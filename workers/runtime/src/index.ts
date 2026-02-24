import { AgentDurableObject } from "./agent-do";
import { backfillReports } from "./rag";

export { AgentDurableObject };

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  AGENT_DO: DurableObjectNamespace<AgentDurableObject>;
  ANTHROPIC_API_KEY: string;
  VECTORIZE?: VectorizeIndex;
  AI?: Ai;
  ORG_NAME?: string;
  ORG_CONTEXT?: string;
  DEFAULT_MODEL?: string;
  REPORT_TIMEZONE?: string;
}

export default {
  /**
   * Cron trigger: bootstrap alarm chains for all enabled agents.
   * Runs daily to ensure every agent's Durable Object has an alarm set.
   */
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const { results: agents } = await env.DB.prepare(
      "SELECT id FROM agent_definitions WHERE enabled = 1"
    ).all<{ id: string }>();

    for (const agent of agents) {
      const doId = env.AGENT_DO.idFromName(agent.id);
      const stub = env.AGENT_DO.get(doId);
      await stub.ensureAlarm(agent.id);
    }

    console.log(`Bootstrapped alarms for ${agents.length} agents`);
  },

  /**
   * HTTP handler for manual triggers, chat, and health checks.
   */
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check
    if (path === "/" || path === "/health") {
      return Response.json({
        service: "openchief-runtime",
        status: "ok",
      });
    }

    // POST /trigger/:agentId/:reportType — manually trigger a report
    const triggerMatch = path.match(/^\/trigger\/([^/]+)\/([^/]+)$/);
    if (triggerMatch && request.method === "POST") {
      const [, agentId, reportType] = triggerMatch;
      const asOf = url.searchParams.get("asOf") || undefined;

      const doId = env.AGENT_DO.idFromName(agentId);
      const stub = env.AGENT_DO.get(doId);
      const report = await stub.triggerReport(reportType, agentId, asOf);

      if (!report) {
        return Response.json({ error: "No report generated" }, { status: 404 });
      }
      return Response.json(report);
    }

    // POST /chat/:agentId — streaming chat
    const chatMatch = path.match(/^\/chat\/([^/]+)$/);
    if (chatMatch && request.method === "POST") {
      const [, agentId] = chatMatch;
      const body = (await request.json()) as {
        message: string;
        userEmail?: string;
        userName?: string;
      };

      if (!body.message) {
        return Response.json(
          { error: "message is required" },
          { status: 400 }
        );
      }

      const userEmail = body.userEmail || "anonymous@openchief";
      const userName = body.userName || "User";

      // Chat uses per-user DOs to isolate conversation history
      const chatDoId = env.AGENT_DO.idFromName(`chat:${agentId}:${userEmail}`);
      const stub = env.AGENT_DO.get(chatDoId);
      const stream = await stub.chat(body.message, userEmail, userName, agentId);

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // GET /chat/:agentId/history — get chat history
    const historyMatch = path.match(/^\/chat\/([^/]+)\/history$/);
    if (historyMatch && request.method === "GET") {
      const [, agentId] = historyMatch;
      const userEmail =
        url.searchParams.get("email") || "anonymous@openchief";

      const chatDoId = env.AGENT_DO.idFromName(`chat:${agentId}:${userEmail}`);
      const stub = env.AGENT_DO.get(chatDoId);
      const history = await stub.getChatHistory(agentId);

      return Response.json(history);
    }

    // POST /chat/:agentId/clear — clear chat history for a user
    const clearMatch = path.match(/^\/chat\/([^/]+)\/clear$/);
    if (clearMatch && request.method === "POST") {
      const [, agentId] = clearMatch;
      const userEmail =
        url.searchParams.get("email") || "anonymous@openchief";

      const chatDoId = env.AGENT_DO.idFromName(`chat:${agentId}:${userEmail}`);
      const stub = env.AGENT_DO.get(chatDoId);
      await stub.clearChatHistory(agentId);

      return Response.json({ ok: true, cleared: `chat:${agentId}:${userEmail}` });
    }

    // POST /trigger-task/:agentId — manually trigger task execution for an agent
    const taskMatch = path.match(/^\/trigger-task\/([^/]+)$/);
    if (taskMatch && request.method === "POST") {
      const [, agentId] = taskMatch;
      const doId = env.AGENT_DO.idFromName(agentId);
      const stub = env.AGENT_DO.get(doId);
      const result = await stub.triggerTaskExecution(agentId);
      return Response.json(result, { status: result.ok ? 200 : 500 });
    }

    // POST /admin/reset-alarms — force all agents to the staggered schedule
    if (path === "/admin/reset-alarms" && request.method === "POST") {
      const { results: agents } = await env.DB.prepare(
        "SELECT id FROM agent_definitions WHERE enabled = 1"
      ).all<{ id: string }>();

      for (const agent of agents) {
        const doId = env.AGENT_DO.idFromName(agent.id);
        const stub = env.AGENT_DO.get(doId);
        await stub.resetAlarm(agent.id);
      }

      return Response.json({
        ok: true,
        message: `Reset alarms for ${agents.length} agents`,
        agents: agents.map((a) => a.id),
      });
    }

    // POST /admin/backfill-vectorize — index existing reports into Vectorize
    if (path === "/admin/backfill-vectorize" && request.method === "POST") {
      if (!env.VECTORIZE || !env.AI) {
        return Response.json(
          { error: "Vectorize/AI not configured. Set vectorizeIndexName in openchief.config.ts" },
          { status: 400 }
        );
      }

      const result = await backfillReports({
        VECTORIZE: env.VECTORIZE,
        AI: env.AI,
        DB: env.DB,
      });

      return Response.json({
        message: "Backfill complete",
        indexed: result.indexed,
        errors: result.errors,
      });
    }

    // POST /tools/generate-voice — analyze messages and generate voice profile
    if (path === "/tools/generate-voice" && request.method === "POST") {
      const body = (await request.json()) as {
        personName: string;
        messages: string[];
      };

      if (!body.personName || !body.messages || body.messages.length === 0) {
        return Response.json(
          { error: "personName and messages are required" },
          { status: 400 },
        );
      }

      const apiKey = env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return Response.json(
          { error: "ANTHROPIC_API_KEY not configured" },
          { status: 500 },
        );
      }

      const { callClaude } = await import("./claude-client");
      const model = env.DEFAULT_MODEL || "claude-sonnet-4-6";

      const systemPrompt = `You are an expert at analyzing communication styles and writing patterns.
You will receive a collection of Slack messages written by a single person named "${body.personName}".
Analyze their writing style and produce a voice profile.

You must output ONLY valid JSON matching this exact shape:
{
  "voice": "...",
  "personality": "...",
  "outputStyle": "..."
}

Field guidelines:
- voice (2-4 sentences): HOW this person communicates — vocabulary choices, sentence structure, cadence, verbal habits, catchphrases, and tone. Be specific and cite patterns from their messages.
- personality (2-4 sentences): WHO this person is based on their writing — temperament, values, priorities, humor style, communication preferences, and interpersonal approach. Infer from patterns, not individual messages.
- outputStyle (1-2 sentences): How this person would FORMAT and PRESENT information in reports. E.g., "Direct and data-driven with bullet points" or "Narrative and conversational with context-setting before conclusions."

Be specific and evidence-based. Capture distinctive traits that differentiate this person from others. If messages are too few or generic to identify clear patterns, say so honestly in each field.`;

      const userPrompt = `Here are ${body.messages.length} Slack messages from ${body.personName}:\n\n${body.messages.map((msg, i) => `[${i + 1}] ${msg}`).join("\n\n")}\n\nAnalyze these messages and generate the voice profile JSON.`;

      try {
        const result = await callClaude(
          apiKey,
          systemPrompt,
          [{ role: "user", content: userPrompt }],
          model,
          2048,
        );

        // Parse the JSON response
        const cleaned = result.text
          .replace(/```json\s*/g, "")
          .replace(/```\s*/g, "")
          .trim();
        const parsed = JSON.parse(cleaned) as {
          voice: string;
          personality: string;
          outputStyle: string;
        };

        return Response.json({
          voice: parsed.voice,
          personality: parsed.personality,
          outputStyle: parsed.outputStyle,
          messageCount: body.messages.length,
          model,
          tokens: { input: result.inputTokens, output: result.outputTokens },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        return Response.json(
          { error: `Voice generation failed: ${msg}` },
          { status: 500 },
        );
      }
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
