/**
 * OpenChief Intercom Connector
 *
 * Receives Intercom webhook notifications (HMAC-SHA1 verified), normalizes
 * events, and publishes to the openchief-events queue.
 *
 * Also runs periodic polling to fetch recently updated conversations.
 */

import { verifyIntercomSignature } from "./webhook-verify";
import { normalizeIntercomEvent, type IntercomWebhookPayload } from "./normalize";
import { runPollTasks, runDeepBackfill } from "./poll";

interface Env {
  EVENTS_QUEUE: Queue;
  INTERCOM_ACCESS_TOKEN: string;
  INTERCOM_CLIENT_SECRET: string;
  ADMIN_SECRET: string;
  KV: KVNamespace;
  DB: D1Database;
}

function requireAdmin(request: Request, env: Env): Response | null {
  const auth = request.headers.get("Authorization");
  if (!env.ADMIN_SECRET || auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // POST /poll — manual trigger for polling (admin only)
    if (url.pathname === "/poll" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const result = await runPollTasks(env);
        return jsonResponse({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Poll failed";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // POST /backfill — deep historical backfill (admin only)
    if (url.pathname === "/backfill" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const result = await runDeepBackfill(env);
        return jsonResponse({ ok: true, result });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Backfill failed";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // POST /webhook — Intercom webhook endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();

      // Verify HMAC signature
      const signature = request.headers.get("X-Hub-Signature");
      const valid = await verifyIntercomSignature(
        body,
        signature,
        env.INTERCOM_CLIENT_SECRET
      );
      if (!valid) {
        return new Response("Invalid signature", { status: 401 });
      }

      // Parse and process in background for fast response
      const payload = JSON.parse(body) as IntercomWebhookPayload;

      // Ignore Intercom ping/health-check events
      if (payload.topic === "ping") {
        return new Response("ok", { status: 200 });
      }

      ctx.waitUntil(handleWebhookEvent(payload, env));

      return new Response("ok", { status: 200 });
    }

    // Health check
    if (request.method === "GET") {
      return jsonResponse({
        service: "openchief-connector-intercom",
        status: "ok",
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Scheduled handler — runs every 30 minutes
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ) {
    try {
      const result = await runPollTasks(env);
      console.log("Intercom poll complete:", JSON.stringify(result));
    } catch (err) {
      console.error(
        "Intercom poll failed:",
        err instanceof Error ? err.message : err
      );
    }
  },
};

// --- Event Processing --------------------------------------------------------

async function handleWebhookEvent(
  payload: IntercomWebhookPayload,
  env: Env
): Promise<void> {
  try {
    const event = normalizeIntercomEvent(payload);
    if (!event) return;

    await env.EVENTS_QUEUE.send(event);
    console.log(`Processed Intercom event: ${event.eventType} (${payload.topic})`);
  } catch (err) {
    console.error("Intercom event processing error:", err);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
