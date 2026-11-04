import { useSearchParams } from 'react-router-dom';
import { useMemo, useState, useEffect } from 'react';
import { useKnownVendorNames } from '@/features/vendors';
import { client } from '@/api';
import { DataTable, Modal, StatusBadge, ColumnFilter, ExportPanel, Pagination, SearchInput, LoadAllCapNote } from '@/components/ui';
import { useTableFilters, usePagedFilters, useServerPagination, FilterSpec, useAuth } from '@/hooks';
import { EditableCell } from '@/components/ui/EditableCell';
import { IndentForm } from '@/components/forms';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { IndentDetailsModal, ApprovalCell } from '../components/IndentDetailsModal';
import { ViewReceiptLink } from '../components/ViewReceiptLink';
import { IndentTrackModal } from '../components/IndentTrackModal';
import { CancelIndentModal, CancelOutcome } from '../components/CancelIndentModal';
import { RefundStatusModal } from '../components/RefundStatusModal';
import { RefundStatusBadge } from '../components/RefundStatusBadge';
import { OrderedConfirmModal, OrderedOutcome } from '../components/OrderedConfirmModal';
import { CustomsClearanceModal } from '../components/CustomsClearanceModal';
import { VendorShipmentModal } from '../components/VendorShipmentModal';
import { SendToFinanceModal } from '../components/SendToFinanceModal';
import { FinaliseReviewModal } from '../components/FinaliseReviewModal';
import { needsCeoSignoff, ceoLaneVisible, VENDOR_ORDER_ROLES, ceoNotApplicableLabel, ceoNotApplicableTitle } from '@/config/thresholds';
import { extractErrorMessage } from '@/lib';
import { dateOnlyKey } from '@/utils/date';


// Stable signature of the editable vendor-allocation fields — used to detect
// unsaved edits (compare the live rows against the snapshot taken on load) so
// closing the modal with pending changes can warn instead of silently dropping
// them. Order-stable: load preserves server order; adds append, removes filter.
const allocSig = (rows: any[]): string =>
    JSON.stringify((rows || []).map((a: any) => ({
        i: a.indentItemId, v: String(a.vendorName || '').trim(),
        q: Number(a.allocatedQty) || 0, p: Number(a.unitPrice) || 0,
        c: String(a.currency || 'INR').toUpperCase().trim(), u: String(a.unit ?? '').trim(),
        url: String(a.url ?? '').trim(), n: String(a.notes ?? '').trim(),
        g: (a.gstPercentage == null || a.gstPercentage === '') ? null : Number(a.gstPercentage),
        s: (a.shippingCost == null || a.shippingCost === '') ? null : Number(a.shippingCost),
        e: a.quotedEtaDate ? String(a.quotedEtaDate).slice(0, 10) : null,
        alt: a.isAlternative === true,
    })));

// Active = every indent not yet closed. History (RECEIVED/REJECTED/CANCELLED)
// lives in its own bucket. Both are paginated server-side, 10/page.
/**
 * Who is supplying this indent, in the order procurement would say it.
 *
 * Two sources, because the answer changes as the indent moves. Early on there
 * are only ALLOCATIONS — vendors quoted against lines, still provisional and
 * possibly including alternatives that were never chosen. Once it is sent to
 * finance there are ORDERS, one per vendor actually being bought from. Orders
 * win where they exist: they are what is happening, not what was considered.
 *
 * Discarded allocations and alternatives are dropped — listing a vendor whose
 * quote was rejected as the supplier would be wrong on the face of it.
 *
 * Deduplicated and order-preserving: one vendor quoted on six lines is one
 * vendor, and the first name shown should be the first one on the indent.
 */
const vendorNamesOf = (row: any): string[] => {
  const fromOrders = (row?.vendorOrders ?? [])
    .map((o: any) => o?.vendorName)
    .filter(Boolean);
  const source = fromOrders.length > 0
    ? fromOrders
    : (row?.vendorAllocations ?? [])
        .filter((a: any) => !a?.isDiscarded && !a?.isAlternative)
        .map((a: any) => a?.vendorName)
        .filter(Boolean);
  return [...new Set<string>(source)];
};

const ACTIVE_INDENT_STATUSES = 'PENDING,APPROVED,QUOTATION_IN_PROGRESS,READY_FOR_PAYMENT,AWAITING_PAYMENT,PAYMENT_DONE,ORDERED,IN_TRANSIT,PARTIALLY_RECEIVED';
const DONE_INDENT_STATUSES = 'RECEIVED,REJECTED,CANCELLED';

export const IndentsManagementPage = () => {

    const [isViewModalOpen, setIsViewModalOpen] = useState(false);
    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
    // Opt-in withdrawn (soft-deleted) rows in the History modal — off by
    // default. Drives both the history fetch and the export so the downloaded
    // file matches the table.
    const [showDeleted, setShowDeleted] = useState(false);
    const [isRaiseModalOpen, setIsRaiseModalOpen] = useState(false);
    // Track modal — same shared component used on the user-facing page and the
    // History log. Lets admin/super-admin pin down delays from any indent row.
    const [trackIndent, setTrackIndent] = useState<any>(null);
    // Customs-clearance modal — any indent in transit (currency-agnostic).
    const [customsRow, setCustomsRow] = useState<any>(null);
    const [shipmentRow, setShipmentRow] = useState<any>(null);
    // Send-to-Finance modal — captures payment method + optional notes
    // before the indent moves from READY_FOR_PAYMENT to AWAITING_PAYMENT.
    const [sendToFinanceRow, setSendToFinanceRow] = useState<any>(null);
    // Reopen / re-quote modal — pulls a quoted indent back to
    // QUOTATION_IN_PROGRESS from READY_FOR_PAYMENT or AWAITING_PAYMENT when a
    // vendor's stock ran out during the approval/payment gap. Hard stop at
    // PAYMENT_DONE (button hidden once paid).
    const [reopenRow, setReopenRow] = useState<any>(null);
    const [reopenReason, setReopenReason] = useState('');
    const [reopening, setReopening] = useState(false);
    const [selectedIndent, setSelectedIndent] = useState<any>(null);
    const [indentItems, setIndentItems] = useState<any[]>([]);
    // Snapshot of items as they were when the modal opened, used to roll back
    // optimistic edits if the user cancels or if the server rejects the save.
    const [originalItems, setOriginalItems] = useState<any[]>([]);
    const [isSavingItems, setIsSavingItems] = useState(false);

    // Vendor allocation
    const [allocations, setAllocations] = useState<any[]>([]);
    // Snapshot of allocations as last loaded from the server — the baseline for
    // detecting unsaved edits when the modal is closed.
    const [originalAllocations, setOriginalAllocations] = useState<any[]>([]);
    // The merged list (curated codes + names actually used) and a way to
    // promote a new one, so a vendor can be added from where it is typed.
    const { names: knownVendors, saveToList: saveVendorToList } = useKnownVendorNames();

    const { addToast } = useToast();
    const confirm = useConfirm();
    const { user } = useAuth();
    // Who may advance a vendor order's status from the BOM table — mirrors the
    // backend route guard (PROCUREMENT / FINANCE / SUPER_ADMIN).
    const canUpdateVendorOrderStatus = VENDOR_ORDER_ROLES.includes(user?.role || '');

    // BOM lens for the active queue. Three mutually-exclusive VIEWS over the
    // SAME pipeline (not forked queues), each driven by a server-side filter so
    // it spans every page; the pagination hook resets to page 1 on param change:
    //   'all'     → no filter (default)
    //   'regular' → hand-raised only   (regularOnly=true → bomListId IS null)
    //   'bom'     → BOM-spawned only    (bomOnly=true     → bomListId NOT null)
    const [bomView, setBomView] = useState<'all' | 'regular' | 'bom'>('all');

    // Two independent server-side buckets, 10/page each. Emergencies float to
    // the top of the active list, then newest-first — the orderBy=priority
    // sort runs server-side now (was a client .sort(byPriority)), so it holds
    // across pages instead of just within the loaded slice. The inline error
    // banner below reads activeP.error (the hook still toasts on failure too).
    // 'all' sends neither param; undefined values are dropped by the hook. The
    // two flags are mutually exclusive here (one segmented control) so they
    // never both go out — backend treats bomOnly as winning if they ever did.
    const activeP  = useServerPagination<any>({ loadAll: true, endpoint: '/indents', params: { status: ACTIVE_INDENT_STATUSES, orderBy: 'priority', bomOnly: bomView === 'bom' ? 'true' : undefined, regularOnly: bomView === 'regular' ? 'true' : undefined } });
    // The archive loads only while the History modal is open, as on
    // FinanceIndentsPage. Ungated it pulled up to 2,000 finished indents on
    // every visit, and again on every keystroke in the search box (which feeds
    // both lists), for a table nobody had opened.
    const historyP = useServerPagination<any>({ loadAll: true, endpoint: '/indents', params: { status: DONE_INDENT_STATUSES, orderBy: 'priority', includeDeleted: showDeleted }, enabled: isHistoryModalOpen });
    const indents = activeP.items;
    const pastIndents = historyP.items;
    const isLoading = activeP.isLoading;
    const fetchError = activeP.error;

    // Refresh both buckets after any mutation, then nudge the sidebar badge to
    // re-count. Kept async + same name so the ~8 call sites (and the Retry
    // button / CustomsClearanceModal onSaved) need no changes. The old
    // fetchIndents also dispatched indents-updated on success, so callers that
    // additionally dispatch it themselves are just a harmless double-fire.
    const fetchIndents = async () => {
        activeP.refetch();
        historyP.refetch();
        window.dispatchEvent(new Event('indents-updated'));
    };

    // Returns true when the caller should treat this as "done" (success OR the
    // expected re-approval bounce) and may close the modal; false on a genuine
    // failure so the caller keeps the modal open and the user's unsaved work
    // (item edits + vendor allocations still in local state) is NOT lost.
    const handleUpdateStatus = async (id: string, _type: 'status', val: any, extras?: Record<string, any>): Promise<boolean> => {
        let ok = false;
        try {
            await client.patch(`/indents/${id}/status`, { status: val, ...(extras || {}) });
            addToast('Status updated successfully', 'success');
            ok = true;
        } catch (e: any) {
            const msg = extractErrorMessage(e, 'Failed to update status');
            // The quote-finalise "bounce gate" returns HTTP 400 by design: it
            // sends the indent back to PENDING for Tech/CEO re-approval at the
            // firm price (see indents.service.ts bounce gate). That's the
            // expected, successful outcome — not a failure — so show it green
            // AND treat it as a "done" outcome the modal can close on.
            // Genuine errors (e.g. "no vendor allocations yet") stay red and
            // return false so the modal stays open with the work intact.
            const isReapprovalBounce = /moved back for .*re-approval/i.test(msg);
            addToast(msg, isReapprovalBounce ? 'success' : 'error');
            ok = isReapprovalBounce;
        } finally {
            // ALWAYS refetch. The bounce gate returns 400 but still mutates
            // state (status → PENDING, approvals reset). Without a refetch on
            // the error path, procurement keeps seeing the indent as "Quoting"
            // and tries to edit allocations → backend rejects → confusion.
            fetchIndents();
            // Sidebar badges that listen to this event (refundsPendingCount,
            // financePaymentsCount) refresh after a state change.
            window.dispatchEvent(new Event('indents-updated'));
        }
        return ok;
    };

    // Cancel + refund flow — intercepts the "Cancelled" choice from the
    // status dropdown. Reason + recovery path are collected in the
    // modal; on submit we PATCH /indents/:id/status with the right
    // payload shape (retryPayment or cancellationReason + refundStatus).
    const [cancelRow, setCancelRow] = useState<any | null>(null);
    const [cancelSubmitting, setCancelSubmitting] = useState(false);
    const submitCancel = async (outcome: CancelOutcome) => {
        if (!cancelRow) return;
        setCancelSubmitting(true);
        try {
            // Build JSON body for the status PATCH. Receipt file (if any) is
            // uploaded in a separate multipart call AFTER the PATCH succeeds —
            // keeps the PATCH endpoint JSON-only and lets receipts be added
            // later via the Update Refund modal too.
            const body: any = { status: 'CANCELLED', cancellationReason: outcome.reason };
            if (outcome.kind === 'RETRY_PAYMENT') {
                body.status = 'AWAITING_PAYMENT';
                body.retryPayment = true;
            } else if (outcome.kind === 'CANCEL_WITH_REFUND') {
                body.refundStatus = outcome.refundStatus;
                if (outcome.expectedAmount != null) body.refundExpectedAmount = outcome.expectedAmount;
                if (outcome.expectedDate) body.refundExpectedDate = outcome.expectedDate;
                if (outcome.receivedAmount != null) body.refundReceivedAmount = outcome.receivedAmount;
                if (outcome.receivedDate) body.refundReceivedDate = outcome.receivedDate;
                if (outcome.transactionId) body.refundTransactionId = outcome.transactionId;
                if (outcome.notes) body.refundNotes = outcome.notes;
            } else if (outcome.kind === 'REORDER_WITH_REFUND') {
                // Don't cancel — reopen to re-quote so the project keeps moving,
                // while the original payment's refund is chased in parallel.
                // Same refund payload as a cancel; the backend keeps the paid*
                // fields intact and routes the indent to QUOTATION_IN_PROGRESS.
                body.status = 'QUOTATION_IN_PROGRESS';
                body.reorderWithRefund = true;
                body.refundStatus = outcome.refundStatus;
                if (outcome.expectedAmount != null) body.refundExpectedAmount = outcome.expectedAmount;
                if (outcome.expectedDate) body.refundExpectedDate = outcome.expectedDate;
                if (outcome.receivedAmount != null) body.refundReceivedAmount = outcome.receivedAmount;
                if (outcome.receivedDate) body.refundReceivedDate = outcome.receivedDate;
                if (outcome.transactionId) body.refundTransactionId = outcome.transactionId;
                if (outcome.notes) body.refundNotes = outcome.notes;
            }
            await client.patch(`/indents/${cancelRow.id}/status`, body);

            // Upload the screenshot (if provided). Separate call so an
            // upload failure doesn't roll back the cancel itself — the
            // refund tracking still works, the file can be re-uploaded
            // later from the Update Refund modal.
            if ((outcome.kind === 'CANCEL_WITH_REFUND' || outcome.kind === 'REORDER_WITH_REFUND') && outcome.receiptFile) {
                try {
                    const fd = new FormData();
                    fd.append('receipt', outcome.receiptFile);
                    await client.post(`/indents/${cancelRow.id}/refund-receipt`, fd, {
                        headers: { 'Content-Type': 'multipart/form-data' },
                    });
                } catch (e: any) {
                    addToast(extractErrorMessage(e, 'Cancel succeeded but receipt upload failed — try again from Update Refund'), 'error');
                }
            }

            addToast(
                outcome.kind === 'RETRY_PAYMENT' ? 'Re-sent to Finance for payment'
                : outcome.kind === 'CANCEL_NO_REFUND' ? 'Indent cancelled'
                : outcome.kind === 'REORDER_WITH_REFUND'
                    ? (outcome.refundStatus === 'RECEIVED' ? 'Re-ordering — refund already recorded'
                       : outcome.refundStatus === 'WRITE_OFF' ? 'Re-ordering — original payment written off'
                       : 'Re-opened to re-quote — refund chased in parallel')
                : outcome.refundStatus === 'WRITE_OFF' ? 'Cancelled — money written off'
                : outcome.refundStatus === 'RECEIVED' ? 'Cancelled — refund recorded'
                : 'Cancelled — refund tracked',
                'success',
            );
            setCancelRow(null);
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to cancel indent'), 'error');
        } finally {
            setCancelSubmitting(false);
            fetchIndents();
            window.dispatchEvent(new Event('indents-updated'));
        }
    };

    // Reopen / re-quote: pull a quoted indent back to QUOTATION_IN_PROGRESS so
    // procurement can re-quote when a vendor's stock ran out. Allowed from
    // READY_FOR_PAYMENT and AWAITING_PAYMENT; the backend enforces the hard stop
    // at PAYMENT_DONE and warns Finance when pulled out of their payment queue.
    const submitReopen = async () => {
        if (!reopenRow) return;
        setReopening(true);
        try {
            await client.post(`/indents/${reopenRow.id}/reopen-quotation`, {
                reason: reopenReason.trim() || undefined,
            });
            addToast(`${reopenRow.serialNo} reopened — re-quote and resubmit when ready.`, 'success');
            setReopenRow(null);
            setReopenReason('');
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to reopen for re-quoting'), 'error');
        } finally {
            setReopening(false);
            fetchIndents();
            window.dispatchEvent(new Event('indents-updated'));
        }
    };

    // Mark-as-Ordered + Update-ETA flow — single modal in two modes:
    //   - 'mark_ordered': intercepted from the status dropdown when
    //     procurement picks "Mark as Ordered". Captures the expected
    //     delivery date + status transition in one PATCH /status call.
    //   - 'update_eta': opened from the "Update ETA" button on rows
    //     already at ORDERED or IN_TRANSIT. Date-only update via
    //     PATCH /indents/:id/eta (no status change).
    const [orderedRow, setOrderedRow] = useState<any | null>(null);
    const [orderedMode, setOrderedMode] = useState<'mark_ordered' | 'update_eta'>('mark_ordered');
    const [orderedSubmitting, setOrderedSubmitting] = useState(false);
    const submitOrdered = async (outcome: OrderedOutcome) => {
        if (!orderedRow) return;
        setOrderedSubmitting(true);
        try {
            if (outcome.kind === 'MARK_ORDERED') {
                // One PATCH: status transition + ETA + hasTime flag in the same body.
                await client.patch(`/indents/${orderedRow.id}/status`, {
                    status: 'ORDERED',
                    expectedDeliveryDate: outcome.expectedDeliveryDate,
                    expectedDeliveryHasTime: outcome.expectedDeliveryHasTime,
                    notes: outcome.notes || undefined,
                });
                addToast('Marked as Ordered · ETA shared with requester', 'success');
            } else {
                // Pure ETA update — separate endpoint.
                await client.patch(`/indents/${orderedRow.id}/eta`, {
                    expectedDeliveryDate: outcome.expectedDeliveryDate,
                    expectedDeliveryHasTime: outcome.expectedDeliveryHasTime,
                    notes: outcome.notes || undefined,
                });
                addToast('ETA updated · requester notified', 'success');
            }
            setOrderedRow(null);
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to update'), 'error');
        } finally {
            setOrderedSubmitting(false);
            fetchIndents();
            window.dispatchEvent(new Event('indents-updated'));
        }
    };

    // Refund-update modal — opened from the "Update refund" button on a
    // cancelled row with refundStatus IN (PENDING, DISPUTED). Either
    // procurement or finance can flip the status forward.
    const [refundRow, setRefundRow] = useState<any | null>(null);
    const [refundSubmitting, setRefundSubmitting] = useState(false);
    const submitRefundUpdate = async (payload: any) => {
        if (!refundRow) return;
        setRefundSubmitting(true);
        try {
            const { receiptFile, ...jsonPayload } = payload;
            await client.patch(`/indents/${refundRow.id}/refund`, jsonPayload);
            if (receiptFile) {
                try {
                    const fd = new FormData();
                    fd.append('receipt', receiptFile);
                    await client.post(`/indents/${refundRow.id}/refund-receipt`, fd, {
                        headers: { 'Content-Type': 'multipart/form-data' },
                    });
                } catch (e: any) {
                    addToast(extractErrorMessage(e, 'Refund saved but receipt upload failed — try again'), 'error');
                }
            }
            addToast('Refund status updated', 'success');
            setRefundRow(null);
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to update refund'), 'error');
        } finally {
            setRefundSubmitting(false);
            fetchIndents();
            window.dispatchEvent(new Event('indents-updated'));
        }
    };

    // Finalise review flow — fires at Finalise time when any item is
    // short-allocated (procurement buying less) OR over-allocated (procurement
    // buying more to fill general stock). One modal handles both:
    //   - Short rows need a reason
    //   - Over rows need a split decision (how much for the requester vs
    //     general stock)
    // userAssignments is keyed by indentItemId → "for user" qty.
    const [reviewModal, setReviewModal] = useState<{ shortfalls: any[]; overages: any[] } | null>(null);
    const [reviewReason, setReviewReason] = useState('');
    const [userAssignments, setUserAssignments] = useState<Record<string, number>>({});
    const [finalisingPartial, setFinalisingPartial] = useState(false);

    // Keyed by `${indentId}:${type}` — a reminder button disables itself while
    // its POST is in flight so an impatient double/triple-click can't stack
    // duplicate reminders (the backend also throttles, this is the UX guard).
    const [remindingKeys, setRemindingKeys] = useState<Set<string>>(new Set());
    const isReminding = (id: string, type: string) => remindingKeys.has(`${id}:${type}`);

    const handleRemind = async (id: string, type: 'tech' | 'ceo' | 'finance') => {
        const key = `${id}:${type}`;
        if (remindingKeys.has(key)) return; // in-flight guard against re-entry
        setRemindingKeys(prev => new Set(prev).add(key));
        try {
            const res = await client.post(`/indents/${id}/remind`, { type });
            const labels = { tech: 'Admin', ceo: 'CEO', finance: 'Finance' };
            // Surface the server message so a throttled ("already sent recently")
            // repeat reads as such instead of a misleading "sent" toast.
            const serverMsg = res?.data?.data?.message || res?.data?.message;
            addToast(serverMsg || `Reminder sent to ${labels[type]}`, 'success');
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to send reminder'), 'error');
        } finally {
            setRemindingKeys(prev => { const n = new Set(prev); n.delete(key); return n; });
        }
    };

    // Guards against a double-click creating duplicate purchase indents: the
    // submit button is disabled while the POST is in flight (wired to the form's
    // isLoading), and the handler no-ops on re-entry.
    const [isCreatingIndent, setIsCreatingIndent] = useState(false);
    const handleCreateIndent = async (data: any) => {
        if (isCreatingIndent) return;
        setIsCreatingIndent(true);
        try {
            // Returned so IndentForm can attach its optional per-line photos,
            // which need the ids the server assigns.
            const indentRes = await client.post('/indents', data);
            addToast('Indent raised successfully', 'success');
            setIsRaiseModalOpen(false);
            fetchIndents();
        // Hand the saved indent back so the form can attach its photos.
        return indentRes.data?.data ?? indentRes.data;
        } catch {
            addToast('Failed to raise indent', 'error');
        } finally {
            setIsCreatingIndent(false);
        }
    };

    // The modal is now mode-aware:
    //   - 'view'  → frozen indent items (the user's original request)
    //   - 'quote' → quotation items merged onto each indent line (procurement
    //               editable). Vendor allocation panel + Save/Finalise only
    //               render in this mode.
    const [modalMode, setModalMode] = useState<'view' | 'quote'>('view');

    // Builds the modal's local item state from an indent object based on the
    // active mode. Extracted so openModal (initial load) and
    // refreshSelectedIndent (post-save reload) can both hydrate without
    // duplicating logic. Keeps view vs quote behavior consistent.
    const hydrateItemsFor = (indent: any, mode: 'view' | 'quote') => {
        const indentItems = indent.items || [];
        if (mode === 'view') {
            const frozenItems = indentItems.map((it: any) => {
                const oq = it.originalQty != null ? Number(it.originalQty) : Number(it.qty);
                const op = it.originalUnitAmount != null ? Number(it.originalUnitAmount) : Number(it.unitAmount);
                return { ...it, qty: oq, unitAmount: op, total: oq * op };
            });
            return frozenItems;
        }
        const activeQuotation = (indent.quotations || []).find((q: any) => q.status === 'DRAFT' || q.status === 'SUBMITTED');
        return activeQuotation
            ? indentItems.map((it: any) => {
                const qLine = activeQuotation.items?.find((qi: any) => qi.indentItemId === it.id);
                return qLine
                    ? { ...it, qty: qLine.qty, unitAmount: qLine.unitAmount, total: qLine.total, _quotationLineId: qLine.id }
                    : it;
            })
            : indentItems;
    };

    const openModal = async (indent: any, mode: 'view' | 'quote') => {
        setSelectedIndent(indent);
        setModalMode(mode);
        const items = hydrateItemsFor(indent, mode);
        setIndentItems(items);
        setOriginalItems(items.map((i: any) => ({ ...i })));
        setIsViewModalOpen(true);
        // Always fetch allocations. The panel decides what to do with them
        // (editable while procurement owns the indent, read-only otherwise,
        // hidden entirely when there are no allocations + no edit access).
        // The previous guard cleared allocations whenever the indent left
        // APPROVED/QUOTATION_IN_PROGRESS, which made the saved vendor work
        // disappear from view the moment a bounce happened.
        try {
            const res = await client.get(`/indents/${indent.id}/allocations`);
            const rows = (res.data?.data || res.data)?.allocations || [];
            setAllocations(rows);
            setOriginalAllocations(rows);
        } catch { setAllocations([]); setOriginalAllocations([]); }
    };

    // Arriving from a notification (?openIndent=<id>): open that indent.
    // Notifications linked here for this role, but the page never read the
    // param, so the click landed on the list and left you to find the row.
    const [deepLinkParams, setDeepLinkParams] = useSearchParams();
    const deepLinkIndentId = deepLinkParams.get('openIndent');
    useEffect(() => {
        if (!deepLinkIndentId || !(!activeP.isLoading)) return;
        const row = activeP.items.find((r: any) => r?.id === deepLinkIndentId);
        const next = new URLSearchParams(deepLinkParams);
        next.delete('openIndent');
        setDeepLinkParams(next, { replace: true });
        if (row) { openModal(row, 'view'); return; }
        // Not an active indent. The history list is no longer loaded up front
        // (see historyP), so ask for this one indent rather than the archive.
        client.get(`/indents/${deepLinkIndentId}`)
            .then((res) => {
                const fresh = res.data?.data ?? res.data;
                if (fresh?.id) openModal(fresh, 'view');
                else addToast("That indent isn't in your lists any more.", 'info');
            })
            .catch(() => addToast("That indent isn't in your lists any more.", 'info'));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deepLinkIndentId, !activeP.isLoading]);

    // Re-fetch the currently-open indent from the server and reload the
    // modal's local state from the fresh data. Called after any successful
    // save (item edits, allocations, status transitions) so the modal never
    // shows stale numbers — which used to manifest as "values changing
    // after I save" because the parent list refreshed but the modal kept
    // its pre-save snapshot of `selectedIndent`.
    //
    // Returns the fresh indent so callers can branch on its new state
    // (e.g. status bounced back to PENDING for re-approval).
    const refreshSelectedIndent = async (): Promise<any | null> => {
        if (!selectedIndent?.id) return null;
        try {
            const res = await client.get(`/indents/${selectedIndent.id}`);
            const fresh = res.data?.data ?? res.data;
            if (!fresh) return null;
            setSelectedIndent(fresh);
            const items = hydrateItemsFor(fresh, modalMode);
            setIndentItems(items);
            setOriginalItems(items.map((i: any) => ({ ...i })));
            // Allocations are owned by the same backend state; pull them
            // fresh so the vendor panel reflects what was just committed.
            try {
                const allocRes = await client.get(`/indents/${fresh.id}/allocations`);
                const rows = (allocRes.data?.data || allocRes.data)?.allocations || [];
                setAllocations(rows);
                setOriginalAllocations(rows);
            } catch { setAllocations([]); setOriginalAllocations([]); }
            return fresh;
        } catch (e: any) {
            // Non-fatal: the parent's list refetch still ran. Surface a hint
            // so the user knows to close + reopen if the modal looks wrong.
            addToast(extractErrorMessage(e, 'Modal may show stale data — close + reopen to refresh.'), 'error');
            return null;
        }
    };

    // Advance a single vendor order's status from the BOM table. Patches the
    // one order, then refreshes the open modal (so its Status cell reflects the
    // new value) and the parent list (the row's rolled-up state may shift).
    const handleUpdateVendorOrderStatus = async (orderId: string, status: string) => {
        if (!selectedIndent?.id) return;
        try {
            await client.patch(`/indents/${selectedIndent.id}/vendor-orders/${orderId}/status`, { status });
            addToast('Vendor order status updated', 'success');
            await refreshSelectedIndent();
            activeP.refetch();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to update vendor order status'), 'error');
        }
    };

    const handleItemEdit = (itemId: string, field: string, val: any) => {
        // Optimistic local update. The actual write happens on saveChanges();
        // cancelling the modal restores the original snapshot.
        setIndentItems(prev => prev.map(item => {
            if (item.id === itemId) {
                const updated = { ...item, [field]: val };
                if (field === 'qty' || field === 'unitPrice' || field === 'unitAmount') {
                    const q = Number(updated.qty) || 0;
                    const p = Number(updated.unitPrice ?? updated.unitAmount) || 0;
                    updated.totalPrice = q * p;
                }
                return updated;
            }
            return item;
        }));
    };

    const cancelChanges = async () => {
        // Guard against accidental loss: if there are unsaved item OR vendor-
        // allocation edits, warn before closing instead of silently dropping
        // them. (Item edits and allocation edits both only persist on an
        // explicit Save Edits / Save Allocations / Finalise.)
        const dirty = computeDirtyItems().length > 0 || allocSig(allocations) !== allocSig(originalAllocations);
        if (dirty) {
            const discard = await confirm({
                title: 'Discard unsaved changes?',
                message: "You've made changes that aren't saved yet. Close without saving them?",
                confirmLabel: 'Discard changes',
                cancelLabel: 'Keep editing',
                tone: 'danger',
            });
            if (!discard) return; // stay open so they can Save
        }
        // Roll back any unsaved local edits to the snapshot taken on modal open.
        setIndentItems(originalItems);
        setAllocations(originalAllocations);
        setIsViewModalOpen(false);
    };

    // Compute which item rows have actually been edited compared to the
    // snapshot taken on modal-open. Used by both saveChanges and the
    // Finalise flow so the user can't accidentally lose their edits by
    // hitting Finalise without saving first.
    const computeDirtyItems = () => {
        const cur = (v: any) => String(v || 'INR').toUpperCase().trim();
        return indentItems.filter((i) => {
            const orig = originalItems.find((o) => o.id === i.id);
            if (!orig) return false;
            const qChanged = Number(orig.qty) !== Number(i.qty);
            const pChanged = Number(orig.unitAmount ?? orig.unitPrice ?? 0) !== Number(i.unitAmount ?? i.unitPrice ?? 0);
            const cChanged = cur(orig.currency) !== cur(i.currency);
            return qChanged || pChanged || cChanged;
        }).map((i) => ({
            id: i.id,
            qty: Number(i.qty),
            unitAmount: Number(i.unitPrice ?? i.unitAmount),
            currency: cur(i.currency),
        }));
    };
    const dirtyItems = computeDirtyItems();
    const hasDirtyItems = dirtyItems.length > 0;

    // Persists pending edits. Returns true on success, false on failure
    // (so callers — including the Finalise flow — can abort the next step).
    const persistItemEdits = async (): Promise<boolean> => {
        if (!selectedIndent || dirtyItems.length === 0) return true;
        setIsSavingItems(true);
        try {
            // Echo the version this edit was started from. The server refuses
            // (409) if someone else saved in the meantime, instead of letting
            // this write silently overwrite theirs.
            await client.patch(`/indents/${selectedIndent.id}`, {
                items: dirtyItems,
                expectedUpdatedAt: selectedIndent.updatedAt,
            });
            return true;
        } catch (e: any) {
            setIndentItems(originalItems);
            // A conflict is not a failure to save — it is someone else's work
            // being protected. Say which it was, and reload so the next attempt
            // starts from their version rather than repeating the collision.
            if (e?.response?.status === 409) {
                addToast(extractErrorMessage(e, 'Someone else changed this indent — reloading their version.'), 'error');
                await refreshSelectedIndent?.();
            } else {
                addToast(extractErrorMessage(e, 'Failed to save edits — your changes were reverted.'), 'error');
            }
            return false;
        } finally {
            setIsSavingItems(false);
        }
    };

    const saveChanges = async () => {
        if (!selectedIndent) { setIsViewModalOpen(false); return; }
        if (!hasDirtyItems) { setIsViewModalOpen(false); return; }
        const ok = await persistItemEdits();
        if (ok) {
            addToast('Changes saved', 'success');
            setIsViewModalOpen(false);
            fetchIndents();
        }
    };

    const addAllocationRow = (itemId: string, vendorName: string) => {
        const name = (vendorName || '').trim();
        if (!name) { addToast('Enter vendor name', 'error'); return; }
        const item = indentItems.find(i => i.id === itemId);
        if (!item) return;
        // Only COMMITTED rows consume the qty budget. Alternatives (vendor
        // OPTIONS the admin picks between at approval) are each a candidate for
        // the whole line, so they must NOT count as "allocated" — otherwise
        // marking one row as an option wrongly reports the line as fully
        // allocated and blocks adding a second option.
        const committed = allocations.filter(a => a.indentItemId === itemId && !a.isAlternative);
        const allocatedSoFar = committed.reduce((s: number, a: any) => s + Number(a.allocatedQty || 0), 0);
        const remaining = item.qty - allocatedSoFar;
        // When the committed split is already full (remaining <= 0), a new vendor
        // is a candidate for the SAME line — so default it to an OPTION, never a
        // silent extra buy. Options are excluded from the bought qty, so the
        // committed total stays == the requested quantity (nothing leaks to
        // "general stock"). Only when there's a real shortfall (remaining > 0)
        // does the new row commit to fill it (a genuine multi-vendor split).
        // To DELIBERATELY over-order, procurement unchecks "Option" on the row —
        // an explicit act that then drives the requester-vs-stock assignment slip.
        const fillsShortfall = remaining > 0;
        const defaultQty = fillsShortfall ? remaining : item.qty;
        setAllocations(prev => [...prev, { indentItemId: itemId, vendorName: name, allocatedQty: defaultQty, unitPrice: item.unitAmount, currency: item.currency || 'INR', unit: item.unit || '', url: '', notes: '', isAlternative: !fillsShortfall, _isNew: true }]);
    };

    const updateAllocation = (idx: number, field: string, value: any) => {
        setAllocations(prev => prev.map((a, i) => i === idx ? { ...a, [field]: value } : a));
    };

    const removeAllocation = (idx: number) => {
        setAllocations(prev => prev.filter((_, i) => i !== idx));
    };

    // GST is per vendor (name + currency = one order), so set the rate on EVERY
    // allocation row of that vendor at once — the backend groups by the same key
    // and applies the rate to the vendor's subtotal. Passing null clears it.
    // Names are compared trimmed on both sides: the panel groups vendors by the
    // trimmed name, so a row typed as "Robu " sat in the "Robu" group on screen
    // but was skipped here, and kept its old rate.
    const sameVendor = (a: any, vendorName: string, cur: string) =>
        String(a.vendorName || '').trim() === String(vendorName || '').trim()
        && String(a.currency || 'INR').toUpperCase().trim() === cur;
    const setVendorGst = (vendorName: string, currency: string, gstPercentage: number | null) => {
        const cur = String(currency || 'INR').toUpperCase().trim();
        setAllocations(prev => prev.map(a =>
            sameVendor(a, vendorName, cur)
                ? { ...a, gstPercentage }
                : a,
        ));
    };

    // Shipping is per vendor too — same rule as GST: every row of the vendor.
    const setVendorShipping = (vendorName: string, currency: string, shippingCost: number | null) => {
        const cur = String(currency || 'INR').toUpperCase().trim();
        setAllocations(prev => prev.map(a =>
            sameVendor(a, vendorName, cur)
                ? { ...a, shippingCost }
                : a,
        ));
    };

    const saveAllocations = async () => {
        if (!selectedIndent) return;
        // Persist any unsaved item edits FIRST. Without this, procurement can
        // type a new qty into an item cell, allocate vendors against the new
        // qty, and the save fails because the backend still sees the old qty.
        const ok = await persistItemEdits();
        if (!ok) return;

        // Validate the quote before it's committed (Save triggers the firm-price
        // Tech/CEO re-approval). Price is MANDATORY — every vendor line must have
        // a unit price > 0, hard block, no override. ETA + GST are a SOFT caution
        // (a genuinely-unknown ETA or a GST-exempt/0 vendor is legit, so those
        // can be acknowledged past).
        // Every row is sent, so every row is checked. This used to look only at
        // rows with a vendor name, so a row whose name had been cleared, or a
        // main row at qty 0, sailed through to a 400 from the server.
        const unnamed = allocations.filter(a => !String(a.vendorName || '').trim());
        if (unnamed.length) {
            addToast(`${unnamed.length} vendor row${unnamed.length === 1 ? ' has' : 's have'} no vendor name — fill it in or remove the row.`, 'error');
            return;
        }
        const zeroQty = allocations.filter(a => a.isAlternative !== true && !(Number(a.allocatedQty) > 0));
        if (zeroQty.length) {
            addToast(`Quantity must be more than 0 on every vendor row — ${zeroQty.length} ${zeroQty.length === 1 ? 'is' : 'are'} empty or 0.`, 'error');
            return;
        }
        const named = allocations;
        if (named.length) {
            const noPrice = named.filter(a => !(Number(a.unitPrice) > 0));
            if (noPrice.length) {
                addToast(
                    `Unit price is required for every vendor — ${noPrice.length} line${noPrice.length === 1 ? ' is' : 's are'} still ₹0. Enter a price before saving.`,
                    'error',
                );
                return;
            }
            // ETA in the past is a hard block (not a soft gap) — a quoted
            // delivery date before today is nonsensical + reads as instantly
            // overdue on the tracker. Server enforces this too.
            const todayISO = new Date().toLocaleDateString('en-CA');
            const pastEta = named.filter(a => a.quotedEtaDate && String(a.quotedEtaDate).slice(0, 10) < todayISO);
            if (pastEta.length) {
                addToast(
                    `ETA can't be before today — ${pastEta.length} vendor line${pastEta.length === 1 ? ' has' : 's have'} a past delivery date. Fix it before saving.`,
                    'error',
                );
                return;
            }
            // Vendor URL (optional) must be a real http(s) link when present —
            // matches the backend guard so a bad link fails fast, not on a 400.
            const badUrl = named.filter(a => {
                const u = String(a.url ?? '').trim();
                return u && !/^https?:\/\/[^\s]+$/i.test(u);
            });
            if (badUrl.length) {
                addToast(
                    `${badUrl.length} vendor URL${badUrl.length === 1 ? ' is' : 's are'} invalid — links must start with http:// or https://.`,
                    'error',
                );
                return;
            }
            // No two vendor lines may share the same product URL (each vendor's
            // link is its own). Scoped to the allocation table only.
            const urlDup = new Map<string, string>();
            for (const a of named) {
                const u = String(a.url ?? '').trim().toLowerCase();
                if (!u) continue;
                if (urlDup.has(u)) {
                    addToast(`Two vendor lines share the same product URL (${urlDup.get(u)} and ${a.vendorName}). Each vendor needs its own link.`, 'error');
                    return;
                }
                urlDup.set(u, a.vendorName);
            }
            const gaps: string[] = [];
            const noEta = named.filter(a => !a.quotedEtaDate).length;
            const vendorsNoGst = new Set(
                named.filter(a => !(Number(a.gstPercentage) > 0)).map(a => String(a.vendorName).trim()),
            );
            if (noEta) gaps.push(`${noEta} vendor line${noEta === 1 ? '' : 's'} with no ETA`);
            if (vendorsNoGst.size) gaps.push(`${vendorsNoGst.size} vendor${vendorsNoGst.size === 1 ? '' : 's'} with no GST %`);
            if (gaps.length) {
                const proceed = await confirm({
                    title: 'Finalise quote with gaps?',
                    message: `This quote has:\n\n• ${gaps.join('\n• ')}\n\nThat's usually a missed field. Save the quote anyway?`,
                    confirmLabel: 'Save anyway',
                    cancelLabel: 'Go back & fix',
                    tone: 'danger',
                });
                if (!proceed) return;
            }
        }

        try {
            const payload = allocations.map(a => {
                // Options are candidates for the whole line, so a blank/zero qty
                // on an alternative row means "the full line qty" — normalise it
                // rather than letting it fail the backend's allocatedQty ≥ 1 rule.
                let qty = Number(a.allocatedQty);
                if (a.isAlternative === true && (!Number.isFinite(qty) || qty <= 0)) {
                    qty = Number(indentItems.find(i => i.id === a.indentItemId)?.qty) || qty;
                }
                return { indentItemId: a.indentItemId, vendorName: a.vendorName, allocatedQty: qty, unitPrice: Number(a.unitPrice) || undefined, gstPercentage: (a.gstPercentage != null && a.gstPercentage !== '' && Number.isFinite(Number(a.gstPercentage))) ? Number(a.gstPercentage) : undefined, shippingCost: (a.shippingCost != null && a.shippingCost !== '' && Number(a.shippingCost) > 0) ? Number(a.shippingCost) : undefined, isAlternative: a.isAlternative === true, quotedEtaDate: a.quotedEtaDate || undefined, quotedEtaHasTime: a.quotedEtaHasTime === true, currency: String(a.currency || 'INR').toUpperCase().trim(), unit: String(a.unit ?? '').trim() || undefined, url: String(a.url ?? '').trim() || undefined, notes: String(a.notes ?? '').trim() || undefined };
            });
            await client.post(`/indents/${selectedIndent.id}/allocations`, { allocations: payload });
            addToast('Vendor allocations saved', 'success');
            // Refresh the OPEN modal from server before refetching the list.
            // Order matters: the modal-level refresh fixes the user-visible
            // "values changing after submit" bug because it rebuilds
            // indentItems + allocations + selectedIndent.grandTotal from the
            // freshly-committed state — instead of relying on the list
            // refetch which only updates the row in the parent table.
            await refreshSelectedIndent();
            fetchIndents();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to save allocations'), 'error');
        }
    };

    const indentFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'indentNo',   getValue: (r) => r.serialNo },
        { key: 'date',       getValue: (r) => dateOnlyKey(r.createdAt) },
        // Department and Project used to sit here. Both are on the indent slip
        // itself, so the list was spending two of its widest columns repeating
        // what one click already shows — while the thing procurement actually
        // scans for, WHO IS SUPPLYING IT, was not on the table at all.
        //
        // An array, not a joined string: an indent split across three vendors
        // must be findable by any one of them. Picking "Acme" on a joined
        // "Acme, Bolt" row would match nothing.
        { key: 'vendor',     getValue: (r) => { const v = vendorNamesOf(r); return v.length ? v : null; } },
        { key: 'amount',     getValue: (r) => `${r.currency} ${r.grandTotal?.toLocaleString() ?? ''}` },
        { key: 'tech',       getValue: (r) => r.techApprovalStatus || 'PENDING' },
        { key: 'ceo',        getValue: (r) => (ceoLaneVisible(r) ? (r.ceoApprovalStatus || 'PENDING') : 'N/A') },
        { key: 'payment',    getValue: (r) => r.paymentTransactionId || (r.status === 'AWAITING_PAYMENT' ? 'Awaiting Finance' : '') },
        { key: 'procStatus', getValue: (r) => r.status },
    ], []);

    const activeF = usePagedFilters(indents, indentFilterSpecs, 10, activeP.search);
    const historyF = usePagedFilters(pastIndents, indentFilterSpecs, 10, historyP.search);

    const buildColumns = (f: ReturnType<typeof useTableFilters<any>>) => [
        { filterActive: f.isActive('indentNo'),   header: <span className="inline-flex items-center">Indent Number<ColumnFilter searchable options={f.getOptions('indentNo')}   value={f.filters.indentNo   || ''} onChange={(v) => f.setFilter('indentNo', v)}   /></span>, accessor: (row: any) => {
            const backorderForReq = row.backorderForRequests?.[0]?.serialNo;
            return (
              <div className="flex flex-col items-start gap-0.5">
                <span className="font-bold text-ink">{row.serialNo || row.id.split('-')[0]}</span>
                {row.emergency && (
                  <span title={row.emergencyReason || ''}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-red-100 dark:bg-red-400/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-400/30">
                    ⚡ EMERGENCY
                  </span>
                )}
                {row.emergency && row.emergencyReason && (
                  <span className="text-[10px] text-red-700 dark:text-red-300 italic max-w-[220px] block" title={row.emergencyReason}>
                    {row.emergencyReason.length > 50 ? row.emergencyReason.slice(0, 50) + '…' : row.emergencyReason}
                  </span>
                )}
                {row.isAutoRaised && (
                  <span title={backorderForReq ? `Auto-raised by inventory to cover shortfall on request ${backorderForReq}` : 'Auto-raised back-order indent'}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-violet-100 dark:bg-violet-400/20 text-violet-700 dark:text-violet-300 border border-violet-200 dark:border-violet-400/30">
                    🔄 BACK-ORDER{backorderForReq ? ` · ${backorderForReq}` : ''}
                  </span>
                )}
                {/* BOM provenance — every indent that came out of a BOM submit
                    carries `bomListId` + the bomList relation. Surfaces here
                    so procurement immediately sees "this isn't a one-off
                    indent, it's the out-of-stock + custom portion of BOM-005
                    with N other lines the user is also tracking". */}
                {row.bomListId && row.bomList?.serialNo && (
                  <span title={`Bundled from BOM ${row.bomList.serialNo}${row.bomList.name ? ` — ${row.bomList.name}` : ''}. Out-of-stock + custom lines from that BOM.`}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-400/30">
                    📋 from {row.bomList.serialNo}
                  </span>
                )}
              </div>
            );
        } },
        { filterActive: f.isActive('date'),       header: <span className="inline-flex items-center">Request Date<ColumnFilter searchable options={f.getOptions('date')}      value={f.filters.date       || ''} onChange={(v) => f.setFilter('date', v)}       /></span>, accessor: (row: any) => row?.createdAt ? <span className="text-xs">{new Date(row.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span> : 'N/A' },
        { filterActive: f.isActive('vendor'),     header: <span className="inline-flex items-center">Vendor<ColumnFilter searchable options={f.getOptions('vendor')}            value={f.filters.vendor     || ''} onChange={(v) => f.setFilter('vendor', v)}     /></span>, accessor: (row: any) => {
            const names = vendorNamesOf(row);
            if (names.length === 0) {
                // Before a quotation there is genuinely no vendor yet. Say that,
                // rather than a bare dash that reads like missing data.
                return <span className="italic text-faint text-xs">Not quoted yet</span>;
            }
            return (
                <span className="text-xs" title={names.join(', ')}>
                    {names[0]}
                    {names.length > 1 && (
                        <span className="ml-1 text-[10px] font-bold text-brand">+{names.length - 1}</span>
                    )}
                </span>
            );
        } },
        { filterActive: f.isActive('amount'),     header: <span className="inline-flex items-center">Amount<ColumnFilter searchable options={f.getOptions('amount')}            value={f.filters.amount     || ''} onChange={(v) => f.setFilter('amount', v)}     /></span>, accessor: (row: any) => <span className="text-xs font-bold">{row.currency} {row.grandTotal?.toLocaleString()}</span> },
        { filterActive: f.isActive('tech'),       header: <span className="inline-flex items-center">Tech Approval<ColumnFilter options={f.getOptions('tech')}                    value={f.filters.tech       || ''} onChange={(v) => f.setFilter('tech', v)}       /></span>, accessor: (row: any) => {
            // Same stale-check the modal uses — if procurement re-quoted at a
            // different price, the original APPROVED stamp is no longer valid.
            // Showing it raw was misleading the table (modal said "Stale" but
            // table said "APPROVED" for the same indent).
            const current = Number(row.grandTotal || 0);
            const snapshot = row.techApprovedAtAmount;
            const techStale = row.techApprovalStatus === 'APPROVED'
                && snapshot != null
                && Math.abs(Number(snapshot) - current) > 0.005;
            if (techStale) {
                return (
                    <div className="flex flex-col items-start gap-0.5">
                        <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-400/30">Stale</span>
                        <span className="text-[10px] text-muted" title={`Originally approved at ₹${Number(snapshot).toLocaleString()}. Needs re-approval at firm ₹${current.toLocaleString()}.`}>was ₹{Number(snapshot).toLocaleString()}</span>
                    </div>
                );
            }
            return <ApprovalCell status={row.techApprovalStatus || 'PENDING'} timestamp={row.techApprovedAt} approverName={row.techApprovedBy?.name} />;
        }},
        { filterActive: f.isActive('ceo'),        header: <span className="inline-flex items-center">CEO Approval<ColumnFilter options={f.getOptions('ceo')}                      value={f.filters.ceo        || ''} onChange={(v) => f.setFilter('ceo', v)}        /></span>, accessor: (row: any) => {
            const total = Number(row.grandTotal || 0);
            // Column visibility is the amount test alone (ceoLaneVisible) — the
            // CEO lane is still shown and still actionable while their sign-off
            // is optional; only the "is anyone waiting?" signals below go quiet.
            if (!ceoLaneVisible(row)) return <span className="text-[10px] text-faint" title={ceoNotApplicableTitle()}>{ceoNotApplicableLabel()}</span>;
            const realSignOff = !!row.ceoApprovedById;
            // Crosses threshold but never had a real CEO sign-off (auto-stamp
            // when raised under threshold + now over at firm quote).
            if (!realSignOff) {
                return (
                    <div className="flex flex-col items-start gap-0.5">
                        <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-400/30">Pending CEO</span>
                        <span className="text-[10px] text-muted">at firm ₹{total.toLocaleString()}</span>
                    </div>
                );
            }
            // Has a real sign-off but at a different amount → stale.
            const snapshot = row.ceoApprovedAtAmount;
            const ceoStale = row.ceoApprovalStatus === 'APPROVED'
                && snapshot != null
                && Math.abs(Number(snapshot) - total) > 0.005;
            if (ceoStale) {
                return (
                    <div className="flex flex-col items-start gap-0.5">
                        <span className="inline-block text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-400/30">Stale</span>
                        <span className="text-[10px] text-muted" title={`CEO approved at ₹${Number(snapshot).toLocaleString()}. Needs re-approval at firm ₹${total.toLocaleString()}.`}>was ₹{Number(snapshot).toLocaleString()}</span>
                    </div>
                );
            }
            return <ApprovalCell status={row.ceoApprovalStatus || 'PENDING'} timestamp={row.ceoApprovedAt} approverName={row.ceoApprovedBy?.name} />;
        }},
        { filterActive: f.isActive('payment'),    header: <span className="inline-flex items-center">Payment<ColumnFilter searchable options={f.getOptions('payment')}          value={f.filters.payment    || ''} onChange={(v) => f.setFilter('payment', v)}    /></span>, accessor: (row: any) => {
            if (row.paymentTransactionId) {
              return (
                <div className="flex flex-col items-start gap-0.5">
                  <span className="text-[10px] font-mono text-ink">{row.paymentTransactionId}</span>
                  {row.paidBy?.name && <span className="text-[10px] text-muted">by {row.paidBy.name}</span>}
                  {row.paidAt && <span className="text-[10px] text-faint">{new Date(row.paidAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
                  {row.paymentReceiptPath && <ViewReceiptLink indentId={row.id} />}
                </div>
              );
            }
            if (row.status === 'AWAITING_PAYMENT') return <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-400/30">Awaiting Finance</span>;
            return <span className="text-[10px] text-faint">—</span>;
        }},
        { header: 'Reminder', accessor: (row: any) => {
            if (row.status !== 'PENDING') return <span className="text-[10px] text-faint">-</span>;
            const tech = row.techApprovalStatus || 'PENDING';
            const ceo = row.ceoApprovalStatus || 'PENDING';
            const needsCeo = needsCeoSignoff(row);
            if (tech === 'PENDING') return <button disabled={isReminding(row.id, 'tech')} onClick={() => handleRemind(row.id, 'tech')} className="text-xs bg-orange-700 text-white px-2 py-1 rounded font-bold hover:bg-orange-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">{isReminding(row.id, 'tech') ? 'Reminding…' : 'Remind Admin'}</button>;
            if (needsCeo && ceo === 'PENDING') return <button disabled={isReminding(row.id, 'ceo')} onClick={() => handleRemind(row.id, 'ceo')} className="text-xs bg-orange-700 text-white px-2 py-1 rounded font-bold hover:bg-orange-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed">{isReminding(row.id, 'ceo') ? 'Reminding…' : 'Remind CEO'}</button>;
            return <span className="text-[10px] text-green-700 dark:text-green-300 font-bold">All Approved</span>;
        }},
        { filterActive: f.isActive('procStatus'), header: <span className="inline-flex items-center">Proc. Status<ColumnFilter options={f.getOptions('procStatus')}                value={f.filters.procStatus || ''} onChange={(v) => f.setFilter('procStatus', v)} /></span>, accessor: (row: any) => {
            // Soft-deleted (user-withdrawn) indents surface only in History —
            // the active fetch never sends includeDeleted. Freeze the status as
            // a read-only badge + "Deleted" tag and short-circuit BEFORE the
            // EditableCell dropdown, so a dead row can't be transitioned,
            // cancelled, or sent-to-finance from the audit view.
            if (row.deletedAt) {
                return (
                    <div className="flex flex-col items-start gap-1">
                        <StatusBadge status={row.status} />
                        <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold rounded-md ring-1 ring-inset bg-red-100 dark:bg-red-400/20 text-red-700 dark:text-red-300 ring-red-600/30 dark:ring-red-400/30">
                            Deleted
                        </span>
                    </div>
                );
            }
            if (row.status === 'PENDING') {
                const needsCeo = needsCeoSignoff(row);
                if (row.techApprovalStatus === 'APPROVED' && needsCeo && row.ceoApprovalStatus === 'PENDING') {
                    return <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-orange-100 dark:bg-orange-400/20 text-orange-800 dark:text-orange-200 border border-orange-200 dark:border-orange-400/30">Awaiting CEO Approval</span>;
                }
                return <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-yellow-100 dark:bg-yellow-400/20 text-yellow-800 dark:text-yellow-200 border border-yellow-200 dark:border-yellow-400/30">Awaiting Tech Approval</span>;
            }
            if (row.status === 'READY_FOR_PAYMENT') {
                return <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-400/20 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-400/30">Ready — pick payment method</span>;
            }
            if (row.status === 'AWAITING_PAYMENT') {
                return <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-400/30">Awaiting Finance to Pay</span>;
            }
            
            // Per-status forward transitions only — no going back. Mirrors
            // the backend's ALLOWED_TRANSITIONS so the UI doesn't offer a
            // state change the server would reject. Each branch shows the
            // current state first (so the cell displays a friendly label)
            // followed by the *next* states procurement can actually move
            // to.
            const options: { value: string; label: string }[] = [];
            if (row.status === 'QUOTATION_IN_PROGRESS') {
                options.push({ value: 'QUOTATION_IN_PROGRESS', label: 'Quoting...' });
                options.push({ value: 'CANCELLED', label: 'Cancelled' });
            } else if (row.status === 'APPROVED') {
                options.push({ value: 'APPROVED', label: 'Approved (Ready)' });
                options.push({ value: 'CANCELLED', label: 'Cancelled' });
            } else if (row.status === 'PAYMENT_DONE') {
                options.push({ value: 'PAYMENT_DONE', label: 'Paid · Place order next' });
                options.push({ value: 'ORDERED', label: 'Mark as Ordered' });
                options.push({ value: 'CANCELLED', label: 'Cancelled' });
            } else if (row.status === 'ORDERED') {
                options.push({ value: 'ORDERED', label: 'Ordered — awaiting shipment' });
                options.push({ value: 'IN_TRANSIT', label: 'Mark In Transit' });
                options.push({ value: 'RECEIVED', label: 'Mark Received' });
                options.push({ value: 'CANCELLED', label: 'Cancelled' });
            } else if (row.status === 'IN_TRANSIT') {
                options.push({ value: 'IN_TRANSIT', label: 'In Transit' });
                options.push({ value: 'RECEIVED', label: 'Mark Received' });
                options.push({ value: 'CANCELLED', label: 'Cancelled' });
            } else if (row.status === 'PARTIALLY_RECEIVED') {
                // Some vendors delivered, others still in transit. The clerk's
                // per-vendor receive flips it to RECEIVED once the last shipment
                // lands; procurement can also force-complete or cancel the rest.
                options.push({ value: 'PARTIALLY_RECEIVED', label: 'Partly received — awaiting rest' });
                options.push({ value: 'RECEIVED', label: 'Mark Fully Received' });
                options.push({ value: 'CANCELLED', label: 'Cancelled' });
            } else if (row.status === 'RECEIVED') {
                options.push({ value: 'RECEIVED', label: 'Received · complete' });
            } else if (row.status === 'CANCELLED') {
                options.push({ value: 'CANCELLED', label: 'Cancelled' });
            } else if (row.status === 'REJECTED') {
                options.push({ value: 'REJECTED', label: 'Rejected' });
            } else {
                // Defensive fallback for any unforeseen status — display the
                // raw value so the cell isn't blank. No transitions offered
                // since we don't know what's valid.
                options.push({ value: row.status, label: row.status });
            }

            return (
                <div className="flex flex-col items-start gap-1">
                    <EditableCell type="select" value={row?.status || 'APPROVED'}
                        options={options}
                        // Intercept choices that need structured input:
                        //   - Cancelled (with refund tracking)
                        //   - Ordered (with expected delivery date)
                        // Everything else falls through to the direct PATCH.
                        onSave={(val) => {
                            if (val === 'CANCELLED' && row.status !== 'CANCELLED') {
                                setCancelRow(row);
                                return;
                            }
                            if (val === 'ORDERED' && row.status !== 'ORDERED') {
                                setOrderedRow(row);
                                setOrderedMode('mark_ordered');
                                return;
                            }
                            handleUpdateStatus(row.id, 'status', val);
                        }} className="w-32" />
                    <RefundStatusBadge
                        status={row.refundStatus}
                        paidAmount={row.grandTotal}
                        receivedAmount={row.refundReceivedAmount}
                        currency={row.currency || 'INR'}
                    />
                </div>
            );
        }},
        { header: 'Actions', accessor: (row: any) => {
            const canQuote = ['APPROVED', 'QUOTATION_IN_PROGRESS'].includes(row.status);
            // A re-quote = the latest quotation is version >= 2 (a prior quote
            // was rejected and bounced back). Version-based, not length-based:
            // the lazy v1 DRAFT created when procurement first opens an indent
            // would make `length > 0` true and mislabel the first quote.
            const latestQuote = Array.isArray(row.quotations) ? row.quotations[0] : null;
            const isRequote = !!latestQuote && Number(latestQuote.version) >= 2;
            const quoteLabel = isRequote ? 'Requote' : 'Quote';
            // Firm quote re-approved → procurement picks payment method
            // + hands off to Finance. This is the new READY_FOR_PAYMENT
            // step — the indent stays with procurement until they click.
            // Lines still awaiting their first hand-off to Finance (no vendor
            // order yet). On a fresh READY_FOR_PAYMENT indent that's every line;
            // after a partial send it's the leftovers that held the indent at
            // AWAITING_PAYMENT — those can still be sent ("send the rest").
            const unsentLineCount = (Array.isArray(row.vendorAllocations) ? row.vendorAllocations : [])
                .filter((a: any) => !a.vendorOrderId).length;
            const canSendToFinance = row.status === 'READY_FOR_PAYMENT'
                || (row.status === 'AWAITING_PAYMENT' && unsentLineCount > 0);
            const sendIsRemainder = row.status === 'AWAITING_PAYMENT';
            // Re-quote: a vendor's stock can run out while the file sits in the
            // approval/payment gap. Procurement can pull it back to re-quote any
            // time before payment is actually made (READY_FOR_PAYMENT or, even
            // after handoff, AWAITING_PAYMENT). Once PAYMENT_DONE, the button is
            // gone — money has moved.
            const canReopen = ['READY_FOR_PAYMENT', 'AWAITING_PAYMENT'].includes(row.status);
            return (
                <div className="flex gap-1.5 flex-wrap">
                    <button onClick={() => openModal(row, 'view')}
                        className="text-sm bg-hover border border-line text-ink px-3 py-1 rounded-md font-bold hover:bg-line transition-colors shadow-sm">View</button>
                    <button onClick={(e) => { e.stopPropagation(); setTrackIndent(row); }}
                        title="View timeline — see who acted when, and where it stalled"
                        className="text-sm bg-card border border-brand text-brand px-3 py-1 rounded-md font-bold hover:bg-brand/10 transition-colors shadow-sm">Track</button>
                    {canQuote && (
                        <button onClick={() => openModal(row, 'quote')}
                            title={isRequote ? 'A previous quotation was rejected — open to re-quote. Finalising re-runs Tech/CEO approval at the new firm price.' : 'Start a new quotation'}
                            className="text-sm bg-brand text-white px-3 py-1 rounded-full font-bold hover:bg-brand-dark transition-colors shadow-sm">{quoteLabel}</button>
                    )}
                    {canSendToFinance && (
                        <button onClick={() => setSendToFinanceRow(row)}
                            title={sendIsRemainder
                                ? `${unsentLineCount} line(s) not yet sent — hand the rest (or a subset) to Finance.`
                                : 'Approvals cleared. Pick which items + payment method, then send to Finance to pay.'}
                            className="text-sm bg-emerald-700 text-white px-3 py-1 rounded-md font-bold hover:bg-emerald-800 transition-colors shadow-sm">
                            {sendIsRemainder ? `Send remaining (${unsentLineCount}) →` : 'Send to Finance →'}
                        </button>
                    )}
                    {canReopen && (
                        <button onClick={(e) => { e.stopPropagation(); setReopenRow(row); setReopenReason(''); }}
                            title={row.status === 'AWAITING_PAYMENT'
                                ? 'Vendor stock ran out? Pull this back from Finance to re-quote (only before payment).'
                                : 'Vendor stock ran out? Reopen to re-quote before sending to Finance.'}
                            className="text-sm bg-card border border-orange-400 text-orange-700 dark:text-orange-300 px-3 py-1 rounded-md font-bold hover:bg-orange-50 dark:bg-orange-400/15 transition-colors shadow-sm">
                            Re-quote
                        </button>
                    )}
                    {/* Update-refund button — surfaces only while there's
                        something to update (PENDING/DISPUTED). RECEIVED +
                        WRITE_OFF are terminal so we hide the button. */}
                    {['PENDING', 'DISPUTED'].includes(row.refundStatus || '') && (
                        <button onClick={(e) => { e.stopPropagation(); setRefundRow(row); }}
                            title="Update refund status (mark received, dispute, write off)"
                            className="text-sm bg-card border border-amber-400 text-amber-700 dark:text-amber-300 px-3 py-1 rounded-md font-bold hover:bg-amber-50 dark:bg-amber-400/15 transition-colors shadow-sm">
                            Update refund
                        </button>
                    )}
                    {/* Update-ETA button — surfaces on rows already at
                        ORDERED or IN_TRANSIT so procurement can revise
                        the delivery date when the vendor moves their
                        timeline. The first ETA is captured during the
                        Mark-as-Ordered modal; this button is for revisions. */}
                    {['ORDERED', 'IN_TRANSIT'].includes(row.status) && (
                        <button onClick={(e) => { e.stopPropagation(); setOrderedRow(row); setOrderedMode('update_eta'); }}
                            title={row.expectedDeliveryDate ? `Current ETA: ${new Date(row.expectedDeliveryDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. Click to revise.` : 'Set expected delivery date'}
                            className="text-sm bg-card border border-sky-300 dark:border-sky-400/30 text-sky-700 dark:text-sky-300 px-3 py-1 rounded-md font-bold hover:bg-sky-50 dark:bg-sky-400/15 transition-colors shadow-sm">
                            {row.expectedDeliveryDate ? 'Update ETA' : 'Set ETA'}
                        </button>
                    )}
                    {/* Customs — once goods are moving: the whole indent in
                        transit, or any line in transit / at customs (one vendor
                        can be at customs while another hasn't shipped). Same
                        rule as the backend's customsApplicable. */}
                    {(row.status === 'IN_TRANSIT'
                      || (['ORDERED', 'PARTIALLY_RECEIVED'].includes(row.status)
                        && (row.vendorAllocations ?? []).some((a: any) => a?.shipmentStage === 'IN_TRANSIT' || a?.shipmentStage === 'CUSTOMS'))) && (
                        <button onClick={(e) => { e.stopPropagation(); setCustomsRow(row); }}
                            title="Record customs clearance"
                            className="text-sm bg-card border border-violet-300 dark:border-violet-400/30 text-violet-700 dark:text-violet-300 px-3 py-1 rounded-md font-bold hover:bg-violet-50 dark:bg-violet-400/15 transition-colors shadow-sm">
                            Customs
                        </button>
                    )}
                    {/* Per-line shipment tracker — only for indents split across
                        vendors and still live with them. Marks each line's stage
                        (In transit / Customs / Reached) + its own ETA, independent
                        of the others (the per-indent ETA button above moves the
                        whole-indent date). */}
                    {['ORDERED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(row.status) && (row.vendorAllocations?.length || 0) > 0 && (
                        <button onClick={(e) => { e.stopPropagation(); setShipmentRow(row); }}
                            title="Track each line's stage (In transit / Customs / Reached) and ETA"
                            className="text-sm bg-card border border-teal-300 dark:border-teal-400/30 text-teal-700 dark:text-teal-300 px-3 py-1 rounded-md font-bold hover:bg-teal-50 dark:bg-teal-400/15 transition-colors shadow-sm">
                            Shipments
                        </button>
                    )}
                </div>
            );
        }}
    ];

    const activeCols = buildColumns(activeF);
    const historyCols = buildColumns(historyF);

    return (
        <div className="space-y-4 md:space-y-6">
            <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold tracking-tight font-bold text-ink">Indents Management</h2>
                <div className="flex gap-4">
                    <button onClick={() => setIsHistoryModalOpen(true)}
                        className="bg-ink text-card px-4 py-2 font-bold rounded-md hover:bg-black transition-colors shadow-sm">History</button>
                    <button onClick={() => setIsRaiseModalOpen(true)}
                        className="bg-brand text-white px-4 py-2 font-bold rounded-full hover:bg-brand-dark transition-colors shadow-sm">Raise Indent</button>
                </div>
            </div>

            {/* Server-side search across the WHOLE indent set (serial / item /
                requester), not just the loaded page. Broadcasts to the active
                queue and the History modal so both find matches on any page.
                Column filters below still refine within the current page. */}
            <div className="max-w-xs">
                <SearchInput
                    value={activeP.search}
                    onChange={(e) => { const v = e.target.value; activeP.setSearch(v); historyP.setSearch(v); }}
                    placeholder="Search all indents…"
                />
            </div>

            {fetchError && (
                <div className="bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 rounded-md p-3 flex items-center justify-between gap-3">
                    <div className="text-xs text-red-900 dark:text-red-200">
                        <span className="font-bold">Couldn't load indents.</span>{' '}
                        <span className="text-red-800/80 dark:text-red-300">{fetchError}</span>
                        <p className="mt-0.5 text-[10px] text-red-700/80 dark:text-red-300">
                            The table below may not reflect what's actually in the system. Try again, or check your connection.
                        </p>
                    </div>
                    <button onClick={fetchIndents}
                        className="text-xs font-bold bg-red-600 text-white px-3 py-1.5 rounded hover:bg-red-700 transition-colors whitespace-nowrap">
                        Retry
                    </button>
                </div>
            )}

            {/* BOM lens — three VIEWS over the same queue, not forked pipelines.
                "From BOM" matches the emerald provenance chip on the rows;
                "Regular" is its inverse (hand-raised); "All indents" is default. */}
            <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted">View</span>
                <div className="inline-flex rounded-lg border border-line bg-card p-0.5 shadow-sm">
                    <button
                        onClick={() => setBomView('all')}
                        className={`px-3 py-1 text-xs font-bold rounded-md transition-colors ${bomView === 'all' ? 'bg-ink text-card shadow-sm' : 'text-muted hover:bg-hover'}`}
                    >
                        All indents
                    </button>
                    <button
                        onClick={() => setBomView('regular')}
                        title="Show only hand-raised indents (not spawned from a BOM)"
                        className={`px-3 py-1 text-xs font-bold rounded-md transition-colors ${bomView === 'regular' ? 'bg-ink text-card shadow-sm' : 'text-muted hover:bg-hover'}`}
                    >
                        Regular
                    </button>
                    <button
                        onClick={() => setBomView('bom')}
                        title="Show only indents that came from a BOM (its out-of-stock + custom lines, bundled when the BOM was approved)"
                        className={`px-3 py-1 text-xs font-bold rounded-md transition-colors inline-flex items-center gap-1 ${bomView === 'bom' ? 'bg-emerald-700 text-ink shadow-sm' : 'text-muted hover:bg-hover'}`}
                    >
                        📋 From BOM
                    </button>
                </div>
                {bomView === 'bom' && (
                    <span className="text-[11px] font-medium text-emerald-700 dark:text-emerald-300">Showing BOM-spawned indents only</span>
                )}
                {bomView === 'regular' && (
                    <span className="text-[11px] font-medium text-muted">Showing hand-raised indents only</span>
                )}
            </div>

            <div className="bg-card rounded-xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-zebra overflow-hidden">
                <div className="p-0">
                    <DataTable
                        columns={activeCols}
                        data={activeF.pageRows}
                        isLoading={isLoading}
                        keyExtractor={r => r.id}
                        emptyStateMessage={bomView === 'bom' ? 'No active BOM-spawned indents.' : bomView === 'regular' ? 'No active hand-raised indents.' : 'No active indents.'}
                    />
                    <div className="px-4 pb-2">
                        <Pagination currentPage={activeF.page} totalPages={activeF.totalPages} onPageChange={activeF.setPage} />
                    </div>
                </div>
            </div>

            <IndentTrackModal indent={trackIndent} onClose={() => setTrackIndent(null)} />

            {/* Send-to-Finance modal — captures payment method + optional
                banking notes, then transitions READY_FOR_PAYMENT → AWAITING_PAYMENT. */}
            <SendToFinanceModal
                row={sendToFinanceRow}
                onClose={() => setSendToFinanceRow(null)}
                onSent={fetchIndents}
            />

            <IndentDetailsModal
                isOpen={isViewModalOpen}
                onClose={cancelChanges}
                selectedIndent={selectedIndent}
                indentItems={indentItems}
                onItemEdit={handleItemEdit}
                onSaveChanges={saveChanges}
                isSavingItems={isSavingItems}
                allocations={allocations}
                knownVendors={knownVendors}
                onSaveVendorToList={saveVendorToList}
                onAddAllocationRow={addAllocationRow}
                onUpdateAllocation={updateAllocation}
                onSetVendorGst={setVendorGst}
                onSetVendorShipping={setVendorShipping}
                onRemoveAllocation={removeAllocation}
                onSaveAllocations={saveAllocations}
                hasDirtyItems={hasDirtyItems}
                onUpdateVendorOrderStatus={handleUpdateVendorOrderStatus}
                onMarkVendorOrderOrdered={() => { setOrderedRow(selectedIndent); setOrderedMode('mark_ordered'); }}
                canUpdateVendorOrderStatus={canUpdateVendorOrderStatus}
                onTrackShipment={() => setShipmentRow(selectedIndent)}
                mode={modalMode}
                onFinalizeQuotation={async () => {
                   const ok = await persistItemEdits();
                   if (!ok) return;

                   // Compare allocations against the ORIGINAL request (what
                   // the user asked for, frozen). Items can be short, over,
                   // or matching. Short → needs reason. Over → needs split
                   // decision (how much for the requester vs general stock).
                   const shortfalls: any[] = [];
                   const overages: any[] = [];
                   for (const it of indentItems || []) {
                       const allocated = allocations
                           // Committed rows only — vendor OPTIONS (alternatives)
                           // are full-line candidates the admin picks later, so
                           // they must not count toward the shortfall/overage
                           // check (else an option inflates "allocated").
                           .filter(a => a.indentItemId === it.id && !a.isAlternative)
                           .reduce((s, a) => s + Number(a.allocatedQty || 0), 0);
                       const requested = Number(it.originalQty ?? it.qty);
                       const diff = allocated - requested;
                       const row = { itemId: it.id, name: it.name, requested, allocated, unit: it.unit };
                       if (diff < 0) shortfalls.push({ ...row, short: -diff });
                       else if (diff > 0) overages.push({ ...row, over: diff });
                   }
                   if (shortfalls.length > 0 || overages.length > 0) {
                       setReviewModal({ shortfalls, overages });
                       setReviewReason('');
                       // Default each overage to "originally-requested goes to user"
                       const defaults: Record<string, number> = {};
                       overages.forEach(o => { defaults[o.itemId] = o.requested; });
                       setUserAssignments(defaults);
                       return;
                   }
                   // Only close the modal if finalise actually went through (or
                   // bounced for re-approval). On a genuine rejection — e.g.
                   // "no vendor allocations yet" from an accidental early click —
                   // keep the modal OPEN so the item edits + typed vendor
                   // allocations in local state are preserved, not lost.
                   const finalizeOk = await handleUpdateStatus(selectedIndent?.id, 'status', 'AWAITING_PAYMENT');
                   if (finalizeOk) setIsViewModalOpen(false);
                }}
            />

            <FinaliseReviewModal
                reviewModal={reviewModal}
                reviewReason={reviewReason}
                setReviewReason={setReviewReason}
                userAssignments={userAssignments}
                setUserAssignments={setUserAssignments}
                finalisingPartial={finalisingPartial}
                setFinalisingPartial={setFinalisingPartial}
                selectedIndent={selectedIndent}
                onUpdateStatus={handleUpdateStatus}
                onClose={() => { setReviewModal(null); setReviewReason(''); setUserAssignments({}); }}
                onFinalised={() => setIsViewModalOpen(false)}
            />

            <Modal size="2xl" isOpen={isHistoryModalOpen} onClose={() => setIsHistoryModalOpen(false)} title={`Indent History (${historyP.serverTotal})`}>
                <div className="space-y-3">
                    <label className="flex items-center gap-1.5 text-[11px] font-bold text-muted cursor-pointer select-none w-fit" title="Show withdrawn (deleted) indents too — they stay marked in the table and the export.">
                        <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} className="accent-brand" />
                        Include withdrawn
                    </label>
                    {/* Audit-grade export — CSV / List PDF / Detailed PDF with
                        date-range filter. Backend-rendered + role-scoped so
                        the file is auditor-ready out of the box. Scope mirrors
                        the table: terminal statuses + the withdrawn toggle. */}
                    <ExportPanel kind="indents" status={DONE_INDENT_STATUSES} includeDeleted={showDeleted} />
                    <DataTable
                        columns={historyCols}
                        data={historyF.pageRows}
                        isLoading={historyP.isLoading}
                        keyExtractor={r => r.id}
                        emptyStateMessage="No past indents."
                    />
                    <LoadAllCapNote truncated={historyP.truncated} shown={pastIndents.length} total={historyP.serverTotal} />
                    <Pagination currentPage={historyF.page} totalPages={historyF.totalPages} onPageChange={historyF.setPage} />
                </div>
            </Modal>

            <Modal isOpen={isRaiseModalOpen} onClose={() => setIsRaiseModalOpen(false)} title="Raise Indent" size="xl">
                <IndentForm onSubmit={handleCreateIndent} isLoading={isCreatingIndent} />
            </Modal>

            {/* Reopen / re-quote modal — pulls a quoted indent back to
                QUOTATION_IN_PROGRESS so procurement can re-quote when a vendor's
                stock ran out. Optional reason is logged + shown to Finance when
                the indent was already in their payment queue. */}
            <Modal
                isOpen={!!reopenRow}
                onClose={() => { if (reopening) return; setReopenRow(null); setReopenReason(''); }}
                title={reopenRow ? `Reopen ${reopenRow.serialNo} for re-quoting` : 'Reopen for re-quoting'}
            >
                {reopenRow && (
                    <div className="space-y-4">
                        <div className="bg-orange-50 dark:bg-orange-400/15 border border-orange-200 dark:border-orange-400/30 rounded-md p-3 text-xs text-orange-900 dark:text-orange-200 space-y-1">
                            <p className="font-bold">This sends the indent back to Quotation In Progress.</p>
                            <p>
                                {reopenRow.status === 'AWAITING_PAYMENT'
                                    ? 'It’s currently with Finance for payment — reopening pulls it back and tells Finance to hold. Only possible before payment is made.'
                                    : 'Re-quote the affected lines, finalise, and send to Finance again when ready.'}
                            </p>
                        </div>
                        <div className="bg-surface rounded-md p-3 border border-line-soft text-xs">
                            <p><span className="font-bold">Amount:</span> {reopenRow.currency} {Number(reopenRow.grandTotal || 0).toLocaleString('en-IN')}</p>
                            <p><span className="font-bold">Department:</span> {reopenRow.department?.name}</p>
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-ink mb-1">Reason <span className="font-normal text-faint">(optional)</span></label>
                            <textarea
                                value={reopenReason}
                                onChange={(e) => setReopenReason(e.target.value)}
                                rows={3}
                                placeholder="e.g. Vendor A out of stock — need to re-source 2 lines"
                                className="w-full text-sm border border-line rounded-md p-2 focus:outline-none focus:ring-2 focus:ring-orange-300"
                            />
                        </div>
                        <div className="flex justify-end gap-2 pt-1">
                            <button
                                onClick={() => { setReopenRow(null); setReopenReason(''); }}
                                disabled={reopening}
                                className="text-sm bg-hover border border-line text-ink px-4 py-1.5 rounded-md font-bold hover:bg-line transition-colors disabled:opacity-50">
                                Cancel
                            </button>
                            <button
                                onClick={submitReopen}
                                disabled={reopening}
                                className="text-sm bg-orange-700 text-white px-4 py-1.5 rounded-md font-bold hover:bg-orange-800 transition-colors disabled:opacity-50">
                                {reopening ? 'Reopening…' : 'Reopen for re-quoting'}
                            </button>
                        </div>
                    </div>
                )}
            </Modal>

            {/* Cancel-with-refund flow modal — driven by the status dropdown
                interceptor above. */}
            <CancelIndentModal
                isOpen={!!cancelRow}
                onClose={() => setCancelRow(null)}
                row={cancelRow}
                submitting={cancelSubmitting}
                onSubmit={submitCancel}
            />

            {/* Update-refund modal — surfaced from the "Update refund" button
                on cancelled rows. */}
            <RefundStatusModal
                isOpen={!!refundRow}
                onClose={() => setRefundRow(null)}
                row={refundRow}
                submitting={refundSubmitting}
                onSubmit={submitRefundUpdate}
                onUpdated={fetchIndents}
            />

            {/* Mark-as-Ordered + Update-ETA modal — opened either from the
                status dropdown (mark_ordered mode, intercepts the dropdown
                so we get the date in the same flow) or from the Update ETA
                action button (update_eta mode, date-only revision). */}
            <OrderedConfirmModal
                isOpen={!!orderedRow}
                onClose={() => setOrderedRow(null)}
                row={orderedRow}
                mode={orderedMode}
                submitting={orderedSubmitting}
                onSubmit={submitOrdered}
                onUpdated={() => { fetchIndents(); refreshSelectedIndent(); window.dispatchEvent(new Event('indents-updated')); }}
            />

            {/* Customs clearance — any indent in transit (currency-agnostic). */}
            <CustomsClearanceModal
                isOpen={!!customsRow}
                onClose={() => setCustomsRow(null)}
                row={customsRow}
                onSaved={fetchIndents}
            />
            <VendorShipmentModal
                indent={shipmentRow}
                onClose={() => setShipmentRow(null)}
                onSaved={fetchIndents}
            />
        </div>
    );
};
