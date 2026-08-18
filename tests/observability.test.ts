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
