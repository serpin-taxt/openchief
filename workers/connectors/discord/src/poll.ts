/**
 * Periodic polling for Discord messages.
 *
 * Fetches recent messages from relevant text channels in the configured guild,
 * normalizes them, and publishes to the events queue.
 *
 * Uses KV to track the last message ID seen per channel.
 */

import {
  getGuild,
  getGuildChannels,
  getChannelMessages,
} from "./discord-api";
import type { DiscordChannel } from "./discord-api";
import { normalizeMessage } from "./normalize";

interface Env {
  EVENTS_QUEUE: Queue;
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  DISCORD_ALLOWED_CHANNELS?: string;
  KV: KVNamespace;
  DB: D1Database;
}

/**
 * Parse allowed channels from the DISCORD_ALLOWED_CHANNELS env var.
 * Returns null if not set (meaning all channels are allowed).
 */
function parseAllowedChannels(env: Env): Set<string> | null {
  if (!env.DISCORD_ALLOWED_CHANNELS) return null;
  const names = env.DISCORD_ALLOWED_CHANNELS.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) return null;
  return new Set(names);
}

function isRelevantChannel(
  channel: DiscordChannel,
  allowedChannels: Set<string> | null
): boolean {
  // If no allowed channels configured, allow all text channels
  if (!allowedChannels) return true;

  // Channel names may look like "emoji・name" — extract the part after "・"
  const bare = channel.name.includes("・")
    ? channel.name.split("・").pop()!
    : channel.name;
  return allowedChannels.has(bare);
}

/** Rate-limit helper: wait between Discord API calls */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runPollTasks(
  env: Env
): Promise<{ channels: number; messages: number; events: number }> {
  const guild = await getGuild(env.DISCORD_GUILD_ID, env.DISCORD_BOT_TOKEN);
  const allChannels = await getGuildChannels(
    env.DISCORD_GUILD_ID,
    env.DISCORD_BOT_TOKEN
  );
  const allowedChannels = parseAllowedChannels(env);
  const channels = allChannels.filter((ch) =>
    isRelevantChannel(ch, allowedChannels)
  );

  let totalMessages = 0;
  let totalEvents = 0;

  for (const channel of channels) {
    try {
      await delay(500); // Respect Discord rate limits
      // Get cursor: the last message ID we processed for this channel
      const cursorKey = `discord:cursor:${channel.id}`;
      const lastMessageId = await env.KV.get(cursorKey);

      const messages = await getChannelMessages(
        channel.id,
        env.DISCORD_BOT_TOKEN,
        {
          after: lastMessageId || undefined,
          limit: 100,
        }
      );

      if (messages.length === 0) continue;

      totalMessages += messages.length;

      // Discord returns newest-first, so reverse for chronological processing
      const sorted = messages.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      for (const msg of sorted) {
        const event = normalizeMessage(msg, channel.name, guild.name);
        if (event) {
          await env.EVENTS_QUEUE.send(event);
          totalEvents++;
        }
      }

      // Update cursor to the newest message ID
      const newestId = sorted[sorted.length - 1].id;
      await env.KV.put(cursorKey, newestId, { expirationTtl: 86400 * 30 }); // 30 day TTL
    } catch (err) {
      console.error(
        `Error polling channel #${channel.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return { channels: channels.length, messages: totalMessages, events: totalEvents };
}

/**
 * Deep backfill — fetch historical messages from all channels.
 * Call repeatedly until all channels are caught up.
 */
export async function runDeepBackfill(
  env: Env
): Promise<{ channels: number; messages: number; events: number; done: boolean }> {
  const guild = await getGuild(env.DISCORD_GUILD_ID, env.DISCORD_BOT_TOKEN);
  const allChannels = await getGuildChannels(
    env.DISCORD_GUILD_ID,
    env.DISCORD_BOT_TOKEN
  );
  const allowedChannels = parseAllowedChannels(env);
  const channels = allChannels.filter((ch) =>
    isRelevantChannel(ch, allowedChannels)
  );

  let totalMessages = 0;
  let totalEvents = 0;
  let allDone = true;

  for (const channel of channels) {
    try {
      await delay(500); // Respect Discord rate limits
      const backfillKey = `discord:backfill:${channel.id}`;
      const lastBackfillId = await env.KV.get(backfillKey);

      const messages = await getChannelMessages(
        channel.id,
        env.DISCORD_BOT_TOKEN,
        {
          after: lastBackfillId || undefined,
          limit: 100,
        }
      );

      if (messages.length === 0) continue;

      // If we got 100 messages, there might be more
      if (messages.length >= 100) allDone = false;

      totalMessages += messages.length;

      const sorted = messages.sort(
        (a, b) =>
          new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );

      for (const msg of sorted) {
        const event = normalizeMessage(msg, channel.name, guild.name);
        if (event) {
          await env.EVENTS_QUEUE.send(event);
          totalEvents++;
        }
      }

      // Update backfill cursor
      const newestId = sorted[sorted.length - 1].id;
      await env.KV.put(backfillKey, newestId, { expirationTtl: 86400 * 7 });

      // Also update the poll cursor so regular polling picks up from here
      const cursorKey = `discord:cursor:${channel.id}`;
      const existing = await env.KV.get(cursorKey);
      if (!existing || BigInt(newestId) > BigInt(existing)) {
        await env.KV.put(cursorKey, newestId, { expirationTtl: 86400 * 30 });
      }
    } catch (err) {
      console.error(
        `Error backfilling channel #${channel.name}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return {
    channels: channels.length,
    messages: totalMessages,
    events: totalEvents,
    done: allDone,
  };
}
