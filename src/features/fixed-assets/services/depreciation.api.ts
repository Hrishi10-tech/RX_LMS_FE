import { client } from '@/api';

/**
 * Thin wrapper around the depreciation endpoints. Same pattern as
 * `bom-lists.api.ts` — exists so callers don't have to remember
 * the route shape (`/depreciation/...`) and so we can swap in a
 * different transport / mock in tests later.
 */
export const depreciationApi = {
  /**
   * Preview what the NEXT period's posting will look like for an asset.
   * Pure read; used by the asset details modal to show "Est. next
   * period: ₹1,234" inline so Finance can sanity-check.
   */
  previewForAsset: (assetId: string) =>
    client.get(`/depreciation/preview/${assetId}`).then(r => r.data?.data ?? r.data),

  /** Full posting timeline (one row per period, newest first). */
  getEntries: (assetId: string) =>
    client.get(`/depreciation/assets/${assetId}/entries`).then(r => r.data?.data ?? r.data),

  /** Org-wide totals for the Finance dashboard tile. */
  getDashboardTotals: () =>
    client.get('/depreciation/dashboard').then(r => r.data?.data ?? r.data),

  /** Finance hits this to close a period manually. Idempotent. */
  postPeriod: (asOf?: string) =>
    client.post('/depreciation/post', { asOf }).then(r => r.data?.data ?? r.data),

  /** List per-category defaults — populates the Finance settings page. */
  listCategoryDefaults: () =>
    client.get('/depreciation/category-defaults').then(r => r.data?.data ?? r.data),

  /**
   * Apply the category defaults to assets that have no depreciation config of
   * their own. The backend runs this once at startup, so it only ever matters
   * after someone edits a default here — the assets already registered under
   * the old one keep it until this is run.
   *
   * `apply: false` is a dry run and returns the same count without writing,
   * which is what the button uses to say how many assets it would touch before
   * anyone commits to it.
   */
  backfillDefaults: (apply: boolean) =>
    client.post(`/depreciation/backfill-defaults?apply=${apply ? 'true' : 'false'}`)
      .then(r => r.data?.data ?? r.data),

  /**
   * The depreciation schedule as CSV text.
   *
   * Goes through the shared client so the auth header is attached — a plain
   * `<a href>` to this endpoint would arrive unauthenticated and 401. The
   * caller turns the text into a download.
   */
  exportSchedule: (params?: { from?: string; to?: string }) =>
    client.get('/depreciation/export', { params, responseType: 'text' }).then(r => r.data as string),

  /** The master on/off switch. */
  getConfig: () =>
    client.get('/depreciation/config').then(r => r.data?.data ?? r.data),

  setConfig: (enabled: boolean, note?: string) =>
    client.put('/depreciation/config', { enabled, ...(note ? { note } : {}) }).then(r => r.data?.data ?? r.data),

  /** Dispose of an asset — computes gain/loss against book value. */
  dispose: (assetId: string, body: { proceeds?: number | null; disposedOn?: string | null; note?: string | null }) =>
    client.post(`/fixed-assets/${assetId}/dispose`, body).then(r => r.data?.data ?? r.data),

  /** Record depreciation accrued before this system existed. */
  setOpeningBalance: (assetId: string, body: { accumulated: number; asOf: string }) =>
    client.post(`/fixed-assets/${assetId}/opening-depreciation`, body).then(r => r.data?.data ?? r.data),

  /** Upsert defaults for one category. */
  upsertCategoryDefault: (category: string, body: {
    usefulLifeMonths: number;
    salvageValuePercent?: number;
    depreciationMethod?: string;
    legalReference?: string | null;
  }) => client.put(`/depreciation/category-defaults/${category}`, body).then(r => r.data?.data ?? r.data),
};
