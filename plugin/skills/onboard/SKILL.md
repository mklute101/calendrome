---
name: onboard
description: First-run guided setup for calendrome and re-onboarding workflows. Use when the user runs `/calendrome:onboard`, says they want to "set up calendrome", "configure calendrome", "add a new client to calendrome", "reset calendrome", or wants to "demo calendrome to someone". Walks through MCP install, connection-first discovery (Jira/Harvest/Google Calendar), category/project/budget setup, and writes the user's `.claude/calendrome.local.md` settings file.
argument-hint: "(no args)"
allowed-tools: Read, Write, Edit, Bash
---

# Calendrome Onboarding

This skill is the entry point to a fresh calendrome install and the place users return to when they want to add projects, edit settings, reset, or spin up a demo.

The flow is **state-aware**: detect what's already configured, then branch.

## Phase 1: Detect Current State

Run these checks in parallel before talking to the user:

1. **Settings file**: Does `.claude/calendrome.local.md` exist in the current project? (Read it if so.)
2. **MCP configuration**: Read `~/.claude.json` and check for a `calendrome` entry under `mcpServers`. Note whether the calendrome MCP is wired.
3. **Calendrome state** (only if MCP is wired and reachable): Call `mcp__calendrome__list_projects` and `mcp__calendrome__list_categories`. Project count > 0 means there's real configuration.
4. **Other integrations** (read `~/.claude.json` `mcpServers`): note presence of `atlassian`, any `harvest*`, `claude_ai_Google_Calendar`, etc.

Classify into one of:

| State | Settings file? | MCP wired? | Projects? | Branch |
|---|---|---|---|---|
| **First-run** | no | no | n/a | → Phase 2: Real Setup |
| **Partial-MCP** | no | yes | 0 | → Phase 2 step 3 onward (skip MCP install) |
| **Re-run** | yes | yes | >0 | → Phase 3: Re-run Menu |
| **Drift** | mixed | mixed | mixed | Show what's detected, ask user to choose: Real Setup or Re-run Menu |

## Phase 2: Real Setup (first-time)

### Step 1 — MCP install (skip if already wired)

1. Ask: "Where would you like to install calendrome?" Default: `~/dev/tools/calendrome`. Accept any directory.
2. Run via Bash, in sequence:
   - `git clone https://github.com/mklute101/calendrome <target>` (skip if directory exists)
   - `cd <target> && npm install`
   - `npm run build`
3. Register the MCP with Claude Code using the official CLI command (matches the website's install instructions):

```bash
cd <target>
claude mcp add calendrome \
  --env CALENDROME_DB="$PWD/calendrome.db" \
  -- node "$PWD/dist/src/mcp/server.js"
```

Verify with `claude mcp list`.

4. Tell the user: "Restart Claude Code, then reply when ready so we continue."

Do not edit `~/.claude.json` directly. The `claude mcp add` command is the canonical path; manual JSON editing is brittle and unnecessary.

### Step 2 — Connection-first discovery

Re-read `~/.claude.json` `mcpServers`. Show the user what was found:

```
Detected MCP integrations:
- atlassian: yes (Jira/Confluence)
- claude_ai_Google_Calendar: yes
- harvest: not detected

Anything missing or wrong?
```

Ask the user to confirm. For each integration the user confirms is active, prepare to short-circuit a setup question later.

### Step 3 — Write settings file

Create `.claude/calendrome.local.md` in the user's current project directory (or wherever they prefer for cross-project use; default: project-local).

For each integration, ask only the questions that integration needs:

- **Atlassian present** → ask for cloud ID and account ID. (Tip: if the user has an `atlassian` MCP, suggest they run `mcp__atlassian__atlassianUserInfo` and `mcp__atlassian__getAccessibleAtlassianResources` to fetch these.)
- **Google Calendar present** → ask for primary calendar timezone (default: infer from system). Calendar ID defaults to `primary`.
- **Always** → ask for personal email (used for task context lookups).

Write the file using this template (see `references/settings-schema.md` for the full schema):

```markdown
---
atlassian_cloud_id: <value or empty>
atlassian_account_id: <value or empty>
calendar_timezone: America/Chicago
calendar_id: primary
jira_project_keys: []
project_prefixes: []
project_repos: {}
calendrome_repo_path: <target from step 1>
mcp_configured: true
default_work_hours:
  days: [1, 2, 3, 4, 5]
  start: "09:00"
  end: "17:00"
personal_email: <value>
---

# Calendrome Settings

Per-user configuration for the calendrome plugin. Edit values above; the
markdown body is free-form notes.
```

### Step 4 — Categories + working hours

Calendrome auto-creates `work` and `personal` categories on first DB init (see `src/db/migrate.ts`). Confirm with the user:

> "By default, work runs Mon–Fri 9–5 and personal runs evenings/weekends. Want to adjust either?"

If yes, call `mcp__calendrome__update_category` with the new `default_window` JSON.

### Step 5 — Project import (connection-driven)

Branch on detected integrations:

- **Jira detected**: Call `mcp__atlassian__getVisibleJiraProjects` (or have user supply a JQL). Show the list, ask which projects to bring into calendrome. For each chosen project: ask for weekly budget (hours), call `mcp__calendrome__create_project` with `id` (lowercase prefix), `name`, `prefix` (uppercase), `weekly_budget_minutes`, `category_id: "work"`.
- **Harvest detected**: List Harvest projects (use Harvest MCP if available; otherwise ask user to paste). Same import flow.
- **Neither**: Ask the user: "What client/area do you want to track? (id, name, weekly hours, prefix)" Repeat until done.

For each created project, also write a row to `project_prefixes` in the settings file:
```yaml
project_prefixes:
  - prefix: ACME
    project_id: acme
    name: Acme Corp
```

### Step 6 — Done

Show the output of `/calendrome:status` so the user sees their fresh state. Suggest next steps:
- `/calendrome:week` to plan the week
- `/calendrome:today` for daily working sessions
- `/calendrome:block` for ad-hoc time blocks

## Phase 3: Re-run Menu (state already exists)

Show the user the current state and offer four options:

```
Calendrome is already configured.

Current state:
- Projects: 4 (acme, glbx, hobby, internal)
- Settings file: .claude/calendrome.local.md
- MCP: wired

What would you like to do?

1. Add a new project
2. Edit settings (atlassian IDs, working hours, etc.)
3. Full reset (wipe DB and start over) — destructive
4. Demo calendrome to someone (spins up a throwaway sandbox)
```

### Option 1 — Add a new project

Run only Phase 2 step 5 for a single new project. Append to `project_prefixes` in the settings file.

### Option 2 — Edit settings

Open `.claude/calendrome.local.md` and walk the user through each field. Use the Edit tool to apply changes.

### Option 3 — Full reset

**Confirm twice.** Then:
1. Stop the running calendrome MCP if needed (warn the user — they may need to restart Claude Code).
2. `mv <calendrome_repo_path>/calendrome.db <calendrome_repo_path>/calendrome.db.bak-reset-<timestamp>`
3. Restart at Phase 2 step 3 (skip MCP install).

### Option 4 — Demo mode

Defer to `/calendrome:sandbox`. Suggest the user run:

```
/calendrome:sandbox demo
```

This spins up a throwaway calendrome instance on an alt port + alt DB, pre-seeded with realistic-looking demo data. The user's real calendrome stays untouched.

## Critical guardrails

- **Never edit `~/.claude.json` automatically.** Always print the JSON block and ask the user to paste it. (Auto-editing the user-level Claude Code config without explicit consent is overreach.)
- **Never delete the calendrome DB without two confirmations.**
- **Never write PII into the plugin repo itself** — only into the user's project-local settings file.
- **Skip steps with explanation** when their preconditions are already met. Do not re-ask questions whose answers are already in the settings file.

## Additional resources

- `references/settings-schema.md` — full settings file schema and field reference

The first version of this skill keeps detail in SKILL.md; refactor to references/ once the conversational flow stabilizes (see calendrome issue #15).
