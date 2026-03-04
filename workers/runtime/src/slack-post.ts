import type { ReportContent } from "@openchief/shared";

/** Slack block-kit section block limit */
const MAX_BLOCK_TEXT = 3000;

/**
 * Convert standard markdown (from Claude output) to Slack mrkdwn format.
 *
 * Handles: **bold** → *bold*, [text](url) → <url|text>,
 *          ### headers → *bold lines*, ``` code blocks preserved.
 */
export function markdownToSlackMrkdwn(text: string): string {
  let result = text;

  // Convert markdown links [text](url) → <url|text>
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Convert **bold** → *bold* (must come before italic conversion)
  // Use a non-greedy match and avoid converting already-single asterisks
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Convert __italic__ → _italic_ (rare but possible)
  result = result.replace(/__(.+?)__/g, "_$1_");

  // Convert ### Header / ## Header / # Header → *Header* (bold line)
  result = result.replace(/^#{1,3}\s+(.+)$/gm, "*$1*");

  return result;
}

/**
 * Build Slack block-kit blocks from mrkdwn text.
 * Splits into multiple section blocks if text exceeds 3000 char limit.
 */
function buildMrkdwnBlocks(
  text: string
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  if (text.length <= MAX_BLOCK_TEXT) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text },
    });
    return blocks;
  }

  // Split at paragraph boundaries to stay within limit
  const paragraphs = text.split("\n\n");
  let chunk = "";

  for (const para of paragraphs) {
    const candidate = chunk ? `${chunk}\n\n${para}` : para;
    if (candidate.length > MAX_BLOCK_TEXT && chunk) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: chunk },
      });
      chunk = para.length > MAX_BLOCK_TEXT ? para.slice(0, MAX_BLOCK_TEXT) : para;
    } else if (candidate.length > MAX_BLOCK_TEXT) {
      // Single paragraph exceeds limit — truncate
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: para.slice(0, MAX_BLOCK_TEXT) },
      });
      chunk = "";
    } else {
      chunk = candidate;
    }
  }

  if (chunk) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: chunk },
    });
  }

  return blocks;
}

/**
 * Post a message to a Slack channel using chat.postMessage with block-kit.
 * Uses mrkdwn blocks for proper formatting, with text as notification fallback.
 */
export async function postToSlack(
  token: string,
  channel: string,
  text: string,
  threadTs?: string
): Promise<{ ok: boolean; ts?: string; error?: string }> {
  const blocks = buildMrkdwnBlocks(text);

  const body: Record<string, unknown> = {
    channel,
    text, // fallback for notifications / unfurling
    blocks,
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
    parts.push(markdownToSlackMrkdwn(priorities.body));
    parts.push("");
  }

  // Daily focus
  const focus = content.sections.find((s) => s.name === "daily-focus");
  if (focus) {
    parts.push("*Daily Focus*");
    parts.push(markdownToSlackMrkdwn(focus.body));
    parts.push("");
  }

  // Cross-functional synergies
  const synergies = content.sections.find(
    (s) => s.name === "cross-functional-synergies"
  );
  if (synergies) {
    parts.push("*Cross-Functional Synergies*");
    parts.push(markdownToSlackMrkdwn(synergies.body));
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
      ? `:memo: *Full Meeting Transcript*\n\n${markdownToSlackMrkdwn(transcript.body)}`
      : null,
  };
}

/**
 * Format the parent message for a daily agent report (headline only).
 */
function formatReportHeadline(
  agentName: string,
  content: ReportContent,
): string {
  const healthEmoji =
    content.healthSignal === "green"
      ? ":large_green_circle:"
      : content.healthSignal === "yellow"
        ? ":large_yellow_circle:"
        : ":red_circle:";
  return `${healthEmoji} *${agentName} — Daily Report*\n> ${content.headline}`;
}

/**
 * Split report body into individual bullet points.
 * Each bullet becomes its own Slack thread message.
 */
function splitBullets(content: ReportContent): string[] {
  const body = content.sections.map((s) => s.body).join("\n\n");
  const converted = markdownToSlackMrkdwn(body);

  // Split on lines that start with "- " or "• ", keeping the marker
  const bullets: string[] = [];
  let current = "";
  for (const line of converted.split("\n")) {
    if (/^[-•] /.test(line) && current) {
      bullets.push(current.trim());
      current = line;
    } else if (/^[-•] /.test(line)) {
      current = line;
    } else {
      // Continuation line (wrapped text within the same bullet)
      current += "\n" + line;
    }
  }
  if (current.trim()) {
    bullets.push(current.trim());
  }

  return bullets;
}

/**
 * Post an agent report to a Slack channel as headline + one thread reply per bullet.
 * Parent message = headline only (avoids channel spam).
 * Thread replies = one message per bullet point.
 */
export async function postReportToSlack(
  token: string,
  channelId: string,
  agentName: string,
  content: ReportContent,
  reportId: string
): Promise<void> {
  const headline = formatReportHeadline(agentName, content);
  const parent = await postToSlack(token, channelId, headline);
  if (!parent.ok || !parent.ts) {
    console.error(`Failed to post ${agentName} report headline to Slack: ${parent.error}`);
    return;
  }

  // Post each bullet as a separate thread reply
  const bullets = splitBullets(content);
  for (const bullet of bullets) {
    if (bullet.trim()) {
      await postToSlack(token, channelId, bullet, parent.ts);
    }
  }
}

/**
 * Post a task proposal to Slack with interactive approve/reject buttons.
 */
export async function postTaskProposalToSlack(
  token: string,
  channelId: string,
  task: {
    id: string;
    title: string;
    description: string;
    priority: string;
    createdBy: string;
    assignedTo: string;
  }
): Promise<void> {
  const priorityEmoji =
    task.priority === "critical"
      ? ":rotating_light:"
      : task.priority === "high"
        ? ":exclamation:"
        : task.priority === "medium"
          ? ":small_blue_diamond:"
          : ":small_orange_diamond:";

  const text = `${priorityEmoji} *New Task Proposed*\n*${task.title}*\n${task.description}\n\n_Proposed by ${task.createdBy} · Assigned to ${task.assignedTo} · Priority: ${task.priority}_`;

  const blocks = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${priorityEmoji} *New Task Proposed*\n*${task.title}*`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: task.description.slice(0, MAX_BLOCK_TEXT),
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Proposed by *${task.createdBy}* · Assigned to *${task.assignedTo}* · Priority: *${task.priority}*`,
        },
      ],
    },
    {
      type: "actions",
      block_id: `task_actions_${task.id}`,
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve", emoji: true },
          style: "primary",
          action_id: "task_approve",
          value: task.id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject", emoji: true },
          style: "danger",
          action_id: "task_reject",
          value: task.id,
        },
      ],
    },
  ];

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel: channelId, text, blocks }),
  });

  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) {
    console.error(`Slack task proposal post error: ${result.error}`);
  }
}
