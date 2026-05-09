# Calendrome — Claude Code Plugin

Calendar-as-source-of-truth task scheduling, exposed to Claude Code as a set of conversational skills over the [calendrome](https://github.com/mklute101/calendrome) MCP server.

## What's in here

| Skill | What it does |
|---|---|
| `/calendrome:onboard` | First-run guided setup: detects existing connections (Jira, Harvest, Google Calendar), walks you through MCP install, imports projects, sets working hours and weekly budgets. Re-run to add projects, edit settings, or spin up a demo sandbox. |
| `/calendrome:status` | Show current state — projects, budgets, active tasks — and what you can do next. |
| `/calendrome:week` | Weekly planning session. Pulls from Google Calendar, JIRA, and calendrome; presents a unified view; helps you commit time. |
| `/calendrome:today` | Daily working session — morning brief, mid-day check-in, end-of-day wrap-up. |
| `/calendrome:block` | Quick "block this on my calendar starting now" for ad-hoc work. |
| `/calendrome:sandbox` | Spin up a throwaway calendrome instance on an alt port + alt DB. Pass `demo` to pre-seed sample data. |
| `/calendrome:harvest-push` | Push the week's calendrome time entries to Harvest, with a dry-run preview. |

## Settings

Per-user configuration lives in `.claude/calendrome.local.md` (created and edited by `/calendrome:onboard`). Includes Atlassian IDs, calendar ID/timezone, JIRA project keys, and the prefix → calendrome project ID mapping.

## Installation

This plugin ships skills only. The calendrome MCP server still requires a manual one-time install — `/calendrome:onboard` will walk you through it.

See [issue #53](https://github.com/mklute101/calendrome/issues/53) for the long-term plan to make MCP install one step (npm publish, release artifacts, etc.).
