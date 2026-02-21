/**
 * Amplitude REST API helpers.
 *
 * Uses the Amplitude Analytics API v2 for querying metrics.
 * Docs: https://amplitude.com/docs/apis/analytics/dashboard-rest
 *
 * Authentication: API Key + Secret Key via Basic Auth.
 *
 * Covers key Amplitude dashboard charts:
 * - DAU / WAU / MAU (active users)
 * - User composition (country, device, browser, platform)
 * - Event segmentation (wallet connector, OG images, etc.)
 * - Retention & stickiness
 */

const BASE = "https://amplitude.com/api/2";

// --- Response types ----------------------------------------------------------

export interface AmplitudeMetricResult {
  data: {
    series: number[][];
    seriesLabels: number[];
    seriesCollapsed?: Array<{ setId: string; value: number }>;
    xValues?: string[];
  };
}

export interface AmplitudeCompositionResult {
  data: {
    /** series[0] is an array of values corresponding to xValues labels */
    series: number[][];
    seriesLabels: string[];
    /** The labels for each value in the series (e.g., country names, device types) */
    xValues: string[];
  };
}

export interface AmplitudeRetentionResult {
  data: {
    /**
     * series[0] is a dict with:
     *   - values: Record<date, Array<{count, outof, incomplete}>>
     *   - dates: string[]
     *   - datetimes: string[]
     *   - combined: Array<{count, outof, incomplete}>
     */
    series: Array<{
      values: Record<string, Array<{ count: number; outof: number; incomplete: boolean }>>;
      dates: string[];
      datetimes: string[];
      combined: Array<{ count: number; outof: number; incomplete: boolean }>;
    }>;
    seriesLabels: string[];
  };
}

export interface AmplitudeEventSegmentResult {
  data: {
    series: number[][];
    seriesLabels: number[];
    seriesCollapsed?: Array<{ setId: string; value: number }>;
    xValues?: string[];
  };
}

// --- Core fetch --------------------------------------------------------------

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

// --- Active Users (DAU / WAU / MAU) ------------------------------------------

/**
 * Query active user counts for a date range.
 * Returns DAU/WAU/MAU depending on the interval parameter.
 */
export async function getActiveUsers(
  apiKey: string,
  secretKey: string,
  start: string, // YYYYMMDD
  end: string, // YYYYMMDD
  interval: "1" | "7" | "30" = "1" // 1=DAU, 7=WAU, 30=MAU
): Promise<AmplitudeMetricResult> {
  return amplitudeFetch<AmplitudeMetricResult>(
    "/users",
    apiKey,
    secretKey,
    { start, end, i: interval }
  );
}

// --- User Composition --------------------------------------------------------

/**
 * Get the distribution of users across values of a user property.
 * Used for country, device family, browser, platform breakdowns.
 *
 * @param property - User property to group by (e.g., "country", "device_family",
 *                   "os_name", "platform", "device_type")
 */
export async function getUserComposition(
  apiKey: string,
  secretKey: string,
  start: string,
  end: string,
  property: string
): Promise<AmplitudeCompositionResult> {
  return amplitudeFetch<AmplitudeCompositionResult>(
    "/composition",
    apiKey,
    secretKey,
    { start, end, p: property }
  );
}

// --- Event Segmentation ------------------------------------------------------

/**
 * Query event totals/uniques for a specific event type over a date range.
 * Optionally group by a property for breakdown analysis.
 *
 * @param eventType - The event name (e.g., "connectWallet", "renderOGImage")
 * @param metric - "totals" | "uniques" | "pct_dau" | "average"
 * @param groupBy - Optional property to group by (e.g., "connectorId")
 */
export async function getEventSegmentation(
  apiKey: string,
  secretKey: string,
  start: string,
  end: string,
  eventType: string,
  metric: "totals" | "uniques" | "pct_dau" | "average" = "totals",
  groupBy?: string
): Promise<AmplitudeEventSegmentResult> {
  const e = JSON.stringify({ event_type: eventType });
  const params: Record<string, string> = {
    start,
    end,
    e,
    m: metric === "totals" ? "totals" : metric === "uniques" ? "uniques" : metric,
    i: "1",
  };
  if (groupBy) {
    params.g = groupBy;
  }
  return amplitudeFetch<AmplitudeEventSegmentResult>(
    "/events/segmentation",
    apiKey,
    secretKey,
    params
  );
}

/**
 * Get a list of all events with their weekly totals (useful for discovery).
 */
export async function getEventsList(
  apiKey: string,
  secretKey: string
): Promise<{ data: Array<{ name: string; totals: number }> }> {
  return amplitudeFetch<{ data: Array<{ name: string; totals: number }> }>(
    "/events/list",
    apiKey,
    secretKey
  );
}

// --- Retention ---------------------------------------------------------------

/**
 * Query retention analysis.
 *
 * @param startEvent - The starting action (JSON: { event_type: "..." })
 * @param returnEvent - The return action (JSON: { event_type: "..." })
 * @param retentionMode - "bracket" | "rolling" | "n-day"
 */
export async function getRetention(
  apiKey: string,
  secretKey: string,
  start: string,
  end: string,
  startEvent?: string,
  returnEvent?: string,
  retentionMode: "bracket" | "rolling" | "n-day" = "rolling"
): Promise<AmplitudeRetentionResult> {
  const params: Record<string, string> = {
    start,
    end,
    rm: retentionMode,
  };
  if (startEvent) {
    params.se = JSON.stringify({ event_type: startEvent });
  }
  if (returnEvent) {
    params.re = JSON.stringify({ event_type: returnEvent });
  }
  return amplitudeFetch<AmplitudeRetentionResult>(
    "/retention",
    apiKey,
    secretKey,
    params
  );
}

// --- Revenue -----------------------------------------------------------------

/**
 * Get revenue metrics for a date range.
 */
export async function getRevenue(
  apiKey: string,
  secretKey: string,
  start: string,
  end: string
): Promise<AmplitudeMetricResult> {
  return amplitudeFetch<AmplitudeMetricResult>(
    "/revenue/day",
    apiKey,
    secretKey,
    { start, end }
  );
}
