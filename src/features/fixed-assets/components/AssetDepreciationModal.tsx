import { useEffect, useState } from 'react';
import { Modal, Pagination } from '@/components/ui';
import { useClientPagination, useAuth } from '@/hooks';
import { useToast } from '@/context/ToastContext';
import { fmtDateTime } from '@/utils/date';
import { csvTextCell } from '@/utils/csv';
import { TrendingDown, RefreshCw, Download } from 'lucide-react';
import { depreciationApi } from '../services/depreciation.api';
import { extractErrorMessage } from '@/lib';

interface Props {
  /** Asset id when open; null when closed. */
  assetId: string | null;
  /** Header context — passed in so the modal opens instantly w/o a fetch. */
  assetMeta: {
    assetTag: string;
    name: string;
    purchaseValue: number | null;
    currentValue: number | null;
    salvageValue: number | null;
    depreciationMethod: string | null;
    usefulLifeMonths: number | null;
  } | null;
  onClose: () => void;
}

/**
 * Per-asset depreciation timeline + next-period preview.
 *
 * Renders:
 *   - Header chips: purchase value, accumulated depreciation, current book.
 *   - Next-period preview pulled from `/depreciation/preview/:id`.
 *   - A reverse-chronological list of every DepreciationEntry the cron
 *     (or Finance) has posted, with running totals + book-value-after.
 *
 * The history table is the audit-grade view auditors look at: every line
 * shows method-at-time-of-posting (in case Finance changed methods mid-
 * life) + who posted it.
 */
export const AssetDepreciationModal = ({ assetId, assetMeta, onClose }: Props) => {
  const { user } = useAuth();
  // Opening balances are Finance / Super Admin only on the server.
  const canSetOpening = user?.role === 'FINANCE' || user?.role === 'SUPER_ADMIN';
  const { addToast } = useToast();
  const [entries, setEntries] = useState<any[]>([]);
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  // Opening-balance form state. Local to the modal because it's a one-shot
  // action, not part of the timeline data.
  const [openingAccum, setOpeningAccum] = useState<string>('');
  const [openingAsOf, setOpeningAsOf] = useState<string>(() => {
    // Default to the end of last month: the usual "as at" for a carried-in
    // figure, and it keeps depreciation resuming from this month.
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 0).toISOString().slice(0, 10);
  });
  const [savingOpening, setSavingOpening] = useState(false);
  // Audit list grows ~1 row/month over an asset's life (100+ over 10y).
  // Paginate 10/page to bound the DOM; per-row accum/book values are
  // backend-computed so slicing is safe. Reset when a different asset opens.
  const pager = useClientPagination<any>(entries, 10, assetId || '');

  const refetch = async () => {
    if (!assetId) return;
    setLoading(true);
    try {
      // Parallel — preview + entries are independent.
      const [e, p] = await Promise.all([
        depreciationApi.getEntries(assetId),
        depreciationApi.previewForAsset(assetId),
      ]);
      setEntries(Array.isArray(e) ? e : []);
      setPreview(p);
    } catch (err: any) {
      addToast(extractErrorMessage(err, 'Failed to load depreciation history'), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (assetId) refetch();
    else { setEntries([]); setPreview(null); }
    // We intentionally only depend on assetId — the refetch closure
    // captures the latest state on each render, no need to track it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetId]);

  const purchase = assetMeta?.purchaseValue != null ? Number(assetMeta.purchaseValue) : null;
  const current = assetMeta?.currentValue != null ? Number(assetMeta.currentValue) : null;
  const accumulated = purchase != null && current != null ? purchase - current : null;

  const fmtINR = (n: number | null | undefined) =>
    n == null ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

  // Client-side CSV of the depreciation entries currently loaded.
  // Dependency-free: build a CSV string, blob it, click a synthetic
  // anchor, revoke. Exports ALL loaded rows, not just the current page.
  const exportCSV = () => {
    // Text cells only (names are user-typed — see csvTextCell); the money
    // columns stay raw numbers so a spreadsheet can sum them.
    const cell = csvTextCell;
    const period = (e: any) =>
      new Date(e.periodEnd).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
    const header = 'S.No,Period,Amount,Accumulated Dep.,Book Value After,Method,Posted By,Posted At\n';
    const rows = entries.map((e, i) => [
      i + 1,
      cell(period(e)),
      e.amount ?? '',
      e.accumulatedAfter ?? '',
      e.bookValueAfter ?? '',
      cell(e.method?.replace(/_/g, ' ') || ''),
      cell(e.postedBy?.name || 'Cron'),
      cell(fmtDateTime(e.createdAt)),
    ].join(',')).join('\n');
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `asset-depreciation-${assetMeta?.assetTag || 'asset'}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const title = assetMeta
    ? `${assetMeta.assetTag} — ${assetMeta.name} · Depreciation timeline`
    : 'Depreciation timeline';

  const saveOpeningBalance = async () => {
    if (!assetId) return;
    const accumulated = Number(openingAccum);
    if (Number.isNaN(accumulated) || accumulated < 0) {
      addToast('Enter the amount already depreciated (0 or more).', 'error');
      return;
    }
    // The "as of" date is required by the server; say so here instead of
    // letting an emptied box come back as "asOf must be a date".
    if (!openingAsOf) {
      addToast('Pick the date the opening balance is as of.', 'error');
      return;
    }
    setSavingOpening(true);
    try {
      const r = await depreciationApi.setOpeningBalance(assetId, { accumulated, asOf: openingAsOf });
      addToast(
        `Opening balance recorded — book value is now ₹${Number(r?.bookValue ?? 0).toLocaleString('en-IN')}.`,
        'success',
      );
      setOpeningAccum('');
      refetch();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not record the opening balance'), 'error');
    }
    setSavingOpening(false);
  };

  return (
    <Modal isOpen={!!assetId} onClose={onClose} title={title}>
      <div className="space-y-4">
        {/* Top chip strip — at-a-glance summary. The accumulated depreciation
            value is the answer to "what have we written off so far?". */}
        {assetMeta && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
            <div className="bg-surface rounded-md p-2.5 border border-line-soft">
              <p className="text-[10px] text-faint uppercase font-bold">Purchase value</p>
              <p className="font-bold text-ink mt-0.5">{fmtINR(purchase)}</p>
            </div>
            <div className="bg-amber-50/50 dark:bg-amber-400/15 rounded-md p-2.5 border border-amber-100 dark:border-amber-400/25">
              <p className="text-[10px] text-amber-700 dark:text-amber-300 uppercase font-bold">Accumulated dep.</p>
              <p className="font-bold text-amber-900 dark:text-amber-200 mt-0.5">{fmtINR(accumulated)}</p>
            </div>
            <div className="bg-emerald-50/50 dark:bg-emerald-400/15 rounded-md p-2.5 border border-emerald-100 dark:border-emerald-400/25">
              <p className="text-[10px] text-emerald-700 dark:text-emerald-300 uppercase font-bold">Net book value</p>
              <p className="font-bold text-emerald-900 dark:text-emerald-200 mt-0.5">{fmtINR(current)}</p>
            </div>
            <div className="bg-sky-50/50 dark:bg-sky-400/15 rounded-md p-2.5 border border-sky-100 dark:border-sky-400/25">
              <p className="text-[10px] text-sky-700 dark:text-sky-300 uppercase font-bold">Method · life</p>
              <p className="font-bold text-sky-900 dark:text-sky-200 mt-0.5 text-[11px]">
                {assetMeta.depreciationMethod
                  ? `${assetMeta.depreciationMethod.replace(/_/g, ' ')}`
                  : 'Not set'}
              </p>
              {assetMeta.usefulLifeMonths != null && (
                <p className="text-[10px] text-sky-700 dark:text-sky-300 mt-0.5">
                  {assetMeta.usefulLifeMonths} mo
                  {assetMeta.usefulLifeMonths >= 12 && ` (${Math.round(assetMeta.usefulLifeMonths / 12)} y)`}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Next-period preview — shows what tomorrow's posting will look
            like, so Finance can compare against their internal sheet. */}
        {preview && preview.depreciable && (
          <div className="border border-blue-200 dark:border-blue-400/30 bg-blue-50/30 dark:bg-blue-400/15 rounded-md p-3 text-xs">
            <p className="font-bold text-blue-900 dark:text-blue-200 mb-1.5">Next period preview</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-ink">
              <div>
                <span className="text-[10px] text-faint uppercase font-bold block">Months elapsed</span>
                <span className="font-bold">{preview.monthsElapsed} / {preview.monthsElapsed + preview.remainingMonths}</span>
              </div>
              <div>
                <span className="text-[10px] text-faint uppercase font-bold block">Next period amount</span>
                <span className="font-bold text-amber-700 dark:text-amber-300">{fmtINR(Number(preview.nextPeriodAmount))}</span>
              </div>
              <div>
                <span className="text-[10px] text-faint uppercase font-bold block">Projected book after</span>
                <span className="font-bold">{fmtINR(Number(preview.projectedBookValueAfterNext))}</span>
              </div>
              <div>
                <span className="text-[10px] text-faint uppercase font-bold block">Salvage floor</span>
                <span className="text-muted">{fmtINR(Number(preview.salvageValue))}</span>
              </div>
            </div>
          </div>
        )}

        {preview && !preview.depreciable && (
          <div className="border border-line bg-surface rounded-md p-3 text-xs text-muted">
            <p className="font-bold text-ink mb-0.5">Not depreciating</p>
            <p>{preview.reason || 'Asset is not configured for depreciation.'}</p>
          </div>
        )}

        {/* History table — newest first. */}
        <div className="border border-line-soft rounded-md overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-surface border-b border-line-soft">
            <div className="flex items-center gap-2">
              <TrendingDown size={14} className="text-muted" />
              <h4 className="text-xs font-bold text-ink">Posting history ({entries.length})</h4>
            </div>
            <div className="flex items-center gap-3">
              {entries.length > 0 && (
                <button
                  onClick={exportCSV}
                  className="text-[10px] font-bold text-muted hover:text-brand inline-flex items-center gap-1"
                >
                  <Download size={11} />
                  Download CSV
                </button>
              )}
              <button
                onClick={refetch}
                disabled={loading}
                className="text-[10px] font-bold text-muted hover:text-brand inline-flex items-center gap-1 disabled:opacity-50"
              >
                <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
                Refresh
              </button>
            </div>
          </div>
          {/* Opening balance. Offered only when nothing has been posted yet,
              because that's the only time it's valid — the server refuses it
              once entries exist, since it would double-count. This is the
              natural place for it: the timeline is where you look when you ask
              "why does this asset show nothing accumulated". */}
          {canSetOpening && entries.length === 0 && !loading && (
            <div className="mb-3 rounded-lg border border-blue-200 dark:border-blue-400/30 bg-blue-50 dark:bg-blue-400/15 px-3 py-2.5">
              <p className="text-xs font-bold text-blue-900 dark:text-blue-200">Bought before this system?</p>
              <p className="mt-0.5 text-[11px] text-blue-800 dark:text-blue-200">
                Record what it had already depreciated, so the register doesn't carry it at full cost.
                Entered once, as at a month-end.
              </p>
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <div>
                  <label htmlFor="ob-accum" className="block text-[10px] font-bold uppercase text-blue-900 dark:text-blue-200">
                    Already depreciated
                  </label>
                  <input
                    id="ob-accum"
                    type="number"
                    min={0}
                    step="0.01"
                    value={openingAccum}
                    onChange={(e) => setOpeningAccum(e.target.value)}
                    className="w-32 rounded border border-blue-200 dark:border-blue-400/30 px-2 py-1 text-sm"
                  />
                </div>
                <div>
                  <label htmlFor="ob-asof" className="block text-[10px] font-bold uppercase text-blue-900 dark:text-blue-200">
                    As at
                  </label>
                  <input
                    id="ob-asof"
                    type="date"
                    value={openingAsOf}
                    onChange={(e) => setOpeningAsOf(e.target.value)}
                    className="rounded border border-blue-200 dark:border-blue-400/30 px-2 py-1 text-sm"
                  />
                </div>
                <button
                  onClick={saveOpeningBalance}
                  disabled={savingOpening || openingAccum === ''}
                  className="rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingOpening ? 'Saving…' : 'Record'}
                </button>
              </div>
            </div>
          )}

          {entries.length === 0 ? (
            <div className="text-center py-8 px-4 text-xs text-faint">
              {loading ? 'Loading…' : 'No depreciation postings yet. The monthly cron writes the first entry on the 1st of next month, or Finance can hit "Post depreciation now" to backfill.'}
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-surface/60 text-[10px] uppercase tracking-wider text-muted">
                <tr>
                  <th className="text-left px-3 py-1.5 font-bold">Period</th>
                  <th className="text-right px-2 py-1.5 font-bold">Amount</th>
                  <th className="text-right px-2 py-1.5 font-bold">Accum. dep.</th>
                  <th className="text-right px-2 py-1.5 font-bold">Book after</th>
                  <th className="text-left px-2 py-1.5 font-bold">Method</th>
                  <th className="text-left px-3 py-1.5 font-bold">Posted by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {pager.pageRows.map((e) => (
                  <tr key={e.id} className="hover:bg-surface/40">
                    <td className="px-3 py-2 font-medium text-ink">
                      {new Date(e.periodEnd).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-amber-700 dark:text-amber-300 font-bold">
                      {fmtINR(Number(e.amount))}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-muted">
                      {fmtINR(Number(e.accumulatedAfter))}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-emerald-700 dark:text-emerald-300 font-bold">
                      {fmtINR(Number(e.bookValueAfter))}
                    </td>
                    <td className="px-2 py-2 text-[10px] text-muted">
                      {e.method?.replace(/_/g, ' ')}
                    </td>
                    <td className="px-3 py-2 text-[10px] text-muted">
                      {e.postedBy?.name || <span className="italic">Cron</span>}
                      <p className="text-[9px] text-faint mt-0.5">{fmtDateTime(e.createdAt)}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {entries.length > 0 && (
            <Pagination currentPage={pager.page} totalPages={pager.totalPages} onPageChange={pager.setPage} />
          )}
        </div>

        <div className="flex justify-end pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
};
