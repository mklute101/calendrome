/**
 * Shared rig for the GUI/MCP day-parity suite.
 *
 * The contract under test: a "day" means the same thing on both
 * surfaces. The GUI buckets a time_entry by the viewer's LOCAL
 * calendar day (`buildDays`, #82/#104). The MCP read tools bucket by
 * UTC day (`src/day-range.ts`). In any non-UTC zone those disagree at
 * every day edge, so the morning brief asks for "yesterday" and gets a
 * different set of rows than the user is looking at.
 *
 * Every assertion here is timezone-sensitive, so tests drive `withTz`
 * rather than trusting the runner's zone — a UTC-only CI would report
 * all-green against the very bug this suite exists to pin.
 */
import { insertTimeEntry, listPendingReview } from '../../src/time-entry.js';
import { buildWeekPayload } from '../../src/gui/week-data.js';
import { buildDays } from '../../src/gui/app/lib/weekdays';

/**
 * Run `fn` with the process timezone pinned, then restore.
 *
 * Node re-reads `process.env.TZ` for each new Date operation, so this
 * is safe at runtime and lets one file cover several zones. The
 * restore runs in `finally` so a failing expectation can't leak a
 * timezone into the next test.
 */
export async function withTz<T>(tz: string, fn: () => T | Promise<T>): Promise<T> {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/** The local calendar day a timestamp falls on, the way the GUI computes it. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** A work-category project plus a task to hang placements off. */
export function seedWork(db: any): number {
  db.prepare(
    `INSERT INTO projects (id, name, prefix, category_id)
     VALUES ('WORK', 'Work', 'WORK', 'work')`,
  ).run();
  db.prepare(
    `INSERT INTO tasks (project_id, title, status)
     VALUES ('WORK', 'work task', 'PLACED')`,
  ).run();
  return (
    db.prepare(`SELECT id FROM tasks WHERE title = 'work task'`).get() as {
      id: number;
    }
  ).id;
}

/** An UNCONFIRMED placement — the row type both surfaces claim to show. */
export function placement(
  db: any,
  taskId: number,
  startAt: string,
  endAt: string,
  notes?: string,
): number {
  return insertTimeEntry(db, {
    task_id: taskId,
    project_id: 'WORK',
    start_at: startAt,
    end_at: endAt,
    status: 'UNCONFIRMED',
    source: 'placement',
    notes: notes ?? null,
  });
}

/** A CONFIRMED entry — what the timesheet and Harvest push read. */
export function confirmed(
  db: any,
  taskId: number | null,
  startAt: string,
  endAt: string,
  minutes: number,
  projectId = 'WORK',
): number {
  return insertTimeEntry(db, {
    task_id: taskId,
    project_id: projectId,
    start_at: startAt,
    end_at: endAt,
    actual_minutes: minutes,
    status: 'CONFIRMED',
    confirmed_at: endAt,
    source: 'manual',
  });
}

/** A synced meeting row — separate source, same day-bucketing question. */
export function meeting(
  db: any,
  startAt: string,
  endAt: string,
  externalId: string,
): number {
  return insertTimeEntry(db, {
    project_id: 'WORK',
    start_at: startAt,
    end_at: endAt,
    status: 'UNCONFIRMED',
    source: 'gcal-sync',
    external_id: externalId,
    is_meeting: true,
  });
}

const sortIds = (ids: number[]) => [...ids].sort((a, b) => a - b);

/**
 * time_entry ids the GUI actually renders under `day`.
 *
 * `weekStart` must be the Monday of the week containing `day`; the
 * payload is fetched with a day of slack on each edge (#133) and
 * `buildDays` discards anything that buckets outside the week.
 */
export function guiIdsForDay(db: any, weekStart: string, day: string): number[] {
  const payload = buildWeekPayload(db, weekStart);
  const days = buildDays(payload as never, weekStart);
  const bucket = days.find((d) => d.date === day);
  if (!bucket) {
    throw new Error(
      `${day} is not in the week starting ${weekStart} (got ${days
        .map((d) => d.date)
        .join(', ')})`,
    );
  }
  return sortIds(bucket.placed.map((p) => p.time_entry_id));
}

/** time_entry ids the morning brief gets when it asks about `day`. */
export function mcpIdsForDay(db: any, day: string, category = 'work'): number[] {
  return sortIds(
    listPendingReview(db, { from: day, to: day, category }).map((r) => r.id),
  );
}

/** time_entry ids the brief gets for an inclusive multi-day range. */
export function mcpIdsForRange(db: any, from: string, to: string): number[] {
  return sortIds(listPendingReview(db, { from, to }).map((r) => r.id));
}
