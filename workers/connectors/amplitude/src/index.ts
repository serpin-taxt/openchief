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
import { getChart } from "./amplitude-api";
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

export interface ChartConfig {
  id: string;
  label: string;
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

    // GET /charts — list configured chart IDs
    if (url.pathname === "/charts" && request.method === "GET") {
      const denied = requireAdmin(request, env.ADMIN_SECRET);
      if (denied) return denied;
      try {
        const raw = await env.KV.get("amplitude:config:charts");
        const charts: ChartConfig[] = raw ? JSON.parse(raw) : [];
        return jsonResponse({ ok: true, charts });
      } catch (err) {
        return jsonResponse(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    }

    // PUT /charts — save configured chart IDs
    if (url.pathname === "/charts" && request.method === "PUT") {
      const denied = requireAdmin(request, env.ADMIN_SECRET);
      if (denied) return denied;
      try {
        const body = (await request.json()) as { charts: ChartConfig[] };
        if (!Array.isArray(body.charts)) {
          return jsonResponse(
            { ok: false, error: "charts must be an array of { id, label } objects" },
            400,
          );
        }
        const cleaned = body.charts
          .filter((c) => c.id?.trim() && c.label?.trim())
          .map((c) => ({ id: c.id.trim(), label: c.label.trim() }));

        if (cleaned.length > 0) {
          await env.KV.put("amplitude:config:charts", JSON.stringify(cleaned), {
            expirationTtl: 365 * 24 * 60 * 60,
          });
        } else {
          await env.KV.delete("amplitude:config:charts");
        }
        return jsonResponse({ ok: true, charts: cleaned });
      } catch (err) {
        return jsonResponse(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          500,
        );
      }
    }

    // POST /charts/validate — check if a chart ID is accessible
    if (url.pathname === "/charts/validate" && request.method === "POST") {
      const denied = requireAdmin(request, env.ADMIN_SECRET);
      if (denied) return denied;
      try {
        const body = (await request.json()) as { id: string };
        const chartId = body.id?.trim();
        if (!chartId) {
          return jsonResponse({ ok: false, error: "Chart ID required" }, 400);
        }
        await getChart(
          env.AMPLITUDE_API_KEY,
          env.AMPLITUDE_SECRET_KEY,
          chartId,
        );
        return jsonResponse({ ok: true, chartId });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid chart";
        return jsonResponse({ ok: false, error: msg });
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
