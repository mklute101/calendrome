import type { DB } from './db/connection.js';
import { now, nowDate } from './clock.js';
import { toCanonicalUtc, toDayRange } from './day-range.js';
import { recordEntityWrite } from './observability/spans.js';

export type TimeEntryStatus = 'UNCONFIRMED' | 'CONFIRMED';
export type TimeEntrySource = 'placement' | 'gcal-sync' | 'habit' | 'manual';

export interface TimeEntryInput {
  task_id?: number | null;
  project_id?: string | null;
  goal_id?: number | null;
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
  const stamp = now();
  const startAt = toCanonicalUtc(input.start_at, 'start_at');
  const stmt = db.prepare(`
    INSERT INTO time_entry (
      task_id, project_id, goal_id, start_at, end_at, actual_minutes,
      status, confirmed_at, source, external_id, is_meeting,
      synced_at, harvest_entry_id, notes, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.task_id ?? null,
    input.project_id ?? null,
    input.goal_id ?? null,
    startAt,
    toCanonicalUtc(input.end_at, 'end_at'),
    input.actual_minutes ?? null,
    input.status,
    input.confirmed_at != null ? toCanonicalUtc(input.confirmed_at, 'confirmed_at') : null,
    input.source,
    input.external_id ?? null,
    input.is_meeting ? 1 : 0,
    input.synced_at != null ? toCanonicalUtc(input.synced_at, 'synced_at') : null,
    input.harvest_entry_id ?? null,
    input.notes ?? null,
    stamp,
    stamp,
  );
  const id = Number(result.lastInsertRowid);
  // Wide-span annotation (#163): the start timestamp triggers the
  // local/UTC day-bucketing pair on the active span. No-op when no
  // SDK is registered.
  recordEntityWrite({ entity_type: 'time_entry', entity_id: id, start_at: startAt });
  return id;
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

  const sets: string[] = [
    "status = 'CONFIRMED'",
    'confirmed_at = ?',
    'updated_at = ?',
  ];
  const stamp = now();
  const args: (number | string | null)[] = [stamp, stamp];
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
  recordEntityWrite({ entity_type: 'time_entry', entity_id: id });
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
  recordEntityWrite({ entity_type: 'time_entry', entity_id: id });
}

export interface DeleteTimeEntryOptions {
  force?: boolean;
}

export interface DeleteTimeEntryResult {
  deleted: boolean;
  entry: TimeEntryRow;
}

/**
 * Hard-delete a `time_entry` row, regardless of status or source.
 *
 * The corrective primitive for retroactive time tracking: mis-attributed
 * entries, bad durations, double-logs, reclassified work. Removes the row
 * outright — task time totals come from the `v_task_time_spent` view, so
 * no cached counter needs adjusting.
 *
 * Guard: refuses entries with `harvest_entry_id` set (already pushed to
 * Harvest) unless `force: true` is passed. Callers using `force` accept
 * responsibility for Harvest desync.
 *
 * Note on `gcal-sync` source: rows mirroring a Google Calendar event will
 * reappear on the next `sync_calendar_events` call unless the underlying
 * calendar event is also deleted. The function permits the delete anyway —
 * useful for transient cleanup — but the caller should be aware.
 */
export function deleteTimeEntry(
  db: DB,
  id: number,
  opts: DeleteTimeEntryOptions = {},
): DeleteTimeEntryResult {
  const row = db.prepare(`SELECT * FROM time_entry WHERE id = ?`)
    .get(id) as TimeEntryRow | undefined;
  if (!row) throw new Error(`time_entry ${id} not found`);
  if (row.harvest_entry_id !== null && !opts.force) {
    throw new Error(
      `time_entry ${id} is already pushed to Harvest (harvest_entry_id=${row.harvest_entry_id}). ` +
      `Void it in Harvest first, or pass force: true to delete anyway and accept Harvest desync.`,
    );
  }
  db.prepare(`DELETE FROM time_entry WHERE id = ?`).run(id);
  recordEntityWrite({ entity_type: 'time_entry', entity_id: id, start_at: row.start_at });
  return { deleted: true, entry: row };
}

export interface TimeEntryRow {
  id: number;
  task_id: number | null;
  project_id: string | null;
  goal_id: number | null;
  start_at: string;
  end_at: string;
  actual_minutes: number | null;
  status: TimeEntryStatus;
  confirmed_at: string | null;
  source: TimeEntrySource;
  external_id: string | null;
  is_meeting: number;
  synced_at: string | null;
  harvest_entry_id: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListPendingReviewOptions {
  from?: string;
  to?: string;
  category?: string;
}

/**
 * A `time_entry` row decorated with the linked task/goal title, so
 * review lists can show what a placement *is* instead of its `notes`
 * (often a Jira URL, sometimes NULL) (#151). Both are NULL when the
 * entry has no link (e.g. gcal-sync events, unlinked manual logs).
 */
export interface PendingReviewRow extends TimeEntryRow {
  task_title: string | null;
  goal_title: string | null;
}

/**
 * `from`/`to` accept a plain date or an ISO timestamp; both are
 * bucketed to inclusive UTC days (`day-range.ts`) and compared against
 * `DATE(te.start_at)` — the same semantics as `getTimesheetSummary`,
 * so the two can never disagree about which rows a range contains
 * (#92). The default range ends today, so still-upcoming placements
 * dated today are included.
 *
 * `category: 'all'` spans every category so personal/goal placements
 * enter the same review pass as work ones (#148). Entries with no
 * project (gcal-sync rows) surface under 'work' and under 'all'.
 */
export function listPendingReview(db: DB, opts: ListPendingReviewOptions): PendingReviewRow[] {
  const category = opts.category ?? 'work';
  const { fromDay, toDay } = toDayRange(
    opts.from ?? '1970-01-01',
    opts.to ?? nowDate().toISOString(),
  );

  const categoryFilter = category === 'all'
    ? ''
    : `AND (p.category_id = ? OR (p.category_id IS NULL AND ? = 'work'))`;
  const params = category === 'all'
    ? [fromDay, toDay]
    : [fromDay, toDay, category, category];

  return db.prepare(`
    SELECT te.*, t.title AS task_title, g.title AS goal_title
    FROM time_entry te
    LEFT JOIN projects p ON p.id = te.project_id
    LEFT JOIN tasks t ON t.id = te.task_id
    LEFT JOIN goals g ON g.id = te.goal_id
    WHERE te.status = 'UNCONFIRMED'
      AND DATE(te.start_at) >= ?
      AND DATE(te.start_at) <= ?
      ${categoryFilter}
    ORDER BY te.start_at ASC
  `).all(...params) as PendingReviewRow[];
}

export interface MoveOptions {
  new_end_at?: string;
  preserve_duration?: boolean;
}

export function moveTimeEntry(db: DB, id: number, new_start_at: string, opts: MoveOptions = {}): void {
  const existing = db.prepare(`SELECT status, source, start_at, end_at FROM time_entry WHERE id = ?`)
    .get(id) as { status: string; source: string; start_at: string; end_at: string } | undefined;
  if (!existing) throw new Error(`time_entry ${id} not found`);
  if (existing.status === 'CONFIRMED') throw new Error('cannot move a confirmed entry');
  if (existing.source === 'gcal-sync') {
    throw new Error('cannot move a gcal-synced entry; reschedule in Google Calendar');
  }
  if (existing.source === 'manual') {
    throw new Error('cannot move a manual entry; manual entries are CONFIRMED by definition');
  }

  const startAt = toCanonicalUtc(new_start_at, 'new_start_at');
  let endAt: string;
  if (opts.new_end_at) {
    endAt = toCanonicalUtc(opts.new_end_at, 'new_end_at');
  } else {
    const oldDuration =
      new Date(existing.end_at).getTime() - new Date(existing.start_at).getTime();
    endAt = toCanonicalUtc(
      new Date(new Date(startAt).getTime() + oldDuration).toISOString(),
      'new_end_at',
    );
  }

  db.prepare(
    `UPDATE time_entry SET start_at = ?, end_at = ?, updated_at = ? WHERE id = ?`,
  ).run(startAt, endAt, now(), id);
  recordEntityWrite({ entity_type: 'time_entry', entity_id: id, start_at: startAt });
}
