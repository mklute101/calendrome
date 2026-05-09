#!/usr/bin/env node
// Seed a calendrome sandbox DB with realistic-looking demo data.
//
// Usage:
//   CALENDROME_DB=./sandbox.db node plugin/skills/sandbox/scripts/seed-demo.mjs
//
// Idempotent: running twice produces the same final state (truncates seed
// content, then re-inserts). Does not touch a non-sandbox DB by name —
// refuses to run if CALENDROME_DB is empty or matches calendrome.db.

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

// 1. Run schema (idempotent CREATE IF NOT EXISTS).
const schema = readFileSync(join(REPO_ROOT, 'src/db/schema.sql'), 'utf8');
db.exec(schema);

// 2. Ensure default categories exist (mirrors src/db/migrate.ts behavior).
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
    'America/Chicago',
  );
  insertCat.run(
    'personal',
    'Personal',
    1,
    JSON.stringify({ days: [0, 1, 2, 3, 4, 5, 6], start: '18:00', end: '22:00' }),
    'America/Chicago',
  );
}

// 3. Wipe any prior seed content (only seed-tagged rows; uses fixed IDs
//    in the [acme, globex, hobby] set so we never touch user data).
const seedProjectIds = ['acme', 'globex', 'hobby'];
const placeholders = seedProjectIds.map(() => '?').join(',');
db.prepare(`DELETE FROM time_log WHERE task_id IN (SELECT id FROM tasks WHERE project_id IN (${placeholders}))`).run(...seedProjectIds);
db.prepare(`DELETE FROM habit_instances WHERE habit_id IN (SELECT id FROM habits WHERE project_id IN (${placeholders}))`).run(...seedProjectIds);
db.prepare(`DELETE FROM habits WHERE project_id IN (${placeholders})`).run(...seedProjectIds);
db.prepare(`DELETE FROM tasks WHERE project_id IN (${placeholders})`).run(...seedProjectIds);
db.prepare(`DELETE FROM projects WHERE id IN (${placeholders})`).run(...seedProjectIds);

// 4. Seed projects.
const insertProject = db.prepare(
  `INSERT INTO projects (id, name, prefix, weekly_budget_minutes, color, category_id)
   VALUES (?, ?, ?, ?, ?, 'work')`,
);
insertProject.run('acme', 'Acme Corp', 'ACME', 1200, '#2563eb'); // 20h
insertProject.run('globex', 'Globex Industries', 'GLBX', 600, '#16a34a'); // 10h
insertProject.run('hobby', 'Hobby Project', 'HOBBY', 300, '#a855f7'); // 5h

// 5. Compute this week's Monday in local time → ISO with offset.
function mondayOfThisWeek() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day);
  const mon = new Date(now);
  mon.setDate(now.getDate() + diff);
  mon.setHours(9, 0, 0, 0);
  return mon;
}

function isoLocal(d) {
  // ISO 8601 with local clock time and local offset (e.g. 09:00-05:00).
  // Avoid toISOString — it converts to UTC.
  const pad = (n) => String(n).padStart(2, '0');
  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const offsetH = pad(Math.floor(Math.abs(tzOffsetMin) / 60));
  const offsetM = pad(Math.abs(tzOffsetMin) % 60);
  const local =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${local}${sign}${offsetH}:${offsetM}`;
}

const monday = mondayOfThisWeek();
const dayOffsets = (n) => {
  const d = new Date(monday);
  d.setDate(monday.getDate() + n);
  return d;
};
const at = (date, hour, minute = 0) => {
  const d = new Date(date);
  d.setHours(hour, minute, 0, 0);
  return d;
};

// 6. Seed tasks across the week.
const insertTask = db.prepare(
  `INSERT INTO tasks (project_id, title, priority, status, duration_minutes, due, calendar_event_id)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);

// Acme — 4 tasks
insertTask.run('acme', '[ACME-101] Login bug fix', 'HIGH', 'SCHEDULED', 120, isoLocal(at(dayOffsets(0), 10)), 'demo:mon-acme-1');
insertTask.run('acme', '[ACME-103] Footer redesign', 'MEDIUM', 'SCHEDULED', 180, isoLocal(at(dayOffsets(1), 14)), 'demo:tue-acme-1');
insertTask.run('acme', '[ACME-108] Code review PR #423', 'MEDIUM', 'NEW', 60, null, null);
insertTask.run('acme', '[ACME-110] API spec review', 'LOW', 'NEW', 90, null, null);

// Globex — 2 tasks (over-budget for visual cue: 12h scheduled vs 10h budget)
insertTask.run('globex', '[GLBX-42] Migrate analytics pipeline', 'HIGH', 'SCHEDULED', 360, isoLocal(at(dayOffsets(2), 9)), 'demo:wed-glbx-1');
insertTask.run('globex', '[GLBX-58] Onboarding doc rewrite', 'LOW', 'SCHEDULED', 360, isoLocal(at(dayOffsets(3), 13)), 'demo:thu-glbx-1');

// Hobby — 1 task
insertTask.run('hobby', 'Sketch new ride routes', 'LOW', 'SCHEDULED', 90, isoLocal(at(dayOffsets(4), 17)), 'demo:fri-hobby-1');

// 7. One completed task with a logged time entry on Monday morning.
const completedRes = insertTask.run('acme', '[ACME-100] Sprint planning notes', 'MEDIUM', 'COMPLETE', 60, isoLocal(at(dayOffsets(0), 9)), null);
const insertLog = db.prepare(
  `INSERT INTO time_log (task_id, started_at, stopped_at, duration_minutes)
   VALUES (?, ?, ?, ?)`,
);
const startMon = at(dayOffsets(0), 9);
const endMon = at(dayOffsets(0), 10);
insertLog.run(completedRes.lastInsertRowid, isoLocal(startMon), isoLocal(endMon), 60);
db.prepare(`UPDATE tasks SET time_spent_minutes = 60 WHERE id = ?`).run(completedRes.lastInsertRowid);

// 8. One habit (morning standup).
const insertHabit = db.prepare(
  `INSERT INTO habits (project_id, title, duration_minutes, days_of_week, start_time, timezone)
   VALUES (?, ?, ?, ?, ?, ?)`,
);
insertHabit.run('acme', 'Acme standup', 15, JSON.stringify([1, 2, 3, 4, 5]), '09:30', 'America/Chicago');

console.log('Seeded sandbox DB:');
console.log(`  ${dbPath}`);
console.log('  3 projects (Acme, Globex, Hobby)');
console.log('  8 tasks across the week (incl. 1 completed with logged time)');
console.log('  1 daily standup habit');
console.log('');
console.log('Next: in a separate terminal, run:');
console.log(`  CALENDROME_DB=${dbPath} PORT=3838 npm run gui`);
console.log('  → http://localhost:3838');
