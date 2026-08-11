import { describe, it, expect, afterEach } from 'vitest';
import { freshDb } from './helpers/db.js';
import { now, nowDate, nowMs } from '../src/clock.js';
import { CANONICAL_UTC } from '../src/day-range.js';
import { insertTimeEntry, confirmTimeEntry } from '../src/time-entry.js';
import { createProject } from '../src/projects.js';
import { createTask } from '../src/tasks.js';

afterEach(() => {
  delete process.env.CALENDROME_NOW;
});

describe('clock (#149)', () => {
  it('returns real time in canonical form when CALENDROME_NOW is unset', () => {
    const before = Date.now();
    const stamp = now();
    const after = Date.now();
    expect(stamp).toMatch(CANONICAL_UTC);
    const ms = Date.parse(stamp);
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(after + 1000);
  });

  it('freezes at a fixed ISO timestamp', () => {
    process.env.CALENDROME_NOW = '2026-07-31T17:00:00Z';
    expect(now()).toBe('2026-07-31T17:00:00Z');
    expect(nowDate().toISOString()).toBe('2026-07-31T17:00:00.000Z');
    expect(nowMs()).toBe(Date.parse('2026-07-31T17:00:00Z'));
  });

  it('normalizes an offset-stamped fixed timestamp to canonical UTC', () => {
    process.env.CALENDROME_NOW = '2026-07-31T12:00:00-05:00';
    expect(now()).toBe('2026-07-31T17:00:00Z');
  });

  it('applies relative offsets and keeps ticking', () => {
    process.env.CALENDROME_NOW = '-3d';
    const expected = Date.now() - 3 * 86_400_000;
    expect(Math.abs(nowMs() - expected)).toBeLessThan(1000);

    process.env.CALENDROME_NOW = '+2h';
    const expectedFwd = Date.now() + 2 * 3_600_000;
    expect(Math.abs(nowMs() - expectedFwd)).toBeLessThan(1000);

    process.env.CALENDROME_NOW = '-90m';
    const expectedMin = Date.now() - 90 * 60_000;
    expect(Math.abs(nowMs() - expectedMin)).toBeLessThan(1000);
  });

  it('throws on garbage', () => {
    process.env.CALENDROME_NOW = 'yesterday-ish';
    expect(() => now()).toThrow(/CALENDROME_NOW/);
  });
});

describe('clock-driven bookkeeping stamps (#149)', () => {
  it('confirm_placement stamps confirmed_at/updated_at from the injected clock', () => {
    process.env.CALENDROME_NOW = '2026-07-15T09:30:00Z';
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-07-15T08:00:00Z',
      end_at: '2026-07-15T09:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });

    confirmTimeEntry(db, id, {});
    const row = db
      .prepare('SELECT created_at, updated_at, confirmed_at FROM time_entry WHERE id = ?')
      .get(id) as { created_at: string; updated_at: string; confirmed_at: string };
    expect(row.created_at).toBe('2026-07-15T09:30:00Z');
    expect(row.updated_at).toBe('2026-07-15T09:30:00Z');
    expect(row.confirmed_at).toBe('2026-07-15T09:30:00Z');
  });

  it('create paths stamp created_at from the injected clock, in canonical form', () => {
    process.env.CALENDROME_NOW = '2026-07-13T10:00:00Z';
    const db = freshDb();
    const project = createProject(db, { id: 'ACME', name: 'Acme', prefix: 'ACME' });
    const task = createTask(db, { project_id: 'ACME', title: 'demo' });
    expect(project.created_at).toBe('2026-07-13T10:00:00Z');
    expect(task.created_at).toBe('2026-07-13T10:00:00Z');
    expect(task.updated_at).toBe('2026-07-13T10:00:00Z');
  });
});

describe('migrate() normalizes legacy bookkeeping stamps (#149)', () => {
  it('collapses datetime(now) space-form stamps to canonical UTC', async () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    db.prepare(
      `INSERT INTO tasks (project_id, title, created_at, updated_at)
       VALUES ('TEST', 'legacy', '2026-05-01 09:15:00', '2026-05-02 10:30:00')`,
    ).run();

    const { migrate } = await import('../src/db/migrate.js');
    migrate(db);

    const row = db
      .prepare(`SELECT created_at, updated_at FROM tasks WHERE title = 'legacy'`)
      .get() as { created_at: string; updated_at: string };
    expect(row.created_at).toBe('2026-05-01T09:15:00Z');
    expect(row.updated_at).toBe('2026-05-02T10:30:00Z');
  });
});
