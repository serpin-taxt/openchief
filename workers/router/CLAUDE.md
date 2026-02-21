# workers/router — Event Router

Cloudflare Worker that consumes the `openchief-events` queue, enriches events with identity resolution and tweet content, and persists them to D1. This is the bridge between connectors and the agent runtime.

## Worker Info

- **Name**: `openchief-router`
- **Entry**: `src/index.ts`
- **Queue Consumer**: `openchief-events` (max batch: 10, timeout: 30s)
- **Bindings**: D1 (`DB`), KV (`KV`), optional `X_BEARER_TOKEN` (secret, for tweet enrichment)

## File Structure

```
src/
├── index.ts                # Worker entry: queue handler + health check
├── router.ts               # Event processing pipeline (identity + enrichment + D1)
├── identity-resolver.ts    # Cross-platform identity resolution
└── tweet-enricher.ts       # Enrich Slack messages containing tweet URLs
```

## Event Processing Pipeline

```
Queue batch arrives (up to 10 events)
  → Load identity index from D1/KV cache
    → For each event:
      1. Resolve actor identity (GitHub handle → real name)
      2. Enrich tweet URLs in Slack messages (optional, needs X_BEARER_TOKEN)
      3. Persist to D1 events table (INSERT OR IGNORE for dedup)
```

## Queue Handler (`index.ts`)

```typescript
// Cloudflare Queue consumer
queue(batch: MessageBatch<OpenChiefEvent>, env: Env): Promise<void>
```

- Receives batches of `OpenChiefEvent` from any connector
- Delegates to `routeEvents()` for the actual processing
- Also exposes `GET /` health check endpoint

## Event Router (`router.ts`)

**`routeEvents(events, env)`**
1. Loads identity index (KV-cached, 5 min TTL)
2. For each event in order:
   - `resolveEventIdentity(event, identityIndex)` — mutates event in-place
   - `enrichTweetUrls(event, env.X_BEARER_TOKEN)` — mutates event in-place
   - `persistEvent(event, env.DB)` — writes to D1

**`persistEvent(event, db)`**
- `INSERT OR IGNORE INTO events (...)` — prevents duplicate events
- Maps `OpenChiefEvent` fields to D1 columns:
  - `id`, `timestamp`, `ingested_at` → direct mapping
  - `source`, `event_type` → direct mapping
  - `scope.org/project/team/actor` → `scope_org/scope_project/scope_team/scope_actor`
  - `payload` → `JSON.stringify()`
  - `tags` → `JSON.stringify()` or null
  - `summary` → direct mapping

## Identity Resolution (`identity-resolver.ts`)

Cross-platform identity resolution using a "via negativa" approach: only explicitly mapped team members get resolved. External contributors keep their original handles.

### Identity Index

```typescript
loadIdentityIndex(db, kv): Promise<Map<source, Map<handle, IdentityMapping>>>
```

- **KV cache**: key `identity:index`, TTL 300s (5 min)
- **D1 query**: `SELECT * FROM identity_mappings WHERE is_active = 1`
- Builds a 2-level map: `source → handle → identity`
- Platform handle mapping:
  - `github` → `github_username`
  - `slack` → `slack_user_id` AND `display_name` AND `real_name` (all three indexed)
  - `figma` → `figma_handle`
  - `discord` → lowercased `discord_handle`

### Event Identity Resolution

```typescript
resolveEventIdentity(event, identityIndex): void  // mutates event
```

When `event.scope.actor` matches an identity for `event.source`:
1. Preserves original: `event.payload._originalActor = originalHandle`
2. Adds metadata: `_actorTeam`, `_isTeamMember = true`, `_isBot`
3. Replaces `event.scope.actor` with canonical `display_name`
4. Replaces actor references in `event.summary` with display name

**Special cases:**
- Discord: case-insensitive lookup (`.toLowerCase()`)
- Bots: resolved but flagged as `_isBot = true`
- Non-team members: left untouched (no resolution)

## Tweet Enricher (`tweet-enricher.ts`)

Enriches Slack message events that contain tweet/X URLs with actual tweet content.

### When It Runs

Only processes events where:
- `source === "slack"` AND `eventType.startsWith("message.")`
- Event text contains `x.com/*/status/*` or `twitter.com/*/status/*` URLs
- `X_BEARER_TOKEN` environment variable is set

### What It Does

```typescript
enrichTweetUrls(event, bearerToken): Promise<void>  // mutates event
```

1. Regex extracts tweet IDs from URLs in Slack message text
2. Fetches up to 10 tweets at a time via X API v2
3. On success:
   - Stores full tweet data in `event.payload._enrichedTweets`
   - Appends `[Tweet by @username]: text` to `event.summary`
4. On failure: logs error, continues without enrichment (graceful degradation)

### X API Call

```
GET https://api.x.com/2/tweets?ids={ids}&tweet.fields=text,author_id&expansions=author_id&user.fields=username,name
Authorization: Bearer {decoded_token}
```

- Bearer token is URL-decoded before use
- Builds author lookup from `includes.users`
- Returns `TweetData[]` (id, text, author_username, author_name)

## Wrangler Config

```jsonc
{
  "name": "openchief-router",
  "main": "src/index.ts",
  "queues": {
    "consumers": [{
      "queue": "openchief-events",
      "max_batch_size": 10,
      "max_batch_timeout": 30
    }]
  },
  "d1_databases": [{ "binding": "DB", "database_name": "openchief-db" }],
  "kv_namespaces": [{ "binding": "KV" }]
  // Optional secret: X_BEARER_TOKEN
}
```

## Key Design Decisions

1. **Via negativa identity** — Only map known team members. External actors keep their handles. This is safer than guessing.
2. **Immutable event order** — Events are processed in batch order, no reordering
3. **INSERT OR IGNORE** — D1 deduplication prevents duplicate events if a connector publishes the same event twice
4. **KV-cached identity index** — 5 min TTL balances freshness vs. D1 read cost
5. **Graceful tweet enrichment** — Never blocks or fails the event pipeline; errors are logged and skipped
6. **Mutation pattern** — Events are mutated in-place for efficiency (no copying). Fields prefixed with `_` are metadata added by the router.
