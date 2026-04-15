CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL UNIQUE,
  calendar_id TEXT,
  color       TEXT,
  weekly_budget_minutes INTEGER,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_policies (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT REFERENCES projects(id),
  day_of_week INTEGER NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'UTC'
);

CREATE TABLE IF NOT EXISTS tasks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  title             TEXT NOT NULL,
  notes             TEXT,
  priority          TEXT NOT NULL DEFAULT 'LOW',
  status            TEXT NOT NULL DEFAULT 'NEW',
  duration_minutes  INTEGER NOT NULL DEFAULT 30,
  time_spent_minutes INTEGER NOT NULL DEFAULT 0,
  due               TEXT,
  snooze_until      TEXT,
  calendar_event_id TEXT,
  depends_on        INTEGER REFERENCES tasks(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  notes       TEXT,
  processed   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS time_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id          INTEGER NOT NULL REFERENCES tasks(id),
  started_at       TEXT NOT NULL,
  stopped_at       TEXT,
  duration_minutes INTEGER
);

CREATE TABLE IF NOT EXISTS habits (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id       TEXT NOT NULL REFERENCES projects(id),
  title            TEXT NOT NULL,
  notes            TEXT,
  duration_minutes INTEGER NOT NULL,
  days_of_week     TEXT NOT NULL,
  start_time       TEXT NOT NULL,
  timezone         TEXT NOT NULL DEFAULT 'UTC',
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS habit_instances (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  habit_id          INTEGER NOT NULL REFERENCES habits(id),
  scheduled_start   TEXT NOT NULL,
  scheduled_end     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PLANNED',
  calendar_event_id TEXT,
  completed_at      TEXT,
  UNIQUE(habit_id, scheduled_start)
);
