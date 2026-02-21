/**
 * Normalize Discord events to OpenChiefEvent format.
 */

import type { OpenChiefEvent } from "@openchief/shared";
import { generateULID } from "@openchief/shared";
import type { DiscordMessage } from "./discord-api";

/**
 * Normalize a Discord message into an OpenChiefEvent.
 */
export function normalizeMessage(
  msg: DiscordMessage,
  channelName: string,
  guildName: string
): OpenChiefEvent | null {
  // Skip bot messages
  if (msg.author.bot) return null;

  // Skip empty messages (e.g. embeds-only, system messages)
  if (!msg.content && msg.type !== 0) return null;

  // Determine if this is a thread reply
  const isReply = !!msg.message_reference?.message_id;
  const eventType = isReply ? "thread.replied" : "message.posted";

  const displayName = msg.author.global_name || msg.author.username;
  const content = msg.content || "(attachment/embed)";

  // Truncate long messages for summary
  const truncated =
    content.length > 300 ? content.slice(0, 297) + "..." : content;

  let summary: string;
  if (isReply) {
    summary = `${displayName} replied in #${channelName}: ${truncated}`;
  } else {
    summary = `${displayName} in #${channelName}: ${truncated}`;
  }

  return {
    id: generateULID(),
    timestamp: new Date(msg.timestamp).toISOString(),
    ingestedAt: new Date().toISOString(),
    source: "discord",
    eventType,
    scope: {
      org: guildName,
      project: channelName,
      actor: displayName,
    },
    payload: {
      messageId: msg.id,
      channelId: msg.channel_id,
      authorId: msg.author.id,
      authorUsername: msg.author.username,
      authorDisplayName: displayName,
      content: msg.content,
      isReply,
      replyToMessageId: msg.message_reference?.message_id,
      reactions: msg.reactions?.map((r) => ({
        emoji: r.emoji.name,
        count: r.count,
      })),
    },
    summary,
    tags: inferTags(msg.content, channelName),
  };
}

/**
 * Infer tags from message content and channel context.
 */
function inferTags(content: string, channelName: string): string[] {
  const tags: string[] = [];
  const lower = content.toLowerCase();

  // Channel-based tags
  if (channelName.startsWith("feat-") || channelName.startsWith("feature-")) {
    tags.push("feature");
  }
  if (
    channelName.includes("feedback") ||
    channelName.includes("support") ||
    channelName.includes("help")
  ) {
    tags.push("customer-feedback");
  }
  if (channelName.includes("bug") || channelName.includes("issue")) {
    tags.push("bug-report");
  }

  // Content-based tags
  if (lower.includes("bug") || lower.includes("broken") || lower.includes("doesn't work") || lower.includes("not working")) {
    tags.push("bug-report");
  }
  if (lower.includes("feature request") || lower.includes("would be nice") || lower.includes("wish") || lower.includes("please add")) {
    tags.push("feature-request");
  }
  if (lower.includes("love") || lower.includes("amazing") || lower.includes("great") || lower.includes("awesome")) {
    tags.push("positive-feedback");
  }
  if (lower.includes("frustrat") || lower.includes("annoying") || lower.includes("terrible") || lower.includes("hate")) {
    tags.push("negative-feedback");
  }

  // Deduplicate
  return [...new Set(tags)];
}

/**
 * Normalize a Discord interaction (slash command, button click, etc.) from the webhook.
 * For now we mostly care about messages, but this handles the interaction endpoint.
 */
export function normalizeInteraction(
  interaction: Record<string, unknown>,
  guildName: string
): OpenChiefEvent | null {
  // Type 1 = PING (handled separately), Type 2 = APPLICATION_COMMAND
  // For now, we don't generate events from slash commands — just messages
  return null;
}
