/**
 * Invariant health checks (#164).
 *
 * Tracing shows what happened; these assertions say whether the
 * database is in a bad state *right now*. Each check is one cheap SQL
 * query against the existing schema — no new tables — and each guards
 * a failure mode this project has actually shipped:
 *
 * - `time_entry_canonical_utc`: rows must store the canonical UTC
 *   form (`YYYY-MM-DDTHH:MM:SSZ`). An offset-stamped or fractional
 *   timestamp makes `DATE(start_at)` day bucketing disagree with the
 *   literal local day in the string (#92, #95).
 * - `habit_timezone_not_utc`: an active habit with `timezone = 'UTC'`
 *   is almost always the schema default leaking through — instances
 *   land at the wrong local hour every week.
 * - `task_due_not_placement_written`: `place_task` once wrote the
 *   placement start into `task.due` (#79). A timestamp-form due that
 *   exactly equals one of the task's placement starts is that stale
 *   artifact, not a deliberate deadline.
 * - `placement_backing_commitment`: a `source = 'placement'` entry
 *   must point at an existing task or goal; an orphan row renders as
 *   a block nobody can confirm or unplace.
 * - `calendar_event_id_unique`: `sync_calendar_events` upserts by
 *   `external_id` and relies on the partial unique index; duplicate
 *   ids (legacy DBs predating the index, hand edits) double-count
 *   meetings and break the upsert.
 *
 * The sixth concern from the issue — GUI and MCP serving different
 * database files — cannot be asserted from inside one process, so the
 * report carries this process's resolved `db` path (same idea as
 * `GET /api/version`) and the caller diffs the two surfaces' answers.
 *
 * Exposed identically by `GET /api/health` and the `check_health` MCP
 * tool; failures surface in the shape (`ok` flag + `failing` count),
 * not in prose.
 */
import { resolve } from 'node:path';
import type { DB } from '../db/connection.js';

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  /** True only when every check passed. */
  ok: boolean;
  /** Number of failing checks — zero on a healthy database. */
  failing: number;
  /** This process's resolved database path; diff across surfaces. */
  db: string;
  checks: HealthCheck[];
}

/** Format a failing-row id list, capped so detail stays readable. */
function sample(ids: Array<number | string>): string {
  const shown = ids.slice(0, 10).join(', ');
  return ids.length > 10 ? `${shown}, +${ids.length - 10} more` : shown;
}

const CANONICAL_GLOB =
  '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z';

/**
 * Every `time_entry` timestamp must be stored in the canonical UTC
 * form. Offset-stamped rows bucket under a different UTC day than the
 * local day literally written in the string (#92, #95).
 */
export function checkTimeEntryCanonicalUtc(db: DB): HealthCheck {
  const rows = db
    .prepare(
      `SELECT id FROM time_entry
       WHERE start_at NOT GLOB ? OR end_at NOT GLOB ?
       ORDER BY id`,
    )
    .all(CANONICAL_GLOB, CANONICAL_GLOB) as Array<{ id: number }>;
  return {
    name: 'time_entry_canonical_utc',
    ok: rows.length === 0,
    detail:
      rows.length === 0
        ? 'all time_entry timestamps are canonical UTC (YYYY-MM-DDTHH:MM:SSZ)'
        : `${rows.length} time_entry row(s) with non-canonical timestamps ` +
          `(UTC day bucket disagrees with the written local day): ` +
          `id ${sample(rows.map((r) => r.id))}`,
  };
}

/**
 * Active habits must carry a real IANA timezone. `'UTC'` is the schema
 * default leaking through — instances land at the wrong local hour.
 */
export function checkHabitTimezoneNotUtc(db: DB): HealthCheck {
  const rows = db
    .prepare(
      `SELECT id FROM habits WHERE active = 1 AND timezone = 'UTC' ORDER BY id`,
    )
    .all() as Array<{ id: number }>;
  return {
    name: 'habit_timezone_not_utc',
    ok: rows.length === 0,
    detail:
      rows.length === 0
        ? 'no active habits stored with the default UTC timezone'
        : `${rows.length} active habit(s) stored with timezone 'UTC' ` +
          `(instances land at the wrong local hour): ` +
          `id ${sample(rows.map((r) => r.id))}`,
  };
}

/**
 * A timestamp-form `task.due` equal to one of the task's placement
 * starts is the pre-#79 artifact of `place_task` writing `due`, not a
 * deliberate deadline. Deliberate dues are plain dates (no 'T'), so
 * those are never flagged. `strftime` normalizes offset-stamped dues
 * to the canonical UTC form the placement rows store.
 */
export function checkTaskDueNotPlacementWritten(db: DB): HealthCheck {
  const rows = db
    .prepare(
      `SELECT DISTINCT t.id FROM tasks t
       JOIN time_entry te ON te.task_id = t.id AND te.source = 'placement'
       WHERE t.due IS NOT NULL
         AND instr(t.due, 'T') > 0
         AND strftime('%Y-%m-%dT%H:%M:%SZ', t.due) = te.start_at
       ORDER BY t.id`,
    )
    .all() as Array<{ id: number }>;
  return {
    name: 'task_due_not_placement_written',
    ok: rows.length === 0,
    detail:
      rows.length === 0
        ? 'no task dues matching a placement start (stale place_task writes)'
        : `${rows.length} task(s) whose due equals a placement start ` +
          `(stale pre-#79 write, clear with update_task {due: null}): ` +
          `id ${sample(rows.map((r) => r.id))}`,
  };
}

/**
 * Every `source = 'placement'` entry must reference an existing task
 * or goal — that link is what confirm/unplace/undo operate on.
 */
export function checkPlacementBackingCommitment(db: DB): HealthCheck {
  const rows = db
    .prepare(
      `SELECT te.id FROM time_entry te
       LEFT JOIN tasks t ON t.id = te.task_id
       LEFT JOIN goals g ON g.id = te.goal_id
       WHERE te.source = 'placement'
         AND ((te.task_id IS NULL AND te.goal_id IS NULL)
           OR (te.task_id IS NOT NULL AND t.id IS NULL)
           OR (te.goal_id IS NOT NULL AND g.id IS NULL))
       ORDER BY te.id`,
    )
    .all() as Array<{ id: number }>;
  return {
    name: 'placement_backing_commitment',
    ok: rows.length === 0,
    detail:
      rows.length === 0
        ? 'every placement time_entry references an existing task or goal'
        : `${rows.length} placement time_entry row(s) with no backing ` +
          `task or goal: id ${sample(rows.map((r) => r.id))}`,
  };
}

/**
 * `external_id` (the calendar event id) must be unique across
 * `time_entry` — the sync upsert keys on it. Duplicates come from
 * legacy DBs predating the partial unique index or from hand edits.
 */
export function checkCalendarEventIdUnique(db: DB): HealthCheck {
  const rows = db
    .prepare(
      `SELECT external_id FROM time_entry
       WHERE external_id IS NOT NULL
       GROUP BY external_id HAVING COUNT(*) > 1
       ORDER BY external_id`,
    )
    .all() as Array<{ external_id: string }>;
  return {
    name: 'calendar_event_id_unique',
    ok: rows.length === 0,
    detail:
      rows.length === 0
        ? 'no duplicate calendar event ids in time_entry'
        : `${rows.length} calendar event id(s) appearing on multiple ` +
          `time_entry rows: ${sample(rows.map((r) => r.external_id))}`,
  };
}

/** Resolved path of the file this connection serves, like /api/version. */
function resolveDbPath(db: DB): string {
  const name = db.name;
  if (name === '' || name === ':memory:') return ':memory:';
  return resolve(name);
}

/**
 * Run every invariant check and fold the results into one report.
 * Cheap by construction (one indexed-table scan per check), so it is
 * safe to call at the start of every planning session.
 */
export function runHealthChecks(db: DB): HealthReport {
  const checks: HealthCheck[] = [
    checkTimeEntryCanonicalUtc(db),
    checkHabitTimezoneNotUtc(db),
    checkTaskDueNotPlacementWritten(db),
    checkPlacementBackingCommitment(db),
    checkCalendarEventIdUnique(db),
  ];
  const failing = checks.filter((c) => !c.ok).length;
  return { ok: failing === 0, failing, db: resolveDbPath(db), checks };
}
