/**
 * Normalize Google Calendar events -> OpenChiefEvent format.
 */

import { generateULID } from "@openchief/shared";
import type { OpenChiefEvent } from "@openchief/shared";

// --- Types ---

interface GCalEvent {
  id: string;
  status: string;
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
  eventType?: string;
  transparency?: string;
}

// --- Normalization ---

export function normalizeCalendarEvent(
  gcal: GCalEvent,
  calendarName: string
): OpenChiefEvent {
  const now = new Date();
  const startTime = gcal.start?.dateTime || gcal.start?.date || "";
  const endTime = gcal.end?.dateTime || gcal.end?.date || "";
  const eventStart = startTime ? new Date(startTime) : null;

  // Determine event type based on timing
  const eventType = eventStart && eventStart > now
    ? "meeting.upcoming"
    : "meeting.completed";

  // Build attendee list (excluding rooms/resources)
  const humanAttendees = (gcal.attendees || []).filter(
    (a) => !a.resource
  );
  const externalAttendees = humanAttendees.filter((a) => {
    if (!a.email || !gcal.organizer?.email) return false;
    const orgDomain = gcal.organizer.email.split("@")[1];
    return a.email.split("@")[1] !== orgDomain;
  });

  // Calculate duration
  const durationMin =
    eventStart && endTime
      ? Math.round(
          (new Date(endTime).getTime() - eventStart.getTime()) / 60_000
        )
      : null;

  // Build human-readable summary
  const parts: string[] = [];
  parts.push(`Meeting: ${gcal.summary || "Untitled"}`);

  if (humanAttendees.length > 0) {
    const names = humanAttendees
      .filter((a) => !a.self)
      .slice(0, 5)
      .map((a) => a.displayName || a.email)
      .join(", ");
    if (names) parts.push(`with ${names}`);
    if (humanAttendees.filter((a) => !a.self).length > 5) {
      parts.push(
        `+${humanAttendees.filter((a) => !a.self).length - 5} others`
      );
    }
  }

  if (durationMin) parts.push(`(${formatDuration(durationMin)})`);

  // Conference info
  const conferenceName =
    gcal.conferenceData?.conferenceSolution?.name ||
    (gcal.hangoutLink ? "Google Meet" : null);
  if (conferenceName) parts.push(`via ${conferenceName}`);

  if (startTime) {
    const d = new Date(startTime);
    parts.push(
      `on ${d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })} at ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    );
  }

  // Tags
  const tags: string[] = [];
  if (gcal.recurringEventId) tags.push("recurring");
  if (externalAttendees.length > 0) tags.push("external");
  if (humanAttendees.length === 2) tags.push("1on1");
  if (humanAttendees.length > 5) tags.push("large-meeting");
  if (durationMin && durationMin >= 60) tags.push("long");

  // Slim payload -- only what agents need
  const payload: Record<string, unknown> = {
    gcal_id: gcal.id,
    title: gcal.summary,
    start: startTime,
    end: endTime,
    duration_minutes: durationMin,
    location: gcal.location || null,
    organizer: gcal.organizer
      ? {
          email: gcal.organizer.email,
          name: gcal.organizer.displayName,
          self: gcal.organizer.self,
        }
      : null,
    attendees: humanAttendees.map((a) => ({
      email: a.email,
      name: a.displayName || null,
      response: a.responseStatus || "needsAction",
      self: a.self || false,
    })),
    attendee_count: humanAttendees.length,
    external_attendee_count: externalAttendees.length,
    is_recurring: !!gcal.recurringEventId,
    conference: conferenceName || null,
    link: gcal.htmlLink || null,
  };

  // Include description snippet (first 500 chars) if present
  if (gcal.description) {
    payload.description_preview = gcal.description.slice(0, 500);
  }

  return {
    id: generateULID(),
    timestamp: gcal.updated || gcal.created || new Date().toISOString(),
    ingestedAt: now.toISOString(),
    source: "googlecalendar",
    eventType,
    scope: {
      org: gcal.organizer?.email?.split("@")[1] || undefined,
      project: calendarName,
      actor: gcal.organizer?.email || gcal.creator?.email || undefined,
    },
    payload,
    summary: parts.join(" "),
    tags: tags.length > 0 ? tags : undefined,
  };
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}
