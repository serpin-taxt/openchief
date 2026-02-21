/**
 * OpenChief Discord Connector
 *
 * Receives Discord interaction webhooks (Ed25519 verified), normalizes events,
 * and publishes to the openchief-events queue.
 *
 * Also runs periodic polling to fetch messages from guild text channels.
 */

import { verifyDiscordSignature } from "./webhook-verify";
import { normalizeMessage } from "./normalize";
import { runPollTasks, runDeepBackfill } from "./poll";
import { getGuild, getChannel } from "./discord-api";

interface Env {
  EVENTS_QUEUE: Queue;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_GUILD_ID: string;
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

    // POST /webhook — Discord Interactions endpoint
    if (url.pathname === "/webhook" && request.method === "POST") {
      const body = await request.text();
      const signature = request.headers.get("x-signature-ed25519");
      const timestamp = request.headers.get("x-signature-timestamp");

      // Verify Ed25519 signature
      const valid = await verifyDiscordSignature(
        body,
        signature,
        timestamp,
        env.DISCORD_PUBLIC_KEY
      );
      if (!valid) {
        return new Response("Invalid signature", { status: 401 });
      }

      const interaction = JSON.parse(body) as Record<string, unknown>;

      // Handle PING (type 1) — Discord verification handshake
      if (interaction.type === 1) {
        return jsonResponse({ type: 1 });
      }

      // For other interaction types, ack immediately and process in background
      // Type 2 = APPLICATION_COMMAND, Type 3 = MESSAGE_COMPONENT, etc.
      // We don't need to process these for the PM agent — polling covers messages

      return jsonResponse({ type: 1 }); // ACK
    }

    // Health check
    if (request.method === "GET") {
      return jsonResponse({
        service: "openchief-connector-discord",
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
      console.log("Discord poll complete:", JSON.stringify(result));
    } catch (err) {
      console.error(
        "Discord poll failed:",
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
