/**
 * Cron-triggered polling tasks:
 * 1. Auto-join new public channels
 * 2. Sync user profiles to KV + D1
 * 3. Backfill message gaps (rate-limited)
 */

import type { OpenChiefEvent } from "@openchief/shared";
import {
  listConversations,
  joinConversation,
  getConversationHistory,
  getConversationHistoryDeep,
  listUsers,
  getTeamInfo,
} from "./slack-api";
import { bulkCacheUsers, resolveUser } from "./user-cache";
import { syncIdentities } from "./identity-sync";
import { normalizeSlackEvent } from "./normalize";
import { isChannelIgnored } from "./ignored-channels";

interface PollEnv {
  SLACK_BOT_TOKEN: string;
  IGNORED_CHANNELS?: string;
  KV: KVNamespace;
  DB: D1Database;
  EVENTS_QUEUE: Queue;
}

interface PollResult {
  autoJoin: { joined: number };
  userSync: { synced: number; skipped: number };
  backfill: { channels: number; events: number };
}

export async function runPollTasks(env: PollEnv): Promise<PollResult> {
  const startTime = Date.now();
  const result: PollResult = {
    autoJoin: { joined: 0 },
    userSync: { synced: 0, skipped: 0 },
    backfill: { channels: 0, events: 0 },
  };

  // Get workspace name (cached)
  const workspaceName = await getWorkspaceName(env);

  // Task 1: Auto-join public channels (~5s)
  try {
    result.autoJoin = await autoJoinChannels(env);
    console.log(`Auto-join: ${result.autoJoin.joined} channels joined`);
  } catch (err) {
    console.error("Auto-join failed:", err);
  }

  // Task 2: Sync user profiles (~10s)
  if (Date.now() - startTime < 15_000) {
    try {
      result.userSync = await syncUserProfiles(env);
      console.log(
        `User sync: ${result.userSync.synced} synced, ${result.userSync.skipped} skipped`
      );
    } catch (err) {
      console.error("User sync failed:", err);
    }
  }

  // Task 3: Backfill message gaps (~15s max)
  if (Date.now() - startTime < 20_000) {
    try {
      result.backfill = await backfillMessages(
        env,
        workspaceName,
        startTime
      );
      console.log(
        `Backfill: ${result.backfill.channels} channels, ${result.backfill.events} events`
      );
    } catch (err) {
      console.error("Backfill failed:", err);
    }
  }

  return result;
}

// --- Task 1: Auto-Join ----------------------------------------------------------

async function autoJoinChannels(
  env: PollEnv
): Promise<{ joined: number }> {
  const channels = await listConversations(
    env.SLACK_BOT_TOKEN,
    "public_channel"
  );

  let joined = 0;
  for (const ch of channels) {
    if (!ch.is_member && !ch.is_archived) {
      try {
        await joinConversation(env.SLACK_BOT_TOKEN, ch.id);
        joined++;
        console.log(`Joined #${ch.name}`);
      } catch (err) {
        // conversations.join may fail for some restricted channels
        console.warn(`Could not join #${ch.name}:`, err);
      }
    }
  }

  // Cache channel list for backfill reference
  const channelMap = channels
    .filter((ch) => ch.is_member && !ch.is_archived)
    .map((ch) => ({ id: ch.id, name: ch.name }));
  await env.KV.put("slack:channels:list", JSON.stringify(channelMap), {
    expirationTtl: 3600,
  });

  return { joined };
}

// --- Task 2: User Sync ----------------------------------------------------------

async function syncUserProfiles(
  env: PollEnv
): Promise<{ synced: number; skipped: number }> {
  const users = await listUsers(env.SLACK_BOT_TOKEN);

  // Update KV cache
  await bulkCacheUsers(users, env.KV);

  // Sync to D1 identity_mappings
  const result = await syncIdentities(users, env.DB);

  return { synced: result.upserted, skipped: result.skipped };
}

// --- Task 3: Backfill -----------------------------------------------------------

async function backfillMessages(
  env: PollEnv,
  workspaceName: string,
  startTime: number
): Promise<{ channels: number; events: number }> {
  // Load channel list
  const channelListRaw = await env.KV.get("slack:channels:list");
  if (!channelListRaw) return { channels: 0, events: 0 };

  const channels = JSON.parse(channelListRaw) as Array<{
    id: string;
    name: string;
  }>;

  // Load the backfill cursor (which channel index we're at)
  const cursorRaw = await env.KV.get("slack:backfill:cursor");
  let channelIndex = cursorRaw ? parseInt(cursorRaw, 10) : 0;
  if (channelIndex >= channels.length) channelIndex = 0; // Wrap around

  let totalChannels = 0;
  let totalEvents = 0;

  // Process 1-2 channels per run (rate limit: ~1 req/min for conversations.history)
  for (let i = 0; i < 2 && channelIndex + i < channels.length; i++) {
    // Time guard: stop if running low on time
    if (Date.now() - startTime > 25_000) break;

    const ch = channels[channelIndex + i];
    if (isChannelIgnored(ch.name, env.IGNORED_CHANNELS)) continue;

    const cursorKey = `slack:poll:cursor:${ch.id}`;
    const lastTs = await env.KV.get(cursorKey);

    try {
      const messages = await getConversationHistory(
        env.SLACK_BOT_TOKEN,
        ch.id,
        lastTs || undefined,
        100
      );

      if (messages.length > 0) {
        // Normalize and enqueue
        const resolver = (userId: string) =>
          resolveUser(userId, env.KV, env.SLACK_BOT_TOKEN);

        for (const msg of messages) {
          const events = await normalizeSlackEvent(
            msg as unknown as Record<string, unknown>,
            ch.name,
            resolver,
            workspaceName
          );
          for (const event of events) {
            await env.EVENTS_QUEUE.send(event);
            totalEvents++;
          }
        }

        // Update cursor to latest message ts
        const latestTs = messages[0]?.ts; // messages come newest-first
        if (latestTs) {
          await env.KV.put(cursorKey, latestTs, {
            expirationTtl: 86400 * 30,
          });
        }
      }

      totalChannels++;
    } catch (err) {
      console.error(`Backfill error for #${ch.name}:`, err);
    }
  }

  // Save cursor position for next run
  const nextIndex = channelIndex + totalChannels;
  await env.KV.put(
    "slack:backfill:cursor",
    String(nextIndex >= channels.length ? 0 : nextIndex),
    { expirationTtl: 86400 }
  );

  return { channels: totalChannels, events: totalEvents };
}

// --- Deep Backfill --------------------------------------------------------------

export interface DeepBackfillResult {
  channels: number;
  events: number;
  done: boolean;
  channelIndex: number;
  totalChannels: number;
}

/**
 * Aggressive deep backfill: iterates through channels, paging through full
 * history. Designed to be called repeatedly until `done: true`.
 * Each invocation processes as many channels as it can within ~25s.
 */
export async function runDeepBackfill(
  env: PollEnv
): Promise<DeepBackfillResult> {
  const startTime = Date.now();
  const workspaceName = await getWorkspaceName(env);

  // Ensure channels are loaded
  let channelListRaw = await env.KV.get("slack:channels:list");
  if (!channelListRaw) {
    await autoJoinChannels(env);
    channelListRaw = await env.KV.get("slack:channels:list");
  }
  if (!channelListRaw) {
    return {
      channels: 0,
      events: 0,
      done: true,
      channelIndex: 0,
      totalChannels: 0,
    };
  }

  const channels = JSON.parse(channelListRaw) as Array<{
    id: string;
    name: string;
  }>;

  // Load deep backfill cursor (separate from regular backfill)
  const cursorRaw = await env.KV.get("slack:deepbackfill:channelIndex");
  let channelIndex = cursorRaw ? parseInt(cursorRaw, 10) : 0;

  let totalChannels = 0;
  let totalEvents = 0;

  const resolver = (userId: string) =>
    resolveUser(userId, env.KV, env.SLACK_BOT_TOKEN);

  while (channelIndex < channels.length) {
    // Time guard: stop with 5s buffer
    if (Date.now() - startTime > 25_000) break;

    const ch = channels[channelIndex];

    // Skip ignored channels
    if (isChannelIgnored(ch.name, env.IGNORED_CHANNELS)) {
      channelIndex++;
      continue;
    }

    const pageCursorKey = `slack:deepbackfill:pageCursor:${ch.id}`;
    const doneKey = `slack:deepbackfill:done:${ch.id}`;

    // Skip if this channel is already fully backfilled
    const alreadyDone = await env.KV.get(doneKey);
    if (alreadyDone) {
      channelIndex++;
      continue;
    }

    const existingPageCursor = await env.KV.get(pageCursorKey);

    try {
      // Fetch up to 5 pages (1000 messages) per channel per call
      const result = await getConversationHistoryDeep(
        env.SLACK_BOT_TOKEN,
        ch.id,
        {
          paginationCursor: existingPageCursor || undefined,
          maxPages: 5,
        }
      );

      // Normalize and enqueue
      for (const msg of result.messages) {
        const events = await normalizeSlackEvent(
          msg as unknown as Record<string, unknown>,
          ch.name,
          resolver,
          workspaceName
        );
        for (const event of events) {
          await env.EVENTS_QUEUE.send(event);
          totalEvents++;
        }
      }

      if (result.hasMore && result.nextCursor) {
        // More pages for this channel -- save cursor, stay on same channel
        await env.KV.put(pageCursorKey, result.nextCursor, {
          expirationTtl: 86400 * 7,
        });
      } else {
        // Channel fully backfilled
        await env.KV.put(doneKey, "1", { expirationTtl: 86400 * 30 });
        await env.KV.delete(pageCursorKey);
        channelIndex++;
        totalChannels++;

        // Also update the regular backfill cursor so it knows this channel is done
        const latestTs = result.messages[0]?.ts;
        if (latestTs) {
          await env.KV.put(`slack:poll:cursor:${ch.id}`, latestTs, {
            expirationTtl: 86400 * 30,
          });
        }
      }

      console.log(
        `Deep backfill #${ch.name}: ${result.messages.length} msgs, hasMore=${result.hasMore}`
      );
    } catch (err) {
      console.error(`Deep backfill error #${ch.name}:`, err);
      // Skip this channel on error, move to next
      channelIndex++;
    }
  }

  const done = channelIndex >= channels.length;

  // Save progress
  await env.KV.put(
    "slack:deepbackfill:channelIndex",
    String(channelIndex),
    { expirationTtl: 86400 * 7 }
  );

  return {
    channels: totalChannels,
    events: totalEvents,
    done,
    channelIndex,
    totalChannels: channels.length,
  };
}

// --- Helpers --------------------------------------------------------------------

async function getWorkspaceName(env: PollEnv): Promise<string> {
  const cached = await env.KV.get("slack:workspace:name");
  if (cached) return cached;

  try {
    const team = await getTeamInfo(env.SLACK_BOT_TOKEN);
    await env.KV.put("slack:workspace:name", team.name, {
      expirationTtl: 86400,
    });
    return team.name;
  } catch {
    return "unknown-workspace";
  }
}
