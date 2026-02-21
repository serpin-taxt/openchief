# migrations/ — D1 Database Schema

SQL migration files for Cloudflare D1. Applied via `wrangler d1 migrations apply openchief-db`.

## Migration Files

Applied in order by filename prefix:

### 0001_create_events.sql — Events Table

The core event store. Every connector writes normalized events here via the router.

```sql
CREATE TABLE events (
  id             TEXT PRIMARY KEY,        -- ULID (sortable by time)
  timestamp      TEXT NOT NULL,           -- ISO-8601 when event occurred at source
  ingested_at    TEXT NOT NULL,           -- ISO-8601 when ingested by connector
  source         TEXT NOT NULL,           -- "github", "slack", "discord", etc.
  event_type     TEXT NOT NULL,           -- Dot notation: "pr.opened", "message.posted"
  scope_org      TEXT,                    -- Organization/workspace
  scope_project  TEXT,                    -- Repo, channel, project
  scope_team     TEXT,                    -- Team identifier
  scope_actor    TEXT,                    -- Who triggered (resolved to display name by router)
  summary        TEXT NOT NULL,           -- Human-readable 1-3 sentence summary
  payload        TEXT NOT NULL,           -- JSON blob of full/normalized event data
  tags           TEXT                     -- JSON array: ["urgent", "security", "build-failure"]
);

-- Indexes
idx_events_source_type      (source, event_type)     -- Filter by source + type
idx_events_timestamp        (timestamp)               -- Time range queries
idx_events_source_timestamp (source, timestamp)        -- Source + time range
idx_events_scope_project    (scope_project, timestamp) -- Project scoped queries
```

**Key queries against this table:**
- Agent report generation: `WHERE source IN (...) AND event_type LIKE ... AND timestamp > ...`
- Dashboard event volume: `GROUP BY source, DATE(timestamp)`
- Connection events: `WHERE source = ? ORDER BY timestamp DESC LIMIT 100`
- `query_events` tool: User-written SQL (read-only, SELECT/WITH only)

### 0002_create_agents.sql — Agent Definitions + Subscriptions

```sql
CREATE TABLE agent_definitions (
  id          TEXT PRIMARY KEY,     -- Kebab-case: "eng-manager"
  name        TEXT NOT NULL,        -- Display: "Engineering Manager"
  description TEXT,                 -- What the agent does
  config      TEXT NOT NULL,        -- Full agent JSON (AgentDefinition)
  enabled     INTEGER DEFAULT 1,   -- 0 or 1
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE agent_subscriptions (
  id           TEXT PRIMARY KEY,   -- ULID
  agent_id     TEXT NOT NULL,      -- FK to agent_definitions.id
  source       TEXT NOT NULL,      -- "github", "slack", etc.
  event_types  TEXT NOT NULL,      -- JSON array: ["pr.*", "review.*"]
  scope_filter TEXT                -- JSON object or NULL: {"org": "myorg"}
);

-- Indexes
idx_agent_subs_source   (source)    -- Find all agents subscribed to a source
idx_agent_subs_agent    (agent_id)  -- Find all subscriptions for an agent
```

**agent_definitions.config** contains the full JSON blob — this is the source of truth. Other columns (name, description, enabled) are denormalized for query convenience.

**agent_subscriptions** are denormalized from the config for efficient routing. When an agent is updated, subscriptions are deleted and re-inserted.

### 0003_create_reports.sql — Agent Reports

```sql
CREATE TABLE agent_reports (
  id          TEXT PRIMARY KEY,     -- ULID
  agent_id    TEXT NOT NULL,        -- FK to agent_definitions.id
  report_type TEXT NOT NULL,        -- "daily-standup", "weekly-summary"
  content     TEXT NOT NULL,        -- JSON (ReportContent: headline, sections, actionItems, healthSignal)
  event_count INTEGER DEFAULT 0,    -- How many events were in the prompt
  created_at  TEXT NOT NULL
);

-- Indexes
idx_reports_agent       (agent_id, created_at)           -- Agent's reports over time
idx_reports_type        (report_type, created_at)         -- Reports by type
idx_reports_latest      (agent_id, report_type, created_at) -- Latest report per agent+type
```

### 0004_create_revisions.sql — Agent Change History

```sql
CREATE TABLE agent_revisions (
  id          TEXT PRIMARY KEY,     -- ULID
  agent_id    TEXT NOT NULL,        -- FK to agent_definitions.id
  config      TEXT NOT NULL,        -- Full JSON snapshot at this point in time
  changed_by  TEXT NOT NULL,        -- Email or "seed-script"
  change_note TEXT,                 -- What changed
  created_at  TEXT NOT NULL
);

-- Index
idx_revisions_agent (agent_id, created_at)  -- Agent's revision history
```

### 0005_create_identity_mappings.sql — Cross-Platform Identities

Maps a single person across all platforms. Used by the router for identity resolution and by the dashboard for team management.

```sql
CREATE TABLE identity_mappings (
  id               TEXT PRIMARY KEY,  -- ULID
  github_username  TEXT,              -- e.g., "johndoe"
  slack_user_id    TEXT,              -- e.g., "U0ABC12345"
  email            TEXT,              -- e.g., "john@company.com"
  real_name        TEXT,              -- Full name
  display_name     TEXT,              -- Preferred display name
  team             TEXT,              -- Team assignment
  role             TEXT,              -- Job title/role
  avatar_url       TEXT,
  figma_handle     TEXT,
  discord_handle   TEXT,
  jira_username    TEXT,
  notion_user_id   TEXT,
  is_bot           INTEGER DEFAULT 0,   -- 0=human, 1=bot
  is_active        INTEGER DEFAULT 1,   -- 0=inactive, 1=active
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

-- Indexes (one per platform field for lookup)
idx_identity_github   (github_username)
idx_identity_slack    (slack_user_id)
idx_identity_email    (email)
idx_identity_figma    (figma_handle)
idx_identity_discord  (discord_handle)
idx_identity_jira     (jira_username)
idx_identity_notion   (notion_user_id)
```

**Populated by:**
- Slack connector's identity sync (auto-creates from Slack user list)
- Dashboard's identity management (manual creation/merge)
- Seed data (during setup)

**Used by:**
- Router's identity resolver (resolves `scope.actor` to display name)
- Runtime's prompt builder (team directory in system prompt)
- Dashboard's Team page (list, filter, merge identities)

### 0006_create_model_settings.sql — AI Model Configuration

```sql
CREATE TABLE model_settings (
  job_type    TEXT PRIMARY KEY,      -- "daily-report", "weekly-report", "chat"
  model_id    TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  max_tokens  INTEGER NOT NULL DEFAULT 8192,
  updated_at  TEXT,
  updated_by  TEXT
);

-- Seed defaults
INSERT INTO model_settings (job_type, model_id, max_tokens)
VALUES
  ('daily-report',  'claude-sonnet-4-6', 8192),
  ('weekly-report', 'claude-sonnet-4-6', 8192),
  ('meeting',       'claude-sonnet-4-6', 8192),
  ('chat',          'claude-sonnet-4-6', 8192);
```

## Running Migrations

```bash
# Local development
npx wrangler d1 migrations apply openchief-db --local

# Production
npx wrangler d1 migrations apply openchief-db --remote
```

The setup script (`pnpm run setup`) runs migrations automatically.

## Schema Diagram

```
identity_mappings ──┐
                    │ (resolved via router)
events ─────────────┤
  ↑                 │
  │ (written by     │
  │  router)        │
  │                 │
agent_definitions ──┤
  │                 │
  ├── agent_subscriptions (denormalized for routing)
  ├── agent_reports (generated by runtime)
  └── agent_revisions (change history)

model_settings (standalone — controls runtime behavior)
```
