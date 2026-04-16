import type { DB } from './db/connection.js';

interface QueryRow {
  date: string;
  prefix: string;
  minutes: number;
  title: string;
  notes: string | null;
}

export interface TimesheetRow {
  date: string;
  project: string;
  hours: number;
  task: string;
  notes: string | null;
}

export interface ProjectTotal {
  project: string;
  total_hours: number;
}

export interface TimesheetSummary {
  rows: TimesheetRow[];
  by_project: ProjectTotal[];
  grand_total_hours: number;
}

export interface ExportOptions {
  format?: 'csv' | 'markdown';
  includeTotals?: boolean;
}

function csvEscape(value: string): string {
  if (value === '') return '';
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function mdEscape(value: string): string {
  return value.replace(/\|/g, '\\|');
}

function formatHours(minutes: number): number {
  // Preserve decimal precision but avoid floating artifacts. Rounding to
  // 4 places is well past what a timesheet needs and keeps the output
  // readable (e.g. 1.25, 0.5, 1).
  return Number((minutes / 60).toFixed(4));
}

function query(db: DB, fromDate: string, toDate: string): QueryRow[] {
  return db
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
    .all(fromDate, toDate) as QueryRow[];
}

/**
 * Structured timesheet data: flat rows plus per-project totals and a
 * grand total. MCP callers and the daily/weekly planner skills should
 * prefer this over the stringified CSV/Markdown.
 */
export function getTimesheetSummary(
  db: DB,
  fromDate: string,
  toDate: string,
): TimesheetSummary {
  const rows = query(db, fromDate, toDate);

  const byProject = new Map<string, number>();
  let grandMinutes = 0;
  for (const r of rows) {
    byProject.set(r.prefix, (byProject.get(r.prefix) ?? 0) + r.minutes);
    grandMinutes += r.minutes;
  }

  const by_project: ProjectTotal[] = [...byProject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, minutes]) => ({
      project,
      total_hours: formatHours(minutes),
    }));

  return {
    rows: rows.map((r) => ({
      date: r.date,
      project: r.prefix,
      hours: formatHours(r.minutes),
      task: r.title,
      notes: r.notes,
    })),
    by_project,
    grand_total_hours: formatHours(grandMinutes),
  };
}

function renderCsv(summary: TimesheetSummary, includeTotals: boolean): string {
  const lines = ['date,project,hours,task,notes'];
  for (const r of summary.rows) {
    lines.push(
      [
        r.date,
        csvEscape(r.project),
        String(r.hours),
        csvEscape(r.task),
        csvEscape(r.notes ?? ''),
      ].join(','),
    );
  }
  if (includeTotals) {
    for (const p of summary.by_project) {
      lines.push(`,${p.project} subtotal,${p.total_hours},,`);
    }
    lines.push(`,TOTAL,${summary.grand_total_hours},,`);
  }
  return lines.join('\n') + '\n';
}

function renderMarkdown(summary: TimesheetSummary): string {
  const lines: string[] = [];
  lines.push('| date | project | hours | task | notes |');
  lines.push('| --- | --- | ---: | --- | --- |');
  for (const r of summary.rows) {
    lines.push(
      `| ${r.date} | ${mdEscape(r.project)} | ${r.hours} | ${mdEscape(
        r.task,
      )} | ${mdEscape(r.notes ?? '')} |`,
    );
  }
  // Totals footer — always included for markdown since a table without a
  // total is rarely what you want when you're pasting into a doc.
  for (const p of summary.by_project) {
    lines.push(
      `| **${p.project} subtotal** |  | **${p.total_hours}** |  |  |`,
    );
  }
  lines.push(
    `| **TOTAL** |  | **${summary.grand_total_hours}** |  |  |`,
  );
  return lines.join('\n') + '\n';
}

/**
 * Render a timesheet. Default format is CSV without totals (stable
 * contract — existing consumers keep working). Pass `{ format: 'markdown' }`
 * to get a GitHub-flavored table, or `{ includeTotals: true }` to append
 * per-project subtotals and a grand total to the CSV.
 */
export function exportTimesheet(
  db: DB,
  fromDate: string,
  toDate: string,
  options: ExportOptions = {},
): string {
  const summary = getTimesheetSummary(db, fromDate, toDate);
  if (options.format === 'markdown') {
    return renderMarkdown(summary);
  }
  return renderCsv(summary, options.includeTotals === true);
}
