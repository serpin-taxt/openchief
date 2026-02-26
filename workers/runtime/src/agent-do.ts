import { DurableObject } from "cloudflare:workers";
import { generateULID } from "@openchief/shared";
import type {
  AgentDefinition,
  AgentReport,
  ReportConfig,
  Task,
} from "@openchief/shared";
import { callClaude } from "./claude-client";
import { buildPrompt } from "./prompt-builder";
import type { IdentityInfo, OrgInfo, PendingTask } from "./prompt-builder";
import { buildChatSystemPrompt } from "./chat-prompt";
import { buildMeetingPrompt } from "./meeting-prompt";
import type { MeetingTaskData } from "./meeting-prompt";
import { parseReportContent, parseTaskProposals, parseTaskDecisions } from "./report-parser";
import { buildTaskExecutionPrompt } from "./task-prompt";
import { getAgentTools, executeTool } from "./agent-tools";
import type { ToolDefinition } from "./agent-tools";
import { retrieveContext, indexReport } from "./rag";
import { postReportToSlack } from "./slack-post";

// ---------------------------------------------------------------------------
// Staggered report schedule
// ---------------------------------------------------------------------------
// Each agent gets a specific time slot so reports trickle in between 8:00–9:00
// AM local time. The CEO runs at 9:30 AM after all other reports are ready,
// giving them the full picture for their morning meeting.
//
// Times are in the configured REPORT_TIMEZONE (defaults to America/Chicago).
// New agents not listed here get a hash-based slot in the 8:53–8:59 window.
// ---------------------------------------------------------------------------

const REPORT_SCHEDULE: Record<string, { hour: number; minute: number }> = {
  "eng-manager":        { hour: 8, minute: 0 },
  "product-manager":    { hour: 8, minute: 4 },
  "design-manager":     { hour: 8, minute: 8 },
  "data-analyst":       { hour: 8, minute: 12 },
  "customer-support":   { hour: 8, minute: 16 },
  "community-manager":  { hour: 8, minute: 20 },
  "marketing-manager":  { hour: 8, minute: 24 },
  "cro":                { hour: 8, minute: 28 },
  "bizdev":             { hour: 8, minute: 32 },
  "head-of-hr":         { hour: 8, minute: 36 },
  "ciso":               { hour: 8, minute: 40 },
  "cfo":                { hour: 8, minute: 44 },
  "legal-counsel":      { hour: 8, minute: 48 },
  "researcher":         { hour: 8, minute: 52 },
  "ceo":                { hour: 9, minute: 30 },
};

/** Fallback for agents not in the schedule — hash into the 8:53–8:59 window. */
function defaultReportTime(agentId: string): { hour: number; minute: number } {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
  }
  return { hour: 8, minute: 53 + ((hash >>> 0) % 7) };
}

function getAgentReportTime(agentId: string): { hour: number; minute: number } {
  return REPORT_SCHEDULE[agentId] ?? defaultReportTime(agentId);
}

/**
 * Compute the UTC offset (in ms) for a timezone at a given instant.
 * Positive = timezone is ahead of UTC (e.g., UTC+5:30 → +19800000).
 */
function tzOffsetMs(date: Date, tz: string): number {
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const localStr = date.toLocaleString("en-US", { timeZone: tz });
  return new Date(localStr).getTime() - new Date(utcStr).getTime();
}

/**
 * Find the next occurrence of a given local time on a weekday.
 * Handles DST transitions via the IANA timezone string.
 *
 * @param hour    Local hour (0–23)
 * @param minute  Local minute (0–59)
 * @param tz      IANA timezone (e.g. "America/Chicago")
 * @param skipToTomorrow  If true, never returns a time today
 */
function nextWeekdayAlarm(
  hour: number,
  minute: number,
  tz: string,
  skipToTomorrow = false,
): Date {
  const now = Date.now();
  for (let d = skipToTomorrow ? 1 : 0; d <= 7; d++) {
    // Build a "naive UTC" date for the target day + local time
    const base = new Date(now);
    base.setUTCDate(base.getUTCDate() + d);
    base.setUTCHours(hour, minute, 0, 0);

    // Convert local→UTC by subtracting the timezone offset
    const offset = tzOffsetMs(base, tz);
    const utc = new Date(base.getTime() - offset);

    // Must be in the future
    if (utc.getTime() <= now) continue;

    // Must be a weekday in local time
    const localDay = new Date(utc.getTime() + offset).getUTCDay();
    if (localDay === 0 || localDay === 6) continue;

    return utc;
  }
  // Fallback — should never happen
  return new Date(now + 24 * 3600_000);
}

// ---------------------------------------------------------------------------

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
   * Force-reset the alarm to this agent's staggered time slot.
   * Used after schedule changes to migrate all agents to new times.
   */
  async resetAlarm(agentId: string): Promise<void> {
    await this.ensureAgentId(agentId);
    await this.ctx.storage.deleteAlarm();
    await this.ensureAlarm(agentId);
  }

  /**
   * Called by the cron trigger to ensure the alarm chain is bootstrapped.
   * Schedules the agent's next report at its staggered time slot.
   */
  async ensureAlarm(agentId: string): Promise<void> {
    await this.ensureAgentId(agentId);
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (!existingAlarm) {
      const config = await this.getAgentConfig();
      if (config) {
        const hasDaily = config.outputs.reports.some(
          (r) => r.cadence === "daily"
        );
        if (hasDaily) {
          const tz = this.env.REPORT_TIMEZONE || "America/Chicago";
          const { hour, minute } = getAgentReportTime(agentId);
          const alarmTime = nextWeekdayAlarm(hour, minute, tz);
          await this.ctx.storage.put("pending_alarm_type", "daily");
          await this.ctx.storage.setAlarm(alarmTime.getTime());
          console.log(
            `Bootstrapped ${agentId} alarm for ${alarmTime.toISOString()} (${hour}:${String(minute).padStart(2, "0")} ${tz})`
          );
        }
      }
    }
  }

  /**
   * Alarm handler — triggers report generation or task execution.
   */
  async alarm(): Promise<void> {
    const config = await this.getAgentConfig();
    if (!config) {
      console.error("No agent config found, skipping alarm");
      return;
    }

    const alarmType =
      (await this.ctx.storage.get<string>("pending_alarm_type")) || "daily";

    if (alarmType === "task") {
      // Task execution alarm
      await this.executeNextTask(config);
    } else {
      // Report generation alarm
      const reportConfig = config.outputs.reports.find(
        (r) => r.cadence === "daily"
      );

      if (reportConfig) {
        await this.generateReport(reportConfig, config);
      }
    }

    await this.scheduleNextAlarm(config);
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

    // Load recent reports — try local DO storage first, fall back to D1.
    // Chat DOs (named chat:{agentId}:{email}) don't generate reports, so
    // their local_reports table is empty. D1 has the actual reports.
    let recentReports = this.ctx.storage.sql
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

    if (recentReports.length === 0) {
      try {
        const { results } = await this.env.DB.prepare(
          `SELECT report_type, content, created_at FROM reports
           WHERE agent_id = ? ORDER BY created_at DESC LIMIT 3`
        )
          .bind(config.id)
          .all<{ report_type: string; content: string; created_at: string }>();
        recentReports = (results || []).map((r) => ({
          reportType: r.report_type,
          content: r.content,
          createdAt: r.created_at,
        }));
      } catch (err) {
        console.error("Failed to load reports from D1:", err);
      }
    }

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

    const encoder = new TextEncoder();
    const sql = this.ctx.storage.sql;
    const env = this.env;
    const configName = config.name;

    // Stream SSE events in real-time via a TransformStream.
    // The DO stays alive as long as the response stream is open —
    // no ctx.waitUntil() needed.
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();

    const sseWriter = {
      write: (chunk: Uint8Array) => writer.write(chunk),
      close: () => writer.close(),
    };

    // Kick off the chat processing — writes flow through to the browser
    // as each SSE event is generated (real-time token streaming).
    this.chatWithToolLoop(
      systemPrompt,
      messages,
      tools,
      sseWriter,
      encoder,
      sql,
      env,
      configName
    )
      .catch(async (err) => {
        console.error("Chat processing error:", err);
        try {
          await writer.write(
            encoder.encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", text: "An error occurred" })}\n\n`
            )
          );
        } catch {
          // Stream may already be closed
        }
      })
      .finally(() => {
        writer.close().catch(() => {});
      });

    return readable;
  }

  /**
   * Chat with tool use loop — handles Claude → tool_use → execute → respond cycle.
   */
  private async chatWithToolLoop(
    systemPrompt: string,
    messages: Array<{ role: string; content: unknown }>,
    tools: ToolDefinition[],
    writer: { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> },
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
            `event: error\ndata: ${JSON.stringify({ type: "error", text: "Failed to get response from Claude" })}\n\n`
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
            `event: delta\ndata: ${JSON.stringify({ type: "delta", text: roundText })}\n\n`
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
          encoder.encode(`event: done\ndata: ${JSON.stringify({ type: "done" })}\n\n`)
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
            `event: tool_status\ndata: ${JSON.stringify({ type: "tool_status", tool: tool.name, status: toolLabel })}\n\n`
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
      encoder.encode(`event: done\ndata: ${JSON.stringify({ type: "done" })}\n\n`)
    );
  }

  /**
   * Stream a simple Anthropic SSE response (no tool use).
   */
  private async streamAnthropicResponse(
    body: ReadableStream,
    writer: { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> },
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
                  `event: delta\ndata: ${JSON.stringify({ type: "delta", text: event.delta.text })}\n\n`
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
                  `event: done\ndata: ${JSON.stringify({ type: "done" })}\n\n`
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
   * Clear all chat messages for this DO instance.
   */
  async clearChatHistory(agentId: string): Promise<void> {
    await this.ensureAgentId(agentId);
    this.ctx.storage.sql.exec(`DELETE FROM chat_messages`);
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
            `event: error\ndata: ${JSON.stringify({ type: "error", text: message })}\n\n`
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
      scopeFilter?: {
        org?: string;
        project?: string | string[];
        team?: string;
      };
    }>,
    cutoff: string,
    nowStr: string,
    limit: number,
    agentVisibility?: "public" | "exec"
  ): Promise<
    Array<{
      timestamp: string;
      source: string;
      event_type: string;
      summary: string;
      payload: string;
    }>
  > {
    type EventRow = {
      timestamp: string;
      source: string;
      event_type: string;
      summary: string;
      payload: string;
    };

    // Non-exec agents cannot see exec-tagged events (private Slack channels)
    const excludeExec = agentVisibility !== "exec";
    const execFilter = excludeExec
      ? "AND (tags IS NULL OR tags NOT LIKE '%\"exec\"%')"
      : "";

    // Empty subscriptions = subscribe to ALL events (e.g. CEO agent)
    if (subscriptions.length === 0) {
      const sql = `SELECT timestamp, source, event_type, summary, payload
        FROM events
        WHERE timestamp >= ? AND timestamp <= ?
        ${execFilter}
        ORDER BY timestamp ASC
        LIMIT ?`;
      const result = await this.env.DB.prepare(sql).bind(cutoff, nowStr, limit).all();
      return result.results as EventRow[];
    }

    // Per-source fetching: query each subscription independently.
    // The limit parameter is applied per-source (not divided across sources)
    // so every source gets a fair share. The prompt builder applies a character
    // budget to prevent context window overflow.
    const statements = subscriptions.map((sub) => {
      const params: unknown[] = [cutoff, nowStr];
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
          const projects = Array.isArray(sub.scopeFilter.project)
            ? sub.scopeFilter.project
            : [sub.scopeFilter.project];
          parts.push(
            `scope_project IN (${projects.map(() => "?").join(", ")})`
          );
          params.push(...projects);
        }
        if (sub.scopeFilter.team) {
          parts.push(`scope_team = ?`);
          params.push(sub.scopeFilter.team);
        }
      }

      params.push(limit);

      const sql = `SELECT timestamp, source, event_type, summary, payload
        FROM events
        WHERE timestamp >= ? AND timestamp <= ?
          AND ${parts.join(" AND ")}
          ${execFilter}
        ORDER BY timestamp DESC
        LIMIT ?`;

      return this.env.DB.prepare(sql).bind(...params);
    });

    // D1 batch executes all queries in a single round-trip
    const batchResults = await this.env.DB.batch<EventRow>(statements);

    // Merge and sort chronologically
    const merged: EventRow[] = [];
    for (const result of batchResults) {
      merged.push(...(result.results as EventRow[]));
    }
    merged.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    return merged;
  }

  /**
   * Core report generation.
   */
  private async generateReport(
    reportConfig: ReportConfig,
    config: AgentDefinition,
    asOf?: string
  ): Promise<AgentReport | null> {
    // Dedup guard (two layers):
    // 1. DO storage — immediate, race-condition-proof within the same DO instance.
    //    Cloudflare DO alarms have at-least-once delivery, and re-delivery can
    //    arrive within seconds.  ctx.storage is synchronous within the DO, so
    //    the second delivery always sees the first's write.
    // 2. D1 fallback — catches duplicates after DO eviction/recreation.
    if (!asOf) {
      const dedupKey = `last_report:${reportConfig.reportType}`;
      const lastGenerated = await this.ctx.storage.get<number>(dedupKey);
      if (lastGenerated && Date.now() - lastGenerated < 30 * 60 * 1000) {
        console.log(
          `Dedup (storage): skipping ${reportConfig.reportType} for ${config.id} — generated ${Math.round((Date.now() - lastGenerated) / 1000)}s ago`
        );
        return null;
      }
      // Mark BEFORE calling Claude so concurrent re-delivery is blocked.
      // If report generation fails, the key is cleared in the catch below.
      await this.ctx.storage.put(dedupKey, Date.now());

      const thirtyMinAgo = new Date(
        Date.now() - 30 * 60 * 1000
      ).toISOString();
      const existing = await this.env.DB.prepare(
        `SELECT id FROM reports
         WHERE agent_id = ? AND report_type = ? AND created_at > ?
         LIMIT 1`
      )
        .bind(config.id, reportConfig.reportType, thirtyMinAgo)
        .first<{ id: string }>();
      if (existing) {
        console.log(
          `Dedup (D1): skipping ${reportConfig.reportType} for ${config.id} — report ${existing.id} already exists within 30 min window`
        );
        return null;
      }
    }

    // If generation fails after the dedup key was set, clear it so retries work.
    const dedupKeyForCleanup = !asOf ? `last_report:${reportConfig.reportType}` : null;
    try {

    const perSourceEventLimit = 2000;
    const anchorDay = new Date(
      asOf ? asOf + "T23:59:59-06:00" : Date.now()
    ).getUTCDay();
    const lookbackHours =
      anchorDay === 1
        ? 72   // Monday: cover the weekend
        : 25;  // Tue–Fri: ~1 day with 1hr overlap buffer

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
      perSourceEventLimit,
      config.visibility
    );

    // Skip if no events (unless CEO meeting — CEO reads other agents' reports)
    const isCeoMeeting =
      config.id === "ceo" && reportConfig.reportType === "daily-meeting";
    if (events.length === 0 && !isCeoMeeting) {
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

    // Load pending tasks so agents don't propose duplicates
    let pendingTasks: PendingTask[] = [];
    if (!isCeoMeeting) {
      try {
        const taskRows = await this.env.DB.prepare(
          `SELECT title, assigned_to, status FROM tasks
           WHERE status IN ('proposed', 'queued', 'in_progress')
           ORDER BY priority DESC LIMIT 20`
        ).all<{ title: string; assigned_to: string | null; status: string }>();
        pendingTasks = (taskRows.results || []).map((r) => ({
          title: r.title,
          assignedTo: r.assigned_to,
          status: r.status,
        }));
      } catch (err) {
        console.error("Failed to load pending tasks:", err);
      }
    }

    // Build prompt — CEO meeting uses a special prompt that synthesizes
    // all other agents' daily reports instead of raw events
    let prompt: { system: string; user: string };

    if (isCeoMeeting) {
      prompt = await this.buildCeoMeetingPrompt(
        config,
        reportConfig,
        recentReports,
        ragContext
      );
    } else {
      prompt = buildPrompt(
        config,
        reportConfig,
        events,
        recentReports,
        ragContext,
        identities,
        this.getOrgInfo(),
        pendingTasks
      );
    }

    const reportJobType = isCeoMeeting ? "daily-meeting" : "daily-report";
    const modelSettings = await this.getModelSettings(reportJobType);
    const response = await callClaude(
      this.env.ANTHROPIC_API_KEY,
      prompt.system,
      [{ role: "user", content: prompt.user }],
      modelSettings.model,
      modelSettings.maxTokens,
      isCeoMeeting ? { extendedContext: true } : undefined
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

    // Post report to Slack if configured (non-blocking)
    if (config.slackChannelId) {
      this.ctx.waitUntil(
        (async () => {
          try {
            const slackToken = await this.env.KV.get("connector-secret:slack:SLACK_BOT_TOKEN");
            if (!slackToken) {
              console.log("Slack report posting skipped — no bot token in KV");
              return;
            }
            await postReportToSlack(slackToken, config.slackChannelId!, config.name, content, reportId);
            console.log(`Posted ${config.name} report to Slack channel ${config.slackChannelId}`);
          } catch (err) {
            console.error(`Failed to post ${config.name} report to Slack:`, err);
          }
        })()
      );
    }

    // Extract and insert task proposals (non-CEO reports only)
    if (!isCeoMeeting) {
      try {
        const PRIORITY_MAP: Record<string, number> = {
          low: 20,
          medium: 40,
          high: 60,
          critical: 80,
        };
        const proposals = parseTaskProposals(response.text);

        // Enforce daily cap of 5 proposals per agent
        const DAILY_TASK_LIMIT = 5;
        const today = now.split("T")[0]; // "YYYY-MM-DD"
        const countResult = await this.env.DB.prepare(
          `SELECT COUNT(*) as count FROM tasks
           WHERE created_by = ? AND created_at >= ? AND created_at < ?`
        )
          .bind(config.id, `${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`)
          .first<{ count: number }>();
        const todayCount = countResult?.count ?? 0;
        const remaining = Math.max(0, DAILY_TASK_LIMIT - todayCount);
        if (remaining === 0) {
          console.log(`Daily task limit (${DAILY_TASK_LIMIT}) reached for ${config.id}, skipping proposals`);
        }

        for (const proposal of proposals.slice(0, remaining)) {
          // Check for duplicate: same title + assignee already pending
          const existing = await this.env.DB.prepare(
            `SELECT id FROM tasks
             WHERE title = ? AND assigned_to = ? AND status IN ('proposed', 'queued', 'in_progress')
             LIMIT 1`
          )
            .bind(proposal.title, proposal.assignTo)
            .first<{ id: string }>();
          if (existing) continue;

          const taskId = generateULID();
          await this.env.DB.prepare(
            `INSERT INTO tasks (id, title, description, status, priority, created_by, assigned_to, source_report_id, context, tokens_used, created_at, updated_at)
             VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, 0, ?, ?)`
          )
            .bind(
              taskId,
              proposal.title,
              proposal.description,
              PRIORITY_MAP[proposal.priority] || 40,
              config.id,
              proposal.assignTo,
              reportId,
              JSON.stringify(proposal.context),
              now,
              now
            )
            .run();
          console.log(
            `Task proposed by ${config.id}: "${proposal.title}" → ${proposal.assignTo}`
          );
        }
      } catch (err) {
        console.error("Failed to insert task proposals:", err);
      }
    }

    // Process CEO task decisions (CEO meetings only)
    if (isCeoMeeting) {
      try {
        const decisions = parseTaskDecisions(response.text);

        // Enforce daily cap of 6 queued tasks
        const DAILY_QUEUE_LIMIT = 6;
        const today = now.split("T")[0];
        const queuedToday = await this.env.DB.prepare(
          `SELECT COUNT(*) as count FROM tasks
           WHERE status IN ('queued', 'in_progress', 'completed')
             AND updated_at >= ? AND updated_at < ?`
        )
          .bind(`${today}T00:00:00.000Z`, `${today}T23:59:59.999Z`)
          .first<{ count: number }>();
        let queuedCount = queuedToday?.count ?? 0;

        for (const decision of decisions) {
          if (decision.action === "queue") {
            if (queuedCount >= DAILY_QUEUE_LIMIT) {
              console.log(
                `Daily queue limit (${DAILY_QUEUE_LIMIT}) reached — skipping task ${decision.taskId}`
              );
              continue;
            }
            await this.env.DB.prepare(
              `UPDATE tasks SET status = 'queued', priority = ?, updated_at = ?
               WHERE id = ? AND status = 'proposed'`
            )
              .bind(decision.priority, now, decision.taskId)
              .run();
            queuedCount++;
            console.log(
              `CEO queued task ${decision.taskId} with priority ${decision.priority}${decision.notes ? `: ${decision.notes}` : ""}`
            );
          } else if (decision.action === "cancel") {
            await this.env.DB.prepare(
              `UPDATE tasks SET status = 'cancelled', updated_at = ?
               WHERE id = ? AND status = 'proposed'`
            )
              .bind(now, decision.taskId)
              .run();
            console.log(
              `CEO cancelled task ${decision.taskId}${decision.notes ? `: ${decision.notes}` : ""}`
            );
          }
        }
      } catch (err) {
        console.error("Failed to process CEO task decisions:", err);
      }
    }

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

    } catch (err) {
      // Clear the dedup key so the report can be retried
      if (dedupKeyForCleanup) {
        await this.ctx.storage.delete(dedupKeyForCleanup);
        console.error(
          `Report generation failed for ${config.id}/${reportConfig.reportType}, dedup key cleared for retry`
        );
      }
      throw err;
    }
  }

  /**
   * Build the CEO meeting prompt by fetching all other agents' latest daily
   * reports and feeding them into the meeting simulation.
   */
  private async buildCeoMeetingPrompt(
    config: AgentDefinition,
    reportConfig: ReportConfig,
    previousMeetings: string[],
    ragContext: string | null
  ): Promise<{ system: string; user: string }> {
    // Fetch all other enabled agents and their configs
    const agentRows = await this.env.DB.prepare(
      `SELECT id, config FROM agent_definitions WHERE enabled = 1 AND id != 'ceo'`
    ).all<{ id: string; config: string }>();

    const agentConfigs: AgentDefinition[] = [];
    for (const row of agentRows.results || []) {
      try {
        agentConfigs.push(JSON.parse(row.config));
      } catch {
        /* skip unparseable */
      }
    }

    // Fetch today's latest daily report from each agent
    // Look back 12 hours to cover the 8:00-9:30 AM window generously
    const cutoff = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
    const reportRows = await this.env.DB.prepare(
      `SELECT r.agent_id, r.content, a.config as agent_config
       FROM reports r
       JOIN agent_definitions a ON a.id = r.agent_id
       WHERE r.agent_id != 'ceo'
         AND r.created_at > ?
         AND r.report_type NOT LIKE '%weekly%'
       ORDER BY r.created_at DESC`
    )
      .bind(cutoff)
      .all<{ agent_id: string; content: string; agent_config: string }>();

    // De-duplicate: keep only the latest report per agent
    const seen = new Set<string>();
    const dailyReports: Array<{
      agentId: string;
      agentName: string;
      content: {
        headline: string;
        sections: Array<{ name: string; body: string; severity: string }>;
        actionItems: Array<{
          description: string;
          priority: string;
          sourceUrl?: string;
          assignee?: string;
        }>;
        healthSignal: string;
      };
    }> = [];

    for (const row of reportRows.results || []) {
      if (seen.has(row.agent_id)) continue;
      seen.add(row.agent_id);
      try {
        const content = JSON.parse(row.content);
        const agentConfig = JSON.parse(row.agent_config);
        dailyReports.push({
          agentId: row.agent_id,
          agentName: agentConfig.name || row.agent_id,
          content,
        });
      } catch {
        /* skip unparseable */
      }
    }

    // Load task data for the meeting
    let taskData: MeetingTaskData | undefined;
    try {
      // Proposed tasks awaiting prioritization
      const proposedRows = await this.env.DB.prepare(
        `SELECT id, title, description, status, priority, created_by, assigned_to,
                source_report_id, output, context, started_at, completed_at,
                due_by, tokens_used, created_at, updated_at
         FROM tasks WHERE status = 'proposed'
         ORDER BY priority DESC, created_at ASC LIMIT 20`
      ).all();

      // Recently completed tasks (last 48h)
      const completedCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
      const completedRows = await this.env.DB.prepare(
        `SELECT id, title, description, status, priority, created_by, assigned_to,
                source_report_id, output, context, started_at, completed_at,
                due_by, tokens_used, created_at, updated_at
         FROM tasks WHERE status = 'completed' AND completed_at > ?
         ORDER BY completed_at DESC LIMIT 10`
      ).bind(completedCutoff).all();

      const mapRow = (r: Record<string, unknown>): Task => ({
        id: r.id as string,
        title: r.title as string,
        description: r.description as string,
        status: r.status as Task["status"],
        priority: r.priority as number,
        createdBy: r.created_by as string,
        assignedTo: (r.assigned_to as string) || null,
        sourceReportId: (r.source_report_id as string) || null,
        output: r.output ? JSON.parse(r.output as string) : null,
        context: r.context ? JSON.parse(r.context as string) : null,
        startedAt: (r.started_at as string) || null,
        completedAt: (r.completed_at as string) || null,
        dueBy: (r.due_by as string) || null,
        tokensUsed: (r.tokens_used as number) || 0,
        createdAt: r.created_at as string,
        updatedAt: r.updated_at as string,
      });

      taskData = {
        proposedTasks: (proposedRows.results || []).map(mapRow),
        completedTasks: (completedRows.results || []).map(mapRow),
      };
    } catch (err) {
      console.error("Failed to load tasks for CEO meeting:", err);
    }

    console.log(
      `CEO meeting: synthesizing ${dailyReports.length} department reports from ${agentConfigs.length} agents` +
      (taskData ? `, ${taskData.proposedTasks.length} proposed tasks, ${taskData.completedTasks.length} completed tasks` : "")
    );

    return buildMeetingPrompt(
      config,
      agentConfigs,
      dailyReports,
      reportConfig,
      previousMeetings,
      ragContext ?? undefined,
      taskData
    );
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
      "daily-meeting": { model: defaultModel, maxTokens: 16384 },
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
   * Schedule the next daily/weekly alarm at this agent's staggered time slot.
   */
  /**
   * Public wrapper for manual task execution trigger.
   */
  async triggerTaskExecution(agentId: string): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    await this.ensureAgentId(agentId);
    const config = await this.getAgentConfig();
    if (!config) {
      return { ok: false, error: "No agent config found" };
    }
    try {
      await this.executeNextTask(config);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      return { ok: false, error: msg };
    }
  }

  /**
   * Execute the highest-priority queued task assigned to this agent.
   */
  private async executeNextTask(config: AgentDefinition): Promise<void> {
    // Skip CEO (prioritizes, doesn't execute) and agents without tools
    if (config.id === "ceo") return;

    // Find highest-priority queued task assigned to this agent
    const taskRow = await this.env.DB.prepare(
      `SELECT id, title, description, status, priority, created_by, assigned_to,
              source_report_id, output, context, started_at, completed_at,
              due_by, tokens_used, created_at, updated_at
       FROM tasks
       WHERE assigned_to = ? AND status = 'queued'
       ORDER BY priority DESC, created_at ASC
       LIMIT 1`
    )
      .bind(config.id)
      .first<Record<string, unknown>>();

    if (!taskRow) return; // No tasks to execute

    const task: Task = {
      id: taskRow.id as string,
      title: taskRow.title as string,
      description: taskRow.description as string,
      status: taskRow.status as Task["status"],
      priority: taskRow.priority as number,
      createdBy: taskRow.created_by as string,
      assignedTo: (taskRow.assigned_to as string) || null,
      sourceReportId: (taskRow.source_report_id as string) || null,
      output: taskRow.output ? JSON.parse(taskRow.output as string) : null,
      context: taskRow.context ? JSON.parse(taskRow.context as string) : null,
      startedAt: (taskRow.started_at as string) || null,
      completedAt: (taskRow.completed_at as string) || null,
      dueBy: (taskRow.due_by as string) || null,
      tokensUsed: (taskRow.tokens_used as number) || 0,
      createdAt: taskRow.created_at as string,
      updatedAt: taskRow.updated_at as string,
    };

    const now = new Date().toISOString();

    // Mark as in_progress
    await this.env.DB.prepare(
      `UPDATE tasks SET status = 'in_progress', started_at = ?, updated_at = ?
       WHERE id = ? AND status = 'queued'`
    )
      .bind(now, now, task.id)
      .run();

    console.log(`Starting task execution: "${task.title}" for ${config.id}`);

    try {
      // Load identities for context
      const identities = await this.loadIdentities();

      // Retrieve RAG context
      let ragContext: string | null = null;
      if (this.env.VECTORIZE && this.env.AI) {
        try {
          ragContext = await retrieveContext(
            { VECTORIZE: this.env.VECTORIZE, AI: this.env.AI },
            config.id,
            `${task.title} ${task.description}`
          );
        } catch (err) {
          console.error("RAG context retrieval failed:", err);
        }
      }

      // Build prompt
      const prompt = buildTaskExecutionPrompt(
        config,
        task,
        identities,
        ragContext,
        this.getOrgInfo()
      );

      // Call Claude
      const modelSettings = await this.getModelSettings("task-execution");
      const response = await callClaude(
        this.env.ANTHROPIC_API_KEY,
        prompt.system,
        [{ role: "user", content: prompt.user }],
        modelSettings.model,
        modelSettings.maxTokens
      );

      // Parse output
      let output: { summary: string; content: string; artifacts: Array<{ name: string; type: string; content: string }> };
      try {
        let cleaned = response.text.trim();
        if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
        else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
        if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
        cleaned = cleaned.trim();

        const parsed = JSON.parse(cleaned) as Record<string, unknown>;
        output = {
          summary: (parsed.summary as string) || "Task completed",
          content: (parsed.content as string) || cleaned,
          artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts as Array<{ name: string; type: string; content: string }> : [],
        };
      } catch {
        // If JSON parsing fails, use the raw text as content
        output = {
          summary: "Task completed (output parsing failed)",
          content: response.text.slice(0, 10000),
          artifacts: [],
        };
      }

      const completedAt = new Date().toISOString();
      const tokensUsed = (response.inputTokens || 0) + (response.outputTokens || 0);

      // Mark as completed
      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'completed', output = ?, completed_at = ?,
                tokens_used = ?, updated_at = ?
         WHERE id = ?`
      )
        .bind(JSON.stringify(output), completedAt, tokensUsed, completedAt, task.id)
        .run();

      console.log(
        `Task completed: "${task.title}" by ${config.id} (${tokensUsed} tokens)`
      );
    } catch (err) {
      console.error(`Task execution failed for "${task.title}":`, err);
      // Revert to queued so it can be retried next hour
      await this.env.DB.prepare(
        `UPDATE tasks SET status = 'queued', started_at = NULL, updated_at = ?
         WHERE id = ? AND status = 'in_progress'`
      )
        .bind(new Date().toISOString(), task.id)
        .run();
    }
  }

  /**
   * Dual alarm system: picks whichever is sooner — next report or next task check.
   * DOs only support one active alarm, so we compute both candidate times and
   * set the alarm for whichever comes first.
   */
  private async scheduleNextAlarm(config: AgentDefinition): Promise<void> {
    const tz = this.env.REPORT_TIMEZONE || "America/Chicago";

    // Candidate 1: Next report time
    let nextReport: Date | null = null;

    const hasDaily = config.outputs.reports.some(
      (r) => r.cadence === "daily"
    );

    if (hasDaily) {
      const { hour, minute } = getAgentReportTime(config.id);
      nextReport = nextWeekdayAlarm(hour, minute, tz, true);
    }

    // Candidate 2: Next task check (hourly, business hours 8am-6pm, weekdays only)
    // Skip for CEO (prioritizes, doesn't execute)
    let nextTask: Date | null = null;
    if (config.id !== "ceo") {
      // Stagger task checks by agent ID hash (0-14 minutes past the hour)
      let hash = 0;
      for (let i = 0; i < config.id.length; i++) {
        hash = ((hash << 5) - hash + config.id.charCodeAt(i)) | 0;
      }
      const staggerMinute = (hash >>> 0) % 15;

      const now = new Date();
      // Try each of the next 24 hours to find the next valid task slot
      for (let h = 1; h <= 24; h++) {
        const candidate = new Date(now.getTime() + h * 60 * 60 * 1000);
        // Snap to the staggered minute past the hour
        candidate.setUTCMinutes(staggerMinute, 0, 0);

        // Convert to local time to check business hours
        const offset = tzOffsetMs(candidate, tz);
        const localDate = new Date(candidate.getTime() + offset);
        const localHour = localDate.getUTCHours();
        const localDay = localDate.getUTCDay();

        // Must be weekday
        if (localDay === 0 || localDay === 6) continue;
        // Must be business hours (8am-6pm)
        if (localHour < 8 || localHour >= 18) continue;
        // Must be in the future
        if (candidate.getTime() <= now.getTime()) continue;

        nextTask = candidate;
        break;
      }
    }

    // Pick whichever is sooner
    let alarmTime: Date;
    let alarmType: string;

    if (nextReport && nextTask) {
      if (nextTask.getTime() < nextReport.getTime()) {
        alarmTime = nextTask;
        alarmType = "task";
      } else {
        alarmTime = nextReport;
        alarmType = "daily";
      }
    } else if (nextReport) {
      alarmTime = nextReport;
      alarmType = "daily";
    } else if (nextTask) {
      alarmTime = nextTask;
      alarmType = "task";
    } else {
      return; // No alarms needed
    }

    await this.ctx.storage.put("pending_alarm_type", alarmType);
    await this.ctx.storage.setAlarm(alarmTime.getTime());
    console.log(
      `Scheduled next ${config.id} ${alarmType} alarm for ${alarmTime.toISOString()}`
    );
  }
}
