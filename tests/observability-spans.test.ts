import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpanStatusCode, context, trace } from '@opentelemetry/api';
import { node, tracing } from '@opentelemetry/sdk-node';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { callTool } from '../src/mcp/call-tool.js';
import { FakeCalendarClient } from '../src/calendar/index.js';
import {
  annotateSpan,
  guiSpanMiddleware,
  recordEntityWrite,
} from '../src/observability/spans.js';
import { insertTimeEntry } from '../src/time-entry.js';
import { freshDb } from './helpers/db.js';

/**
 * Wide-span tests (#163). A real (in-memory-exporting) tracer
 * provider is registered so spans record; no collector runs anywhere.
 * The provider registration is scoped to this file's worker — every
 * other test file exercises the same code paths against the no-op
 * `@opentelemetry/api` default, which doubles as the flag-off test.
 */
const exporter = new tracing.InMemorySpanExporter();
let provider: InstanceType<typeof node.NodeTracerProvider>;
const calendar = new FakeCalendarClient();
// Resolved lazily, mirroring src/mcp/call-tool.ts: a tracer cached
// before the provider registers is permanently no-op.
const tracer = () => trace.getTracer('calendrome-tests');

/** All finished spans' attributes flattened into one string, for
 * "this text never reached any span" redaction assertions. */
const allAttributeText = (): string =>
  exporter
    .getFinishedSpans()
    .map((s) => JSON.stringify([s.name, s.attributes, s.events]))
    .join('\n');

const findSpan = (name: string) => {
  const span = exporter.getFinishedSpans().find((s) => s.name === name);
  if (!span) throw new Error(`no finished span named ${name}`);
  return span;
};

beforeAll(() => {
  provider = new node.NodeTracerProvider({
    spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
  });
  // Registers the global tracer provider and an AsyncLocalStorage
  // context manager, so startActiveSpan propagates into handlers.
  provider.register();
  // Pin the local-day timezone: the machine running the tests can be
  // in any zone.
  process.env.CALENDROME_TZ = 'America/Chicago';
});

afterAll(async () => {
  delete process.env.CALENDROME_TZ;
  await provider.shutdown();
  trace.disable();
  context.disable();
});

beforeEach(() => exporter.reset());

describe('callTool wide spans (#163)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'calendrome-otel-'));
    dbPath = join(dir, 'calendrome.db');
    const db = openDatabase(dbPath);
    migrate(db);
    db.prepare(
      `INSERT INTO projects (id, name, prefix) VALUES ('acme', 'Acme', 'ACME')`,
    ).run();
    db.close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('emits one span per call with rpc + tool + db_path attributes', async () => {
    const result = await callTool(dbPath, calendar, 'list_projects', {});
    expect(result.isError).toBeUndefined();

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe('tools/call list_projects');
    expect(span.attributes['rpc.system']).toBe('jsonrpc');
    expect(span.attributes['rpc.method']).toBe('tools/call');
    expect(span.attributes['calendrome.tool']).toBe('list_projects');
    expect(span.attributes['calendrome.db_path']).toBe(dbPath);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('records the local/UTC day-bucketing pair on a write call', async () => {
    // 2026-03-10T01:00Z is the evening of 2026-03-09 in America/Chicago
    // (CDT, UTC-5) — exactly the "evening log rolls to the next UTC
    // day" failure mode the attribute pair exists to surface.
    const result = await callTool(dbPath, calendar, 'log_time', {
      project_id: 'acme',
      started_at: '2026-03-10T01:00:00Z',
      stopped_at: '2026-03-10T01:30:00Z',
    });
    expect(result.isError).toBeUndefined();

    const span = findSpan('tools/call log_time');
    expect(span.attributes['calendrome.tz']).toBe('America/Chicago');
    expect(span.attributes['calendrome.utc_day']).toBe('2026-03-10');
    expect(span.attributes['calendrome.local_day']).toBe('2026-03-09');
    expect(span.attributes['calendrome.entity_type']).toBe('time_entry');
    expect(typeof span.attributes['calendrome.entity_id']).toBe('number');
    expect(span.attributes['calendrome.rows_written']).toBe(1);
  });

  it('marks a failing call ERROR with an exception event, result unchanged', async () => {
    const result = await callTool(dbPath, calendar, 'log_time', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/started_at/);

    const span = findSpan('tools/call log_time');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    const exception = span.events.find((e) => e.name === 'exception');
    expect(exception).toBeDefined();
  });

  it('marks an unknown tool ERROR without leaking the raw name into the span', async () => {
    const result = await callTool(dbPath, calendar, 'No Such Tool!', {});
    expect(result.isError).toBe(true);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('tools/call unknown');
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
    expect(JSON.stringify(spans[0].attributes)).not.toContain('No Such Tool');
  });

  it('never lets titles or note bodies reach span attributes', async () => {
    const title = 'CANARY_TITLE super secret client engagement';
    const notes = 'CANARY_NOTES worked on the confidential thing';

    const created = await callTool(dbPath, calendar, 'create_task', {
      project_id: 'acme',
      title,
      duration_minutes: 30,
    });
    expect(created.isError).toBeUndefined();
    const logged = await callTool(dbPath, calendar, 'log_time', {
      project_id: 'acme',
      started_at: '2026-03-10T14:00:00Z',
      stopped_at: '2026-03-10T15:00:00Z',
      notes,
    });
    expect(logged.isError).toBeUndefined();

    expect(exporter.getFinishedSpans().length).toBeGreaterThan(0);
    expect(allAttributeText()).not.toContain('CANARY');
  });
});

describe('redaction boundary (#163)', () => {
  it('drops attribute keys outside the allowlist', () => {
    tracer().startActiveSpan('victim', (span) => {
      annotateSpan(
        {
          'calendrome.tool': 'log_time',
          'calendrome.project_name': 'Secret Client Co',
          'calendrome.notes': 'free text that must not export',
          'http.url': 'http://localhost/api',
        },
        span,
      );
      span.end();
    });

    const span = findSpan('victim');
    expect(span.attributes).toEqual({ 'calendrome.tool': 'log_time' });
  });

  it('drops allowlisted keys whose values fail the shape validators', () => {
    tracer().startActiveSpan('victim', (span) => {
      annotateSpan(
        {
          'calendrome.tool': 'Not A Slug', // whitespace: free text
          'calendrome.local_day': 'yesterday evening',
          'calendrome.utc_day': '2026-03-10', // valid — must survive
          'calendrome.entity_type': 'time entry with spaces',
          'calendrome.entity_id': 'has spaces so not an id',
          'calendrome.rows_written': -1,
          'calendrome.tz': 'not a real/zone name with spaces',
        },
        span,
      );
      span.end();
    });

    const span = findSpan('victim');
    expect(span.attributes).toEqual({ 'calendrome.utc_day': '2026-03-10' });
  });

  it('accumulates rows_written across multiple writes in one span', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO projects (id, name, prefix) VALUES ('acme', 'Acme', 'ACME')`,
    ).run();

    tracer().startActiveSpan('bulk-write', (span) => {
      for (const day of ['2026-03-10', '2026-03-11']) {
        insertTimeEntry(db, {
          project_id: 'acme',
          start_at: `${day}T14:00:00Z`,
          end_at: `${day}T15:00:00Z`,
          status: 'CONFIRMED',
          source: 'manual',
        });
      }
      span.end();
    });
    db.close();

    const span = findSpan('bulk-write');
    expect(span.attributes['calendrome.rows_written']).toBe(2);
    expect(span.attributes['calendrome.entity_type']).toBe('time_entry');
  });
});

describe('GUI request-span middleware (#163)', () => {
  it('annotates the active request span with db_path and tz', () => {
    tracer().startActiveSpan('GET /api/week', (span) => {
      let nextCalled = false;
      guiSpanMiddleware('/tmp/calendrome-gui.db')({}, {}, () => {
        nextCalled = true;
      });
      expect(nextCalled).toBe(true);
      span.end();
    });

    const span = findSpan('GET /api/week');
    expect(span.attributes['calendrome.db_path']).toBe('/tmp/calendrome-gui.db');
    expect(span.attributes['calendrome.tz']).toBe('America/Chicago');
  });
});
