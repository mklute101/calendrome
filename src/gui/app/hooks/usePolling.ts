import { useEffect, useRef } from 'react';
import { fetchVersion } from '../api';

/**
 * Version-gated freshness polling (#132): every tick fetches the
 * cheap `/api/version` change stamp and calls `refetch` only when it
 * differs from the last one seen. The stamp check is a localhost
 * fs.stat, so it runs unconditionally — no `document.hidden` gating,
 * because a backgrounded Tauri webview does not report visibility the
 * way a browser tab does and a paused-on-hidden poller never wakes
 * there. `focus`/`pageshow`/`visibilitychange` all trigger an
 * immediate check as belt-and-braces wake signals.
 *
 * `paused` (drags / in-flight mutations) skips the check body but
 * keeps the interval and listeners registered, so unpausing catches
 * up on the next tick instead of never.
 */
export function usePolling(refetch: () => void, intervalMs: number, paused: boolean) {
  // Ref, not state: the last stamp must survive effect re-runs
  // (week change swaps `refetch` identity) without re-triggering.
  const lastStamp = useRef<string | null>(null);
  useEffect(() => {
    let inflight = false;
    const check = async () => {
      if (paused || inflight) return;
      inflight = true;
      try {
        const { stamp } = await fetchVersion();
        if (lastStamp.current !== null && stamp !== lastStamp.current) refetch();
        lastStamp.current = stamp;
      } catch {
        // Server unreachable — keep polling; next success resyncs.
      } finally {
        inflight = false;
      }
    };
    void check();
    const id = window.setInterval(() => void check(), intervalMs);
    const onWake = () => void check();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('pageshow', onWake);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('pageshow', onWake);
    };
  }, [refetch, intervalMs, paused]);
}
