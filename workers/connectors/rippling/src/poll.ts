/**
 * Snapshot-based polling for Rippling HRIS data.
 *
 * On each poll:
 * 1. Fetch current employee roster + departments from Rippling API
 * 2. Compare against last snapshot stored in KV
 * 3. Emit change events (new hires, departures, title/dept/manager changes)
 * 4. Store new snapshot for next poll
 *
 * Time-off and payroll use cursor-based polling (updated_at > last poll).
 */

import type { OpenChiefEvent } from "@openchief/shared";
import { RipplingClient } from "./rippling-client";
import {
  type WorkerSnapshot,
  workerToSnapshot,
  diffWorkerSnapshots,
  diffDepartments,
  normalizeLeaveRequests,
  normalizeLeaveBalanceLowAlerts,
  normalizePayRuns,
} from "./normalize";

// --- KV Keys ---

const KV_WORKERS_SNAPSHOT = "rippling:snapshot:workers";
const KV_DEPARTMENTS_SNAPSHOT = "rippling:snapshot:departments";
const KV_LEAVE_CURSOR = "rippling:cursor:leave";
const KV_PAYROLL_CURSOR = "rippling:cursor:payroll";

const LOW_PTO_THRESHOLD_DAYS = 3;

// --- Poll Result ---

export interface PollResult {
  workers: { fetched: number; events: number };
  departments: { fetched: number; events: number };
  leave: { fetched: number; events: number };
  payroll: { fetched: number; events: number };
  totalEvents: number;
}

// --- Main Poll Function ---

export async function pollRippling(
  env: {
    KV: KVNamespace;
    EVENTS_QUEUE: Queue;
    RIPPLING_API_TOKEN: string;
  },
  options?: { backfill?: boolean }
): Promise<PollResult> {
  const client = new RipplingClient(env.RIPPLING_API_TOKEN);
  const now = new Date().toISOString();
  const allEvents: OpenChiefEvent[] = [];

  // -- 1. Workers (snapshot diff) --

  const workerResult = await pollWorkers(client, env.KV, now, options?.backfill);
  allEvents.push(...workerResult.events);

  // -- 2. Departments (snapshot diff) --

  const deptResult = await pollDepartments(client, env.KV, now);
  allEvents.push(...deptResult.events);

  // -- 3. Leave requests (cursor-based) --

  const leaveResult = await pollLeave(client, env.KV, now);
  allEvents.push(...leaveResult.events);

  // -- 4. Payroll runs (cursor-based) --

  const payrollResult = await pollPayroll(client, env.KV, now);
  allEvents.push(...payrollResult.events);

  // -- Enqueue all events --

  for (const event of allEvents) {
    await env.EVENTS_QUEUE.send(event);
  }

  console.log(`Rippling poll complete: ${allEvents.length} events enqueued`);

  return {
    workers: { fetched: workerResult.fetched, events: workerResult.events.length },
    departments: { fetched: deptResult.fetched, events: deptResult.events.length },
    leave: { fetched: leaveResult.fetched, events: leaveResult.events.length },
    payroll: { fetched: payrollResult.fetched, events: payrollResult.events.length },
    totalEvents: allEvents.length,
  };
}

// --- Worker Polling ---

async function pollWorkers(
  client: RipplingClient,
  kv: KVNamespace,
  now: string,
  backfill?: boolean
): Promise<{ fetched: number; events: OpenChiefEvent[] }> {
  console.log("Polling Rippling workers...");
  const workers = await client.listWorkers();
  console.log(`Fetched ${workers.length} workers from Rippling`);

  // Build current snapshot
  const currentSnapshot: Record<string, WorkerSnapshot> = {};
  for (const w of workers) {
    const snap = workerToSnapshot(w);
    currentSnapshot[snap.id] = snap;
  }

  // Load previous snapshot
  let previousSnapshot: Record<string, WorkerSnapshot> = {};
  if (!backfill) {
    const stored = await kv.get(KV_WORKERS_SNAPSHOT);
    if (stored) {
      try {
        previousSnapshot = JSON.parse(stored);
      } catch {
        console.warn("Failed to parse workers snapshot, treating as fresh");
      }
    }
  }

  // Diff snapshots to find changes
  const events = diffWorkerSnapshots(previousSnapshot, currentSnapshot, now);
  console.log(`Worker diff: ${events.length} change events`);

  // Store new snapshot (expires after 30 days as safety)
  await kv.put(KV_WORKERS_SNAPSHOT, JSON.stringify(currentSnapshot), {
    expirationTtl: 30 * 24 * 60 * 60,
  });

  return { fetched: workers.length, events };
}

// --- Department Polling ---

async function pollDepartments(
  client: RipplingClient,
  kv: KVNamespace,
  now: string
): Promise<{ fetched: number; events: OpenChiefEvent[] }> {
  console.log("Polling Rippling departments...");
  const departments = await client.listDepartments();
  console.log(`Fetched ${departments.length} departments`);

  // Build current map
  const currentMap: Record<string, string> = {};
  for (const d of departments) {
    currentMap[d.id] = d.name;
  }

  // Load previous map
  let previousMap: Record<string, string> = {};
  const stored = await kv.get(KV_DEPARTMENTS_SNAPSHOT);
  if (stored) {
    try {
      previousMap = JSON.parse(stored);
    } catch {
      // Fresh start
    }
  }

  const events = diffDepartments(previousMap, currentMap, now);

  // Store new snapshot
  await kv.put(KV_DEPARTMENTS_SNAPSHOT, JSON.stringify(currentMap), {
    expirationTtl: 30 * 24 * 60 * 60,
  });

  return { fetched: departments.length, events };
}

// --- Leave Polling ---

async function pollLeave(
  client: RipplingClient,
  kv: KVNamespace,
  now: string
): Promise<{ fetched: number; events: OpenChiefEvent[] }> {
  console.log("Polling Rippling leave requests...");

  // Get cursor
  const since = await kv.get(KV_LEAVE_CURSOR);
  const requests = await client.listLeaveRequests(since || undefined);
  console.log(`Fetched ${requests.length} approved leave requests`);

  const events = normalizeLeaveRequests(requests, now);

  // Also check for low PTO balances
  const balances = await client.listLeaveBalances();
  const lowBalanceEvents = normalizeLeaveBalanceLowAlerts(
    balances,
    LOW_PTO_THRESHOLD_DAYS,
    now
  );
  events.push(...lowBalanceEvents);
  console.log(`Leave: ${events.length} events (incl. ${lowBalanceEvents.length} low-balance alerts)`);

  // Update cursor
  await kv.put(KV_LEAVE_CURSOR, now);

  return { fetched: requests.length + balances.length, events };
}

// --- Payroll Polling ---

async function pollPayroll(
  client: RipplingClient,
  kv: KVNamespace,
  now: string
): Promise<{ fetched: number; events: OpenChiefEvent[] }> {
  console.log("Polling Rippling pay runs...");

  // Get cursor
  const since = await kv.get(KV_PAYROLL_CURSOR);
  const runs = await client.listPayRuns(since || undefined);
  console.log(`Fetched ${runs.length} pay runs`);

  // Only emit events for completed or failed runs
  const relevantRuns = runs.filter(
    (r) => r.status === "COMPLETED" || r.status === "FAILED"
  );
  const events = normalizePayRuns(relevantRuns, now);

  // Update cursor
  await kv.put(KV_PAYROLL_CURSOR, now);

  return { fetched: runs.length, events };
}
