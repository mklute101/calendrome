/**
 * MCP tool registry.
 *
 * `buildTools(db, options?)` returns the full array of `ToolDescriptor`
 * objects exposed by the MCP server. Each entry has `{ name, description,
 * inputSchema, handler }`; the `name` is the public API. Tools are grouped
 * by domain (projects, tasks, inbox, habits, budgets, layout, timesheet,
 * calendar, categories, availability) — the boundaries follow the modules
 * under `src/`.
 *
 * Adding a tool: append an object literal to the returned array, then
 * update the expected-surface check in `tests/mcp-tools.test.ts`. To make
 * the new tool show up on the GUI /docs page, write a JSDoc block
 * above the object literal — see `create_task` for the canonical
 * shape (summary, `@example`, `@see`).
 */
import type { DB } from '../../db/connection.js';
import { toDayRange } from '../../day-range.js';
import { guiStart, guiStop, guiStatus } from '../../gui/launcher.js';
import {
  createProject,
  listProjects,
  updateProject,
  getProject,
} from '../../projects.js';
import {
  createTask,
  updateTask,
  listTasks,
  searchTasks,
  setTaskStatus,
  getTask,
  type CreateTaskInput,
} from '../../tasks.js';
import { completeTask, logTime } from '../../time-log.js';
import {
  confirmTimeEntry,
  skipTimeEntry,
  listPendingReview,
  moveTimeEntry,
  insertTimeEntry,
  deleteTimeEntry,
} from '../../time-entry.js';
import {
  inboxAdd,
  inboxList,
  inboxNext,
  inboxProcess,
} from '../../inbox.js';
import {
  createHabit,
  listHabits,
  generateHabitInstances,
  completeHabitInstance,
  skipHabitInstance,
} from '../../habits.js';
import { getProjectBudget, getAllBudgets } from '../../budgets.js';
import {
  createCategory,
  listCategories,
  updateCategory,
  type CategoryWindow,
} from '../../categories.js';
import {
  createAvailabilityOverride,
  listAvailabilityOverrides,
  deleteAvailabilityOverride,
  clearAvailabilityOverrides,
} from '../../availability.js';
import { HarvestClient } from '../../harvest/client.js';
import {
  addMeetingProjectMapping,
  listMeetingProjectMappings,
  deleteMeetingProjectMapping,
} from '../../meeting-mappings.js';
import { harvestPushTimesheet } from '../../harvest/push.js';
import {
  exportTimesheet,
  getTimesheetSummary,
} from '../../timesheet.js';
import { stubCalendar, type CalendarClient } from '../../calendar/index.js';
import {
  syncCalendarEvents,
  deleteCalendarEventsInRange,
  type CalendarEventInput,
} from '../../calendar-sync.js';

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: any) => Promise<any>;
}

export interface BuildToolsOptions {
  calendar?: CalendarClient;
}

function requireString(args: any, key: string): string {
  const v = args?.[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`missing required string field: ${key}`);
  }
  return v;
}

function requireNumber(args: any, key: string): number {
  const v = args?.[key];
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new Error(`missing required number field: ${key}`);
  }
  return v;
}

export function buildTools(
  db: DB,
  options: BuildToolsOptions = {},
): ToolDescriptor[] {
  const calendar = options.calendar ?? stubCalendar;

  return [
    // -------- projects --------
    {
      name: 'create_project',
      description:
        'Create a project with calendar mapping and weekly budget. ' +
        "category_id defaults to 'work'.",
      inputSchema: {
        type: 'object',
        required: ['id', 'name', 'prefix'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          prefix: { type: 'string' },
          calendar_id: { type: ['string', 'null'] },
          color: { type: ['string', 'null'] },
          weekly_budget_minutes: { type: ['integer', 'null'] },
          harvest_project_id: { type: ['integer', 'null'] },
          harvest_task_id: { type: ['integer', 'null'] },
          category_id: { type: ['string', 'null'] },
        },
      },
      async handler(args) {
        const project = createProject(db, {
          id: requireString(args, 'id'),
          name: requireString(args, 'name'),
          prefix: requireString(args, 'prefix'),
          calendar_id: args.calendar_id ?? null,
          color: args.color ?? null,
          weekly_budget_minutes: args.weekly_budget_minutes ?? null,
          harvest_project_id: args.harvest_project_id ?? null,
          harvest_task_id: args.harvest_task_id ?? null,
          category_id: args.category_id ?? null,
        });
        return { project };
      },
    },
    {
      name: 'list_projects',
      description:
        'List projects. Pass category_id (string or array of strings) to ' +
        'filter — e.g. category_id="work" for the screen-share view.',
      inputSchema: {
        type: 'object',
        properties: {
          active: { type: 'boolean' },
          category_id: {
            oneOf: [
              { type: 'string' },
              { type: 'array', items: { type: 'string' } },
            ],
          },
        },
      },
      async handler(args) {
        return {
          projects: listProjects(db, {
            active: args?.active,
            category_id: args?.category_id,
          }),
        };
      },
    },
    {
      name: 'update_project',
      description: 'Update project settings',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          prefix: { type: 'string' },
          weekly_budget_minutes: { type: ['integer', 'null'] },
          calendar_id: { type: ['string', 'null'] },
          color: { type: ['string', 'null'] },
          harvest_project_id: { type: ['integer', 'null'] },
          harvest_task_id: { type: ['integer', 'null'] },
          category_id: { type: ['string', 'null'] },
          active: { type: 'integer' },
        },
      },
      async handler(args) {
        const { id, ...patch } = args;
        return { project: updateProject(db, requireString(args, 'id'), patch) };
      },
    },

    // -------- tasks --------
    /**
     * Create a task in a project.
     *
     * Tasks are the primary unit of work. A new task starts as an
     * unscheduled item; use `place_task` to put it on the calendar
     * with an actual time. `duration_minutes` is the planned size,
     * not the time spent — actual time is tracked via `log_time`
     * (retroactive) or `place_task` (forward-scheduled), both of which
     * write rows to `time_entry`.
     *
     * @example
     * create_task({
     *   project_id: 'athletech',
     *   title: 'Review beehiiv feed PR',
     *   duration_minutes: 60,
     *   priority: 'high'
     * })
     *
     * @see place_task, update_task, log_time
     */
    {
      name: 'create_task',
      description: 'Create a task in a project',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'title'],
        properties: {
          project_id: { type: 'string' },
          title: { type: 'string' },
          notes: { type: ['string', 'null'] },
          priority: { type: 'string' },
          duration_minutes: { type: 'integer' },
          due: { type: ['string', 'null'] },
          snooze_until: { type: ['string', 'null'] },
        },
      },
      async handler(args) {
        const input: CreateTaskInput = {
          project_id: requireString(args, 'project_id'),
          title: requireString(args, 'title'),
          notes: args.notes ?? null,
          priority: args.priority,
          duration_minutes: args.duration_minutes,
          due: args.due ?? null,
          snooze_until: args.snooze_until ?? null,
        };
        return { task: createTask(db, input) };
      },
    },
    /**
     * Update task fields by id.
     *
     * Patch-style: only the fields you pass are changed. Pass `null`
     * to explicitly clear a nullable field (notes, due, snooze_until).
     * Use this for backfilling notes after-the-fact, adjusting a
     * planned duration, or moving a `due` date.
     *
     * @example
     * update_task({ id: 17, duration_minutes: 390, notes: 'Trimmed Mon block' })
     *
     * @see create_task, place_task, complete_task
     */
    {
      name: 'update_task',
      description: 'Update task fields',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' },
          title: { type: 'string' },
          notes: { type: ['string', 'null'] },
          priority: { type: 'string' },
          duration_minutes: { type: 'integer' },
          due: { type: ['string', 'null'] },
          snooze_until: { type: ['string', 'null'] },
        },
      },
      async handler(args) {
        const { id, ...patch } = args;
        return { task: updateTask(db, requireNumber(args, 'id'), patch) };
      },
    },
    {
      name: 'list_tasks',
      description: 'List tasks with filters',
      inputSchema: {
        type: 'object',
        properties: {
          project_id: { type: 'string' },
          status: { type: 'string' },
          due_before: { type: 'string' },
        },
      },
      async handler(args) {
        return { tasks: listTasks(db, args ?? {}) };
      },
    },
    {
      name: 'search_tasks',
      description: 'Full-text search task titles and notes',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' } },
      },
      async handler(args) {
        return { tasks: searchTasks(db, requireString(args, 'query')) };
      },
    },
    {
      name: 'complete_task',
      description: 'Complete a task',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      async handler(args) {
        return { task: completeTask(db, requireNumber(args, 'id')) };
      },
    },
    /**
     * Retroactively log a CONFIRMED time_entry for work that already happened.
     *
     * The primary entry point for time tracking alongside `place_task`
     * (forward-scheduled placement). `log_time` covers meetings, ad-hoc
     * work, end-of-week timesheet reconciliation — anything off the
     * calendar.
     *
     * Validates ISO 8601 timestamps, `stopped_at > started_at`, and
     * neither more than 24h in the future. Leaves `tasks.status` alone —
     * call `complete_task` separately if appropriate.
     *
     * @example
     * log_time({ task_id: 17, started_at: '2026-05-04T09:00:00-05:00',
     *            stopped_at: '2026-05-04T12:00:00-05:00', notes: 'sprint planning' })
     *
     * @see place_task, complete_task, get_timesheet_summary
     */
    {
      name: 'log_time',
      description: 'Retroactively log a CONFIRMED time_entry for completed work',
      inputSchema: {
        type: 'object',
        required: ['started_at', 'stopped_at'],
        properties: {
          task_id: { type: 'integer' },
          project_id: { type: 'string' },
          started_at: { type: 'string' },
          stopped_at: { type: 'string' },
          notes: { type: ['string', 'null'] },
        },
      },
      async handler(args) {
        const taskId = args.task_id === undefined || args.task_id === null
          ? undefined
          : Number(args.task_id);
        const projectId = args.project_id === undefined || args.project_id === null
          ? undefined
          : String(args.project_id);
        const entry = logTime(db, {
          task_id: taskId,
          project_id: projectId,
          started_at: requireString(args, 'started_at'),
          stopped_at: requireString(args, 'stopped_at'),
          notes: (args.notes as string | null | undefined) ?? null,
        });
        return {
          entry,
          task: entry.task_id !== null ? getTask(db, entry.task_id) : null,
        };
      },
    },

    // -------- inbox --------
    {
      name: 'inbox_add',
      description: 'Quick-capture an item to the inbox',
      inputSchema: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          notes: { type: ['string', 'null'] },
        },
      },
      async handler(args) {
        return {
          item: inboxAdd(db, {
            title: requireString(args, 'title'),
            notes: args.notes ?? null,
          }),
        };
      },
    },
    {
      name: 'inbox_list',
      description: 'List unprocessed inbox items',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return { items: inboxList(db) };
      },
    },
    {
      name: 'inbox_next',
      description: 'Get the next unprocessed inbox item',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return { item: inboxNext(db) };
      },
    },
    {
      name: 'inbox_process',
      description: 'Convert an inbox item into a task in a project',
      inputSchema: {
        type: 'object',
        required: ['id', 'project_id'],
        properties: {
          id: { type: 'integer' },
          project_id: { type: 'string' },
        },
      },
      async handler(args) {
        return {
          task: inboxProcess(
            db,
            requireNumber(args, 'id'),
            requireString(args, 'project_id'),
          ),
        };
      },
    },

    // -------- habits --------
    {
      name: 'create_habit',
      description: 'Create a recurring habit time block',
      inputSchema: {
        type: 'object',
        required: [
          'project_id',
          'title',
          'duration_minutes',
          'days_of_week',
          'start_time',
        ],
        properties: {
          project_id: { type: 'string' },
          title: { type: 'string' },
          duration_minutes: { type: 'integer' },
          days_of_week: { type: 'string' },
          start_time: { type: 'string' },
          timezone: { type: 'string' },
          notes: { type: ['string', 'null'] },
        },
      },
      async handler(args) {
        return {
          habit: createHabit(db, {
            project_id: requireString(args, 'project_id'),
            title: requireString(args, 'title'),
            duration_minutes: requireNumber(args, 'duration_minutes'),
            days_of_week: requireString(args, 'days_of_week'),
            start_time: requireString(args, 'start_time'),
            timezone: args.timezone,
            notes: args.notes ?? null,
          }),
        };
      },
    },
    {
      name: 'list_habits',
      description: 'List habit templates',
      inputSchema: {
        type: 'object',
        properties: { active: { type: 'boolean' } },
      },
      async handler(args) {
        return { habits: listHabits(db, { active: args?.active }) };
      },
    },
    {
      name: 'generate_habit_instances',
      description: 'Materialize habit_instances rows for a date range',
      inputSchema: {
        type: 'object',
        required: ['habit_id', 'from', 'to'],
        properties: {
          habit_id: { type: 'integer' },
          from: { type: 'string' },
          to: { type: 'string' },
        },
      },
      async handler(args) {
        return {
          instances: generateHabitInstances(
            db,
            requireNumber(args, 'habit_id'),
            requireString(args, 'from'),
            requireString(args, 'to'),
          ),
        };
      },
    },
    {
      name: 'complete_habit_instance',
      description: 'Mark a habit instance complete',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      async handler(args) {
        return {
          instance: completeHabitInstance(db, requireNumber(args, 'id')),
        };
      },
    },
    {
      name: 'skip_habit_instance',
      description: 'Mark a habit instance skipped',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      async handler(args) {
        return { instance: skipHabitInstance(db, requireNumber(args, 'id')) };
      },
    },

    // -------- budgets --------
    {
      name: 'get_project_budget',
      description:
        'For a project + week, return allocated/spent/scheduled/remaining/over_budget',
      inputSchema: {
        type: 'object',
        required: ['project_id', 'week_start'],
        properties: {
          project_id: { type: 'string' },
          week_start: { type: 'string' },
        },
      },
      async handler(args) {
        return {
          budget: getProjectBudget(
            db,
            requireString(args, 'project_id'),
            requireString(args, 'week_start'),
          ),
        };
      },
    },
    {
      name: 'get_all_budgets',
      description: 'Get budgets for every active project for a given week',
      inputSchema: {
        type: 'object',
        required: ['week_start'],
        properties: { week_start: { type: 'string' } },
      },
      async handler(args) {
        return {
          budgets: getAllBudgets(db, requireString(args, 'week_start')),
        };
      },
    },

    // -------- layout & placement --------
    /**
     * Return everything that lives on the calendar in a date range —
     * scheduled tasks (those with a paired placement `time_entry`),
     * habit instances, and synced calendar events — grouped for display.
     *
     * Used by the planner skill to reason about what's already on
     * the calendar before suggesting new placements. `from`/`to`
     * are bucketed to inclusive UTC days — plain dates preferred,
     * ISO timestamps tolerated. The response includes the
     * placement rows themselves (`placements`: time_entry id,
     * start/end, status) so callers can confirm/move/skip without a
     * second lookup.
     *
     * @example
     * get_week_layout({ from: '2026-05-04', to: '2026-05-10' })
     *
     * @see place_task, get_all_budgets
     */
    {
      name: 'get_week_layout',
      description:
        'Tasks + habit instances + calendar events for a date range, grouped by day',
      inputSchema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: {
            type: 'string',
            description:
              'Range start: YYYY-MM-DD or ISO timestamp, bucketed to its UTC day (inclusive).',
          },
          to: {
            type: 'string',
            description:
              'Range end: YYYY-MM-DD or ISO timestamp, bucketed to its UTC day (inclusive).',
          },
          project_id: { type: 'string' },
        },
      },
      async handler(args) {
        const { fromDay: from, toDay: to } = toDayRange(
          requireString(args, 'from'),
          requireString(args, 'to'),
        );
        // A task is "on the calendar" iff it has a paired placement
        // time_entry (UNCONFIRMED = still scheduled, CONFIRMED = done).
        // The time_entry's start_at — not task.due, which is a pure
        // deadline field — says when the task sits in the week (#79).
        const placements = db
          .prepare(
            `SELECT id AS time_entry_id, task_id, start_at, end_at, status
               FROM time_entry
              WHERE source = 'placement' AND task_id IS NOT NULL
                AND DATE(start_at) >= ? AND DATE(start_at) <= ?
              ORDER BY start_at`,
          )
          .all(from, to) as {
          time_entry_id: number;
          task_id: number;
          start_at: string;
          end_at: string;
          status: string;
        }[];
        const placedTaskIds = new Set(placements.map((r) => r.task_id));
        const tasks = listTasks(db, {
          project_id: args.project_id,
        }).filter((t) => placedTaskIds.has(t.id));
        const taskIds = new Set(tasks.map((t) => t.id));
        const habits = db
          .prepare(
            `SELECT habit_instances.* FROM habit_instances
               JOIN habits ON habits.id = habit_instances.habit_id
              WHERE habit_instances.scheduled_start >= ?
                AND habit_instances.scheduled_start <= ?
                ${args.project_id ? 'AND habits.project_id = ?' : ''}
              ORDER BY habit_instances.scheduled_start`,
          )
          .all(
            ...(args.project_id
              ? [`${from}T00:00:00Z`, `${to}T23:59:59Z`, args.project_id]
              : [`${from}T00:00:00Z`, `${to}T23:59:59Z`]),
          );
        return {
          tasks,
          habit_instances: habits,
          // Honor the project_id filter: only placements whose task
          // survived the filter above.
          placements: placements.filter((p) => taskIds.has(p.task_id)),
        };
      },
    },
    /**
     * Place a task on the calendar at a specific start time.
     *
     * Creates a calendar event via the configured `CalendarClient`
     * (real Google Calendar in production, the stub in tests) and
     * inserts a paired UNCONFIRMED `time_entry` row that becomes
     * the canonical link between task and event. The event's end
     * is computed from the task's `duration_minutes` and status
     * flips to `SCHEDULED`. The task's `due` is never touched —
     * it is a pure deadline field; the time_entry alone says where
     * the task sits on the calendar (#79).
     *
     * The UNCONFIRMED time_entry is what the day-end review flow
     * operates on — call `confirm_placement` once the work happened
     * (optionally adjusting `actual_minutes`), or `skip_placement`
     * if it didn't.
     *
     * @example
     * place_task({ task_id: 17, start: '2026-05-04T07:00:00-05:00' })
     *
     * @see create_task, unplace_task, confirm_placement, skip_placement, move_placement, get_week_layout
     */
    {
      name: 'place_task',
      description: 'Create a calendar event for a task at a specific time',
      inputSchema: {
        type: 'object',
        required: ['task_id', 'start'],
        properties: {
          task_id: { type: 'integer' },
          start: { type: 'string' },
        },
      },
      async handler(args) {
        const taskId = requireNumber(args, 'task_id');
        const start = requireString(args, 'start');
        const task = getTask(db, taskId);
        if (!task) throw new Error(`task ${taskId} not found`);
        const project = getProject(db, task.project_id);

        const startMs = Date.parse(start);
        const endMs = startMs + task.duration_minutes * 60_000;
        const end = new Date(endMs).toISOString();

        const event = await calendar.createEvent({
          calendar_id: project?.calendar_id ?? null,
          summary: `${project?.prefix ?? ''} ${task.title}`.trim(),
          start,
          end,
          description: task.notes ?? undefined,
        });

        // Insert paired UNCONFIRMED time_entry — this is the row the
        // confirmation flow operates on. The time_entry's `external_id`
        // (= event.id) is now the canonical link between task and
        // calendar event; we no longer stamp `task.calendar_event_id`.
        const timeEntryId = insertTimeEntry(db, {
          task_id: taskId,
          project_id: task.project_id,
          start_at: start,
          end_at: end,
          status: 'UNCONFIRMED',
          source: 'placement',
          external_id: event.id,
          notes: task.notes ?? null,
        });

        setTaskStatus(db, taskId, 'SCHEDULED');
        return {
          task: getTask(db, taskId),
          event,
          time_entry_id: timeEntryId,
        };
      },
    },
    /**
     * Remove a task's calendar event and its paired UNCONFIRMED
     * time_entry, then reset the task to `NEW`.
     *
     * The paired placement `time_entry` is the source of truth for
     * "is this task placed?" — `unplace_task` deletes both the
     * Google Calendar event and that row. Refuses to run if the
     * paired entry is already CONFIRMED (you logged real work
     * against it — use `update_task` instead). Only flips status
     * when the task was actually `SCHEDULED`; IN_PROGRESS and
     * COMPLETE are left alone.
     *
     * @example
     * unplace_task({ task_id: 17 })
     *
     * @see place_task, confirm_placement, skip_placement, move_placement
     */
    {
      name: 'unplace_task',
      description: "Remove a task's calendar event and reset its status",
      inputSchema: {
        type: 'object',
        required: ['task_id'],
        properties: { task_id: { type: 'integer' } },
      },
      async handler(args) {
        const taskId = requireNumber(args, 'task_id');
        const task = getTask(db, taskId);
        if (!task) throw new Error(`task ${taskId} not found`);

        // Find the paired placement time_entry, if any. The time_entry
        // is now the sole source of truth for "is this task placed?".
        const pairedEntry = db
          .prepare(
            `SELECT id, status, external_id FROM time_entry
             WHERE task_id = ? AND source = 'placement'
             ORDER BY id DESC LIMIT 1`,
          )
          .get(taskId) as
          | { id: number; status: string; external_id: string | null }
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
        return { task: getTask(db, taskId) };
      },
    },
    /**
     * Confirm that an UNCONFIRMED placement actually happened.
     *
     * Flips a placement `time_entry` from `UNCONFIRMED` to
     * `CONFIRMED` — the gate that lets the row count toward
     * timesheets and Harvest pushes. Idempotent on already-
     * CONFIRMED entries (no-op). Optional overrides:
     *
     * - `actual_minutes`: adjust duration when the work took
     *   longer or shorter than the placed slot. The row's `end_at`
     *   is rewritten to `start_at + actual_minutes`.
     * - `project_id`: reassign to a different project (e.g. the
     *   meeting was for ACME, not GLBX).
     * - `notes`: append context for the timesheet line.
     *
     * @example
     * confirm_placement({ time_entry_id: 91, actual_minutes: 45 })
     *
     * @see place_task, skip_placement, list_pending_review, move_placement
     */
    {
      name: 'confirm_placement',
      description:
        'Flip an UNCONFIRMED time_entry to CONFIRMED. Optional ' +
        'actual_minutes override (when work took longer/shorter than ' +
        'placed), optional project_id reassignment, optional notes.',
      inputSchema: {
        type: 'object',
        required: ['time_entry_id'],
        properties: {
          time_entry_id: { type: 'integer' },
          actual_minutes: { type: 'integer' },
          project_id: { type: 'string' },
          notes: { type: 'string' },
        },
      },
      async handler(args) {
        const timeEntryId = requireNumber(args, 'time_entry_id');
        confirmTimeEntry(db, timeEntryId, {
          actual_minutes: args?.actual_minutes,
          project_id: args?.project_id,
          notes: args?.notes,
        });
        return { confirmed: true, time_entry_id: timeEntryId };
      },
    },
    /**
     * Delete an UNCONFIRMED placement that did not actually happen.
     *
     * The opposite of `confirm_placement`. Removes the
     * `time_entry` row entirely so it never lands in a timesheet.
     * Refuses to delete CONFIRMED entries (use the GUI or a manual
     * SQL fix — losing confirmed hours should be deliberate) and
     * refuses to delete entries from the `gcal-sync` source (those
     * are mirrored from Google Calendar — delete the event there).
     *
     * @example
     * skip_placement({ time_entry_id: 91 })
     *
     * @see confirm_placement, list_pending_review, unplace_task
     */
    {
      name: 'skip_placement',
      description:
        'Delete an UNCONFIRMED time_entry (it did not happen). Rejects ' +
        'CONFIRMED entries and gcal-sync sourced entries.',
      inputSchema: {
        type: 'object',
        required: ['time_entry_id'],
        properties: {
          time_entry_id: { type: 'integer' },
        },
      },
      async handler(args) {
        const timeEntryId = requireNumber(args, 'time_entry_id');
        skipTimeEntry(db, timeEntryId);
        return { skipped: true, time_entry_id: timeEntryId };
      },
    },
    /**
     * Hard-delete a `time_entry` row to correct bad/duplicate entries.
     *
     * The corrective primitive that pairs with `log_time` — covers
     * mis-attributed entries, bad durations, double-logs, and reclassified
     * work that `confirm_placement` / `skip_placement` cannot fix because
     * they only operate on UNCONFIRMED rows.
     *
     * Refuses entries with `harvest_entry_id` set (already pushed to
     * Harvest) unless `force: true` — pass that flag to delete anyway
     * and accept Harvest desync. `gcal-sync` rows are deletable, but
     * note they reappear on the next `sync_calendar_events` unless
     * the underlying Google Calendar event is also removed.
     *
     * @example
     * delete_time_entry({ id: 142 })
     * delete_time_entry({ id: 142, force: true })
     *
     * @see log_time, skip_placement, confirm_placement, move_placement
     */
    {
      name: 'delete_time_entry',
      description:
        'Hard-delete a time_entry row (corrects mis-logged or duplicate ' +
        'entries). Refuses rows already pushed to Harvest unless force is true.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'integer' },
          force: { type: 'boolean' },
        },
      },
      async handler(args) {
        const id = requireNumber(args, 'id');
        const force = Boolean(args?.force);
        return deleteTimeEntry(db, id, { force });
      },
    },
    /**
     * List UNCONFIRMED time_entries that need review.
     *
     * The feed the day/week wrap-up flow walks through to confirm
     * or skip each placement. `from`/`to` are day-granular and
     * inclusive: a plain date or an ISO timestamp is bucketed to
     * its UTC day, and every entry on that day is returned — the
     * same range semantics as `get_timesheet_summary`, so the two
     * tools always agree on which rows a range contains. The
     * default range ends today, which includes today's
     * still-upcoming placements. Filters to work-category projects
     * by default so personal placements don't clutter timesheet
     * reconciliation; pass `category: 'personal'` or omit to
     * broaden.
     *
     * @example
     * list_pending_review({ from: '2026-05-04', to: '2026-05-10' })
     *
     * @see confirm_placement, skip_placement, move_placement, get_timesheet_summary
     */
    {
      name: 'list_pending_review',
      description:
        'List UNCONFIRMED time_entries that need confirmation or ' +
        'skip. Defaults to work-category entries only. `from`/`to` are ' +
        'inclusive UTC days (plain date or ISO timestamp).',
      inputSchema: {
        type: 'object',
        properties: {
          from: {
            type: 'string',
            description:
              'Range start: YYYY-MM-DD or ISO timestamp, bucketed to its UTC day (inclusive).',
          },
          to: {
            type: 'string',
            description:
              'Range end: YYYY-MM-DD or ISO timestamp, bucketed to its UTC day (inclusive).',
          },
          category: { type: 'string' },
        },
      },
      async handler(args) {
        return {
          rows: listPendingReview(db, {
            from: args?.from,
            to: args?.to,
            category: args?.category,
          }),
        };
      },
    },
    /**
     * Reschedule an UNCONFIRMED placement to a new time.
     *
     * For when the calendar shifts and a planned slot needs to
     * move before it's confirmed. Preserves the entry's duration
     * by default — pass `new_end_at` to also change the length.
     * Updates the paired Google Calendar event when one exists.
     *
     * Refuses to move:
     * - CONFIRMED entries (real work has been logged — editing
     *   the timestamp would rewrite history)
     * - `gcal-sync` sourced entries (mirrored from Google
     *   Calendar — move the event there)
     * - manual `log_time` entries (no calendar event to update)
     *
     * @example
     * move_placement({ time_entry_id: 91, new_start_at: '2026-05-05T14:00:00-05:00' })
     *
     * @see place_task, confirm_placement, skip_placement, list_pending_review
     */
    {
      name: 'move_placement',
      description:
        'Reschedule an UNCONFIRMED placement or habit entry. Preserves ' +
        'duration by default.',
      inputSchema: {
        type: 'object',
        required: ['time_entry_id', 'new_start_at'],
        properties: {
          time_entry_id: { type: 'integer' },
          new_start_at: { type: 'string' },
          new_end_at: { type: 'string' },
        },
      },
      async handler(args) {
        const id = requireNumber(args, 'time_entry_id');
        moveTimeEntry(db, id, requireString(args, 'new_start_at'), {
          new_end_at: args?.new_end_at,
        });
        return { moved: true, time_entry_id: id };
      },
    },

    // -------- timesheet --------
    /**
     * Render a timesheet for a date range from CONFIRMED time_entry rows.
     *
     * Reads CONFIRMED placements, manual `log_time` entries, and
     * confirmed gcal-sync rows — UNCONFIRMED entries are never
     * included (use `list_pending_review` to clear them first).
     * `format` is `csv` (default) or `markdown`. `include_totals`
     * appends per-project subtotals and a grand total; markdown
     * always includes totals.
     *
     * `categories` defaults to `["work"]` so personal hours stay
     * out of client timesheets; pass `["personal"]` or both to
     * widen.
     *
     * @example
     * export_timesheet({ from: '2026-05-04', to: '2026-05-10', format: 'markdown' })
     *
     * @see get_timesheet_summary, harvest_push_timesheet, log_time
     */
    {
      name: 'export_timesheet',
      description:
        'Render a timesheet for a date range from CONFIRMED time_entry ' +
        'rows. `format` is "csv" (default) or "markdown". `include_totals` ' +
        'appends per-project subtotals and a grand total row (markdown ' +
        'always includes totals). `categories` filters by project category ' +
        '— defaults to `["work"]` so personal hours stay out of client ' +
        'timesheets; pass `["personal"]` or `["work", "personal"]` to ' +
        'include them.',
      inputSchema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: {
            type: 'string',
            description:
              'Range start: YYYY-MM-DD or ISO timestamp, bucketed to its UTC day (inclusive).',
          },
          to: {
            type: 'string',
            description:
              'Range end: YYYY-MM-DD or ISO timestamp, bucketed to its UTC day (inclusive).',
          },
          format: { type: 'string', enum: ['csv', 'markdown'] },
          include_totals: { type: 'boolean' },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Project categories to include. Default ["work"].',
          },
        },
      },
      async handler(args) {
        const format =
          args?.format === 'markdown' ? 'markdown' : 'csv';
        const categories = Array.isArray(args?.categories)
          ? (args!.categories as string[])
          : undefined;
        const rendered = exportTimesheet(
          db,
          requireString(args, 'from'),
          requireString(args, 'to'),
          {
            format,
            includeTotals: args?.include_totals === true,
            categories,
          },
        );
        // Keep the legacy `csv` key on the response for backwards
        // compatibility with any caller that already reads it.
        return { format, [format === 'markdown' ? 'markdown' : 'csv']: rendered };
      },
    },
    /**
     * Structured timesheet data for planner-skill reasoning.
     *
     * Prefer this over `export_timesheet` when a skill needs to
     * reason about the numbers (drift checks, budget rollups,
     * pre-flight Harvest checks) instead of just rendering them.
     * Returns rows plus per-project totals plus a grand total in
     * decimal hours.
     *
     * `categories` defaults to `["work"]`. Pass
     * `include_unconfirmed: true` to surface a separate
     * `unconfirmed` section listing UNCONFIRMED entries in the
     * same range — useful for catching drift before a Harvest
     * push.
     *
     * @example
     * get_timesheet_summary({ from: '2026-05-04', to: '2026-05-10', include_unconfirmed: true })
     *
     * @see export_timesheet, list_pending_review, harvest_push_timesheet
     */
    {
      name: 'get_timesheet_summary',
      description:
        'Structured timesheet data for a date range from CONFIRMED ' +
        'time_entry rows: rows plus per-project totals plus grand total ' +
        '(in hours). Prefer this over export_timesheet when a planner ' +
        'skill needs to reason about the numbers instead of just display ' +
        'them. `categories` filters by project category — defaults to ' +
        '`["work"]`. Pass `include_unconfirmed: true` to surface a ' +
        'separate `unconfirmed` section listing UNCONFIRMED entries in ' +
        'the same range — useful for catching drift before a Harvest push.',
      inputSchema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: {
            type: 'string',
            description:
              'Range start: YYYY-MM-DD or ISO timestamp, bucketed to its UTC day (inclusive).',
          },
          to: {
            type: 'string',
            description:
              'Range end: YYYY-MM-DD or ISO timestamp, bucketed to its UTC day (inclusive).',
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Project categories to include. Default ["work"].',
          },
          include_unconfirmed: {
            type: 'boolean',
            description:
              'Include UNCONFIRMED entries as a separate section. Default false.',
          },
        },
      },
      async handler(args) {
        const categories = Array.isArray(args?.categories)
          ? (args!.categories as string[])
          : undefined;
        return {
          summary: getTimesheetSummary(
            db,
            requireString(args, 'from'),
            requireString(args, 'to'),
            {
              categories,
              include_unconfirmed: args?.include_unconfirmed === true,
            },
          ),
        };
      },
    },

    // -------- harvest --------
    /**
     * Push CONFIRMED time_entry rows to Harvest for a date range.
     *
     * Requires `HARVEST_TOKEN` and `HARVEST_ACCOUNT_ID` env vars,
     * and per-project `harvest_project_id` + `harvest_task_id`
     * mappings. Skips entries already pushed (`harvest_entry_id`
     * set) so the call is safe to retry.
     *
     * Pre-flight: refuses to push if any UNCONFIRMED entry exists
     * in the range — the planner should run `list_pending_review`
     * and confirm or skip each row first. Pass `force: true` to
     * override (rare; use when an UNCONFIRMED row is intentionally
     * being deferred).
     *
     * `categories` defaults to `["work"]` so personal hours never
     * leak unless explicitly opted in.
     *
     * @example
     * harvest_push_timesheet({ from: '2026-05-04', to: '2026-05-10' })
     *
     * @see get_timesheet_summary, list_pending_review, harvest_list_projects
     */
    {
      name: 'harvest_push_timesheet',
      description:
        'Push CONFIRMED time_entry rows to Harvest for a date range. ' +
        'Requires HARVEST_TOKEN and HARVEST_ACCOUNT_ID env vars. Skips ' +
        'entries already pushed (harvest_entry_id set). Projects must ' +
        'have harvest_project_id and harvest_task_id mapped. ' +
        '`categories` defaults to `["work"]` — personal hours never ' +
        'leak unless explicitly opted in. Refuses to push if any ' +
        'UNCONFIRMED entries exist in the range (the planner should ' +
        'confirm or skip them first); pass `force: true` to override.',
      inputSchema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: {
            type: 'string',
            description:
              'Range start: YYYY-MM-DD or ISO timestamp, bucketed to its UTC day (inclusive).',
          },
          to: {
            type: 'string',
            description:
              'Range end: YYYY-MM-DD or ISO timestamp, bucketed to its UTC day (inclusive).',
          },
          categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Project categories to push. Default ["work"].',
          },
          force: {
            type: 'boolean',
            description:
              'Skip the UNCONFIRMED-entry pre-flight check. Default false.',
          },
        },
      },
      async handler(args) {
        const token = process.env.HARVEST_TOKEN;
        const accountId = process.env.HARVEST_ACCOUNT_ID;
        if (!token || !accountId) {
          throw new Error(
            'HARVEST_TOKEN and HARVEST_ACCOUNT_ID env vars must be set',
          );
        }
        const client = new HarvestClient({ token, accountId });
        const categories = Array.isArray(args?.categories)
          ? (args!.categories as string[])
          : undefined;
        return harvestPushTimesheet(
          db,
          client,
          requireString(args, 'from'),
          requireString(args, 'to'),
          {
            categories,
            force: args?.force === true,
          },
        );
      },
    },
    {
      name: 'harvest_list_projects',
      description:
        'List active projects from Harvest. Use this to find ' +
        'harvest_project_id values for mapping to calendrome projects. ' +
        'Requires HARVEST_TOKEN and HARVEST_ACCOUNT_ID env vars.',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        const token = process.env.HARVEST_TOKEN;
        const accountId = process.env.HARVEST_ACCOUNT_ID;
        if (!token || !accountId) {
          throw new Error(
            'HARVEST_TOKEN and HARVEST_ACCOUNT_ID env vars must be set',
          );
        }
        const client = new HarvestClient({ token, accountId });
        const projects = await client.listProjects();
        return { projects };
      },
    },

    // -------- calendar sync --------
    /**
     * Import external calendar events into Calendrome.
     *
     * Upserts each event into the unified `time_entry` table with
     * source `gcal-sync`. Re-sync is idempotent and **preserves
     * confirmation state** — if you already confirmed an event
     * for the timesheet, re-syncing won't kick it back to
     * UNCONFIRMED. Project assignment is matched by uppercase
     * prefix on the event summary (e.g. `[ACME] Sprint planning`).
     *
     * If `window` is provided (#93), the sync is a true mirror for
     * that range: after upserting, UNCONFIRMED gcal-sync rows inside
     * the window that are **not** in the payload are pruned — they
     * were cancelled or rescheduled in Google Calendar. Bounds are
     * inclusive UTC day buckets. CONFIRMED rows, placements, habits,
     * and manual entries are never touched, so passing the window is
     * always safe. Pass a window matching the fetched range on every
     * sync; omit it only for partial pushes (a single new event).
     *
     * `clear_range` (delete-then-reinsert) is the legacy variant —
     * prefer `window`, which preserves row identity and any state on
     * re-synced rows instead of recreating them.
     *
     * @example
     * sync_calendar_events({ events: [...], window: { from: '2026-05-04', to: '2026-05-17' } })
     *
     * @see list_pending_review, confirm_placement, get_week_layout
     */
    {
      name: 'sync_calendar_events',
      description:
        'Import external calendar events into Calendrome. ' +
        'If window is provided, unconfirmed synced events in that range ' +
        'missing from the payload are pruned (mirror semantics; safe for ' +
        'placements). clear_range (legacy) deletes the range first instead.',
      inputSchema: {
        type: 'object',
        required: ['events'],
        properties: {
          events: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'calendar_id', 'summary', 'start', 'end'],
              properties: {
                id: { type: 'string' },
                calendar_id: { type: 'string' },
                project_id: { type: ['string', 'null'] },
                summary: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' },
                is_meeting: { type: 'boolean' },
              },
            },
          },
          window: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
            required: ['from', 'to'],
          },
          clear_range: {
            type: 'object',
            properties: {
              from: { type: 'string' },
              to: { type: 'string' },
            },
            required: ['from', 'to'],
          },
        },
      },
      async handler(args) {
        let cleared = 0;
        if (args.clear_range) {
          cleared = deleteCalendarEventsInRange(
            db,
            args.clear_range.from,
            args.clear_range.to,
          );
        }
        const events: CalendarEventInput[] = args.events ?? [];
        const result = syncCalendarEvents(db, events, args.window);
        return { upserted: result.upserted, deleted: result.deleted + cleared };
      },
    },

    // -------- meeting → project mappings --------
    /**
     * Add a title-pattern rule that auto-assigns synced calendar
     * events to a project (#35).
     *
     * Recurring Google events have a unique id per instance, so
     * tagging events individually never sticks — the durable
     * identity of a meeting series is its title. Rules apply during
     * `sync_calendar_events` to events without an explicit
     * `project_id`; first rule (by creation order) that matches
     * wins. Matching is case-insensitive; `match` is `contains`
     * (default), `exact`, or `regex` (validated here).
     *
     * @example
     * add_meeting_project_mapping({ pattern: 'Daily Standup', project_id: 'acme' })
     *
     * @see sync_calendar_events, list_meeting_project_mappings, delete_meeting_project_mapping
     */
    {
      name: 'add_meeting_project_mapping',
      description:
        'Add a title-pattern rule that auto-assigns synced calendar events ' +
        'to a project. match: contains (default) | exact | regex, ' +
        'case-insensitive. First matching rule wins during sync.',
      inputSchema: {
        type: 'object',
        required: ['pattern', 'project_id'],
        properties: {
          pattern: { type: 'string' },
          project_id: { type: 'string' },
          match: { type: 'string', enum: ['exact', 'contains', 'regex'] },
        },
      },
      async handler(args) {
        const mapping = addMeetingProjectMapping(db, {
          pattern: requireString(args, 'pattern'),
          project_id: requireString(args, 'project_id'),
          match: args.match,
        });
        return { mapping };
      },
    },
    /**
     * List meeting → project mapping rules in application order.
     *
     * @example
     * list_meeting_project_mappings()
     *
     * @see add_meeting_project_mapping, delete_meeting_project_mapping
     */
    {
      name: 'list_meeting_project_mappings',
      description:
        'List meeting title → project mapping rules in the order they apply.',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return { mappings: listMeetingProjectMappings(db) };
      },
    },
    /**
     * Delete a meeting → project mapping rule by id.
     *
     * Already-synced events keep their assignment; the rule just
     * stops applying to future syncs.
     *
     * @example
     * delete_meeting_project_mapping({ id: 3 })
     *
     * @see add_meeting_project_mapping, list_meeting_project_mappings
     */
    {
      name: 'delete_meeting_project_mapping',
      description: 'Delete a meeting title → project mapping rule by id.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      async handler(args) {
        deleteMeetingProjectMapping(db, requireNumber(args, 'id'));
        return { deleted: true };
      },
    },

    // -------- categories --------
    // Categories drive *when* work happens. Every project belongs to one;
    // each category owns a default scheduling window. Filtering by category
    // is also the screen-share filter — same data, two uses.
    /**
     * List categories ordered by display_order.
     *
     * The seeded set is `work` and `personal`; each row carries a
     * `default_window` describing when projects in that category are
     * normally schedulable (Mon-Fri 9-5 for work, evenings/weekends
     * for personal). The GUI uses this list to render the Work/All
     * toggle.
     *
     * @example
     * list_categories()
     *
     * @see create_category, update_category, list_projects
     */
    {
      name: 'list_categories',
      description: 'List categories ordered by display_order',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return { categories: listCategories(db) };
      },
    },
    /**
     * Create a new category with an optional default scheduling window.
     *
     * Useful for splitting "deep work" (mornings only) out of `work`,
     * or adding a third bucket like `learning`. Projects can then be
     * tagged with the new category and the planner will respect its
     * window when placing tasks.
     *
     * @example
     * create_category({
     *   id: 'deepwork',
     *   name: 'Deep Work',
     *   display_order: 5,
     *   default_window: { days: [1,2,3,4,5], start: '06:00', end: '09:00' },
     *   timezone: 'America/Chicago'
     * })
     *
     * @see list_categories, update_category
     */
    {
      name: 'create_category',
      description:
        'Create a new category with an optional default scheduling window. ' +
        'default_window shape: ' +
        '{ days: int[] (0=Sun..6=Sat), start: "HH:MM", end: "HH:MM" }.',
      inputSchema: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          display_order: { type: 'integer' },
          timezone: { type: 'string' },
          default_window: {
            type: ['object', 'null'],
            properties: {
              days: { type: 'array', items: { type: 'integer' } },
              start: { type: 'string' },
              end: { type: 'string' },
            },
          },
        },
      },
      async handler(args) {
        return {
          category: createCategory(db, {
            id: requireString(args, 'id'),
            name: requireString(args, 'name'),
            display_order: args.display_order,
            default_window: args.default_window ?? null,
            timezone: args.timezone,
          }),
        };
      },
    },
    /**
     * Update a category's window or metadata.
     *
     * Patch-style: only the fields you pass are changed. Most common
     * use is reshaping `default_window` after the planner has been
     * placing tasks at the wrong hour (e.g. switching `work` from
     * 9-5 to 8-6, or adding Saturday to the workdays).
     *
     * @example
     * update_category({
     *   id: 'work',
     *   default_window: { days: [1,2,3,4,5,6], start: '08:00', end: '18:00' }
     * })
     *
     * @see list_categories, create_category
     */
    {
      name: 'update_category',
      description:
        "Update a category's name, display order, timezone, or default " +
        'scheduling window.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          display_order: { type: 'integer' },
          timezone: { type: 'string' },
          default_window: {
            type: ['object', 'null'],
            properties: {
              days: { type: 'array', items: { type: 'integer' } },
              start: { type: 'string' },
              end: { type: 'string' },
            },
          },
        },
      },
      async handler(args) {
        const id = requireString(args, 'id');
        const patch: {
          name?: string;
          display_order?: number;
          timezone?: string;
          default_window?: CategoryWindow | null;
        } = {};
        if (args.name !== undefined) patch.name = args.name;
        if (args.display_order !== undefined)
          patch.display_order = args.display_order;
        if (args.timezone !== undefined) patch.timezone = args.timezone;
        if (args.default_window !== undefined)
          patch.default_window = args.default_window;
        return { category: updateCategory(db, id, patch) };
      },
    },

    // -------- availability overrides --------
    // The frictionless answer to "Tuesday night I'm doing nothing — don't
    // schedule anything." One conversational sentence → one MCP call →
    // the block exists. No settings UI, no placeholder calendar event.
    /**
     * Reserve a window so the planner won't schedule into it.
     *
     * The whole point: "Tuesday night I'm doing nothing — don't
     * schedule anything" should be one MCP call from one sentence
     * to Claude. No settings UI, no placeholder calendar event.
     *
     * `category_id` scopes the block: `null` blocks across every
     * category (you're literally unavailable), `"personal"` blocks
     * only personal-category projects (you're at work, so personal
     * tasks shouldn't get placed during this window), etc.
     *
     * @example
     * block_time({
     *   start: '2026-05-12T18:00:00-05:00',
     *   end:   '2026-05-12T22:00:00-05:00',
     *   reason: 'family dinner'
     * })
     *
     * @see open_time, list_availability, clear_availability
     */
    {
      name: 'block_time',
      description:
        "Reserve a window so the planner won't schedule into it. " +
        'category_id is optional — leave it null to block across every ' +
        'category, or set it to scope (e.g. "personal") to block only ' +
        'that category.',
      inputSchema: {
        type: 'object',
        required: ['start', 'end'],
        properties: {
          start: { type: 'string' },
          end: { type: 'string' },
          category_id: { type: ['string', 'null'] },
          reason: { type: ['string', 'null'] },
        },
      },
      async handler(args) {
        return {
          override: createAvailabilityOverride(db, {
            start: requireString(args, 'start'),
            end: requireString(args, 'end'),
            available: 0,
            category_id: args.category_id ?? null,
            reason: args.reason ?? null,
          }),
        };
      },
    },
    /**
     * Carve out a window inside a normally-blocked time, e.g.
     * "Saturday morning is fair game for personal work this week".
     *
     * The inverse of `block_time`. Useful when the default category
     * window is conservative (personal = evenings only) but a
     * specific date is freer than usual.
     *
     * @example
     * open_time({
     *   start: '2026-05-09T10:00:00-05:00',
     *   end:   '2026-05-09T12:00:00-05:00',
     *   category_id: 'personal',
     *   reason: 'free Saturday morning'
     * })
     *
     * @see block_time, list_availability
     */
    {
      name: 'open_time',
      description:
        'Mark a window as available even if it falls outside the normal ' +
        'category window. e.g. "Saturday morning is fair game for personal ' +
        'work".',
      inputSchema: {
        type: 'object',
        required: ['start', 'end'],
        properties: {
          start: { type: 'string' },
          end: { type: 'string' },
          category_id: { type: ['string', 'null'] },
          reason: { type: ['string', 'null'] },
        },
      },
      async handler(args) {
        return {
          override: createAvailabilityOverride(db, {
            start: requireString(args, 'start'),
            end: requireString(args, 'end'),
            available: 1,
            category_id: args.category_id ?? null,
            reason: args.reason ?? null,
          }),
        };
      },
    },
    /**
     * List availability overrides intersecting [from, to].
     *
     * Returns both blocks (`available: 0`) and openings (`available: 1`).
     * The planner consults this before suggesting placements; the GUI
     * renders blocks as greyed-out time on the timeline (follow-up).
     *
     * Pass `category_id: null` to get only global overrides (those that
     * apply regardless of category); omit it to get every override.
     *
     * @example
     * list_availability({ from: '2026-05-04', to: '2026-05-10' })
     *
     * @see block_time, open_time, clear_availability
     */
    {
      name: 'list_availability',
      description:
        'List availability overrides intersecting [from, to]. Optional ' +
        'category_id filter (pass null to get global-only overrides).',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          category_id: { type: ['string', 'null'] },
        },
      },
      async handler(args) {
        return {
          overrides: listAvailabilityOverrides(db, {
            from: args.from,
            to: args.to,
            category_id: args.category_id,
          }),
        };
      },
    },
    {
      name: 'delete_availability',
      description: 'Delete a single availability override by id',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      async handler(args) {
        deleteAvailabilityOverride(db, requireNumber(args, 'id'));
        return { ok: true };
      },
    },
    /**
     * Wipe every override fully contained in [start, end].
     *
     * The other half of the friction-floor goal: changing your mind
     * should be just as easy as setting the block in the first place.
     * "Actually, I'm free Tuesday night" → one MCP call → the block is
     * gone. The user never has to look up an override id.
     *
     * Optional `category_id` scopes the clear (e.g. drop only the
     * personal blocks in the range, leave the work ones).
     *
     * @example
     * clear_availability({
     *   start: '2026-05-12T00:00:00Z',
     *   end:   '2026-05-13T00:00:00Z'
     * })
     *
     * @see block_time, delete_availability
     */
    {
      name: 'clear_availability',
      description:
        'Clear every override fully contained in [start, end]. Useful when ' +
        'plans change: "actually, I am free Tuesday night" wipes the block ' +
        'without making the user remember IDs.',
      inputSchema: {
        type: 'object',
        required: ['start', 'end'],
        properties: {
          start: { type: 'string' },
          end: { type: 'string' },
          category_id: { type: ['string', 'null'] },
        },
      },
      async handler(args) {
        const removed = clearAvailabilityOverrides(db, {
          start: requireString(args, 'start'),
          end: requireString(args, 'end'),
          category_id: args.category_id,
        });
        return { removed };
      },
    },

    // -------- gui --------
    /**
     * Start the read-only week-view GUI dashboard (a separate Node
     * process, normally on port 3737) and return its URL. Idempotent:
     * if the GUI is already running — tracked PID alive, or the port is
     * already in use — it returns the existing URL instead of spawning a
     * duplicate. The child is detached so it survives MCP restarts; stop
     * it with `gui_stop`.
     *
     * @example
     * gui_start()
     *
     * @see gui_stop, gui_status
     */
    {
      name: 'gui_start',
      description:
        'Start the week-view GUI dashboard (separate process, default ' +
        'port 3737) and return its URL. No-op if already running.',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return guiStart();
      },
    },
    /**
     * Stop the GUI server previously started by `gui_start`. Only kills a
     * process recorded in the sidecar PID file — a GUI started by hand
     * (`npm run gui`) is left alone.
     *
     * @example
     * gui_stop()
     *
     * @see gui_start, gui_status
     */
    {
      name: 'gui_stop',
      description: 'Stop the GUI server started by gui_start.',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return guiStop();
      },
    },
    /**
     * Report GUI server status: { running, pid, url, source }. `source`
     * is 'pid' (our spawn), 'port' (someone else's process on the port),
     * or null. Use before `gui_start` to decide whether to start.
     *
     * @example
     * gui_status()
     *
     * @see gui_start, gui_stop
     */
    {
      name: 'gui_status',
      description: 'Report GUI server status { running, pid, url, source }.',
      inputSchema: { type: 'object', properties: {} },
      async handler() {
        return guiStatus();
      },
    },
  ];
}
