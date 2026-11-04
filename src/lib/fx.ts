import { useEffect, useState } from 'react';
import { client } from './axios';
import { applyLiveRates } from '@/config/thresholds';

// Live FX bootstrap. The backend refreshes rates daily and exposes the current
// table at GET /fx/rates (public). Here we:
//   1. seed the in-memory table from localStorage SYNCHRONOUSLY at app start so
//      conversions are correct on first paint after any reload (no static flash),
//   2. revalidate from the network in the background and re-cache.
// On any failure we simply keep whatever's already applied (cached → static).

const CACHE_KEY = 'fx_rates_v1';
// Backend pulls daily; revalidate the client at most every 6h.
const REVALIDATE_MS = 6 * 60 * 60 * 1000;
const FX_UPDATED_EVENT = 'fx-rates-updated';

export interface FxMeta {
  source: 'live' | 'static';
  lastUpdated: string | null;       // when the backend last applied a live feed
  providerTimestamp: string | null; // the feed's own "as of" time
}

interface FxCache extends FxMeta {
  rates: Record<string, number>;
  cachedAt: number;
}

let meta: FxMeta = { source: 'static', lastUpdated: null, providerTimestamp: null };

export const getFxMeta = (): FxMeta => meta;

function readCache(): FxCache | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.rates) return parsed as FxCache;
  } catch {
    /* localStorage unavailable / corrupt → fall back to static */
  }
  return null;
}

function writeCache(c: FxCache): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch {
    /* quota / unavailable — non-fatal, in-memory rates still apply */
  }
}

function setMeta(next: FxMeta): void {
  meta = next;
  try {
    window.dispatchEvent(new CustomEvent(FX_UPDATED_EVENT));
  } catch {
    /* non-browser env */
  }
}

/**
 * Seed the conversion table from the last cached snapshot. Call this ONCE,
 * synchronously, before React renders (in main.tsx) so totals use last-known
 * live rates immediately rather than flashing the static baseline.
 */
export function seedFxFromCache(): void {
  const cache = readCache();
  if (!cache) return;
  const applied = applyLiveRates(cache.rates);
  if (applied.length > 0) {
    meta = {
      source: cache.source ?? 'live',
      lastUpdated: cache.lastUpdated ?? null,
      providerTimestamp: cache.providerTimestamp ?? null,
    };
  }
}

/**
 * Revalidate rates from the backend if the cache is stale (or absent), apply
 * them, and re-cache. Fire-and-forget; never throws.
 */
export async function bootstrapFxRates(): Promise<void> {
  const cache = readCache();
  if (cache && Date.now() - cache.cachedAt < REVALIDATE_MS) return; // still fresh
  try {
    const res = await client.get('/fx/rates');
    const payload = res.data?.data ?? res.data;
    if (!payload?.rates) return;
    const applied = applyLiveRates(payload.rates);
    if (applied.length === 0) return;
    setMeta({
      source: payload.source ?? 'live',
      lastUpdated: payload.lastUpdated ?? null,
      providerTimestamp: payload.providerTimestamp ?? null,
    });
    writeCache({
      rates: payload.rates,
      source: payload.source ?? 'live',
      lastUpdated: payload.lastUpdated ?? null,
      providerTimestamp: payload.providerTimestamp ?? null,
      cachedAt: Date.now(),
    });
  } catch {
    /* network/server down → keep cached/static rates */
  }
}

/** Re-renders on FX updates so a "rates as of …" indicator stays current. */
export function useFxMeta(): FxMeta {
  const [m, setM] = useState<FxMeta>(meta);
  useEffect(() => {
    const onUpdate = () => setM(getFxMeta());
    window.addEventListener(FX_UPDATED_EVENT, onUpdate);
    return () => window.removeEventListener(FX_UPDATED_EVENT, onUpdate);
  }, []);
  return m;
}
