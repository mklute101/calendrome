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
  insertTimeEntry,
  skipTimeEntry,
  type TimeEntryRow,
} from '../time-entry.js';
import { completeTask } from '../time-log.js';
import { getTask, updateTask, type Task, type TaskStatus } from '../tasks.js';
import {
  completeHabitInstance,
  getHabit,
  moveHabitInstance,
  skipHabitInstance,
  type HabitInstance,
} from '../habits.js';
import {
  assignHours,
  pullHours,
  type Assignment,
  type AssignHoursInput,
  type EnvelopeMove,
  type PullHoursInput,
} from '../assignments.js';

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

function getHabitInstance(db: DB, id: number): HabitInstance {
  const row = db
    .prepare(`SELECT * FROM habit_instances WHERE id = ?`)
    .get(id) as HabitInstance | undefined;
  if (!row) throw new Error(`habit_instance ${id} not found`);
  return row;
}

/** Requires PLANNED — the core fns don't guard status, the GUI does
 *  so a stale double-click 409s instead of silently re-completing. */
function requirePlanned(inst: HabitInstance): void {
  if (inst.status !== 'PLANNED') {
    throw new Error(
      `habit_instance ${inst.id} is ${inst.status}, not PLANNED`,
    );
  }
}

/**
 * Mark a habit instance done (#118) — same core as the
 * `complete_habit_instance` path: status → COMPLETE and the paired
 * time_entry confirmed.
 */
export function guiHabitComplete(db: DB, id: number): { instance: HabitInstance } {
  requirePlanned(getHabitInstance(db, id));
  return { instance: completeHabitInstance(db, id) };
}

/**
 * Skip a habit instance (#118) — the slot didn't happen. Status →
 * SKIPPED and the paired UNCONFIRMED time_entry is deleted. The skip
 * is counted, not hidden: it stays in the DB for the weekly meter.
 * Undo is `reopenHabitInstance`, not a re-insert here.
 */
export function guiHabitSkip(db: DB, id: number): { instance: HabitInstance } {
  requirePlanned(getHabitInstance(db, id));
  return { instance: skipHabitInstance(db, id) };
}

/**
 * Move a habit instance within its frequency range (#118) — thin
 * wrapper over `moveHabitInstance`, which enforces the range rule
 * (fixed-days: its own day; times_per_week: its week) and moves the
 * linked entry without touching `scheduled_start`.
 */
export function guiHabitMove(
  db: DB,
  id: number,
  args: { start: string; end?: string },
): { instance: HabitInstance; entry: TimeEntryRow } {
  return moveHabitInstance(db, id, args.start, { newEnd: args.end });
}

/**
 * Undo path for habit ✓/✕ (#118). Like `reopenTask` above, this is a
 * deliberate, GUI-undo-only deviation from the one-way core
 * transitions: validated to only ever move an instance *back to*
 * PLANNED, and only for habit-sourced state.
 *  - from SKIPPED: status → PLANNED and the UNCONFIRMED entry is
 *    re-inserted at the scheduled slot + relinked (the skip deleted
 *    it; the scheduled slot is the only position we still know).
 *  - from COMPLETE: status → PLANNED, completed_at cleared, and the
 *    linked entry un-confirmed in place (it keeps any moved position).
 */
export function reopenHabitInstance(db: DB, id: number): { instance: HabitInstance } {
  const reopenTx = db.transaction(() => {
    const inst = getHabitInstance(db, id);
    if (inst.status === 'PLANNED') {
      throw new Error(`habit_instance ${id} is already PLANNED`);
    }
    const habit = getHabit(db, inst.habit_id);
    if (!habit) throw new Error(`habit ${inst.habit_id} not found`);

    if (inst.status === 'SKIPPED') {
      const teId = insertTimeEntry(db, {
        task_id: null,
        project_id: habit.project_id,
        start_at: inst.scheduled_start,
        end_at: inst.scheduled_end,
        status: 'UNCONFIRMED',
        source: 'habit',
        notes: habit.title,
      });
      db.prepare(
        `UPDATE habit_instances
            SET status = 'PLANNED', completed_at = NULL, time_entry_id = ?
          WHERE id = ?`,
      ).run(teId, id);
      return;
    }

    // COMPLETE → PLANNED. Un-confirming has no core fn on purpose
    // (confirm is one-way everywhere else); validate the entry is
    // habit-sourced before the direct write.
    if (inst.time_entry_id != null) {
      const te = db
        .prepare(`SELECT source FROM time_entry WHERE id = ?`)
        .get(inst.time_entry_id) as { source: string } | undefined;
      if (te && te.source !== 'habit') {
        throw new Error(
          `habit_instance ${id} links non-habit time_entry ${inst.time_entry_id} (${te.source})`,
        );
      }
      db.prepare(
        `UPDATE time_entry
            SET status = 'UNCONFIRMED', confirmed_at = NULL,
                updated_at = datetime('now')
          WHERE id = ?`,
      ).run(inst.time_entry_id);
    }
    db.prepare(
      `UPDATE habit_instances SET status = 'PLANNED', completed_at = NULL WHERE id = ?`,
    ).run(id);
  });
  reopenTx();
  return { instance: getHabitInstance(db, id) };
}

export function guiSnooze(
  db: DB,
  taskId: number,
  until: string | null,
): { task: Task } {
  return { task: updateTask(db, taskId, { snooze_until: until }) };
}

/**
 * Set an envelope's weekly assignment (same as the `assign_hours` MCP
 * tool). `minutes: null` snoozes the envelope for the week.
 */
export function guiAssign(db: DB, args: AssignHoursInput): { assignment: Assignment } {
  return { assignment: assignHours(db, args) };
}

/**
 * Move minutes between two envelopes — the YNAB pull (same as the
 * `pull_hours` MCP tool). The client's undo is simply the reverse
 * pull (from/to swapped), which `pullHours` accepts cleanly because
 * the forward pull left the destination holding the pulled minutes.
 */
export function guiPull(db: DB, args: PullHoursInput): { move: EnvelopeMove } {
  return { move: pullHours(db, args) };
}
