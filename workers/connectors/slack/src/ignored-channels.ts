/**
 * Configurable channel filtering for the Slack connector.
 *
 * Channels in the ignore list are dropped at the connector level --
 * they never reach the event queue, router, or agents.
 *
 * Use this for noisy automated channels (deploy bots, CI notifications, etc.)
 * that would pollute agent reports with noise.
 *
 * Configuration via the IGNORED_CHANNELS environment variable:
 *   - Comma-separated list of channel names (without #)
 *   - Example: IGNORED_CHANNELS="deployments,github-notifications,ci-builds"
 *   - If not set, no channels are ignored by default.
 */

let parsedIgnoredChannels: Set<string> | null = null;
let lastRawValue: string | undefined;

/**
 * Parse the IGNORED_CHANNELS env var into a Set.
 * Caches the result for the lifetime of the worker instance.
 */
function getIgnoredSet(ignoredChannelsEnv: string | undefined): Set<string> {
  if (parsedIgnoredChannels && lastRawValue === ignoredChannelsEnv) {
    return parsedIgnoredChannels;
  }

  lastRawValue = ignoredChannelsEnv;

  if (!ignoredChannelsEnv || ignoredChannelsEnv.trim() === "") {
    parsedIgnoredChannels = new Set();
    return parsedIgnoredChannels;
  }

  parsedIgnoredChannels = new Set(
    ignoredChannelsEnv
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0)
  );

  return parsedIgnoredChannels;
}

/**
 * Check if a channel name should be ignored.
 * Strips leading '#' if present.
 *
 * @param channelName - The channel name to check (with or without #)
 * @param ignoredChannelsEnv - The value of the IGNORED_CHANNELS env var
 */
export function isChannelIgnored(
  channelName: string,
  ignoredChannelsEnv?: string
): boolean {
  const name = channelName.startsWith("#")
    ? channelName.slice(1)
    : channelName;
  const ignoredSet = getIgnoredSet(ignoredChannelsEnv);
  return ignoredSet.has(name.toLowerCase());
}
