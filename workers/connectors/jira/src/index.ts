/**
 * OpenChief Jira Connector
 *
 * Polls the Jira Cloud REST API for issue changes, transitions, comments,
 * and sprint events. Normalizes them to OpenChiefEvent format and publishes
 * to the openchief-events queue.
 *
 * Supports both Jira Software (issues, sprints, boards) and Jira core.
 */

import { runPoll, runBackfill } from "./poll";
import { syncJiraIdentities } from "./identity-sync";
import type { PollEnv } from "./poll";

interface Env extends PollEnv {
  ADMIN_SECRET: string;
  DB: D1Database;
}

function requireAdmin(request: Request, env: Env): Response | null {
  const auth = request.headers.get("Authorization");
  if (!env.ADMIN_SECRET || auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /poll — manual trigger for polling (admin only)
    if (url.pathname === "/poll" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const result = await runPoll(env);
        return jsonResponse({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Poll failed";
        console.error("Jira poll failed:", msg);
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // POST /backfill — deep backfill (admin only), default 30 days
    if (url.pathname === "/backfill" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const days = Number(url.searchParams.get("days") || "30");
        const result = await runBackfill(env, days);
        return jsonResponse({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Backfill failed";
        console.error("Jira backfill failed:", msg);
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // POST /identity — sync Jira users to identity_mappings (admin only)
    if (url.pathname === "/identity" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const result = await syncJiraIdentities(env);
        return jsonResponse({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Identity sync failed";
        console.error("Jira identity sync failed:", msg);
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({
        service: "openchief-connector-jira",
        status: "ok",
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Scheduled handler — polls Jira API on cron
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    try {
      const result = await runPoll(env);
      console.log("Jira scheduled poll:", JSON.stringify(result));
    } catch (err) {
      console.error(
        "Jira poll failed:",
        err instanceof Error ? err.message : err
      );
    }
  },
};
