import type { DB } from '../../db/connection.js';
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
import { startTask, stopTask, completeTask } from '../../time-log.js';
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
import { HarvestClient } from '../../harvest/client.js';
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
      description: 'Create a project with calendar mapping and weekly budget',
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
        });
        return { project };
      },
    },
    {
      name: 'list_projects',
      description: 'List all projects',
      inputSchema: {
        type: 'object',
        properties: { active: { type: 'boolean' } },
      },
      async handler(args) {
        return { projects: listProjects(db, { active: args?.active }) };
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
          active: { type: 'integer' },
        },
      },
      async handler(args) {
        const { id, ...patch } = args;
        return { project: updateProject(db, requireString(args, 'id'), patch) };
      },
    },

    // -------- tasks --------
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
      name: 'start_task',
      description: 'Start the timer on a task',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      async handler(args) {
        const id = requireNumber(args, 'id');
        const entry = startTask(db, id);
        return { entry, task: getTask(db, id) };
      },
    },
    {
      name: 'stop_task',
      description: 'Stop the timer on a task',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer' } },
      },
      async handler(args) {
        const id = requireNumber(args, 'id');
        const entry = stopTask(db, id);
        return { entry, task: getTask(db, id) };
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
    {
      name: 'get_week_layout',
      description:
        'Tasks + habit instances + calendar events for a date range, grouped by day',
      inputSchema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          project_id: { type: 'string' },
        },
      },
      async handler(args) {
        const from = requireString(args, 'from');
        const to = requireString(args, 'to');
        const tasks = listTasks(db, {
          project_id: args.project_id,
        }).filter(
          (t) =>
            t.calendar_event_id !== null &&
            t.due !== null &&
            t.due >= `${from}T00:00:00Z` &&
            t.due <= `${to}T23:59:59Z`,
        );
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
        return { tasks, habit_instances: habits };
      },
    },
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

        const updated = updateTask(db, taskId, {
          calendar_event_id: event.id,
          due: start,
        });
        setTaskStatus(db, taskId, 'SCHEDULED');
        return { task: getTask(db, taskId), event, _previous: updated };
      },
    },
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
        if (task.calendar_event_id) {
          const project = getProject(db, task.project_id);
          await calendar.deleteEvent({
            calendar_id: project?.calendar_id ?? null,
            event_id: task.calendar_event_id,
          });
        }
        updateTask(db, taskId, { calendar_event_id: null });
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

    // -------- timesheet --------
    {
      name: 'export_timesheet',
      description:
        'Render a timesheet for a date range. `format` is "csv" (default) ' +
        'or "markdown". `include_totals` appends per-project subtotals and ' +
        'a grand total row (markdown always includes totals).',
      inputSchema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
          format: { type: 'string', enum: ['csv', 'markdown'] },
          include_totals: { type: 'boolean' },
        },
      },
      async handler(args) {
        const format =
          args?.format === 'markdown' ? 'markdown' : 'csv';
        const rendered = exportTimesheet(
          db,
          requireString(args, 'from'),
          requireString(args, 'to'),
          {
            format,
            includeTotals: args?.include_totals === true,
          },
        );
        // Keep the legacy `csv` key on the response for backwards
        // compatibility with any caller that already reads it.
        return { format, [format === 'markdown' ? 'markdown' : 'csv']: rendered };
      },
    },
    {
      name: 'get_timesheet_summary',
      description:
        'Structured timesheet data for a date range: rows plus ' +
        'per-project totals plus grand total (in hours). Prefer this ' +
        'over export_timesheet when a planner skill needs to reason ' +
        'about the numbers instead of just display them.',
      inputSchema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
        },
      },
      async handler(args) {
        return {
          summary: getTimesheetSummary(
            db,
            requireString(args, 'from'),
            requireString(args, 'to'),
          ),
        };
      },
    },

    // -------- harvest --------
    {
      name: 'harvest_push_timesheet',
      description:
        'Push time_log entries to Harvest for a date range. Requires ' +
        'HARVEST_TOKEN and HARVEST_ACCOUNT_ID env vars. Skips entries ' +
        'already pushed (harvest_entry_id set). Projects must have ' +
        'harvest_project_id and harvest_task_id mapped.',
      inputSchema: {
        type: 'object',
        required: ['from', 'to'],
        properties: {
          from: { type: 'string' },
          to: { type: 'string' },
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
        return harvestPushTimesheet(
          db,
          client,
          requireString(args, 'from'),
          requireString(args, 'to'),
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
    {
      name: 'sync_calendar_events',
      description:
        'Import external calendar events into Calendrome. ' +
        'If clear_range is provided, existing events in that range are deleted first.',
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
        let deleted = 0;
        if (args.clear_range) {
          deleted = deleteCalendarEventsInRange(
            db,
            args.clear_range.from,
            args.clear_range.to,
          );
        }
        const events: CalendarEventInput[] = args.events ?? [];
        const result = syncCalendarEvents(db, events);
        return { upserted: result.upserted, deleted };
      },
    },
  ];
}
