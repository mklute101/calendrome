/**
 * OpenTelemetry SDK bootstrap (#162).
 *
 * Imported before anything else in both entry points
 * (`src/mcp/server.ts`, `src/gui/server.ts`). Entirely inert unless
 * `CALENDROME_OTEL=1`: the flag check happens before any OTel package
 * is loaded (synchronous `createRequire` calls below), so the default
 * path gains no startup cost and no network egress.
 *
 * ORDERING — the bootstrap must be fully synchronous. Node evaluates
 * the CommonJS dependency graph (express and everything under it)
 * concurrently with any pending top-level await in this module, so an
 * async bootstrap loses the race and require-in-the-middle never sees
 * express or http load — the SDK starts but auto-instrumentation
 * patches nothing and no spans are ever produced. A synchronous
 * module body evaluates to completion before the first CJS facade in
 * the entry point's import list, which is why the OTel packages are
 * loaded with `createRequire` rather than `import()`.
 *
 * CONSTRAINT — the MCP server's stdout is the JSON-RPC transport.
 * Nothing here may ever write to stdout: OTLP HTTP exporter only,
 * never a console span exporter, and `diag` output goes through a
 * stderr-only logger. A single stray stdout line corrupts the
 * protocol on the first span.
 *
 * Shutdown: the MCP process is killed by its client when the session
 * ends, and the batch span processor buffers spans in memory. The
 * SIGTERM/SIGINT handlers flush via `sdk.shutdown()` and then
 * re-raise the signal so default termination (or any other handler)
 * still runs; `beforeExit` covers the stdin-close path where the
 * event loop simply drains.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as otelApi from '@opentelemetry/api';
import type * as otelSdkNode from '@opentelemetry/sdk-node';
import type * as otelAutoInstr from '@opentelemetry/auto-instrumentations-node';
import type * as otelOtlpHttp from '@opentelemetry/exporter-trace-otlp-http';
import type * as otelResources from '@opentelemetry/resources';
import type * as otelSemconv from '@opentelemetry/semantic-conventions';

if (process.env.CALENDROME_OTEL === '1') {
  bootstrap();
}

/**
 * `calendrome-mcp` or `calendrome-gui`, inferred from the entry
 * script path (`dist/src/mcp/server.js` vs `dist/src/gui/server.js`).
 * One shared bootstrap file keeps the "import this first" contract
 * identical in both entry points.
 */
function detectServiceName(): string {
  const entry = (process.argv[1] ?? '').split(sep).join('/');
  return entry.includes('/gui/') ? 'calendrome-gui' : 'calendrome-mcp';
}

/**
 * service.version from package.json. Walk upward from this file so
 * the lookup works from both the compiled tree (dist/src/observability)
 * and the source tree (src/observability).
 */
function readServiceVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'package.json');
    if (existsSync(candidate)) {
      try {
        const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as {
          version?: string;
        };
        return parsed.version ?? '0.0.0';
      } catch {
        return '0.0.0';
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

function bootstrap(): void {
  const require = createRequire(import.meta.url);
  const { diag, DiagLogLevel, trace } = require(
    '@opentelemetry/api',
  ) as typeof otelApi;
  const { NodeSDK, tracing } = require(
    '@opentelemetry/sdk-node',
  ) as typeof otelSdkNode;
  const { getNodeAutoInstrumentations } = require(
    '@opentelemetry/auto-instrumentations-node',
  ) as typeof otelAutoInstr;
  const { OTLPTraceExporter } = require(
    '@opentelemetry/exporter-trace-otlp-http',
  ) as typeof otelOtlpHttp;
  const { resourceFromAttributes } = require(
    '@opentelemetry/resources',
  ) as typeof otelResources;
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = require(
    '@opentelemetry/semantic-conventions',
  ) as typeof otelSemconv;

  // All diag levels route to stderr. DiagConsoleLogger is unusable
  // here: console.log/info/debug write to stdout, which is the MCP
  // JSON-RPC transport.
  const toStderr =
    (level: string) =>
    (message: string, ...args: unknown[]) => {
      process.stderr.write(
        `[otel:${level}] ${message}${args.length ? ' ' + args.map(String).join(' ') : ''}\n`,
      );
    };
  diag.setLogger(
    {
      error: toStderr('error'),
      warn: toStderr('warn'),
      info: toStderr('info'),
      debug: toStderr('debug'),
      verbose: toStderr('verbose'),
    },
    DiagLogLevel.ERROR,
  );

  // Exporter target comes from OTEL_EXPORTER_OTLP_ENDPOINT (the
  // exporter reads the env var itself and appends /v1/traces).
  // Default is the local grafana/otel-lgtm backend from
  // docker-compose.otel.yml.
  const exporterConfig = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ? {}
    : { url: 'http://localhost:4318/v1/traces' };

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: detectServiceName(),
      [ATTR_SERVICE_VERSION]: readServiceVersion(),
    }),
    // Explicit, not inherited: at single-user call volume, sampling
    // only loses data.
    sampler: new tracing.AlwaysOnSampler(),
    traceExporter: new OTLPTraceExporter(exporterConfig),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs instrumentation is high-volume noise at this scale and
        // adds measurable startup overhead.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();

  // One guaranteed span per process lifetime. The MCP server speaks
  // JSON-RPC over stdio, so with no manual tool-handler spans yet
  // (#163) a plain session touches neither express nor outbound
  // HTTP and auto-instrumentation alone would export nothing. This
  // marks startup in the trace backend for both processes. Name and
  // resource attributes only — no user data.
  trace
    .getTracer('calendrome-observability')
    .startSpan('process.start')
    .end();

  let shuttingDown = false;
  const flush = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await sdk.shutdown();
    } catch (err) {
      process.stderr.write(`[otel] shutdown failed: ${String(err)}\n`);
    }
  };

  // Flush buffered spans before the MCP client's kill lands. Using
  // `once` + re-raise composes with default termination and with any
  // other listeners instead of clobbering them.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void flush().finally(() => {
        process.kill(process.pid, signal);
      });
    });
  }

  // Stdin-close path: the MCP transport ends, the event loop drains,
  // and the process would exit with spans still buffered. Scheduling
  // the flush here keeps the loop alive until it completes.
  process.once('beforeExit', () => {
    void flush();
  });
}
