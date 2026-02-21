/**
 * OpenChief Slack Connector
 *
 * Receives Slack Events API webhooks, normalizes them to OpenChiefEvent format,
 * and publishes to the openchief-events queue.
 *
 * Also runs periodic polling to auto-join channels, sync users, and backfill.
 */

import { verifySlackSignature } from "./webhook-verify";
import { normalizeSlackEvent } from "./normalize";
import { resolveUser } from "./user-cache";
import { runPollTasks, runDeepBackfill } from "./poll";
import { getTeamInfo } from "./slack-api";
import { isChannelIgnored } from "./ignored-channels";

interface Env {
  EVENTS_QUEUE: Queue;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ADMIN_SECRET: string;
  IGNORED_CHANNELS?: string;
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

    // POST /poll -- manual trigger for polling (admin only)
    if (url.pathname === "/poll" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const result = await runPollTasks(env);
        return Response.json({ ok: true, result }, { status: 200 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Poll failed";
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    // POST /backfill -- deep historical backfill (admin only)
    if (url.pathname === "/backfill" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const result = await runDeepBackfill(env);
        return Response.json({ ok: true, result }, { status: 200 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Backfill failed";
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    // POST /webhook -- Slack Events API endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();
      const parsed = JSON.parse(body) as Record<string, unknown>;

      // 1. Handle URL verification challenge
      if (parsed.type === "url_verification") {
        return Response.json(
          { challenge: parsed.challenge },
          { status: 200 }
        );
      }

      // 2. Verify Slack signature
      const timestamp = request.headers.get("x-slack-request-timestamp");
      const signature = request.headers.get("x-slack-signature");
      const valid = await verifySlackSignature(
        body,
        timestamp,
        signature,
        env.SLACK_SIGNING_SECRET
      );
      if (!valid) {
        return new Response("Invalid signature", { status: 401 });
      }

      // 3. Handle event_callback -- process in background for fast response
      if (parsed.type === "event_callback") {
        ctx.waitUntil(handleEventCallback(parsed, env));
      }

      // Respond immediately -- Slack requires 200 within 3 seconds
      return new Response("ok", { status: 200 });
    }

    // GET / -- health check
    if (request.method === "GET") {
      return Response.json({
        service: "openchief-connector-slack",
        status: "ok",
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Scheduled handler -- runs every 30 minutes
  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    try {
      const result = await runPollTasks(env);
      console.log("Poll complete:", JSON.stringify(result));
    } catch (err) {
      console.error(
        "Poll failed:",
        err instanceof Error ? err.message : err
      );
    }
  },
};

// --- Event Processing -----------------------------------------------------------

async function handleEventCallback(
  parsed: Record<string, unknown>,
  env: Env
): Promise<void> {
  try {
    const slackEvent = parsed.event as Record<string, unknown>;
    if (!slackEvent) return;

    // Get workspace name
    const workspaceName = await getCachedWorkspaceName(env);

    // Resolve channel name from KV cache
    const channelId =
      (slackEvent.channel as string) ||
      ((slackEvent.item as Record<string, unknown>)?.channel as string);
    const channelName = channelId
      ? await getCachedChannelName(channelId, env)
      : undefined;

    // Skip ignored channels
    if (channelName && isChannelIgnored(channelName, env.IGNORED_CHANNELS)) {
      return;
    }

    // User resolver
    const resolver = (userId: string) =>
      resolveUser(userId, env.KV, env.SLACK_BOT_TOKEN);

    // Normalize
    const events = await normalizeSlackEvent(
      slackEvent,
      channelName,
      resolver,
      workspaceName
    );

    // Enqueue
    for (const event of events) {
      await env.EVENTS_QUEUE.send(event);
    }

    if (events.length > 0) {
      console.log(
        `Processed ${events.length} event(s): ${events.map((e) => e.eventType).join(", ")}`
      );
    }
  } catch (err) {
    console.error("Event processing error:", err);
  }
}

async function getCachedWorkspaceName(env: Env): Promise<string> {
  const cached = await env.KV.get("slack:workspace:name");
  if (cached) return cached;

  try {
    const team = await getTeamInfo(env.SLACK_BOT_TOKEN);
    await env.KV.put("slack:workspace:name", team.name, {
      expirationTtl: 86400,
    });
    return team.name;
  } catch {
    return "workspace";
  }
}

async function getCachedChannelName(
  channelId: string,
  env: Env
): Promise<string | undefined> {
  const listRaw = await env.KV.get("slack:channels:list");
  if (listRaw) {
    const channels = JSON.parse(listRaw) as Array<{
      id: string;
      name: string;
    }>;
    const found = channels.find((c) => c.id === channelId);
    if (found) return found.name;
  }
  return undefined;
}
