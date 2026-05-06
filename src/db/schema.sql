CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL UNIQUE,
  calendar_id TEXT,
  color       TEXT,
  weekly_budget_minutes INTEGER,
  harvest_project_id INTEGER,
  harvest_task_id INTEGER,
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
  duration_minutes INTEGER,
  harvest_entry_id INTEGER
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

CREATE TABLE IF NOT EXISTS calendar_events (
  id              TEXT PRIMARY KEY,
  calendar_id     TEXT NOT NULL,
  project_id      TEXT REFERENCES projects(id),
  summary         TEXT NOT NULL,
  start           TEXT NOT NULL,
  end             TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL,
  is_meeting      INTEGER NOT NULL DEFAULT 0,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Categories: top-level scheduling windows. Every project belongs to one.
-- The screen-share filter and the "when can this be scheduled" decision
-- are the same lookup.
CREATE TABLE IF NOT EXISTS categories (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  display_order  INTEGER NOT NULL DEFAULT 0,
  -- Default weekly window as JSON, e.g.
  -- {"days":[1,2,3,4,5],"start":"09:00","end":"17:00"}
  -- (days: 0=Sun..6=Sat, ISO-ish; null means "no default window")
  default_window TEXT,
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ad-hoc availability blocks/openings. The frictionless answer to
-- "Tuesday night I'm not doing anything — don't schedule anything."
-- available=0  → block this window (do not schedule)
-- available=1  → open this window (allow scheduling outside the normal window)
-- category_id  → null = applies to all categories, otherwise scoped
CREATE TABLE IF NOT EXISTS availability_overrides (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  start       TEXT NOT NULL,
  end         TEXT NOT NULL,
  available   INTEGER NOT NULL,
  category_id TEXT REFERENCES categories(id),
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_availability_overrides_range
  ON availability_overrides(start, end);
