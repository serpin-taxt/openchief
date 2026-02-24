import type { ReportContent, TaskProposal, TaskDecision } from "@openchief/shared";

/**
 * Attempt to repair truncated JSON by closing open strings, arrays, and objects.
 */
function repairTruncatedJson(json: string): string {
  let repaired = json.trim();

  // If we're inside a string value, close it
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < repaired.length; i++) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (repaired[i] === "\\") {
      escapeNext = true;
      continue;
    }
    if (repaired[i] === '"') {
      inString = !inString;
    }
  }
  if (inString) {
    repaired += '"';
  }

  // Count open brackets and braces, close them
  const stack: string[] = [];
  inString = false;
  escapeNext = false;
  for (let i = 0; i < repaired.length; i++) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (repaired[i] === "\\") {
      escapeNext = true;
      continue;
    }
    if (repaired[i] === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (repaired[i] === "{") stack.push("}");
    else if (repaired[i] === "[") stack.push("]");
    else if (repaired[i] === "}" || repaired[i] === "]") stack.pop();
  }

  // Remove any trailing comma before closing
  repaired = repaired.replace(/,\s*$/, "");

  // Close all open brackets/braces
  while (stack.length > 0) {
    repaired += stack.pop();
  }

  return repaired;
}

/**
 * Parse Claude's JSON response into a typed ReportContent.
 * Handles markdown code fences, truncated JSON, and validates required fields.
 */
export function parseReportContent(raw: string): ReportContent {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  cleaned = cleaned.trim();

  // First attempt: parse as-is
  let parsed: { headline?: string; sections?: unknown[]; actionItems?: unknown[]; healthSignal?: string } | null = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Second attempt: repair truncated JSON
    try {
      const repaired = repairTruncatedJson(cleaned);
      parsed = JSON.parse(repaired);
    } catch (err) {
      console.error("Failed to parse report JSON (even after repair):", err);
    }
  }

  if (parsed && parsed.headline && Array.isArray(parsed.sections)) {
    return {
      headline: parsed.headline,
      sections: parsed.sections as ReportContent["sections"],
      actionItems: (parsed.actionItems || []) as ReportContent["actionItems"],
      healthSignal: (parsed.healthSignal as ReportContent["healthSignal"]) || "yellow",
    };
  }

  // Fallback: wrap the raw text as a single section
  console.error("Report parsing failed — using raw fallback");
  return {
    headline: "Report generated (parsing error)",
    sections: [
      {
        name: "raw-output",
        body: raw.slice(0, 5000),
        severity: "info",
      },
    ],
    actionItems: [],
    healthSignal: "yellow",
  };
}

/**
 * Extract task proposals from Claude's JSON response.
 * Returns [] on any failure — task proposals are optional.
 */
export function parseTaskProposals(raw: string): TaskProposal[] {
  try {
    // Strip markdown code fences if present
    let cleaned = raw.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    let parsed: { taskProposals?: unknown[] } | null = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      try {
        parsed = JSON.parse(repairTruncatedJson(cleaned));
      } catch {
        return [];
      }
    }

    if (!parsed?.taskProposals || !Array.isArray(parsed.taskProposals)) {
      return [];
    }

    const proposals: TaskProposal[] = [];
    for (const raw of parsed.taskProposals) {
      const item = raw as Record<string, unknown>;
      if (
        typeof item.title === "string" &&
        typeof item.description === "string" &&
        typeof item.assignTo === "string"
      ) {
        const context = item.context as { reasoning?: string; relevantUrls?: string[] } | undefined;
        proposals.push({
          title: item.title.slice(0, 200),
          description: item.description.slice(0, 2000),
          assignTo: item.assignTo,
          priority: (["low", "medium", "high", "critical"].includes(item.priority as string)
            ? item.priority
            : "medium") as TaskProposal["priority"],
          context: {
            reasoning: context?.reasoning || "Proposed during report generation",
            relevantUrls: context?.relevantUrls,
          },
        });
      }
    }

    return proposals.slice(0, 5); // Cap at 5 per report
  } catch {
    return [];
  }
}

/**
 * Extract task decisions from CEO meeting JSON response.
 * Returns [] on any failure — task decisions are optional.
 */
export function parseTaskDecisions(raw: string): TaskDecision[] {
  try {
    let cleaned = raw.trim();
    if (cleaned.startsWith("```json")) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith("```")) cleaned = cleaned.slice(3);
    if (cleaned.endsWith("```")) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    let parsed: { taskDecisions?: unknown[] } | null = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      try {
        parsed = JSON.parse(repairTruncatedJson(cleaned));
      } catch {
        return [];
      }
    }

    if (!parsed?.taskDecisions || !Array.isArray(parsed.taskDecisions)) {
      return [];
    }

    const decisions: TaskDecision[] = [];
    for (const raw of parsed.taskDecisions) {
      const item = raw as Record<string, unknown>;
      if (
        typeof item.taskId === "string" &&
        typeof item.action === "string" &&
        (item.action === "queue" || item.action === "cancel")
      ) {
        decisions.push({
          taskId: item.taskId,
          action: item.action,
          priority: typeof item.priority === "number" ? item.priority : 50,
          notes: typeof item.notes === "string" ? item.notes : undefined,
        });
      }
    }

    return decisions;
  } catch {
    return [];
  }
}
