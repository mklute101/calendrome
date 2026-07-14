/**
 * GUI HTTP server — interactive weekly planner (#24, #86).
 *
 * Express app serving the SPA in `public/` plus `/api/*` JSON
 * endpoints: reads for the dashboard payloads, writes for the
 * interactive actions (drag-to-reschedule, place/complete/snooze,
 * confirm/skip/unplace). Every request opens a fresh SQLite
 * connection and closes it in `finally` — that keeps the GUI honest
 * about cross-process writes from the MCP server.
 *
 * Writes reuse the exact core functions behind the MCP tools (via
 * `src/placement.ts` and `./mutations.ts`) so the two surfaces can
 * never drift.
 *
 * Write posture: the server binds 127.0.0.1 only, never sends CORS
 * headers, and rejects any write whose Origin header is not a local
 * GUI origin (the served app, the Vite dev server, or the Tauri
 * shell). A browser tab on a hostile site therefore can't mutate
 * your schedule: cross-origin fetches to localhost require a CORS
 * preflight we never answer, and form posts carry a foreign Origin.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { listProjects } from '../projects.js';
import { listCategories } from '../categories.js';
import { buildWeekPayload } from './week-data.js';
import { buildTasksPayload } from './tasks-data.js';
import {
  GoogleCalendarClient,
  LocalCalendarClient,
  type CalendarClient,
} from '../calendar/index.js';
import {
  guiPlace,
  guiMove,
  guiConfirm,
  guiSkip,
  guiUnplace,
  guiComplete,
  reopenTask,
  guiSnooze,
} from './mutations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CALENDROME_DB ?? 'calendrome.db';
// CALENDROME_GUI_PORT is the specific override (for machines where
// something else also reads PORT); bare PORT is what the sandbox
// skill documents and what people reach for first (#75).
const PORT = Number(
  process.env.CALENDROME_GUI_PORT ?? process.env.PORT ?? 3737,
);

export function createApp(
  dbPath: string,
  calendar: CalendarClient,
): express.Express {
  // Open a fresh connection per request so cross-process writes
  // (from the MCP server) are always visible.
  function getDb() {
    return openDatabase(dbPath);
  }

  const app = express();
  app.use(express.json());
  app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }));

  // The SPA uses hash routing; the old standalone /tasks page is now
  // the #/tasks route. Keep the old URL working.
  app.get('/tasks', (_req, res) => res.redirect('/#/tasks'));

  // Origin guard for writes (see header). GET stays unguarded — the
  // payloads are already readable by any local process via the DB.
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET') return next();
    const origin = req.headers.origin;
    if (origin && !isLocalGuiOrigin(origin)) {
      res.status(403).json({ error: `cross-origin write rejected: ${origin}` });
      return;
    }
    next();
  });

  /** Shared write-route wrapper: JSON result, `{error}` on throw. */
  async function mutate(
    res: express.Response,
    fn: () => unknown | Promise<unknown>,
  ): Promise<void> {
    try {
      res.json(await fn());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(/not found/i.test(msg) ? 404 : 409).json({ error: msg });
    }
  }

  const idParam = (req: express.Request): number => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new Error(`invalid id: ${req.params.id}`);
    return id;
  };

  /**
   * List active projects with budgets and Harvest mappings.
   * Source for the budget cards on the dashboard.
   */
  app.get('/api/projects', (_req, res) => {
    const db = getDb();
    try {
      res.json(listProjects(db, { active: true }));
    } finally {
      db.close();
    }
  });

  /**
   * List categories (work, personal, …). Source for the Work/All toggle
   * in the dashboard header — the client builds a project→category map
   * from `/api/projects` and filters everything client-side.
   */
  app.get('/api/categories', (_req, res) => {
    const db = getDb();
    try {
      res.json(listCategories(db));
    } finally {
      db.close();
    }
  });

  /**
   * Return everything needed to render one week of the dashboard:
   * tasks, materialized habit instances, placements, time logs,
   * project budgets, synced calendar events, and availability
   * overrides. `start` is YYYY-MM-DD; the range covers seven days.
   * Assembly lives in `week-data.ts` so the payload contract is
   * unit-testable without the server.
   */
  app.get('/api/week', (req, res) => {
    const start = String(req.query.start ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
      res.status(400).json({ error: 'start param required (YYYY-MM-DD)' });
      return;
    }

    const db = getDb();
    try {
      res.json(buildWeekPayload(db, start));
    } finally {
      db.close();
    }
  });

  /**
   * List every pending/unfinished task (NEW, IN_PROGRESS, SCHEDULED),
   * ordered by priority then due date. Source for the tasks panel and
   * the full-page `#/tasks` view (#85). Assembly lives in `tasks-data.ts`
   * so the payload contract is unit-testable without the server.
   */
  app.get('/api/tasks', (_req, res) => {
    const db = getDb();
    try {
      res.json(buildTasksPayload(db));
    } finally {
      db.close();
    }
  });

  /**
   * Place a task on the calendar: creates the calendar event and the
   * paired UNCONFIRMED placement time_entry (same path as the
   * `place_task` MCP tool). Body: `{task_id, start, end?}` — `end`
   * defaults to `start + task.duration_minutes`.
   */
  app.post('/api/placements', (req, res) => {
    const { task_id, start, end } = req.body ?? {};
    if (typeof task_id !== 'number' || typeof start !== 'string') {
      res.status(400).json({ error: 'body requires task_id (number) and start (string)' });
      return;
    }
    const db = getDb();
    mutate(res, () => guiPlace(db, calendar, { task_id, start, end })).finally(
      () => db.close(),
    );
  });

  /**
   * Move or resize a placement (drag-to-reschedule). Body:
   * `{start, end?}` — omitting `end` preserves the duration; setting
   * it resizes. Guards mirror `move_placement`: CONFIRMED, gcal-sync,
   * and manual entries refuse with 409.
   */
  app.post('/api/placements/:id/move', (req, res) => {
    const { start, end } = req.body ?? {};
    if (typeof start !== 'string') {
      res.status(400).json({ error: 'body requires start (string)' });
      return;
    }
    const db = getDb();
    mutate(res, () => guiMove(db, idParam(req), { start, end })).finally(() =>
      db.close(),
    );
  });

  /**
   * Confirm an UNCONFIRMED placement actually happened (same as the
   * `confirm_placement` MCP tool). Body: `{actual_minutes?, notes?}`.
   * Idempotent on already-CONFIRMED entries.
   */
  app.post('/api/placements/:id/confirm', (req, res) => {
    const { actual_minutes, notes } = req.body ?? {};
    const db = getDb();
    mutate(res, () => guiConfirm(db, idParam(req), { actual_minutes, notes })).finally(
      () => db.close(),
    );
  });

  /**
   * Skip an UNCONFIRMED placement — the slot didn't happen. Deletes
   * the row (same as `skip_placement`) and returns the deleted span
   * so the client's undo can re-place the task.
   */
  app.post('/api/placements/:id/skip', (req, res) => {
    const db = getDb();
    mutate(res, () => guiSkip(db, idParam(req))).finally(() => db.close());
  });

  /**
   * Unplace a task: removes its calendar event + paired UNCONFIRMED
   * placement and resets SCHEDULED → NEW (same as `unplace_task`).
   * Returns the removed span (`was`) for undo.
   */
  app.post('/api/tasks/:id/unplace', (req, res) => {
    const db = getDb();
    mutate(res, () => guiUnplace(db, calendar, idParam(req))).finally(() =>
      db.close(),
    );
  });

  /** Mark a task COMPLETE (same as the `complete_task` MCP tool). */
  app.post('/api/tasks/:id/complete', (req, res) => {
    const db = getDb();
    mutate(res, () => guiComplete(db, idParam(req))).finally(() => db.close());
  });

  /**
   * Reopen a COMPLETE task — the undo path for an accidental
   * complete. Body: `{status: 'NEW'|'SCHEDULED'|'IN_PROGRESS'}`.
   * Documented deviation from ALLOWED_TRANSITIONS (which only allows
   * COMPLETE → ARCHIVED); refuses tasks that aren't COMPLETE.
   */
  app.post('/api/tasks/:id/reopen', (req, res) => {
    const { status } = req.body ?? {};
    if (!['NEW', 'SCHEDULED', 'IN_PROGRESS'].includes(status)) {
      res.status(400).json({ error: 'body requires status: NEW|SCHEDULED|IN_PROGRESS' });
      return;
    }
    const db = getDb();
    mutate(res, () => reopenTask(db, idParam(req), status)).finally(() =>
      db.close(),
    );
  });

  /**
   * Snooze a task until a date (or clear the snooze with null). Body:
   * `{until: string | null}` — presets like "+1 day" are client-side
   * sugar that compute the ISO date.
   */
  app.post('/api/tasks/:id/snooze', (req, res) => {
    const body = req.body ?? {};
    if (!('until' in body) || (body.until !== null && typeof body.until !== 'string')) {
      res.status(400).json({ error: 'body requires until (string | null)' });
      return;
    }
    const db = getDb();
    mutate(res, () => guiSnooze(db, idParam(req), body.until)).finally(() =>
      db.close(),
    );
  });

  /**
   * Serve the inline-comment-derived documentation bundle that powers
   * the `/docs` page. Generated at build time by `scripts/extract-docs.mjs`.
   */
  app.get('/api/docs', (_req, res) => {
    const docsPath = join(__dirname, 'public', 'docs.json');
    try {
      const text = readFileSync(docsPath, 'utf8');
      res.type('application/json').send(text);
    } catch {
      res.status(503).json({
        error:
          'docs not yet generated — run `npm run build` to produce docs.json',
      });
    }
  });

  return app;
}

function isLocalGuiOrigin(origin: string): boolean {
  if (origin === 'tauri://localhost' || origin === 'http://tauri.localhost') {
    return true;
  }
  try {
    const u = new URL(origin);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1')
    );
  } catch {
    return false;
  }
}

// Entry point: only migrate + listen when run directly
// (`node dist/src/gui/server.js`), not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const initDb = openDatabase(DB_PATH);
  migrate(initDb);
  initDb.close();

  const calendar: CalendarClient =
    process.env.CALENDROME_CALENDAR === 'google'
      ? new GoogleCalendarClient()
      : new LocalCalendarClient();

  createApp(DB_PATH, calendar).listen(PORT, '127.0.0.1', () => {
    console.log(`Calendrome GUI → http://localhost:${PORT}`);
    console.log(`Database: ${DB_PATH}`);
  });
}
