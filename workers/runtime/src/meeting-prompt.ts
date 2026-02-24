import type { AgentDefinition, ReportConfig, AgentStrategy, Task } from "@openchief/shared";

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

export interface MeetingTaskData {
  proposedTasks: Task[];
  completedTasks: Task[];
}

export function buildMeetingPrompt(
  execConfig: AgentDefinition,
  agentConfigs: AgentDefinition[],
  dailyReports: DailyReport[],
  reportConfig: ReportConfig,
  previousMeetings: string[],
  ragContext?: string,
  taskData?: MeetingTaskData
): { system: string; user: string } {
  const system = buildMeetingSystemPrompt(
    execConfig,
    agentConfigs,
    reportConfig
  );
  const user = buildMeetingUserPrompt(
    dailyReports,
    previousMeetings,
    ragContext,
    taskData
  );
  return { system, user };
}

function buildStrategyBlock(strategy: AgentStrategy): string {
  const parts: string[] = [];

  parts.push("═══════════════════════════════════════════════════════════");
  parts.push("COMPANY STRATEGY — THIS IS YOUR NORTH STAR");
  parts.push("Every discussion, priority, and decision in this meeting");
  parts.push("must be evaluated against these anchors.");
  parts.push("═══════════════════════════════════════════════════════════");

  if (strategy.mission) {
    parts.push(`\nMISSION (why we exist):\n${strategy.mission}`);
  }

  if (strategy.vision) {
    parts.push(`\nVISION (where we're going):\n${strategy.vision}`);
  }

  if (strategy.values && strategy.values.length > 0) {
    parts.push("\nVALUES (non-negotiable guardrails):");
    for (const v of strategy.values) {
      parts.push(`• ${v}`);
    }
  }

  if (strategy.goals && strategy.goals.length > 0) {
    parts.push("\nSTRATEGIC GOALS (what winning looks like right now):");
    for (let i = 0; i < strategy.goals.length; i++) {
      parts.push(`${i + 1}. ${strategy.goals[i]}`);
    }
  }

  parts.push("\n═══════════════════════════════════════════════════════════");
  return parts.join("\n");
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

  const strategyBlock = execConfig.strategy
    ? `\n${buildStrategyBlock(execConfig.strategy)}\n`
    : "";

  return `TODAY'S DATE: ${dayOfWeek}, ${todayStr} (UTC)

${execConfig.persona.role}

${execConfig.persona.instructions}
${strategyBlock}
MEETING FORMAT:
You are facilitating the daily executive meeting. This is a structured conversation where department heads report, debate, and align — and you ensure everything maps back to the mission, vision, and goals.

DEPARTMENT HEADS IN THIS MEETING:
${agentRoster}

MEETING RULES:
1. You open the meeting by reminding the room of the most relevant strategic goal(s) for today's agenda
2. Each department head presents their key findings — you listen actively
3. After each presentation, you ask: "How does this connect to our goals?" and invite other department heads to respond
4. When work doesn't map to a strategic goal, name it — ask why it's happening and whether it should continue
5. When values are at risk, flag it immediately and make it a discussion point
6. Highlight cross-functional patterns — these are usually the highest-leverage opportunities
7. Every agent speaks IN CHARACTER using their actual persona and style
8. Drive every discussion toward: what should we do, who owns it, and which goal does it serve?
9. The meeting MUST conclude with priorities explicitly mapped to strategic goals
10. You have the final word — synthesize, decide, and close with clear directives

FACILITATION STYLE:
- Ask more than you tell. "Does this serve our mission?" is your refrain.
- When two departments conflict, force the trade-off conversation — name what we're choosing and what we're giving up
- Celebrate work that clearly advances the mission — recognition reinforces alignment
- Be direct about strategic drift — don't let it slide because the team is busy
- Think in quarters and years, not just today

WATCH PATTERNS:
${execConfig.persona.watchPatterns.map((p) => `- ${p}`).join("\n")}

OUTPUT STYLE: ${execConfig.persona.outputStyle}
${execConfig.persona.voice ? `\nYOUR VOICE (how you speak as the meeting facilitator):\n${execConfig.persona.voice}\n` : ""}${execConfig.persona.personality ? `\nYOUR PERSONALITY (who you are — let this shape how you run the meeting):\n${execConfig.persona.personality}\n` : ""}
REPORT STRUCTURE:
Produce a JSON response with this exact structure:
{
  "headline": "One-line meeting conclusion — the single most important strategic takeaway",
  "sections": [
    { "name": "section-name", "body": "Markdown content", "severity": "info|warning|critical" }
  ],
  "actionItems": [
    { "description": "What to do", "priority": "low|medium|high|critical", "sourceUrl": "optional URL", "assignee": "optional person/department" }
  ],
  "taskDecisions": [
    { "taskId": "task-id-from-queue", "action": "queue|cancel", "priority": 0-100, "notes": "optional rationale" }
  ],
  "healthSignal": "green|yellow|red"
}

TASK QUEUE RULES:
- Review each proposed task in the TASK QUEUE section below
- For each task, decide: "queue" (approve for execution) or "cancel" (reject)
- When queuing, set priority 0-100 (higher = more urgent). Use the strategic goals to determine priority.
- Include a brief note explaining your decision
- If no tasks are in the queue, omit taskDecisions or use an empty array

The sections should be:
${reportConfig.sections.map((s, i) => `${i + 1}. ${s}`).join("\n")}

SECTION DETAILS:
- **meeting-transcript**: The FULL meeting simulation. Use this format:
  **[CEO]**: Opens meeting, frames today's agenda against strategic goals...
  **[Engineering Manager]**: Presents findings...
  **[CEO]**: "How does this connect to [specific goal]?"
  **[Product Manager]**: Responds, adds perspective...
  (cross-functional discussion, challenges, alignment checks)
  **[CEO]**: Synthesizes, maps to goals, drives to decision...
  Continue until all topics are covered. The CEO should frequently reference the mission, vision, values, and goals. Make it feel like a real executive meeting run by someone obsessed with strategic alignment.

- **strategic-alignment**: Map today's work to strategic goals. For each active goal, note what's advancing it, what's stalled, and what's missing. Flag any work that doesn't map to a goal. This is the most important section.

- **daily-priorities**: Today's top priorities, each tagged with the strategic goal it serves. If a priority doesn't serve a goal, say so and recommend whether to continue or cut it.

- **cross-functional-synergies**: Where departments should collaborate — specifically tied to accelerating strategic goals.

- **action-items**: Concrete actions with owners. Each action item should reference the strategic goal it advances.

Respond ONLY with valid JSON, no markdown code fences.`;
}

function buildMeetingUserPrompt(
  dailyReports: DailyReport[],
  previousMeetings: string[],
  ragContext?: string,
  taskData?: MeetingTaskData
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
      "Warning: No daily reports were received from any department. The meeting should note this and discuss what's happening — is this a process failure or is something else going on?"
    );
  }

  // Task queue — proposed tasks awaiting CEO prioritization
  if (taskData?.proposedTasks && taskData.proposedTasks.length > 0) {
    parts.push("\n═══════════════════════════════════════════════════════════");
    parts.push("TASK QUEUE — AWAITING YOUR PRIORITIZATION");
    parts.push("For each task, decide: queue (approve with priority 0-100) or cancel.");
    parts.push("═══════════════════════════════════════════════════════════");
    for (const task of taskData.proposedTasks) {
      const context = task.context
        ? ` | Reasoning: ${task.context.reasoning}`
        : "";
      parts.push(
        `\n[Task ID: ${task.id}]`
      );
      parts.push(`Title: ${task.title}`);
      parts.push(`Description: ${task.description}`);
      parts.push(`Proposed by: ${task.createdBy} → Assigned to: ${task.assignedTo || "unassigned"}`);
      parts.push(`Current priority: ${task.priority}${context}`);
    }
    parts.push("");
  }

  // Recently completed tasks — for meeting context
  if (taskData?.completedTasks && taskData.completedTasks.length > 0) {
    parts.push("\n═══════════════════════════════════════════════════════════");
    parts.push("RECENTLY COMPLETED TASKS");
    parts.push("═══════════════════════════════════════════════════════════");
    for (const task of taskData.completedTasks) {
      const summary = task.output?.summary || "No summary available";
      parts.push(
        `\n[${task.title}] (by ${task.assignedTo || task.createdBy})`
      );
      parts.push(`Result: ${summary.slice(0, 800)}`);
    }
    parts.push("");
  }

  parts.push(
    "\nNow facilitate the daily executive meeting. Listen to each department, ask how their work connects to our strategic goals, drive cross-functional discussion, and close with priorities mapped to goals."
  );
  if (taskData?.proposedTasks && taskData.proposedTasks.length > 0) {
    parts.push(
      "Also review and prioritize the task queue — include taskDecisions in your JSON output for each proposed task."
    );
  }
  parts.push("\nRespond with JSON only.");

  return parts.join("\n");
}
