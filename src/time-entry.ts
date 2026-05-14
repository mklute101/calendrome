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

export interface ConfirmOptions {
  actual_minutes?: number | null;
  project_id?: string | null;
  notes?: string | null;
}

export function confirmTimeEntry(db: DB, id: number, opts: ConfirmOptions): void {
  const existing = db.prepare(`SELECT status FROM time_entry WHERE id = ?`).get(id) as { status: string } | undefined;
  if (!existing) throw new Error(`time_entry ${id} not found`);
  if (existing.status === 'CONFIRMED') return; // idempotent no-op

  const sets: string[] = ["status = 'CONFIRMED'", "confirmed_at = datetime('now')", "updated_at = datetime('now')"];
  const args: (number | string | null)[] = [];
  if (opts.actual_minutes !== undefined) {
    sets.push('actual_minutes = ?');
    args.push(opts.actual_minutes ?? null);
  }
  if (opts.project_id !== undefined) {
    sets.push('project_id = ?');
    args.push(opts.project_id ?? null);
  }
  if (opts.notes !== undefined) {
    sets.push('notes = ?');
    args.push(opts.notes ?? null);
  }
  args.push(id);
  db.prepare(`UPDATE time_entry SET ${sets.join(', ')} WHERE id = ?`).run(...args);
}

export function skipTimeEntry(db: DB, id: number): void {
  const existing = db.prepare(`SELECT status, source FROM time_entry WHERE id = ?`)
    .get(id) as { status: string; source: string } | undefined;
  if (!existing) throw new Error(`time_entry ${id} not found`);
  if (existing.status === 'CONFIRMED') throw new Error('cannot skip a confirmed entry');
  if (existing.source === 'gcal-sync') {
    throw new Error('cannot skip a gcal-synced entry; delete it in Google Calendar and re-sync');
  }
  db.prepare(`DELETE FROM time_entry WHERE id = ?`).run(id);
}
