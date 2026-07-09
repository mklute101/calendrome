import type { DB } from './db/connection.js';
import { toDayRange } from './day-range.js';

interface QueryRow {
  date: string;
  prefix: string;
  minutes: number;
  title: string;
  notes: string | null;
  status: string;
}

export interface TimesheetRow {
  date: string;
  project: string;
  hours: number;
  task: string;
  notes: string | null;
}

export interface UnconfirmedRow extends TimesheetRow {
  status: 'UNCONFIRMED';
}

export interface ProjectTotal {
  project: string;
  total_hours: number;
}

export interface TimesheetSummary {
  rows: TimesheetRow[];
  by_project: ProjectTotal[];
  grand_total_hours: number;
  /**
   * Present only when `include_unconfirmed: true` is passed. UNCONFIRMED
   * time_entry rows in the same range — surfaced so the planner can see
   * drift between what's scheduled and what's been confirmed.
   */
  unconfirmed?: {
    rows: UnconfirmedRow[];
    grand_total_hours: number;
  };
}

export interface SummaryOptions {
  /**
   * Filter rows by their project's category. Default `['work']`. Pass
   * `['personal']` for personal hours only, `['work', 'personal']` for
   * everything categorized. Projects with no category, and time_entry
   * rows with no project, are always excluded from a category-filtered
   * export — they don't belong to either bucket.
   */
  categories?: string[];
  /**
   * Include UNCONFIRMED entries as a separate section on the summary.
   * Default false (CONFIRMED only).
   */
  include_unconfirmed?: boolean;
}

export interface ExportOptions extends SummaryOptions {
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

function query(
  db: DB,
  fromDate: string,
  toDate: string,
  categories: string[],
  status: 'CONFIRMED' | 'UNCONFIRMED',
): QueryRow[] {
  if (categories.length === 0) return [];
  // Normalize bounds to inclusive UTC day buckets so a caller-supplied
  // timestamp can't lexicographically outrank DATE(te.start_at) and
  // drop the first day of the range (#92).
  const { fromDay, toDay } = toDayRange(fromDate, toDate);
  const placeholders = categories.map(() => '?').join(',');
  // task_id is optional on time_entry, so LEFT JOIN tasks. project_id
  // is similarly nullable; INNER JOIN projects ensures only categorized
  // rows surface in a category-filtered export.
  const sql = `SELECT
        DATE(te.start_at) AS date,
        p.prefix          AS prefix,
        COALESCE(t.title, te.notes, '') AS title,
        COALESCE(t.notes, te.notes)     AS notes,
        SUM(
          COALESCE(
            te.actual_minutes,
            CAST(ROUND((julianday(te.end_at) - julianday(te.start_at)) * 24 * 60) AS INTEGER)
          )
        ) AS minutes,
        te.status         AS status
       FROM time_entry te
       LEFT JOIN tasks    t ON t.id = te.task_id
       INNER JOIN projects p ON p.id = te.project_id
      WHERE te.status = ?
        AND DATE(te.start_at) >= ?
        AND DATE(te.start_at) <= ?
        AND p.category_id IN (${placeholders})
      GROUP BY date, COALESCE(t.id, te.id)
      ORDER BY date, COALESCE(t.id, te.id)`;
  return db
    .prepare(sql)
    .all(status, fromDay, toDay, ...categories) as QueryRow[];
}

function rowsToTimesheetRows(rows: QueryRow[]): TimesheetRow[] {
  return rows.map((r) => ({
    date: r.date,
    project: r.prefix,
    hours: formatHours(r.minutes),
    task: r.title,
    notes: r.notes,
  }));
}

/**
 * Structured timesheet data: flat rows plus per-project totals and a
 * grand total. MCP callers and the daily/weekly planner skills should
 * prefer this over the stringified CSV/Markdown.
 *
 * Reads from `time_entry` filtered to `status = 'CONFIRMED'`. Defaults
 * to the `work` category — personal entries are excluded unless the
 * caller asks for them via `categories`.
 *
 * `fromDate`/`toDate` accept a plain date or an ISO timestamp; both
 * are bucketed to inclusive UTC days (`day-range.ts`), the same
 * semantics as `listPendingReview`.
 */
export function getTimesheetSummary(
  db: DB,
  fromDate: string,
  toDate: string,
  options: SummaryOptions = {},
): TimesheetSummary {
  const categories = options.categories ?? ['work'];
  const rows = query(db, fromDate, toDate, categories, 'CONFIRMED');

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

  const summary: TimesheetSummary = {
    rows: rowsToTimesheetRows(rows),
    by_project,
    grand_total_hours: formatHours(grandMinutes),
  };

  if (options.include_unconfirmed) {
    const unconfirmedRows = query(
      db,
      fromDate,
      toDate,
      categories,
      'UNCONFIRMED',
    );
    let unconfirmedMinutes = 0;
    for (const r of unconfirmedRows) unconfirmedMinutes += r.minutes;
    summary.unconfirmed = {
      rows: rowsToTimesheetRows(unconfirmedRows).map((r) => ({
        ...r,
        status: 'UNCONFIRMED' as const,
      })),
      grand_total_hours: formatHours(unconfirmedMinutes),
    };
  }

  return summary;
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
 *
 * Reads CONFIRMED `time_entry` rows. Defaults to `categories: ['work']`.
 */
export function exportTimesheet(
  db: DB,
  fromDate: string,
  toDate: string,
  options: ExportOptions = {},
): string {
  const summary = getTimesheetSummary(db, fromDate, toDate, {
    categories: options.categories,
  });
  if (options.format === 'markdown') {
    return renderMarkdown(summary);
  }
  return renderCsv(summary, options.includeTotals === true);
}
