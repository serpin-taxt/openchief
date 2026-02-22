/**
 * OpenChief Demo Engine
 *
 * A synthetic event generator that simulates a fictional company
 * ("Serpin's Burger Shack") with 15 team members actively using GitHub,
 * Slack, Jira, Discord, Figma, Intercom, Amplitude, and Google Analytics.
 *
 * Runs on a 30-minute cron, generating 20-50 realistic events per cycle.
 * Events flow through the normal pipeline (queue -> router -> D1 -> agents).
 *
 * Endpoints:
 *   GET  /           -> health check
 *   POST /generate   -> manual trigger (generates one batch immediately)
 *   POST /backfill   -> generate N days of historical events
 *
 * Scheduled:
 *   Cron every 30 minutes -> automatic event generation
 */

import { generateEventBatch } from "./generators";
import { TEAM } from "./world";

interface Env {
  EVENTS_QUEUE: Queue;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // -- Health check --
    if (url.pathname === "/" && request.method === "GET") {
      return Response.json({
        service: "openchief-demo-engine",
        status: "ok",
        team_size: TEAM.length,
        timestamp: new Date().toISOString(),
      });
    }

    // -- Manual generate --
    if (url.pathname === "/generate" && request.method === "POST") {
      try {
        const result = await publishBatch(env);
        return Response.json({ ok: true, ...result });
      } catch (err) {
        console.error("Manual generate failed:", err);
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    // -- Backfill: generate historical events --
    if (url.pathname === "/backfill" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({})) as Record<string, unknown>;
        const days = Math.min(Number(body.days) || 7, 30);
        const batchesPerDay = Number(body.batchesPerDay) || 16; // ~every 30 min during working hours
        const result = await backfill(env, days, batchesPerDay);
        return Response.json({ ok: true, ...result });
      } catch (err) {
        console.error("Backfill failed:", err);
        return Response.json(
          { ok: false, error: err instanceof Error ? err.message : String(err) },
          { status: 500 },
        );
      }
    }

    return new Response("Not found", { status: 404 });
  },

  // -- Scheduled (cron) --
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    try {
      const result = await publishBatch(env);
      console.log(`Demo engine: published ${result.eventCount} events`);
    } catch (err) {
      console.error("Demo engine scheduled run failed:", err);
    }
  },
};

// -- Helpers --------------------------------------------------------------------

async function publishBatch(env: Env): Promise<{ eventCount: number; sources: Record<string, number> }> {
  const events = generateEventBatch();

  // Publish each event to the queue (same as real connectors)
  for (const event of events) {
    await env.EVENTS_QUEUE.send(event);
  }

  // Count by source for logging
  const sources: Record<string, number> = {};
  for (const e of events) {
    sources[e.source] = (sources[e.source] || 0) + 1;
  }

  return { eventCount: events.length, sources };
}

/**
 * Generate historical event data for N days.
 * Creates batches with timestamps spread across each day,
 * simulating realistic working-hours activity.
 */
async function backfill(
  env: Env,
  days: number,
  batchesPerDay: number,
): Promise<{ totalEvents: number; days: number }> {
  let totalEvents = 0;
  const nowMs = Date.now();

  // Collect all events first, then send in batches of 100 (queue sendBatch limit)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const allEvents: any[] = [];

  for (let d = days; d >= 1; d--) {
    // Skip weekends (less activity, not zero)
    const dayDate = new Date(nowMs - d * 24 * 60 * 60 * 1000);
    const isWeekend = dayDate.getDay() === 0 || dayDate.getDay() === 6;
    const cyclesThisDay = isWeekend ? Math.ceil(batchesPerDay / 3) : batchesPerDay;

    for (let b = 0; b < cyclesThisDay; b++) {
      const events = generateEventBatch();

      // Shift timestamps to the target day, spread across working hours (8am-8pm)
      const hourOffset = 8 + (b / cyclesThisDay) * 12; // 8am to 8pm spread
      const baseTime = new Date(dayDate);
      baseTime.setUTCHours(Math.floor(hourOffset), Math.round((hourOffset % 1) * 60), 0, 0);

      for (const event of events) {
        // Randomize within a ~30 min window around the base time
        const jitter = (Math.random() - 0.5) * 30 * 60 * 1000;
        const eventTime = new Date(baseTime.getTime() + jitter);
        event.timestamp = eventTime.toISOString();
        event.ingestedAt = new Date(eventTime.getTime() + 2000).toISOString(); // 2s "ingestion delay"

        allEvents.push(event);
      }
    }
  }

  // Send in batches of 100 using sendBatch (much fewer API calls)
  for (let i = 0; i < allEvents.length; i += 100) {
    const chunk = allEvents.slice(i, i + 100);
    await env.EVENTS_QUEUE.sendBatch(chunk.map((body) => ({ body })));
  }
  totalEvents = allEvents.length;

  return { totalEvents, days };
}
