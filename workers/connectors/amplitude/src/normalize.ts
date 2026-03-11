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

export interface ChartSnapshot {
  chartId: string;
  chartLabel: string;
  data: Record<string, unknown>;
  date: string; // YYYY-MM-DD (poll date)
}

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

// --- Chart normalizer --------------------------------------------------------

/**
 * Build a best-effort summary from chart data by inspecting common shapes.
 */
function buildChartSummary(snapshot: ChartSnapshot): string {
  const { chartLabel, data, date } = snapshot;
  const parts: string[] = [`${chartLabel} for ${date}`];

  // Event segmentation / active users: data.series is number[][]
  const series = data.series;
  if (Array.isArray(series) && series.length > 0) {
    // Numeric series — extract latest values per series
    if (Array.isArray(series[0])) {
      const seriesLabels = Array.isArray(data.seriesLabels)
        ? (data.seriesLabels as string[])
        : [];
      const summaryParts: string[] = [];
      for (let i = 0; i < Math.min(series.length, 5); i++) {
        const s = series[i] as number[];
        if (Array.isArray(s) && s.length > 0) {
          const last = s[s.length - 1];
          if (typeof last === "number") {
            const label = seriesLabels[i] || `Series ${i + 1}`;
            const prev = s.length >= 2 ? s[s.length - 2] : undefined;
            let change = "";
            if (typeof prev === "number" && prev > 0) {
              const pct = (((last - prev) / prev) * 100).toFixed(1);
              change = last >= prev ? ` (+${pct}%)` : ` (${pct}%)`;
            }
            summaryParts.push(`${label}: ${last.toLocaleString()}${change}`);
          }
        }
      }
      if (summaryParts.length > 0) {
        parts.push(summaryParts.join(", "));
      }
      return parts.join(" — ");
    }

    // Retention-style: series[0].combined
    const first = series[0] as Record<string, unknown>;
    if (typeof first === "object" && first !== null && "combined" in first) {
      const combined = first.combined as Array<{ count: number; outof: number }> | undefined;
      if (Array.isArray(combined) && combined.length > 1) {
        const cohort = combined[0]?.outof || 0;
        const rates: string[] = [];
        for (let i = 0; i < Math.min(combined.length, 9); i += 1) {
          const rate = combined[i].outof > 0
            ? ((combined[i].count / combined[i].outof) * 100).toFixed(1)
            : "0";
          rates.push(`D${i}: ${rate}%`);
        }
        parts.push(`cohort ${cohort.toLocaleString()} users, ${rates.join(", ")}`);
      }
      return parts.join(" — ");
    }
  }

  // Composition-like: data.xValues
  const xValues = data.xValues;
  if (Array.isArray(xValues) && xValues.length > 0) {
    parts.push(`${xValues.length} categories`);
  }

  return parts.join(" — ");
}

/**
 * Trim chart data to stay under Cloudflare Queue's 128KB message limit.
 * Keeps series arrays but truncates long ones to the last 60 data points.
 * If the result is still too large, drops the raw data entirely (summary
 * still captures the key insight).
 */
function trimChartData(
  data: Record<string, unknown>,
): { data: Record<string, unknown>; truncated: boolean } {
  const MAX_PAYLOAD_BYTES = 80_000; // leave headroom for the rest of the event

  // First try: trim series arrays to last 60 entries
  const trimmed = { ...data };
  let didTrim = false;

  if (Array.isArray(trimmed.series)) {
    trimmed.series = (trimmed.series as unknown[]).map((s) => {
      if (Array.isArray(s) && s.length > 60) {
        didTrim = true;
        return s.slice(-60);
      }
      return s;
    });
  }
  if (Array.isArray(trimmed.xValues) && (trimmed.xValues as unknown[]).length > 60) {
    trimmed.xValues = (trimmed.xValues as unknown[]).slice(-60);
    didTrim = true;
  }
  if (Array.isArray(trimmed.seriesLabels) && (trimmed.seriesLabels as unknown[]).length > 60) {
    trimmed.seriesLabels = (trimmed.seriesLabels as unknown[]).slice(-60);
    didTrim = true;
  }

  const size = new TextEncoder().encode(JSON.stringify(trimmed)).byteLength;
  if (size <= MAX_PAYLOAD_BYTES) {
    return { data: trimmed, truncated: didTrim };
  }

  // Still too large — drop raw data, keep only metadata
  return {
    data: { _note: "Chart data too large; see summary for key metrics" },
    truncated: true,
  };
}

/**
 * Convert saved chart results into an OpenChiefEvent.
 * Uses generic normalization since chart response shapes vary by chart type.
 */
export function normalizeChart(
  snapshot: ChartSnapshot,
  projectName: string
): OpenChiefEvent {
  const { data, truncated } = trimChartData(snapshot.data);
  const tags = ["metric", "chart"];
  if (truncated) tags.push("truncated");

  return {
    id: generateULID(),
    timestamp: pollTimestamp(),
    ingestedAt: new Date().toISOString(),
    source: "amplitude",
    eventType: "metric.chart",
    scope: {
      org: projectName,
      project: snapshot.chartLabel,
    },
    payload: {
      chartId: snapshot.chartId,
      chartLabel: snapshot.chartLabel,
      data,
      date: snapshot.date,
    },
    summary: buildChartSummary(snapshot),
    tags,
  };
}
