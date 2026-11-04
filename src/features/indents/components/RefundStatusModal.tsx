// RefundStatusModal — used POST-cancellation to move a refund forward
// (PENDING → RECEIVED / WRITE_OFF / DISPUTED, or DISPUTED → RECEIVED /
// WRITE_OFF, etc). Both Procurement (chasing the vendor) and Finance
// (verifying receipt) can open this; whoever knows the latest state updates it.
//
// Per-vendor: each vendor order was its own checkout in its own currency, so
// its refund is chased + recorded in THAT currency — no INR collapse, no
// FX-drift mismatch. When the indent has per-vendor refunds the modal renders
// one self-contained card per vendor (each POSTs to
// /indents/:id/vendor-orders/:orderId/refund and re-fetches). Legacy indents
// with no vendor orders fall back to the original indent-level form, which
// submits via the `onSubmit` prop (PATCH /indents/:id/refund).

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { fmtDate } from '@/utils/date';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { ViewReceiptLink } from './ViewReceiptLink';
import { useAbortOnUnmount } from '@/hooks';
import { RECEIPT_ACCEPT } from '@/lib/fileAccept';

type RefundStatus = 'PENDING' | 'RECEIVED' | 'WRITE_OFF' | 'DISPUTED';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  row: any | null;                                  // the cancelled indent
  submitting?: boolean;                             // legacy (indent-level) submit in-flight
  onSubmit: (payload: {
    status: RefundStatus;
    receivedDate?: string;
    receivedAmount?: number;
    transactionId?: string;
    notes?: string;
    receiptFile?: File;
  }) => void | Promise<void>;
  // Called after any successful per-vendor update so the parent re-fetches its
  // list. The modal also re-fetches the single indent internally to refresh the
  // cards, so this is purely to keep the surrounding table in sync.
  onUpdated?: () => void | Promise<void>;
}

// Mirrors the backend ALLOWED_REFUND map exactly so the UI never offers an
// option the server would reject. Keep these in sync.
const ALLOWED: Record<string, RefundStatus[]> = {
  PENDING:   ['RECEIVED', 'WRITE_OFF', 'DISPUTED'],
  DISPUTED:  ['RECEIVED', 'WRITE_OFF', 'PENDING'],
  WRITE_OFF: ['RECEIVED'],
  RECEIVED:  [],
};

const LABEL: Record<RefundStatus, string> = {
  PENDING:   'Move back to Pending',
  RECEIVED:  'Mark Received',
  WRITE_OFF: 'Write off',
  DISPUTED:  'Mark Disputed',
};

const STATUS_TONE: Record<string, string> = {
  PENDING:   'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border-amber-200 dark:border-amber-400/30',
  DISPUTED:  'text-rose-700 dark:text-rose-300 bg-rose-50 dark:bg-rose-400/15 border-rose-200 dark:border-rose-400/30',
  RECEIVED:  'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-400/15 border-emerald-200 dark:border-emerald-400/30',
  WRITE_OFF: 'text-secondary bg-hover border-line',
};

// ---------------------------------------------------------------------------
// One vendor's refund — fully self-contained (own state, own POST, own toast).
// ---------------------------------------------------------------------------
function VendorRefundCard({ indentId, vo, onDone }: { indentId: string; vo: any; onDone: () => void | Promise<void> }) {
  const { addToast } = useToast();
  const cur = (vo.currency || 'INR').toUpperCase();
  const current = (vo.refundStatus as RefundStatus) || 'PENDING';
  const targets = ALLOWED[current] || [];
  const orderAmount = Number(vo.amount ?? 0);
  const expected = vo.refundExpectedAmount != null ? Number(vo.refundExpectedAmount) : orderAmount;

  const [target, setTarget] = useState<RefundStatus | null>(targets[0] || null);
  const [receivedAmount, setReceivedAmount] = useState<string>(String(expected || ''));
  const [receivedDate, setReceivedDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [txn, setTxn] = useState('');
  const [notes, setNotes] = useState('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  // Re-seed when the vendor's refund state changes (after a successful update +
  // re-fetch the parent hands back a fresh `vo` with a new refundStatus).
  useEffect(() => {
    setTarget(targets[0] || null);
    setReceivedAmount(String(expected || ''));
    setReceivedDate(new Date().toISOString().slice(0, 10));
    setTxn('');
    setNotes('');
    setReceiptFile(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vo.id, vo.refundStatus]);

  const valid = useMemo(() => {
    if (!target) return false;
    if (target === 'RECEIVED') return Number(receivedAmount) > 0 && Number(receivedAmount) <= orderAmount && !!receivedDate;
    if (target === 'WRITE_OFF' || target === 'DISPUTED') return notes.trim().length > 0;
    return true;
  }, [target, receivedAmount, receivedDate, notes, orderAmount]);

  const submit = async () => {
    if (!valid || !target || busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('status', target);
      if (target === 'RECEIVED') {
        fd.append('receivedDate', receivedDate);
        fd.append('receivedAmount', String(Number(receivedAmount)));
        if (txn.trim()) fd.append('transactionId', txn.trim());
      }
      if (notes.trim()) fd.append('notes', notes.trim());
      if (receiptFile) fd.append('receipt', receiptFile);
      await client.post(`/indents/${indentId}/vendor-orders/${vo.id}/refund`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      addToast(`${vo.vendorName}: refund ${target === 'RECEIVED' ? 'received' : target.toLowerCase().replace('_', ' ')}`, 'success');
      await onDone();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to update refund'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-card p-3 space-y-2">
      {/* Header — vendor, amount paid (native), current refund status */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-bold text-[13px] text-ink">{vo.vendorName}</p>
          <p className="text-[11px] text-muted">
            Paid {cur} {orderAmount.toLocaleString()}
            {vo.paymentTransactionId && <> · txn <span className="font-mono">{vo.paymentTransactionId}</span></>}
          </p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_TONE[current] || STATUS_TONE.PENDING}`}>
          {current.replace('_', ' ')}
        </span>
      </div>

      {/* Money summary in the vendor's OWN currency */}
      <div className="text-[11px] text-muted space-y-0.5">
        <p>
          <span className="text-faint">Expected back:</span> {cur} {Number(expected).toLocaleString()}
          {vo.refundExpectedDate && <> by {fmtDate(vo.refundExpectedDate)}</>}
        </p>
        {vo.refundReceivedAmount != null && (
          <p>
            <span className="text-faint">Received:</span>{' '}
            <span className="font-bold text-emerald-700 dark:text-emerald-300">{cur} {Number(vo.refundReceivedAmount).toLocaleString()}</span>
            {vo.refundReceivedDate && <> on {fmtDate(vo.refundReceivedDate)}</>}
            {vo.refundTransactionId && <> · txn <span className="font-mono">{vo.refundTransactionId}</span></>}
          </p>
        )}
        {vo.refundNotes && <p className="italic text-faint">{vo.refundNotes}</p>}
        {vo.refundReceiptPath && (
          <ViewReceiptLink indentId={indentId} orderId={vo.id} kind="vendor-order-refund" />
        )}
      </div>

      {targets.length === 0 ? (
        <p className="text-[11px] italic text-emerald-700 dark:text-emerald-300">Refund settled — nothing more to chase.</p>
      ) : (
        <div className="space-y-2 border-t border-line-soft pt-2">
          <div className="flex flex-wrap gap-1.5">
            {targets.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTarget(t)}
                className={`rounded-full border px-2.5 py-1 text-[11px] font-bold transition-colors ${
                  target === t ? 'border-brand bg-brand-100 text-brand-700' : 'border-line text-muted hover:bg-surface'
                }`}
              >
                {LABEL[t]}
              </button>
            ))}
          </div>

          {target === 'RECEIVED' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Received ({cur}) <span className="text-red-700 dark:text-red-300">*</span></label>
                  <input type="number" min="0" step="0.01" max={orderAmount} value={receivedAmount} onChange={(e) => setReceivedAmount(e.target.value)}
                    className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand" />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Received on <span className="text-red-700 dark:text-red-300">*</span></label>
                  <input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)}
                    className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand" />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Refund txn / bank credit ref</label>
                <input type="text" value={txn} onChange={(e) => setTxn(e.target.value)}
                  placeholder="REFUND-12345 / NEFT ref"
                  className="w-full border border-line rounded px-2 py-1 text-sm font-mono outline-none focus:border-brand" />
              </div>
              {Number(receivedAmount) > 0 && Number(receivedAmount) < orderAmount && (
                <p className="text-[10px] text-amber-700 dark:text-amber-300 italic">
                  {cur} {(orderAmount - Number(receivedAmount)).toLocaleString()} short of the {cur} {orderAmount.toLocaleString()} paid — recording as a partial refund.
                </p>
              )}
              {Number(receivedAmount) > orderAmount && (
                <p className="text-[10px] text-rose-700 dark:text-rose-300 italic">
                  Can't exceed the {cur} {orderAmount.toLocaleString()} paid to {vo.vendorName}.
                </p>
              )}
            </div>
          )}

          {(target === 'WRITE_OFF' || target === 'DISPUTED') && (
            <div>
              <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">
                {target === 'WRITE_OFF' ? 'Why is this being written off?' : 'What is the dispute about?'} <span className="text-red-700 dark:text-red-300">*</span>
              </label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                placeholder={target === 'WRITE_OFF'
                  ? 'e.g. Vendor unresponsive 60d; reversal window closed.'
                  : 'e.g. Vendor wants restocking fee — escalated.'}
                className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand resize-none" />
            </div>
          )}

          {target === 'PENDING' && (
            <div>
              <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Notes (optional)</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                placeholder="e.g. Vendor agreed to refund — back to chasing."
                className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand resize-none" />
            </div>
          )}

          {/* Proof upload — bank credit screenshot / vendor email. Optional on
              every target. */}
          <div>
            <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">
              Receipt / screenshot <span className="normal-case text-faint">— optional, ≤ 25 MB</span>
              {vo.refundReceiptPath && <span className="ml-1 text-brand-700 italic normal-case">— replaces existing</span>}
            </label>
            <input type="file" accept={RECEIPT_ACCEPT} onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
              className="w-full text-[11px] text-ink file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-[11px] file:font-bold file:bg-brand/20 file:text-brand-700 hover:file:bg-brand/30 cursor-pointer" />
            {receiptFile && <p className="text-[10px] text-muted italic mt-1">{receiptFile.name} · {(receiptFile.size / 1024).toFixed(0)} KB</p>}
          </div>

          <div className="flex justify-end">
            <button onClick={submit} disabled={!valid || busy}
              className="px-3 py-1.5 text-[11px] font-bold text-white bg-brand hover:bg-brand-dark rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {busy ? 'Saving…' : target ? LABEL[target] : 'Update'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function RefundStatusModal({ isOpen, onClose, row, submitting = false, onSubmit, onUpdated }: Props) {
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();
  // Internal live copy so per-vendor updates refresh the cards without the
  // parent having to push a new `row` snapshot.
  const [liveRow, setLiveRow] = useState<any | null>(row);
  useEffect(() => { setLiveRow(row); }, [row]);

  const r = liveRow || row;
  const vendorRefunds: any[] = (r?.vendorOrders || []).filter((vo: any) => vo.refundStatus && vo.refundStatus !== 'NONE');
  const perVendor = vendorRefunds.length > 0;

  const refresh = async () => {
    if (r?.id) {
      try {
        const res = await client.get(`/indents/${r.id}`, { signal: abortSignal() });
        setLiveRow(res.data?.data ?? res.data);
      } catch { /* keep current copy; the list re-fetch below still runs */ }
    }
    await onUpdated?.();
  };

  // --- Legacy (indent-level) state — only rendered when !perVendor, but the
  // hooks must run unconditionally (rules of hooks). ---
  const currentStatus = (r?.refundStatus as RefundStatus | 'NONE' | undefined) || 'NONE';
  const targets = ALLOWED[currentStatus] || [];
  const currency = r?.currency || 'INR';
  const grandTotal = Number(r?.grandTotal ?? 0);
  const expectedAmount = Number(r?.refundExpectedAmount ?? grandTotal);

  const [target, setTarget] = useState<RefundStatus | null>(null);
  const [receivedAmount, setReceivedAmount] = useState<string>('');
  const [receivedDate, setReceivedDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [txn, setTxn] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setTarget(targets[0] || null);
    setReceivedAmount(String(expectedAmount || ''));
    setReceivedDate(new Date().toISOString().slice(0, 10));
    setTxn('');
    setNotes('');
    setReceiptFile(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, r?.id, expectedAmount, targets.join(',')]);

  const overTotal = grandTotal > 0 && Number(receivedAmount) > grandTotal;
  const valid = useMemo(() => {
    if (!target) return false;
    // Capped at the indent total, as the server is — the per-vendor card
    // already capped at its order amount; this form let any figure through.
    if (target === 'RECEIVED') return Number(receivedAmount) > 0 && !!receivedDate && !overTotal;
    if (target === 'WRITE_OFF' || target === 'DISPUTED') return notes.trim().length > 0;
    return true;
  }, [target, receivedAmount, receivedDate, notes, overTotal]);

  const handleSubmit = async () => {
    if (!valid || !target || submitting) return;
    const payload: Parameters<typeof onSubmit>[0] = { status: target };
    if (target === 'RECEIVED') {
      payload.receivedDate = receivedDate;
      payload.receivedAmount = Number(receivedAmount);
      if (txn.trim()) payload.transactionId = txn.trim();
    }
    if (notes.trim()) payload.notes = notes.trim();
    if (receiptFile) payload.receiptFile = receiptFile;
    await onSubmit(payload);
  };

  if (!row) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Update refund — ${r.serialNo || 'Indent'}`}>
      {perVendor ? (
        <div className="space-y-3 text-sm">
          <p className="text-[12px] text-muted">
            Each vendor was paid separately, so each refund is chased and recorded in its own currency.
            Update them independently as the money comes back.
          </p>
          <div className="space-y-2.5 max-h-[60vh] overflow-y-auto pr-0.5">
            {vendorRefunds.map((vo) => (
              <VendorRefundCard key={vo.id} indentId={r.id} vo={vo} onDone={refresh} />
            ))}
          </div>
          <div className="flex justify-end pt-2 border-t border-line-soft">
            <button onClick={onClose}
              className="px-3 py-1.5 text-xs font-bold text-muted hover:bg-hover rounded transition-colors">
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          {/* Current state summary */}
          <div className="rounded-lg border border-line bg-surface px-3 py-2 text-xs">
            <p><span className="font-bold text-ink">Current refund status:</span> <span className="font-bold uppercase tracking-wider text-brand-700">{currentStatus}</span></p>
            <p><span className="text-faint">Paid:</span> {currency} {grandTotal.toLocaleString('en-IN')}{r.paymentTransactionId && <> · txn <span className="font-mono">{r.paymentTransactionId}</span></>}</p>
            {r.refundExpectedAmount != null && (
              <p><span className="text-faint">Expected back:</span> {currency} {Number(r.refundExpectedAmount).toLocaleString('en-IN')}{r.refundExpectedDate && <> by {fmtDate(r.refundExpectedDate)}</>}</p>
            )}
            {r.refundReceivedAmount != null && (
              <p><span className="text-faint">Already received:</span> {currency} {Number(r.refundReceivedAmount).toLocaleString('en-IN')}{r.refundReceivedDate && <> on {fmtDate(r.refundReceivedDate)}</>}</p>
            )}
          </div>

          {targets.length === 0 && (
            <p className="text-[12px] italic text-faint">No further updates allowed from <span className="font-bold">{currentStatus}</span> — terminal state.</p>
          )}

          {targets.length > 0 && (
            <div className="space-y-1.5">
              <label className="block text-xs font-bold text-muted uppercase tracking-wider">Move to</label>
              {targets.map(t => (
                <label key={t} className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${target === t ? 'border-brand bg-brand-100/60' : 'border-line hover:bg-surface'}`}>
                  <input type="radio" checked={target === t} onChange={() => setTarget(t)} />
                  <span className="font-bold text-ink text-[13px]">{LABEL[t]}</span>
                </label>
              ))}
            </div>
          )}

          {target === 'RECEIVED' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Received amount ({currency}) <span className="text-red-700 dark:text-red-300">*</span></label>
                  <input type="number" min="0" step="0.01" max={grandTotal > 0 ? grandTotal : undefined} value={receivedAmount} onChange={(e) => setReceivedAmount(e.target.value)}
                    className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand" />
                  {overTotal && <p className="mt-0.5 text-[10px] text-red-700 dark:text-red-300">Can't be more than the indent total.</p>}
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Received on <span className="text-red-700 dark:text-red-300">*</span></label>
                  <input type="date" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)}
                    className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand" />
                </div>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Refund txn / bank credit ref</label>
                <input type="text" value={txn} onChange={(e) => setTxn(e.target.value)}
                  placeholder="REFUND-12345 / NEFT ref"
                  className="w-full border border-line rounded px-2 py-1 text-sm font-mono outline-none focus:border-brand" />
              </div>
              {Number(receivedAmount) > 0 && Number(receivedAmount) < grandTotal && (
                <p className="text-[10px] text-amber-700 dark:text-amber-300 italic">
                  Heads-up: that's {currency} {(grandTotal - Number(receivedAmount)).toLocaleString('en-IN')} short of the {currency} {grandTotal.toLocaleString('en-IN')} paid. Flagging as partial refund.
                </p>
              )}
            </div>
          )}

          {(target === 'WRITE_OFF' || target === 'DISPUTED') && (
            <div>
              <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">
                {target === 'WRITE_OFF' ? 'Why is this being written off?' : 'What is the dispute about?'} <span className="text-red-700 dark:text-red-300">*</span>
              </label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
                placeholder={target === 'WRITE_OFF'
                  ? 'e.g. Vendor unresponsive 60d; bank says reversal window closed.'
                  : 'e.g. Vendor wants ₹2k restocking fee — escalated to admin.'}
                className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand resize-none" />
            </div>
          )}

          {target === 'PENDING' && (
            <div>
              <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Notes (optional)</label>
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                placeholder="e.g. Vendor agreed to refund — back to chasing."
                className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand resize-none" />
            </div>
          )}

          {target && (
            <div>
              <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">
                Receipt / screenshot (PDF or image) <span className="text-faint normal-case">— optional, ≤ 25 MB</span>
                {r.refundReceiptPath && <span className="ml-2 text-brand-700 italic normal-case">— uploading a new one replaces the existing receipt</span>}
              </label>
              <input
                type="file"
                accept={RECEIPT_ACCEPT}
                onChange={(e) => setReceiptFile(e.target.files?.[0] || null)}
                className="w-full text-[12px] text-ink file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-[11px] file:font-bold file:bg-brand/20 file:text-brand-700 hover:file:bg-brand/30 cursor-pointer"
              />
              {receiptFile && (
                <p className="text-[10px] text-muted italic mt-1">
                  {receiptFile.name} · {(receiptFile.size / 1024).toFixed(0)} KB
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
            <button onClick={onClose} disabled={submitting}
              className="px-3 py-1.5 text-xs font-bold text-muted hover:bg-hover rounded transition-colors disabled:opacity-50">
              Close
            </button>
            {targets.length > 0 && (
              <button onClick={handleSubmit} disabled={!valid || submitting}
                className="px-4 py-1.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                {submitting ? 'Saving…' : target ? LABEL[target] : 'Update'}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
