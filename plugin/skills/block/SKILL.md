---
name: block
description: Quick calendar block — create a Google Calendar event starting now for ad-hoc work. Use when the user runs `/calendrome:block`, says "block 30 minutes for X", "block an hour", "I'm about to work on X", "next hour on Y", or wants to capture ad-hoc time without leaving the conversation. Applies the user's configured client prefixes automatically when the activity matches a project name.
argument-hint: "[duration] [title]  — duration like 30m, 1h, 1.5h. Title can include client prefix or be inferred from project_prefixes."
allowed-tools: Read, Bash
---

# Quick Calendar Block

Single-purpose: turn "I'm about to work on X for an hour" into a calendar event in one step.

## Settings used

- `calendar_timezone` — default for events
- `calendar_id` — defaults to `primary` if absent
- `project_prefixes` — `{prefix, project_id, name}` for auto-prefix matching

If the settings file is missing, default to `America/Chicago` + `primary` and skip auto-prefix.

## Local time override

If the user specifies a non-default timezone ("8pm Rio", "7pm Berlin"), convert to `calendar_timezone` for the API but confirm in both timezones. Aliases: Rio → America/Sao_Paulo, Berlin → Europe/Berlin.

## Argument parsing

Parse `$ARGUMENTS`:

- **Duration**: first token matching a time pattern (`30m`, `45m`, `1h`, `1.5h`, `90m`). Default `30m`.
- **Title**: everything else after extracting duration. If empty, ask: "What are you working on? (and how long, default 30m)"

### Examples

| Input | Duration | Title |
|---|---|---|
| `(none)` | 30m (after asking) | (asked) |
| `45m ATN: Deploy hotfix` | 45m | ATN: Deploy hotfix |
| `1h SAN: Code review PR #142` | 60m | SAN: Code review PR #142 |
| `PR review` | 30m | PR review |

## Workflow

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

### Step 3 — Get current time

Compute "now" in `<calendar_timezone>`. Use Bash `date` if needed.

### Step 4 — Create event

`mcp__claude_ai_Google_Calendar__create_event` with:
- `calendarId`: `<calendar_id>`
- `summary`: prefixed title
- `start.dateTime`: now in ISO 8601 with `<calendar_timezone>` offset
- `start.timeZone`: `<calendar_timezone>`
- `end.dateTime`: now + duration
- `end.timeZone`: `<calendar_timezone>`

### Step 5 — Confirm

One-line confirmation:

```
Blocked: [title] [HH:MM]-[HH:MM]
```

Example:
```
Blocked: ATN: Deploy hotfix 14:30-15:15
```

That's the whole skill. No follow-up unless the user asks.
