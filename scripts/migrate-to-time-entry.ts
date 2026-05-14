/**
 * One-shot migration: legacy `time_log` + `calendar_events` -> `time_entry`.
 *
 * Runs ONCE against the user's live DB. Idempotent: re-running after the
 * first cutover is a no-op (the idempotency guard short-circuits when the
 * legacy `time_log` table is gone).
 *
 * Migration is wrapped in a single transaction. The inline parity check
 * (Step G) THROWS on any per-project mismatch between BEFORE totals (from
 * `time_log`) and AFTER totals (from CONFIRMED manual `time_entry` rows),
 * which rolls back the transaction — so we never end up in a half-migrated
 * state. Legacy tables and columns are only dropped after parity passes.
 *
 * CLI:
 *   tsx scripts/migrate-to-time-entry.ts <path-to-calendrome.db>
 */
import Database from 'better-sqlite3';

type DB = Database.Database;

function tableExists(db: DB, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
  return !!row;
}

function hasColumn(db: DB, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as {
    name: string;
  }[];
  return cols.some((c) => c.name === column);
}

export function runMigration(db: DB): void {
  // Step A: Idempotency guard — if time_log is gone, migration already ran.
  if (!tableExists(db, 'time_log')) {
    return;
  }

  // Capture BEFORE parity totals OUTSIDE the transaction so we can compare
  // against AFTER totals computed inside.
  const beforeRows = db
    .prepare(
      `SELECT p.prefix AS prefix, CAST(SUM(tl.duration_minutes) AS INTEGER) AS m
       FROM time_log tl
       JOIN tasks t ON t.id = tl.task_id
       JOIN projects p ON p.id = t.project_id
       GROUP BY p.prefix`,
    )
    .all() as { prefix: string; m: number }[];
  const before = new Map<string, number>();
  for (const r of beforeRows) before.set(r.prefix, r.m ?? 0);

  const tx = db.transaction(() => {
    // Step B: Copy confirmed historical hours from time_log.
    db.exec(`
      INSERT INTO time_entry (
        task_id, project_id, start_at, end_at, actual_minutes,
        status, confirmed_at, source, harvest_entry_id, notes
      )
      SELECT
        tl.task_id,
        t.project_id,
        tl.started_at,
        COALESCE(tl.stopped_at, datetime(tl.started_at, '+' || tl.duration_minutes || ' minutes')),
        tl.duration_minutes,
        'CONFIRMED',
        COALESCE(tl.stopped_at, tl.started_at),
        'manual',
        tl.harvest_entry_id,
        tl.notes
      FROM time_log tl
      JOIN tasks t ON t.id = tl.task_id
    `);

    // Step C: Copy future task-linked placements (only if calendar_event_id
    // column still exists on tasks — paranoia for partial pre-state).
    if (hasColumn(db, 'tasks', 'calendar_event_id')) {
      db.exec(`
        INSERT INTO time_entry (task_id, project_id, start_at, end_at, status, source, is_meeting, notes)
        SELECT t.id, ce.project_id, ce.start, ce.end, 'UNCONFIRMED', 'placement', ce.is_meeting, ce.summary
        FROM calendar_events ce
        JOIN tasks t ON t.calendar_event_id = ce.id
        WHERE ce.start > datetime('now')
      `);
    }

    // Step D: Copy future gcal-sync events that are NOT task-linked.
    // Skip any external_id that's already present (paranoia: prior dual-write
    // may have populated some).
    const taskJoinClause = hasColumn(db, 'tasks', 'calendar_event_id')
      ? `LEFT JOIN tasks t ON t.calendar_event_id = ce.id`
      : `LEFT JOIN tasks t ON 1=0`;
    const taskFilterClause = hasColumn(db, 'tasks', 'calendar_event_id')
      ? `AND t.id IS NULL`
      : ``;
    db.exec(`
      INSERT INTO time_entry (project_id, start_at, end_at, status, source, external_id, is_meeting, synced_at, notes)
      SELECT ce.project_id, ce.start, ce.end, 'UNCONFIRMED', 'gcal-sync', ce.id, ce.is_meeting, ce.synced_at, ce.summary
      FROM calendar_events ce
      ${taskJoinClause}
      WHERE ce.start > datetime('now')
        ${taskFilterClause}
        AND NOT EXISTS (SELECT 1 FROM time_entry te WHERE te.external_id = ce.id)
    `);

    // Step E: Past calendar_events placements are intentionally NOT migrated.
    // They're the bug source. Leave them un-migrated (they live in
    // calendar_events until Step H drops the table).

    // Step F: Habit instances -> paired time_entry rows + sidecar FK.
    db.exec(`
      INSERT INTO time_entry (task_id, project_id, start_at, end_at, status, source, notes)
      SELECT NULL, h.project_id, hi.scheduled_start, hi.scheduled_end,
             CASE WHEN hi.status = 'COMPLETED' THEN 'CONFIRMED' ELSE 'UNCONFIRMED' END,
             'habit',
             h.title
      FROM habit_instances hi JOIN habits h ON h.id = hi.habit_id
      WHERE hi.time_entry_id IS NULL
    `);

    db.exec(`
      UPDATE habit_instances
      SET time_entry_id = (
        SELECT te.id FROM time_entry te
        JOIN habits h ON h.id = habit_instances.habit_id
        WHERE te.source = 'habit'
          AND te.start_at = habit_instances.scheduled_start
          AND te.project_id = h.project_id
        ORDER BY te.id ASC
        LIMIT 1
      )
      WHERE time_entry_id IS NULL
    `);

    // Step G: Parity check — per-project CONFIRMED manual minutes.
    const afterRows = db
      .prepare(
        `SELECT p.prefix AS prefix,
                CAST(SUM(COALESCE(te.actual_minutes,
                  ROUND((julianday(te.end_at) - julianday(te.start_at)) * 1440))) AS INTEGER) AS m
         FROM time_entry te
         JOIN projects p ON p.id = te.project_id
         WHERE te.status='CONFIRMED' AND te.source='manual'
         GROUP BY p.prefix`,
      )
      .all() as { prefix: string; m: number }[];
    const after = new Map<string, number>();
    for (const r of afterRows) after.set(r.prefix, r.m ?? 0);

    // Strict: per-prefix BEFORE (time_log) must equal AFTER
    // (time_entry CONFIRMED manual). Any mismatch — including drift from
    // pre-existing manual rows — aborts the transaction.
    const allPrefixes = new Set<string>([...before.keys(), ...after.keys()]);
    for (const prefix of allPrefixes) {
      const expected = before.get(prefix) ?? 0;
      const actual = after.get(prefix) ?? 0;
      if (expected !== actual) {
        throw new Error(
          `parity mismatch for ${prefix}: before=${expected} after=${actual}`,
        );
      }
    }

    // Step H: Drop legacy tables and columns.
    db.exec(`DROP TABLE IF EXISTS time_log`);
    db.exec(`DROP TABLE IF EXISTS calendar_events`);

    if (hasColumn(db, 'tasks', 'time_spent_minutes')) {
      db.exec(`ALTER TABLE tasks DROP COLUMN time_spent_minutes`);
    }
    if (hasColumn(db, 'tasks', 'calendar_event_id')) {
      db.exec(`ALTER TABLE tasks DROP COLUMN calendar_event_id`);
    }
  });

  tx();
}

// CLI entry point
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error(
      'Usage: tsx scripts/migrate-to-time-entry.ts <path-to-calendrome.db>',
    );
    process.exit(1);
  }
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  runMigration(db);
  console.log('Migration complete.');
}
