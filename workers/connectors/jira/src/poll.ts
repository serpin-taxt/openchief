/**
 * Jira Cloud poller — fetches recently updated issues, transitions, comments,
 * and sprint events using the Jira REST API v3 + Agile API.
 *
 * Runs on a cron schedule (every 15 min) and uses a KV-stored cursor to only
 * fetch new data on subsequent runs.
 */

import { createJiraClient } from "./jira-api";
import type { JiraClient, JiraIssue, JiraSprint } from "./jira-api";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PollEnv {
  EVENTS_QUEUE: Queue;
  JIRA_API_TOKEN: string;
  JIRA_API_EMAIL: string;
  JIRA_INSTANCE_URL: string;
  JIRA_PROJECTS?: string; // comma-separated project keys, e.g. "PROJ1,PROJ2"
  POLL_CURSOR: KVNamespace;
}

export interface PollResult {
  issues: number;
  transitions: number;
  comments: number;
  sprints: number;
  total: number;
}

const CURSOR_KEY = "jira:last-poll";

// Default lookback on first run: 30 days
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Main Poll ──────────────────────────────────────────────────────────────

export async function runPoll(env: PollEnv): Promise<PollResult> {
  const client = createJiraClient(
    env.JIRA_INSTANCE_URL,
    env.JIRA_API_EMAIL,
    env.JIRA_API_TOKEN
  );

  const lastPoll = await env.POLL_CURSOR.get(CURSOR_KEY);
  const since = lastPoll || new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  const now = new Date().toISOString();

  console.log(`Polling Jira since ${since}`);

  const result: PollResult = { issues: 0, transitions: 0, comments: 0, sprints: 0, total: 0 };

  // 1. Poll recently updated issues (includes changelog for transitions)
  const issueEvents = await pollIssues(client, env, since);
  result.issues = issueEvents.issueCount;
  result.transitions = issueEvents.transitionCount;
  result.comments = issueEvents.commentCount;

  // 2. Poll sprint changes
  const sprintCount = await pollSprints(client, env, since);
  result.sprints = sprintCount;

  result.total = result.issues + result.transitions + result.comments + result.sprints;

  // Update cursor
  await env.POLL_CURSOR.put(CURSOR_KEY, now);

  console.log(
    `Jira poll complete: ${result.total} events ` +
      `(${result.issues} issues, ${result.transitions} transitions, ` +
      `${result.comments} comments, ${result.sprints} sprints)`
  );

  return result;
}

// ─── Issue Polling ──────────────────────────────────────────────────────────

async function pollIssues(
  client: JiraClient,
  env: PollEnv,
  since: string
): Promise<{ issueCount: number; transitionCount: number; commentCount: number }> {
  const { normalizeIssue, normalizeTransitions, normalizeComments } = await import("./normalize");

  // Build JQL: updated since last poll, optionally filtered by projects
  const sinceDate = since.slice(0, 16).replace("T", " "); // "2026-02-18 12:00"
  const projects = parseProjects(env.JIRA_PROJECTS);
  let jql = `updated >= "${sinceDate}"`;
  if (projects.length > 0) {
    jql += ` AND project IN (${projects.map((p) => `"${p}"`).join(",")})`;
  }
  jql += " ORDER BY updated DESC";

  let issueCount = 0;
  let transitionCount = 0;
  let commentCount = 0;
  let startAt = 0;
  const maxPages = 10;

  for (let page = 0; page < maxPages; page++) {
    const result = await client.searchIssues(jql, { startAt, maxResults: 50 });

    for (const issue of result.issues) {
      // Emit issue created/updated event
      const issueEvent = normalizeIssue(issue, since);
      await env.EVENTS_QUEUE.send(issueEvent);
      issueCount++;

      // Emit transition events from changelog
      const transitions = normalizeTransitions(issue, since);
      for (const t of transitions) {
        await env.EVENTS_QUEUE.send(t);
        transitionCount++;
      }

      // Emit comment events
      const comments = normalizeComments(issue, since);
      for (const c of comments) {
        await env.EVENTS_QUEUE.send(c);
        commentCount++;
      }
    }

    // Check if there are more pages
    if (startAt + result.issues.length >= result.total) break;
    startAt += result.maxResults;

    // Rate limit
    await delay(300);
  }

  return { issueCount, transitionCount, commentCount };
}

// ─── Sprint Polling ─────────────────────────────────────────────────────────

async function pollSprints(
  client: JiraClient,
  env: PollEnv,
  since: string
): Promise<number> {
  const { normalizeSprint } = await import("./normalize");
  const projects = parseProjects(env.JIRA_PROJECTS);
  let sprintCount = 0;

  try {
    // Get boards for each project (or all boards if no projects specified)
    const boards = projects.length > 0
      ? (await Promise.all(projects.map((p) => client.getBoards(p)))).flat()
      : await client.getBoards();

    // Dedupe boards by ID
    const seenBoards = new Set<number>();
    const uniqueBoards = boards.filter((b) => {
      if (seenBoards.has(b.id)) return false;
      seenBoards.add(b.id);
      return true;
    });

    for (const board of uniqueBoards) {
      try {
        // Get active + recently closed sprints
        const [activeSprints, closedSprints] = await Promise.all([
          client.getSprints(board.id, "active"),
          client.getSprints(board.id, "closed"),
        ]);

        const allSprints = [...activeSprints, ...closedSprints];

        // Check sprint state changes by comparing with stored state
        for (const sprint of allSprints) {
          const stateKey = `jira:sprint-state:${sprint.id}`;
          const storedState = await env.POLL_CURSOR.get(stateKey);

          if (storedState !== sprint.state) {
            // Sprint state changed (or first time seeing this sprint)
            if (storedState) {
              // Only emit event if state actually changed (not first discovery)
              const event = normalizeSprint(sprint, board, storedState);
              await env.EVENTS_QUEUE.send(event);
              sprintCount++;
            }
            await env.POLL_CURSOR.put(stateKey, sprint.state, {
              expirationTtl: 86400 * 90, // 90 days
            });
          }
        }
      } catch (err) {
        // Some boards may not support sprints (Kanban boards)
        console.warn(
          `Skipping sprints for board ${board.id} (${board.name}): ${err instanceof Error ? err.message : err}`
        );
      }

      await delay(200);
    }
  } catch (err) {
    console.error(
      `Sprint polling failed: ${err instanceof Error ? err.message : err}`
    );
  }

  return sprintCount;
}

// ─── Backfill ───────────────────────────────────────────────────────────────

export async function runBackfill(
  env: PollEnv,
  days: number
): Promise<PollResult> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const client = createJiraClient(
    env.JIRA_INSTANCE_URL,
    env.JIRA_API_EMAIL,
    env.JIRA_API_TOKEN
  );

  console.log(`Backfilling Jira for ${days} days (since ${since})`);

  const result: PollResult = { issues: 0, transitions: 0, comments: 0, sprints: 0, total: 0 };
  const issueEvents = await pollIssues(client, env, since);
  result.issues = issueEvents.issueCount;
  result.transitions = issueEvents.transitionCount;
  result.comments = issueEvents.commentCount;
  result.total = result.issues + result.transitions + result.comments;

  // Update cursor so regular poll doesn't re-fetch
  await env.POLL_CURSOR.put(CURSOR_KEY, new Date().toISOString());

  return result;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function parseProjects(projectsStr?: string): string[] {
  if (!projectsStr) return [];
  return projectsStr
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
