/**
 * Periodic polling for Amplitude metrics.
 *
 * Fetches the key metrics from Amplitude:
 *
 * 1. DAU / WAU / MAU  (active users)
 * 2. User composition  (country, device, device_type, platform, language)
 * 3. Retention         (rolling retention, any active event)
 *
 * Each metric is deduped by name + date so we don't re-emit on every poll.
 * Runs every 6 hours via cron trigger.
 */

import {
  getActiveUsers,
  getUserComposition,
  getRetention,
} from "./amplitude-api";
import {
  normalizeMetric,
  normalizeComposition,
  normalizeRetention,
} from "./normalize";
import type { OpenChiefEvent } from "@openchief/shared";

interface Env {
  EVENTS_QUEUE: Queue;
  AMPLITUDE_API_KEY: string;
  AMPLITUDE_SECRET_KEY: string;
  AMPLITUDE_PROJECT_NAME?: string;
  KV: KVNamespace;
  DB: D1Database;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatDateHyphen(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface PollResult {
  metrics: number;
  events: number;
  errors: string[];
}

export async function runPollTasks(env: Env): Promise<PollResult> {
  const projectName = env.AMPLITUDE_PROJECT_NAME || "default";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400_000);
  const twoDaysAgo = new Date(today.getTime() - 2 * 86400_000);
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400_000);
  const sixtyDaysAgo = new Date(today.getTime() - 60 * 86400_000);

  const allEvents: OpenChiefEvent[] = [];
  const errors: string[] = [];

  // --- 1. Active Users: DAU / WAU / MAU --------------------------------------
  try {
    const [dauResult, wauResult, mauResult] = await Promise.all([
      getActiveUsers(
        env.AMPLITUDE_API_KEY,
        env.AMPLITUDE_SECRET_KEY,
        formatDate(twoDaysAgo),
        formatDate(yesterday),
        "1"
      ),
      getActiveUsers(
        env.AMPLITUDE_API_KEY,
        env.AMPLITUDE_SECRET_KEY,
        formatDate(new Date(today.getTime() - 14 * 86400_000)),
        formatDate(yesterday),
        "7"
      ),
      getActiveUsers(
        env.AMPLITUDE_API_KEY,
        env.AMPLITUDE_SECRET_KEY,
        formatDate(sixtyDaysAgo),
        formatDate(yesterday),
        "30"
      ),
    ]);

    // DAU
    if (dauResult.data?.series?.length >= 1) {
      const series = dauResult.data.series[0];
      const current = series[series.length - 1] || 0;
      const prev = series.length >= 2 ? series[series.length - 2] : undefined;
      allEvents.push(
        normalizeMetric(
          {
            metricName: "DAU (Daily Active Users)",
            value: current,
            previousValue: prev,
            date: formatDateHyphen(yesterday),
            interval: "daily",
          },
          projectName
        )
      );
    }

    // WAU
    if (wauResult.data?.series?.length >= 1) {
      const series = wauResult.data.series[0];
      const current = series[series.length - 1] || 0;
      const prev = series.length >= 2 ? series[series.length - 2] : undefined;
      allEvents.push(
        normalizeMetric(
          {
            metricName: "WAU (Weekly Active Users)",
            value: current,
            previousValue: prev,
            date: formatDateHyphen(yesterday),
            interval: "weekly",
          },
          projectName
        )
      );
    }

    // MAU
    if (mauResult.data?.series?.length >= 1) {
      const series = mauResult.data.series[0];
      const current = series[series.length - 1] || 0;
      const prev = series.length >= 2 ? series[series.length - 2] : undefined;
      allEvents.push(
        normalizeMetric(
          {
            metricName: "MAU (Monthly Active Users)",
            value: current,
            previousValue: prev,
            date: formatDateHyphen(yesterday),
            interval: "monthly",
          },
          projectName
        )
      );
    }

    console.log("Active users fetched: DAU/WAU/MAU");
  } catch (err) {
    const msg = `Active users: ${err instanceof Error ? err.message : err}`;
    console.error(msg);
    errors.push(msg);
  }

  // --- 2. User Composition ---------------------------------------------------
  // Valid Amplitude built-in properties for this project:
  // country, device_type (Desktop/Mobile/Tablet), device (OS/Device family),
  // platform (Web/iOS/Android), language, city, region

  const compositionDimensions = [
    { property: "country", name: "User Composition by Country" },
    { property: "device", name: "Usage by Device Family" },
    { property: "device_type", name: "Usage on Desktop/Mobile" },
    { property: "platform", name: "Usage by Platform" },
    { property: "language", name: "Usage by Language" },
  ];

  for (const dim of compositionDimensions) {
    try {
      const result = await getUserComposition(
        env.AMPLITUDE_API_KEY,
        env.AMPLITUDE_SECRET_KEY,
        formatDate(thirtyDaysAgo),
        formatDate(yesterday),
        dim.property
      );

      // Composition API returns data.xValues (labels) and data.series[0] (values)
      const data = result.data as Record<string, unknown>;
      const xValues = data?.xValues as string[] | undefined;
      const series = data?.series as number[][] | undefined;

      if (xValues && series && series.length > 0) {
        const values = series[0];
        const breakdown: Array<{ label: string; value: number }> = [];
        for (let i = 0; i < xValues.length; i++) {
          const label = xValues[i] || "(none)";
          const value = values[i] || 0;
          if (value > 0) {
            breakdown.push({ label, value });
          }
        }
        // Sort by value descending
        breakdown.sort((a, b) => b.value - a.value);

        if (breakdown.length > 0) {
          allEvents.push(
            normalizeComposition(
              {
                metricName: dim.name,
                dimension: dim.property,
                breakdown,
                date: formatDateHyphen(yesterday),
              },
              projectName
            )
          );
        }
      }

      console.log(`Composition fetched: ${dim.name}`);
    } catch (err) {
      const msg = `Composition ${dim.property}: ${err instanceof Error ? err.message : err}`;
      console.error(msg);
      errors.push(msg);
    }
  }

  // --- 3. Retention ----------------------------------------------------------
  // Uses rolling retention with _active event type (matches dashboard)

  try {
    const retentionResult = await getRetention(
      env.AMPLITUDE_API_KEY,
      env.AMPLITUDE_SECRET_KEY,
      formatDate(sixtyDaysAgo),
      formatDate(yesterday),
      "_active",
      "_active",
      "rolling"
    );

    // Response: data.series[0].combined = Array<{count, outof, incomplete}>
    const data = retentionResult.data as Record<string, unknown>;
    const series = data?.series as Array<Record<string, unknown>> | undefined;

    if (series && series.length > 0) {
      const combined = series[0].combined as
        | Array<{ count: number; outof: number }>
        | undefined;

      if (combined && combined.length > 0) {
        const cohortSize = combined[0]?.outof || 0;

        if (cohortSize > 0) {
          // Extract daily rates, then sample weekly (every 7 days)
          const dailyRates = combined.map((item) =>
            item.outof > 0 ? (item.count / item.outof) * 100 : 0
          );

          // Weekly samples: Day 0, 7, 14, 21, 28, 35, 42, 49, 56
          const weeklyRates: number[] = [];
          for (
            let i = 0;
            i < dailyRates.length && weeklyRates.length < 9;
            i += 7
          ) {
            weeklyRates.push(Math.round(dailyRates[i] * 10) / 10);
          }

          allEvents.push(
            normalizeRetention(
              {
                metricName: "Rolling Retention (Any Active Event)",
                date: formatDateHyphen(yesterday),
                rates: weeklyRates,
                cohortSize,
              },
              projectName
            )
          );

          console.log(
            `Retention fetched: ${weeklyRates.length} weeks, cohort ${cohortSize}`
          );
        }
      }
    }
  } catch (err) {
    const msg = `Retention: ${err instanceof Error ? err.message : err}`;
    console.error(msg);
    errors.push(msg);
  }

  // --- Dedup & Publish -------------------------------------------------------

  let eventsPublished = 0;
  for (const event of allEvents) {
    const payloadDate =
      (event.payload as Record<string, unknown>).date ||
      formatDateHyphen(yesterday);
    const dedupKey = `amplitude:dedup:${event.scope.project}:${payloadDate}`;
    const existing = await env.KV.get(dedupKey);
    if (existing) continue;

    await env.EVENTS_QUEUE.send(event);
    await env.KV.put(dedupKey, "1", { expirationTtl: 86400 * 3 }); // 3-day dedup window
    eventsPublished++;
  }

  console.log(
    `Amplitude poll complete: ${allEvents.length} metrics, ${eventsPublished} events published, ${errors.length} errors`
  );

  return { metrics: allEvents.length, events: eventsPublished, errors };
}
