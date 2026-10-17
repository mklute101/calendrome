import { describe, it, expect, afterEach } from 'vitest';
import { freshDb } from './helpers/db.js';
import { createProject } from '../src/projects.js';
import {
  createHabit,
  generateHabitInstances,
  completeHabitInstance,
  skipHabitInstance,
  habitWeekScore,
  placeHabitInstance,
  editHabit,
  unplaceHabitInstance,
  retireHabit,
  deleteHabit,
  listHabits,
  moveEntryRespectingHabit,
} from '../src/habits.js';
import { assignHours, pullHours } from '../src/assignments.js';
import { confirmTimeEntry } from '../src/time-entry.js';
import { buildTools } from '../src/mcp/tools/index.js';

// Wed 2026-07-15 12:00 UTC: Mon/Tue of the week are past, Thu-Sun future.
const NOW = '2026-07-15T12:00:00Z';

function setup() {
  process.env.CALENDROME_NOW = NOW;
  const db = freshDb();
  createProject(db, { id: 'me', name: 'Me', prefix: 'ME' });
  createProject(db, { id: 'fit', name: 'Fitness', prefix: 'FIT' });
  return db;
}

afterEach(() => {
  delete process.env.CALENDROME_NOW;
});

function count(db: ReturnType<typeof setup>, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}

describe('placeHabitInstance (#138)', () => {
  it('places up to the weekly target, then refuses naming the target', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Run', duration_minutes: 45,
      times_per_week: 3, start_time: '07:00', timezone: 'UTC',
    });
    // Week of 2026-07-20 materializes 3 candidates; skip two of them so
    // one instance remains.
    const gen = generateHabitInstances(db, h.id, '2026-07-20', '2026-07-26');
    skipHabitInstance(db, gen[1].id);
    skipHabitInstance(db, gen[2].id);

    const a = placeHabitInstance(db, h.id, '2026-07-24T18:00:00Z');
    expect(a.entry.start_at).toBe('2026-07-24T18:00:00Z');
    expect(a.entry.end_at).toBe('2026-07-24T18:45:00Z');
    expect(a.entry.source).toBe('habit');
    expect(a.entry.status).toBe('UNCONFIRMED');
    placeHabitInstance(db, h.id, '2026-07-25T18:00:00Z');
    expect(() => placeHabitInstance(db, h.id, '2026-07-26T18:00:00Z')).toThrow(
      /already meets its target of 3/,
    );
  });

  it('fixed-days: a skipped Monday can be made up on Tuesday', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Outreach', duration_minutes: 30,
      days_of_week: '1,3,5', start_time: '11:00', timezone: 'UTC',
    });
    // Unmaterialized week: placement generates it first, so it is at target.
    expect(() => placeHabitInstance(db, h.id, '2026-07-21T18:00:00Z')).toThrow(/target of 3/);
    const [mon] = generateHabitInstances(db, h.id, '2026-07-20', '2026-07-20');
    skipHabitInstance(db, mon.id);
    const { instance } = placeHabitInstance(db, h.id, '2026-07-21T18:00:00Z');
    completeHabitInstance(db, instance.id);
    expect(habitWeekScore(db, h.id, '2026-07-20')).toEqual({ done: 1, target: 3 });
  });

  it('a slot collision errors cleanly with no partial rows', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Run', duration_minutes: 45,
      times_per_week: 3, start_time: '07:00', timezone: 'UTC',
    });
    const gen = generateHabitInstances(db, h.id, '2026-07-20', '2026-07-26');
    skipHabitInstance(db, gen[2].id);
    const before = count(db, 'SELECT COUNT(*) AS n FROM time_entry');
    // gen[0] occupies Monday 07:00.
    expect(() => placeHabitInstance(db, h.id, gen[0].scheduled_start)).toThrow(
      /already has an instance at/,
    );
    expect(count(db, 'SELECT COUNT(*) AS n FROM time_entry')).toBe(before);
    expect(count(db, 'SELECT COUNT(*) AS n FROM habit_instances')).toBe(3);
  });

  it('refuses a retired habit', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Run', duration_minutes: 45,
      times_per_week: 3, start_time: '07:00', timezone: 'UTC',
    });
    retireHabit(db, h.id);
    expect(() => placeHabitInstance(db, h.id, '2026-07-24T18:00:00Z')).toThrow(/retired/);
  });
});

describe('moveEntryRespectingHabit (#129)', () => {
  it('routes habit entries through the week rule; other entries move freely', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Outreach', duration_minutes: 30,
      days_of_week: '1,3,5', start_time: '11:00', timezone: 'UTC',
    });
    const [mon] = generateHabitInstances(db, h.id, '2026-07-20', '2026-07-26');
    moveEntryRespectingHabit(db, mon.time_entry_id!, '2026-07-21T18:00:00Z');
    expect(() =>
      moveEntryRespectingHabit(db, mon.time_entry_id!, '2026-07-27T11:00:00Z'),
    ).toThrow(/leaving the week is a skip, not a move/);
  });
});

describe('editHabit (#131)', () => {
  it('moves future unconfirmed entries to the new time; confirmed today keeps its time', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Stretch', duration_minutes: 30,
      days_of_week: '0,1,2,3,4,5,6', start_time: '09:00', timezone: 'UTC',
    });
    const gen = generateHabitInstances(db, h.id, '2026-07-13', '2026-07-19');
    const wed = gen.find((i) => i.scheduled_start.startsWith('2026-07-15'))!;
    confirmTimeEntry(db, wed.time_entry_id!, {});
    // Thursday's instance was moved by the user: it keeps its chosen time.
    const thu = gen.find((i) => i.scheduled_start.startsWith('2026-07-16'))!;
    moveEntryRespectingHabit(db, thu.time_entry_id!, '2026-07-16T20:00:00Z');

    editHabit(db, h.id, { start_time: '18:00', duration_minutes: 45 });

    const entries = db
      .prepare(
        `SELECT hi.scheduled_start, te.start_at, te.end_at, te.status FROM habit_instances hi
           JOIN time_entry te ON te.id = hi.time_entry_id WHERE hi.habit_id = ?
          ORDER BY hi.scheduled_start`,
      )
      .all(h.id) as Array<{ scheduled_start: string; start_at: string; end_at: string; status: string }>;
    const byDay = Object.fromEntries(entries.map((e) => [e.scheduled_start.slice(0, 10), e]));
    expect(byDay['2026-07-13'].start_at).toBe('2026-07-13T09:00:00Z'); // past
    expect(byDay['2026-07-15'].start_at).toBe('2026-07-15T09:00:00Z'); // confirmed
    expect(byDay['2026-07-16'].start_at).toBe('2026-07-16T20:00:00Z'); // moved
    expect(byDay['2026-07-16'].end_at).toBe('2026-07-16T20:45:00Z');
    expect(byDay['2026-07-17'].start_at).toBe('2026-07-17T18:00:00Z');
    expect(byDay['2026-07-17'].end_at).toBe('2026-07-17T18:45:00Z');
    expect(byDay['2026-07-17'].scheduled_start).toBe('2026-07-17T18:00:00Z');

    // Regeneration after the edit makes no duplicates.
    generateHabitInstances(db, h.id, '2026-07-13', '2026-07-19');
    expect(count(db, 'SELECT COUNT(*) AS n FROM habit_instances WHERE habit_id = ?', h.id)).toBe(7);
  });

  it('switching fixed-days to 3x/week re-materializes the rest of the week', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Outreach', duration_minutes: 30,
      days_of_week: '1,2,3,4,5', start_time: '11:00', timezone: 'UTC',
    });
    generateHabitInstances(db, h.id, '2026-07-13', '2026-07-19');
    const after = editHabit(db, h.id, { times_per_week: 3 });
    expect(after.times_per_week).toBe(3);
    expect(after.days_of_week).toBe('');
    // Mon, Tue, Wed (past or started) stay; future Thu/Fri are removed
    // and the week is already at 3, so nothing is re-added.
    const rows = db
      .prepare('SELECT scheduled_start FROM habit_instances WHERE habit_id = ? ORDER BY 1')
      .all(h.id) as Array<{ scheduled_start: string }>;
    expect(rows.map((r) => r.scheduled_start.slice(0, 10))).toEqual([
      '2026-07-13', '2026-07-14', '2026-07-15',
    ]);
    expect(count(db, "SELECT COUNT(*) AS n FROM time_entry WHERE source = 'habit'")).toBe(3);
    expect(() => editHabit(db, h.id, { days_of_week: '1', times_per_week: 2 })).toThrow(
      /exactly one of/,
    );
  });

  it('carries title and project to future entries', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Run', duration_minutes: 30,
      days_of_week: '5', start_time: '07:00', timezone: 'UTC',
    });
    const [fri] = generateHabitInstances(db, h.id, '2026-07-13', '2026-07-19');
    editHabit(db, h.id, { title: 'Long run', project_id: 'fit' });
    const te = db.prepare('SELECT project_id, notes FROM time_entry WHERE id = ?').get(fri.time_entry_id) as {
      project_id: string; notes: string;
    };
    expect(te).toEqual({ project_id: 'fit', notes: 'Long run' });
    expect(() => editHabit(db, h.id, { project_id: 'nope' })).toThrow(/not found/);
  });
});

describe('retireHabit (#131)', () => {
  it('keeps history, removes future plannable instances and their entries', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Stretch', duration_minutes: 30,
      days_of_week: '1,2,4,5,6', start_time: '09:00', timezone: 'UTC',
    });
    const gen = generateHabitInstances(db, h.id, '2026-07-13', '2026-07-19');
    completeHabitInstance(db, gen[0].id); // Mon
    completeHabitInstance(db, gen[1].id); // Tue
    const r = retireHabit(db, h.id);
    expect(r.removed_instances).toBe(3);
    expect(count(db, 'SELECT COUNT(*) AS n FROM habit_instances WHERE habit_id = ?', h.id)).toBe(2);
    expect(count(db, "SELECT COUNT(*) AS n FROM time_entry WHERE source = 'habit'")).toBe(2);
    expect(listHabits(db, { active: true }).map((x) => x.id)).not.toContain(h.id);
    expect(() => generateHabitInstances(db, h.id, '2026-07-20', '2026-07-26')).toThrow(/retired/);
    expect(() => editHabit(db, h.id, { title: 'x' })).toThrow(/retired/);
  });

  it('assignment rows stay readable; new assign/pull to the retired habit errors', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Stretch', duration_minutes: 30,
      times_per_week: 2, start_time: '09:00', timezone: 'UTC',
    });
    assignHours(db, { envelope_type: 'habit', envelope_id: String(h.id), week_start: '2026-07-13', minutes: 60 });
    retireHabit(db, h.id);
    expect(count(db, "SELECT COUNT(*) AS n FROM assignments WHERE envelope_type = 'habit'")).toBe(1);
    expect(() =>
      assignHours(db, { envelope_type: 'habit', envelope_id: String(h.id), week_start: '2026-07-20', minutes: 60 }),
    ).toThrow(/retired/);
    expect(() =>
      pullHours(db, { week_start: '2026-07-20', to: { type: 'habit', id: String(h.id) }, minutes: 30 }),
    ).toThrow(/retired/);
  });
});

describe('deleteHabit (#131)', () => {
  it('removes every row a fresh duplicate owns, with FK integrity intact', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Dup', duration_minutes: 30,
      days_of_week: '1,3,5', start_time: '09:00', timezone: 'UTC',
    });
    const gen = generateHabitInstances(db, h.id, '2026-07-13', '2026-07-26');
    skipHabitInstance(db, gen[0].id);
    assignHours(db, { envelope_type: 'habit', envelope_id: String(h.id), week_start: '2026-07-13', minutes: 0 });
    const r = deleteHabit(db, h.id);
    expect(r.deleted_instances).toBe(6);
    expect(count(db, 'SELECT COUNT(*) AS n FROM habits')).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM habit_instances')).toBe(0);
    expect(count(db, "SELECT COUNT(*) AS n FROM time_entry WHERE source = 'habit'")).toBe(0);
    expect(count(db, 'SELECT COUNT(*) AS n FROM assignments')).toBe(0);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('refuses, writing nothing, when the habit has a COMPLETE instance or confirmed entry', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Real', duration_minutes: 30,
      days_of_week: '1,3,5', start_time: '09:00', timezone: 'UTC',
    });
    const gen = generateHabitInstances(db, h.id, '2026-07-13', '2026-07-19');
    completeHabitInstance(db, gen[0].id);
    expect(() => deleteHabit(db, h.id)).toThrow(/use retire_habit/);
    expect(count(db, 'SELECT COUNT(*) AS n FROM habit_instances')).toBe(3);

    const h2 = createHabit(db, {
      project_id: 'me', title: 'Logged', duration_minutes: 30,
      days_of_week: '1', start_time: '09:00', timezone: 'UTC',
    });
    const [i2] = generateHabitInstances(db, h2.id, '2026-07-13', '2026-07-19');
    confirmTimeEntry(db, i2.time_entry_id!, {});
    expect(() => deleteHabit(db, h2.id)).toThrow(/use retire_habit/);
    expect(count(db, 'SELECT COUNT(*) AS n FROM habits')).toBe(2);
  });
});

describe('habit lifecycle MCP tools', () => {
  function tool(db: ReturnType<typeof setup>, name: string) {
    const t = buildTools(db).find((x: any) => x.name === name);
    if (!t) throw new Error(`no tool ${name}`);
    return t;
  }

  it('place / move_placement / update / retire / delete through the MCP surface', async () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Outreach', duration_minutes: 30,
      days_of_week: '1,3,5', start_time: '11:00', timezone: 'UTC',
    });
    const [mon] = generateHabitInstances(db, h.id, '2026-07-20', '2026-07-26');

    // move_placement honours the week rule for habit entries.
    await tool(db, 'move_placement').handler({
      time_entry_id: mon.time_entry_id, new_start_at: '2026-07-21T18:00:00Z',
    });
    await expect(
      tool(db, 'move_placement').handler({
        time_entry_id: mon.time_entry_id, new_start_at: '2026-07-27T11:00:00Z',
      }),
    ).rejects.toThrow(/leaving the week is a skip, not a move/);

    skipHabitInstance(db, mon.id);
    const placed = await tool(db, 'place_habit_instance').handler({
      habit_id: h.id, start: '2026-07-25T10:00:00Z',
    });
    expect(placed.entry.start_at).toBe('2026-07-25T10:00:00Z');

    // Absent args arrive undefined and must not be written.
    const upd = await tool(db, 'update_habit').handler({ habit_id: h.id, title: 'Daily outreach' });
    expect(upd.habit.title).toBe('Daily outreach');
    expect(upd.habit.start_time).toBe('11:00');

    const retired = await tool(db, 'retire_habit').handler({ habit_id: h.id });
    expect(retired.habit.active).toBe(0);
    await expect(tool(db, 'delete_habit').handler({ habit_id: 999 })).rejects.toThrow(/not found/);
  });
});

describe('review regressions', () => {
  function entryOf(db: ReturnType<typeof setup>, instanceId: number) {
    return db
      .prepare(
        `SELECT hi.scheduled_start, hi.scheduled_end, te.start_at, te.end_at FROM habit_instances hi
           JOIN time_entry te ON te.id = hi.time_entry_id WHERE hi.id = ?`,
      )
      .get(instanceId) as { scheduled_start: string; scheduled_end: string; start_at: string; end_at: string };
  }

  it('a time edit never moves a generated session onto a placed one', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Outreach', duration_minutes: 30,
      days_of_week: '1,4,5', start_time: '11:00', timezone: 'UTC',
    });
    const gen = generateHabitInstances(db, h.id, '2026-07-20', '2026-07-26');
    skipHabitInstance(db, gen[0].id); // Mon
    // Placed Thursday 07:00, same day as the generated Thursday 11:00.
    const { instance: placed } = placeHabitInstance(db, h.id, '2026-07-23T07:00:00Z');
    expect(placed.origin).toBe('placed');

    // Generated Thu would move onto the placed 07:00 slot: it keeps
    // 11:00 instead, and the edit still succeeds for Fri.
    editHabit(db, h.id, { start_time: '07:00' });
    const thu = gen.find((i) => i.scheduled_start.startsWith('2026-07-23'))!;
    const fri = gen.find((i) => i.scheduled_start.startsWith('2026-07-24'))!;
    expect(entryOf(db, placed.id).start_at).toBe('2026-07-23T07:00:00Z');
    expect(entryOf(db, thu.id).start_at).toBe('2026-07-23T11:00:00Z');
    expect(entryOf(db, fri.id).start_at).toBe('2026-07-24T07:00:00Z');
  });

  it('a placed session keeps its time and survives a frequency change', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Outreach', duration_minutes: 30,
      days_of_week: '1,3,5', start_time: '11:00', timezone: 'UTC',
    });
    const gen = generateHabitInstances(db, h.id, '2026-07-20', '2026-07-26');
    skipHabitInstance(db, gen[0].id);
    const { instance: placed } = placeHabitInstance(db, h.id, '2026-07-22T07:00:00Z');
    editHabit(db, h.id, { start_time: '09:00' });
    expect(entryOf(db, placed.id).start_at).toBe('2026-07-22T07:00:00Z');
    editHabit(db, h.id, { days_of_week: '2,4' });
    expect(entryOf(db, placed.id).start_at).toBe('2026-07-22T07:00:00Z');
  });

  it('unplace deletes a placed instance and frees the slot; generated ones refuse', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Run', duration_minutes: 45,
      times_per_week: 1, start_time: '07:00', timezone: 'UTC',
    });
    const [gen] = generateHabitInstances(db, h.id, '2026-07-20', '2026-07-26');
    expect(() => unplaceHabitInstance(db, gen.id)).toThrow(/skip it instead/);
    skipHabitInstance(db, gen.id);
    const a = placeHabitInstance(db, h.id, '2026-07-25T10:00:00Z');
    unplaceHabitInstance(db, a.instance.id);
    expect(count(db, 'SELECT COUNT(*) AS n FROM time_entry WHERE id = ?', a.entry.id)).toBe(0);
    // Same slot again: no 409.
    placeHabitInstance(db, h.id, '2026-07-25T10:00:00Z');
  });

  it('a target-form habit can be placed into a week not yet filled', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Run', duration_minutes: 45,
      times_per_week: 3, start_time: '07:00', timezone: 'UTC',
    });
    placeHabitInstance(db, h.id, '2026-07-25T10:00:00Z'); // Saturday
    // Generation then fills only what is left: 2 more, not 3.
    generateHabitInstances(db, h.id, '2026-07-20', '2026-07-26');
    expect(count(db, 'SELECT COUNT(*) AS n FROM habit_instances WHERE habit_id = ?', h.id)).toBe(3);
  });

  it('edits never create or move a session into the past', () => {
    const db = setup(); // now = Wed 2026-07-15 12:00Z
    const h = createHabit(db, {
      project_id: 'me', title: 'Stretch', duration_minutes: 30,
      days_of_week: '2,4', start_time: '07:00', timezone: 'UTC',
    });
    generateHabitInstances(db, h.id, '2026-07-13', '2026-07-19');
    editHabit(db, h.id, { days_of_week: '1,3,5' });
    const starts = (db
      .prepare(
        `SELECT te.start_at FROM habit_instances hi JOIN time_entry te ON te.id = hi.time_entry_id
          WHERE hi.habit_id = ? AND hi.scheduled_start >= ?`,
      )
      .all(h.id, '2026-07-15T00:00:00Z') as Array<{ start_at: string }>).map((r) => r.start_at);
    // Wed 07:00 already passed: not created. Fri 07:00 is future.
    expect(starts).toEqual(['2026-07-17T07:00:00Z']);

    const h2 = createHabit(db, {
      project_id: 'me', title: 'Evening', duration_minutes: 30,
      days_of_week: '3', start_time: '18:00', timezone: 'UTC',
    });
    const [wed] = generateHabitInstances(db, h2.id, '2026-07-15', '2026-07-15');
    editHabit(db, h2.id, { start_time: '07:00' });
    expect(entryOf(db, wed.id).start_at).toBe('2026-07-15T18:00:00Z');
  });

  it('duration edits keep instance and entry in agreement; a custom end survives a title edit', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Stretch', duration_minutes: 30,
      days_of_week: '4,5', start_time: '09:00', timezone: 'UTC',
    });
    const [thu, fri] = generateHabitInstances(db, h.id, '2026-07-16', '2026-07-17');
    moveEntryRespectingHabit(db, thu.time_entry_id!, '2026-07-18T10:00:00Z');
    moveEntryRespectingHabit(db, fri.time_entry_id!, fri.scheduled_start, {
      newEnd: '2026-07-17T10:30:00Z',
    });
    editHabit(db, h.id, { title: 'Stretch more' });
    expect(entryOf(db, fri.id).end_at).toBe('2026-07-17T10:30:00Z');

    editHabit(db, h.id, { duration_minutes: 60 });
    const t = entryOf(db, thu.id);
    expect(t.end_at).toBe('2026-07-18T11:00:00Z');
    expect(t.scheduled_end).toBe('2026-07-16T10:00:00Z');
  });

  it('a retired habit can still release its minutes', () => {
    const db = setup();
    const h = createHabit(db, {
      project_id: 'me', title: 'Stretch', duration_minutes: 30,
      times_per_week: 2, start_time: '09:00', timezone: 'UTC',
    });
    const id = String(h.id);
    assignHours(db, { envelope_type: 'habit', envelope_id: id, week_start: '2026-07-13', minutes: 120 });
    retireHabit(db, h.id);
    pullHours(db, { week_start: '2026-07-13', from: { type: 'habit', id }, minutes: 60 });
    assignHours(db, { envelope_type: 'habit', envelope_id: id, week_start: '2026-07-13', minutes: null });
  });
});
