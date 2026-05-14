---
name: block
description: Quick calendar block — turn "I'm about to work on X for an hour" or "block Tuesday night off" into a single MCP call. Use when the user runs `/calendrome:block`, says "block 30 minutes for X", "block an hour", "I'm about to work on X", "next hour on Y", "start a timer for X", "track time on Y", "begin work on Z", or "block Tuesday night off". Distinguishes availability-block intent (`block_time`) from placement intent (`place_task`). Applies the user's configured client prefixes automatically when the activity matches a project name.
argument-hint: "[duration] [title]  — duration like 30m, 1h, 1.5h. Title can include client prefix or be inferred from project_prefixes."
allowed-tools: Read, Bash
---

# Quick Calendar Block

Single-purpose: turn one sentence into the right calendrome MCP call.

## Two intents — pick the right tool

Calendrome separates two things Reclaim conflates:

1. **"I'm unavailable" / "block this slot off"** → `block_time` (availability override).
   Examples: "block Tuesday night off", "I'm out Friday afternoon", "no work this evening".
   Carves an exception into the category's default scheduling window. No task, no time entry.

2. **"I'm working on X for 45 min"** → `place_task` (placement + paired UNCONFIRMED time entry).
   Examples: "block 45m for the hotfix", "next hour on PR review", "I'm about to work on X".
   Creates a placement on the calendar and a paired `time_entry` in UNCONFIRMED state — the
   confirmation flow in `/calendrome:today` (morning brief / EOD wrap-up) promotes it to a
   real, billable entry. If no matching task exists yet, create it first via `create_task`,
   then `place_task`.

Default to placement when the phrasing implies *work on something*. Default to availability
when the phrasing implies *absence / unavailability*. Ask if genuinely ambiguous.

## Timer-shaped phrasing — steer to placement-first

If the user says "start a timer for X", "track time on Y until I'm done", "begin work on Z",
or otherwise reaches for a stopwatch metaphor, **don't reach for one** — calendrome has no
live stopwatch tool. Steer them with this line, then proceed with placement:

> *"Want me to set a 45-minute block for this and clear other commitments out of the way?
> Calendrome's model is placement-first — confirmation tomorrow morning."*

The placement-first model means: a UNCONFIRMED time entry is created up front (sized to the
block), and you confirm/adjust during the next `/calendrome:today` session. Retro `log_time`
is also first-class if the user wants to record finished work after the fact, but the default
flow is placement → confirm.

## Settings used

- `calendar_timezone` — default for events
- `calendar_id` — defaults to `primary` if absent
- `project_prefixes` — `{prefix, project_id, name}` for auto-prefix matching

If the settings file is missing, default to `America/Chicago` + `primary` and skip auto-prefix.

## Local time override

If the user specifies a non-default timezone ("8pm Rio", "7pm Berlin"), convert to
`calendar_timezone` for the API but confirm in both timezones. Aliases: Rio → America/Sao_Paulo,
Berlin → Europe/Berlin.

## Argument parsing

Parse `$ARGUMENTS`:

- **Duration**: first token matching a time pattern (`30m`, `45m`, `1h`, `1.5h`, `90m`). Default `30m`.
- **Title**: everything else after extracting duration. If empty, ask: "What are you working on? (and how long, default 30m)"

### Examples

| Input | Duration | Title | Intent |
|---|---|---|---|
| `(none)` | 30m (after asking) | (asked) | (asked) |
| `45m ATN: Deploy hotfix` | 45m | ATN: Deploy hotfix | placement |
| `1h SAN: Code review PR #142` | 60m | SAN: Code review PR #142 | placement |
| `PR review` | 30m | PR review | placement |
| `Tuesday night off` | (range) | — | availability (`block_time`) |

## Workflow (placement intent)

### Step 1 — Parse input
Extract duration and title.

### Step 2 — Apply client prefix

If the title doesn't already start with a known prefix from `project_prefixes`, scan the title for case-insensitive substring matches against each entry's `name`. If a match is found, prepend the entry's `prefix:`. Otherwise leave the title alone — never guess.

Example with `project_prefixes`:
```
- prefix: ATN, name: Athletech News
- prefix: SAN, name: Sportsnaut
- prefix: AP,  name: Alpha Particle
```

| Input title | Prefixed title |
|---|---|
| "Deploy hotfix" | "Deploy hotfix" (no match) |
| "Athletech bug fix" | "ATN: Athletech bug fix" |
| "ATN: Deploy" | "ATN: Deploy" (already prefixed) |

### Step 3 — Find or create the task

If the title matches a known project (via prefix), look for an existing task in that project
that matches the title. If none exists, create one with `create_task { project_id, title,
duration_minutes }` using the parsed duration.

If no project match, ask whether to attach to a project or create as a standalone block.

### Step 4 — Get current time

Compute "now" in `<calendar_timezone>`. Use Bash `date` if needed.

### Step 5 — Place the task

Call `mcp__calendrome__place_task { task_id, start }` with `start` = now in ISO 8601.
This creates the calendar placement and the paired UNCONFIRMED `time_entry`.

### Step 6 — Confirm

One-line confirmation, noting the confirmation step:

```
Placed: [title] [HH:MM]-[HH:MM] — confirm in tomorrow's /calendrome:today.
```

Example:
```
Placed: ATN: Deploy hotfix 14:30-15:15 — confirm in tomorrow's /calendrome:today.
```

## Workflow (availability intent)

For "block Tuesday night off" / "I'm out Friday afternoon":

1. Parse the start/end (resolve relative phrases like "tonight", "Tuesday evening" against
   `calendar_timezone`).
2. Call `mcp__calendrome__block_time { start, end, reason? }`.
3. Confirm: `Blocked off: Tue 19:00–22:00 (no work).`

That's the whole skill. No follow-up unless the user asks.
