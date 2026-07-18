import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { wrapSqlJsDatabase } from '../../src/db/sqljs-adapter.js';
import { migrate } from '../../src/db/migrate.js';
import type { DB } from '../../src/db/types.js';

const require = createRequire(import.meta.url);

/** One sql.js runtime per test process — the WASM module is heavy. */
const sqlJsPromise = initSqlJs({
  // Resolve the wasm binary explicitly: sql.js's own locateFile relies on
  // script-path detection that breaks under vitest's module transform.
  locateFile: (file: string) =>
    join(dirname(require.resolve('sql.js')), file),
});

/**
 * sql.js twin of `freshDb()`: a fresh in-memory WASM database wrapped
 * in the `DB` interface, with migrations applied. What the browser
 * playground runs, minus the browser.
 */
export async function freshSqlJsDb(): Promise<DB> {
  const SQL = await sqlJsPromise;
  const db = wrapSqlJsDatabase(new SQL.Database());
  migrate(db);
  return db;
}
