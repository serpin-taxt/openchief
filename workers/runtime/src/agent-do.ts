import { DurableObject } from "cloudflare:workers";
import { generateULID } from "@openchief/shared";
import type {
  AgentDefinition,
  AgentReport,
  ReportConfig,
} from "@openchief/shared";
import { callClaude } from "./claude-client";
import { buildPrompt } from "./prompt-builder";
import type { IdentityInfo, OrgInfo } from "./prompt-builder";
import { buildChatSystemPrompt } from "./chat-prompt";
import { parseReportContent } from "./report-parser";
import { getAgentTools, executeTool } from "./agent-tools";
import type { ToolDefinition } from "./agent-tools";
import { retrieveContext, indexReport } from "./rag";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  ANTHROPIC_API_KEY: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  ORG_NAME?: string;
  ORG_CONTEXT?: string;
  DEFAULT_MODEL?: string;
  REPORT_TIMEZONE?: string;
}

export class AgentDurableObject extends DurableObject<Env> {
  private agentConfig: AgentDefinition | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Initialize SQLite tables
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS inbox (
          id TEXT PRIMARY KEY,
          timestamp TEXT NOT NULL,
          source TEXT NOT NULL,
          event_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          payload TEXT NOT NULL,
          processed INTEGER NOT NULL DEFAULT 0,
          received_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS local_reports (
          id TEXT PRIMARY KEY,
          report_type TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS reasoning_log (
          id TEXT PRIMARY KEY,
          report_id TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          user_email TEXT NOT NULL,
          user_name TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_inbox_unprocessed
          ON inbox(processed, timestamp);
        CREATE INDEX IF NOT EXISTS idx_reports_type
          ON local_reports(report_type, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_chat_created
          ON chat_messages(created_at);
      `);
    });
  }

  /**
   * Called by the cron trigger to ensure the alarm chain is bootstrapped.
   */
  async ensureAlarm(agentId: string): Promise<void> {
    await this.ensureAgentId(agentId);
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (!existingAlarm) {
      const config = await this.getAgentConfig();
      if (config) {
        await this.scheduleNextPeriodicAlarm(config);
      }
    }
  }

  /**
   * Alarm handler — triggers report generation.
   */
  async alarm(): Promise<void> {
    const config = await this.getAgentConfig();
    if (!config) {
      console.error("No agent config found, skipping alarm");
      return;
    }

    const alarmType =
      (await this.ctx.storage.get<string>("pending_alarm_type")) || "daily";

    const reportConfig = config.outputs.reports.find((r) => {
      if (alarmType === "weekly") return r.reportType.includes("weekly");
      return r.cadence === "daily";
    });

    if (reportConfig) {
      await this.generateReport(reportConfig, config);
    }

    await this.scheduleNextPeriodicAlarm(config);
  }

  /**
   * Manually trigger a report.
   */
  async triggerReport(
    reportType: string,
    agentId: string,
    asOf?: string
  ): Promise<AgentReport | null> {
    try {
      await this.ensureAgentId(agentId);
      const config = await this.getAgentConfig();
      if (!config) return null;

      const reportConfig = config.outputs.reports.find(
        (r) => r.reportType === reportType
      );
      if (!reportConfig) return null;

      return this.generateReport(reportConfig, config, asOf);
    } catch (err) {
      console.error(
        `triggerReport failed for ${agentId}/${reportType}:`,
        err
      );
      throw err;
    }
  }

  /**
   * Chat with the agent — returns an SSE ReadableStream.
   */
  async chat(
    userMessage: string,
    userEmail: string,
    userName: string,
    agentId: string
  ): Promise<ReadableStream> {
    await this.ensureAgentId(agentId);

    const config = await this.getAgentConfig();
    if (!config) {
      return this.sseError("Agent config not found");
    }

    // Load recent reports from local DO storage
    const recentReports = this.ctx.storage.sql
      .exec(
        `SELECT report_type, content, created_at FROM local_reports
         ORDER BY created_at DESC LIMIT 3`
      )
      .toArray()
      .map((r) => ({
        reportType: r.report_type as string,
        content: r.content as string,
        createdAt: r.created_at as string,
      }));

    // Load chat history (last 50 messages)
    const history = this.ctx.storage.sql
      .exec(
        `SELECT role, content, user_name FROM chat_messages
         ORDER BY created_at ASC`
      )
      .toArray();
    const recentHistory = history.slice(-50);

    // Load identity mappings
    const identities = await this.loadIdentities();
    const enrichedUserName = this.resolveUserName(userEmail, identities);

    // Save the user's message
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO chat_messages (id, user_email, user_name, role, content, created_at)
       VALUES (?, ?, ?, 'user', ?, ?)`,
      generateULID(),
      userEmail,
      enrichedUserName,
      userMessage,
      now
    );

    // Retrieve RAG context if Vectorize is configured
    let ragContext: string | null = null;
    if (this.env.VECTORIZE && this.env.AI) {
      try {
        ragContext = await retrieveContext(
          { VECTORIZE: this.env.VECTORIZE, AI: this.env.AI },
          config.id,
          userMessage
        );
      } catch (err) {
        console.error("RAG context retrieval failed:", err);
      }
    }

    // Build system prompt
    const systemPrompt = buildChatSystemPrompt(
      config,
      recentReports,
      enrichedUserName,
      ragContext,
      identities,
      this.getOrgInfo()
    );

    // Build messages array
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const msg of recentHistory) {
      messages.push({
        role: msg.role as "user" | "assistant",
        content: msg.content as string,
      });
    }
    messages.push({ role: "user", content: userMessage });

    // Get tools from agent's config-driven tools array
    const tools = getAgentTools(config.tools || []);

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const sql = this.ctx.storage.sql;
    const env = this.env;
    const configName = config.name;

    this.ctx.waitUntil(
      (async () => {
        try {
          await this.chatWithToolLoop(
            systemPrompt,
            messages,
            tools,
            writer,
            encoder,
            sql,
            env,
            configName
          );
        } catch (err) {
          console.error("Chat processing error:", err);
          try {
            await writer.write(
              encoder.encode(
                `data: ${JSON.stringify({ type: "error", text: "An error occurred" })}\n\n`
              )
            );
          } catch {
            /* writer may be closed */
          }
        } finally {
          await writer.close();
        }
      })()
    );

    return readable;
  }

  /**
   * Chat with tool use loop — handles Claude → tool_use → execute → respond cycle.
   */
  private async chatWithToolLoop(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: ToolDefinition[],
    writer: WritableStreamDefaultWriter,
    encoder: TextEncoder,
    sql: SqlStorage,
    env: Env,
    configName: string
  ): Promise<void> {
    const MAX_TOOL_ROUNDS = 10;
    let fullText = "";
    const chatModelSettings = await this.getModelSettings("chat");

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const body: Record<string, unknown> = {
        model: chatModelSettings.model,
        max_tokens: chatModelSettings.maxTokens,
        system: systemPrompt,
        messages,
      };
      if (tools.length > 0) {
        body.tools = tools;
      }

      const isStreaming = round === 0 && tools.length === 0;
      if (isStreaming) body.stream = true;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Claude API error (round ${round}): ${errorText}`);
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", text: "Failed to get response from Claude" })}\n\n`
          )
        );
        return;
      }

      // Simple streaming (no tools)
      if (isStreaming && response.body) {
        await this.streamAnthropicResponse(
          response.body,
          writer,
          encoder,
          fullText,
          sql,
          configName
        );
        return;
      }

      // Non-streaming — parse for tool use
      const result = (await response.json()) as {
        content: Array<
          | { type: "text"; text: string }
          | {
              type: "tool_use";
              id: string;
              name: string;
              input: Record<string, unknown>;
            }
        >;
        stop_reason: string;
        usage: { input_tokens: number; output_tokens: number };
      };

      const textBlocks: string[] = [];
      const toolUseBlocks: Array<{
        id: string;
        name: string;
        input: Record<string, unknown>;
      }> = [];

      for (const block of result.content) {
        if (block.type === "text" && block.text) {
          textBlocks.push(block.text);
        } else if (block.type === "tool_use") {
          toolUseBlocks.push({
            id: block.id,
            name: block.name,
            input: block.input,
          });
        }
      }

      const roundText = textBlocks.join("");
      if (roundText) {
        fullText += roundText;
        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ type: "delta", text: roundText })}\n\n`
          )
        );
      }

      if (toolUseBlocks.length === 0 || result.stop_reason !== "tool_use") {
        sql.exec(
          `INSERT INTO chat_messages (id, user_email, user_name, role, content, created_at)
           VALUES (?, ?, ?, 'assistant', ?, ?)`,
          generateULID(),
          "assistant",
          configName,
          fullText,
          new Date().toISOString()
        );
        await writer.write(
          encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`)
        );
        return;
      }

      // Execute tools
      messages.push({ role: "assistant", content: result.content });

      const toolResults: Array<{
        type: "tool_result";
        tool_use_id: string;
        content: string;
        is_error?: boolean;
      }> = [];

      for (const tool of toolUseBlocks) {
        const toolLabel =
          tool.name === "query_events"
            ? `Querying events...`
            : tool.name === "github_file"
              ? `Fetching ${(tool.input.path as string) || "file"}...`
              : tool.name === "github_search"
                ? `Searching code for "${(tool.input.query as string) || ""}"...`
                : `Running ${tool.name}...`;

        await writer.write(
          encoder.encode(
            `data: ${JSON.stringify({ type: "tool_status", tool: tool.name, status: toolLabel })}\n\n`
          )
        );

        const toolResult = await executeTool(tool.name, tool.input, {
          DB: env.DB,
          GITHUB_TOKEN: env.GITHUB_TOKEN,
          GITHUB_REPO: env.GITHUB_REPO,
        });

        toolResults.push({
          type: "tool_result",
          tool_use_id: tool.id,
          content: toolResult.content,
          is_error: toolResult.is_error || undefined,
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    // Hit max tool rounds
    if (fullText) {
      sql.exec(
        `INSERT INTO chat_messages (id, user_email, user_name, role, content, created_at)
         VALUES (?, ?, ?, 'assistant', ?, ?)`,
        generateULID(),
        "assistant",
        configName,
        fullText,
        new Date().toISOString()
      );
    }
    await writer.write(
      encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`)
    );
  }

  /**
   * Stream a simple Anthropic SSE response (no tool use).
   */
  private async streamAnthropicResponse(
    body: ReadableStream,
    writer: WritableStreamDefaultWriter,
    encoder: TextEncoder,
    existingText: string,
    sql: SqlStorage,
    configName: string
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = existingText;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;

          try {
            const event = JSON.parse(data);
            if (event.type === "content_block_delta" && event.delta?.text) {
              fullText += event.delta.text;
              await writer.write(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "delta", text: event.delta.text })}\n\n`
                )
              );
            } else if (event.type === "message_stop") {
              sql.exec(
                `INSERT INTO chat_messages (id, user_email, user_name, role, content, created_at)
                 VALUES (?, ?, ?, 'assistant', ?, ?)`,
                generateULID(),
                "assistant",
                configName,
                fullText,
                new Date().toISOString()
              );
              await writer.write(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "done" })}\n\n`
                )
              );
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    } catch (err) {
      console.error("Stream processing error:", err);
    }
  }

  /**
   * Get chat history for the sidebar.
   */
  async getChatHistory(
    agentId: string
  ): Promise<
    Array<{
      id: string;
      userEmail: string;
      userName: string;
      role: string;
      content: string;
      createdAt: string;
    }>
  > {
    await this.ensureAgentId(agentId);

    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, user_email, user_name, role, content, created_at
         FROM chat_messages ORDER BY created_at ASC LIMIT 100`
      )
      .toArray();

    return rows.map((r) => ({
      id: r.id as string,
      userEmail: r.user_email as string,
      userName: r.user_name as string,
      role: r.role as string,
      content: r.content as string,
      createdAt: r.created_at as string,
    }));
  }

  private sseError(message: string): ReadableStream {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ type: "error", text: message })}\n\n`
          )
        );
        controller.close();
      },
    });
  }

  /**
   * Query events from D1 using agent subscriptions as filters.
   */
  private async queryEventsFromD1(
    subscriptions: Array<{
      source: string;
      eventTypes: string[];
      scopeFilter?: { org?: string; project?: string; team?: string };
    }>,
    cutoff: string,
    nowStr: string,
    limit: number
  ): Promise<
    Array<{
      timestamp: string;
      source: string;
      event_type: string;
      summary: string;
      payload: string;
    }>
  > {
    // Empty subscriptions = subscribe to ALL events (e.g. CEO agent)
    if (subscriptions.length === 0) {
      const sql = `SELECT timestamp, source, event_type, summary, payload
        FROM events
        WHERE timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
        LIMIT ?`;
      const result = await this.env.DB.prepare(sql).bind(cutoff, nowStr, limit).all();
      return result.results as Array<{
        timestamp: string;
        source: string;
        event_type: string;
        summary: string;
        payload: string;
      }>;
    }

    const params: unknown[] = [cutoff, nowStr];
    const subClauses: string[] = [];

    for (const sub of subscriptions) {
      const parts: string[] = [];

      parts.push(`source = ?`);
      params.push(sub.source);

      const typeConds: string[] = [];
      let matchAll = false;
      for (const pattern of sub.eventTypes) {
        if (pattern === "*") {
          matchAll = true;
          break;
        } else if (pattern.endsWith(".*")) {
          typeConds.push(`event_type LIKE ?`);
          params.push(`${pattern.slice(0, -2)}.%`);
        } else {
          typeConds.push(`event_type = ?`);
          params.push(pattern);
        }
      }
      if (!matchAll && typeConds.length > 0) {
        parts.push(`(${typeConds.join(" OR ")})`);
      }

      if (sub.scopeFilter) {
        if (sub.scopeFilter.org) {
          parts.push(`scope_org = ?`);
          params.push(sub.scopeFilter.org);
        }
        if (sub.scopeFilter.project) {
          parts.push(`scope_project = ?`);
          params.push(sub.scopeFilter.project);
        }
        if (sub.scopeFilter.team) {
          parts.push(`scope_team = ?`);
          params.push(sub.scopeFilter.team);
        }
      }

      subClauses.push(`(${parts.join(" AND ")})`);
    }

    params.push(limit);

    const sql = `SELECT timestamp, source, event_type, summary, payload
      FROM events
      WHERE timestamp >= ? AND timestamp <= ?
        AND (${subClauses.join(" OR ")})
      ORDER BY timestamp ASC
      LIMIT ?`;

    const result = await this.env.DB.prepare(sql).bind(...params).all();

    return result.results as Array<{
      timestamp: string;
      source: string;
      event_type: string;
      summary: string;
      payload: string;
    }>;
  }

  /**
   * Core report generation.
   */
  private async generateReport(
    reportConfig: ReportConfig,
    config: AgentDefinition,
    asOf?: string
  ): Promise<AgentReport | null> {
    const eventLimit = reportConfig.cadence === "weekly" ? 5000 : 2000;
    const anchorDay = new Date(
      asOf ? asOf + "T23:59:59-06:00" : Date.now()
    ).getUTCDay();
    const lookbackHours =
      reportConfig.cadence === "weekly"
        ? 8 * 24
        : anchorDay === 1
          ? 72
          : 48;

    const anchorMs = asOf
      ? new Date(asOf + "T23:59:59-06:00").getTime()
      : Date.now();
    const cutoff = new Date(
      anchorMs - lookbackHours * 60 * 60 * 1000
    ).toISOString();
    const nowStr = new Date(anchorMs).toISOString();

    const events = await this.queryEventsFromD1(
      config.subscriptions,
      cutoff,
      nowStr,
      eventLimit
    );

    // Skip if no events (unless weekly)
    if (events.length === 0 && reportConfig.cadence !== "weekly") {
      return null;
    }

    // Load recent past reports for trend comparison
    const recentReportsResult = await this.env.DB.prepare(
      `SELECT content, created_at FROM reports
       WHERE agent_id = ? AND report_type = ?
       ORDER BY created_at DESC LIMIT 3`
    )
      .bind(config.id, reportConfig.reportType)
      .all();
    const recentReports = (recentReportsResult.results || []).map((r) => {
      const date = new Date(r.created_at as string).toLocaleDateString(
        "en-US",
        { weekday: "short", month: "short", day: "numeric" }
      );
      return `[Report from ${date}]\n${r.content as string}`;
    });

    // Load identity mappings
    const identities = await this.loadIdentities();

    // Retrieve RAG context if Vectorize is configured
    let ragContext: string | null = null;
    if (this.env.VECTORIZE && this.env.AI) {
      try {
        ragContext = await retrieveContext(
          { VECTORIZE: this.env.VECTORIZE, AI: this.env.AI },
          config.id,
          `${config.name} ${reportConfig.reportType} report`
        );
      } catch (err) {
        console.error("RAG context retrieval failed, continuing without:", err);
      }
    }

    // Build prompt
    const prompt = buildPrompt(
      config,
      reportConfig,
      events,
      recentReports,
      ragContext,
      identities,
      this.getOrgInfo()
    );

    const reportJobType =
      reportConfig.cadence === "weekly" ? "weekly-report" : "daily-report";
    const modelSettings = await this.getModelSettings(reportJobType);
    const response = await callClaude(
      this.env.ANTHROPIC_API_KEY,
      prompt.system,
      [{ role: "user", content: prompt.user }],
      modelSettings.model,
      modelSettings.maxTokens
    );

    const content = parseReportContent(response.text);

    const reportId = generateULID();
    const now = asOf
      ? new Date(asOf + "T14:00:00Z").toISOString()
      : new Date().toISOString();
    const report: AgentReport = {
      id: reportId,
      agentId: config.id,
      reportType: reportConfig.reportType,
      content,
      eventCount: events.length,
      createdAt: now,
    };

    // Store locally
    this.ctx.storage.sql.exec(
      `INSERT INTO local_reports (id, report_type, content, created_at)
       VALUES (?, ?, ?, ?)`,
      reportId,
      reportConfig.reportType,
      JSON.stringify(content),
      now
    );

    // Log token usage
    this.ctx.storage.sql.exec(
      `INSERT INTO reasoning_log (id, report_id, input_tokens, output_tokens, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      generateULID(),
      reportId,
      response.inputTokens,
      response.outputTokens,
      now
    );

    // Persist to D1
    await this.env.DB.prepare(
      `INSERT INTO reports (id, agent_id, report_type, content, event_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(
        reportId,
        config.id,
        reportConfig.reportType,
        JSON.stringify(content),
        events.length,
        now
      )
      .run();

    // Cache in KV
    await this.env.KV.put(
      `report:latest:${config.id}:${reportConfig.reportType}`,
      JSON.stringify(report),
      { expirationTtl: 86400 }
    );

    // Index in Vectorize for RAG (non-blocking)
    if (this.env.VECTORIZE && this.env.AI) {
      this.ctx.waitUntil(
        indexReport(
          { VECTORIZE: this.env.VECTORIZE, AI: this.env.AI },
          config.id,
          report
        ).catch((err) => console.error("RAG indexing failed:", err))
      );
    }

    console.log(
      `Generated ${reportConfig.reportType} report for ${config.id}: ${content.headline}`
    );

    return report;
  }

  /**
   * Load identity mappings from D1 (KV-cached).
   */
  private async loadIdentities(): Promise<IdentityInfo[]> {
    const cacheKey = "identities:all";
    const cached = await this.env.KV.get(cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as IdentityInfo[];
      } catch {
        /* fall through */
      }
    }

    try {
      const result = await this.env.DB.prepare(
        `SELECT github_username, slack_user_id, email, real_name, display_name, team, role, is_bot
         FROM identity_mappings WHERE is_active = 1`
      ).all();

      const identities: IdentityInfo[] = result.results.map(
        (r: Record<string, unknown>) => ({
          github_username: (r.github_username as string) || null,
          slack_user_id: (r.slack_user_id as string) || null,
          email: (r.email as string) || null,
          real_name: r.real_name as string,
          display_name: (r.display_name as string) || null,
          team: (r.team as string) || null,
          role: (r.role as string) || null,
          is_bot: Boolean(r.is_bot),
        })
      );

      await this.env.KV.put(cacheKey, JSON.stringify(identities), {
        expirationTtl: 3600,
      });

      return identities;
    } catch (err) {
      console.error("Failed to load identities:", err);
      return [];
    }
  }

  private resolveUserName(
    email: string,
    identities: IdentityInfo[]
  ): string {
    const identity = identities.find(
      (i) => i.email && i.email.toLowerCase() === email.toLowerCase()
    );
    if (identity) {
      return identity.display_name || identity.real_name;
    }
    return email.split("@")[0];
  }

  private async ensureAgentId(agentId: string): Promise<void> {
    const existing = await this.ctx.storage.get<string>("agentId");
    if (!existing) {
      await this.ctx.storage.put("agentId", agentId);
    }
  }

  private async getAgentConfig(): Promise<AgentDefinition | null> {
    if (this.agentConfig) return this.agentConfig;

    const agentId = await this.ctx.storage.get<string>("agentId");
    if (!agentId) {
      console.error("No agentId in DO storage — cannot load config");
      return null;
    }

    const result = await this.env.DB.prepare(
      "SELECT config FROM agent_definitions WHERE id = ?"
    )
      .bind(agentId)
      .first();

    if (!result) return null;

    this.agentConfig = JSON.parse(
      result.config as string
    ) as AgentDefinition;
    return this.agentConfig;
  }

  private getOrgInfo(): OrgInfo {
    return {
      orgName: this.env.ORG_NAME || undefined,
      orgContext: this.env.ORG_CONTEXT || undefined,
      timezone: this.env.REPORT_TIMEZONE || undefined,
    };
  }

  private async getModelSettings(
    jobType: string
  ): Promise<{ model: string; maxTokens: number }> {
    const defaultModel = this.env.DEFAULT_MODEL || "claude-sonnet-4-6";
    const defaults: Record<string, { model: string; maxTokens: number }> = {
      "daily-report": { model: defaultModel, maxTokens: 8192 },
      "weekly-report": { model: defaultModel, maxTokens: 8192 },
      chat: { model: defaultModel, maxTokens: 8192 },
    };

    try {
      const result = await this.env.DB.prepare(
        "SELECT model_id, max_tokens FROM model_settings WHERE job_type = ?"
      )
        .bind(jobType)
        .first();

      if (result) {
        return {
          model: result.model_id as string,
          maxTokens: result.max_tokens as number,
        };
      }
    } catch {
      // Table may not exist yet
    }

    return defaults[jobType] || defaults["daily-report"];
  }

  /**
   * Schedule the next daily/weekly alarm.
   */
  private async scheduleNextPeriodicAlarm(
    config: AgentDefinition
  ): Promise<void> {
    const hasDaily = config.outputs.reports.some(
      (r) => r.cadence === "daily"
    );
    const hasWeekly = config.outputs.reports.some(
      (r) => r.cadence === "weekly"
    );

    if (!hasDaily && !hasWeekly) return;

    const now = new Date();

    if (hasDaily) {
      const next = new Date(now);
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(14, 0, 0, 0); // 14:00 UTC — customize via config

      // Skip weekends
      const day = next.getUTCDay();
      if (day === 0) next.setUTCDate(next.getUTCDate() + 1);
      if (day === 6) next.setUTCDate(next.getUTCDate() + 2);

      await this.ctx.storage.put("pending_alarm_type", "daily");
      await this.ctx.storage.setAlarm(next.getTime());
    } else if (hasWeekly) {
      const next = new Date(now);
      const daysUntilMonday = (8 - next.getUTCDay()) % 7 || 7;
      next.setUTCDate(next.getUTCDate() + daysUntilMonday);
      next.setUTCHours(14, 0, 0, 0);

      await this.ctx.storage.put("pending_alarm_type", "weekly");
      await this.ctx.storage.setAlarm(next.getTime());
    }
  }
}
