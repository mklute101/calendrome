---
name: onboard
description: First-run guided setup for calendrome and re-onboarding workflows. Use when the user runs `/calendrome:onboard`, says they want to "set up calendrome", "configure calendrome", "add a new client to calendrome", "reset calendrome", or wants to "demo calendrome to someone". Walks through MCP install, connection-first discovery (Jira/Harvest/Google Calendar), category/project/budget setup, and writes the user's `~/.claude/calendrome.local.md` settings file.
argument-hint: "(no args)"
allowed-tools: Read, Write, Edit, Bash
---

# Calendrome Onboarding

This skill is the entry point to a fresh calendrome install and the place users return to when they want to add projects, edit settings, reset, or spin up a demo.

The flow is **state-aware**: detect what's already configured, then branch.

## Phase 1: Detect Current State

Run these checks in parallel before talking to the user:

1. **Settings file**: Does `~/.claude/calendrome.local.md` exist? (Read it if so.) Also check for a legacy project-local `.claude/calendrome.local.md` in the current directory — if one exists and the global file doesn't, offer to move it to `~/.claude/calendrome.local.md` before anything else.
2. **MCP configuration**: Read `~/.claude.json` and check for a `calendrome` entry under `mcpServers`. Note the path it points to (e.g. the `args[]` value ending in `dist/src/mcp/server.js`) and whether that path still exists on disk.
3. **Source directory**: If the settings file (from step 1) has `calendrome_repo_path`, check that path. Otherwise check the default (`~/dev/tools/calendrome`) plus any path inferred from the MCP config (step 2). Record: source-present? and `dist/src/mcp/server.js` built?
4. **Calendrome state** (only if MCP is wired and reachable): Call `mcp__calendrome__list_projects` and `mcp__calendrome__list_categories`. Project count > 0 means there's real configuration.
5. **Other integrations** (read `~/.claude.json` `mcpServers`): note presence of `atlassian`, any `harvest*`, `claude_ai_Google_Calendar`, etc.

Classify into one of:

| State | Settings file? | MCP wired? | Projects? | Branch |
|---|---|---|---|---|
| **First-run** | no | no | n/a | → Phase 2: Real Setup |
| **Partial-MCP** | no | yes | 0 | → Phase 2 step 3 onward (skip MCP install) |
| **Re-run** | yes | yes | >0 | → Phase 3: Re-run Menu |
| **Drift** | mixed | mixed | mixed | Show what's detected, ask user to choose: Real Setup or Re-run Menu |
| **MCP-stale** | varies | yes, but path missing | n/a | → Phase 2 step 1, sub-state "Re-register" |

The MCP-stale case happens when the user's `~/.claude.json` still references a calendrome path that no longer exists (e.g. they moved or deleted the source directory). Do not silently ignore — it surfaces as `mcp__calendrome__*` tools either failing on call or being absent. Treat as MCP-not-wired for routing purposes, but tell the user what was detected so they can confirm.

## Phase 2: Real Setup (first-time)

### Step 1 — MCP install (skip if already wired and source path resolves)

The user's first impression. Make it solid. There are several legitimate starting points; detect first, then act.

#### 1a — Pre-flight checks

Before touching anything, verify the user's environment can complete the install. Run these in parallel:

- `node --version` — must be `v20.0.0` or higher (calendrome requires Node 20+)
- `git --version` — must succeed
- `npm --version` — must succeed
- `which claude` — Claude Code CLI must be on PATH (it should be, since the user is using it now, but verify)

If any fail, stop and tell the user exactly which tool is missing or out of date and how to install it. Do **not** plough ahead — half-installed states are worse than no install.

#### 1b — Determine sub-state

Using the source-present and built flags from Phase 1, plus the result of step 2 (MCP wired? path resolves?), pick a sub-state:

| Sub-state | Source dir? | Built? | MCP registered? | Action |
|---|---|---|---|---|
| **Full install** | no | n/a | no | clone → npm install → npm run build → register |
| **Build-only** | yes | no | no | (skip clone) npm install → npm run build → register |
| **Register-only** | yes | yes | no | (skip clone, skip build) register |
| **Re-register** | yes | yes | yes (stale path) | unregister → register with correct path |
| **Skip** | yes | yes | yes (path resolves) | nothing to do; jump to Step 2 |

Tell the user which sub-state was detected before acting. Example: *"You already have calendrome cloned at `~/dev/tools/calendrome` and built — I'll just register the MCP and we'll skip the clone and build."*

#### 1c — Resolve the install path

If sub-state is **Full install**, ask the user where to clone:

> "Where should I install calendrome? [default: `~/dev/tools/calendrome`]"

If the user picks a path that already exists, check whether it's a valid calendrome clone:

- Is there a `.git/config` with `https://github.com/mklute101/calendrome`?
- Does `package.json` have `"name": "calendrome"`?

If yes → switch to **Build-only** or **Register-only** sub-state and continue. If no → tell the user the directory exists and is not a calendrome clone, ask them to pick a different path. Do **not** clone over an existing non-calendrome directory.

#### 1d — Run install commands

Based on sub-state, run the appropriate commands via Bash. Run them sequentially, not in parallel, and check the exit code of each.

**Full install:**
```bash
git clone https://github.com/mklute101/calendrome <target>
cd <target>
npm install
npm run build
```

**Build-only:**
```bash
cd <target>
npm install
npm run build
```

**Register-only:** skip directly to step 1e.

If `npm install` or `npm run build` fails, stop and surface the error to the user with one of the troubleshooting hints from `references/install-flow.md`. Do not retry silently. Do not proceed to MCP registration with an unbuilt source — `claude mcp add` will succeed but the MCP itself will fail to start when Claude Code tries to launch it.

#### 1e — Register the MCP

Run the canonical `claude mcp add` command (matches the website's manual-install copy):

```bash
cd <target>
claude mcp add calendrome \
  --env CALENDROME_DB="$PWD/calendrome.db" \
  -- node "$PWD/dist/src/mcp/server.js"
```

For **Re-register** sub-state, first remove the stale entry:
```bash
claude mcp remove calendrome
```
Then run the add command above with the correct path.

Verify with `claude mcp list`. Confirm to the user that calendrome appears in the list with the expected absolute path.

Do **not** edit `~/.claude.json` directly. The `claude mcp add` command is the canonical path; manual JSON editing is brittle and unnecessary.

#### 1f — Restart boundary

MCP changes do not hot-load. The MCP server isn't actually reachable from this session even though it's registered. Tell the user:

> "Calendrome's MCP is installed and registered. **Restart Claude Code** to pick it up — quit fully (Cmd-Q on Mac) and relaunch. Then run `/calendrome:onboard` again from any directory and I'll continue from where we left off (Step 2: connection-discovery)."

Do **not** continue past this point in the same session. The state machine in Phase 1 will route the post-restart run to **Partial-MCP** (since the settings file still doesn't exist) and skip directly to Step 2. That's by design.

For deeper troubleshooting (failure modes, idempotency edge cases, what to do when `claude mcp add` rejects), see `references/install-flow.md`.

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

Create `~/.claude/calendrome.local.md` — global, exactly one per user. Settings are never project-local: there's one calendar, one set of clients, one Harvest account, regardless of cwd.

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
- Settings file: ~/.claude/calendrome.local.md
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

Open `~/.claude/calendrome.local.md` and walk the user through each field. Use the Edit tool to apply changes.

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

- **Never edit `~/.claude.json` directly.** Use `claude mcp add` and `claude mcp remove` for MCP registration changes — they edit the file safely and survive Claude Code upgrades. Never write to `~/.claude.json` with the Edit or Write tools.
- **Never delete the calendrome DB without two confirmations.**
- **Never write PII into the plugin repo itself** — only into the user's global settings file (`~/.claude/calendrome.local.md`).
- **Skip steps with explanation** when their preconditions are already met. Do not re-ask questions whose answers are already in the settings file.
- **Stop at the restart boundary in Step 1f.** MCP changes don't hot-load. Continuing past it in the same session will fail in confusing ways.

## Additional resources

- `references/settings-schema.md` — full settings file schema and field reference
- `references/install-flow.md` — Step 1 troubleshooting: pre-flight failures, idempotency cases, and what to do when install commands fail

The first version of this skill keeps detail in SKILL.md; refactor to references/ once the conversational flow stabilizes (see calendrome issue #15).
