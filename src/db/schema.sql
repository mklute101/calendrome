CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL UNIQUE,
  calendar_id TEXT,
  color       TEXT,
  weekly_budget_minutes INTEGER,
  harvest_project_id INTEGER,
  harvest_task_id INTEGER,
  category_id TEXT REFERENCES categories(id),
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
  due               TEXT,
  snooze_until      TEXT,
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
  time_entry_id     INTEGER REFERENCES time_entry(id),
  UNIQUE(habit_id, scheduled_start)
);

-- Categories: top-level scheduling windows. Every project belongs to one.
-- The screen-share filter and the "when can this be scheduled" decision
-- are the same lookup. See src/categories.ts for the default_window
-- shape (JSON of days/start/end).
CREATE TABLE IF NOT EXISTS categories (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  display_order  INTEGER NOT NULL DEFAULT 0,
  default_window TEXT,
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ad-hoc availability blocks/openings. The frictionless answer to
-- "Tuesday night I'm not doing anything — don't schedule anything."
-- See src/availability.ts for semantics of available/category_id.
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

CREATE TABLE IF NOT EXISTS time_entry (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id         INTEGER REFERENCES tasks(id),
  project_id      TEXT    REFERENCES projects(id),
  start_at        TEXT    NOT NULL,
  end_at          TEXT    NOT NULL,
  actual_minutes  INTEGER,
  status          TEXT    NOT NULL DEFAULT 'UNCONFIRMED'
                          CHECK (status IN ('UNCONFIRMED', 'CONFIRMED')),
  confirmed_at    TEXT,
  source          TEXT    NOT NULL
                          CHECK (source IN ('placement', 'gcal-sync', 'habit', 'manual')),
  external_id     TEXT,
  is_meeting      INTEGER NOT NULL DEFAULT 0,
  synced_at       TEXT,
  harvest_entry_id INTEGER,
  notes           TEXT,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (end_at >= start_at),
  CHECK (actual_minutes IS NULL OR actual_minutes >= 0),
  CHECK (is_meeting IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_time_entry_range ON time_entry(start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_time_entry_status_start ON time_entry(status, start_at);
CREATE INDEX IF NOT EXISTS idx_time_entry_project ON time_entry(project_id);
CREATE INDEX IF NOT EXISTS idx_time_entry_task ON time_entry(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_entry_external
  ON time_entry(external_id) WHERE external_id IS NOT NULL;

CREATE VIEW IF NOT EXISTS v_task_time_spent AS
SELECT
  task_id,
  CAST(ROUND(SUM(COALESCE(actual_minutes,
    (julianday(end_at) - julianday(start_at)) * 24 * 60))) AS INTEGER) AS minutes
FROM time_entry
WHERE status = 'CONFIRMED' AND task_id IS NOT NULL
GROUP BY task_id;
