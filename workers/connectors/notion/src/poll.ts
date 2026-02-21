/**
 * Notion API poller — fetches recently created/updated pages, database entries,
 * and comments using the Notion API (v2022-06-28).
 *
 * Runs on a cron schedule (every 15 min) and uses a KV-stored cursor to only
 * fetch new data on subsequent runs.
 */

const NOTION_API_BASE = "https://api.notion.com/v1";
const NOTION_API_VERSION = "2022-06-28";

// --- Types -------------------------------------------------------------------

export interface NotionPage {
  id: string;
  object: "page";
  created_time: string;
  last_edited_time: string;
  created_by: { id: string };
  last_edited_by: { id: string };
  parent:
    | { type: "database_id"; database_id: string }
    | { type: "page_id"; page_id: string }
    | { type: "workspace"; workspace: true };
  url: string;
  properties: Record<string, unknown>;
  icon?: { type: string; emoji?: string } | null;
  cover?: unknown;
}

export interface NotionDatabase {
  id: string;
  object: "database";
  created_time: string;
  last_edited_time: string;
  title: Array<{ plain_text: string }>;
  url: string;
  parent:
    | { type: "page_id"; page_id: string }
    | { type: "workspace"; workspace: true };
}

export interface NotionComment {
  id: string;
  object: "comment";
  parent: { type: "page_id"; page_id: string } | { type: "block_id"; block_id: string };
  discussion_id: string;
  created_time: string;
  last_edited_time: string;
  created_by: { id: string };
  rich_text: Array<{ plain_text: string }>;
}

// --- Notion API helpers ------------------------------------------------------

async function notionFetch<T>(
  path: string,
  apiKey: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${NOTION_API_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_API_VERSION,
      "Content-Type": "application/json",
      "User-Agent": "openchief-connector-notion",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Notion API ${res.status}: ${text.slice(0, 300)}`);
  }

  return res.json() as Promise<T>;
}

// --- Poll Functions ----------------------------------------------------------

/**
 * Search for all pages the integration can access, filtered to those updated
 * after `since`. Returns up to ~100 pages per call (paginated).
 */
export async function pollPages(
  apiKey: string,
  since: string
): Promise<NotionPage[]> {
  const pages: NotionPage[] = [];
  let startCursor: string | undefined;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore && pageCount < 5) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100,
    };
    if (startCursor) body.start_cursor = startCursor;

    const result = await notionFetch<{
      results: NotionPage[];
      has_more: boolean;
      next_cursor: string | null;
    }>("/search", apiKey, { method: "POST", body });

    // Filter to only pages updated after our cursor
    for (const page of result.results) {
      if (page.last_edited_time >= since) {
        pages.push(page);
      } else {
        // Results are sorted desc by last_edited_time, so we can stop early
        hasMore = false;
        break;
      }
    }

    if (hasMore) {
      hasMore = result.has_more;
      startCursor = result.next_cursor || undefined;
    }
    pageCount++;
  }

  return pages;
}

/**
 * Find all databases the integration can access, then query each for entries
 * updated after `since`.
 */
export async function pollDatabaseEntries(
  apiKey: string,
  since: string
): Promise<{ database: NotionDatabase; entries: NotionPage[] }[]> {
  // Step 1: Search for all databases
  const databases: NotionDatabase[] = [];
  let startCursor: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const body: Record<string, unknown> = {
      filter: { property: "object", value: "database" },
      page_size: 100,
    };
    if (startCursor) body.start_cursor = startCursor;

    const result = await notionFetch<{
      results: NotionDatabase[];
      has_more: boolean;
      next_cursor: string | null;
    }>("/search", apiKey, { method: "POST", body });

    databases.push(...result.results);
    hasMore = result.has_more;
    startCursor = result.next_cursor || undefined;
  }

  // Step 2: Query each database for recently updated entries
  const results: { database: NotionDatabase; entries: NotionPage[] }[] = [];

  for (const db of databases) {
    try {
      const entries = await queryDatabaseEntries(apiKey, db.id, since);
      if (entries.length > 0) {
        results.push({ database: db, entries });
      }
    } catch (err) {
      // Some databases may have restricted access — skip gracefully
      console.error(
        `Failed to query database ${db.id}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  return results;
}

async function queryDatabaseEntries(
  apiKey: string,
  databaseId: string,
  since: string
): Promise<NotionPage[]> {
  const entries: NotionPage[] = [];
  let startCursor: string | undefined;
  let hasMore = true;
  let pageCount = 0;

  while (hasMore && pageCount < 3) {
    const body: Record<string, unknown> = {
      filter: {
        timestamp: "last_edited_time",
        last_edited_time: { on_or_after: since },
      },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 100,
    };
    if (startCursor) body.start_cursor = startCursor;

    const result = await notionFetch<{
      results: NotionPage[];
      has_more: boolean;
      next_cursor: string | null;
    }>(`/databases/${databaseId}/query`, apiKey, { method: "POST", body });

    entries.push(...result.results);
    hasMore = result.has_more;
    startCursor = result.next_cursor || undefined;
    pageCount++;
  }

  return entries;
}

/**
 * Fetch comments on recently changed pages.
 * Notion's GET /comments endpoint requires a block_id (page ID).
 * We only check pages that were updated in this poll cycle.
 */
export async function pollComments(
  apiKey: string,
  pageIds: string[],
  since: string
): Promise<NotionComment[]> {
  const allComments: NotionComment[] = [];

  // Limit to 20 pages to control API usage
  const pagesToCheck = pageIds.slice(0, 20);

  for (const pageId of pagesToCheck) {
    try {
      let startCursor: string | undefined;
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({ block_id: pageId, page_size: "100" });
        if (startCursor) params.set("start_cursor", startCursor);

        const result = await notionFetch<{
          results: NotionComment[];
          has_more: boolean;
          next_cursor: string | null;
        }>(`/comments?${params}`, apiKey);

        // Filter to comments created after our cursor
        const recent = result.results.filter((c) => c.created_time >= since);
        allComments.push(...recent);

        hasMore = result.has_more;
        startCursor = result.next_cursor || undefined;
      }
    } catch (err) {
      // Some pages may not support comments — skip gracefully
      console.error(
        `Failed to fetch comments for page ${pageId}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  return allComments;
}
