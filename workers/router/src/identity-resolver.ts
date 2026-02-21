/**
 * Cross-platform identity resolution.
 *
 * Loads identity_mappings from D1 (with KV caching) and resolves
 * platform-specific actor handles to canonical real names.
 *
 * Uses "via negativa" for large platforms like Discord —
 * only mapped team members get resolved; everyone else keeps their
 * platform handle as-is.
 */

import type { OpenChiefEvent } from "@openchief/shared";

interface IdentityMapping {
  real_name: string;
  display_name: string | null;
  team: string | null;
  is_bot: number;
}

type IdentityIndex = Map<string, Map<string, IdentityMapping>>;

const CACHE_KEY = "identity:index";
const CACHE_TTL = 300; // 5 minutes

/**
 * Build a lookup index from identity_mappings.
 */
export async function loadIdentityIndex(
  db: D1Database,
  kv: KVNamespace
): Promise<IdentityIndex> {
  const cached = (await kv.get(CACHE_KEY, "json")) as Record<
    string,
    Record<string, IdentityMapping>
  > | null;
  if (cached) {
    const index: IdentityIndex = new Map();
    for (const [source, handles] of Object.entries(cached)) {
      index.set(source, new Map(Object.entries(handles)));
    }
    return index;
  }

  const results = await db
    .prepare(
      `SELECT real_name, display_name, team, is_bot,
              github_username, slack_user_id, figma_handle, discord_handle
       FROM identity_mappings
       WHERE is_active = 1`
    )
    .all();

  const index: IdentityIndex = new Map();

  function addMapping(
    source: string,
    handle: string,
    mapping: IdentityMapping
  ) {
    if (!index.has(source)) index.set(source, new Map());
    index.get(source)!.set(handle, mapping);
  }

  for (const row of results.results) {
    const mapping: IdentityMapping = {
      real_name: row.real_name as string,
      display_name: row.display_name as string | null,
      team: row.team as string | null,
      is_bot: row.is_bot as number,
    };

    if (row.github_username) {
      addMapping("github", row.github_username as string, mapping);
    }
    if (row.slack_user_id) {
      addMapping("slack", row.slack_user_id as string, mapping);
    }
    const slackName = (row.display_name || row.real_name) as string;
    if (slackName) {
      addMapping("slack", slackName, mapping);
    }
    if (row.figma_handle) {
      addMapping("figma", row.figma_handle as string, mapping);
    }
    if (row.discord_handle) {
      addMapping(
        "discord",
        (row.discord_handle as string).toLowerCase(),
        mapping
      );
    }
  }

  const cacheObj: Record<string, Record<string, IdentityMapping>> = {};
  for (const [source, handles] of index) {
    cacheObj[source] = Object.fromEntries(handles);
  }
  await kv.put(CACHE_KEY, JSON.stringify(cacheObj), {
    expirationTtl: CACHE_TTL,
  });

  return index;
}

/**
 * Resolve the actor in an event to a canonical team member name.
 * Mutates the event in place.
 */
export function resolveEventIdentity(
  event: OpenChiefEvent,
  index: IdentityIndex
): void {
  const actor = event.scope.actor;
  if (!actor) return;

  const sourceMap = index.get(event.source);
  if (!sourceMap) return;

  let mapping = sourceMap.get(actor);
  if (!mapping && event.source === "discord") {
    mapping = sourceMap.get(actor.toLowerCase());
  }

  if (mapping) {
    event.payload._originalActor = actor;
    event.payload._actorTeam = mapping.team;
    event.payload._isTeamMember = !mapping.is_bot;
    event.payload._isBot = !!mapping.is_bot;

    if (!mapping.is_bot) {
      const canonicalName = mapping.display_name || mapping.real_name;
      event.scope.actor = canonicalName;
      if (event.summary.includes(actor)) {
        event.summary = event.summary.replace(actor, canonicalName);
      }
    }
  }
}
