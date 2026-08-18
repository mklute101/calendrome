/**
 * Wide-span annotation helpers and the redaction boundary (#163).
 *
 * Application code records observability data through this module
 * only — never by calling `span.setAttribute` directly. That keeps
 * the redaction boundary in one place: `ALLOWED_ATTRS` below is an
 * allowlist of attribute keys, each with a value validator, and
 * anything outside it is silently dropped. Ids, enums, counts, day
 * strings, timezone names, and paths pass; project names, client
 * names, and free-text note/title bodies can never reach a span
 * because no allowlisted key admits free text (every string validator
 * rejects whitespace except `calendrome.db_path`, which is
 * operator-supplied configuration, never caller data). Exception
 * events and status messages are part of the same boundary: errors
 * are recorded only through `recordSpanError`, which scrubs echoed
 * caller values out of the message and the stack.
 *
 * Everything here goes through `@opentelemetry/api` only. Without an
 * SDK registered (the default — `CALENDROME_OTEL` unset), the api
 * package is a true no-op: there is no active span, so every helper
 * returns immediately and the hot path pays a property read and a
 * null check. Nothing in this module ever throws: observability must
 * never break a write path.
 *
 * The domain attributes are chosen against failure modes this project
 * has actually shipped. `calendrome.local_day` and
 * `calendrome.utc_day` are recorded side by side on every write that
 * carries a timestamp precisely so day-bucketing disagreements (the
 * evening-local-time entry that rolls to the next UTC day and lands
 * on the wrong timesheet row) become a trace query instead of a bug
 * report days later.
 */
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';

/** YYYY-MM-DD. */
const PLAIN_DAY = /^\d{4}-\d{2}-\d{2}$/;
/** snake_case machine names: tool names, entity types. */
const SLUG = /^[a-z0-9_]{1,64}$/;
/** IANA timezone names (America/Chicago, Etc/GMT+5, UTC). */
const IANA_TZ = /^[A-Za-z0-9_+/-]{1,64}$/;
/** Structural ids: numeric or short token, never free text. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const isDay = (v: unknown): boolean => typeof v === 'string' && PLAIN_DAY.test(v);
const isSlug = (v: unknown): boolean => typeof v === 'string' && SLUG.test(v);

/**
 * The full set of attribute keys that may ever appear on a span, with
 * a validator per key. Adding an attribute means adding a row here —
 * and deciding, at that moment, that its values are structural
 * (redaction is decided before the first export, not after).
 */
const ALLOWED_ATTRS: Record<string, (v: unknown) => boolean> = {
  // Semantic conventions (RPC server side).
  'rpc.system': (v) => v === 'jsonrpc',
  'rpc.method': (v) => v === 'tools/call',
  // Domain attributes.
  'calendrome.tool': isSlug,
  'calendrome.tz': (v) => typeof v === 'string' && IANA_TZ.test(v),
  'calendrome.local_day': isDay,
  'calendrome.utc_day': isDay,
  'calendrome.entity_type': isSlug,
  'calendrome.entity_id': (v) =>
    typeof v === 'number'
      ? Number.isInteger(v)
      : typeof v === 'string' && ID.test(v),
  'calendrome.rows_written': (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0,
  'calendrome.db_path': (v) =>
    typeof v === 'string' && v.length <= 1024 && !/[\r\n]/.test(v),
};

export type SpanAttrs = Record<string, string | number | undefined>;

/**
 * Set attributes on `span` (default: the active span). The only way
 * attributes get set anywhere in calendrome. Keys outside
 * `ALLOWED_ATTRS`, and values that fail their key's validator, are
 * dropped silently. No-op when there is no recording span.
 */
export function annotateSpan(attrs: SpanAttrs, span?: Span): void {
  const target = span ?? trace.getActiveSpan();
  if (!target || !target.isRecording()) return;
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    const allowed = ALLOWED_ATTRS[key];
    if (!allowed || !allowed(value)) continue;
    target.setAttribute(key, value);
  }
}

/**
 * Timezone used for the local-day computation: `CALENDROME_TZ` when
 * set (tests, or a machine whose system tz is not the one you live
 * in), else the process's resolved zone.
 */
function spanTimeZone(): string {
  return (
    process.env.CALENDROME_TZ ??
    Intl.DateTimeFormat().resolvedOptions().timeZone ??
    'UTC'
  );
}

/** Cached per-timezone formatters — en-CA formats as YYYY-MM-DD. */
const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** Local calendar day of a UTC instant in `tz`; null if `tz` is bogus. */
function localDay(utcMs: number, tz: string): string | null {
  try {
    let fmt = dayFormatters.get(tz);
    if (!fmt) {
      fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      dayFormatters.set(tz, fmt);
    }
    return fmt.format(new Date(utcMs));
  } catch {
    return null;
  }
}

/**
 * Scrub an error message for span export. The repo's error convention
 * puts echoed caller values after a colon (`start_at is not a valid
 * ISO 8601 timestamp: <raw input>`), so everything from the first
 * colon on is dropped — the static head keeps its diagnostic value
 * while caller free text (which could be a title, a note body, or a
 * project name typo'd into a date field) never reaches the exporter.
 */
function scrubErrorMessage(raw: string): string {
  const colon = raw.indexOf(':');
  const head = colon === -1 ? raw : raw.slice(0, colon);
  return head.slice(0, 256);
}

/**
 * Record a handler failure on `span` (default: the active span):
 * exception event + ERROR status, both carrying the scrubbed message.
 * The stack is reduced to its `at ...` frames — the first line of a
 * raw stack embeds the unscrubbed message, and frames are structural
 * file paths. The only way errors get recorded on spans anywhere in
 * calendrome, for the same reason `annotateSpan` is the only way
 * attributes do: exception events are part of the redaction boundary
 * (#163).
 */
export function recordSpanError(err: unknown, span?: Span): void {
  const target = span ?? trace.getActiveSpan();
  if (!target || !target.isRecording()) return;
  const message = scrubErrorMessage(
    err instanceof Error ? err.message : String(err),
  );
  const stack =
    err instanceof Error && err.stack
      ? err.stack
          .split('\n')
          .filter((line) => /^\s+at /.test(line))
          .join('\n')
      : undefined;
  target.recordException({
    name: err instanceof Error ? err.name : 'Error',
    message,
    ...(stack ? { stack } : {}),
  });
  target.setStatus({ code: SpanStatusCode.ERROR, message });
}

export interface EntityWrite {
  /** What kind of row was touched, e.g. 'time_entry'. */
  entity_type: string;
  /** The row's id; omit for bulk writes without a single id. */
  entity_id?: string | number;
  /**
   * The entry's UTC start timestamp, when the write carries one.
   * Triggers the side-by-side `local_day` / `utc_day` bucketing pair.
   */
  start_at?: string;
  /** Rows mutated by this write; defaults to 1. */
  rows?: number;
}

/** Running row-mutation count per span, so bulk operations (calendar
 * sync inserting N events) report a total rather than the last 1. */
const rowsBySpan = new WeakMap<Span, number>();

/**
 * Annotate the active span with a row mutation: entity identity,
 * cumulative `rows_written`, and — when the write carries a start
 * timestamp — the `local_day` / `utc_day` bucketing pair plus the
 * timezone used to compute it. Called from the core write paths
 * (`src/time-entry.ts`), so both surfaces (MCP tool span, GUI request
 * span) get the same attributes for free. No-op without a recording
 * active span.
 */
export function recordEntityWrite(write: EntityWrite): void {
  const span = trace.getActiveSpan();
  if (!span || !span.isRecording()) return;

  const rows = (rowsBySpan.get(span) ?? 0) + (write.rows ?? 1);
  rowsBySpan.set(span, rows);

  const attrs: SpanAttrs = {
    'calendrome.entity_type': write.entity_type,
    'calendrome.entity_id': write.entity_id,
    'calendrome.rows_written': rows,
  };

  if (write.start_at !== undefined) {
    const ms = Date.parse(write.start_at);
    if (!Number.isNaN(ms)) {
      const tz = spanTimeZone();
      attrs['calendrome.tz'] = tz;
      attrs['calendrome.utc_day'] = new Date(ms).toISOString().slice(0, 10);
      attrs['calendrome.local_day'] = localDay(ms, tz) ?? undefined;
    }
  }

  annotateSpan(attrs, span);
}

/**
 * Express middleware for the GUI's `/api` routes: enrich the active
 * request span (created by http/express auto-instrumentation when
 * `CALENDROME_OTEL=1`) with the domain attributes knowable at request
 * time. Deeper attributes — entity identity, rows written, the day
 * bucketing pair — land on the same span via `recordEntityWrite` in
 * the core write paths the route handlers call. No-op when the SDK is
 * off: there is no active span to annotate.
 *
 * Typed structurally (not against express) so the observability
 * module stays dependency-free and directly unit-testable.
 */
export function guiSpanMiddleware(
  dbPath: string,
): (req: unknown, res: unknown, next: () => void) => void {
  return (_req, _res, next) => {
    annotateSpan({
      'calendrome.db_path': dbPath,
      'calendrome.tz': spanTimeZone(),
    });
    next();
  };
}
