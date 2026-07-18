#!/usr/bin/env node
// Seed a calendrome sandbox DB with the commitments-prototype worked
// examples from the 2026-07-17 commitment-taxonomy design (#106):
//
//   - ACME retainer (project cap, 20h/week) + PERSONAL project
//   - Daily stretch  — Habit, fixed days (7×15min)
//   - Workout        — Habit, N-per-week target (4×45min)
//   - Spanish        — Goal, recurring refill (3h/week)
//   - Prospecting    — Goal, by-date (10h, ~4 weeks out, 2h min chunk)
//   - a few confirmed/unconfirmed time entries so get_envelopes has
//     activity to show
//
// Usage:
//   CALENDROME_DB=./sandbox.db node plugin/skills/sandbox/scripts/seed-commitments.mjs
//
// Idempotent: wipes its own seed content (project ids acme/personal and
// everything hanging off them), then re-inserts. Refuses to touch a DB
// that looks like the real calendrome.db.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

const dbPath = process.env.CALENDROME_DB;
if (!dbPath) {
  console.error('CALENDROME_DB env var is required.');
  process.exit(1);
}
if (resolve(dbPath).endsWith('/calendrome.db')) {
  console.error(
    `Refusing to seed ${dbPath} — looks like the real calendrome DB.\n` +
      `Point CALENDROME_DB at a sandbox file (e.g. ./sandbox.db).`,
  );
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// 1. Run schema (idempotent CREATE IF NOT EXISTS), then the guarded
//    column adds migrate() would do — an older sandbox DB skips the
//    CREATEs, so goal_id / times_per_week need explicit ALTERs.
const schema = readFileSync(join(REPO_ROOT, 'src/db/schema.sql'), 'utf8');
db.exec(schema);

function hasColumn(table, column) {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .some((c) => c.name === column);
}
if (!hasColumn('time_entry', 'goal_id')) {
  db.exec('ALTER TABLE time_entry ADD COLUMN goal_id INTEGER REFERENCES goals(id)');
}
if (!hasColumn('habits', 'times_per_week')) {
  db.exec('ALTER TABLE habits ADD COLUMN times_per_week INTEGER');
}

// 2. Ensure default categories exist (mirrors src/db/migrate.ts).
const haveCategories = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
if (haveCategories.n === 0) {
  const insertCat = db.prepare(
    `INSERT INTO categories (id, name, display_order, default_window, timezone)
     VALUES (?, ?, ?, ?, ?)`,
  );
  insertCat.run(
    'work',
    'Work',
    0,
    JSON.stringify({ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }),
    'UTC',
  );
  insertCat.run(
    'personal',
    'Personal',
    1,
    JSON.stringify({ days: [0, 1, 2, 3, 4, 5, 6], start: '18:00', end: '22:00' }),
    'UTC',
  );
}

// 3. Wipe prior seed content — only rows hanging off the seed projects.
const seedProjectIds = ['acme', 'personal'];
const ph = seedProjectIds.map(() => '?').join(',');
const goalIds = db
  .prepare(`SELECT id FROM goals WHERE project_id IN (${ph})`)
  .all(...seedProjectIds)
  .map((r) => String(r.id));
const habitIds = db
  .prepare(`SELECT id FROM habits WHERE project_id IN (${ph})`)
  .all(...seedProjectIds)
  .map((r) => String(r.id));
const wipeEnvelope = (type, ids) => {
  if (ids.length === 0) return;
  const idPh = ids.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM assignments WHERE envelope_type = ? AND envelope_id IN (${idPh})`,
  ).run(type, ...ids);
  db.prepare(
    `DELETE FROM envelope_moves
      WHERE (from_type = ? AND from_id IN (${idPh}))
         OR (to_type = ? AND to_id IN (${idPh}))`,
  ).run(type, ...ids, type, ...ids);
};
wipeEnvelope('project', seedProjectIds);
wipeEnvelope('goal', goalIds);
wipeEnvelope('habit', habitIds);
db.prepare(`DELETE FROM time_entry WHERE project_id IN (${ph})`).run(...seedProjectIds);
db.prepare(`DELETE FROM habit_instances WHERE habit_id IN (SELECT id FROM habits WHERE project_id IN (${ph}))`).run(...seedProjectIds);
db.prepare(`DELETE FROM habits WHERE project_id IN (${ph})`).run(...seedProjectIds);
db.prepare(`DELETE FROM goals WHERE project_id IN (${ph})`).run(...seedProjectIds);
db.prepare(`DELETE FROM tasks WHERE project_id IN (${ph})`).run(...seedProjectIds);
db.prepare(`DELETE FROM projects WHERE id IN (${ph})`).run(...seedProjectIds);

// 4. Projects.
const insertProject = db.prepare(
  `INSERT INTO projects (id, name, prefix, weekly_budget_minutes, color, category_id)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
insertProject.run('acme', 'ACME retainer', 'ACME', 1200, '#2563eb', 'work'); // 20h cap
insertProject.run('personal', 'Personal', 'PERSONAL', null, '#a855f7', 'personal');

// 5. Week math — canonical UTC timestamps (YYYY-MM-DDTHH:MM:SSZ).
function canonical(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
function mondayOfThisWeekUtc() {
  const now = new Date();
  const dow = now.getUTCDay(); // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(now.getTime() + diff * 86_400_000);
  return new Date(
    Date.UTC(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate()),
  );
}
const monday = mondayOfThisWeekUtc();
const weekStart = monday.toISOString().slice(0, 10);
const at = (dayOffset, hour, minute = 0) =>
  new Date(monday.getTime() + dayOffset * 86_400_000 + (hour * 60 + minute) * 60_000);
const plusDays = (days) =>
  new Date(monday.getTime() + days * 86_400_000).toISOString().slice(0, 10);

// 6. Habits: the daily stretch (fixed days) and the workout (target).
const insertHabit = db.prepare(
  `INSERT INTO habits
     (project_id, title, duration_minutes, days_of_week, times_per_week, start_time, timezone)
   VALUES (?, ?, ?, ?, ?, ?, 'UTC')`,
);
insertHabit.run('personal', 'Daily stretch', 15, '0,1,2,3,4,5,6', null, '07:00');
insertHabit.run('personal', 'Workout', 45, '', 4, '17:30');

// 7. Goals: Spanish (refill) and Prospecting (by-date, ~4 weeks out).
const insertGoal = db.prepare(
  `INSERT INTO goals
     (project_id, title, notes, target_minutes, due, refill_period, min_chunk_minutes)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const spanish = insertGoal.run(
  'personal',
  'Spanish practice',
  'No finish line by design — hours poured in per week.',
  180,
  null,
  'week',
  null,
);
const prospecting = insertGoal.run(
  'acme',
  'Prospecting before launch',
  '10h before the launch event; no 20-minute confetti.',
  600,
  plusDays(28), // due ~4 weeks out (a Monday, so weeks divide evenly)
  null,
  120,
);
const spanishId = Number(spanish.lastInsertRowid);
const prospectingId = Number(prospecting.lastInsertRowid);

// 8. Time entries so get_envelopes has activity to show.
const insertEntry = db.prepare(
  `INSERT INTO time_entry
     (project_id, goal_id, start_at, end_at, actual_minutes, status, confirmed_at, source, notes)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
// Confirmed ACME work Monday morning (plain project activity, 3h).
insertEntry.run(
  'acme', null,
  canonical(at(0, 9)), canonical(at(0, 12)),
  null, 'CONFIRMED', canonical(at(0, 12)), 'manual',
  'Sprint work',
);
// Scheduled ACME block Wednesday (2h, UNCONFIRMED).
insertEntry.run(
  'acme', null,
  canonical(at(2, 13)), canonical(at(2, 15)),
  null, 'UNCONFIRMED', null, 'placement',
  'Feature work',
);
// Confirmed Spanish session Tuesday evening (1h into the refill bucket).
insertEntry.run(
  'personal', spanishId,
  canonical(at(1, 18)), canonical(at(1, 19)),
  null, 'CONFIRMED', canonical(at(1, 19)), 'manual',
  'Spanish practice',
);
// Scheduled prospecting block Thursday (2h — the min chunk, UNCONFIRMED).
insertEntry.run(
  'acme', prospectingId,
  canonical(at(3, 9)), canonical(at(3, 11)),
  null, 'UNCONFIRMED', null, 'placement',
  'Prospecting before launch',
);

console.log('Seeded commitments sandbox DB:');
console.log(`  ${dbPath}`);
console.log('  2 projects   ACME retainer (20h/week cap), Personal');
console.log('  2 habits     Daily stretch (fixed days, 7×15min), Workout (4×/week, 45min)');
console.log(`  2 goals      Spanish practice (refill 3h/week, id ${spanishId}),`);
console.log(`               Prospecting before launch (by-date 10h, due ${plusDays(28)}, id ${prospectingId})`);
console.log('  4 entries    3h ACME confirmed · 2h ACME scheduled · 1h Spanish confirmed · 2h prospecting scheduled');
console.log('');
console.log(`This week's Monday: ${weekStart}`);
console.log('');
console.log('Try these MCP calls:');
console.log(`  list_goals({ week_start: '${weekStart}' })`);
console.log(`  get_envelopes({ week_start: '${weekStart}' })`);
console.log(`  assign_hours({ envelope_type: 'goal', envelope_id: '${spanishId}', week_start: '${weekStart}', minutes: 240 })`);
console.log(`  pull_hours({ week_start: '${weekStart}',`);
console.log(`               from: { type: 'project', id: 'acme' },`);
console.log(`               to:   { type: 'goal', id: '${prospectingId}' }, minutes: 120, note: 'launch crunch' })`);
console.log(`  list_envelope_moves({ week_start: '${weekStart}' })`);
console.log(`  place_goal_block({ goal_id: ${spanishId}, start: '${canonical(at(4, 18))}', duration_minutes: 60 })`);
console.log(`  generate_habit_instances({ habit_id: <id from list_habits>, from: '${weekStart}', to: '${plusDays(6)}' })`);
