# Demo database

`calendrome-demo.db` is a fully populated calendrome dataset for demos
and screen-shares. It was not seeded: a Claude session played two and a
half weeks of real usage against the actual core functions (the same
code paths the MCP tools and GUI call), one planning session and one
daily wrap at a time, with a simulated clock. Every row in it was
written by `place_task` / `confirm_placement` / `sync_calendar_events` /
`log_time` / habit and goal calls — never by hand-inserted SQL.

All names are fictional. "Today" inside the dataset is **Friday
2026-07-31**; the further real time drifts past that date, the staler
the week views will look.

## The story

A freelance product engineer with two clients and a side product:

| Project | Prefix | Weekly budget | Category |
|---|---|---|---|
| Northwind Traders | NW | 16h | work |
| Lumen Analytics | LMN | 8h | work |
| Studio (own product) | STU | 4h | work |
| Personal | PER | — | personal |
| Fitness | FIT | — | personal |

Goals: **Spanish practice** (3h/week refill) and a by-date bucket,
**Talk: local-first apps with SQLite** (12h before Aug 21 — watch its
weekly ask re-pace as hours bank). Habits: daily stretch, 3×/week
strength workout, Friday invoicing.

- **Week of Jul 13** — normal Monday planning, then a Wednesday
  Northwind production incident: afternoon placements skipped, 5h of
  unplanned work logged retroactively, a missed Lumen meeting, blocks
  re-placed onto Thursday. Northwind ends the week 6h over its
  envelope (warns, never blocks). Saturday talk-prep hours placed
  outside the work window via `open_time`.
- **Week of Jul 20** — Tuesday sick day (`block_time` + skip/move of
  every placement), dentist and Lumen check-in cancelled upstream and
  pruned by the next morning's mirror-sync (`sync_log` rows 4),
  2h pulled from Lumen to Studio (`envelope_moves`), a report that ran
  over confirmed with amended minutes.
- **Week of Jul 27 (current)** — Monday through Thursday planned,
  worked, and confirmed. Friday is live: this morning's brief has run,
  and four work entries sit UNCONFIRMED awaiting the EOD wrap, with
  weekend goal blocks placed. A couple of deliberate loose ends are in
  there too (an unconfirmed workout from week 1, one workout still
  owed this week) — real usage always has drift.

## Using it

```bash
# GUI against the demo data (any port you like)
CALENDROME_DB=./demo/calendrome-demo.db PORT=3838 npm run gui

# MCP server against the demo data
CALENDROME_DB=./demo/calendrome-demo.db npm start
```

Copy the file somewhere else first if you plan to mutate it during a
demo and want a clean copy afterwards.
