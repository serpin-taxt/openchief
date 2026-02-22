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

    return Response.json({ error: "Not found" }, { status: 404 });
  },
};
