# Commitment taxonomy + time-envelope budgeting — design

**Date:** 2026-07-17
**Status:** Draft to play with — review round 1 (2026-07-18 PR comments) folded in; resolved points moved out of Open questions
**Tracking issue:** [#106](https://github.com/mklute101/calendrome/issues/106)
**Reframes:** [#103](https://github.com/mklute101/calendrome/issues/103) (habit interaction model — the question that triggered this)
**Builds on:** [#99](https://github.com/mklute101/calendrome/issues/99), [#100](https://github.com/mklute101/calendrome/issues/100) (budget caps), the [2026-05-13 time-entry unification](./2026-05-13-time-entry-unification-design.md)

---

## Problem

Calendrome's primitives grew ad hoc, and #103 exposed the seam. Habit
blocks and task placements sit on the same timeline with different
capabilities, and the "right" interaction model for a habit block turns
out to be unanswerable at the habit level — it depends on what a habit
*is*, which was never written down.

Three symptoms of the same gap:

1. **The bucket is a convention, not a concept.** CLAUDE.md: "The
   bucket is just a task with a large duration and a due date." That
   works until you ask what "done today" means for it, or want the
   planner to pace it ("10h before the event" implies ~3h/week — where
   does that number live?).
2. **No primitive models a floor.** Budgets are per-project *ceilings*
   (warn when over). "Spend at least 5h/week on prospecting, whenever
   it fits" — a *target* — has no home. The closest thing is
   `weekly_hours_target` in the `/week` skill settings, which never
   made it into the database.
3. **Budgets don't know the week's size.** Each cap is independent.
   Nothing represents the total supply of schedulable hours, so
   nothing can say "you've promised 46 hours to a 40-hour week."

The storage layer does **not** have this problem — the 2026-05-13
unification already collapsed everything on the timeline into one
`time_entry` table. The taxonomy question lives one level up: what
*generates* entries, and what "done" means for each kind.

## First principles

**1. A commitment type is a generator + done-ness tracker over
`time_entry` rows.** The timeline substrate stays exactly as unified.
Types differ on three axes only:

| Axis | Meaning |
| --- | --- |
| **Ask** | How the commitment requests hours from a week (fixed estimate, frequency × duration, target ÷ time remaining) |
| **Done-ness** | What completion means (definitive finish, per-instance did/skip, cumulative hours reached) |
| **Mobility** | How its blocks may move (float freely, only within a frequency range, irrelevant — only the total matters, externally owned) |
| **Chunking** | How the hours may be clumped (any size chunks, fixed instance-sized chunks that cannot combine, n/a) |

**2. The week has a computable hour supply.** Category scheduling
windows (work Mon–Fri 9–5, personal evenings/weekends) minus synced
meetings minus `block_time` reservations, plus `open_time` carve-outs.
No other time tool knows this; calendrome already stores every input.

Two properties of supply worth stating outright:

- **Supply is swaths, not blocks.** Open time *exists* without being
  scheduled — god forbid we schedule every little thing. Personal
  time especially is a broad swath that backs envelopes without ever
  materializing as calendar blocks. Scheduling is what commitments
  do *to* supply, not what supply is.
- **Supply is adjustable per week in one sentence.** "Short week,
  I'm off Friday" changes this week's supply without touching the
  standing windows — the same standing-config-vs-this-week split as
  budget overrides (#100), and the same friction floor as
  `block_time`. The windows are the default, never a marriage.

**3. Budgeting is reconciling asks against supply.** Every commitment
type produces a weekly ask. The sum of asks vs. the supply is the
planning conversation — visible on Monday, not discovered on Friday.

## The taxonomy

**Commitment** is the parent concept (ratified, review round 1): the
broad term for anything that claims your time. The four below are its
*types* — one `time_entry` shape on the timeline, distinguished only
by the three axes:

| Type | Ask | Done-ness | Mobility | Chunking |
| --- | --- | --- | --- | --- |
| **Task** | Estimate (`duration_minutes`); may run over or under | Definitive *finished* | Blocks float freely | Splittable; optional min chunk |
| **Habit** | Frequency × duration (daily 15 min) | Per-instance: did it or skipped it; never "finishes" | Only **within its frequency range**; outside the range it's not a move, it's a skip | **Non-combinable** — instance-sized chunks, spread out by definition |
| **Goal** | Target ÷ time: *by-date* (10h before the event → remaining ÷ weeks left) or *recurring refill* (5h/week, no end) | **Cumulative** — hours poured into the bucket | Fully floating; only the total matters | **Combinable** — big chunks fine; optional min chunk |
| **Event** | None — it takes hours off the supply | Attended or not; calendrome doesn't track it | Externally owned (Google Calendar) | n/a |

### Task

Unchanged from today. `duration_minutes` is the estimate, actuals come
from confirmed entries, `COMPLETE` is the finish line. The one change
is subtractive: a task is no longer overloaded to *also* be the bucket.

### Habit

The frequency range is the load-bearing rule, and it answers #103's
"this instance vs. the series" question without any of the
recurring-event this/following/all machinery:

- **Slide within the range = move.** A daily stretch can go from 7:00
  to 21:00 the same day. A Mon/Wed/Fri habit instance can slide within
  its own day.
- **Leave the range = skip.** "Move Tuesday's stretch to Wednesday" is
  not a move — Wednesday already has its own instance. Tuesday is a
  skip, full stop. Skips are counted, not hidden; the miss is data.
- The template (time, days, duration, project) is edited on its own
  surface, never by dragging an instance.

**Frequency can be a target, not a fixture.** The working-out case
(review round 1): the intent is "work out most days," the reality is
4 of 7. Pinning it to Mon/Tue/Thu/Sat and logging three skips a week
punishes honesty. So a habit's frequency comes in two forms:

- **Fixed days** (`days_of_week`, today's model): the 7:00 stretch,
  the Monday standup. Misses are per-day skips.
- **N-per-week target**: "work out 4×/week, any days." Instances
  materialize as *candidates* (or on demand); the week scores 4/4,
  3/4 — a frequency meter, not a skip list. Done-ness is still
  per-instance (you did *today's* workout); only the schedule is
  loose. The frequency range for mobility widens accordingly: an
  N-per-week instance can slide anywhere in its week.

A habit never finishes and never rolls over. Missing Tuesday does not
make Wednesday 30 minutes long — combining is exactly what a habit
*can't* do, and that (review round 2) is the crispest line between
Habit and Goal: **both can be buckets of hours; a habit's hours are
non-combinable** (you can't do the week's stretching in one sitting —
the spreading-out *is* the commitment), **a goal's hours combine
freely** (a rainy Saturday can drain half the prospecting bucket).

### Goal

The new type — CLAUDE.md's bucket promoted to a first-class concept,
with YNAB target semantics:

- **By-date:** "10h of prospecting before the event (Sept 12)." The
  weekly ask is `remaining ÷ weeks left`, recomputed as reality
  happens — fall behind and the ask grows, exactly like a YNAB
  by-date target. Definitive finish: the bucket fills or the date
  arrives.
- **Recurring refill:** "5h/week toward the newsletter, indefinitely."
  The envelope refills each week. This is the floor that has no home
  today — the inverse of a budget cap. Under-filling nags the way
  over-spending a cap does. The canonical live example (review round
  1): **Spanish practice** — already happening today, genuinely not
  about a finish line, just hours poured in per week.

A goal doesn't care *when* its hours happen. The planner drains it
into whatever slots fit; blocks placed against a goal are ordinary
placements that count toward the bucket when confirmed.

**Minimum chunk** (review round 2 — a Reclaim feature worth keeping):
a goal (or task) can declare `min_chunk_minutes` — "don't schedule
less than 2h of prospecting; anything shorter isn't worth the context
switch." The planner skips free slots smaller than the minimum rather
than confetti-ing the bucket across 20-minute gaps. Habits don't need
it: their chunk size is exactly the instance duration.

### Event

**Any externally scheduled event** — kept deliberately broad, not
gcal-specific. gcal-sync is today's source, but the type is "something
outside calendrome claimed this slot." Occupies supply, tracked for
meeting time, owned elsewhere. No change.

## The model on a real week (worked examples)

The taxonomy is only right if real commitments pass through it without
squinting. One of each, end to end:

**Daily stretch, 15 min — Habit, fixed days.**
Ask: 7 × 15 min = 1.75h/week. Done: did today's or skipped it.
Mobility: slides within its day; "move Tuesday's to Wednesday" is a
Tuesday skip. Chunking: seven 15-min chunks, non-combinable — a
105-minute Sunday stretch marathon is not the commitment.
Budget row: `Stretch — assigned 1.75h · activity 1.25h · 5/7`.

**Work out 4×/week — Habit, N-per-week target.**
Ask: 4 × duration, any days. Done: per-instance, scored as a weekly
meter (3/4), not as skips against days never promised. Mobility: an
instance slides anywhere in its week. Chunking: non-combinable — two
workouts back-to-back is still one workout.
Budget row: `Workout — 3/4 this week`, yellow at week's end if under.

**Spanish practice, ~3h/week — Goal, recurring refill.**
Ask: 3h refill each week, forever; no finish line by design. Done:
cumulative — hours poured in. Mobility/chunking: fully floating,
combinable; six 30-min sessions or one rainy-Saturday 3h block both
fill the envelope. Budget row: `Spanish — assigned 3h · activity 2h ·
1h more needed this week`.

**10h prospecting before the event — Goal, by-date.**
Ask: remaining ÷ weeks left, re-paced weekly (fall behind → the ask
grows — the "Quarterly Tax: $400 more needed this month" row in YNAB
terms). `min_chunk_minutes: 120` — no 20-minute confetti. Done: the
bucket fills or the date arrives. Budget row: funding-status line
driven by pace.

**Client retainer, 20h/week cap — the cap side of a project envelope.**
Not a new type: the project's assignment carries a ceiling (#99/#100).
Placements and confirmed hours are the activity; the row goes red at
21h. A "client paused this week" snooze is an unfunded envelope.

**The beautiful-day MTB afternoon — not a commitment, a pull.**
One sentence blocks the afternoon; the displaced work commitments'
envelopes get covered from personal supply by default, or something
gets snoozed and its hours consciously perish. Appears in Recent
Moves, undoable.

Nothing above needed a fifth type, and no example needed two types at
once — the seams hold so far. The stress case remains the workout
habit drifting toward "just make it 4h/week of movement" (a goal); if
that ever feels natural, the chunking line is where the argument
happens.

## The north star: envelope budgeting for time

The YNAB loop, translated honestly:

| YNAB | Calendrome |
| --- | --- |
| Income arrives | The week's hour supply is computed (windows − meetings − blocks) |
| Give every dollar a job | Assign supply to envelopes (projects / goals / habits) at the `/week` session |
| Category target | The commitment's ask (refill, by-date pace, frequency) |
| Overspending a category | An envelope's placed + confirmed hours exceed its assignment |
| **Cover it from another envelope** | **The pull: "take 2h from hobby, give it to ACME" — one sentence, zero-sum** |
| Credit-card float | Scheduling debt: more hours placed than the week holds |

The pull is the mechanic that matters. Today's budgets warn about
drift after the fact; you can nod at the warning and keep going —
which is exactly how "work expands to fill the time allotted." Under
envelope allocation the overage has to *come from somewhere*, and
naming the somewhere is the decision. The drift still happens if you
choose it — soft caps stay soft, YNAB-style, warn loudly never block —
but it can no longer happen *unconsciously*.

Where calendrome beats YNAB: YNAB makes you hunt for the money.
The `/week` planner is a brain — it can propose the pull ("HOBBY has
3h unassigned; or Thursday evening is open supply"). The friction
floor stays one sentence, per CLAUDE.md.

**Envelopes are fungible across categories** (ratified, review
round 1) — that's kinda the point. Category windows shape where the
planner *suggests* hours land; they are not walls between pools. The
canonical case is the spontaneity flow:

> It's beautiful out and you want to hit the mountain bike during
> work hours. One sentence — "taking the afternoon for MTB" — and the
> afternoon's work commitments need covering. By default the pull
> comes from personal time (tonight, the weekend); or you snooze
> something and *lose those hours*, consciously. Either way the
> tradeoff got named, which is the entire mechanic. The planner
> proposes the options; you pick in the same sentence or the next one.

Spontaneity is not an exception the model tolerates — it's a pull
like any other, and the one-sentence friction floor is what keeps a
beautiful day from turning into a settings exercise.

Existing budget work slots straight in:

- **#99 (monthly caps)** — a monthly assignment horizon alongside the
  weekly one; retainers are month-shaped envelopes.
- **#100 (snooze/override)** — an override is a re-funded envelope for
  one week; a snooze is an unfunded one. Same table, same semantics.

**Time differs from money in one place:** unspent hours perish.
There is no "roll over the envelope" — an unfilled refill goal just
nags; an unused assignment evaporates; by-date goals re-pace instead.
(Ratified, review round 1.)

### The budget view

The calendar is not the only honest way to look at this model
(review round 1): the envelope side wants its own surface — a
**YNAB-style budget view** as a peer of the weekly timeline. Same
data, opposite projection: the calendar answers "when," the budget
view answers "where is my week going."

V1 shape (review round 2): **just copy YNAB's category screen,
lowkey.** The mapping is nearly column-for-column:

| YNAB category screen | Calendrome budget view |
| --- | --- |
| Category rows in groups | Envelope rows (goals / habits / project caps) grouped by category or project |
| **Assigned** | Hours assigned this week |
| **Activity** | Hours scheduled + confirmed against the envelope |
| **Available** (colored pill) | Assigned − activity: green funded, yellow underfunded, red overspent |
| Funding-status line ("Overspent. $111.17 of $100.63" / "$400 more needed this month" / "On Track") | "Overspent: 11.5h of 10h" / "2h more needed this week" (target-derived) / "On track" |
| Progress bar under the name | Same, driven by the ask |
| **Recent Moves** + Undo/Redo | The pull history — every "take 2h from hobby" is a logged move, undoable |

That last row matters: YNAB's "Recent Moves" is the audit trail of
envelope transfers, which is exactly what pulls are. The budget view
is where pulls become visible, reviewable, and reversible.

This also raises the bar on docs/website/UI generally — the model has
to be *legible*, not just implemented.

## What this means for existing pieces

Deliberately incremental — no big-bang schema change is proposed here:

| Today | Under the taxonomy |
| --- | --- |
| `time_entry` + `habit_instances` sidecar | Unchanged — the substrate is already right |
| Bucket task (big duration + due) | Becomes a **Goal (by-date)**; tasks stop being overloaded |
| `weekly_hours_target` in skill settings | Becomes a **Goal (recurring refill)** in the database |
| `projects.weekly_budget_minutes` | The cap side of an envelope; assignment/target side grows alongside (#99/#100 compatible) |
| `habits` table + generation | Unchanged mechanically; gains the frequency-range mobility rule, the N-per-week target form, and a template-edit surface |
| "Calendar items" as the umbrella | **Commitments** (ratified); the four types are its flavors |

## Near-term work that survives regardless

From #103, these are taxonomy-proof and actionable now — no decision
in this doc changes them:

- `update_habit` / `deactivate_habit` MCP tools (core functions exist
  in `src/habits.ts`, unexposed). Deactivation should purge future
  PLANNED instances + their UNCONFIRMED entries; `week-data.ts` must
  stop regenerating for inactive habits (`listHabits(db, { active:
  true })`) or cleanup self-reverts.
- Habit-instance **complete/skip in the GUI** — mirrors the placement
  block's ✓/✕ affordance; closes the pending-review reachability gap
  (habit entries appear in `list_pending_review` but are untouchable
  in the GUI).
- Entry-level `confirm_placement` / `skip_placement` on habit-sourced
  entries should back-sync `habit_instances.status`, so both
  directions converge on the same end state.
- **Move within the frequency range** in the GUI (drag a habit block
  around its own day) — the mobility rule above already licenses it.

Deferred until this doc is ratified: detach-to-one-off (may be
unnecessary once Goals exist), template management in the GUI, any
renaming, all envelope mechanics.

## Data-model sketch (proposal — round-3 bait, not ratified)

The incremental shape that gets to the taxonomy without a big-bang
migration. Three moves:

**1. A `goals` table** — the one genuinely new entity. Tasks and
habits keep their tables; `time_entry` stays the substrate.

```sql
CREATE TABLE IF NOT EXISTS goals (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT NOT NULL REFERENCES projects(id),
  title             TEXT NOT NULL,
  target_minutes    INTEGER NOT NULL,       -- the bucket
  due               TEXT,                   -- by-date flavor; NULL = refill
  refill_period     TEXT,                   -- 'week' (v1); NULL = by-date
  min_chunk_minutes INTEGER,                -- Reclaim's "minimum hours"
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Placements against a goal are ordinary `time_entry` rows with a
`goal_id` (one nullable FK column added to `time_entry` — the same
sidecar move `habit_instances.time_entry_id` already made in the
unification). Confirmed minutes sum into the bucket exactly the way
`v_task_time_spent` works for tasks.

**2. Habits gain the N-per-week form** — `times_per_week INTEGER`
alongside `days_of_week` (exactly one set). Generation for the target
form materializes candidates on demand instead of per-day rows;
scoring is `COUNT(status='COMPLETE') / times_per_week` for the week.

**3. One `assignments` table answers "where does 12h-this-week
live"** — #100's `budget_overrides` built once, generally:

```sql
CREATE TABLE IF NOT EXISTS assignments (
  envelope_type  TEXT NOT NULL,             -- 'project' | 'goal' | 'habit'
  envelope_id    TEXT NOT NULL,             -- project id or goal/habit rowid
  week_start     TEXT NOT NULL,             -- Monday ISO date
  minutes        INTEGER,                   -- NULL = snoozed (unfunded)
  note           TEXT,
  PRIMARY KEY (envelope_type, envelope_id, week_start)
);
```

Caps, overrides, snoozes, and goal/habit funding are all this one
row shape. The standing config (`projects.weekly_budget_minutes`,
a goal's derived weekly ask, a habit's frequency ask) is the
*default*; an `assignments` row is *this week's word* — the same
standing-vs-this-week split as supply. Pulls are then just paired
writes to two rows in the same week, logged for Recent Moves
(`moves` table or an append-only log — v1 can defer this until the
budget view lands).

What this sketch deliberately does **not** do: rename anything,
touch `time_entry`'s shape beyond one nullable FK, merge habit/task/
goal tables into a `commitments` supertable (the umbrella is a
concept, not a table), or build supply computation (that's the
envelope milestone, not the taxonomy one).

**Compat posture (review round 3):** there is no backwards-compat
requirement — sole user, beta, freedom to do it right. The
incrementality above is an architecture choice (unified substrate,
separate generators — the same call the time-entry unification made),
*not* caution. Two consequences:

- **Parallel run, then decide.** The additive schema means the real
  DB keeps today's behavior while a sandbox DB runs the commitments
  model — same install, two worlds, for a couple weeks of real use.
  The radical part being tested is envelope budgeting (assigned
  supply, zero-sum pulls) vs. independent soft caps — a behavior
  change, not a storage one.
- **End-state cleanup, once ratified:** fold
  `projects.weekly_budget_minutes` into the assignments model as a
  standing target (no dual sources of truth), migrate existing
  bucket-tasks to goals outright rather than coexisting, and take
  any renames freely. Small breaking migrations, deliberately
  deferred — not silently abandoned.

## Resolved in review rounds 1–2 (2026-07-18)

1. **Umbrella naming** — the parent concept is **Commitment**; the
   four types are its flavors.
2. **Supply pools are fungible** — that's the point. Categories shape
   suggestions, not walls; MTB during work hours pulls from personal
   time or you snooze and consciously lose the hours.
3. **Rollover** — confirmed: time perishes. No envelope balances
   across weeks; by-date goals re-pace.
4. **Event stays broad** — any externally scheduled event, not
   gcal-specific.
5. **Open swaths matter** — supply exists without being scheduled,
   and must be adjustable per-week in one sentence (short week ≠
   config surgery).
6. **Habit and Goal stay distinct types, split by chunking** — both
   can be buckets of hours; a habit's hours are non-combinable
   (spreading out is the commitment), a goal's combine freely. New
   fourth axis: **Chunking**; plus `min_chunk_minutes` on
   goals/tasks (the Reclaim "minimum hours" feature).
7. **Budget view v1 = copy YNAB's category screen** — Assigned /
   Activity / Available columns, funding-status lines, colored
   pills, and Recent Moves as the pull history.

## Open questions

1. **Type-level naming.** "Goal" vs "target"; whether the "habit"
   type keeps its Reclaim-heritage name.
2. **Where does an assignment live?** Now proposed concretely as the
   `assignments` table in the data-model sketch above — one row shape
   for caps, overrides, snoozes, and goal/habit funding. Veto or
   ratify there.
3. **Pull gesture in the budget view** — drag between rows vs.
   conversational-only at v1 (YNAB does both; Recent Moves implies
   move-logging either way).

## Making it sing — roadmap from the prototype (round 4)

The prototype (PR #111) makes the model *operable* over MCP. What
makes it sing is two steps more: **visible** (envelope state is
ambient, not queried) and **tactile** (the pull is a gesture). In
rough order of leverage:

### M1 — Watchable (small; timeline polish)

- Goal blocks styled distinctly (bucket accent) with a progress chip
  ("4.5/10h") that updates as blocks confirm.
- Side panel grows a **Goals section**: title, progress bar, "Nh more
  needed this week", behind-pace glow. Habits get their weekly meter
  (●●●○ 3/4) in the panel.
- Header strip: `assigned 34h · confirmed 12h` for the week — the
  first ambient envelope signal, before the full budget view.

### M2 — Budget view v1 (the flagship; new `#/budget` route)

The YNAB category screen, hours edition (per round 2):

- Envelope rows grouped by category → project; columns **Assigned /
  Activity / Available**; funding-status line + colored pill;
  progress bar driven by the ask. Same week selector as the timeline.
- **Inline assign**: click the Assigned cell, type hours (YNAB's
  edit-in-place).
- **Click-to-pull**: click an underfunded/overspent pill → "Cover
  from…" menu listing envelopes with surplus → one click executes
  `pull_hours`. (Drag-between-rows can come later; the menu is
  YNAB's overspend flow and is 90% of the value.)
- **Recent Moves** panel: the `envelope_moves` log, newest first,
  each with an undo (reverse pull).
- All writes through `src/gui/mutations.ts` wrappers over the same
  core fns as the MCP tools — the no-drift rule holds.

### M3 — Tactile economy (the pull leaves the budget page)

- **Drag a goal from the panel onto the timeline** → creates a
  `place_goal_block` (default size: `min_chunk_minutes`, else the
  remaining weekly ask, else 1h).
- **Overspend-at-confirm**: confirming a block whose actual_minutes
  blows the envelope pops the same "Cover from…" toast — the pull
  offered at the moment of overspend, YNAB's overspend flow.
- N-per-week habit candidates render as light "candidate" blocks
  draggable anywhere in their week (the mobility rule made tactile;
  merges with the #103 mechanics track's complete/skip-on-block
  work).

### M4 — Supply (the "income" side becomes real)

- Compute the week's supply (category windows − events − blocks +
  open_time) and show **To Be Assigned** in the budget-view header:
  `supply 38h · assigned 34h · free 4h`, red when assigned > supply —
  scheduling debt made visible (YNAB's "you assigned more than you
  have").
- One-sentence per-week supply edits already exist (`block_time` /
  `open_time`); the header makes their effect legible.
- `/week` becomes the actual budget meeting: reconcile asks vs
  supply, propose assignments and pulls, surface the envelope table
  in the brief.

### M5 — Cutover (after the parallel run decides)

Per the compat posture: fold `projects.weekly_budget_minutes` into
assignments as standing targets, migrate bucket-tasks to goals,
settle names. The dashboard's budget cards retire in favor of the
budget view.

Deliberately not on this list: auto-scheduling (still
suggest-approve, per PLAN.md), and a min_chunk-aware free-slot
suggester (planner-skill work riding on `get_free_slots`, not GUI).

## References

- `CLAUDE.md` — three principles ("work expands to fill the time
  allotted" is the one this design attacks), bucket sentence,
  categories + availability model
- `PLAN.md` — habits as "recurring time blocks" (Reclaim heritage),
  estimate-vs-actual contract, budget semantics
- [2026-05-13 time-entry unification](./2026-05-13-time-entry-unification-design.md)
  — the substrate: one row per thing-on-the-calendar
- [#103](https://github.com/mklute101/calendrome/issues/103) — habit
  interaction model (the trigger; stays open, rescoped to mechanics)
- [#99](https://github.com/mklute101/calendrome/issues/99) /
  [#100](https://github.com/mklute101/calendrome/issues/100) — the cap
  side of envelopes, already YNAB-voiced
- YNAB target types (by-date / weekly refill) — the borrowed model
