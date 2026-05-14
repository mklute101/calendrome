/**
 * Calendar event sync — inbound mirror of Google Calendar (or any source).
 *
 * Calendrome doesn't fetch from Google itself; the planner skill calls
 * the Google Calendar MCP and pushes events here via
 * `sync_calendar_events`. Stored events power the timeline view's
 * meeting/habit overlays and the "available focus time" calculation.
 * Idempotent: re-syncing the same event id updates in place.
 */
import type { DB } from './db/connection.js';

export interface CalendarEventInput {
  id: string;
  calendar_id: string;
  project_id?: string | null;
  summary: string;
  start: string;  // ISO 8601
  end: string;    // ISO 8601
  is_meeting?: boolean;
}

export interface CalendarEvent {
  id: string;
  calendar_id: string;
  project_id: string | null;
  summary: string;
  start: string;
  end: string;
  duration_minutes: number;
  is_meeting: number;
  synced_at: string;
}

function computeDurationMinutes(start: string, end: string): number {
  const ms = Date.parse(end) - Date.parse(start);
  return Math.round(ms / 60_000);
}

export function syncCalendarEvents(
  db: DB,
  events: CalendarEventInput[],
): { upserted: number; deleted: number } {
  const upsertLegacy = db.prepare(`
    INSERT OR REPLACE INTO calendar_events
      (id, calendar_id, project_id, summary, start, end, duration_minutes, is_meeting, synced_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  // Dual-write into the unified time_entry table. On conflict (existing
  // external_id), update only the sync-driven fields and leave confirmation
  // state (status, confirmed_at, actual_minutes, task_id) untouched.
  const upsertTimeEntry = db.prepare(`
    INSERT INTO time_entry (
      project_id, start_at, end_at, status, source, external_id, is_meeting, synced_at, notes
    ) VALUES (?, ?, ?, 'UNCONFIRMED', 'gcal-sync', ?, ?, datetime('now'), ?)
    ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET
      project_id = excluded.project_id,
      start_at   = excluded.start_at,
      end_at     = excluded.end_at,
      is_meeting = excluded.is_meeting,
      synced_at  = excluded.synced_at,
      notes      = excluded.notes,
      updated_at = datetime('now')
  `);

  let upserted = 0;
  const txn = db.transaction(() => {
    for (const e of events) {
      const duration = computeDurationMinutes(e.start, e.end);
      upsertLegacy.run(
        e.id,
        e.calendar_id,
        e.project_id ?? null,
        e.summary,
        e.start,
        e.end,
        duration,
        e.is_meeting ? 1 : 0,
      );
      upsertTimeEntry.run(
        e.project_id ?? null,
        e.start,
        e.end,
        e.id,
        e.is_meeting ? 1 : 0,
        e.summary,
      );
      upserted++;
    }
  });
  txn();

  return { upserted, deleted: 0 };
}

export function deleteCalendarEventsInRange(
  db: DB,
  from: string,
  to: string,
): number {
  const txn = db.transaction(() => {
    // Remove UNCONFIRMED gcal-sync time_entry rows in range. CONFIRMED rows
    // are historical — once a user has confirmed the time, the row outlives
    // the calendar event it originated from.
    db.prepare(`
      DELETE FROM time_entry
       WHERE source = 'gcal-sync'
         AND status = 'UNCONFIRMED'
         AND external_id IS NOT NULL
         AND start_at >= ?
         AND start_at <= ?
    `).run(from, to);

    return db
      .prepare(`DELETE FROM calendar_events WHERE start >= ? AND start <= ?`)
      .run(from, to).changes;
  });
  return txn() as number;
}

export function listCalendarEvents(
  db: DB,
  from: string,
  to: string,
): CalendarEvent[] {
  return db
    .prepare(
      `SELECT * FROM calendar_events
       WHERE start >= ? AND start <= ?
       ORDER BY start`,
    )
    .all(from, to) as CalendarEvent[];
}
