/**
 * OpenChief Amplitude Connector
 *
 * Periodically polls Amplitude Analytics API for key metrics (DAU, WAU, etc.),
 * normalizes them to OpenChiefEvent format, and publishes to the events queue.
 *
 * Unlike webhook-based connectors, Amplitude is pull-only — no webhook endpoint.
 * The /webhook endpoint accepts manual metric pushes for custom dashboards.
 */

import { runPollTasks } from "./poll";
import { normalizeMetric, type MetricSnapshot } from "./normalize";
import { requireAdmin } from "@openchief/shared";

interface Env {
  EVENTS_QUEUE: Queue;
  AMPLITUDE_API_KEY: string;
  AMPLITUDE_SECRET_KEY: string;
  AMPLITUDE_PROJECT_NAME?: string;
  ADMIN_SECRET: string;
  KV: KVNamespace;
  DB: D1Database;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // POST /poll — manual trigger for metric fetch
    if (url.pathname === "/poll" && request.method === "POST") {
      const denied = requireAdmin(request, env.ADMIN_SECRET);
      if (denied) return denied;
      try {
        const result = await runPollTasks(env);
        return jsonResponse({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Poll failed";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // POST /webhook — accept manual metric pushes
    // Useful for custom dashboards or scripts pushing metrics
    if (url.pathname === "/webhook" && request.method === "POST") {
      const denied = requireAdmin(request, env.ADMIN_SECRET);
      if (denied) return denied;
      try {
        const body = (await request.json()) as {
          metrics: MetricSnapshot[];
          projectName?: string;
        };

        const projectName =
          body.projectName || env.AMPLITUDE_PROJECT_NAME || "default";
        let count = 0;
        for (const snap of body.metrics) {
          const event = normalizeMetric(snap, projectName);
          await env.EVENTS_QUEUE.send(event);
          count++;
        }

        return jsonResponse({ ok: true, eventsPublished: count });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Webhook failed";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // Health check
    if (request.method === "GET") {
      return jsonResponse({
        service: "openchief-connector-amplitude",
        status: "ok",
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Scheduled handler — runs every 6 hours
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ) {
    try {
      const result = await runPollTasks(env);
      console.log("Amplitude poll complete:", JSON.stringify(result));
    } catch (err) {
      console.error(
        "Amplitude poll failed:",
        err instanceof Error ? err.message : err
      );
    }
  },
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
