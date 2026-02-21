import type { OpenChiefEvent } from "@openchief/shared";

/**
 * Enrich Slack message events that contain tweet URLs.
 * Fetches actual tweet content from the Twitter/X API v2.
 */

const TWEET_URL_PATTERN =
  /https?:\/\/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/g;

interface TweetData {
  id: string;
  text: string;
  author_id?: string;
  author_username?: string;
  author_name?: string;
}

export async function enrichTweetUrls(
  event: OpenChiefEvent,
  bearerToken: string
): Promise<void> {
  if (event.source !== "slack") return;
  if (!event.eventType.startsWith("message.")) return;

  const payload = event.payload as Record<string, unknown>;
  const text = (payload.text as string) || "";

  const tweetIds: string[] = [];
  const urlMatches = [...text.matchAll(TWEET_URL_PATTERN)];
  for (const match of urlMatches) {
    if (match[1] && !tweetIds.includes(match[1])) {
      tweetIds.push(match[1]);
    }
  }

  if (tweetIds.length === 0) return;

  try {
    const tweets = await fetchTweets(tweetIds.slice(0, 10), bearerToken);
    if (tweets.length > 0) {
      payload._enrichedTweets = tweets;
      const tweetSummaries = tweets
        .map(
          (t) =>
            `[Tweet by @${t.author_username || "unknown"}]: ${t.text}`
        )
        .join("\n");
      event.summary += `\n--- Linked tweets ---\n${tweetSummaries}`;
    }
  } catch (err) {
    console.error("Tweet enrichment failed:", err);
  }
}

async function fetchTweets(
  ids: string[],
  bearerToken: string
): Promise<TweetData[]> {
  const token = decodeURIComponent(bearerToken);
  const params = new URLSearchParams({
    ids: ids.join(","),
    "tweet.fields": "text,author_id",
    expansions: "author_id",
    "user.fields": "username,name",
  });

  const resp = await fetch(`https://api.x.com/2/tweets?${params}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "User-Agent": "openchief-router",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`Twitter API ${resp.status}: ${text}`);
    return [];
  }

  const json = (await resp.json()) as {
    data?: Array<{ id: string; text: string; author_id?: string }>;
    includes?: {
      users?: Array<{ id: string; username: string; name: string }>;
    };
  };

  if (!json.data) return [];

  const authors = new Map<string, { username: string; name: string }>();
  if (json.includes?.users) {
    for (const user of json.includes.users) {
      authors.set(user.id, { username: user.username, name: user.name });
    }
  }

  return json.data.map((tweet) => {
    const author = tweet.author_id
      ? authors.get(tweet.author_id)
      : undefined;
    return {
      id: tweet.id,
      text: tweet.text,
      author_id: tweet.author_id,
      author_username: author?.username,
      author_name: author?.name,
    };
  });
}
