/**
 * X (Twitter) API v2 client.
 * Handles authentication, pagination, and typed responses.
 * API docs: https://developer.x.com/en/docs/x-api
 */

// --- Types -------------------------------------------------------------------

export interface TwitterUser {
  id: string;
  name: string;
  username: string;
  public_metrics?: {
    followers_count: number;
    following_count: number;
    tweet_count: number;
    listed_count: number;
  };
}

export interface Tweet {
  id: string;
  text: string;
  created_at: string;
  author_id: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{
    type: "retweeted" | "quoted" | "replied_to";
    id: string;
  }>;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
    impression_count: number;
  };
}

interface TweetResponse {
  data?: Tweet[];
  includes?: {
    users?: TwitterUser[];
  };
  meta?: {
    result_count: number;
    newest_id?: string;
    oldest_id?: string;
    next_token?: string;
  };
}

interface UserLookupResponse {
  data?: TwitterUser;
}

// --- Client ------------------------------------------------------------------

const BASE_URL = "https://api.x.com/2";
const MAX_RETRIES = 3;
const MAX_PAGES = 3; // Safety limit -- keep low for Worker CPU limits

/** Standard tweet fields we request on every tweet endpoint */
const TWEET_FIELDS =
  "created_at,author_id,conversation_id,in_reply_to_user_id,referenced_tweets,public_metrics";
const USER_FIELDS = "id,name,username,public_metrics";
const EXPANSIONS = "author_id";

export class TwitterClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Create a new client instance using a different token.
   * Used to switch from app-only bearer to user access token.
   */
  withToken(token: string): TwitterClient {
    return new TwitterClient(token);
  }

  // --- User Lookup -----------------------------------------------------------

  /** Resolve a username to a TwitterUser (with public_metrics). */
  async getUserByUsername(username: string): Promise<TwitterUser | null> {
    const url = `${BASE_URL}/users/by/username/${encodeURIComponent(username)}?user.fields=${USER_FIELDS}`;
    const response = await this.fetchWithRetry(url);

    if (!response.ok) {
      if (response.status === 404) return null;
      const text = await response.text();
      throw new Error(`X API error ${response.status} on user lookup: ${text}`);
    }

    const body = (await response.json()) as UserLookupResponse;
    return body.data ?? null;
  }

  /** Get a user by ID (with public_metrics for follower snapshot). */
  async getUser(userId: string): Promise<TwitterUser | null> {
    const url = `${BASE_URL}/users/${userId}?user.fields=${USER_FIELDS}`;
    const response = await this.fetchWithRetry(url);

    if (!response.ok) {
      if (response.status === 404) return null;
      const text = await response.text();
      throw new Error(`X API error ${response.status} on user get: ${text}`);
    }

    const body = (await response.json()) as UserLookupResponse;
    return body.data ?? null;
  }

  // --- Tweets ----------------------------------------------------------------

  /** Get tweets posted by a user. */
  async getUserTweets(
    userId: string,
    sinceId?: string
  ): Promise<{ tweets: Tweet[]; users: TwitterUser[]; newestId?: string }> {
    return this.paginateTweets(
      `${BASE_URL}/users/${userId}/tweets`,
      sinceId
    );
  }

  /** Get tweets that mention a user. */
  async getUserMentions(
    userId: string,
    sinceId?: string
  ): Promise<{ tweets: Tweet[]; users: TwitterUser[]; newestId?: string }> {
    return this.paginateTweets(
      `${BASE_URL}/users/${userId}/mentions`,
      sinceId
    );
  }

  /** Search recent tweets matching a query. */
  async searchRecent(
    query: string,
    sinceId?: string
  ): Promise<{ tweets: Tweet[]; users: TwitterUser[]; newestId?: string }> {
    const baseUrl = `${BASE_URL}/tweets/search/recent`;
    return this.paginateTweets(baseUrl, sinceId, { query });
  }

  // --- Pagination ------------------------------------------------------------

  private async paginateTweets(
    baseUrl: string,
    sinceId?: string,
    extraParams?: Record<string, string>
  ): Promise<{ tweets: Tweet[]; users: TwitterUser[]; newestId?: string }> {
    const allTweets: Tweet[] = [];
    const allUsers: TwitterUser[] = [];
    let newestId: string | undefined;
    let nextToken: string | undefined;
    let page = 0;

    do {
      const params = new URLSearchParams({
        "tweet.fields": TWEET_FIELDS,
        "user.fields": USER_FIELDS,
        expansions: EXPANSIONS,
        max_results: sinceId ? "100" : "10",  // Fetch fewer on first run (no cursor)
        ...(extraParams || {}),
      });

      if (sinceId) params.set("since_id", sinceId);
      if (nextToken) params.set("pagination_token", nextToken);

      const url = `${baseUrl}?${params.toString()}`;
      const response = await this.fetchWithRetry(url);

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`X API error ${response.status}: ${text}`);
      }

      const body = (await response.json()) as TweetResponse;

      if (body.data) {
        allTweets.push(...body.data);
      }
      if (body.includes?.users) {
        allUsers.push(...body.includes.users);
      }
      if (body.meta?.newest_id && !newestId) {
        newestId = body.meta.newest_id;
      }

      nextToken = body.meta?.next_token;
      page++;
    } while (nextToken && page < MAX_PAGES);

    return { tweets: allTweets, users: allUsers, newestId };
  }

  // --- HTTP Layer ------------------------------------------------------------

  private async fetchWithRetry(
    url: string,
    retries = MAX_RETRIES
  ): Promise<Response> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "User-Agent": "openchief-connector-twitter",
        },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      // Rate limited -- don't retry in Workers (CPU time is limited)
      if (response.status === 429) {
        const resetHeader = response.headers.get("x-rate-limit-reset");
        const resetAt = resetHeader ? new Date(parseInt(resetHeader) * 1000).toISOString() : "unknown";
        console.log(`X API rate limited, resets at ${resetAt} -- skipping`);
        return response;
      }

      // Server error -- retry with short backoff
      if (response.status >= 500 && attempt < retries) {
        const waitMs = (attempt + 1) * 1000;
        console.log(`X API server error ${response.status}, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      return response;
    }

    throw new Error(`X API failed after ${retries} retries`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
