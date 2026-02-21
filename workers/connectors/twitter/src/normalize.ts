/**
 * Normalize X/Twitter API data into OpenChiefEvent format.
 *
 * Produces events for tweets, mentions, search matches,
 * and engagement metrics snapshots.
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";
import type { Tweet, TwitterUser } from "./twitter-client";

// --- Tweet Normalization -----------------------------------------------------

/**
 * Classify a tweet into an event type based on its content.
 */
function classifyTweet(tweet: Tweet): "tweet.posted" | "tweet.reply" | "tweet.retweet" {
  if (tweet.referenced_tweets?.some((r) => r.type === "retweeted")) {
    return "tweet.retweet";
  }
  if (tweet.referenced_tweets?.some((r) => r.type === "replied_to") || tweet.in_reply_to_user_id) {
    return "tweet.reply";
  }
  return "tweet.posted";
}

/**
 * Build a direct URL to a tweet.
 */
function tweetUrl(username: string, tweetId: string): string {
  return `https://x.com/${username}/status/${tweetId}`;
}

/**
 * Resolve an author_id to a username from the includes.users array.
 */
function resolveAuthor(
  authorId: string,
  users: TwitterUser[],
  monitoredUsername?: string
): { name: string; username: string } {
  const user = users.find((u) => u.id === authorId);
  if (user) {
    return { name: user.name, username: user.username };
  }
  // Fallback: if this is from a getUserTweets call, the author is the monitored account
  if (monitoredUsername) {
    return { name: monitoredUsername, username: monitoredUsername };
  }
  return { name: authorId, username: authorId };
}

/**
 * Normalize tweets from a monitored account into OpenChiefEvents.
 */
export function normalizeTweets(
  tweets: Tweet[],
  users: TwitterUser[],
  monitoredUsername: string,
  now: string
): OpenChiefEvent[] {
  return tweets.map((tweet) => {
    const eventType = classifyTweet(tweet);
    const author = resolveAuthor(tweet.author_id, users, monitoredUsername);

    const payload: Record<string, unknown> = {
      tweet_id: tweet.id,
      text: tweet.text,
      author_name: author.name,
      author_username: author.username,
      url: tweetUrl(author.username, tweet.id),
      retweet_count: tweet.public_metrics?.retweet_count ?? 0,
      reply_count: tweet.public_metrics?.reply_count ?? 0,
      like_count: tweet.public_metrics?.like_count ?? 0,
      quote_count: tweet.public_metrics?.quote_count ?? 0,
      impression_count: tweet.public_metrics?.impression_count ?? 0,
    };

    if (eventType === "tweet.reply" && tweet.in_reply_to_user_id) {
      payload.in_reply_to_user_id = tweet.in_reply_to_user_id;
    }

    if (eventType === "tweet.retweet") {
      const retweeted = tweet.referenced_tweets?.find((r) => r.type === "retweeted");
      if (retweeted) {
        payload.retweeted_tweet_id = retweeted.id;
      }
    }

    // Truncate text for summary
    const textPreview = tweet.text.length > 120
      ? tweet.text.slice(0, 117) + "..."
      : tweet.text;

    let summary: string;
    switch (eventType) {
      case "tweet.retweet":
        summary = `@${monitoredUsername} retweeted: ${textPreview}`;
        break;
      case "tweet.reply":
        summary = `@${monitoredUsername} replied: ${textPreview}`;
        break;
      default:
        summary = `@${monitoredUsername} tweeted: ${textPreview}`;
    }

    return {
      id: generateULID(),
      timestamp: tweet.created_at || now,
      ingestedAt: now,
      source: "twitter",
      eventType,
      scope: {
        actor: `@${author.username}`,
      },
      payload,
      summary,
      tags: ["twitter", monitoredUsername, eventType],
    } satisfies OpenChiefEvent;
  });
}

// --- Mention Normalization ---------------------------------------------------

/**
 * Normalize mentions of a monitored account into OpenChiefEvents.
 */
export function normalizeMentions(
  tweets: Tweet[],
  users: TwitterUser[],
  monitoredUsername: string,
  now: string
): OpenChiefEvent[] {
  return tweets.map((tweet) => {
    const author = resolveAuthor(tweet.author_id, users);

    const textPreview = tweet.text.length > 120
      ? tweet.text.slice(0, 117) + "..."
      : tweet.text;

    return {
      id: generateULID(),
      timestamp: tweet.created_at || now,
      ingestedAt: now,
      source: "twitter",
      eventType: "mention.received",
      scope: {
        actor: `@${author.username}`,
      },
      payload: {
        tweet_id: tweet.id,
        text: tweet.text,
        author_name: author.name,
        author_username: author.username,
        mentioned_account: monitoredUsername,
        url: tweetUrl(author.username, tweet.id),
        retweet_count: tweet.public_metrics?.retweet_count ?? 0,
        reply_count: tweet.public_metrics?.reply_count ?? 0,
        like_count: tweet.public_metrics?.like_count ?? 0,
        quote_count: tweet.public_metrics?.quote_count ?? 0,
        impression_count: tweet.public_metrics?.impression_count ?? 0,
      },
      summary: `@${author.username} mentioned @${monitoredUsername}: ${textPreview}`,
      tags: ["twitter", monitoredUsername, "mention.received"],
    } satisfies OpenChiefEvent;
  });
}

// --- Search Normalization ----------------------------------------------------

/**
 * Normalize search result tweets into OpenChiefEvents.
 */
export function normalizeSearchResults(
  tweets: Tweet[],
  users: TwitterUser[],
  query: string,
  now: string
): OpenChiefEvent[] {
  return tweets.map((tweet) => {
    const author = resolveAuthor(tweet.author_id, users);

    const textPreview = tweet.text.length > 120
      ? tweet.text.slice(0, 117) + "..."
      : tweet.text;

    return {
      id: generateULID(),
      timestamp: tweet.created_at || now,
      ingestedAt: now,
      source: "twitter",
      eventType: "search.match",
      scope: {
        actor: `@${author.username}`,
      },
      payload: {
        tweet_id: tweet.id,
        text: tweet.text,
        author_name: author.name,
        author_username: author.username,
        matched_query: query,
        url: tweetUrl(author.username, tweet.id),
        retweet_count: tweet.public_metrics?.retweet_count ?? 0,
        reply_count: tweet.public_metrics?.reply_count ?? 0,
        like_count: tweet.public_metrics?.like_count ?? 0,
        quote_count: tweet.public_metrics?.quote_count ?? 0,
        impression_count: tweet.public_metrics?.impression_count ?? 0,
      },
      summary: `Search match for "${query}" -- @${author.username}: ${textPreview}`,
      tags: ["twitter", "search.match", query],
    } satisfies OpenChiefEvent;
  });
}

// --- Engagement Snapshot -----------------------------------------------------

/**
 * Aggregate engagement metrics from a batch of fetched tweets.
 * Emits a single snapshot event summarizing total engagement
 * across all tweets in this poll cycle.
 */
export function normalizeEngagementSnapshot(
  username: string,
  tweets: Tweet[],
  now: string
): OpenChiefEvent | null {
  if (tweets.length === 0) return null;

  // Filter to only original tweets (not RTs) for engagement metrics
  const originalTweets = tweets.filter(
    (t) => !t.referenced_tweets?.some((r) => r.type === "retweeted")
  );

  if (originalTweets.length === 0) return null;

  let totalLikes = 0;
  let totalRetweets = 0;
  let totalReplies = 0;
  let totalQuotes = 0;
  let totalImpressions = 0;

  for (const tweet of originalTweets) {
    const m = tweet.public_metrics;
    if (m) {
      totalLikes += m.like_count;
      totalRetweets += m.retweet_count;
      totalReplies += m.reply_count;
      totalQuotes += m.quote_count;
      totalImpressions += m.impression_count;
    }
  }

  const totalEngagements = totalLikes + totalRetweets + totalReplies + totalQuotes;
  const engagementRate = totalImpressions > 0
    ? ((totalEngagements / totalImpressions) * 100).toFixed(2)
    : "0";

  // Find the top-performing tweet by total engagements
  let topTweet: Tweet | null = null;
  let topEngagement = 0;
  for (const tweet of originalTweets) {
    const m = tweet.public_metrics;
    if (m) {
      const eng = m.like_count + m.retweet_count + m.reply_count + m.quote_count;
      if (eng > topEngagement) {
        topEngagement = eng;
        topTweet = tweet;
      }
    }
  }

  const parts = [];
  if (totalImpressions > 0) parts.push(`${formatNum(totalImpressions)} impressions`);
  if (totalLikes > 0) parts.push(`${formatNum(totalLikes)} likes`);
  if (totalRetweets > 0) parts.push(`${formatNum(totalRetweets)} RTs`);
  if (totalReplies > 0) parts.push(`${formatNum(totalReplies)} replies`);
  const metricsStr = parts.join(", ");

  return {
    id: generateULID(),
    timestamp: now,
    ingestedAt: now,
    source: "twitter",
    eventType: "account.engagement_snapshot",
    scope: {
      actor: `@${username}`,
    },
    payload: {
      username,
      tweet_count: originalTweets.length,
      total_likes: totalLikes,
      total_retweets: totalRetweets,
      total_replies: totalReplies,
      total_quotes: totalQuotes,
      total_impressions: totalImpressions,
      total_engagements: totalEngagements,
      engagement_rate_pct: parseFloat(engagementRate),
      top_tweet_id: topTweet?.id ?? null,
      top_tweet_text: topTweet?.text ?? null,
      top_tweet_url: topTweet
        ? tweetUrl(username, topTweet.id)
        : null,
      top_tweet_engagements: topEngagement,
    },
    summary: `@${username} engagement (${originalTweets.length} tweets): ${metricsStr} (${engagementRate}% rate)`,
    tags: ["twitter", username, "account.engagement_snapshot"],
  };
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
