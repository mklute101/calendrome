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
  status: 'UNCONFIRMED' | 'CONFIRMED';
}

export function syncCalendarEvents(
  db: DB,
  events: CalendarEventInput[],
): { upserted: number; deleted: number } {
  // Write into the unified time_entry table. On conflict (existing
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
  // Remove UNCONFIRMED gcal-sync time_entry rows in range. CONFIRMED rows
  // are historical — once a user has confirmed the time, the row outlives
  // the calendar event it originated from.
  return db
    .prepare(`
      DELETE FROM time_entry
       WHERE source = 'gcal-sync'
         AND status = 'UNCONFIRMED'
         AND external_id IS NOT NULL
         AND start_at >= ?
         AND start_at <= ?
    `)
    .run(from, to).changes as number;
}

export function listCalendarEvents(
  db: DB,
  from: string,
  to: string,
): CalendarEvent[] {
  // Reads gcal-sync rows from the unified time_entry table and projects
  // them into the legacy CalendarEvent shape so existing consumers (GUI
  // timeline, planner skill) keep working unchanged. `status` is included
  // so the GUI can visually flag past-UNCONFIRMED entries as "needs review".
  return db
    .prepare(
      `SELECT
         te.external_id                                       AS id,
         COALESCE(p.calendar_id, '')                          AS calendar_id,
         te.project_id                                        AS project_id,
         COALESCE(te.notes, '')                               AS summary,
         te.start_at                                          AS start,
         te.end_at                                            AS end,
         CAST(ROUND((julianday(te.end_at) - julianday(te.start_at)) * 24 * 60) AS INTEGER) AS duration_minutes,
         te.is_meeting                                        AS is_meeting,
         te.synced_at                                         AS synced_at,
         te.status                                            AS status
       FROM time_entry te
       LEFT JOIN projects p ON p.id = te.project_id
       WHERE te.source = 'gcal-sync'
         AND te.external_id IS NOT NULL
         AND te.start_at >= ?
         AND te.start_at <= ?
       ORDER BY te.start_at`,
    )
    .all(from, to) as CalendarEvent[];
}
