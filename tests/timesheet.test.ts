import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createTask } from '../src/tasks.js';
import {
  exportTimesheet,
  getTimesheetSummary,
} from '../src/timesheet.js';

function insertTimeLog(
  db: any,
  taskId: number,
  startedAt: string,
  durationMinutes: number,
) {
  db.prepare(
    `INSERT INTO time_log (task_id, started_at, stopped_at, duration_minutes)
     VALUES (?, ?, ?, ?)`,
  ).run(taskId, startedAt, startedAt, durationMinutes);
}

describe('timesheet export', () => {
  it('returns just a header for an empty range', () => {
    const db = freshDb();
    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19');
    expect(csv.trim()).toBe('date,project,hours,task,notes');
  });

  it('emits one row per (date, task) with hours formatted as decimal', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const t1 = createTask(db, { project_id: 'acme', title: 'Report' });
    const t2 = createTask(db, { project_id: 'acme', title: 'Memo' });

    insertTimeLog(db, t1.id, '2026-04-14T09:00:00Z', 75); // 1.25h
    insertTimeLog(db, t2.id, '2026-04-14T11:00:00Z', 30); // 0.5h
    insertTimeLog(db, t1.id, '2026-04-15T09:00:00Z', 60); // 1h

    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19');
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('date,project,hours,task,notes');
    expect(lines.length).toBe(4);

    expect(lines).toContain('2026-04-14,ACME,1.25,Report,');
    expect(lines).toContain('2026-04-14,ACME,0.5,Memo,');
    expect(lines).toContain('2026-04-15,ACME,1,Report,');
  });

  it('excludes rows outside the date range', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const t = createTask(db, { project_id: 'acme', title: 'X' });
    insertTimeLog(db, t.id, '2026-04-12T09:00:00Z', 60);
    insertTimeLog(db, t.id, '2026-04-20T09:00:00Z', 60);

    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19');
    expect(csv.trim().split('\n').length).toBe(1); // header only
  });

  it('quotes notes containing commas', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const t = createTask(db, {
      project_id: 'acme',
      title: 'Plain title',
      notes: 'note with, comma',
    });
    insertTimeLog(db, t.id, '2026-04-14T09:00:00Z', 60);

    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19');
    expect(csv).toContain('"note with, comma"');
  });
});

describe('timesheet export with totals', () => {
  function setup() {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    createProject(db, { id: 'glbx', name: 'Globex', prefix: 'GLBX' });
    const t1 = createTask(db, { project_id: 'acme', title: 'Report' });
    const t2 = createTask(db, { project_id: 'acme', title: 'Memo' });
    const t3 = createTask(db, { project_id: 'glbx', title: 'Pitch deck' });
    insertTimeLog(db, t1.id, '2026-04-14T09:00:00Z', 90); // 1.5h ACME
    insertTimeLog(db, t2.id, '2026-04-14T11:00:00Z', 30); // 0.5h ACME
    insertTimeLog(db, t3.id, '2026-04-15T10:00:00Z', 120); // 2h GLBX
    return db;
  }

  it('appends per-project subtotals and a grand total when includeTotals is set', () => {
    const db = setup();
    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19', {
      includeTotals: true,
    });
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('date,project,hours,task,notes');
    expect(lines).toContain(',ACME subtotal,2,,');
    expect(lines).toContain(',GLBX subtotal,2,,');
    expect(lines).toContain(',TOTAL,4,,');
  });

  it('does not append totals by default (backwards compatible)', () => {
    const db = setup();
    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19');
    expect(csv).not.toContain('TOTAL');
    expect(csv).not.toContain('subtotal');
  });

  it('markdown format produces a GitHub-flavored table', () => {
    const db = setup();
    const md = exportTimesheet(db, '2026-04-13', '2026-04-19', {
      format: 'markdown',
    });
    const lines = md.trim().split('\n');
    expect(lines[0]).toBe('| date | project | hours | task | notes |');
    expect(lines[1]).toBe('| --- | --- | ---: | --- | --- |');
    expect(md).toContain('| 2026-04-14 | ACME | 1.5 | Report |  |');
    expect(md).toContain('| 2026-04-15 | GLBX | 2 | Pitch deck |  |');
  });

  it('markdown format always includes totals footer', () => {
    const db = setup();
    const md = exportTimesheet(db, '2026-04-13', '2026-04-19', {
      format: 'markdown',
    });
    expect(md).toContain('| **ACME subtotal** |  | **2** |');
    expect(md).toContain('| **GLBX subtotal** |  | **2** |');
    expect(md).toContain('| **TOTAL** |  | **4** |');
  });

  it('markdown format escapes pipes in titles/notes', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const t = createTask(db, {
      project_id: 'acme',
      title: 'a | b',
      notes: 'foo | bar',
    });
    insertTimeLog(db, t.id, '2026-04-14T09:00:00Z', 60);
    const md = exportTimesheet(db, '2026-04-13', '2026-04-19', {
      format: 'markdown',
    });
    expect(md).toContain('a \\| b');
    expect(md).toContain('foo \\| bar');
  });

  it('markdown on empty range returns header + divider only', () => {
    const db = freshDb();
    const md = exportTimesheet(db, '2026-04-13', '2026-04-19', {
      format: 'markdown',
    });
    const lines = md.trim().split('\n');
    expect(lines[0]).toBe('| date | project | hours | task | notes |');
    expect(lines[1]).toBe('| --- | --- | ---: | --- | --- |');
    expect(lines).toContain('| **TOTAL** |  | **0** |  |  |');
  });
});

describe('getTimesheetSummary', () => {
  function setup() {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    createProject(db, { id: 'glbx', name: 'Globex', prefix: 'GLBX' });
    const t1 = createTask(db, { project_id: 'acme', title: 'Report' });
    const t2 = createTask(db, { project_id: 'acme', title: 'Memo' });
    const t3 = createTask(db, { project_id: 'glbx', title: 'Pitch deck' });
    insertTimeLog(db, t1.id, '2026-04-14T09:00:00Z', 90); // 1.5h
    insertTimeLog(db, t2.id, '2026-04-14T11:00:00Z', 30); // 0.5h
    insertTimeLog(db, t3.id, '2026-04-15T10:00:00Z', 120); // 2h
    return db;
  }

  it('returns structured rows and totals', () => {
    const db = setup();
    const summary = getTimesheetSummary(db, '2026-04-13', '2026-04-19');
    expect(summary.rows).toHaveLength(3);
    expect(summary.grand_total_hours).toBe(4);
    expect(summary.by_project).toEqual([
      { project: 'ACME', total_hours: 2 },
      { project: 'GLBX', total_hours: 2 },
    ]);
  });

  it('row.hours is a number, not a string', () => {
    const db = setup();
    const summary = getTimesheetSummary(db, '2026-04-13', '2026-04-19');
    for (const r of summary.rows) {
      expect(typeof r.hours).toBe('number');
    }
  });

  it('empty range returns empty rows and zero totals', () => {
    const db = freshDb();
    const summary = getTimesheetSummary(db, '2026-04-13', '2026-04-19');
    expect(summary.rows).toEqual([]);
    expect(summary.by_project).toEqual([]);
    expect(summary.grand_total_hours).toBe(0);
  });

  it('by_project is sorted alphabetically by prefix', () => {
    const db = freshDb();
    createProject(db, { id: 'z', name: 'Z', prefix: 'ZETA' });
    createProject(db, { id: 'a', name: 'A', prefix: 'ALPHA' });
    const tz = createTask(db, { project_id: 'z', title: 'x' });
    const ta = createTask(db, { project_id: 'a', title: 'y' });
    insertTimeLog(db, tz.id, '2026-04-14T09:00:00Z', 60);
    insertTimeLog(db, ta.id, '2026-04-14T09:00:00Z', 60);
    const summary = getTimesheetSummary(db, '2026-04-13', '2026-04-19');
    expect(summary.by_project.map((p) => p.project)).toEqual([
      'ALPHA',
      'ZETA',
    ]);
  });
});
