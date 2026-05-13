import type { DB } from './db/connection.js';

export type TimeEntryStatus = 'UNCONFIRMED' | 'CONFIRMED';
export type TimeEntrySource = 'placement' | 'gcal-sync' | 'habit' | 'manual';

export interface TimeEntryInput {
  task_id?: number | null;
  project_id?: string | null;
  start_at: string;
  end_at: string;
  actual_minutes?: number | null;
  status: TimeEntryStatus;
  confirmed_at?: string | null;
  source: TimeEntrySource;
  external_id?: string | null;
  is_meeting?: boolean;
  synced_at?: string | null;
  harvest_entry_id?: number | null;
  notes?: string | null;
}

export function insertTimeEntry(db: DB, input: TimeEntryInput): number {
  const stmt = db.prepare(`
    INSERT INTO time_entry (
      task_id, project_id, start_at, end_at, actual_minutes,
      status, confirmed_at, source, external_id, is_meeting,
      synced_at, harvest_entry_id, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.task_id ?? null,
    input.project_id ?? null,
    input.start_at,
    input.end_at,
    input.actual_minutes ?? null,
    input.status,
    input.confirmed_at ?? null,
    input.source,
    input.external_id ?? null,
    input.is_meeting ? 1 : 0,
    input.synced_at ?? null,
    input.harvest_entry_id ?? null,
    input.notes ?? null,
  );
  return Number(result.lastInsertRowid);
}
