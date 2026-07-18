#!/usr/bin/env node
// Seed a calendrome sandbox DB with realistic-looking demo data.
//
// Usage:
//   CALENDROME_DB=./sandbox.db node plugin/skills/sandbox/scripts/seed-demo.mjs
//
// The dataset itself lives in src/demo-seed.ts (compiled to
// dist/src/demo-seed.js) — the same canonical seed the website's
// in-browser playground uses, so the two demos can't drift.
//
// Idempotent: running twice produces the same final state (seedDemo
// truncates seed content, then re-inserts). Does not touch a
// non-sandbox DB by name — refuses to run if CALENDROME_DB is empty
// or matches calendrome.db.

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../..');

const dbPath = process.env.CALENDROME_DB;
if (!dbPath) {
  console.error('CALENDROME_DB env var is required.');
  process.exit(1);
}
if (resolve(dbPath).endsWith('/calendrome.db')) {
  console.error(
    `Refusing to seed ${dbPath} — looks like the real calendrome DB.\n` +
      `Point CALENDROME_DB at a sandbox file (e.g. ./sandbox.db).`,
  );
  process.exit(1);
}

// The canonical dataset is compiled TypeScript — require a build.
const seedModulePath = join(REPO_ROOT, 'dist/src/demo-seed.js');
let seedDemo;
try {
  ({ seedDemo } = await import(pathToFileURL(seedModulePath).href));
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(
      `Cannot find ${seedModulePath}.\n` +
        `Run \`npm run build\` first — the seed dataset is compiled from src/demo-seed.ts.`,
    );
    process.exit(1);
  }
  throw err;
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Apply schema (idempotent CREATE IF NOT EXISTS), then seed.
const schema = readFileSync(join(REPO_ROOT, 'src/db/schema.sql'), 'utf8');
db.exec(schema);

const summary = seedDemo(db);

console.log('Seeded sandbox DB:');
console.log(`  ${dbPath}`);
console.log(`  ${summary.projects} projects (Acme, Globex, Hobby)`);
console.log(
  `  ${summary.tasks} tasks across the week (incl. 1 completed with logged time)`,
);
console.log(`  ${summary.habits} daily standup habit`);
console.log('');
console.log('Next: in a separate terminal, run:');
console.log(`  CALENDROME_DB=${dbPath} PORT=3838 npm run gui`);
console.log('  → http://localhost:3838');
