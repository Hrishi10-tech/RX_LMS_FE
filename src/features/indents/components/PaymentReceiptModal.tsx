import { ChevronDown } from 'lucide-react';
import { Modal } from '@/components/ui';
import { useAuth } from '@/hooks';
import { fmtDateTime, fmtDate } from '@/utils/date';
import { ViewReceiptLink } from './ViewReceiptLink';
import { RefundStatusBadge } from './RefundStatusBadge';

interface PaymentReceiptModalProps {
    /** The row being viewed; null closes the modal. */
    row: any | null;
    onClose: () => void;
    vendorDisplay: (row: any) => string;
    /** Fired when the user hits "Update refund" — parent opens the refund modal + closes this one. */
    onUpdateRefund: (row: any) => void;
    // Lazy timeline accordion state (owned by the parent).
    timelineOpen: boolean;
    timelineLoading: boolean;
    timelineLoaded: boolean;
    timelineError: boolean;
    timeline: any[];
    onToggleTimeline: () => void;
    onLoadTimeline: (id: string) => void;
}

/**
 * Payment Receipt — read-only view of a paid indent. Opens
 * on row click in the All Other Indents table. Lets finance
 * audit any past payment: vendor breakdown, txn id, receipt
 * screenshot, who paid + when, payment method procurement
 * chose. No fetches — all data is already on the row from
 * the list endpoint include.
 */
export const PaymentReceiptModal = ({
    row,
    onClose,
    vendorDisplay,
    onUpdateRefund,
    timelineOpen,
    timelineLoading,
    timelineLoaded,
    timelineError,
    timeline,
    onToggleTimeline,
    onLoadTimeline,
}: PaymentReceiptModalProps) => {
    const { user } = useAuth();
    return (
        <Modal isOpen={!!row} onClose={onClose} title={row ? `Payment Receipt — ${row.serialNo}` : 'Payment Receipt'}>
            {row && (() => {
                const status = row.status;
                const isPaid = !!row.paymentTransactionId || !!row.paidAt;
                const itemMap: Record<string, any> = {};
                for (const it of (row.items || [])) itemMap[it.id] = it;
                const allocs: any[] = Array.isArray(row.vendorAllocations) ? row.vendorAllocations : [];
                const byVendor: Record<string, { vendor: string; lines: any[]; total: number }> = {};
                for (const a of allocs) {
                    const v = a.vendorName || 'Unassigned';
                    if (!byVendor[v]) byVendor[v] = { vendor: v, lines: [], total: 0 };
                    const lineTotal = Number(a.allocatedQty || 0) * Number(a.unitPrice || 0);
                    byVendor[v].lines.push({
                        itemName: itemMap[a.indentItemId]?.name || '(item removed)',
                        unit: a.unit || itemMap[a.indentItemId]?.unit || '',
                        qty: Number(a.allocatedQty || 0),
                        unitPrice: Number(a.unitPrice || 0),
                        total: lineTotal,
                    });
                    byVendor[v].total += lineTotal;
                }
                const vendors = Object.values(byVendor);
                // Per-vendor ORDER carries the real payment proof (txn id +
                // receipt + paid date) for a per-vendor pay — the indent-level
                // fields stay blank in that case.
                const ordersByVendor: Record<string, any> = {};
                for (const o of (row.vendorOrders || [])) ordersByVendor[o.vendorName] = o;
                return (
                    <div className="space-y-4">
                        <div className="bg-surface rounded-lg p-3 border border-line-soft text-xs">
                            <p><span className="font-bold">Vendor:</span> {vendorDisplay(row) || <span className="italic text-faint">not set</span>}</p>
                            <p><span className="font-bold">Amount:</span> {row.currency} {row.grandTotal?.toLocaleString()}</p>
                            <p><span className="font-bold">Department:</span> {row.department?.name || 'Unknown'}</p>
                            <p><span className="font-bold">Status:</span> {status}</p>
                        </div>

                        {isPaid ? (
                            <div className="bg-emerald-50/60 dark:bg-emerald-400/15 rounded-lg p-3 border border-emerald-200 dark:border-emerald-400/30 text-xs space-y-1">
                                <p className="font-bold text-emerald-900 dark:text-emerald-200 uppercase tracking-wider text-[10px] mb-1">
                                    Payment confirmation
                                </p>
                                <p>
                                    <span className="font-bold">Transaction ID:</span>{' '}
                                    <span className="font-mono">{row.paymentTransactionId || <span className="italic text-faint">not recorded</span>}</span>
                                </p>
                                <p>
                                    <span className="font-bold">Paid by:</span> {row.paidBy?.name || <span className="italic text-faint">unknown</span>}
                                    {row.paidBy?.role && <span className="text-[10px] text-faint"> · {row.paidBy.role}</span>}
                                </p>
                                <p><span className="font-bold">Paid at:</span> {row.paidAt ? fmtDateTime(row.paidAt) : <span className="italic text-faint">—</span>}</p>
                                {row.paymentReceiptPath && (
                                    <p className="pt-1">
                                        <span className="font-bold">Receipt / screenshot:</span>{' '}
                                        <ViewReceiptLink indentId={row.id} />
                                    </p>
                                )}
                            </div>
                        ) : (
                            <p className="text-[11px] text-faint italic">
                                This indent hasn't been marked paid yet.
                            </p>
                        )}

                        {/* Customs duty — every duty raised on this indent
                            (internal + international), with txn id + receipt
                            for the paid ones. Gives finance / super-admin a
                            per-indent audit of the customs spend. */}
                        {Array.isArray(row.customsDutyPayments) && row.customsDutyPayments.length > 0 && (
                            <div className="bg-violet-50/60 dark:bg-violet-400/15 rounded-lg p-3 border border-violet-200 dark:border-violet-400/30 text-xs space-y-2">
                                <p className="font-bold text-violet-900 dark:text-violet-200 uppercase tracking-wider text-[10px]">
                                    Customs duty
                                </p>
                                {row.customsDutyPayments.map((p: any) => (
                                    <div key={p.id} className="border-t border-violet-100 dark:border-violet-400/25 pt-2 first:border-0 first:pt-0">
                                        <p>
                                            <span className="font-bold">{p.kind === 'INTERNAL' ? 'Other payments' : 'Customs duty'}:</span>{' '}
                                            {p.currency} {Number(p.amount).toLocaleString('en-IN')}
                                            {' · '}
                                            <span className={p.status === 'PAID' ? 'text-emerald-700 dark:text-emerald-300 font-bold' : 'text-amber-700 dark:text-amber-300 font-bold'}>
                                                {p.status === 'PAID' ? 'Paid' : 'Pending'}
                                            </span>
                                        </p>
                                        {p.status === 'PAID' && (
                                            <p className="text-[10px] text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                                                {p.transactionId && <span>txn <span className="font-mono text-ink">{p.transactionId}</span></span>}
                                                {p.paidBy?.name && <span>· by {p.paidBy.name}</span>}
                                                {p.paidAt && <span>· {fmtDateTime(p.paidAt)}</span>}
                                                {p.receiptPath && <ViewReceiptLink indentId={row.id} kind="customs-duty" paymentId={p.id} />}
                                            </p>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Refund tracking — only visible when the indent
                            was cancelled after payment + refund is being
                            tracked. Both finance + procurement can hit
                            "Update refund" to move it forward. */}
                        {row.refundStatus && row.refundStatus !== 'NONE' && (
                            <div className="bg-amber-50/40 dark:bg-amber-400/15 rounded-lg p-3 border border-amber-200 dark:border-amber-400/30 text-xs">
                                <div className="flex items-baseline justify-between flex-wrap gap-2 mb-1">
                                    <p className="font-bold text-amber-900 dark:text-amber-200 uppercase tracking-wider text-[10px]">
                                        Refund tracking
                                    </p>
                                    <RefundStatusBadge
                                        status={row.refundStatus}
                                        paidAmount={row.grandTotal}
                                        receivedAmount={row.refundReceivedAmount}
                                        currency={row.currency || 'INR'}
                                        size="md"
                                    />
                                </div>
                                {row.refundExpectedAmount != null && (
                                    <p>
                                        <span className="font-bold">Expected:</span> {row.currency || 'INR'} {Number(row.refundExpectedAmount).toLocaleString('en-IN')}
                                        {row.refundExpectedDate && <> by {fmtDate(row.refundExpectedDate)}</>}
                                    </p>
                                )}
                                {row.refundReceivedAmount != null && (
                                    <p>
                                        <span className="font-bold">Received:</span> {row.currency || 'INR'} {Number(row.refundReceivedAmount).toLocaleString('en-IN')}
                                        {row.refundReceivedDate && <> on {fmtDate(row.refundReceivedDate)}</>}
                                        {row.refundTransactionId && <> · txn <span className="font-mono">{row.refundTransactionId}</span></>}
                                    </p>
                                )}
                                {row.refundNotes && (
                                    <p className="mt-1 text-muted italic whitespace-pre-wrap">{row.refundNotes}</p>
                                )}
                                {row.refundReceiptPath && (
                                    <p className="mt-1">
                                        <ViewReceiptLink indentId={row.id} kind="refund" />
                                    </p>
                                )}
                                {row.refundUpdatedAt && (
                                    <p className="mt-1 text-[10px] text-faint">
                                        Last update {fmtDateTime(row.refundUpdatedAt)}
                                    </p>
                                )}
                                {/* Refund outcomes are Finance / Procurement / Super Admin on the
                                    server; Associate Finance can view refunds but not set them. */}
                                {['PENDING', 'DISPUTED'].includes(row.refundStatus) && user?.role !== 'ASSOCIATE_FINANCE' && (
                                    <div className="mt-2">
                                        <button
                                            onClick={() => onUpdateRefund(row)}
                                            className="text-[11px] font-bold text-amber-800 dark:text-amber-200 hover:text-amber-900 dark:text-amber-200 border border-amber-400 hover:bg-amber-100 dark:bg-amber-400/20 rounded px-2 py-1 transition-colors"
                                        >
                                            Update refund
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {row.paymentMethod && (
                            <div className="bg-sky-50/60 dark:bg-sky-400/15 rounded-lg p-3 border border-sky-200 dark:border-sky-400/30 text-xs">
                                <p className="font-bold text-sky-900 dark:text-sky-200 uppercase tracking-wider text-[10px] mb-1">
                                    Payment method (from procurement)
                                </p>
                                <p className="text-ink">
                                    <span className="font-bold">{({
                                        ONLINE: 'Online (vendor portal / payment gateway)',
                                        WIRE_TRANSFER: 'Wire transfer / NEFT / RTGS',
                                        CHEQUE: 'Cheque',
                                        CASH: 'Cash',
                                        OTHER: 'Other',
                                    } as any)[row.paymentMethod] || row.paymentMethod}</span>
                                </p>
                                {row.paymentMethodNotes && (
                                    <p className="mt-1 text-muted whitespace-pre-wrap">{row.paymentMethodNotes}</p>
                                )}
                                {row.paymentHandoffAt && (
                                    <p className="mt-1 text-[10px] text-faint">
                                        Handed off {fmtDateTime(row.paymentHandoffAt)}
                                        {row.paymentHandoffBy?.name && ` · ${row.paymentHandoffBy.name}`}
                                    </p>
                                )}
                            </div>
                        )}

                        <div className="bg-emerald-50/40 dark:bg-emerald-400/15 rounded-lg p-3 border border-emerald-100 dark:border-emerald-400/25 text-xs">
                            <p className="font-bold text-emerald-900 dark:text-emerald-200 uppercase tracking-wider text-[10px] mb-2">
                                Vendor breakdown
                            </p>
                            {vendors.length === 0 ? (
                                <p className="text-[11px] text-faint italic">No per-vendor allocation recorded.</p>
                            ) : (
                                <div className="space-y-2">
                                    {vendors.map(v => (
                                        <div key={v.vendor} className="bg-card rounded border border-emerald-100 dark:border-emerald-400/25 p-2">
                                            <div className="flex items-baseline justify-between mb-1">
                                                <span className="font-bold text-ink">{v.vendor}</span>
                                                <span className="font-mono font-bold text-emerald-700 dark:text-emerald-300">
                                                    {row.currency} {v.total.toLocaleString('en-IN')}
                                                </span>
                                            </div>
                                            <ul className="space-y-0.5">
                                                {v.lines.map((ln, i) => (
                                                    <li key={i} className="text-[10px] text-muted flex items-baseline justify-between gap-2">
                                                        <span className="truncate flex-1">{ln.itemName}</span>
                                                        <span className="font-mono whitespace-nowrap">
                                                            {ln.qty} {ln.unit} × {ln.unitPrice.toLocaleString('en-IN')}
                                                        </span>
                                                    </li>
                                                ))}
                                            </ul>
                                            {/* This vendor's own payment proof — txn id, paid date, receipt. */}
                                            {(() => {
                                                const vo = ordersByVendor[v.vendor];
                                                if (!vo) return null;
                                                const paid = vo.status !== 'AWAITING_PAYMENT' && (vo.paymentTransactionId || vo.paidAt);
                                                return (
                                                    <div className="mt-1.5 pt-1.5 border-t border-emerald-100 dark:border-emerald-400/25 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
                                                        {paid ? (
                                                            <>
                                                                <span className="font-bold text-emerald-700 dark:text-emerald-300">Paid</span>
                                                                {vo.paymentTransactionId && <span className="text-muted">txn <span className="font-mono text-ink">{vo.paymentTransactionId}</span></span>}
                                                                {vo.paidAt && <span className="text-faint">{fmtDateTime(vo.paidAt)}</span>}
                                                                {vo.paymentReceiptPath && <ViewReceiptLink indentId={row.id} kind="vendor-order" orderId={vo.id} />}
                                                            </>
                                                        ) : (
                                                            <span className="text-amber-700 dark:text-amber-300 font-bold">Awaiting payment</span>
                                                        )}
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Timeline / status history — fetched from
                            /indents/:id/timeline. Lets finance audit
                            the full lifecycle: who approved, when
                            procurement quoted, when payment was made,
                            when inventory marked received. Friendly
                            labels + stage colors so it scans as a
                            lifecycle, not a SQL dump. */}
                        <div className="bg-brand-50 rounded-lg border border-brand-200 text-xs">
                            <button
                                type="button"
                                onClick={onToggleTimeline}
                                aria-expanded={timelineOpen}
                                className="w-full flex items-center justify-between gap-2 p-3 text-left hover:bg-brand-50 rounded-lg transition-colors"
                            >
                                <span className="font-bold text-brand-700 uppercase tracking-wider text-[10px]">
                                    Timeline / history
                                </span>
                                <ChevronDown
                                    size={14}
                                    className={`text-brand-700 transition-transform ${timelineOpen ? 'rotate-180' : ''}`}
                                />
                            </button>
                            {timelineOpen && (
                            <div className="px-3 pb-3">
                            {(timelineLoading || !timelineLoaded) ? (
                                <p className="text-[11px] text-faint italic">Loading timeline…</p>
                            ) : timelineError ? (
                                <p className="text-[11px] text-faint italic">
                                    Couldn't load the timeline.{' '}
                                    <button
                                        type="button"
                                        onClick={() => row && onLoadTimeline(row.id)}
                                        className="text-brand-700 underline hover:text-brand-700 not-italic font-semibold"
                                    >
                                        Retry
                                    </button>
                                </p>
                            ) : timeline.length === 0 ? (
                                <p className="text-[11px] text-faint italic">No status changes recorded yet.</p>
                            ) : (() => {
                                const STATUS_LABEL: Record<string, string> = {
                                    PENDING: 'Awaiting approval',
                                    APPROVED: 'Approved',
                                    REJECTED: 'Rejected',
                                    QUOTATION_IN_PROGRESS: 'Procurement quoting',
                                    READY_FOR_PAYMENT: 'Ready for payment',
                                    AWAITING_PAYMENT: 'Awaiting payment',
                                    PAYMENT_DONE: 'Payment done',
                                    ORDERED: 'Order placed',
                                    IN_TRANSIT: 'In transit',
                                    PARTIALLY_RECEIVED: 'Partly received',
                                    RECEIVED: 'Received in inventory',
                                    CANCELLED: 'Cancelled',
                                };
                                // Verb labels keyed by the actual transition — much more
                                // informative than the generic "Moved to: X". Especially
                                // important for the firm-quote bounce (QIP → PENDING)
                                // which reads as "back to approval" instead of confusingly
                                // looking like the indent just regressed.
                                const TRANSITION_LABEL: Record<string, string> = {
                                    '→PENDING': 'Indent raised — awaiting approval',
                                    'PENDING→QUOTATION_IN_PROGRESS': 'Admin approval complete — handed to Procurement to quote',
                                    'QUOTATION_IN_PROGRESS→PENDING': 'Quote finalised — re-approval required at firm price',
                                    'PENDING→READY_FOR_PAYMENT': 'Re-approved at firm price — back to Procurement for payment method',
                                    'PENDING→AWAITING_PAYMENT': 'Re-approved at firm price — sent to Finance',
                                    'QUOTATION_IN_PROGRESS→READY_FOR_PAYMENT': 'Ready for payment',
                                    'QUOTATION_IN_PROGRESS→AWAITING_PAYMENT': 'Sent to Finance for payment',
                                    'READY_FOR_PAYMENT→AWAITING_PAYMENT': 'Sent to Finance for payment',
                                    'AWAITING_PAYMENT→PAYMENT_DONE': 'Payment confirmed',
                                    'PAYMENT_DONE→ORDERED': 'Order placed with vendor',
                                    'PAYMENT_DONE→IN_TRANSIT': 'Vendor shipped',
                                    'ORDERED→IN_TRANSIT': 'Vendor shipped',
                                    'ORDERED→RECEIVED': 'Received in inventory',
                                    'IN_TRANSIT→RECEIVED': 'Received in inventory',
                                    'ORDERED→PARTIALLY_RECEIVED': 'First vendor shipment received — others still in transit',
                                    'IN_TRANSIT→PARTIALLY_RECEIVED': 'A vendor shipment received — others still in transit',
                                    'PARTIALLY_RECEIVED→RECEIVED': 'Final shipment received — fully in inventory',
                                    'PARTIALLY_RECEIVED→CANCELLED': 'Cancelled — remaining shipments called off',
                                    'PENDING→REJECTED': 'Rejected at approval',
                                    'QUOTATION_IN_PROGRESS→CANCELLED': 'Cancelled during quoting',
                                };
                                const ACTION_LABEL: Record<string, string> = {
                                    CREATED: 'Indent created',
                                    AUTO_APPROVED: 'Auto-approved (raised by an approver)',
                                    TECH_APPROVED: 'Approved (Admin / Tech)',
                                    TECH_REJECTED: 'Rejected (Admin / Tech)',
                                    TECH_PENDING: 'Admin/Tech approval revoked',
                                    CEO_APPROVED: 'Approved (CEO)',
                                    CEO_REJECTED: 'Rejected (CEO)',
                                    CEO_REVOKED: 'CEO approval revoked',
                                    SENT_TO_FINANCE: 'Sent to Finance',
                                    PAYMENT_DONE: 'Marked as paid',
                                    PAYMENT_RETRIED: 'Payment retried — re-sent to Finance',
                                    CANCELLED_WITH_REFUND_PENDING: 'Cancelled — refund pending',
                                    CANCELLED_WITH_REFUND_RECEIVED: 'Cancelled — refund received',
                                    CANCELLED_WITH_REFUND_WRITE_OFF: 'Cancelled — written off',
                                    CANCELLED_WITH_REFUND_DISPUTED: 'Cancelled — refund disputed',
                                    REFUND_RECEIVED: 'Refund received',
                                    REFUND_DISPUTED: 'Refund disputed with vendor',
                                    REFUND_WRITE_OFF: 'Refund written off',
                                    REFUND_REOPENED: 'Refund re-opened',
                                    REFUND_UPDATED: 'Refund status updated',
                                    REFUND_RECEIPT_UPLOADED: 'Refund receipt uploaded',
                                    ETA_SET: 'Expected delivery date set',
                                    ETA_UPDATED: 'Delivery date revised',
                                };
                                // Specific dedupe — only collapse status transitions where a
                                // nearby approval action ALREADY tells the same story. We KEEP
                                // transitions that convey new destination info (e.g. "now back
                                // with Procurement for payment method", "now with vendor") so
                                // the timeline tracks the full custody chain.
                                // Map: approval action → toStatus it implicitly covers.
                                const ACTION_COVERS_TRANSITION: Record<string, string[]> = {
                                    CREATED: ['PENDING'],                              // covers null→PENDING
                                    // Pre-fix indents auto-transitioned PENDING→AWAITING_PAYMENT
                                    // right after the final approval. The action row already
                                    // captures the approver — the transition row is redundant.
                                    // (Post-fix flow lands on READY_FOR_PAYMENT instead, which
                                    // is NOT covered here so its "back to Procurement for
                                    // payment method" handoff stays visible.)
                                    TECH_APPROVED: ['AWAITING_PAYMENT'],
                                    CEO_APPROVED: ['AWAITING_PAYMENT'],
                                    SENT_TO_FINANCE: ['AWAITING_PAYMENT'],             // covers READY_FOR_PAYMENT→AWAITING_PAYMENT
                                    PAYMENT_DONE: ['PAYMENT_DONE'],                    // covers AWAITING_PAYMENT→PAYMENT_DONE
                                    // Cancel-with-refund + retry-payment events fully describe
                                    // the transition they triggered — collapse the duplicate
                                    // status row so the timeline reads as one event, not two.
                                    CANCELLED_WITH_REFUND_PENDING: ['CANCELLED'],
                                    CANCELLED_WITH_REFUND_RECEIVED: ['CANCELLED'],
                                    CANCELLED_WITH_REFUND_WRITE_OFF: ['CANCELLED'],
                                    PAYMENT_RETRIED: ['AWAITING_PAYMENT'],
                                };
                                const DEDUPE_WINDOW_MS = 10_000;
                                const events = timeline.filter((log: any) => {
                                    if (log.kind !== 'status') return true;
                                    const t = new Date(log.createdAt).getTime();
                                    const isCovered = timeline.some((other: any) => {
                                        if (other.kind !== 'approval') return false;
                                        const covers = ACTION_COVERS_TRANSITION[other.action] || [];
                                        if (!covers.includes(log.toStatus)) return false;
                                        return Math.abs(new Date(other.createdAt).getTime() - t) < DEDUPE_WINDOW_MS;
                                    });
                                    return !isCovered;
                                });

                                // One unified summary per event — no chips, no dual rendering.
                                // Status transitions use the verb-style TRANSITION_LABEL when
                                // we have one for the specific from→to pair; otherwise fall
                                // back to the destination status label.
                                const INVENTORY_LABEL: Record<string, string> = {
                                    STOCK_IN: 'Stock received in inventory',
                                    ISSUED: 'Issued to requester',
                                    RETURNED: 'Returned to inventory',
                                    DISPOSED: 'Disposed',
                                    ADJUSTED: 'Stock adjusted',
                                };
                                const summary = (log: any): string => {
                                    if (log.kind === 'approval') return ACTION_LABEL[log.action] || log.action;
                                    if (log.kind === 'inventory') {
                                        const verb = INVENTORY_LABEL[log.eventType] || log.eventType;
                                        const qty = log.quantityChange > 0 ? `+${log.quantityChange}` : `${log.quantityChange}`;
                                        return `${verb} (${qty} ${log.itemUnit || ''} · ${log.itemName || 'item'})`;
                                    }
                                    const key = `${log.fromStatus || ''}→${log.toStatus}`;
                                    if (TRANSITION_LABEL[key]) return TRANSITION_LABEL[key];
                                    const to = STATUS_LABEL[log.toStatus] || log.toStatus;
                                    return log.fromStatus ? to : `Status: ${to}`;
                                };

                                const isReject = (log: any) => log.kind === 'approval'
                                    ? /REJECT/.test(log.action || '')
                                    : log.kind === 'status'
                                    ? (log.toStatus === 'REJECTED' || log.toStatus === 'CANCELLED')
                                    : false;
                                const isDone = (log: any) => log.kind === 'approval'
                                    ? log.action === 'PAYMENT_DONE'
                                    : log.kind === 'status'
                                    ? (log.toStatus === 'RECEIVED' || log.toStatus === 'PAYMENT_DONE')
                                    : log.eventType === 'STOCK_IN';

                                return (
                                    <ol className="relative border-l-2 border-brand-200 ml-2 space-y-3 pl-4">
                                        {events.map((log: any) => {
                                            const dotColor = isReject(log) ? 'bg-red-500' : isDone(log) ? 'bg-emerald-500' : 'bg-brand';
                                            return (
                                                <li key={`${log.kind}-${log.id}`} className="relative">
                                                    <span className={`absolute -left-[21px] top-[7px] w-2.5 h-2.5 rounded-full border-2 border-card shadow ${dotColor}`}></span>
                                                    <div className="flex items-baseline justify-between gap-2 flex-wrap">
                                                        <p className="text-[12px] font-bold text-ink">{summary(log)}</p>
                                                        <span className="text-[10px] text-faint whitespace-nowrap">{fmtDateTime(log.createdAt)}</span>
                                                    </div>
                                                    <p className="text-[10px] text-muted mt-0.5">
                                                        {log.actor?.name || 'System'}
                                                        {log.actor?.role && <span className="text-faint"> · {log.actor.role}</span>}
                                                        {log.kind === 'inventory' && typeof log.stockAfter === 'number' && (
                                                            <span className="text-faint"> · stock now {log.stockAfter}</span>
                                                        )}
                                                    </p>
                                                    {log.kind === 'inventory' && log.requestSerialNo && (
                                                        <p className="text-[10px] text-emerald-700 dark:text-emerald-300 mt-0.5">
                                                            Fulfilled {log.requestSerialNo}
                                                            {log.requestForUser && <span className="text-muted"> for {log.requestForUser}</span>}
                                                        </p>
                                                    )}
                                                    {log.notes && (
                                                        <p className="text-[10px] text-muted italic mt-1 pl-2 border-l-2 border-brand-200 whitespace-pre-wrap">{log.notes}</p>
                                                    )}
                                                </li>
                                            );
                                        })}
                                    </ol>
                                );
                            })()}
                            </div>
                            )}
                        </div>

                        <div className="flex justify-end pt-2 border-t border-line-soft">
                            <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-muted hover:bg-surface rounded">Close</button>
                        </div>
                    </div>
                );
            })()}
        </Modal>
    );
};
