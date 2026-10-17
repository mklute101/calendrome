# Demo database

`calendrome-demo.db` is a fully populated calendrome dataset for demos
and screen-shares. It was not seeded: `play-demo.mjs` plays three
simulated weeks of real usage through the MCP tool path (the same
handlers Claude calls), one planning session and one daily wrap at a
time, moving a simulated clock (`CALENDROME_NOW`) between steps. Every
row was written by `place_task` / `confirm_placement` /
`sync_calendar_events` / `log_time` / habit, goal and envelope calls,
never by hand-inserted SQL.

Everything in it is fictional. "Today" inside the dataset is **Friday
2026-10-16, 08:45 New York time**; the further real time drifts past
that date, the staler the week views will look.

## The story

Avery Quinn is a senior brand strategist at Halcyon & Hart, a big-city
agency. Work is capped tight and keeps overrunning. Weekends belong to
Maple Hollow, a small town two hours upstate with a farmers market, a
pumpkin patch and an inn whose pie recipe Avery is determined to learn.
Yes, it is that movie: the city professional rediscovers small-town
life, and the big pitch is due the Friday before the Harvest Festival.

| Project | Prefix | Weekly budget | Category |
|---|---|---|---|
| Aurelia Luxe rebrand | LUXE | 20h | work |
| Holiday campaign pitch | PITCH | 8h | work |
| Agency ops | OPS | 3h | work |
| Maple Hollow | HOLLOW | none | personal |
| Wellness | WELL | none | personal |

Both categories run on `America/New_York`. Work's window is Mon-Fri
09:00-18:00; personal's is weekends only, so weeknight pie practice and
phone calls land outside it and self-supply (the tool says so in a
`note`, and places them anyway).

Goals:

- **Pumpkin patch season**: by-date, 12h before Nov 2, with a 3h
  `min_chunk_minutes` (the drive is half the trip). Watch the weekly ask
  re-pace as hours bank: 144m in the week of Sep 28, 120m on Oct 5, 80m
  on Oct 12. The planner places full 3h chunks even when the ask is
  smaller, and a 1h "cider stop" placed on Friday comes back with a
  minimum-chunk note.
- **Learn the Hollow Inn pie**: weekly refill, 90m, 45m minimum chunk.

Habits: Saturday farmers market (fixed day), Call Aunt Dot (2x/week),
Morning run (3x/week). The N-per-week habits slide within their week
to the day they actually happen.

- **Week of Sep 28**: first week on the plan. The Aurelia Luxe client
  escalates on Wednesday (2.5h logged after the fact, outside the work
  window), the workshop runs long, and the rebrand ends 23.5h of 20h:
  overspent, warned, never blocked. The pie evening slides to Thursday
  and only gets an hour. Saturday's first trip to the patch runs an
  hour over its block.
- **Week of Oct 5**: the overrun gets named up front this time:
  `assign_hours` gives the rebrand 22h, plus a 1h `pull_hours` from the
  pitch (Recent Moves). It still ends 24h of 23h. An agency dinner is
  `block_time`d, the Thursday pie block is skipped and rescheduled to
  Sunday, and a Saturday-morning fire drill eats the farmers market.
  The Tuesday run was never wrapped and is still pending (so is next
  Tuesday's): real usage has drift.
- **Week of Oct 12 (current)**: pitch week. 4h pulled from the
  rebrand to the pitch, agency ops snoozed for the week (`minutes:
  null`), and the pitch still overruns: 18.5h of 12h after a late
  Thursday rewrite. The client cancels Thursday's check-in upstream
  and Wednesday's re-sync prunes it (`sync_log`). Friday is live: the
  morning brief has run, the pitch presentation and two work blocks
  sit UNCONFIRMED, `open_time` frees Friday afternoon for the drive
  up, and the Harvest Festival weekend is placed (two 3h pumpkin
  blocks, the market, a call with Aunt Dot).

Budgets are standing envelope assignments (#173), so
`get_project_budget`, `get_all_budgets` and `get_envelopes` all read
the week's assignment the same way: an explicit week row when one was
assigned or pulled, else the project's standing cap.

## Using it

```bash
# GUI against the demo data (any port you like)
CALENDROME_DB=./demo/calendrome-demo.db PORT=3838 npm run gui

# MCP server against the demo data; pin the clock to the dataset's "today"
CALENDROME_DB=./demo/calendrome-demo.db CALENDROME_NOW=2026-10-16T12:45:00Z npm start
```

Copy the file somewhere else first if you plan to mutate it during a
demo and want a clean copy afterwards.

## Rebuilding it

```bash
npm run build
CALENDROME_DB=./demo/calendrome-demo.db node demo/play-demo.mjs --overwrite
```

The script prints each week's goal pacing and budget rollup, plus every
`note` the tools returned along the way. Event ids from the local
calendar client are random, so a rebuild is equivalent, not
byte-identical.
