# Calendrome Demo Script (Friday)

## Setup (before the demo)

1. Projects created with real budgets
2. Calendar events synced (run `/week` once to populate)
3. A few tasks already in progress (so budgets show activity)
4. GUI running: `npm run gui` → http://localhost:3737

---

## Beat 1: The Problem (30 seconds)

> "Right now I use Reclaim.ai, but I'm replacing it because I want
> more control — specifically over project hour budgets and how my
> week gets planned. Reclaim auto-schedules everything; I want to
> decide collaboratively with Claude."

---

## Beat 2: Show the GUI (60 seconds)

Open http://localhost:3737

- **Budget bars at the top** — "Here are my projects and how much
  time I've allocated to each this week. Blue is on track, amber
  is approaching the cap."
- **Compact view** — "Tasks, meetings, logged time. Meetings are
  solid blocks, tasks are hatched."
- **Toggle to Timeline** — "Same data, but now you can see when
  things are actually happening. Red line is now."
- **Now-line** — "It's [current time], and here's where my day is."

---

## Beat 3: The DevCon Example (90 seconds)

> "I have the DevCon conference May 15th. I want to spend 10 hours
> prepping — research speakers, plan who to meet, take notes on
> sessions to attend."

In Claude Code:
```
Create a task: project "glbx", title "DevCon conference prep",
10 hours, due May 15th
```

Show the task created. Then:
```
What's my pacing look like? I have 10 hours of DevCon prep
due May 15th — how much per week do I need?
```

Claude calculates: "You have 2 weeks. That's 5 hours/week. Your GLBX
budget has 3h remaining this week — you'd need to stretch or start
next week."

**Point:** This is the insight Reclaim couldn't give you — budgets
+ due dates + pacing, conversationally.

---

## Beat 4: Weekly Planning Flow (90 seconds)

Run `/week`:

1. "It pulls my Jira tickets AND my Google Calendar simultaneously"
2. Show the unified view: meetings, open tickets, budget status
3. "Here are tickets that don't have calendar time blocked yet"
4. "Let's block 2 hours for ACME-42 Tuesday morning"

Watch it:
- Create the calendrome task
- Create the Google Calendar event
- Link them
- Budget bar updates

> "One sentence, three actions, budget reflects reality."

---

## Beat 5: Time Tracking (60 seconds)

```
Start task ACME-42
```

Wait a moment, then:
```
Stop task ACME-42
```

Show: time_log entry created, `time_spent_minutes` updated on the
task, budget bar moves.

> "No separate time tracker. Start and stop within the same
> conversation where you're doing the work."

---

## Beat 6: Timesheet (30 seconds)

```
Export this week's timesheet as markdown
```

Show the table with per-project subtotals. Then (if Harvest is set up):

```
Push this week to Harvest
```

> "One command. 23 entries. Done."

---

## Beat 7: The Philosophy (30 seconds, closing)

> "Calendrome doesn't auto-schedule. It doesn't manage your
> calendar for you. It gives you the data to make good decisions
> — budgets, pacing, time logs — and Claude does the orchestration.
> It's a data layer for your work life, not another app demanding
> your attention."

---

## Backup beats (if there's time / questions)

- **`/calendrome`** — show the help/status command
- **Habits** — show recurring time blocks
- **Inbox** — quick capture + process flow
- **GUI refresh** — show that MCP writes appear immediately in the GUI
- **View toggle** — compact vs timeline, localStorage persistence

---

## Things that might go wrong

| Issue | Fix |
|---|---|
| GUI shows empty days | Run `/week` first to sync calendar events |
| MCP server disconnected | `claude mcp list` → restart Claude Code |
| Budget shows 0 | Create projects with `weekly_budget_minutes` set |
| Harvest push fails | Check `HARVEST_TOKEN` / `HARVEST_ACCOUNT_ID` env vars |
| Timeline blocks misaligned | Check timezone — events need ISO 8601 with timezone |
