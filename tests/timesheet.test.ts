import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createTask } from '../src/tasks.js';
import { insertTimeEntry } from '../src/time-entry.js';
import {
  exportTimesheet,
  getTimesheetSummary,
} from '../src/timesheet.js';

function seedConfirmed(
  db: any,
  taskId: number | null,
  projectId: string | null,
  startedAt: string,
  durationMinutes: number,
  notes: string | null = null,
) {
  const start = new Date(startedAt);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  return insertTimeEntry(db, {
    task_id: taskId,
    project_id: projectId,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    actual_minutes: durationMinutes,
    status: 'CONFIRMED',
    confirmed_at: end.toISOString(),
    source: 'manual',
    notes,
  });
}

function seedUnconfirmed(
  db: any,
  taskId: number | null,
  projectId: string | null,
  startedAt: string,
  durationMinutes: number,
  notes: string | null = null,
) {
  const start = new Date(startedAt);
  const end = new Date(start.getTime() + durationMinutes * 60000);
  return insertTimeEntry(db, {
    task_id: taskId,
    project_id: projectId,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    actual_minutes: durationMinutes,
    status: 'UNCONFIRMED',
    source: 'placement',
    notes,
  });
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

    seedConfirmed(db, t1.id, 'acme', '2026-04-14T09:00:00Z', 75); // 1.25h
    seedConfirmed(db, t2.id, 'acme', '2026-04-14T11:00:00Z', 30); // 0.5h
    seedConfirmed(db, t1.id, 'acme', '2026-04-15T09:00:00Z', 60); // 1h

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
    seedConfirmed(db, t.id, 'acme', '2026-04-12T09:00:00Z', 60);
    seedConfirmed(db, t.id, 'acme', '2026-04-20T09:00:00Z', 60);

    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19');
    expect(csv.trim().split('\n').length).toBe(1); // header only
  });

  it('excludes UNCONFIRMED time_entry rows by default', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const t = createTask(db, { project_id: 'acme', title: 'Report' });

    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 60);
    seedUnconfirmed(db, t.id, 'acme', '2026-04-15T09:00:00Z', 60);

    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19');
    const lines = csv.trim().split('\n');
    expect(lines.length).toBe(2); // header + the one CONFIRMED row
    expect(lines).toContain('2026-04-14,ACME,1,Report,');
  });

  it('quotes notes containing commas', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const t = createTask(db, {
      project_id: 'acme',
      title: 'Plain title',
      notes: 'note with, comma',
    });
    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 60);

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
    seedConfirmed(db, t1.id, 'acme', '2026-04-14T09:00:00Z', 90); // 1.5h ACME
    seedConfirmed(db, t2.id, 'acme', '2026-04-14T11:00:00Z', 30); // 0.5h ACME
    seedConfirmed(db, t3.id, 'glbx', '2026-04-15T10:00:00Z', 120); // 2h GLBX
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
    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 60);
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

describe('timesheet category filter', () => {
  function setup() {
    const db = freshDb();
    createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      category_id: 'work',
    });
    createProject(db, {
      id: 'gym',
      name: 'Gym',
      prefix: 'GYM',
      category_id: 'personal',
    });
    const tw = createTask(db, { project_id: 'acme', title: 'Report' });
    const tp = createTask(db, { project_id: 'gym', title: 'Lift' });
    seedConfirmed(db, tw.id, 'acme', '2026-04-14T09:00:00Z', 60); // 1h work
    seedConfirmed(db, tp.id, 'gym', '2026-04-14T18:00:00Z', 60); // 1h personal
    return db;
  }

  it('defaults to work category only', () => {
    const db = setup();
    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19');
    expect(csv).toContain('ACME');
    expect(csv).not.toContain('GYM');
  });

  it('categories=["personal"] returns only personal-category rows', () => {
    const db = setup();
    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19', {
      categories: ['personal'],
    });
    expect(csv).not.toContain('ACME');
    expect(csv).toContain('GYM');
  });

  it('categories=["work", "personal"] returns both', () => {
    const db = setup();
    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19', {
      categories: ['work', 'personal'],
    });
    expect(csv).toContain('ACME');
    expect(csv).toContain('GYM');
  });

  it('excludes rows whose time_entry has no project_id', () => {
    const db = setup();
    // unattached entry — no project, no category → always excluded
    seedConfirmed(db, null, null, '2026-04-14T12:00:00Z', 30, 'orphan');
    const csv = exportTimesheet(db, '2026-04-13', '2026-04-19', {
      categories: ['work', 'personal'],
    });
    expect(csv).not.toContain('orphan');
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
    seedConfirmed(db, t1.id, 'acme', '2026-04-14T09:00:00Z', 90); // 1.5h
    seedConfirmed(db, t2.id, 'acme', '2026-04-14T11:00:00Z', 30); // 0.5h
    seedConfirmed(db, t3.id, 'glbx', '2026-04-15T10:00:00Z', 120); // 2h
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
    seedConfirmed(db, tz.id, 'z', '2026-04-14T09:00:00Z', 60);
    seedConfirmed(db, ta.id, 'a', '2026-04-14T09:00:00Z', 60);
    const summary = getTimesheetSummary(db, '2026-04-13', '2026-04-19');
    expect(summary.by_project.map((p) => p.project)).toEqual([
      'ALPHA',
      'ZETA',
    ]);
  });

  it('include_unconfirmed exposes a separate unconfirmed section', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    const t = createTask(db, { project_id: 'acme', title: 'Report' });
    seedConfirmed(db, t.id, 'acme', '2026-04-14T09:00:00Z', 60); // 1h confirmed
    seedUnconfirmed(db, t.id, 'acme', '2026-04-15T09:00:00Z', 90); // 1.5h unconfirmed

    const plain = getTimesheetSummary(db, '2026-04-13', '2026-04-19');
    expect(plain.unconfirmed).toBeUndefined();
    expect(plain.grand_total_hours).toBe(1);

    const with_u = getTimesheetSummary(db, '2026-04-13', '2026-04-19', {
      include_unconfirmed: true,
    });
    expect(with_u.grand_total_hours).toBe(1); // confirmed only
    expect(with_u.unconfirmed).toBeDefined();
    expect(with_u.unconfirmed!.grand_total_hours).toBe(1.5);
    expect(with_u.unconfirmed!.rows).toHaveLength(1);
    expect(with_u.unconfirmed!.rows[0].status).toBe('UNCONFIRMED');
  });
});
