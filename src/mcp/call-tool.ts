/**
 * Per-call tool dispatch for the MCP server.
 *
 * Each call opens a fresh SQLite connection, resolves the tool by
 * name, runs its handler, and closes the connection — mirroring the
 * GUI server's connection-per-request pattern. A long-lived boot-time
 * connection can serve a stale view of the shared DB file: a pinned
 * WAL read snapshot, or — if the file is ever atomically replaced by
 * a backup/restore — an old inode that still answers under the same
 * path. Either way, concurrent MCP sessions drift out of sync until
 * restart (#90). `buildTools` is a pure closure factory, so
 * rebuilding the descriptor array per call costs microseconds.
 *
 * Observability (#163): every call runs inside one wide span. The
 * handler executes in the span's context, so core write paths deepen
 * the same span via `recordEntityWrite` (entity identity, rows
 * written, the local/UTC day-bucketing pair) instead of opening thin
 * child spans. Failures are recorded on the span (`recordException` +
 * ERROR status) while the client still receives the same `isError`
 * text result as before. All of this rides `@opentelemetry/api`
 * only: with no SDK registered (`CALENDROME_OTEL` unset) the tracer
 * is a no-op and the call path behaves exactly as it did.
 */
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { openDatabase } from '../db/connection.js';
import type { CalendarClient } from '../calendar/index.js';
import { annotateSpan, recordSpanError } from '../observability/spans.js';
import { buildTools } from './tools/index.js';

/**
 * Resolved per call, never cached at module load: a tracer obtained
 * before an SDK registers is permanently no-op (the api's proxy
 * binds its delegate at registration time, and under a dual-package
 * load the module that grabbed a tracer early never sees it).
 * `getTracer` after registration reads the shared global registry, so
 * per-call resolution works in every load order — and is a cheap
 * lookup.
 */
const tracer = () => trace.getTracer('calendrome');

/** Tool names are snake_case; anything else is client garbage that
 * must not become a span name (redaction boundary, #163). */
const TOOL_NAME = /^[a-z0-9_]{1,64}$/;

export interface CallToolResult {
  // Index signature keeps this assignable to the MCP SDK's ServerResult.
  [key: string]: unknown;
  isError?: boolean;
  content: { type: 'text'; text: string }[];
}

export async function callTool(
  dbPath: string,
  calendar: CalendarClient,
  name: string,
  args: unknown,
): Promise<CallToolResult> {
  const safeName = TOOL_NAME.test(name) ? name : 'unknown';
  return tracer().startActiveSpan(
    `tools/call ${safeName}`,
    { kind: SpanKind.SERVER },
    async (span): Promise<CallToolResult> => {
      annotateSpan(
        {
          'rpc.system': 'jsonrpc',
          'rpc.method': 'tools/call',
          'calendrome.tool': safeName,
          'calendrome.db_path': dbPath,
        },
        span,
      );
      const db = openDatabase(dbPath);
      try {
        const tool = buildTools(db, { calendar }).find((t) => t.name === name);
        if (!tool) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: `unknown tool: ${safeName}`,
          });
          return {
            isError: true,
            content: [{ type: 'text', text: `unknown tool: ${name}` }],
          };
        }
        const result = await tool.handler(args ?? {});
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Record the failure on the span through the redaction
        // boundary: validation errors echo caller input in their
        // message ("... is not a valid ISO 8601 timestamp: <input>"),
        // so the raw message and stack must not reach the exporter.
        // The client-facing result is unchanged (same isError text
        // block as before #163) — the client sent the input, so
        // echoing it back leaks nothing.
        recordSpanError(err, span);
        return {
          isError: true,
          content: [{ type: 'text', text: message }],
        };
      } finally {
        db.close();
        span.end();
      }
    },
  );
}
