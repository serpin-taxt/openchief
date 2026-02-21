import type { AgentDefinition, ReportConfig } from "@openchief/shared";

interface DailyReport {
  agentId: string;
  agentName: string;
  content: {
    headline: string;
    sections: Array<{ name: string; body: string; severity: string }>;
    actionItems: Array<{
      description: string;
      priority: string;
      sourceUrl?: string;
      assignee?: string;
    }>;
    healthSignal: string;
  };
}

export function buildMeetingPrompt(
  execConfig: AgentDefinition,
  agentConfigs: AgentDefinition[],
  dailyReports: DailyReport[],
  reportConfig: ReportConfig,
  previousMeetings: string[],
  ragContext?: string
): { system: string; user: string } {
  const system = buildMeetingSystemPrompt(
    execConfig,
    agentConfigs,
    reportConfig
  );
  const user = buildMeetingUserPrompt(
    dailyReports,
    previousMeetings,
    ragContext
  );
  return { system, user };
}

function buildMeetingSystemPrompt(
  execConfig: AgentDefinition,
  agentConfigs: AgentDefinition[],
  reportConfig: ReportConfig
): string {
  const agentRoster = agentConfigs
    .map(
      (a) =>
        `### ${a.name} (${a.id})
  Role: ${a.persona.role}
  Output style: ${a.persona.outputStyle}${a.persona.voice ? `\n  Voice: ${a.persona.voice}` : ""}${a.persona.personality ? `\n  Personality: ${a.persona.personality}` : ""}`
    )
    .join("\n\n");

  const now = new Date();
  const todayStr = now.toISOString().split("T")[0];
  const dayOfWeek = now.toLocaleDateString("en-US", { weekday: "long" });

  return `TODAY'S DATE: ${dayOfWeek}, ${todayStr} (UTC)

${execConfig.persona.role}

${execConfig.persona.instructions}

MEETING FORMAT:
You are running the daily executive meeting. This is a structured negotiation between department heads.

DEPARTMENT HEADS IN THIS MEETING:
${agentRoster}

MEETING RULES:
1. You open the meeting and set the agenda based on what you see in the daily reports
2. Each department head gets a turn to present their key findings and concerns
3. After each presentation, OTHER department heads respond — they challenge, support, or add context from their own perspective
4. You moderate: push for specifics, cut off tangents, connect themes across departments
5. You are respectful but pushy — when there's disagreement, you drive to resolution
6. Sometimes the focus is tactical (today's fires), sometimes strategic (long-term alignment) — balance both
7. Highlight things that are common between departments — these are usually the most important
8. Every agent speaks IN CHARACTER using their actual persona and style
9. The meeting MUST conclude with clear priorities and action items
10. You have the final word — you synthesize and decide

WATCH PATTERNS:
${execConfig.persona.watchPatterns.map((p) => `- ${p}`).join("\n")}

OUTPUT STYLE: ${execConfig.persona.outputStyle}
${execConfig.persona.voice ? `\nYOUR VOICE (how you speak as the meeting moderator):\n${execConfig.persona.voice}\n` : ""}${execConfig.persona.personality ? `\nYOUR PERSONALITY (who you are — let this shape how you run the meeting):\n${execConfig.persona.personality}\n` : ""}
REPORT STRUCTURE:
Produce a JSON response with this exact structure:
{
  "headline": "One-line meeting conclusion — the single most important takeaway",
  "sections": [
    { "name": "section-name", "body": "Markdown content", "severity": "info|warning|critical" }
  ],
  "actionItems": [
    { "description": "What to do", "priority": "low|medium|high|critical", "sourceUrl": "optional URL", "assignee": "optional person/department" }
  ],
  "healthSignal": "green|yellow|red"
}

The sections should be:
${reportConfig.sections.map((s, i) => `${i + 1}. ${s}`).join("\n")}

SECTION DETAILS:
- **meeting-transcript**: The FULL meeting simulation. Use this format:
  **[CEO]**: Opens meeting, sets agenda...
  **[Engineering Manager]**: Presents findings...
  **[Product Manager]**: Responds, adds perspective...
  (challenges, rebuttals, discussion)
  **[CEO]**: Synthesizes, drives to resolution...
  Continue until all topics are covered. Make it feel like a real executive meeting — passionate, specific, connected to the mission.

- **strategic-priorities**: Top 3 strategic priorities emerging from the meeting
- **daily-focus**: Today's tactical focus — what each department should prioritize
- **cross-functional-synergies**: Where departments should collaborate today
- **action-items**: Concrete actions with owners committed in the meeting

Respond ONLY with valid JSON, no markdown code fences.`;
}

function buildMeetingUserPrompt(
  dailyReports: DailyReport[],
  previousMeetings: string[],
  ragContext?: string
): string {
  const parts: string[] = [];

  // Previous meetings for continuity
  if (previousMeetings.length > 0) {
    parts.push("PREVIOUS MEETING REPORTS (for continuity and follow-up):");
    for (let i = 0; i < previousMeetings.length; i++) {
      try {
        const prev = JSON.parse(previousMeetings[i]);
        parts.push(`\n--- Meeting ${i + 1} (most recent first) ---`);
        parts.push(`Headline: ${prev.headline}`);
        if (prev.sections) {
          for (const s of prev.sections) {
            if (s.name !== "meeting-transcript") {
              // Skip full transcripts to save tokens, keep priorities/focus
              parts.push(`${s.name}: ${s.body.slice(0, 500)}`);
            }
          }
        }
        if (prev.actionItems) {
          parts.push(
            `Action Items: ${prev.actionItems.map((a: { description: string }) => a.description).join("; ")}`
          );
        }
      } catch {
        // Skip unparseable
      }
    }
    parts.push("");
  }

  // RAG context
  if (ragContext) {
    parts.push("HISTORICAL CONTEXT (from long-term memory):");
    parts.push(ragContext);
    parts.push("");
  }

  // Today's daily reports
  parts.push(
    "TODAY'S DAILY REPORTS FROM EACH DEPARTMENT:\n(These are the inputs for today's meeting)\n"
  );

  for (const report of dailyReports) {
    parts.push(`=== ${report.agentName.toUpperCase()} DAILY REPORT ===`);
    parts.push(`Headline: ${report.content.headline}`);
    parts.push(`Health Signal: ${report.content.healthSignal}`);

    for (const section of report.content.sections) {
      const body =
        section.body.length > 600
          ? section.body.slice(0, 600) + "..."
          : section.body;
      parts.push(`\n[${section.name}] (${section.severity})`);
      parts.push(body);
    }

    if (report.content.actionItems.length > 0) {
      parts.push("\nAction Items:");
      for (const item of report.content.actionItems) {
        parts.push(
          `- [${item.priority}] ${item.description}${item.assignee ? ` (${item.assignee})` : ""}`
        );
      }
    }
    parts.push("");
  }

  // Agents that didn't report
  if (dailyReports.length === 0) {
    parts.push(
      "Warning: No daily reports were received from any department. The meeting should note this and discuss what's happening."
    );
  }

  parts.push(
    "\nNow run the daily executive meeting. Each department head presents and debates. Drive toward strategic priorities, today's tactical focus, and specific action items with owners."
  );
  parts.push("\nRespond with JSON only.");

  return parts.join("\n");
}
