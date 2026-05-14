/**
 * GUI HTTP server (read-only dashboard).
 *
 * Express app serving the static page in `public/` and a small set of
 * `/api/*` JSON endpoints used by the dashboard. Every request opens a
 * fresh SQLite connection and closes it in `finally` — that keeps the
 * GUI honest about cross-process writes from the MCP server.
 *
 * The GUI never mutates state. All writes happen through MCP tools or
 * direct DB tooling; the dashboard just visualizes what's there.
 */
import express from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { listProjects } from '../projects.js';
import { listTasks } from '../tasks.js';
import { listHabits, generateHabitInstances } from '../habits.js';
import { getAllBudgets } from '../budgets.js';
import { listCalendarEvents } from '../calendar-sync.js';
import { listCategories } from '../categories.js';
import { listAvailabilityOverrides } from '../availability.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CALENDROME_DB ?? 'calendrome.db';
const PORT = Number(process.env.CALENDROME_GUI_PORT ?? 3737);

// Run migrations once at startup
const initDb = openDatabase(DB_PATH);
migrate(initDb);
initDb.close();

// Open a fresh connection per request so cross-process writes
// (from the MCP server) are always visible.
function getDb() {
  return openDatabase(DB_PATH);
}

const app = express();
app.use(express.static(join(__dirname, 'public'), { extensions: ['html'] }));

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
 * tasks, materialized habit instances, time logs, project budgets,
 * synced calendar events, and availability overrides. `start` is
 * YYYY-MM-DD; the range covers seven days.
 */
app.get('/api/week', (req, res) => {
  const start = String(req.query.start ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    res.status(400).json({ error: 'start param required (YYYY-MM-DD)' });
    return;
  }

  const db = getDb();
  try {
    const startDate = new Date(start + 'T00:00:00Z');
    const endDate = new Date(startDate);
    endDate.setUTCDate(endDate.getUTCDate() + 6);
    const end = endDate.toISOString().slice(0, 10);

    const tasks = listTasks(db);
    const weekTasks = tasks.filter((t) => {
      if (t.status === 'ARCHIVED') return false;
      return true;
    });

    const habits = listHabits(db);
    for (const h of habits) {
      try {
        generateHabitInstances(db, h.id, start, end);
      } catch {
        // already generated
      }
    }
    const existingInstances = db
      .prepare(
        `SELECT hi.*, h.title as habit_title, h.project_id, h.duration_minutes as habit_duration
         FROM habit_instances hi
         JOIN habits h ON h.id = hi.habit_id
         WHERE hi.scheduled_start >= ? AND hi.scheduled_start <= ?
         ORDER BY hi.scheduled_start`,
      )
      .all(start + 'T00:00:00', end + 'T23:59:59') as any[];

    // Project CONFIRMED, manual time_entry rows into the legacy time_logs
    // shape the dashboard expects (`started_at`, `duration_minutes`,
    // `task_title`, `project_id`). The unified `time_entry` table is now
    // the source of truth; the legacy `time_log` table is gone.
    const timeLogs = db
      .prepare(
        `SELECT
           te.id                                         AS id,
           te.task_id                                    AS task_id,
           te.start_at                                   AS started_at,
           te.end_at                                     AS stopped_at,
           COALESCE(
             te.actual_minutes,
             CAST(ROUND((julianday(te.end_at) - julianday(te.start_at)) * 24 * 60) AS INTEGER)
           )                                             AS duration_minutes,
           te.notes                                      AS notes,
           t.title                                       AS task_title,
           COALESCE(te.project_id, t.project_id)         AS project_id
         FROM time_entry te
         LEFT JOIN tasks t ON t.id = te.task_id
         WHERE te.status = 'CONFIRMED'
           AND te.source = 'manual'
           AND DATE(te.start_at) >= ? AND DATE(te.start_at) <= ?
         ORDER BY te.start_at`,
      )
      .all(start, end) as any[];

    const budgets = getAllBudgets(db, start);

    const calendarEvents = listCalendarEvents(
      db,
      start + 'T00:00:00',
      end + 'T23:59:59',
    );

    const availability = listAvailabilityOverrides(db, {
      from: start + 'T00:00:00',
      to: end + 'T23:59:59',
    });

    res.json({
      start,
      end,
      tasks: weekTasks,
      habit_instances: existingInstances,
      time_logs: timeLogs,
      budgets,
      calendar_events: calendarEvents,
      availability,
    });
  } finally {
    db.close();
  }
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

app.listen(PORT, () => {
  console.log(`Calendrome GUI → http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
