/**
 * Calendar adapter interface.
 *
 * Phase 1 ships an in-memory `FakeCalendarClient` (used by tests) and a
 * `GoogleCalendarClient` skeleton that throws `NotImplementedError` until
 * Phase 2 wires up real OAuth + googleapis.
 *
 * The MCP tool layer takes any `CalendarClient` via `buildTools(db, { calendar })`,
 * so swapping fake → real is a one-line change at server startup.
 */

export interface CreateEventArgs {
  calendar_id: string | null;
  summary: string;
  start: string; // ISO 8601
  end: string; // ISO 8601
  description?: string;
}

export interface DeleteEventArgs {
  calendar_id: string | null;
  event_id: string;
}

export interface CalendarEvent {
  id: string;
  calendar_id: string | null;
  summary: string;
  start: string;
  end: string;
  description?: string;
}

export interface CalendarClient {
  createEvent(args: CreateEventArgs): Promise<{ id: string }>;
  deleteEvent(args: DeleteEventArgs): Promise<void>;
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}
