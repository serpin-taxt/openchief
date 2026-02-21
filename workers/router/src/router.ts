import type { OpenChiefEvent } from "@openchief/shared";
import { loadIdentityIndex, resolveEventIdentity } from "./identity-resolver";
import { enrichTweetUrls } from "./tweet-enricher";

interface Env {
  DB: D1Database;
  KV: KVNamespace;
  X_BEARER_TOKEN?: string;
}

/**
 * Route a batch of events: resolve identities and persist to D1.
 * Agents query D1 directly at report time using their subscriptions as filters.
 */
export async function routeEvents(
  events: OpenChiefEvent[],
  env: Env
): Promise<void> {
  const identityIndex = await loadIdentityIndex(env.DB, env.KV);

  for (const event of events) {
    // Resolve actor identity (e.g. GitHub username → real name)
    resolveEventIdentity(event, identityIndex);

    // Enrich Slack messages that contain tweet URLs with actual tweet content
    if (env.X_BEARER_TOKEN) {
      await enrichTweetUrls(event, env.X_BEARER_TOKEN);
    }

    // Persist the enriched event to D1
    await persistEvent(event, env.DB);
  }
}

async function persistEvent(event: OpenChiefEvent, db: D1Database) {
  await db
    .prepare(
      `INSERT OR IGNORE INTO events
        (id, timestamp, ingested_at, source, event_type, scope_org, scope_project, scope_team, scope_actor, summary, payload, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      event.id,
      event.timestamp,
      event.ingestedAt,
      event.source,
      event.eventType,
      event.scope.org || null,
      event.scope.project || null,
      event.scope.team || null,
      event.scope.actor || null,
      event.summary,
      JSON.stringify(event.payload),
      event.tags ? JSON.stringify(event.tags) : null
    )
    .run();
}
