// CancelIndentModal — collects WHY the indent is being cancelled + WHAT
// happened to the money. Three top-level branches when paid:
//   1. Payment failed on vendor side  → retry (back to AWAITING_PAYMENT)
//   2. Cancel indent + track refund    → status CANCELLED + refund block
//   3. Re-order items + chase refund    → reopen to QUOTATION_IN_PROGRESS so
//      procurement re-quotes (same/new vendor) while the original payment's
//      refund is chased in parallel. Same refund block as #2.
//
// The refund block is ONE unified form (shared by #2 and #3) regardless of
// whether the refund is already in hand or coming later. A sub-toggle picks
// Pending / Received / Disputed / Write-off; the visible fields adapt.
// Screenshot upload is available throughout so finance has hard proof on file.

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { fmtDateTime } from '@/utils/date';
import { RECEIPT_ACCEPT } from '@/lib/fileAccept';

export type CancelOutcome =
  | { kind: 'RETRY_PAYMENT'; reason: string }
  | { kind: 'CANCEL_NO_REFUND'; reason: string }   // status was < PAYMENT_DONE
  | {
      kind: 'CANCEL_WITH_REFUND';
      reason: string;
      refundStatus: 'PENDING' | 'RECEIVED' | 'WRITE_OFF' | 'DISPUTED';
      expectedAmount?: number;
      expectedDate?: string;
      receivedAmount?: number;
      receivedDate?: string;
      transactionId?: string;
      notes?: string;
      receiptFile?: File;
    }
  | {
      // Important item: reopen the indent to re-quote (same vendor or a new
      // one) so the project keeps moving, while the ORIGINAL payment's refund
      // is chased in parallel. Carries the same refund payload as a cancel.
      kind: 'REORDER_WITH_REFUND';
      reason: string;
      refundStatus: 'PENDING' | 'RECEIVED' | 'WRITE_OFF' | 'DISPUTED';
      expectedAmount?: number;
      expectedDate?: string;
      receivedAmount?: number;
      receivedDate?: string;
      transactionId?: string;
      notes?: string;
      receiptFile?: File;
    };

interface Props {
  isOpen: boolean;
  onClose: () => void;
  row: any | null;
  submitting?: boolean;
  onSubmit: (outcome: CancelOutcome) => void | Promise<void>;
}

type TopChoice = 'RETRY' | 'CANCEL' | 'REORDER';
type RefundChoice = 'PENDING' | 'RECEIVED' | 'WRITE_OFF' | 'DISPUTED';

// Mirror the backend PAID_STATES (indents.service.ts): a PARTIALLY_RECEIVED
// indent is paid+ordered too, so cancelling it must collect a refund outcome.
const PAID_STATES = new Set(['PAYMENT_DONE', 'ORDERED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED']);

export function CancelIndentModal({ isOpen, onClose, row, submitting = false, onSubmit }: Props) {
  const [reason, setReason] = useState('');
  // Top-level: retry vs cancel-with-refund vs re-order. Starts UNSET on a paid
  // indent so cancelling (destructive) is never the silent default — the user
  // must consciously pick. (For an unpaid indent the picker isn't shown at all.)
  const [topChoice, setTopChoice] = useState<TopChoice | null>(null);
  // Within the cancel branch: refund status sub-choice.
  const [refundChoice, setRefundChoice] = useState<RefundChoice>('PENDING');

  // All refund fields live as strings so the inputs stay controlled;
  // we coerce to number only on submit.
  const [expectedAmount, setExpectedAmount] = useState<string>('');
  const [expectedDate, setExpectedDate] = useState<string>('');
  const [receivedAmount, setReceivedAmount] = useState<string>('');
  const [receivedDate, setReceivedDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [refundTxn, setRefundTxn] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [receiptFile, setReceiptFile] = useState<File | null>(null);

  const wasPaid = !!(row && PAID_STATES.has(row.status));
  const grandTotal = Number(row?.grandTotal ?? 0);
  const currency = row?.currency || 'INR';

  // Reset state every time the modal opens with a new row so a stale
  // amount or file selection from a previous indent never leaks in.
  useEffect(() => {
    if (!isOpen) return;
    setReason('');
    setTopChoice(null);
    setRefundChoice('PENDING');
    setExpectedAmount(grandTotal > 0 ? String(grandTotal) : '');
    setExpectedDate('');
    setReceivedAmount(grandTotal > 0 ? String(grandTotal) : '');
    setReceivedDate(new Date().toISOString().slice(0, 10));
    setRefundTxn('');
    setNotes('');
    setReceiptFile(null);
  }, [isOpen, row?.id, grandTotal]);

  const trimmedReason = reason.trim();
  const trimmedNotes = notes.trim();
  // The top reason field is required in EVERY branch and is the #1 reason the
  // submit button sits disabled. When it's empty we light it up red so nobody
  // fills "Notes" by mistake and then wonders why the button is dead.
  const reasonMissing = !trimmedReason && !submitting;

  const valid = useMemo(() => {
    if (!trimmedReason) return false;
    if (!wasPaid) return true; // simple cancel — reason only
    if (!topChoice) return false; // paid: must explicitly pick cancel / re-order / retry
    if (topChoice === 'RETRY') return row?.status === 'PAYMENT_DONE';
    // CANCEL and REORDER share the refund sub-form, so the same refund-field
    // validation applies to both (REORDER just reopens instead of cancelling).
    if (refundChoice === 'RECEIVED') {
      // Need positive amount + date AND proof (txn ref OR notes) so the
      // audit trail explains where the money came from. Matches the
      // backend's stricter check added after the audit pass.
      if (!(Number(receivedAmount) > 0 && !!receivedDate)) return false;
      if (!refundTxn.trim() && !trimmedNotes) return false;
      return true;
    }
    if (refundChoice === 'WRITE_OFF') return trimmedNotes.length > 0;
    if (refundChoice === 'DISPUTED')  return trimmedNotes.length > 0;
    return true; // PENDING — expected fields optional
  }, [trimmedReason, wasPaid, topChoice, refundChoice, receivedAmount, receivedDate, refundTxn, trimmedNotes, row?.status]);

  const handleSubmit = async () => {
    if (!valid || submitting) return;
    let outcome: CancelOutcome;
    if (!wasPaid) {
      outcome = { kind: 'CANCEL_NO_REFUND', reason: trimmedReason };
    } else if (topChoice === 'RETRY') {
      outcome = { kind: 'RETRY_PAYMENT', reason: trimmedReason };
    } else {
      // CANCEL_WITH_REFUND and REORDER_WITH_REFUND carry the identical refund
      // payload — only the kind (and downstream destination status) differ.
      const refundPayload = {
        reason: trimmedReason,
        refundStatus: refundChoice,
        expectedAmount: refundChoice === 'PENDING' && expectedAmount ? Number(expectedAmount) : undefined,
        expectedDate: refundChoice === 'PENDING' && expectedDate ? expectedDate : undefined,
        receivedAmount: refundChoice === 'RECEIVED' ? Number(receivedAmount) : undefined,
        receivedDate: refundChoice === 'RECEIVED' ? receivedDate : undefined,
        transactionId: refundChoice === 'RECEIVED' && refundTxn.trim() ? refundTxn.trim() : undefined,
        notes: trimmedNotes || undefined,
        receiptFile: receiptFile || undefined,
      };
      outcome = topChoice === 'REORDER'
        ? { kind: 'REORDER_WITH_REFUND', ...refundPayload }
        : { kind: 'CANCEL_WITH_REFUND', ...refundPayload };
    }
    await onSubmit(outcome);
  };

  const submitLabel = useMemo(() => {
    if (submitting) return 'Working…';
    if (!wasPaid) return 'Cancel indent';
    if (!topChoice) return 'Choose an option above';
    if (topChoice === 'RETRY') return 'Re-send to Finance';
    if (topChoice === 'REORDER') return 'Re-order + chase refund';
    if (refundChoice === 'PENDING')   return 'Cancel + track refund';
    if (refundChoice === 'RECEIVED')  return 'Cancel + record received';
    if (refundChoice === 'DISPUTED')  return 'Cancel + flag dispute';
    return 'Cancel + write off';
  }, [submitting, wasPaid, topChoice, refundChoice]);

  // The reason field is shared across all branches, but "Why are you
  // cancelling?" reads wrong when you're retrying a payment or re-ordering
  // (you're NOT cancelling). Adapt the label + placeholder to the chosen path
  // so it's obvious what to type — and so a re-order user isn't left staring
  // at a disabled button wondering why.
  const reasonLabel =
    !wasPaid ? 'Why are you cancelling?'
    : topChoice === 'RETRY' ? 'Why did the payment fail?'
    : topChoice === 'REORDER' ? 'Why are you re-ordering?'
    : 'Why are you cancelling?';
  const reasonPlaceholder =
    topChoice === 'RETRY' ? 'e.g. Bank reversed the transfer / gateway timed out — needs a fresh payment attempt.'
    : topChoice === 'REORDER' ? "e.g. Vendor can't deliver in time — re-ordering from another supplier to keep the project on track."
    : 'e.g. Vendor unable to fulfill the order — switched to a different supplier.';

  // When the submit button is disabled, say WHY in one line — otherwise the
  // user (esp. on the re-order path) just sees a dead button. Mirrors the
  // exact checks in `valid` above.
  const disabledHint = useMemo(() => {
    if (submitting || valid) return '';
    if (!trimmedReason) return 'Add a reason above to continue.';
    if (wasPaid && !topChoice) return 'Pick what to do with the paid amount above — cancel, re-order, or retry.';
    if (wasPaid && topChoice === 'RETRY' && row?.status !== 'PAYMENT_DONE') {
      return 'Retry is only available straight after payment.';
    }
    if (wasPaid && (topChoice === 'CANCEL' || topChoice === 'REORDER')) {
      if (refundChoice === 'RECEIVED') {
        if (!(Number(receivedAmount) > 0 && !!receivedDate)) return 'Enter the received amount and date.';
        if (!refundTxn.trim() && !trimmedNotes) return 'Add a transaction ref or notes as proof of the credit.';
      }
      if (refundChoice === 'WRITE_OFF') return 'Add notes explaining the write-off.';
      if (refundChoice === 'DISPUTED') return 'Add notes explaining the dispute.';
    }
    return '';
  }, [submitting, valid, trimmedReason, wasPaid, topChoice, refundChoice, receivedAmount, receivedDate, refundTxn, trimmedNotes, row?.status]);

  if (!row) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Cancel ${row.serialNo || 'Indent'}`}>
      <div className="space-y-4 text-sm">
        {/* Reason — always required. Lights up red while empty so it's never
            confused with the optional refund "Notes" field further down. */}
        <div>
          <label className={`block text-xs font-bold mb-1 ${reasonMissing ? 'text-red-700 dark:text-red-300' : 'text-muted'}`}>
            {reasonLabel} <span className="text-red-700 dark:text-red-300">*</span>
          </label>
          <textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={reasonPlaceholder}
            rows={3}
            className={`w-full bg-card border rounded-lg px-3 py-2 text-sm outline-none resize-none transition-colors ${
              reasonMissing
                ? 'border-red-400 ring-1 ring-red-200 focus:border-red-500'
                : 'border-line focus:border-brand'
            }`}
          />
          {reasonMissing ? (
            <p className="text-[11px] text-red-700 dark:text-red-300 font-semibold mt-1">
              Required — type the reason here to enable the button below. (This is separate from the refund “Notes” field.)
            </p>
          ) : (
            <p className="text-[10px] text-faint mt-1">
              Shown to the requester, approvers, and the requester's manager in their notification.
            </p>
          )}
        </div>

        {/* Money warning + 2-branch picker — only when paid */}
        {wasPaid && (
          <>
            <div className="rounded-lg border border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 px-3 py-2">
              <p className="text-xs font-bold text-amber-900 dark:text-amber-200 uppercase tracking-wider mb-1">
                ⚠ This indent has been paid
              </p>
              <p className="text-[12px] text-amber-900 dark:text-amber-200">
                {currency} {grandTotal.toLocaleString('en-IN')}
                {row.paymentTransactionId && <> via <span className="font-mono">{row.paymentTransactionId}</span></>}
                {row.paidBy?.name && <> by {row.paidBy.name}</>}
                {row.paidAt && <> on {fmtDateTime(row.paidAt)}</>}.
              </p>
            </div>

            {/* Top-level recovery choices when paid: retry (only PAYMENT_DONE) /
                cancel + refund / re-order + refund. The shared refund sub-form
                renders once below, under whichever refund-bearing choice is active. */}
            <div className="space-y-1.5">
              {row.status === 'PAYMENT_DONE' && (
                <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${topChoice === 'RETRY' ? 'border-brand bg-brand-100/60' : 'border-line hover:bg-surface'}`}>
                  <input type="radio" className="mt-1" checked={topChoice === 'RETRY'} onChange={() => setTopChoice('RETRY')} />
                  <div className="flex-1">
                    <p className="font-bold text-ink">Payment failed on the vendor side — re-send to Finance</p>
                    <p className="text-[11px] text-muted">Bank reversed / gateway timeout / portal rejected. Money never actually moved. Finance gets a clean Mark-as-Paid form again.</p>
                  </div>
                </label>
              )}

              <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${topChoice === 'CANCEL' ? 'border-brand bg-brand-100/60' : 'border-line hover:bg-surface'}`}>
                <input type="radio" className="mt-1" checked={topChoice === 'CANCEL'} onChange={() => setTopChoice('CANCEL')} />
                <div className="flex-1">
                  <p className="font-bold text-ink">Cancel indent + track refund</p>
                  <p className="text-[11px] text-muted">Money is/was with the vendor and you are <span className="font-semibold">not</span> re-ordering. Record the refund — pending, already received, or written off.</p>
                </div>
              </label>

              <label className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${topChoice === 'REORDER' ? 'border-brand bg-brand-100/60' : 'border-line hover:bg-surface'}`}>
                <input type="radio" className="mt-1" checked={topChoice === 'REORDER'} onChange={() => setTopChoice('REORDER')} />
                <div className="flex-1">
                  <p className="font-bold text-ink">Re-order the items + chase the refund</p>
                  <p className="text-[11px] text-muted">Important item, can't wait. Reopens the indent to re-quote (same vendor or a new one) so the project keeps moving — while the original payment's refund is chased in parallel.</p>
                </div>
              </label>
            </div>

            {/* Shared refund sub-form — used by both Cancel and Re-order. */}
            {(topChoice === 'CANCEL' || topChoice === 'REORDER') && (
              <div className="rounded-lg border border-brand/50 bg-brand-100/40 px-3 py-3 space-y-3">
                {topChoice === 'REORDER' && (
                  <p className="text-[11px] text-brand-700 bg-brand/15 rounded px-2 py-1.5">
                    The indent reopens for re-quoting and re-payment so the project keeps moving. This block tracks the <span className="font-semibold">original</span> payment you're recovering — keep updating it from <span className="font-semibold">Update Refund</span> as the money comes back.
                  </p>
                )}
                {/* Refund status sub-toggle */}
                <div>
                  <p className="block text-[10px] font-bold text-faint uppercase mb-1">Refund status</p>
                  <div className="grid grid-cols-4 gap-1.5">
                    {(['PENDING', 'RECEIVED', 'DISPUTED', 'WRITE_OFF'] as const).map(rc => (
                      <button
                        key={rc}
                        type="button"
                        onClick={() => setRefundChoice(rc)}
                        className={`text-[11px] font-bold uppercase tracking-wide rounded border px-2 py-1.5 transition-colors ${
                          refundChoice === rc
                            ? 'bg-brand/20 border-brand text-brand-700'
                            : 'bg-card border-line text-muted hover:bg-surface'
                        }`}
                      >
                        {rc === 'PENDING' ? 'Pending'
                          : rc === 'RECEIVED' ? 'Received'
                          : rc === 'DISPUTED' ? 'Disputed'
                          : 'Write off'}
                      </button>
                    ))}
                  </div>
                </div>

                {/* PENDING fields — expected amount + date */}
                {refundChoice === 'PENDING' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Expected amount ({currency})</label>
                      <input type="number" min="0" step="0.01" value={expectedAmount} onChange={(e) => setExpectedAmount(e.target.value)}
                        className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand" />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Expected by</label>
                      <input type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)}
                        className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand" />
                    </div>
                  </div>
                )}

                {/* RECEIVED fields — amount + date + txn ID */}
                {refundChoice === 'RECEIVED' && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">Received amount ({currency}) <span className="text-red-700 dark:text-red-300">*</span></label>
                        <input type="number" min="0" step="0.01" value={receivedAmount} onChange={(e) => setReceivedAmount(e.target.value)}
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
                      <input type="text" value={refundTxn} onChange={(e) => setRefundTxn(e.target.value)}
                        placeholder="REFUND-12345 / NEFT credit ref"
                        className="w-full border border-line rounded px-2 py-1 text-sm font-mono outline-none focus:border-brand" />
                    </div>
                    {Number(receivedAmount) > 0 && Number(receivedAmount) < grandTotal && (
                      <p className="text-[10px] text-amber-700 dark:text-amber-300 italic">
                        Heads-up: {currency} {(grandTotal - Number(receivedAmount)).toLocaleString('en-IN')} short of the {currency} {grandTotal.toLocaleString('en-IN')} paid. Flagging as partial refund.
                      </p>
                    )}
                  </div>
                )}

                {/* Notes — required for write-off + disputed (need an
                    explanation), and ALSO required for received when no txn ref
                    is given (proof needed). PENDING: optional. */}
                <div>
                  <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">
                    Notes {(refundChoice === 'WRITE_OFF' || refundChoice === 'DISPUTED') && <span className="text-red-700 dark:text-red-300">*</span>}
                    {refundChoice === 'RECEIVED' && !refundTxn.trim() && <span className="text-red-700 dark:text-red-300">*</span>}
                  </label>
                  <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                    placeholder={refundChoice === 'WRITE_OFF'
                      ? 'e.g. Vendor unresponsive 30d — bank refused reversal.'
                      : refundChoice === 'DISPUTED'
                      ? 'e.g. Vendor wants ₹2k restocking fee — escalated to admin.'
                      : refundChoice === 'RECEIVED'
                      ? 'Required if no transaction reference. Describe how the refund came back.'
                      : 'Any banking details / vendor email reference / other context'}
                    className="w-full border border-line rounded px-2 py-1 text-sm outline-none focus:border-brand resize-none" />
                </div>

                {/* Screenshot upload — proof of refund. Vendor's email, bank
                    credit screenshot, refund confirmation PDF, etc. Optional
                    always; can also be uploaded later via the Update Refund modal. */}
                <div>
                  <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">
                    Receipt / screenshot (PDF or image) <span className="text-faint normal-case">— optional, ≤ 25 MB</span>
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
              </div>
            )}
          </>
        )}

        <div className="flex items-center justify-end gap-3 pt-2 border-t border-line-soft">
          {disabledHint && (
            <p className="mr-auto text-[11px] text-amber-700 dark:text-amber-300 italic">{disabledHint}</p>
          )}
          <button onClick={onClose} disabled={submitting}
            className="px-3 py-1.5 text-xs font-bold text-muted hover:bg-hover rounded transition-colors disabled:opacity-50">
            Keep open
          </button>
          <button onClick={handleSubmit} disabled={!valid || submitting}
            className={`px-4 py-1.5 text-xs font-bold text-white rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${topChoice === 'REORDER' && wasPaid ? 'bg-brand-700 hover:bg-brand-700' : 'bg-red-600 hover:bg-red-700'}`}>
            {submitLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
