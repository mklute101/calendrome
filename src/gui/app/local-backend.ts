/**
 * Local backend — the playground's stand-in for the GUI server.
 *
 * Implements `Backend` (see `api.ts`) by calling the exact same core
 * functions the server routes call (`buildWeekPayload`, `buildTasksPayload`,
 * `listProjects`, and the `gui*` mutations), directly against an
 * injected in-browser database (sql.js via `sqljs-adapter.ts`). The
 * server's routes are one-liners over these functions, so there is no
 * response-shaping logic to duplicate — the payloads are identical by
 * construction (the repo's no-drift rule).
 *
 * Domain-guard errors are wrapped in `ApiError` with the same status
 * mapping as the server's `mutate()` helper (404 for "not found", 409
 * otherwise), so the existing toast handling works unchanged.
 *
 * Browser-safe: imports only engine-agnostic core modules (`DB` and
 * `CalendarClient` are type-only imports).
 */
import type { DB } from '../../db/types.js';
import type { CalendarClient } from '../../calendar/types.js';
import { buildWeekPayload } from '../week-data.js';
import { buildTasksPayload } from '../tasks-data.js';
import { listProjects } from '../../projects.js';
import {
  guiPlace,
  guiMove,
  guiConfirm,
  guiSkip,
  guiUnplace,
  guiComplete,
  reopenTask,
  guiSnooze,
} from '../mutations.js';
import { ApiError, type Backend } from './api';
import type { Project, TasksPayload, WeekPayload } from './types';

/**
 * Same contract as `LocalCalendarClient` (a stable unique event id,
 * no-op delete) without importing `src/calendar/` — `google.ts` and
 * `local.ts` pull node built-ins the browser bundle must not see.
 */
const demoCalendar: CalendarClient = {
  async createEvent() {
    return { id: `playground-${crypto.randomUUID()}` };
  },
  async deleteEvent() {},
};

/** Mirror of the server's `mutate()` status mapping. */
async function guarded<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ApiError(msg, /not found/i.test(msg) ? 404 : 409);
  }
}

export function createLocalBackend(db: DB): Backend {
  return {
    fetchProjects: async () =>
      listProjects(db, { active: true }) as unknown as Project[],
    fetchWeek: async (start) =>
      buildWeekPayload(db, start) as unknown as WeekPayload,
    fetchTasks: async () => buildTasksPayload(db) as unknown as TasksPayload,

    placeTask: (args) =>
      guarded(() => guiPlace(db, demoCalendar, args)) as ReturnType<
        Backend['placeTask']
      >,
    // The server route returns guiMove's raw `{ placement: TimeEntryRow }`;
    // api.ts declares the narrower shape callers rely on (start_at/end_at),
    // which the row satisfies at runtime. Same payload as HTTP, hence the cast.
    movePlacement: (id, args) =>
      guarded(() => guiMove(db, id, args)) as unknown as ReturnType<
        Backend['movePlacement']
      >,
    confirmPlacement: (id, args) => guarded(() => guiConfirm(db, id, args)),
    skipPlacement: (id) => guarded(() => guiSkip(db, id)),
    unplaceTask: (id) =>
      guarded(() => guiUnplace(db, demoCalendar, id)) as ReturnType<
        Backend['unplaceTask']
      >,
    completeTask: (id) =>
      guarded(() => guiComplete(db, id)) as ReturnType<Backend['completeTask']>,
    reopenTask: (id, status) =>
      guarded(() => reopenTask(db, id, status)) as ReturnType<
        Backend['reopenTask']
      >,
    snoozeTask: (id, until) =>
      guarded(() => guiSnooze(db, id, until)) as ReturnType<
        Backend['snoozeTask']
      >,
  };
}
