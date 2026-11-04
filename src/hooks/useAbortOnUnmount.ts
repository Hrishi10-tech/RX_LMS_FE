import { useCallback, useEffect, useRef } from 'react';

/**
 * A signal that aborts when the component goes away.
 *
 * Most pages in this app fetch inside a `useEffect` and never cancel. Leaving
 * such a page abandons the request: the server finishes work nobody will read,
 * and the browser kills the connection in a way axios reports as a bare
 * `Network Error` — the same text it uses when the backend is genuinely down.
 * That made real outages and ordinary navigation indistinguishable in the
 * console, and would do the same in the error log.
 *
 * Usage is two lines per component:
 *
 *     const abortSignal = useAbortOnUnmount();
 *     client.get('/thing', { signal: abortSignal() })
 *
 * A getter rather than a bare signal, for two reasons. It stays valid across
 * a StrictMode double-mount — React 18 mounts, unmounts and remounts in
 * development, so a signal captured once would already be aborted by the time
 * the second mount fetched, and every request would fail in dev only. And it
 * can be called from an event handler as readily as from an effect.
 *
 * Deliberately scoped to the component rather than to each effect run. An
 * effect-scoped controller also cancels when dependencies change, which is
 * better still — but it has to be written per effect, and getting it wrong
 * cancels a request the next run actually wanted. Unmount-scoped is the
 * change that is correct everywhere without reading each call site's
 * dependency array.
 */
export function useAbortOnUnmount(): () => AbortSignal {
  const ref = useRef<AbortController | null>(null);

  const signal = useCallback(() => {
    // Recreated once aborted, so a remount does not inherit a dead signal.
    if (!ref.current || ref.current.signal.aborted) {
      ref.current = new AbortController();
    }
    return ref.current.signal;
  }, []);

  useEffect(() => () => ref.current?.abort(), []);

  return signal;
}
