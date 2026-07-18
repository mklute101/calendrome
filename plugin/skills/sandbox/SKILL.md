---
name: sandbox
description: Spin up a throwaway calendrome instance (alt DB + alt port) for testing or demos. Use when the user runs `/calendrome:sandbox`, says they want to "test calendrome safely", "play around without breaking my data", "demo calendrome", or "show calendrome to someone". Optional `demo` argument seeds rich realistic-looking sample data for screen-shares.
argument-hint: "[demo]  — optional. Pass 'demo' to pre-seed rich sample data."
allowed-tools: Bash, Read, Write
---

# Calendrome Sandbox

Spin up a calendrome instance that does not touch the user's real DB. Useful for two cases:

1. **Try-without-fear**: testing destructive operations, exploring new features, running through onboarding to verify it works
2. **Demo**: showing calendrome to someone with realistic pre-seeded data, no real account state required

## Configuration

Two settings make sandbox isolation work:

- **`CALENDROME_DB`** environment variable — points the MCP server at an alternate sqlite file
- **`PORT`** environment variable — points the GUI server at an alternate port (default 3737 → sandbox 3838)

Both servers (`src/mcp/server.ts` and `src/gui/server.ts`) already honor these env vars.

## Workflow

### Step 1: Read settings

Read `~/.claude/calendrome.local.md` to find `calendrome_repo_path`. If no settings file exists, ask the user where calendrome is installed.

### Step 2: Decide DB target

- Default sandbox DB: `<calendrome_repo_path>/sandbox.db`
- If the user passed `demo`: same path, but seed rich data afterward.

If `<calendrome_repo_path>/sandbox.db` already exists, ask: "Sandbox DB exists from a previous run. Reuse, or wipe and re-seed?"

### Step 3: Print start instructions

Do not auto-spawn long-running servers from inside this skill — background processes started from a skill invocation are fragile and easy to leak. Instead, print exact commands the user runs in their own terminal:

```bash
cd <calendrome_repo_path>

# Terminal 1 — MCP server (point Claude Code at this if you want it as a separate MCP)
CALENDROME_DB=./sandbox.db npm start

# Terminal 2 — GUI on alt port
CALENDROME_DB=./sandbox.db PORT=3838 npm run gui
# → http://localhost:3838
```

### Step 4: Seed (if `demo` mode)

If the user invoked `/calendrome:sandbox demo`, run the seed script:

```bash
CALENDROME_DB=<calendrome_repo_path>/sandbox.db node <calendrome_repo_path>/plugin/skills/sandbox/scripts/seed-demo.mjs
```

The seed script populates:
- 3 fictional projects with weekly budgets (Acme Corp, Globex, Hobby)
- Default categories (work, personal)
- A week of scheduled tasks across the three projects
- A few completed tasks with logged time
- One placeholder task and one habit

(The seed script is the SQL fixtures equivalent of the in-memory tests in `tests/`.)

### Step 4b: Commitments seed (on request)

If the user wants to try the commitments prototype (#106 — goals,
assignments, envelope pulls), there is a second seeder:

```bash
CALENDROME_DB=<calendrome_repo_path>/sandbox.db node <calendrome_repo_path>/plugin/skills/sandbox/scripts/seed-commitments.mjs
```

It seeds the worked examples from the commitment-taxonomy design doc:

- **ACME retainer** — project with a 20h/week cap, plus a budget-less
  **Personal** project
- **Daily stretch** — Habit, fixed days (7×15min)
- **Workout** — Habit, N-per-week target (4×45min)
- **Spanish practice** — Goal, recurring refill (3h/week)
- **Prospecting before launch** — Goal, by-date (10h due ~4 weeks
  out, 2h minimum chunk)
- A few confirmed/unconfirmed time entries so `get_envelopes` has
  activity to show

On success it prints a cheat-sheet of envelope calls to try
(`get_envelopes`, `assign_hours`, `pull_hours`, `place_goal_block`, …)
with this week's Monday and the seeded goal ids already filled in —
paste-ready for a first budget-meeting run. It is idempotent (wipes
and re-seeds its own projects) and refuses to touch a DB that looks
like the real `calendrome.db`.

### Step 5: Confirm + show URL

Tell the user:

```
Sandbox up.
- DB: <repo>/sandbox.db
- GUI: http://localhost:3838
- MCP: connect by running `CALENDROME_DB=./sandbox.db npm start` in a separate terminal

Your real calendrome data is untouched.
```

### Step 6: Teardown (when user is done)

Print:

```bash
# Stop the GUI process (Ctrl-C in its terminal)
# Stop the MCP process (Ctrl-C in its terminal)

# Optional: wipe sandbox state
rm <calendrome_repo_path>/sandbox.db
```

Do not auto-rm the file.

## Demo seed contents

The demo seed (see `scripts/seed-demo.mjs`) produces a realistic-feeling fictional setup:

- **Acme Corp** — 20h/week budget, 4 active tasks across the week
- **Globex** — 10h/week budget, 2 tasks (one over-budget for visual effect)
- **Hobby** — 5h/week, 1 task (under-utilized — shows the visual cue)
- A morning standup meeting habit
- A logged Monday entry on Acme to populate the "Spent" column

This gives a screen-share viewer enough variety to see budgets, scheduling, and time logs in action.

## Why setup-only (not full lifecycle)

Real lifecycle management for two background node processes from inside a Claude Code skill is fragile: PID tracking across sessions, port conflicts, and silent failures are all common. Letting the user run `npm start` and `npm run gui` themselves keeps responsibility in the right place. The skill's value is configuration + seed data, not process supervision.

## Additional resources

- `scripts/seed-demo.mjs` — demo data seeder used by `/calendrome:sandbox demo`
- `scripts/seed-commitments.mjs` — commitments-prototype seeder (the
  design doc's worked examples); prints an envelope-call cheat-sheet
