import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { wrapSqlJsDatabase } from '../../src/db/sqljs-adapter.js';
import { migrate } from '../../src/db/migrate.js';
import type { DB } from '../../src/db/types.js';

const require = createRequire(import.meta.url);

/**
 * One sql.js runtime per test process — the WASM module is heavy.
 * Initialized lazily so native-engine runs never load it.
 */
let sqlJsPromise: Promise<SqlJsStatic> | null = null;
let sqlJs: SqlJsStatic | null = null;

export function preloadSqlJs(): Promise<SqlJsStatic> {
  sqlJsPromise ??= initSqlJs({
    // Resolve the wasm binary explicitly: sql.js's own locateFile relies on
    // script-path detection that breaks under vitest's module transform.
    locateFile: (file: string) =>
      join(dirname(require.resolve('sql.js')), file),
  }).then((SQL) => (sqlJs = SQL));
  return sqlJsPromise;
}

/**
 * sql.js twin of `freshDb()`: a fresh in-memory WASM database wrapped
 * in the `DB` interface, with migrations applied. What the browser
 * playground runs, minus the browser.
 */
export async function freshSqlJsDb(): Promise<DB> {
  const SQL = await preloadSqlJs();
  const db = wrapSqlJsDatabase(new SQL.Database());
  migrate(db);
  return db;
}

/**
 * Synchronous variant for the engine-matrix run, where `freshDb()`
 * must stay sync. Requires `preloadSqlJs()` to have resolved first —
 * `tests/setup-engine.ts` does that before any test file runs.
 */
export function freshSqlJsDbSync(): DB {
  if (!sqlJs) {
    throw new Error(
      'sql.js not preloaded — is tests/setup-engine.ts in vitest setupFiles?',
    );
  }
  const db = wrapSqlJsDatabase(new sqlJs.Database());
  migrate(db);
  return db;
}
