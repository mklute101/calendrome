/**
 * Task placement — the composition shared by the `place_task` /
 * `unplace_task` MCP tools and the GUI write API (#86).
 *
 * Placing a task creates a calendar event via the configured
 * `CalendarClient` and inserts the paired UNCONFIRMED `time_entry`
 * (source `placement`, `external_id` = event id) — that row is the
 * canonical link between task and calendar event and the thing the
 * confirmation flow operates on. The task's `due` is never touched;
 * the time_entry alone says where the task sits on the calendar (#79).
 *
 * Extracted from the MCP handlers so the GUI server and the MCP
 * server share one implementation and can never drift.
 */
import type { DB } from './db/connection.js';
import type { CalendarClient } from './calendar/index.js';
import { getTask, setTaskStatus, type Task } from './tasks.js';
import { getProject } from './projects.js';
import { insertTimeEntry } from './time-entry.js';

export interface PlaceTaskArgs {
  task_id: number;
  start: string;
  /** Defaults to start + task.duration_minutes. Set to restore a resized block (undo). */
  end?: string;
}

export interface PlaceTaskResult {
  task: Task;
  event: { id: string };
  time_entry_id: number;
}

export async function placeTask(
  db: DB,
  calendar: CalendarClient,
  args: PlaceTaskArgs,
): Promise<PlaceTaskResult> {
  const task = getTask(db, args.task_id);
  if (!task) throw new Error(`task ${args.task_id} not found`);
  const project = getProject(db, task.project_id);

  const startMs = Date.parse(args.start);
  if (Number.isNaN(startMs)) {
    throw new Error(`start is not a valid ISO 8601 timestamp: ${args.start}`);
  }
  const end =
    args.end ?? new Date(startMs + task.duration_minutes * 60_000).toISOString();

  const event = await calendar.createEvent({
    calendar_id: project?.calendar_id ?? null,
    summary: `${project?.prefix ?? ''} ${task.title}`.trim(),
    start: args.start,
    end,
    description: task.notes ?? undefined,
  });

  // Insert paired UNCONFIRMED time_entry — this is the row the
  // confirmation flow operates on. The time_entry's `external_id`
  // (= event.id) is now the canonical link between task and
  // calendar event; we no longer stamp `task.calendar_event_id`.
  const timeEntryId = insertTimeEntry(db, {
    task_id: args.task_id,
    project_id: task.project_id,
    start_at: args.start,
    end_at: end,
    status: 'UNCONFIRMED',
    source: 'placement',
    external_id: event.id,
    notes: task.notes ?? null,
  });

  setTaskStatus(db, args.task_id, 'SCHEDULED');
  return {
    task: getTask(db, args.task_id)!,
    event,
    time_entry_id: timeEntryId,
  };
}

export interface UnplaceTaskResult {
  task: Task;
  /** The removed placement's span — lets an undo re-place at the same slot. */
  was: { start_at: string; end_at: string } | null;
}

export async function unplaceTask(
  db: DB,
  calendar: CalendarClient,
  taskId: number,
): Promise<UnplaceTaskResult> {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`task ${taskId} not found`);

  // Find the paired placement time_entry, if any. The time_entry
  // is now the sole source of truth for "is this task placed?".
  const pairedEntry = db
    .prepare(
      `SELECT id, status, external_id, start_at, end_at FROM time_entry
       WHERE task_id = ? AND source = 'placement'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(taskId) as
    | {
        id: number;
        status: string;
        external_id: string | null;
        start_at: string;
        end_at: string;
      }
    | undefined;

  if (pairedEntry && pairedEntry.status === 'CONFIRMED') {
    throw new Error(
      `cannot unplace task ${taskId}: its time_entry is already CONFIRMED`,
    );
  }

  if (pairedEntry && pairedEntry.external_id) {
    const project = getProject(db, task.project_id);
    await calendar.deleteEvent({
      calendar_id: project?.calendar_id ?? null,
      event_id: pairedEntry.external_id,
    });
  }

  if (pairedEntry) {
    db.prepare(`DELETE FROM time_entry WHERE id = ?`).run(pairedEntry.id);
  }

  // Only flip status when the task was actually SCHEDULED. For NEW
  // (never placed), IN_PROGRESS, or COMPLETE we leave the status
  // alone — unplacing the calendar event shouldn't yank a task out
  // of in-progress or completed state.
  if (task.status === 'SCHEDULED') {
    setTaskStatus(db, taskId, 'NEW');
  }
  return {
    task: getTask(db, taskId)!,
    was: pairedEntry
      ? { start_at: pairedEntry.start_at, end_at: pairedEntry.end_at }
      : null,
  };
}
