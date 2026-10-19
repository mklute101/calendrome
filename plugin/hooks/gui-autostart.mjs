#!/usr/bin/env node
// Start the week-view GUI when a planner session opens.
//
// Wired in hooks.json to two events, because a planner skill starts two
// ways: the user types `/calendrome:today` (UserPromptSubmit, the prompt
// is the slash command) or Claude invokes it from "good morning"
// (PreToolUse on the Skill tool). Every other prompt and skill exits
// immediately.
//
// Mirrors `gui_start` in src/gui/launcher.ts: spawn
// `dist/src/gui/server.js` detached and record its PID in the same
// sidecar so `gui_stop` can stop it. The plugin ships without the
// server, so the source checkout is resolved the way onboard does it:
// `calendrome_repo_path` in ~/.claude/calendrome.local.md, else
// ~/dev/tools/calendrome.
//
// A running GUI is left alone unless it is stale: the same server.js,
// but built after the process started. A running process keeps serving
// the code it booted with, and an old build can fail against a DB a
// newer build migrated (#173), so a stale GUI is stopped and respawned.
// That covers a GUI started by hand (`npm run gui`) too, but only after
// confirming via ps/lsof that the port's listener is this checkout's
// server.js. Anything else on the port is never touched.
//
// Never blocks the prompt or the skill: every failure exits 0, and only
// the UserPromptSubmit path prints (stdout there becomes context).

import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLANNER_SKILLS = ['today', 'week'];

/**
 * True when the hook payload opens a planner session: a
 * `/calendrome:today` or `/calendrome:week` prompt (bare `/today` and
 * `/week` too), or a Skill tool call for either.
 */
export function opensPlanner(input) {
  if (!input || typeof input !== 'object') return false;
  if (input.hook_event_name === 'UserPromptSubmit') {
    const m = /^\s*\/(?:calendrome:)?(\w+)(?:\s|$)/.exec(input.prompt ?? '');
    return m !== null && PLANNER_SKILLS.includes(m[1]);
  }
  if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'Skill') {
    const skill = String(input.tool_input?.skill ?? '').replace(/^\//, '');
    return PLANNER_SKILLS.some((s) => skill === `calendrome:${s}`);
  }
  return false;
}

/** `calendrome_repo_path` from the settings frontmatter, else the default. */
export function resolveRepoPath(settingsText, home = homedir()) {
  const m = /^calendrome_repo_path:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(settingsText ?? '');
  const raw = m ? m[1] : '~/dev/tools/calendrome';
  return resolve(raw.replace(/^~(?=$|\/)/, home));
}

function guiPort() {
  return Number(process.env.CALENDROME_GUI_PORT ?? process.env.PORT ?? 3737);
}

function pidFilePath() {
  return process.env.CALENDROME_GUI_PID_FILE ?? join(homedir(), '.calendrome', 'gui.pid');
}

/**
 * True when a running GUI booted before its entry file was last built.
 * `proc` is { startMs, entryPath } from processInfo(); a different entry
 * path (another checkout, another program) is never stale.
 */
export function isStale(proc, entry, entryMtimeMs) {
  if (!proc || proc.entryPath !== entry) return false;
  // ps reports start time to the second; compare there too, or a GUI
  // started in the same second as the build reads stale forever.
  return Number.isFinite(proc.startMs) && Math.floor(entryMtimeMs / 1000) * 1000 > proc.startMs;
}

function sh(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 2000,
  }).trim();
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** PID of the running GUI: the sidecar's if alive, else the port's listener. */
function runningPid(port) {
  try {
    const pid = Number(readFileSync(pidFilePath(), 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return pid;
  } catch {
    // no sidecar
  }
  try {
    const pid = Number(sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t']).split('\n')[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null; // no lsof (Windows) or nothing listening
  }
}

/** { startMs, entryPath } for a node process running a server.js, else null. */
function processInfo(pid) {
  try {
    // lstart is fixed-width: "Fri Oct 16 21:27:31 2026", then the args.
    const line = sh('ps', ['-o', 'lstart=', '-o', 'args=', '-p', String(pid)]);
    const startMs = Date.parse(line.slice(0, 24));
    const script = line.slice(24).trim().split(/\s+/).find((a) => a.endsWith('server.js'));
    if (!script) return null;
    let entryPath = script;
    if (!isAbsolute(script)) {
      const cwd = sh('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
        .split('\n')
        .find((l) => l.startsWith('n'));
      if (!cwd) return null;
      entryPath = resolve(cwd.slice(1), script);
    }
    return { startMs, entryPath };
  } catch {
    return null;
  }
}

async function waitForPortFree(port, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portInUse(port))) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function portInUse(port, timeoutMs = 300) {
  return new Promise((res) => {
    const s = connect({ port, host: '127.0.0.1' });
    const finish = (v) => {
      s.destroy();
      res(v);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
  });
}

function readStdin() {
  return new Promise((res) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => res(data));
    process.stdin.on('error', () => res(data));
  });
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return;
  }
  if (!opensPlanner(input)) return;

  const say = (msg) => {
    if (input.hook_event_name === 'UserPromptSubmit') console.log(msg);
  };
  const port = guiPort();
  const url = `http://localhost:${port}`;

  let settings = '';
  try {
    settings = readFileSync(join(homedir(), '.claude', 'calendrome.local.md'), 'utf8');
  } catch {
    // no settings yet: fall back to the default checkout
  }
  const entry = join(resolveRepoPath(settings), 'dist', 'src', 'gui', 'server.js');

  let restarted = false;
  if (await portInUse(port)) {
    const pid = runningPid(port);
    const built = existsSync(entry) ? statSync(entry).mtimeMs : 0;
    if (pid === null || !isStale(processInfo(pid), entry, built)) {
      say(`Calendrome GUI already running at ${url}.`);
      return;
    }
    try {
      process.kill(pid);
    } catch {
      say(`Calendrome GUI at ${url} is running an older build but could not be stopped (pid ${pid}).`);
      return;
    }
    if (!(await waitForPortFree(port))) {
      say(`Calendrome GUI at ${url} is running an older build; stop signal sent to pid ${pid} but the port is still busy.`);
      return;
    }
    restarted = true;
  } else if (runningPid(port) !== null) {
    say(`Calendrome GUI is starting at ${url}.`); // spawned, not yet bound
    return;
  }

  if (!existsSync(entry)) {
    say(`Calendrome GUI not started: ${entry} is missing (run \`npm run build\` in the calendrome checkout).`);
    return;
  }

  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  if (typeof child.pid !== 'number') return;
  mkdirSync(dirname(pidFilePath()), { recursive: true });
  writeFileSync(pidFilePath(), String(child.pid), 'utf8');
  say(
    restarted
      ? `Calendrome GUI restarted at ${url} (it was running an older build).`
      : `Calendrome GUI started at ${url}.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => process.exit(0));
}
