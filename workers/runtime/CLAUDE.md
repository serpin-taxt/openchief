# workers/runtime — Agent Runtime

The core brain of OpenChief. This Cloudflare Worker hosts a Durable Object per agent that generates reports via Claude, handles chat interactions, and manages persistent agent state.

## Worker Info

- **Name**: `openchief-runtime`
- **Entry**: `src/index.ts`
- **Durable Object**: `AgentDurableObject` (one instance per agent)
- **Cron**: `55 13 * * 1-5` (weekdays, bootstraps alarm chain)
- **Bindings**: D1 (`DB`), KV (`KV`), `AGENT_DO` (DO namespace), `ANTHROPIC_API_KEY` (secret), `VECTORIZE` (optional), `AI` (optional)

## File Structure

```
src/
├── index.ts           # HTTP routes + cron handler
├── agent-do.ts        # Durable Object: inbox, reports, chat, alarm-driven report gen
├── claude-client.ts   # Simple Anthropic API wrapper
├── prompt-builder.ts  # System + user prompts for report generation
├── chat-prompt.ts     # System prompt for chat interactions
├── agent-tools.ts     # Data-driven tool registry + execution
├── rag.ts             # RAG: Vectorize indexing + retrieval (long-term memory)
└── report-parser.ts   # Parse Claude JSON → ReportContent
```

## HTTP Routes (`index.ts`)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/` or `/health` | Health check |
| POST | `/trigger/:agentId/:reportType` | Manually trigger a report. Optional `?asOf=YYYY-MM-DD` for backfill |
| POST | `/chat/:agentId` | SSE streaming chat. Body: `{ message, userEmail?, userName? }` |
| GET | `/chat/:agentId/history` | Chat history. Query: `?email=USER_EMAIL` |
| POST | `/admin/backfill-vectorize` | Index all existing D1 reports into Vectorize |

### Cron Handler

Runs daily on weekdays. For each enabled agent in D1, calls `ensureAlarm()` on its Durable Object to bootstrap the alarm chain. This ensures agents run reports even if no events arrive.

## Agent Durable Object (`agent-do.ts`)

Each agent gets its own Durable Object instance with persistent SQLite storage.

### Local SQLite Tables

| Table | Purpose |
|-------|---------|
| `inbox` | Incoming events (with `processed` flag) |
| `local_reports` | Cached recent reports (fast local access) |
| `reasoning_log` | Token usage tracking (input/output tokens per report) |
| `chat_messages` | Conversation history per user (role, content, timestamp, user_email) |

### Key Methods

**`ensureAlarm(agentId)`**
- Called by cron to bootstrap the alarm chain
- Sets next alarm if none is pending

**`alarm()`**
- Fires when alarm triggers
- Determines report type: `pending_alarm_type` or defaults to daily
- Calls `generateReport()` for the appropriate report config
- Schedules next alarm

**`triggerReport(reportType, agentId, asOf?)`**
- Manual report trigger (called from HTTP route)
- `asOf` allows backfilling historical dates

**`generateReport(reportConfig, config, asOf?)`**
Core report generation flow:
1. Query D1 for events matching agent subscriptions (lookback: 48-72h daily, 8 days weekly)
2. Load last 3 reports for trend comparison
3. Load identity mappings (KV-cached, 1hr TTL)
4. Retrieve historical context from Vectorize (RAG, if configured)
5. Build prompt via `buildPrompt()` (includes RAG context)
6. Call Claude via `callClaude()`
7. Parse response via `parseReportContent()`
8. Store report in: local SQLite → D1 → KV (1hr TTL) → Vectorize (async)
9. Log token usage to `reasoning_log`

**`chat(userMessage, userEmail, userName, agentId)`**
Returns SSE `ReadableStream`:
1. Load recent reports (3) + chat history (last 50 messages)
2. Resolve user name from identity mappings
3. Save user message to SQLite
4. Run `chatWithToolLoop()` (max 10 rounds of tool use)
5. Stream SSE events: `delta` (text), `tool_status`, `error`, `done`

**`chatWithToolLoop()`**
Agentic tool-use loop:
- Fetches model settings from D1 (`model_settings` table)
- Default: claude-sonnet-4-6, 8192 max tokens
- If Claude requests tool use → execute tool → push result → loop
- Max 10 rounds to prevent runaway
- Saves final assistant message to SQLite

### Event Querying

**`queryEventsFromD1()`**
Builds dynamic WHERE clause from agent subscriptions:
- Source: exact match
- Event types: `*` (any), `prefix.*` (LIKE), or exact match
- Scope filters: AND logic for org/project/team
- Lookback window: daily 48-72h (skip weekends), weekly 8 days
- Orders by timestamp DESC

### Model Settings

**`getModelSettings()`**
Defaults (overridable via D1 `model_settings` table):

| Job Type | Model | Max Tokens |
|----------|-------|------------|
| daily-report | claude-sonnet-4-6 | 8192 |
| weekly-report | claude-sonnet-4-6 | 8192 |
| chat | claude-sonnet-4-6 | 8192 |

## Claude Client (`claude-client.ts`)

Simple wrapper around the Anthropic Messages API.

```typescript
callClaude(
  apiKey: string,
  systemPrompt: string,
  messages: Array<{ role: "user" | "assistant", content: string }>,
  model?: string,      // default: "claude-sonnet-4-6"
  maxTokens?: number   // default: 8192
): Promise<{ text: string, inputTokens: number, outputTokens: number }>
```

- POST to `https://api.anthropic.com/v1/messages`
- Sanitizes Unicode (removes lone surrogates that would cause API errors)
- Returns extracted text + token usage

## Prompt Builder (`prompt-builder.ts`)

Builds the system + user prompt for **report generation**.

```typescript
buildPrompt(config, reportConfig, events, recentReports, ragContext, identities)
  → { system: string, user: string }
```

### System Prompt Includes:
1. Agent persona (role, instructions, watchPatterns, outputStyle, voice, personality)
2. Team member directory (display name, GitHub handle, role, team) — humans and bots separated
3. Required JSON output format (headline, sections, actionItems, healthSignal)
4. Analysis guidelines:
   - Be specific (names, numbers, links)
   - Cross-reference across sources
   - Don't double-count PRs (opened in one period, merged in another)
   - Track PR lifecycle (time to first review, merge time)
   - Note absence of expected activity
   - Flag tool_use blocks in chat for proactive tools

### User Prompt Includes:
1. Events grouped by category:
   - Pull Requests, Code Reviews, Comments, CI/CD Builds, Issues, Commits
   - Messages (Slack/Discord), Support (Intercom), Finance, Calendar
2. Aggregates (PR counts by action, review counts by state, CI pass/fail, message volume)
3. Historical context (RAG — optional retrieved context)
4. Previous reports (last 3 — for trend comparison)

**`groupEventsByCategory()`** — Maps event type prefixes to categories
**`extractPayloadDetail()`** — Extracts rich detail from Slack text, tweets, enriched tweets
**`buildTeamLists()`** — Formats identity mappings as bullet list
**`computeAggregates()`** — Summary statistics across all events

## Chat Prompt Builder (`chat-prompt.ts`)

Builds the system prompt for **chat interactions** (different from reports).

```typescript
buildChatSystemPrompt(config, recentReports, userName, ragContext, identities)
  → string
```

### Includes:
1. Agent identity (name, role, user greeting, today's date)
2. Full persona (instructions, watchPatterns, outputStyle, voice, personality)
3. Recent reports (headline, health signal, action items)
4. Historical context (RAG)
5. Data source descriptions (generic descriptions of each subscribed source)
6. Available tool descriptions
7. Team directory
8. Chat guidelines (be conversational, cite data, stay in role)

**`SOURCE_DESCRIPTIONS`** — Map of source names to plain-English descriptions of what data comes from each source
**`TOOL_DESCRIPTIONS`** — Map of tool names to descriptions of what each tool does

## Agent Tools (`agent-tools.ts`)

Data-driven tool system. Agents declare which tools they can use in their `tools` array.

### Tool Registry

```typescript
const ALL_TOOLS: Record<string, ToolDefinition> = {
  query_events: { ... },   // SQL against events table
  github_file: { ... },    // Fetch file/directory from GitHub
  github_search: { ... },  // Code search in GitHub repo
}
```

### Tool: `query_events`
- Runs read-only SQL against D1 events table
- Schema exposed to Claude: `events(id, timestamp, ingested_at, source, event_type, scope_org, scope_project, scope_team, scope_actor, summary, payload, tags)`
- Validation: SELECT/WITH only, no dangerous keywords (INSERT, UPDATE, DELETE, DROP, ALTER, CREATE)
- LIMIT required (enforced)
- Output: formatted markdown table, 100 rows max, 15KB truncation

### Tool: `github_file`
- Fetches file content or directory listing from configured GitHub repo
- Parameters: `path` (required), `ref` (optional, default: "main")
- Directory path → returns listing with file/folder icons + sizes
- File path → returns base64-decoded content (20KB truncation)
- Uses GitHub App installation token for auth

### Tool: `github_search`
- Code search in configured GitHub repo
- Parameter: `query` (search string, e.g., "function handleAuth")
- Returns up to 10 results with file path + code snippets
- Uses GitHub REST API code search

### Execution Flow

```typescript
getAgentTools(toolNames: string[]): ToolDefinition[]  // Filter ALL_TOOLS by agent config
executeTool(name, input, env): Promise<{ content: string, is_error?: boolean }>
```

## RAG Module (`rag.ts`)

Gives agents long-term memory via Cloudflare Vectorize + Workers AI embeddings. All functions accept a minimal `Env` of `{ VECTORIZE: VectorizeIndex, AI: Ai }` so they can be called from both the DO and the main worker.

### Embedding

- **Model**: `@cf/baai/bge-base-en-v1.5` (768-dimensional vectors)
- **Batching**: `embedTexts()` batches up to ~100 texts per Workers AI call
- **Truncation**: Text capped at 2,000 chars per vector

### Exported Functions

**`indexReport(env, agentId, report)`**
- Creates one vector per report headline (headline + action items)
- Creates one vector per report section (headline + section name + body)
- Upserts in batches of 100 (Vectorize limit)
- Called via `ctx.waitUntil()` from `agent-do.ts` — non-blocking

**`indexEvents(env, agentId, events)`**
- Groups ~20 event summaries per vector (keeps index manageable)
- Each batch: `[timestamp] eventType: summary` joined by newlines
- Not currently wired up (available for future use)

**`retrieveContext(env, agentId, query, topK=10)`**
- Embeds query → Vectorize similarity search filtered by `agentId`
- Returns formatted markdown block: `HISTORICAL CONTEXT (from long-term memory):\n...`
- Returns empty string on error or no matches (graceful degradation)
- Called from `agent-do.ts` before building report and chat prompts

**`backfillReports(env)`**
- Reads all reports from D1 and indexes them into Vectorize
- Returns `{ indexed: number, errors: number }`
- Called from `POST /admin/backfill-vectorize` endpoint

### Vector Metadata Schema

| Type | Fields |
|------|--------|
| `report-headline` | agentId, reportId, reportType, createdAt, health |
| `report-section` | agentId, reportId, reportType, createdAt, sectionName, severity |
| `event-batch` | agentId, startDate, endDate, eventCount |

### Integration Pattern

RAG bindings are optional (`VECTORIZE?: VectorizeIndex`, `AI?: Ai`). All integration points guard with:
```typescript
if (this.env.VECTORIZE && this.env.AI) { ... }
```
This means RAG is a zero-config optional feature — agents work identically without it.

## Report Parser (`report-parser.ts`)

Parses Claude's raw text response into typed `ReportContent`.

```typescript
parseReportContent(raw: string): ReportContent
```

1. Strips markdown code fences (` ```json...``` `)
2. Parses JSON
3. Validates required fields (headline, sections array)
4. Falls back: wraps raw text in a single "raw-output" section if parse fails

## Wrangler Config

```jsonc
{
  "name": "openchief-runtime",
  "main": "src/index.ts",
  "durable_objects": {
    "bindings": [{ "name": "AGENT_DO", "class_name": "AgentDurableObject" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["AgentDurableObject"] }],
  "d1_databases": [{ "binding": "DB", "database_name": "openchief-db" }],
  "kv_namespaces": [{ "binding": "KV" }],
  "triggers": { "crons": ["55 13 * * 1-5"] },
  // RAG bindings (added by generate-config when vectorizeIndexName is set)
  "vectorize": [{ "binding": "VECTORIZE", "index_name": "openchief-agents" }],
  "ai": { "binding": "AI" }
  // Secrets: ANTHROPIC_API_KEY
}
```

## Key Design Decisions

1. **Alarm chain, not cron per agent** — Cron bootstraps alarms; each DO manages its own schedule
2. **3-tier storage** — Local SQLite (fast), D1 (durable), KV (cached latest)
3. **Weekend-aware lookback** — Daily reports on Monday look back to Friday (72h)
4. **Identity-enriched prompts** — Team directory injected so Claude knows who's who
5. **Token tracking** — Every report logs input/output tokens for cost monitoring
6. **Tool-use loop capped at 10** — Prevents runaway agent behavior in chat
7. **Model settings in D1** — Users can change models per job type without redeploying
8. **RAG is optional** — VECTORIZE/AI bindings are optional; all RAG code checks before use and fails gracefully
9. **Non-blocking indexing** — Report vectors are upserted via `ctx.waitUntil()` so report generation latency is unaffected
