/**
 * Normalize Jira API objects into OpenChiefEvents.
 *
 * Event types follow the <entity>.<action> convention:
 *   issue.created, issue.updated, issue.transitioned, issue.assigned,
 *   issue.resolved, issue.commented, sprint.started, sprint.completed, sprint.closed
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";
import type { JiraIssue, JiraComment, JiraChangelogEntry, JiraSprint, JiraBoard } from "./jira-api";

// ─── Issues ──────────────────────────────────────────────────────────────────

/**
 * Normalize a Jira issue into a single OpenChiefEvent.
 * Determines if the issue was created or updated based on timestamps.
 */
export function normalizeIssue(issue: JiraIssue, since: string): OpenChiefEvent {
  const now = new Date().toISOString();
  const f = issue.fields;
  const isNew = isRecentlyCreated(f.created, f.updated, since);
  const eventType = isNew ? "issue.created" : "issue.updated";

  const age = ageHours(f.created);
  const parts = [
    `${f.issuetype.name} ${issue.key} "${f.summary}" ${isNew ? "created" : "updated"} in ${f.project.name}`,
    `status=${f.status.name}`,
  ];
  if (f.priority) parts.push(`priority=${f.priority.name}`);
  if (f.assignee) parts.push(`assignee=${f.assignee.displayName}`);
  if (f.reporter) parts.push(`reporter=${f.reporter.displayName}`);
  if (f.labels.length > 0) parts.push(`labels=[${f.labels.join(",")}]`);
  if (f.parent) parts.push(`parent=${f.parent.key}`);
  parts.push(`age_hours=${age}`);
  if (f.resolution) parts.push(`resolution=${f.resolution.name}`);

  return {
    id: generateULID(),
    timestamp: f.updated || f.created,
    ingestedAt: now,
    source: "jira",
    eventType,
    scope: {
      org: f.project.key,
      project: f.project.name,
      actor: (isNew ? f.creator?.displayName : f.assignee?.displayName) || f.reporter?.displayName || "unknown",
    },
    payload: slimIssuePayload(issue),
    summary: parts.join(" | "),
    tags: buildIssueTags(issue),
  };
}

// ─── Transitions (from changelog) ────────────────────────────────────────────

/**
 * Extract status transitions from the issue changelog and normalize each
 * into a separate OpenChiefEvent.
 */
export function normalizeTransitions(issue: JiraIssue, since: string): OpenChiefEvent[] {
  const now = new Date().toISOString();
  const f = issue.fields;
  const events: OpenChiefEvent[] = [];

  const changelog = f.changelog?.histories || [];

  for (const entry of changelog) {
    // Only process entries since last poll
    if (entry.created < since) continue;

    // Look for status changes
    const statusChange = entry.items.find((item) => item.field === "status");
    if (statusChange) {
      const fromStatus = statusChange.fromString || "unknown";
      const toStatus = statusChange.toString || "unknown";

      // Determine specific event type
      let eventType = "issue.transitioned";
      if (toStatus.toLowerCase().includes("done") || statusChange.to === "10001") {
        eventType = "issue.resolved";
      }

      events.push({
        id: generateULID(),
        timestamp: entry.created,
        ingestedAt: now,
        source: "jira",
        eventType,
        scope: {
          org: f.project.key,
          project: f.project.name,
          actor: entry.author.displayName,
        },
        payload: {
          issue_key: issue.key,
          issue_summary: f.summary,
          issue_type: f.issuetype.name,
          project_key: f.project.key,
          project_name: f.project.name,
          from_status: fromStatus,
          to_status: toStatus,
          transitioned_by: entry.author.displayName,
          transitioned_at: entry.created,
          priority: f.priority?.name,
          assignee: f.assignee?.displayName,
        },
        summary: `${f.issuetype.name} ${issue.key} "${f.summary}" moved from "${fromStatus}" to "${toStatus}" by ${entry.author.displayName}`,
      });
    }

    // Look for assignee changes
    const assigneeChange = entry.items.find((item) => item.field === "assignee");
    if (assigneeChange) {
      const fromAssignee = assigneeChange.fromString || "unassigned";
      const toAssignee = assigneeChange.toString || "unassigned";

      events.push({
        id: generateULID(),
        timestamp: entry.created,
        ingestedAt: now,
        source: "jira",
        eventType: "issue.assigned",
        scope: {
          org: f.project.key,
          project: f.project.name,
          actor: entry.author.displayName,
        },
        payload: {
          issue_key: issue.key,
          issue_summary: f.summary,
          issue_type: f.issuetype.name,
          project_key: f.project.key,
          project_name: f.project.name,
          from_assignee: fromAssignee,
          to_assignee: toAssignee,
          assigned_by: entry.author.displayName,
          assigned_at: entry.created,
        },
        summary: `${issue.key} "${f.summary}" reassigned from ${fromAssignee} to ${toAssignee} by ${entry.author.displayName}`,
      });
    }

    // Look for priority changes
    const priorityChange = entry.items.find((item) => item.field === "priority");
    if (priorityChange) {
      events.push({
        id: generateULID(),
        timestamp: entry.created,
        ingestedAt: now,
        source: "jira",
        eventType: "issue.priority_changed",
        scope: {
          org: f.project.key,
          project: f.project.name,
          actor: entry.author.displayName,
        },
        payload: {
          issue_key: issue.key,
          issue_summary: f.summary,
          issue_type: f.issuetype.name,
          project_key: f.project.key,
          project_name: f.project.name,
          from_priority: priorityChange.fromString,
          to_priority: priorityChange.toString,
          changed_by: entry.author.displayName,
        },
        summary: `${issue.key} "${f.summary}" priority changed from ${priorityChange.fromString} to ${priorityChange.toString}`,
      });
    }
  }

  return events;
}

// ─── Comments ────────────────────────────────────────────────────────────────

/**
 * Extract recent comments from the issue and normalize each.
 */
export function normalizeComments(issue: JiraIssue, since: string): OpenChiefEvent[] {
  const now = new Date().toISOString();
  const f = issue.fields;
  const events: OpenChiefEvent[] = [];

  const comments = f.comment?.comments || [];

  for (const comment of comments) {
    // Only process comments since last poll
    if (comment.created < since) continue;

    const bodyText = extractCommentText(comment.body);
    const preview = bodyText.slice(0, 200);

    events.push({
      id: generateULID(),
      timestamp: comment.created,
      ingestedAt: now,
      source: "jira",
      eventType: "issue.commented",
      scope: {
        org: f.project.key,
        project: f.project.name,
        actor: comment.author.displayName,
      },
      payload: {
        issue_key: issue.key,
        issue_summary: f.summary,
        issue_type: f.issuetype.name,
        project_key: f.project.key,
        project_name: f.project.name,
        comment_id: comment.id,
        comment_author: comment.author.displayName,
        comment_preview: preview,
        comment_length: bodyText.length,
        comment_word_count: bodyText.split(/\s+/).filter(Boolean).length,
        created: comment.created,
      },
      summary: `${comment.author.displayName} commented on ${issue.key} "${f.summary}": "${preview.slice(0, 100)}${bodyText.length > 100 ? "..." : ""}"`,
    });
  }

  return events;
}

// ─── Sprints ─────────────────────────────────────────────────────────────────

/**
 * Normalize a sprint state change into an OpenChiefEvent.
 */
export function normalizeSprint(
  sprint: JiraSprint,
  board: { id: number; name: string; location?: { projectKey: string; projectName: string } },
  previousState: string
): OpenChiefEvent {
  const now = new Date().toISOString();
  let eventType = "sprint.updated";

  if (sprint.state === "active" && previousState === "future") {
    eventType = "sprint.started";
  } else if (sprint.state === "closed" && previousState === "active") {
    eventType = "sprint.completed";
  }

  const projectKey = board.location?.projectKey || "unknown";
  const projectName = board.location?.projectName || board.name;

  const parts = [
    `Sprint "${sprint.name}" ${sprint.state === "active" ? "started" : sprint.state === "closed" ? "completed" : "updated"}`,
    `board=${board.name}`,
    `project=${projectName}`,
  ];
  if (sprint.goal) parts.push(`goal="${sprint.goal}"`);
  if (sprint.startDate) parts.push(`start=${sprint.startDate.slice(0, 10)}`);
  if (sprint.endDate) parts.push(`end=${sprint.endDate.slice(0, 10)}`);

  return {
    id: generateULID(),
    timestamp: sprint.completeDate || sprint.startDate || now,
    ingestedAt: now,
    source: "jira",
    eventType,
    scope: {
      org: projectKey,
      project: projectName,
    },
    payload: {
      sprint_id: sprint.id,
      sprint_name: sprint.name,
      sprint_state: sprint.state,
      previous_state: previousState,
      board_id: board.id,
      board_name: board.name,
      project_key: projectKey,
      project_name: projectName,
      start_date: sprint.startDate,
      end_date: sprint.endDate,
      complete_date: sprint.completeDate,
      goal: sprint.goal,
    },
    summary: parts.join(" | "),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Determine if an issue was recently created (created === updated within 2 min,
 * OR created after the last poll cursor).
 */
function isRecentlyCreated(created: string, updated: string, since: string): boolean {
  const createdMs = new Date(created).getTime();
  const updatedMs = new Date(updated).getTime();
  const sinceMs = new Date(since).getTime();

  // If created after last poll, it's new
  if (createdMs >= sinceMs) return true;

  // If created and updated are within 2 minutes, treat as new
  return updatedMs - createdMs < 2 * 60 * 1000;
}

function ageHours(created: string): number {
  return Math.round((Date.now() - new Date(created).getTime()) / 3_600_000);
}

/**
 * Extract plain text from Jira's Atlassian Document Format (ADF) body.
 * Falls back to string body if not ADF.
 */
function extractCommentText(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";

  // ADF format: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "..." }] }] }
  const doc = body as { type?: string; content?: unknown[] };
  if (doc.type === "doc" && Array.isArray(doc.content)) {
    return extractAdfText(doc.content);
  }

  return JSON.stringify(body).slice(0, 500);
}

function extractAdfText(nodes: unknown[]): string {
  const parts: string[] = [];

  for (const node of nodes) {
    const n = node as { type?: string; text?: string; content?: unknown[] };
    if (n.type === "text" && n.text) {
      parts.push(n.text);
    }
    if (Array.isArray(n.content)) {
      parts.push(extractAdfText(n.content));
    }
  }

  return parts.join(" ").trim();
}

/**
 * Slim down an issue payload to essential fields for queue size limits.
 */
function slimIssuePayload(issue: JiraIssue): Record<string, unknown> {
  const f = issue.fields;
  return {
    _polled: true,
    issue_key: issue.key,
    issue_id: issue.id,
    summary: f.summary,
    status: f.status.name,
    status_category: f.status.statusCategory?.name,
    issue_type: f.issuetype.name,
    is_subtask: f.issuetype.subtask,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName,
    reporter: f.reporter?.displayName,
    creator: f.creator?.displayName,
    project_key: f.project.key,
    project_name: f.project.name,
    labels: f.labels,
    components: f.components?.map((c) => c.name),
    fix_versions: f.fixVersions?.map((v) => v.name),
    resolution: f.resolution?.name,
    created: f.created,
    updated: f.updated,
    resolved: f.resolutiondate,
    due_date: f.duedate,
    parent_key: f.parent?.key,
    parent_summary: f.parent?.fields?.summary,
    parent_type: f.parent?.fields?.issuetype?.name,
    subtask_count: f.subtasks?.length || 0,
    comment_count: f.comment?.total || 0,
    changelog_count: f.changelog?.histories?.length || 0,
  };
}

/**
 * Build tags from issue metadata.
 */
function buildIssueTags(issue: JiraIssue): string[] | undefined {
  const tags: string[] = [];
  const f = issue.fields;

  // Add priority as tag
  if (f.priority?.name) {
    tags.push(f.priority.name.toLowerCase().replace(/\s+/g, "-"));
  }

  // Add status category
  if (f.status.statusCategory?.key) {
    tags.push(f.status.statusCategory.key);
  }

  // Add issue type
  tags.push(f.issuetype.name.toLowerCase().replace(/\s+/g, "-"));

  // Add labels
  for (const label of f.labels) {
    tags.push(label.toLowerCase().replace(/\s+/g, "-"));
  }

  return tags.length > 0 ? tags : undefined;
}
