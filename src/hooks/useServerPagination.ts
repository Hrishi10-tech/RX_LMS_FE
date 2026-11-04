import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

export interface ServerPaginationOptions {
  /** List endpoint, e.g. '/fixed-assets'. */
  endpoint: string;
  /** Rows per page. Default 10. */
  pageSize?: number;
  /** Extra query params (status, category, role, tab, scope, ...). Empty/undefined values are skipped. */
  params?: Record<string, string | number | boolean | undefined | null>;
  /** Key holding the rows in the response envelope. Default 'items' (a few endpoints use 'events'). */
  itemsKey?: string;
  /** When false, the hook idles (no fetch). Default true. */
  enabled?: boolean;
  /** When false, the `search` box value is NOT sent to the server (caller filters client-side). Default true. */
  serverSearch?: boolean;
  /**
   * Mirror `page` and `search` into the URL, so a filtered list survives a
   * reload and can be sent to a colleague.
   *
   * Opt-in, and namespaced by this key, because several pages run more than
   * one of these side by side — My Components has three — and they would
   * otherwise all fight over a single `?page=`. Pass `'page'` on a page with
   * one list for clean `?page=2&q=resistor`; pass something distinct
   * ('active', 'history') where there are several.
   *
   * Leave it unset and the hook behaves exactly as before.
   */
  urlKey?: string;
  /**
   * Fetch EVERY matching row (in server-sized chunks, up to LOAD_ALL_CAP) instead
   * of one page, for lists whose column filters run in the browser.
   *
   * Those filters used to see only the current 10 rows: picking Department =
   * Hardware on page 1 missed everyone on page 2, and the dropdown never even
   * offered values that only appeared on later pages. With this on, the caller
   * filters `items` (all rows) and pages the RESULT with useClientPagination.
   * The search box still goes to the server.
   */
  loadAll?: boolean;
}

/** Most rows a loadAll list will pull. Far above any list here today. */
export const LOAD_ALL_CAP = 2000;
/** Chunk size for loadAll — the server's own per-request cap (parseTake). */
const LOAD_ALL_CHUNK = 200;

/**
 * Server-side pagination for any list endpoint that returns `{ items, total }`
 * (optionally wrapped in `{ data: { items, total } }`). Mirrors the
 * `/users/paginated` contract used across the app: take/skip + case-insensitive
 * `search`, ordered server-side. Keeps only ONE page (≤ pageSize rows) in the
 * client so large tables can't blow up the DOM.
 *
 * Pair with the shared <Pagination> (currentPage/totalPages/onPageChange) and
 * <SearchInput> (value=search, onChange sets search).
 */
export function useServerPagination<T = any>(opts: ServerPaginationOptions) {
  const { endpoint, pageSize = 10, params, itemsKey = 'items', enabled = true, serverSearch = true, urlKey, loadAll = false } = opts;
  const { addToast } = useToast();

  // `?page=` / `?q=` when this is the page's only list, `?<key>Page=` /
  // `?<key>Q=` when it is one of several.
  const pageParam = urlKey ? (urlKey === 'page' ? 'page' : `${urlKey}Page`) : null;
  const searchParam = urlKey ? (urlKey === 'page' ? 'q' : `${urlKey}Q`) : null;
  const [searchParams, setSearchParams] = useSearchParams();

  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  /**
   * The server's own count of matching rows. Same as `total` for a paged list;
   * for a loadAll list `total` is what was actually loaded, which stops at
   * LOAD_ALL_CAP, so this is the only place the real number survives.
   */
  const [serverTotal, setServerTotal] = useState(0);
  // Seeded FROM the URL, so a reload or a pasted link lands where it should
  // rather than resetting to page 1 with an empty box.
  const [page, setPage] = useState(() => {
    const raw = pageParam ? Number(searchParams.get(pageParam)) : NaN;
    return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
  });
  const [search, setSearch] = useState(() => (searchParam ? searchParams.get(searchParam) ?? '' : ''));
  const [debouncedSearch, setDebouncedSearch] = useState(() => (searchParam ? searchParams.get(searchParam) ?? '' : ''));
  const [isLoading, setIsLoading] = useState(true);
  /**
   * Has a response ever arrived? Not the same as "not loading" — before the
   * first one lands we know nothing about how many pages there are, and
   * saying "one" is a guess that other components act on. See `totalPages`.
   */
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  // Stable key for the extra params so the effect only re-runs on real changes.
  const paramKey = useMemo(() => JSON.stringify(params ?? {}), [params]);

  // Debounce the search box (300ms after the user stops typing).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Narrowing the result set must reset to page 1 — the old page may not exist.
  //
  // Skipped on the very first run, or a link to `?page=3&q=resistor` would
  // seed page 3 and then immediately throw it away.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!settled) { setSettled(true); return; }
    setPage(1);
  }, [debouncedSearch, paramKey]);

  // Mirror page + search back into the URL.
  //
  // `replace`, not push: typing six characters into a search box should not
  // bury the previous page under six history entries that Back has to walk.
  // Defaults are omitted rather than written as `page=1&q=`, so an untouched
  // list keeps a clean address.
  useEffect(() => {
    if (!pageParam || !searchParam) return;
    const next = new URLSearchParams(searchParams);
    if (page > 1) next.set(pageParam, String(page)); else next.delete(pageParam);
    if (debouncedSearch) next.set(searchParam, debouncedSearch); else next.delete(searchParam);
    if (next.toString() !== searchParams.toString()) setSearchParams(next, { replace: true });
  }, [page, debouncedSearch, pageParam, searchParam]);

  useEffect(() => {
    // Idle (disabled) — clear the initial `true` so a gated table doesn't sit
    // on a permanent spinner waiting for a fetch that never fires.
    if (!enabled) { setIsLoading(false); setHasLoaded(true); return; }
    // `cancelled` stops a stale response being applied; the controller stops
    // the request itself. Both are needed, and only the first was here.
    //
    // Without the abort, typing in a search box fired a request per debounce
    // and let every one of them run to completion — the server did the work,
    // the bytes came back, and the answer was thrown away. Leaving the page
    // mid-load did the same, and the browser cancelling it on navigation
    // surfaced as a bare `Network Error` indistinguishable from the server
    // being down.
    const abort = new AbortController();
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      try {
        const query = (take: number, skip: number) => {
          const sp = new URLSearchParams();
          sp.set('take', String(take));
          sp.set('skip', String(skip));
          if (serverSearch && debouncedSearch.trim()) sp.set('search', debouncedSearch.trim());
          if (params) {
            for (const [k, v] of Object.entries(params)) {
              if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
            }
          }
          return sp.toString();
        };
        if (loadAll) {
          const all: T[] = [];
          let serverTotal = 0;
          // Advance by what actually came back: some endpoints cap a page below
          // LOAD_ALL_CHUNK (users stop at 100), so "a short page means the end"
          // would have stopped there.
          while (all.length < LOAD_ALL_CAP) {
            const res = await client.get(`${endpoint}?${query(LOAD_ALL_CHUNK, all.length)}`, { signal: abort.signal });
            const payload = res.data?.data ?? res.data ?? {};
            const rows = (Array.isArray(payload) ? payload : (payload[itemsKey] ?? payload.items ?? [])) as T[];
            serverTotal = Array.isArray(payload) ? rows.length : (payload.total ?? rows.length);
            all.push(...rows);
            if (rows.length === 0 || Array.isArray(payload) || all.length >= serverTotal) break;
          }
          if (cancelled) return;
          setItems(all);
          setTotal(all.length);
          setServerTotal(Math.max(serverTotal, all.length));
          setError(null);
          return;
        }
        const res = await client.get(`${endpoint}?${query(pageSize, (page - 1) * pageSize)}`, { signal: abort.signal });
        const payload = res.data?.data ?? res.data ?? {};
        if (cancelled) return;
        if (Array.isArray(payload)) {
          // Endpoint hasn't been converted to an envelope yet — degrade gracefully.
          setItems(payload as T[]);
          setTotal(payload.length);
          setServerTotal(payload.length);
        } else {
          setItems((payload[itemsKey] ?? payload.items ?? []) as T[]);
          setTotal(payload.total ?? 0);
          setServerTotal(payload.total ?? 0);
        }
        setError(null);
      } catch (e: any) {
        if (!cancelled) {
          const msg = extractErrorMessage(e, 'Failed to load data');
          setError(msg);
          addToast(msg, 'error');
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          // Set on failure as well as success. A request that errored still
          // tells us the guessing phase is over; leaving it false would park
          // `totalPages` on the page-floor forever and stop the self-heal
          // ever correcting a genuinely out-of-range page.
          setHasLoaded(true);
        }
      }
    })();
    return () => {
      cancelled = true;
      abort.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, loadAll ? 0 : page, debouncedSearch, paramKey, pageSize, enabled, serverSearch, itemsKey, tick, loadAll]);

  /**
   * How many pages there are — or, until the first response lands, a value
   * that does not contradict the page we were asked for.
   *
   * This used to be `Math.max(1, ceil(total / pageSize))` unconditionally.
   * `total` starts at 0, so for the whole of the first load it reported
   * exactly ONE page, and <Pagination> has a self-heal that moves you off a
   * page that no longer exists:
   *
   *     if (totalPages > 0 && currentPage > totalPages) onPageChange(totalPages)
   *
   * So opening `/inventory/components?page=2` seeded page 2 from the URL,
   * and then — before any data arrived — the self-heal "corrected" it to
   * page 1 and the URL sync stripped `?page=2` back out. A shared link or a
   * reload silently lost your place.
   *
   * Measured rather than reasoned about: a probe logged `seed page=2`,
   * then `url-sync page=1 'page=2' -> ''`, with the reset effect never
   * firing. Chromium usually answered the first request before the self-heal
   * ran and hid it; WebKit did not, which is how it surfaced.
   *
   * The floor of `page` is the fix: until we know better, the page being
   * asked for is assumed to exist, so nothing clamps it away. Once a response
   * has landed, the real count takes over and the self-heal works as intended
   * — including correcting a page that genuinely no longer exists.
   */
  const totalPages = hasLoaded
    ? Math.max(1, Math.ceil(total / pageSize))
    : Math.max(1, page);

  return {
    items, total, totalPages,
    page, setPage,
    search, setSearch,
    isLoading,
    /** Last load error message (null when the most recent load succeeded). */
    error,
    /** How many rows the server says match, whether or not they were all loaded. */
    serverTotal,
    /**
     * A loadAll list that hit LOAD_ALL_CAP: `items` holds the first
     * LOAD_ALL_CAP rows of `serverTotal`. Show <LoadAllCapNote> when true, or
     * the user reads the capped list as the whole history.
     */
    truncated: loadAll && serverTotal > items.length,
    /** Re-fetch the current page (after a mutation). */
    refetch: () => setTick(t => t + 1),
  };
}
