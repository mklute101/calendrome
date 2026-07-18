/**
 * Week payload assembly for the GUI dashboard.
 *
 * Extracted from the `/api/week` route so the payload contract is
 * unit-testable without standing up the Express server.
 *
 * Placement semantics (#79): everything time-positioned on the
 * timeline comes from `time_entry` rows — `placements` for
 * UNCONFIRMED (planned) work, `time_logs` for CONFIRMED (done)
 * work. `task.due` is a pure deadline field and never positions a
 * block; unplaced tasks with a `due` inside the week are surfaced
 * by the client as deadline markers only.
 */
import type { DB } from '../db/connection.js';
import { listTasks } from '../tasks.js';
import { listHabits, generateHabitInstances, habitWeekScore } from '../habits.js';
import { getAllBudgets } from '../budgets.js';
import { listCalendarEvents } from '../calendar-sync.js';
import { listAvailabilityOverrides } from '../availability.js';
import { listGoals, goalProgress } from '../goals.js';
import { getEnvelopes } from '../assignments.js';

// Effective minutes of a time_entry: explicit actual_minutes wins,
// otherwise derive from the start/end span.
const DURATION_SQL = `COALESCE(
  te.actual_minutes,
  CAST(ROUND((julianday(te.end_at) - julianday(te.start_at)) * 24 * 60) AS INTEGER)
)`;

/**
 * Build the `/api/week` JSON payload for the seven days starting at
 * `start` (YYYY-MM-DD).
 */
export function buildWeekPayload(db: DB, start: string) {
  const startDate = new Date(start + 'T00:00:00Z');
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + 6);
  const end = endDate.toISOString().slice(0, 10);

  const tasks = listTasks(db);
  const weekTasks = tasks.filter((t) => {
    if (t.status === 'ARCHIVED') return false;
    return true;
  });

  const habits = listHabits(db);
  for (const h of habits) {
    try {
      generateHabitInstances(db, h.id, start, end);
    } catch {
      // already generated
    }
  }
  // Display truth for a habit block is the linked time_entry's span —
  // a moved instance (#118) keeps its immutable `scheduled_start` slot
  // identity but renders (and buckets) on the entry's day, mirroring
  // the placements query. SKIPPED instances have no entry (COALESCE
  // falls back to the scheduled slot); they stay in the payload for
  // the weekly meter and are filtered out client-side in buildDays.
  // `times_per_week` rides along so the client can constrain drags to
  // the frequency range (fixed-days: own day; target form: own week).
  const existingInstances = db
    .prepare(
      `SELECT hi.*, h.title as habit_title, h.project_id,
              h.duration_minutes as habit_duration, h.times_per_week,
              COALESCE(te.start_at, hi.scheduled_start) AS start_at,
              COALESCE(te.end_at, hi.scheduled_end)     AS end_at
       FROM habit_instances hi
       JOIN habits h ON h.id = hi.habit_id
       LEFT JOIN time_entry te ON te.id = hi.time_entry_id
       WHERE COALESCE(te.start_at, hi.scheduled_start) >= ?
         AND COALESCE(te.start_at, hi.scheduled_start) <= ?
       ORDER BY COALESCE(te.start_at, hi.scheduled_start)`,
    )
    .all(start + 'T00:00:00', end + 'T23:59:59') as any[];

  // UNCONFIRMED placement entries — the planned blocks on the
  // timeline. The time_entry row, not task.due, says where a task
  // sits on the calendar (#79). LEFT JOINs: a placement may be
  // task-linked, goal-linked (place_goal_block), or bare
  // project-level — all of them must render, not just task rows.
  const placements = db
    .prepare(
      `SELECT
         te.id                                         AS time_entry_id,
         te.task_id                                    AS task_id,
         te.goal_id                                    AS goal_id,
         te.start_at                                   AS start_at,
         te.end_at                                     AS end_at,
         te.status                                     AS status,
         ${DURATION_SQL}                               AS duration_minutes,
         t.title                                       AS task_title,
         g.title                                       AS goal_title,
         t.priority                                    AS priority,
         COALESCE(te.project_id, t.project_id, g.project_id) AS project_id
       FROM time_entry te
       LEFT JOIN tasks t ON t.id = te.task_id
       LEFT JOIN goals g ON g.id = te.goal_id
       WHERE te.source = 'placement'
         AND te.status = 'UNCONFIRMED'
         AND DATE(te.start_at) >= ? AND DATE(te.start_at) <= ?
       ORDER BY te.start_at`,
    )
    .all(start, end) as any[];

  // Project CONFIRMED time_entry rows into the legacy time_logs
  // shape the dashboard expects (`started_at`, `duration_minutes`,
  // `task_title`, `project_id`). Includes confirmed placements —
  // once the work happened it renders as a logged block, same as a
  // manual log_time entry. gcal-sync rows stay out: they already
  // render via `calendar_events`.
  const timeLogs = db
    .prepare(
      `SELECT
         te.id                                         AS id,
         te.task_id                                    AS task_id,
         te.goal_id                                    AS goal_id,
         te.start_at                                   AS started_at,
         te.end_at                                     AS stopped_at,
         ${DURATION_SQL}                               AS duration_minutes,
         te.notes                                      AS notes,
         t.title                                       AS task_title,
         g.title                                       AS goal_title,
         COALESCE(te.project_id, t.project_id, g.project_id) AS project_id
       FROM time_entry te
       LEFT JOIN tasks t ON t.id = te.task_id
       LEFT JOIN goals g ON g.id = te.goal_id
       WHERE te.status = 'CONFIRMED'
         AND te.source IN ('manual', 'placement')
         AND DATE(te.start_at) >= ? AND DATE(te.start_at) <= ?
       ORDER BY te.start_at`,
    )
    .all(start, end) as any[];

  const budgets = getAllBudgets(db, start);

  // Commitments (M1 — watchable): goals with embedded progress, habit
  // weekly meters, and the week's envelope totals. goalProgress /
  // getEnvelopes key off a Monday; the GUI always requests Mondays,
  // but normalize anyway so a mid-week `start` still answers for its
  // own week instead of throwing.
  const startDow = startDate.getUTCDay(); // 0=Sun..6=Sat
  const monday = new Date(
    startDate.getTime() - ((startDow + 6) % 7) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);

  const goals = listGoals(db, { active: true }).map((g) => ({
    ...g,
    progress: goalProgress(db, g.id, monday),
  }));

  const habitScores = listHabits(db, { active: true }).map((h) => ({
    habit_id: h.id,
    title: h.title,
    project_id: h.project_id,
    ...habitWeekScore(db, h.id, monday),
  }));

  const envelopeSummary = getEnvelopes(db, monday).reduce(
    (acc, e) => {
      acc.assigned_minutes += e.assigned ?? 0;
      acc.confirmed_minutes += e.activity.confirmed_minutes;
      acc.scheduled_minutes += e.activity.scheduled_minutes;
      return acc;
    },
    { assigned_minutes: 0, confirmed_minutes: 0, scheduled_minutes: 0 },
  );

  const calendarEvents = listCalendarEvents(
    db,
    start + 'T00:00:00',
    end + 'T23:59:59',
  );

  const availability = listAvailabilityOverrides(db, {
    from: start + 'T00:00:00',
    to: end + 'T23:59:59',
  });

  return {
    start,
    end,
    tasks: weekTasks,
    habit_instances: existingInstances,
    placements,
    time_logs: timeLogs,
    budgets,
    calendar_events: calendarEvents,
    availability,
    goals,
    habit_scores: habitScores,
    envelope_summary: envelopeSummary,
  };
}
