# OpenChief

**AI agents that passively watch your business tools and produce daily reports.**

OpenChief is a fleet of specialized AI agents that watch your connected data sources (GitHub, Slack, Discord, Intercom, etc.), synthesize what happened, and deliver structured daily and weekly reports — like having a team of analysts working around the clock.

Open-source. Serverless. Run locally or deploy to [Cloudflare Workers](https://workers.cloudflare.com/) (free tier).

## How It Works

```
Data Sources          Connectors         Event Router        Agent Runtime         Dashboard
┌──────────┐       ┌────────────┐      ┌────────────┐     ┌──────────────┐     ┌───────────┐
│  GitHub   │──────▶│  GitHub    │─────▶│            │────▶│ Eng Manager  │────▶│           │
│  Slack    │──────▶│  Slack     │─────▶│   Queue    │────▶│ Product Mgr  │────▶│  Reports  │
│  Discord  │──────▶│  Discord   │─────▶│     +      │────▶│ CEO / CFO    │────▶│  + Chat   │
│  Intercom │──────▶│  Intercom  │─────▶│  Identity  │────▶│ CISO / Legal │────▶│           │
│  Figma    │──────▶│  Figma     │─────▶│ Resolution │────▶│ Marketing    │────▶│           │
│  ...      │──────▶│  ...       │─────▶│            │────▶│ + 9 more     │────▶│           │
└──────────┘       └────────────┘      └────────────┘     └──────────────┘     └───────────┘
```

1. **Connectors** receive webhooks or poll APIs, normalize events into a common format
2. **Event Router** resolves identities across platforms and persists events to D1
3. **Agent Runtime** uses Durable Objects to run each agent on a schedule — feeding events to Claude and storing structured reports
4. **Dashboard** displays reports, health signals, and lets you chat with any agent

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 10+
- [Anthropic API key](https://console.anthropic.com/)
- [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier) — **only if deploying**, not needed for local dev

### Setup

**One-liner** (checks for prerequisites, clones, installs):

```bash
curl -fsSL https://raw.githubusercontent.com/serpin-taxt/openchief/main/install.sh | bash
```

**Or manually:**

```bash
git clone https://github.com/serpin-taxt/openchief.git
cd openchief
pnpm install
pnpm run setup
```

The interactive setup wizard asks how you want to run — **deploy to Cloudflare** or **local development** — and handles everything from there: org info, auth, database migrations, agent seeding, and config generation.

**To deploy to Cloudflare:**

```bash
pnpm run setup    # Select option 1: Deploy to Cloudflare
pnpm run deploy   # Build + deploy all workers
```

Your dashboard URL will be shown when the deploy completes. Open it, add your Anthropic API key, and connect your data sources.

**To run locally (no Cloudflare account needed):**

```bash
pnpm run setup    # Select option 2: Local development
pnpm dev          # Starts all workers locally
```

Dashboard at `http://localhost:5173`, runtime at `http://localhost:8787`. All data stays on your machine using local D1 (SQLite), local KV, and local queues — powered by `wrangler dev`.

### Authentication

When deploying to Cloudflare, the setup wizard lets you choose how to protect your dashboard:

| Mode | Description |
|------|-------------|
| **Admin password** (recommended) | Single password login — simple, no external dependencies. Set during setup via `wrangler secret put ADMIN_PASSWORD`. |
| **Cloudflare Access** | SSO via Cloudflare Zero Trust. Supports Google, GitHub, Okta, one-time PIN, and other identity providers. Free for up to 50 users. The deploy script shows setup steps. |
| **No auth** | Open access — for local development or VPN-protected environments. |

To change auth mode later, update `auth.provider` in `openchief.config.ts` and run `pnpm generate-config && pnpm run deploy`.

### Manual Setup

If you prefer to configure things by hand instead of using the setup wizard:

```bash
# Copy the example config
cp openchief.example.config.ts openchief.config.ts

# For local dev: set accountId to "local" and resource IDs to "local-placeholder"
# For Cloudflare deploy: create resources and fill in real IDs:
npx wrangler d1 create openchief-db
npx wrangler kv namespace create OPENCHIEF_KV
npx wrangler queues create openchief-events
npx wrangler vectorize create openchief-agents --dimensions 768 --metric cosine

# Then:
pnpm generate-config    # Write wrangler.jsonc files
pnpm seed               # Seed agents to D1
pnpm dev                # Local dev, or:
pnpm run deploy         # Deploy to Cloudflare
```

## Agents

OpenChief ships with 15 ready-to-use agents. All agents are seeded by default — enable or disable them from the dashboard.

| Agent | Watches | Focus |
|-------|---------|-------|
| **CEO** | All sources | Executive synthesis, cross-functional signals |
| **CFO** | QuickBooks + Slack | Burn rate, runway, budget utilization |
| **CPO** | Slack + GitHub | Team sentiment, hiring, onboarding |
| **CRO** | Amplitude + Slack | Revenue growth, conversion funnels |
| **CISO** | GitHub + Slack | Security vulnerabilities, compliance |
| **Engineering Manager** | GitHub + Slack | PRs, builds, shipping velocity |
| **Product Manager** | Slack + GitHub + Intercom | Customer signals, feature requests |
| **Design Manager** | Figma + Slack + GitHub | Design activity, review cycles |
| **Marketing Manager** | Twitter + Slack + Analytics | Brand presence, content strategy |
| **Customer Support** | Intercom + Slack | Support tickets, response times |
| **Community Manager** | Discord + Twitter + Slack | Community health, engagement |
| **Data Analyst** | Amplitude + Google Analytics | User behavior, growth metrics |
| **Head of BizDev** | Slack + CRM | Partnership pipeline, deal progress |
| **Legal Counsel** | Slack + GitHub | Compliance risks, legal issues |
| **Researcher** | Twitter + Slack | Industry trends, competitor moves |

### Create Your Own Agent

Agents are **data, not code** — just JSON files. Add one to `agents/` and run `pnpm seed`:

```json
{
  "id": "my-agent",
  "name": "My Custom Agent",
  "subscriptions": [
    { "source": "github", "eventTypes": ["pr.*", "build.*"] },
    { "source": "slack", "eventTypes": ["message.*"] }
  ],
  "persona": {
    "role": "What this agent does",
    "instructions": "Detailed instructions for report generation...",
    "watchPatterns": ["Things to flag"],
    "outputStyle": "Direct, data-first",
    "voice": "How it communicates",
    "personality": "Its character"
  },
  "outputs": {
    "reports": [
      { "reportType": "daily-standup", "cadence": "daily", "sections": ["..."] }
    ]
  },
  "tools": ["query_events"],
  "enabled": true
}
```

## Connectors

| Connector | Status | Events |
|-----------|--------|--------|
| **GitHub** | Full | `pr.*`, `review.*`, `build.*`, `issue.*`, `push.*` |
| **Slack** | Full | `message.*`, `thread.*`, `reaction.*` |
| Discord | Stub | `message.*`, `thread.*`, `reaction.*` |
| Jira | Stub | `issue.*`, `sprint.*` |
| Jira Product Discovery | Stub | `idea.*`, `insight.*` |
| Notion | Stub | `page.*`, `database.*` |
| Figma | Stub | `file.*`, `comment.*`, `library.*` |
| Intercom | Stub | `conversation.*`, `ticket.*` |
| Twitter/X | Stub | `tweet.*`, `mention.*` |
| Amplitude | Stub | `metrics.*`, `event.*` |
| Google Calendar | Stub | `calendar.*` |
| Google Analytics | Stub | `traffic.*`, `conversion.*` |
| QuickBooks | Stub | `invoice.*`, `payment.*`, `report.*` |
| Rippling | Stub | `employee.*`, `payroll.*` |

GitHub and Slack are fully implemented. Other connectors have the worker scaffolding in place and are ready to be built out.

## Architecture

pnpm monorepo powered by Turborepo. Runs locally via `wrangler dev` or deployed to Cloudflare's edge:

| Component | Technology | Purpose |
|-----------|-----------|---------|
| `packages/shared` | TypeScript | Core types, event matching, ULID generation |
| `workers/runtime` | Durable Objects + Vectorize + Workers AI | Per-agent state, report generation, chat, RAG |
| `workers/router` | Queue Consumer | Event routing and identity resolution |
| `workers/dashboard` | React + Tailwind v4 | Web UI for reports and agent management |
| `workers/connectors/*` | Workers | One worker per data source (14 connectors) |
| `migrations/` | D1 (SQLite) | 6 migration files |
| `agents/` | JSON configs | 15 agent definitions |

### Event Flow

```
Source (GitHub, Slack, etc.)
  → Connector Worker (normalize to OpenChiefEvent)
    → Cloudflare Queue (openchief-events)
      → Event Router (identity resolution, persist to D1)
        → Agent Durable Object (reads events at report time)
          → Vectorize retrieves historical context (RAG)
            → Claude generates structured report
              → Report stored in D1 + KV + Vectorize
```

### RAG (Long-Term Memory)

Agents have long-term memory powered by Cloudflare Vectorize and Workers AI. When RAG is enabled, every generated report is embedded and indexed. At report time and during chat, agents retrieve relevant historical context via semantic search, allowing them to reference past trends and incidents.

- **Embedding model:** `@cf/baai/bge-base-en-v1.5` (768 dimensions, runs on Workers AI)
- **Vector store:** Cloudflare Vectorize (`openchief-agents` index)
- **What's indexed:** Report headlines, report sections, event batches
- **Retrieval:** Top-10 similarity search filtered by agent ID (no cross-agent leakage)
- **Setup:** Created automatically by `pnpm run setup`, or manually with `npx wrangler vectorize create openchief-agents --dimensions 768 --metric cosine`
- **Optional:** RAG is disabled when `vectorizeIndexName` is not set in config. Agents still work without it, they just lack historical context.

To backfill existing reports into the vector index:

```bash
curl -X POST https://your-runtime.workers.dev/admin/backfill-vectorize
```

### Event Format

All data flows through a common event format:

```typescript
interface OpenChiefEvent {
  id: string;           // ULID
  timestamp: string;    // When it happened at the source
  ingestedAt: string;   // When OpenChief received it
  source: string;       // "github", "slack", etc.
  eventType: string;    // "pr.opened", "message.posted", etc.
  scope: {
    org?: string;
    project?: string;
    team?: string;
    actor?: string;
  };
  payload: Record<string, unknown>;
  summary: string;      // Human-readable summary
  tags?: string[];
}
```

## Commands

```bash
pnpm run setup          # Interactive setup wizard (local or Cloudflare)
pnpm dev                # Start local dev servers (no Cloudflare needed)
pnpm run deploy         # Build + deploy all workers to Cloudflare
pnpm run teardown       # Delete all deployed Cloudflare resources
pnpm build              # Build all packages
pnpm typecheck          # Type-check everything
pnpm seed               # Seed agent definitions to D1
pnpm generate-config    # Regenerate wrangler.jsonc files from config
```

## Project Structure

```
openchief/
├── packages/shared/          # @openchief/shared — types, matching, ULID
├── workers/
│   ├── runtime/              # Agent Durable Object runtime
│   ├── router/               # Event router (queue consumer)
│   ├── dashboard/            # React SPA + API worker
│   └── connectors/           # One worker per data source
│       ├── github/           # Full implementation
│       ├── slack/            # Full implementation
│       ├── discord/          # Stub
│       ├── jira/             # Stub
│       └── ...               # 10 more connector stubs
├── agents/                   # 15 agent JSON definitions
├── migrations/               # D1 SQL migration files
├── scripts/                  # setup, seed, deploy, teardown, generate-config
├── openchief.example.config.ts
├── turbo.json
└── pnpm-workspace.yaml
```

## Contributing

Contributions welcome! The two highest-impact areas:

### Adding a Connector

1. Create `workers/connectors/your-source/` (stubs already exist for most)
2. Implement webhook handling and/or polling
3. Normalize events to `OpenChiefEvent` format
4. Publish to the `openchief-events` queue
5. Submit a PR

### Adding an Agent

1. Create a JSON file in `agents/`
2. Define subscriptions, persona, and output config
3. Run `pnpm seed` to test
4. Submit a PR

## License

[MIT](LICENSE)
