import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';
import { freshSqlJsDbSync } from './sqljs.js';
import type { DB } from '../../src/db/types.js';

/**
 * Create a fresh in-memory database with migrations applied.
 * Each test should call this so they don't share state.
 *
 * Engine matrix: `CALENDROME_TEST_ENGINE=sqljs npm test` runs the whole
 * suite against the sql.js (WASM) adapter the browser playground uses,
 * catching SQL that better-sqlite3's newer bundled SQLite accepts but
 * sql.js's older build does not. CI runs both engines.
 */
export function freshDb(): DB {
  if (process.env.CALENDROME_TEST_ENGINE === 'sqljs') {
    return freshSqlJsDbSync();
  }
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}
