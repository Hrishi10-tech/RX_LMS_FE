import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * Handles a `?<param>=<id>` deep link that should reveal one row of a table:
 * scroll it into view, flash-highlight it, then strip the param so a refresh
 * doesn't re-fire.
 *
 * Notifications hand out `?openRequest=<id>` links for component requests to
 * ADMIN/SUPER_ADMIN (`/<slug>/approvals`), INVENTORY (`/inventory/requests`)
 * and requesters (their tracker) — but only the tracker even read the param,
 * and it looked for `[data-request-id]`, an attribute nothing in the app
 * renders (DataTable emits `data-row-id`). So every one of those links landed
 * on the right page and then did nothing at all: no scroll, no highlight, no
 * explanation. This centralises the behaviour on the attribute DataTable
 * actually writes.
 *
 * Rows live on server-paginated tables, so the target may not be on the page
 * in front of the user. That case gets `onMissing` instead of silence.
 */
export function useRowDeepLink({
  param,
  ready,
  onMissing,
}: {
  /** Query-string key, e.g. 'openRequest'. */
  param: string;
  /**
   * False while the table is still loading. Note this is only a hint: the
   * loading flags these pages expose are also false BEFORE the first fetch
   * starts, which is why the lookup below polls rather than taking one shot.
   */
  ready: boolean;
  /** Called with the id when the row never shows up. */
  onMissing?: (id: string) => void;
}): string | null {
  const [searchParams, setSearchParams] = useSearchParams();
  const targetId = searchParams.get(param);
  const handledRef = useRef<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);

  // Timers live in refs, cleared only on unmount.
  //
  // They must NOT be torn down by the lookup effect's own cleanup: that effect
  // strips the query param, which changes `targetId`, which re-runs the effect
  // — so a cleanup returned from it cancelled the very lookup it had just
  // started, every single time. That was the bug behind "the highlight never
  // appears" even after the selector was corrected.
  const pollRef = useRef<number | null>(null);
  const fadeRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
      if (fadeRef.current) window.clearTimeout(fadeRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!targetId || !ready) return;
    if (handledRef.current === targetId) return;
    handledRef.current = targetId;

    const id = targetId;
    const DEADLINE_MS = 3000;
    const INTERVAL_MS = 150;
    let waited = 0;

    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      const row = document.querySelector(`[data-row-id="${id}"]`);
      if (row) {
        window.clearInterval(pollRef.current!);
        pollRef.current = null;
        row.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        setHighlightId(id);
        // Fade rather than leaving the row permanently marked.
        fadeRef.current = window.setTimeout(() => setHighlightId(null), 4000);
        return;
      }
      waited += INTERVAL_MS;
      if (waited >= DEADLINE_MS) {
        window.clearInterval(pollRef.current!);
        pollRef.current = null;
        onMissing?.(id);
      }
    }, INTERVAL_MS);

    // Strip the param so a refresh doesn't re-open it. Safe to do now: the
    // lookup above no longer depends on this effect staying mounted.
    const next = new URLSearchParams(searchParams);
    next.delete(param);
    setSearchParams(next, { replace: true });
    // `searchParams`/`setSearchParams`/`onMissing` are read imperatively;
    // including them would re-run this effect on the strip above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId, ready, param]);

  return highlightId;
}
