import { describe, it, expect } from 'vitest';

/**
 * The OTel bootstrap must be entirely inert unless CALENDROME_OTEL=1:
 * no signal handlers registered, no SDK loaded, no side effects. Both
 * entry points import it before anything else, so any default-path
 * cost here is paid on every server start (#162).
 */
describe('observability bootstrap', () => {
  it('is inert when CALENDROME_OTEL is unset', async () => {
    delete process.env.CALENDROME_OTEL;
    const before = {
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
      beforeExit: process.listenerCount('beforeExit'),
    };

    await import('../src/observability/otel.js');

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
    expect(process.listenerCount('beforeExit')).toBe(before.beforeExit);
  });
});

/**
 * The #163 span helpers ride `@opentelemetry/api` only, which is a
 * verified no-op without a registered SDK: `trace.getActiveSpan()`
 * returns undefined and `startActiveSpan` hands out a non-recording
 * span. This file never registers a provider, so these tests pin the
 * flag-off default path: every helper is inert and throw-free.
 * (Recording-path assertions live in observability-spans.test.ts.)
 */
describe('span helpers without an SDK (flag off)', () => {
  it('annotateSpan and recordEntityWrite are inert no-ops', async () => {
    const { annotateSpan, recordEntityWrite } = await import(
      '../src/observability/spans.js'
    );
    expect(() =>
      annotateSpan({ 'calendrome.tool': 'log_time' }),
    ).not.toThrow();
    expect(() =>
      recordEntityWrite({
        entity_type: 'time_entry',
        entity_id: 1,
        start_at: '2026-03-10T01:00:00Z',
      }),
    ).not.toThrow();
  });

  it('guiSpanMiddleware still calls next()', async () => {
    const { guiSpanMiddleware } = await import(
      '../src/observability/spans.js'
    );
    let nextCalled = false;
    guiSpanMiddleware('/tmp/x.db')({}, {}, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
