import { useEffect, useMemo, useState } from 'react';
import { Modal, StatusBadge } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { useAuth } from '@/hooks';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import { CheckCircle2, Circle, AlertTriangle } from 'lucide-react';
import { bomListsApi } from '../services/bom-lists.api';

interface Props {
  batchId: string | null;
  /** History mode renders read-only with per-line "Issued on {date} by {clerk}" stamps. */
  mode: 'issue' | 'history';
  onClose: () => void;
  /** Fired after a successful bulk-issue so the parent page re-fetches. */
  onIssued?: () => void;
}

const ISSUABLE_STATUSES = new Set(['APPROVED', 'YET_TO_ISSUE']);

/**
 * Per-line stock chip. Green = enough stock to issue everything; amber =
 * short stock (will partial-issue + auto-raise back-order); red = nothing
 * in stock (line will be queued behind a back-order).
 */
const StockChip = ({ remaining, stock }: { remaining: number; stock: number }) => {
  if (stock <= 0) {
    return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30">0 in stock</span>;
  }
  if (stock < remaining) {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded border bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30">
        <AlertTriangle size={10} /> {stock} of {remaining}
      </span>
    );
  }
  return <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30">{stock} in stock</span>;
};

/**
 * Drawer for the BOM Batches page. Two modes:
 *
 *  - `issue`: clerk view — every still-issuable line pre-ticked, clerk can
 *    untick anything they don't want, then click "Issue selected". Sends
 *    one atomic bulk-issue request.
 *  - `history`: read-only — shows each issued line with `Issued X on
 *    {date} by {clerk}`. Used in the History tab on the same page.
 *
 * Loads `/bom-lists/batches/:id` when opened — has every spawned request
 * plus current stock for the partial-issue calculation.
 */
export const BomBatchIssueDrawer = ({ batchId, mode, onClose, onIssued }: Props) => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [batch, setBatch] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Local tick state — Set of request IDs the clerk has marked for issue.
  // Initialised to "all still-issuable lines" on open (default = tick all).
  const [ticked, setTicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!batchId) { setBatch(null); setTicked(new Set()); return; }
    let cancelled = false;
    setLoading(true);
    bomListsApi.getBatch(batchId)
      .then(d => {
        if (cancelled) return;
        setBatch(d);
        // Pre-tick every still-issuable line. History mode ignores this set.
        const issuableIds = (d.spawnedRequests || [])
          .filter((r: any) => ISSUABLE_STATUSES.has(r.status))
          .map((r: any) => r.id);
        setTicked(new Set(issuableIds));
      })
      .catch(e => addToast(extractErrorMessage(e, 'Failed to load batch'), 'error'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads the batch only when batchId changes; addToast (toast context) is used only in the error branch and must not retrigger the fetch
  }, [batchId]);

  const issuableLines = useMemo(
    () => (batch?.spawnedRequests || []).filter((r: any) => ISSUABLE_STATUSES.has(r.status)),
    [batch],
  );
  const historyLines = useMemo(
    () => (batch?.spawnedRequests || []).filter((r: any) => !ISSUABLE_STATUSES.has(r.status)),
    [batch],
  );

  // Stop the clerk from issuing requests they themselves raised — the
  // backend enforces this too (returns 403), but pre-blocking here saves
  // a round trip + lets the UI explain WHY.
  const isOwnRequest = (r: any) => batch?.createdBy?.id === user?.id || r?.createdById === user?.id;

  const toggle = (id: string) => {
    setTicked(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const tickAll = () => {
    setTicked(new Set(issuableLines.filter((r: any) => !isOwnRequest(r)).map((r: any) => r.id)));
  };
  const untickAll = () => setTicked(new Set());

  const submit = async () => {
    if (!batch || ticked.size === 0) return;
    // Build the payload: for each ticked line, calculate how much to actually
    // issue. If stock < remaining, issue what's available and ask backend to
    // auto-raise a back-order; otherwise issue the full remainder.
    const payload = issuableLines
      .filter((r: any) => ticked.has(r.id))
      .map((r: any) => {
        const remaining = Number(r.qtyRequested) - Number(r.qtyIssued ?? 0);
        const stock = Number(r.inventoryItem?.stock ?? 0);
        const toIssue = Math.max(0, Math.min(remaining, stock));
        const shortfall = remaining - toIssue;
        return {
          requestId: r.id,
          qtyToIssue: toIssue,
          // Only ask for back-order when there's actually a shortfall — and
          // skip zero-issue rows with no shortfall (defensive; shouldn't happen).
          autoRaiseBackorder: shortfall > 0,
        };
      })
      // Drop any line where we'd send qtyToIssue=0 and autoRaiseBackorder=false
      // (the backend would 400). Doesn't happen unless stock = remaining = 0
      // and the row somehow stayed ticked, but worth being defensive about.
      .filter((p: { qtyToIssue: number; autoRaiseBackorder: boolean }) => p.qtyToIssue > 0 || p.autoRaiseBackorder);

    if (payload.length === 0) {
      addToast('Nothing to issue — every ticked line has 0 stock and no back-order requested.', 'error');
      return;
    }

    const n = payload.length;
    if (!await confirm(`Issue ${n} line${n === 1 ? '' : 's'} from ${batch.serialNo}? This cannot be undone from here.`)) return;

    setSubmitting(true);
    try {
      const res = await bomListsApi.bulkIssue(payload);
      addToast(`${res.issuedCount} line${res.issuedCount === 1 ? '' : 's'} issued from ${batch.serialNo}.`, 'success');
      onIssued?.();
      onClose();
      // Refresh global inventory badge — same event the per-row Issue modal fires.
      window.dispatchEvent(new Event('requests-updated'));
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to issue batch'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const title = batch
    ? `${batch.serialNo} — ${batch.name}${mode === 'history' ? ' · BOM Issued' : ''}`
    : 'BOM Batch';

  return (
    <Modal isOpen={!!batchId} onClose={onClose} title={title}>
      {loading && <div className="text-center py-8 text-faint">Loading…</div>}
      {!loading && batch && (
        <div className="space-y-4">
          {/* Header strip — who raised it + when. Useful context for the
              clerk before they commit a batch. */}
          <div className="bg-surface rounded-md p-3 border border-line-soft grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div>
              <p className="text-[10px] text-faint uppercase font-bold">Requester</p>
              <p className="font-medium text-ink truncate">{batch.createdBy?.name || 'Unknown'}</p>
            </div>
            <div>
              <p className="text-[10px] text-faint uppercase font-bold">Project</p>
              <p className="font-medium text-ink truncate">{batch.project?.name || <span className="italic text-faint">General / Others</span>}</p>
            </div>
            <div>
              <p className="text-[10px] text-faint uppercase font-bold">Department</p>
              <p className="font-medium text-ink truncate">{batch.department?.name}</p>
            </div>
            <div>
              <p className="text-[10px] text-faint uppercase font-bold">Submitted</p>
              <p className="font-medium text-ink">{batch.submittedAt ? fmtDateTime(batch.submittedAt) : '—'}</p>
            </div>
          </div>

          {/* Issue mode: tick list of still-issuable lines */}
          {mode === 'issue' && issuableLines.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-bold text-ink">
                  Issuable lines ({ticked.size} of {issuableLines.length} ticked)
                </h4>
                <div className="flex gap-2 text-[10px] font-bold">
                  <button onClick={tickAll}
                    className="px-2 py-1 rounded border border-emerald-200 dark:border-emerald-400/30 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:bg-emerald-400/15">
                    Tick all
                  </button>
                  <button onClick={untickAll}
                    className="px-2 py-1 rounded border border-line text-muted hover:bg-surface">
                    Untick all
                  </button>
                </div>
              </div>
              <div className="border border-line-soft rounded-md divide-y divide-line-soft max-h-[40vh] overflow-y-auto">
                {issuableLines.map((r: any) => {
                  const isTicked = ticked.has(r.id);
                  const remaining = Number(r.qtyRequested) - Number(r.qtyIssued ?? 0);
                  const stock = Number(r.inventoryItem?.stock ?? 0);
                  const isMine = isOwnRequest(r);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      disabled={isMine}
                      onClick={() => toggle(r.id)}
                      title={isMine ? 'You raised this request — someone else has to issue it.' : (isTicked ? 'Untick to skip this line' : 'Tick to include in this batch')}
                      className={`w-full text-left px-3 py-2 flex items-center gap-3 text-sm transition-colors ${
                        isMine ? 'bg-red-50/40 dark:bg-red-400/15 cursor-not-allowed' :
                        isTicked ? 'bg-emerald-50/40 dark:bg-emerald-400/15 hover:bg-emerald-50 dark:bg-emerald-400/15' : 'hover:bg-surface'
                      }`}
                    >
                      <div className="shrink-0">
                        {isTicked
                          ? <CheckCircle2 size={18} className="text-emerald-700 dark:text-emerald-300" />
                          : <Circle size={18} className={isMine ? 'text-red-300' : 'text-faint'} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-ink">{r.serialNo}</span>
                          <span className="font-medium text-ink truncate">{r.inventoryItem?.name}</span>
                          <StatusBadge status={r.status} />
                          {isMine && (
                            <span className="text-[9px] font-bold text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-400/20 border border-red-200 dark:border-red-400/30 px-1.5 py-0.5 rounded">
                              You raised this
                            </span>
                          )}
                        </div>
                        <p className="text-[10px] text-faint">
                          {r.inventoryItem?.category?.replace(/_/g, ' ')}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-0.5 shrink-0">
                        <span className="font-mono text-xs">
                          <span className="font-bold text-ink">{remaining}</span>
                          <span className="text-faint"> {r.inventoryItem?.unit}</span>
                        </span>
                        <StockChip remaining={remaining} stock={stock} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {mode === 'issue' && issuableLines.length === 0 && (
            <div className="text-center text-faint py-6 border border-dashed border-line rounded-md text-sm">
              Nothing left to issue on this BOM.
            </div>
          )}

          {/* Already-issued / terminal lines — read-only history block */}
          {historyLines.length > 0 && (
            <div>
              <h4 className="text-sm font-bold text-ink mb-2">
                {mode === 'history' ? 'Issued lines' : `Already processed (${historyLines.length})`}
              </h4>
              <div className="border border-line-soft rounded-md divide-y divide-line-soft max-h-[35vh] overflow-y-auto">
                {historyLines.map((r: any) => (
                  <div key={r.id} className="px-3 py-2 flex items-center gap-3 text-sm bg-surface/40">
                    <CheckCircle2 size={16} className="text-emerald-500 dark:text-emerald-300 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold text-ink">{r.serialNo}</span>
                        <span className="font-medium text-ink truncate">{r.inventoryItem?.name}</span>
                        <StatusBadge status={r.status} />
                      </div>
                      <p className="text-[10px] text-faint">
                        Issued <span className="font-bold text-muted">{Number(r.qtyIssued || 0)}</span> {r.inventoryItem?.unit}
                        {r.issuedAt && <> · {fmtDateTime(r.issuedAt)}</>}
                        {r.issuedBy?.name && <> · by <span className="font-bold text-muted">{r.issuedBy.name}</span></>}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sticky footer — Issue / Untick all / Cancel */}
          {mode === 'issue' && issuableLines.length > 0 && (
            <div className="flex items-center justify-end gap-2 pt-3 border-t border-line-soft">
              <button onClick={onClose}
                className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface">
                Cancel
              </button>
              <button
                onClick={submit}
                disabled={submitting || ticked.size === 0}
                className="inline-flex items-center gap-2 bg-emerald-700 text-white px-5 py-2 rounded-md font-bold text-sm hover:bg-emerald-800 disabled:opacity-50 shadow-sm">
                {submitting ? 'Issuing…' : `Issue selected (${ticked.size} of ${issuableLines.length})`}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
