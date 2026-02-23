/**
 * Normalize Figma webhook events to OpenChiefEvent format.
 */

import type { OpenChiefEvent } from "@openchief/shared";
import { generateULID } from "@openchief/shared";

/** Figma webhook payload types */
interface FigmaWebhookPayload {
  event_type: string;
  passcode: string;
  timestamp: string;
  webhook_id: string;

  // FILE_VERSION_UPDATE
  file_key?: string;
  file_name?: string;
  version_id?: string;
  label?: string;
  description?: string;
  triggered_by?: { id: string; handle: string };

  // FILE_COMMENT
  comment?: Array<{
    id: string;
    text: string;
    user: { id: string; handle: string };
    created_at: string;
    parent_id?: string;
    file_key: string;
    file_name: string;
  }>;

  // LIBRARY_PUBLISH
  library_name?: string;
  created_components?: Array<{ key: string; name: string }>;
  modified_components?: Array<{ key: string; name: string }>;
  deleted_components?: Array<{ key: string; name: string }>;
  created_styles?: Array<{ key: string; name: string }>;
  modified_styles?: Array<{ key: string; name: string }>;
  deleted_styles?: Array<{ key: string; name: string }>;
}

export function normalizeWebhookEvent(
  payload: FigmaWebhookPayload
): OpenChiefEvent[] {
  const events: OpenChiefEvent[] = [];

  switch (payload.event_type) {
    case "FILE_VERSION_UPDATE": {
      const actor = payload.triggered_by?.handle || "unknown";
      const fileName = payload.file_name || "untitled";
      const label = payload.label || payload.description || "new version";
      events.push({
        id: generateULID(),
        timestamp: payload.timestamp,
        ingestedAt: new Date().toISOString(),
        source: "figma",
        eventType: "file.version_updated",
        scope: {
          org: "figma",
          project: fileName,
          actor,
        },
        payload: {
          fileKey: payload.file_key,
          fileName,
          versionId: payload.version_id,
          label: payload.label,
          description: payload.description,
          triggeredBy: payload.triggered_by,
        },
        summary: `${actor} saved a new version of "${fileName}": ${label}`,
        tags: inferTags("version", fileName, label),
      });
      break;
    }

    case "FILE_COMMENT": {
      if (payload.comment) {
        for (const c of payload.comment) {
          const isReply = !!c.parent_id;
          events.push({
            id: generateULID(),
            timestamp: c.created_at,
            ingestedAt: new Date().toISOString(),
            source: "figma",
            eventType: isReply ? "comment.replied" : "comment.created",
            scope: {
              org: "figma",
              project: c.file_name || payload.file_name || "untitled",
              actor: c.user.handle,
            },
            payload: {
              commentId: c.id,
              text: c.text,
              fileKey: c.file_key || payload.file_key,
              fileName: c.file_name || payload.file_name,
              parentId: c.parent_id,
              userId: c.user.id,
              userHandle: c.user.handle,
            },
            summary: `${c.user.handle} ${isReply ? "replied to a comment" : "commented"} on "${c.file_name || payload.file_name}": ${c.text.slice(0, 150)}`,
            tags: inferTags("comment", c.file_name || "", c.text),
          });
        }
      }
      break;
    }

    case "FILE_UPDATE": {
      // Fires after ~30 minutes of editing inactivity — debounced autosave notification
      // No triggered_by field in payload, so actor is unknown
      const fileName = payload.file_name || "untitled";
      events.push({
        id: generateULID(),
        timestamp: payload.timestamp,
        ingestedAt: new Date().toISOString(),
        source: "figma",
        eventType: "file.edited",
        scope: {
          org: "figma",
          project: fileName,
          actor: "unknown",
        },
        payload: {
          fileKey: payload.file_key,
          fileName,
        },
        summary: `"${fileName}" was updated`,
        tags: ["design-update", "autosave"],
      });
      break;
    }

    case "FILE_DELETE": {
      const actor = payload.triggered_by?.handle || "unknown";
      const fileName = payload.file_name || "untitled";
      events.push({
        id: generateULID(),
        timestamp: payload.timestamp,
        ingestedAt: new Date().toISOString(),
        source: "figma",
        eventType: "file.deleted",
        scope: {
          org: "figma",
          project: fileName,
          actor,
        },
        payload: {
          fileKey: payload.file_key,
          fileName,
        },
        summary: `${actor} deleted "${fileName}"`,
        tags: ["design-update"],
      });
      break;
    }

    case "LIBRARY_PUBLISH": {
      const actor = payload.triggered_by?.handle || "unknown";
      const libName = payload.library_name || payload.file_name || "untitled library";
      const created = [
        ...(payload.created_components || []),
        ...(payload.created_styles || []),
      ];
      const modified = [
        ...(payload.modified_components || []),
        ...(payload.modified_styles || []),
      ];
      const deleted = [
        ...(payload.deleted_components || []),
        ...(payload.deleted_styles || []),
      ];

      const parts: string[] = [];
      if (created.length) parts.push(`${created.length} added`);
      if (modified.length) parts.push(`${modified.length} modified`);
      if (deleted.length) parts.push(`${deleted.length} removed`);
      const changeSummary = parts.join(", ") || "no component changes";

      events.push({
        id: generateULID(),
        timestamp: payload.timestamp,
        ingestedAt: new Date().toISOString(),
        source: "figma",
        eventType: "library.published",
        scope: {
          org: "figma",
          project: libName,
          actor,
        },
        payload: {
          fileKey: payload.file_key,
          fileName: payload.file_name,
          libraryName: libName,
          createdComponents: payload.created_components,
          modifiedComponents: payload.modified_components,
          deletedComponents: payload.deleted_components,
          createdStyles: payload.created_styles,
          modifiedStyles: payload.modified_styles,
          deletedStyles: payload.deleted_styles,
        },
        summary: `${actor} published library "${libName}": ${changeSummary}`,
        tags: ["design-system", "library-publish"],
      });
      break;
    }
  }

  return events;
}

/**
 * Create a file activity event — tracks autosave-level edits detected
 * via last_modified changes. Includes who was recently in the file.
 */
export function createFileActivityEvent(opts: {
  fileKey: string;
  fileName: string;
  lastModified: string;
  editors: Array<{ id: string; handle: string }>;
}): OpenChiefEvent {
  const editorNames = opts.editors.map((e) => e.handle).join(", ") || "unknown";
  return {
    id: generateULID(),
    timestamp: opts.lastModified,
    ingestedAt: new Date().toISOString(),
    source: "figma",
    eventType: "file.edited",
    scope: {
      org: "figma",
      project: opts.fileName,
      actor: editorNames,
    },
    payload: {
      fileKey: opts.fileKey,
      fileName: opts.fileName,
      lastModified: opts.lastModified,
      editors: opts.editors,
    },
    summary: `${editorNames} was working on "${opts.fileName}"`,
    tags: ["design-update", "autosave"],
  };
}

function inferTags(type: string, fileName: string, text: string): string[] {
  const tags: string[] = [];
  const lower = (fileName + " " + text).toLowerCase();

  if (type === "version") tags.push("design-update");
  if (type === "comment") tags.push("design-feedback");

  if (lower.includes("component") || lower.includes("design system")) {
    tags.push("design-system");
  }
  if (lower.includes("icon")) tags.push("icons");
  if (lower.includes("prototype") || lower.includes("flow")) {
    tags.push("prototype");
  }
  if (lower.includes("review") || lower.includes("feedback")) {
    tags.push("design-review");
  }
  if (lower.includes("bug") || lower.includes("fix")) {
    tags.push("design-fix");
  }

  return [...new Set(tags)];
}
