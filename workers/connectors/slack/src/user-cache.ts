/**
 * KV-backed user profile cache.
 * Resolves Slack user IDs to human-readable names, emails, and metadata.
 */

import { getUserInfo, type SlackUser } from "./slack-api";

export interface UserInfo {
  id: string;
  realName: string;
  displayName: string;
  email?: string;
  isBot: boolean;
  avatarUrl?: string;
}

const CACHE_TTL = 86400; // 24 hours
const CACHE_PREFIX = "slack:user:";

/**
 * Resolve a Slack user ID to a UserInfo object.
 * Tries KV cache first, falls back to Slack API on miss.
 */
export async function resolveUser(
  userId: string,
  kv: KVNamespace,
  token: string
): Promise<UserInfo> {
  // Check cache
  const cached = await kv.get(`${CACHE_PREFIX}${userId}`, "json");
  if (cached) return cached as UserInfo;

  // Cache miss -- fetch from Slack
  try {
    const user = await getUserInfo(token, userId);
    const info = slackUserToInfo(user);
    await cacheUser(kv, info);
    return info;
  } catch (err) {
    // Return a fallback if API fails
    console.error(`Failed to resolve user ${userId}:`, err);
    return {
      id: userId,
      realName: userId,
      displayName: userId,
      isBot: false,
    };
  }
}

/**
 * Bulk-cache users from a users.list call.
 * Writes in parallel batches of 20 to avoid overwhelming KV.
 */
export async function bulkCacheUsers(
  users: SlackUser[],
  kv: KVNamespace
): Promise<void> {
  const batchSize = 20;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    await Promise.all(
      batch.map((user) => {
        const info = slackUserToInfo(user);
        return cacheUser(kv, info);
      })
    );
  }
}

/**
 * Convert a raw Slack user to our UserInfo type.
 */
export function slackUserToInfo(user: SlackUser): UserInfo {
  return {
    id: user.id,
    realName: user.profile.real_name || user.real_name || user.name,
    displayName:
      user.profile.display_name || user.profile.real_name || user.name,
    email: user.profile.email,
    isBot: user.is_bot || user.is_app_user || user.id === "USLACKBOT",
    avatarUrl: user.profile.image_192 || user.profile.image_72,
  };
}

async function cacheUser(kv: KVNamespace, info: UserInfo): Promise<void> {
  await kv.put(`${CACHE_PREFIX}${info.id}`, JSON.stringify(info), {
    expirationTtl: CACHE_TTL,
  });
}
