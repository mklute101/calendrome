import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import {
  createAvailabilityOverride,
  getAvailabilityOverride,
  listAvailabilityOverrides,
  deleteAvailabilityOverride,
  clearAvailabilityOverrides,
} from '../src/availability.js';

describe('availability overrides', () => {
  it('createAvailabilityOverride stores a block with reason', () => {
    const db = freshDb();
    const block = createAvailabilityOverride(db, {
      start: '2026-05-12T18:00:00Z',
      end: '2026-05-12T22:00:00Z',
      available: 0,
      reason: 'family dinner',
    });
    expect(block.id).toBeGreaterThan(0);
    expect(block.available).toBe(0);
    expect(block.reason).toBe('family dinner');
    expect(block.category_id).toBeNull();
  });

  it('rejects an end <= start', () => {
    const db = freshDb();
    expect(() =>
      createAvailabilityOverride(db, {
        start: '2026-05-12T18:00:00Z',
        end: '2026-05-12T18:00:00Z',
        available: 0,
      }),
    ).toThrow(/end must be after start/);
  });

  it('listAvailabilityOverrides returns rows that overlap [from, to]', () => {
    const db = freshDb();
    // Inside the range
    const inside = createAvailabilityOverride(db, {
      start: '2026-05-12T18:00:00Z',
      end: '2026-05-12T22:00:00Z',
      available: 0,
    });
    // Before the range
    createAvailabilityOverride(db, {
      start: '2026-05-01T18:00:00Z',
      end: '2026-05-01T22:00:00Z',
      available: 0,
    });
    // Straddles the start of the range
    const straddle = createAvailabilityOverride(db, {
      start: '2026-05-10T22:00:00Z',
      end: '2026-05-11T02:00:00Z',
      available: 0,
    });

    const found = listAvailabilityOverrides(db, {
      from: '2026-05-11T00:00:00Z',
      to: '2026-05-15T00:00:00Z',
    });
    const ids = found.map((r) => r.id).sort();
    expect(ids).toEqual([inside.id, straddle.id].sort());
  });

  it('listAvailabilityOverrides filters by category_id', () => {
    const db = freshDb();
    const work = createAvailabilityOverride(db, {
      start: '2026-05-12T10:00:00Z',
      end: '2026-05-12T11:00:00Z',
      available: 0,
      category_id: 'work',
    });
    const personal = createAvailabilityOverride(db, {
      start: '2026-05-12T18:00:00Z',
      end: '2026-05-12T22:00:00Z',
      available: 0,
      category_id: 'personal',
    });
    const all = createAvailabilityOverride(db, {
      start: '2026-05-12T23:00:00Z',
      end: '2026-05-13T01:00:00Z',
      available: 0,
      category_id: null,
    });

    const workRows = listAvailabilityOverrides(db, { category_id: 'work' });
    expect(workRows.map((r) => r.id)).toEqual([work.id]);

    const personalRows = listAvailabilityOverrides(db, {
      category_id: 'personal',
    });
    expect(personalRows.map((r) => r.id)).toEqual([personal.id]);

    const globalRows = listAvailabilityOverrides(db, { category_id: null });
    expect(globalRows.map((r) => r.id)).toEqual([all.id]);
  });

  it('deleteAvailabilityOverride removes a single row', () => {
    const db = freshDb();
    const o = createAvailabilityOverride(db, {
      start: '2026-05-12T18:00:00Z',
      end: '2026-05-12T22:00:00Z',
      available: 0,
    });
    deleteAvailabilityOverride(db, o.id);
    expect(getAvailabilityOverride(db, o.id)).toBeNull();
  });

  it('clearAvailabilityOverrides removes everything fully inside the range', () => {
    const db = freshDb();
    const inside = createAvailabilityOverride(db, {
      start: '2026-05-12T18:00:00Z',
      end: '2026-05-12T22:00:00Z',
      available: 0,
    });
    const straddle = createAvailabilityOverride(db, {
      start: '2026-05-12T22:00:00Z',
      end: '2026-05-13T02:00:00Z',
      available: 0,
    });
    const removed = clearAvailabilityOverrides(db, {
      start: '2026-05-12T00:00:00Z',
      end: '2026-05-13T00:00:00Z',
    });
    expect(removed).toBe(1);
    expect(getAvailabilityOverride(db, inside.id)).toBeNull();
    expect(getAvailabilityOverride(db, straddle.id)).not.toBeNull();
  });

  it('available=1 (open) carves time inside a normally-blocked window', () => {
    const db = freshDb();
    // "Saturday morning is fair game for personal work"
    const open = createAvailabilityOverride(db, {
      start: '2026-05-09T10:00:00Z',
      end: '2026-05-09T12:00:00Z',
      available: 1,
      category_id: 'personal',
      reason: 'free Saturday morning',
    });
    expect(open.available).toBe(1);
    expect(open.category_id).toBe('personal');
  });
});
