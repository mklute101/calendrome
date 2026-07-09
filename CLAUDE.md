# Calendrome

## Why this exists

Three principles:

**If it's not on the calendar, it's not real.** You can talk about
needing or wanting to do something, but until time is actually
allocated for it, it won't happen. Calendrome exists to make the gap
between "I should do this" and "this has 2 hours blocked on Tuesday"
as small as possible.

**Work expands to fill the time allotted.** Even when client work
drops, it still somehow takes all week — unless you budget
deliberately. Without explicit hour caps per project, low-priority
work absorbs every gap. Calendrome makes hour budgets visible so
you can see the drift and push back.

**Claiming and releasing time should be one sentence.** The thing
Reclaim gets wrong is making "Tuesday night I'm doing nothing"
into a settings exercise. In calendrome, that's one MCP call
(`block_time`) the planner skill makes from a single conversational
sentence. Same for "actually I'm free again" (`clear_availability`).
The friction-floor for adjusting your own schedule is a complete
sentence — never a click path.

## What we know

- Weekly hour budgets per project, YNAB-style: soft caps that warn
  loudly but never block. You decide what to do about overages.
- Tasks can be "fill the bucket" (30h total toward a certification)
  or recurring (20h/week for a client). The bucket is just a task
  with a large duration and a due date.
- The `/week` planner skill is the primary UX — collaborative weekly
  planning that pulls from Jira, Google Calendar, and calendrome.
- The GUI is a read-only dashboard. It shows the full picture but
  you plan via Claude conversations.
- Every project belongs to a **category** (`work`, `personal`, …).
  Categories own a default scheduling window — work is Mon-Fri 9-5,
  personal is evenings/weekends — so the planner knows which slots
  are eligible for which projects. The GUI defaults to the work view
  so casual screen-shares never leak personal stuff.
- **Availability overrides** carve exceptions into those windows.
  `block_time` reserves a slot ("Tuesday night, nothing"); `open_time`
  carves out an extra one ("Saturday morning is fair game"). Both
  exist because Reclaim makes this a chore and we don't want to.
- Integrations (Harvest, Google Calendar sync) are separate from core.

## What we're still figuring out

- **Auto-scheduling:** Not sure yet. The current model is fully
  manual (Claude suggests, you approve). But some level of "just
  place this for me" might be valuable. TBD.
- **How much GUI?** In an AI-tools world, does the dashboard need
  to be interactive? Or can MCP + Claude handle everything? The
  current bet is "start with MCP-only, see how far it goes, add
  GUI interactivity only when conversations can't."
- **Data store vs. orchestrator:** Right now calendrome never calls
  external services — the AI does that and pushes data in. But that
  line might move. If calendar sync should be automatic, calendrome
  needs to reach out on its own.
- **What is an AI tool?** Most tools assume a human clicking buttons.
  Calendrome is built for an AI to call via MCP. The implications of
  that are still unfolding — maybe we don't need a GUI at all, maybe
  we need a completely different kind of GUI.
- **Calendars for your AI:** Calendrome could be a shared schedule
  between you and your AI agents. Agent tasks alongside human tasks,
  same budget system, same timeline. You'd manage a team of one
  human + N agents, and the budget would track both.

## Architecture (current)

- **SQLite via better-sqlite3** — WAL mode, zero config
- **MCP stdio server** — low-level `Server` class with JSON schemas
- **GUI is a separate Express process** — reads same SQLite file,
  fresh DB connection per request for cross-process visibility
- **Skills are the UX layer** — `/week`, `/calendrome`, `/focus`
- **Calendar events synced in** — planner skill fetches from Google
  Calendar MCP, pushes into calendrome via `sync_calendar_events`
- **Harvest push is bulk** — one MCP call loops internally

## Conventions

- Prefixes are uppercase (`ACME`, `GLBX`), map 1:1 to `project.id`
- Dates are ISO 8601, stored as TEXT in SQLite
- Time is minutes internally, decimal hours in exports (1.25h = 75 min)
- `time_entry` range reads normalize `from`/`to` through
  `src/day-range.ts`: inclusive UTC day buckets, never raw string
  compares against `DATE(start_at)` (#92)
- `time_entry` timestamps are stored canonical UTC
  (`YYYY-MM-DDTHH:MM:SSZ`): every write path funnels through
  `toCanonicalUtc` in `src/day-range.ts`, and `migrate()` normalizes
  legacy mixed-form rows (#95)
- Tests use in-memory SQLite (`freshDb()`) — isolated, no cleanup
- No PII in the repo — fictional names, `<FILL IN>` markers in skills

## What Claude should know

- `npm test` runs vitest (110+ tests)
- `npm run build` compiles TS + copies schema.sql and GUI assets
- `npm start` launches the MCP server, `npm run gui` the web dashboard
- Planner skill: `.claude/skills/week.md`
- When adding tools: update `src/mcp/tools/index.ts` + the surface
  check in `tests/mcp-tools.test.ts`
- Schema: `src/db/schema.sql` (idempotent `IF NOT EXISTS`)
- **Keep the website in sync.** When changing how calendrome is
  installed, distributed, or invoked (MCP setup, plugin install,
  slash command names), update `website/index.html` (§install) and
  `website/docs.html` in the same change. The install section is
  the user's first impression — drift is costly. Treat it as part
  of the wrap-up checklist on any PR that touches install/skills.
