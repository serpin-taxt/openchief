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

/**
 * Default webhook topics to subscribe to in the Intercom Developer Hub.
 * These cover the most useful real-time events for business intelligence.
 */
const DEFAULT_WEBHOOK_TOPICS = [
  "conversation.user.replied",
  "conversation.admin.replied",
  "conversation.admin.noted",
  "conversation.admin.closed",
  "ticket.created",
] as const;

/**
 * All webhook topics the connector can handle (superset of defaults).
 */
const ALL_SUPPORTED_TOPICS = [
  ...DEFAULT_WEBHOOK_TOPICS,
  "conversation.user.created",
  "conversation.admin.single.created",
  "conversation.admin.assigned",
  "conversation.admin.opened",
  "conversation.admin.snoozed",
  "conversation.admin.unsnoozed",
  "conversation.rating.added",
  "conversation.rating.remarked",
  "ticket.state.updated",
  "contact.created",
  "user.created",
] as const;

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

    // GET /webhook-setup — returns the webhook URL and topics to configure
    if (url.pathname === "/webhook-setup" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;

      const webhookUrl = new URL("/webhook", url.origin).toString();
      return jsonResponse({
        instructions: "Configure these in your Intercom Developer Hub → Your App → Webhooks",
        webhookUrl,
        defaultTopics: [...DEFAULT_WEBHOOK_TOPICS],
        allSupportedTopics: [...ALL_SUPPORTED_TOPICS],
        docsUrl: "https://developers.intercom.com/docs/webhooks/setting-up-webhooks",
      });
    }

    // GET /webhook-topics — returns all topics with selection state
    if (url.pathname === "/webhook-topics" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;

      const storedRaw = await env.KV.get("intercom:webhook_topics");
      const selected: string[] = storedRaw
        ? JSON.parse(storedRaw)
        : [...DEFAULT_WEBHOOK_TOPICS];
      const selectedSet = new Set(selected);

      return jsonResponse({
        ok: true,
        topics: ALL_SUPPORTED_TOPICS.map((topic) => ({
          topic,
          selected: selectedSet.has(topic),
          isDefault: (DEFAULT_WEBHOOK_TOPICS as readonly string[]).includes(topic),
        })),
        selected,
      });
    }

    // PUT /webhook-topics — save topic selection
    if (url.pathname === "/webhook-topics" && request.method === "PUT") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;

      const body = await request.json() as { topics: string[] };
      if (!Array.isArray(body.topics)) {
        return jsonResponse({ ok: false, error: "topics must be an array" }, 400);
      }

      // Validate all topics are in ALL_SUPPORTED_TOPICS
      const validTopics = new Set<string>(ALL_SUPPORTED_TOPICS);
      const invalid = body.topics.filter((t) => !validTopics.has(t));
      if (invalid.length > 0) {
        return jsonResponse({ ok: false, error: `Invalid topics: ${invalid.join(", ")}` }, 400);
      }

      await env.KV.put("intercom:webhook_topics", JSON.stringify(body.topics));

      return jsonResponse({ ok: true, selected: body.topics });
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
    // Check topic filter — drop events for topics the user hasn't selected
    const storedTopics = await env.KV.get("intercom:webhook_topics");
    if (storedTopics) {
      const selectedTopics: string[] = JSON.parse(storedTopics);
      if (!selectedTopics.includes(payload.topic)) {
        console.log(`Dropping unselected Intercom topic: ${payload.topic}`);
        return;
      }
    }
    // If no stored topics, accept all (backwards compat / first-time setup)

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
