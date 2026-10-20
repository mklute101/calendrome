---
name: sandbox
description: Spin up a throwaway calendrome instance (alt DB + alt port) for testing or demos. Use when the user runs `/calendrome:sandbox`, says they want to "test calendrome safely", "play around without breaking my data", "demo calendrome", or "show calendrome to someone". Optional `demo` argument copies the committed fictional demo database for screen-shares.
argument-hint: "[demo]  — optional. Pass 'demo' to copy the committed demo database."
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
- In `demo` mode, copy the committed `<calendrome_repo_path>/demo/calendrome-demo.db` to this path. The committed file is the source; the sandbox copy is the working database.

If `<calendrome_repo_path>/sandbox.db` already exists:

- In normal sandbox mode, ask whether to reuse it or wipe it and start with an empty DB.
- In `demo` mode, ask whether to reuse it or replace it with the committed demo database.

Never replace an existing sandbox without the user's choice.

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

### Step 4: Copy the demo database (if `demo` mode)

If the user invoked `/calendrome:sandbox demo` and chose a new or replacement sandbox, stop any process using the sandbox DB. For a replacement, remove the existing sandbox DB and its SQLite sidecars only after the user chose replacement. Then copy the committed demo DB:

```bash
cp "<calendrome_repo_path>/demo/calendrome-demo.db" "<calendrome_repo_path>/sandbox.db"
```

If the user chose to reuse an existing sandbox, leave it unchanged. The copy reads `demo/calendrome-demo.db` and writes `sandbox.db`; replacement cleanup may remove only the user-approved sandbox DB and its SQLite sidecars. The committed demo DB is fictional and is built through the real MCP tool path by `demo/play-demo.mjs`, whose existing guard against writing to `calendrome.db` remains in place.

### Step 4b: Commitments seed (on request)

If the user wants to try the commitments model (#106 — goals,
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

## Demo database contents

The copied database contains the fictional, three-week planning scenario documented in [`demo/README.md`](../../../demo/README.md). It is produced by `demo/play-demo.mjs` through real MCP tool calls, so the sandbox uses the same data path as the application instead of maintaining a second SQL fixture.

## Why setup-only (not full lifecycle)

Real lifecycle management for two background node processes from inside a Claude Code skill is fragile: PID tracking across sessions, port conflicts, and silent failures are all common. Letting the user run `npm start` and `npm run gui` themselves keeps responsibility in the right place. The skill's value is configuration + a safe demo DB copy, not process supervision.

## Additional resources

- `../../../demo/calendrome-demo.db` — committed fictional database copied by `/calendrome:sandbox demo`
- `../../../demo/play-demo.mjs` — rebuilds the demo database through real tool calls
- `scripts/seed-commitments.mjs` — commitments seeder (the
  design doc's worked examples); prints an envelope-call cheat-sheet
- `scripts/seed-helpers.mjs` — clock-convention timestamps and envelope
  wipes shared by both seeders
