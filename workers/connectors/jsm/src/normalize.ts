/**
 * Normalize JSM API objects into OpenChiefEvents.
 *
 * Event types:
 *   request.created, request.updated, request.resolved,
 *   request.breached, request.commented,
 *   csat.received
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";
import type { JsmRequest, JsmSlaRecord, JsmCsatFeedback } from "./jsm-api";

// ─── Requests ────────────────────────────────────────────────────────────────

/**
 * Normalize a JSM request into a single OpenChiefEvent.
 * Determines if the request was created or updated based on timestamps.
 */
export function normalizeRequest(request: JsmRequest, since: string): OpenChiefEvent {
  const now = new Date().toISOString();
  const f = request.fields;
  const isNew = isRecentlyCreated(f.created, f.updated, since);
  const eventType = isNew ? "request.created" : "request.updated";

  const age = ageHours(f.created);
  const parts = [
    `${f.issuetype.name} ${request.key} "${f.summary}" ${isNew ? "created" : "updated"} in ${f.project.name}`,
    `status=${f.status.name}`,
  ];
  if (f.priority) parts.push(`priority=${f.priority.name}`);
  if (f.assignee) parts.push(`assignee=${f.assignee.displayName}`);
  if (f.reporter) parts.push(`reporter=${f.reporter.displayName}`);
  parts.push(`age_hours=${age}`);
  if (f.resolution) parts.push(`resolution=${f.resolution.name}`);

  return {
    id: generateULID(),
    timestamp: f.updated || f.created,
    ingestedAt: now,
    source: "jsm",
    eventType,
    scope: {
      org: f.project.key,
      project: f.project.name,
      actor: (isNew ? f.reporter?.displayName : f.assignee?.displayName) || f.reporter?.displayName || "unknown",
    },
    payload: slimRequestPayload(request),
    summary: parts.join(" | "),
    tags: buildRequestTags(request),
  };
}

// ─── Transitions ─────────────────────────────────────────────────────────────

/**
 * Extract status transitions from the request changelog and normalize each.
 */
export function normalizeTransitions(request: JsmRequest, since: string): OpenChiefEvent[] {
  const now = new Date().toISOString();
  const f = request.fields;
  const events: OpenChiefEvent[] = [];

  const changelog = f.changelog?.histories || [];

  for (const entry of changelog) {
    if (entry.created < since) continue;

    // Status changes
    const statusChange = entry.items.find((item) => item.field === "status");
    if (statusChange) {
      const fromStatus = statusChange.fromString || "unknown";
      const toStatus = statusChange.toString || "unknown";

      // Determine if this is a resolution
      let eventType = "request.updated";
      if (toStatus.toLowerCase().includes("done") || toStatus.toLowerCase().includes("resolved") || toStatus.toLowerCase().includes("closed")) {
        eventType = "request.resolved";
      }

      events.push({
        id: generateULID(),
        timestamp: entry.created,
        ingestedAt: now,
        source: "jsm",
        eventType,
        scope: {
          org: f.project.key,
          project: f.project.name,
          actor: entry.author.displayName,
        },
        payload: {
          request_key: request.key,
          request_summary: f.summary,
          request_type: f.issuetype.name,
          project_key: f.project.key,
          project_name: f.project.name,
          from_status: fromStatus,
          to_status: toStatus,
          transitioned_by: entry.author.displayName,
          transitioned_at: entry.created,
          priority: f.priority?.name,
          assignee: f.assignee?.displayName,
        },
        summary: `${f.issuetype.name} ${request.key} "${f.summary}" moved from "${fromStatus}" to "${toStatus}" by ${entry.author.displayName}`,
      });
    }

    // Assignee changes
    const assigneeChange = entry.items.find((item) => item.field === "assignee");
    if (assigneeChange) {
      const fromAssignee = assigneeChange.fromString || "unassigned";
      const toAssignee = assigneeChange.toString || "unassigned";

      events.push({
        id: generateULID(),
        timestamp: entry.created,
        ingestedAt: now,
        source: "jsm",
        eventType: "request.updated",
        scope: {
          org: f.project.key,
          project: f.project.name,
          actor: entry.author.displayName,
        },
        payload: {
          request_key: request.key,
          request_summary: f.summary,
          request_type: f.issuetype.name,
          project_key: f.project.key,
          project_name: f.project.name,
          from_assignee: fromAssignee,
          to_assignee: toAssignee,
          assigned_by: entry.author.displayName,
        },
        summary: `${request.key} "${f.summary}" reassigned from ${fromAssignee} to ${toAssignee} by ${entry.author.displayName}`,
      });
    }
  }

  return events;
}

// ─── Comments ────────────────────────────────────────────────────────────────

/**
 * Extract recent comments from the request and normalize each.
 */
export function normalizeComments(request: JsmRequest, since: string): OpenChiefEvent[] {
  const now = new Date().toISOString();
  const f = request.fields;
  const events: OpenChiefEvent[] = [];

  const comments = f.comment?.comments || [];

  for (const comment of comments) {
    if (comment.created < since) continue;

    const bodyText = extractCommentText(comment.body);
    const preview = bodyText.slice(0, 200);

    events.push({
      id: generateULID(),
      timestamp: comment.created,
      ingestedAt: now,
      source: "jsm",
      eventType: "request.commented",
      scope: {
        org: f.project.key,
        project: f.project.name,
        actor: comment.author.displayName,
      },
      payload: {
        request_key: request.key,
        request_summary: f.summary,
        request_type: f.issuetype.name,
        project_key: f.project.key,
        project_name: f.project.name,
        comment_id: comment.id,
        comment_author: comment.author.displayName,
        comment_preview: preview,
        comment_length: bodyText.length,
        created: comment.created,
      },
      summary: `${comment.author.displayName} commented on ${request.key} "${f.summary}": "${preview.slice(0, 100)}${bodyText.length > 100 ? "..." : ""}"`,
    });
  }

  return events;
}

// ─── SLA Breach ──────────────────────────────────────────────────────────────

/**
 * Normalize SLA breach detection into events.
 * Emits request.breached when an ongoing or completed SLA cycle is breached.
 */
export function normalizeSLABreach(
  request: JsmRequest,
  slaRecords: JsmSlaRecord[],
  knownBreaches: Set<string>,
): OpenChiefEvent[] {
  const now = new Date().toISOString();
  const f = request.fields;
  const events: OpenChiefEvent[] = [];

  for (const sla of slaRecords) {
    const breachKey = `${request.key}:${sla.id}`;

    // Check ongoing cycle breach
    if (sla.ongoingCycle?.breached && !knownBreaches.has(breachKey)) {
      events.push({
        id: generateULID(),
        timestamp: now,
        ingestedAt: now,
        source: "jsm",
        eventType: "request.breached",
        scope: {
          org: f.project.key,
          project: f.project.name,
          actor: f.assignee?.displayName || "unassigned",
        },
        payload: {
          request_key: request.key,
          request_summary: f.summary,
          request_type: f.issuetype.name,
          project_key: f.project.key,
          project_name: f.project.name,
          sla_name: sla.name,
          sla_goal: sla.ongoingCycle.goalDuration.friendly,
          sla_elapsed: sla.ongoingCycle.elapsedTime.friendly,
          assignee: f.assignee?.displayName,
          priority: f.priority?.name,
          status: f.status.name,
        },
        summary: `SLA "${sla.name}" breached on ${request.key} "${f.summary}" — goal ${sla.ongoingCycle.goalDuration.friendly}, elapsed ${sla.ongoingCycle.elapsedTime.friendly}`,
        tags: ["sla-breach"],
      });
    }

    // Check completed cycle breaches
    for (const cycle of sla.completedCycles) {
      if (cycle.breached && !knownBreaches.has(breachKey)) {
        events.push({
          id: generateULID(),
          timestamp: now,
          ingestedAt: now,
          source: "jsm",
          eventType: "request.breached",
          scope: {
            org: f.project.key,
            project: f.project.name,
            actor: f.assignee?.displayName || "unassigned",
          },
          payload: {
            request_key: request.key,
            request_summary: f.summary,
            request_type: f.issuetype.name,
            project_key: f.project.key,
            project_name: f.project.name,
            sla_name: sla.name,
            sla_goal: cycle.goalDuration.friendly,
            sla_elapsed: cycle.elapsedTime.friendly,
            breach_type: "completed",
            assignee: f.assignee?.displayName,
            priority: f.priority?.name,
          },
          summary: `SLA "${sla.name}" was breached on ${request.key} "${f.summary}" — goal ${cycle.goalDuration.friendly}, took ${cycle.elapsedTime.friendly}`,
          tags: ["sla-breach"],
        });
      }
    }
  }

  return events;
}

// ─── CSAT ────────────────────────────────────────────────────────────────────

/**
 * Normalize CSAT feedback into an event.
 */
export function normalizeCSAT(
  request: JsmRequest,
  feedback: JsmCsatFeedback,
): OpenChiefEvent {
  const now = new Date().toISOString();
  const f = request.fields;

  const ratingEmoji = feedback.rating >= 4 ? "😊" : feedback.rating >= 3 ? "😐" : "😞";
  const parts = [
    `CSAT ${ratingEmoji} ${feedback.rating}/5 for ${request.key} "${f.summary}"`,
  ];
  if (feedback.comment) parts.push(`feedback="${feedback.comment.slice(0, 100)}"`);
  if (f.assignee) parts.push(`agent=${f.assignee.displayName}`);

  return {
    id: generateULID(),
    timestamp: now,
    ingestedAt: now,
    source: "jsm",
    eventType: "csat.received",
    scope: {
      org: f.project.key,
      project: f.project.name,
      actor: f.reporter?.displayName || "customer",
    },
    payload: {
      request_key: request.key,
      request_summary: f.summary,
      request_type: f.issuetype.name,
      project_key: f.project.key,
      project_name: f.project.name,
      csat_rating: feedback.rating,
      csat_comment: feedback.comment || null,
      agent: f.assignee?.displayName,
      reporter: f.reporter?.displayName,
      resolution: f.resolution?.name,
    },
    summary: parts.join(" | "),
    tags: feedback.rating <= 2 ? ["low-csat"] : undefined,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecentlyCreated(created: string, updated: string, since: string): boolean {
  const createdMs = new Date(created).getTime();
  const updatedMs = new Date(updated).getTime();
  const sinceMs = new Date(since).getTime();

  if (createdMs >= sinceMs) return true;
  return updatedMs - createdMs < 2 * 60 * 1000;
}

function ageHours(created: string): number {
  return Math.round((Date.now() - new Date(created).getTime()) / 3_600_000);
}

function extractCommentText(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";

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
    if (n.type === "text" && n.text) parts.push(n.text);
    if (Array.isArray(n.content)) parts.push(extractAdfText(n.content));
  }
  return parts.join(" ").trim();
}

function slimRequestPayload(request: JsmRequest): Record<string, unknown> {
  const f = request.fields;
  return {
    _polled: true,
    request_key: request.key,
    request_id: request.id,
    summary: f.summary,
    status: f.status.name,
    status_category: f.status.statusCategory?.name,
    request_type: f.issuetype.name,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName,
    reporter: f.reporter?.displayName,
    creator: f.creator?.displayName,
    project_key: f.project.key,
    project_name: f.project.name,
    labels: f.labels,
    components: f.components?.map((c) => c.name),
    resolution: f.resolution?.name,
    created: f.created,
    updated: f.updated,
    resolved: f.resolutiondate,
    due_date: f.duedate,
    comment_count: f.comment?.total || 0,
    changelog_count: f.changelog?.histories?.length || 0,
  };
}

function buildRequestTags(request: JsmRequest): string[] | undefined {
  const tags: string[] = [];
  const f = request.fields;

  if (f.priority?.name) {
    tags.push(f.priority.name.toLowerCase().replace(/\s+/g, "-"));
  }
  if (f.status.statusCategory?.key) {
    tags.push(f.status.statusCategory.key);
  }
  tags.push(f.issuetype.name.toLowerCase().replace(/\s+/g, "-"));
  for (const label of f.labels) {
    tags.push(label.toLowerCase().replace(/\s+/g, "-"));
  }

  return tags.length > 0 ? tags : undefined;
}
