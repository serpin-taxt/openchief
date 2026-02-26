/**
 * Normalize Amplitude metric snapshots to OpenChiefEvent format.
 *
 * Supports three metric shapes:
 * 1. MetricSnapshot — single numeric value with optional previous (DAU, WAU, MAU)
 * 2. CompositionSnapshot — breakdown by dimension (country, device, browser)
 * 3. RetentionSnapshot — cohort retention rates
 */

import type { OpenChiefEvent } from "@openchief/shared";
import { generateULID } from "@openchief/shared";

// --- Snapshot types ----------------------------------------------------------

export interface MetricSnapshot {
  metricName: string;
  value: number;
  previousValue?: number;
  date: string; // YYYY-MM-DD
  interval: string; // "daily", "weekly", "monthly"
}

export interface CompositionSnapshot {
  metricName: string;
  dimension: string; // e.g., "country", "device_family", "browser"
  breakdown: Array<{ label: string; value: number }>;
  date: string;
}

export interface RetentionSnapshot {
  metricName: string;
  date: string;
  /** Retention rates by week/day, e.g., [100, 45.2, 32.1, 28.5, ...] */
  rates: number[];
  /** Total users in the cohort */
  cohortSize: number;
}

// --- Helpers -----------------------------------------------------------------

/**
 * Event timestamp uses the current poll time (when data was fetched) rather
 * than midnight UTC of the data date.  This keeps Amplitude events inside
 * the runtime's 25-hour lookback window.  The original data date is preserved
 * in `payload.date` for display purposes.
 */
function pollTimestamp(): string {
  return new Date().toISOString();
}

// --- Normalizers -------------------------------------------------------------

/**
 * Convert a single numeric metric snapshot into an OpenChiefEvent.
 */
export function normalizeMetric(
  snapshot: MetricSnapshot,
  projectName: string
): OpenChiefEvent {
  const changeStr = snapshot.previousValue !== undefined
    ? (() => {
        const diff = snapshot.value - snapshot.previousValue;
        const pct = snapshot.previousValue > 0
          ? ((diff / snapshot.previousValue) * 100).toFixed(1)
          : "N/A";
        const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
        return ` (${direction} ${pct}% from ${snapshot.previousValue.toLocaleString()})`;
      })()
    : "";

  const summary = `${snapshot.metricName}: ${snapshot.value.toLocaleString()}${changeStr} for ${snapshot.date} (${snapshot.interval})`;

  const tags: string[] = ["metric"];
  if (snapshot.previousValue !== undefined) {
    const diff = snapshot.value - snapshot.previousValue;
    const pct = snapshot.previousValue > 0
      ? Math.abs((diff / snapshot.previousValue) * 100)
      : 0;
    if (pct > 20) tags.push("significant-change");
    if (diff < 0) tags.push("decline");
    if (diff > 0) tags.push("growth");
  }

  return {
    id: generateULID(),
    timestamp: pollTimestamp(),
    ingestedAt: new Date().toISOString(),
    source: "amplitude",
    eventType: "metric.snapshot",
    scope: {
      org: projectName,
      project: snapshot.metricName,
    },
    payload: {
      metricName: snapshot.metricName,
      value: snapshot.value,
      previousValue: snapshot.previousValue,
      date: snapshot.date,
      interval: snapshot.interval,
    },
    summary,
    tags,
  };
}

/**
 * Convert a composition/breakdown snapshot into an OpenChiefEvent.
 * These show user distribution across a dimension (country, device, browser, etc.)
 */
export function normalizeComposition(
  snapshot: CompositionSnapshot,
  projectName: string
): OpenChiefEvent {
  const total = snapshot.breakdown.reduce((sum, b) => sum + b.value, 0);
  const top5 = snapshot.breakdown.slice(0, 5);
  const top5Str = top5
    .map((b) => {
      const pct = total > 0 ? ((b.value / total) * 100).toFixed(1) : "0";
      return `${b.label}: ${b.value.toLocaleString()} (${pct}%)`;
    })
    .join(", ");

  const summary = `${snapshot.metricName} — Top 5: ${top5Str} (total: ${total.toLocaleString()}) for ${snapshot.date}`;

  return {
    id: generateULID(),
    timestamp: pollTimestamp(),
    ingestedAt: new Date().toISOString(),
    source: "amplitude",
    eventType: "metric.composition",
    scope: {
      org: projectName,
      project: snapshot.metricName,
    },
    payload: {
      metricName: snapshot.metricName,
      dimension: snapshot.dimension,
      breakdown: snapshot.breakdown.slice(0, 15), // Top 15 to keep payload reasonable
      total,
      date: snapshot.date,
    },
    summary,
    tags: ["metric", "composition", snapshot.dimension],
  };
}

/**
 * Convert a retention snapshot into an OpenChiefEvent.
 */
export function normalizeRetention(
  snapshot: RetentionSnapshot,
  projectName: string
): OpenChiefEvent {
  const weekLabels = snapshot.rates
    .map((rate, i) => `W${i}: ${rate.toFixed(1)}%`)
    .join(", ");

  const summary = `${snapshot.metricName}: cohort ${snapshot.cohortSize.toLocaleString()} users — ${weekLabels} for ${snapshot.date}`;

  const tags: string[] = ["metric", "retention"];

  // Flag concerning retention drops
  if (snapshot.rates.length >= 2) {
    const week1 = snapshot.rates[1] ?? 0;
    if (week1 < 20) tags.push("low-retention");
    if (week1 >= 40) tags.push("strong-retention");
  }

  return {
    id: generateULID(),
    timestamp: pollTimestamp(),
    ingestedAt: new Date().toISOString(),
    source: "amplitude",
    eventType: "metric.retention",
    scope: {
      org: projectName,
      project: snapshot.metricName,
    },
    payload: {
      metricName: snapshot.metricName,
      cohortSize: snapshot.cohortSize,
      rates: snapshot.rates,
      date: snapshot.date,
    },
    summary,
    tags,
  };
}
