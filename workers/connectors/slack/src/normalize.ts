/**
 * Normalize Slack event payloads into OpenChiefEvent[].
 *
 * This is async because it needs to resolve Slack user IDs to real names
 * via the user cache.
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";
import type { UserInfo } from "./user-cache";

type UserResolver = (userId: string) => Promise<UserInfo>;

// --- Main Normalizer ------------------------------------------------------------

export async function normalizeSlackEvent(
  event: Record<string, unknown>,
  channelName: string | undefined,
  resolveUser: UserResolver,
  workspaceName: string
): Promise<OpenChiefEvent[]> {
  const eventType = event.type as string;
  const now = new Date().toISOString();

  switch (eventType) {
    case "message":
      return normalizeMessage(
        event,
        channelName,
        resolveUser,
        workspaceName,
        now
      );
    case "reaction_added":
    case "reaction_removed":
      return normalizeReaction(
        event,
        channelName,
        resolveUser,
        workspaceName,
        now
      );
    case "channel_created":
      return normalizeChannelCreated(event, resolveUser, workspaceName, now);
    case "channel_archive":
    case "channel_unarchive":
      return normalizeChannelArchive(event, channelName, workspaceName, now);
    case "member_joined_channel":
    case "member_left_channel":
      return normalizeMemberEvent(
        event,
        channelName,
        resolveUser,
        workspaceName,
        now
      );
    case "team_join":
      return normalizeTeamJoin(event, resolveUser, workspaceName, now);
    default:
      return [];
  }
}

// --- Message Normalization ------------------------------------------------------

async function normalizeMessage(
  event: Record<string, unknown>,
  channelName: string | undefined,
  resolveUser: UserResolver,
  workspaceName: string,
  now: string
): Promise<OpenChiefEvent[]> {
  const subtype = event.subtype as string | undefined;
  const channelId = event.channel as string;
  const ts = event.ts as string;
  const threadTs = event.thread_ts as string | undefined;
  const channel = channelName || channelId;

  // Skip bot/app messages and channel system messages
  if (
    subtype === "bot_message" ||
    subtype === "channel_join" ||
    subtype === "channel_leave" ||
    event.bot_id
  ) {
    return [];
  }

  // Message deleted
  if (subtype === "message_deleted") {
    return [
      makeEvent({
        eventType: "message.deleted",
        scope: { org: workspaceName, project: `#${channel}` },
        summary: `Message deleted in #${channel}`,
        payload: { channel_id: channelId, deleted_ts: event.deleted_ts },
        ts: (event.event_ts as string) || ts,
        now,
      }),
    ];
  }

  // Message edited
  if (subtype === "message_changed") {
    const message = event.message as Record<string, unknown> | undefined;
    const userId = message?.user as string | undefined;
    const actor = userId ? await resolveUser(userId) : null;
    const text = truncate((message?.text as string) || "", 500);

    return [
      makeEvent({
        eventType: "message.edited",
        scope: {
          org: workspaceName,
          project: `#${channel}`,
          actor: actor?.realName,
        },
        summary: `${actor?.realName || "Someone"} edited a message in #${channel}: "${text}"`,
        payload: {
          channel_id: channelId,
          user_id: userId,
          text: truncate((message?.text as string) || "", 4000),
          ts: message?.ts,
        },
        ts: (event.event_ts as string) || ts,
        now,
      }),
    ];
  }

  // Regular message or thread reply
  const userId = event.user as string | undefined;
  if (!userId) return [];

  const actor = await resolveUser(userId);

  // Skip bot users
  if (actor.isBot) return [];

  const rawText = (event.text as string) || "";
  const text = await resolveSlackMentions(rawText, resolveUser);
  const isThread = threadTs && threadTs !== ts;

  const eventTypeName = isThread ? "thread.replied" : "message.posted";
  const summaryPrefix = isThread
    ? `${actor.realName} replied in thread in #${channel}`
    : `${actor.realName} posted in #${channel}`;

  const normalized = makeEvent({
    eventType: eventTypeName,
    scope: {
      org: workspaceName,
      project: `#${channel}`,
      actor: actor.realName,
    },
    summary: `${summaryPrefix}: "${truncate(text, 500)}"`,
    payload: {
      channel_id: channelId,
      channel_name: channel,
      user_id: userId,
      text: truncate(text, 4000),
      ts,
      thread_ts: threadTs || null,
      files: extractFiles(
        event.files as Record<string, unknown>[] | undefined
      ),
    },
    ts: (event.event_ts as string) || ts,
    now,
  });

  return [normalized];
}

// --- Reaction Normalization -----------------------------------------------------

async function normalizeReaction(
  event: Record<string, unknown>,
  channelName: string | undefined,
  resolveUser: UserResolver,
  workspaceName: string,
  now: string
): Promise<OpenChiefEvent[]> {
  const userId = event.user as string;
  const reaction = event.reaction as string;
  const item = event.item as Record<string, unknown>;
  const channelId = item?.channel as string;
  const channel = channelName || channelId || "unknown";
  const isAdded = event.type === "reaction_added";

  const actor = await resolveUser(userId);
  if (actor.isBot) return [];

  return [
    makeEvent({
      eventType: isAdded ? "reaction.added" : "reaction.removed",
      scope: {
        org: workspaceName,
        project: `#${channel}`,
        actor: actor.realName,
      },
      summary: `${actor.realName} ${isAdded ? "reacted with" : "removed"} :${reaction}: in #${channel}`,
      payload: {
        channel_id: channelId,
        user_id: userId,
        reaction,
        item_ts: item?.ts,
      },
      ts: (event.event_ts as string) || now,
      now,
    }),
  ];
}

// --- Channel Events -------------------------------------------------------------

async function normalizeChannelCreated(
  event: Record<string, unknown>,
  resolveUser: UserResolver,
  workspaceName: string,
  now: string
): Promise<OpenChiefEvent[]> {
  const ch = event.channel as Record<string, unknown>;
  const channelName = ch?.name as string;
  const creatorId = ch?.creator as string;
  const actor = creatorId ? await resolveUser(creatorId) : null;

  return [
    makeEvent({
      eventType: "channel.created",
      scope: {
        org: workspaceName,
        project: `#${channelName}`,
        actor: actor?.realName,
      },
      summary: `${actor?.realName || "Someone"} created channel #${channelName}`,
      payload: { channel_id: ch?.id, channel_name: channelName },
      ts: (event.event_ts as string) || now,
      now,
    }),
  ];
}

async function normalizeChannelArchive(
  event: Record<string, unknown>,
  channelName: string | undefined,
  workspaceName: string,
  now: string
): Promise<OpenChiefEvent[]> {
  const channelId = event.channel as string;
  const channel = channelName || channelId;
  const isArchive = event.type === "channel_archive";

  return [
    makeEvent({
      eventType: isArchive ? "channel.archived" : "channel.unarchived",
      scope: { org: workspaceName, project: `#${channel}` },
      summary: `#${channel} was ${isArchive ? "archived" : "unarchived"}`,
      payload: { channel_id: channelId },
      ts: (event.event_ts as string) || now,
      now,
    }),
  ];
}

// --- Member Events --------------------------------------------------------------

async function normalizeMemberEvent(
  event: Record<string, unknown>,
  channelName: string | undefined,
  resolveUser: UserResolver,
  workspaceName: string,
  now: string
): Promise<OpenChiefEvent[]> {
  const userId = event.user as string;
  const channelId = event.channel as string;
  const channel = channelName || channelId;
  const isJoin = event.type === "member_joined_channel";
  const actor = await resolveUser(userId);

  return [
    makeEvent({
      eventType: isJoin ? "member.joined" : "member.left",
      scope: {
        org: workspaceName,
        project: `#${channel}`,
        actor: actor.realName,
      },
      summary: `${actor.realName} ${isJoin ? "joined" : "left"} #${channel}`,
      payload: { channel_id: channelId, user_id: userId },
      ts: (event.event_ts as string) || now,
      now,
    }),
  ];
}

// --- Team Join ------------------------------------------------------------------

async function normalizeTeamJoin(
  event: Record<string, unknown>,
  resolveUser: UserResolver,
  workspaceName: string,
  now: string
): Promise<OpenChiefEvent[]> {
  const user = event.user as Record<string, unknown>;
  const userId = user?.id as string;
  const actor = userId ? await resolveUser(userId) : null;

  return [
    makeEvent({
      eventType: "member.joined_workspace",
      scope: { org: workspaceName, actor: actor?.realName },
      summary: `${actor?.realName || "Someone"} joined the workspace`,
      payload: { user_id: userId },
      ts: (event.event_ts as string) || now,
      now,
    }),
  ];
}

// --- Helpers --------------------------------------------------------------------

function makeEvent(opts: {
  eventType: string;
  scope: { org: string; project?: string; actor?: string; team?: string };
  summary: string;
  payload: Record<string, unknown>;
  ts: string;
  now: string;
}): OpenChiefEvent {
  return {
    id: generateULID(),
    timestamp: slackTsToIso(opts.ts),
    ingestedAt: opts.now,
    source: "slack",
    eventType: opts.eventType,
    scope: opts.scope,
    payload: opts.payload,
    summary: opts.summary,
  };
}

function slackTsToIso(ts: string): string {
  try {
    const seconds = parseFloat(ts);
    return new Date(seconds * 1000).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "...";
}

/**
 * Resolve Slack-style user mentions (<@U123>) to real names.
 */
async function resolveSlackMentions(
  text: string,
  resolveUser: UserResolver
): Promise<string> {
  const mentionPattern = /<@(U[A-Z0-9]+)(?:\|[^>]*)?>/g;
  const matches = [...text.matchAll(mentionPattern)];
  let resolved = text;

  for (const match of matches) {
    const userId = match[1];
    try {
      const user = await resolveUser(userId);
      resolved = resolved.replace(match[0], `@${user.displayName}`);
    } catch {
      // Keep the original mention if resolution fails
    }
  }

  // Also resolve channel mentions: <#C123|channel-name> -> #channel-name
  resolved = resolved.replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1");

  return resolved;
}

function extractFiles(
  files: Record<string, unknown>[] | undefined
): Array<Record<string, unknown>> | null {
  if (!files || files.length === 0) return null;
  return files.map((f) => ({
    file_id: f.id,
    filename: f.name,
    filetype: f.filetype,
    size_bytes: f.size,
    mimetype: f.mimetype,
    url_private: f.url_private,
    thumb_url: f.thumb_360 || f.thumb_480 || null,
    is_image: ((f.mimetype as string) || "").startsWith("image/"),
  }));
}
