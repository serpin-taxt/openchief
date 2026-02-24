import type { AgentDefinition, Task } from "@openchief/shared";
import type { IdentityInfo, OrgInfo } from "./prompt-builder";

/**
 * Build the system + user prompt for autonomous task execution.
 */
export function buildTaskExecutionPrompt(
  config: AgentDefinition,
  task: Task,
  identities: IdentityInfo[],
  ragContext: string | null,
  org?: OrgInfo
): { system: string; user: string } {
  const system = buildTaskSystemPrompt(config, identities, org);
  const user = buildTaskUserPrompt(task, ragContext);
  return { system, user };
}

function buildTaskSystemPrompt(
  config: AgentDefinition,
  identities: IdentityInfo[],
  org?: OrgInfo
): string {
  const today = new Date();
  const tz = org?.timezone || "UTC";
  const dayOfWeek = today.toLocaleDateString("en-US", { weekday: "long", timeZone: tz });
  const dateStr = today.toLocaleDateString("en-CA", { timeZone: tz });

  const orgBlock = org?.orgName
    ? `\nORGANIZATION: ${org.orgName}${org.orgContext ? ` — ${org.orgContext}` : ""}\n`
    : "";

  // Build team list for context
  const teamList = identities
    .filter((i) => !i.is_bot)
    .map((i) => {
      const name = i.display_name || i.real_name;
      const parts = [name];
      if (i.role) parts.push(`(${i.role})`);
      if (i.team) parts.push(`[${i.team}]`);
      return `• ${parts.join(" ")}`;
    })
    .slice(0, 20);

  return `You are ${config.persona.role}.

Today is ${dayOfWeek}, ${dateStr}.
${orgBlock}
═══ YOUR PERSONA ═══
${config.persona.instructions}

═══ OUTPUT STYLE ═══
${config.persona.outputStyle}
${config.persona.voice ? `\n═══ VOICE ═══\n${config.persona.voice}` : ""}
${config.persona.personality ? `\n═══ PERSONALITY ═══\n${config.persona.personality}` : ""}

═══ TEAM MEMBERS ═══
${teamList.length > 0 ? teamList.join("\n") : "No team members configured."}

═══ TASK EXECUTION ═══
You have been assigned a task to complete autonomously. Produce a thorough, high-quality deliverable.

Your output MUST be valid JSON matching this exact shape:
{
  "summary": "One-line summary of what you produced",
  "content": "Full markdown deliverable — this is the main output. Be thorough and detailed.",
  "artifacts": [
    { "name": "artifact-name", "type": "markdown|json|csv|text", "content": "Full artifact content" }
  ]
}

GUIDELINES:
1. Focus on producing a complete, actionable deliverable — not a plan to do it later.
2. Use your persona and expertise to produce high-quality work.
3. Reference specific data, names, and details when available.
4. Artifacts are optional — use them for structured data, code, or documents that benefit from being separate.
5. Keep the summary concise (one line). Put the substance in the content field.
6. Write in markdown format for the content field.

Respond ONLY with valid JSON.`;
}

function buildTaskUserPrompt(
  task: Task,
  ragContext: string | null
): string {
  const parts: string[] = [];

  parts.push("═══ YOUR ASSIGNED TASK ═══");
  parts.push(`Title: ${task.title}`);
  parts.push(`Description: ${task.description}`);
  parts.push(`Priority: ${task.priority}/100`);

  if (task.context) {
    parts.push(`\nReasoning: ${task.context.reasoning}`);
    if (task.context.relevantUrls && task.context.relevantUrls.length > 0) {
      parts.push("Relevant links:");
      for (const url of task.context.relevantUrls) {
        parts.push(`- ${url}`);
      }
    }
  }

  if (ragContext) {
    parts.push(`\n═══ HISTORICAL CONTEXT ═══\n${ragContext}`);
  }

  parts.push("\n\nComplete this task now. Produce the JSON deliverable.");

  return parts.join("\n");
}
