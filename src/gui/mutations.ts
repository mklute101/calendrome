/**
 * GUI write operations (#24, #86).
 *
 * One function per write endpoint in `server.ts`, each a thin,
 * unit-testable wrapper over the same core functions the MCP tools
 * use — the GUI never grows its own mutation logic, so the two
 * surfaces cannot drift. Every function takes the per-request `db`
 * (the GUI server opens a fresh connection per request for
 * cross-process visibility) and returns the refreshed row(s) the
 * client needs to reconcile its optimistic state.
 *
 * Known pre-existing gap, accepted here as in the MCP layer: moving
 * a placement does not update the linked calendar event
 * (`moveTimeEntry` never touches the CalendarClient). Fine under
 * `LocalCalendarClient`, the production default.
 */
import type { DB } from '../db/connection.js';
import type { CalendarClient } from '../calendar/index.js';
import {
  placeTask,
  unplaceTask,
  type PlaceTaskResult,
  type UnplaceTaskResult,
} from '../placement.js';
import {
  moveTimeEntry,
  confirmTimeEntry,
  skipTimeEntry,
  type TimeEntryRow,
} from '../time-entry.js';
import { completeTask } from '../time-log.js';
import { getTask, updateTask, type Task, type TaskStatus } from '../tasks.js';

function getEntry(db: DB, id: number): TimeEntryRow {
  const row = db
    .prepare(`SELECT * FROM time_entry WHERE id = ?`)
    .get(id) as TimeEntryRow | undefined;
  if (!row) throw new Error(`time_entry ${id} not found`);
  return row;
}

export async function guiPlace(
  db: DB,
  calendar: CalendarClient,
  args: { task_id: number; start: string; end?: string },
): Promise<PlaceTaskResult> {
  return placeTask(db, calendar, args);
}

export function guiMove(
  db: DB,
  id: number,
  args: { start: string; end?: string },
): { placement: TimeEntryRow } {
  moveTimeEntry(db, id, args.start, { new_end_at: args.end });
  return { placement: getEntry(db, id) };
}

export function guiConfirm(
  db: DB,
  id: number,
  args: { actual_minutes?: number | null; notes?: string | null },
): { time_entry: TimeEntryRow } {
  confirmTimeEntry(db, id, args);
  return { time_entry: getEntry(db, id) };
}

export function guiSkip(
  db: DB,
  id: number,
): { deleted: { task_id: number | null; start_at: string; end_at: string } } {
  const row = getEntry(db, id);
  skipTimeEntry(db, id);
  // Returned so the undo toast can re-place the task at the same slot.
  return {
    deleted: { task_id: row.task_id, start_at: row.start_at, end_at: row.end_at },
  };
}

export async function guiUnplace(
  db: DB,
  calendar: CalendarClient,
  taskId: number,
): Promise<UnplaceTaskResult> {
  return unplaceTask(db, calendar, taskId);
}

export function guiComplete(db: DB, taskId: number): { task: Task } {
  return { task: completeTask(db, taskId) };
}

/**
 * Undo path for "complete". `ALLOWED_TRANSITIONS` in tasks.ts allows
 * only COMPLETE → ARCHIVED, so undoing an accidental complete needs
 * a direct status write. Deliberate, GUI-undo-only deviation:
 * validated to only ever move a task *out of* COMPLETE.
 */
export function reopenTask(
  db: DB,
  taskId: number,
  to: Extract<TaskStatus, 'NEW' | 'SCHEDULED' | 'IN_PROGRESS'>,
): { task: Task } {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`task ${taskId} not found`);
  if (task.status !== 'COMPLETE') {
    throw new Error(
      `cannot reopen task ${taskId}: status is ${task.status}, not COMPLETE`,
    );
  }
  if (!['NEW', 'SCHEDULED', 'IN_PROGRESS'].includes(to)) {
    throw new Error(`cannot reopen to ${to}`);
  }
  db.prepare(
    `UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?`,
  ).run(to, taskId);
  return { task: getTask(db, taskId)! };
}

export function guiSnooze(
  db: DB,
  taskId: number,
  until: string | null,
): { task: Task } {
  return { task: updateTask(db, taskId, { snooze_until: until }) };
}
