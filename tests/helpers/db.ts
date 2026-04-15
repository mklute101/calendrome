import { openDatabase } from '../../src/db/connection.js';
import { migrate } from '../../src/db/migrate.js';

/**
 * Create a fresh in-memory database with migrations applied.
 * Each test should call this so they don't share state.
 */
export function freshDb() {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}
