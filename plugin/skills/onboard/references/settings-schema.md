# Calendrome Settings Schema

The settings file lives at `~/.claude/calendrome.local.md` (global — exactly one per user, never project-local) and is consumed by all calendrome plugin skills. YAML frontmatter holds the values; the markdown body is free-form notes.

## Full template

```markdown
---
# Atlassian / Jira
atlassian_cloud_id: ""           # from getAccessibleAtlassianResources
atlassian_account_id: ""         # from atlassianUserInfo
jira_project_keys: []            # list of Jira project keys to scope queries to (optional)

# Google Calendar
calendar_timezone: America/Chicago
calendar_id: primary

# Projects — calendrome project setup mirrored here for prefix-matching
project_prefixes:
  - prefix: ACME                 # uppercase, used in task titles ("ACME: ...")
    project_id: acme             # lowercase, matches calendrome.projects.id
    name: Acme Corp              # used for substring matching in /calendrome:block
project_repos: {}                # optional: { "ACME": "/abs/path/to/repo" }

# Calendrome MCP
calendrome_repo_path: ~/dev/tools/calendrome
mcp_configured: false            # flipped to true by /calendrome:onboard

# Working hours
default_work_hours:
  days: [1, 2, 3, 4, 5]          # 0=Sun, 6=Sat
  start: "09:00"
  end: "17:00"

# Personal context
personal_email: ""               # for Gmail context lookups (read-only)
obsidian_vault: ""               # optional, for context reads
---

# Calendrome Settings

Free-form notes about your setup. The plugin reads only the YAML above.
```

## Field reference

| Field | Required | Used by | Notes |
|---|---|---|---|
| `atlassian_cloud_id` | Conditional | `today`, `week` | Required if Jira integration is in use |
| `atlassian_account_id` | Conditional | `today`, `week` | Required if Jira integration is in use |
| `jira_project_keys` | No | `week` | Scopes JQL to specific projects |
| `calendar_timezone` | Yes | all calendar skills | IANA tz name (e.g. `America/Chicago`) |
| `calendar_id` | Yes | all calendar skills | Defaults to `primary` |
| `project_prefixes` | Yes (can be empty) | `today`, `week`, `block` | Each entry: `{prefix, project_id, name}` |
| `project_repos` | No | `today`, `week` | Map of prefix → absolute repo path for code-task readiness |
| `calendrome_repo_path` | Yes | `sandbox`, `onboard` | Absolute path to the calendrome installation |
| `mcp_configured` | Yes | `onboard` | `false` means MCP install step still pending |
| `default_work_hours` | No | `onboard` | Used to seed category windows on first run |
| `personal_email` | No | `today` | Used for Gmail context lookups; never written to |
| `obsidian_vault` | No | `today` | Optional read-only context source |

## How fields are populated

`/calendrome:onboard` writes the file from scratch. Re-running onboard with "Edit settings" walks the user through each field and uses `Edit` tool patches.

Other skills only **read** the file (`Read` tool). They never modify it. If a required field is missing, the skill points the user to `/calendrome:onboard` and exits.

## Privacy

This file is per-user and lives in the home directory, outside any repo — it can never land in version control.
