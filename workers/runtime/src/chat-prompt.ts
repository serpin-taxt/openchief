import type { AgentDefinition } from "@openchief/shared";
import type { IdentityInfo, OrgInfo } from "./prompt-builder";

/**
 * Source descriptions — generic, no company-specific references.
 */
const SOURCE_DESCRIPTIONS: Record<string, string> = {
  github:
    "GitHub: Pull requests, code reviews, issues, CI/CD builds, commits. " +
    "Tracks engineering velocity, code quality, and shipping progress.",
  slack:
    "Slack: Team messages and threads from connected channels. " +
    "Captures internal discussions, decisions, blockers, and sentiment.",
  discord:
    "Discord: Community messages, threads, and reactions. " +
    "Tracks community engagement, sentiment, support questions, and growth.",
  jira:
    "Jira: Issues, sprints, epics, and project tracking. " +
    "Monitors project progress, blockers, and team workload.",
  notion:
    "Notion: Pages, databases, and wiki updates. " +
    "Tracks documentation changes, meeting notes, and knowledge base evolution.",
  figma:
    "Figma: File edits, comments, library publishes, and design reviews. " +
    "Monitors design activity, collaboration, and design system health.",
  intercom:
    "Intercom: Customer conversations, tickets, and support metrics. " +
    "Tracks support volume, response times, customer pain points, and satisfaction.",
  twitter:
    "Twitter/X: Tweets mentioning your brand, competitor activity, and industry trends. " +
    "Monitors public sentiment, engagement, and market positioning.",
  amplitude:
    "Amplitude: Product analytics — DAU/WAU/MAU, feature adoption, retention curves, funnels. " +
    "Provides quantitative user behavior data.",
  "google-calendar":
    "Google Calendar: Team meetings, availability, and scheduling patterns. " +
    "Tracks meeting load and time allocation.",
  "google-analytics":
    "Google Analytics: Website traffic, acquisition channels, page views, and conversion metrics. " +
    "Monitors top-of-funnel marketing performance.",
  quickbooks:
    "QuickBooks: Invoices, payments, bills, P&L reports, and balance sheets. " +
    "Provides financial data for revenue, expenses, and cash flow analysis.",
};

/**
 * Tool descriptions — generic, config-driven.
 */
const TOOL_DESCRIPTIONS: Record<string, string> = {
  query_events:
    "query_events: Run read-only SQL queries against the events database. " +
    "Useful for counting events, finding patterns, or answering data questions. " +
    'Example: SELECT source, event_type, COUNT(*) FROM events GROUP BY source, event_type ORDER BY COUNT(*) DESC LIMIT 20',
  github_file:
    "github_file: Fetch files or directories from the configured GitHub repository. " +
    "Useful for reading code, configs, or documentation. " +
    'Provide { "path": "src/index.ts" } or { "path": "src/" } for directory listing.',
  github_search:
    "github_search: Search for code in the configured GitHub repository. " +
    'Provide { "query": "function handleAuth" } to find matching code.',
  query_database:
    "query_database: Run read-only SQL queries against the production database replica. " +
    "Useful for answering questions about live data, user counts, etc. " +
    "Only SELECT/WITH/EXPLAIN queries are allowed.",
};

/**
 * Build the system prompt for chat interactions.
 */
export function buildChatSystemPrompt(
  config: AgentDefinition,
  recentReports: Array<{
    reportType: string;
    content: string;
    createdAt: string;
  }>,
  userName: string,
  ragContext: string | null,
  identities: IdentityInfo[],
  org?: OrgInfo
): string {
  const parts: string[] = [];

  const tz = org?.timezone || "UTC";
  const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: tz });

  // Identity
  parts.push(`You are ${config.name}, ${config.persona.role}.`);
  if (org?.orgName) {
    parts.push(`You work for ${org.orgName}${org.orgContext ? ` — ${org.orgContext}` : ""}.`);
  }
  parts.push(`You're chatting with ${userName}.`);
  parts.push(`Today is ${dateStr}.`);

  // Persona
  parts.push(`\n═══ YOUR INSTRUCTIONS ═══\n${config.persona.instructions}`);
  if (config.persona.watchPatterns.length > 0) {
    parts.push(
      `\n═══ WATCH PATTERNS ═══\n${config.persona.watchPatterns.map((w) => `• ${w}`).join("\n")}`
    );
  }
  parts.push(`\n═══ OUTPUT STYLE ═══\n${config.persona.outputStyle}`);
  if (config.persona.voice) {
    parts.push(`\n═══ VOICE ═══\n${config.persona.voice}`);
  }
  if (config.persona.personality) {
    parts.push(`\n═══ PERSONALITY ═══\n${config.persona.personality}`);
  }

  // Recent reports
  if (recentReports.length > 0) {
    parts.push("\n═══ YOUR RECENT REPORTS ═══");
    for (const report of recentReports) {
      const date = new Date(report.createdAt).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      parts.push(`[${report.reportType} — ${date}]`);
      try {
        const parsed = JSON.parse(report.content);
        parts.push(`Headline: ${parsed.headline || "N/A"}`);
        parts.push(`Health: ${parsed.healthSignal || "N/A"}`);
        if (parsed.actionItems?.length > 0) {
          parts.push(
            `Action items: ${parsed.actionItems.map((a: { description: string }) => a.description).join("; ")}`
          );
        }
      } catch {
        parts.push(report.content.slice(0, 500));
      }
    }
  }

  // Long-term memory / RAG
  if (ragContext) {
    parts.push(`\n═══ HISTORICAL CONTEXT ═══\n${ragContext}`);
  }

  // Data sources
  parts.push("\n═══ YOUR DATA SOURCES ═══");
  parts.push(buildDataSourcesBlock(config));

  // Available tools
  if (config.tools && config.tools.length > 0) {
    parts.push("\n═══ AVAILABLE TOOLS ═══");
    for (const toolName of config.tools) {
      const desc = TOOL_DESCRIPTIONS[toolName];
      if (desc) parts.push(desc);
    }
  }

  // Team directory
  const teamBlock = buildTeamDirectoryBlock(identities);
  if (teamBlock) {
    parts.push(`\n═══ TEAM DIRECTORY ═══\n${teamBlock}`);
  }

  // Chat guidelines
  parts.push(`
═══ CHAT GUIDELINES ═══
- Stay in character as ${config.name}.
- Be concise but thorough. Use your reports and data to back up claims.
- If you don't know something, say so — don't fabricate.
- When using tools, explain what you're looking for and share findings.
- Use markdown formatting for readability.`);

  return parts.join("\n");
}

/**
 * Build a description of this agent's subscribed data sources.
 */
function buildDataSourcesBlock(config: AgentDefinition): string {
  const sources = new Set(config.subscriptions.map((s) => s.source));
  const lines: string[] = [];

  for (const source of sources) {
    const desc = SOURCE_DESCRIPTIONS[source];
    if (desc) {
      const subs = config.subscriptions.filter((s) => s.source === source);
      const eventTypes = subs.flatMap((s) => s.eventTypes).join(", ");
      lines.push(`${desc}\n  Subscribed event types: ${eventTypes}`);
    } else {
      lines.push(`${source}: Connected data source`);
    }
  }

  return lines.join("\n\n") || "No data sources configured.";
}

/**
 * Build a team directory block from identity mappings.
 */
function buildTeamDirectoryBlock(identities: IdentityInfo[]): string | null {
  const humans = identities.filter((i) => !i.is_bot);
  if (humans.length === 0) return null;

  return humans
    .map((i) => {
      const name = i.display_name || i.real_name;
      const parts = [name];
      if (i.github_username) parts.push(`GitHub: @${i.github_username}`);
      if (i.team) parts.push(`Team: ${i.team}`);
      if (i.role) parts.push(`Role: ${i.role}`);
      return `• ${parts.join(" | ")}`;
    })
    .join("\n");
}
