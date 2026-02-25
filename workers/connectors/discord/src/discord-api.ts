/**
 * Discord REST API helpers.
 */

const BASE = "https://discord.com/api/v10";

interface DiscordChannel {
  id: string;
  name: string;
  type: number; // 0 = text, 2 = voice, 4 = category, 5 = announcement, etc.
  guild_id?: string;
  parent_id?: string | null;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  author: {
    id: string;
    username: string;
    discriminator: string;
    bot?: boolean;
    global_name?: string | null;
  };
  content: string;
  timestamp: string;
  edited_timestamp: string | null;
  type: number;
  thread?: {
    id: string;
    name: string;
  };
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
  referenced_message?: DiscordMessage | null;
  reactions?: Array<{
    count: number;
    emoji: { id: string | null; name: string };
  }>;
}

interface DiscordGuild {
  id: string;
  name: string;
  icon: string | null;
}

export type { DiscordChannel, DiscordMessage, DiscordGuild };

async function discordFetch<T>(
  path: string,
  botToken: string,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

/** Get guild (server) info */
export async function getGuild(
  guildId: string,
  botToken: string
): Promise<DiscordGuild> {
  return discordFetch<DiscordGuild>(`/guilds/${guildId}`, botToken);
}

/** Get text channels in a guild */
export async function getGuildChannels(
  guildId: string,
  botToken: string
): Promise<DiscordChannel[]> {
  const channels = await discordFetch<DiscordChannel[]>(
    `/guilds/${guildId}/channels`,
    botToken
  );
  // Return only text-based channels (type 0 = text, 5 = announcement, 15 = forum)
  return channels.filter((c) => [0, 5, 15].includes(c.type));
}

/** Fetch recent messages from a channel */
export async function getChannelMessages(
  channelId: string,
  botToken: string,
  options?: { after?: string; limit?: number }
): Promise<DiscordMessage[]> {
  const params: Record<string, string> = {
    limit: String(options?.limit ?? 100),
  };
  if (options?.after) {
    params.after = options.after;
  }
  return discordFetch<DiscordMessage[]>(
    `/channels/${channelId}/messages`,
    botToken,
    params
  );
}

/** Get ALL channels in a guild (including categories for UI grouping) */
export async function getAllGuildChannels(
  guildId: string,
  botToken: string
): Promise<DiscordChannel[]> {
  return discordFetch<DiscordChannel[]>(`/guilds/${guildId}/channels`, botToken);
}

/** Get a specific channel */
export async function getChannel(
  channelId: string,
  botToken: string
): Promise<DiscordChannel> {
  return discordFetch<DiscordChannel>(`/channels/${channelId}`, botToken);
}
