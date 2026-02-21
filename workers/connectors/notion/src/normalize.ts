import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";
import type { NotionPage, NotionDatabase, NotionComment } from "./poll";

/**
 * Normalize Notion API objects into OpenChiefEvents.
 */

// --- Pages -------------------------------------------------------------------

export function normalizePages(pages: NotionPage[]): OpenChiefEvent[] {
  const now = new Date().toISOString();

  return pages.map((page) => {
    const title = extractPageTitle(page);
    const isNew = isRecentlyCreated(page.created_time, page.last_edited_time);
    const eventType = isNew ? "page.created" : "page.updated";
    const parentInfo = describeParent(page.parent);

    const summary = isNew
      ? `New Notion page "${title}" created${parentInfo ? ` in ${parentInfo}` : ""}`
      : `Notion page "${title}" updated${parentInfo ? ` in ${parentInfo}` : ""}`;

    return {
      id: generateULID(),
      timestamp: page.last_edited_time,
      ingestedAt: now,
      source: "notion",
      eventType,
      scope: {
        project: parentInfo || undefined,
        actor: page.last_edited_by?.id,
      },
      payload: slimPagePayload(page, title),
      summary,
    };
  });
}

// --- Database Entries --------------------------------------------------------

export function normalizeDatabaseEntries(
  database: NotionDatabase,
  entries: NotionPage[]
): OpenChiefEvent[] {
  const now = new Date().toISOString();
  const dbTitle = database.title?.map((t) => t.plain_text).join("") || "Untitled database";

  return entries.map((entry) => {
    const title = extractPageTitle(entry);
    const isNew = isRecentlyCreated(entry.created_time, entry.last_edited_time);
    const eventType = isNew ? "database.entry.created" : "database.entry.updated";

    const props = extractKeyProperties(entry.properties);
    const propsStr = props.length > 0 ? ` [${props.join(", ")}]` : "";

    const summary = isNew
      ? `New entry "${title}" added to database "${dbTitle}"${propsStr}`
      : `Entry "${title}" updated in database "${dbTitle}"${propsStr}`;

    return {
      id: generateULID(),
      timestamp: entry.last_edited_time,
      ingestedAt: now,
      source: "notion",
      eventType,
      scope: {
        project: dbTitle,
        actor: entry.last_edited_by?.id,
      },
      payload: {
        ...slimPagePayload(entry, title),
        database_id: database.id,
        database_title: dbTitle,
        key_properties: props,
      },
      summary,
      tags: extractTags(entry.properties),
    };
  });
}

// --- Comments ----------------------------------------------------------------

export function normalizeComments(comments: NotionComment[]): OpenChiefEvent[] {
  const now = new Date().toISOString();

  return comments.map((comment) => {
    const text = comment.rich_text?.map((t) => t.plain_text).join("") || "";
    const preview = text.slice(0, 200);
    const parentId =
      comment.parent.type === "page_id"
        ? comment.parent.page_id
        : comment.parent.block_id;

    return {
      id: generateULID(),
      timestamp: comment.created_time,
      ingestedAt: now,
      source: "notion",
      eventType: "comment.created",
      scope: {
        actor: comment.created_by?.id,
      },
      payload: {
        comment_id: comment.id,
        discussion_id: comment.discussion_id,
        parent_type: comment.parent.type,
        parent_id: parentId,
        text_preview: preview,
        text_length: text.length,
        word_count: text.split(/\s+/).filter(Boolean).length,
        created_time: comment.created_time,
      },
      summary: `Comment on Notion page: "${preview.slice(0, 100)}${text.length > 100 ? "..." : ""}"`,
    };
  });
}

// --- Helpers -----------------------------------------------------------------

/**
 * Extract the page title from properties. Notion pages can have a "title"
 * property with various names (Name, Title, etc.)
 */
function extractPageTitle(page: NotionPage): string {
  const props = page.properties || {};

  for (const [, value] of Object.entries(props)) {
    const prop = value as Record<string, unknown>;
    if (prop.type === "title") {
      const titleArray = prop.title as Array<{ plain_text: string }> | undefined;
      if (titleArray && titleArray.length > 0) {
        return titleArray.map((t) => t.plain_text).join("");
      }
    }
  }

  return "Untitled";
}

/**
 * Determine if a page was recently created (within 2 minutes of last edit).
 * This heuristic catches pages that were just created and possibly immediately
 * edited, treating them as "created" events.
 */
function isRecentlyCreated(createdTime: string, lastEditedTime: string): boolean {
  const created = new Date(createdTime).getTime();
  const edited = new Date(lastEditedTime).getTime();
  return edited - created < 2 * 60 * 1000; // within 2 minutes
}

/**
 * Describe the parent of a page (database name, page, or workspace).
 */
function describeParent(
  parent:
    | { type: "database_id"; database_id: string }
    | { type: "page_id"; page_id: string }
    | { type: "workspace"; workspace: true }
): string | null {
  if (parent.type === "database_id") return `database:${parent.database_id.slice(0, 8)}`;
  if (parent.type === "page_id") return `page:${parent.page_id.slice(0, 8)}`;
  return null;
}

/**
 * Slim down a page payload to essential fields to stay under queue size limits.
 */
function slimPagePayload(
  page: NotionPage,
  title: string
): Record<string, unknown> {
  return {
    page_id: page.id,
    title,
    url: page.url,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    created_by: page.created_by?.id,
    last_edited_by: page.last_edited_by?.id,
    parent_type: page.parent?.type,
  };
}

/**
 * Extract key readable properties from a Notion page (status, select, date, etc.)
 * Returns an array of "key: value" strings.
 */
function extractKeyProperties(properties: Record<string, unknown>): string[] {
  const results: string[] = [];

  for (const [key, value] of Object.entries(properties)) {
    const prop = value as Record<string, unknown>;

    switch (prop.type) {
      case "status": {
        const status = prop.status as { name: string } | null;
        if (status?.name) results.push(`${key}: ${status.name}`);
        break;
      }
      case "select": {
        const select = prop.select as { name: string } | null;
        if (select?.name) results.push(`${key}: ${select.name}`);
        break;
      }
      case "multi_select": {
        const multi = prop.multi_select as Array<{ name: string }> | null;
        if (multi && multi.length > 0) {
          results.push(`${key}: ${multi.map((m) => m.name).join(", ")}`);
        }
        break;
      }
      case "date": {
        const date = prop.date as { start: string; end?: string } | null;
        if (date?.start) {
          results.push(`${key}: ${date.start}${date.end ? ` → ${date.end}` : ""}`);
        }
        break;
      }
      case "people": {
        const people = prop.people as Array<{ id: string; name?: string }> | null;
        if (people && people.length > 0) {
          results.push(`${key}: ${people.map((p) => p.name || p.id).join(", ")}`);
        }
        break;
      }
      case "checkbox": {
        if (prop.checkbox === true) results.push(`${key}: true`);
        break;
      }
      case "number": {
        if (prop.number != null) results.push(`${key}: ${prop.number}`);
        break;
      }
    }
  }

  return results;
}

/**
 * Extract tags from page properties (status values, select values).
 */
function extractTags(properties: Record<string, unknown>): string[] | undefined {
  const tags: string[] = [];

  for (const [, value] of Object.entries(properties)) {
    const prop = value as Record<string, unknown>;

    if (prop.type === "status") {
      const status = prop.status as { name: string } | null;
      if (status?.name) tags.push(status.name.toLowerCase().replace(/\s+/g, "-"));
    }
    if (prop.type === "multi_select") {
      const multi = prop.multi_select as Array<{ name: string }> | null;
      if (multi) {
        for (const m of multi) {
          tags.push(m.name.toLowerCase().replace(/\s+/g, "-"));
        }
      }
    }
  }

  return tags.length > 0 ? tags : undefined;
}
