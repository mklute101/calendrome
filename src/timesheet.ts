import type { DB } from './db/connection.js';

interface Row {
  date: string;
  prefix: string;
  minutes: number;
  title: string;
  notes: string | null;
}

function csvEscape(value: string): string {
  if (value === '') return '';
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function formatHours(minutes: number): string {
  const hours = minutes / 60;
  // Use a string with trailing zeros stripped (e.g. 1.25, 0.5, 1)
  return Number(hours.toFixed(4)).toString();
}

export function exportTimesheet(
  db: DB,
  fromDate: string,
  toDate: string,
): string {
  const rows = db
    .prepare(
      `SELECT
          DATE(time_log.started_at) AS date,
          projects.prefix          AS prefix,
          tasks.title              AS title,
          tasks.notes              AS notes,
          SUM(time_log.duration_minutes) AS minutes
         FROM time_log
         JOIN tasks    ON tasks.id = time_log.task_id
         JOIN projects ON projects.id = tasks.project_id
        WHERE DATE(time_log.started_at) >= ?
          AND DATE(time_log.started_at) <= ?
          AND time_log.duration_minutes IS NOT NULL
        GROUP BY date, tasks.id
        ORDER BY date, tasks.id`,
    )
    .all(fromDate, toDate) as Row[];

  const lines = ['date,project,hours,task,notes'];
  for (const r of rows) {
    lines.push(
      [
        r.date,
        csvEscape(r.prefix),
        formatHours(r.minutes),
        csvEscape(r.title),
        csvEscape(r.notes ?? ''),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}
