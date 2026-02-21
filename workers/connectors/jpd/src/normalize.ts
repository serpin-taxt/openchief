/**
 * Normalize JPD API objects into OpenChiefEvents.
 *
 * Event types follow the <entity>.<action> convention:
 *   idea.created, idea.updated, idea.status_changed, idea.commented,
 *   idea.assigned, idea.prioritized
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";
import type { JpdIdea, JpdComment } from "./jpd-api";
import { JPD_FIELDS } from "./jpd-api";

// ─── JPD Field Helpers ──────────────────────────────────────────────────────

/**
 * Read a JPD custom field that might exist under two different IDs.
 * Returns the first non-null value found.
 */
function readField(fields: Record<string, unknown>, ids: string | readonly string[]): unknown {
  const idList = Array.isArray(ids) ? ids : [ids];
  for (const id of idList) {
    if (fields[id] != null) return fields[id];
  }
  return undefined;
}

/** Extract a numeric rating (1-5) from a JPD rating field. */
function readRating(fields: Record<string, unknown>, ids: readonly string[]): number | undefined {
  const val = readField(fields, ids);
  if (typeof val === "number") return val;
  if (typeof val === "string" && val !== "") return Number(val) || undefined;
  return undefined;
}

/** Extract a slider value (0-100) from a JPD slider field. */
function readSlider(fields: Record<string, unknown>, ids: readonly string[]): number | undefined {
  const val = readField(fields, ids);
  if (typeof val === "number") return val;
  if (typeof val === "string" && val !== "") return Number(val) || undefined;
  return undefined;
}

/** Extract options from a multi-select/checkbox field → string[]. */
function readOptions(fields: Record<string, unknown>, ids: string | readonly string[]): string[] {
  const val = readField(fields, ids);
  if (!Array.isArray(val)) return [];
  return val
    .map((v: unknown) => {
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && "value" in v) return (v as { value: string }).value;
      return "";
    })
    .filter(Boolean);
}

/** Extract a single select option value. */
function readSelect(fields: Record<string, unknown>, ids: string | readonly string[]): string | undefined {
  const val = readField(fields, ids);
  if (typeof val === "string") return val;
  if (val && typeof val === "object" && "value" in val) return (val as { value: string }).value;
  return undefined;
}

/** Extract people field → display names. */
function readPeople(fields: Record<string, unknown>, ids: string | readonly string[]): string[] {
  const val = readField(fields, ids);
  if (!Array.isArray(val)) return [];
  return val
    .map((v: unknown) => {
      if (v && typeof v === "object" && "displayName" in v) return (v as { displayName: string }).displayName;
      return "";
    })
    .filter(Boolean);
}

/** Extract boolean field. */
function readBoolean(fields: Record<string, unknown>, ids: string | readonly string[]): boolean | undefined {
  const val = readField(fields, ids);
  if (typeof val === "boolean") return val;
  if (val === 1 || val === "1") return true;
  if (val === 0 || val === "0") return false;
  return undefined;
}

/** Extract the JPD priority data from an idea's fields. */
function extractJpdPriority(fields: Record<string, unknown>) {
  const impact = readRating(fields, JPD_FIELDS.IMPACT);
  const effort = readRating(fields, JPD_FIELDS.EFFORT);
  const value = readRating(fields, JPD_FIELDS.VALUE);
  const confidence = readSlider(fields, JPD_FIELDS.CONFIDENCE);
  const impactScore = readField(fields, JPD_FIELDS.IMPACT_SCORE);
  const rank = readField(fields, JPD_FIELDS.RANK) as string | undefined;
  const goal = readOptions(fields, JPD_FIELDS.GOAL);
  const roadmap = readSelect(fields, JPD_FIELDS.ROADMAP);
  const strategy = readOptions(fields, JPD_FIELDS.STRATEGY);
  const featureLead = readPeople(fields, JPD_FIELDS.FEATURE_LEAD);
  const complete = readBoolean(fields, JPD_FIELDS.COMPLETE);
  const designStatus = readSelect(fields, JPD_FIELDS.DESIGN_STATUS);
  const designsReady = readBoolean(fields, JPD_FIELDS.DESIGNS_READY);
  const specReady = readBoolean(fields, JPD_FIELDS.SPEC_READY);
  const deliveryProgress = readField(fields, JPD_FIELDS.DELIVERY_PROGRESS);
  const deliveryStatus = readField(fields, JPD_FIELDS.DELIVERY_STATUS);

  // Build a clean object omitting undefined values
  const data: Record<string, unknown> = {};
  if (impact != null) data.impact = impact;
  if (effort != null) data.effort = effort;
  if (value != null) data.value = value;
  if (confidence != null) data.confidence = confidence;
  if (impactScore != null) data.impact_score = typeof impactScore === "number" ? impactScore : Number(impactScore) || undefined;
  if (rank) data.rank = rank;
  if (goal.length > 0) data.goal = goal;
  if (roadmap) data.roadmap = roadmap;
  if (strategy.length > 0) data.strategy = strategy;
  if (featureLead.length > 0) data.feature_lead = featureLead;
  if (complete != null) data.complete = complete;
  if (designStatus) data.design_status = designStatus;
  if (designsReady != null) data.designs_ready = designsReady;
  if (specReady != null) data.spec_ready = specReady;
  if (deliveryProgress != null) data.delivery_progress = deliveryProgress;
  if (deliveryStatus != null) data.delivery_status = deliveryStatus;

  return Object.keys(data).length > 0 ? data : undefined;
}

// ─── Ideas ──────────────────────────────────────────────────────────────────

/**
 * Normalize a JPD idea into an OpenChiefEvent.
 */
export function normalizeIdea(idea: JpdIdea, since: string): OpenChiefEvent {
  const now = new Date().toISOString();
  const f = idea.fields;
  const isNew = isRecentlyCreated(f.created, f.updated, since);
  const eventType = isNew ? "idea.created" : "idea.updated";

  const jpdPriority = extractJpdPriority(f);

  const parts = [
    `${f.issuetype.name} ${idea.key} "${f.summary}" ${isNew ? "created" : "updated"} in ${f.project.name}`,
    `status=${f.status.name}`,
  ];
  if (f.priority) parts.push(`priority=${f.priority.name}`);
  if (f.assignee) parts.push(`assignee=${f.assignee.displayName}`);
  if (f.reporter) parts.push(`reporter=${f.reporter.displayName}`);
  if (f.labels.length > 0) parts.push(`labels=[${f.labels.join(",")}]`);
  // Add priority data to summary
  if (jpdPriority) {
    const pParts: string[] = [];
    if (jpdPriority.impact) pParts.push(`impact=${jpdPriority.impact}`);
    if (jpdPriority.effort) pParts.push(`effort=${jpdPriority.effort}`);
    if (jpdPriority.value) pParts.push(`value=${jpdPriority.value}`);
    if (jpdPriority.confidence) pParts.push(`confidence=${jpdPriority.confidence}`);
    if (jpdPriority.goal) pParts.push(`goal=${(jpdPriority.goal as string[]).join(",")}`);
    if (jpdPriority.strategy) pParts.push(`strategy=${(jpdPriority.strategy as string[]).join(",")}`);
    if (jpdPriority.feature_lead) pParts.push(`lead=${(jpdPriority.feature_lead as string[]).join(",")}`);
    if (jpdPriority.complete != null) pParts.push(`complete=${jpdPriority.complete}`);
    if (pParts.length > 0) parts.push(pParts.join(" "));
  }

  return {
    id: generateULID(),
    timestamp: f.updated || f.created,
    ingestedAt: now,
    source: "jpd",
    eventType,
    scope: {
      org: f.project.key,
      project: f.project.name,
      actor: (isNew ? f.creator?.displayName : f.assignee?.displayName) || f.reporter?.displayName || "unknown",
    },
    payload: slimIdeaPayload(idea, jpdPriority),
    summary: parts.join(" | "),
    tags: buildIdeaTags(idea, jpdPriority),
  };
}

// ─── Status Changes ──────────────────────────────────────────────────────────

/**
 * Extract status and field changes from changelog.
 */
export function normalizeIdeaChanges(idea: JpdIdea, since: string): OpenChiefEvent[] {
  const now = new Date().toISOString();
  const f = idea.fields;
  const events: OpenChiefEvent[] = [];

  const changelog = f.changelog?.histories || [];

  for (const entry of changelog) {
    if (entry.created < since) continue;

    // Status changes
    const statusChange = entry.items.find((item) => item.field === "status");
    if (statusChange) {
      events.push({
        id: generateULID(),
        timestamp: entry.created,
        ingestedAt: now,
        source: "jpd",
        eventType: "idea.status_changed",
        scope: {
          org: f.project.key,
          project: f.project.name,
          actor: entry.author.displayName,
        },
        payload: {
          idea_key: idea.key,
          idea_summary: f.summary,
          project_key: f.project.key,
          project_name: f.project.name,
          from_status: statusChange.fromString,
          to_status: statusChange.toString,
          changed_by: entry.author.displayName,
        },
        summary: `Idea ${idea.key} "${f.summary}" moved from "${statusChange.fromString}" to "${statusChange.toString}" by ${entry.author.displayName}`,
      });
    }

    // Assignee changes
    const assigneeChange = entry.items.find((item) => item.field === "assignee");
    if (assigneeChange) {
      events.push({
        id: generateULID(),
        timestamp: entry.created,
        ingestedAt: now,
        source: "jpd",
        eventType: "idea.assigned",
        scope: {
          org: f.project.key,
          project: f.project.name,
          actor: entry.author.displayName,
        },
        payload: {
          idea_key: idea.key,
          idea_summary: f.summary,
          project_key: f.project.key,
          project_name: f.project.name,
          from_assignee: assigneeChange.fromString || "unassigned",
          to_assignee: assigneeChange.toString || "unassigned",
        },
        summary: `Idea ${idea.key} "${f.summary}" assigned to ${assigneeChange.toString || "unassigned"} by ${entry.author.displayName}`,
      });
    }

    // Priority/impact/effort/value/confidence/rank changes
    const priorityChange = entry.items.find(
      (item) =>
        item.field === "priority" ||
        item.field === "Rank" ||
        item.field.toLowerCase().includes("impact") ||
        item.field.toLowerCase().includes("effort") ||
        item.field.toLowerCase().includes("value") ||
        item.field.toLowerCase().includes("confidence") ||
        item.field.toLowerCase().includes("reach") ||
        item.field.toLowerCase().includes("goal") ||
        item.field.toLowerCase().includes("strategy") ||
        item.field.toLowerCase().includes("roadmap")
    );
    if (priorityChange && !statusChange) {
      events.push({
        id: generateULID(),
        timestamp: entry.created,
        ingestedAt: now,
        source: "jpd",
        eventType: "idea.prioritized",
        scope: {
          org: f.project.key,
          project: f.project.name,
          actor: entry.author.displayName,
        },
        payload: {
          idea_key: idea.key,
          idea_summary: f.summary,
          project_key: f.project.key,
          project_name: f.project.name,
          field: priorityChange.field,
          from_value: priorityChange.fromString,
          to_value: priorityChange.toString,
          changed_by: entry.author.displayName,
        },
        summary: `Idea ${idea.key} "${f.summary}" ${priorityChange.field} changed from "${priorityChange.fromString}" to "${priorityChange.toString}"`,
      });
    }
  }

  return events;
}

// ─── Comments ────────────────────────────────────────────────────────────────

/**
 * Extract recent comments from the idea.
 */
export function normalizeIdeaComments(idea: JpdIdea, since: string): OpenChiefEvent[] {
  const now = new Date().toISOString();
  const f = idea.fields;
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
      source: "jpd",
      eventType: "idea.commented",
      scope: {
        org: f.project.key,
        project: f.project.name,
        actor: comment.author.displayName,
      },
      payload: {
        idea_key: idea.key,
        idea_summary: f.summary,
        project_key: f.project.key,
        project_name: f.project.name,
        comment_id: comment.id,
        comment_author: comment.author.displayName,
        comment_preview: preview,
        comment_length: bodyText.length,
        created: comment.created,
      },
      summary: `${comment.author.displayName} commented on idea ${idea.key} "${f.summary}": "${preview.slice(0, 100)}${bodyText.length > 100 ? "..." : ""}"`,
    });
  }

  return events;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isRecentlyCreated(created: string, updated: string, since: string): boolean {
  const createdMs = new Date(created).getTime();
  const updatedMs = new Date(updated).getTime();
  const sinceMs = new Date(since).getTime();

  if (createdMs >= sinceMs) return true;
  return updatedMs - createdMs < 2 * 60 * 1000;
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

function slimIdeaPayload(
  idea: JpdIdea,
  jpdPriority?: Record<string, unknown>
): Record<string, unknown> {
  const f = idea.fields;
  return {
    _polled: true,
    idea_key: idea.key,
    idea_id: idea.id,
    summary: f.summary,
    status: f.status.name,
    status_category: f.status.statusCategory?.name,
    issue_type: f.issuetype.name,
    priority: f.priority?.name,
    assignee: f.assignee?.displayName,
    reporter: f.reporter?.displayName,
    creator: f.creator?.displayName,
    project_key: f.project.key,
    project_name: f.project.name,
    labels: f.labels,
    created: f.created,
    updated: f.updated,
    comment_count: f.comment?.total || 0,
    changelog_count: f.changelog?.histories?.length || 0,
    // JPD priority and scoring data
    ...(jpdPriority || {}),
  };
}

function buildIdeaTags(
  idea: JpdIdea,
  jpdPriority?: Record<string, unknown>
): string[] | undefined {
  const tags: string[] = [];
  const f = idea.fields;

  if (f.priority?.name) tags.push(f.priority.name.toLowerCase().replace(/\s+/g, "-"));
  if (f.status.statusCategory?.key) tags.push(f.status.statusCategory.key);
  tags.push("idea");
  for (const label of f.labels) tags.push(label.toLowerCase().replace(/\s+/g, "-"));

  // Add JPD-specific tags
  if (jpdPriority) {
    if (jpdPriority.impact) tags.push(`impact-${jpdPriority.impact}`);
    if (jpdPriority.effort) tags.push(`effort-${jpdPriority.effort}`);
    if (jpdPriority.complete === true) tags.push("complete");
    if (jpdPriority.goal) {
      for (const g of jpdPriority.goal as string[]) {
        tags.push(`goal-${g.toLowerCase().replace(/\s+/g, "-")}`);
      }
    }
    if (jpdPriority.strategy) {
      for (const s of jpdPriority.strategy as string[]) {
        tags.push(`strategy-${s.toLowerCase().replace(/\s+/g, "-")}`);
      }
    }
  }

  return tags.length > 0 ? tags : undefined;
}
