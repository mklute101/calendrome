import { useEffect } from 'react';

/**
 * Poll `refetch` on an interval so writes from other surfaces (the
 * MCP server, another session) appear live. Paused while the tab is
 * hidden or `paused` is true (during drags / in-flight mutations);
 * refetches immediately on tab refocus.
 */
export function usePolling(refetch: () => void, intervalMs: number, paused: boolean) {
  useEffect(() => {
    if (paused) return;
    const tick = () => {
      if (!document.hidden) refetch();
    };
    const id = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (!document.hidden) refetch();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refetch, intervalMs, paused]);
}
