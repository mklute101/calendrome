/**
 * Canonical demo dataset — fictional projects/tasks/placements used by
 * the sandbox skill (`plugin/skills/sandbox/scripts/seed-demo.mjs`)
 * and the in-browser playground (`src/gui/app/playground.tsx`). One
 * dataset, two consumers, so the demos can't drift.
 *
 * Assumes the schema is already applied (`src/db/schema.sql`); seeds
 * default categories only if absent (mirroring `migrate()`), then the
 * three fictional projects and a week of tasks, placements, logged
 * time, and a daily habit — anchored to the Monday of `now`'s week in
 * local time.
 *
 * Idempotent: wipes prior seed content first (only rows belonging to
 * the fixed project ids `acme`/`globex`/`hobby`, so a user's own data
 * in the same DB is never touched), then re-inserts.
 *
 * Browser-safe: no node imports — this module runs inside the
 * playground bundle against the sql.js adapter.
 */
import type { DB } from './db/types.js';
import { insertTimeEntry } from './time-entry.js';

const SEED_PROJECT_IDS = ['acme', 'globex', 'hobby'] as const;

/**
 * The seed is anchored to the runtime's local week and timezone —
 * the demo should look right wherever it runs (the sandbox skill on
 * the owner's machine, the playground in any visitor's browser).
 */
function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** ISO 8601 with local clock time and local offset (e.g. `09:00-05:00`). */
function isoLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const offsetH = pad(Math.floor(Math.abs(tzOffsetMin) / 60));
  const offsetM = pad(Math.abs(tzOffsetMin) % 60);
  const local =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${local}${sign}${offsetH}:${offsetM}`;
}

function mondayOfWeek(now: Date): Date {
  const day = now.getDay(); // 0=Sun..6=Sat
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(now);
  mon.setDate(now.getDate() + diff);
  mon.setHours(9, 0, 0, 0);
  return mon;
}

export interface SeedSummary {
  projects: number;
  tasks: number;
  placements: number;
  habits: number;
}

export function seedDemo(db: DB, now: Date = new Date()): SeedSummary {
  // 1. Default categories if absent (mirrors src/db/migrate.ts).
  const catCount = (
    db.prepare('SELECT COUNT(*) AS n FROM categories').get() as { n: number }
  ).n;
  const tz = localTimezone();
  if (catCount === 0) {
    const insertCat = db.prepare(
      `INSERT INTO categories (id, name, display_order, default_window, timezone)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertCat.run(
      'work',
      'Work',
      0,
      JSON.stringify({ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }),
      tz,
    );
    insertCat.run(
      'personal',
      'Personal',
      1,
      JSON.stringify({ days: [0, 1, 2, 3, 4, 5, 6], start: '18:00', end: '22:00' }),
      tz,
    );
  }

  // 2. Wipe prior seed content — only rows tied to the fixed seed project
  //    ids. Order respects FKs: habit_instances → time_entry → habits/tasks
  //    → projects.
  const ids = [...SEED_PROJECT_IDS];
  const ph = ids.map(() => '?').join(',');
  db.prepare(
    `DELETE FROM habit_instances WHERE habit_id IN (SELECT id FROM habits WHERE project_id IN (${ph}))`,
  ).run(...ids);
  db.prepare(
    `DELETE FROM time_entry WHERE project_id IN (${ph})
       OR task_id IN (SELECT id FROM tasks WHERE project_id IN (${ph}))`,
  ).run(...ids, ...ids);
  db.prepare(`DELETE FROM habits WHERE project_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM tasks WHERE project_id IN (${ph})`).run(...ids);
  db.prepare(`DELETE FROM projects WHERE id IN (${ph})`).run(...ids);

  // 3. Projects.
  const insertProject = db.prepare(
    `INSERT INTO projects (id, name, prefix, weekly_budget_minutes, color, category_id)
     VALUES (?, ?, ?, ?, ?, 'work')`,
  );
  insertProject.run('acme', 'Acme Corp', 'ACME', 1200, '#2563eb'); // 20h
  insertProject.run('globex', 'Globex Industries', 'GLBX', 600, '#16a34a'); // 10h
  insertProject.run('hobby', 'Hobby Project', 'HOBBY', 300, '#a855f7'); // 5h

  // 4. Anchor to this week's Monday in local time.
  const monday = mondayOfWeek(now);
  const dayOffset = (n: number) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + n);
    return d;
  };
  const at = (date: Date, hour: number, minute = 0) => {
    const d = new Date(date);
    d.setHours(hour, minute, 0, 0);
    return d;
  };

  const insertTask = db.prepare(
    `INSERT INTO tasks (project_id, title, priority, status, duration_minutes, due)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  let placements = 0;
  /** Insert a SCHEDULED task plus its paired UNCONFIRMED placement. */
  const placed = (
    projectId: string,
    title: string,
    priority: string,
    durationMinutes: number,
    start: Date,
    externalId: string,
  ) => {
    const res = insertTask.run(
      projectId,
      title,
      priority,
      'SCHEDULED',
      durationMinutes,
      isoLocal(start),
    );
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    insertTimeEntry(db, {
      task_id: Number(res.lastInsertRowid),
      project_id: projectId,
      start_at: isoLocal(start),
      end_at: isoLocal(end),
      status: 'UNCONFIRMED',
      source: 'placement',
      external_id: externalId,
    });
    placements++;
  };

  // Acme — 4 tasks.
  placed('acme', '[ACME-101] Login bug fix', 'HIGH', 120, at(dayOffset(0), 10), 'demo:mon-acme-1');
  placed('acme', '[ACME-103] Footer redesign', 'MEDIUM', 180, at(dayOffset(1), 14), 'demo:tue-acme-1');
  insertTask.run('acme', '[ACME-108] Code review PR #423', 'MEDIUM', 'NEW', 60, null);
  insertTask.run('acme', '[ACME-110] API spec review', 'LOW', 'NEW', 90, null);

  // Globex — 2 tasks (over budget for the visual cue: 12h placed vs 10h budget).
  placed('globex', '[GLBX-42] Migrate analytics pipeline', 'HIGH', 360, at(dayOffset(2), 9), 'demo:wed-glbx-1');
  placed('globex', '[GLBX-58] Onboarding doc rewrite', 'LOW', 360, at(dayOffset(3), 13), 'demo:thu-glbx-1');

  // Hobby — 1 task.
  placed('hobby', 'Sketch new ride routes', 'LOW', 90, at(dayOffset(4), 17), 'demo:fri-hobby-1');

  // 5. One completed task with confirmed logged time Monday morning.
  const completed = insertTask.run(
    'acme',
    '[ACME-100] Sprint planning notes',
    'MEDIUM',
    'COMPLETE',
    60,
    isoLocal(at(dayOffset(0), 9)),
  );
  insertTimeEntry(db, {
    task_id: Number(completed.lastInsertRowid),
    project_id: 'acme',
    start_at: isoLocal(at(dayOffset(0), 9)),
    end_at: isoLocal(at(dayOffset(0), 10)),
    actual_minutes: 60,
    status: 'CONFIRMED',
    confirmed_at: isoLocal(at(dayOffset(0), 10)),
    source: 'manual',
  });

  // 6. One habit — the daily standup.
  db.prepare(
    `INSERT INTO habits (project_id, title, duration_minutes, days_of_week, start_time, timezone)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'acme',
    'Acme standup',
    15,
    '1,2,3,4,5', // comma-separated, the habits.ts convention (the old seed's JSON form was stale)
    '09:30',
    tz,
  );

  return { projects: 3, tasks: 8, placements, habits: 1 };
}
