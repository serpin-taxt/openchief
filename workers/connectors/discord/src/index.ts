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
import { getGuild, getChannel, getAllGuildChannels } from "./discord-api";

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

    // GET /channels — list guild channels with selection state (admin only)
    if (url.pathname === "/channels" && request.method === "GET") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const allChannels = await getAllGuildChannels(
          env.DISCORD_GUILD_ID,
          env.DISCORD_BOT_TOKEN
        );

        // Separate categories (type 4) from text channels (type 0, 5, 15)
        const categories = allChannels.filter((c) => c.type === 4);
        const textChannels = allChannels.filter((c) =>
          [0, 5, 15].includes(c.type)
        );

        // Build category lookup map
        const categoryMap = new Map(categories.map((c) => [c.id, c.name]));

        // Read selected channel IDs from KV
        const storedRaw = await env.KV.get("discord:allowed_channels");
        const selected: string[] = storedRaw ? JSON.parse(storedRaw) : [];

        // Map channels with category info
        const channels = textChannels.map((ch) => ({
          id: ch.id,
          name: ch.name,
          type: ch.type,
          categoryId: ch.parent_id || null,
          categoryName: ch.parent_id
            ? categoryMap.get(ch.parent_id) || "Other"
            : "No Category",
        }));

        return jsonResponse({ ok: true, channels, selected });
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : "Failed to list channels";
        return jsonResponse({ ok: false, error: msg }, 500);
      }
    }

    // PUT /channels — save selected channel IDs (admin only)
    if (url.pathname === "/channels" && request.method === "PUT") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const body = (await request.json()) as { channelIds: string[] };
        if (!Array.isArray(body.channelIds)) {
          return jsonResponse(
            { ok: false, error: "channelIds must be an array" },
            400
          );
        }
        if (body.channelIds.length > 0) {
          await env.KV.put(
            "discord:allowed_channels",
            JSON.stringify(body.channelIds)
          );
        } else {
          await env.KV.delete("discord:allowed_channels");
        }
        return jsonResponse({ ok: true, channelIds: body.channelIds });
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to save channel selection";
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
