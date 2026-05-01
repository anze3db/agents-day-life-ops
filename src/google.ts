/**
 * Minimal Google Calendar API client for Life Ops.
 *
 * Uses an OAuth 2.0 access token (Bearer auth). The simplest way to obtain
 * one for the demo is via Google's OAuth Playground:
 * https://developers.google.com/oauthplayground/ — pick the
 * `https://www.googleapis.com/auth/calendar.events.readonly` scope, authorize
 * for the user's account, and copy the access token. Tokens expire in ~1h.
 */

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export type CalendarEvent = {
  id: string;
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  status?: string;
  transparency?: "transparent" | "opaque";
};

export class GoogleCalendarClient {
  constructor(private readonly accessToken: string) {}

  /** Fetch primary-calendar events overlapping [from, to]. */
  async listEvents(
    fromMs: number,
    toMs: number
  ): Promise<CalendarEvent[]> {
    const params = new URLSearchParams({
      timeMin: new Date(fromMs).toISOString(),
      timeMax: new Date(toMs).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "50"
    });
    const res = await fetch(
      `${CALENDAR_API_BASE}/calendars/primary/events?${params.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: "application/json"
        }
      }
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Google Calendar ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { items?: CalendarEvent[] };
    return data.items ?? [];
  }
}

/**
 * Convert a Google Calendar event to a busy window in unix ms. Returns null
 * if the event shouldn't be considered busy (transparent, all-day, declined).
 */
export function eventToBusyWindow(event: CalendarEvent): {
  start: number;
  end: number;
  title: string;
} | null {
  if (event.status === "cancelled") return null;
  if (event.transparency === "transparent") return null;

  // Prefer dateTime (timed events); fall back to date (all-day events).
  // All-day events are still treated as busy — that's the agents-day case.
  const startStr = event.start?.dateTime ?? event.start?.date;
  const endStr = event.end?.dateTime ?? event.end?.date;
  if (!startStr || !endStr) return null;

  const start = new Date(startStr).getTime();
  const end = new Date(endStr).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  return {
    start,
    end,
    title: event.summary ?? "Busy"
  };
}
