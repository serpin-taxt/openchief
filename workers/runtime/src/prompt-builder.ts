import type { AgentDefinition, ReportConfig } from "@openchief/shared";

export interface IdentityInfo {
  github_username: string | null;
  slack_user_id: string | null;
  email: string | null;
  real_name: string;
  display_name: string | null;
  team: string | null;
  role: string | null;
  is_bot: boolean;
}

interface EventRow {
  timestamp: string;
  source: string;
  event_type: string;
  summary: string;
  payload: string;
}

interface Prompt {
  system: string;
  user: string;
}

export interface OrgInfo {
  orgName?: string;
  orgContext?: string;
  timezone?: string;
}

/**
 * Build the system + user prompt for report generation.
 */
export interface PendingTask {
  title: string;
  assignedTo: string | null;
  status: string;
}

export function buildPrompt(
  config: AgentDefinition,
  reportConfig: ReportConfig,
  events: EventRow[],
  recentReports: string[],
  ragContext: string | null,
  identities: IdentityInfo[],
  org?: OrgInfo,
  pendingTasks?: PendingTask[]
): Prompt {
  const system = buildSystemPrompt(config, reportConfig, identities, org);
  const user = buildUserPrompt(events, recentReports, ragContext, pendingTasks);
  return { system, user };
}

function buildSystemPrompt(
  config: AgentDefinition,
  reportConfig: ReportConfig,
  identities: IdentityInfo[],
  org?: OrgInfo
): string {
  const today = new Date();
  const tz = org?.timezone || "UTC";
  const dayOfWeek = today.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  const dateStr = today.toLocaleDateString("en-CA", { timeZone: tz }); // YYYY-MM-DD format

  const { teamMembers, bots } = buildTeamLists(identities);

  const orgBlock = org?.orgName
    ? `\n═══ ORGANIZATION ═══\n${org.orgName}${org.orgContext ? `: ${org.orgContext}` : ""}\n`
    : "";

  return `You are ${config.persona.role}.

Today is ${dayOfWeek}, ${dateStr}.
${orgBlock}

═══ YOUR PERSONA ═══
${config.persona.instructions}

═══ WATCH PATTERNS ═══
Flag or escalate if you observe:
${config.persona.watchPatterns.map((w) => `• ${w}`).join("\n")}

═══ OUTPUT STYLE ═══
${config.persona.outputStyle}
${config.persona.voice ? `\n═══ VOICE ═══\n${config.persona.voice}` : ""}
${config.persona.personality ? `\n═══ PERSONALITY ═══\n${config.persona.personality}` : ""}

═══ TEAM MEMBERS ═══
These are real team members. Use first names when referring to people:
${teamMembers.length > 0 ? teamMembers.join("\n") : "No team members configured yet."}
${bots.length > 0 ? `\nKnown bots (exclude from people counts): ${bots.join(", ")}` : ""}

═══ REPORT STRUCTURE ═══
You must output ONLY valid JSON matching this exact shape:
{
  "headline": "One-line summary of the day (be specific, cite numbers)",
  "sections": [
    ${reportConfig.sections.map((s) => `{ "name": "${s}", "body": "Markdown analysis", "severity": "info|warning|critical" }`).join(",\n    ")}
  ],
  "actionItems": [
    { "description": "What needs attention", "priority": "low|medium|high|critical", "sourceUrl": "optional link", "assignee": "optional person" }
  ],
  "taskProposals": [
    { "title": "Short task title", "description": "What the task involves and expected deliverable", "assignTo": "agent-id to assign (e.g. eng-manager, marketing-manager)", "priority": "low|medium|high|critical", "context": { "reasoning": "Why this task is needed based on today's data" } }
  ],
  "healthSignal": "green|yellow|red"
}

═══ TASK PROPOSALS ═══
If your analysis reveals work that an agent could do autonomously — writing blog posts, researching competitors, analyzing trends, drafting documentation, building reports — propose up to 2 tasks. Be selective: only propose tasks when there's a clear, high-value need based on today's data. Do NOT propose tasks just because you can. Each task should:
- Have a concrete, achievable deliverable
- Be assigned to the most appropriate agent by their ID
- Include reasoning tied to specific events or patterns you observed
- Not duplicate any pending tasks listed below

═══ ANALYSIS GUIDELINES ═══
1. Be specific — cite PR numbers, exact metrics, names.
2. Cross-reference events to build a narrative (e.g., PR opened → reviewed → merged is one story, not three).
3. Don't double-count: a PR that was merged should not also appear as "open" or "blocked."
4. For PRs: track lifecycle (opened → reviewed → merged/closed). A merged PR is done, not pending.
5. Use the team member list to attribute work to real names.
6. Compare against previous reports when available to identify trends.
7. If there are few events, say so honestly rather than padding the report.
8. Health signal: green = on track, yellow = some concerns, red = urgent issues.

═══ OUTPUT CONSTRAINTS ═══
CRITICAL: Keep your TOTAL JSON output under 4000 tokens. Each section body should be 2-4 concise paragraphs max. Prioritize the most important insights rather than covering everything. Use bullet points sparingly. Do NOT repeat the same information across sections.`;
}

function buildUserPrompt(
  events: EventRow[],
  recentReports: string[],
  ragContext: string | null,
  pendingTasks?: PendingTask[]
): string {
  const parts: string[] = [];

  // Event data — apply character budget to prevent context window overflow.
  // Events arrive sorted chronologically (oldest first). We keep the most
  // recent events by scanning backwards from the end until the budget is full,
  // then render in chronological order.
  if (events.length > 0) {
    const trimmed = trimEventsToCharBudget(events);
    const grouped = groupEventsByCategory(trimmed.events);
    parts.push("═══ EVENTS ═══");
    for (const [category, catEvents] of Object.entries(grouped)) {
      parts.push(`\n--- ${category.toUpperCase()} (${catEvents.length} events) ---`);
      for (const evt of catEvents) {
        const detail = extractPayloadDetail(evt);
        parts.push(`[${evt.timestamp}] ${evt.summary}${detail ? `\n${detail}` : ""}`);
      }
    }
    if (trimmed.truncatedCount > 0) {
      parts.push(`\n[${trimmed.truncatedCount} older events omitted — context budget reached]`);
    }
  } else {
    parts.push("═══ NO EVENTS ═══\nNo matching events in this time window.");
  }

  // Pre-computed aggregates
  if (events.length > 0) {
    parts.push("\n═══ AGGREGATES ═══");
    parts.push(computeAggregates(events));
  }

  // Historical context from RAG
  if (ragContext) {
    parts.push(`\n═══ HISTORICAL CONTEXT ═══\n${ragContext}`);
  }

  // Recent reports for comparison — cap each to prevent context overflow
  if (recentReports.length > 0) {
    parts.push("\n═══ PREVIOUS REPORTS (for trend comparison) ═══");
    for (const report of recentReports) {
      if (report.length > MAX_RECENT_REPORT_CHARS) {
        parts.push(
          report.slice(0, MAX_RECENT_REPORT_CHARS) +
            `\n[... truncated — ${report.length - MAX_RECENT_REPORT_CHARS} chars omitted]`
        );
      } else {
        parts.push(report);
      }
    }
  }

  // Pending tasks — so the agent doesn't propose duplicates
  if (pendingTasks && pendingTasks.length > 0) {
    parts.push("\n═══ PENDING TASKS (do not duplicate these) ═══");
    for (const task of pendingTasks) {
      parts.push(`- [${task.status}] ${task.title}${task.assignedTo ? ` (assigned to ${task.assignedTo})` : ""}`);
    }
  }

  parts.push("\n\nAnalyze the above data and produce the JSON report.");

  return parts.join("\n");
}

/**
 * Group events by high-level category for readability.
 */
function groupEventsByCategory(
  events: EventRow[]
): Record<string, EventRow[]> {
  const groups: Record<string, EventRow[]> = {};

  for (const evt of events) {
    let category: string;
    const type = evt.event_type;

    if (type.startsWith("pr.")) category = "Pull Requests";
    else if (type.startsWith("review.")) category = "Code Reviews";
    else if (type.startsWith("comment.")) category = "Comments";
    else if (type.startsWith("build.") || type.startsWith("ci.")) category = "CI/CD";
    else if (type.startsWith("issue.")) category = "Issues";
    else if (type.startsWith("push.")) category = "Commits";
    else if (type.startsWith("message.") || type.startsWith("thread.")) category = "Messages";
    else if (type.startsWith("conversation.") || type.startsWith("ticket.")) category = "Support";
    else if (type.startsWith("invoice.") || type.startsWith("payment.") || type.startsWith("bill.")) category = "Finance";
    else if (type.startsWith("calendar.")) category = "Calendar";
    else category = evt.source;

    if (!groups[category]) groups[category] = [];
    groups[category].push(evt);
  }

  return groups;
}

/**
 * Extract full text content from event payload for richer context.
 */
function extractPayloadDetail(evt: EventRow): string | null {
  try {
    const payload = JSON.parse(evt.payload);

    // Slack messages — include the full text
    if (evt.source === "slack" && payload.text) {
      return `  Text: ${(payload.text as string).slice(0, 500)}`;
    }

    // Twitter/X — include tweet text
    if (evt.source === "twitter" && payload.text) {
      return `  Tweet: ${(payload.text as string).slice(0, 500)}`;
    }

    // Enriched tweets in Slack messages
    if (payload._enrichedTweets && Array.isArray(payload._enrichedTweets)) {
      const tweets = payload._enrichedTweets as Array<{
        author_username?: string;
        text: string;
      }>;
      return tweets
        .map(
          (t) =>
            `  [Tweet by @${t.author_username || "unknown"}]: ${t.text.slice(0, 300)}`
        )
        .join("\n");
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Build team member descriptions from identity mappings.
 */
function buildTeamLists(identities: IdentityInfo[]): {
  teamMembers: string[];
  bots: string[];
} {
  const teamMembers: string[] = [];
  const bots: string[] = [];

  for (const identity of identities) {
    if (identity.is_bot) {
      bots.push(identity.display_name || identity.real_name);
      continue;
    }

    const name = identity.display_name || identity.real_name;
    const firstName = name.split(" ")[0];
    const parts = [firstName];

    if (identity.github_username) {
      parts.push(`(GitHub: @${identity.github_username})`);
    }
    if (identity.role) {
      parts.push(`— ${identity.role}`);
    }
    if (identity.team) {
      parts.push(`[${identity.team}]`);
    }

    teamMembers.push(`• ${parts.join(" ")}`);
  }

  return { teamMembers, bots };
}

/**
 * Pre-compute aggregates for Claude — saves it from counting manually.
 */
function computeAggregates(events: EventRow[]): string {
  const lines: string[] = [];

  // PR stats
  const prEvents = events.filter((e) => e.event_type.startsWith("pr."));
  if (prEvents.length > 0) {
    const byAction: Record<string, number> = {};
    for (const e of prEvents) {
      const action = e.event_type.split(".")[1] || "other";
      byAction[action] = (byAction[action] || 0) + 1;
    }
    lines.push(
      `PRs: ${Object.entries(byAction).map(([a, c]) => `${c} ${a}`).join(", ")}`
    );
  }

  // Review stats
  const reviewEvents = events.filter((e) =>
    e.event_type.startsWith("review.")
  );
  if (reviewEvents.length > 0) {
    const byState: Record<string, number> = {};
    for (const e of reviewEvents) {
      const state = e.event_type.split(".")[1] || "other";
      byState[state] = (byState[state] || 0) + 1;
    }
    lines.push(
      `Reviews: ${Object.entries(byState).map(([s, c]) => `${c} ${s}`).join(", ")}`
    );
  }

  // Build stats
  const buildEvents = events.filter(
    (e) => e.event_type.startsWith("build.") || e.event_type.startsWith("ci.")
  );
  if (buildEvents.length > 0) {
    const success = buildEvents.filter(
      (e) => e.event_type.includes("success") || e.event_type.includes("passed")
    ).length;
    const failed = buildEvents.filter(
      (e) => e.event_type.includes("fail") || e.event_type.includes("error")
    ).length;
    lines.push(`CI/CD: ${success} passed, ${failed} failed out of ${buildEvents.length} total`);
  }

  // Message volume by source
  const messageEvents = events.filter(
    (e) =>
      e.event_type.startsWith("message.") ||
      e.event_type.startsWith("thread.")
  );
  if (messageEvents.length > 0) {
    const bySource: Record<string, number> = {};
    for (const e of messageEvents) {
      bySource[e.source] = (bySource[e.source] || 0) + 1;
    }
    lines.push(
      `Messages: ${Object.entries(bySource).map(([s, c]) => `${c} from ${s}`).join(", ")}`
    );
  }

  return lines.join("\n") || "No aggregate data to compute.";
}

/**
 * Character budget for the events section of the prompt.
 *
 * Claude's context window is 200K tokens. Technical content (GitHub events,
 * code snippets, PR descriptions) encodes at ~2.8 chars/token — much denser
 * than prose text. We budget conservatively:
 *
 *   - System prompt + team list:  ~15K chars  (~5K tokens)
 *   - Aggregates:                  ~1K chars
 *   - RAG context:                 ~3K chars
 *   - Recent reports (capped):    ~18K chars  (~6K tokens for 3 × 6K reports)
 *   - Pending tasks:               ~1K chars
 *   - Output budget:              ~16K chars  (~4K tokens reserved for output)
 *   - Safety margin:              ~46K chars
 *
 * Events budget: 300K chars → ~107K tokens.
 * Total estimated: ~128K tokens (well under 200K limit).
 */
const MAX_EVENT_CHARS = 300_000;

/**
 * Character budget per recent report (3 reports × 6K chars = 18K total).
 * Prevents large historical reports from blowing up the context window.
 */
const MAX_RECENT_REPORT_CHARS = 6_000;

/**
 * Trim events to fit within the character budget, keeping the most recent.
 *
 * Events are expected in chronological order (oldest first). We scan backwards
 * from the newest event, accumulating rendered character sizes until the budget
 * is exhausted, then return the included events in their original order.
 */
function trimEventsToCharBudget(events: EventRow[]): {
  events: EventRow[];
  truncatedCount: number;
} {
  if (events.length === 0) return { events, truncatedCount: 0 };

  // Pre-compute rendered size for each event (mirrors the rendering loop above)
  const sizes = events.map((evt) => {
    const detail = extractPayloadDetail(evt);
    return `[${evt.timestamp}] ${evt.summary}${detail ? `\n${detail}` : ""}`.length;
  });

  // Scan from newest (end) to oldest (start), accumulating until budget is hit
  let remaining = MAX_EVENT_CHARS;
  let startIdx = events.length;
  for (let i = events.length - 1; i >= 0; i--) {
    if (remaining - sizes[i] < 0) break;
    remaining -= sizes[i];
    startIdx = i;
  }

  return {
    events: events.slice(startIdx),
    truncatedCount: startIdx,
  };
}
