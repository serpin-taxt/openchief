/**
 * Thin Slack Web API HTTP client with pagination and rate-limit handling.
 */

const SLACK_BASE = "https://slack.com/api";
const USER_AGENT = "openchief-connector-slack";

// --- Types ----------------------------------------------------------------------

export interface SlackChannel {
  id: string;
  name: string;
  is_member: boolean;
  is_private: boolean;
  is_archived: boolean;
  num_members: number;
  topic?: { value: string };
  purpose?: { value: string };
}

export interface SlackMessage {
  type: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text: string;
  ts: string;
  thread_ts?: string;
  reply_count?: number;
  files?: SlackFile[];
  reactions?: Array<{ name: string; count: number; users: string[] }>;
  edited?: { user: string; ts: string };
}

export interface SlackUser {
  id: string;
  name: string;
  real_name: string;
  deleted: boolean;
  is_bot: boolean;
  is_app_user: boolean;
  profile: {
    display_name: string;
    real_name: string;
    email?: string;
    image_72?: string;
    image_192?: string;
  };
}

export interface SlackFile {
  id: string;
  name: string;
  filetype: string;
  size: number;
  mimetype: string;
  url_private: string;
  url_private_download?: string;
  thumb_360?: string;
  thumb_480?: string;
}

// --- Core API Caller ------------------------------------------------------------

async function slackApiFetch(
  method: string,
  params: Record<string, string>,
  token: string
): Promise<Record<string, unknown>> {
  const url = new URL(`${SLACK_BASE}/${method}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
  });

  // Handle rate limiting with automatic retry
  if (response.status === 429) {
    const retryAfter = parseInt(
      response.headers.get("Retry-After") || "5",
      10
    );
    if (retryAfter <= 10) {
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      return slackApiFetch(method, params, token);
    }
    throw new Error(`Slack rate limited, retry after ${retryAfter}s`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (!data.ok) {
    throw new Error(`Slack API ${method} failed: ${data.error}`);
  }

  return data;
}

// --- Paginated Helper -----------------------------------------------------------

async function slackPaginate<T>(
  method: string,
  params: Record<string, string>,
  token: string,
  resultKey: string,
  maxPages: number = 10
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const p = { ...params };
    if (cursor) p.cursor = cursor;

    const data = await slackApiFetch(method, p, token);
    const items = data[resultKey] as T[] | undefined;
    if (items) all.push(...items);

    const meta = data.response_metadata as
      | { next_cursor?: string }
      | undefined;
    cursor = meta?.next_cursor || undefined;
    pages++;
  } while (cursor && pages < maxPages);

  return all;
}

// --- Exported Convenience Functions ---------------------------------------------

/**
 * List all conversations (channels) the bot can see.
 * Defaults to public + private channels. Use types param to customize.
 */
export async function listConversations(
  token: string,
  types: string = "public_channel,private_channel"
): Promise<SlackChannel[]> {
  return slackPaginate<SlackChannel>(
    "conversations.list",
    { types, limit: "200", exclude_archived: "true" },
    token,
    "channels",
    20
  );
}

/**
 * Join a conversation by channel ID.
 */
export async function joinConversation(
  token: string,
  channelId: string
): Promise<void> {
  await slackApiFetch("conversations.join", { channel: channelId }, token);
}

/**
 * Get conversation history for a single channel.
 * Returns up to `limit` messages after `oldest` timestamp.
 * Only fetches 1 page to respect rate limits during regular polling.
 */
export async function getConversationHistory(
  token: string,
  channelId: string,
  oldest?: string,
  limit: number = 100
): Promise<SlackMessage[]> {
  const params: Record<string, string> = {
    channel: channelId,
    limit: String(limit),
  };
  if (oldest) params.oldest = oldest;

  return slackPaginate<SlackMessage>(
    "conversations.history",
    params,
    token,
    "messages",
    1 // Only 1 page per call due to rate limits
  );
}

/**
 * Deep backfill: fetches ALL history for a channel with pagination.
 * Returns messages + a cursor for resumption.
 *
 * @param opts.oldest - Only messages after this Slack timestamp
 * @param opts.latest - Only messages before this Slack timestamp
 * @param opts.paginationCursor - Slack cursor for next page
 * @param opts.maxPages - Max pages to fetch per call (default: 10)
 */
export async function getConversationHistoryDeep(
  token: string,
  channelId: string,
  opts: {
    oldest?: string;
    latest?: string;
    paginationCursor?: string;
    maxPages?: number;
  } = {}
): Promise<{
  messages: SlackMessage[];
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const maxPages = opts.maxPages ?? 10;
  const all: SlackMessage[] = [];
  let cursor: string | undefined = opts.paginationCursor;
  let pages = 0;
  let hasMore = false;

  do {
    const params: Record<string, string> = {
      channel: channelId,
      limit: "200",
    };
    if (opts.oldest) params.oldest = opts.oldest;
    if (opts.latest) params.latest = opts.latest;
    if (cursor) params.cursor = cursor;

    const data = await slackApiFetch("conversations.history", params, token);
    const messages = data.messages as SlackMessage[] | undefined;
    if (messages) all.push(...messages);

    const meta = data.response_metadata as
      | { next_cursor?: string }
      | undefined;
    cursor = meta?.next_cursor || undefined;
    hasMore = (data.has_more as boolean) || false;
    pages++;
  } while (cursor && hasMore && pages < maxPages);

  return {
    messages: all,
    nextCursor: cursor || null,
    hasMore,
  };
}

/**
 * Get all replies in a thread.
 */
export async function getConversationReplies(
  token: string,
  channelId: string,
  threadTs: string
): Promise<SlackMessage[]> {
  return slackPaginate<SlackMessage>(
    "conversations.replies",
    { channel: channelId, ts: threadTs, limit: "200" },
    token,
    "messages",
    5
  );
}

/**
 * List all users in the workspace.
 */
export async function listUsers(token: string): Promise<SlackUser[]> {
  return slackPaginate<SlackUser>(
    "users.list",
    { limit: "200" },
    token,
    "members",
    20
  );
}

/**
 * Get detailed info for a single user by ID.
 */
export async function getUserInfo(
  token: string,
  userId: string
): Promise<SlackUser> {
  const data = await slackApiFetch("users.info", { user: userId }, token);
  return data.user as SlackUser;
}

/**
 * Get workspace (team) info.
 */
export async function getTeamInfo(
  token: string
): Promise<{ id: string; name: string; domain: string }> {
  const data = await slackApiFetch("team.info", {}, token);
  const team = data.team as Record<string, unknown>;
  return {
    id: team.id as string,
    name: team.name as string,
    domain: team.domain as string,
  };
}
