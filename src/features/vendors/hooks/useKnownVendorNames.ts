import { useCallback, useEffect, useState } from 'react';
import { client } from '@/api';
import { useAbortOnUnmount } from '@/hooks';

export interface KnownVendor {
  name: string;
  /** How many allocations / orders have used this name. */
  uses: number;
  /** Already curated into the Vendor Code List. */
  inList: boolean;
}

/**
 * Every vendor name the organisation has actually used.
 *
 * The vendor field on an indent has always had a suggestion list, fed only
 * from the Vendor Code List — which held two entries while twenty-two distinct
 * names had been typed on indents, none of them in the list. A picker that
 * suggests nothing is a free-text box, and that is where "Bilnkit" sitting
 * next to "Blinkit" comes from.
 *
 * So suggestions now come from what has been USED as well as what has been
 * curated, and a name can be promoted into the curated list from where it is
 * typed rather than by going to another page to re-enter it.
 */
export const useKnownVendorNames = () => {
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [names, setNames] = useState<KnownVendor[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const res = await client.get('/vendor-codes/known-names', { signal: abortSignal() });
      const payload = res.data?.data ?? res.data;
      setNames(payload?.names ?? []);
    } catch {
      // Leave whatever we had. Suggestions are an assist, not a gate — a
      // transient failure must never stop somebody entering a vendor.
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { void refetch(); }, [refetch]);

  /** Promote a typed name into the Vendor Code List. The code is generated server-side. */
  const saveToList = useCallback(async (vendorName: string) => {
    await client.post('/vendor-codes', { vendorName: vendorName.trim() });
    await refetch();
  }, [refetch]);

  return { names, isLoading, refetch, saveToList };
};

/**
 * The known name that `typed` looks like a misspelling of, or null.
 *
 * Deliberately quiet. It returns nothing for a match that differs only by
 * case, because "amazon" and "Amazon" are one vendor and asking about them
 * would be noise — the kind that gets dismissed on reflex until the one real
 * warning is dismissed with it. It speaks only for a genuine near-miss: one
 * edit away for short names, two for longer ones.
 */
export const findSimilarVendor = (typed: string, known: KnownVendor[]): string | null => {
  const t = typed.trim().toLowerCase();
  if (t.length < 3) return null;
  let best: { name: string; distance: number } | null = null;
  for (const k of known) {
    const candidate = k.name.trim().toLowerCase();
    if (candidate === t) return null;            // same vendor, different case
    const allowed = Math.max(t.length, candidate.length) >= 8 ? 2 : 1;
    const d = editDistance(t, candidate, allowed);
    if (d <= allowed && (!best || d < best.distance)) best = { name: k.name, distance: d };
  }
  return best?.name ?? null;
};

/**
 * Damerau-Levenshtein distance, abandoned once it provably exceeds `limit`.
 *
 * Damerau, not plain Levenshtein, because a swap of two neighbouring letters
 * has to count as ONE mistake. It is the commonest typo there is, and plain
 * Levenshtein scores it as two — which would have made this miss the exact
 * case it was built for: "Bilnkit" is "Blinkit" with two letters transposed,
 * and at a threshold of one edit it would have passed without a word.
 *
 * The bail-out is what makes this safe to run on every keystroke against the
 * whole vendor list: a name that is nowhere near stops costing anything after
 * a couple of rows of the matrix.
 */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  // Three rows: the one before last is what a transposition reaches back to.
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      // …and the swap itself: "ab" -> "ba" is one mistake, not two.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, prev2[j - 2] + 1);
      }
      curr[j] = best;
      if (best < rowMin) rowMin = best;
    }
    if (rowMin > limit) return limit + 1;
    prev2 = prev;
    prev = curr;
  }
  return prev[b.length];
}
