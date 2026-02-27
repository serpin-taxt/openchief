/**
 * JSM poller — fetches recently updated service desk requests, transitions,
 * comments, SLA breaches, and CSAT feedback using the Jira REST API v3 +
 * JSM-specific service desk API.
 *
 * Runs on a cron schedule (every 15 min) and uses a KV-stored cursor to only
 * fetch new data on subsequent runs.
 */

import { createJsmClient } from "./jsm-api";
import type { JsmClient, JsmRequest } from "./jsm-api";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PollEnv {
  EVENTS_QUEUE: Queue;
  JSM_API_TOKEN: string;
  JSM_API_EMAIL: string;
  JSM_INSTANCE_URL: string;
  JSM_PROJECTS?: string; // comma-separated project keys
  POLL_CURSOR: KVNamespace;
}

export interface PollResult {
  requests: number;
  transitions: number;
  comments: number;
  breaches: number;
  csats: number;
  total: number;
}

const CURSOR_KEY = "jsm:last-poll";
const DEFAULT_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

// ─── Main Poll ───────────────────────────────────────────────────────────────

export async function runPoll(env: PollEnv): Promise<PollResult> {
  const client = createJsmClient(
    env.JSM_INSTANCE_URL,
    env.JSM_API_EMAIL,
    env.JSM_API_TOKEN,
  );

  const lastPoll = await env.POLL_CURSOR.get(CURSOR_KEY);
  const since = lastPoll || new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  const now = new Date().toISOString();

  console.log(`Polling JSM since ${since}`);

  const result = await pollRequests(client, env, since);

  // Update cursor
  await env.POLL_CURSOR.put(CURSOR_KEY, now);

  console.log(
    `JSM poll complete: ${result.total} events ` +
      `(${result.requests} requests, ${result.transitions} transitions, ` +
      `${result.comments} comments, ${result.breaches} breaches, ${result.csats} CSATs)`,
  );

  return result;
}

// ─── Request Polling ─────────────────────────────────────────────────────────

async function pollRequests(
  client: JsmClient,
  env: PollEnv,
  since: string,
): Promise<PollResult> {
  const {
    normalizeRequest,
    normalizeTransitions,
    normalizeComments,
    normalizeSLABreach,
    normalizeCSAT,
  } = await import("./normalize");

  // Build JQL: service desk issue types updated since last poll
  const sinceDate = since.slice(0, 16).replace("T", " ");
  const projects = parseProjects(env.JSM_PROJECTS);

  // JSM request types typically include "Service Request", "[System] Service request",
  // "Incident", "Problem", "Change", etc. We catch all by filtering on project type.
  let jql = `updated >= "${sinceDate}"`;
  if (projects.length > 0) {
    jql += ` AND project IN (${projects.map((p) => `"${p}"`).join(",")})`;
  }
  jql += " ORDER BY updated DESC";

  let requestCount = 0;
  let transitionCount = 0;
  let commentCount = 0;
  let breachCount = 0;
  let csatCount = 0;
  let startAt = 0;
  const maxPages = 10;

  // Load known SLA breaches from KV to avoid re-emitting
  const knownBreaches = await loadKnownBreaches(env.POLL_CURSOR);

  for (let page = 0; page < maxPages; page++) {
    const result = await client.searchRequests(jql, { startAt, maxResults: 50 });

    for (const request of result.issues) {
      // Emit request created/updated event
      const requestEvent = normalizeRequest(request, since);
      await env.EVENTS_QUEUE.send(requestEvent);
      requestCount++;

      // Emit transition events from changelog
      const transitions = normalizeTransitions(request, since);
      for (const t of transitions) {
        await env.EVENTS_QUEUE.send(t);
        transitionCount++;
      }

      // Emit comment events
      const comments = normalizeComments(request, since);
      for (const c of comments) {
        await env.EVENTS_QUEUE.send(c);
        commentCount++;
      }

      // Check SLA breaches (rate-limited — only for active/open requests)
      if (request.fields.status.statusCategory?.key !== "done") {
        try {
          const slaRecords = await client.getRequestSLAs(request.key);
          const breachEvents = normalizeSLABreach(request, slaRecords, knownBreaches);
          for (const b of breachEvents) {
            await env.EVENTS_QUEUE.send(b);
            knownBreaches.add(`${request.key}:${b.payload?.sla_name || ""}`);
            breachCount++;
          }
        } catch (err) {
          // SLA API may not be available — skip silently
          console.warn(`SLA check failed for ${request.key}: ${err instanceof Error ? err.message : err}`);
        }

        await delay(200); // Rate limit SLA calls
      }

      // Check CSAT for resolved requests
      if (request.fields.resolution) {
        try {
          const feedback = await client.getCSATFeedback(request.key);
          if (feedback) {
            const csatKey = `jsm:csat:${request.key}`;
            const alreadySeen = await env.POLL_CURSOR.get(csatKey);
            if (!alreadySeen) {
              const csatEvent = normalizeCSAT(request, feedback);
              await env.EVENTS_QUEUE.send(csatEvent);
              await env.POLL_CURSOR.put(csatKey, "1", { expirationTtl: 86400 * 90 });
              csatCount++;
            }
          }
        } catch (err) {
          console.warn(`CSAT check failed for ${request.key}: ${err instanceof Error ? err.message : err}`);
        }

        await delay(200);
      }
    }

    // Check if there are more pages
    if (startAt + result.issues.length >= result.total) break;
    startAt += 50;

    await delay(300);
  }

  // Persist known breaches to KV
  await saveKnownBreaches(env.POLL_CURSOR, knownBreaches);

  return {
    requests: requestCount,
    transitions: transitionCount,
    comments: commentCount,
    breaches: breachCount,
    csats: csatCount,
    total: requestCount + transitionCount + commentCount + breachCount + csatCount,
  };
}

// ─── Backfill ────────────────────────────────────────────────────────────────

export async function runBackfill(
  env: PollEnv,
  days: number,
): Promise<PollResult> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const client = createJsmClient(
    env.JSM_INSTANCE_URL,
    env.JSM_API_EMAIL,
    env.JSM_API_TOKEN,
  );

  console.log(`Backfilling JSM for ${days} days (since ${since})`);
  const result = await pollRequests(client, env, since);

  await env.POLL_CURSOR.put(CURSOR_KEY, new Date().toISOString());
  return result;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseProjects(projectsStr?: string): string[] {
  if (!projectsStr) return [];
  return projectsStr.split(",").map((p) => p.trim()).filter(Boolean);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BREACHES_KEY = "jsm:known-breaches";

async function loadKnownBreaches(kv: KVNamespace): Promise<Set<string>> {
  const raw = await kv.get(BREACHES_KEY);
  if (!raw) return new Set();
  try {
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

async function saveKnownBreaches(kv: KVNamespace, breaches: Set<string>): Promise<void> {
  // Keep only the last 1000 breach keys to prevent unbounded growth
  const arr = [...breaches].slice(-1000);
  await kv.put(BREACHES_KEY, JSON.stringify(arr), { expirationTtl: 86400 * 90 });
}
