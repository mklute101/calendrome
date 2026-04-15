import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import {
  createProject,
  getProject,
  updateProject,
  listProjects,
} from '../src/projects.js';

describe('projects', () => {
  it('createProject inserts and returns the row', () => {
    const db = freshDb();
    const p = createProject(db, {
      id: 'acme',
      name: 'Acme Corp',
      prefix: 'ACME',
      weekly_budget_minutes: 20 * 60,
    });
    expect(p.id).toBe('acme');
    expect(p.name).toBe('Acme Corp');
    expect(p.prefix).toBe('ACME');
    expect(p.weekly_budget_minutes).toBe(1200);
    expect(p.active).toBe(1);
    expect(p.created_at).toBeTruthy();
    expect(p.updated_at).toBeTruthy();
  });

  it('enforces unique prefix', () => {
    const db = freshDb();
    createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
    expect(() =>
      createProject(db, { id: 'acme2', name: 'Acme Corp 2', prefix: 'ACME' }),
    ).toThrow();
  });

  it('getProject returns null when missing', () => {
    const db = freshDb();
    expect(getProject(db, 'nope')).toBeNull();
  });

  it('updateProject updates only provided fields and bumps updated_at', async () => {
    const db = freshDb();
    const p = createProject(db, { id: 'hobby', name: 'Hobby', prefix: 'HOBBY' });
    // sqlite datetime resolution is 1s; sleep briefly to see updated_at change
    await new Promise((r) => setTimeout(r, 1100));
    const updated = updateProject(db, 'hobby', { weekly_budget_minutes: 300 });
    expect(updated.weekly_budget_minutes).toBe(300);
    expect(updated.name).toBe('Hobby');
    expect(updated.updated_at >= p.updated_at).toBe(true);
    expect(updated.updated_at).not.toBe(p.updated_at);
  });

  it('listProjects filters by active', () => {
    const db = freshDb();
    createProject(db, { id: 'a', name: 'A', prefix: 'A' });
    createProject(db, { id: 'b', name: 'B', prefix: 'B' });
    updateProject(db, 'b', { active: 0 } as any);

    const all = listProjects(db);
    expect(all.length).toBe(2);

    const active = listProjects(db, { active: true });
    expect(active.length).toBe(1);
    expect(active[0].id).toBe('a');

    const inactive = listProjects(db, { active: false });
    expect(inactive.length).toBe(1);
    expect(inactive[0].id).toBe('b');
  });
});
