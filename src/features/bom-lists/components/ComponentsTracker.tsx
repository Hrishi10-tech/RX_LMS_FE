import { Fragment, ReactElement } from 'react';
import { fmtDate, fmtDateTime } from '@/utils/date';

interface ComponentsTrackerProps {
  /** The bottom-up component rollup (rows + totals) from the parent's memo. */
  rollup: { rows: Array<{ row: any; badge: ReactElement }>; total: number };
  /** Already-lowercased, already-trimmed filter query (parent owns the input). */
  itemQuery: string;
  /** Raw filter text, for the "no matches" copy. */
  itemSearch: string;
  // Re-raise inline form state (owned by the parent, keyed by request id).
  reraiseDraftFor: string | null;
  reraiseQty: number | '';
  setReraiseQty: (v: number | '') => void;
  reraiseReason: string;
  setReraiseReason: (v: string) => void;
  reraisingId: string | null;
  onOpenReraise: (req: any) => void;
  onCancelReraise: () => void;
  onSubmitReraise: (req: any) => void;
  /** Close the editor modal (used before navigating to a request/indent). */
  onClose: () => void;
  navigate: (to: string) => void;
  roleSlug: string;
}

/**
 * "Components" — ONE unified list of every component on this
 * routed BOM, one row per physical part, showing where it is right
 * now. The trick that kills the old triple-repeat: a part that went
 * short-stock → ordered → received → issued spawns a downstream
 * ComponentRequest, which we fold back onto its indent line via the
 * sourceIndentItemId link. So it shows up ONCE, carrying its latest
 * status — never as an indent line AND the request it turned into.
 * In-stock parts (issued straight from inventory) and re-raises carry
 * no such link, so each is simply its own row.
 */
export const ComponentsTracker = ({
  rollup: componentRollup,
  itemQuery,
  itemSearch,
  reraiseDraftFor,
  reraiseQty,
  setReraiseQty,
  reraiseReason,
  setReraiseReason,
  reraisingId,
  onOpenReraise: openReraise,
  onCancelReraise: cancelReraise,
  onSubmitReraise: submitReraise,
  onClose,
  navigate,
  roleSlug,
}: ComponentsTrackerProps) => {
  // Single bottom-up source of truth: `componentRollup` (module-level
  // classifyComponent + the memo up top) already folded received-then-
  // issued parts onto their indent line and classified each component
  // into issued / pending / closed. This table only RENDERS those
  // rows — so the headline chips ("2 issued · 1 pending") and the
  // per-row badges are physically incapable of disagreeing.
  //
  // Filter (shared search box above) — match on part name or either
  // reference number, so someone can jump to "ADS1294" or "IND-002".
  const shown = itemQuery
    ? componentRollup.rows.filter((d) =>
        `${d.row.name} ${d.row.req?.serialNo || ''} ${d.row.indent?.serialNo || ''}`
          .toLowerCase().includes(itemQuery))
    : componentRollup.rows;

  // Shared <th> chrome: sticky so the header stays put while the body
  // scrolls, with an inset bottom rule that survives the sticky repaint.
  const thCls = 'sticky top-0 z-10 bg-brand-50 font-bold px-3 py-2 text-[10px] uppercase tracking-wide text-muted shadow-[inset_0_-1px_0_#E5E7EB]';
  return (
    <div className="space-y-3 border border-brand-200 bg-brand-100/40 rounded-lg p-3">
      <div className="flex items-baseline gap-2 flex-wrap">
        <h4 className="text-sm font-bold text-ink">Components</h4>
        <span className="text-[11px] font-bold text-muted">{componentRollup.total} total</span>
      </div>

      <div className="border border-line bg-card rounded-md overflow-hidden">
        <div className="max-h-[42vh] overflow-y-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <th className={`${thCls} text-left`}>Ref</th>
                <th className={`${thCls} text-left`}>Component</th>
                <th className={`${thCls} text-right`}>Qty</th>
                <th className={`${thCls} text-left`}>Source</th>
                <th className={`${thCls} text-left`}>Status</th>
                <th className={`${thCls} w-px`} aria-label="Actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {shown.map(({ row, badge }) => {
                const r = row.req;
                // The reference + click target: for a part that has a live
                // request (in-stock, or ordered→issued) open the request;
                // for one still in procurement open the indent.
                const serial = r?.serialNo || row.indent?.serialNo;
                const open = r
                  ? () => { onClose(); navigate(`/${roleSlug}/ip-requests?openRequest=${r.id}`); }
                  : () => { onClose(); navigate(`/${roleSlug}/ip-requests?openIndent=${row.indent.id}`); };
                const isReraisable = !!r && ['REJECTED', 'DISPOSED', 'CONSUMED', 'RETURNED'].includes(r.status);
                const isExpanded = !!r && reraiseDraftFor === r.id;
                // Show an ETA only while an ordered part is still in transit
                // (once issued, its request status carries the story).
                const ind = row.indent;
                const showEta = row.sourced === 'ordered' && !r && ind?.expectedDeliveryDate
                  && ['ORDERED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(ind.status);
                return (
                  <Fragment key={row.key}>
                    <tr onClick={open} className="align-top hover:bg-surface cursor-pointer">
                      <td className="px-3 py-2.5 font-mono text-xs font-bold text-ink whitespace-nowrap">{serial || '—'}</td>
                      <td className="px-3 py-2.5 text-ink">
                        <span className="block truncate max-w-[42ch]">{row.name}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-xs text-muted whitespace-nowrap tabular-nums">{row.qty} {row.unit}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {row.sourced === 'stock' ? (
                          <span title="Issued from existing inventory stock." className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded border bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30">From stock</span>
                        ) : (
                          <span title={r ? `Ordered through procurement on ${ind?.serialNo}, then issued to you.` : 'Was short in stock — being bought through procurement.'} className="inline-flex text-[10px] font-bold px-1.5 py-0.5 rounded border bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30">
                            Ordered{r && ind?.serialNo ? ` · ${ind.serialNo}` : ''}
                          </span>
                        )}
                        {showEta && (
                          <span className="block mt-0.5 text-[10px] text-faint">
                            ETA {ind.expectedDeliveryHasTime ? fmtDateTime(ind.expectedDeliveryDate) : fmtDate(ind.expectedDeliveryDate)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{badge}</td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-right">
                        {isReraisable && !isExpanded && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openReraise(r); }}
                            className="text-[10px] font-bold text-brand hover:text-brand-dark px-2 py-0.5 border border-brand rounded"
                            title="Re-raise a fresh request from this BOM with adjusted qty + reason"
                          >
                            ↺ Re-raise
                          </button>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr className="bg-brand-100/60">
                        <td colSpan={6} className="px-3 py-3 border-t border-brand-200">
                          <div className="space-y-2">
                            <p className="text-[10px] text-muted leading-relaxed">
                              Raising a fresh request from this BOM. Original ({r.serialNo}) stays on record. Adjust the qty if that's what was wrong, and add a short reason so your manager understands the change.
                            </p>
                            <div className="flex items-center gap-2 flex-wrap">
                              <label className="text-[10px] font-bold text-muted uppercase">New qty</label>
                              <input
                                type="number"
                                min={1}
                                value={reraiseQty}
                                onChange={(e) => setReraiseQty(e.target.value === '' ? '' : Number(e.target.value))}
                                className="w-24 px-2 py-1 border rounded text-sm focus:border-brand outline-none"
                              />
                              <span className="text-[10px] text-faint">{r.inventoryItem?.unit}</span>
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-muted uppercase mb-1">
                                Reason <span className="text-faint font-normal">(shown to manager)</span>
                              </label>
                              <textarea
                                value={reraiseReason}
                                onChange={(e) => setReraiseReason(e.target.value)}
                                rows={2}
                                placeholder="e.g. corrected count after recheck — 5 not 1"
                                className="w-full px-2 py-1.5 border rounded text-xs focus:border-brand outline-none resize-none"
                              />
                            </div>
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                onClick={cancelReraise}
                                disabled={reraisingId === r.id}
                                className="text-xs font-bold text-muted px-3 py-1 rounded border border-line hover:bg-surface disabled:opacity-50"
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={() => submitReraise(r)}
                                disabled={reraisingId === r.id || reraiseQty === '' || Number(reraiseQty) < 1}
                                className="text-xs font-bold bg-brand text-white px-3 py-1 rounded-full hover:bg-brand-dark disabled:opacity-50"
                              >
                                {reraisingId === r.id ? 'Re-raising…' : 'Re-raise'}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {itemQuery && shown.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-5 text-center text-faint italic text-xs">
                    No components match “{itemSearch.trim()}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
