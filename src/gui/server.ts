import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../db/connection.js';
import { migrate } from '../db/migrate.js';
import { listProjects } from '../projects.js';
import { listTasks } from '../tasks.js';
import { listHabits, generateHabitInstances } from '../habits.js';
import { getAllBudgets } from '../budgets.js';
import { listCalendarEvents } from '../calendar-sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CALENDROME_DB ?? 'calendrome.db';
const PORT = Number(process.env.CALENDROME_GUI_PORT ?? 3737);

const db = openDatabase(DB_PATH);
migrate(db);

const app = express();
app.use(express.static(join(__dirname, 'public')));

app.get('/api/projects', (_req, res) => {
  res.json(listProjects(db, { active: true }));
});

app.get('/api/week', (req, res) => {
  const start = String(req.query.start ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    res.status(400).json({ error: 'start param required (YYYY-MM-DD)' });
    return;
  }

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
  const allInstances: any[] = [];
  for (const h of habits) {
    try {
      const instances = generateHabitInstances(db, h.id, start, end);
      allInstances.push(...instances);
    } catch {
      // already generated — query existing
    }
  }
  const existingInstances = db
    .prepare(
      `SELECT hi.*, h.title as habit_title, h.project_id, h.duration_minutes as habit_duration
       FROM habit_instances hi
       JOIN habits h ON h.id = hi.habit_id
       WHERE hi.scheduled_start >= ? AND hi.scheduled_start <= ?
       ORDER BY hi.scheduled_start`,
    )
    .all(start + 'T00:00:00', end + 'T23:59:59') as any[];

  const timeLogs = db
    .prepare(
      `SELECT tl.*, t.title as task_title, t.project_id
       FROM time_log tl
       JOIN tasks t ON t.id = tl.task_id
       WHERE DATE(tl.started_at) >= ? AND DATE(tl.started_at) <= ?
       ORDER BY tl.started_at`,
    )
    .all(start, end) as any[];

  const budgets = getAllBudgets(db, start);

  const calendarEvents = listCalendarEvents(
    db,
    start + 'T00:00:00',
    end + 'T23:59:59',
  );

  res.json({
    start,
    end,
    tasks: weekTasks,
    habit_instances: existingInstances,
    time_logs: timeLogs,
    budgets,
    calendar_events: calendarEvents,
  });
});

app.listen(PORT, () => {
  console.log(`Calendrome GUI → http://localhost:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});
