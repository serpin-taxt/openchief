# scripts/ — Setup, Seed, Config Generation, Deploy

CLI scripts for onboarding, configuration, and deployment. All written in TypeScript and run via `tsx`.

## File Structure

```
scripts/
├── setup.ts           # Interactive setup wizard (pnpm run setup)
├── seed-agents.ts     # Seed agent definitions to D1 (pnpm seed)
├── generate-config.ts # Generate wrangler.jsonc files from config (pnpm generate-config)
├── deploy.ts          # Build + deploy all workers (pnpm run deploy)
└── teardown.ts        # Delete all workers + resources (pnpm run teardown)
```

## setup.ts — Interactive Setup Wizard

**Command**: `pnpm run setup` (or `npx tsx scripts/setup.ts`)

Guides users through complete OpenChief setup:

### Steps

1. **Organization** — Prompts for company name + brief description (injected into agent prompts as context)

2. **Cloudflare Account** — Prompts for account ID. Optionally auto-creates resources:
   - D1 database (`openchief-db`)
   - KV namespace (`OPENCHIEF_KV`)
   - Queue (`openchief-events`)
   - Uses `wrangler d1 create`, `wrangler kv namespace create`, `wrangler queues create`

3. **AI Provider** — Prompts for Anthropic API key (`sk-ant-...`)

4. **Connector Selection** — Checkboxes for 12 connectors (GitHub + Slack default-selected):
   - github, slack, discord, figma, intercom, twitter, jira, notion, amplitude, google-calendar, google-analytics, quickbooks

5. **Starter Agents** — Checkboxes for 6 starter agents (eng-manager + product-manager default-selected):
   - eng-manager, product-manager, design-manager, customer-support, community-manager, data-analyst

6. **GitHub Repo** — Prompts for `owner/repo` (used by `github_file` and `github_search` tools)

7. **Config File Generation** — Writes `openchief.config.ts` with all collected values

8. **Wrangler Config Updates** — Calls `generate-config.ts` to update all `wrangler.jsonc` files

9. **Database Migrations** — Runs `wrangler d1 migrations apply` against `openchief-db`

10. **Agent Seeding** — Runs `seed-agents.ts` to insert selected agents into D1

11. **Secret Deployment** — Runs `wrangler secret put` for ANTHROPIC_API_KEY on the runtime worker

### Implementation

- Uses Node `readline` for interactive prompts
- Default values shown in brackets `[default]`
- Supports pre-existing configs (re-running is safe)
- All Cloudflare resource creation is optional (user can provide existing IDs)

## seed-agents.ts — Agent Seeder

**Command**: `pnpm seed` (or `npx tsx scripts/seed-agents.ts`)

Reads all `.json` files from the `agents/` directory and inserts them into D1.

### What It Does

For each agent JSON file:
1. Parse JSON file
2. `INSERT OR REPLACE INTO agent_definitions` — id, name, description, full config JSON, enabled flag
3. For each subscription: `INSERT OR REPLACE INTO agent_subscriptions` — ULID id, agent_id, source, event_types JSON, scope_filter JSON
4. `INSERT OR REPLACE INTO agent_revisions` — ULID id, agent_id, full config JSON, "seed-script" as changed_by, "Initial seed" as change_note

### ULID Generation

Inline ULID generator (same as `@openchief/shared`):
- 10 time chars + 16 random chars
- Crockford's Base32 encoding
- Used for subscription IDs and revision IDs

### Execution

Uses `wrangler d1 execute openchief-db --local` — runs against the local D1 database. For production, change `--local` to `--remote` or remove the flag.

### Adding New Agents

Just add a `.json` file to `agents/` and run `pnpm seed`. The script discovers all JSON files automatically — no code changes needed.

## generate-config.ts — Wrangler Config Generator

**Command**: `pnpm generate-config` (or `npx tsx scripts/generate-config.ts`)

Reads `openchief.config.ts` and updates `wrangler.jsonc` files for all workers with the correct resource IDs.

### What It Updates

5 `wrangler.jsonc` files:
1. `workers/runtime/wrangler.jsonc` — D1 database ID, KV namespace ID
2. `workers/router/wrangler.jsonc` — D1 database ID, KV namespace ID
3. `workers/dashboard/wrangler.jsonc` — D1 database ID, KV namespace ID, account ID
4. `workers/connectors/github/wrangler.jsonc` — KV namespace ID, queue name
5. `workers/connectors/slack/wrangler.jsonc` — KV namespace ID, D1 database ID, queue name

### How It Works

1. Dynamically imports `openchief.config.ts`
2. Validates required fields (accountId, d1DatabaseId, kvNamespaceId)
3. For each wrangler.jsonc file:
   - Reads existing content (strips comments for JSON parse)
   - Replaces placeholder values (`REPLACE_WITH_*`) with actual IDs
   - Writes back to file

### Placeholder Convention

Wrangler files use these placeholders that get replaced:
- `REPLACE_WITH_D1_DATABASE_ID`
- `REPLACE_WITH_KV_NAMESPACE_ID`
- `REPLACE_WITH_ACCOUNT_ID`

## deploy.ts — Full Deployment

**Command**: `pnpm run deploy` (or `npx tsx scripts/deploy.ts`)

Orchestrates building and deploying all workers.

### Steps

1. **Build** — `pnpm build` (Turborepo builds all packages)
2. **Deploy core workers** (in order):
   - `workers/runtime` → `npx wrangler deploy`
   - `workers/router` → `npx wrangler deploy`
   - `workers/dashboard` → `npx wrangler deploy`
3. **Deploy enabled connectors** — Reads `openchief.config.ts` and deploys only connectors where `enabled: true`

### Connector Deploy

For each enabled connector:
- Checks if `workers/connectors/<name>/` directory exists
- Runs `npx wrangler deploy` in that directory
- Skips gracefully if directory doesn't exist (stub connectors)

## teardown.ts — Full Teardown

**Command**: `pnpm run teardown` (or `npx tsx scripts/teardown.ts`)

Deletes all deployed workers and Cloudflare resources. Reads `openchief.config.ts` for resource IDs and account ID.

### Flags

| Flag | Description |
|------|-------------|
| `--yes` | Skip confirmation prompts (for CI / scripting) |
| `--keep-config` | Don't delete `openchief.config.ts` after teardown |

### Teardown Order

Order matters — the router is a queue consumer and can't be deleted while the queue exists:

1. **Connector workers** — deletes `openchief-connector-{source}` for each enabled connector
2. **Dashboard worker** — `openchief-dashboard` (no queue dependency)
3. **Queue** — `npx wrangler queues delete openchief-events` (must happen before router)
4. **Router + Runtime workers** — now safe to delete after queue is gone
5. **Vectorize** — `npx wrangler vectorize delete openchief-agents --force` (only if configured)
6. **KV namespace** — `npx wrangler kv namespace delete --namespace-id {id}`
7. **D1 database** — `npx wrangler d1 delete openchief-db --skip-confirmation`
8. **Config file** — removes `openchief.config.ts` (unless `--keep-config`)

### Safety

- Two confirmation prompts by default (both default to "no")
- Skipped with `--yes` flag
- Graceful degradation: if a resource doesn't exist, logs a skip message and continues
- Workers deleted before resources so bindings don't block resource deletion
- Local mode (accountId = "local") skips all remote resource deletion
