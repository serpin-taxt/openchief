import type { ReportContent } from "@openchief/shared";

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
