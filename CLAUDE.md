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
  or recurring (20h/week for a client). The bucket is a **goal** —
  first-class, not a task convention: by-date ("10h before the
  event", the weekly ask re-paces as remaining ÷ weeks left) or
  weekly-refill ("3h of Spanish per week, forever"), done-ness is
  cumulative hours, and `min_chunk_minutes` keeps the planner from
  confetti-ing the bucket across tiny gaps.
- **Commitment taxonomy** (prototype): Task / Habit / Goal / Event
  are the four commitment types over the unified `time_entry`
  substrate, plus YNAB-for-time envelope budgeting — weekly
  assignments per envelope (`assign_hours`; NULL = snoozed) and
  zero-sum pulls (`pull_hours`, logged in `envelope_moves`). Spec:
  `docs/superpowers/specs/2026-07-17-commitment-taxonomy-design.md`
  (#106). Posture is parallel-run: the real DB keeps today's
  behavior until the new tools are used, the sandbox is the proving
  ground, and branch `pre-commitments` is the way back.
- The `/week` planner skill is the primary UX — collaborative weekly
  planning that pulls from Jira, Google Calendar, and calendrome.
- The GUI is an interactive weekly planner (React SPA + optional
  Tauri desktop shell): drag placements to move/resize, drag tasks
  from the panel to place them, complete/snooze/confirm/skip inline.
  Every GUI write goes through the same core functions as the MCP
  tools (`src/placement.ts`, `src/gui/mutations.ts`) — the two
  surfaces cannot drift. Claude conversations remain the planning
  brain; the GUI covers fast rearranging (#24, #86).
- Every project belongs to a **category** (`work`, `personal`, …).
  Categories own a default scheduling window — work is Mon-Fri 9-5,
  personal is evenings/weekends — shaping where the planner
  *suggests* hours land. **Windows are guidelines, not rules**: no
  placement is ever invalid for being outside one, and no `open_time`
  ceremony is needed first — scheduling outside the window *is* the
  override, and the hours self-supply (`scheduled_outside_minutes`
  in `get_supply`). Place it, mention the note in passing, move on.
  The GUI defaults to the work view so casual screen-shares never
  leak personal stuff.
- **Availability overrides** carve exceptions into those windows.
  `block_time` reserves a slot ("Tuesday night, nothing"); `open_time`
  announces an extra one ahead of time ("Saturday morning is fair
  game") so suggestions and supply see it — an announcement, never
  permission. Both exist because Reclaim makes this a chore and we
  don't want to.
- Integrations (Harvest, Google Calendar sync) are separate from core.

## What we're still figuring out

- **Auto-scheduling:** Not sure yet. The current model is fully
  manual (Claude suggests, you approve). But some level of "just
  place this for me" might be valuable. TBD.
- ~~**How much GUI?**~~ Resolved (#86, #24): MCP-only hit its
  ceiling at fast rescheduling — round-tripping every block move
  through a conversation was real friction. The GUI is now
  write-capable for scheduling actions; task *creation* and planning
  still happen in conversation.
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
- **Calendar events synced in** — planner skills fetch the whole
  visible week from the Google Calendar MCP and push it via
  `sync_calendar_events` with a `window` — upsert + prune of
  cancelled meetings, never touching confirmed/placed rows (#93)
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

- `npm test` runs vitest (270+ tests); `npm run test:e2e` runs the
  Playwright browser tests (build first)
- `npm run build` compiles TS, builds the GUI SPA (Vite), copies
  schema.sql + docs.html, regenerates docs.json
- `npm start` launches the MCP server, `npm run gui` the web app;
  `npm run dev` is Vite HMR against a running GUI server
- `npm run tauri:build` produces the native desktop app (needs the
  Rust toolchain; run on the target machine)
- GUI write posture: binds 127.0.0.1, no CORS, non-local Origin
  writes rejected — see the `src/gui/server.ts` header
- Planner skill: `.claude/skills/week.md`
- When adding tools: update `src/mcp/tools/index.ts` + the surface
  check in `tests/mcp-tools.test.ts`
- Schema: `src/db/schema.sql` (idempotent `IF NOT EXISTS`)
- Commitments tools live in the `// -------- commitments (prototype)
  --------` section of `src/mcp/tools/index.ts`; envelope weeks are
  Monday ISO dates (`week_start`)
- **Keep the website in sync.** When changing how calendrome is
  installed, distributed, or invoked (MCP setup, plugin install,
  slash command names), update `website/index.html` (§install) and
  `website/docs.html` in the same change. The install section is
  the user's first impression — drift is costly. Treat it as part
  of the wrap-up checklist on any PR that touches install/skills.
