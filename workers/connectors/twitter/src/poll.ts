/**
 * Polling orchestrator for X/Twitter connector.
 *
 * On each poll:
 * 1. For each monitored account, resolve username -> user ID (cached in KV)
 * 2. Fetch new tweets since last cursor -> normalize -> enqueue
 * 3. If OAuth tokens available, fetch mentions via User Context -> normalize -> enqueue
 * 4. Optionally run search queries
 * 5. Aggregate engagement metrics from fetched tweets -> emit snapshot event
 * 6. Update all cursors in KV
 */

import type { OpenChiefEvent } from "@openchief/shared";
import { TwitterClient } from "./twitter-client";
import {
  normalizeTweets,
  normalizeMentions,
  normalizeSearchResults,
  normalizeEngagementSnapshot,
} from "./normalize";
import {
  getValidAccessToken,
  resolveOAuthUserId,
} from "./oauth";

// --- KV Key Prefixes ---------------------------------------------------------

const KV_PREFIX_USER = "twitter:user:";
const KV_PREFIX_CURSOR_TWEETS = "twitter:cursor:tweets:";
const KV_PREFIX_CURSOR_MENTIONS = "twitter:cursor:mentions:";
const KV_PREFIX_CURSOR_SEARCH = "twitter:cursor:search:";

const KV_TTL = 30 * 24 * 60 * 60; // 30 days

// --- Poll Result -------------------------------------------------------------

export interface PollResult {
  accounts: Array<{
    username: string;
    tweets: { fetched: number; events: number };
    mentions: { fetched: number; events: number; oauthUsed: boolean };
    engagementSnapshot: boolean;
  }>;
  search: { queries: number; events: number };
  totalEvents: number;
}

// --- Config Helpers ----------------------------------------------------------

/** Read monitored accounts: KV first, env var fallback. */
export async function getMonitoredAccounts(
  kv: KVNamespace,
  envAccounts: string
): Promise<string[]> {
  const kvAccounts = await kv.get("twitter:config:monitored_accounts");
  const raw = kvAccounts || envAccounts;
  return raw
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}

/** Read search queries: KV first, env var fallback. */
function getSearchQueries(
  kvQueries: string | null,
  envQueries: string | undefined
): string[] {
  const raw = kvQueries || envQueries || "";
  return raw
    .split("|")
    .map((q) => q.trim())
    .filter(Boolean);
}

// --- Main Poll Function ------------------------------------------------------

export async function pollTwitter(
  env: {
    KV: KVNamespace;
    EVENTS_QUEUE: Queue;
    X_BEARER_TOKEN: string;
    X_MONITORED_ACCOUNTS: string;
    X_SEARCH_QUERIES?: string;
    X_OAUTH_CLIENT_ID?: string;
    X_OAUTH_CLIENT_SECRET?: string;
  },
  options?: { backfill?: boolean }
): Promise<PollResult> {
  const client = new TwitterClient(env.X_BEARER_TOKEN);
  const now = new Date().toISOString();
  const allEvents: OpenChiefEvent[] = [];

  // Read monitored accounts: KV first (dashboard-managed), env var fallback
  const accounts = await getMonitoredAccounts(env.KV, env.X_MONITORED_ACCOUNTS);

  if (accounts.length === 0) {
    console.log("No monitored accounts configured, skipping poll");
    return { accounts: [], search: { queries: 0, events: 0 }, totalEvents: 0 };
  }

  // Seed KV from env vars on first run (if KV is empty)
  await seedConfigToKV(env.KV, env.X_MONITORED_ACCOUNTS, env.X_SEARCH_QUERIES);

  const accountResults: PollResult["accounts"] = [];

  // -- Poll each monitored account --------------------------------------------

  for (const username of accounts) {
    console.log(`Polling @${username}...`);

    // Resolve username -> user ID (cached)
    const userId = await resolveUserId(client, username, env.KV);
    if (!userId) {
      console.error(`Could not resolve user ID for @${username}, skipping`);
      accountResults.push({
        username,
        tweets: { fetched: 0, events: 0 },
        mentions: { fetched: 0, events: 0, oauthUsed: false },
        engagementSnapshot: false,
      });
      continue;
    }

    // -- Tweets ---------------------------------------------------------------

    const tweetCursorKey = `${KV_PREFIX_CURSOR_TWEETS}${userId}`;
    const tweetSinceId = options?.backfill
      ? undefined
      : (await env.KV.get(tweetCursorKey)) ?? undefined;

    let tweetsFetched = 0;
    let tweetEvents: OpenChiefEvent[] = [];
    let fetchedTweetsRaw: import("./twitter-client").Tweet[] = [];

    try {
      const result = await client.getUserTweets(userId, tweetSinceId);
      tweetsFetched = result.tweets.length;
      fetchedTweetsRaw = result.tweets;
      tweetEvents = normalizeTweets(result.tweets, result.users, username, now);

      if (result.newestId) {
        await env.KV.put(tweetCursorKey, result.newestId, {
          expirationTtl: KV_TTL,
        });
      }
      console.log(`  @${username} tweets: ${tweetsFetched} fetched, ${tweetEvents.length} events`);
    } catch (err) {
      console.error(`  Error fetching tweets for @${username}:`, err);
    }

    allEvents.push(...tweetEvents);

    // -- Mentions (OAuth User Context) ----------------------------------------

    let mentionsFetched = 0;
    let mentionEvents: OpenChiefEvent[] = [];
    let oauthUsed = false;

    // Try to get a user access token for this account
    const oauthUserId = await resolveOAuthUserId(username, env.KV);
    if (oauthUserId && env.X_OAUTH_CLIENT_ID && env.X_OAUTH_CLIENT_SECRET) {
      const userAccessToken = await getValidAccessToken(
        oauthUserId,
        env.X_OAUTH_CLIENT_ID,
        env.X_OAUTH_CLIENT_SECRET,
        env.KV
      );

      if (userAccessToken) {
        oauthUsed = true;
        const userClient = client.withToken(userAccessToken);

        const mentionCursorKey = `${KV_PREFIX_CURSOR_MENTIONS}${userId}`;
        const mentionSinceId = options?.backfill
          ? undefined
          : (await env.KV.get(mentionCursorKey)) ?? undefined;

        try {
          const result = await userClient.getUserMentions(userId, mentionSinceId);
          mentionsFetched = result.tweets.length;

          mentionEvents = normalizeMentions(result.tweets, result.users, username, now);

          if (result.newestId) {
            await env.KV.put(mentionCursorKey, result.newestId, {
              expirationTtl: KV_TTL,
            });
          }
          console.log(`  @${username} mentions (OAuth): ${mentionsFetched} fetched, ${mentionEvents.length} events`);
        } catch (err) {
          console.error(`  Error fetching mentions for @${username}:`, err);
        }

        allEvents.push(...mentionEvents);
      } else {
        console.log(`  @${username} mentions: OAuth token expired/unavailable, skipping`);
      }
    } else {
      console.log(`  @${username} mentions: no OAuth tokens, skipping`);
    }

    // -- Engagement Metrics (aggregate from fetched tweets) -------------------

    let engagementSnapshot = false;

    if (fetchedTweetsRaw.length > 0) {
      const engagementEvent = normalizeEngagementSnapshot(
        username,
        fetchedTweetsRaw,
        now
      );
      if (engagementEvent) {
        allEvents.push(engagementEvent);
        engagementSnapshot = true;
        console.log(`  @${username} engagement snapshot emitted (${fetchedTweetsRaw.length} tweets)`);
      }
    }

    accountResults.push({
      username,
      tweets: { fetched: tweetsFetched, events: tweetEvents.length },
      mentions: { fetched: mentionsFetched, events: mentionEvents.length, oauthUsed },
      engagementSnapshot,
    });
  }

  // -- Search Queries ---------------------------------------------------------

  let searchEvents: OpenChiefEvent[] = [];
  // Read search queries: KV first (dashboard-managed), env var fallback
  const kvQueries = await env.KV.get("twitter:config:search_queries");
  const searchQueries = getSearchQueries(kvQueries, env.X_SEARCH_QUERIES);

  for (const query of searchQueries) {
    const queryHash = simpleHash(query);
    const searchCursorKey = `${KV_PREFIX_CURSOR_SEARCH}${queryHash}`;
    const searchSinceId = options?.backfill
      ? undefined
      : (await env.KV.get(searchCursorKey)) ?? undefined;

    try {
      const result = await client.searchRecent(query, searchSinceId);
      const events = normalizeSearchResults(result.tweets, result.users, query, now);
      searchEvents.push(...events);

      if (result.newestId) {
        await env.KV.put(searchCursorKey, result.newestId, {
          expirationTtl: KV_TTL,
        });
      }
      console.log(`  Search "${query}": ${result.tweets.length} results, ${events.length} events`);
    } catch (err) {
      console.error(`  Error searching for "${query}":`, err);
    }
  }

  allEvents.push(...searchEvents);

  // -- Enqueue all events -----------------------------------------------------

  for (const event of allEvents) {
    await env.EVENTS_QUEUE.send(event);
  }

  console.log(`Twitter poll complete: ${allEvents.length} events enqueued`);

  return {
    accounts: accountResults,
    search: { queries: searchQueries.length, events: searchEvents.length },
    totalEvents: allEvents.length,
  };
}

// --- Helpers -----------------------------------------------------------------

/** Resolve a username to a user ID, using KV cache. */
async function resolveUserId(
  client: TwitterClient,
  username: string,
  kv: KVNamespace
): Promise<string | null> {
  const cacheKey = `${KV_PREFIX_USER}${username}`;
  const cached = await kv.get(cacheKey);
  if (cached) return cached;

  const user = await client.getUserByUsername(username);
  if (!user) return null;

  // Cache for 7 days -- user IDs don't change
  await kv.put(cacheKey, user.id, { expirationTtl: 7 * 24 * 60 * 60 });
  return user.id;
}

/** Simple string hash for search query cursor keys. */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash).toString(36);
}

/** Seed KV from env vars on first run only (if KV has no values yet). */
async function seedConfigToKV(
  kv: KVNamespace,
  monitoredAccounts: string,
  searchQueries?: string
): Promise<void> {
  try {
    const existingAccounts = await kv.get("twitter:config:monitored_accounts");
    if (!existingAccounts && monitoredAccounts) {
      await kv.put("twitter:config:monitored_accounts", monitoredAccounts, {
        expirationTtl: 365 * 24 * 60 * 60,
      });
    }
    const existingQueries = await kv.get("twitter:config:search_queries");
    if (!existingQueries && searchQueries) {
      await kv.put("twitter:config:search_queries", searchQueries, {
        expirationTtl: 365 * 24 * 60 * 60,
      });
    }
  } catch (err) {
    console.error("Failed to seed config to KV:", err);
  }
}
