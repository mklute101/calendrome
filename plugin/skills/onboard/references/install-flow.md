# Onboard install-flow troubleshooting

Reference material for the onboard skill's Step 1 (MCP install). The main `SKILL.md` describes the happy path and sub-state detection. This file documents failure modes and what to tell the user when things go wrong.

## Pre-flight failures

### Node too old

`node --version` returns < `v20.0.0`.

calendrome's `package.json` doesn't enforce a Node version with `engines`, but the codebase uses features that require Node 20 (ES2022 features, `node:test` patterns in some test files). 22 LTS is fine.

What to tell the user:

> "calendrome needs Node 20 or newer. You have `<their version>`. Install Node 20+ via [nvm](https://github.com/nvm-sh/nvm) (`nvm install 20 && nvm use 20`) or [Homebrew](https://formulae.brew.sh/formula/node@20) (`brew install node@20`)."

Do not attempt the install yourself. Node version managers are personal infrastructure.

### git, npm, or claude not on PATH

Each is independently a stop. Don't proceed if any are missing.

- `git not found` → "Install git from https://git-scm.com/. On Mac: `xcode-select --install` brings it via Command Line Tools."
- `npm not found` → "npm ships with Node — if `node --version` works but `npm` doesn't, your install is broken. Reinstall Node."
- `claude not found` → "Claude Code's CLI isn't on your PATH. You're using it now, so it's installed somewhere — but the `claude` binary isn't reachable from a shell. Check Claude Code's install instructions; on Mac the binary is typically at `/usr/local/bin/claude` or installed via the desktop app."

### Network unreachable

`git clone` or `npm install` fails with network errors.

Tell the user, do not retry automatically:

> "Couldn't reach `<github.com|registry.npmjs.org>`. Check your network and any proxy or firewall, then re-run `/calendrome:onboard` to resume."

## Idempotency cases

### Target directory exists and is not a calendrome clone

Detected via missing `.git/config` calendrome remote or wrong `package.json` name.

Do **not** clone into it. Do **not** rename or delete it. Tell the user:

> "The directory you picked (`<path>`) already exists and isn't a calendrome clone. Pick a different path, or move/remove that directory yourself first."

Then re-prompt for an install path.

### Target directory is a calendrome clone with uncommitted changes

`git status` in the target shows modifications. This is usually fine — the user might have local tweaks or a partial previous run. Don't `git pull` or `git reset`. Just proceed with `npm install` + `npm run build` and trust the user's working tree.

If `npm install` later fails and the cause looks like dependency drift, mention this in the error message: "If you have local changes to `package.json`, that may be why."

### dist/ exists but is stale

After build, the existing `dist/` is overwritten by `tsc`. No special handling needed.

Edge case: if the user has a half-built `dist/` from an interrupted previous run, `npm run build` should overwrite. If it doesn't (rare), tell the user: "Try `rm -rf dist/ && npm run build` from `<path>`, then re-run `/calendrome:onboard`."

## Failure modes

### `npm install` fails

Capture the error. Common causes:

- **Disk full** → tell the user, have them free space, then re-run onboard
- **Permissions error on `~/.npm`** → tell user to run `sudo chown -R $(whoami) ~/.npm` and re-run
- **Peer dep / version conflict** → don't try to fix automatically. Surface the error and suggest the user run `npm install --legacy-peer-deps` or open a calendrome bug if the error mentions calendrome's own dependencies

Never run `npm install --force` automatically — it can produce broken trees.

### `npm run build` fails

calendrome's build is `tsc -p tsconfig.json && cp src/db/schema.sql dist/src/db/schema.sql && mkdir -p dist/src/gui/public && cp -R src/gui/public/. dist/src/gui/public/ && node scripts/extract-docs.mjs`.

- **TypeScript errors** → likely a stale source tree. Suggest `git pull`, then re-run.
- **Missing `src/db/schema.sql`** → unusual; the user has a corrupted clone. Suggest re-cloning to a different path.
- **`scripts/extract-docs.mjs` fails** → low-blast-radius script (generates docs); if it fails the build is otherwise OK. Mention it but proceed to MCP registration.

### `claude mcp add` rejects

- **"calendrome already registered"** → switch to **Re-register** sub-state: `claude mcp remove calendrome`, then re-add. Don't ask the user — this is the obvious recovery.
- **"command not found: claude"** → pre-flight should have caught this; see above.
- **Unknown error** → surface to user verbatim; do not retry.

### MCP registered but tools not available after restart

After the user restarts Claude Code and runs `/calendrome:onboard` again, you should see `mcp__calendrome__*` tools. If not:

1. Check `claude mcp list` — is calendrome there?
2. If yes, ask the user to check Claude Code's MCP startup logs. The MCP might be crashing on launch (most likely cause: build failed silently and `dist/src/mcp/server.js` is missing).
3. Verify `<target>/dist/src/mcp/server.js` exists. If not, run `npm run build` again from `<target>`.
4. If still no luck, ask the user to run `node <target>/dist/src/mcp/server.js` directly and share the output. The MCP server logs to stderr.

## What not to do

- Never `rm -rf` anything in the user's filesystem.
- Never `git reset --hard` or `git clean` in the calendrome clone.
- Never edit `~/.claude.json` directly. Always use `claude mcp add` / `claude mcp remove`.
- Never silently retry a failed command. Always surface the error.
- Never proceed past Step 1f (restart boundary) in the same session — MCP changes don't hot-load.
- Never assume the user is on macOS. Commands here use POSIX shell, no `brew`-specific paths.
