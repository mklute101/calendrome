import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { insertTimeEntry, confirmTimeEntry, skipTimeEntry } from '../src/time-entry.js';

describe('insertTimeEntry', () => {
  it('inserts an UNCONFIRMED placement entry', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    db.prepare(`INSERT INTO tasks (id, project_id, title) VALUES (1, 'TEST', 't')`).run();

    const id = insertTimeEntry(db, {
      task_id: 1,
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });

    const row = db.prepare(`SELECT * FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.status).toBe('UNCONFIRMED');
    expect(row.source).toBe('placement');
    expect(row.confirmed_at).toBeNull();
    expect(row.actual_minutes).toBeNull();
  });

  it('inserts a CONFIRMED manual entry with actual_minutes and project-only (task_id null)', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();

    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      actual_minutes: 60,
      status: 'CONFIRMED',
      confirmed_at: '2026-05-13T10:00:00Z',
      source: 'manual',
      notes: 'retro log',
    });

    const row = db.prepare(`SELECT * FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.status).toBe('CONFIRMED');
    expect(row.actual_minutes).toBe(60);
    expect(row.confirmed_at).toBe('2026-05-13T10:00:00Z');
    expect(row.task_id).toBeNull();
    expect(row.notes).toBe('retro log');
  });

  it('inserts a gcal-sync entry with external_id, is_meeting=1, synced_at', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('A', 'A', 'A')`).run();

    const id = insertTimeEntry(db, {
      project_id: 'A',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T09:30:00Z',
      status: 'UNCONFIRMED',
      source: 'gcal-sync',
      external_id: 'gcal-evt-1',
      is_meeting: true,
      synced_at: '2026-05-13T08:00:00Z',
    });

    const row = db.prepare(`SELECT external_id, is_meeting, synced_at, source FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.external_id).toBe('gcal-evt-1');
    expect(row.is_meeting).toBe(1);
    expect(row.synced_at).toBe('2026-05-13T08:00:00Z');
    expect(row.source).toBe('gcal-sync');
  });
});

describe('confirmTimeEntry', () => {
  it('flips UNCONFIRMED to CONFIRMED and stamps confirmed_at', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });

    confirmTimeEntry(db, id, {});
    const row = db.prepare(`SELECT status, confirmed_at FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.status).toBe('CONFIRMED');
    expect(row.confirmed_at).not.toBeNull();
  });

  it('applies actual_minutes override', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });
    confirmTimeEntry(db, id, { actual_minutes: 45 });
    const row = db.prepare(`SELECT actual_minutes FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.actual_minutes).toBe(45);
  });

  it('reassigns project_id when supplied', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('A', 'A', 'A')`).run();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('B', 'B', 'B')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'A',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });
    confirmTimeEntry(db, id, { project_id: 'B' });
    const row = db.prepare(`SELECT project_id, status FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.project_id).toBe('B');
    expect(row.status).toBe('CONFIRMED');
  });

  it('is idempotent on already-CONFIRMED entries — does not mutate', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      actual_minutes: 60,
      status: 'CONFIRMED',
      confirmed_at: '2026-05-13T10:00:00Z',
      source: 'manual',
    });

    expect(() => confirmTimeEntry(db, id, { actual_minutes: 30 })).not.toThrow();
    const row = db.prepare(`SELECT actual_minutes, confirmed_at FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.actual_minutes).toBe(60); // unchanged
    expect(row.confirmed_at).toBe('2026-05-13T10:00:00Z'); // unchanged
  });

  it('throws if the time_entry id does not exist', () => {
    const db = freshDb();
    expect(() => confirmTimeEntry(db, 9999, {})).toThrow();
  });
});

describe('skipTimeEntry', () => {
  it('deletes the row', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'placement',
    });
    skipTimeEntry(db, id);
    const row = db.prepare(`SELECT id FROM time_entry WHERE id = ?`).get(id);
    expect(row).toBeUndefined();
  });

  it('rejects on CONFIRMED status', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, {
      project_id: 'TEST',
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      actual_minutes: 60,
      status: 'CONFIRMED',
      confirmed_at: '2026-05-13T10:00:00Z',
      source: 'manual',
    });
    expect(() => skipTimeEntry(db, id)).toThrow(/confirmed/i);
  });

  it('rejects source=gcal-sync', () => {
    const db = freshDb();
    const id = insertTimeEntry(db, {
      start_at: '2026-05-13T09:00:00Z',
      end_at: '2026-05-13T10:00:00Z',
      status: 'UNCONFIRMED',
      source: 'gcal-sync',
      external_id: 'gcal-evt-1',
    });
    expect(() => skipTimeEntry(db, id)).toThrow(/gcal/i);
  });

  it('throws if the time_entry id does not exist', () => {
    const db = freshDb();
    expect(() => skipTimeEntry(db, 9999)).toThrow();
  });
});
