import { useEffect, useState } from 'react';
import { Modal, StatusBadge, SlipDownloadButtons } from '@/components/ui';
import { client } from '@/api';
import { fmtDateTime, fmtDate } from '@/utils/date';
import { AlertTriangle, User as UserIcon, Pencil, CheckCircle2, XCircle } from 'lucide-react';
import { normalizeQtyInput } from '@/utils/normalizeQtyInput';

interface Props {
  /** Request id to view. Null closes the modal (and clears state). */
  requestId: string | null;
  onClose: () => void;
  /**
   * Approve from the view itself. Omit on the pages that only read — the
   * footer then says so, exactly as before.
   *
   * Receives the quantity to approve: the number shown, or whatever the
   * approver typed after clicking the pencil beside it. The caller decides
   * whether that counts as a change.
   */
  onApprove?: (qty: number) => Promise<void> | void;
  /** Reject from the view. The caller owns the reason prompt. */
  onReject?: () => void;
  /** Disables both buttons while the caller's request is in flight. */
  acting?: boolean;
}

const fmtNature = (nature?: string) =>
  nature === 'TEMPORARY' ? 'Temporary' : nature === 'PERMANENT' ? 'Permanent' : nature || '—';

const fmtDuration = (value?: number, unit?: string) =>
  value != null && unit ? `${value} ${String(unit).toLowerCase()}` : '—';

const num = (v: any) => (v == null ? 0 : Number(v));

/**
 * Read-only detail pane for a single component request — the requester's,
 * approver's, and auditor's "what is this row, exactly" view. Fetched lazily
 * via GET /requests/:id (visibility-scoped server-side; a 404 here means the
 * caller can't see it). Reused by TeamApprovalsPage, ApprovalsPage, and the
 * requester's My Components page, so it stays purely presentational — no
 * approve/reject actions live here (those have their own buttons on each page).
 */
/** A loan can only be extended while the item is still out. */
const LOAN_ACTIVE = ['IN_USE', 'OVERDUE'];

export const ComponentRequestReviewModal = ({ requestId, onClose, onApprove, onReject, acting }: Props) => {
  const [req, setReq] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Inline quantity edit, same shape as the BOM approval slip: a pencil turns
  // the figure into a field, and what is typed applies when you Approve.
  // Nothing is saved on its own — there is no half-committed state to undo.
  const [editingQty, setEditingQty] = useState(false);
  const [qtyDraft, setQtyDraft] = useState('');

  useEffect(() => {
    if (!requestId) { setReq(null); setError(false); return; }
    // A fresh open never inherits the last request's draft.
    setEditingQty(false);
    setQtyDraft('');
    let cancelled = false;
    setLoading(true);
    setError(false);
    client.get(`/requests/${requestId}`)
      .then(res => { if (!cancelled) setReq(res.data?.data || res.data || null); })
      .catch(() => { if (!cancelled) { setReq(null); setError(true); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [requestId]);

  const responsibles: any[] = req?.responsiblePersons || [];
  const extensions: any[] = req?.extensionRequests || [];
  const qtyRequested = num(req?.qtyRequested);
  const qtyIssued = num(req?.qtyIssued);
  const qtyShortfall = num(req?.qtyShortfall);
  const unit = req?.inventoryItem?.unit || '';
  // Actions show only when the caller supplied them AND the request is still
  // awaiting a decision — an approved or rejected row stays a read-only record.
  const canDecide = !!onApprove && req?.status === 'PENDING';
  const approveQty = editingQty && qtyDraft !== '' ? Number(qtyDraft) : qtyRequested;
  const qtyChanged = canDecide && approveQty !== qtyRequested;

  return (
    <Modal isOpen={!!requestId} onClose={onClose} title={`Request ${req?.serialNo || ''}`}>
      {loading ? (
        <div className="text-center py-10 text-faint">Loading...</div>
      ) : error || !req ? (
        <div className="text-center py-10 text-faint text-sm">
          Couldn't load this request — it may have been removed or you don't have access.
        </div>
      ) : (
        <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
          {/* Status pill up top so the state is the first thing read; the
              single-request slip download sits opposite it. */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <StatusBadge status={req.status} />
              {req.disposition && req.disposition !== 'IN_USE' && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider bg-hover text-secondary border border-line">
                  {String(req.disposition).replace(/_/g, ' ')}
                </span>
              )}
            </div>
            <SlipDownloadButtons kind="requests" id={req.id || requestId!} serialNo={req.serialNo} size="sm" />
          </div>

          {/* BOM provenance — flags that this request is one line of a BOM
              submission (different context than an ad-hoc single request). */}
          {req.bomList?.serialNo && (
            <div className="rounded-lg border border-brand-200 bg-brand-100/40 px-3 py-2 flex items-center gap-2">
              <span className="text-base">📦</span>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold text-brand-700 uppercase tracking-wider">From BOM</p>
                <p className="text-sm font-bold text-ink truncate">
                  {req.bomList.serialNo}{req.bomList.name ? ` — ${req.bomList.name}` : ''}
                </p>
              </div>
            </div>
          )}

          {/* Rejection reason — only when rejected; mirrors the inline banner
              the requester sees on their own list. */}
          {req.status === 'REJECTED' && (
            <div className="bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 rounded-lg p-3 text-sm flex items-start gap-2">
              <AlertTriangle size={16} className="text-red-700 dark:text-red-300 mt-0.5 shrink-0" />
              <div>
                <p className="font-bold text-red-900 dark:text-red-200">Rejected</p>
                <p className="text-xs text-red-800 dark:text-red-200 mt-0.5">
                  {(req.rejectionReason || '').trim() || <span className="italic">No reason given.</span>}
                </p>
              </div>
            </div>
          )}

          {/* Top-line facts */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-faint text-xs">Requested by</span><p className="font-bold text-ink">{req.createdBy?.name || 'Unknown'} <span className="text-xs font-normal text-muted">{req.createdBy?.email ? `(${req.createdBy.email})` : ''}</span></p></div>
            <div><span className="text-faint text-xs">Raised on</span><p className="font-medium text-ink">{req.createdAt ? fmtDateTime(req.createdAt) : '—'}</p></div>
            <div><span className="text-faint text-xs">Department</span><p className="font-medium text-ink">{req.department?.name || 'Unknown'}</p></div>
            <div><span className="text-faint text-xs">Project</span><p className="font-medium text-ink">{req.project?.name || <span className="italic text-faint">General / Others</span>}</p></div>
            <div><span className="text-faint text-xs">Nature</span><p className="font-medium text-ink">{fmtNature(req.nature)}{req.nature === 'TEMPORARY' && <span className="text-xs font-normal text-muted"> · {fmtDuration(req.durationValue, req.durationUnit)}</span>}</p></div>
            {req.dueDate && (
              <div><span className="text-faint text-xs">Due</span><p className="font-medium text-ink">{fmtDateTime(req.dueDate)}</p></div>
            )}
          </div>

          {/* Item + quantities */}
          <div>
            <span className="text-faint text-xs">Component</span>
            <div className="mt-1 bg-surface border border-line-soft rounded-md px-3 py-2.5">
              <p className="font-bold text-ink">{req.inventoryItem?.name || '—'}</p>
              {req.inventoryItem?.category && (
                <p className="text-[10px] text-muted uppercase tracking-wider mt-0.5">{String(req.inventoryItem.category).replace(/_/g, ' ')}</p>
              )}
              <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                <div className="group">
                  <p className="text-[10px] text-muted uppercase tracking-wider font-bold">Requested</p>
                  {editingQty ? (
                    <input
                      autoFocus
                      // Select what is there, so typing REPLACES the current
                      // figure. Without it the field opens with the cursor at
                      // one end and typing 40 against 83 gives 8340 — a wrong
                      // number that still looks like a number.
                      onFocus={(e) => e.currentTarget.select()}
                      type="number"
                      min={1}
                      step="any"
                      value={qtyDraft}
                      onChange={(e) => setQtyDraft(normalizeQtyInput(e.target.value))}
                      aria-label="Quantity to approve"
                      className="mt-0.5 w-16 rounded border border-amber-500 bg-card px-1.5 py-0.5 text-sm font-bold text-ink text-center outline-none"
                      />
                  ) : (
                    <p className="text-sm font-bold text-ink mt-0.5 inline-flex items-center justify-center gap-1">
                      {qtyRequested} <span className="text-xs font-normal text-muted">{unit}</span>
                      {canDecide && (
                        <button
                          type="button"
                          onClick={() => { setQtyDraft(String(qtyRequested)); setEditingQty(true); }}
                          disabled={acting}
                          // Beside the number, not under it, and out of the way
                          // until wanted. focus-visible keeps it reachable by
                          // keyboard, where there is no hover to reveal it.
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted hover:text-brand disabled:opacity-50"
                          title="Approve a different quantity"
                          aria-label="Edit the quantity to approve"
                        >
                          <Pencil size={11} />
                        </button>
                      )}
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-[10px] text-muted uppercase tracking-wider font-bold">Issued</p>
                  <p className="text-sm font-bold text-ink mt-0.5">{qtyIssued} <span className="text-xs font-normal text-muted">{unit}</span></p>
                </div>
                <div>
                  <p className="text-[10px] text-muted uppercase tracking-wider font-bold">Shortfall</p>
                  <p className={`text-sm font-bold mt-0.5 ${qtyShortfall > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-ink'}`}>{qtyShortfall} <span className="text-xs font-normal text-muted">{unit}</span></p>
                </div>
              </div>
              {/* Back-order chip — when a shortfall was covered by an auto-raised indent. */}
              {req.backorderIndent?.serialNo && (
                <div className="mt-2 pt-2 border-t border-line flex items-center gap-1.5 text-[11px]">
                  <span className="text-faint">Back-order indent:</span>
                  <span className="font-bold text-ink">{req.backorderIndent.serialNo}</span>
                  <StatusBadge status={req.backorderIndent.status} />
                </div>
              )}
            </div>
          </div>

          {/* Approval / issue / return facts — only render the rows that have data. */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            {req.approvedBy?.name && (
              <div><span className="text-faint text-xs">Approved by</span><p className="font-medium text-ink">{req.approvedBy.name}{req.approvedBy.role && <span className="text-xs font-normal text-muted"> · {String(req.approvedBy.role).replace(/_/g, ' ')}</span>}</p></div>
            )}
            {req.approvedAt && (
              <div><span className="text-faint text-xs">Approved on</span><p className="font-medium text-ink">{fmtDateTime(req.approvedAt)}</p></div>
            )}
            {req.issuedBy?.name && (
              <div><span className="text-faint text-xs">Issued by</span><p className="font-medium text-ink">{req.issuedBy.name}{req.issuedBy.role && <span className="text-xs font-normal text-muted"> · {String(req.issuedBy.role).replace(/_/g, ' ')}</span>}</p></div>
            )}
            {req.issuedAt && (
              <div><span className="text-faint text-xs">Issued on</span><p className="font-medium text-ink">{fmtDateTime(req.issuedAt)}</p></div>
            )}
            {req.returnedAt && (
              <div><span className="text-faint text-xs">Returned on</span><p className="font-medium text-ink">{fmtDateTime(req.returnedAt)}</p></div>
            )}
          </div>

          {/* Responsible persons */}
          {responsibles.length > 0 && (
            <div>
              <span className="text-faint text-xs">Responsible person{responsibles.length > 1 ? 's' : ''}</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {responsibles.map((rp: any) => (
                  <span key={rp.userId} className="inline-flex items-center gap-1 text-xs bg-hover text-ink rounded-full px-2 py-0.5">
                    <UserIcon size={10} /> {rp.user?.name || 'Unknown'}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Disposition detail — when the item has been marked CONSUMED/EMBEDDED/etc. */}
          {req.disposition && req.disposition !== 'IN_USE' && (
            <div className="bg-surface border border-line-soft rounded-md px-3 py-2 text-sm">
              <span className="text-faint text-xs">Disposition</span>
              <p className="font-medium text-ink">{String(req.disposition).replace(/_/g, ' ')}{req.dispositionDate ? <span className="text-xs font-normal text-muted"> · {fmtDate(req.dispositionDate)}</span> : ''}</p>
              {req.dispositionNotes && <p className="text-xs text-muted mt-1">{req.dispositionNotes}</p>}
            </div>
          )}

          {/* Return record */}
          {req.returnRecord && (
            <div className="bg-surface border border-line-soft rounded-md px-3 py-2 text-sm">
              <span className="text-faint text-xs">Return record</span>
              <p className="font-medium text-ink">{req.returnRecord.condition || '—'}{req.returnRecord.returnedDate ? <span className="text-xs font-normal text-muted"> · {fmtDate(req.returnRecord.returnedDate)}</span> : ''}</p>
              {req.returnRecord.notes && <p className="text-xs text-muted mt-1">{req.returnRecord.notes}</p>}
            </div>
          )}

          {/* Extension history — extension actions log under their own entity, so
              they surface here rather than in the Track timeline. */}
          {extensions.length > 0 && (
            <div>
              <span className="text-faint text-xs">Extension request{extensions.length > 1 ? 's' : ''} ({extensions.length})</span>
              <div className="mt-1 border border-line-soft rounded-md divide-y divide-line-soft">
                {extensions.map((ext: any) => (
                  <div key={ext.id} className="px-3 py-2 text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      {/* A request left waiting when the item came back or was used
                          up can never be decided (the queue hides it, approve
                          refuses it). Shown as what it is, not "Pending" for ever. */}
                      {ext.status === 'PENDING' && !LOAN_ACTIVE.includes(req?.status)
                        ? <span className="text-[10px] font-bold uppercase tracking-wide text-muted bg-hover border border-line px-1.5 py-0.5 rounded" title="The item is no longer out, so this extension request no longer applies">No longer needed</span>
                        : <StatusBadge status={ext.status} />}
                      <span className="font-medium text-ink">{fmtNature(ext.newNature)} · {fmtDuration(ext.newDurationValue, ext.newDurationUnit)}</span>
                      <span className="text-[10px] text-faint">{ext.createdAt ? fmtDateTime(ext.createdAt) : ''}</span>
                    </div>
                    {ext.reason && <p className="text-muted mt-1">{ext.reason}</p>}
                    {ext.approvedBy?.name && (
                      <p className="text-[10px] text-faint mt-0.5">Decided by <span className="font-medium text-ink">{ext.approvedBy.name}</span>{ext.approvedBy.role && <span> · {String(ext.approvedBy.role).replace(/_/g, ' ')}</span>}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {canDecide ? (
            <div className="pt-3 border-t border-line-soft space-y-2">
              {qtyChanged && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300 text-center">
                  Approving {approveQty} {unit} instead of the {qtyRequested} asked for — the requester is told.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onReject}
                  disabled={acting}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border border-red-200 dark:border-red-400/30 text-red-700 dark:text-red-300 bg-card hover:bg-red-50 dark:bg-red-400/15 disabled:opacity-50"
                >
                  <XCircle size={13} /> Reject
                </button>
                <button
                  type="button"
                  onClick={() => onApprove?.(approveQty)}
                  disabled={acting || !(approveQty >= 1)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md bg-emerald-700 text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  <CheckCircle2 size={13} /> {acting ? 'Working…' : qtyChanged ? `Approve ${approveQty}` : 'Approve'}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-[10px] text-faint text-center italic pt-2 border-t border-line-soft">
              Read-only view.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
};
