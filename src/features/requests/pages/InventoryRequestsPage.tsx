import { useEffect, useMemo, useState } from 'react';
import { client } from '@/api';
import { DataTable, Modal, ColumnFilter, BulkSelectionBar, BulkActionButton, ExportPanel, Pagination, SearchInput, LoadAllCapNote } from '@/components/ui';
import { useBulkSelection, useServerPagination, useTableFilters, usePagedFilters, useRowDeepLink, FilterSpec } from '@/hooks';
import { useToast } from '@/context/ToastContext';
import { fmtDateTime } from '@/utils/date';
import { DURATION_UNITS, durationUnitLabel } from '@/utils/duration';

import { extractErrorMessage } from '@/lib';
import { RequestAttachment } from '@/features/requests/components/RequestAttachment';
import { IssueAllotPanel } from '@/features/requests/components/IssueAllotPanel';
import { useAuth } from '@/context/AuthContext';

// Active = not yet handed over (still in the inventory clerk's queue).
// History = everything past that point. Both buckets paginate server-side
// (10/page) via the status / excludeStatus comma params, so a large request
// log can never blow up the DOM.
const ACTIVE_REQUEST_STATUSES = 'PENDING,APPROVED,YET_TO_ISSUE';



/**
 * What a request may actually be issued from.
 *
 * A request draws on its project's own allotment first and the unallotted
 * pool after; another project's reservation is off limits. The server sends
 * that split as `availableToRequest`, and the clerk's screen has to use it
 * instead of raw stock — a shelf of 100 with 60 reserved for Watch offers a
 * Phone request 40, and offering 100 only produces a refused issue.
 *
 * Falls back to raw stock when the field is missing, so an older response
 * (or a cached page mid-deploy) degrades to the previous behaviour rather
 * than offering zero of everything.
 */
const drawableFor = (row: any): number => {
    const pools = row?.availableToRequest;
    if (pools && Number.isFinite(Number(pools.total))) return Number(pools.total);
    return Number(row?.inventoryItem?.stock ?? 0);
};


export const InventoryRequestsPage = () => {
    const [isViewModalOpen, setIsViewModalOpen] = useState(false);
    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
    // Opt-in withdrawn (soft-deleted) rows in the History modal — off by
    // default. Drives both the table fetch and the export below so the
    // downloaded file matches what's on screen.
    const [showDeleted, setShowDeleted] = useState(false);
    const [selectedRequest, setSelectedRequest] = useState<any>(null);

    const { addToast } = useToast();
    const activeSel = useBulkSelection();

    // Two server-side buckets, 10/page each. Active = still in the clerk's
    // queue; history = everything past issue. The split runs server-side via
    // the status / excludeStatus comma params so neither table ever loads the
    // full request log into the browser.
    const activeP = useServerPagination<any>({ loadAll: true, endpoint: '/requests', params: { status: ACTIVE_REQUEST_STATUSES } });
    // History rows only ever render inside the (closed-by-default) History
    // modal — there's no main-page count off this bucket — so gate the fetch on
    // the modal being open. Saves one full `/requests` round-trip per page load;
    // re-fetches fresh each time the modal re-opens.
    const historyP = useServerPagination<any>({ loadAll: true, endpoint: '/requests', params: { excludeStatus: ACTIVE_REQUEST_STATUSES, includeDeleted: showDeleted }, enabled: isHistoryModalOpen });
    const requests = activeP.items;
    const pastRequests = historyP.items;
    const isLoading = activeP.isLoading;

    // ?openRequest=<id> from a component-request notification. The clerk lands
    // on this page from the bell, so the row they were told about has to be
    // pointed at — previously the param was simply dropped.
    const highlightId = useRowDeepLink({
        param: 'openRequest',
        ready: !isLoading,
        onMissing: () =>
            addToast(
                "That request isn't in the active queue — it may already be issued. Check History.",
                'info',
            ),
    });

    // Refresh both buckets after a mutation. Same name as the old fetcher so
    // every existing call site (issue confirm, inline field edit) is unchanged.
    const fetchRequests = () => { activeP.refetch(); historyP.refetch(); };


    // Clicking Issue opens a confirmation modal. The qty itself is computed
    // automatically (min of stock + still-needed) — Finance / the clerk no
    // longer types it here. The fine-tuning happens on the Issue Slips page
    // where qtyIssued is editable inline before the final Mark-as-issued.
    // What the modal still does:
    //   - Show stock state (banner colour) so the clerk knows whether
    //     they're full-filling, partial-filling, or queueing.
    //   - Show requester + computed qty for one final sanity check.
    //   - Confirm via a single "Issue X" button.
    const [issueRow, setIssueRow] = useState<any | null>(null);
    const [issueSubmitting, setIssueSubmitting] = useState(false);
    // Allot from inside the slip (the same allotment as Allot Items) — for the
    // roles that may allot at all.
    const { user } = useAuth();
    const canAllot = ['SUPER_ADMIN', 'ADMIN', 'INVENTORY'].includes(user?.role ?? '');
    const [showAllot, setShowAllot] = useState(false);

    const closeIssue = () => { setIssueRow(null); setShowAllot(false); };

    // After an allotment is saved the list is refetched; keep the open slip on
    // the fresh row so its "available to this request" is the server's new figure.
    useEffect(() => {
        if (!issueRow) return;
        const fresh = requests.find((r: any) => r.id === issueRow.id);
        if (fresh && fresh !== issueRow) setIssueRow(fresh);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- follow the list, not the slip
    }, [requests]);

    const handleIssue = (id: string) => {
        const row = requests.find((r: any) => r.id === id);
        if (!row) return;
        setIssueRow(row);
    };

    const confirmIssue = async () => {
        if (!issueRow) return;
        const itemStock = drawableFor(issueRow);
        const requested = Number(issueRow.qtyRequested ?? 0);
        const alreadyIssued = Number(issueRow.qtyIssued ?? 0);
        const stillNeeded = Math.max(requested - alreadyIssued, 0);
        const canIssueNow = Math.min(stillNeeded, itemStock);
        const shortfall = Math.max(stillNeeded - canIssueNow, 0);
        const willBackorder = shortfall > 0;

        setIssueSubmitting(true);
        try {
            await client.patch(`/requests/${issueRow.id}/issue`, {
                qtyToIssue: canIssueNow,
                // Only auto-raise an indent when stock can't cover the
                // remainder. Full-fill = no back-order = nothing extra
                // spawned, so the inventory queue stays clean.
                autoRaiseBackorder: willBackorder,
            });
            const toastMsg = !willBackorder
                ? `Issued ${canIssueNow} of ${issueRow.qtyRequested}. Edit qty on Issue Slips if needed.`
                : canIssueNow === 0
                    ? `Out of stock — back-order indent raised for ${shortfall}.`
                    : `Issued ${canIssueNow} of ${issueRow.qtyRequested}. Back-order indent raised for ${shortfall}.`;
            addToast(toastMsg, 'success');
            closeIssue();
            fetchRequests();
            // Issuing flips a request from APPROVED → IN_USE: empties the
            // Inventory Requests badge AND fills the Issue Slips badge.
            window.dispatchEvent(new Event('requests-updated'));
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to issue'), 'error');
        } finally {
            setIssueSubmitting(false);
        }
    };

    const handleView = (req: any) => { setSelectedRequest(req); setIsViewModalOpen(true); setNatureSaving(false); setSwitchingToTemporary(false); setPendingDuration(durationFor(req)); };

    // Correcting the nature after the fact is the point of this control: an
    // item raised as Temporary by mistake sits in the return queue being
    // chased forever (a lab coat is issued for someone's whole employment,
    // so it belongs on Permanent). Switching to Temporary needs a return
    // period, which is why the duration fields appear with it.
    const [natureSaving, setNatureSaving] = useState(false);
    // True only while the clerk has chosen Temporary and not yet confirmed the
    // chase period. Reset whenever a different request is opened, or the panel
    // would reappear on the next one still mid-switch.
    const [switchingToTemporary, setSwitchingToTemporary] = useState(false);
    const [pendingDuration, setPendingDuration] = useState<{ value: number; unit: string }>({ value: 1, unit: 'MONTHS' });

    /**
     * What the return-period boxes should start at for a given request.
     *
     * The requester's own answer, whenever there is one. Switching a request to
     * Permanent clears its dueDate but KEEPS durationValue/durationUnit, so a
     * request asked for as "1 minute", flipped to Permanent and flipped back
     * still knows it was 1 minute — and offering a hardcoded "1 month" there
     * would quietly replace what the requester asked for with a number nobody
     * chose. Only a request that never carried a period falls back.
     */
    const durationFor = (req: any) => ({
        value: Number(req?.durationValue) > 0 ? Number(req.durationValue) : 1,
        unit: req?.durationUnit || 'MONTHS',
    });

    const saveNature = async (next: 'TEMPORARY' | 'PERMANENT') => {
        if (!selectedRequest || next === selectedRequest.nature) return;
        setNatureSaving(true);
        try {
            const body: any = { nature: next };
            if (next === 'TEMPORARY') {
                body.durationValue = pendingDuration.value;
                body.durationUnit = pendingDuration.unit;
            }
            const res = await client.patch(`/requests/${selectedRequest.id}`, body);
            const updated = res.data?.data ?? res.data;
            setSelectedRequest({ ...selectedRequest, ...updated });
            addToast(
                next === 'PERMANENT'
                    ? 'Set to Permanent — it no longer needs returning, and the requester has been told'
                    : 'Set to Temporary — the requester has been told the new return date',
                'success',
            );
            fetchRequests();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Could not change the nature'), 'error');
        } finally {
            setNatureSaving(false);
        }
    };

    // Column filters refine the *current page* (server pagination already
    // capped it at 10 rows); options derive from those rows. Same pattern as
    // the shipped Indents Management page. Server-side search/sort is the
    // cross-set tool; these are a within-page narrowing.
    // Department / purpose / date dropped out with their columns. They only
    // ever narrowed the current page anyway; the search box now covers
    // department and purpose across the whole set, which is strictly better.
    // A filter on every data column, like the other tables (owner, 27 Oct).
    // Values match what each cell shows, so the list offers exactly what is on screen.
    const filterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'reqId', getValue: (r) => r.serialNo || r.id.split('-')[0] },
        { key: 'item', getValue: (r) => r.inventoryItem?.name || 'Unknown item' },
        { key: 'qty', getValue: (r) => `${r.qtyRequested ?? 0}${r.inventoryItem?.unit ? ` ${r.inventoryItem.unit}` : ''}` },
        { key: 'reqBy', getValue: (r) => r.createdBy?.name || 'Unknown' },
        { key: 'accountable', getValue: (r) => {
            const names = (r.responsiblePersons ?? []).map((rp: any) => rp.user?.name).filter(Boolean);
            return names.length ? names : 'None';
        } },
        { key: 'container', getValue: (r) => r.inventoryItem?.containerName || '—' },
        { key: 'tray', getValue: (r) => r.inventoryItem?.trayNumber || '—' },
        { key: 'location', getValue: (r) => r.lab?.name || '—' },
        { key: 'project', getValue: (r) => r.project?.name || 'General' },
    ], []);
    const activeF = usePagedFilters(requests, filterSpecs, 10, activeP.search);
    const historyF = usePagedFilters(pastRequests, filterSpecs, 10, historyP.search);
    const hasFilters = Object.keys(activeF.filters).length > 0 || Object.keys(historyF.filters).length > 0;

    const buildColumns = (f: ReturnType<typeof useTableFilters<any>>) => {
      // Header with its column filter (searchable — these lists run long).
      const filtered = (label: string, key: string) => ({
        filterActive: f.isActive(key),
        header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={f.getOptions(key)} value={f.filters[key] || ''} onChange={(v) => f.setFilter(key, v)} /></span>,
      });
      return [
        { ...filtered('Request ID', 'reqId'), accessor: (row: any) => (
            <div className="flex flex-col items-start gap-0.5">
                <span className="font-bold text-ink font-mono text-xs">{row.serialNo || row.id.split('-')[0]}</span>
                {/* "from BOM-XXX" chip — helps the clerk see which requests
                    are part of the same submitted BOM so they can issue them
                    together. Read-only signal, no click target (clerks don't
                    need to drill into the source BOM to act). */}
                {row?.bomList?.serialNo && (
                    <span
                        title={`Part of ${row.bomList.serialNo}${row.bomList.name ? ` — ${row.bomList.name}` : ''}`}
                        className="text-[9px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 px-1.5 py-0.5 rounded cursor-help"
                    >
                        from {row.bomList.serialNo}
                    </span>
                )}
                {/* Soft-deleted (user-withdrawn) requests appear only in the
                    History modal (the active fetch never sends includeDeleted).
                    This clerk view has no status column, so the audit mark
                    rides next to the request ID. Active rows never carry
                    deletedAt, so this never shows on the live queue. */}
                {row?.deletedAt && (
                    <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold rounded-md ring-1 ring-inset bg-red-100 dark:bg-red-400/20 text-red-700 dark:text-red-300 ring-red-600/30 dark:ring-red-400/30">
                        Deleted
                    </span>
                )}
            </div>
        ) },
        // The item name doubles as the way into the slip — clicking the name
        // is the instinctive move, and the View button at the end stays for
        // anyone who looks for an explicit control.
        { ...filtered('Item Name', 'item'), accessor: (row: any) => (
            <button
              onClick={() => handleView(row)}
              title="Open the request details"
              className="text-sm text-left font-medium text-ink hover:text-brand-dark hover:underline decoration-dotted underline-offset-2 transition-colors max-w-[180px] truncate"
            >
              {row?.inventoryItem?.name || 'Unknown item'}
            </button>
        ) },
        { ...filtered('Qty', 'qty'), accessor: (row: any) => (
            <span className="text-sm font-bold text-ink">
              {row?.qtyRequested ?? 0}
              {row?.inventoryItem?.unit && <span className="text-[10px] font-normal text-faint ml-1">{row.inventoryItem.unit}</span>}
            </span>
        ) },
        { ...filtered('Requested By', 'reqBy'),
          accessor: (row: any) => <span className="text-sm text-ink">{row.createdBy?.name || 'Unknown'}</span> },
        { ...filtered('Accountable', 'accountable'), accessor: (row: any) => <span className="text-xs text-muted max-w-[150px] truncate inline-block" title={row?.responsiblePersons?.map((rp: any) => rp.user?.name).join(', ')}>{row?.responsiblePersons?.map((rp: any) => rp.user?.name).join(', ') || 'None'}</span> },
        // Where to pick the item from. Rack address is deliberately absent —
        // container + tray is what was asked for. Roughly 40% of items have
        // these unset, hence the explicit dash rather than an empty cell.
        { ...filtered('Container', 'container'), accessor: (row: any) => row?.inventoryItem?.containerName
            ? <span className="text-xs text-muted max-w-[140px] truncate inline-block" title={row.inventoryItem.containerName}>{row.inventoryItem.containerName}</span>
            : <span className="text-xs text-faint">—</span> },
        { ...filtered('Tray', 'tray'), accessor: (row: any) => row?.inventoryItem?.trayNumber
            ? <span className="text-xs text-muted">{row.inventoryItem.trayNumber}</span>
            : <span className="text-xs text-faint">—</span> },
        // The requester's room, snapshotted when the request was raised.
        { ...filtered('Location', 'location'), accessor: (row: any) => row?.lab?.name
            ? <span className="text-xs text-muted max-w-[130px] truncate inline-block" title={row.lab.name}>{row.lab.name}</span>
            : <span className="text-xs text-faint" title="The requester had no room assigned when this was raised.">—</span> },
        { ...filtered('Project', 'project'), accessor: (row: any) => row?.project?.name
            ? <span className="text-xs text-muted max-w-[130px] truncate inline-block" title={row.project.name}>{row.project.name}</span>
            : <span className="text-xs text-faint italic">General</span> },
        // Department, Purpose and Date used to sit here. They're on the detail
        // slip instead — the clerk's queue is for deciding what to issue, and
        // those three are context you want once you've opened a request, not
        // six columns of scrolling on every row.
        { header: 'Issue', accessor: (row: any) => {
            // Only APPROVED + YET_TO_ISSUE rows are physically issuable.
            // PENDING means the manager hasn't acted yet — issuing it
            // would bypass the entire approval chain (a control bypass
            // that was confirmed live in testing). Surface the request's
            // state explicitly instead of a click that would 400.
            const canIssue = row.status === 'APPROVED' || row.status === 'YET_TO_ISSUE';
            if (canIssue) {
                return <button onClick={() => handleIssue(row.id)} className="text-xs bg-green-700 text-white px-3 py-1 rounded-md font-bold hover:bg-green-800 transition-colors shadow-sm">Issue</button>;
            }
            return (
                <span
                    className="text-[10px] font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 px-2 py-1 rounded"
                    title={row.status === 'PENDING' ? 'Manager must approve this before it can be issued.' : `Status: ${row.status}`}
                >
                    {row.status === 'PENDING' ? 'Awaiting approval' : row.status}
                </span>
            );
        }},
        { header: 'Actions', accessor: (row: any) => (
            <button onClick={() => handleView(row)} className="text-xs bg-card border border-faint text-ink px-3 py-1 rounded-md font-bold hover:bg-surface transition-colors">View</button>
        )}
      ];
    };

    // One column factory, two instances — active vs history each get their own
    // filter state (options computed from that bucket's current page).
    const columns = buildColumns(activeF);
    const historyColumns = buildColumns(historyF);

    const detailColumns = [
        { header: 'Item Name', accessor: (row: any) => row?.inventoryItem?.name || 'Unknown Item' },
        { header: 'Requested Qty', accessor: (row: any) => <span className="font-bold">{row?.qtyRequested || 0}</span> },
        { header: 'Project', accessor: (row: any) => row?.project?.name
            ? <span className="text-xs text-muted">{row.project.name}</span>
            : <span className="text-xs text-faint italic">General stock</span> },
        // The room this request was raised for, snapshotted at creation — so
        // an old slip keeps showing where the stock actually went even after
        // the requester moves desks.
        { header: 'Location', accessor: (row: any) => row?.lab?.name
            ? <span className="text-xs text-muted">{row.lab.name}</span>
            : <span className="text-xs text-faint italic" title="The requester had no room assigned when this was raised.">Not recorded</span> },
    ];

    return (
        <div className="space-y-4 md:space-y-6">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Inventory Requests</h2>
                    {hasFilters && <button onClick={() => { activeF.clearFilters(); historyF.clearFilters(); }} className="text-xs text-brand font-bold hover:underline mt-1">Clear filters</button>}
                </div>
                <button onClick={() => setIsHistoryModalOpen(true)} className="bg-ink text-card px-4 py-2 font-bold rounded-md hover:bg-black transition-colors shadow-sm">History</button>
            </div>

            <div className="bg-card rounded-xl shadow-sm border border-zebra overflow-hidden">
                <BulkSelectionBar count={activeSel.selectedIds.size} onClear={activeSel.clearSelection}>
                    {/* Bulk issue — the clerk ticks an approved batch (often a whole
                        BOM's worth) and issues it in one atomic action. We mirror the
                        single-row Issue maths per line (qty = min(stillNeeded, stock),
                        auto back-order on shortfall) and skip any non-approved row so a
                        stray PENDING tick can't roll the batch back. */}
                    <BulkActionButton
                        label="Issue"
                        count={activeSel.selectedIds.size}
                        verb="issued"
                        confirmTitle="Issue selected requests?"
                        confirmMessage={`Issue ${activeSel.selectedIds.size} selected request${activeSel.selectedIds.size === 1 ? '' : 's'} in full from current stock. Only manager-approved requests are issued — pending ones are skipped — and any short-stock line raises a back-order automatically. All-or-nothing: if a line can't be issued, none are.`}
                        onRun={async () => {
                            const rows = requests.filter((r: any) => activeSel.selectedIds.has(r.id));
                            const issuable = rows.filter((r: any) => r.status === 'APPROVED' || r.status === 'YET_TO_ISSUE');
                            const skipped = activeSel.selectedIds.size - issuable.length;
                            if (issuable.length === 0) {
                                return { succeeded: 0, failed: [{ id: '', message: 'none are approved & issuable' }] };
                            }
                            const items = issuable.map((r: any) => {
                                const remaining = Math.max(Number(r.qtyRequested ?? 0) - Number(r.qtyIssued ?? 0), 0);
                                const stock = drawableFor(r);
                                const qtyToIssue = Math.min(remaining, stock);
                                return { requestId: r.id, qtyToIssue, autoRaiseBackorder: remaining - qtyToIssue > 0 };
                            });
                            try {
                                const res = await client.post('/requests/bulk-issue', { items });
                                const issued = res.data?.data?.issuedCount ?? res.data?.issuedCount ?? items.length;
                                return { succeeded: issued, failed: skipped > 0 ? [{ id: '', message: `${skipped} not approved — skipped` }] : [] };
                            } catch (e: any) {
                                return { succeeded: 0, failed: [{ id: '', message: extractErrorMessage(e, 'Issue failed — batch rolled back') }] };
                            }
                        }}
                        onDone={() => { activeSel.clearSelection(); fetchRequests(); window.dispatchEvent(new Event('requests-updated')); }}
                    />
                </BulkSelectionBar>
                {/* Server-side search — matches across the WHOLE request set
                    (serial / item / requester), not just the current page. The
                    column filters below still refine within the loaded page. */}
                <div className="px-4 pt-2 pb-1 max-w-xs">
                    <SearchInput value={activeP.search} onChange={(e) => activeP.setSearch(e.target.value)} placeholder="Search all requests…" />
                </div>
                <DataTable
                    columns={columns}
                    data={activeF.pageRows}
                    isLoading={isLoading}
                    keyExtractor={r => r.id}
                    emptyStateMessage="No active requests."
                    rowClassName={(r: any) => (r.id === highlightId ? 'bg-amber-100/70 dark:bg-amber-400/15' : '')}
                    maxHeight="60vh"
                    selectedIds={activeSel.selectedIds}
                    onToggleSelect={activeSel.toggleSelect}
                    onToggleSelectAllVisible={activeSel.toggleSelectAllVisible}
                />
                <div className="px-4 pb-2">
                    <Pagination currentPage={activeF.page} totalPages={activeF.totalPages} onPageChange={activeF.setPage} />
                </div>
            </div>

            {/* size="lg": the items table carries four columns now (item, qty,
                project, location) and the default max-w-lg cut Location off
                the right edge entirely. */}
            <Modal size="lg" isOpen={isViewModalOpen} onClose={() => setIsViewModalOpen(false)} title={`Request Details - ${selectedRequest?.serialNo || 'N/A'}`}>
                {selectedRequest && (
                    <div className="space-y-4">
                        <div className="grid grid-cols-2 gap-4 bg-surface p-4 rounded-lg border border-line-soft">
                            <div><p className="text-[10px] text-faint uppercase font-bold">Requested By</p><p className="text-sm font-medium text-ink">{selectedRequest.createdBy?.name || 'Unknown'}</p></div>
                            <div><p className="text-[10px] text-faint uppercase font-bold">Department</p><p className="text-sm font-medium text-ink">{selectedRequest.department?.name || 'Unknown'}</p></div>
                            {/* "Nature", not "Purpose". The field is TEMPORARY/PERMANENT — it decides
                                whether the item has to come back, which is not a purpose. And
                                "Purpose" is already a real free-text field on indents and BOM
                                lines ("why do you need this"), so the same word meant two
                                unrelated things. Nature is what the request form, the revise
                                modal, the requester's own list and the CSV export all call it. */}
                            <div>
                                <p className="text-[10px] text-faint uppercase font-bold">Nature</p>
                                <div className="flex items-center gap-2 mt-0.5">
                                    <select
                                        value={switchingToTemporary ? 'TEMPORARY' : (selectedRequest.nature || '')}
                                        disabled={natureSaving}
                                        onChange={(e) => {
                                            const next = e.target.value as 'TEMPORARY' | 'PERMANENT';
                                            // Going to Temporary needs a chase period, so ask for it
                                            // first and save on confirm. Permanent needs nothing, so
                                            // it saves immediately as before.
                                            if (next === 'TEMPORARY' && selectedRequest.nature !== 'TEMPORARY') {
                                                // Re-seed here as well as on open: the row may
                                                // have been saved since the modal was opened.
                                                setPendingDuration(durationFor(selectedRequest));
                                                setSwitchingToTemporary(true);
                                            } else {
                                                setSwitchingToTemporary(false);
                                                saveNature(next);
                                            }
                                        }}
                                        className="text-sm font-medium text-ink bg-card border border-line rounded px-2 py-1 focus:border-brand outline-none disabled:opacity-50"
                                    >
                                        <option value="TEMPORARY">Temporary</option>
                                        <option value="PERMANENT">Permanent</option>
                                    </select>
                                    {natureSaving && <span className="text-[10px] text-faint">saving…</span>}
                                </div>
                                {selectedRequest.nature === 'TEMPORARY' && selectedRequest.dueDate && (
                                    <p className="text-[10px] text-faint mt-1">Due back {fmtDateTime(selectedRequest.dueDate)}</p>
                                )}
                            </div>
                            <div><p className="text-[10px] text-faint uppercase font-bold">Date</p><p className="text-sm font-medium text-ink">{fmtDateTime(selectedRequest.createdAt)}</p></div>
                                {/* Shown only while actually switching to Temporary.
                                It used to sit on every Permanent request reading "If
                                Temporary, return in …", which asked about a state the
                                request was not in and implied a Permanent item could not
                                be returned without it. It can: Permanent means no return
                                DEADLINE, not no return. This period only decides when the
                                holder starts being chased, which is why it is named that
                                and only appears when it applies. */}
                            {switchingToTemporary && (
                                <div className="col-span-2 rounded-md border border-line-soft bg-card px-3 py-2.5">
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                                        {/* One non-wrapping group: the label, the number and
                                            the unit must never be split from each other, which
                                            is what made this unreadable before. Only the
                                            buttons below may drop to a second line, and they
                                            drop together. */}
                                        <span className="flex items-center gap-2 whitespace-nowrap">
                                        <span className="shrink-0 text-xs text-secondary">Chase for return after</span>
                                        <input
                                            type="number" min={1} step={1} value={pendingDuration.value}
                                            // Whole units only — the server takes an integer duration.
                                            onChange={(e) => setPendingDuration(d => ({ ...d, value: Math.max(1, Math.round(Number(e.target.value)) || 1) }))}
                                            className="w-20 shrink-0 text-xs border border-line rounded px-2 py-1 outline-none focus:border-brand"
                                        />
                                        {/* All five units the API accepts — this list was
                                            short by minutes and hours, which the server has
                                            always taken. Labels follow the number, so it
                                            reads "1 month" and "2 months". */}
                                        <select
                                            value={pendingDuration.unit}
                                            onChange={(e) => setPendingDuration(d => ({ ...d, unit: e.target.value }))}
                                            className="w-[6.5rem] shrink-0 text-xs border border-line rounded px-2 py-1 bg-card outline-none focus:border-brand"
                                        >
                                            {DURATION_UNITS.map((u) => (
                                                <option key={u} value={u}>{durationUnitLabel(u, pendingDuration.value)}</option>
                                            ))}
                                        </select>
                                        {/* Says where the number came from, so the clerk can
                                            see they are about to accept the requester's own
                                            answer rather than a default someone has to guess at. */}
                                        {Number(selectedRequest.durationValue) > 0
                                            && pendingDuration.value === Number(selectedRequest.durationValue)
                                            && pendingDuration.unit === selectedRequest.durationUnit && (
                                            <span className="shrink-0 text-[11px] text-faint">as requested</span>
                                        )}
                                        </span>
                                        {/* Pushed to the right of the same row. The controls
                                            above have fixed widths — the unit box is sized for
                                            "minutes", the longest label — so switching
                                            singular to plural cannot change their width and
                                            reflow the line, which is what used to drop the
                                            row onto a second line at "months". */}
                                        <span className="ml-auto flex items-center gap-2">
                                        <button
                                            onClick={async () => { await saveNature('TEMPORARY'); setSwitchingToTemporary(false); }}
                                            disabled={natureSaving}
                                            className="text-[11px] font-bold px-2.5 py-1 rounded bg-ink text-card hover:bg-black disabled:opacity-50"
                                        >
                                            {natureSaving ? 'Saving…' : 'Set to Temporary'}
                                        </button>
                                        <button
                                            onClick={() => setSwitchingToTemporary(false)}
                                            className="text-[11px] font-bold px-2.5 py-1 rounded border border-line-soft text-secondary hover:text-ink"
                                        >
                                            Cancel
                                        </button>
                                        </span>
                                    </div>
                                </div>
                            )}

                        </div>
                        {/* The requester's own evidence of what they mean. Read-only
                            here: only the person who raised it can attach or replace. */}
                        <RequestAttachment
                            requestId={selectedRequest.id}
                            hasAttachment={!!selectedRequest.attachmentMime}
                            canAttach={false}
                        />
                        <div>
                            <h4 className="font-bold text-ink mb-3">Requested Items</h4>
                            <div className="border border-line rounded-lg overflow-hidden">
                                <DataTable columns={detailColumns} data={[selectedRequest]} isLoading={false} keyExtractor={r => r.id} />
                            </div>
                        </div>
                    </div>
                )}
            </Modal>

            <Modal size="2xl" isOpen={isHistoryModalOpen} onClose={() => setIsHistoryModalOpen(false)} title="Request History">
                <div className="mb-3 space-y-3">
                    <label className="flex items-center gap-1.5 text-[11px] font-bold text-muted cursor-pointer select-none w-fit" title="Show withdrawn (deleted) requests too — they stay marked in the table and the export.">
                        <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} className="accent-brand" />
                        Include withdrawn
                    </label>
                    <ExportPanel kind="requests" excludeStatus={ACTIVE_REQUEST_STATUSES} includeDeleted={showDeleted} />
                </div>
                {/* View-only — dispositioning lives on its own page (/inventory/dispositions)
                    because the data of record there is the issue slip, not the original
                    request, and history pages stay read-only by design. */}
                <DataTable
                    columns={historyColumns.filter(c => c.header !== 'Issue')}
                    data={historyF.pageRows}
                    isLoading={historyP.isLoading}
                    keyExtractor={r => r.id}
                    emptyStateMessage="No past requests."
                />
                <LoadAllCapNote truncated={historyP.truncated} shown={pastRequests.length} total={historyP.serverTotal} />
                <Pagination currentPage={historyF.page} totalPages={historyF.totalPages} onPageChange={historyF.setPage} />
            </Modal>

            {/* Issue confirmation modal — no qty input. The qty is computed
                from min(stock, stillNeeded), and fine-tuning happens on
                Issue Slips (next step) before the final Mark-as-issued.
                Modal stays so the clerk gets a sanity check + the stock
                state (full / partial / out) is visible BEFORE the click
                that actually moves stock. */}
            <Modal isOpen={!!issueRow} onClose={closeIssue} title="Issue Request">
                {issueRow && (() => {
                    const requested = Number(issueRow.qtyRequested ?? 0);
                    const alreadyIssued = Number(issueRow.qtyIssued ?? 0);
                    const stillNeeded = Math.max(requested - alreadyIssued, 0);
                    const itemStock = drawableFor(issueRow);
                    const pools = issueRow.availableToRequest;
                    const onShelf = Number(issueRow.inventoryItem?.stock ?? 0);
                    const reservedElsewhere = Math.max(onShelf - itemStock, 0);
                    const projectName = issueRow.project?.name || 'this project';
                    const canIssueNow = Math.min(stillNeeded, itemStock);
                    const shortfall = Math.max(stillNeeded - canIssueNow, 0);
                    const unit = issueRow.inventoryItem?.unit || 'unit(s)';
                    const itemName = issueRow.inventoryItem?.name || 'item';
                    const isZeroStock = itemStock === 0;
                    const isStockShort = itemStock < stillNeeded;
                    return (
                        <div className="space-y-4">
                            {/* Stock banner — colour-coded so the clerk
                                instantly sees whether they're full-filling,
                                partial-filling, or queueing. */}
                            <div className={`rounded-lg p-3 text-sm border ${
                                isZeroStock ? 'bg-red-50 dark:bg-red-400/15 border-red-200 dark:border-red-400/30' :
                                isStockShort ? 'bg-amber-50 dark:bg-amber-400/15 border-amber-200 dark:border-amber-400/30' :
                                'bg-emerald-50 dark:bg-emerald-400/15 border-emerald-200 dark:border-emerald-400/30'
                            }`}>
                                <p className={`font-bold ${
                                    isZeroStock ? 'text-red-900 dark:text-red-200' :
                                    isStockShort ? 'text-amber-900 dark:text-amber-200' :
                                    'text-emerald-900 dark:text-emerald-200'
                                }`}>
                                    {isZeroStock
                                        ? `Out of stock for ${itemName}.`
                                        : isStockShort
                                            ? `Stock is lower than the requested amount.`
                                            : `Stock available — full quantity will be issued.`}
                                </p>
                                <p className="text-xs mt-1 text-muted">
                                    Requested: <span className="font-bold">{requested} {unit}</span>
                                    {alreadyIssued > 0 && <> · Already issued: <span className="font-bold">{alreadyIssued}</span></>}
                                    {' '}· Available to this request: <span className="font-bold">{itemStock}</span>
                                </p>
                                {/* When the shelf holds more than this request
                                    can have, say where the rest went. Without
                                    this the clerk reads "40 available" with 100
                                    physically in front of them and assumes the
                                    screen is wrong. */}
                                {reservedElsewhere > 0 && (
                                    <p className="text-xs mt-1 text-muted">
                                        {onShelf} {unit} on the shelf —{' '}
                                        <span className="font-bold">{reservedElsewhere}</span> reserved for other projects
                                        {pools && pools.tag > 0 && <> · <span className="font-bold">{pools.tag}</span> allotted to {projectName}</>}
                                        .
                                    </p>
                                )}
                            </div>

                            {/* Allot here instead of leaving for Allot Items:
                                free another project's reservation, or reserve
                                for this request's project. Offered loudest
                                when the shortage is stock reserved elsewhere. */}
                            {canAllot && issueRow.inventoryItem?.id && (
                                showAllot ? (
                                    <IssueAllotPanel
                                        itemId={issueRow.inventoryItem.id}
                                        unit={unit}
                                        requestProjectId={issueRow.project?.id ?? null}
                                        requestProjectName={issueRow.project?.name ?? 'This request\'s project'}
                                        stillNeeded={stillNeeded}
                                        onSaved={() => activeP.refetch()}
                                    />
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => setShowAllot(true)}
                                        className={`text-xs font-bold ${isStockShort && reservedElsewhere > 0 ? 'text-brand hover:underline' : 'text-muted hover:text-brand'}`}
                                    >
                                        {isStockShort && reservedElsewhere > 0 ? 'Free up reserved stock for this request →' : 'Change allotment'}
                                    </button>
                                )
                            )}

                            {/* Sanity-check facts before confirming. The qty is
                                auto-computed (min of stock + still-needed) and
                                already stated by the banner above + the "Issue N"
                                button, so this box only carries what those DON'T:
                                  - who it's being issued to (requester), and
                                  - the back-order consequence — but ONLY when
                                    stock is short. A full-fill needs no note
                                    (banner + button already make it obvious),
                                    so the box collapses to one line there. */}
                            <div className="bg-surface rounded-lg p-3 border border-line-soft text-xs space-y-1">
                                <p><span className="text-faint">Requested by:</span> <span className="font-bold text-ink">{issueRow.createdBy?.name || 'Unknown'}</span></p>
                                {shortfall > 0 && (
                                    <p className="text-ink">
                                        {isZeroStock ? (
                                            <>Request will be <span className="font-bold text-amber-700 dark:text-amber-300">queued</span> — nothing issued now. A back-order indent for <span className="font-bold text-red-700 dark:text-red-300">{shortfall}</span> {unit} will be raised on the requestor's behalf.</>
                                        ) : (
                                            <><span className="font-bold text-emerald-700 dark:text-emerald-300">{canIssueNow}</span> {unit} will be issued now. A back-order indent for the remaining <span className="font-bold text-red-700 dark:text-red-300">{shortfall}</span> will be raised on the requestor's behalf.</>
                                        )}
                                    </p>
                                )}
                            </div>

                            <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
                                <button onClick={closeIssue} className="px-4 py-2 text-sm font-bold text-muted hover:bg-surface rounded">Cancel</button>
                                <button onClick={confirmIssue} disabled={issueSubmitting}
                                  className="px-5 py-2 text-sm font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50">
                                    {issueSubmitting
                                        ? 'Working…'
                                        : shortfall > 0
                                            ? (canIssueNow === 0
                                                ? `Queue + raise indent for ${shortfall}`
                                                : `Issue ${canIssueNow} + raise indent for ${shortfall}`)
                                            : `Issue ${canIssueNow}`}
                                </button>
                            </div>
                        </div>
                    );
                })()}
            </Modal>
        </div>
    );
};
