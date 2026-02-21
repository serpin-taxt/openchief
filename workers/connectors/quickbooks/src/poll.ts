/**
 * QuickBooks Online polling logic.
 *
 * - Refreshes OAuth access token using stored refresh token
 * - Uses Change Data Capture (CDC) for incremental entity sync
 * - Fetches P&L and Balance Sheet reports
 * - Normalizes and publishes to the events queue
 */

import type { Env } from "./index";
import type { OpenChiefEvent } from "@openchief/shared";
import { generateULID } from "@openchief/shared";
import {
  normalizeInvoice,
  normalizePayment,
  normalizeCustomer,
  normalizeBill,
  normalizeProfitAndLoss,
  normalizeBalanceSheet,
} from "./normalize";

const QB_API = "https://quickbooks.api.intuit.com/v3/company";
const QB_SANDBOX_API = "https://sandbox-quickbooks.api.intuit.com/v3/company";
const KV_CURSOR_KEY = "qb:cursor";
const KV_DEDUP_PREFIX = "qb:dedup:";
const DEFAULT_LOOKBACK_DAYS = 7;
const DEDUP_TTL = 86400 * 7; // 7 days

// Entities we track via Change Data Capture
const CDC_ENTITIES = "Invoice,Payment,Customer,Bill,Estimate,Vendor";

// --- Token Management ---

export async function getAccessToken(env: Env): Promise<string> {
  // Check if we have a cached (non-expired) access token
  const cached = await env.KV.get("qb:access_token");
  if (cached) return cached;

  // Need to refresh
  const refreshToken = await env.KV.get("qb:refresh_token");
  if (!refreshToken) {
    throw new Error(
      "No refresh token stored. Complete the OAuth flow at /oauth/start first."
    );
  }

  const credentials = btoa(`${env.QB_CLIENT_ID}:${env.QB_CLIENT_SECRET}`);

  const resp = await fetch(
    "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
        Accept: "application/json",
      },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    }
  );

  const data = (await resp.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!resp.ok || !data.access_token) {
    throw new Error(
      `Token refresh failed: ${data.error || resp.status} — ${data.error_description || "unknown"}`
    );
  }

  // Cache with TTL slightly shorter than actual expiry
  const ttl = Math.max((data.expires_in || 3600) - 300, 60);
  await env.KV.put("qb:access_token", data.access_token, {
    expirationTtl: ttl,
  });

  // QuickBooks may rotate the refresh token on refresh
  if (data.refresh_token) {
    await env.KV.put("qb:refresh_token", data.refresh_token);
  }

  return data.access_token;
}

// --- QuickBooks API Helpers ---

function apiBase(): string {
  // Use production API
  return QB_API;
}

async function qbFetch(
  accessToken: string,
  realmId: string,
  path: string
): Promise<unknown> {
  const url = `${apiBase()}/${realmId}${path}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`QuickBooks API ${resp.status}: ${text.slice(0, 500)}`);
  }

  return resp.json();
}

// --- Change Data Capture ---

interface CDCResponse {
  CDCResponse?: Array<{
    QueryResponse?: Array<{
      [entity: string]: unknown[];
    }>;
  }>;
}

async function fetchCDC(
  accessToken: string,
  realmId: string,
  changedSince: string
): Promise<CDCResponse> {
  const params = new URLSearchParams({
    entities: CDC_ENTITIES,
    changedSince,
  });
  return (await qbFetch(
    accessToken,
    realmId,
    `/cdc?${params}`
  )) as CDCResponse;
}

// --- Report Fetching ---

interface QBReport {
  Header?: {
    ReportName?: string;
    DateMacro?: string;
    StartPeriod?: string;
    EndPeriod?: string;
    Currency?: string;
    ReportBasis?: string;
  };
  Columns?: { Column?: Array<{ ColTitle?: string; ColType?: string }> };
  Rows?: {
    Row?: Array<QBReportRow>;
  };
}

interface QBReportRow {
  type?: string; // "Section" | "Data" | "Total"
  group?: string;
  Header?: { ColData?: Array<{ value?: string }> };
  Rows?: { Row?: Array<QBReportRow> };
  Summary?: { ColData?: Array<{ value?: string }> };
  ColData?: Array<{ value?: string; id?: string }>;
}

async function fetchReport(
  accessToken: string,
  realmId: string,
  reportName: string,
  params?: Record<string, string>
): Promise<QBReport> {
  const searchParams = new URLSearchParams(params || {});
  return (await qbFetch(
    accessToken,
    realmId,
    `/reports/${reportName}?${searchParams}`
  )) as QBReport;
}

// --- Poll Orchestration ---

export async function runPollTasks(
  env: Env,
  lookbackDays?: number
): Promise<{ entitiesFound: number; eventsPublished: number; reportsPublished: number }> {
  const accessToken = await getAccessToken(env);
  const realmId = await env.KV.get("qb:realm_id");

  if (!realmId) {
    throw new Error(
      "No realm ID stored. Complete the OAuth flow at /oauth/start first."
    );
  }

  // Determine CDC cursor
  let changedSince: string;
  if (lookbackDays) {
    changedSince = new Date(
      Date.now() - lookbackDays * 86400_000
    ).toISOString();
  } else {
    const cursor = await env.KV.get(KV_CURSOR_KEY);
    changedSince =
      cursor ||
      new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400_000).toISOString();
  }

  let entitiesFound = 0;
  let eventsPublished = 0;
  let reportsPublished = 0;
  let latestTimestamp = changedSince;

  // -- 1. Change Data Capture for entities --
  try {
    const cdcData = await fetchCDC(accessToken, realmId, changedSince);
    const queryResponses = cdcData.CDCResponse?.[0]?.QueryResponse || [];

    for (const qr of queryResponses) {
      for (const [entityType, entities] of Object.entries(qr)) {
        if (!Array.isArray(entities)) continue;
        entitiesFound += entities.length;

        for (const entity of entities) {
          const e = entity as Record<string, unknown>;
          const meta = e.MetaData as
            | { LastUpdatedTime?: string; CreateTime?: string }
            | undefined;
          const entityId = (e.Id as string) || "";
          const updatedAt = meta?.LastUpdatedTime || meta?.CreateTime || "";

          // Dedup
          const dedupKey = `${KV_DEDUP_PREFIX}${entityType}:${entityId}:${updatedAt}`;
          const existing = await env.KV.get(dedupKey);
          if (existing) continue;

          // Normalize based on entity type
          let event;
          switch (entityType) {
            case "Invoice":
              event = normalizeInvoice(e, realmId);
              break;
            case "Payment":
              event = normalizePayment(e, realmId);
              break;
            case "Customer":
              event = normalizeCustomer(e, realmId);
              break;
            case "Bill":
              event = normalizeBill(e, realmId);
              break;
            default:
              // For Estimate, Vendor, etc. -- publish a generic event
              event = normalizeGenericEntity(entityType, e, realmId);
              break;
          }

          if (event) {
            await env.EVENTS_QUEUE.send(event);
            eventsPublished++;
            await env.KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL });
          }

          // Track latest timestamp for cursor
          if (updatedAt && updatedAt > latestTimestamp) {
            latestTimestamp = updatedAt;
          }
        }
      }
    }
  } catch (err) {
    console.error(
      "CDC fetch failed:",
      err instanceof Error ? err.message : err
    );
    // Don't throw -- still try reports
  }

  // -- 2. Financial Reports (P&L + Balance Sheet) --
  try {
    // Profit & Loss -- This Month
    const pnl = await fetchReport(accessToken, realmId, "ProfitAndLoss", {
      date_macro: "This Month",
    });
    const pnlEvent = normalizeProfitAndLoss(pnl, realmId);
    if (pnlEvent) {
      // Dedup reports by date
      const reportDedupKey = `${KV_DEDUP_PREFIX}report:pnl:${pnl.Header?.StartPeriod || "unknown"}`;
      const existing = await env.KV.get(reportDedupKey);
      if (!existing) {
        await env.EVENTS_QUEUE.send(pnlEvent);
        await env.KV.put(reportDedupKey, "1", { expirationTtl: DEDUP_TTL });
        reportsPublished++;
      }
    }

    // Balance Sheet -- current
    const bs = await fetchReport(accessToken, realmId, "BalanceSheet", {
      date_macro: "Today",
    });
    const bsEvent = normalizeBalanceSheet(bs, realmId);
    if (bsEvent) {
      const reportDedupKey = `${KV_DEDUP_PREFIX}report:bs:${new Date().toISOString().slice(0, 10)}`;
      const existing = await env.KV.get(reportDedupKey);
      if (!existing) {
        await env.EVENTS_QUEUE.send(bsEvent);
        await env.KV.put(reportDedupKey, "1", { expirationTtl: DEDUP_TTL });
        reportsPublished++;
      }
    }
  } catch (err) {
    console.error(
      "Report fetch failed:",
      err instanceof Error ? err.message : err
    );
  }

  // Update cursor
  if (latestTimestamp > changedSince) {
    await env.KV.put(KV_CURSOR_KEY, latestTimestamp, {
      expirationTtl: 86400 * 60,
    });
  }

  return { entitiesFound, eventsPublished, reportsPublished };
}

// --- Generic entity normalizer (for Estimate, Vendor, etc.) ---

function normalizeGenericEntity(
  entityType: string,
  entity: Record<string, unknown>,
  realmId: string
): OpenChiefEvent {
  const meta = entity.MetaData as
    | { LastUpdatedTime?: string; CreateTime?: string }
    | undefined;
  const timestamp = meta?.LastUpdatedTime || meta?.CreateTime || new Date().toISOString();
  const name =
    (entity.DisplayName as string) ||
    (entity.DocNumber as string) ||
    (entity.Id as string) ||
    "Unknown";

  return {
    id: generateULID(),
    timestamp,
    ingestedAt: new Date().toISOString(),
    source: "quickbooks",
    eventType: `${entityType.toLowerCase()}.updated`,
    scope: {
      org: realmId,
      project: "QuickBooks",
    },
    payload: entity,
    summary: `${entityType} "${name}" was updated`,
    tags: [entityType.toLowerCase()],
  };
}
