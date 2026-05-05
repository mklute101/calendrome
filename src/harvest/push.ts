import type { DB } from '../db/connection.js';
import { listProjects, type Project } from '../projects.js';
import { HarvestClient } from './client.js';

interface TimeLogRow {
  id: number;
  task_id: number;
  started_at: string;
  duration_minutes: number;
  harvest_entry_id: number | null;
  task_title: string;
  project_id: string;
}

export interface PushResult {
  pushed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export async function harvestPushTimesheet(
  db: DB,
  client: HarvestClient,
  fromDate: string,
  toDate: string,
): Promise<PushResult> {
  const rows = db
    .prepare(
      `SELECT
        tl.id,
        tl.task_id,
        tl.started_at,
        tl.duration_minutes,
        tl.harvest_entry_id,
        t.title AS task_title,
        t.project_id
       FROM time_log tl
       JOIN tasks t ON t.id = tl.task_id
       WHERE DATE(tl.started_at) >= ?
         AND DATE(tl.started_at) <= ?
         AND tl.duration_minutes IS NOT NULL
       ORDER BY tl.started_at`,
    )
    .all(fromDate, toDate) as TimeLogRow[];

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
        `time_log #${row.id}: project "${row.project_id}" has no harvest_project_id/harvest_task_id mapped`,
      );
      continue;
    }

    const spentDate = row.started_at.slice(0, 10);
    const hours = Number((row.duration_minutes / 60).toFixed(4));

    try {
      const entry = await client.createTimeEntry({
        project_id: project.harvest_project_id,
        task_id: project.harvest_task_id,
        spent_date: spentDate,
        hours,
        notes: row.task_title,
      });

      db.prepare(
        'UPDATE time_log SET harvest_entry_id = ? WHERE id = ?',
      ).run(entry.id, row.id);

      result.pushed++;
    } catch (err: any) {
      result.failed++;
      result.errors.push(`time_log #${row.id}: ${err.message}`);
    }
  }

  return result;
}
