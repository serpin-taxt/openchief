/**
 * Google Analytics 4 Data API v1beta client.
 *
 * Uses the GA4 Data API to run reports for page performance,
 * traffic sources, referrers, geography, and site overview.
 */

import { getAccessToken } from "./jwt";

const BASE_URL = "https://analyticsdata.googleapis.com/v1beta";
const MAX_RETRIES = 3;

// --- Types ---

export interface GA4ReportRequest {
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions?: Array<{ name: string }>;
  metrics: Array<{ name: string }>;
  orderBys?: Array<{
    metric?: { metricName: string };
    dimension?: { dimensionName: string };
    desc?: boolean;
  }>;
  limit?: number;
  metricFilter?: unknown;
  dimensionFilter?: unknown;
}

export interface GA4ReportRow {
  dimensionValues?: Array<{ value: string }>;
  metricValues?: Array<{ value: string }>;
}

export interface GA4ReportResponse {
  rows?: GA4ReportRow[];
  totals?: Array<{ metricValues?: Array<{ value: string }> }>;
  rowCount?: number;
  metadata?: {
    currencyCode?: string;
    timeZone?: string;
  };
  propertyQuota?: {
    tokensPerDay?: { consumed: number; remaining: number };
    tokensPerHour?: { consumed: number; remaining: number };
  };
}

// --- Client ---

export class GA4Client {
  constructor(
    private serviceAccountKey: string,
    private propertyId: string
  ) {}

  /**
   * Run a single GA4 report.
   */
  async runReport(request: GA4ReportRequest): Promise<GA4ReportResponse> {
    const token = await getAccessToken(this.serviceAccountKey);
    const url = `${BASE_URL}/properties/${this.propertyId}:runReport`;

    return this.fetchWithRetry(url, token, {
      ...request,
      returnPropertyQuota: true,
    });
  }

  /**
   * Fetch page performance: top pages by views with engagement metrics.
   */
  async getPagePerformance(date: string): Promise<GA4ReportResponse> {
    return this.runReport({
      dateRanges: [{ startDate: date, endDate: date }],
      dimensions: [
        { name: "pagePath" },
        { name: "pageTitle" },
      ],
      metrics: [
        { name: "screenPageViews" },
        { name: "activeUsers" },
        { name: "averageSessionDuration" },
        { name: "bounceRate" },
      ],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 25,
    });
  }

  /**
   * Fetch traffic sources breakdown.
   */
  async getTrafficSources(date: string): Promise<GA4ReportResponse> {
    return this.runReport({
      dateRanges: [{ startDate: date, endDate: date }],
      dimensions: [{ name: "sessionSourceMedium" }],
      metrics: [
        { name: "sessions" },
        { name: "activeUsers" },
        { name: "newUsers" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 20,
    });
  }

  /**
   * Fetch site overview totals (yesterday + 7 days ago for WoW comparison).
   */
  async getSiteOverview(
    date: string,
    comparisonDate: string
  ): Promise<{ current: GA4ReportResponse; previous: GA4ReportResponse }> {
    const [current, previous] = await Promise.all([
      this.runReport({
        dateRanges: [{ startDate: date, endDate: date }],
        metrics: [
          { name: "screenPageViews" },
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "newUsers" },
          { name: "engagementRate" },
          { name: "averageSessionDuration" },
        ],
      }),
      this.runReport({
        dateRanges: [{ startDate: comparisonDate, endDate: comparisonDate }],
        metrics: [
          { name: "screenPageViews" },
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "newUsers" },
          { name: "engagementRate" },
          { name: "averageSessionDuration" },
        ],
      }),
    ]);

    return { current, previous };
  }

  /**
   * Fetch top referrers over a date range.
   */
  async getTopReferrers(startDate: string, endDate: string): Promise<GA4ReportResponse> {
    return this.runReport({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "pageReferrer" }],
      metrics: [
        { name: "sessions" },
        { name: "activeUsers" },
      ],
      orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
      limit: 20,
    });
  }

  /**
   * Fetch geographic breakdown of users.
   */
  async getGeography(startDate: string, endDate: string): Promise<GA4ReportResponse> {
    return this.runReport({
      dateRanges: [{ startDate, endDate }],
      dimensions: [{ name: "country" }],
      metrics: [
        { name: "activeUsers" },
        { name: "sessions" },
      ],
      orderBys: [{ metric: { metricName: "activeUsers" }, desc: true }],
      limit: 15,
    });
  }

  // --- HTTP Helper ---

  private async fetchWithRetry(
    url: string,
    token: string,
    body: Record<string, unknown>,
    retries = MAX_RETRIES
  ): Promise<GA4ReportResponse> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.status === 429 && attempt < retries) {
        const waitMs = (attempt + 1) * 2000;
        console.log(`GA4 rate limited, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (response.status >= 500 && attempt < retries) {
        const waitMs = (attempt + 1) * 3000;
        console.log(`GA4 server error ${response.status}, retrying in ${waitMs}ms`);
        await sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GA4 API error ${response.status}: ${text.slice(0, 500)}`);
      }

      return (await response.json()) as GA4ReportResponse;
    }

    throw new Error(`GA4 API failed after ${retries} retries`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
