#!/usr/bin/env node
// Build demo/calendrome-demo.db by *playing* three simulated weeks of
// calendrome usage through the real MCP tool path (callTool ->
// buildTools handlers -> core functions), one planning session and one
// daily wrap at a time, with the clock simulated via CALENDROME_NOW.
// No hand-inserted SQL: every row comes out of a real write path.
//
// The persona (all fictional): Avery Quinn, a senior brand strategist
// at a big-city agency, Halcyon & Hart. Work is tight-capped and keeps
// overrunning. Personal life is built around weekends in Maple Hollow,
// a small town two hours upstate: a farmers-market habit, a by-date
// "pumpkin patch season" goal with a 3h minimum chunk (the drive is
// half the trip), and a weekly pie-baking refill goal. Yes, it is the
// one where the city professional rediscovers small-town life. The
// pitch is due the Friday before the Harvest Festival.
//
//   Week of Sep 28 — first week on the plan; the Aurelia Luxe client
//                    escalates midweek and the rebrand ends 4h over.
//   Week of Oct 5  — assigned 22h up front, a 1h pull from the pitch,
//                    a Saturday fire drill that eats the market.
//   Week of Oct 12 — pitch week (current): 4h pulled from the rebrand
//                    to the pitch, agency ops snoozed, pitch overruns.
//                    "Today" is Friday Oct 16, 08:45 New York time: the
//                    morning brief has run, Friday's work and the
//                    weekend's Maple Hollow blocks sit UNCONFIRMED.
//
// Usage (needs a build: the script drives dist/):
//   npm run build
//   CALENDROME_DB=./demo/calendrome-demo.db node demo/play-demo.mjs --overwrite
//
// Refuses to touch a DB that looks like the real calendrome.db, and
// refuses an existing file unless --overwrite is passed (the demo is
// rebuilt from empty, never layered onto other data).

import { existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const dist = (rel) => pathToFileURL(join(REPO_ROOT, 'dist', 'src', rel)).href;

const dbPathArg = process.env.CALENDROME_DB;
if (!dbPathArg) {
  console.error('CALENDROME_DB env var is required.');
  process.exit(1);
}
const dbPath = resolve(dbPathArg);
if (dbPath.endsWith('/calendrome.db')) {
  console.error(
    `Refusing to build into ${dbPathArg}: looks like the real calendrome DB.\n` +
      'Point CALENDROME_DB at a demo file (e.g. ./demo/calendrome-demo.db).',
  );
  process.exit(1);
}
if (existsSync(dbPath)) {
  if (!process.argv.includes('--overwrite')) {
    console.error(`${dbPathArg} exists; pass --overwrite to rebuild it from empty.`);
    process.exit(1);
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
}
if (!existsSync(join(REPO_ROOT, 'dist', 'src', 'mcp', 'call-tool.js'))) {
  console.error('dist/ not found: run `npm run build` first.');
  process.exit(1);
}

const { openDatabase } = await import(dist('db/connection.js'));
const { migrate } = await import(dist('db/migrate.js'));
const { callTool } = await import(dist('mcp/call-tool.js'));
const { LocalCalendarClient } = await import(dist('calendar/index.js'));

// Boot exactly like the MCP server: migrate once, then one fresh
// connection per tool call.
{
  const db = openDatabase(dbPath);
  migrate(db);
  db.close();
}
const calendar = new LocalCalendarClient();

// ---------------------------------------------------------------------
// Clock + call helpers
// ---------------------------------------------------------------------

const TZ = 'America/New_York';
// Every simulated day sits inside EDT (UTC-4): DST ends 2026-11-01.
const EDT = '-04:00';
/** Local New York wall time -> canonical UTC ISO. */
const ny = (day, hhmm) =>
  new Date(`${day}T${hhmm}:00${EDT}`).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Move the simulated clock (what every server clock read sees). */
function clock(day, hhmm) {
  process.env.CALENDROME_NOW = ny(day, hhmm);
}

const notes = [];
async function call(name, args = {}) {
  const res = await callTool(dbPath, calendar, name, args);
  const text = res.content?.[0]?.text ?? '';
  if (res.isError) {
    throw new Error(`${name}(${JSON.stringify(args)}) failed at ${process.env.CALENDROME_NOW}: ${text}`);
  }
  const out = JSON.parse(text);
  if (out && typeof out.note === 'string') notes.push(`${name}: ${out.note}`);
  return out;
}

const tasks = {}; // key -> { id, entry }
async function task(key, project_id, title, duration_minutes, priority = 'MEDIUM') {
  const { task: t } = await call('create_task', { project_id, title, duration_minutes, priority });
  tasks[key] = { id: t.id };
  return t.id;
}
async function place(key, day, hhmm) {
  const r = await call('place_task', { task_id: tasks[key].id, start: ny(day, hhmm) });
  tasks[key].entry = r.time_entry_id;
  return r.time_entry_id;
}
const confirm = (time_entry_id, actual_minutes) =>
  call('confirm_placement', actual_minutes ? { time_entry_id, actual_minutes } : { time_entry_id });
const confirmTask = (key, actual) => confirm(tasks[key].entry, actual);

/** Confirm every pending gcal-sync meeting that started on a local day. */
async function confirmMeetings(day) {
  const { rows } = await call('list_pending_review', { from: day, to: day });
  for (const e of rows ?? []) {
    if (e.source !== 'gcal-sync') continue;
    if (e.start_at >= ny(day, '00:00') && e.start_at < ny(day, '23:59')) {
      await confirm(e.id);
    }
  }
}

const habits = {}; // key -> habit id
const instances = {}; // `${key}:${day}` -> instance id (by local scheduled day)
async function generateWeek(monday, sunday) {
  for (const [key, id] of Object.entries(habits)) {
    const { instances: list } = await call('generate_habit_instances', {
      habit_id: id,
      from: monday,
      to: sunday,
    });
    for (const inst of list) {
      const localDay = new Date(Date.parse(inst.scheduled_start) - 4 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      instances[`${key}:${localDay}`] = { id: inst.id, entry: inst.time_entry_id };
    }
  }
}
const completeHabit = (key, day) => call('complete_habit_instance', { id: instances[`${key}:${day}`].id });
const skipHabit = (key, day) => call('skip_habit_instance', { id: instances[`${key}:${day}`].id });
/** Slide an N-per-week candidate to the day it actually happens on. */
const moveHabit = (key, fromDay, toDay, hhmm) =>
  call('move_placement', {
    time_entry_id: instances[`${key}:${fromDay}`].entry,
    new_start_at: ny(toDay, hhmm),
  });

const goals = {};
async function goalBlock(key, day, hhmm, duration_minutes, blockNotes) {
  const { entry } = await call('place_goal_block', {
    goal_id: goals[key],
    start: ny(day, hhmm),
    duration_minutes,
    ...(blockNotes ? { notes: blockNotes } : {}),
  });
  return entry.id;
}

async function syncWeek(monday, nextMonday, events) {
  return call('sync_calendar_events', {
    events: events.map(([id, summary, day, from, to]) => ({
      id,
      calendar_id: 'work',
      summary,
      start: ny(day, from),
      end: ny(day, to),
      is_meeting: true,
    })),
    window: { from: ny(monday, '00:00'), to: ny(nextMonday, '00:00') },
  });
}

const pacing = [];
async function recordPacing(week) {
  const { goals: list } = await call('list_goals', { week_start: week });
  for (const g of list) {
    const p = g.progress;
    pacing.push(
      `${week}  ${g.title.padEnd(26)} ask ${String(p.weekly_ask).padStart(3)}m` +
        (p.weeks_left != null ? `  weeks_left ${p.weeks_left}  remaining ${p.remaining_minutes}m` : '') +
        `  min_chunk ${g.min_chunk_minutes ?? '-'}  ${p.status}`,
    );
  }
}

// ---------------------------------------------------------------------
// Onboarding — Sunday Sep 27, evening
// ---------------------------------------------------------------------

clock('2026-09-27', '19:00');
await call('update_category', {
  id: 'work',
  timezone: TZ,
  default_window: { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
});
await call('update_category', {
  id: 'personal',
  timezone: TZ,
  // Weekends are for Maple Hollow. Weeknight personal time still
  // happens; it just lands outside the window and self-supplies.
  default_window: { days: [0, 6], start: '08:00', end: '20:00' },
});

await call('create_project', { id: 'luxe', name: 'Aurelia Luxe rebrand', prefix: 'LUXE', color: '#c2410c', category_id: 'work', weekly_budget_minutes: 1200 });
await call('create_project', { id: 'pitch', name: 'Holiday campaign pitch', prefix: 'PITCH', color: '#b91c1c', category_id: 'work', weekly_budget_minutes: 480 });
await call('create_project', { id: 'ops', name: 'Agency ops', prefix: 'OPS', color: '#475569', category_id: 'work', weekly_budget_minutes: 180 });
await call('create_project', { id: 'hollow', name: 'Maple Hollow', prefix: 'HOLLOW', color: '#d97706', category_id: 'personal' });
await call('create_project', { id: 'wellness', name: 'Wellness', prefix: 'WELL', color: '#15803d', category_id: 'personal' });

await call('add_meeting_project_mapping', { pattern: 'Aurelia', match: 'contains', project_id: 'luxe' });
await call('add_meeting_project_mapping', { pattern: 'Holiday pitch', match: 'contains', project_id: 'pitch' });
await call('add_meeting_project_mapping', { pattern: 'Halcyon', match: 'contains', project_id: 'ops' });

goals.pumpkin = (
  await call('create_goal', {
    project_id: 'hollow',
    title: 'Pumpkin patch season',
    notes: 'Twelve hours of small-town Saturdays before Halloween. The drive is half the trip, so no slivers.',
    target_minutes: 720,
    due: '2026-11-02',
    min_chunk_minutes: 180,
  })
).goal.id;
goals.pie = (
  await call('create_goal', {
    project_id: 'hollow',
    title: 'Learn the Hollow Inn pie',
    notes: "The inn's handwritten recipe card, one evening at a time.",
    target_minutes: 90,
    refill_period: 'week',
    min_chunk_minutes: 45,
  })
).goal.id;

habits.market = (await call('create_habit', { project_id: 'hollow', title: 'Saturday farmers market', duration_minutes: 90, days_of_week: '6', start_time: '09:00', timezone: TZ })).habit.id;
habits.dot = (await call('create_habit', { project_id: 'hollow', title: 'Call Aunt Dot', duration_minutes: 30, times_per_week: 2, start_time: '19:30', timezone: TZ })).habit.id;
habits.run = (await call('create_habit', { project_id: 'wellness', title: 'Morning run', duration_minutes: 30, times_per_week: 3, start_time: '06:30', timezone: TZ })).habit.id;

// ---------------------------------------------------------------------
// Week 1 — Sep 28 to Oct 4
// ---------------------------------------------------------------------

clock('2026-09-28', '08:30'); // Monday planning session
await syncWeek('2026-09-28', '2026-10-05', [
  ['w1-standup-mon', 'Halcyon standup', '2026-09-28', '09:30', '09:45'],
  ['w1-standup-wed', 'Halcyon standup', '2026-09-30', '09:30', '09:45'],
  ['w1-standup-fri', 'Halcyon standup', '2026-10-02', '09:30', '09:45'],
  ['w1-luxe-sync', 'Aurelia Luxe weekly sync', '2026-09-29', '11:00', '12:00'],
  ['w1-luxe-workshop', 'Aurelia Luxe brand workshop', '2026-10-01', '13:00', '16:00'],
  ['w1-pitch-kickoff', 'Holiday pitch kickoff', '2026-09-30', '15:00', '16:00'],
]);
await task('audit', 'luxe', 'LUXE: brand audit', 240, 'HIGH');
await task('interviews', 'luxe', 'LUXE: stakeholder interview synthesis', 180, 'HIGH');
await task('naming', 'luxe', 'LUXE: naming territories', 120);
await task('wsprep', 'luxe', 'LUXE: workshop prep', 180, 'HIGH');
await task('mood1', 'luxe', 'LUXE: moodboards round 1', 240);
await task('insight', 'pitch', 'PITCH: audience insight research', 180);
await task('scan', 'pitch', 'PITCH: competitive scan', 120);
await task('ts1', 'ops', 'OPS: timesheets', 30, 'LOW');
await place('audit', '2026-09-28', '10:00');
await place('interviews', '2026-09-29', '13:00');
await place('naming', '2026-09-29', '16:00');
await place('wsprep', '2026-09-30', '10:00');
await place('insight', '2026-10-01', '09:00');
await place('mood1', '2026-10-02', '10:00');
await place('scan', '2026-10-02', '14:30');
await place('ts1', '2026-10-02', '17:00');
await generateWeek('2026-09-28', '2026-10-04');
await recordPacing('2026-09-28');
// Pumpkin goal asks 144m this week, but a trip is never less than its
// 3h minimum chunk: the planner places the chunk, not the ask.
const w1Patch = await goalBlock('pumpkin', '2026-10-03', '11:00', 180, 'Pumpkin patch: Hollow Hill Farm');
const w1Pie = await goalBlock('pie', '2026-09-30', '20:00', 90, 'Pie: crust attempt #1');

clock('2026-09-28', '18:15'); // Monday wrap
await confirmTask('audit', 270); // ran 30m over
await confirmMeetings('2026-09-28');
await completeHabit('run', '2026-09-28');

clock('2026-09-29', '18:20'); // Tuesday wrap
await confirmTask('interviews');
await confirmTask('naming', 150);
await confirmMeetings('2026-09-29');
await skipHabit('run', '2026-09-29'); // rain

clock('2026-09-30', '22:30'); // Wednesday wrap, late
await confirmTask('wsprep');
await confirmMeetings('2026-09-30');
// Client escalation: workshop deck v2 overnight. Logged after the fact.
await call('log_time', {
  project_id: 'luxe',
  started_at: ny('2026-09-30', '19:00'),
  stopped_at: ny('2026-09-30', '21:30'),
  notes: 'Aurelia asked for workshop deck v2 by morning',
});
// The city ate the pie evening: slide it to Thursday.
await call('move_placement', { time_entry_id: w1Pie, new_start_at: ny('2026-10-01', '20:30') });
await completeHabit('run', '2026-09-30');

clock('2026-10-01', '21:45'); // Thursday wrap
await confirmTask('insight');
await confirmMeetings('2026-10-01'); // workshop
await confirm(w1Pie, 60); // only an hour: the dough needed to rest overnight
await completeHabit('dot', '2026-09-29');

clock('2026-10-02', '18:10'); // Friday wrap
await confirmTask('mood1');
await confirmTask('scan');
await confirmTask('ts1');
await confirmMeetings('2026-10-02');

clock('2026-10-03', '19:00'); // Saturday in Maple Hollow
await completeHabit('market', '2026-10-03');
await confirm(w1Patch, 240); // stayed for cider donuts
await moveHabit('dot', '2026-09-28', '2026-10-03', '17:00');
await completeHabit('dot', '2026-09-28');

// ---------------------------------------------------------------------
// Week 2 — Oct 5 to Oct 11
// ---------------------------------------------------------------------

clock('2026-10-05', '08:30'); // Monday planning session
// Last week Aurelia ran 4h over. Name it up front this time: 22h, and
// one more hour pulled from the pitch, which is ahead.
await call('assign_hours', { envelope_type: 'project', envelope_id: 'luxe', week_start: '2026-10-05', minutes: 1320, note: 'Round 2 week: known heavy' });
await call('pull_hours', { week_start: '2026-10-05', from: { type: 'project', id: 'pitch' }, to: { type: 'project', id: 'luxe' }, minutes: 60, note: 'Pitch research is ahead; Aurelia round 2 is not' });
await syncWeek('2026-10-05', '2026-10-12', [
  ['w2-standup-mon', 'Halcyon standup', '2026-10-05', '09:30', '09:45'],
  ['w2-standup-wed', 'Halcyon standup', '2026-10-07', '09:30', '09:45'],
  ['w2-standup-fri', 'Halcyon standup', '2026-10-09', '09:30', '09:45'],
  ['w2-luxe-sync', 'Aurelia Luxe weekly sync', '2026-10-06', '11:00', '12:00'],
  ['w2-pitch-checkin', 'Holiday pitch check-in', '2026-10-08', '10:00', '10:30'],
  ['w2-luxe-review', 'Aurelia Luxe round 2 review', '2026-10-09', '14:00', '15:30'],
]);
await task('mood2', 'luxe', 'LUXE: moodboards round 2', 240, 'HIGH');
await task('sketch', 'luxe', 'LUXE: identity sketches', 240, 'HIGH');
await task('guide', 'luxe', 'LUXE: brand guidelines draft', 300);
await task('deck2', 'luxe', 'LUXE: round 2 deck', 180, 'HIGH');
await task('concepts', 'pitch', 'PITCH: concept sketches', 180);
await task('story', 'pitch', 'PITCH: storyboard', 120);
await task('ts2', 'ops', 'OPS: timesheets', 30, 'LOW');
await place('mood2', '2026-10-05', '10:00');
await place('sketch', '2026-10-06', '13:00');
await place('guide', '2026-10-07', '10:00');
await place('concepts', '2026-10-07', '15:30'); // runs past 18:00, outside the work window
await place('story', '2026-10-08', '10:30');
await place('deck2', '2026-10-08', '13:00');
await place('ts2', '2026-10-09', '17:00');
await generateWeek('2026-10-05', '2026-10-11');
await recordPacing('2026-10-05');
const w2Patch = await goalBlock('pumpkin', '2026-10-10', '10:30', 180, 'Pumpkin patch: Kettle Creek Orchard');
const w2PieTue = await goalBlock('pie', '2026-10-06', '20:00', 45, 'Pie: lattice practice');
const w2PieThu = await goalBlock('pie', '2026-10-08', '20:00', 45, 'Pie: full bake');

clock('2026-10-05', '18:05');
await confirmTask('mood2');
await confirmMeetings('2026-10-05');
await completeHabit('run', '2026-10-05');

clock('2026-10-06', '22:15');
await confirmTask('sketch', 300); // ran an hour over
await confirmMeetings('2026-10-06');
await confirm(w2PieTue);
await completeHabit('dot', '2026-10-06');
await call('log_time', {
  project_id: 'luxe',
  started_at: ny('2026-10-06', '21:00'),
  stopped_at: ny('2026-10-06', '22:00'),
  notes: 'Late feedback round on sketches',
});
// The Tuesday run never happened and never got wrapped: it stays a
// PLANNED instance with an UNCONFIRMED entry (real usage has drift).

clock('2026-10-07', '19:00');
await confirmTask('guide', 360);
await confirmTask('concepts');
await confirmMeetings('2026-10-07');
await completeHabit('run', '2026-10-07');
// Agency dinner Thursday night: nothing gets scheduled there.
await call('block_time', { start: ny('2026-10-08', '18:00'), end: ny('2026-10-08', '22:00'), reason: 'Halcyon & Hart agency dinner' });

clock('2026-10-08', '17:45');
await confirmTask('story');
await confirmTask('deck2', 240);
await confirmMeetings('2026-10-08');
await call('skip_placement', { time_entry_id: w2PieThu });
// Pie still needs 45m this week: Sunday afternoon, back from the Hollow.
const w2PieSun = await goalBlock('pie', '2026-10-11', '15:00', 45, 'Pie: full bake (rescheduled)');

clock('2026-10-09', '18:00');
await confirmMeetings('2026-10-09');
await confirmTask('ts2');

clock('2026-10-10', '20:30'); // Saturday
// Aurelia fire drill before breakfast: the market loses.
await call('log_time', {
  project_id: 'luxe',
  started_at: ny('2026-10-10', '07:30'),
  stopped_at: ny('2026-10-10', '09:00'),
  notes: 'Saturday fire drill: logo lockup for the investor deck',
});
await skipHabit('market', '2026-10-10');
await confirm(w2Patch);
await call('log_time', {
  goal_id: goals.pumpkin,
  started_at: ny('2026-10-10', '13:30'),
  stopped_at: ny('2026-10-10', '14:30'),
  notes: 'Hayride and corn maze: stayed an extra hour',
});
await moveHabit('dot', '2026-10-05', '2026-10-10', '18:00');
await completeHabit('dot', '2026-10-05');

clock('2026-10-11', '17:00'); // Sunday
await confirm(w2PieSun);

// ---------------------------------------------------------------------
// Week 3 — Oct 12 to Oct 18 (current; "today" is Friday Oct 16)
// ---------------------------------------------------------------------

clock('2026-10-12', '08:30'); // Monday planning: pitch week
await call('pull_hours', { week_start: '2026-10-12', from: { type: 'project', id: 'luxe' }, to: { type: 'project', id: 'pitch' }, minutes: 240, note: 'Pitch week: Aurelia on maintenance' });
await call('assign_hours', { envelope_type: 'project', envelope_id: 'ops', week_start: '2026-10-12', minutes: null, note: 'Standups paused for pitch week' });
const week3Meetings = [
  ['w3-luxe-sync', 'Aurelia Luxe weekly sync', '2026-10-13', '11:00', '11:30'],
  ['w3-luxe-checkin', 'Aurelia Luxe check-in', '2026-10-15', '09:30', '10:00'],
  ['w3-pitch-rehearsal', 'Holiday pitch rehearsal', '2026-10-15', '14:00', '16:00'],
  ['w3-pitch-final', 'Holiday pitch presentation', '2026-10-16', '10:00', '11:30'],
];
await syncWeek('2026-10-12', '2026-10-19', week3Meetings);
await task('final', 'pitch', 'PITCH: final deck', 300, 'HIGH');
await task('booklet', 'pitch', 'PITCH: leave-behind booklet', 240);
await task('rehearse', 'pitch', 'PITCH: rehearsal notes', 120);
await task('feedback', 'luxe', 'LUXE: guidelines feedback pass', 180);
await task('handoff', 'luxe', 'LUXE: handoff notes', 90);
await task('ts3', 'ops', 'OPS: timesheets', 30, 'LOW');
await place('final', '2026-10-12', '10:00');
await place('booklet', '2026-10-13', '13:00');
await place('rehearse', '2026-10-14', '10:00');
await place('feedback', '2026-10-14', '13:00');
await place('handoff', '2026-10-16', '13:00');
await place('ts3', '2026-10-16', '14:30');
await generateWeek('2026-10-12', '2026-10-18');
await recordPacing('2026-10-12');
const w3PieTue = await goalBlock('pie', '2026-10-13', '20:00', 45, 'Pie: apple-cranberry');
// Harvest Festival weekend: two full-chunk trips.
await goalBlock('pumpkin', '2026-10-17', '10:00', 180, 'Maple Hollow Harvest Festival');
await goalBlock('pumpkin', '2026-10-18', '12:00', 180, 'Pumpkin carving at the inn');
// Leaving straight after the pitch: Friday afternoon is personal time.
await call('open_time', { start: ny('2026-10-16', '15:00'), end: ny('2026-10-16', '20:00'), category_id: 'personal', reason: 'Drive up to Maple Hollow after the pitch' });

clock('2026-10-12', '19:30');
await confirmTask('final', 360);
await completeHabit('run', '2026-10-12');

clock('2026-10-13', '21:30');
await confirmTask('booklet');
await confirmMeetings('2026-10-13');
await confirm(w3PieTue);
await completeHabit('dot', '2026-10-13');

clock('2026-10-14', '08:30'); // Wednesday morning re-sync
// The client cancelled Thursday's check-in upstream: the mirror-sync
// prunes the UNCONFIRMED row (and logs it in sync_log).
await syncWeek('2026-10-12', '2026-10-19', week3Meetings.filter(([id]) => id !== 'w3-luxe-checkin'));

clock('2026-10-14', '18:30');
await confirmTask('rehearse');
await confirmTask('feedback', 150);
await completeHabit('run', '2026-10-14');

clock('2026-10-15', '22:40');
await confirmMeetings('2026-10-15');
await call('log_time', {
  project_id: 'pitch',
  started_at: ny('2026-10-15', '19:00'),
  stopped_at: ny('2026-10-15', '22:00'),
  notes: 'Final deck rewrite after rehearsal',
});
// The second Aunt Dot call slides to Saturday in the Hollow.
await moveHabit('dot', '2026-10-12', '2026-10-17', '18:30');

clock('2026-10-16', '08:45'); // Friday: the morning brief has run.
await call('list_pending_review', {});
// City brain tries to squeeze in a 1h cider stop on the drive up; the
// pumpkin goal's 3h minimum chunk says so (placed anyway, a note).
await goalBlock('pumpkin', '2026-10-16', '17:30', 60, 'Cider stop on the drive up');
// Re-read every week's pacing now that all the hours are in: a past
// week keeps the ask it was planned with.
for (const week of ['2026-09-28', '2026-10-05', '2026-10-12']) await recordPacing(week);

// ---------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------

const db = openDatabase(dbPath);
const count = (sql) => db.prepare(sql).get().n;
console.log(`Built ${dbPathArg}`);
console.log(`  "now" inside the data: ${process.env.CALENDROME_NOW} (Fri 2026-10-16 08:45 ${TZ})`);
console.log(
  `  ${count('SELECT COUNT(*) n FROM projects')} projects, ${count('SELECT COUNT(*) n FROM tasks')} tasks, ` +
    `${count('SELECT COUNT(*) n FROM time_entry')} time entries ` +
    `(${count("SELECT COUNT(*) n FROM time_entry WHERE status = 'UNCONFIRMED'")} unconfirmed), ` +
    `${count('SELECT COUNT(*) n FROM assignments')} assignments, ${count('SELECT COUNT(*) n FROM envelope_moves')} moves`,
);
db.close();
console.log('\nGoal pacing (each week at its planning session, then all weeks re-read on Friday Oct 16):');
for (const line of pacing) console.log(`  ${line}`);
for (const week of ['2026-09-28', '2026-10-05', '2026-10-12']) {
  const { budgets } = await call('get_all_budgets', { week_start: week });
  console.log(`\nBudgets, week of ${week}:`);
  for (const b of budgets) {
    if (b.assigned_minutes === null) continue;
    const used = b.confirmed_minutes + b.scheduled_minutes;
    console.log(
      `  ${b.project_id.padEnd(8)} ${(used / 60).toFixed(1).padStart(5)}h of ${(b.assigned_minutes / 60).toFixed(1)}h` +
        (b.overspent ? '  OVERSPENT' : '') + (b.snoozed ? '  snoozed' : ''),
    );
  }
}
if (notes.length) {
  console.log('\nTool notes surfaced during play:');
  for (const n of notes) console.log(`  ${n}`);
}
