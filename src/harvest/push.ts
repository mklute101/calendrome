import type { DB } from '../db/connection.js';
import { listProjects, type Project } from '../projects.js';
import { listPendingReview } from '../time-entry.js';
import { HarvestClient } from './client.js';

interface TimeEntryRow {
  id: number;
  task_id: number | null;
  project_id: string;
  start_at: string;
  end_at: string;
  actual_minutes: number | null;
  harvest_entry_id: number | null;
  task_title: string | null;
  notes: string | null;
}

export interface PushResult {
  pushed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export interface PushOptions {
  /**
   * Project category filter. Default `['work']` — we never push
   * personal hours to Harvest unless the caller explicitly opts in.
   */
  categories?: string[];
  /**
   * Bypass the UNCONFIRMED-entry pre-flight guard. Off by default so
   * the planner sees the drift before it leaks to Harvest.
   */
  force?: boolean;
}

export async function harvestPushTimesheet(
  db: DB,
  client: HarvestClient,
  fromDate: string,
  toDate: string,
  options: PushOptions = {},
): Promise<PushResult> {
  const categories = options.categories ?? ['work'];
  const force = options.force === true;

  // Pre-flight: refuse to push if there are unconfirmed work entries in
  // the range. Surface the offenders so the planner can fix them up
  // (place_task / log_time / skip / confirm). The guard always asks
  // about the 'work' category — Harvest doesn't care about personal.
  if (!force) {
    // listPendingReview filter is `start_at >= from AND start_at < to`,
    // so widen the upper bound to capture entries on the final date.
    const pending = listPendingReview(db, {
      from: `${fromDate}T00:00:00Z`,
      to: `${toDate}T23:59:59.999Z`,
      category: 'work',
    });
    if (pending.length > 0) {
      const summary = pending
        .slice(0, 5)
        .map(
          (e) =>
            `  - #${e.id} ${e.start_at} (${e.project_id ?? '<no project>'}: ${e.notes ?? 'unnamed'})`,
        )
        .join('\n');
      const more =
        pending.length > 5 ? `\n  ... and ${pending.length - 5} more` : '';
      throw new Error(
        `Cannot push: ${pending.length} unconfirmed ${pending.length === 1 ? 'entry' : 'entries'} in range ${fromDate}..${toDate}.\n` +
          `Confirm them (log_time / place_task / complete_task) or pass force=true to override.\n` +
          summary +
          more,
      );
    }
  }

  if (categories.length === 0) {
    return { pushed: 0, skipped: 0, failed: 0, errors: [] };
  }
  const placeholders = categories.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT
        te.id,
        te.task_id,
        te.project_id,
        te.start_at,
        te.end_at,
        te.actual_minutes,
        te.harvest_entry_id,
        t.title AS task_title,
        te.notes AS notes
       FROM time_entry te
       INNER JOIN projects p ON p.id = te.project_id
       LEFT  JOIN tasks    t ON t.id = te.task_id
       WHERE te.status = 'CONFIRMED'
         AND DATE(te.start_at) >= ?
         AND DATE(te.start_at) <= ?
         AND p.category_id IN (${placeholders})
       ORDER BY te.start_at`,
    )
    .all(fromDate, toDate, ...categories) as TimeEntryRow[];

  const projects = listProjects(db);
  const projectMap = new Map<string, Project>(projects.map((p) => [p.id, p]));

  const result: PushResult = { pushed: 0, skipped: 0, failed: 0, errors: [] };

  for (const row of rows) {
    if (row.harvest_entry_id) {
      result.skipped++;
      continue;
    }

    const project = projectMap.get(row.project_id);
    if (!project?.harvest_project_id || !project?.harvest_task_id) {
      result.failed++;
      result.errors.push(
        `time_entry #${row.id}: project "${row.project_id}" has no harvest_project_id/harvest_task_id mapped`,
      );
      continue;
    }

    const minutes =
      row.actual_minutes ??
      Math.round(
        (new Date(row.end_at).getTime() - new Date(row.start_at).getTime()) /
          60000,
      );

    const spentDate = row.start_at.slice(0, 10);
    const hours = Number((minutes / 60).toFixed(4));
    const noteText = row.task_title ?? row.notes ?? '';

    try {
      const entry = await client.createTimeEntry({
        project_id: project.harvest_project_id,
        task_id: project.harvest_task_id,
        spent_date: spentDate,
        hours,
        notes: noteText,
      });

      db.prepare(
        'UPDATE time_entry SET harvest_entry_id = ?, updated_at = datetime(\'now\') WHERE id = ?',
      ).run(entry.id, row.id);

      result.pushed++;
    } catch (err: any) {
      result.failed++;
      result.errors.push(`time_entry #${row.id}: ${err.message}`);
    }
  }

  return result;
}
