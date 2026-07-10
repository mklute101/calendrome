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
import { toCanonicalUtc, toDayRange } from './day-range.js';
import { buildMeetingProjectResolver } from './meeting-mappings.js';

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

/**
 * Prune window for mirror-sync (#93). When provided, gcal-sync
 * UNCONFIRMED rows inside the window whose `external_id` is not in
 * the synced payload are deleted — the event was cancelled or moved
 * out of the window in Google Calendar. Bounds are inclusive UTC day
 * buckets (`day-range.ts`, #92). CONFIRMED rows are historical and
 * always survive; placements/habits/manual rows are never touched.
 *
 * The prune is window-global, not per-calendar: it assumes the sync
 * payload is the complete truth for the window. If multiple calendar
 * feeds ever sync independently, scope the prune per feed first.
 */
export interface SyncWindow {
  from: string;
  to: string;
}

export function syncCalendarEvents(
  db: DB,
  events: CalendarEventInput[],
  window?: SyncWindow,
): { upserted: number; deleted: number } {
  // Write into the unified time_entry table. On conflict (existing
  // external_id), update only the sync-driven fields and leave confirmation
  // state (status, confirmed_at, actual_minutes, task_id) untouched.
  const upsertTimeEntry = db.prepare(`
    INSERT INTO time_entry (
      project_id, start_at, end_at, status, source, external_id, is_meeting, synced_at, notes
    ) VALUES (?, ?, ?, 'UNCONFIRMED', 'gcal-sync', ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
    ON CONFLICT(external_id) WHERE external_id IS NOT NULL DO UPDATE SET
      project_id = excluded.project_id,
      start_at   = excluded.start_at,
      end_at     = excluded.end_at,
      is_meeting = excluded.is_meeting,
      synced_at  = excluded.synced_at,
      notes      = excluded.notes,
      updated_at = datetime('now')
  `);

  // Title-pattern auto-assignment (#35): events arriving without an
  // explicit project_id are matched against meeting_project_mappings.
  // Explicit assignment (the skill matched a prefix) always wins.
  const resolveProject = buildMeetingProjectResolver(db);

  let upserted = 0;
  let deleted = 0;
  const txn = db.transaction(() => {
    for (const e of events) {
      upsertTimeEntry.run(
        e.project_id ?? resolveProject(e.summary),
        toCanonicalUtc(e.start, `event ${e.id} start`),
        toCanonicalUtc(e.end, `event ${e.id} end`),
        e.id,
        e.is_meeting ? 1 : 0,
        e.summary,
      );
      upserted++;
    }

    if (window) {
      const { fromDay, toDay } = toDayRange(window.from, window.to);
      const ids = events.map((e) => e.id);
      const notInPayload = ids.length
        ? `AND external_id NOT IN (${ids.map(() => '?').join(',')})`
        : '';
      deleted = db
        .prepare(`
          DELETE FROM time_entry
           WHERE source = 'gcal-sync'
             AND status = 'UNCONFIRMED'
             AND external_id IS NOT NULL
             AND DATE(start_at) >= ?
             AND DATE(start_at) <= ?
             ${notInPayload}
        `)
        .run(fromDay, toDay, ...ids).changes as number;
    }
  });
  txn();

  return { upserted, deleted };
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
