/**
 * GA4 polling orchestrator.
 *
 * Fetches daily analytics reports from GA4 Data API, normalizes them
 * into OpenChiefEvents, and enqueues them for downstream processing.
 *
 * Uses KV-backed date cursors to avoid re-processing the same day,
 * and stores site overview snapshots for week-over-week comparisons.
 */

import type { OpenChiefEvent } from "@openchief/shared";
import { GA4Client } from "./ga-client";
import {
  normalizeSiteOverview,
  normalizeTopPages,
  normalizeTrafficSources,
  normalizeTopReferrers,
  normalizeGeography,
} from "./normalize";

// --- KV Keys ---

const KV_CURSOR = "ga4:cursor:last_date";
const KV_DEDUP_PREFIX = "ga4:dedup:";
const KV_TTL = 3 * 24 * 60 * 60; // 3 days for dedup keys

// --- Types ---

export interface PollResult {
  date: string;
  siteOverview: boolean;
  topPages: number;
  trafficSources: number;
  topReferrers: number;
  geography: number;
  totalEvents: number;
  skipped: boolean;
}

interface PollEnv {
  EVENTS_QUEUE: Queue;
  KV: KVNamespace;
  GA4_SERVICE_ACCOUNT_KEY: string;
  GA4_PROPERTY_ID: string;
}

interface PollOptions {
  backfill?: boolean;
}

// --- Date Helpers ---

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(days: number): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// --- Main Poll Function ---

export async function pollGA4(
  env: PollEnv,
  options?: PollOptions
): Promise<PollResult> {
  const yesterday = formatDate(daysAgo(1));
  const sevenDaysAgo = formatDate(daysAgo(7));
  const eightDaysAgo = formatDate(daysAgo(8)); // For WoW comparison
  const now = new Date().toISOString();

  // -- Dedup check --
  if (!options?.backfill) {
    const dedupKey = `${KV_DEDUP_PREFIX}${yesterday}`;
    const alreadyPolled = await env.KV.get(dedupKey);
    if (alreadyPolled) {
      console.log(`GA4: Already polled for ${yesterday}, skipping`);
      return {
        date: yesterday,
        siteOverview: false,
        topPages: 0,
        trafficSources: 0,
        topReferrers: 0,
        geography: 0,
        totalEvents: 0,
        skipped: true,
      };
    }
  }

  const client = new GA4Client(env.GA4_SERVICE_ACCOUNT_KEY, env.GA4_PROPERTY_ID);
  const allEvents: OpenChiefEvent[] = [];
  const errors: string[] = [];

  // -- 1. Site Overview (yesterday vs 8 days ago for WoW) --
  let siteOverviewOk = false;
  try {
    const { current, previous } = await client.getSiteOverview(yesterday, eightDaysAgo);
    const event = normalizeSiteOverview(current, previous, yesterday, now);
    if (event) {
      allEvents.push(event);
      siteOverviewOk = true;
    }
  } catch (err) {
    errors.push(`Site overview: ${err instanceof Error ? err.message : err}`);
  }

  // -- 2. Top Pages --
  let topPagesCount = 0;
  try {
    const report = await client.getPagePerformance(yesterday);
    const event = normalizeTopPages(report, yesterday, now);
    if (event) {
      allEvents.push(event);
      topPagesCount = (event.payload as { totalPages?: number }).totalPages || 0;
    }
  } catch (err) {
    errors.push(`Top pages: ${err instanceof Error ? err.message : err}`);
  }

  // -- 3. Traffic Sources --
  let trafficSourcesCount = 0;
  try {
    const report = await client.getTrafficSources(yesterday);
    const event = normalizeTrafficSources(report, yesterday, now);
    if (event) {
      allEvents.push(event);
      trafficSourcesCount = (event.payload as { sources?: unknown[] }).sources?.length || 0;
    }
  } catch (err) {
    errors.push(`Traffic sources: ${err instanceof Error ? err.message : err}`);
  }

  // -- 4. Top Referrers (last 7 days) --
  let referrersCount = 0;
  try {
    const report = await client.getTopReferrers(sevenDaysAgo, yesterday);
    const event = normalizeTopReferrers(report, sevenDaysAgo, yesterday, now);
    if (event) {
      allEvents.push(event);
      referrersCount = (event.payload as { referrers?: unknown[] }).referrers?.length || 0;
    }
  } catch (err) {
    errors.push(`Top referrers: ${err instanceof Error ? err.message : err}`);
  }

  // -- 5. Geography (last 7 days) --
  let geoCount = 0;
  try {
    const report = await client.getGeography(sevenDaysAgo, yesterday);
    const event = normalizeGeography(report, sevenDaysAgo, yesterday, now);
    if (event) {
      allEvents.push(event);
      geoCount = (event.payload as { countries?: unknown[] }).countries?.length || 0;
    }
  } catch (err) {
    errors.push(`Geography: ${err instanceof Error ? err.message : err}`);
  }

  // -- Enqueue events --
  for (const event of allEvents) {
    await env.EVENTS_QUEUE.send(event);
  }

  // -- Update cursor + dedup --
  if (allEvents.length > 0) {
    await env.KV.put(KV_CURSOR, yesterday);
    await env.KV.put(`${KV_DEDUP_PREFIX}${yesterday}`, "1", {
      expirationTtl: KV_TTL,
    });
  }

  if (errors.length > 0) {
    console.warn("GA4 poll partial errors:", errors.join("; "));
  }

  return {
    date: yesterday,
    siteOverview: siteOverviewOk,
    topPages: topPagesCount,
    trafficSources: trafficSourcesCount,
    topReferrers: referrersCount,
    geography: geoCount,
    totalEvents: allEvents.length,
    skipped: false,
  };
}
