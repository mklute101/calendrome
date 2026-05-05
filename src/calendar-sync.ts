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
  const upsert = db.prepare(`
    INSERT OR REPLACE INTO calendar_events
      (id, calendar_id, project_id, summary, start, end, duration_minutes, is_meeting, synced_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  let upserted = 0;
  const txn = db.transaction(() => {
    for (const e of events) {
      const duration = computeDurationMinutes(e.start, e.end);
      upsert.run(
        e.id,
        e.calendar_id,
        e.project_id ?? null,
        e.summary,
        e.start,
        e.end,
        duration,
        e.is_meeting ? 1 : 0,
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
  const result = db
    .prepare(`DELETE FROM calendar_events WHERE start >= ? AND start <= ?`)
    .run(from, to);
  return result.changes;
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
