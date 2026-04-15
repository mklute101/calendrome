import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createTask } from '../src/tasks.js';
import { exportTimesheet } from '../src/timesheet.js';

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
