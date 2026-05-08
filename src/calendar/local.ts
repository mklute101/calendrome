import { randomUUID } from 'node:crypto';
import type {
  CalendarClient,
  CreateEventArgs,
  DeleteEventArgs,
} from './types.js';

/**
 * Production default until Phase 2 wires up Google.
 *
 * `place_task` only needs a stable `calendar_event_id` to stamp on the task —
 * the GUI and budget queries key off `tasks.calendar_event_id` + `tasks.due`,
 * not anything in an external calendar. Calendar events flow into calendrome
 * via `sync_calendar_events`, not the other way around.
 *
 * `createEvent` returns a UUID-based id that won't collide across MCP server
 * restarts (unlike `FakeCalendarClient`'s sequential `evt-N`). `deleteEvent`
 * is a no-op since there's nothing to delete locally.
 */
export class LocalCalendarClient implements CalendarClient {
  async createEvent(_args: CreateEventArgs): Promise<{ id: string }> {
    return { id: `local-${randomUUID()}` };
  }

  async deleteEvent(_args: DeleteEventArgs): Promise<void> {}
}
