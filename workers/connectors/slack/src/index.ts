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
import { runPollTasks, runIdentitySync, runDeepBackfill } from "./poll";
import { getTeamInfo } from "./slack-api";
import { isChannelIgnored } from "./ignored-channels";

interface Env {
  EVENTS_QUEUE: Queue;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  ADMIN_SECRET: string;
  IGNORED_CHANNELS?: string;
  IGNORE_BOTS?: string;
  KV: KVNamespace;
  DB: D1Database;
  /** Service binding to runtime worker — enables AI split-view chat when configured */
  AGENT_RUNTIME?: Fetcher;
  /** Bearer token for runtime /chat endpoint — must match runtime's ADMIN_SECRET */
  RUNTIME_ADMIN_SECRET?: string;
  /** Email of the superadmin user — always gets exec access to all agents */
  SUPERADMIN_EMAIL?: string;
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
    // ?task=identity  — only sync user profiles (for "Sync People" button)
    if (url.pathname === "/poll" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const task = url.searchParams.get("task");
      try {
        const result =
          task === "identity"
            ? await runIdentitySync(env)
            : await runPollTasks(env);
        return Response.json({ ok: true, result }, { status: 200 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Poll failed";
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    // POST /backfill -- deep historical backfill (admin only)
    // ?days=7 — only backfill messages from the last N days (default: all history)
    if (url.pathname === "/backfill" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      const daysParam = url.searchParams.get("days");
      const oldestTs = daysParam
        ? String(Math.floor((Date.now() - parseInt(daysParam, 10) * 86400_000) / 1000))
        : undefined;
      try {
        const result = await runDeepBackfill(env, oldestTs);
        return Response.json({ ok: true, result }, { status: 200 });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Backfill failed";
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    // GET /channels -- list available Slack channels (admin only)
    if (url.pathname === "/channels" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const raw = await env.KV.get("slack:channels:list");
        const channels: Array<{ id: string; name: string; is_private?: boolean }> =
          raw ? JSON.parse(raw) : [];
        return Response.json({ ok: true, channels });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed to list channels";
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }

    // POST /interactive -- Slack interactive payload (button clicks)
    if (url.pathname === "/interactive" && request.method === "POST") {
      const body = await request.text();

      // Verify Slack signature
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

      // Parse the payload (sent as application/x-www-form-urlencoded)
      const params = new URLSearchParams(body);
      const payloadStr = params.get("payload");
      if (!payloadStr) {
        return new Response("Missing payload", { status: 400 });
      }

      // Process in background — Slack requires 200 within 3 seconds
      ctx.waitUntil(handleInteractivePayload(JSON.parse(payloadStr), env));
      return new Response("", { status: 200 });
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

    const eventType = slackEvent.type as string;

    // ---- AI Assistant Events (split-view chat) ----
    // Only active when AGENT_RUNTIME service binding is configured
    if (env.AGENT_RUNTIME && env.RUNTIME_ADMIN_SECRET) {
      const aiEnv = {
        SLACK_BOT_TOKEN: env.SLACK_BOT_TOKEN,
        KV: env.KV,
        DB: env.DB,
        AGENT_RUNTIME: env.AGENT_RUNTIME,
        RUNTIME_ADMIN_SECRET: env.RUNTIME_ADMIN_SECRET,
        SUPERADMIN_EMAIL: env.SUPERADMIN_EMAIL,
      };

      if (eventType === "assistant_thread_started") {
        const { handleAssistantThreadStarted } = await import("./ai-chat");
        await handleAssistantThreadStarted(slackEvent, aiEnv);
        return;
      }

      if (eventType === "assistant_thread_context_changed") {
        const { handleAssistantThreadContextChanged } = await import("./ai-chat");
        await handleAssistantThreadContextChanged(slackEvent, aiEnv);
        return;
      }

      // DM messages: check if this is an assistant thread before normal processing
      const channelType = slackEvent.channel_type as string | undefined;
      if (eventType === "message" && channelType === "im") {
        // Skip bot's own messages to prevent loops
        if (slackEvent.bot_id || slackEvent.subtype === "bot_message") return;

        const { handleAssistantMessage } = await import("./ai-chat");
        const handled = await handleAssistantMessage(slackEvent, aiEnv);
        if (handled) return;
        // Not an assistant thread — fall through to normal event processing
      }
    }

    // ---- Standard event processing ----

    // Get workspace name
    const workspaceName = await getCachedWorkspaceName(env);

    // Resolve channel info from KV cache
    const channelId =
      (slackEvent.channel as string) ||
      ((slackEvent.item as Record<string, unknown>)?.channel as string);
    const channelInfo = channelId
      ? await getCachedChannelInfo(channelId, env)
      : { name: undefined, isPrivate: false };
    const channelName = channelInfo.name;

    // Determine if this is a private channel event
    // Prefer channel_type from Slack webhook payload (authoritative), fall back to cache
    const channelType = slackEvent.channel_type as string | undefined;
    const isPrivateChannel =
      channelType === "group" || (!channelType && channelInfo.isPrivate);

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
      workspaceName,
      { isPrivateChannel, ignoreBots: env.IGNORE_BOTS !== "false" }
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

async function getCachedChannelInfo(
  channelId: string,
  env: Env
): Promise<{ name?: string; isPrivate: boolean }> {
  const listRaw = await env.KV.get("slack:channels:list");
  if (listRaw) {
    const channels = JSON.parse(listRaw) as Array<{
      id: string;
      name: string;
      is_private?: boolean;
    }>;
    const found = channels.find((c) => c.id === channelId);
    if (found) return { name: found.name, isPrivate: found.is_private ?? false };
  }
  return { name: undefined, isPrivate: false };
}

// --- Interactive Payload (Task Approve/Reject Buttons) -------------------------

interface SlackInteractivePayload {
  type: string;
  user: { id: string; username: string; name?: string };
  actions: Array<{
    action_id: string;
    value: string;
    block_id: string;
  }>;
  response_url: string;
  message?: Record<string, unknown>;
}

async function handleInteractivePayload(
  payload: SlackInteractivePayload,
  env: Env
): Promise<void> {
  try {
    if (payload.type !== "block_actions" || !payload.actions?.length) return;

    const action = payload.actions[0];
    const taskId = action.value;
    const actionId = action.action_id;
    const userName = payload.user.name || payload.user.username;
    const now = new Date().toISOString();

    if (actionId === "task_approve") {
      await env.DB.prepare(
        `UPDATE tasks SET status = 'queued', updated_at = ?
         WHERE id = ? AND status = 'proposed'`
      )
        .bind(now, taskId)
        .run();

      // Update the Slack message to reflect approval
      await fetch(payload.response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replace_original: true,
          text: `Task approved by ${userName}`,
          blocks: replaceActionsWithStatus(
            payload.message,
            action.block_id,
            `:white_check_mark: *Approved* by ${userName}`
          ),
        }),
      });

      console.log(`Task ${taskId} approved by ${userName}`);
    } else if (actionId === "task_reject") {
      await env.DB.prepare(
        `UPDATE tasks SET status = 'cancelled', updated_at = ?
         WHERE id = ? AND status = 'proposed'`
      )
        .bind(now, taskId)
        .run();

      // Update the Slack message to reflect rejection
      await fetch(payload.response_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replace_original: true,
          text: `Task rejected by ${userName}`,
          blocks: replaceActionsWithStatus(
            payload.message,
            action.block_id,
            `:x: *Rejected* by ${userName}`
          ),
        }),
      });

      console.log(`Task ${taskId} rejected by ${userName}`);
    }
  } catch (err) {
    console.error("Interactive payload error:", err);
  }
}

/**
 * Replace the actions block (buttons) with a context block showing the decision.
 * Preserves all other blocks (title, description, metadata).
 */
function replaceActionsWithStatus(
  message: Record<string, unknown> | undefined,
  actionBlockId: string,
  statusText: string
): Array<Record<string, unknown>> {
  const originalBlocks = (message?.blocks as Array<Record<string, unknown>>) || [];

  return originalBlocks.map((block) => {
    if (block.block_id === actionBlockId) {
      return {
        type: "context",
        elements: [{ type: "mrkdwn", text: statusText }],
      };
    }
    return block;
  });
}
