import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './connection.js';
import { now } from '../clock.js';
import { STANDING_WEEK } from '../standing-assignments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_WORK_WINDOW = JSON.stringify({
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '17:00',
});
const DEFAULT_PERSONAL_WINDOW = JSON.stringify({
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '18:00',
  end: '22:00',
});

export function hasColumn(db: DB, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as {
    name: string;
  }[];
  return cols.some((c) => c.name === column);
}

export function migrate(db: DB): void {
  const sql = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(sql);

  if (!hasColumn(db, 'projects', 'category_id')) {
    db.exec(
      'ALTER TABLE projects ADD COLUMN category_id TEXT REFERENCES categories(id)',
    );
  }

  if (!hasColumn(db, 'habit_instances', 'time_entry_id')) {
    db.exec(
      'ALTER TABLE habit_instances ADD COLUMN time_entry_id INTEGER REFERENCES time_entry(id)',
    );
  }
  // CREDITED_ELSEWHERE_SQL (src/assignments.ts) runs a correlated
  // EXISTS on habit_instances.time_entry_id for every project entry
  // (#173). Created here, after the column add, rather than in
  // schema.sql, which runs first and would fail on a DB that predates
  // the column.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_habit_instances_time_entry ON habit_instances(time_entry_id)',
  );

  // Commitments (#106): goal-linked time entries and the
  // N-per-week habit form.
  if (!hasColumn(db, 'time_entry', 'goal_id')) {
    db.exec(
      'ALTER TABLE time_entry ADD COLUMN goal_id INTEGER REFERENCES goals(id)',
    );
  }
  if (!hasColumn(db, 'habits', 'times_per_week')) {
    db.exec('ALTER TABLE habits ADD COLUMN times_per_week INTEGER');
  }
  // Hand-placed habit instances (#138) keep their time through
  // schedule edits; everything that predates placement was generated.
  if (!hasColumn(db, 'habit_instances', 'origin')) {
    db.exec("ALTER TABLE habit_instances ADD COLUMN origin TEXT NOT NULL DEFAULT 'generated'");
  }

  // M5 cutover (#173): project caps move from
  // projects.weekly_budget_minutes into standing assignment rows.
  foldWeeklyBudgetColumn(db);

  const count = (
    db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }
  ).n;
  if (count === 0) {
    const insert = db.prepare(
      `INSERT INTO categories (id, name, display_order, default_window, timezone)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('work', 'Work', 0, DEFAULT_WORK_WINDOW, 'UTC');
    insert.run('personal', 'Personal', 1, DEFAULT_PERSONAL_WINDOW, 'UTC');
  }

  // Backfill: projects with no category land in 'work' (where everything
  // has lived up to now). Keeps existing installs functional.
  db.prepare(
    "UPDATE projects SET category_id = 'work' WHERE category_id IS NULL",
  ).run();

  normalizeTimeEntryTimestamps(db);
  normalizeAvailabilityTimestamps(db);
  normalizeBookkeepingTimestamps(db);
}

/**
 * One-shot normalization of time_entry timestamps to the canonical
 * UTC form (`YYYY-MM-DDTHH:MM:SSZ`) — see `src/day-range.ts` (#95).
 * Historical rows persisted whatever form the caller supplied: local
 * offsets (`…T11:15:00-05:00`), millisecond precision (`…T19:15:00.000Z`),
 * or `datetime('now')` output (`YYYY-MM-DD HH:MM:SS`).
 *
 * Normalization happens in SQL via strftime, not in JS: SQLite treats
 * bare datetime strings as UTC (matching how `DATE(start_at)` already
 * buckets them), whereas JS `Date.parse` would read them as local time
 * and shift the instant. strftime converts offset-stamped values to
 * UTC and returns NULL for unparseable ones, which COALESCE leaves
 * untouched.
 *
 * Idempotent: canonical values map to themselves, so steady-state cost
 * is one SELECT that matches nothing. Rows are updated one at a time
 * because a row whose `end_at >= start_at` CHECK only held under
 * lexicographic comparison of mixed forms could fail it once both
 * sides are true UTC instants — such rows are skipped with a warning
 * rather than aborting startup.
 */
function normalizeTimeEntryTimestamps(db: DB): void {
  const canon = (col: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`;
  const dirty = db
    .prepare(`
      SELECT id FROM time_entry
      WHERE start_at != ${canon('start_at')}
         OR end_at   != ${canon('end_at')}
         OR (confirmed_at IS NOT NULL AND confirmed_at != ${canon('confirmed_at')})
         OR (synced_at    IS NOT NULL AND synced_at    != ${canon('synced_at')})
    `)
    .all() as { id: number }[];
  if (dirty.length === 0) return;

  const normalize = db.prepare(`
    UPDATE time_entry SET
      start_at     = COALESCE(${canon('start_at')}, start_at),
      end_at       = COALESCE(${canon('end_at')}, end_at),
      confirmed_at = COALESCE(${canon('confirmed_at')}, confirmed_at),
      synced_at    = COALESCE(${canon('synced_at')}, synced_at)
    WHERE id = ?
  `);
  for (const { id } of dirty) {
    try {
      normalize.run(id);
    } catch (err) {
      console.error(
        `time_entry ${id}: skipped timestamp normalization (${(err as Error).message})`,
      );
    }
  }
}

/**
 * Same one-shot normalization for availability_overrides (#145).
 * `createAvailabilityOverride` used to insert caller-supplied strings
 * verbatim, so historical rows can carry local offsets
 * (`…T20:00:00-05:00`) that break the lexicographic range compares in
 * `listAvailabilityOverrides` / `clearAvailabilityOverrides`. Same
 * strftime idiom as time_entry above; the table has no CHECK between
 * start and end, so a single bulk UPDATE suffices. Idempotent:
 * canonical values map to themselves.
 */
function normalizeAvailabilityTimestamps(db: DB): void {
  const canon = (col: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`;
  db.prepare(`
    UPDATE availability_overrides SET
      start = COALESCE(${canon('start')}, start),
      end   = COALESCE(${canon('end')}, end)
    WHERE start != ${canon('start')}
       OR end   != ${canon('end')}
  `).run();
}

/**
 * Same one-shot normalization for bookkeeping stamps (#149).
 * Historical rows carry `datetime('now')` output (`YYYY-MM-DD
 * HH:MM:SS`) from schema defaults and SQL-side stamping; new writes go
 * through `src/clock.ts` and land in the canonical `…T…Z` form. Mixed
 * forms are exactly the format-sniffing hazard #95 removed for domain
 * timestamps, so collapse the legacy rows here once. Same strftime
 * idiom as above; none of these tables have cross-column CHECKs, so
 * bulk UPDATEs suffice. Idempotent: canonical values map to
 * themselves.
 */
function normalizeBookkeepingTimestamps(db: DB): void {
  const canon = (col: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`;
  const tables: Record<string, string[]> = {
    projects: ['created_at', 'updated_at'],
    tasks: ['created_at', 'updated_at'],
    habits: ['created_at'],
    habit_instances: ['completed_at'],
    categories: ['created_at'],
    availability_overrides: ['created_at'],
    goals: ['created_at'],
    assignments: ['updated_at'],
    envelope_moves: ['created_at'],
    meeting_project_mappings: ['created_at'],
    inbox: ['created_at'],
    sync_log: ['synced_at'],
    time_entry: ['created_at', 'updated_at'],
  };
  for (const [table, cols] of Object.entries(tables)) {
    const sets = cols
      .map((c) => `${c} = COALESCE(${canon(c)}, ${c})`)
      .join(', ');
    const where = cols
      .map((c) => `(${c} IS NOT NULL AND ${c} != ${canon(c)})`)
      .join(' OR ');
    db.prepare(`UPDATE ${table} SET ${sets} WHERE ${where}`).run();
  }
}

/**
 * Path of the one-shot pre-migration backup for a file-backed DB, or
 * null for an in-memory / anonymous one.
 */
export function preFoldBackupPath(db: DB): string | null {
  if (db.memory || !db.name) return null;
  return `${db.name}.pre-173.bak`;
}

/**
 * Copy the DB next to itself before the irreversible column drop
 * (`VACUUM INTO`, a consistent snapshot even under WAL). Never
 * overwrites an existing backup: a second boot, or a concurrent one
 * that lost the race, keeps the first copy. Logged on stderr (stdout
 * is the MCP protocol channel).
 */
function backupBeforeFold(db: DB): void {
  const path = preFoldBackupPath(db);
  if (path === null || existsSync(path)) return;
  try {
    db.prepare('VACUUM INTO ?').run(path);
  } catch (err) {
    // A concurrent boot wrote it between the check and the VACUUM.
    if (existsSync(path)) return;
    throw err;
  }
  console.error(
    `calendrome: backed up ${db.name} to ${path} before folding weekly_budget_minutes into assignments (#173)`,
  );
}

/**
 * The M5 migration (#173): fold `projects.weekly_budget_minutes` into
 * standing assignment rows, then drop the column.
 *
 * - A file-backed DB that still has the column is first copied to
 *   `<db>.pre-173.bak` (see `backupBeforeFold`).
 * - The fold runs in one IMMEDIATE transaction, so a failure leaves the
 *   column (and every cap) intact, and two processes booting at once
 *   serialize on the write lock (the connection's busy timeout makes
 *   the second wait). The column check is repeated under the lock: if
 *   the other process already folded, this is a no-op.
 * - Idempotent: a DB without the column is a no-op. An existing
 *   standing row (not possible before this migration, but cheap to
 *   respect) wins.
 */
export function foldWeeklyBudgetColumn(db: DB): void {
  if (!hasColumn(db, 'projects', 'weekly_budget_minutes')) return;
  backupBeforeFold(db);
  db.transaction(() => {
    if (!hasColumn(db, 'projects', 'weekly_budget_minutes')) return;
    db.prepare(
      `INSERT OR IGNORE INTO assignments
         (envelope_type, envelope_id, week_start, minutes, updated_at)
       SELECT 'project', id, ?, weekly_budget_minutes, ?
         FROM projects
        WHERE weekly_budget_minutes IS NOT NULL`,
    ).run(STANDING_WEEK, now());
    db.exec('ALTER TABLE projects DROP COLUMN weekly_budget_minutes');
  }).immediate();
}
