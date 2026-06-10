---
name: status
description: Show calendrome status — projects, weekly budgets, active task count, and available commands. Use when the user runs `/calendrome:status`, says "show calendrome status", "what's calendrome doing", "calendrome dashboard", or asks about budget/projects/tasks state. Also serves as the help/dashboard entry point after onboarding.
argument-hint: "(no args)"
allowed-tools: Read, Bash
---

# Calendrome Status

Lightweight read-only dashboard over the calendrome MCP. Two output paths:

- **Empty install** → first-time setup pointer (suggest `/calendrome:onboard`)
- **Configured install** → status table + command reference

## Step 1: Check state

Read settings: `~/.claude/calendrome.local.md` (use defaults if missing).

Run these calendrome MCP tools in parallel:

- `mcp__calendrome__list_projects {}` — all configured projects
- `mcp__calendrome__get_all_budgets { week_start: "<this Monday's ISO date>" }` — weekly budget overview
- `mcp__calendrome__list_tasks {}` — active task counts (filter `status` NEW or SCHEDULED)

If the MCP is unreachable, tell the user: "Calendrome MCP is not responding. Check that it's running, and `~/.claude.json` has the calendrome entry. Run `/calendrome:onboard` if you haven't yet."

## Step 2: Decide output

If `list_projects` is empty → **First-time setup pointer**:

```
Calendrome is reachable but no projects exist yet.

Run `/calendrome:onboard` to walk through setup, or call
`mcp__calendrome__create_project` directly if you know what you want.
```

Otherwise → **Status dashboard**:

```
## Calendrome Status

### Projects (<N> configured)
| Project | Budget (weekly) | Spent | Scheduled | Remaining | Status |
|---------|----------------:|------:|----------:|----------:|--------|
| ...     | ...             | ...   | ...       | ...       | OK / OVER |

### Tasks
- Active: <count of NEW + SCHEDULED>
- In progress: <count with active time entries, if available>

### Available Commands
| Command | What it does |
|---|---|
| `/calendrome:week` | Weekly planning — calendar + JIRA + budgets unified |
| `/calendrome:today` | Daily working session — morning brief, active assist, EOD wrap |
| `/calendrome:block` | Quick "block this on my calendar starting now" |
| `/calendrome:onboard` | Re-run setup — add projects, edit settings, demo |
| `/calendrome:sandbox` | Throwaway calendrome instance for testing or demos |
| `/calendrome:harvest-push` | Push the week's time entries to Harvest, with a dry-run preview |

### Integrations
- Harvest: <configured if any project has harvest_project_id, else not configured>
- Calendar: <calendar_timezone from settings>
- Jira: <jira_project_keys from settings, comma-separated>
```

## Formatting rules

- Tables for budgets, bullets for action lists.
- Use the **current Monday** as `week_start` for budget queries (compute from today's date in the user's `calendar_timezone`).
- Keep the output one screen — this is a dashboard, not a tutorial.
- Status column: "OK" when remaining ≥ 0, "OVER" when negative.

## Edge cases

- Settings file missing but MCP reachable: show dashboard normally; mention "No `~/.claude/calendrome.local.md` found — run `/calendrome:onboard` to write one."
- Settings file present but MCP unreachable: surface the MCP error first; settings-only output is not useful.
