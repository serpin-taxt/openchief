# workers/connectors — Data Source Connectors

Each connector is an independent Cloudflare Worker that ingests data from an external source, normalizes it into `OpenChiefEvent` format, and publishes to the `openchief-events` queue. The router then handles persistence and identity resolution.

## Connector Pattern

Every connector follows the same architecture:

```
External Source (webhook or poll)
  → Connector Worker
    → Verify signature / authenticate
      → Normalize to OpenChiefEvent[]
        → Queue.send() each event to openchief-events
```

### Required Wrangler Bindings

```jsonc
{
  "queues": {
    "producers": [{ "queue": "openchief-events", "binding": "EVENTS_QUEUE" }]
  }
}
```

### Common Patterns

1. **Webhook + Poll hybrid** — Primary: real-time webhooks. Backup: cron-based polling to catch missed events.
2. **Signature verification** — HMAC validation of incoming webhooks (GitHub: SHA-256, Slack: custom v0 scheme)
3. **Admin endpoint** — `POST /poll` with Bearer token for manual poll trigger
4. **Health check** — `GET /` returns service status
5. **Event deduplication** — ULID-based IDs; router uses `INSERT OR IGNORE`
6. **Graceful error handling** — Individual event failures don't crash the batch
7. **KV for state** — Polling cursors, user caches, channel lists stored in KV

## Implemented Connectors

### GitHub Connector (`github/`)

**Full implementation** — webhook receiver + cron-based polling.

#### File Structure
```
src/
├── index.ts              # Webhook handler + cron + /poll endpoint
├── normalize.ts          # GitHub webhook → OpenChiefEvent[]
├── poll.ts               # Cron polling (PRs, reviews, issues, commits, workflows)
├── webhook-verify.ts     # HMAC SHA-256 signature verification
└── github-app-auth.ts    # GitHub App JWT → installation token
```

#### Webhook Events Handled

| GitHub Event | Event Type(s) | Key Payload Fields |
|-------------|---------------|-------------------|
| `pull_request` | `pr.opened`, `pr.closed`, `pr.merged`, `pr.synchronize` | additions, deletions, changed_files, labels, draft, reviewers |
| `pull_request_review` | `review.submitted`, `review.dismissed` | state (approved/changes_requested), time_to_review_hours |
| `issues` | `issue.opened`, `issue.closed`, etc. | number, title, state, labels, age_hours |
| `issue_comment` | `comment.pr_discussion`, `comment.discussion` | body (truncated), word_count, file preview |
| `pull_request_review_comment` | `comment.pr_review` | path, position, word_count |
| `push` | `push.completed` | commit_count, branch |
| `workflow_run` | `build.failed`, `build.succeeded` | conclusion, branch, triggering_actor. Tags: `["build-failure"]` on fail |

#### Summary Format
Pipe-separated key=value segments:
```
PR #123 "title" was opened by user in org/repo | +10/-5 files=15 | labels=[bug]
```

#### Polling (`poll.ts`)
- **Cron**: Every 6 hours (`0 */6 * * *`)
- **Repos**: From `GITHUB_REPOS` env var (comma-separated)
- **Cursor**: KV key `poll:cursor:{repo}`, defaults to 30 days back
- **Fetches in parallel**: PRs, reviews (top 20 PRs), issues, commits, comments (review + issue), workflows
- **Slim payloads**: Strips large GitHub API responses to essential fields only
- **Pagination**: Max 5 pages per resource type

#### Auth (`github-app-auth.ts`)
- GitHub App: RS256 JWT → installation access token
- WebCrypto for signing (PKCS#8 private key)
- Module-level cache, 1hr validity, auto-refresh with 5-min buffer

#### Webhook Verification (`webhook-verify.ts`)
- Header: `x-hub-signature-256` = `sha256={hmac_hex}`
- HMAC-SHA256 of raw request body with `GITHUB_WEBHOOK_SECRET`
- Constant-time comparison to prevent timing attacks

#### Wrangler Config
```jsonc
{
  "name": "openchief-connector-github",
  "queues": { "producers": [{ "queue": "openchief-events", "binding": "EVENTS_QUEUE" }] },
  "kv_namespaces": [{ "binding": "POLL_CURSOR" }],
  "triggers": { "crons": ["0 */6 * * *"] }
  // Secrets: GITHUB_WEBHOOK_SECRET, GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY,
  //          GITHUB_INSTALLATION_ID, GITHUB_REPOS, ADMIN_SECRET
}
```

---

### Slack Connector (`slack/`)

**Full implementation** — webhook receiver + cron polling + deep backfill + identity sync.

#### File Structure
```
src/
├── index.ts              # Webhook handler (Events API) + cron + /poll + /backfill
├── normalize.ts          # Slack event → OpenChiefEvent[]
├── poll.ts               # Cron tasks: auto-join, user sync, message backfill
├── slack-api.ts          # Slack Web API client (rate limiting, pagination)
├── user-cache.ts         # KV-based user profile cache
├── identity-sync.ts      # Sync Slack users to D1 identity_mappings
└── ignored-channels.ts   # Configurable channel ignore list
```

#### Webhook Events Handled

| Slack Event | Event Type(s) | Key Details |
|-------------|---------------|-------------|
| `message` (regular) | `message.posted` | text (4000 char limit), user, channel, mentions resolved |
| `message` (thread reply) | `thread.replied` | thread_ts, parent reference |
| `message` (edited) | `message.edited` | previous + new text |
| `message` (deleted) | `message.deleted` | deleted timestamp |
| `reaction_added` | `reaction.added` | emoji, item_ts |
| `reaction_removed` | `reaction.removed` | emoji, item_ts |
| `channel_created` | `channel.created` | channel_id, channel_name, creator |
| `channel_archive` | `channel.archived` | channel_id |
| `channel_unarchive` | `channel.unarchived` | channel_id |
| `member_joined_channel` | `member.joined` | user_id, channel_id |
| `member_left_channel` | `member.left` | user_id, channel_id |
| `team_join` | `member.joined_workspace` | user_id |

**Skips**: bot messages, channel join/leave subtypes, app messages.

#### Webhook Processing
1. Parse JSON body
2. Handle `url_verification` challenge (Slack setup handshake)
3. Verify signature: `v0=HMAC-SHA256(signing_secret, "v0:{timestamp}:{body}")`
4. Replay protection: reject if timestamp > 5 minutes old
5. Process via `ctx.waitUntil()` (non-blocking — Slack requires <3s response)
6. Resolve channel name from KV
7. Skip ignored channels
8. Normalize → queue

#### User Resolution
- Resolves `<@U123>` mentions to `@displayname` in message text
- Uses KV cache (`slack:user:{userId}`, 24hr TTL) with API fallback
- Async resolver function passed to normalizer

#### Polling Tasks (every 30 minutes)

Three concurrent tasks:

1. **Auto-join public channels** (~5s)
   - List all public non-archived channels
   - Join any the bot isn't already in
   - Cache channel list to KV (1hr TTL)

2. **User profile sync** (~10s)
   - Fetch all workspace users
   - Bulk cache to KV (24hr TTL)
   - Sync to D1 `identity_mappings`:
     - Match by `slack_user_id` first
     - Fall back to email match
     - Insert new identities with ULID

3. **Message backfill** (~15s, rate-limited)
   - Process 1-2 channels per run
   - Track position via KV cursor
   - Normalize and enqueue each message

#### Deep Backfill (`POST /backfill`)
- Separate from regular polling
- Fetches up to 5 pages (1000 messages) per channel per call
- Tracks per-channel completion via KV flags
- Designed to be called repeatedly until `done: true`

#### Slack API Client (`slack-api.ts`)
- Handles 429 rate limits with `Retry-After` header (auto-retry up to 10s)
- Cursor-based pagination (max 10 pages)
- Methods: `listConversations`, `joinConversation`, `getConversationHistory`, `getConversationHistoryDeep`, `listUsers`, `getUserInfo`, `getTeamInfo`

#### Ignored Channels (`ignored-channels.ts`)
- `IGNORED_CHANNELS` env var (comma-separated): `"deployments,github-notifications"`
- Module-level Set, checked before normalization
- Channels in this list never reach the event queue

#### Wrangler Config
```jsonc
{
  "name": "openchief-connector-slack",
  "queues": { "producers": [{ "queue": "openchief-events", "binding": "EVENTS_QUEUE" }] },
  "kv_namespaces": [{ "binding": "KV" }],
  "d1_databases": [{ "binding": "DB", "database_name": "openchief-db" }],
  "triggers": { "crons": ["*/30 * * * *"] }
  // Secrets: SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET, ADMIN_SECRET
  // Optional: IGNORED_CHANNELS
}
```

---

### Figma Connector (`figma/`)

**Full implementation** — OAuth + webhook + cron polling + deep backfill. Most sophisticated connector — tracks version history, autosave-level edits, comments, and library publishes.

#### File Structure
```
src/
├── index.ts              # Webhook handler + OAuth flow + cron + /poll + /backfill
└── normalize.ts          # Figma webhook/API → OpenChiefEvent[]
```

#### Webhook Events Handled

| Figma Event | Event Type(s) | Key Details |
|-------------|---------------|-------------|
| `FILE_UPDATE` | `file.edited` | fileKey, fileName (fires ~30 min after editing inactivity, no actor) |
| `FILE_VERSION_UPDATE` | `file.version_updated` | fileKey, versionId, label, description, triggeredBy |
| `FILE_COMMENT` (new) | `comment.created` | commentId, text, fileKey, fileName, userId, userHandle |
| `FILE_COMMENT` (reply) | `comment.replied` | commentId, text, parentId, fileKey, fileName |
| `FILE_DELETE` | `file.deleted` | fileKey, fileName, triggeredBy |
| `LIBRARY_PUBLISH` | `library.published` | libraryName, created/modified/deleted components and styles |

#### Polling-Only Events

| Detection Method | Event Type | Key Details |
|-----------------|------------|-------------|
| `last_modified` change (no new version) | `file.edited` | Autosave detection via polling — editors inferred from recent version authors |

#### Webhook Verification
- Figma uses a **passcode** scheme (not HMAC) — each webhook payload contains a `passcode` field verified against `FIGMA_PASSCODE`
- Non-blocking processing via `ctx.waitUntil()` for fast response

#### Authentication
- **Dual auth support**: OAuth (preferred) and Personal Access Token (fallback)
- `getFigmaToken()` checks KV for OAuth token first (`figma:oauth_token`), falls back to `FIGMA_TOKEN` env secret
- Auto-detects token type by prefix: `figu_*` → Bearer auth (OAuth), `figd_*` → X-Figma-Token header (PAT)
- OAuth flow: `/oauth/start` → Figma authorize → `/oauth/callback` → token stored in KV with ~90-day TTL
- 11 granular v2 OAuth scopes (file_content:read, file_metadata:read, file_versions:read, file_comments:read, library_assets:read, library_content:read, team_library_content:read, file_dev_resources:read, projects:read, webhooks:read, webhooks:write)

#### File Discovery
Two strategies for determining which files to monitor:
1. **Explicit allowlist**: `figma:file_keys` KV key — JSON array of specific file keys
2. **Project scanning**: `figma:project_ids` KV key — scans all files in specified Figma projects

#### Polling (`runPollTasks`)
- **Cron**: Every 6 hours (`0 */6 * * *`)
- **File resolution**: Checks `figma:file_keys` allowlist first, falls back to scanning `figma:project_ids`
- **Version detection**: Fetches `/v1/files/{key}/versions`, filters to versions newer than last poll
- **Autosave detection**: Compares `last_modified` timestamps between polls — if changed but no named version, emits `file.edited` event
- **Cursor**: KV key `figma:last_poll:{fileKey}`, defaults to 6 hours back
- **Rate limiting**: 500ms delay between files

#### Deep Backfill (`POST /backfill`)
- Configurable lookback: `?days=7` (default)
- Fetches both versions and comments for all watched files
- Updates poll cursors after completion to avoid re-fetch
- 500ms delay between API calls per file

#### Auto-Tagging
`inferTags()` applies tags based on file name and content keywords: `design-update`, `design-feedback`, `design-system`, `icons`, `prototype`, `design-review`, `design-fix`, `library-publish`, `autosave`

#### Wrangler Config
```jsonc
{
  "name": "openchief-connector-figma",
  "queues": { "producers": [{ "queue": "openchief-events", "binding": "EVENTS_QUEUE" }] },
  "kv_namespaces": [{ "binding": "KV" }],
  "d1_databases": [{ "binding": "DB", "database_name": "openchief-db" }],
  "triggers": { "crons": ["0 */6 * * *"] }
  // Secrets: FIGMA_TOKEN, FIGMA_PASSCODE, FIGMA_CLIENT_ID, FIGMA_CLIENT_SECRET, ADMIN_SECRET
}
```

---

## Other Connectors

All 14 connectors are fully implemented. Beyond GitHub, Slack, and Figma (documented in detail above), these connectors follow the same patterns:

| Connector | Worker Name | Type | Key Features |
|-----------|-------------|------|-------------|
| discord | openchief-connector-discord | Webhook (Ed25519) + Polling | Deep backfill, configurable channel allowlist via `DISCORD_ALLOWED_CHANNELS` env var |
| jira | openchief-connector-jira | Polling | Issues, transitions, comments, sprints |
| jpd | openchief-connector-jpd | Polling | Jira Product Discovery — filters for Idea issue types via JQL |
| notion | openchief-connector-notion | Polling (15m) | Pages, database entries, comments; deduplicates DB entries (which are also pages) |
| intercom | openchief-connector-intercom | Webhook (HMAC-SHA1) + Polling | Conversations, messages, status changes; non-blocking webhook processing |
| twitter | openchief-connector-twitter | OAuth PKCE + Polling | Multi-account monitoring, optional search queries, per-account OAuth tokens |
| amplitude | openchief-connector-amplitude | Polling (6h) | Custom metrics snapshots |
| google-analytics | openchief-connector-googleanalytics | Polling | GA4 metrics (DAU, WAU, traffic sources, geography) via service account |
| google-calendar | openchief-connector-googlecalendar | OAuth + Polling | Calendar events, meetings; OAuth 2.0 with refresh token storage |
| quickbooks | openchief-connector-quickbooks | OAuth (Intuit) + Polling | Invoices, payments, customers, P&L reports; stores realm ID |
| rippling | openchief-connector-rippling | Polling (6h) | Employee data, org structure, time-off, payroll status; excludes salary data |

## How to Implement a New Connector

1. Create `workers/connectors/<name>/` with:
   - `src/index.ts` — Worker entry with `fetch()` handler (webhook) and optional `scheduled()` handler (cron)
   - `src/normalize.ts` — Transform source events to `OpenChiefEvent[]`
   - `package.json` — Depend on `@openchief/shared`
   - `wrangler.jsonc` — Queue producer binding + any KV/D1 bindings needed

2. In the normalize function:
   - Generate ULID for each event: `import { generateULID } from "@openchief/shared"`
   - Set `source` to match the key in `CONNECTOR_CONFIGS`
   - Set `eventType` in dot notation (e.g., `issue.created`, `message.posted`)
   - Fill `scope` (org, project, team, actor)
   - Write a human-readable `summary`
   - Include relevant data in `payload`

3. Register in dashboard (`workers/dashboard/worker/index.ts`):
   - Add to `CONNECTOR_CONFIGS` with fields
   - Add to `SOURCE_TO_TOOL` mapping
   - Add icon in `SourceIcon.tsx`

4. Reference the GitHub and Slack connectors as implementation examples.
