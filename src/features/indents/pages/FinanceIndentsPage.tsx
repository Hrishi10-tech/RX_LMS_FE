import { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import { client } from '@/api';
import { DataTable, Modal, ColumnFilter, PendingCell, ExportPanel, Pagination, SearchInput, BomProvenanceChip, BulkSelectionBar, LoadAllCapNote } from '@/components/ui';
import { usePagedFilters, useClientPagination, useServerPagination, useBulkSelection, FilterSpec, useAuth, useAbortOnUnmount } from '@/hooks';
import { useToast } from '@/context/ToastContext';
import { statusReasonForIndent } from '@/utils/pendingReason';
import { fmtDateTime, dateOnlyKey } from '@/utils/date';
import { ceoLaneVisible, ceoNotApplicableLabel, ceoNotApplicableTitle } from '@/config/thresholds';
import { RefundStatusModal } from '../components/RefundStatusModal';
import { RefundStatusBadge } from '../components/RefundStatusBadge';
import { PaymentModal } from '../components/PaymentModal';
import { PaymentReceiptModal } from '../components/PaymentReceiptModal';

import { extractErrorMessage, logError } from '@/lib';
import { ApprovalCell } from '../components/IndentDetailsModal';
import { UserRole } from '@/types';
import { RECEIPT_ACCEPT } from '@/lib/fileAccept';

const EmergencyBadge = ({ row }: { row: any }) => (
    <div className="flex flex-col items-start gap-0.5">
        <span className="font-bold text-ink">{row.serialNo}</span>
        {/* BOM provenance chip — finance needs to know if this indent
            came from a 150-line BOM (different decision context than
            an ad-hoc indent for one item). Tooltip carries the BOM name
            for quick orientation; clicking the row opens the timeline
            modal which now also shows the full BOM link. */}
        {row.bomList?.serialNo && (
            <BomProvenanceChip serialNo={row.bomList.serialNo} name={row.bomList.name} prefix="from " />
        )}
        {row.emergency && (
            <>
                <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-red-100 dark:bg-red-400/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-400/30">⚡ EMERGENCY</span>
                {row.emergencyReason && (
                    <span className="text-[10px] text-red-700 dark:text-red-300 italic max-w-[200px]" title={row.emergencyReason}>
                        {row.emergencyReason.length > 40 ? row.emergencyReason.slice(0, 40) + '…' : row.emergencyReason}
                    </span>
                )}
            </>
        )}
    </div>
);

/**
 * Finance hub:
 *   - Top section: indents in AWAITING_PAYMENT, with "Mark as Paid" action.
 *   - Below: read-only spend overview across every indent.
 */
/**
 * One money cell.
 *
 * An Associate Finance user only sees amounts on the payments Finance assigned
 * to it; the server blanks the rest and stamps `amountsRedacted` on the row.
 * Rendering that as an empty cell or a bare dash would read as "no amount
 * recorded", so it says "Hidden" with the reason on hover — the viewer should
 * be able to tell "not allowed to see this" from "nothing here".
 */
const AmountCell = ({ row, bold = true }: { row: any; bold?: boolean }) => {
  if (row?.amountsRedacted) {
    return (
      <span
        className="text-[10px] font-bold uppercase tracking-wider text-muted"
        title="Only Finance and the person a payment is assigned to can see its value"
      >
        Hidden
      </span>
    );
  }
  return (
    <span className={bold ? 'font-bold text-ink' : undefined}>
      {row.currency} {row.grandTotal?.toLocaleString()}
    </span>
  );
};

export const FinanceIndentsPage = () => {
    const { user } = useAuth();
    // FINANCE and SUPER_ADMIN can pay anything.
    //
    // ASSOCIATE_FINANCE can now pay too — but only indents Finance has
    // explicitly assigned to it. The server is the authority (`assertMayPay`);
    // this flag only decides whether to render the button, and the row-level
    // check below decides which rows get one. Rendering it everywhere and
    // letting the AF collect a 403 would be the same mistake the asset-intake
    // four-eyes rule had before it was made visible up front.
    const isAssociateFinance = user?.role === UserRole.ASSOCIATE_FINANCE;
    const canPayAnything = user?.role === UserRole.FINANCE || user?.role === UserRole.SUPER_ADMIN;
    const canMarkPaid = canPayAnything || isAssociateFinance;
    // Only Finance decides who pays what — an AF must not be able to assign
    // work to itself.
    const canAssignPayments = canPayAnything;
    const mayPayRow = (row: any) =>
        canPayAnything || (isAssociateFinance && row?.paymentAssignee?.id === user?.id);
    const { addToast } = useToast();

    // Three server-paginated buckets (10/page each), mirroring the
    // IndentsManagementPage precedent. orderBy=priority floats emergencies to
    // the top ACROSS pages (server-side), replacing the old client
    // .sort(emergency-first). Column filters below refine the CURRENT loaded
    // page only — the same accepted tradeoff as the sibling page.
    // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
    const abortSignal = useAbortOnUnmount();

    const [isHistoryOpen, setIsHistoryOpen] = useState(false);
    //  1. AWAITING_PAYMENT — the act-on queue (finance marks these paid).
    // Associate Finance sees ONLY the payments Finance has sent it — the master
    // control stays with Finance. There is deliberately no "show me everything"
    // toggle: the server scopes an AF's AWAITING_PAYMENT view to its own
    // assignments whatever the request asks for, so a toggle would promise a
    // view the role isn't allowed to have.
    // Bulk assignment. Finance triages the whole queue in one pass, so this is
    // select-many-then-send rather than a per-row dropdown.
    const paySel = useBulkSelection();
    const [assignees, setAssignees] = useState<Array<{ id: string; name: string; email: string }>>([]);
    const [assignTo, setAssignTo] = useState('');
    const [assigning, setAssigning] = useState(false);
    const awaitingP = useServerPagination<any>({ loadAll: true,
        endpoint: '/indents',
        params: {
            status: 'AWAITING_PAYMENT',
            orderBy: 'priority',
            // Sent so the intent is legible in the request, not merely implied
            // by the caller's role; the server enforces it either way.
            ...(isAssociateFinance ? { paymentAssignedToMe: 'true' } : {}),
        },
    });
    //  2. "All Other Indents" — the LIVE overview: still-in-flight work only
    //     (approved → ordered → in-transit). Delivered/dead (RECEIVED,
    //     REJECTED, CANCELLED) drop out of here and into History — the same
    //     terminal set the backend rollup treats as non-active
    //     (indent-query.service.ts), matching the delivered-only History
    //     semantics used on the approval/queue pages.
    const overviewP = useServerPagination<any>({ loadAll: true, endpoint: '/indents', params: { excludeStatus: 'AWAITING_PAYMENT,RECEIVED,CANCELLED,REJECTED', orderBy: 'priority' } });
    //  3. History — the delivered/dead archive (RECEIVED + REJECTED + CANCELLED).
    //     Lazy: only fetched while the History modal is open, so the default page
    //     load doesn't pay for a query most visits never look at.
    const historyP = useServerPagination<any>({ loadAll: true, endpoint: '/indents', params: { status: 'RECEIVED,CANCELLED,REJECTED', orderBy: 'priority' }, enabled: isHistoryOpen });

    // Spend tiles + customs-duty queue come from ONE aggregate call instead of
    // reducing/flat-mapping over a full client-side /indents fetch. Bounded by
    // design (org-wide groupBy sums + PENDING-only duty rows), so it can't blow
    // up the way the old "load everything, derive in the browser" path could.
    const [summary, setSummary] = useState<{ aggregates: { pipeline: number; committed: number; received: number }; pendingCustomsDuties: any[] }>({
        aggregates: { pipeline: 0, committed: 0, received: 0 },
        pendingCustomsDuties: [],
    });
    // A mutation handler both calls fetchIndents() directly AND dispatches
    // 'indents-updated' (for the sidebar + sibling pages); this page's own
    // listener then re-invokes fetchIndents, so fetchSummary would fire twice
    // for the same change. This in-flight guard collapses that same-tick double
    // into one GET — the skipped call carries identical data. (Genuinely
    // sequential mutations are >1 request apart, so each still refreshes.)
    const summaryInFlight = useRef(false);
    const fetchSummary = useCallback(async () => {
        if (summaryInFlight.current) return;
        summaryInFlight.current = true;
        try {
            const { data } = await client.get('/indents/finance-summary', { signal: abortSignal() });
            const payload = data?.data ?? data ?? {};
            setSummary({
                aggregates: payload.aggregates ?? { pipeline: 0, committed: 0, received: 0 },
                pendingCustomsDuties: payload.pendingCustomsDuties ?? [],
            });
        } catch {
            // Non-fatal: the paginated tables (which DO toast on error) carry the
            // page; the tiles just keep their last value rather than disrupting it.
        } finally {
            summaryInFlight.current = false;
        }
    }, []);

    // Payment modal state
    const [payRow, setPayRow] = useState<any | null>(null);
    const [txnId, setTxnId] = useState('');
    const [notes, setNotes] = useState('');
    const [receipts, setReceipts] = useState<File[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    // Customs-duty pay modal (international indents) — separate state from the
    // main mark-paid modal above so the two never clash.
    const [dutyPayRow, setDutyPayRow] = useState<any | null>(null);
    const [dutyTxnId, setDutyTxnId] = useState('');
    const [dutyReceipt, setDutyReceipt] = useState<File | null>(null);
    const [dutySubmitting, setDutySubmitting] = useState(false);
    const dutyFileRef = useRef<HTMLInputElement>(null);
    // Which customs-duty rows have their clearance detail expanded. Finance
    // reviews the documentation / delivery order / shipment detail procurement
    // recorded, then decides what & where to pay.
    const [expandedDuties, setExpandedDuties] = useState<Set<string>>(new Set());
    const toggleDutyDetail = (id: string) => setExpandedDuties(prev => {
        const next = new Set(prev);
        next.has(id) ? next.delete(id) : next.add(id);
        return next;
    });
    // Vendor breakdown for the open payment modal — fetched on open so
    // finance can verify "who gets what" against the vendor invoice
    // before releasing the payment. Without this the modal only showed
    // grand total + a single vendor name, which doesn't match how
    // procurement actually splits a quote across multiple vendors.
    const [payAllocations, setPayAllocations] = useState<any[]>([]);
    const [payItems, setPayItems] = useState<any[]>([]);
    const [allocLoading, setAllocLoading] = useState(false);

    // Per-vendor-order payment forms — each vendor order is its own website
    // checkout (one wire/cheque/card payment can't cover 200 vendors), so
    // finance captures a txn id + receipt + notes per vendor and fires them
    // one at a time. Keyed by vendorOrder id. The indent auto-advances to
    // PAYMENT_DONE server-side once the last outstanding order clears.
    const [voForms, setVoForms] = useState<Record<string, { txnId: string; notes: string; receipt: File | null }>>({});
    const [voSubmitting, setVoSubmitting] = useState<string | null>(null);
    const voFileRefs = useRef<Record<string, HTMLInputElement | null>>({});
    // Per-order line selection for partial mark-paid, keyed by vendor-order id.
    // No entry = "all lines selected" (the default → omit allocationIds → today's
    // whole-order payment, byte-for-byte). An explicit Set → pay just those lines
    // (the backend splits the order: the paid lines peel into their own order,
    // the rest stay AWAITING_PAYMENT).
    const [voSelected, setVoSelected] = useState<Record<string, Set<string>>>({});
    const setVoForm = (orderId: string, patch: Partial<{ txnId: string; notes: string; receipt: File | null }>) =>
        setVoForms(prev => {
            const cur = prev[orderId] ?? { txnId: '', notes: '', receipt: null };
            return { ...prev, [orderId]: { ...cur, ...patch } };
        });

    // Inline vendor-credential lookup. Finance enters the vault master
    // password once per modal session; we then match unique vendor names
    // from the allocations against the vault and surface logins inline.
    // Removes the page-switching dance: open vault → unlock → find vendor
    // → copy creds → switch back to pay.
    const [vaultPassword, setVaultPassword] = useState('');
    const [vaultUnlocking, setVaultUnlocking] = useState(false);
    const [vaultMatches, setVaultMatches] = useState<Array<{ vendorName: string; matched: boolean; credential: { id: string; platform: string; loginId: string; password: string; notes?: string } | null }>>([]);
    const [vaultRevealed, setVaultRevealed] = useState<Record<string, boolean>>({});
    const [vaultError, setVaultError] = useState<string | null>(null);
    // Idle auto-lock — decrypted creds in modal state get wiped after this
    // many ms of no interaction with the vault card. Short enough that an
    // unattended modal can't leak passwords; long enough that finance has
    // time to read + copy + tab over to the vendor portal.
    const VAULT_IDLE_MS = 90_000;
    const vaultIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lockVault = () => {
        setVaultPassword('');
        setVaultMatches([]);
        setVaultRevealed({});
        setVaultError(null);
        if (vaultIdleTimer.current) {
            clearTimeout(vaultIdleTimer.current);
            vaultIdleTimer.current = null;
        }
    };
    const bumpVaultIdle = () => {
        if (vaultIdleTimer.current) clearTimeout(vaultIdleTimer.current);
        vaultIdleTimer.current = setTimeout(() => {
            lockVault();
            addToast('Vault auto-locked after 90s of inactivity', 'info');
        }, VAULT_IDLE_MS);
    };
    useEffect(() => () => {
        if (vaultIdleTimer.current) clearTimeout(vaultIdleTimer.current);
    }, []);

    // Refresh both paginated buckets + the aggregate summary after any mutation
    // (or focus / cross-page 'indents-updated'). The pagination hooks self-fetch
    // on mount, so this is NOT called on first render — only the summary is.
    const fetchIndents = () => {
        awaitingP.refetch();
        overviewP.refetch();
        // History is lazy (only fetches while its modal is open) — refetch it
        // too when open so a mark-received elsewhere lands in the archive live.
        if (isHistoryOpen) historyP.refetch();
        fetchSummary();
    };
    // The listeners below are registered once, on mount, so a plain reference
    // to fetchIndents would keep the first render's copy forever — the one
    // where isHistoryOpen was false — and a focus or 'indents-updated' with the
    // History modal open never refreshed it. They call through this ref, which
    // always holds the current render's fetchIndents.
    const fetchIndentsRef = useRef(fetchIndents);
    fetchIndentsRef.current = fetchIndents;

    // The two table hooks self-fetch on mount; here we only pull the aggregate
    // summary (tiles + customs queue). On tab focus / 'indents-updated' (e.g.
    // procurement edits/raises a customs duty elsewhere) we refresh everything
    // so the queue + spend tiles stay live without a manual reload.
    useEffect(() => {
        fetchSummary();
        // Tab-return fires BOTH 'focus' and 'visibilitychange' → used to double-fetch.
        // Guard the focus/visibility pair so it refetches once; the explicit
        // 'indents-updated' signal stays direct (a real data-changed event that
        // should always refetch).
        let lastRefresh = 0;
        const refreshOnReturn = () => {
            const now = Date.now();
            if (now - lastRefresh < 500) return;
            lastRefresh = now;
            fetchIndentsRef.current();
        };
        const onUpdated = () => fetchIndentsRef.current();
        const onVisible = () => { if (document.visibilityState === 'visible') refreshOnReturn(); };
        window.addEventListener('focus', refreshOnReturn);
        window.addEventListener('indents-updated', onUpdated);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.removeEventListener('focus', refreshOnReturn);
            window.removeEventListener('indents-updated', onUpdated);
            document.removeEventListener('visibilitychange', onVisible);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const openPayModal = async (row: any) => {
        setPayRow(row); setTxnId(''); setNotes(''); setReceipts([]);
        setPayAllocations([]); setPayItems([]);
        setVoForms({}); setVoSubmitting(null); voFileRefs.current = {}; setVoSelected({});
        if (fileRef.current) fileRef.current.value = '';
        // Pull the vendor allocation breakdown so finance can verify the
        // payment against vendor invoices line-by-line.
        setAllocLoading(true);
        try {
            const allocRes = await client.get(`/indents/${row.id}/allocations`, { signal: abortSignal() });
            const allocPayload = allocRes.data?.data ?? allocRes.data;
            setPayAllocations(allocPayload?.allocations || []);
            // Items already arrived with the list row (findAll includes them
            // with id/name/unit) — the breakdown only needs name+unit by id, so
            // reuse them instead of a second /indents/:id round-trip.
            setPayItems(row.items || []);
        } catch (e: any) {
            // Non-fatal: pay modal still works without the breakdown.
            addToast(extractErrorMessage(e, 'Could not load vendor breakdown'), 'error');
        } finally {
            setAllocLoading(false);
        }
    };
    const closePayModal = () => {
        setPayRow(null);
        setPayAllocations([]);
        setPayItems([]);
        setVoForms({}); setVoSubmitting(null); voFileRefs.current = {}; setVoSelected({});
        // Wipe decrypted credentials from memory the moment the modal
        // closes — keeps the attack surface tight.
        lockVault();
    };

    const submitPayment = async () => {
        if (!payRow) return;
        // Transaction ID is required (the server refuses a payment without one); the receipt is optional.
        if (!txnId.trim()) { addToast('A transaction ID is required', 'error'); return; }
        setSubmitting(true);
        try {
            const fd = new FormData();
            fd.append('transactionId', txnId.trim());
            if (notes.trim()) fd.append('notes', notes.trim());
            // Repeated field name — this is how multipart carries a list, and it
            // is the name FileFieldsInterceptor reads on the server.
            receipts.forEach(f => fd.append('receipts', f));
            await client.post(`/indents/${payRow.id}/mark-paid`, fd, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            addToast(`${payRow.serialNo} marked as paid`, 'success');
            closePayModal();
            fetchIndents();
            // Notify sibling indent views (Procurement/Refunds/SuperAdmin) + the
            // finance/procurement badges. The per-vendor + duty pay paths already
            // dispatch this; the whole-indent mark-paid path didn't.
            window.dispatchEvent(new Event('indents-updated'));
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to mark as paid'), 'error');
        } finally {
            setSubmitting(false);
        }
    };

    // Mark ONE vendor order paid. Fires its own txn id + receipt, then re-pulls
    // the indent so this card flips to "paid" while the rest stay actionable.
    // When the server reports the whole indent rolled up to PAYMENT_DONE (last
    // vendor cleared), the modal closes and the row leaves the queue.
    const submitVendorPayment = async (vo: any) => {
        if (!payRow) return;
        const form = voForms[vo.id] || { txnId: '', notes: '', receipt: null };
        // Transaction ID is required (the server refuses a payment without one); the receipt is optional.
        if (!form.txnId.trim()) { addToast('A transaction ID is required', 'error'); return; }
        // Which of THIS order's lines are being paid. No selection entry = all
        // (whole-order pay, no allocationIds). A strict subset → send the ticked
        // ids; the backend peels them into their own order and pays just those.
        const lineIds: string[] = payAllocations.filter((a: any) => a.vendorOrderId === vo.id).map((a: any) => a.id);
        const sel = voSelected[vo.id];
        const selectedIds = sel ? lineIds.filter((id) => sel.has(id)) : lineIds;
        if (lineIds.length > 0 && selectedIds.length === 0) { addToast('Select at least one item to pay', 'error'); return; }
        const isSubset = lineIds.length > 0 && selectedIds.length < lineIds.length;
        setVoSubmitting(vo.id);
        try {
            const fd = new FormData();
            fd.append('transactionId', form.txnId.trim());
            if (form.notes.trim()) fd.append('notes', form.notes.trim());
            if (form.receipt) fd.append('receipt', form.receipt);
            if (isSubset) fd.append('allocationIds', JSON.stringify(selectedIds));
            const res = await client.post(`/indents/${payRow.id}/vendor-orders/${vo.id}/mark-paid`, fd, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            const updated = res.data?.data ?? res.data;
            addToast(isSubset ? `${selectedIds.length} item(s) for ${vo.vendorName} marked as paid` : `${vo.vendorName} marked as paid`, 'success');
            setVoForms(prev => { const n = { ...prev }; delete n[vo.id]; return n; });
            setVoSelected(prev => { const n = { ...prev }; delete n[vo.id]; return n; });
            if (voFileRefs.current[vo.id]) voFileRefs.current[vo.id]!.value = '';
            if (updated?.status === 'PAYMENT_DONE') {
                addToast(`${payRow.serialNo} fully paid — order placed with procurement`, 'success');
                closePayModal();
            } else {
                // Re-pull fresh vendor orders AND allocations so the paid card
                // shows server truth (txn id + receipt link) and a subset-pay
                // split surfaces its new sibling order with the right lines.
                try {
                    const fresh = await client.get(`/indents/${payRow.id}`, { signal: abortSignal() });
                    const freshRow = fresh.data?.data ?? fresh.data;
                    setPayRow((prev: any) => prev ? { ...prev, status: freshRow.status, vendorOrders: freshRow.vendorOrders } : prev);
                    if (Array.isArray(freshRow?.vendorAllocations)) setPayAllocations(freshRow.vendorAllocations);
                } catch {
                    setPayRow((prev: any) => prev ? { ...prev, vendorOrders: (prev.vendorOrders || []).map((o: any) => o.id === vo.id ? { ...o, status: 'PAID' } : o) } : prev);
                }
            }
            fetchIndents();
            window.dispatchEvent(new Event('indents-updated'));
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to mark vendor as paid'), 'error');
        } finally {
            setVoSubmitting(null);
        }
    };

    const submitDutyPayment = async () => {
        if (!dutyPayRow) return;
        if (!dutyTxnId.trim()) { addToast('Transaction ID is required', 'error'); return; }
        setDutySubmitting(true);
        try {
            const fd = new FormData();
            fd.append('transactionId', dutyTxnId.trim());
            if (dutyReceipt) fd.append('receipt', dutyReceipt);
            await client.post(`/indents/${dutyPayRow.indent.id}/customs-duty/${dutyPayRow.id}/pay`, fd, {
                headers: { 'Content-Type': 'multipart/form-data' },
            });
            addToast(`Customs duty paid — ${dutyPayRow.indent.serialNo}`, 'success');
            setDutyPayRow(null); setDutyTxnId(''); setDutyReceipt(null);
            if (dutyFileRef.current) dutyFileRef.current.value = '';
            fetchIndents();
            // Update the sidebar "Payments & Spend" badge immediately.
            window.dispatchEvent(new Event('indents-updated'));
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to pay customs duty'), 'error');
        } finally {
            setDutySubmitting(false);
        }
    };

    // Current loaded page of each server bucket (≤10 rows). Column filters +
    // the row tables read these; pagination/sort already happened server-side.
    const awaitingPayment = awaitingP.items;
    const everythingElse  = overviewP.items;

    // Pending customs-duty rows — now sourced from the aggregate summary
    // (PENDING-only, org-wide) instead of a flatMap over a full /indents fetch.
    const pendingCustomsDuties = summary.pendingCustomsDuties;

    // Derive the display vendor name(s) from the active quotation's
    // VendorAllocation rows — `Indent.vendorName` is a legacy free-text
    // field that procurement stopped filling once per-vendor allocations
    // became the source of truth. Falls back to the legacy field only
    // when there are no allocations (very old indents).
    const vendorNames = (row: any): string[] => {
        const allocs: any[] = Array.isArray(row?.vendorAllocations) ? row.vendorAllocations : [];
        const names = Array.from(new Set(allocs.map(a => (a?.vendorName || '').trim()).filter(Boolean)));
        if (names.length === 0) { const v = (row?.vendorName || '').trim(); return v ? [v] : []; }
        return names as string[];
    };
    const vendorDisplay = (row: any): string => {
        const names = vendorNames(row);
        if (names.length === 0) return '';
        if (names.length === 1) return names[0];
        return `${names[0]} +${names.length - 1} more`;
    };
    // Payment has actually moved once it's past the awaiting-payment stage.
    const PAID_STATES = ['PAYMENT_DONE', 'ORDERED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED'];
    const paymentMoved = (row: any): boolean => !!row?.paymentTransactionId || PAID_STATES.includes(row?.status);

    // Read-only payment-receipt drawer — opens via an explicit "View"
    // button in the row. Reuses fields already on the row (no extra
    // fetch for the receipt body since the list endpoint includes
    // items + vendorAllocations + paidBy + payment* fields).
    // Audit trail is fetched on demand from /indents/:id/audit — merges
    // status transitions + every individual approval event so admin
    // re-approvals don't appear to be missing.
    const [viewRow, setViewRow] = useState<any | null>(null);
    const [viewTimeline, setViewTimeline] = useState<any[]>([]);
    const [viewTimelineLoading, setViewTimelineLoading] = useState(false);
    // Timeline is the heaviest part of this modal (full audit merge) and most
    // opens never look at it, so it's collapsed + lazy: we fetch /indents/:id/
    // audit only on the FIRST expand of the accordion, not on every open.
    const [viewTimelineOpen, setViewTimelineOpen] = useState(false);
    const [viewTimelineLoaded, setViewTimelineLoaded] = useState(false);
    const [viewTimelineError, setViewTimelineError] = useState(false);
    const openViewModal = async (row: any) => {
        setViewRow(row);
        setViewTimeline([]);
        setViewTimelineOpen(false);
        setViewTimelineLoaded(false);
        setViewTimelineLoading(false);
        setViewTimelineError(false);
        // Pull the full detail so the slip has the per-vendor orders (each vendor's
        // own transaction id + receipt + paid date) — the list row only carries
        // the indent-level payment fields, which are empty for a per-vendor pay.
        try {
            const { data } = await client.get(`/indents/${row.id}`, { signal: abortSignal() });
            const detail = data?.data ?? data;
            if (detail?.id) setViewRow((prev: any) => (prev && prev.id === detail.id ? { ...prev, ...detail } : prev));
        } catch { /* keep the list row — slip still renders what it has */ }
    };

    // Arriving from a notification (?openIndent=<id>): open that indent.
    // Notifications linked here for this role, but the page never read the
    // param, so the click landed on the list and left you to find the row.
    const [deepLinkParams, setDeepLinkParams] = useSearchParams();
    const deepLinkIndentId = deepLinkParams.get('openIndent');
    useEffect(() => {
        if (!deepLinkIndentId || !(!awaitingP.isLoading && !overviewP.isLoading)) return;
        const row = [...awaitingP.items, ...overviewP.items, ...historyP.items].find((r: any) => r?.id === deepLinkIndentId);
        const next = new URLSearchParams(deepLinkParams);
        next.delete('openIndent');
        setDeepLinkParams(next, { replace: true });
        if (row) { openViewModal(row); }
        else addToast("That indent isn't in your lists any more.", 'info');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deepLinkIndentId, !awaitingP.isLoading && !overviewP.isLoading]);
    const loadTimeline = async (id: string) => {
        setViewTimelineLoading(true);
        setViewTimelineError(false);
        try {
            const { data } = await client.get(`/indents/${id}/audit`, { signal: abortSignal() });
            setViewTimeline(data?.data ?? data ?? []);
        } catch {
            // Non-fatal — modal still shows everything else. Flag the error so the
            // accordion offers a Retry instead of a misleading "no changes
            // recorded yet" (which reads as real data, not a failed fetch) and
            // instead of latching the failure permanently until the modal reopens.
            setViewTimeline([]);
            setViewTimelineError(true);
        } finally {
            setViewTimelineLoaded(true);
            setViewTimelineLoading(false);
        }
    };
    const toggleTimeline = () => {
        const next = !viewTimelineOpen;
        setViewTimelineOpen(next);
        // Fetch once, on first expand only.
        if (next && !viewTimelineLoaded && viewRow) loadTimeline(viewRow.id);
    };
    const closeViewModal = () => {
        setViewRow(null);
        setViewTimeline([]);
        setViewTimelineOpen(false);
        setViewTimelineLoaded(false);
        setViewTimelineError(false);
    };

    // Refund-update modal — finance opens this from a cancelled-with-refund
    // row's receipt modal (or directly from the overview table) to mark
    // refund RECEIVED / DISPUTED / WRITE_OFF. Same modal as procurement uses.
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

    const paymentFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'indentNo',   getValue: (r) => r.serialNo },
        { key: 'date',       getValue: (r) => dateOnlyKey(r.createdAt) },
        { key: 'department', getValue: (r) => r.department?.name || 'Unknown' },
        { key: 'project',    getValue: (r) => r.project?.name || 'General / Others' },
        // Redacted rows group under one "Hidden" option instead of a pile of
        // identical "INR " entries in the filter dropdown.
        { key: 'amount',     getValue: (r) => r.amountsRedacted ? 'Hidden' : `${r.currency} ${r.grandTotal?.toLocaleString() ?? ''}` },
        { key: 'vendor',     getValue: (r) => { const v = vendorNames(r); return v.length ? v : null; } }, // one value per vendor, not "Acme +2 more"
        // A filter on every data column (owner, 27 Oct).
        { key: 'assignee',   getValue: (r) => r.paymentAssignee?.name || 'Unassigned' },
    ], []);

    const overviewFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'indentNo',   getValue: (r) => r.serialNo },
        { key: 'date',       getValue: (r) => dateOnlyKey(r.createdAt) },
        { key: 'department', getValue: (r) => r.department?.name || 'Unknown' },
        { key: 'project',    getValue: (r) => r.project?.name || 'General / Others' },
        // Redacted rows group under one "Hidden" option instead of a pile of
        // identical "INR " entries in the filter dropdown.
        { key: 'amount',     getValue: (r) => r.amountsRedacted ? 'Hidden' : `${r.currency} ${r.grandTotal?.toLocaleString() ?? ''}` },
        { key: 'tech',       getValue: (r) => r.techApprovalStatus },
        { key: 'ceo',        getValue: (r) => (ceoLaneVisible(r) ? r.ceoApprovalStatus : 'N/A') },
        { key: 'status',     getValue: (r) => r.status },
        { key: 'payment',    getValue: (r) => r.paymentTransactionId },
        { key: 'vendor',     getValue: (r) => { const v = vendorNames(r); return v.length ? v : null; } }, // one value per vendor, not "Acme +2 more"
    ], []);

    // Who Finance can hand payments to. Its own endpoint so Finance doesn't
    // need the user-management surface just to fill a dropdown. Fetched once,
    // and only for the roles that can assign.
    useEffect(() => {
        if (!canAssignPayments) return;
        client.get('/indents/payments/assignees', { signal: abortSignal() })
            .then(({ data }) => setAssignees(data?.data ?? data ?? []))
            .catch(err => logError('FinanceIndents.assignees', err));
    }, [canAssignPayments]);

    const runAssign = async (assigneeId: string | null) => {
        const ids = [...paySel.selectedIds];
        if (ids.length === 0) return;
        setAssigning(true);
        try {
            const { data } = await client.post('/indents/payments/assign', { indentIds: ids, assigneeId });
            const r = data?.data ?? data;
            const skipped = r?.skipped?.length ?? 0;
            if (assigneeId) {
                addToast(
                    `${r?.assignedCount ?? 0} payment${(r?.assignedCount ?? 0) === 1 ? '' : 's'} assigned to ${r?.assigneeName ?? 'them'}` +
                    (skipped ? ` — ${skipped} skipped (${r.skipped[0].reason})` : '.'),
                    skipped ? 'warning' : 'success',
                );
            } else {
                addToast(`${r?.assignedCount ?? 0} payment${(r?.assignedCount ?? 0) === 1 ? '' : 's'} unassigned.`, 'success');
            }
            paySel.clearSelection();
            setAssignTo('');
            awaitingP.refetch();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Could not assign the payments'), 'error');
        }
        setAssigning(false);
    };

    const paymentF = usePagedFilters(awaitingPayment, paymentFilterSpecs, 10, awaitingP.search);
    const overviewF = usePagedFilters(everythingElse, overviewFilterSpecs, 10, overviewP.search);
    // History (delivered/dead) reuses the overview column specs but needs its
    // OWN filter state + option lists — otherwise the modal's column filters
    // would be driven by the inline table's data instead of the archive's.
    const historyF = usePagedFilters(historyP.items, overviewFilterSpecs, 10, historyP.search);

    // Customs-duty queue stays client-paginated: the summary returns the full
    // PENDING set (bounded — one aggregate call), so 10/page in the browser is
    // enough to keep the DOM bounded without another server round-trip.
    const customsPager  = useClientPagination(pendingCustomsDuties, 10);

    // Tiles read the server-computed aggregates (org-wide, not just this page).
    const totals = summary.aggregates;

    const paymentColumns = [
        { filterActive: paymentF.isActive('indentNo'),   header: <span className="inline-flex items-center">Indent #<ColumnFilter searchable options={paymentF.getOptions('indentNo')}   value={paymentF.filters.indentNo   || ''} onChange={(v) => paymentF.setFilter('indentNo', v)}   /></span>, accessor: (row: any) => <EmergencyBadge row={row} /> },
        { filterActive: paymentF.isActive('date'),       header: <span className="inline-flex items-center">Date<ColumnFilter searchable options={paymentF.getOptions('date')}             value={paymentF.filters.date       || ''} onChange={(v) => paymentF.setFilter('date', v)}       /></span>, accessor: (row: any) => fmtDateTime(row.createdAt, 'N/A') },
        { filterActive: paymentF.isActive('department'), header: <span className="inline-flex items-center">Department<ColumnFilter options={paymentF.getOptions('department')}                  value={paymentF.filters.department || ''} onChange={(v) => paymentF.setFilter('department', v)} /></span>, accessor: (row: any) => row.department?.name || 'Unknown' },
        { filterActive: paymentF.isActive('project'),    header: <span className="inline-flex items-center">Project<ColumnFilter options={paymentF.getOptions('project')}                       value={paymentF.filters.project    || ''} onChange={(v) => paymentF.setFilter('project', v)}    /></span>, accessor: (row: any) => row.project?.name || <span className="italic text-faint">General / Others</span> },
        { filterActive: paymentF.isActive('amount'),     header: <span className="inline-flex items-center">Amount<ColumnFilter searchable options={paymentF.getOptions('amount')}         value={paymentF.filters.amount     || ''} onChange={(v) => paymentF.setFilter('amount', v)}     /></span>, accessor: (row: any) => <AmountCell row={row} /> },
        { filterActive: paymentF.isActive('vendor'),     header: <span className="inline-flex items-center">Vendor<ColumnFilter searchable options={paymentF.getOptions('vendor')}         value={paymentF.filters.vendor     || ''} onChange={(v) => paymentF.setFilter('vendor', v)}     /></span>, accessor: (row: any) => vendorDisplay(row) || <span className="text-[10px] text-faint">—</span> },
        { header: 'View', accessor: (row: any) => (
            <button
                onClick={(e) => { e.stopPropagation(); openViewModal(row); }}
                className="px-2.5 py-1 text-[11px] font-bold text-brand-700 hover:text-ink border border-brand-200 rounded hover:bg-brand-100/60 transition-colors"
                title="View details + timeline"
            >
                View
            </button>
        ) },
        { filterActive: paymentF.isActive('assignee'),   header: <span className="inline-flex items-center">Assigned to<ColumnFilter searchable options={paymentF.getOptions('assignee')} value={paymentF.filters.assignee   || ''} onChange={(v) => paymentF.setFilter('assignee', v)}   /></span>, accessor: (row: any) => row.paymentAssignee?.name
            ? <span className="text-xs font-bold text-ink">{row.paymentAssignee.name}</span>
            : <span className="text-[10px] text-faint italic">Unassigned</span> },
        { header: 'Action', accessor: (row: any) => {
            if (mayPayRow(row)) return (
                <button onClick={() => openPayModal(row)} className="px-3 py-1.5 text-xs font-bold bg-emerald-700 text-white rounded hover:bg-emerald-800 transition-colors">
                    Mark as Paid
                </button>
            );
            // An AF looking at somebody else's row (or an unassigned one):
            // say so, rather than offering a button that 403s.
            if (isAssociateFinance) return (
                <span className="text-[10px] text-faint italic" title="Finance assigns payments before they can be made">
                    {row.paymentAssignee?.name ? 'Assigned to someone else' : 'Not assigned to you'}
                </span>
            );
            return <span className="text-[10px] text-faint italic">View only</span>;
        } },
    ];

    // Column factory — the inline overview and the History modal render the
    // same columns but must each bind to their OWN filter state (`f`), so the
    // column-filter dropdowns act on the table you're actually looking at.
    const makeOverviewColumns = (f: any) => [
        { filterActive: f.isActive('indentNo'),   header: <span className="inline-flex items-center">Indent #<ColumnFilter searchable options={f.getOptions('indentNo')}   value={f.filters.indentNo   || ''} onChange={(v) => f.setFilter('indentNo', v)}   /></span>, accessor: (row: any) => <EmergencyBadge row={row} /> },
        { filterActive: f.isActive('date'),       header: <span className="inline-flex items-center">Date<ColumnFilter searchable options={f.getOptions('date')}             value={f.filters.date       || ''} onChange={(v) => f.setFilter('date', v)}       /></span>, accessor: (row: any) => fmtDateTime(row.createdAt, 'N/A') },
        { filterActive: f.isActive('department'), header: <span className="inline-flex items-center">Department<ColumnFilter options={f.getOptions('department')}                  value={f.filters.department || ''} onChange={(v) => f.setFilter('department', v)} /></span>, accessor: (row: any) => row.department?.name || 'Unknown' },
        { filterActive: f.isActive('project'),    header: <span className="inline-flex items-center">Project<ColumnFilter options={f.getOptions('project')}                       value={f.filters.project    || ''} onChange={(v) => f.setFilter('project', v)}    /></span>, accessor: (row: any) => row.project?.name || <span className="italic text-faint">General / Others</span> },
        { filterActive: f.isActive('amount'),     header: <span className="inline-flex items-center">Amount<ColumnFilter searchable options={f.getOptions('amount')}         value={f.filters.amount     || ''} onChange={(v) => f.setFilter('amount', v)}     /></span>, accessor: (row: any) => <AmountCell row={row} /> },
        { filterActive: f.isActive('tech'),       header: <span className="inline-flex items-center">Tech<ColumnFilter options={f.getOptions('tech')}                              value={f.filters.tech       || ''} onChange={(v) => f.setFilter('tech', v)}       /></span>, accessor: (row: any) => (
            <ApprovalCell status={row.techApprovalStatus} timestamp={row.techApprovedAt} approverName={row.techApprovedBy?.name} />
        )},
        { filterActive: f.isActive('ceo'),        header: <span className="inline-flex items-center">CEO<ColumnFilter options={f.getOptions('ceo')}                                value={f.filters.ceo        || ''} onChange={(v) => f.setFilter('ceo', v)}        /></span>, accessor: (row: any) => {
            // Same gate as this column's own filter options above (:522) — if the
            // two disagreed, the filter would offer "APPROVED" for rows whose
            // cell reads "N/A".
            if (!ceoLaneVisible(row)) return <span className="text-[10px] text-faint" title={ceoNotApplicableTitle()}>{ceoNotApplicableLabel()}</span>;
            return <ApprovalCell status={row.ceoApprovalStatus} timestamp={row.ceoApprovedAt} approverName={row.ceoApprovedBy?.name} />;
        }},
        { filterActive: f.isActive('status'),     header: <span className="inline-flex items-center">Status<ColumnFilter options={f.getOptions('status')}                         value={f.filters.status     || ''} onChange={(v) => f.setFilter('status', v)}     /></span>, accessor: (row: any) => (
            <div className="flex flex-col items-start gap-1">
                {row.status === 'PAYMENT_DONE' && !isAssociateFinance ? (
                    // Once paid, finance can advance it to "Order placed" straight
                    // (not Associate Finance — the order-status route is Finance /
                    // Procurement / Super Admin)
                    // from the status cell (mirrors procurement's per-row status
                    // dropdown) — marks the vendor orders ORDERED + rolls up.
                    <select
                        value="PAYMENT_DONE"
                        disabled={orderingId === row.id}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => { if (e.target.value === 'ORDERED') markOrderPlaced(row); }}
                        title="Payment is done — pick 'Order placed' once you've ordered from the vendor(s)"
                        className="text-[11px] font-bold border border-emerald-200 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-400/15 text-emerald-800 dark:text-emerald-200 rounded px-1.5 py-1 cursor-pointer focus:outline-none focus:border-brand disabled:opacity-60 disabled:cursor-wait"
                    >
                        <option value="PAYMENT_DONE">{orderingId === row.id ? 'Placing…' : 'Payment Done'}</option>
                        <option value="ORDERED">Order placed →</option>
                    </select>
                ) : (
                    <PendingCell status={row.status} reason={statusReasonForIndent(row)} />
                )}
                <RefundStatusBadge
                    status={row.refundStatus}
                    paidAmount={row.grandTotal}
                    receivedAmount={row.refundReceivedAmount}
                    currency={row.currency || 'INR'}
                />
            </div>
        ) },
        { filterActive: f.isActive('payment'),    header: <span className="inline-flex items-center">Payment<ColumnFilter searchable options={f.getOptions('payment')}       value={f.filters.payment    || ''} onChange={(v) => f.setFilter('payment', v)}    /></span>, accessor: (row: any) => {
            if (!paymentMoved(row)) return <span className="text-[10px] text-faint">—</span>;
            // Clickable → opens the slip, which shows every transaction id + the
            // uploaded receipt(s). Multi-vendor pays have NO indent-level txn id
            // (it's per vendor order), so a raw field here was blank + useless.
            return (
                <button
                    onClick={(e) => { e.stopPropagation(); openViewModal(row); }}
                    title="View payment slip — transaction id(s) + receipt(s)"
                    className="text-left flex flex-col items-start gap-0.5 group"
                >
                    {row.paymentTransactionId ? (
                        <span className="text-[10px] font-mono text-ink underline decoration-dotted group-hover:text-brand-700">{row.paymentTransactionId}</span>
                    ) : (
                        <span className="text-[11px] font-bold text-brand-700 underline decoration-dotted">Per-vendor · view slip</span>
                    )}
                    {row.paidAt && <span className="text-[10px] text-faint">{fmtDateTime(row.paidAt)}</span>}
                </button>
            );
        } },
        { filterActive: f.isActive('vendor'),     header: <span className="inline-flex items-center">Vendor<ColumnFilter searchable options={f.getOptions('vendor')}         value={f.filters.vendor     || ''} onChange={(v) => f.setFilter('vendor', v)}     /></span>, accessor: (row: any) => {
            const names = vendorNames(row);
            if (names.length === 0) return <span className="text-[10px] text-faint">—</span>;
            return (
                <button
                    onClick={(e) => { e.stopPropagation(); openViewModal(row); }}
                    title={names.join(', ')}
                    className="text-left text-[11px] text-ink hover:text-brand-700 underline decoration-dotted"
                >
                    {vendorDisplay(row)}
                </button>
            );
        } },
        { header: 'View', accessor: (row: any) => (
            <button
                onClick={(e) => { e.stopPropagation(); openViewModal(row); }}
                className="px-2.5 py-1 text-[11px] font-bold text-brand-700 hover:text-ink border border-brand-200 rounded hover:bg-brand-100/60 transition-colors"
                title="View details + timeline"
            >
                View
            </button>
        ) },
    ];
    const overviewColumns = makeOverviewColumns(overviewF);
    const historyColumns  = makeOverviewColumns(historyF);

    // "Mark order placed" from the Status-column dropdown — once payment is done,
    // finance can place the order directly (not just procurement). Marks every
    // PAID vendor order ORDERED via /vendor-orders/:id/status (FINANCE allowed,
    // no ETA needed — same as procurement's per-row dropdown); the indent rolls
    // up to ORDERED automatically.
    const [orderingId, setOrderingId] = useState<string | null>(null);
    const markOrderPlaced = async (row: any) => {
        setOrderingId(row.id);
        try {
            const fresh = await client.get(`/indents/${row.id}`, { signal: abortSignal() });
            const detail = fresh.data?.data ?? fresh.data;
            const paidOrders = (detail?.vendorOrders || []).filter((o: any) => o.status === 'PAID');
            if (paidOrders.length === 0) { addToast('No paid vendor orders to place.', 'error'); return; }
            for (const o of paidOrders) {
                await client.patch(`/indents/${row.id}/vendor-orders/${o.id}/status`, { status: 'ORDERED' });
            }
            addToast(`${row.serialNo} — order placed`, 'success');
            fetchIndents();
            window.dispatchEvent(new Event('indents-updated'));
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to mark order placed'), 'error');
        } finally {
            setOrderingId(null);
        }
    };

    const fmt = (n: number) => `₹ ${n.toLocaleString('en-IN')}`;

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Finance — Payments & Spend</h2>
                <p className="text-sm md:text-[15px] text-muted mt-1.5">Mark approved indents as paid (transaction ID required, receipt optional). Below: full spend visibility across every indent.</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-card rounded-xl border border-line-soft shadow-sm p-4">
                    <p className="text-xs font-bold text-muted uppercase tracking-wider">In Pipeline</p>
                    <p className="text-2xl font-bold text-ink mt-1">{fmt(totals.pipeline)}</p>
                    <p className="text-[11px] text-muted mt-1">Pending approval, with procurement, or awaiting payment.</p>
                </div>
                <div className="bg-card rounded-xl border border-line-soft shadow-sm p-4">
                    <p className="text-xs font-bold text-muted uppercase tracking-wider">Committed (Paid + Ordered)</p>
                    <p className="text-2xl font-bold text-amber-700 dark:text-amber-300 mt-1">{fmt(totals.committed)}</p>
                    <p className="text-[11px] text-muted mt-1">Paid and / or with vendor.</p>
                </div>
                <div className="bg-card rounded-xl border border-line-soft shadow-sm p-4">
                    <p className="text-xs font-bold text-muted uppercase tracking-wider">Received</p>
                    <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300 mt-1">{fmt(totals.received)}</p>
                    <p className="text-[11px] text-muted mt-1">Delivered and shelved.</p>
                </div>
            </div>

            {/* Server-side search across the WHOLE indent set (serial / item /
                requester), not just the loaded page. Broadcasts to Awaiting
                Payment, the spend overview, and the History modal. Column
                filters still refine within the current page. */}
            <div className="max-w-xs">
                <SearchInput
                    value={awaitingP.search}
                    onChange={(e) => { const v = e.target.value; awaitingP.setSearch(v); overviewP.setSearch(v); historyP.setSearch(v); }}
                    placeholder="Search all indents…"
                />
            </div>

            {/* Awaiting Payment section */}
            <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
                <div className="px-6 py-3 border-b border-line-soft bg-amber-50 dark:bg-amber-400/15">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div>
                            <h3 className="text-sm font-bold text-amber-900 dark:text-amber-200">Awaiting Payment ({awaitingP.total})</h3>
                            <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                                {isAssociateFinance
                                    ? 'Payments Finance has assigned to you. Pay via your bank / wire, then record the transaction here.'
                                    : 'Procurement has finalized the vendor and quote. Pay it yourself, or assign it to an Associate Finance colleague.'}
                            </p>
                        </div>
                        {/* Says plainly that this is a scoped view, so an AF
                            doesn't wonder where the rest of the queue went. */}
                        {isAssociateFinance && (
                            <span className="rounded-full bg-amber-100 dark:bg-amber-400/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-900 dark:text-amber-200 whitespace-nowrap">
                                Assigned to you
                            </span>
                        )}
                    </div>
                </div>

                {/* Bulk assign — Finance only. Selecting nothing hides the bar
                    entirely (BulkSelectionBar's own behaviour). */}
                {canAssignPayments && (
                    <BulkSelectionBar
                        count={paySel.selectedIds.size}
                        onClear={() => paySel.clearSelection()}
                    >
                        <div className="flex items-center gap-2 flex-wrap">
                            <label htmlFor="assign-to" className="text-[11px] font-bold text-muted">Send to</label>
                            <select
                                id="assign-to"
                                value={assignTo}
                                onChange={(e) => setAssignTo(e.target.value)}
                                className="rounded border border-line px-2 py-1 text-xs"
                            >
                                <option value="">Choose an Associate Finance user…</option>
                                {assignees.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                            </select>
                            <button
                                onClick={() => runAssign(assignTo)}
                                disabled={assigning || !assignTo}
                                className="rounded-full bg-brand px-2.5 py-1 text-xs font-bold text-white hover:bg-brand-dark disabled:opacity-50"
                            >
                                {assigning ? 'Sending…' : `Send ${paySel.selectedIds.size}`}
                            </button>
                            <button
                                onClick={() => runAssign(null)}
                                disabled={assigning}
                                title="Take these back — they become unassigned"
                                className="rounded border border-line px-2.5 py-1 text-xs font-bold text-muted hover:bg-surface disabled:opacity-50"
                            >
                                Unassign
                            </button>
                            {assignees.length === 0 && (
                                // Finance can now create these logins itself, so
                                // point at the page instead of leaving a dead end
                                // that reads like something only an admin can fix.
                                <span className="text-[10px] text-faint italic">
                                    No Associate Finance users yet —{' '}
                                    <Link to="/finance/associate-finance" className="font-bold text-brand-700 underline hover:text-ink">
                                        add one
                                    </Link>.
                                </span>
                            )}
                        </div>
                    </BulkSelectionBar>
                )}

                <DataTable
                    columns={paymentColumns}
                    data={paymentF.pageRows}
                    isLoading={awaitingP.isLoading}
                    keyExtractor={r => r.id}
                    emptyStateMessage={isAssociateFinance
                        ? 'Nothing assigned to you right now. Finance sends payments to you from this queue.'
                        : 'No indents currently awaiting payment.'}
                    {...(canAssignPayments ? {
                        selectedIds: paySel.selectedIds,
                        onToggleSelect: paySel.toggleSelect,
                        onToggleSelectAllVisible: paySel.toggleSelectAllVisible,
                    } : {})}
                />
                <div className="px-6 pb-2">
                    <Pagination currentPage={paymentF.page} totalPages={paymentF.totalPages} onPageChange={paymentF.setPage} />
                </div>
            </div>

            {/* Customs duty — any indent in transit (currency-agnostic). Two
                purchases per indent (internal + international); Finance pays each. */}
            {pendingCustomsDuties.length > 0 && (
                <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
                    <div className="px-6 py-3 border-b border-line-soft bg-violet-50 dark:bg-violet-400/15">
                        <h3 className="text-sm font-bold text-violet-900 dark:text-violet-200">Customs duty ({pendingCustomsDuties.length})</h3>
                        <p className="text-xs text-violet-700 dark:text-violet-300 mt-0.5">Duty raised by procurement on international indents in transit. Pay each, then record the transaction.</p>
                    </div>
                    <div className="divide-y divide-line-soft">
                        {customsPager.pageRows.map((p: any) => {
                            const ind = p.indent || {};
                            const hasDetail = !!(ind.customsDocumentationNotes || ind.customsDeliveryOrderChaNotes || ind.customsDutyAwb || ind.customsDutyShippingAgent || ind.customsDutyShippingBill);
                            const open = expandedDuties.has(p.id);
                            return (
                            <div key={p.id} className="px-6 py-3">
                                <div className="flex items-center justify-between gap-3 flex-wrap">
                                    <div className="text-sm">
                                        <span className="font-mono font-bold text-ink">{ind.serialNo}</span>
                                        <span className="ml-2 text-muted">{p.kind === 'INTERNAL' ? 'Other payments' : 'Customs duty'}</span>
                                        <span className="ml-2 font-bold text-ink">{p.currency} {Number(p.amount).toLocaleString('en-IN')}</span>
                                        {ind.customsDutyAwb && <span className="ml-2 text-[11px] text-faint">AWB {ind.customsDutyAwb}</span>}
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button onClick={() => toggleDutyDetail(p.id)}
                                            className="text-[11px] font-bold text-violet-700 dark:text-violet-300 hover:text-violet-900 dark:text-violet-200 inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-violet-50 dark:bg-violet-400/15">
                                            <ChevronDown size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
                                            {open ? 'Hide details' : 'Clearance details'}
                                        </button>
                                        {/* Customs duty is Finance / Super Admin only on the server
                                            (Associate Finance pays indents, not duty). */}
                                        {canMarkPaid && !isAssociateFinance ? (
                                            <button onClick={() => { setDutyPayRow(p); setDutyTxnId(''); setDutyReceipt(null); if (dutyFileRef.current) dutyFileRef.current.value = ''; }}
                                                className="text-xs font-bold bg-violet-600 text-white px-3 py-1.5 rounded-md hover:bg-violet-700 transition-colors shadow-sm">Mark paid</button>
                                        ) : (
                                            <span className="text-[11px] italic text-faint">View only</span>
                                        )}
                                    </div>
                                </div>
                                {open && (
                                    <div className="mt-3 rounded-lg border border-violet-100 dark:border-violet-400/25 bg-violet-50/40 dark:bg-violet-400/15 p-3 space-y-3 text-xs">
                                        {/* Documentation — free-text import notes procurement logged. */}
                                        <div>
                                            <p className="font-bold text-violet-900 dark:text-violet-200 uppercase tracking-wider text-[10px] mb-1">Documentation</p>
                                            {ind.customsDocumentationNotes
                                                ? <p className="text-ink whitespace-pre-wrap">{ind.customsDocumentationNotes}</p>
                                                : <p className="italic text-faint">Not recorded.</p>}
                                        </div>
                                        {/* Delivery Order — the CHA (Custom House Agent) slip. */}
                                        <div>
                                            <p className="font-bold text-violet-900 dark:text-violet-200 uppercase tracking-wider text-[10px] mb-1">Delivery order (CHA slip)</p>
                                            {ind.customsDeliveryOrderChaNotes
                                                ? <p className="text-ink whitespace-pre-wrap">{ind.customsDeliveryOrderChaNotes}</p>
                                                : <p className="italic text-faint">No CHA slip yet.</p>}
                                        </div>
                                        {/* Duty — shipment detail the duty is raised against. */}
                                        <div>
                                            <p className="font-bold text-violet-900 dark:text-violet-200 uppercase tracking-wider text-[10px] mb-1">Duty detail</p>
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                                                <div><span className="text-faint">Airway bill (AWB)</span><br /><span className="text-ink font-medium">{ind.customsDutyAwb || '—'}</span></div>
                                                <div><span className="text-faint">Shipping agent</span><br /><span className="text-ink font-medium">{ind.customsDutyShippingAgent || '—'}</span></div>
                                                <div><span className="text-faint">Shipping bill</span><br /><span className="text-ink font-medium">{ind.customsDutyShippingBill || '—'}</span></div>
                                            </div>
                                        </div>
                                        {!hasDetail && <p className="italic text-faint">Procurement hasn't recorded clearance detail for this indent yet.</p>}
                                    </div>
                                )}
                            </div>
                            );
                        })}
                    </div>
                    <div className="px-6 py-2 border-t border-line-soft">
                        <Pagination currentPage={customsPager.page} totalPages={customsPager.totalPages} onPageChange={customsPager.setPage} />
                    </div>
                </div>
            )}

            {/* Customs-duty pay modal — reuses the txn id + receipt pattern. */}
            <Modal isOpen={!!dutyPayRow} onClose={() => setDutyPayRow(null)} title={dutyPayRow ? `Pay customs duty — ${dutyPayRow.indent.serialNo}` : 'Pay customs duty'}>
                {dutyPayRow && (
                    <div className="space-y-3">
                        <div className="text-sm bg-violet-50 dark:bg-violet-400/15 border border-violet-200 dark:border-violet-400/30 rounded-md px-3 py-2">
                            <span className="font-bold">{dutyPayRow.kind === 'INTERNAL' ? 'Other payments' : 'Customs duty'}</span> · {dutyPayRow.currency} {Number(dutyPayRow.amount).toLocaleString('en-IN')}
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-muted mb-1">Transaction ID *</label>
                            <input type="text" value={dutyTxnId} onChange={e => setDutyTxnId(e.target.value)} required
                                className="w-full border border-line rounded-md py-1.5 px-3 text-sm focus:border-brand outline-none" placeholder="UTR / NEFT / cheque no." />
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-muted mb-1">Receipt / challan (PDF or image)</label>
                            <input ref={dutyFileRef} type="file" accept={RECEIPT_ACCEPT}
                                onChange={e => setDutyReceipt(e.target.files?.[0] || null)}
                                className="w-full text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-brand file:text-white file:font-bold file:cursor-pointer" />
                            {dutyReceipt && <p className="text-[10px] text-muted mt-1">📎 {dutyReceipt.name}</p>}
                        </div>
                        <div className="flex justify-end gap-2">
                            <button onClick={() => setDutyPayRow(null)} disabled={dutySubmitting} className="text-xs font-bold text-muted px-3 py-1.5 rounded-md hover:bg-hover disabled:opacity-50">Cancel</button>
                            <button onClick={submitDutyPayment} disabled={dutySubmitting} className="text-xs font-bold bg-violet-600 text-white px-3 py-1.5 rounded-md hover:bg-violet-700 disabled:opacity-50">{dutySubmitting ? 'Paying…' : 'Mark paid'}</button>
                        </div>
                    </div>
                )}
            </Modal>

            {/* Live overview (in-flight only) — inline so finance can scan
                indents still moving through the pipeline alongside the
                awaiting-payment queue. Delivered/dead ones live behind the
                History button (opens a focused modal with CSV/PDF export). */}
            <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
                <div className="px-6 py-3 border-b border-line-soft flex items-center justify-between gap-3">
                    <div>
                        <h3 className="text-sm font-bold text-ink">All Other Indents ({overviewP.total})</h3>
                        <p className="text-xs text-muted mt-0.5">Read-only view of indents still in progress. Received, rejected &amp; cancelled ones move to History.</p>
                    </div>
                    <button
                        onClick={() => setIsHistoryOpen(true)}
                        className="text-xs font-bold text-brand-700 hover:text-ink border border-brand-200 hover:bg-brand-100/60 rounded px-3 py-1.5 transition-colors whitespace-nowrap"
                        title="Open the history view — received &amp; cancelled indents (download CSV inside)"
                    >
                        History
                    </button>
                </div>
                <DataTable
                    columns={overviewColumns}
                    data={overviewF.pageRows}
                    isLoading={overviewP.isLoading}
                    keyExtractor={r => r.id}
                    emptyStateMessage="No indents found."
                />
                <div className="px-6 pb-2">
                    <Pagination currentPage={overviewF.page} totalPages={overviewF.totalPages} onPageChange={overviewF.setPage} />
                </div>
            </div>

            {/* History modal — the delivered/dead archive (RECEIVED +
                REJECTED + CANCELLED), with Download CSV. Triggered from the
                History button in the section header. */}
            <Modal size="2xl" isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} title={`Indent History (${historyP.serverTotal})`}>
                <div className="space-y-3">
                    {/* Audit-grade export — date-range filter, CSV / List PDF
                        / Detailed PDF, server-rendered + tamper-evident. */}
                    <ExportPanel kind="indents" />
                    {/* Its own server bucket (status: RECEIVED,CANCELLED,REJECTED),
                        fetched lazily via historyP.enabled = isHistoryOpen so
                        the default page load doesn't pay for it. The CSV
                        export still covers the full org set. */}
                    <DataTable
                        columns={historyColumns}
                        data={historyF.pageRows}
                        isLoading={historyP.isLoading}
                        keyExtractor={r => r.id}
                        emptyStateMessage="No past indents."
                    />
                    <LoadAllCapNote truncated={historyP.truncated} shown={historyP.items.length} total={historyP.serverTotal} />
                    <Pagination currentPage={historyF.page} totalPages={historyF.totalPages} onPageChange={historyF.setPage} />
                </div>
            </Modal>

            {/* Mark as Paid Modal */}
            <PaymentModal
                row={payRow}
                onClose={closePayModal}
                vendorDisplay={vendorDisplay}
                payAllocations={payAllocations}
                payItems={payItems}
                allocLoading={allocLoading}
                voForms={voForms}
                setVoForm={setVoForm}
                voSubmitting={voSubmitting}
                onSubmitVendorPayment={submitVendorPayment}
                voSelected={voSelected}
                setVoSelected={setVoSelected}
                voFileRefs={voFileRefs}
                txnId={txnId}
                setTxnId={setTxnId}
                receipts={receipts}
                setReceipts={setReceipts}
                fileRef={fileRef}
                notes={notes}
                setNotes={setNotes}
                onSubmitPayment={submitPayment}
                submitting={submitting}
                vaultPassword={vaultPassword}
                setVaultPassword={setVaultPassword}
                vaultUnlocking={vaultUnlocking}
                setVaultUnlocking={setVaultUnlocking}
                vaultMatches={vaultMatches}
                setVaultMatches={setVaultMatches}
                vaultRevealed={vaultRevealed}
                setVaultRevealed={setVaultRevealed}
                vaultError={vaultError}
                setVaultError={setVaultError}
                onLockVault={lockVault}
                onBumpVaultIdle={bumpVaultIdle}
                addToast={addToast}
            />

            {/* Payment Receipt — read-only view of a paid indent. Opens
                on row click in the All Other Indents table. Lets finance
                audit any past payment: vendor breakdown, txn id, receipt
                screenshot, who paid + when, payment method procurement
                chose. No fetches — all data is already on the row from
                the list endpoint include. */}
            <PaymentReceiptModal
                row={viewRow}
                onClose={closeViewModal}
                vendorDisplay={vendorDisplay}
                onUpdateRefund={(r) => { setRefundRow(r); closeViewModal(); }}
                timelineOpen={viewTimelineOpen}
                timelineLoading={viewTimelineLoading}
                timelineLoaded={viewTimelineLoaded}
                timelineError={viewTimelineError}
                timeline={viewTimeline}
                onToggleTimeline={toggleTimeline}
                onLoadTimeline={loadTimeline}
            />

            {/* Refund-update modal — opened from "Update refund" inside the
                receipt modal. Same component procurement uses; whichever
                role acts first updates the state. */}
            <RefundStatusModal
                isOpen={!!refundRow}
                onClose={() => setRefundRow(null)}
                row={refundRow}
                submitting={refundSubmitting}
                onSubmit={submitRefundUpdate}
                onUpdated={() => { fetchIndents(); window.dispatchEvent(new Event('indents-updated')); }}
            />
        </div>
    );
};
