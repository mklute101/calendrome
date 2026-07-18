import { describe, it, expect } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import { createGoal } from '../src/goals.js';
import { createHabit } from '../src/habits.js';
import { pullHours } from '../src/assignments.js';
import { buildEnvelopesPayload, buildMovesPayload } from '../src/gui/budget-data.js';

/**
 * Budget-view payload tests (#106 M2): `/api/envelopes` rows carry
 * the owning project_id (the grouping key the client needs), and
 * `/api/moves` echoes the week with the moves newest-first.
 */

const WEEK = '2026-07-13'; // Monday

function setup() {
  const db = freshDb();
  createProject(db, { id: 'acme', name: 'Acme Corp', prefix: 'ACME' });
  return db;
}

describe('buildEnvelopesPayload', () => {
  it('enriches goal and habit rows with their owning project_id', () => {
    const db = setup();
    const goal = createGoal(db, {
      project_id: 'acme',
      title: 'Prospecting',
      target_minutes: 600,
      due: '2026-09-11',
    });
    const habit = createHabit(db, {
      project_id: 'acme',
      title: 'Stretch',
      duration_minutes: 15,
      days_of_week: '1,2,3,4,5',
      start_time: '07:00',
    });

    const payload = buildEnvelopesPayload(db, WEEK);
    expect(payload.week).toBe(WEEK);
    const byKey = new Map(
      payload.envelopes.map((e) => [`${e.envelope_type}:${e.envelope_id}`, e]),
    );
    expect(byKey.get('project:acme')?.project_id).toBe('acme');
    expect(byKey.get(`goal:${goal.id}`)?.project_id).toBe('acme');
    expect(byKey.get(`habit:${habit.id}`)?.project_id).toBe('acme');
    // The core row shape passes through untouched.
    expect(byKey.get(`goal:${goal.id}`)?.funding).toBeDefined();
    expect(byKey.get(`goal:${goal.id}`)?.needed_minutes).toBeGreaterThan(0);
  });

  it('rejects a non-Monday week (core assertMonday)', () => {
    const db = setup();
    expect(() => buildEnvelopesPayload(db, '2026-07-14')).toThrow(/Monday/);
  });
});

describe('buildMovesPayload', () => {
  it('returns the week echo and moves newest-first', () => {
    const db = setup();
    createProject(db, { id: 'hobby', name: 'Hobby', prefix: 'HOBBY' });
    db.prepare('UPDATE projects SET weekly_budget_minutes = 300 WHERE id = ?').run(
      'hobby',
    );
    pullHours(db, {
      week_start: WEEK,
      from: { type: 'project', id: 'hobby' },
      to: { type: 'project', id: 'acme' },
      minutes: 60,
      note: 'first',
    });
    pullHours(db, {
      week_start: WEEK,
      from: { type: 'project', id: 'hobby' },
      to: { type: 'project', id: 'acme' },
      minutes: 30,
      note: 'second',
    });

    const payload = buildMovesPayload(db, WEEK);
    expect(payload.week).toBe(WEEK);
    expect(payload.moves.map((m) => m.note)).toEqual(['second', 'first']);
  });
});
