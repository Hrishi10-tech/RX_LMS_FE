import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { client } from '@/api';
import { DataTable, LoadAllCapNote, Modal, BulkSelectionBar, BulkActionButton, ColumnFilter, ConfirmDialog, RejectionReasonModal, PendingCell, Pagination, ExportPanel, BomProvenanceChip } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { runPerId } from '@/utils/bulk';
import { useAuth, useBulkSelection, useTableFilters, useClientPagination, useRowDeepLink, useAbortOnUnmount, FilterSpec } from '@/hooks';
import { fmtDateTime, dateOnlyKey } from '@/utils/date';
import { needsCeoSignoff, ceoLaneVisible, isCeoApprovalRequired, ceoThresholdLabel, ceoThresholdMoney, ceoGateCoversEverything, APPROVER_ROLES, TERMINAL_INDENT_STATUSES } from '@/config/thresholds';
import { statusReasonForIndent } from '@/utils/pendingReason';
import { IndentReviewModal } from '../components/IndentReviewModal';
import { IndentTrackModal } from '@/features/indents/components/IndentTrackModal';
import { ComponentRequestReviewModal } from '@/features/requests/components/ComponentRequestReviewModal';
import { ComponentRequestTrackModal } from '@/features/requests/components/ComponentRequestTrackModal';
import { ViewReceiptLink } from '@/features/indents/components/ViewReceiptLink';
import { Eye, Clock, FileText } from 'lucide-react';
import { BomApprovalSlipModal, BomHistorySection, bomListsApi } from '@/features/bom-lists';
import { PendingExtensionsSection } from '../components/PendingExtensionsSection';
import { auditColumns } from '../components/auditColumns';
import { BomQueueSection } from '../components/BomQueueSection';
import { TechApprovalCell } from '../components/TechApprovalCell';
import { CeoApprovalCell } from '../components/CeoApprovalCell';
import { UserRole } from '@/types';

// What the Items and Payment cells show, as text for their column filters.
const itemNames = (r: any) => { const n = (r?.items || []).map((it: any) => it.name).filter(Boolean); return n.length ? n : 'No items'; };
const paymentLabel = (r: any) => r.paymentTransactionId || (r.status === 'AWAITING_PAYMENT' ? 'Awaiting Finance' : '—');

export const ApprovalsPage = () => {
    const [pendingIndents, setPendingIndents] = useState<any[]>([]);
    const [pastIndents, setPastIndents] = useState<any[]>([]);
    const [pendingRequests, setPendingRequests] = useState<any[]>([]);
    // Past = any component request whose approval decision was already made
    // (status ≠ PENDING). Drives the per-section History modals so each
    // section's audit is one click away from where the decision lives.
    const [pastRequests, setPastRequests] = useState<any[]>([]);
    // The server's totals for the two History buttons. Counting the loaded
    // rows capped both at 200 — and the requests one counted only the non-BOM
    // rows among those 200, a number that matched nothing.
    const [pastRequestsTotal, setPastRequestsTotal] = useState(0);
    const [bomHistoryTotal, setBomHistoryTotal] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    // One open-flag per section's history modal. Replaces the single global
    // history button that only showed indent history.
    // BOM history is now a real surface again: a cross-BOM list of DECIDED
    // BOMs (routed / rejected / mid-route), role-scoped server-side. Each row
    // opens the read-only slip + its per-version Timeline — the "find an old
    // BOM" entry point an approver can't get from the creator-scoped BOM
    // Lists page.
    const [requestHistoryOpen, setRequestHistoryOpen] = useState(false);
    const [indentHistoryOpen, setIndentHistoryOpen] = useState(false);
    // History rows are fetched on demand (see fetchIndentHistory). The count on
    // the History button comes from the server's `total` on a 1-row probe, so
    // the button is still accurate without the page carrying the archive.
    const [pastIndentsTotal, setPastIndentsTotal] = useState(0);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [bomHistoryOpen, setBomHistoryOpen] = useState(false);
    const [bomHistory, setBomHistory] = useState<any[]>([]);
    // Read by the fetchers, which are also called from event listeners that
    // would otherwise see the open/closed state of the render they were made in.
    const requestHistoryOpenRef = useRef(false);
    const bomHistoryOpenRef = useRef(false);
    // False from opening until its rows arrive, so the modal says "Loading"
    // rather than flashing "no history yet".
    const [requestHistoryLoaded, setRequestHistoryLoaded] = useState(false);
    const [bomHistoryLoaded, setBomHistoryLoaded] = useState(false);
    // The indent the approver is currently reviewing — read-only modal with
    // purpose / responsible persons / item-level justifications. Without this,
    // admins were approving blind.
    const [reviewIndent, setReviewIndent] = useState<any | null>(null);
    // Same shared Track modal used everywhere else (user IP/Requests, history,
    // procurement indents). Keeps the audit experience identical regardless of
    // which page the viewer opened the indent from.
    const [trackIndent, setTrackIndent] = useState<any | null>(null);
    // Component-request View/Track — same shared modals used on Team Approvals
    // and My Components, so the read-only detail + timeline experience is
    // identical wherever a request row is shown. reviewRequestId drives a
    // self-fetching detail modal; trackRequest passes the row for the timeline.
    const [reviewRequestId, setReviewRequestId] = useState<string | null>(null);
    const [trackRequest, setTrackRequest] = useState<any | null>(null);
    const [searchParams, setSearchParams] = useSearchParams();
    const [filter, setFilter] = useState(searchParams.get('filter') || 'all');
    const { addToast } = useToast();
    const { user } = useAuth();
    const isSuperAdmin = user?.role === UserRole.SUPER_ADMIN;
    // Only department ADMINs can give tech approval on an indent — the backend
    // enforces this and 403s anyone else, so the buttons should not be shown
    // to MANAGER/USER/etc. either (otherwise they get a useless "Forbidden" toast).
    // SUPER_ADMIN sees the read-only ApprovalCell since they don't act in the
    // tech lane; CEO lane has its own super-admin-only buttons further down.
    const canTechApprove = user?.role === UserRole.ADMIN;
    const canViewReceipts = ['SUPER_ADMIN', 'FINANCE', 'PROCUREMENT', 'ADMIN', 'ASSOCIATE_FINANCE'].includes(user?.role || '');
    // SUPER_ADMIN deliberately excluded — the CEO lane is for INDENTS only
    // (the ≥₹20k threshold). Component requests are the manager/admin
    // approval surface, not super-admin. Hiding the Component Requests +
    // BOM Slips sections on the super-admin's /approvals page removes
    // empty noise; they can still see all request activity (audit-only)
    // on /super-admin/team-approvals.
    const canApproveRequests = ['ADMIN', 'MANAGER'].includes(user?.role || '');
    const requestsSel = useBulkSelection();

    // Re-entrancy guard: focus + visibilitychange + custom events can fire
    // back-to-back (browser quirks, devtools open, multi-monitor). Without
    // this, every event used to spawn a duplicate fetch + a duplicate toast
    // on failure. One in-flight request at a time is plenty.
    const fetchingRef = useRef(false);
    const fetchIndents = async () => {
        if (fetchingRef.current) return;
        fetchingRef.current = true;
        setIsLoading(true);
        try {
            // For MANAGER (and any non-admin role): personal queue only —
            // indents the user created or is an RP on. A manager has no
            // legitimate need to see a random coworker's indent detail
            // just because they share a department; that's information
            // leakage. Direct reports' indents live on Team Approvals,
            // not here.
            //
            // ADMIN / PROCUREMENT / FINANCE / SUPER_ADMIN keep the
            // existing wider scope — those roles are genuine approvers
            // or operational owners.
            const usePersonalScope = !APPROVER_ROLES.includes(user?.role || '');
            // Hard cap the payload — Approvals page re-fetches on focus
            // + visibility events, so an unbounded list grows the page
            // load over the lifetime of the account. 200 is the API's
            // own default; passing it explicitly here also future-proofs
            // us against the default changing on the backend.
            const params: Record<string, string> = usePersonalScope
              ? { createdByMe: 'true', take: '200' }
              : { take: '200' };
            // Terminal indents (RECEIVED / REJECTED / CANCELLED) are only ever
            // rendered inside the History modal, but they used to arrive on
            // every page load and every focus re-fetch — and they are the
            // bucket that grows forever, so they were also the rows most likely
            // to push a live approval past the 200 cap and out of sight.
            // The main fetch now asks the server for the in-flight set only;
            // history is fetched when the modal opens (see fetchIndentHistory).
            const { data } = await client.get('/indents', {
                params: { ...params, excludeStatus: TERMINAL_INDENT_STATUSES.join(',') },
            });
            const all = data.data?.items || data.data || [];
            // Layout: the main "Indents" table shows EVERYTHING that's still
            // in-flight — PENDING approvals up top, then in-progress procurement
            // (APPROVED / QUOTATION_IN_PROGRESS / AWAITING_PAYMENT / ORDERED /
            // IN_TRANSIT / PAYMENT_DONE) — so admins can see what happens to
            // their approvals downstream and a re-priced indent re-appearing
            // for re-approval is visible without having to hunt for it.
            // History modal shows only the truly-settled indents.
            const PRIORITY: Record<string, number> = {
                PENDING: 0,
                APPROVED: 1,
                QUOTATION_IN_PROGRESS: 2,
                AWAITING_PAYMENT: 3,
                PAYMENT_DONE: 4,
                ORDERED: 5,
                IN_TRANSIT: 6,
                PARTIALLY_RECEIVED: 7,
            };
                // Already terminal-free server-side; the sort is the approval-lane
            // ordering the table renders in.
            const inFlight = all.slice()
                .sort((a: any, b: any) => (PRIORITY[a.status] ?? 99) - (PRIORITY[b.status] ?? 99));
            setPendingIndents(inFlight);
            // Keep the History button's count live, and refresh the rows too if
            // the modal happens to be open when a decision lands. The count-only
            // probe asks for one row and reads the server's `total`.
            void fetchIndentHistory({ countOnly: !indentHistoryOpen });
        } catch (e: any) {
            // Surface the real error instead of swallowing it — the previous
            // bare catch stacked "Failed to fetch indents" toasts every time
            // the focus/visibility/approvals-updated event fired, with no clue
            // about WHAT was actually failing. The axios interceptor maps
            // errors to AppError so e.message is the user-facing string.
            console.error('[fetchIndents]', e);
            addToast(extractErrorMessage(e, 'Failed to fetch indents'), 'error');
        } finally {
            setIsLoading(false);
            fetchingRef.current = false;
        }
    };

    // Terminal indents, fetched only when the History modal is opened — and
    // re-fetched while it is open after a decision, so a just-rejected indent
    // appears without a reload. Scoped exactly like the in-flight fetch above
    // so the viewer sees the same set of indents either way.
    const fetchIndentHistory = async (opts: { countOnly?: boolean } = {}) => {
        const usePersonalScope = !APPROVER_ROLES.includes(user?.role || '');
        const base: Record<string, string> = usePersonalScope ? { createdByMe: 'true' } : {};
        const params = { ...base, status: TERMINAL_INDENT_STATUSES.join(','), take: opts.countOnly ? '1' : '200' };
        if (!opts.countOnly) setHistoryLoading(true);
        try {
            const { data } = await client.get('/indents', { params });
            const payload = data.data ?? data ?? {};
            const rows = payload.items ?? (Array.isArray(payload) ? payload : []);
            setPastIndentsTotal(typeof payload.total === 'number' ? payload.total : rows.length);
            if (!opts.countOnly) setPastIndents(rows);
        } catch {
            // Non-fatal: the History modal renders its own empty state.
        } finally {
            if (!opts.countOnly) setHistoryLoading(false);
        }
    };

    const fetchRequests = async () => {
        if (!canApproveRequests) return;
        try {
            // Same personal-scope rule as indents above. For MANAGER (and
            // other non-admin roles), restrict to requests the user
            // created or is an RP on. Team requests (where the manager
            // is the approver of record) live on Team Approvals — not
            // here. ADMIN keeps the dept-wide view because they actually
            // approve across the whole administered dept.
            const usePersonalScope = !APPROVER_ROLES.includes(user?.role || '');
            // Same hard cap as the indents fetch — see comment above.
            const base: Record<string, string> = usePersonalScope ? { createdByMe: 'true' } : {};
            // The queue is asked for by status and read to the end. It used to
            // take the newest 200 requests of ANY status and filter PENDING
            // here, so once 200 newer requests existed an older pending one
            // simply never appeared — while the sidebar badge still counted it.
            const rowsOf = (data: any) => data.data?.items || data.data || [];
            const pending: any[] = [];
            for (let skip = 0; ; skip += 200) {
                const { data } = await client.get('/requests', { params: { ...base, status: 'PENDING', take: '200', skip: String(skip) } });
                const page = rowsOf(data);
                pending.push(...page);
                if (page.length < 200) break;
            }
            // Non-BOM only (BOM requests are shown under their BOM), filtered
            // server-side so `total` is the real count. Rows only while History
            // is open; closed, one row is enough for the button's count — the
            // same probe the indent history uses. It was 200 rows on every visit.
            const { data: pastData } = await client.get('/requests', {
                params: { ...base, excludeStatus: 'PENDING', regularOnly: 'true', take: requestHistoryOpenRef.current ? '200' : '1' },
            });
            const pastRows = rowsOf(pastData);
            setPendingRequests(pending);
            if (requestHistoryOpenRef.current) { setPastRequests(pastRows); setRequestHistoryLoaded(true); }
            const pastTotal = pastData?.data?.total;
            setPastRequestsTotal(typeof pastTotal === 'number' ? pastTotal : pastRows.length);
        } catch {
            // Silent — Requests section just renders empty.
        }
    };

    // BOM approval queue — single stage. One manager/admin sign-off clears
    // the whole BOM, so there's one queue of SUBMITTED BOMs awaiting approval.
    //
    // SCOPE: the personal Approvals page only carries the viewer's OWN /
    // responsible-person work. For a MANAGER the approval queue is ENTIRELY
    // their direct reports' BOMs (team work) — those now live on the Team
    // Approvals page, so we skip the fetch here and the BOM card never renders
    // for a manager. SUPER_ADMIN is the same: the CEO console is for indents
    // ≥ ₹20,000 only — BOMs are a manager/admin job, and the CEO's org-wide
    // BOM oversight already lives on Team Approvals. Only ADMIN keeps the BOM
    // card here (dept-scoped approver work on their own console).
    const [bomManagerQueue, setBomManagerQueue] = useState<any[]>([]);
    const fetchBomQueues = async () => {
        if (user?.role === UserRole.MANAGER || user?.role === UserRole.SUPER_ADMIN) { setBomManagerQueue([]); setBomHistory([]); return; }
        try {
            // Live pending queue + decided-BOM history in parallel — same
            // role-scoping server-side, so the History button always reflects
            // exactly the BOMs this approver could have acted on.
            // History rows only while its modal is open; otherwise one row,
            // for the button's count (see fetchRequests).
            const [mgr, hist] = await Promise.all([
                bomListsApi.approvalsManager().catch(() => ({ items: [] })),
                bomListsApi.approvalsManagerHistory(bomHistoryOpenRef.current ? {} : { take: 1 }).catch(() => ({ items: [] })),
            ]);
            setBomManagerQueue(mgr?.items || []);
            if (bomHistoryOpenRef.current) { setBomHistory(hist?.items || []); setBomHistoryLoaded(true); }
            setBomHistoryTotal(typeof hist?.total === 'number' ? hist.total : (hist?.items || []).length);
        } catch {
            // Silent — section just renders empty.
        }
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial fetch of all three queues, runs once on mount
    useEffect(() => { fetchIndents(); fetchRequests(); fetchBomQueues(); }, []);

    // Opening a History modal loads its rows; the closed state only counts.
    useEffect(() => {
        requestHistoryOpenRef.current = requestHistoryOpen;
        setRequestHistoryLoaded(false);
        if (requestHistoryOpen) void fetchRequests();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the modal opening only
    }, [requestHistoryOpen]);
    useEffect(() => {
        bomHistoryOpenRef.current = bomHistoryOpen;
        setBomHistoryLoaded(false);
        if (bomHistoryOpen) void fetchBomQueues();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the modal opening only
    }, [bomHistoryOpen]);

    // Refetch when the user returns to this tab. Without this, an admin with
    // the Approvals page open in a background tab wouldn't see procurement-
    // triggered bounces (or other approvers' actions) until they manually
    // refreshed — leading to stale "Approved" rows that confused users into
    // thinking the system was broken.
    useEffect(() => {
        // Refetch only when the tab becomes visible again. We deliberately do
        // NOT also listen on window 'focus': the two events double-fire on a
        // tab return (each fired all 3 queues → up to 6 calls), and a bare
        // window-focus without a tab switch doesn't need a refresh.
        // visibilitychange alone covers the "came back to this background tab"
        // case the refetch exists for.
        const onVisible = () => {
            if (document.visibilityState === 'visible') {
                fetchIndents(); fetchRequests(); fetchBomQueues();
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- registers the visibility listener once on mount; the fetch* helpers are stable for this purpose and re-registering would churn the listener
    }, []);

    useEffect(() => {
        const f = searchParams.get('filter');
        if (f) {
            setFilter(f);
            setSearchParams({}, { replace: true });
            return;
        }
        // For the SUPER_ADMIN (CEO), default the indent filter pill to
        // "CEO Approval" since that's the only lane they personally act on
        // (≥ ₹20k indents waiting for sign-off). They can still click
        // "All Pending" to see everything in flight.
        if (user?.role === UserRole.SUPER_ADMIN) {
            setFilter('ceo');
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- runs only on role change to seed the default filter; searchParams/setSearchParams are read imperatively and must not retrigger this seed
    }, [user?.role]);

    // ?openRequest=<id> from a component-request notification. ADMIN and
    // SUPER_ADMIN are sent here by NotificationsPage, but the param was never
    // read, so the card navigated to a queue of many rows with no indication
    // which one it meant.
    const highlightId = useRowDeepLink({
        param: 'openRequest',
        ready: !isLoading,
        onMissing: () =>
            addToast(
                "That request is no longer in the pending queue — it looks like it's already been decided.",
                'info',
            ),
    });

    // Deep-link from a BOM approval notification: ?openBom=<id> opens that
    // BOM's approval slip directly. The slip modal fetches the BOM by id, so
    // this works even for admins or for a BOM no longer in the manager queue.
    useEffect(() => {
        const openBom = searchParams.get('openBom');
        if (openBom) {
            openSlip(openBom);
            const next = new URLSearchParams(searchParams);
            next.delete('openBom');
            setSearchParams(next, { replace: true });
        }
    }, [searchParams, setSearchParams]);

    const deepLinkAbort = useAbortOnUnmount();
    // Deep-link from an indent approval notification: ?openIndent=<id>. The
    // "Tech approval needed — IND-xxx" ping lands here, so this must open a
    // surface the approver can actually act on (the previous lack of a handler
    // made the link inert). Routing mirrors the page's own logic:
    //   • A freshly-spawned BOM indent (still PENDING, no vendor allocations)
    //     is acted on from its PARENT BOM's approval slip — that's where those
    //     indents are surfaced (see slipIndentBoms) and where the Tech/CEO
    //     approve + reject buttons live. Open that slip by bomListId.
    //   • Every other indent (ad-hoc, or one that has detached into its own
    //     procurement lifecycle) opens the IndentReviewModal, which wires the
    //     same approve/reject actions by role + status.
    // We fetch the indent by id so the link resolves regardless of which page
    // of the (take=200-capped) list it would land on — mirrors how the BOM
    // slip self-fetches by id.
    //
    // Cancelled on unmount only. It used to be cancelled by its own cleanup:
    // removing ?openIndent below changes searchParams, the effect re-ran, and
    // the cleanup threw away the indent it had just asked for — so the link
    // landed on the list and the review never opened.
    useEffect(() => {
        const openIndent = searchParams.get('openIndent');
        if (!openIndent) return;
        client.get(`/indents/${openIndent}`, { signal: deepLinkAbort() })
            .then(({ data }) => {
                const ind = data?.data ?? data;
                if (!ind) return;
                const bomId = ind.bomListId || ind.bomList?.id;
                if (bomId && isInitialSpawnBomIndent(ind)) {
                    openSlip(bomId);
                } else {
                    setReviewIndent(ind);
                }
            })
            // Stale / out-of-scope id — leave the page as the approver left it.
            .catch(() => undefined);
        const next = new URLSearchParams(searchParams);
        next.delete('openIndent');
        setSearchParams(next, { replace: true });
    }, [searchParams, setSearchParams]);

    const filteredPending = useMemo(() => pendingIndents.filter((req) => {
        if (filter === 'tech') return req.techApprovalStatus === 'PENDING';
        // ceoLaneVisible, not needsCeoSignoff — the CEO's queue keeps listing
        // high-value indents they may still act on even when nothing waits on them.
        if (filter === 'ceo') return req.techApprovalStatus === 'APPROVED' && req.ceoApprovalStatus === 'PENDING' && ceoLaneVisible(req);
        return true;
    }), [pendingIndents, filter]);

    // Pending indent table — Tech/CEO/Status columns deliberately skip per-column filters because
    // the pill filter above already narrows by tech/ceo, and every row is PENDING by definition.
    const indentFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'indentNo',    getValue: (r) => r.serialNo },
        { key: 'date',        getValue: (r) => dateOnlyKey(r.createdAt) },
        { key: 'department',  getValue: (r) => r.department?.name || 'Unknown' },
        { key: 'project',     getValue: (r) => r.project?.name || 'General / Others' },
        { key: 'amount',      getValue: (r) => `${r.currency} ${r.grandTotal?.toLocaleString() ?? ''}` },
        { key: 'requestedBy', getValue: (r) => r.createdBy?.name },
        // A filter on every other data column (owner, 27 Oct).
        { key: 'items',       getValue: itemNames },
        { key: 'payment',     getValue: paymentLabel },
    ], []);

    const requestFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'requestNo',   getValue: (r) => r.serialNo },
        { key: 'item',        getValue: (r) => r.inventoryItem?.name },
        { key: 'qty',         getValue: (r) => r.qtyRequested },
        { key: 'requestedBy', getValue: (r) => r.createdBy?.name },
        { key: 'department',  getValue: (r) => r.department?.name },
        // Keyed 'nature' to match the field and every other surface; it was
        // 'purpose', which collides with the genuine free-text purpose on
        // indents and BOM lines.
        { key: 'nature',      getValue: (r) => r.nature === 'TEMPORARY' ? `Temporary (${r.durationValue} ${(r.durationUnit || '').toLowerCase()})` : 'Permanent' },
        { key: 'date',        getValue: (r) => dateOnlyKey(r.createdAt) },
    ], []);

    const historyFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'indentNo',   getValue: (r) => r.serialNo },
        { key: 'department', getValue: (r) => r.department?.name || 'Unknown' },
        { key: 'amount',     getValue: (r) => `${r.currency} ${r.grandTotal?.toLocaleString() ?? ''}` },
        { key: 'tech',       getValue: (r) => r.techApprovalStatus },
        { key: 'ceo',        getValue: (r) => (ceoLaneVisible(r) ? r.ceoApprovalStatus : 'N/A') },
        { key: 'status',     getValue: (r) => r.status },
        { key: 'items',      getValue: itemNames },
    ], []);

    // Group EVERYTHING from a BOM into one slip — requests AND the spawned
    // procurement indent. Without this an indent-only BOM (no in-stock items,
    // all custom/back-ordered lines) becomes invisible at the slip level
    // because there are no component requests to bulk-approve. The slip
    // modal then shows requests in one block + indents in another, with
    // appropriate actions per layer (managers approve requests, admins
    // also approve indents).
    const groupByBom = (reqs: any[], indents: any[]) => {
        const byBom = new Map<string, { requests: any[]; indents: any[]; meta: any }>();
        const adHocReqs: any[] = [];
        const adHocIndents: any[] = [];

        const ensureSlot = (id: string, source: any) => {
            if (!byBom.has(id)) {
                byBom.set(id, {
                    requests: [],
                    indents: [],
                    meta: {
                        id,
                        serialNo: source.bomList.serialNo,
                        name: source.bomList.name,
                        project: source.project,
                        department: source.department,
                        createdBy: source.createdBy,
                        submittedAt: source.createdAt,
                    },
                });
            }
            return byBom.get(id)!;
        };

        for (const r of reqs) {
            if (r.bomListId && r.bomList?.serialNo) {
                ensureSlot(r.bomListId, r).requests.push(r);
            } else {
                adHocReqs.push(r);
            }
        }
        for (const i of indents) {
            if (i.bomListId && i.bomList?.serialNo) {
                ensureSlot(i.bomListId, i).indents.push(i);
            } else {
                adHocIndents.push(i);
            }
        }

        const slips = Array.from(byBom.values()).map(slot => ({
            ...slot.meta,
            requests: slot.requests,
            indents: slot.indents,
        }));
        slips.sort((a, b) => (new Date(b.submittedAt).getTime()) - (new Date(a.submittedAt).getTime()));
        return { adHocReqs, adHocIndents, slips };
    };

    // Split BOM-bound rows out of the ad-hoc tables so the same item
    // doesn't appear in two places. BOM-bound requests/indents now flow
    // through the new whole-BOM approval modal (driven by the queue
    // endpoints below). The legacy `bomSlips` grouping is gone — under
    // deferred-split, no PENDING request has a bomListId at the time
    // it lands here (those only spawn at routing, already APPROVED).
    // Requests ARE split out of their BOM grouping — spawned component requests
    // land pre-APPROVED, so none are ever PENDING here; only genuine ad-hoc
    // requests reach this table.
    const adHocRequests = useMemo(
        () => groupByBom(pendingRequests, []).adHocReqs,
        [pendingRequests],
    );

    // A BOM's freshly-spawned procurement indent belongs to that BOM's slip —
    // NOT the loose Indents table. It's "initial spawn" while it's still
    // PENDING and procurement hasn't touched it (no vendor allocations yet) —
    // a window that spans BOTH the tech approval (ADMIN) and the CEO sign-off
    // (SUPER_ADMIN): status stays PENDING until both are done (see
    // indent-approval.checkAndAutoTransition). The instant procurement starts
    // quoting — or it bounces back for firm-price re-approval, which already
    // carries its own "📦 BOM-xxx" + "Re-approval at firm quote" badges and the
    // quote-review modal — it detaches into its own procurement lifecycle and
    // reappears as a normal indent row. Only approvers who can actually act on
    // it (ADMIN = tech, SUPER_ADMIN = CEO) get the slip routing; every other
    // role's table is left exactly as-is (no regression to their personal view).
    const canRouteIndentToSlip = canTechApprove || isSuperAdmin;
    const isInitialSpawnBomIndent = (i: any) =>
        !!i.bomList?.serialNo && i.status === 'PENDING' && (i.vendorAllocations?.length ?? 0) === 0;
    // Which approver's slip queue an initial-spawn indent belongs in: ADMIN runs
    // the tech gate on every indent → all of them; SUPER_ADMIN only ever signs
    // off the ≥ ₹20k ones (CEO gate), so under-threshold indents — which the CEO
    // never touches — are left in the table as before (read-only to them), not
    // surfaced as dead cards in their queue.
    const routesToSlip = (i: any) => {
        if (!isInitialSpawnBomIndent(i)) return false;
        if (canTechApprove) return true;
        if (isSuperAdmin) return ceoLaneVisible(i);
        return false;
    };

    // The Indents table drops the slip-routed initial-spawn BOM indents; they're
    // reachable + actionable from the "Indent approval" lane of the BOM
    // Approvals card below instead. This is what kills the old "red dot, nothing
    // to approve" dead-end: the badge still counts the indent, and now there's a
    // visible card to act on it — just grouped under its BOM, not loose.
    const tableIndents = useMemo(
        () => filteredPending.filter((i) => !routesToSlip(i)),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- routesToSlip is a render-scope helper whose inputs (canRouteIndentToSlip) are already listed; recomputes with the same deps
        [filteredPending, canRouteIndentToSlip],
    );
    const indentsF = useTableFilters(tableIndents, indentFilterSpecs);

    // Group those slip-routed indents by their BOM → one card per BOM that opens
    // the approval slip (where the indent's tech/CEO approve + reject live).
    // Derived from the pre-pill `pendingIndents` so the card shows regardless of
    // which Tech/CEO/All pill is active (the pill only narrows the loose table).
    const slipIndentBoms = useMemo(() => {
        if (!canRouteIndentToSlip) return [];
        const byBom = new Map<string, any>();
        for (const i of pendingIndents) {
            if (!routesToSlip(i)) continue;
            const id = i.bomListId;
            if (!byBom.has(id)) {
                byBom.set(id, {
                    id,
                    serialNo: i.bomList.serialNo,
                    name: i.bomList.name || i.bomList.serialNo,
                    project: i.project,
                    department: i.department,
                    createdBy: i.createdBy,
                    submittedAt: i.createdAt,
                    items: [] as any[],
                    // The BOM is already ROUTED here — what's pending is its
                    // indent. This viewer only has a decision left if one of
                    // those indents is on THEIR gate: tech (ADMIN) or, for a
                    // ≥threshold indent, CEO (SUPER_ADMIN). An admin who has
                    // tech-approved a ₹20k+ indent that's now awaiting CEO has
                    // nothing left to decide → the card flips to "View approved
                    // BOM" instead of "Review & decide".
                    viewerHasPendingGate: false,
                });
            }
            const slot = byBom.get(id);
            slot.items.push(...(i.items || []));
            const pendingForViewer =
                (canTechApprove && i.techApprovalStatus === 'PENDING') ||
                (isSuperAdmin && i.ceoApprovalStatus === 'PENDING' && needsCeoSignoff(i));
            if (pendingForViewer) slot.viewerHasPendingGate = true;
        }
        return Array.from(byBom.values()).sort(
            (a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime(),
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps -- routesToSlip is a render-scope helper whose inputs (canRouteIndentToSlip) are already listed; recomputes with the same deps
    }, [pendingIndents, canRouteIndentToSlip]);

    const { pastAdHocRequests } = useMemo(() => {
        const { adHocReqs } = groupByBom(pastRequests, []);
        return { pastAdHocRequests: adHocReqs };
    }, [pastRequests]);
    const requestsF = useTableFilters(adHocRequests, requestFilterSpecs);
    const historyF = useTableFilters(pastIndents, historyFilterSpecs);

    // Client-side pagination (documented fallback). These queues are grouped/
    // computed: ad-hoc rows are what's left after BOM-bound rows are pulled out
    // by groupByBom, and the fetches are already hard-capped at take=200. So we
    // render 10 rows per table to keep the DOM bounded (the crash vector) while
    // the cap bounds memory. Each pager resets to page 1 when its filter changes.
    const requestsPager = useClientPagination(requestsF.filteredRows, 10, JSON.stringify(requestsF.filters));
    const indentsPager  = useClientPagination(indentsF.filteredRows, 10, JSON.stringify(indentsF.filters));
    const historyPager  = useClientPagination(historyF.filteredRows, 10, JSON.stringify(historyF.filters));
    const pastReqPager  = useClientPagination(pastAdHocRequests, 10);
    // Open-slip state — drives the new whole-BOM approval modal.
    // The modal fetches its own data via bomListsApi.get(id), so we
    // don't need a parent-side lookup map any more.
    const [openSlipId, setOpenSlipId] = useState<string | null>(null);
    // Whether the open slip is read-only. History rows open it purely to
    // inspect (no approve / reject / revoke / indent actions); the live queue
    // + the notification deep-link open it actionable. One modal, two modes.
    const [slipReadOnly, setSlipReadOnly] = useState(false);
    const openSlip = (id: string, ro = false) => { setSlipReadOnly(ro); setOpenSlipId(id); };

    // Modal state for rejections. `kind` tells the submit handler which endpoint to hit.
    // 'quote' is distinct from 'tech'/'ceo' — rejecting a quote sends the
    // indent back to procurement to re-quote, instead of killing the indent.
    const [rejectTarget, setRejectTarget] = useState<
        | { kind: 'tech'; id: string; serialNo: string }
        | { kind: 'ceo'; id: string; serialNo: string }
        | { kind: 'request'; id: string; serialNo: string }
        | { kind: 'quote'; id: string; serialNo: string; quotationId: string }
        | null
    >(null);
    const [rejectSubmitting, setRejectSubmitting] = useState(false);

    // Axios interceptor maps API errors to AppError instances, so the real
    // message lives on `e.message`, not `e.response.data.message`. Previously
    // every failure showed a generic "Failed" toast because we read the wrong
    // field. Also: refetch on ANY outcome — if the action raced (e.g. another
    // admin already approved), the UI must sync with reality so the buttons
    // don't keep tempting another click.
    // Ping the sidebar badge to recount after any approval action — without
    // this, the "Approvals: 1" pill lingers after the row has been actioned.
    // Also fire requests-updated: approving a component request drops it into
    // the inventory issue queue, whose badge (pendingInventoryRequests) only
    // refreshes on requests-updated — approvals-updated alone left it stale.
    const pingBadge = () => {
        window.dispatchEvent(new Event('approvals-updated'));
        window.dispatchEvent(new Event('requests-updated'));
    };

    // Admin picks the vendor(s) + qty split for multi-option items, then we
    // refetch the indent so the review modal re-renders without the alternatives
    // (and the Approve button unlocks).
    const handleSelectVendors = async (indentId: string, selections: { indentItemId: string; picks: { allocationId: string; qty: number }[] }[]) => {
        try {
            await client.post(`/indents/${indentId}/select-vendors`, { selections });
            addToast('Vendors selected', 'success');
            const { data } = await client.get(`/indents/${indentId}`);
            const fresh = data?.data ?? data;
            if (fresh) setReviewIndent(fresh);
            fetchIndents();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to select vendors'), 'error');
        }
    };

    // A MANAGER_REQUIRED department expects the manager to sign before the
    // admin. When they have not, the API answers 409 MANAGER_APPROVAL_PENDING
    // rather than refusing outright — the admin is told who has not signed and
    // can go ahead anyway. Held here so the retry can carry the confirmation.
    const [bypassPrompt, setBypassPrompt] = useState<
        { id: string; message: string; managerName: string | null } | null
    >(null);
    const [bypassSubmitting, setBypassSubmitting] = useState(false);

    const handleTechApprove = async (
        id: string,
        decision: 'APPROVED' | 'PENDING',
        bypassManagerApproval = false,
    ) => {
        try {
            await client.patch(`/indents/${id}/tech-approve`, { decision, ...(bypassManagerApproval ? { bypassManagerApproval: true } : {}) });
            addToast(`Tech approval: ${decision === 'PENDING' ? 'REVOKED' : decision}`, 'success');
            setBypassPrompt(null);
        } catch (e: any) {
            // Not an error to show as a red toast — it is a question. Surface
            // the dialog instead and leave the indent untouched. The axios
            // interceptor maps responses to AppError, so the server's own code
            // arrives on `details`, not on `response`.
            const details = e?.details;
            if (details?.code === 'MANAGER_APPROVAL_PENDING') {
                setBypassPrompt({ id, message: e.message, managerName: details?.data?.managerName ?? null });
                return;
            }
            addToast(extractErrorMessage(e, 'Action failed'), 'error');
        } finally {
            fetchIndents();
            pingBadge();
        }
    };

    const handleCeoApprove = async (id: string, decision: 'APPROVED' | 'PENDING') => {
        try {
            await client.patch(`/indents/${id}/ceo-approve`, { decision });
            addToast(`CEO approval: ${decision === 'PENDING' ? 'REVOKED' : decision}`, 'success');
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Action failed'), 'error');
        } finally {
            fetchIndents();
            pingBadge();
        }
    };

    // Which row is mid-approve. Without this a double-click fired two PATCHes:
    // the first approved the request, the second hit an already-APPROVED row and
    // surfaced a red "Cannot approve request in APPROVED state" toast that sat
    // there for 10 seconds next to a row that had, in fact, just been approved.
    const [approvingId, setApprovingId] = useState<string | null>(null);

    const handleApproveRequest = async (id: string) => {
        if (approvingId) return;
        setApprovingId(id);
        try {
            await client.patch(`/requests/${id}/approve`);
            addToast('Request approved', 'success');
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to approve'), 'error');
        } finally {
            // Resync on every outcome — if another approver just acted, the
            // buttons need to disappear so we don't lure into a stale click.
            setApprovingId(null);
            fetchRequests();
            pingBadge();
        }
    };

    // Fires when the RejectionReasonModal's Reject button is clicked. Routes to the right
    // endpoint based on `rejectTarget.kind`. Errors stay in the modal (modal stays open
    // via the early return) so the approver can correct and retry.
    const handleRejectionSubmit = async (reason: string) => {
        if (!rejectTarget) return;
        setRejectSubmitting(true);
        try {
            if (rejectTarget.kind === 'tech') {
                await client.patch(`/indents/${rejectTarget.id}/tech-approve`, { decision: 'REJECTED', reason });
                addToast('Tech rejection sent', 'success');
                fetchIndents();
            } else if (rejectTarget.kind === 'ceo') {
                await client.patch(`/indents/${rejectTarget.id}/ceo-approve`, { decision: 'REJECTED', reason });
                addToast('CEO rejection sent', 'success');
                fetchIndents();
            } else if (rejectTarget.kind === 'quote') {
                // Rejects the firm quote only — indent stays alive, procurement re-quotes.
                await client.post(`/quotations/${rejectTarget.quotationId}/reject`, { reason });
                addToast('Quote rejected — sent back to procurement to re-quote.', 'success');
                fetchIndents();
                pingBadge();
            } else {
                await client.patch(`/requests/${rejectTarget.id}/reject`, { reason });
                addToast('Request rejected', 'success');
                pingBadge();
                fetchRequests();
            }
            setRejectTarget(null);
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to reject'), 'error');
        } finally {
            setRejectSubmitting(false);
        }
    };

    const requestColumns: any[] = [
        { filterActive: requestsF.isActive('requestNo'),   header: <span className="inline-flex items-center">Request #<ColumnFilter searchable options={requestsF.getOptions('requestNo')}   value={requestsF.filters.requestNo   || ''} onChange={(v) => requestsF.setFilter('requestNo', v)}   /></span>, accessor: (row: any) => <span className="font-bold text-ink">{row.serialNo}</span> },
        { filterActive: requestsF.isActive('item'),        header: <span className="inline-flex items-center">Item<ColumnFilter searchable options={requestsF.getOptions('item')}                value={requestsF.filters.item        || ''} onChange={(v) => requestsF.setFilter('item', v)}        /></span>, accessor: (row: any) => <span className="text-sm text-ink">{row.inventoryItem?.name || 'Unknown'}</span> },
        { filterActive: requestsF.isActive('qty'),         header: <span className="inline-flex items-center">Qty<ColumnFilter options={requestsF.getOptions('qty')}                                value={requestsF.filters.qty         || ''} onChange={(v) => requestsF.setFilter('qty', v)}         /></span>, accessor: (row: any) => <span className="font-bold">{row.qtyRequested}</span> },
        { filterActive: requestsF.isActive('requestedBy'), header: <span className="inline-flex items-center">Requested By<ColumnFilter searchable options={requestsF.getOptions('requestedBy')} value={requestsF.filters.requestedBy || ''} onChange={(v) => requestsF.setFilter('requestedBy', v)} /></span>, accessor: (row: any) => <span className="text-sm">{row.createdBy?.name || 'Unknown'}</span> },
        { filterActive: requestsF.isActive('department'),  header: <span className="inline-flex items-center">Department<ColumnFilter options={requestsF.getOptions('department')}                  value={requestsF.filters.department  || ''} onChange={(v) => requestsF.setFilter('department', v)}  /></span>, accessor: (row: any) => row.department?.name || '-' },
        { filterActive: requestsF.isActive('nature'),      header: <span className="inline-flex items-center">Nature<ColumnFilter options={requestsF.getOptions('nature')}                          value={requestsF.filters.nature      || ''} onChange={(v) => requestsF.setFilter('nature', v)}      /></span>, accessor: (row: any) => row.nature === 'TEMPORARY' ? `Temporary (${row.durationValue} ${(row.durationUnit || '').toLowerCase()})` : 'Permanent' },
        { filterActive: requestsF.isActive('date'),        header: <span className="inline-flex items-center">Date<ColumnFilter searchable options={requestsF.getOptions('date')}                  value={requestsF.filters.date        || ''} onChange={(v) => requestsF.setFilter('date', v)}        /></span>, accessor: (row: any) => row.createdAt ? <span className="text-xs">{fmtDateTime(row.createdAt)}</span> : '-' },
        { header: 'Action', accessor: (row: any) => (
            <div className="flex gap-1">
                <button onClick={() => handleApproveRequest(row.id)} disabled={approvingId === row.id} className="px-2 py-1 text-xs font-bold bg-green-700 text-white rounded hover:bg-green-800 disabled:opacity-50 transition-colors">{approvingId === row.id ? 'Approving…' : 'Approve'}</button>
                <button onClick={() => setRejectTarget({ kind: 'request', id: row.id, serialNo: row.serialNo })} className="px-2 py-1 text-xs font-bold bg-red-600 text-white rounded hover:bg-red-700 transition-colors">Reject</button>
            </div>
        )},
        ...auditColumns((row: any) => setReviewRequestId(row.id), (row: any) => setTrackRequest(row)),
    ];

    // Renders the items on an indent row: first item + qty, then a `+N more`
    // chip hovering shows the full list. Approvers were having to click into
    // each indent to find out what was being approved — the most-important
    // signal was hidden two levels deep.
    const renderItemsCell = (row: any) => {
        const items: any[] = row?.items || [];
        if (items.length === 0) return <span className="text-faint text-xs italic">No items</span>;
        const first = items[0];
        const extra = items.length - 1;
        const tooltip = items.map((it: any) => `${it.name} × ${Number(it.qty)} ${it.unit || ''}`).join('\n');
        return (
            <span className="text-sm text-ink inline-flex items-center" title={tooltip}>
                <span className="font-medium">{first.name}</span>
                <span className="ml-1 text-muted text-xs">× {Number(first.qty)}{first.unit ? ` ${first.unit}` : ''}</span>
                {extra > 0 && (
                    <button type="button" onClick={() => setReviewIndent(row)}
                        title={`${tooltip}\n\nClick to see the full breakdown`}
                        className="ml-1.5 text-[10px] font-bold bg-brand/15 text-brand-700 px-1.5 py-0.5 rounded hover:bg-brand/25 transition-colors cursor-pointer">
                        +{extra} more
                    </button>
                )}
            </span>
        );
    };

    // Renders the Amount cell. When grandTotal is 0 the indent is a "price-TBD"
    // raise — the requester didn't know the price yet, and Procurement will
    // quote after approval. The backend's PO-sourcing gate (indents.service.ts)
    // catches any quoted amount >= CEO_APPROVAL_THRESHOLD by resetting CEO
    // approval and routing back here, so approving a ₹0 indent is safe.
    const renderAmountCell = (row: any) => {
        // SUBMITTED = procurement has explicitly pushed for re-approval. That
        // (or anything past quoting like AWAITING_PAYMENT / PAYMENT_DONE) is
        // when the firm quote becomes visible to approvers. DRAFT means
        // procurement is still iterating — show the original ask instead,
        // because what's currently in the quotation table is in-flux.
        const submittedQuotation = (row.quotations || []).find((q: any) => q.status === 'SUBMITTED');
        const draftQuotation    = (row.quotations || []).find((q: any) => q.status === 'DRAFT');
        const pastQuoting = !['PENDING', 'APPROVED', 'QUOTATION_IN_PROGRESS', 'REJECTED', 'CANCELLED'].includes(row.status);
        const firmTotal = submittedQuotation
            ? Number(submittedQuotation.grandTotal || 0)
            : pastQuoting
                ? Number(row.grandTotal || 0) // indent.grandTotal mirrors the last firm price by this point
                : 0;
        const showFirm = firmTotal > 0;
        const isProcurementIterating = !!draftQuotation && !submittedQuotation && row.status === 'QUOTATION_IN_PROGRESS';

        // Iterating without a submitted firm quote → tell the approver to
        // wait, don't surface the in-flux number.
        if (isProcurementIterating) {
            return (
                <span
                    className="inline-flex items-center gap-1 text-xs font-medium text-muted italic cursor-help"
                    title="Procurement is still iterating on prices. The firm quote will appear here once they push it for re-approval."
                >
                    Procurement quoting…
                </span>
            );
        }

        if (!showFirm) {
            return (
                <span
                    className="inline-flex items-center gap-1 text-xs font-bold text-amber-700 dark:text-amber-300 cursor-help"
                    title={`Requester didn't know the price. Procurement will quote after approval. ${ceoGateCoversEverything() ? 'Whatever it is quoted at, the indent will come back to the CEO automatically.' : `If the quoted amount crosses ${ceoThresholdMoney()} the indent will come back to the CEO automatically.`}`}
                >
                    Price TBD
                    <span className="text-[10px] bg-amber-100 dark:bg-amber-400/20 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded font-bold">?</span>
                </span>
            );
        }
        return (
            <div className="flex flex-col items-start gap-0.5">
                <span className="text-xs font-bold">{row.currency} {firmTotal.toLocaleString()}</span>
                <span className="text-[9px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-300">Firm quote</span>
            </div>
        );
    };

    // Column order is curated for scan-ability: identity (#, item) → money
    // (amount) → context (date, dept, project, requester) → action gates
    // (tech, ceo) → outcome (status). Header is "Indent" (not "Indent #") —
    // the hash was redundant with the IND-0xx serial in every cell.
    const columns: any[] = [
        { filterActive: indentsF.isActive('indentNo'),    header: <span className="inline-flex items-center">Indent<ColumnFilter searchable options={indentsF.getOptions('indentNo')}    value={indentsF.filters.indentNo    || ''} onChange={(v) => indentsF.setFilter('indentNo', v)}    /></span>, accessor: (row: any) => {
            // "Re-approval needed" badge: PENDING + has at least one vendor
            // allocation means procurement already quoted and the gate bounced
            // it back. Without this, admins couldn't tell a re-approval apart
            // from a brand-new approval.
            const isReapproval = row.status === 'PENDING' && (row.vendorAllocations?.length ?? 0) > 0;
            return (
                <div className="flex flex-col items-start gap-1">
                    <span className="font-bold text-ink">{row.serialNo}</span>
                    {/* BOM provenance — indent-only BOMs (no in-stock items,
                        only custom/out-of-stock lines bundled to procurement)
                        never appear in the BOM Slip section above because that
                        section is for component-request bulk-approve. Without
                        this chip, those BOMs are invisible to the admin. */}
                    {row.bomList?.serialNo && (
                        <BomProvenanceChip serialNo={row.bomList.serialNo} name={row.bomList.name} />
                    )}
                    {isReapproval && (
                        <span
                            title="Procurement has finalised the quotation. Approve again at the firm price below."
                            className="text-[10px] font-bold bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-400/30 px-1.5 py-0.5 rounded cursor-help"
                        >
                            Re-approval at firm quote
                        </span>
                    )}
                </div>
            );
        } },
        { filterActive: indentsF.isActive('items'),       header: <span className="inline-flex items-center">Items<ColumnFilter searchable options={indentsF.getOptions('items')}            value={indentsF.filters.items       || ''} onChange={(v) => indentsF.setFilter('items', v)}       /></span>, accessor: renderItemsCell },
        { filterActive: indentsF.isActive('amount'),      header: <span className="inline-flex items-center">Amount<ColumnFilter searchable options={indentsF.getOptions('amount')}          value={indentsF.filters.amount      || ''} onChange={(v) => indentsF.setFilter('amount', v)}      /></span>, accessor: renderAmountCell },
        { filterActive: indentsF.isActive('date'),        header: <span className="inline-flex items-center">Date<ColumnFilter searchable options={indentsF.getOptions('date')}            value={indentsF.filters.date        || ''} onChange={(v) => indentsF.setFilter('date', v)}        /></span>, accessor: (row: any) => row.createdAt ? <span className="text-xs">{fmtDateTime(row.createdAt)}</span> : '-' },
        { filterActive: indentsF.isActive('department'),  header: <span className="inline-flex items-center">Department<ColumnFilter options={indentsF.getOptions('department')}                value={indentsF.filters.department  || ''} onChange={(v) => indentsF.setFilter('department', v)}  /></span>, accessor: (row: any) => row.department?.name || 'Unknown' },
        { filterActive: indentsF.isActive('project'),     header: <span className="inline-flex items-center">Project<ColumnFilter options={indentsF.getOptions('project')}                     value={indentsF.filters.project     || ''} onChange={(v) => indentsF.setFilter('project', v)}     /></span>, accessor: (row: any) => row.project?.name || <span className="text-faint italic">General / Others</span> },
        { filterActive: indentsF.isActive('requestedBy'), header: <span className="inline-flex items-center">Requested By<ColumnFilter searchable options={indentsF.getOptions('requestedBy')} value={indentsF.filters.requestedBy || ''} onChange={(v) => indentsF.setFilter('requestedBy', v)} /></span>, accessor: (row: any) => row.createdBy?.name || 'Unknown' },
        { header: 'Tech Approval', accessor: (row: any) => (
            <TechApprovalCell
                row={row}
                canTechApprove={canTechApprove}
                onReviewIndent={setReviewIndent}
                onTechApprove={handleTechApprove}
                onRejectTech={(r: any) => setRejectTarget({ kind: 'tech', id: r.id, serialNo: r.serialNo })}
            />
        )},
        { header: 'CEO Approval', accessor: (row: any) => (
            <CeoApprovalCell
                row={row}
                isSuperAdmin={isSuperAdmin}
                onReviewIndent={setReviewIndent}
                onCeoApprove={handleCeoApprove}
                onRejectCeo={(r: any) => setRejectTarget({ kind: 'ceo', id: r.id, serialNo: r.serialNo })}
            />
        )},
        // Payment column — txn id + receipt link once Finance has marked the
        // indent paid. SUPER_ADMIN gets visibility here too so the CEO can
        // confirm what was actually paid without needing a Finance-role login.
        { filterActive: indentsF.isActive('payment'),     header: <span className="inline-flex items-center">Payment<ColumnFilter searchable options={indentsF.getOptions('payment')}        value={indentsF.filters.payment     || ''} onChange={(v) => indentsF.setFilter('payment', v)}     /></span>, accessor: (row: any) => {
            if (row.paymentTransactionId) {
                return (
                    <div className="flex flex-col items-start gap-0.5">
                        <span className="text-[10px] font-mono text-ink">{row.paymentTransactionId}</span>
                        {row.paidBy?.name && <span className="text-[10px] text-muted">by {row.paidBy.name}</span>}
                        {row.paidAt && <span className="text-[10px] text-faint">{fmtDateTime(row.paidAt)}</span>}
                        {/* The receipt file is Finance / Procurement / Admin / Super Admin
                            on the server — a manager clicking it got "not allowed". */}
                        {row.paymentReceiptPath && canViewReceipts && <ViewReceiptLink indentId={row.id} />}
                    </div>
                );
            }
            if (row.status === 'AWAITING_PAYMENT') return <span className="text-[11px] font-bold px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-400/30">Awaiting Finance</span>;
            return <span className="text-[10px] text-faint">—</span>;
        }},
        { header: 'Status', accessor: (row: any) => (
            // PendingCell renders the badge + an italic amber sub-line explaining
            // *why* the row is PENDING (e.g. "Awaiting Tech approval", "Awaiting
            // CEO sign-off"), so approvers don't have to cross-reference the
            // Tech/CEO columns to know what's blocking the row.
            <PendingCell status={row.status} reason={statusReasonForIndent(row)} />
        ) },
        // Read-only drill-downs: View → IndentReviewModal (purpose, responsibles,
        // emergency reason, full per-item justification — approvers need this
        // *before* hitting Approve/Reject); Track → status timeline.
        ...auditColumns(setReviewIndent, setTrackIndent),
    ];

    // History columns mirror the pending-indent layout so the eye doesn't have
    // to relearn the table when switching tabs.
    const historyColumns: any[] = [
        { filterActive: historyF.isActive('indentNo'),   header: <span className="inline-flex items-center">Indent<ColumnFilter searchable options={historyF.getOptions('indentNo')}   value={historyF.filters.indentNo   || ''} onChange={(v) => historyF.setFilter('indentNo', v)}   /></span>, accessor: (row: any) => (
            <div className="flex flex-col items-start gap-0.5">
                <span className="font-bold text-ink">{row.serialNo}</span>
                {row.bomList?.serialNo && (
                    <BomProvenanceChip serialNo={row.bomList.serialNo} name={row.bomList.name} />
                )}
            </div>
        ) },
        { filterActive: historyF.isActive('items'),      header: <span className="inline-flex items-center">Items<ColumnFilter searchable options={historyF.getOptions('items')}         value={historyF.filters.items      || ''} onChange={(v) => historyF.setFilter('items', v)}      /></span>, accessor: renderItemsCell },
        { filterActive: historyF.isActive('amount'),     header: <span className="inline-flex items-center">Amount<ColumnFilter searchable options={historyF.getOptions('amount')}       value={historyF.filters.amount     || ''} onChange={(v) => historyF.setFilter('amount', v)}     /></span>, accessor: renderAmountCell },
        { filterActive: historyF.isActive('department'), header: <span className="inline-flex items-center">Department<ColumnFilter options={historyF.getOptions('department')}                  value={historyF.filters.department || ''} onChange={(v) => historyF.setFilter('department', v)} /></span>, accessor: (row: any) => row.department?.name || 'Unknown' },
        { filterActive: historyF.isActive('tech'),       header: <span className="inline-flex items-center">Tech<ColumnFilter options={historyF.getOptions('tech')}                              value={historyF.filters.tech       || ''} onChange={(v) => historyF.setFilter('tech', v)}       /></span>, accessor: (row: any) => (
            <TechApprovalCell
                row={row}
                historyMode
                canTechApprove={canTechApprove}
                onReviewIndent={setReviewIndent}
                onTechApprove={handleTechApprove}
                onRejectTech={(r: any) => setRejectTarget({ kind: 'tech', id: r.id, serialNo: r.serialNo })}
            />
        )},
        { filterActive: historyF.isActive('ceo'),        header: <span className="inline-flex items-center">CEO<ColumnFilter options={historyF.getOptions('ceo')}                                value={historyF.filters.ceo        || ''} onChange={(v) => historyF.setFilter('ceo', v)}        /></span>, accessor: (row: any) => (
            <CeoApprovalCell
                row={row}
                historyMode
                isSuperAdmin={isSuperAdmin}
                onReviewIndent={setReviewIndent}
                onCeoApprove={handleCeoApprove}
                onRejectCeo={(r: any) => setRejectTarget({ kind: 'ceo', id: r.id, serialNo: r.serialNo })}
            />
        )},
        { filterActive: historyF.isActive('status'),     header: <span className="inline-flex items-center">Status<ColumnFilter options={historyF.getOptions('status')}                          value={historyF.filters.status     || ''} onChange={(v) => historyF.setFilter('status', v)}     /></span>, accessor: (row: any) => (
            // Rejected rows in history get their rejection reason on the
            // sub-line so admins reviewing past decisions don't have to open
            // each one to remember "why".
            <PendingCell status={row.status} reason={statusReasonForIndent(row)} />
        ) },
        ...auditColumns(setReviewIndent, setTrackIndent),
    ];

    // The subtitle describes what this page ACTUALLY shows the person reading
    // it, rather than a fixed description of the page in the abstract.
    //
    // It used to promise "Three sections … BOM slips first" to every
    // non-super-admin. A MANAGER never sees a BOM card here at all — their
    // BOM approvals are their reports' work and live on Team Approvals, so
    // fetchBomQueues skips the call entirely for them. They were told to look
    // for a section that cannot render, and the one place it does live went
    // unmentioned.
    // Only reached by the non-super-admin branch below, so MANAGER is the one
    // role that has to be distinguished: an ADMIN gets all three inputs to the
    // BOM block (own queue, history, and BOM-routed indents on their tech
    // gate), a MANAGER gets none of them.
    const showsBomSection = user?.role !== UserRole.MANAGER;
    const sectionBlurb = showsBomSection
        ? 'Three sections, each with its own history button — BOM slips first (most bulk), then ad-hoc component requests, then indents.'
        : 'Two sections, each with its own history button — ad-hoc component requests, then indents. BOM approvals for your team live under Team Approvals.';

    // The CEO bar is configurable in Settings, but this sentence hardcoded
    // "₹20,000" — the constant it had on the day it was written. Finance
    // moving the bar left the page quoting a figure the system no longer
    // enforces, which is worse than quoting none: an approver reads it as the
    // rule. Shared with Team Approvals, which had the identical literal.
    const ceoBar = ceoThresholdLabel();

    return (
        <div className="space-y-6">
            <div>
                <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Approvals</h2>
                <p className="text-sm md:text-[15px] text-muted mt-1.5">
                    {isSuperAdmin
                        ? (isCeoApprovalRequired()
                            ? `CEO approval queue — indents ${ceoBar} wait for your sign-off. Component requests are handled by managers + admins; the org-wide audit lives under Team Approvals.`
                            : `CEO review — indents ${ceoBar} show up here, but nothing waits on you: technical approval alone moves them forward. You can still step in and approve or reject any of them. Component requests are handled by managers + admins; the org-wide audit lives under Team Approvals.`)
                        : sectionBlurb}
                </p>
            </div>

            {/* Section order — most-batched first so the approver clears
                bulk work before drilling into ad-hoc rows:
                  1) BOM Approval Slips    (one batch per BOM)
                  2) Component Requests    (ad-hoc, individual)
                  3) Indents               (approval work)

                Each section has its own scroll container with a fixed
                max-height so all three stay visible on screen at once,
                even when one of them has hundreds of rows. */}

            {/* 1) BOM Approvals — two lanes, both opening the same whole-BOM slip
                (which owns the actions; we just open it and let it enforce the
                gate):
                  • "Awaiting approval" — SUBMITTED BOMs needing the one
                    manager/admin sign-off. Approving routes the whole BOM.
                  • "Indent approval"   — already-routed BOMs whose spawned
                    procurement indent is awaiting tech (ADMIN) / CEO
                    (SUPER_ADMIN) approval. Keeps the indent with its BOM
                    instead of stranding it as a loose row in the table below. */}
            {(bomManagerQueue.length > 0 || slipIndentBoms.length > 0 || bomHistoryTotal > 0) && (
                <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden mt-6">
                    <div className="px-6 py-3 border-b border-line-soft bg-surface flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                            <FileText size={16} className="text-brand shrink-0" />
                            <div className="min-w-0">
                                <h3 className="text-sm font-bold text-ink">BOM Approvals</h3>
                                <p className="text-xs text-muted mt-0.5">
                                    Decide a whole BOM in one slip. When you approve, in-stock lines go to inventory to issue and out-of-stock or custom lines go to procurement as one indent. That indent's own approval also happens here — no loose indent rows to chase.
                                </p>
                            </div>
                        </div>
                        <button
                            onClick={() => setBomHistoryOpen(true)}
                            className="shrink-0 bg-ink text-card text-xs font-bold px-3 py-1.5 rounded-md hover:bg-black transition-colors shadow-sm"
                            title="See decided BOMs (approved / rejected) and open any one's Timeline"
                        >
                            History{bomHistoryTotal > 0 ? ` (${bomHistoryTotal})` : ''}
                        </button>
                    </div>
                    {bomManagerQueue.length > 0 && (
                        <BomQueueSection
                            label="Awaiting approval"
                            stageTone="text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border-amber-200 dark:border-amber-400/30"
                            items={bomManagerQueue}
                            onOpen={(id: string) => openSlip(id)}
                        />
                    )}
                    {slipIndentBoms.length > 0 && (
                        <BomQueueSection
                            label="Indent approval"
                            stageTone="text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-400/15 border-sky-200 dark:border-sky-400/30"
                            items={slipIndentBoms}
                            onOpen={(id: string) => openSlip(id)}
                            cta={(b: any) => b.viewerHasPendingGate
                                ? { label: 'Review & decide →' }
                                : { label: 'View approved BOM →', muted: true }}
                        />
                    )}
                </div>
            )}

            {/* 2) Component Requests — ad-hoc only (BOM-bound ones grouped above) */}
            {canApproveRequests && (
                <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
                    <div className="px-6 py-3 border-b border-line-soft bg-surface flex items-start justify-between gap-2">
                        <div className="min-w-0">
                            <h3 className="text-sm font-bold text-ink">Component Requests</h3>
                            <p className="text-xs text-muted mt-0.5">
                                Pending ad-hoc component-issue requests from your team.
                            </p>
                        </div>
                        <button
                            onClick={() => setRequestHistoryOpen(true)}
                            className="shrink-0 bg-ink text-card text-xs font-bold px-3 py-1.5 rounded-md hover:bg-black transition-colors shadow-sm"
                            title="See ad-hoc requests you've already decided on"
                        >
                            History{pastRequestsTotal > 0 ? ` (${pastRequestsTotal})` : ''}
                        </button>
                    </div>
                    <div className="px-6 pt-3">
                        <BulkSelectionBar count={requestsSel.selectedIds.size} onClear={requestsSel.clearSelection}>
                            {/* Bulk approve — loops the same one-click POST the per-row
                                Approve button fires (no payload), so every backend approval
                                guard still runs per request. Best-effort: an already-decided
                                row just lands in the failed tally. Reject stays per-row — it
                                needs a typed reason, so there's no safe blanket version. */}
                            <BulkActionButton
                                label="Approve"
                                count={requestsSel.selectedIds.size}
                                verb="approved"
                                confirmTitle="Approve selected requests?"
                                confirmMessage={`Approve ${requestsSel.selectedIds.size} selected component request${requestsSel.selectedIds.size === 1 ? '' : 's'}? Each goes to the inventory desk to be issued. Already-decided rows are skipped.`}
                                onRun={() => runPerId([...requestsSel.selectedIds], (id) => client.patch(`/requests/${id}/approve`))}
                                onDone={() => { requestsSel.clearSelection(); fetchRequests(); pingBadge(); }}
                            />
                        </BulkSelectionBar>
                    </div>
                    <DataTable
                        columns={requestColumns}
                        data={requestsPager.pageRows}
                        isLoading={isLoading}
                        keyExtractor={r => r.id}
                        emptyStateMessage="No pending ad-hoc request approvals."
                        rowClassName={(r: any) => (r.id === highlightId ? 'bg-amber-100/70 dark:bg-amber-400/15' : '')}
                        maxHeight="35vh"
                        selectedIds={requestsSel.selectedIds}
                        onToggleSelect={requestsSel.toggleSelect}
                        onToggleSelectAllVisible={requestsSel.toggleSelectAllVisible}
                    />
                    <div className="px-6 pb-2">
                        <Pagination currentPage={requestsPager.page} totalPages={requestsPager.totalPages} onPageChange={requestsPager.setPage} />
                    </div>
                </div>
            )}

            {/* Extension Requests — loan extensions on issued components.
                Self-contained queue (fetches GET /extensions/pending); renders
                nothing when empty. Sits between request approvals and indents
                because it's the same kind of quick yes/no the approver clears.
                Shown only for ADMIN/SUPER_ADMIN, whose primary approval queue IS
                this page. MANAGERs clear extensions on Team Approvals (their
                personal Approvals page is createdByMe-scope), so rendering it
                here too just duplicated the same org-wide queue for them. */}
            {(user?.role === UserRole.ADMIN || user?.role === UserRole.SUPER_ADMIN) && <PendingExtensionsSection />}

            {/* 3) Indents — approval work (last because each indent decision
                often warrants more attention than the BOM/ad-hoc rows above).
                Header carries the Tech/CEO filter pills (they only apply here)
                + the indent-history button. */}
            <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
                <div className="px-6 py-3 border-b border-line-soft bg-surface flex items-center justify-between gap-3 flex-wrap">
                    <h3 className="text-sm font-bold text-ink">Indents</h3>
                    <div className="flex items-center gap-2 flex-wrap">
                        {/* Filter pills — moved here from the page header because
                            tech/CEO gating only applies to indents, not BOM slips
                            or component requests. */}
                        {[
                            { id: 'all', label: 'All Pending' },
                            { id: 'tech', label: 'Tech Approval' },
                            { id: 'ceo', label: 'CEO Approval' },
                        ].map(f => (
                            <button
                                key={f.id}
                                onClick={() => setFilter(f.id)}
                                className={`px-3 py-1 text-xs font-bold rounded-full transition-colors border ${
                                    filter === f.id
                                        ? 'bg-brand text-white border-brand shadow-sm'
                                        : 'bg-card text-muted border-line hover:bg-surface'
                                }`}
                            >
                                {f.label}
                            </button>
                        ))}
                        <button
                            onClick={() => { setIndentHistoryOpen(true); fetchIndentHistory(); }}
                            className="bg-ink text-card text-xs font-bold px-3 py-1.5 rounded-md hover:bg-black transition-colors shadow-sm"
                            title="See indents you've already decided on"
                        >
                            History{pastIndentsTotal > 0 ? ` (${pastIndentsTotal})` : ''}
                        </button>
                    </div>
                </div>
                <DataTable
                    columns={columns}
                    data={indentsPager.pageRows}
                    isLoading={isLoading}
                    keyExtractor={r => r.id}
                    emptyStateMessage="No pending indent approvals."
                    maxHeight="40vh"
                />
                <div className="px-6 pb-2">
                    <Pagination currentPage={indentsPager.page} totalPages={indentsPager.totalPages} onPageChange={indentsPager.setPage} />
                </div>
            </div>

            <BomApprovalSlipModal
                bomListId={openSlipId}
                readOnly={slipReadOnly}
                onClose={() => { setOpenSlipId(null); setSlipReadOnly(false); }}
                onProcessed={() => { fetchRequests(); fetchIndents(); fetchBomQueues(); pingBadge(); }}
            />

            {/* Indent approval history (existing) */}
            <Modal size="2xl" isOpen={indentHistoryOpen} onClose={() => setIndentHistoryOpen(false)} title="Indent Approval History">
                <div className="mb-3">
                    <ExportPanel kind="indents" status="RECEIVED,REJECTED,CANCELLED" />
                </div>
                <DataTable
                    columns={historyColumns}
                    data={historyPager.pageRows}
                    isLoading={historyLoading}
                    keyExtractor={r => r.id}
                    emptyStateMessage="No past indent approvals."
                />
                <Pagination currentPage={historyPager.page} totalPages={historyPager.totalPages} onPageChange={historyPager.setPage} />
            </Modal>

            {/* BOM history — cross-BOM list of DECIDED BOMs (routed / rejected
                / mid-route), role-scoped server-side. Each row opens the
                read-only slip, whose Timeline button carries the full
                per-version audit. Backed by a real backend query so it
                includes REJECTED BOMs the spawned-children view never saw. */}
            <Modal isOpen={bomHistoryOpen} onClose={() => setBomHistoryOpen(false)} title="BOM History">
                <div className="mb-3">
                    <ExportPanel kind="bom-lists" />
                </div>
                {!bomHistoryLoaded ? (
                    <div className="text-center text-faint py-6 text-sm">Loading…</div>
                ) : (<>
                <LoadAllCapNote truncated={bomHistoryTotal > bomHistory.length} shown={bomHistory.length} total={bomHistoryTotal} />
                <BomHistorySection
                    items={bomHistory}
                    onOpen={(id: string) => { setBomHistoryOpen(false); openSlip(id, true); }}
                />
                </>)}
            </Modal>


            {/* Component Request history — past ad-hoc requests, compact table. */}
            <Modal isOpen={requestHistoryOpen} onClose={() => setRequestHistoryOpen(false)} title="Component Request History">
                <div className="mb-3">
                    <ExportPanel kind="requests" excludeStatus="PENDING" />
                </div>
                <LoadAllCapNote truncated={requestHistoryLoaded && pastRequestsTotal > pastAdHocRequests.length} shown={pastAdHocRequests.length} total={pastRequestsTotal} />
                {!requestHistoryLoaded ? (
                    <div className="text-center text-faint py-6 text-sm">Loading…</div>
                ) : pastAdHocRequests.length === 0 ? (
                    <div className="text-center text-faint py-6 text-sm">No past ad-hoc request decisions yet.</div>
                ) : (
                    <div className="divide-y divide-line-soft max-h-[60vh] overflow-y-auto">
                        {pastReqPager.pageRows.map((r: any) => (
                            <div key={r.id} className="px-3 py-2.5 flex items-center gap-3 text-sm">
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-mono text-xs font-bold text-ink">{r.serialNo}</span>
                                        <span className="font-medium text-ink truncate">{r.inventoryItem?.name || 'Unknown'}</span>
                                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${
                                            r.status === 'REJECTED'
                                                ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30'
                                                : 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30'
                                        }`}>
                                            {r.status}
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-muted mt-0.5 truncate">
                                        <span className="font-bold">{r.createdBy?.name || 'Unknown'}</span>
                                        {r.department?.name && <> · {r.department.name}</>}
                                        <span className="text-faint"> · decided {r.approvedAt ? fmtDateTime(r.approvedAt) : '—'}</span>
                                        {r.rejectionReason && <> · <span className="italic text-red-700 dark:text-red-300">"{r.rejectionReason}"</span></>}
                                    </p>
                                </div>
                                <span className="font-mono text-xs font-bold text-ink shrink-0">
                                    {Number(r.qtyRequested)} {r.inventoryItem?.unit || ''}
                                </span>
                                <div className="flex gap-1 shrink-0">
                                    <button onClick={() => setReviewRequestId(r.id)} title="View details" className="px-2 py-1 text-xs font-bold bg-hover text-ink rounded hover:bg-line transition-colors inline-flex items-center gap-1"><Eye size={12} /> View</button>
                                    <button onClick={() => setTrackRequest(r)} title="Track timeline" className="px-2 py-1 text-xs font-bold bg-hover text-ink rounded hover:bg-line transition-colors inline-flex items-center gap-1"><Clock size={12} /> Track</button>
                                </div>
                            </div>
                        ))}
                        <Pagination currentPage={pastReqPager.page} totalPages={pastReqPager.totalPages} onPageChange={pastReqPager.setPage} />
                    </div>
                )}
            </Modal>

            <RejectionReasonModal
                isOpen={!!rejectTarget}
                onClose={() => !rejectSubmitting && setRejectTarget(null)}
                onSubmit={handleRejectionSubmit}
                entityLabel={
                    rejectTarget
                        ? rejectTarget.kind === 'request'
                            ? `Request ${rejectTarget.serialNo}`
                            : rejectTarget.kind === 'quote'
                                ? `Firm quote for ${rejectTarget.serialNo} (procurement will re-quote)`
                                : `Indent ${rejectTarget.serialNo}`
                        : ''
                }
                submitting={rejectSubmitting}
            />

            <IndentReviewModal
                indent={reviewIndent}
                onClose={() => setReviewIndent(null)}
                {...(() => {
                    if (!reviewIndent) return {};
                    const r = reviewIndent;
                    const activeQ = (r.quotations || []).find((q: any) => q.status === 'DRAFT' || q.status === 'SUBMITTED');
                    // Two distinct reject paths:
                    //   - "Send to re-quote" (quote-level): only valid when a
                    //     quotation exists. Indent stays alive, procurement
                    //     re-quotes.
                    //   - "Reject indent" (indent-level): always available.
                    //     Kills the entire indent.
                    // Rejecting a quote is Admin / Super Admin on the server.
                    const rejectQuoteAction = activeQ && (isSuperAdmin || canTechApprove)
                        ? () => { setRejectTarget({ kind: 'quote', id: r.id, serialNo: r.serialNo, quotationId: activeQ.id }); setReviewIndent(null); }
                        : undefined;
                    const rejectIndentAction = (kind: 'tech' | 'ceo') => () => {
                        setRejectTarget({ kind, id: r.id, serialNo: r.serialNo });
                        setReviewIndent(null);
                    };
                    // Tech approver path
                    if (canTechApprove && r.techApprovalStatus === 'PENDING') {
                        return {
                            actionLabel: activeQ ? 'Firm quote — Tech approval' : 'Tech approval',
                            onApprove: async () => { await handleTechApprove(r.id, 'APPROVED'); setReviewIndent(null); },
                            // Same server decision the table's button reads, so
                            // opening View is not a way round a disabled button.
                            approveBlockedReason: r.techApproveBlockedReason ?? null,
                            onSelectVendors: (selections) => handleSelectVendors(r.id, selections),
                            // Tech lane only: the dept admin can edit line quantities
                            // (+ vendor split) at approval. Requires an active quote.
                            canAdjust: !!activeQ,
                            onRejectQuote: rejectQuoteAction,
                            onRejectIndent: rejectIndentAction('tech'),
                        };
                    }
                    // CEO approver path
                    if (isSuperAdmin && r.ceoApprovalStatus === 'PENDING') {
                        const total = activeQ ? Number(activeQ.grandTotal || 0) : Number(r.grandTotal || 0);
                        // Amount test only — the CEO can still approve a
                        // high-value indent while their sign-off is optional.
                        if (ceoLaneVisible({ grandTotal: total, currency: r.currency })) {
                            return {
                                actionLabel: activeQ ? 'Firm quote — CEO approval' : 'CEO approval',
                                onApprove: async () => { await handleCeoApprove(r.id, 'APPROVED'); setReviewIndent(null); },
                                onSelectVendors: (selections) => handleSelectVendors(r.id, selections),
                                onRejectQuote: rejectQuoteAction,
                                onRejectIndent: rejectIndentAction('ceo'),
                            };
                        }
                    }
                    return {};
                })()}
            />

            <IndentTrackModal indent={trackIndent} onClose={() => setTrackIndent(null)} />

            <ComponentRequestReviewModal requestId={reviewRequestId} onClose={() => setReviewRequestId(null)} />
            <ComponentRequestTrackModal request={trackRequest} onClose={() => setTrackRequest(null)} />

            {/* Manager-first is an expectation in a MANAGER_REQUIRED
                department, not a wall. The admin is told who has not signed
                and decides; going ahead is recorded against their name. */}
            <ConfirmDialog
                isOpen={!!bypassPrompt}
                title="The manager has not approved this yet"
                confirmLabel="Approve anyway"
                cancelLabel="Wait for the manager"
                isLoading={bypassSubmitting}
                message={
                    <span>
                        {bypassPrompt?.managerName
                            ? <>This department expects <span className="font-bold">{bypassPrompt.managerName}</span> to approve first, and they have not yet.</>
                            : bypassPrompt?.message}
                        <br /><br />
                        You can go ahead — it will be recorded as approved without manager sign-off, under your name.
                    </span>
                }
                onClose={() => setBypassPrompt(null)}
                onConfirm={async () => {
                    if (!bypassPrompt) return;
                    setBypassSubmitting(true);
                    try {
                        await handleTechApprove(bypassPrompt.id, 'APPROVED', true);
                    } finally {
                        setBypassSubmitting(false);
                    }
                }}
            />
        </div>
    );
};
