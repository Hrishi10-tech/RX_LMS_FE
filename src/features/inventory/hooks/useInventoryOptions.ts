import { useCallback, useEffect, useState } from 'react';
import { client } from '@/api';
import { useAbortOnUnmount } from '@/hooks';

/**
 * How many items a picker loads before anyone types.
 *
 * Only has to look populated — the search box queries the server, so this is
 * not a ceiling on what can be found, just on what is downloaded up front.
 */
export const PICKER_INITIAL_ITEMS = 50;

export interface InventoryOption {
  id: string;
  name: string;
  unit?: string | null;
  stock?: number | null;
  status?: string | null;
  category?: string | null;
  departmentId?: string | null;
  isShared?: boolean;
}

/**
 * The COMPLETE list of inventory items the signed-in user can see.
 *
 * Use this anywhere a user has to PICK an item — the Request Component modal,
 * the receive-goods matcher, a dashboard lookup. Do NOT use it to render a
 * browsable table; that wants useServerPagination against `/inventory`.
 *
 * Why it exists: `GET /inventory` is a paginated table read that caps at 200
 * rows ordered by name. Every picker was calling it with no params and treating
 * that alphabetical first page as the whole inventory, so past 200 items
 * anything late in the alphabet could not be selected — and because those pages
 * filter client-side, the search box could not find it either. That is how an
 * item correctly marked Shared ends up invisible, and why renaming it made it
 * reappear: the new name moved it inside the first 200.
 *
 * `/inventory/options` returns every scoped row with a narrow projection, so a
 * complete list stays cheap.
 */
/**
 * @param take  Ask for a SHORT list instead of the whole catalogue.
 *
 * Pages that own a picker used to pull every scoped row on mount — up to
 * 5,000 — whether or not anyone opened the picker. That is the wait before the
 * page is usable, paid on every visit by everyone. Now the picker searches the
 * server as you type, so the initial list only has to look populated; pass a
 * small `take` and let the search find the rest.
 *
 * Omit it and the behaviour is unchanged (the full scoped list), because some
 * callers still scan the array for other purposes.
 */
export const useInventoryOptions = (take?: number) => {
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();
  const [items, setItems] = useState<InventoryOption[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [truncated, setTruncated] = useState(false);
  const [total, setTotal] = useState(0);

  const refetch = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await client.get('/inventory/options',
        // Merge rather than replace: this call already varies its config.
        take ? { params: { take }, signal: abortSignal() } : { signal: abortSignal() });
      const payload = res.data?.data ?? res.data;
      setItems(payload?.items ?? []);
      // Surfaced rather than swallowed: the whole point of this hook is that a
      // caller is never silently handed a partial list again. `total` comes
      // back too so a picker can say HOW MANY it is not showing — "4 items
      // hidden" and "40,000 items hidden" are different problems.
      setTruncated(Boolean(payload?.truncated));
      setTotal(Number(payload?.total ?? payload?.items?.length ?? 0));
    } catch {
      // Leave the previous list in place; a picker with stale options beats a
      // picker that empties itself on a transient network blip.
    } finally {
      setIsLoading(false);
    }
  }, [take]);

  useEffect(() => { void refetch(); }, [refetch]);

  return { items, isLoading, truncated, total, refetch };
};
