import type { ReportContent } from "@openchief/shared";

/**
 * Parse Claude's JSON response into a typed ReportContent.
 * Handles markdown code fences and validates required fields.
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

  try {
    const parsed = JSON.parse(cleaned);

    // Validate required fields
    if (!parsed.headline || !Array.isArray(parsed.sections)) {
      throw new Error("Missing required fields");
    }

    return {
      headline: parsed.headline,
      sections: parsed.sections || [],
      actionItems: parsed.actionItems || [],
      healthSignal: parsed.healthSignal || "yellow",
    };
  } catch (err) {
    console.error("Failed to parse report JSON:", err);

    // Fallback: wrap the raw text as a single section
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
}
