import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { insertTimeEntry, confirmTimeEntry, skipTimeEntry, listPendingReview, moveTimeEntry } from '../src/time-entry.js';

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

describe('listPendingReview', () => {
  function seed(db: any) {
    db.prepare(`INSERT INTO projects (id, name, prefix, category_id) VALUES ('WORK', 'Work', 'WORK', 'work')`).run();
    db.prepare(`INSERT INTO projects (id, name, prefix, category_id) VALUES ('PERS', 'Pers', 'PERS', 'personal')`).run();
  }

  it('returns UNCONFIRMED entries with start_at in the past, work category by default', () => {
    const db = freshDb();
    seed(db);
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2020-01-01T09:00:00Z', end_at: '2020-01-01T10:00:00Z', status: 'UNCONFIRMED', source: 'placement' });
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2099-01-01T09:00:00Z', end_at: '2099-01-01T10:00:00Z', status: 'UNCONFIRMED', source: 'placement' });
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2020-01-01T11:00:00Z', end_at: '2020-01-01T12:00:00Z', actual_minutes: 60, status: 'CONFIRMED', confirmed_at: '2020-01-01T12:00:00Z', source: 'manual' });
    insertTimeEntry(db, { project_id: 'PERS', start_at: '2020-01-01T13:00:00Z', end_at: '2020-01-01T14:00:00Z', status: 'UNCONFIRMED', source: 'placement' });

    const rows = listPendingReview(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe('WORK');
    expect(rows[0].start_at).toBe('2020-01-01T09:00:00Z');
  });

  it('respects explicit category filter', () => {
    const db = freshDb();
    seed(db);
    insertTimeEntry(db, { project_id: 'PERS', start_at: '2020-01-01T13:00:00Z', end_at: '2020-01-01T14:00:00Z', status: 'UNCONFIRMED', source: 'placement' });

    const rows = listPendingReview(db, { category: 'personal' });
    expect(rows).toHaveLength(1);
    expect(rows[0].project_id).toBe('PERS');
  });

  it('orders results by start_at ascending', () => {
    const db = freshDb();
    seed(db);
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2020-01-03T09:00:00Z', end_at: '2020-01-03T10:00:00Z', status: 'UNCONFIRMED', source: 'placement' });
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2020-01-01T09:00:00Z', end_at: '2020-01-01T10:00:00Z', status: 'UNCONFIRMED', source: 'placement' });
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2020-01-02T09:00:00Z', end_at: '2020-01-02T10:00:00Z', status: 'UNCONFIRMED', source: 'placement' });

    const rows = listPendingReview(db, {});
    expect(rows.map((r) => r.start_at)).toEqual([
      '2020-01-01T09:00:00Z',
      '2020-01-02T09:00:00Z',
      '2020-01-03T09:00:00Z',
    ]);
  });

  it('respects explicit from/to range', () => {
    const db = freshDb();
    seed(db);
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2020-01-01T09:00:00Z', end_at: '2020-01-01T10:00:00Z', status: 'UNCONFIRMED', source: 'placement' });
    insertTimeEntry(db, { project_id: 'WORK', start_at: '2020-01-05T09:00:00Z', end_at: '2020-01-05T10:00:00Z', status: 'UNCONFIRMED', source: 'placement' });

    const rows = listPendingReview(db, { from: '2020-01-02T00:00:00Z', to: '2020-01-10T00:00:00Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0].start_at).toBe('2020-01-05T09:00:00Z');
  });
});

describe('moveTimeEntry', () => {
  it('preserves duration by default', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, { project_id: 'TEST', start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T11:00:00Z', status: 'UNCONFIRMED', source: 'placement' });

    moveTimeEntry(db, id, '2026-05-13T14:00:00Z');
    const row = db.prepare(`SELECT start_at, end_at FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.start_at).toBe('2026-05-13T14:00:00Z');
    expect(row.end_at).toBe('2026-05-13T16:00:00Z');
  });

  it('accepts explicit new_end_at', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, { project_id: 'TEST', start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T11:00:00Z', status: 'UNCONFIRMED', source: 'placement' });

    moveTimeEntry(db, id, '2026-05-13T14:00:00Z', { new_end_at: '2026-05-13T14:30:00Z' });
    const row = db.prepare(`SELECT end_at FROM time_entry WHERE id = ?`).get(id) as any;
    expect(row.end_at).toBe('2026-05-13T14:30:00Z');
  });

  it('rejects move on CONFIRMED', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, { project_id: 'TEST', start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T10:00:00Z', actual_minutes: 60, status: 'CONFIRMED', confirmed_at: '2026-05-13T10:00:00Z', source: 'manual' });
    expect(() => moveTimeEntry(db, id, '2026-05-13T14:00:00Z')).toThrow(/confirmed/i);
  });

  it('rejects source=gcal-sync', () => {
    const db = freshDb();
    const id = insertTimeEntry(db, { start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T10:00:00Z', status: 'UNCONFIRMED', source: 'gcal-sync', external_id: 'e1' });
    expect(() => moveTimeEntry(db, id, '2026-05-13T14:00:00Z')).toThrow(/gcal/i);
  });

  it('rejects source=manual', () => {
    const db = freshDb();
    const id = insertTimeEntry(db, { start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T10:00:00Z', status: 'UNCONFIRMED', source: 'manual' });
    expect(() => moveTimeEntry(db, id, '2026-05-13T14:00:00Z')).toThrow(/manual/i);
  });

  it('allows move on source=habit', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO projects (id, name, prefix) VALUES ('TEST', 'T', 'TEST')`).run();
    const id = insertTimeEntry(db, { project_id: 'TEST', start_at: '2026-05-13T09:00:00Z', end_at: '2026-05-13T09:30:00Z', status: 'UNCONFIRMED', source: 'habit' });
    expect(() => moveTimeEntry(db, id, '2026-05-13T10:00:00Z')).not.toThrow();
  });

  it('throws if id does not exist', () => {
    const db = freshDb();
    expect(() => moveTimeEntry(db, 9999, '2026-05-13T09:00:00Z')).toThrow();
  });
});
