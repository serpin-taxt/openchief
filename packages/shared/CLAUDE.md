# @openchief/shared

Core types, utilities, and event matching logic shared across all OpenChief workers. This is the only internal package — every worker depends on it.

## Package Info

- **Name**: `@openchief/shared`
- **Type**: ES module
- **Exports**: `dist/index.js` (compiled from `src/index.ts`)
- **Build**: `tsc` — no bundling, just TypeScript compilation to `dist/`

## File Structure

```
src/
├── index.ts              # Re-exports everything from types/ and utils/
├── types/
│   ├── event.ts          # OpenChiefEvent, EventScope
│   ├── agent.ts          # AgentDefinition, EventSubscription, AgentPersona, ReportConfig
│   ├── report.ts         # AgentReport, ReportContent, ReportSection, ActionItem
│   ├── revision.ts       # AgentRevision
│   └── config.ts         # OpenChiefConfig
└── utils/
    ├── ulid.ts           # generateULID() — time-sortable unique IDs
    └── matching.ts       # Event subscription matching (wildcard, scope filters)
```

## Types

### OpenChiefEvent (`types/event.ts`)

The canonical event format. Every connector normalizes raw source data into this shape before publishing to the queue.

```typescript
interface OpenChiefEvent {
  id: string;              // ULID — lexicographically sortable by time
  timestamp: string;       // ISO-8601 when event occurred at the source
  ingestedAt: string;      // ISO-8601 when the connector ingested it
  source: string;          // "github", "slack", "discord", etc.
  eventType: string;       // Dot notation: "pr.opened", "message.posted"
  scope: EventScope;       // Routing metadata (org, project, team, actor)
  payload: Record<string, unknown>;  // Raw/normalized source payload
  summary: string;         // Human-readable 1-3 sentence summary
  tags?: string[];         // Cross-cutting labels: "urgent", "security", "build-failure"
}

interface EventScope {
  org?: string;            // Organization/workspace (e.g., "mycompany")
  project?: string;        // Repo, channel, or project (e.g., "myorg/myrepo", "#general")
  team?: string;           // Team identifier
  actor?: string;          // Who triggered the event (resolved to display name by router)
}
```

### AgentDefinition (`types/agent.ts`)

The JSON schema for agent configs stored in `agents/` and D1.

```typescript
interface AgentDefinition {
  id: string;              // Unique kebab-case ID: "eng-manager"
  name: string;            // Display name: "Engineering Manager"
  description: string;     // What this agent watches and does
  subscriptions: EventSubscription[];  // Which events this agent receives
  persona: AgentPersona;   // Claude's identity and instructions
  outputs: AgentOutputConfig;  // Report configurations
  enabled: boolean;        // Whether the agent generates reports
  tools?: string[];        // Tool access: ["query_events", "github_file"]
  visibility?: "public" | "exec";  // Access control level
  allowedEmails?: string[];  // For "exec" visibility only
}

interface EventSubscription {
  source: string;          // Exact match: "github", "slack"
  eventTypes: string[];    // Wildcard patterns: "pr.*", "message.*", "*"
  scopeFilter?: {          // Optional AND-logic scope narrowing
    org?: string;
    project?: string;
    team?: string;
  };
}

interface AgentPersona {
  role: string;            // System prompt identity: "Engineering Manager responsible for..."
  instructions: string;    // Detailed analysis guidelines (Markdown)
  watchPatterns: string[]; // Things to flag: "PRs open > 48 hours"
  outputStyle: string;     // Output tone: "Direct and data-driven"
  voice?: string;          // How the agent communicates
  personality?: string;    // Temperament and values
}

interface ReportConfig {
  reportType: string;      // "daily-standup", "weekly-summary"
  cadence: "daily" | "weekly";
  sections: string[];      // Section names: ["shipping-progress", "blockers"]
}
```

### ReportContent (`types/report.ts`)

The structured output format Claude produces for each report.

```typescript
interface AgentReport {
  id: string;              // ULID
  agentId: string;
  reportType: string;
  content: ReportContent;
  eventCount: number;
  createdAt: string;
}

interface ReportContent {
  headline: string;        // One-line summary
  sections: ReportSection[];
  actionItems: ActionItem[];
  healthSignal: "green" | "yellow" | "red";
}

interface ReportSection {
  name: string;            // Matches section from ReportConfig
  body: string;            // Markdown content
  severity: "info" | "warning" | "critical";
}

interface ActionItem {
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  sourceUrl?: string;
  assignee?: string;
}
```

### AgentRevision (`types/revision.ts`)

Tracks every change to an agent config.

```typescript
interface AgentRevision {
  id: string;              // ULID
  agentId: string;
  config: AgentDefinition; // Full snapshot at that point in time
  changedBy: string;       // Email of the person who changed it
  changeNote: string;      // What changed and why
  createdAt: string;
}
```

### OpenChiefConfig (`types/config.ts`)

The user's instance configuration (from `openchief.config.ts`).

```typescript
interface OpenChiefConfig {
  instance: {
    name: string;          // Display name for the dashboard
    orgName: string;       // Company/org name
    context: string;       // Injected into all agent prompts as company context
  };
  cloudflare: {
    accountId: string;
    d1DatabaseId: string;
    kvNamespaceId: string;
    queueName: string;     // Default: "openchief-events"
  };
  runtime: {
    defaultModel: string;  // Default: "claude-sonnet-4-6"
    reportTimezone: string; // e.g., "America/Chicago"
    reportTimeUtcHour: number; // 0-23, when daily reports run
  };
  auth: {
    provider: "none" | "cloudflare-access";
    teamDomain?: string;
  };
  github?: { repo: string; };  // "owner/repo"
  connectors: { [key: string]: { enabled: boolean } };
}
```

## Utilities

### ULID Generation (`utils/ulid.ts`)

```typescript
generateULID(): string
```

- 26-character string: 10 time chars + 16 random chars
- Crockford's Base32 encoding: `0123456789ABCDEFGHJKMNPQRSTVWXYZ`
- Lexicographically sortable by creation time
- Used for: event IDs, report IDs, revision IDs, subscription IDs

### Event Matching (`utils/matching.ts`)

Three exported functions for routing events to agents:

```typescript
// Does a single event type match a subscription pattern?
matchesEventType(eventType: string, pattern: string): boolean
// "*"       → matches everything
// "pr.*"    → matches "pr.opened", "pr.merged" (prefix + ".")
// "pr.opened" → exact match only

// Does an event match a single subscription?
matchesSubscription(event: OpenChiefEvent, sub: EventSubscription): boolean
// All three must be true:
// 1. event.source === sub.source (exact)
// 2. At least one sub.eventTypes pattern matches event.eventType
// 3. If scopeFilter exists, ALL specified fields match (AND logic)

// Which agents should receive this event?
findMatchingAgents(
  event: OpenChiefEvent,
  subscriptionsByAgent: Map<string, EventSubscription[]>
): string[]
// Returns agentIds whose subscriptions match the event
```

## How It's Used

- **Router**: Uses `matchesSubscription()` and `findMatchingAgents()` to route events
- **Runtime**: Uses types for report generation, tool responses, and prompt building
- **Dashboard**: Uses types for API request/response shapes
- **Connectors**: Use `OpenChiefEvent` and `generateULID()` to create normalized events
- **Scripts**: Use types for config validation and agent seeding

## Build

```bash
cd packages/shared
npx tsc           # Compile to dist/
```

Output goes to `dist/` — other workspace packages reference `@openchief/shared` and resolve via pnpm workspace protocol.
