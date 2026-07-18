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

| Type | Ask | Done-ness | Mobility |
| --- | --- | --- | --- |
| **Task** | Estimate (`duration_minutes`); may run over or under | Definitive *finished* | Blocks float freely |
| **Habit** | Frequency × duration (daily 15 min) | Per-instance: did it or skipped it; never "finishes" | Only **within its frequency range**; outside the range it's not a move, it's a skip |
| **Goal** | Target ÷ time: *by-date* (10h before the event → remaining ÷ weeks left) or *recurring refill* (5h/week, no end) | **Cumulative** — hours poured into the bucket | Fully floating; only the total matters |
| **Event** | None — it takes hours off the supply | Attended or not; calendrome doesn't track it | Externally owned (Google Calendar) |

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
make Wednesday 30 minutes long — that would make it a Goal.

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

### Event

**Any externally scheduled event** — kept deliberately broad, not
gcal-specific. gcal-sync is today's source, but the type is "something
outside calendrome claimed this slot." Occupies supply, tracked for
meeting time, owned elsewhere. No change.

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
**YNAB-style budget view** as a peer of the weekly timeline. Rows are
envelopes (projects / goals / habits); columns are assigned /
scheduled / spent / available; over- and under-funded rows glow the
way budget cards do today; the pull is a drag between rows or one
sentence. Same data, opposite projection: the calendar answers
"when," the budget view answers "where is my week going." This also
raises the bar on docs/website/UI generally — the model has to be
*legible*, not just implemented.

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

## Resolved in review round 1 (2026-07-18)

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

## Open questions

1. **Type-level naming.** "Goal" vs "target"; whether the "habit"
   type keeps its Reclaim-heritage name.
2. **Is Habit a distinct type or a Goal flavor?** A habit is nearly a
   recurring-refill goal with a fixed slot and per-instance
   done-ness — and the new N-per-week target form sits right between
   them. The done-ness semantics (did-today vs. hours-this-week)
   still argue they're genuinely different; the workout case will be
   the test.
3. **Where does an assignment live?** In plain terms: when you say
   "ACME gets 12h this week," some row has to remember that sentence
   for that week. Today the closest shape is #100's proposed
   `budget_overrides (project_id, week_start, budget_minutes)` — one
   row per project per week. The question is whether to build that
   same three-column idea once, generally — `assignments (envelope,
   week, minutes)` where an envelope can be a project *or* a goal
   *or* a habit — so caps, overrides, snoozes, and target funding are
   all the one mechanism instead of four parallel tables.
4. **Budget-view shape.** What the YNAB-style view shows at v1 and
   how the pull gesture works there (drag between rows vs.
   conversational only).

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
