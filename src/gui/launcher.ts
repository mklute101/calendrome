/**
 * GUI server lifecycle helpers for the MCP `gui_*` tools.
 *
 * The GUI is a separate Node process (`node dist/src/gui/server.js`,
 * normally on port 3737). These helpers let the MCP server start, stop,
 * and inspect it without the user dropping to a second terminal. The
 * child is spawned detached + unref'd so it survives MCP restarts; its
 * PID is recorded in a sidecar file so a later MCP session can find it.
 *
 * "Already running" is detected two ways: a live PID in the sidecar, or
 * the configured port already accepting connections (someone ran
 * `npm run gui` by hand). Either way we return the URL rather than
 * spawning a duplicate.
 */
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Mirror src/gui/server.ts port resolution so the URL matches where the
// server actually binds.
function guiPort(): number {
  return Number(process.env.CALENDROME_GUI_PORT ?? process.env.PORT ?? 3737);
}
function guiUrl(): string {
  return `http://localhost:${guiPort()}`;
}

// Sidecar lives under ~/.calendrome so a fresh MCP session can still stop
// the GUI. Override with CALENDROME_GUI_PID_FILE for tests/sandboxes.
function pidFilePath(): string {
  return process.env.CALENDROME_GUI_PID_FILE ?? join(homedir(), '.calendrome', 'gui.pid');
}
// dist/src/gui/launcher.js -> sibling dist/src/gui/server.js
function serverEntry(): string {
  return join(__dirname, 'server.js');
}

function readPid(): number | null {
  const p = pidFilePath();
  if (!existsSync(p)) return null;
  const pid = Number(readFileSync(p, 'utf8').trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function clearPidFile(): void {
  const p = pidFilePath();
  if (existsSync(p)) rmSync(p);
}
function portInUse(port: number, timeoutMs = 300): Promise<boolean> {
  return new Promise((res) => {
    const s = connect({ port, host: '127.0.0.1' });
    let done = false;
    const finish = (v: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      res(v);
    };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
  });
}

export interface GuiStatus {
  running: boolean;
  pid: number | null;
  url: string;
  source: 'pid' | 'port' | null;
}
export async function guiStatus(): Promise<GuiStatus> {
  const url = guiUrl();
  const pid = readPid();
  if (pid !== null && isAlive(pid)) return { running: true, pid, url, source: 'pid' };
  if (pid !== null) clearPidFile(); // stale
  if (await portInUse(guiPort())) return { running: true, pid: null, url, source: 'port' };
  return { running: false, pid: null, url, source: null };
}

export interface GuiStartResult {
  started: boolean;
  already_running: boolean;
  pid: number | null;
  url: string;
}
export async function guiStart(): Promise<GuiStartResult> {
  const url = guiUrl();
  const status = await guiStatus();
  if (status.running) return { started: false, already_running: true, pid: status.pid, url };
  const entry = serverEntry();
  if (!existsSync(entry)) {
    throw new Error(`GUI server not built: ${entry} is missing. Run \`npm run build\` first.`);
  }
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  if (typeof child.pid !== 'number') throw new Error('failed to spawn GUI server (no pid)');
  const pidFile = pidFilePath();
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(child.pid), 'utf8');
  return { started: true, already_running: false, pid: child.pid, url };
}

export interface GuiStopResult {
  stopped: boolean;
  pid: number | null;
}
export function guiStop(): GuiStopResult {
  const pid = readPid();
  if (pid === null) return { stopped: false, pid: null };
  let stopped = false;
  if (isAlive(pid)) {
    try {
      process.kill(pid);
      stopped = true;
    } catch {
      stopped = false;
    }
  }
  clearPidFile();
  return { stopped, pid };
}
