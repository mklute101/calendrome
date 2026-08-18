/**
 * OpenTelemetry SDK bootstrap (#162).
 *
 * Imported before anything else in both entry points
 * (`src/mcp/server.ts`, `src/gui/server.ts`). Entirely inert unless
 * `CALENDROME_OTEL=1`: the flag check happens before any OTel package
 * is loaded (dynamic imports), so the default path gains no startup
 * cost and no network egress.
 *
 * When enabled, the top-level `await` below blocks evaluation of the
 * rest of the entry point's module graph until the SDK has started.
 * That ordering is what lets auto-instrumentation patch CommonJS
 * dependencies (express, outbound http) via require-in-the-middle
 * before they are first loaded.
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
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.CALENDROME_OTEL === '1') {
  await bootstrap();
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

async function bootstrap(): Promise<void> {
  const [
    { diag, DiagLogLevel },
    { NodeSDK, tracing },
    { getNodeAutoInstrumentations },
    { OTLPTraceExporter },
    { resourceFromAttributes },
    { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION },
  ] = await Promise.all([
    import('@opentelemetry/api'),
    import('@opentelemetry/sdk-node'),
    import('@opentelemetry/auto-instrumentations-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
    import('@opentelemetry/resources'),
    import('@opentelemetry/semantic-conventions'),
  ]);

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
