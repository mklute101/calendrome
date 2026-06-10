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
import { listCategories } from '../categories.js';
import { buildWeekPayload } from './week-data.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CALENDROME_DB ?? 'calendrome.db';
// CALENDROME_GUI_PORT is the specific override (for machines where
// something else also reads PORT); bare PORT is what the sandbox
// skill documents and what people reach for first (#75).
const PORT = Number(
  process.env.CALENDROME_GUI_PORT ?? process.env.PORT ?? 3737,
);

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
