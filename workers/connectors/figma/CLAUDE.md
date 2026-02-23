# Figma Connector

Cloudflare Worker that ingests Figma design activity into OpenChief via webhooks and periodic polling. Normalizes raw Figma API payloads into `OpenChiefEvent` objects and publishes them to the shared Cloudflare Queue.

## How It Works

Three ingestion paths, all produce the same normalized events:

### Webhooks (real-time)

Figma sends POST requests to `/webhook` when subscribed events occur. The worker:

1. Verifies the `passcode` field in the JSON payload against `FIGMA_PASSCODE`
2. Calls `normalizeWebhookEvent()` to convert the payload into `OpenChiefEvent` objects
3. Publishes each event to the `EVENTS_QUEUE` (Cloudflare Queue)
4. Processes in background via `ctx.waitUntil()` for fast webhook response

### Polling (periodic)

A cron trigger (`0 */6 * * *`) calls `runPollTasks()` which:

1. Gets the best available Figma token (OAuth preferred, PAT fallback)
2. Resolves the list of watched files — either from `figma:file_keys` KV allowlist or by scanning all project files from `figma:project_ids`
3. For each file, fetches version history from `/v1/files/{key}/versions`
4. Filters to versions newer than the last poll (KV cursor, defaults to 6 hours back)
5. Detects autosave-level edits by comparing `last_modified` timestamps between polls
6. Normalizes and publishes all events to the queue
7. Rate limits at 500ms between files to avoid Figma API throttling

### Backfill (on-demand)

`POST /backfill` fetches historical versions and comments for all watched files:

1. Looks back N days (default 7, configurable via `?days=` query param)
2. Fetches version history and comments for each file
3. Normalizes and publishes all events to the queue
4. Updates poll cursors so regular polling doesn't re-fetch

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Worker entry point — routes requests (health check, webhook, OAuth, admin /poll, /backfill), cron handler |
| `src/normalize.ts` | Converts Figma webhook/API payloads to `OpenChiefEvent[]` |

## Event Types Produced

| Figma Event | OpenChief Event Type | Key Metadata |
|-------------|---------------------|--------------|
| `FILE_UPDATE` | `file.edited` | fileKey, fileName (fires ~30 min after editing inactivity, no actor) |
| `FILE_VERSION_UPDATE` | `file.version_updated` | fileKey, versionId, label, description, triggeredBy |
| `FILE_COMMENT` (new) | `comment.created` | commentId, text, fileKey, fileName, userId, userHandle |
| `FILE_COMMENT` (reply) | `comment.replied` | commentId, text, parentId, fileKey, fileName |
| `FILE_DELETE` | `file.deleted` | fileKey, fileName, triggeredBy |
| `LIBRARY_PUBLISH` | `library.published` | libraryName, created/modified/deleted components and styles |
| Autosave detection (poll) | `file.edited` | fileKey, fileName, lastModified, editors (recent version authors) |

### Auto-Tagging

The `inferTags()` function applies tags based on file name and content keywords:
- `design-update` — version saves
- `design-feedback` — comments
- `design-system` — files/comments mentioning "component" or "design system"
- `icons` — icon-related activity
- `prototype` — prototype or flow mentions
- `design-review` — review/feedback mentions
- `design-fix` — bug/fix mentions
- `library-publish` — library publish events
- `autosave` — file edit (autosave) detections

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | None | Health check — returns `{ service, status: "ok" }` |
| `POST` | `/webhook` | Passcode in payload | Figma webhook receiver |
| `POST` | `/poll` | Bearer `ADMIN_SECRET` | Manual poll trigger — checks all watched files |
| `POST` | `/backfill` | Bearer `ADMIN_SECRET` | Deep backfill — `?days=7` (default). Fetches versions + comments |
| `GET` | `/oauth/start` | Bearer `ADMIN_SECRET` | Redirects to Figma OAuth authorize page |
| `GET` | `/oauth/callback` | State param | OAuth callback — exchanges code for token, stores in KV |

## Authentication

This connector supports two authentication methods with automatic preference:

### OAuth (preferred)

1. Admin navigates to `/oauth/start` (or constructs the Figma OAuth URL directly)
2. User authorizes the Figma app with 11 granular scopes (v2)
3. Callback exchanges the code for an access token (90-day TTL) and refresh token
4. Tokens stored in KV: `figma:oauth_token` (with TTL) and `figma:refresh_token`
5. OAuth tokens use `Authorization: Bearer {token}` header

### Personal Access Token (fallback)

1. Set `FIGMA_TOKEN` secret with a Figma PAT (prefix `figd_*`)
2. PAT tokens use `X-Figma-Token: {token}` header

### Token Selection

`getFigmaToken()` checks KV for an OAuth token first, falls back to `FIGMA_TOKEN` env secret. The `figmaApi()` helper auto-detects the token type by prefix (`figu_*` = OAuth Bearer, `figd_*` = X-Figma-Token header).

## OAuth Scopes (v2 granular)

| Scope | Purpose |
|-------|---------|
| `file_content:read` | Read file content (nodes, images) |
| `file_metadata:read` | Read file metadata (name, last modified) |
| `file_versions:read` | Read version history |
| `file_comments:read` | Read file comments |
| `library_assets:read` | Read library assets |
| `library_content:read` | Read library content |
| `team_library_content:read` | Read team library content |
| `file_dev_resources:read` | Read dev resources |
| `projects:read` | List project files |
| `webhooks:read` | Read webhook registrations |
| `webhooks:write` | Create/manage webhooks |

## Environment / Secrets

All secrets are set via `wrangler secret put <NAME>`:

| Name | Type | Description |
|------|------|-------------|
| `FIGMA_TOKEN` | Secret | Personal Access Token (fallback if no OAuth token in KV) |
| `FIGMA_PASSCODE` | Secret | Passcode for webhook payload verification |
| `FIGMA_CLIENT_ID` | Secret | OAuth app client ID |
| `FIGMA_CLIENT_SECRET` | Secret | OAuth app client secret |
| `ADMIN_SECRET` | Secret | Bearer token for `/poll`, `/backfill`, `/oauth/start` endpoints |

## Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `EVENTS_QUEUE` | Queue producer | Publishes normalized events to `openchief-events` |
| `KV` | KV namespace | OAuth tokens, file keys, project IDs, poll cursors, last-modified tracking |
| `DB` | D1 database | Shared `openchief-db` (available but not directly used by connector) |

## KV Keys

| Key | TTL | Purpose |
|-----|-----|---------|
| `figma:oauth_token` | ~90 days | OAuth access token (preferred auth) |
| `figma:refresh_token` | None | OAuth refresh token |
| `figma:project_ids` | None | JSON array or comma-separated list of Figma project IDs to scan |
| `figma:file_keys` | None | JSON array or comma-separated list of specific file keys to watch (overrides project scanning) |
| `figma:last_poll:{fileKey}` | 7 days | Last poll timestamp per file |
| `figma:last_modified:{fileKey}` | 30 days | Stored `last_modified` for autosave detection |

## Setup

### Creating a Figma App

1. Go to **figma.com/developers/apps** → **Create new app**
2. Set the **App name** (e.g., "OpenChief")
3. Add the **Callback URL**: `https://your-connector.workers.dev/oauth/callback`
4. Set **Allowed scopes** — all 11 scopes listed above
5. Add a **Description** and **Support contact** (required for publishing)
6. **Publish** the app as **Private** (only your team can access)
7. Note the **Client ID** and **Client Secret**
8. Set all secrets via `wrangler secret put`

### Configuring Watched Files

Set one of these KV keys to tell the connector what to monitor:

**Option A — Project IDs** (watches all files in specified projects):
```bash
# Find project ID in Figma URL: figma.com/files/project/{projectId}/...
wrangler kv key put --namespace-id=<KV_ID> "figma:project_ids" "[\"183464427\"]"
```

**Option B — File keys** (watches specific files only):
```bash
# Find file key in Figma URL: figma.com/design/{fileKey}/...
wrangler kv key put --namespace-id=<KV_ID> "figma:file_keys" "[\"abc123\",\"def456\"]"
```

### Completing OAuth Flow

After deploying and setting secrets:

1. Navigate to `https://your-connector.workers.dev/oauth/start` (with `Authorization: Bearer <ADMIN_SECRET>` header), or construct the OAuth URL directly:
   ```
   https://www.figma.com/oauth?client_id=<CLIENT_ID>&redirect_uri=<CALLBACK_URL>&scope=file_content:read,file_metadata:read,...&response_type=code&state=openchief
   ```
2. Authorize the app on Figma's consent screen
3. Token is automatically stored in KV on callback

### Setting Up Webhooks

Create webhooks via the Figma API after OAuth is configured:

```bash
curl -X POST https://api.figma.com/v2/webhooks \
  -H "Authorization: Bearer <OAUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{
    "event_type": "FILE_VERSION_UPDATE",
    "team_id": "<TEAM_ID>",
    "endpoint": "https://your-connector.workers.dev/webhook",
    "passcode": "<FIGMA_PASSCODE>"
  }'
```

Repeat for `FILE_UPDATE`, `FILE_COMMENT`, `FILE_DELETE`, and `LIBRARY_PUBLISH` event types.

### Using Claude Code with Browser Automation

```
Set up the Figma connector for OpenChief. Navigate to figma.com/developers/apps,
create a new app called "OpenChief", add the callback URL for my Figma connector
worker, set all 11 v2 OAuth scopes (file_content:read, file_metadata:read,
file_versions:read, file_comments:read, library_assets:read, library_content:read,
team_library_content:read, file_dev_resources:read, projects:read, webhooks:read,
webhooks:write), add a description and support contact, publish the app as Private,
then complete the OAuth flow by navigating to the authorize URL, granting access,
and verifying the token was stored. Finally set all wrangler secrets on the connector
worker and configure the project IDs or file keys in KV.
```

## Polling Details

- Resolves watched files from `figma:file_keys` allowlist first, falls back to scanning `figma:project_ids`
- For allowlisted file keys, tries to resolve metadata from project file lists (cheaper), falls back to individual file endpoint
- 500ms delay between files to respect Figma API rate limits
- Tracks `last_modified` per file — detects autosave edits even when no named version is saved
- Recent version authors are used as a proxy for who is actively editing
- On first poll, looks back 6 hours; subsequent polls use KV cursor

## Backfill Details

- Fetches versions and comments for all watched files
- Default lookback: 7 days (configurable via `?days=` query param)
- 500ms delay between API calls per file
- Updates poll cursors after backfill so regular polling doesn't duplicate
- Designed to be called once during initial setup or after adding new files
