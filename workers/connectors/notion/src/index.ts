import { pollPages, pollDatabaseEntries, pollComments } from "./poll";
import { normalizePages, normalizeDatabaseEntries, normalizeComments } from "./normalize";
import type { OpenChiefEvent } from "@openchief/shared";

interface Env {
  EVENTS_QUEUE: Queue;
  NOTION_API_KEY: string;
  POLL_CURSOR: KVNamespace;
  ADMIN_SECRET: string;
}

const CURSOR_KEY = "notion:last-poll";

// Default lookback on first run: 30 days
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

function requireAdmin(request: Request, env: Env): Response | null {
  const auth = request.headers.get("Authorization");
  if (!env.ADMIN_SECRET || auth !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

async function runPoll(env: Env): Promise<{
  pages: number;
  databaseEntries: number;
  comments: number;
  total: number;
}> {
  const lastPoll = await env.POLL_CURSOR.get(CURSOR_KEY);
  const since =
    lastPoll || new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  const now = new Date().toISOString();

  console.log(`Polling Notion since ${since}`);

  const allEvents: OpenChiefEvent[] = [];

  // 1. Poll pages
  const pages = await pollPages(env.NOTION_API_KEY, since);
  const pageEvents = normalizePages(pages);
  allEvents.push(...pageEvents);

  // 2. Poll database entries
  const dbResults = await pollDatabaseEntries(env.NOTION_API_KEY, since);
  let dbEntryCount = 0;
  for (const { database, entries } of dbResults) {
    // Filter out entries that were already captured as top-level pages
    // (Notion database entries are also pages, so we dedupe by ID)
    const pageIds = new Set(pages.map((p) => p.id));
    const uniqueEntries = entries.filter((e) => !pageIds.has(e.id));

    const entryEvents = normalizeDatabaseEntries(database, uniqueEntries);
    allEvents.push(...entryEvents);
    dbEntryCount += uniqueEntries.length;
  }

  // 3. Poll comments on recently changed pages
  const recentPageIds = pages.map((p) => p.id);
  const comments = await pollComments(env.NOTION_API_KEY, recentPageIds, since);
  const commentEvents = normalizeComments(comments);
  allEvents.push(...commentEvents);

  // 4. Enqueue all events
  for (const event of allEvents) {
    await env.EVENTS_QUEUE.send(event);
  }

  // 5. Update cursor
  await env.POLL_CURSOR.put(CURSOR_KEY, now);

  console.log(
    `Notion poll complete: ${allEvents.length} events (${pageEvents.length} pages, ${dbEntryCount} db entries, ${commentEvents.length} comments)`
  );

  return {
    pages: pageEvents.length,
    databaseEntries: dbEntryCount,
    comments: commentEvents.length,
    total: allEvents.length,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // POST /poll — manual trigger (admin only)
    if (url.pathname === "/poll" && request.method === "POST") {
      const denied = requireAdmin(request, env);
      if (denied) return denied;
      try {
        const results = await runPoll(env);
        return new Response(JSON.stringify({ ok: true, results }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Poll failed";
        return new Response(JSON.stringify({ ok: false, error: msg }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, connector: "notion" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  },

  // Scheduled handler — polls Notion API every 15 minutes
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    try {
      const results = await runPoll(env);
      console.log("Notion scheduled poll:", JSON.stringify(results));
    } catch (err) {
      console.error(
        "Notion poll failed:",
        err instanceof Error ? err.message : err
      );
    }
  },
};
