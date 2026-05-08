import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import {
  createCategory,
  getCategory,
  listCategories,
  updateCategory,
} from '../src/categories.js';

describe('categories', () => {
  it('seeds work and personal on a fresh db', () => {
    const db = freshDb();
    const cats = listCategories(db);
    const ids = cats.map((c) => c.id);
    expect(ids).toContain('work');
    expect(ids).toContain('personal');
  });

  it('seeded work category has a Mon-Fri 9-5 default window', () => {
    const db = freshDb();
    const work = getCategory(db, 'work');
    expect(work).not.toBeNull();
    expect(work!.default_window).toEqual({
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '17:00',
    });
  });

  it('seeded personal category has an evenings window', () => {
    const db = freshDb();
    const personal = getCategory(db, 'personal');
    expect(personal).not.toBeNull();
    expect(personal!.default_window).not.toBeNull();
    expect(personal!.default_window!.start).toBe('18:00');
  });

  it('createCategory inserts a new category with a parsed window', () => {
    const db = freshDb();
    const c = createCategory(db, {
      id: 'deepwork',
      name: 'Deep Work',
      display_order: 5,
      default_window: { days: [1, 2, 3, 4, 5], start: '06:00', end: '09:00' },
      timezone: 'America/Chicago',
    });
    expect(c.id).toBe('deepwork');
    expect(c.default_window).toEqual({
      days: [1, 2, 3, 4, 5],
      start: '06:00',
      end: '09:00',
    });
    expect(c.timezone).toBe('America/Chicago');
  });

  it('listCategories returns rows ordered by display_order', () => {
    const db = freshDb();
    createCategory(db, { id: 'zzz', name: 'Z', display_order: -1 });
    const cats = listCategories(db);
    expect(cats[0].id).toBe('zzz');
  });

  it('updateCategory can change just the default_window', () => {
    const db = freshDb();
    updateCategory(db, 'work', {
      default_window: { days: [1, 2, 3, 4, 5, 6], start: '08:00', end: '18:00' },
    });
    const work = getCategory(db, 'work')!;
    expect(work.default_window).toEqual({
      days: [1, 2, 3, 4, 5, 6],
      start: '08:00',
      end: '18:00',
    });
    expect(work.name).toBe('Work');
  });

  it('updateCategory with empty patch is a no-op', () => {
    const db = freshDb();
    const before = getCategory(db, 'work')!;
    const after = updateCategory(db, 'work', {});
    expect(after).toEqual(before);
  });

  it('getCategory returns null for missing id', () => {
    const db = freshDb();
    expect(getCategory(db, 'nope')).toBeNull();
  });
});
