#!/usr/bin/env node
/**
 * Scheduled health runner — the follow-up deferred by #164.
 *
 * Runs the invariant checks from `src/health/checks.ts` against the
 * database and reports failures. Silence is the expected output: a
 * healthy database prints one line and exits 0; failures print one
 * line per failing check and exit 1; a broken run (missing build,
 * missing database) exits 2. The exit code is the contract, so any
 * scheduler — launchd, cron, CI — can gate on it.
 *
 * Flags:
 *   --notify  post a macOS notification on failure or breakage
 *             (no-op on other platforms) so a scheduled run stays
 *             invisible until something is actually wrong
 *   --json    print the raw HealthReport instead of lines
 *
 * Imports the built modules, so `npm run build` must have run. The
 * database is opened read-write (better-sqlite3 has no readonly
 * convenience here) but the checks only SELECT — no migration is run,
 * so the script never mutates a database it is asked to judge.
 *
 * Database path: `CALENDROME_DB`, defaulting to `calendrome.db` at
 * the repo root — the same resolution the servers use.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const notify = args.includes('--notify');
const json = args.includes('--json');

function notifyMac(message) {
  if (!notify || process.platform !== 'darwin') return;
  spawnSync('osascript', [
    '-e',
    `display notification ${JSON.stringify(message)} with title "calendrome health"`,
  ]);
}

function broken(message) {
  console.error(message);
  notifyMac(`health run broke: ${message}`);
  process.exit(2);
}

const distDir = join(root, 'dist', 'src');
if (!existsSync(join(distDir, 'health', 'checks.js'))) {
  broken('dist/ is missing — run `npm run build` first');
}

const dbPath = process.env.CALENDROME_DB ?? join(root, 'calendrome.db');
if (!existsSync(dbPath)) {
  broken(`database not found: ${dbPath}`);
}

const { openDatabase } = await import(
  pathToFileURL(join(distDir, 'db', 'connection.js'))
);
const { runHealthChecks } = await import(
  pathToFileURL(join(distDir, 'health', 'checks.js'))
);

let report;
try {
  const db = openDatabase(dbPath);
  try {
    report = runHealthChecks(db);
  } finally {
    db.close();
  }
} catch (err) {
  broken(err instanceof Error ? err.message : String(err));
}

if (json) {
  console.log(JSON.stringify(report, null, 2));
} else if (report.ok) {
  console.log(`ok — ${report.checks.length} checks passed (${report.db})`);
} else {
  for (const check of report.checks.filter((c) => !c.ok)) {
    console.log(`FAIL ${check.name}: ${check.detail}`);
  }
}

if (!report.ok) {
  const first = report.checks.find((c) => !c.ok);
  notifyMac(`${report.failing} failing — ${first.name}`);
  process.exit(1);
}
