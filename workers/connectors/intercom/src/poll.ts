/**
 * Polling tasks for Intercom connector.
 *
 * Runs on a cron schedule to fetch recently updated conversations
 * and normalize them into OpenChiefEvents.
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";
import { searchConversations, getConversation, type IntercomConversation, type IntercomConversationDetail, type IntercomConversationPart } from "./intercom-api";

interface Env {
  EVENTS_QUEUE: Queue;
  INTERCOM_ACCESS_TOKEN: string;
  KV: KVNamespace;
  DB: D1Database;
}

const POLL_CURSOR_KEY = "intercom:poll:cursor";

/**
 * Poll for recently updated conversations and enqueue events.
 */
export async function runPollTasks(env: Env): Promise<{ conversationsProcessed: number; eventsEnqueued: number }> {
  // Get cursor — last poll timestamp (unix seconds)
  const cursorStr = await env.KV.get(POLL_CURSOR_KEY);
  const lastPoll = cursorStr ? parseInt(cursorStr, 10) : Math.floor(Date.now() / 1000) - 3600; // default: 1 hour ago

  const pollStart = Math.floor(Date.now() / 1000);
  let conversationsProcessed = 0;
  let eventsEnqueued = 0;

  try {
    const result = await searchConversations(env.INTERCOM_ACCESS_TOKEN, lastPoll);

    for (const convo of result.conversations) {
      conversationsProcessed++;

      // Get full conversation with parts for richer data
      let detail;
      try {
        detail = await getConversation(env.INTERCOM_ACCESS_TOKEN, convo.id);
      } catch {
        // If we can't get detail, use the summary version
        detail = convo;
      }

      const event = normalizeConversationPoll(detail);
      if (event) {
        await env.EVENTS_QUEUE.send(event);
        eventsEnqueued++;
      }
    }

    // Update cursor
    await env.KV.put(POLL_CURSOR_KEY, pollStart.toString());
  } catch (err) {
    console.error("Intercom poll error:", err);
    throw err;
  }

  return { conversationsProcessed, eventsEnqueued };
}

/**
 * Deep backfill — fetch conversations from the last 7 days.
 */
export async function runDeepBackfill(env: Env): Promise<{ conversationsProcessed: number; eventsEnqueued: number }> {
  const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  let conversationsProcessed = 0;
  let eventsEnqueued = 0;
  let cursor: string | undefined;

  do {
    const result = await searchConversations(env.INTERCOM_ACCESS_TOKEN, sevenDaysAgo, cursor);

    for (const convo of result.conversations) {
      conversationsProcessed++;

      // Fetch full conversation with parts for richer data
      let detail: IntercomConversation | IntercomConversationDetail;
      try {
        detail = await getConversation(env.INTERCOM_ACCESS_TOKEN, convo.id);
      } catch {
        detail = convo;
      }

      const event = normalizeConversationPoll(detail);
      if (event) {
        await env.EVENTS_QUEUE.send(event);
        eventsEnqueued++;
      }
    }

    cursor = result.pages.next?.starting_after;
  } while (cursor);

  // Update cursor to now
  await env.KV.put(POLL_CURSOR_KEY, Math.floor(Date.now() / 1000).toString());

  return { conversationsProcessed, eventsEnqueued };
}

/**
 * Build a condensed transcript from conversation parts.
 * Filters out bot auto-greetings and internal notes, keeps user + admin messages.
 * Returns up to ~600 chars of meaningful chat content.
 */
function buildTranscript(convo: IntercomConversation | IntercomConversationDetail): string {
  const detail = convo as IntercomConversationDetail;
  const rawParts: IntercomConversationPart[] = detail.conversation_parts?.conversation_parts || [];
  if (rawParts.length === 0) return "";

  // Filter to meaningful messages — skip assignments, notes, system actions
  const messageParts = rawParts.filter((p) => {
    if (!p.body) return false;
    const partType = p.part_type;
    // Keep: comment (user/admin messages), note (admin notes are useful context)
    // Skip: assignment, open, close, etc.
    return partType === "comment" || partType === "note";
  });

  if (messageParts.length === 0) return "";

  const lines: string[] = [];
  let charBudget = 600;

  for (const part of messageParts) {
    if (charBudget <= 0) break;
    const plainBody = (part.body || "").replace(/<[^>]*>/g, "").trim();
    if (!plainBody) continue;
    // Skip the generic Intercom bot greeting
    if (plainBody.includes("This is an agent speaking")) continue;

    const role = part.author.type === "admin" || part.author.type === "bot" ? "AGENT" : "USER";
    const name = part.author.name || role;
    const truncBody = plainBody.length > 150 ? plainBody.slice(0, 147) + "..." : plainBody;
    const line = `[${role}] ${name}: ${truncBody}`;
    lines.push(line);
    charBudget -= line.length;
  }

  return lines.length > 0 ? `\nTRANSCRIPT:\n${lines.join("\n")}` : "";
}

/**
 * Normalize a polled conversation into an OpenChiefEvent.
 */
function normalizeConversationPoll(convo: IntercomConversation | IntercomConversationDetail): OpenChiefEvent | null {
  const { id, state, source, updated_at, statistics, conversation_rating, tags: tagData, contacts, assignee } = convo;
  const authorName = source?.author?.name || "Unknown";

  const body = source?.body || "";
  const plainBody = body.replace(/<[^>]*>/g, "").trim();
  const excerpt = plainBody.length > 200 ? plainBody.slice(0, 197) + "..." : plainBody;

  // Build a rich summary with all available stats
  const parts: string[] = [`INTERCOM_CONVERSATION #${id} | state=${state}`];
  if (authorName !== "Unknown") parts.push(`initiated_by=${authorName}`);
  if (assignee?.name) parts.push(`assigned_to=${assignee.name}`);

  // Contact info
  const contactCount = contacts?.contacts?.length ?? 0;
  if (contactCount > 0) {
    const contactNames = contacts?.contacts?.map((c: Record<string, unknown>) => c.name || c.email || "anon").join(", ");
    parts.push(`contacts=${contactNames} (${contactCount})`);
  }

  // Statistics — the most valuable part for the CS manager
  if (statistics) {
    const stats: string[] = [];
    if (statistics.time_to_admin_reply) stats.push(`first_reply=${Math.round(statistics.time_to_admin_reply / 60)}m`);
    if (statistics.time_to_first_close) stats.push(`time_to_close=${Math.round(statistics.time_to_first_close / 3600)}h`);
    if (statistics.median_time_to_reply) stats.push(`median_reply=${Math.round(statistics.median_time_to_reply / 60)}m`);
    if (statistics.count_conversation_parts) stats.push(`messages=${statistics.count_conversation_parts}`);
    if (statistics.count_reopens) stats.push(`reopens=${statistics.count_reopens}`);
    if (statistics.count_assignments) stats.push(`assignments=${statistics.count_assignments}`);
    if (stats.length > 0) parts.push(`stats=[${stats.join(", ")}]`);
  }

  // Rating
  if (conversation_rating?.rating) {
    parts.push(`csat=${conversation_rating.rating}/5`);
    if (conversation_rating.remark) parts.push(`feedback="${conversation_rating.remark}"`);
  }

  // Tags
  if (tagData?.tags?.length) {
    parts.push(`tags=[${tagData.tags.map((t) => t.name).join(", ")}]`);
  }

  // Excerpt — only if it's actual customer content, not the bot greeting
  if (excerpt && !excerpt.includes("This is an agent speaking")) {
    const shortExcerpt = excerpt.length > 100 ? excerpt.slice(0, 97) + "..." : excerpt;
    parts.push(`preview="${shortExcerpt}"`);
  }

  // Condensed transcript from conversation parts
  const transcript = buildTranscript(convo);
  if (transcript) parts.push(transcript);

  // Tags
  const tagNames = tagData?.tags?.map((t) => t.name) || [];

  return {
    id: generateULID(),
    timestamp: new Date(updated_at * 1000).toISOString(),
    ingestedAt: new Date().toISOString(),
    source: "intercom",
    eventType: `conversation.${state}`,
    scope: {
      project: "conversations",
      actor: authorName,
    },
    payload: {
      conversationId: id,
      state,
      authorName,
      authorType: source?.author?.type,
      excerpt,
      tags: tagNames,
      statistics,
      rating: conversation_rating ? { score: conversation_rating.rating, remark: conversation_rating.remark } : null,
      contactCount: contacts?.contacts?.length ?? 0,
      assigneeName: assignee?.name || null,
    },
    summary: parts.join(" | "),
    tags: [
      ...tagNames,
      ...(conversation_rating && conversation_rating.rating <= 2 ? ["negative-feedback"] : []),
      ...(conversation_rating && conversation_rating.rating >= 4 ? ["positive-feedback"] : []),
    ],
  };
}
