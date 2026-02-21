/**
 * OpenChief Google Analytics 4 Connector
 *
 * Polling-only connector that fetches daily website analytics from GA4:
 * page views, traffic sources, referrers, geography, and site overview.
 *
 * Endpoints:
 *   GET  /         -> health check
 *   POST /poll     -> manual poll (admin auth required)
 *   POST /backfill -> full re-sync ignoring dedup (admin auth required)
 *
 * Scheduled:
 *   Cron every 6 hours -> automatic poll for yesterday's data
 */

import { pollGA4 } from "./poll";

interface Env {
  EVENTS_QUEUE: Queue;
  KV: KVNamespace;
  DB: D1Database;
  GA4_SERVICE_ACCOUNT_KEY: string;
  GA4_PROPERTY_ID: string;
  ADMIN_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // -- Health check --
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          service: "openchief-connector-googleanalytics",
          status: "ok",
          propertyId: env.GA4_PROPERTY_ID || "(not set)",
          timestamp: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // -- Manual poll --
    if (url.pathname === "/poll" && request.method === "POST") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const result = await pollGA4(env);
        return new Response(JSON.stringify({ ok: true, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Manual poll failed:", err);
        return new Response(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    // -- Backfill (ignores dedup) --
    if (url.pathname === "/backfill" && request.method === "POST") {
      if (!requireAdmin(request, env)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const result = await pollGA4(env, { backfill: true });
        return new Response(JSON.stringify({ ok: true, backfill: true, result }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Backfill failed:", err);
        return new Response(
          JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
          {
            status: 500,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },

  // -- Scheduled polling --
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      console.log("GA4 scheduled poll starting...");
      const result = await pollGA4(env);
      console.log("GA4 scheduled poll complete:", JSON.stringify(result));
    } catch (err) {
      console.error("GA4 scheduled poll failed:", err);
    }
  },
};

// --- Auth Helper ---

function requireAdmin(request: Request, env: Env): boolean {
  const auth = request.headers.get("Authorization");
  return auth === `Bearer ${env.ADMIN_SECRET}`;
}
