/**
 * Google Calendar polling logic.
 *
 * - Refreshes OAuth access token using stored refresh token
 * - Fetches calendar events updated since last poll cursor
 * - Normalizes and publishes to the events queue
 * - Deduplicates using KV keys per event ID + updated timestamp
 */

import type { Env } from "./index";
import { normalizeCalendarEvent } from "./normalize";

const GCAL_API = "https://www.googleapis.com/calendar/v3";
const KV_CURSOR_KEY = "gcal:cursor";
const KV_DEDUP_PREFIX = "gcal:dedup:";
const DEFAULT_LOOKBACK_DAYS = 7;
const DEDUP_TTL = 86400 * 7; // 7 days

// --- Token Management ---

/**
 * Get a valid access token, refreshing from the stored refresh token if needed.
 */
export async function getAccessToken(env: Env): Promise<string> {
  // Check if we have a cached (non-expired) access token
  const cached = await env.KV.get("gcal:access_token");
  if (cached) return cached;

  // Need to refresh
  const refreshToken = await env.KV.get("gcal:refresh_token");
  if (!refreshToken) {
    throw new Error(
      "No refresh token stored. Complete the OAuth flow at /oauth/start first."
    );
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = (await resp.json()) as {
    access_token?: string;
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
  await env.KV.put("gcal:access_token", data.access_token, {
    expirationTtl: ttl,
  });

  return data.access_token;
}

// --- Google Calendar API ---

interface GCalEvent {
  id: string;
  status: string; // "confirmed" | "tentative" | "cancelled"
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  created?: string;
  updated?: string;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string };
  attendees?: Array<{
    email: string;
    displayName?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
    resource?: boolean;
    optional?: boolean;
  }>;
  recurringEventId?: string;
  conferenceData?: {
    entryPoints?: Array<{
      entryPointType: string;
      uri: string;
      label?: string;
    }>;
    conferenceSolution?: { name?: string };
  };
  hangoutLink?: string;
  eventType?: string; // "default" | "focusTime" | "outOfOffice" | "workingLocation"
  transparency?: string; // "opaque" | "transparent"
}

interface GCalListResponse {
  items?: GCalEvent[];
  nextPageToken?: string;
  summary?: string; // Calendar name
}

async function listEvents(
  accessToken: string,
  calendarId: string,
  updatedMin: string,
  pageToken?: string
): Promise<GCalListResponse> {
  const params = new URLSearchParams({
    updatedMin,
    singleEvents: "true",
    orderBy: "updated",
    maxResults: "250",
    // Look at events from 30 days ago to 14 days from now
    timeMin: new Date(Date.now() - 30 * 86400_000).toISOString(),
    timeMax: new Date(Date.now() + 14 * 86400_000).toISOString(),
  });
  if (pageToken) params.set("pageToken", pageToken);

  const resp = await fetch(
    `${GCAL_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (!resp.ok) {
    const text = await resp.text();
    // Return special marker for 410 "updatedMin too old" so caller can retry
    if (resp.status === 410 && text.includes("updatedMinTooLongAgo")) {
      return { items: [], _tooOld: true } as GCalListResponse & { _tooOld?: boolean };
    }
    throw new Error(`Google Calendar API ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<GCalListResponse>;
}

// --- Poll Orchestration ---

export async function runPollTasks(
  env: Env,
  lookbackDays?: number
): Promise<{ eventsFound: number; eventsPublished: number }> {
  const accessToken = await getAccessToken(env);
  const calendarId = env.GOOGLE_CALENDAR_ID || "primary";

  // Determine the updatedMin cursor
  let updatedMin: string;
  if (lookbackDays) {
    // Explicit lookback (backfill mode)
    updatedMin = new Date(
      Date.now() - lookbackDays * 86400_000
    ).toISOString();
  } else {
    const cursor = await env.KV.get(KV_CURSOR_KEY);
    updatedMin =
      cursor ||
      new Date(Date.now() - DEFAULT_LOOKBACK_DAYS * 86400_000).toISOString();
  }

  let eventsFound = 0;
  let eventsPublished = 0;
  let latestUpdated = updatedMin;
  let pageToken: string | undefined;
  let calendarName = "Calendar";

  do {
    const response = await listEvents(
      accessToken,
      calendarId,
      updatedMin,
      pageToken
    ) as GCalListResponse & { _tooOld?: boolean };

    // If updatedMin was too old, retry with a 3-day window
    if (response._tooOld) {
      updatedMin = new Date(Date.now() - 3 * 86400_000).toISOString();
      continue;
    }

    if (response.summary) calendarName = response.summary;
    const items = response.items || [];
    eventsFound += items.length;

    for (const gcalEvent of items) {
      // Skip cancelled, focus time, out of office, and working location events
      if (gcalEvent.status === "cancelled") continue;
      if (
        gcalEvent.eventType &&
        gcalEvent.eventType !== "default"
      )
        continue;

      // Skip all-day events without a specific time (likely holidays, OOO blocks)
      if (gcalEvent.start?.date && !gcalEvent.start?.dateTime) continue;

      // Skip events without a title (personal blocks, etc.)
      if (!gcalEvent.summary) continue;

      // Dedup: skip if we've already published this exact version
      const dedupKey = `${KV_DEDUP_PREFIX}${gcalEvent.id}:${gcalEvent.updated}`;
      const existing = await env.KV.get(dedupKey);
      if (existing) continue;

      // Normalize and publish
      const event = normalizeCalendarEvent(gcalEvent, calendarName);
      await env.EVENTS_QUEUE.send(event);
      eventsPublished++;

      // Mark as published
      await env.KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL });

      // Track latest updated timestamp for cursor
      if (gcalEvent.updated && gcalEvent.updated > latestUpdated) {
        latestUpdated = gcalEvent.updated;
      }
    }

    pageToken = response.nextPageToken;
  } while (pageToken);

  // Update cursor to latest event's updated timestamp
  if (latestUpdated > updatedMin) {
    await env.KV.put(KV_CURSOR_KEY, latestUpdated, {
      expirationTtl: 86400 * 60, // Keep cursor for 60 days
    });
  }

  return { eventsFound, eventsPublished };
}
