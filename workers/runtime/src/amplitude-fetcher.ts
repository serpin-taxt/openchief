/**
 * Fresh Amplitude data fetching for report generation.
 *
 * Called at report time to pull the latest metrics directly from Amplitude,
 * rather than relying on pre-polled events in D1.
 *
 * This gives the analytics agent access to the freshest possible data
 * every time it generates a report.
 */

const BASE = "https://amplitude.com/api/2";

// ─── Amplitude API helpers ──────────────────────────────────────────────

async function amplitudeFetch<T>(
  path: string,
  apiKey: string,
  secretKey: string,
  params?: Record<string, string>
): Promise<T> {
  const url = new URL(BASE + path);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const auth = btoa(`${apiKey}:${secretKey}`);
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Amplitude API ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

// ─── Date helpers ───────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

function formatDateHyphen(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Fetch all metrics and format for prompt injection ──────────────────

export interface AmplitudeMetricsBlock {
  /** Pre-formatted text block ready to inject into the prompt */
  text: string;
  /** Number of individual metric calls that succeeded */
  metricsLoaded: number;
  /** Any errors encountered (non-fatal) */
  errors: string[];
}

/**
 * Fetch fresh Amplitude metrics and return a formatted text block
 * ready to inject into the agent's prompt.
 */
export async function fetchAmplitudeMetrics(
  apiKey: string,
  secretKey: string
): Promise<AmplitudeMetricsBlock> {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400_000);
  const twoDaysAgo = new Date(today.getTime() - 2 * 86400_000);
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400_000);
  const sixtyDaysAgo = new Date(today.getTime() - 60 * 86400_000);

  const sections: string[] = [];
  const errors: string[] = [];
  let metricsLoaded = 0;

  // ─── 1. Active Users: DAU / WAU / MAU ───────────────────────────────
  try {
    const [dauResult, wauResult, mauResult] = await Promise.all([
      amplitudeFetch<{ data: { series: number[][] } }>(
        "/users",
        apiKey,
        secretKey,
        { start: formatDate(twoDaysAgo), end: formatDate(yesterday), i: "1" }
      ),
      amplitudeFetch<{ data: { series: number[][] } }>(
        "/users",
        apiKey,
        secretKey,
        {
          start: formatDate(new Date(today.getTime() - 14 * 86400_000)),
          end: formatDate(yesterday),
          i: "7",
        }
      ),
      amplitudeFetch<{ data: { series: number[][] } }>(
        "/users",
        apiKey,
        secretKey,
        { start: formatDate(sixtyDaysAgo), end: formatDate(yesterday), i: "30" }
      ),
    ]);

    const lines: string[] = ["## Active Users"];

    for (const [label, result] of [
      ["DAU (Daily Active Users)", dauResult],
      ["WAU (Weekly Active Users)", wauResult],
      ["MAU (Monthly Active Users)", mauResult],
    ] as const) {
      if (result.data?.series?.length >= 1) {
        const series = result.data.series[0];
        const current = series[series.length - 1] || 0;
        const prev = series.length >= 2 ? series[series.length - 2] : undefined;
        const changeStr =
          prev !== undefined && prev > 0
            ? (() => {
                const diff = current - prev;
                const pct = ((diff / prev) * 100).toFixed(1);
                const arrow = diff > 0 ? "↑" : diff < 0 ? "↓" : "→";
                return ` (${arrow} ${pct}% from ${prev.toLocaleString()})`;
              })()
            : "";
        lines.push(
          `- ${label}: **${current.toLocaleString()}**${changeStr} as of ${formatDateHyphen(yesterday)}`
        );
        metricsLoaded++;
      }
    }

    // Compute stickiness if we have DAU and MAU
    const dauSeries = dauResult.data?.series?.[0];
    const mauSeries = mauResult.data?.series?.[0];
    if (dauSeries?.length && mauSeries?.length) {
      const dau = dauSeries[dauSeries.length - 1] || 0;
      const mau = mauSeries[mauSeries.length - 1] || 1;
      const stickiness = ((dau / mau) * 100).toFixed(1);
      lines.push(`- DAU:MAU Stickiness: **${stickiness}%**`);
    }

    sections.push(lines.join("\n"));
  } catch (err) {
    errors.push(`Active users: ${err instanceof Error ? err.message : err}`);
  }

  // ─── 2. User Composition ────────────────────────────────────────────
  const compositionDimensions = [
    { property: "country", name: "Country" },
    { property: "device", name: "Device Family" },
    { property: "device_type", name: "Desktop vs Mobile" },
    { property: "platform", name: "Platform" },
    { property: "language", name: "Language" },
  ];

  const compositionLines: string[] = ["## User Composition (Last 30 Days)"];

  for (const dim of compositionDimensions) {
    try {
      const result = await amplitudeFetch<{
        data: { xValues: string[]; series: number[][] };
      }>("/composition", apiKey, secretKey, {
        start: formatDate(thirtyDaysAgo),
        end: formatDate(yesterday),
        p: dim.property,
      });

      const xValues = result.data?.xValues;
      const series = result.data?.series;

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
        breakdown.sort((a, b) => b.value - a.value);

        const total = breakdown.reduce((sum, b) => sum + b.value, 0);
        const top5 = breakdown
          .slice(0, 5)
          .map((b) => {
            const pct = total > 0 ? ((b.value / total) * 100).toFixed(1) : "0";
            return `${b.label}: ${b.value.toLocaleString()} (${pct}%)`;
          })
          .join(", ");

        compositionLines.push(
          `- **${dim.name}**: ${top5}${breakdown.length > 5 ? ` + ${breakdown.length - 5} more` : ""}`
        );
        metricsLoaded++;
      }
    } catch (err) {
      errors.push(
        `Composition ${dim.property}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  if (compositionLines.length > 1) {
    sections.push(compositionLines.join("\n"));
  }

  // ─── 3. Retention ───────────────────────────────────────────────────
  try {
    const retentionResult = await amplitudeFetch<{
      data: {
        series: Array<{
          combined: Array<{ count: number; outof: number; incomplete: boolean }>;
        }>;
      };
    }>("/retention", apiKey, secretKey, {
      start: formatDate(sixtyDaysAgo),
      end: formatDate(yesterday),
      rm: "rolling",
      se: JSON.stringify({ event_type: "_active" }),
      re: JSON.stringify({ event_type: "_active" }),
    });

    const series = retentionResult.data?.series;
    if (series && series.length > 0) {
      const combined = series[0].combined;
      if (combined && combined.length > 0) {
        const cohortSize = combined[0]?.outof || 0;

        if (cohortSize > 0) {
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

          const retentionLines: string[] = [
            "## Retention (Rolling, Any Active Event)",
            `- Cohort size: **${cohortSize.toLocaleString()}** users`,
            `- Retention curve: ${weeklyRates.map((r, i) => `W${i}: ${r.toFixed(1)}%`).join(" → ")}`,
          ];

          // Flag concerning patterns
          if (weeklyRates.length >= 2 && weeklyRates[1] < 20) {
            retentionLines.push(
              `- Warning: Week 1 retention is ${weeklyRates[1].toFixed(1)}% — below 20% threshold`
            );
          }

          sections.push(retentionLines.join("\n"));
          metricsLoaded++;
        }
      }
    }
  } catch (err) {
    errors.push(`Retention: ${err instanceof Error ? err.message : err}`);
  }

  // ─── Assemble final block ───────────────────────────────────────────
  const header = `═══ FRESH AMPLITUDE METRICS (pulled ${new Date().toISOString()}) ═══`;
  const errorNote =
    errors.length > 0
      ? `\n\nSome metrics could not be loaded: ${errors.join("; ")}`
      : "";

  const text =
    sections.length > 0
      ? `${header}\n\n${sections.join("\n\n")}${errorNote}`
      : `${header}\n\nNo Amplitude metrics could be loaded.${errorNote}`;

  return { text, metricsLoaded, errors };
}
