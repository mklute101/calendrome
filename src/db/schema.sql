CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL UNIQUE,
  calendar_id TEXT,
  color       TEXT,
  -- Standing default assignment for the project's envelope (the cap
  -- side). Column name kept for history (#121).
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
  -- Frequency: exactly one of days_of_week / times_per_week is the
  -- habit's form (enforced in src/habits.ts). days_of_week stays NOT
  -- NULL for legacy compatibility — the N-per-week form stores ''.
  days_of_week     TEXT NOT NULL,
  times_per_week   INTEGER,
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
  goal_id         INTEGER REFERENCES goals(id),
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

-- Commitments prototype (#106): Goals are the bucket-of-hours
-- commitment type — by-date ("10h before Sept 12", due set) or
-- recurring refill ("3h/week forever", refill_period set). Exactly
-- one of due/refill_period must be set; enforced in src/goals.ts,
-- not by CHECK, so existing DBs migrate cleanly.
CREATE TABLE IF NOT EXISTS goals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  title             TEXT NOT NULL,
  notes             TEXT,
  target_minutes    INTEGER NOT NULL,
  due               TEXT,                  -- by-date flavor; NULL = refill
  refill_period     TEXT,                  -- 'week' (v1); NULL = by-date
  min_chunk_minutes INTEGER,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Envelope assignments (#106): "this week's word" on how many minutes
-- an envelope (project cap / goal / habit) gets, YNAB-style. Absence
-- of a row means the standing default applies (project budget, goal
-- weekly ask, habit frequency ask). minutes NULL = snoozed (unfunded).
CREATE TABLE IF NOT EXISTS assignments (
  envelope_type  TEXT NOT NULL,            -- 'project' | 'goal' | 'habit'
  envelope_id    TEXT NOT NULL,
  week_start     TEXT NOT NULL,            -- Monday ISO date
  minutes        INTEGER,                  -- NULL = snoozed (unfunded)
  note           TEXT,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (envelope_type, envelope_id, week_start)
);

-- Recent Moves (#106): append-only audit trail of envelope pulls.
-- NULL from = pulled out of unassigned supply; NULL to = released
-- back to supply.
CREATE TABLE IF NOT EXISTS envelope_moves (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start    TEXT NOT NULL,
  from_type     TEXT, from_id TEXT,        -- NULL = from unassigned supply
  to_type       TEXT, to_id   TEXT,        -- NULL = released to supply
  minutes       INTEGER NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Title-pattern rules that auto-assign incoming calendar events to a
-- project during sync (#35). Google recurring-event instances have
-- unique ids, so per-event tagging never sticks; the durable identity
-- of a meeting series is its title. First match by id order wins.
CREATE TABLE IF NOT EXISTS meeting_project_mappings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern    TEXT NOT NULL,
  match      TEXT NOT NULL DEFAULT 'contains'
             CHECK (match IN ('exact', 'contains', 'regex')),
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
