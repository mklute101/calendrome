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
 */
import Database from 'better-sqlite3';

export type DB = Database.Database;

export function openDatabase(path: string = ':memory:'): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}
