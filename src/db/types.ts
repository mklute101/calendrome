/**
 * Database interface — the narrow SQLite surface calendrome actually
 * uses, extracted so the same core functions can run against two
 * engines:
 *
 *   - `better-sqlite3` (node: MCP server, GUI server, tests) via
 *     `openDatabase()` in `connection.ts`
 *   - `sql.js` (WASM, in-browser playground demo) via
 *     `wrapSqlJsDatabase()` in `sqljs-adapter.ts`
 *
 * The shape is deliberately minimal: positional `?` binding only,
 * `run`/`get`/`all` on prepared statements, `exec`, `pragma`,
 * better-sqlite3-style `transaction(fn)` (returns a callable that
 * wraps `fn` in BEGIN/COMMIT with ROLLBACK on throw), and `close`.
 * Don't add better-sqlite3 extras (`iterate`, `pluck`, named binds…)
 * unless core code genuinely needs them — every addition must be
 * implementable in the sql.js adapter too.
 *
 * This file must stay free of node-only and better-sqlite3 imports:
 * it is pulled into the browser bundle by the playground.
 */

/**
 * Values the codebase binds into statements (positional `?` only).
 * Statement params are typed `unknown` because callers build dynamic
 * arg arrays; engines validate at bind time exactly as before.
 */
export type BindValue = number | bigint | string | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface DB {
  prepare(sql: string): Statement;
  /** Execute a multi-statement SQL script (no parameters, no results). */
  exec(sql: string): unknown;
  /** Execute a PRAGMA (e.g. `journal_mode = WAL`); result shape is engine-ish. */
  pragma(source: string): unknown;
  /**
   * better-sqlite3 transaction semantics: returns a function that runs
   * `fn` inside BEGIN/COMMIT, rolling back if it throws.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  transaction<F extends (...args: any[]) => any>(fn: F): F;
  close(): void;
}
