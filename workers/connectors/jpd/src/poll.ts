/**
 * JPD poller — fetches recently updated ideas, status changes, and comments.
 *
 * JPD ideas are Jira issues of type "Idea" within JPD projects.
 * We use standard JQL search with issuetype filter + changelog expansion.
 */

import { createJpdClient } from "./jpd-api";
import type { JpdClient } from "./jpd-api";

export interface PollEnv {
  EVENTS_QUEUE: Queue;
  JPD_API_TOKEN: string;
  JPD_API_EMAIL: string;
  JPD_INSTANCE_URL: string;
  JPD_PROJECTS?: string; // comma-separated project keys
  JPD_EVENT_TYPES?: string; // comma-separated: "ideas,changes,comments" (all if unset)
  POLL_CURSOR: KVNamespace;
}

export interface PollResult {
  ideas: number;
  statusChanges: number;
  comments: number;
  total: number;
}

const CURSOR_KEY = "jpd:last-poll";
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

export async function runPoll(env: PollEnv): Promise<PollResult> {
  const client = createJpdClient(
    env.JPD_INSTANCE_URL,
    env.JPD_API_EMAIL,
    env.JPD_API_TOKEN
  );

  const lastPoll = await env.POLL_CURSOR.get(CURSOR_KEY);
  const since = lastPoll || new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  const now = new Date().toISOString();

  console.log(`Polling JPD since ${since}`);

  const enabledTypes = parseEventTypes(env.JPD_EVENT_TYPES);
  const result = await pollIdeas(client, env, since, enabledTypes);

  // Update cursor
  await env.POLL_CURSOR.put(CURSOR_KEY, now);

  console.log(
    `JPD poll complete: ${result.total} events ` +
      `(${result.ideas} ideas, ${result.statusChanges} status changes, ${result.comments} comments)`
  );

  return result;
}

async function pollIdeas(
  client: JpdClient,
  env: PollEnv,
  since: string,
  enabledTypes: Set<string>,
): Promise<PollResult> {
  const { normalizeIdea, normalizeIdeaChanges, normalizeIdeaComments } = await import("./normalize");

  // Build JQL to find JPD ideas updated since last poll.
  // Subtract 12h overlap because Jira JQL interprets dates in the user's
  // timezone, but our cursor is stored as UTC. Router deduplicates via ULID.
  const sinceMs = new Date(since).getTime() - 12 * 60 * 60 * 1000;
  const sinceDate = new Date(sinceMs).toISOString().slice(0, 16).replace("T", " ");
  const projects = parseProjects(env.JPD_PROJECTS);

  let jql = `issuetype = Idea AND updated >= "${sinceDate}"`;
  if (projects.length > 0) {
    jql += ` AND project IN (${projects.map((p) => `"${p}"`).join(",")})`;
  }
  jql += " ORDER BY updated DESC";

  let ideaCount = 0;
  let statusChangeCount = 0;
  let commentCount = 0;
  let startAt = 0;
  const maxPages = 10;

  for (let page = 0; page < maxPages; page++) {
    const result = await client.searchIdeas(jql, { startAt, maxResults: 50 });

    for (const idea of result.issues) {
      // Emit idea created/updated event
      if (enabledTypes.has("ideas")) {
        const ideaEvent = normalizeIdea(idea, since);
        await env.EVENTS_QUEUE.send(ideaEvent);
        ideaCount++;
      }

      // Emit status and field change events from changelog
      if (enabledTypes.has("changes")) {
        const changes = normalizeIdeaChanges(idea, since);
        for (const c of changes) {
          await env.EVENTS_QUEUE.send(c);
          statusChangeCount++;
        }
      }

      // Emit comment events
      if (enabledTypes.has("comments")) {
        const comments = normalizeIdeaComments(idea, since);
        for (const c of comments) {
          await env.EVENTS_QUEUE.send(c);
          commentCount++;
        }
      }
    }

    if (startAt + result.issues.length >= result.total) break;
    startAt += result.maxResults;

    await delay(300);
  }

  return {
    ideas: ideaCount,
    statusChanges: statusChangeCount,
    comments: commentCount,
    total: ideaCount + statusChangeCount + commentCount,
  };
}

export async function runBackfill(
  env: PollEnv,
  days: number
): Promise<PollResult> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const client = createJpdClient(
    env.JPD_INSTANCE_URL,
    env.JPD_API_EMAIL,
    env.JPD_API_TOKEN
  );

  console.log(`Backfilling JPD for ${days} days (since ${since})`);
  const enabledTypes = parseEventTypes(env.JPD_EVENT_TYPES);
  const result = await pollIdeas(client, env, since, enabledTypes);

  await env.POLL_CURSOR.put(CURSOR_KEY, new Date().toISOString());
  return result;
}

const ALL_EVENT_TYPES = new Set(["ideas", "changes", "comments"]);

function parseEventTypes(typesStr?: string): Set<string> {
  if (!typesStr) return ALL_EVENT_TYPES;
  const parsed = new Set(
    typesStr.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
  );
  return parsed.size > 0 ? parsed : ALL_EVENT_TYPES;
}

function parseProjects(projectsStr?: string): string[] {
  if (!projectsStr) return [];
  return projectsStr.split(",").map((p) => p.trim()).filter(Boolean);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
