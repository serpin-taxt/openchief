# agents/ — Agent Definitions

Agent definitions are **data, not code**. Each JSON file in this directory defines an AI agent's identity, what data it watches, and what reports it produces. The seed script (`pnpm seed`) reads all `.json` files from this directory and inserts them into D1.

## Agent Definition Schema

Every agent JSON file must have these fields:

```typescript
{
  // Identity
  "id": string,           // Unique kebab-case ID (matches filename without .json)
  "name": string,          // Human-readable display name
  "description": string,   // What this agent watches and does (shown in dashboard)

  // Data Sources
  "subscriptions": [       // Which events this agent receives
    {
      "source": string,        // Must match a connector source: "github", "slack", etc.
      "eventTypes": string[],  // Wildcard patterns: "pr.*", "message.*", "*"
      "scopeFilter"?: {        // Optional narrowing (AND logic)
        "org"?: string,
        "project"?: string,
        "team"?: string
      }
    }
  ],

  // Claude's Identity
  "persona": {
    "role": string,            // System prompt identity (1 sentence)
    "instructions": string,    // Detailed analysis guidelines (Markdown, can be long)
    "watchPatterns": string[], // Specific things to flag/escalate
    "outputStyle": string,     // How to format and tone the output
    "voice"?: string,          // Communication style and vocabulary
    "personality"?: string     // Temperament, values, quirks
  },

  // Report Configuration
  "outputs": {
    "reports": [
      {
        "reportType": string,    // Unique type ID: "daily-standup", "weekly-summary"
        "cadence": "daily" | "weekly",
        "sections": string[]     // Section names Claude must include
      }
    ]
  },

  // Capabilities
  "enabled": boolean,          // Whether the agent actively generates reports
  "tools"?: string[]           // Optional: ["query_events", "github_file", "github_search"]
}
```

## Available Tools

| Tool | What It Does | Who Uses It |
|------|-------------|-------------|
| `query_events` | Read-only SQL queries against the D1 events table | Most agents with analytical needs |
| `github_file` | Fetch file content or directory listings from the configured GitHub repo | eng-manager, ciso |
| `github_search` | Search code in the configured GitHub repo | eng-manager, ciso |

Agents without a tool in their `tools` array cannot use it — access is enforced at runtime.

## Available Sources

These are the connector source strings that can appear in subscriptions:

| Source | Event Type Examples |
|--------|-------------------|
| `github` | `pr.*`, `review.*`, `comment.*`, `build.*`, `push.*`, `issue.*` |
| `slack` | `message.*`, `thread.*`, `reaction.*`, `channel.*`, `member.*` |
| `discord` | `message.*` |
| `figma` | `file.*`, `comment.*` |
| `amplitude` | `metrics.*`, `event.*`, `report.*` |
| `google-analytics` | `traffic.*`, `conversion.*` |
| `google-calendar` | `event.*`, `meeting.*` |
| `intercom` | `conversation.*`, `ticket.*` |
| `notion` | `page.*`, `database.*` |
| `jira` | `issue.*`, `sprint.*` |
| `jira-product-discovery` | `idea.*`, `insight.*` |
| `twitter` | `tweet.*`, `mention.*` |
| `quickbooks` | `transaction.*`, `invoice.*` |
| `rippling` | `employee.*`, `payroll.*` |

## All 15 Agents

### Executive / C-Suite

| Agent | ID | Watches | Key Focus | Reports |
|-------|----|---------|-----------|---------|
| CEO | `ceo` | None (aggregates) | Cross-functional synthesis, strategy, execution | daily-meeting |
| CFO | `cfo` | Slack, Rippling | Burn rate, runway, budget, headcount costs | daily-finance-pulse, weekly-finance-review |
| CISO | `ciso` | GitHub, Slack | Vulnerabilities, secrets, CI/CD security, incidents | daily-security-brief, weekly-security-review |
| CPO | `cpo` | Slack, Rippling | Team sentiment, hiring, onboarding, culture | daily-people-pulse, weekly-people-review |
| CRO | `cro` | Slack, Twitter, GA, Amplitude | Revenue, conversions, go-to-market | daily-revenue-pulse, weekly-growth-review |

### Functional Leads

| Agent | ID | Watches | Key Focus | Reports |
|-------|----|---------|-----------|---------|
| Engineering Manager | `eng-manager` | GitHub, Slack, Jira, JPD | PR velocity, code quality, blockers, team health | daily-standup, weekly-summary |
| Product Manager | `product-manager` | Slack, GitHub, Intercom, Discord, Amplitude, Notion, Jira, JPD | Customer voice, shipping, product signals | daily-product-pulse, weekly-product-review |
| Design Manager | `design-manager` | Figma, Slack, GitHub | Design velocity, collaboration, design system | daily-design-digest, weekly-design-review |
| Data Analyst | `data-analyst` | Amplitude, GA, Slack, Discord | Growth, engagement, retention, conversion | daily-metrics-brief, weekly-analytics-review |
| Customer Support | `customer-support` | Intercom, Slack | Ticket trends, response times, pain points | daily-support-digest, weekly-support-review |
| Community Manager | `community-manager` | Discord, Twitter, Slack | Engagement, sentiment, community growth | daily-community-pulse, weekly-community-review |
| Marketing Manager | `marketing-manager` | Slack, Discord, Twitter, GA | Brand, content, growth marketing, community | daily-marketing-pulse, weekly-marketing-review |

### Specialists

| Agent | ID | Watches | Key Focus | Reports |
|-------|----|---------|-----------|---------|
| Head of BD | `bizdev` | Slack, Twitter, Notion | Partnerships, deals, integration opportunities | daily-bd-pulse, weekly-bd-review |
| Legal Counsel | `legal-counsel` | Slack | Compliance, contracts, IP, privacy, employment law | daily-legal-scan, weekly-legal-review |
| Researcher | `researcher` | Twitter, Slack | Industry trends, competitors, market signals | daily-intelligence-brief, weekly-research-digest |

## How to Create a New Agent

1. Create `agents/<id>.json` following the schema above
2. Choose subscriptions matching your data sources
3. Write a detailed persona with clear instructions, watch patterns, and voice
4. Define reports with appropriate cadence and sections
5. Run `pnpm seed` to insert into D1
6. Add an icon mapping in `workers/dashboard/src/components/AppSidebar.tsx`:
   ```typescript
   const agentIconMap: Record<string, ComponentType<LucideProps>> = {
     "your-agent": YourIcon,
   }
   ```

## How Seeding Works

`scripts/seed-agents.ts`:
1. Reads ALL `.json` files from `agents/` directory
2. For each file:
   - `INSERT OR REPLACE INTO agent_definitions` (id, name, description, config JSON, enabled)
   - `INSERT OR REPLACE INTO agent_subscriptions` for each subscription
   - `INSERT OR REPLACE INTO agent_revisions` (initial seed revision)
3. Uses `wrangler d1 execute` with `--local` flag
4. No code changes needed — just add the JSON file and seed

## Persona Writing Guidelines

- **role**: One sentence defining the agent's identity and responsibility. This goes at the top of the system prompt.
- **instructions**: Multi-paragraph Markdown. Be specific about priorities, frameworks, and what to look for. Use numbered lists and bold headers.
- **watchPatterns**: Concrete, measurable patterns that should trigger alerts. E.g., "PRs open for more than 48 hours without review".
- **outputStyle**: How the output should be formatted and toned. E.g., "Data-first narrative. Lead with the headline metric."
- **voice**: How the agent speaks. E.g., "Direct and concise. Uses engineering jargon naturally."
- **personality**: The agent's temperament. E.g., "Protective of developer time. Gets frustrated by unnecessary meetings."

These fields are all injected into Claude's system prompt, so they directly shape the agent's behavior and output quality.
