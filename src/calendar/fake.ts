import type {
  CalendarClient,
  CalendarEvent,
  CreateEventArgs,
  DeleteEventArgs,
} from './types.js';

/**
 * In-memory CalendarClient for tests and local dry-runs.
 *
 * Records every created event in `events` so tests can assert on them, and
 * supports deletion. IDs are deterministic (`evt-1`, `evt-2`, ...) which
 * keeps snapshot-style tests stable.
 */
export class FakeCalendarClient implements CalendarClient {
  events: CalendarEvent[] = [];
  private nextId = 1;

  async createEvent(args: CreateEventArgs): Promise<{ id: string }> {
    const id = `evt-${this.nextId++}`;
    this.events.push({
      id,
      calendar_id: args.calendar_id,
      summary: args.summary,
      start: args.start,
      end: args.end,
      description: args.description,
    });
    return { id };
  }

  async deleteEvent(args: DeleteEventArgs): Promise<void> {
    const before = this.events.length;
    this.events = this.events.filter((e) => e.id !== args.event_id);
    if (this.events.length === before) {
      throw new Error(`event ${args.event_id} not found`);
    }
  }

  /** Convenience: find an event by id (returns undefined if missing). */
  getEvent(id: string): CalendarEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** Convenience: list events on a specific calendar (or all if null). */
  listEvents(calendarId?: string | null): CalendarEvent[] {
    if (calendarId === undefined) return [...this.events];
    return this.events.filter((e) => e.calendar_id === calendarId);
  }

  /** Reset state between tests. */
  reset(): void {
    this.events = [];
    this.nextId = 1;
  }
}
