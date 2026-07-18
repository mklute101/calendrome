/**
 * SQLite connection helpers.
 *
 * Calendrome uses a single file-backed SQLite database (default path
 * `calendrome.db`, override with `CALENDROME_DB`). Both the MCP server
 * and the GUI server open this file independently. WAL mode is enabled
 * so concurrent reads and the occasional cross-process write don't
 * block each other; foreign keys are on so schema-level invariants
 * actually fire.
 *
 * `openDatabase(':memory:')` is the convention for tests — every test
 * gets a fresh isolated DB, no cleanup required.
 *
 * `DB` is an interface (see `./types.ts`), not the better-sqlite3
 * class: the in-browser playground runs the same core functions
 * against a sql.js (WASM) database through `sqljs-adapter.ts`, so
 * everything downstream of here is engine-agnostic.
 */
import Database from 'better-sqlite3';
import type { DB } from './types.js';

export type { DB, Statement, RunResult, BindValue } from './types.js';

export function openDatabase(path: string = ':memory:'): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db as unknown as DB;
}
