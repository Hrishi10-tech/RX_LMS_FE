import { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { client } from '@/api';
import { DataTable, LoadAllCapNote, Modal, ColumnFilter, PendingCell, Pagination, ExportPanel, BomProvenanceChip } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { useTableFilters, FilterSpec, useAuth, useClientPagination, useAbortOnUnmount } from '@/hooks';
import { logError, extractErrorMessage } from '@/lib';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { CheckCircle2, ChevronRight, Clock, FileText, ShieldCheck, Users, XCircle } from 'lucide-react';
import { RejectionReasonModal } from '@/components/ui';
import { IndentReviewModal } from '../components/IndentReviewModal';
import { IndentTrackModal } from '@/features/indents/components/IndentTrackModal';
import { ComponentRequestReviewModal } from '@/features/requests/components/ComponentRequestReviewModal';
import { ComponentRequestTrackModal } from '@/features/requests/components/ComponentRequestTrackModal';
import { PendingExtensionsSection } from '../components/PendingExtensionsSection';
import { auditColumns } from '../components/auditColumns';
import { BomQueueSection } from '../components/BomQueueSection';
import { BomHistorySection } from '@/features/bom-lists';
import { BomApprovalSlipModal } from '@/features/bom-lists/components/BomApprovalSlipModal';
import { bomListsApi } from '@/features/bom-lists/services/bom-lists.api';
import { needsCeoSignoff, ceoLaneVisible, isCeoApprovalRequired, ceoThresholdLabel, ISSUED_STATUSES, TERMINAL_INDENT_STATUSES, ceoNotApplicableLabel, ceoNotApplicableTitle } from '@/config/thresholds';
import { UserRole } from '@/types';

// Where a signature can still be taken back — mirrors the server's revoke window.
/** The Manager column's word for an indent, as text — the cell and its filter share it. */
const managerStageLabel = (row: any): string => {
  if (row.managerApprovedBy?.name) return row.managerApprovedBy.name;
  if (row.managerApprovalStatus === 'REJECTED') return 'Rejected';
  if (row.managerApprovalBypassedBy?.name) return 'Bypassed';
  if (row.managerApprovalSkipped && row.techApprovedById && row.techApprovedById === row.createdById) return 'Not needed';
  if (row.managerApprovalSkipped) return 'No manager';
  return row.department?.indentApprovalMode === 'MANAGER_REQUIRED' ? 'Pending' : 'Not required';
};

const REVOCABLE_INDENT_STATUSES = ['PENDING', 'APPROVED', 'QUOTATION_IN_PROGRESS', 'AWAITING_PAYMENT'];

/**
 * Team audit view — shared by SUPER_ADMIN / ADMIN / MANAGER, with the
 * scope of the lens widening at each level:
 *
 *   - MANAGER    → GET /requests/team-approvals
 *     "Every request a USER on my team has raised."
 *   - ADMIN      → GET /requests/manager-approvals
 *     "Every request a MANAGER in my dept(s) has acted on."
 *   - SUPER_ADMIN → GET /requests/all-approvals
 *     "Every request, decided by anyone, anywhere in the org."
 *
 * One component, three lenses. Layout adapts per lens (super-admin gets
 * an org-wide summary card + approver-role column the others don't need).
 */
export const TeamApprovalsPage = () => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [rows, setRows] = useState<any[]>([]);
  // Indent audit data — only fetched on the super-admin lens, otherwise
  // the page focuses on component-request audit (existing behaviour).
  const [indentRows, setIndentRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Inline approve/reject — manager lens only. Approve component requests
  // raised by direct reports right from this page (the previous design
  // moved team requests here from the personal Approvals page, but did
  // not bring the approve/reject actions over, leaving managers with no
  // UI path to approve their team's requests).
  const [actingId, setActingId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<{ id: string; serialNo: string } | null>(null);
  // The row the View modal is deciding on, so it can report its own busy
  // state and close itself once the decision lands.
  const [reviewActing, setReviewActing] = useState(false);
  const [rejectSubmitting, setRejectSubmitting] = useState(false);
  // Indents have their own reject target: a different endpoint and a
  // different audience for the reason, so sharing one piece of state with the
  // request modal would only invite sending a reason to the wrong lane.
  const [indentRejectTarget, setIndentRejectTarget] = useState<{ id: string; serialNo: string } | null>(null);

  // History modals (manager lens). The main tables show only what's still
  // awaiting a decision; everything already approved/rejected moves behind a
  // History button per section — mirroring the personal Approvals page so the
  // pending queue doesn't stay cluttered with settled rows.
  const [requestHistoryOpen, setRequestHistoryOpen] = useState(false);
  const [indentHistoryOpen, setIndentHistoryOpen] = useState(false);
  // Super-admin BOM-slip History — closed-out BOMs (every spawned request +
  // indent has landed/rejected) move behind this button so the main list
  // stays the live queue, mirroring the request/indent History split.
  const [bomHistoryOpen, setBomHistoryOpen] = useState(false);
  // Manager lens BOM History — decided BOMs (routed / rejected) raised by the
  // manager's direct reports. Audit counterpart of the actionable queue; each
  // row opens the read-only slip + its per-version Timeline. Backed by the
  // role-scoped /approvals/manager/history endpoint (same scope as the queue).
  const [bomDecidedOpen, setBomDecidedOpen] = useState(false);
  const [bomDecided, setBomDecided] = useState<any[]>([]);
  // The server's total, not the rows loaded (one page of up to 200).
  const [bomDecidedTotal, setBomDecidedTotal] = useState(0);
  // Its rows are fetched on opening (up to 200 every visit before, unseen).
  const [bomDecidedLoaded, setBomDecidedLoaded] = useState(false);
  useEffect(() => {
    if (!bomDecidedOpen) { setBomDecidedLoaded(false); return; }
    let live = true;
    bomListsApi.approvalsManagerHistory()
      .then((res: any) => {
        if (!live) return;
        setBomDecided(res?.items || []);
        setBomDecidedTotal(typeof res?.total === 'number' ? res.total : (res?.items || []).length);
      })
      .catch((err) => { logError('TeamApprovals.fetchBomHistory', err); })
      .finally(() => { if (live) setBomDecidedLoaded(true); });
    return () => { live = false; };
  }, [bomDecidedOpen]);

  // Click-through on a BOM slip → BomApprovalSlipModal. Two modes, one state:
  //   - ACTIONABLE: the manager-lens "Awaiting approval" queue + the
  //     notification deep-link (a SUBMITTED team BOM the manager signs off).
  //   - READ-ONLY: every audit / history row (BOM Slips rollup, super-lens
  //     History, manager-lens decided-BOM History) — inspection only, no
  //     approve / reject / revoke / indent actions. `openSlip(id, readOnly)`
  //     sets both so the call site declares its intent explicitly.
  const [slipModalId, setSlipModalId] = useState<string | null>(null);
  const [slipReadOnly, setSlipReadOnly] = useState(false);
  const openSlip = (id: string, ro = false) => { setSlipReadOnly(ro); setSlipModalId(id); };

  // Manager lens: the actionable approval queue — SUBMITTED BOMs raised by the
  // manager's direct reports, awaiting their one sign-off. This is the team's
  // BOM work; it used to wrongly surface on the personal Approvals page. The
  // queue endpoint is already scoped to "BOMs created by users I manage", so
  // there's nothing extra to filter client-side.
  const [bomManagerQueue, setBomManagerQueue] = useState<any[]>([]);

  // Read-only drill-down for the indent audit table: View → IndentReviewModal
  // (purpose / responsibles / per-item justification), Track → IndentTrackModal
  // (status timeline). Both are read-only and mirror what the Approvals page
  // already offers on its indent rows — this audit view was just missing them.
  const [reviewIndent, setReviewIndent] = useState<any | null>(null);
  const [trackIndent, setTrackIndent] = useState<any | null>(null);
  // Same read-only drill-down for the COMPONENT-REQUEST audit table — every
  // lens (super/admin/manager) gets View (full detail) + Track (approval
  // timeline), matching what the indent table already offers.
  const [reviewRequestId, setReviewRequestId] = useState<string | null>(null);
  const [trackRequest, setTrackRequest] = useState<any | null>(null);

  // Role lens — drives endpoint + copy + column set.
  // FINANCE uses the manager lens: Finance is Associate Finance's manager, so
  // its "team" is the Associate Finance logins (managerScopeUserWhere).
  const isFinance = user?.role === UserRole.FINANCE;
  const lens: 'super' | 'admin' | 'manager' = user?.role === UserRole.SUPER_ADMIN
    ? 'super'
    : user?.role === UserRole.MANAGER || isFinance
    ? 'manager'
    : 'admin';

  const endpoint =
    lens === 'super'   ? '/requests/all-approvals' :
    lens === 'manager' ? '/requests/team-approvals' :
                         '/requests/manager-approvals';

  // Admin shares the manager's "live table + History modal" split: once a
  // request is issued/closed it drops out of the active list into History
  // instead of cluttering the audit. Super keeps the all-inclusive audit
  // table (it's an org-wide ledger with its own summary tiles).
  const usesHistorySplit = lens === 'manager' || lens === 'admin';

  const heading = 'Team Approvals';
  const subhead =
    lens === 'super'
      ? 'Every component-request AND indent decision across every department, by every approver. Includes pending, approved, and rejected. Org-wide audit — read only.'
      : isFinance
      ? 'Requests and indents raised by Associate Finance — you approve them as their manager. Pending, approved, or rejected.'
      : lens === 'manager'
      ? 'Every component request AND indent your team has raised — people in your department, plus anyone assigned to you. Pending, approved, or rejected.'
      : 'Every component request a manager in your department(s) has approved or rejected. Read-only audit.';

  const fetchRows = () => {
    setLoading(true);
    // Always fetch requests (the original behaviour).
    const reqsP = client.get(endpoint, { signal: abortSignal() })
      .then((res) => setRows(res.data?.data?.items || res.data?.data || []))
      .catch((err) => { logError('TeamApprovals.fetch', err); addToast('Failed to load request audit', 'error'); });

    // Indents audit:
    //   - Super-admin: every indent org-wide (/indents is already
    //     role-scoped to "see all" for SUPER_ADMIN).
    //   - Manager: indents from their team (teamScope=true — reports plus
    //     their department, resolved server-side). Manager's
    //     personal indents stay on the Approvals page; this view is
    //     oversight-only.
    //   - Admin: only BOM-bound indents in their department(s) — these feed
    //     the dept BOM slips below (an admin has no flat indent table, so an
    //     ad-hoc indent fetch would be wasted). `bomOnly=true` + the service's
    //     buildDepartmentScope keeps it to BOM indents the admin owns.
    // Hard cap to the API default so a long-lived org doesn't end up
    // pulling thousands of rows per page open. The page filters
    // client-side after this — if we ever exceed 200 in real usage,
    // it's a signal to switch this to server-side pagination, not
    // raise the cap.
    const indentsP =
      lens === 'super'
        ? client.get('/indents', { params: { take: '200' }, signal: abortSignal() })
            .then((res) => setIndentRows(res.data?.data?.items || res.data?.data || []))
            .catch((err) => { logError('TeamApprovals.fetchIndents', err); addToast('Failed to load indent audit', 'error'); })
        : lens === 'manager'
        ? client.get('/indents', { params: { teamScope: 'true', take: '200' }, signal: abortSignal() })
            .then((res) => setIndentRows(res.data?.data?.items || res.data?.data || []))
            .catch((err) => { logError('TeamApprovals.fetchIndents', err); addToast('Failed to load team indents', 'error'); })
        : client.get('/indents', { params: { bomOnly: 'true', take: '200' }, signal: abortSignal() })
            .then((res) => setIndentRows(res.data?.data?.items || res.data?.data || []))
            .catch((err) => { logError('TeamApprovals.fetchIndents', err); addToast('Failed to load BOM indents', 'error'); });

    // BOM approval queue. MANAGER lens = the ACTIONABLE queue (direct reports'
    // SUBMITTED BOMs they sign off) + decided history. SUPER lens = the same
    // endpoint, which the server scopes org-wide for a super-admin, but shown
    // READ-ONLY: the CEO oversees every pending BOM without acting (managers/
    // admins approve; the CEO only signs off indents ≥ ₹20k). ADMIN's pending
    // BOMs stay on their own Approvals page.
    const bomP =
      // Associate Finance raises no BOMs, so Finance has no BOM queue to fetch.
      isFinance
        ? Promise.resolve()
        : lens === 'manager'
        ? Promise.all([
            bomListsApi.approvalsManager()
              .then((res: any) => setBomManagerQueue(res?.items || []))
              .catch((err) => { logError('TeamApprovals.fetchBomQueue', err); setBomManagerQueue([]); }),
            // One row for the button's count; the rows load when History opens.
            bomListsApi.approvalsManagerHistory({ take: 1 })
              .then((res: any) => setBomDecidedTotal(typeof res?.total === 'number' ? res.total : (res?.items || []).length))
              .catch((err) => { logError('TeamApprovals.fetchBomHistory', err); }),
          ])
        : lens === 'super'
          ? bomListsApi.approvalsManager()
              .then((res: any) => setBomManagerQueue(res?.items || []))
              .catch((err) => { logError('TeamApprovals.fetchBomQueue', err); setBomManagerQueue([]); })
          : Promise.resolve();

    Promise.all([reqsP, indentsP, bomP]).finally(() => setLoading(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refetches rows when endpoint/lens change; fetchRows is a render-scope helper whose inputs are already the deps
  useEffect(() => { fetchRows(); }, [endpoint, lens]);

  // Notification deep-link: a manager's BOM approval notification routes to
  // /manager/team-approvals?openBom=<id>. Read the param, open the approval
  // slip (SUBMITTED team BOM → actionable), then strip it from the URL so a
  // refresh / back doesn't re-open the modal. Mirrors the personal Approvals
  // page's handler, but targets this page's slipModalId state.
  useEffect(() => {
    const openBom = searchParams.get('openBom');
    if (openBom) {
      openSlip(openBom);
      const next = new URLSearchParams(searchParams);
      next.delete('openBom');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Partition: BOM-bound rows roll up into one card per BOM, ad-hoc rows
  // render as the flat audit table. Includes BOTH component requests AND
  // procurement indents — an indent-only BOM (no in-stock items, only
  // custom/back-ordered lines) used to vanish from the BOM Slips section
  // because that section only counted ComponentRequests. Now the slip
  // shows the full BOM picture: requests + indents, with their own
  // approval lanes.
  const {
    adHocRows, adHocIndentRows, bomSlips,
    activeBomSlips, pastBomSlips,
    adHocPendingRows, adHocPastRows,
    adHocPendingIndentRows, adHocPastIndentRows,
  } = useMemo(() => {
    const byBom = new Map<string, { requests: any[]; indents: any[]; meta: any }>();
    const adHoc: any[] = [];
    const adHocInd: any[] = [];

    const ensure = (id: string, source: any) => {
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
          },
        });
      }
      return byBom.get(id)!;
    };

    for (const r of rows) {
      if (r.bomListId && r.bomList?.serialNo) ensure(r.bomListId, r).requests.push(r);
      else adHoc.push(r);
    }
    for (const i of indentRows) {
      if (i.bomListId && i.bomList?.serialNo) ensure(i.bomListId, i).indents.push(i);
      else adHocInd.push(i);
    }

    const slips = Array.from(byBom.values()).map(slot => {
      // In-stock request buckets, honest about physical fulfilment. APPROVED /
      // YET_TO_ISSUE are merely ROUTED to the stores team — not yet handed to the
      // requester — so they are "awaiting issue", NOT fulfilled. Only IN_USE
      // onward (incl. the post-issue terminals) means the stock actually reached
      // the requester. The old single "fulfilled" chip counted APPROVED too,
      // which read as "done" when nothing had been issued.
      const ISSUED_STATES = new Set(ISSUED_STATUSES);
      const issuedR   = slot.requests.filter(r => ISSUED_STATES.has(r.status)).length;
      const awaitingR = slot.requests.filter(r => r.status === 'APPROVED' || r.status === 'YET_TO_ISSUE').length;
      const rejectedR = slot.requests.filter(r => r.status === 'REJECTED').length;
      const pendingR  = slot.requests.filter(r => r.status === 'PENDING').length;
      const pendingI  = slot.indents.filter(i =>
        i.techApprovalStatus === 'PENDING' ||
        (i.techApprovalStatus === 'APPROVED' && i.ceoApprovalStatus === 'PENDING'),
      ).length;
      const recentAt = [...slot.requests, ...slot.indents].reduce((m: Date | null, r: any) => {
        const t = r.approvedAt ? new Date(r.approvedAt) : new Date(r.createdAt);
        return (!m || t > m) ? t : m;
      }, null);
      return {
        ...slot.meta,
        recentAt,
        requests: slot.requests,
        indents: slot.indents,
        issuedCount: issuedR,
        awaitingIssueCount: awaitingR,
        rejectedCount: rejectedR,
        pendingCount: pendingR,
        pendingIndentCount: pendingI,
      };
    });
    slips.sort((a, b) => (b.recentAt?.getTime() ?? 0) - (a.recentAt?.getTime() ?? 0));

    // Active vs closed-out split — drives the manager lens's "main table =
    // live queue, History = done" layout. The cut is NOT at approval: a
    // manager keeps overseeing an item after they approve it, right up until
    // it physically lands. Only then does it drop to History.
    //   • Requests: active through PENDING → APPROVED → YET_TO_ISSUE, i.e.
    //     until issued to the requester (IN_USE onward). Mirrors the backend's
    //     canonical "history = NOT (PENDING/APPROVED/YET_TO_ISSUE)" set
    //     (requests.service.ts ~L455). REJECTED is settled → History.
    //   • Indents: active through the entire procurement cycle (approval,
    //     quotation, payment, ordered, in-transit). They reach History only
    //     once RECEIVED at inventory — or REJECTED / CANCELLED (dead).
    const REQUEST_ACTIVE = new Set(['PENDING', 'APPROVED', 'YET_TO_ISSUE']);
    const INDENT_CLOSED = new Set(TERMINAL_INDENT_STATUSES);
    const reqPending = adHoc.filter((r: any) => REQUEST_ACTIVE.has(r.status));
    const reqPast = adHoc.filter((r: any) => !REQUEST_ACTIVE.has(r.status));
    const indPending = adHocInd.filter((i: any) => !INDENT_CLOSED.has(i.status));
    const indPast = adHocInd.filter((i: any) => INDENT_CLOSED.has(i.status));

    // BOM slip active/closed split (drives the super-admin BOM History). A
    // slip is closed only when EVERY spawned child has landed — all requests
    // out of the active set AND all indents in the closed set. One live child
    // keeps the whole BOM in the active list (matches the request/indent rule).
    const slipClosed = (s: any) =>
      s.requests.every((r: any) => !REQUEST_ACTIVE.has(r.status)) &&
      s.indents.every((i: any) => INDENT_CLOSED.has(i.status));
    const activeSlips = slips.filter((s) => !slipClosed(s));
    const pastSlips = slips.filter((s) => slipClosed(s));

    return {
      adHocRows: adHoc, adHocIndentRows: adHocInd, bomSlips: slips,
      activeBomSlips: activeSlips, pastBomSlips: pastSlips,
      adHocPendingRows: reqPending, adHocPastRows: reqPast,
      adHocPendingIndentRows: indPending, adHocPastIndentRows: indPast,
    };
  }, [rows, indentRows]);

  // SUPER_ADMIN summary tiles — combined totals across requests + indents,
  // grouped by status + by approver role. Lets the auditor scan the
  // org's health in 3 seconds before diving into row tables.
  const summary = useMemo(() => {
    if (lens !== 'super') return null;
    // Helpers — indents use a different status enum than requests; map both
    // into 3 buckets (approved / rejected / pending) for the totals.
    const indentBucket = (status: string) => {
      if (status === 'PENDING') return 'pending';
      if (status === 'REJECTED' || status === 'CANCELLED') return 'rejected';
      return 'approved'; // APPROVED, QUOTATION_IN_PROGRESS, AWAITING_PAYMENT, ORDERED, RECEIVED, etc.
    };
    const requestBucket = (status: string) =>
      status === 'PENDING' ? 'pending' :
      status === 'REJECTED' ? 'rejected' :
      'approved';

    const reqStats = { total: rows.length, approved: 0, rejected: 0, pending: 0 };
    for (const r of rows) reqStats[requestBucket(r.status) as keyof typeof reqStats] += 1;

    const indStats = { total: indentRows.length, approved: 0, rejected: 0, pending: 0 };
    for (const i of indentRows) indStats[indentBucket(i.status) as keyof typeof indStats] += 1;

    // Combined totals across both data types.
    const total = reqStats.total + indStats.total;
    const approved = reqStats.approved + indStats.approved;
    const rejected = reqStats.rejected + indStats.rejected;
    const pending = reqStats.pending + indStats.pending;

    // Approver-role breakdown across both. Indents have two approvers
    // (techApprovedBy + ceoApprovedBy); we attribute the indent to
    // whichever signed last (techApprovedBy as fallback if no ceo).
    const byRole = new Map<string, number>();
    for (const r of rows) {
      const role = r.approvedBy?.role;
      if (role) byRole.set(role, (byRole.get(role) || 0) + 1);
    }
    for (const i of indentRows) {
      const role = i.ceoApprovedBy?.role || i.techApprovedBy?.role || i.approvedBy?.role;
      if (role) byRole.set(role, (byRole.get(role) || 0) + 1);
    }

    // Pending queue by the role responsible for clearing it — the
    // forward-looking complement to "Decisions by approver role". Maps each
    // open item to whoever's sign-off it's waiting on:
    //   • a PENDING component request  → its requester's MANAGER
    //   • an indent awaiting Tech      → the dept ADMIN
    //   • an indent past Tech, awaiting CEO, ≥ ₹20k threshold → CEO
    // Insertion order (Manager → Admin → CEO) is the approval pipeline order,
    // which reads more naturally here than the decisions card's count-sort.
    const pendingByRole = new Map<string, number>();
    const pendingReq = rows.filter((r) => r.status === 'PENDING').length;
    if (pendingReq) pendingByRole.set('MANAGER', pendingReq);
    let techPending = 0;
    let ceoPending = 0;
    for (const i of indentRows) {
      if (i.techApprovalStatus === 'PENDING') techPending += 1;
      else if (
        i.techApprovalStatus === 'APPROVED' &&
        i.ceoApprovalStatus === 'PENDING' &&
        needsCeoSignoff(i)
      ) ceoPending += 1;
    }
    if (techPending) pendingByRole.set('ADMIN', techPending);
    if (ceoPending) pendingByRole.set('CEO', ceoPending);

    return {
      total, approved, rejected, pending,
      reqStats, indStats,
      byRole: Array.from(byRole.entries()).sort((a, b) => b[1] - a[1]),
      pendingByRole: Array.from(pendingByRole.entries()),
    };
  }, [rows, indentRows, lens]);

  // Per-column filters for the indents audit table.
  const indentFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
    { key: 'indentNo',    getValue: (r) => r.serialNo },
    { key: 'requester',   getValue: (r) => r.createdBy?.name || 'Unknown' },
    { key: 'tech',        getValue: (r) => r.techApprovedBy?.name || (r.techApprovalStatus === 'PENDING' ? 'Pending' : '—') },
    { key: 'ceo',         getValue: (r) => r.ceoApprovedBy?.name || (r.ceoApprovalStatus === 'PENDING' ? 'Pending' : '—') },
    { key: 'status',      getValue: (r) => r.status || 'UNKNOWN' },
    { key: 'dept',        getValue: (r) => r.department?.name || 'Unknown' },
    { key: 'project',     getValue: (r) => r.project?.name || 'General / Others' },
    // A filter on every data column (owner, 27 Oct).
    { key: 'items',       getValue: (r) => { const names = (r.items || []).map((it: any) => it.name).filter(Boolean); return names.length ? names : '—'; } },
    { key: 'amount',      getValue: (r) => r.grandTotal != null ? `${r.currency || 'INR'} ${Number(r.grandTotal).toLocaleString()}` : '—' },
    { key: 'manager',     getValue: managerStageLabel },
    { key: 'lastActivity', getValue: (r) => { const ts = r.approvedAt || r.updatedAt || r.createdAt; return ts ? fmtDate(ts) : '—'; } },
  ], []);
  // Indent table sees only AD-HOC indents — BOM-bound ones now live inside
  // their slip card, so showing them here too would be duplication and break
  // the "one slip per BOM" principle the user complained about.
  // Manager lens narrows the indent table to in-flight rows (anything not yet
  // RECEIVED/REJECTED/CANCELLED); received & dead ones live in the History
  // modal. Admin/super keep the full audit table.
  const indF = useTableFilters(lens === 'manager' ? adHocPendingIndentRows : adHocIndentRows, indentFilterSpecs);
  const indPager = useClientPagination<any>(indF.filteredRows, 10, JSON.stringify(indF.filters));
  const pastIndF = useTableFilters(adHocPastIndentRows, indentFilterSpecs);
  const pastIndPager = useClientPagination<any>(pastIndF.filteredRows, 10, JSON.stringify(pastIndF.filters));

  const buildIndentColumns = (indF: ReturnType<typeof useTableFilters<any>>, indPager: { page: number }) => {
    const indentColumns: any[] = [
      { header: 'S.No', accessor: (_r: any, idx?: number) => String((indPager.page - 1) * 10 + (idx ?? 0) + 1) },
      {
        filterActive: indF.isActive('indentNo'),
        header: <span className="inline-flex items-center">Indent #<ColumnFilter searchable options={indF.getOptions('indentNo')} value={indF.filters.indentNo || ''} onChange={(v) => indF.setFilter('indentNo', v)} /></span>,
        // BOM provenance chip — indent-only BOMs (no in-stock items, only
        // custom/out-of-stock lines bundled to procurement) never appear in
        // the "BOM Slips" section above because that's for component-request
        // bulk-approve. Without this chip those BOMs become invisible at the
        // org audit. Tooltip carries the BOM name for orientation.
        accessor: (row: any) => (
          <div className="flex flex-col items-start gap-0.5">
            <span className="font-mono text-xs font-bold text-ink">{row.serialNo}</span>
            {row.bomList?.serialNo && (
              <BomProvenanceChip serialNo={row.bomList.serialNo} name={row.bomList.name} />
            )}
          </div>
        ),
      },
      {
        filterActive: indF.isActive('requester'),
        header: <span className="inline-flex items-center">Requested by<ColumnFilter searchable options={indF.getOptions('requester')} value={indF.filters.requester || ''} onChange={(v) => indF.setFilter('requester', v)} /></span>,
        accessor: (row: any) => <span className="text-sm">{row.createdBy?.name || 'Unknown'}</span>,
      },
      {
        filterActive: indF.isActive('items'),
        header: <span className="inline-flex items-center">Items<ColumnFilter searchable options={indF.getOptions('items')} value={indF.filters.items || ''} onChange={(v) => indF.setFilter('items', v)} /></span>,
        accessor: (row: any) => {
          const items = row.items || [];
          if (items.length === 0) return <span className="text-xs italic text-faint">—</span>;
          return (
            <span className="text-xs text-ink" title={items.map((it: any) => `${it.name} × ${Number(it.qty)} ${it.unit || ''}`).join('\n')}>
              {items[0].name}{items.length > 1 && <span className="text-faint"> · +{items.length - 1} more</span>}
            </span>
          );
        },
      },
      {
        filterActive: indF.isActive('amount'),
        header: <span className="inline-flex items-center">Amount<ColumnFilter searchable options={indF.getOptions('amount')} value={indF.filters.amount || ''} onChange={(v) => indF.setFilter('amount', v)} /></span>,
        accessor: (row: any) => row.grandTotal != null
          ? <span className="font-mono text-xs text-ink">{row.currency || 'INR'} {Number(row.grandTotal).toLocaleString()}</span>
          : <span className="text-xs text-faint">—</span>,
      },
      {
        filterActive: indF.isActive('dept'),
        header: <span className="inline-flex items-center">Department<ColumnFilter options={indF.getOptions('dept')} value={indF.filters.dept || ''} onChange={(v) => indF.setFilter('dept', v)} /></span>,
        accessor: (row: any) => <span className="text-sm text-muted">{row.department?.name || 'Unknown'}</span>,
      },
      {
        filterActive: indF.isActive('manager'),
        header: <span className="inline-flex items-center">Manager<ColumnFilter searchable options={indF.getOptions('manager')} value={indF.filters.manager || ''} onChange={(v) => indF.setFilter('manager', v)} /></span>,
        accessor: (row: any) => {
          // Only AND departments make this a stage people wait on. In an OR
          // department a manager's signature is one of two ways in, so a bare
          // "Pending" would read as an outstanding task when it is nothing of
          // the sort.
          if (row.managerApprovedBy?.name) {
            return <span className="text-xs font-bold text-ink">{row.managerApprovedBy.name}</span>;
          }
          if (row.managerApprovalStatus === 'REJECTED') {
            return <span className="text-xs italic text-faint">Rejected</span>;
          }
          // A bypass and a skip both mean "no manager signature", and they are
          // not the same thing: one was a decision somebody made, the other was
          // nobody being available to make it. Shown differently so the audit
          // reads honestly.
          if (row.managerApprovalBypassedBy?.name) {
            return (
              <span className="text-xs italic text-amber-700 dark:text-amber-300" title={`${row.managerApprovalBypassedBy.name} approved this without waiting for manager sign-off.`}>
                Bypassed
              </span>
            );
          }
          // The raiser signed their own indent (an admin of the department or a
          // Super Admin) — the manager stage had nothing to add, rather than
          // nobody being there.
          if (row.managerApprovalSkipped && row.techApprovedById && row.techApprovedById === row.createdById) {
            return (
              <span className="text-xs italic text-faint" title="Raised by an approver of this department, so it was approved automatically.">
                Not needed
              </span>
            );
          }
          if (row.managerApprovalSkipped) {
            return (
              <span className="text-xs italic text-faint" title="Nobody manages the requester, so this stage was passed over and the admin's approval stands alone.">
                No manager
              </span>
            );
          }
          const andMode = row.department?.indentApprovalMode === 'MANAGER_REQUIRED';
          return <span className="text-xs italic text-faint">{andMode ? 'Pending' : 'Not required'}</span>;
        },
      },
      {
        filterActive: indF.isActive('tech'),
        header: <span className="inline-flex items-center">Tech<ColumnFilter searchable options={indF.getOptions('tech')} value={indF.filters.tech || ''} onChange={(v) => indF.setFilter('tech', v)} /></span>,
        accessor: (row: any) => row.techApprovedBy?.name
          ? <span className="text-xs font-bold text-ink">{row.techApprovedBy.name}</span>
          : <span className="text-xs italic text-faint">{row.techApprovalStatus === 'REJECTED' ? 'Rejected' : 'Pending'}</span>,
      },
      {
        filterActive: indF.isActive('ceo'),
        header: <span className="inline-flex items-center">CEO<ColumnFilter searchable options={indF.getOptions('ceo')} value={indF.filters.ceo || ''} onChange={(v) => indF.setFilter('ceo', v)} /></span>,
        accessor: (row: any) => {
          // The CEO lane is only shown above the threshold. Below it = "N/A".
          if (!ceoLaneVisible(row)) return <span className="text-xs italic text-faint" title={ceoNotApplicableTitle()}>{ceoNotApplicableLabel()}</span>;
          return row.ceoApprovedBy?.name
            ? <span className="text-xs font-bold text-ink">{row.ceoApprovedBy.name}</span>
            : <span className="text-xs italic text-faint">{row.ceoApprovalStatus === 'REJECTED' ? 'Rejected' : 'Pending'}</span>;
        },
      },
      {
        filterActive: indF.isActive('lastActivity'),
        header: <span className="inline-flex items-center">Last activity<ColumnFilter searchable options={indF.getOptions('lastActivity')} value={indF.filters.lastActivity || ''} onChange={(v) => indF.setFilter('lastActivity', v)} /></span>,
        accessor: (row: any) => {
          const ts = row.approvedAt || row.updatedAt || row.createdAt;
          return ts ? <span className="text-xs text-muted">{fmtDateTime(ts)}</span> : <span className="text-xs text-faint">—</span>;
        },
      },
      {
        filterActive: indF.isActive('status'),
        header: <span className="inline-flex items-center">Status<ColumnFilter options={indF.getOptions('status')} value={indF.filters.status || ''} onChange={(v) => indF.setFilter('status', v)} /></span>,
        accessor: (row: any) => <PendingCell status={row.status} reason={row.rejectionReason || null} />,
      },
    ];

    // A manager can sign an indent from here, exactly as they can a component
    // request. Until this existed the indent table was oversight-only — managers
    // could watch their team's indents go by and do nothing about them, which is
    // no use at all in a department that requires their signature first.
    if (lens === 'manager') {
      indentColumns.push({
        header: 'Action',
        accessor: (row: any) => {
          // Nothing to do once the manager stage is settled, or once the indent
          // has left the approvals stage entirely.
          const busy = actingId === row.id;
          // The manager's own signature can be taken back until the indent is
          // paid for — the same window the admin has. Doing so clears the
          // admin's approval too, so it starts the department stage over.
          if (row.managerApprovalStatus === 'APPROVED' && REVOCABLE_INDENT_STATUSES.includes(row.status)) {
            const adminSigned = row.techApprovalStatus === 'APPROVED';
            const movedOn = row.status !== 'PENDING';
            return (
              <button
                onClick={async () => {
                  const ok = await confirm({
                    title: `Revoke your approval of ${row.serialNo}?`,
                    message: movedOn
                      ? 'It has already gone to Procurement. Revoking pulls it back to approvals and clears the admin\'s approval as well — it will need signing off again from the start.'
                      : adminSigned
                        ? 'The admin has approved it too. Revoking clears their approval as well — it will need signing off again from the start.'
                        : 'It goes back to waiting for approval. The admin and the requester are told.',
                    confirmLabel: 'Revoke',
                    tone: 'danger',
                  });
                  if (!ok) return;
                  setActingId(row.id);
                  try {
                    await client.patch(`/indents/${row.id}/manager-approve`, { decision: 'PENDING' });
                    addToast(`Approval revoked — ${row.serialNo}`, 'success');
                    fetchRows();
                  } catch (e: any) {
                    addToast(extractErrorMessage(e, 'Revoke failed'), 'error');
                  } finally {
                    setActingId(null);
                  }
                }}
                disabled={busy}
                className="text-[10px] bg-orange-100 dark:bg-orange-400/20 text-orange-700 dark:text-orange-300 px-2 py-0.5 rounded font-bold hover:bg-orange-200 disabled:opacity-50 transition-colors shadow-sm"
                title="Take back your approval"
              >
                Revoke Approval
              </button>
            );
          }
          const settled = row.managerApprovalStatus !== 'PENDING' || row.managerApprovalSkipped;
          if (settled || row.status !== 'PENDING') {
            return <span className="text-[10px] text-faint italic">—</span>;
          }
          return (
            <div className="flex items-center gap-1.5">
              <button
                onClick={async () => {
                  setActingId(row.id);
                  try {
                    await client.patch(`/indents/${row.id}/manager-approve`, { decision: 'APPROVED' });
                    addToast(`Approved ${row.serialNo}`, 'success');
                    fetchRows();
                  } catch (e: any) {
                    addToast(extractErrorMessage(e, 'Approve failed'), 'error');
                  } finally {
                    setActingId(null);
                  }
                }}
                disabled={busy}
                className="inline-flex items-center gap-1 text-[10px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded px-2 py-0.5"
                title="Approve this indent as the requester's manager"
              >
                <CheckCircle2 size={10} /> Approve
              </button>
              <button
                onClick={() => setIndentRejectTarget({ id: row.id, serialNo: row.serialNo })}
                disabled={busy}
                className="inline-flex items-center gap-1 text-[10px] font-bold text-red-700 dark:text-red-300 border border-red-200 dark:border-red-400/30 bg-card hover:bg-red-50 dark:bg-red-400/15 disabled:opacity-50 rounded px-2 py-0.5"
                title="Reject this indent (reason required)"
              >
                <XCircle size={10} /> Reject
              </button>
            </div>
          );
        },
      });
    }

    indentColumns.push(...auditColumns(setReviewIndent, setTrackIndent));
    return indentColumns;
  };
  const indentColumns = buildIndentColumns(indF, indPager);

  // History modal reuses these columns minus the running S.No, which is bound
  // to the main table's pager and would mis-number inside the modal.
  const historyIndentColumns = buildIndentColumns(pastIndF, pastIndPager).filter((c: any) => c.header !== 'S.No' && c.header !== 'Action');

  const filterSpecs = useMemo<FilterSpec<any>[]>(() => [
    { key: 'decider', getValue: (r) => r.approvedBy?.name || (r.status === 'PENDING' ? 'Pending' : 'Unknown') },
    { key: 'role', getValue: (r) => r.approvedBy?.role?.replace(/_/g, ' ') || (r.status === 'PENDING' ? '—' : 'Unknown') },
    { key: 'requester', getValue: (r) => r.createdBy?.name || 'Unknown' },
    { key: 'item', getValue: (r) => r.inventoryItem?.name || 'Unknown' },
    { key: 'status', getValue: (r) => r.status || 'UNKNOWN' },
    { key: 'dept', getValue: (r) => r.department?.name || 'Unknown' },
    // A filter on every data column (owner, 27 Oct).
    { key: 'decisionAt', getValue: (r) => r.approvedAt ? fmtDate(r.approvedAt) : '—' },
    { key: 'requestNo', getValue: (r) => r.serialNo },
  ], []);
  // Manager lens shows active (pre-delivery) requests in the main table;
  // delivered/rejected ones move to the History modal. Admin/super keep
  // their full audit table.
  const f = useTableFilters(usesHistorySplit ? adHocPendingRows : adHocRows, filterSpecs);
  const reqPager = useClientPagination<any>(f.filteredRows, 10, JSON.stringify(f.filters));
  const pastF = useTableFilters(adHocPastRows, filterSpecs);
  const pastReqPager = useClientPagination<any>(pastF.filteredRows, 10, JSON.stringify(pastF.filters));
  // Super-admin splits slips into a live list + a History modal; admin/manager
  // show every slip in the one list (their scope is already narrow).
  const visibleBomSlips = lens === 'super' ? activeBomSlips : bomSlips;
  const bomPager = useClientPagination<any>(visibleBomSlips, 10);
  const pastBomPager = useClientPagination<any>(pastBomSlips, 10);

  // Header label for the decider column — varies by lens.
  const deciderHeader =
    lens === 'super'   ? 'Decided by' :
    lens === 'manager' ? 'Decided by' :
                         'Manager';

  // Build columns. Super-admin gets an extra "Role" column so they can
  // spot at a glance whether a decision came from a manager, admin, or
  // super-admin.
  // Built per table: the History modal gets its own filters over the history
  // rows. It used to reuse the main table's columns, so a filter picked in the
  // modal narrowed the table behind it instead.
  const buildRequestColumns = (f: ReturnType<typeof useTableFilters<any>>, reqPager: { page: number }) => {
    const columns: any[] = [
      { header: 'S.No', accessor: (_r: any, idx?: number) => String((reqPager.page - 1) * 10 + (idx ?? 0) + 1) },
      {
        filterActive: f.isActive('decider'),
        header: <span className="inline-flex items-center">{deciderHeader}<ColumnFilter searchable options={f.getOptions('decider')} value={f.filters.decider || ''} onChange={(v) => f.setFilter('decider', v)} /></span>,
        accessor: (row: any) => (
          <span className={row.approvedBy?.name ? 'font-bold text-ink' : 'text-xs text-faint italic'}>
            {row.approvedBy?.name || 'Pending'}
          </span>
        ),
      },
    ];
    if (lens === 'super') {
      columns.push({
        filterActive: f.isActive('role'),
        header: <span className="inline-flex items-center">Role<ColumnFilter options={f.getOptions('role')} value={f.filters.role || ''} onChange={(v) => f.setFilter('role', v)} /></span>,
        accessor: (row: any) => row.approvedBy?.role
          ? <RoleBadge role={row.approvedBy.role} />
          : <span className="text-xs text-faint italic">—</span>,
      });
    }
    columns.push(
      {
        filterActive: f.isActive('decisionAt'),
        header: <span className="inline-flex items-center">Decision at<ColumnFilter searchable options={f.getOptions('decisionAt')} value={f.filters.decisionAt || ''} onChange={(v) => f.setFilter('decisionAt', v)} /></span>,
        accessor: (row: any) => row.approvedAt
          ? <span className="text-xs text-muted">{fmtDateTime(row.approvedAt)}</span>
          : <span className="text-xs text-faint">—</span>,
      },
      {
        filterActive: f.isActive('requester'),
        header: <span className="inline-flex items-center">Requested by<ColumnFilter searchable options={f.getOptions('requester')} value={f.filters.requester || ''} onChange={(v) => f.setFilter('requester', v)} /></span>,
        accessor: (row: any) => <span className="text-sm">{row.createdBy?.name || 'Unknown'}</span>,
      },
      {
        filterActive: f.isActive('item'),
        header: <span className="inline-flex items-center">Item<ColumnFilter searchable options={f.getOptions('item')} value={f.filters.item || ''} onChange={(v) => f.setFilter('item', v)} /></span>,
        accessor: (row: any) => (
          <span className="text-sm text-ink">
            <span className="font-medium">{row.inventoryItem?.name || 'Unknown'}</span>
            <span className="ml-1 text-xs text-muted">× {row.qtyRequested} {row.inventoryItem?.unit || ''}</span>
          </span>
        ),
      },
      {
        filterActive: f.isActive('dept'),
        header: <span className="inline-flex items-center">Department<ColumnFilter options={f.getOptions('dept')} value={f.filters.dept || ''} onChange={(v) => f.setFilter('dept', v)} /></span>,
        accessor: (row: any) => <span className="text-sm text-muted">{row.department?.name || 'Unknown'}</span>,
      },
      {
        filterActive: f.isActive('requestNo'),
        header: <span className="inline-flex items-center">Request #<ColumnFilter searchable options={f.getOptions('requestNo')} value={f.filters.requestNo || ''} onChange={(v) => f.setFilter('requestNo', v)} /></span>,
        accessor: (row: any) => <span className="font-mono text-xs text-muted">{row.serialNo}</span>,
      },
      {
        filterActive: f.isActive('status'),
        header: <span className="inline-flex items-center">Outcome<ColumnFilter options={f.getOptions('status')} value={f.filters.status || ''} onChange={(v) => f.setFilter('status', v)} /></span>,
        accessor: (row: any) => <PendingCell status={row.status} reason={row.status === 'REJECTED' ? row.rejectionReason || null : null} />,
      },
    );

    // Manager-only action column. Shows Approve / Reject on PENDING rows so
    // a manager can act on their direct reports' requests from here. Admin
    // + super-admin lenses skip this (their actions are tracked elsewhere
    // — admin approves indents, super-admin views everything as audit).
    if (lens === 'manager') {
      columns.push({
        header: 'Action',
        accessor: (row: any) => {
          if (row.status !== 'PENDING') {
            return <span className="text-[10px] text-faint italic">—</span>;
          }
          const busy = actingId === row.id;
          return (
            <div className="flex items-center gap-1.5">
              <button
                onClick={async () => {
                  setActingId(row.id);
                  try {
                    await client.patch(`/requests/${row.id}/approve`);
                    addToast(`Approved ${row.serialNo}`, 'success');
                    fetchRows();
                  } catch (e: any) {
                    addToast(extractErrorMessage(e, 'Approve failed'), 'error');
                  } finally {
                    setActingId(null);
                  }
                }}
                disabled={busy}
                className="inline-flex items-center gap-1 text-[10px] font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded px-2 py-0.5"
                title="Approve this request"
              >
                <CheckCircle2 size={10} /> Approve
              </button>
              <button
                onClick={() => setRejectTarget({ id: row.id, serialNo: row.serialNo })}
                disabled={busy}
                className="inline-flex items-center gap-1 text-[10px] font-bold text-red-700 dark:text-red-300 border border-red-200 dark:border-red-400/30 bg-card hover:bg-red-50 dark:bg-red-400/15 disabled:opacity-50 rounded px-2 py-0.5"
                title="Reject this request (reason required)"
              >
                <XCircle size={10} /> Reject
              </button>
            </div>
          );
        },
      });
    }

    // View + Track stay the rightmost pair on every lens — appended AFTER the
    // manager-only Action column so these utility icons line up with the other
    // approvals tables (Action, when present, sits just to their left).
    columns.push(...auditColumns((row: any) => setReviewRequestId(row.id), (row: any) => setTrackRequest(row)));
    return columns;
  };
  const columns = buildRequestColumns(f, reqPager);

  // History modal: same columns minus the pager-bound S.No and the Action
  // column — every history row is already decided, so there's nothing to act on.
  const historyRequestColumns = buildRequestColumns(pastF, pastReqPager).filter((c: any) => c.header !== 'S.No' && c.header !== 'Action');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">{heading}</h2>
        <p className="text-sm md:text-[15px] text-muted mt-1.5">{subhead}</p>
      </div>

      {/* Extension Requests — managers approve their team's loan extensions
          here (this is where a manager's approvals badge points). Self-contained
          queue; renders nothing when empty. Manager-only: ADMIN/SUPER_ADMIN clear
          extensions on their Approvals page instead, so this would otherwise
          duplicate the same org-wide queue across both of their pages. */}
      {(user?.role === UserRole.MANAGER || isFinance) && <PendingExtensionsSection />}

      {/* SUPER_ADMIN summary tiles — combined totals across requests +
          indents, then a per-type split row below. Only renders for the
          super-admin lens; admin/manager don't need the breakdown because
          their scope is already narrow. */}
      {lens === 'super' && summary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryTile icon={<ShieldCheck size={18} className="text-violet-600 dark:text-violet-300" />} label="Total decisions" value={summary.total} accent="violet" sub={`${summary.reqStats.total} req · ${summary.indStats.total} indent`} />
            <SummaryTile icon={<CheckCircle2 size={18} className="text-emerald-700 dark:text-emerald-300" />} label="Approved" value={summary.approved} accent="emerald" sub={`${summary.reqStats.approved} req · ${summary.indStats.approved} indent`} />
            <SummaryTile icon={<XCircle size={18} className="text-red-700 dark:text-red-300" />} label="Rejected" value={summary.rejected} accent="red" sub={`${summary.reqStats.rejected} req · ${summary.indStats.rejected} indent`} />
            <SummaryTile icon={<Clock size={18} className="text-amber-700 dark:text-amber-300" />} label="Pending" value={summary.pending} accent="amber" sub={`${summary.reqStats.pending} req · ${summary.indStats.pending} indent`} />
          </div>
        </>
      )}

      {/* SUPER_ADMIN approver-role breakdown — two cards side by side:
          what's already been decided (by approver role) and what's still
          pending (by the role responsible for clearing it). Helps spot work
          piling up on the wrong stage or an overloaded approver. */}
      {lens === 'super' && summary && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {/* Decided — historical: who signed off how many items. */}
          {summary.byRole.length > 0 && (
            <div className="bg-card rounded-xl shadow-sm border border-line-soft px-6 py-4">
              <h3 className="text-sm font-bold text-ink flex items-center gap-2 mb-3">
                <Users size={16} className="text-brand" /> Decisions by approver role
              </h3>
              <div className="flex flex-wrap gap-2">
                {summary.byRole.map(([role, count]) => (
                  <div key={role} className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-line bg-surface">
                    <RoleBadge role={role} />
                    <span className="text-sm font-bold text-ink">{count}</span>
                    <span className="text-[11px] text-faint">decision{count === 1 ? '' : 's'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {/* Pending — forward-looking: who still needs to act, on how many.
              Always rendered so an empty queue reads as a positive "all clear"
              instead of a missing card. */}
          <div className="bg-card rounded-xl shadow-sm border border-line-soft px-6 py-4">
            <h3 className="text-sm font-bold text-ink flex items-center gap-2 mb-3">
              <Clock size={16} className="text-amber-700 dark:text-amber-300" /> Pending by approver role
            </h3>
            {summary.pendingByRole.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {summary.pendingByRole.map(([role, count]) => (
                  <div key={role} className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-amber-200 dark:border-amber-400/30 bg-amber-50/60 dark:bg-amber-400/15">
                    <RoleBadge role={role} />
                    <span className="text-sm font-bold text-ink">{count}</span>
                    <span className="text-[11px] text-faint">pending</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-faint italic">Nothing awaiting approval — all clear.</p>
            )}
          </div>
        </div>
      )}

      {/* BOM Approvals (manager lens) — the ACTIONABLE queue: SUBMITTED BOMs
          your direct reports raised, each awaiting your one sign-off. Clicking
          a row opens the approval slip (approve / per-line review / reject /
          send-back). These used to wrongly live on the personal Approvals page;
          a BOM raised by a report is team work and belongs here. */}
      {lens === 'manager' && (bomManagerQueue.length > 0 || bomDecidedTotal > 0) && (
        <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
          <div className="px-6 py-3 border-b border-line-soft bg-surface flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={16} className="text-brand shrink-0" />
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-ink">BOM Approvals</h3>
                <p className="text-xs text-muted mt-0.5">
                  BOMs raised by your team, awaiting your decision. Approving routes the whole BOM (in-stock lines flow to inventory, procurement lines spawn an indent).
                </p>
              </div>
            </div>
            <button
              onClick={() => setBomDecidedOpen(true)}
              className="shrink-0 bg-ink text-card text-xs font-bold px-3 py-1.5 rounded-md hover:bg-black transition-colors shadow-sm"
              title="See decided BOMs (approved / rejected) and open any one's Timeline"
            >
              History{bomDecidedTotal > 0 ? ` (${bomDecidedTotal})` : ''}
            </button>
          </div>
          {bomManagerQueue.length > 0 ? (
            <BomQueueSection
              label="Awaiting approval"
              stageTone="text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border-amber-200 dark:border-amber-400/30"
              items={bomManagerQueue}
              onOpen={(id: string) => openSlip(id)}
            />
          ) : (
            <p className="px-6 py-6 text-center text-xs text-faint italic">
              No BOMs awaiting your approval — see History for decided ones.
            </p>
          )}
        </div>
      )}

      {/* Pending BOM approvals (super lens) — org-wide oversight, READ-ONLY.
          The CEO sees every SUBMITTED BOM still awaiting a manager/admin
          sign-off (with who it's waiting on), but doesn't act on them here —
          clicking opens the slip read-only. Fills the gap between "raised" and
          "routed" so a pending BOM isn't invisible to the CEO. */}
      {lens === 'super' && bomManagerQueue.length > 0 && (
        <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
          <div className="px-6 py-3 border-b border-line-soft bg-surface flex items-center gap-2">
            <FileText size={16} className="text-brand shrink-0" />
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-ink">Pending BOM approvals ({bomManagerQueue.length})</h3>
              <p className="text-xs text-muted mt-0.5">
                Every BOM awaiting a manager/admin sign-off, org-wide — read-only oversight. Managers &amp; admins approve these;{' '}
                {/* Live bar, not the literal ₹20,000 this used to print. The
                    CEO threshold is editable in Settings, so a hardcoded
                    figure tells an approver a rule the system stopped
                    enforcing the moment Finance moved it. Same fix as the
                    Approvals page subtitle. */}
                {isCeoApprovalRequired()
                  ? `you sign off indents ${ceoThresholdLabel()}.`
                  : `indents ${ceoThresholdLabel()} are yours to review if you want them — technical approval alone is enough to move them.`}
              </p>
            </div>
          </div>
          <BomQueueSection
            label="Awaiting approval"
            stageTone="text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border-amber-200 dark:border-amber-400/30"
            items={bomManagerQueue}
            onOpen={(id: string) => openSlip(id, true)}
            cta={() => ({ label: 'View →', muted: true })}
          />
        </div>
      )}

      {/* BOM Slip audit — grouped rollup per BOM so the auditor sees batches
          at a glance instead of N similar rows. Every slip is a ROUTED BOM
          (built from its spawned children), so clicking a row opens the
          read-only BOM contents. Super-admin gets a live list + History
          (closed-out BOMs); admin/manager show every slip in scope. */}
      {bomSlips.length > 0 && (
        <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
          <div className="px-6 py-3 border-b border-line-soft bg-surface flex items-start justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={16} className="text-brand shrink-0" />
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-ink">BOM Slips ({visibleBomSlips.length})</h3>
                <p className="text-xs text-muted mt-0.5">
                  Each BOM routed to inventory and/or procurement, grouped. Click a row to view its contents.
                  {lens === 'super' && ' Closed-out BOMs move to History.'}
                </p>
              </div>
            </div>
            {lens === 'super' && (
              <button
                onClick={() => setBomHistoryOpen(true)}
                className="shrink-0 bg-ink text-card text-xs font-bold px-3 py-1.5 rounded-md hover:bg-black transition-colors shadow-sm"
                title="BOMs whose every request + indent has landed, been rejected, or cancelled"
              >
                History{pastBomSlips.length > 0 ? ` (${pastBomSlips.length})` : ''}
              </button>
            )}
          </div>
          {visibleBomSlips.length > 0 ? (
            <>
              <div className="divide-y divide-line-soft overflow-y-auto" style={{ maxHeight: '35vh' }}>
                {bomPager.pageRows.map((slip: any) => (
                  <BomSlipRow key={slip.id} slip={slip} onClick={() => openSlip(slip.id, true)} />
                ))}
              </div>
              <Pagination currentPage={bomPager.page} totalPages={bomPager.totalPages} onPageChange={bomPager.setPage} />
            </>
          ) : (
            <p className="px-6 py-6 text-center text-xs text-faint italic">
              No active BOMs — every BOM in scope has closed out. See History.
            </p>
          )}
        </div>
      )}

      {/* Ad-hoc audit table */}
      <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
        <div className="px-6 py-3 border-b border-line-soft bg-surface flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-ink">
              {lens === 'super' ? 'Component Requests' : 'Ad-hoc requests'} ({usesHistorySplit ? adHocPendingRows.length : adHocRows.length})
            </h3>
            <p className="text-xs text-muted mt-0.5">
              {lens === 'manager'
                ? 'Live ad-hoc requests from your team — awaiting your decision or still being issued. They move to History once the components reach the requester.'
                : lens === 'admin'
                ? 'Live ad-hoc requests in your department(s) — still pending or being issued. They move to History once the components reach the requester.'
                : 'Individual component requests not tied to a BOM.'}
              {bomSlips.length > 0 && <span className="italic"> BOM-bound rows are grouped above.</span>}
            </p>
          </div>
          {usesHistorySplit && (
            <button
              onClick={() => setRequestHistoryOpen(true)}
              className="shrink-0 bg-ink text-card text-xs font-bold px-3 py-1.5 rounded-md hover:bg-black transition-colors shadow-sm"
              title="See requests that have been issued, returned, or rejected"
            >
              History{adHocPastRows.length > 0 ? ` (${adHocPastRows.length})` : ''}
            </button>
          )}
        </div>
        <DataTable
          columns={columns}
          data={reqPager.pageRows}
          isLoading={loading}
          keyExtractor={(r) => r.id}
          emptyStateMessage={
            lens === 'super'
              ? 'No request activity in the org yet.'
              : usesHistorySplit
              ? 'No active requests — check History for issued/closed ones.'
              : 'No manager approvals to show yet.'
          }
          maxHeight={lens === 'super' ? '40vh' : '55vh'}
        />
        <div className="px-6 pb-2">
          <Pagination currentPage={reqPager.page} totalPages={reqPager.totalPages} onPageChange={reqPager.setPage} />
        </div>
      </div>

      {/* Indents audit — rendered for SUPER_ADMIN (org-wide) and MANAGER
          (their direct reports' indents only). ADMIN's indent view stays
          on the regular Approvals page since admins are dept-level
          approvers, not oversight viewers. */}
      {(lens === 'super' || lens === 'manager') && (
        <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
          <div className="px-6 py-3 border-b border-line-soft bg-surface flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-bold text-ink">Indents ({lens === 'manager' ? adHocPendingIndentRows.length : indentRows.length})</h3>
              <p className="text-xs text-muted mt-0.5">
                {lens === 'super'
                  ? 'Every indent in the org — pending, in procurement, approved, rejected, cancelled. Tech + CEO approval columns show who signed off and when.'
                  : 'Live team indents — from approval through quotation, payment and shipping. They move to History once received at inventory (or cancelled).'}
              </p>
            </div>
            {lens === 'manager' && (
              <button
                onClick={() => setIndentHistoryOpen(true)}
                className="shrink-0 bg-ink text-card text-xs font-bold px-3 py-1.5 rounded-md hover:bg-black transition-colors shadow-sm"
                title="See team indents received at inventory, rejected, or cancelled"
              >
                History{adHocPastIndentRows.length > 0 ? ` (${adHocPastIndentRows.length})` : ''}
              </button>
            )}
          </div>
          <DataTable
            columns={indentColumns}
            data={indPager.pageRows}
            isLoading={loading}
            keyExtractor={(r) => r.id}
            emptyStateMessage={lens === 'super'
              ? 'No indent activity in the org yet.'
              : 'No active team indents — check History for received/closed ones.'}
            maxHeight="50vh"
          />
          <div className="px-6 pb-2">
            <Pagination currentPage={indPager.page} totalPages={indPager.totalPages} onPageChange={indPager.setPage} />
          </div>
        </div>
      )}

      {/* History modals (manager lens) — team requests / indents that have
          closed out: requests issued to the requester (or rejected), indents
          received at inventory (or rejected/cancelled). Same column sets minus
          the pager-bound S.No (and, for requests, the now-irrelevant Action
          column). View/Track drill-downs reuse the modals already mounted
          below. */}
      <Modal isOpen={requestHistoryOpen} onClose={() => setRequestHistoryOpen(false)} title="Team Request History" size="full">
        <ExportPanel kind="requests" who="team" excludeStatus="PENDING,APPROVED,YET_TO_ISSUE" />
        <DataTable
          columns={historyRequestColumns}
          data={pastReqPager.pageRows}
          isLoading={loading}
          keyExtractor={(r) => r.id}
          emptyStateMessage="No closed-out team requests yet — issued and rejected ones land here."
          maxHeight="55vh"
        />
        <Pagination currentPage={pastReqPager.page} totalPages={pastReqPager.totalPages} onPageChange={pastReqPager.setPage} />
      </Modal>

      <Modal isOpen={indentHistoryOpen} onClose={() => setIndentHistoryOpen(false)} title="Team Indent History" size="full">
        <ExportPanel kind="indents" who="team" status="RECEIVED,REJECTED,CANCELLED" />
        <DataTable
          columns={historyIndentColumns}
          data={pastIndPager.pageRows}
          isLoading={loading}
          keyExtractor={(r) => r.id}
          emptyStateMessage="No received or cancelled team indents yet."
          maxHeight="55vh"
        />
        <Pagination currentPage={pastIndPager.page} totalPages={pastIndPager.totalPages} onPageChange={pastIndPager.setPage} />
      </Modal>

      {/* BOM History (super lens only) — closed-out slips: every spawned
          request + indent has landed, been rejected, or cancelled. Same
          clickable rows as the live list, so a row still opens its read-only
          contents. */}
      <Modal isOpen={bomHistoryOpen} onClose={() => setBomHistoryOpen(false)} title="BOM History" size="2xl">
        {pastBomSlips.length > 0 ? (
          <>
            <div className="divide-y divide-line-soft overflow-y-auto" style={{ maxHeight: '55vh' }}>
              {pastBomPager.pageRows.map((slip: any) => (
                <BomSlipRow key={slip.id} slip={slip} onClick={() => openSlip(slip.id, true)} />
              ))}
            </div>
            <Pagination currentPage={pastBomPager.page} totalPages={pastBomPager.totalPages} onPageChange={pastBomPager.setPage} />
          </>
        ) : (
          <p className="px-6 py-8 text-center text-sm text-faint italic">
            No closed-out BOMs yet — they land here once every spawned request and indent has been received, rejected, or cancelled.
          </p>
        )}
      </Modal>

      {/* BOM History (manager lens) — decided BOMs (routed / rejected) raised
          by direct reports. Each row opens the read-only slip + its per-version
          Timeline. Backed by the role-scoped history endpoint, so it includes
          REJECTED BOMs the spawned-children rollup never captured. */}
      <Modal isOpen={bomDecidedOpen} onClose={() => setBomDecidedOpen(false)} title="BOM History">
        {!bomDecidedLoaded ? (
          <div className="text-center text-faint py-6 text-sm">Loading…</div>
        ) : (<>
          <LoadAllCapNote truncated={bomDecidedTotal > bomDecided.length} shown={bomDecided.length} total={bomDecidedTotal} />
          <BomHistorySection
            items={bomDecided}
            onOpen={(id: string) => { setBomDecidedOpen(false); openSlip(id, true); }}
          />
        </>)}
      </Modal>

      {/* Rejection-reason modal (manager lens only). Shown when manager
          clicks Reject on a pending row. Reason is required by the
          backend — surfacing the modal lets the manager supply it. */}
      <RejectionReasonModal
        isOpen={!!rejectTarget}
        onClose={() => setRejectTarget(null)}
        entityLabel={`Request ${rejectTarget?.serialNo || ''}`}
        audienceLabel="the requester"
        submitting={rejectSubmitting}
        onSubmit={async (reason) => {
          if (!rejectTarget) return;
          setRejectSubmitting(true);
          try {
            await client.patch(`/requests/${rejectTarget.id}/reject`, { reason });
            addToast(`Rejected ${rejectTarget.serialNo}`, 'success');
            setRejectTarget(null);
            fetchRows();
          } catch (e: any) {
            addToast(extractErrorMessage(e, 'Reject failed'), 'error');
          } finally {
            setRejectSubmitting(false);
          }
        }}
      />

      {/* Same modal, the indent lane. The reason reaches the requester and is
          stored on the indent, so it has to be asked for rather than defaulted. */}
      <RejectionReasonModal
        isOpen={!!indentRejectTarget}
        onClose={() => setIndentRejectTarget(null)}
        entityLabel={`Indent ${indentRejectTarget?.serialNo || ''}`}
        audienceLabel="the requester"
        submitting={rejectSubmitting}
        onSubmit={async (reason) => {
          if (!indentRejectTarget) return;
          setRejectSubmitting(true);
          try {
            await client.patch(`/indents/${indentRejectTarget.id}/manager-approve`, { decision: 'REJECTED', reason });
            addToast(`Rejected ${indentRejectTarget.serialNo}`, 'success');
            setIndentRejectTarget(null);
            fetchRows();
          } catch (e: any) {
            addToast(extractErrorMessage(e, 'Reject failed'), 'error');
          } finally {
            setRejectSubmitting(false);
          }
        }}
      />

      {/* Read-only indent drill-down for the audit table. No approve/reject
          callbacks passed → IndentReviewModal renders in pure read-only mode
          (this is an oversight view, not an action one). */}
      {/* Same rule as the request view: the manager can decide from the
          detail they are reading. The modal already supported this — it
          renders its action footer when the callbacks are present and says
          "Read-only view" when they are not — it was simply never passed
          them here. Only a PENDING indent in the manager lens gets them. */}
      <IndentReviewModal
        indent={reviewIndent}
        onClose={() => setReviewIndent(null)}
        actionLabel={lens === 'manager' ? "Manager approval" : undefined}
        canEditQty={lens === 'manager' && reviewIndent?.status === 'PENDING'}
        onApprove={lens === 'manager' && reviewIndent?.status === 'PENDING' ? async (qtyByItem?: Record<string, number>) => {
          const target = reviewIndent;
          if (!target) return;
          try {
            // Quantities first, approval second. If the edit is rejected
            // (someone else moved the indent on, a quantity is out of range)
            // the approval must not go through on numbers that were never
            // saved — the throw stops it here and the toast says why.
            if (qtyByItem && Object.keys(qtyByItem).length > 0) {
              await client.patch(`/indents/${target.id}`, {
                items: Object.entries(qtyByItem).map(([id, qty]) => ({ id, qty })),
                expectedUpdatedAt: target.updatedAt,
              });
            }
            await client.patch(`/indents/${target.id}/manager-approve`, { decision: 'APPROVED' });
            addToast(
              qtyByItem
                ? `Approved ${target.serialNo} with revised quantities`
                : `Approved ${target.serialNo}`,
              'success',
            );
            setReviewIndent(null);
            fetchRows();
          } catch (e: any) {
            addToast(extractErrorMessage(e, 'Approve failed'), 'error');
          }
        } : undefined}
        onRejectIndent={lens === 'manager' && reviewIndent?.status === 'PENDING' ? () => {
          const target = reviewIndent;
          if (!target) return;
          setReviewIndent(null);
          setIndentRejectTarget({ id: target.id, serialNo: target.serialNo });
        } : undefined}
      />
      <IndentTrackModal indent={trackIndent} onClose={() => setTrackIndent(null)} />

      {/* Component-request drill-down — View fetches full detail, Track fetches
          the approval timeline. Both read-only; available on every lens. */}
      {/* Approve / reject live HERE, on the view, rather than only as row
          buttons: the decision belongs next to the detail it is based on, and
          the quantity is editable in place (pencil beside "Requested"), the
          same way the BOM approval slip works. Actions appear only in the
          manager lens — the other lenses are audit views and pass nothing, so
          the modal stays read-only for them. */}
      <ComponentRequestReviewModal
        requestId={reviewRequestId}
        onClose={() => setReviewRequestId(null)}
        acting={reviewActing}
        onApprove={lens === 'manager' ? async (qty: number) => {
          if (!reviewRequestId) return;
          setReviewActing(true);
          try {
            // Send the quantity only when it differs, so an ordinary approval
            // stays an ordinary approval all the way down to the audit note.
            const row = rows.find((r: any) => r.id === reviewRequestId);
            const original = Number(row?.qtyRequested ?? qty);
            await client.patch(
              `/requests/${reviewRequestId}/approve`,
              qty !== original ? { qtyRequested: qty } : {},
            );
            addToast(
              qty !== original
                ? `Approved ${row?.serialNo || ''} for ${qty}`
                : `Approved ${row?.serialNo || ''}`,
              'success',
            );
            setReviewRequestId(null);
            fetchRows();
          } catch (e: any) {
            addToast(extractErrorMessage(e, 'Approve failed'), 'error');
          } finally {
            setReviewActing(false);
          }
        } : undefined}
        onReject={lens === 'manager' ? () => {
          const row = rows.find((r: any) => r.id === reviewRequestId);
          if (!row) return;
          setReviewRequestId(null);
          setRejectTarget({ id: row.id, serialNo: row.serialNo });
        } : undefined}
      />
      <ComponentRequestTrackModal request={trackRequest} onClose={() => setTrackRequest(null)} />

      {/* BOM slip drill-down. Audit/History rows open it read-only (inspection
          only); the manager-lens "Awaiting approval" queue + the notification
          deep-link open it actionable. `slipReadOnly` carries that intent from
          the call site. onProcessed refetches after any allowed action. */}
      <BomApprovalSlipModal
        bomListId={slipModalId}
        readOnly={slipReadOnly}
        onClose={() => { setSlipModalId(null); setSlipReadOnly(false); }}
        onProcessed={() => {
          // Refetch the queue + audit rollups, and ping the sidebar so the
          // Team Approvals dot recounts the moment a team BOM is decided.
          fetchRows();
          window.dispatchEvent(new Event('approvals-updated'));
        }}
      />
    </div>
  );
};

// ---- Small presentational helpers --------------------------------------

const ACCENT: Record<string, string> = {
  violet:  'bg-violet-50 dark:bg-violet-400/15 border-violet-200 dark:border-violet-400/30 text-violet-700 dark:text-violet-300',
  emerald: 'bg-emerald-50 dark:bg-emerald-400/15 border-emerald-200 dark:border-emerald-400/30 text-emerald-700 dark:text-emerald-300',
  red:     'bg-red-50 dark:bg-red-400/15 border-red-200 dark:border-red-400/30 text-red-700 dark:text-red-300',
  amber:   'bg-amber-50 dark:bg-amber-400/15 border-amber-200 dark:border-amber-400/30 text-amber-700 dark:text-amber-300',
};

const SummaryTile = ({ icon, label, value, accent, sub }: { icon: React.ReactNode; label: string; value: number; accent: string; sub?: string }) => (
  <div className={`rounded-xl border px-4 py-3 ${ACCENT[accent] || ACCENT.violet}`}>
    <div className="flex items-center gap-2">
      {icon}
      <span className="text-[10px] uppercase font-bold tracking-wider">{label}</span>
    </div>
    <p className="text-2xl font-bold mt-1">{value}</p>
    {/* No opacity here: the tile's accent colour already passes AA, and
        knocking it back to 70% put this sub-label at 2.89-3.63:1. */}
    {sub && <p className="text-[10px] mt-0.5">{sub}</p>}
  </div>
);

const ROLE_STYLES: Record<string, string> = {
  SUPER_ADMIN: 'bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-400/30',
  // CEO = the super-admin acting on the indent CEO gate. Distinct chip so the
  // "Pending by approver role" card reads as a pipeline stage, not a person.
  CEO:         'bg-fuchsia-50 dark:bg-fuchsia-400/15 text-fuchsia-700 dark:text-fuchsia-300 border-fuchsia-200 dark:border-fuchsia-400/30',
  ADMIN:       'bg-orange-50 dark:bg-orange-400/15 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-400/30',
  MANAGER:     'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30',
  USER:        'bg-surface text-secondary border-line',
  LAB:         'bg-cyan-50 dark:bg-cyan-400/15 text-cyan-700 dark:text-cyan-300 border-cyan-200 dark:border-cyan-400/30',
  INVENTORY:   'bg-teal-50 dark:bg-teal-400/15 text-teal-700 dark:text-teal-300 border-teal-200 dark:border-teal-400/30',
  PROCUREMENT: 'bg-indigo-50 dark:bg-indigo-400/15 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-400/30',
  FINANCE:     'bg-pink-50 dark:bg-pink-400/15 text-pink-700 dark:text-pink-300 border-pink-200 dark:border-pink-400/30',
};

const RoleBadge = ({ role }: { role: string }) => {
  const cls = ROLE_STYLES[role] || 'bg-surface text-secondary border-line';
  return (
    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${cls} uppercase tracking-wide`}>
      {role.replace(/_/g, ' ')}
    </span>
  );
};

// One ROUTED BOM, summarized: serial/name/creator on the left, outcome chips
// for its spawned children on the right. The whole row is a button → opens the
// read-only BomApprovalSlipModal. Chips only render when their count > 0 so a
// clean slip stays uncluttered.
const BomSlipRow = ({ slip, onClick }: { slip: any; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    className="w-full text-left px-6 py-3 flex items-center gap-4 hover:bg-brand-50 transition-colors cursor-pointer"
    title="View BOM contents"
  >
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-mono text-[10px] font-bold text-faint">{slip.serialNo}</span>
        <span className="text-base font-bold text-ink truncate">{slip.name}</span>
      </div>
      <p className="text-[11px] text-muted mt-0.5 truncate">
        <span className="font-bold">{slip.createdBy?.name || 'Unknown'}</span>
        {slip.project?.name && <> · {slip.project.name}</>}
        {slip.department?.name && <> · {slip.department.name}</>}
        {slip.recentAt && (
          <span className="text-faint"> · last activity {fmtDateTime(slip.recentAt.toISOString())}</span>
        )}
      </p>
    </div>
    <div className="shrink-0 flex items-center gap-1.5 flex-wrap justify-end">
      {slip.issuedCount > 0 && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30" title="In-stock lines physically issued to the requester">
          {slip.issuedCount} issued
        </span>
      )}
      {slip.awaitingIssueCount > 0 && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-sky-50 dark:bg-sky-400/15 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-400/30" title="Approved & sent to the stores team — not yet handed over">
          {slip.awaitingIssueCount} to issue
        </span>
      )}
      {slip.pendingCount > 0 && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30">
          {slip.pendingCount} pending
        </span>
      )}
      {slip.rejectedCount > 0 && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30">
          {slip.rejectedCount} rejected
        </span>
      )}
      {slip.indents.length > 0 && (
        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-indigo-50 dark:bg-indigo-400/15 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-400/30">
          {slip.indents.length} indent{slip.indents.length > 1 ? 's' : ''}
          {slip.pendingIndentCount > 0 ? ` · ${slip.pendingIndentCount} pending` : ''}
        </span>
      )}
      <ChevronRight size={14} className="text-faint" />
    </div>
  </button>
);
