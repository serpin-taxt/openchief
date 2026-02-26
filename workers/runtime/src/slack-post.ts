import type { ReportContent } from "@openchief/shared";

/**
 * Post a message to a Slack channel using chat.postMessage.
 */
export async function postToSlack(
  token: string,
  channel: string,
  text: string,
  threadTs?: string
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const body: Record<string, string> = {
    channel,
    text,
  };
  if (threadTs) {
    body.thread_ts = threadTs;
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const result = (await response.json()) as {
    ok: boolean;
    ts?: string;
    error?: string;
  };

  if (!result.ok) {
    console.error(`Slack postMessage error: ${result.error}`);
  }

  return result;
}

/**
 * Format a meeting report as a Slack summary message.
 * Returns the main message and a transcript for the thread.
 */
export function formatMeetingForSlack(
  content: ReportContent,
  reportId: string
): { summary: string; transcript: string | null } {
  const parts: string[] = [];

  // Header
  const healthEmoji =
    content.healthSignal === "green"
      ? ":large_green_circle:"
      : content.healthSignal === "yellow"
        ? ":large_yellow_circle:"
        : ":red_circle:";
  parts.push(`${healthEmoji} *Daily Executive Meeting*`);
  parts.push(`> ${content.headline}`);
  parts.push("");

  // Strategic priorities
  const priorities = content.sections.find(
    (s) => s.name === "strategic-priorities"
  );
  if (priorities) {
    parts.push("*Strategic Priorities*");
    parts.push(priorities.body);
    parts.push("");
  }

  // Daily focus
  const focus = content.sections.find((s) => s.name === "daily-focus");
  if (focus) {
    parts.push("*Daily Focus*");
    parts.push(focus.body);
    parts.push("");
  }

  // Cross-functional synergies
  const synergies = content.sections.find(
    (s) => s.name === "cross-functional-synergies"
  );
  if (synergies) {
    parts.push("*Cross-Functional Synergies*");
    parts.push(synergies.body);
    parts.push("");
  }

  // Action items
  if (content.actionItems.length > 0) {
    parts.push("*Action Items*");
    for (const item of content.actionItems) {
      const priorityEmoji =
        item.priority === "critical"
          ? ":rotating_light:"
          : item.priority === "high"
            ? ":exclamation:"
            : item.priority === "medium"
              ? ":small_blue_diamond:"
              : ":small_orange_diamond:";
      const assignee = item.assignee ? ` _(${item.assignee})_` : "";
      parts.push(`${priorityEmoji} ${item.description}${assignee}`);
    }
    parts.push("");
  }

  parts.push(`_Report ID: ${reportId}_`);

  // Full meeting transcript for thread
  const transcript = content.sections.find(
    (s) => s.name === "meeting-transcript"
  );

  return {
    summary: parts.join("\n"),
    transcript: transcript
      ? `:memo: *Full Meeting Transcript*\n\n${transcript.body}`
      : null,
  };
}

/**
 * Format a daily agent report as an array of Slack messages.
 * Each message becomes a separate post in a thread:
 *   1. Headline with health signal (parent message)
 *   2–N. One message per report section
 *   Last. Action items summary
 */
export function formatReportForSlack(
  agentName: string,
  content: ReportContent,
  reportId: string
): string[] {
  const messages: string[] = [];

  // Parent message: health + agent name + headline
  const healthEmoji =
    content.healthSignal === "green"
      ? ":large_green_circle:"
      : content.healthSignal === "yellow"
        ? ":large_yellow_circle:"
        : ":red_circle:";
  messages.push(
    `${healthEmoji} *${agentName} — Daily Report*\n> ${content.headline}\n\n_${content.sections.length} sections below in thread_`
  );

  // One message per section
  for (const section of content.sections) {
    const severityPrefix =
      section.severity === "critical"
        ? ":red_circle: "
        : section.severity === "warning"
          ? ":warning: "
          : "";
    // Title-case the section name for readability
    const title = section.name
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
    messages.push(`${severityPrefix}*${title}*\n${section.body}`);
  }

  // Final message: action items
  if (content.actionItems.length > 0) {
    const lines = ["*Action Items*"];
    for (const item of content.actionItems) {
      const emoji =
        item.priority === "critical"
          ? ":rotating_light:"
          : item.priority === "high"
            ? ":exclamation:"
            : item.priority === "medium"
              ? ":small_blue_diamond:"
              : ":small_orange_diamond:";
      const assignee = item.assignee ? ` _(${item.assignee})_` : "";
      lines.push(`${emoji} ${item.description}${assignee}`);
    }
    messages.push(lines.join("\n"));
  }

  return messages;
}

/**
 * Post a full agent report to a Slack channel as a threaded conversation.
 * The first message is the headline (parent); sections + action items follow as replies.
 */
export async function postReportToSlack(
  token: string,
  channelId: string,
  agentName: string,
  content: ReportContent,
  reportId: string
): Promise<void> {
  const messages = formatReportForSlack(agentName, content, reportId);
  if (messages.length === 0) return;

  // Post headline as parent message
  const first = await postToSlack(token, channelId, messages[0]);
  if (!first.ok || !first.ts) {
    console.error(`Failed to post report headline to Slack: ${first.error}`);
    return;
  }

  // Post remaining messages as thread replies
  for (const msg of messages.slice(1)) {
    await postToSlack(token, channelId, msg, first.ts);
  }
}
