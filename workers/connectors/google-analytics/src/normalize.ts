/**
 * Normalize GA4 report data into OpenChiefEvent format.
 *
 * Produces events for site overview, top pages, traffic sources,
 * top referrers, and geographic breakdown.
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";
import type { GA4ReportResponse } from "./ga-client";

// --- Helpers ---

function num(value: string | undefined): number {
  return value ? parseFloat(value) : 0;
}

function pct(value: number): string {
  return (value * 100).toFixed(1) + "%";
}

function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}m ${sec}s`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function changeStr(current: number, previous: number): string {
  if (previous === 0) return current > 0 ? " (new)" : "";
  const diff = current - previous;
  const pctChange = ((diff / previous) * 100).toFixed(1);
  const arrow = diff > 0 ? "^" : diff < 0 ? "v" : "->";
  return ` (${arrow}${Math.abs(parseFloat(pctChange))}% WoW)`;
}

// --- Site Overview ---

export function normalizeSiteOverview(
  current: GA4ReportResponse,
  previous: GA4ReportResponse,
  date: string,
  now: string
): OpenChiefEvent | null {
  const curRow = current.rows?.[0];
  const prevRow = previous.rows?.[0];
  if (!curRow?.metricValues) return null;

  const views = num(curRow.metricValues[0]?.value);
  const sessions = num(curRow.metricValues[1]?.value);
  const users = num(curRow.metricValues[2]?.value);
  const newUsers = num(curRow.metricValues[3]?.value);
  const engagementRate = num(curRow.metricValues[4]?.value);
  const avgDuration = num(curRow.metricValues[5]?.value);

  const prevViews = prevRow ? num(prevRow.metricValues?.[0]?.value) : 0;
  const prevSessions = prevRow ? num(prevRow.metricValues?.[1]?.value) : 0;
  const prevUsers = prevRow ? num(prevRow.metricValues?.[2]?.value) : 0;

  const parts = [
    `${fmtNum(views)} page views${changeStr(views, prevViews)}`,
    `${fmtNum(sessions)} sessions${changeStr(sessions, prevSessions)}`,
    `${fmtNum(users)} active users${changeStr(users, prevUsers)}`,
    `${fmtNum(newUsers)} new users`,
    `${pct(engagementRate)} engagement rate`,
    `${fmtDuration(avgDuration)} avg session`,
  ];

  return {
    id: generateULID(),
    timestamp: now,
    ingestedAt: now,
    source: "googleanalytics",
    eventType: "metric.site_overview",
    scope: {},
    payload: {
      date,
      views,
      sessions,
      activeUsers: users,
      newUsers,
      engagementRate,
      averageSessionDuration: avgDuration,
      previousViews: prevViews,
      previousSessions: prevSessions,
      previousUsers: prevUsers,
    },
    summary: `Site overview (${date}): ${parts.join(", ")}`,
    tags: ["googleanalytics", "metric", "site_overview"],
  };
}

// --- Top Pages ---

export function normalizeTopPages(
  report: GA4ReportResponse,
  date: string,
  now: string
): OpenChiefEvent | null {
  if (!report.rows?.length) return null;

  const pages = report.rows.map((row) => ({
    path: row.dimensionValues?.[0]?.value || "/",
    title: row.dimensionValues?.[1]?.value || "(untitled)",
    views: num(row.metricValues?.[0]?.value),
    users: num(row.metricValues?.[1]?.value),
    avgDuration: num(row.metricValues?.[2]?.value),
    bounceRate: num(row.metricValues?.[3]?.value),
  }));

  const topSummary = pages
    .slice(0, 5)
    .map((p) => `${p.path} (${fmtNum(p.views)} views)`)
    .join(", ");

  return {
    id: generateULID(),
    timestamp: now,
    ingestedAt: now,
    source: "googleanalytics",
    eventType: "metric.top_pages",
    scope: {},
    payload: {
      date,
      pages,
      totalPages: pages.length,
    },
    summary: `Top pages (${date}): ${topSummary}`,
    tags: ["googleanalytics", "metric", "top_pages"],
  };
}

// --- Traffic Sources ---

export function normalizeTrafficSources(
  report: GA4ReportResponse,
  date: string,
  now: string
): OpenChiefEvent | null {
  if (!report.rows?.length) return null;

  const sources = report.rows.map((row) => ({
    sourceMedium: row.dimensionValues?.[0]?.value || "(unknown)",
    sessions: num(row.metricValues?.[0]?.value),
    users: num(row.metricValues?.[1]?.value),
    newUsers: num(row.metricValues?.[2]?.value),
  }));

  const totalSessions = sources.reduce((sum, s) => sum + s.sessions, 0);

  const topSummary = sources
    .slice(0, 5)
    .map((s) => {
      const share = totalSessions > 0 ? ((s.sessions / totalSessions) * 100).toFixed(1) : "0";
      return `${s.sourceMedium} (${share}%)`;
    })
    .join(", ");

  return {
    id: generateULID(),
    timestamp: now,
    ingestedAt: now,
    source: "googleanalytics",
    eventType: "metric.traffic_sources",
    scope: {},
    payload: {
      date,
      sources,
      totalSessions,
    },
    summary: `Traffic sources (${date}): ${topSummary}`,
    tags: ["googleanalytics", "metric", "traffic_sources"],
  };
}

// --- Top Referrers ---

export function normalizeTopReferrers(
  report: GA4ReportResponse,
  startDate: string,
  endDate: string,
  now: string
): OpenChiefEvent | null {
  if (!report.rows?.length) return null;

  const referrers = report.rows
    .map((row) => ({
      referrer: row.dimensionValues?.[0]?.value || "(unknown)",
      sessions: num(row.metricValues?.[0]?.value),
      users: num(row.metricValues?.[1]?.value),
    }))
    .filter((r) => r.referrer !== "(not set)" && r.referrer !== "(direct)");

  if (referrers.length === 0) return null;

  const topSummary = referrers
    .slice(0, 5)
    .map((r) => `${r.referrer} (${fmtNum(r.sessions)} sessions)`)
    .join(", ");

  return {
    id: generateULID(),
    timestamp: now,
    ingestedAt: now,
    source: "googleanalytics",
    eventType: "metric.top_referrers",
    scope: {},
    payload: {
      startDate,
      endDate,
      referrers,
    },
    summary: `Top referrers (${startDate} to ${endDate}): ${topSummary}`,
    tags: ["googleanalytics", "metric", "top_referrers"],
  };
}

// --- Geographic Breakdown ---

export function normalizeGeography(
  report: GA4ReportResponse,
  startDate: string,
  endDate: string,
  now: string
): OpenChiefEvent | null {
  if (!report.rows?.length) return null;

  const countries = report.rows.map((row) => ({
    country: row.dimensionValues?.[0]?.value || "(unknown)",
    users: num(row.metricValues?.[0]?.value),
    sessions: num(row.metricValues?.[1]?.value),
  }));

  const totalUsers = countries.reduce((sum, c) => sum + c.users, 0);

  const topSummary = countries
    .slice(0, 5)
    .map((c) => {
      const share = totalUsers > 0 ? ((c.users / totalUsers) * 100).toFixed(1) : "0";
      return `${c.country} (${share}%)`;
    })
    .join(", ");

  return {
    id: generateULID(),
    timestamp: now,
    ingestedAt: now,
    source: "googleanalytics",
    eventType: "metric.geo_breakdown",
    scope: {},
    payload: {
      startDate,
      endDate,
      countries,
      totalUsers,
    },
    summary: `Users by country (${startDate} to ${endDate}): ${topSummary}`,
    tags: ["googleanalytics", "metric", "geo_breakdown"],
  };
}
