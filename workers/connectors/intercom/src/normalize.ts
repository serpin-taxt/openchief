/**
 * Normalize Intercom webhook events to OpenChiefEvent format.
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";

/** Intercom webhook payload shape (partial — we extract what we need) */
export interface IntercomWebhookPayload {
  type: "notification_event";
  topic: string;
  id: string;
  created_at: number;
  delivery_status: string;
  data: {
    type: string;
    item: Record<string, unknown>;
  };
  app_id: string;
}

/**
 * Map Intercom webhook topic to our event type.
 */
function mapTopic(topic: string): string {
  const MAP: Record<string, string> = {
    // Conversations
    "conversation.user.created": "conversation.created",
    "conversation.user.replied": "conversation.user_replied",
    "conversation.admin.replied": "conversation.admin_replied",
    "conversation.admin.single.created": "conversation.admin_initiated",
    "conversation.admin.assigned": "conversation.assigned",
    "conversation.admin.noted": "conversation.note_added",
    "conversation.admin.closed": "conversation.closed",
    "conversation.admin.opened": "conversation.reopened",
    "conversation.admin.snoozed": "conversation.snoozed",
    "conversation.admin.unsnoozed": "conversation.unsnoozed",
    "conversation.rating.added": "conversation.rated",
    "conversation.rating.remarked": "conversation.rating_remarked",
    // Tickets
    "ticket.created": "ticket.created",
    "ticket.state.updated": "ticket.state_updated",
    // Contact
    "contact.created": "conversation.contact_created",
    // User
    "user.created": "conversation.user_signed_up",
  };
  return MAP[topic] ?? topic.replace(/\./g, "_");
}

/**
 * Extract a human-readable summary from an Intercom webhook event.
 */
function buildSummary(topic: string, item: Record<string, unknown>): string {
  const source = item.source as Record<string, unknown> | undefined;
  const conversationId = item.id as string | undefined;

  // Try to get author info
  const author = source?.author as Record<string, unknown> | undefined;
  const authorName = (author?.name as string) || "Someone";
  const authorType = (author?.type as string) || "unknown";

  // Try to get body excerpt
  const body = (source?.body as string) || (item.body as string) || "";
  const plainBody = body.replace(/<[^>]*>/g, "").trim();
  const excerpt = plainBody.length > 200 ? plainBody.slice(0, 197) + "..." : plainBody;

  const idStr = conversationId ? ` #${conversationId}` : "";

  switch (topic) {
    case "conversation.user.created":
      return `New conversation${idStr} from ${authorName}: ${excerpt}`;
    case "conversation.user.replied":
      return `${authorName} replied to conversation${idStr}: ${excerpt}`;
    case "conversation.admin.replied":
      return `${authorName} (admin) replied to conversation${idStr}: ${excerpt}`;
    case "conversation.admin.single.created":
      return `${authorName} started a conversation${idStr} with a user: ${excerpt}`;
    case "conversation.admin.assigned":
      return `Conversation${idStr} assigned to ${(item.assignee as Record<string, unknown>)?.name || "someone"}`;
    case "conversation.admin.noted":
      return `${authorName} added a note to conversation${idStr}`;
    case "conversation.admin.closed":
      return `Conversation${idStr} closed by ${authorName}`;
    case "conversation.admin.opened":
      return `Conversation${idStr} reopened by ${authorName}`;
    case "conversation.admin.snoozed":
      return `Conversation${idStr} snoozed by ${authorName}`;
    case "conversation.admin.unsnoozed":
      return `Conversation${idStr} unsnoozed by ${authorName}`;
    case "conversation.rating.added": {
      const rating = (item.conversation_rating as Record<string, unknown>)?.rating;
      return `Conversation${idStr} rated ${rating ?? "unknown"}/5 by customer`;
    }
    case "conversation.rating.remarked": {
      const remark = (item.conversation_rating as Record<string, unknown>)?.remark as string;
      return `Customer left feedback on conversation${idStr}: ${remark || "(no text)"}`;
    }
    case "ticket.created":
      return `New ticket${idStr} created: ${(item.title as string) || excerpt}`;
    case "ticket.state.updated":
      return `Ticket${idStr} state changed to ${(item.ticket_state as string) || "unknown"}`;
    default:
      return `Intercom event: ${topic}${idStr}`;
  }
}

/**
 * Infer tags from the event topic and content.
 */
function inferTags(topic: string, item: Record<string, unknown>): string[] {
  const tags: string[] = [];

  if (topic.startsWith("conversation.rating")) {
    tags.push("csat");
    const rating = (item.conversation_rating as Record<string, unknown>)?.rating as number | undefined;
    if (rating !== undefined) {
      if (rating <= 2) tags.push("negative-feedback");
      if (rating >= 4) tags.push("positive-feedback");
    }
  }

  if (topic.includes("closed")) tags.push("resolved");
  if (topic.includes("created") && topic.includes("user")) tags.push("new-conversation");
  if (topic.startsWith("ticket")) tags.push("ticket");

  // Check for urgency signals in content
  const body = ((item.source as Record<string, unknown>)?.body as string) || "";
  const lower = body.toLowerCase();
  if (lower.includes("urgent") || lower.includes("asap") || lower.includes("critical")) {
    tags.push("urgent");
  }
  if (lower.includes("bug") || lower.includes("broken") || lower.includes("not working")) {
    tags.push("bug-report");
  }

  return [...new Set(tags)];
}

/**
 * Normalize an Intercom webhook payload into an OpenChiefEvent.
 */
export function normalizeIntercomEvent(
  payload: IntercomWebhookPayload
): OpenChiefEvent | null {
  const { topic, data, created_at } = payload;
  const item = data?.item;

  if (!item) return null;

  const eventType = mapTopic(topic);
  const summary = buildSummary(topic, item);
  const tags = inferTags(topic, item);

  // Extract actor info
  const source = item.source as Record<string, unknown> | undefined;
  const author = source?.author as Record<string, unknown> | undefined;
  const actorName = (author?.name as string) || undefined;

  return {
    id: generateULID(),
    timestamp: new Date(created_at * 1000).toISOString(),
    ingestedAt: new Date().toISOString(),
    source: "intercom",
    eventType,
    scope: {
      org: payload.app_id,
      project: topic.startsWith("ticket") ? "tickets" : "conversations",
      actor: actorName,
    },
    payload: item,
    summary,
    tags,
  };
}
