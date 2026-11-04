import { useMemo, useState } from 'react';
import { useServerPagination, useBulkSelection, usePagedFilters, FilterSpec, useAuth } from '@/hooks';
import { fmtDateTime, formatDueDelta, dateOnlyKey } from '@/utils/date';
import { RequestStatus } from '@/types';
import { DataTable, Modal, BulkSelectionBar, ColumnFilter, PendingCell, Pagination, SearchInput } from '@/components/ui';
import { statusReasonForRequest } from '@/utils/pendingReason';
import { ExtensionForm } from '@/components/forms';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { client } from '@/api';
import { extractErrorMessage } from '@/lib';
import { DispositionModal } from '@/features/communication';
import { ComponentRequestReviewModal } from '@/features/requests/components/ComponentRequestReviewModal';
import { ComponentRequestTrackModal } from '@/features/requests/components/ComponentRequestTrackModal';
import { Eye, Clock } from 'lucide-react';


const CONDITION_OPTIONS = [
    { value: 'Working', label: 'Working / Good Condition' },
    { value: 'Not Working', label: 'Not Working / Defective' },
    { value: 'Damaged', label: 'Physically Damaged' },
    { value: 'Used', label: 'Used / Partially Consumed' },
];

export const StandardMyComponentsPage = () => {
    const { addToast } = useToast();
    const confirm = useConfirm();
    const { user } = useAuth();
    // "Mine" here includes loans you are a responsible person on, but only the
    // person who raised a request may disposition it (USER/LAB; requests
    // service updateDisposition). Offering the button to everyone else ended in
    // "You can only update disposition for your own requests".
    const mayDispose = (row: any) =>
        !['USER', 'LAB'].includes(user?.role || '') || row.createdById === user?.id;
    const [isExtModalOpen, setIsExtModalOpen] = useState(false);
    const [selectedRequest, setSelectedRequest] = useState<any>(null);

    // Disposition modal state
    const [dispositionRequest, setDispositionRequest] = useState<any>(null);

    // Component-request View/Track — same shared modals used on the approval
    // surfaces, so a requester sees the identical read-only detail + timeline
    // for their own components (active, overdue, and terminal/history rows).
    const [reviewRequestId, setReviewRequestId] = useState<string | null>(null);
    const [trackRequest, setTrackRequest] = useState<any | null>(null);

    // Return modal state. `returnIds` non-empty = bulk mode (one shared
    // condition/reason applied to every selected row); empty = single mode
    // driven by `returnRequest`, unchanged from before.
    const [isReturnModalOpen, setIsReturnModalOpen] = useState(false);
    const [returnRequest, setReturnRequest] = useState<any>(null);
    const [returnIds, setReturnIds] = useState<string[]>([]);
    const [returnCondition, setReturnCondition] = useState('Working');
    const [returnReason, setReturnReason] = useState('');
    const [isSubmittingReturn, setIsSubmittingReturn] = useState(false);
    // Bulk-disposition mode for the shared DispositionModal (null = single).
    const [dispositionIds, setDispositionIds] = useState<string[] | null>(null);
    const activeSel = useBulkSelection();
    const overdueSel = useBulkSelection();

    // Three independent server-side buckets — each 10/page, scoped to the
    // signed-in user (createdByMe). Active = still in hand; Overdue = past due;
    // History = post-issuance terminal lifecycle. A disposition maps the
    // request to a terminal status atomically on the server, so this status
    // filter reproduces the old client split (status OR disposition) exactly.
    const activeP  = useServerPagination<any>({ loadAll: true, endpoint: '/requests', params: { createdByMe: true, status: 'IN_USE,RETURN_REQUESTED' } });
    const overdueP = useServerPagination<any>({ loadAll: true, endpoint: '/requests', params: { createdByMe: true, status: 'OVERDUE' } });
    const historyP = useServerPagination<any>({ endpoint: '/requests', params: { createdByMe: true, status: 'RETURNED,CONSUMED,EMBEDDED,DISPOSED' } });
    const activeRequests = activeP.items;
    const overdueRequests = overdueP.items;
    const historyRequests = historyP.items;
    const isLoading = activeP.isLoading;
    // A return / extension / disposition moves a row between buckets, so
    // refresh all three after any mutation.
    const refreshAll = () => { activeP.refetch(); overdueP.refetch(); historyP.refetch(); };

    const handleExtend = (req: any) => {
        setSelectedRequest(req);
        setIsExtModalOpen(true);
    };

    const handleInitiateReturn = (req: any) => {
        setReturnRequest(req);
        setReturnIds([]); // single mode
        setReturnCondition('Working');
        setReturnReason('');
        setIsReturnModalOpen(true);
    };

    // Open the return modal in bulk mode for a selection set.
    const openBulkReturn = (ids: Set<string>) => {
        if (ids.size === 0) return;
        setReturnRequest(null);
        setReturnIds([...ids]);
        setReturnCondition('Working');
        setReturnReason('');
        setIsReturnModalOpen(true);
    };

    // Open the shared DispositionModal in bulk mode for a selection set.
    const openBulkDisposition = (ids: Set<string>) => {
        if (ids.size === 0) return;
        const rows = [...activeP.items, ...overdueP.items].filter((r: any) => ids.has(r.id));
        const allowed = rows.filter(mayDispose).map((r: any) => r.id);
        const skipped = ids.size - allowed.length;
        if (allowed.length === 0) {
            addToast('Only the person who raised a request can mark its disposition.', 'error');
            return;
        }
        if (skipped > 0) {
            addToast(`${skipped} selected ${skipped === 1 ? 'item was' : 'items were'} raised by someone else — only they can mark disposition. Continuing with the rest.`, 'info');
        }
        setDispositionRequest(null);
        setDispositionIds(allowed);
    };

    const submitReturn = async () => {
        const isBulk = returnIds.length > 0;
        if (!isBulk && !returnRequest) return;
        setIsSubmittingReturn(true);
        try {
            if (isBulk) {
                const res = await client.post('/requests/bulk-initiate-return', {
                    ids: returnIds,
                    condition: returnCondition,
                    reason: returnReason || undefined,
                });
                const summary = res.data?.data ?? res.data ?? {};
                const ok = summary.succeeded?.length ?? 0;
                const fail = summary.failed?.length ?? 0;
                if (fail === 0) {
                    addToast(`Return initiated for ${ok} item${ok === 1 ? '' : 's'} — inventory will be notified.`, 'success');
                } else if (ok === 0) {
                    addToast(`Couldn't initiate any return. ${summary.failed?.[0]?.reason || ''}`.trim(), 'error');
                } else {
                    addToast(`Return initiated for ${ok} item${ok === 1 ? '' : 's'}; ${fail} skipped (${summary.failed?.[0]?.reason || 'not eligible'}).`, 'warning');
                }
                activeSel.clearSelection();
                overdueSel.clearSelection();
            } else {
                await client.post(`/requests/${returnRequest.id}/initiate-return`, {
                    condition: returnCondition,
                    reason: returnReason || undefined,
                });
                addToast('Return initiated — inventory staff will be notified to confirm.', 'success');
            }
            setIsReturnModalOpen(false);
            setReturnIds([]);
            refreshAll();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to initiate return'), 'error');
        }
        setIsSubmittingReturn(false);
    };

    // Withdraw a return that inventory hasn't confirmed yet.
    //
    // Initiating a return is one click and irreversible from the UI: the row
    // flips to RETURN_REQUESTED, which blocks extensions and dispositions, and
    // nothing on this page could undo it — the borrower had to find a clerk.
    // `POST /requests/:id/cancel-return` restores IN_USE (or OVERDUE if the due
    // date has passed, so this can't be used to shed an overdue flag).
    const [cancellingReturnId, setCancellingReturnId] = useState<string | null>(null);
    const handleWithdrawReturn = async (row: any) => {
        if (cancellingReturnId) return;
        if (!await confirm({
            title: 'Withdraw this return?',
            message: `${row?.inventoryItem?.name || 'This item'} goes back to being on loan to you, and inventory stops expecting it back.`,
            confirmLabel: 'Withdraw',
        })) return;
        setCancellingReturnId(row.id);
        try {
            await client.post(`/requests/${row.id}/cancel-return`, {});
            addToast('Return withdrawn — the item is back on loan to you.', 'success');
            refreshAll();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to withdraw the return'), 'error');
        }
        setCancellingReturnId(null);
    };

    const submitExtension = async (data: any) => {
        // Let failures propagate so ExtensionForm surfaces the real backend
        // message and keeps the modal open; the form owns success/error toasts.
        await client.post(`/requests/${selectedRequest.id}/extension`, data);
        setIsExtModalOpen(false);
        refreshAll();
    };

    const [isHistoryOpen, setIsHistoryOpen] = useState(false);

    const activeFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'component', getValue: (r) => r?.inventoryItem?.name },
        { key: 'qty',       getValue: (r) => (r?.qtyShortfall > 0 && r?.backorderIndentId) ? `${r?.qtyIssued ?? 0} / ${r?.qtyRequested ?? 0}` : String(r?.qtyIssued ?? r?.qtyRequested ?? 0) },
        { key: 'project',   getValue: (r) => r?.project?.name || 'General / Others' },
        { key: 'dueDate',   getValue: (r) => dateOnlyKey(r?.dueDate) },
        { key: 'status',    getValue: (r) => r?.status },
    ], []);

    const overdueFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'component', getValue: (r) => r?.inventoryItem?.name },
        { key: 'qty',       getValue: (r) => (r?.qtyShortfall > 0 && r?.backorderIndentId) ? `${r?.qtyIssued ?? 0} / ${r?.qtyRequested ?? 0}` : String(r?.qtyIssued ?? r?.qtyRequested ?? 0) },
        { key: 'project',   getValue: (r) => r?.project?.name || 'General / Others' },
        { key: 'dueDate',   getValue: (r) => dateOnlyKey(r?.dueDate) },
        // A filter on every data column (owner, 27 Oct) — the value the cell shows.
        { key: 'overdue',   getValue: (r) => { const dd = formatDueDelta(r?.dueDate); return dd.overdue ? dd.magnitude : '0'; } },
    ], []);

    const activeF = usePagedFilters(activeRequests, activeFilterSpecs, 10, activeP.search);
    const overdueF = usePagedFilters(overdueRequests, overdueFilterSpecs, 10, overdueP.search);

    const ActionButtons = ({ row }: { row: any }) => {
        const isReturnRequested = row.status === RequestStatus.RETURN_REQUESTED;
        const canDispose = [RequestStatus.IN_USE, RequestStatus.OVERDUE].includes(row.status as RequestStatus) && mayDispose(row);
        return (
            <div className="flex gap-1.5">
                {!isReturnRequested ? (
                    <>
                        <button
                            onClick={() => handleInitiateReturn(row)}
                            className="text-xs bg-brand text-white px-3 py-1.5 rounded-full font-bold hover:bg-brand-dark transition-colors whitespace-nowrap"
                        >
                            Initiate Return
                        </button>
                        {canDispose && (
                            <button
                                onClick={() => setDispositionRequest(row)}
                                className="text-xs bg-card border border-faint text-ink px-3 py-1.5 rounded font-bold hover:bg-surface transition-colors whitespace-nowrap"
                            >
                                Mark Disposition
                            </button>
                        )}
                    </>
                ) : (
                    <>
                        <span className="text-xs text-orange-600 dark:text-orange-300 font-bold px-3 py-1 leading-tight">
                            Awaiting Pickup
                            {row.returnRequest?.at && (
                                <span className="block text-[10px] font-normal text-muted whitespace-nowrap">
                                    asked {fmtDateTime(row.returnRequest.at)}{row.returnRequest.byName ? ` by ${row.returnRequest.byName}` : ''}
                                </span>
                            )}
                        </span>
                        <button
                            onClick={() => handleWithdrawReturn(row)}
                            disabled={cancellingReturnId === row.id}
                            title="Cancel this return — the item stays on loan to you"
                            className="text-xs bg-card border border-faint text-ink px-3 py-1.5 rounded font-bold hover:bg-surface transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {cancellingReturnId === row.id ? 'Withdrawing…' : 'Withdraw Return'}
                        </button>
                    </>
                )}
                <button onClick={() => setReviewRequestId(row.id)} title="View details" className="text-xs bg-hover text-ink px-3 py-1.5 rounded font-bold hover:bg-line transition-colors inline-flex items-center gap-1 whitespace-nowrap"><Eye size={12} /> View</button>
                <button onClick={() => setTrackRequest(row)} title="Track timeline" className="text-xs bg-hover text-ink px-3 py-1.5 rounded font-bold hover:bg-line transition-colors inline-flex items-center gap-1 whitespace-nowrap"><Clock size={12} /> Track</button>
            </div>
        );
    };

    const activeColumns = [
        { filterActive: activeF.isActive('component'), header: <span className="inline-flex items-center">Component<ColumnFilter searchable options={activeF.getOptions('component')} value={activeF.filters.component || ''} onChange={(v) => activeF.setFilter('component', v)} /></span>, accessor: (row: any) => <span className="font-bold text-ink">{row?.inventoryItem?.name || 'Unknown Item'}</span> },
        { filterActive: activeF.isActive('qty'),       header: <span className="inline-flex items-center">Qty<ColumnFilter options={activeF.getOptions('qty')}                            value={activeF.filters.qty       || ''} onChange={(v) => activeF.setFilter('qty', v)}       /></span>, accessor: (row: any) => {
            const issued = row?.qtyIssued ?? 0;
            const requested = row?.qtyRequested ?? 0;
            const shortfall = row?.qtyShortfall ?? 0;
            if (shortfall > 0 && row?.backorderIndentId) {
                return (
                    <div className="flex flex-col items-start gap-0.5">
                        <span className="font-bold">{issued} / {requested}</span>
                        <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 px-1.5 py-0.5 rounded">
                            Partial — {shortfall} on back-order
                        </span>
                    </div>
                );
            }
            // Show the actually-issued qty (what's physically in the user's
            // hands) once it's set; fall back to requested for pre-issue rows.
            // If the inventory clerk later corrects the issued qty inline,
            // this column reflects the truth instead of the old ask.
            const display = issued || requested;
            const corrected = issued > 0 && issued !== requested;
            return (
                <span className="font-bold inline-flex items-center gap-1">
                    {display}
                    {corrected && (
                        <span
                            className="text-[10px] font-medium text-faint cursor-help"
                            title={`Inventory issued ${issued} (requested ${requested}).`}
                        >(req {requested})</span>
                    )}
                </span>
            );
        }},
        { filterActive: activeF.isActive('project'),   header: <span className="inline-flex items-center">Project<ColumnFilter options={activeF.getOptions('project')}                    value={activeF.filters.project   || ''} onChange={(v) => activeF.setFilter('project', v)}   /></span>, accessor: (row: any) => row?.project?.name || <span className="italic text-faint">General / Others</span> },
        { filterActive: activeF.isActive('dueDate'),   header: <span className="inline-flex items-center">Due Date<ColumnFilter searchable options={activeF.getOptions('dueDate')}      value={activeF.filters.dueDate   || ''} onChange={(v) => activeF.setFilter('dueDate', v)}   /></span>, accessor: (row: any) => row?.dueDate ? fmtDateTime(row.dueDate) : 'N/A' },
        { filterActive: activeF.isActive('status'),    header: <span className="inline-flex items-center">Status<ColumnFilter options={activeF.getOptions('status')}                      value={activeF.filters.status    || ''} onChange={(v) => activeF.setFilter('status', v)}    /></span>, accessor: (row: any) => <PendingCell status={row?.status || 'UNKNOWN'} reason={statusReasonForRequest(row)} /> },
        { header: 'Action', accessor: (row: any) => <ActionButtons row={row} /> },
    ];

    const overdueColumns = [
        { filterActive: overdueF.isActive('component'), header: <span className="inline-flex items-center">Component<ColumnFilter searchable options={overdueF.getOptions('component')} value={overdueF.filters.component || ''} onChange={(v) => overdueF.setFilter('component', v)} /></span>, accessor: (row: any) => <span className="font-bold text-ink">{row?.inventoryItem?.name || 'Unknown Item'}</span> },
        { filterActive: overdueF.isActive('qty'),       header: <span className="inline-flex items-center">Qty<ColumnFilter options={overdueF.getOptions('qty')}                            value={overdueF.filters.qty       || ''} onChange={(v) => overdueF.setFilter('qty', v)}       /></span>, accessor: (row: any) => {
            const issued = Number(row?.qtyIssued ?? 0);
            const requested = Number(row?.qtyRequested ?? 0);
            const shortfall = Number(row?.qtyShortfall ?? 0);
            if (shortfall > 0 && row?.backorderIndentId) {
                return (
                    <div className="flex flex-col items-start gap-0.5">
                        <span className="font-bold">{issued} / {requested}</span>
                        <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 px-1.5 py-0.5 rounded">
                            Partial — {shortfall} on back-order
                        </span>
                    </div>
                );
            }
            const display = issued || requested;
            const corrected = issued > 0 && issued !== requested;
            return (
                <span className="font-bold inline-flex items-center gap-1">
                    {display}
                    {corrected && (
                        <span
                            className="text-[10px] font-medium text-faint cursor-help"
                            title={`Inventory issued ${issued} (requested ${requested}).`}
                        >(req {requested})</span>
                    )}
                </span>
            );
        }},
        { filterActive: overdueF.isActive('project'),   header: <span className="inline-flex items-center">Project<ColumnFilter options={overdueF.getOptions('project')}                    value={overdueF.filters.project   || ''} onChange={(v) => overdueF.setFilter('project', v)}   /></span>, accessor: (row: any) => row?.project?.name || <span className="italic text-faint">General / Others</span> },
        { filterActive: overdueF.isActive('dueDate'),   header: <span className="inline-flex items-center">Due Date<ColumnFilter searchable options={overdueF.getOptions('dueDate')}      value={overdueF.filters.dueDate   || ''} onChange={(v) => overdueF.setFilter('dueDate', v)}   /></span>, accessor: (row: any) => row?.dueDate ? fmtDateTime(row.dueDate) : 'N/A' },
        {
            filterActive: overdueF.isActive('overdue'),
            header: <span className="inline-flex items-center">Overdue<ColumnFilter searchable options={overdueF.getOptions('overdue')} value={overdueF.filters.overdue || ''} onChange={(v) => overdueF.setFilter('overdue', v)} /></span>,
            accessor: (row: any) => {
                const dd = formatDueDelta(row?.dueDate);
                return <span className="font-bold text-red-700 dark:text-red-300">{dd.overdue ? dd.magnitude : '0'}</span>;
            }
        },
        {
            header: 'Action',
            accessor: (row: any) => (
                <div className="flex gap-1.5">
                    <button
                        onClick={() => handleInitiateReturn(row)}
                        className="text-xs bg-brand text-white px-3 py-1.5 rounded-full font-bold hover:bg-brand-dark transition-colors whitespace-nowrap"
                    >
                        Initiate Return
                    </button>
                    <button
                        onClick={() => handleExtend(row)}
                        className="text-xs bg-card border border-faint text-ink px-3 py-1.5 rounded font-bold hover:bg-surface transition-colors shadow-sm whitespace-nowrap"
                    >
                        Request Extension
                    </button>
                    <button
                        onClick={() => setDispositionRequest(row)}
                        className="text-xs bg-card border border-faint text-ink px-3 py-1.5 rounded font-bold hover:bg-surface transition-colors whitespace-nowrap"
                    >
                        Mark Disposition
                    </button>
                    <button onClick={() => setReviewRequestId(row.id)} title="View details" className="text-xs bg-hover text-ink px-3 py-1.5 rounded font-bold hover:bg-line transition-colors inline-flex items-center gap-1 whitespace-nowrap"><Eye size={12} /> View</button>
                    <button onClick={() => setTrackRequest(row)} title="Track timeline" className="text-xs bg-hover text-ink px-3 py-1.5 rounded font-bold hover:bg-line transition-colors inline-flex items-center gap-1 whitespace-nowrap"><Clock size={12} /> Track</button>
                </div>
            )
        }
    ];

    // Read-only column set for the History modal — same data columns as the
    // active table, with the lifecycle Action column (return/dispose) dropped
    // but a View/Track action kept so a requester can still audit the full
    // detail + timeline of a terminal (returned/consumed/disposed) component.
    const historyColumns = [
        ...activeColumns.filter(c => c.header !== 'Action'),
        { header: 'Action', accessor: (row: any) => (
            <div className="flex gap-1.5">
                <button onClick={() => setReviewRequestId(row.id)} title="View details" className="text-xs bg-hover text-ink px-3 py-1.5 rounded font-bold hover:bg-line transition-colors inline-flex items-center gap-1 whitespace-nowrap"><Eye size={12} /> View</button>
                <button onClick={() => setTrackRequest(row)} title="Track timeline" className="text-xs bg-hover text-ink px-3 py-1.5 rounded font-bold hover:bg-line transition-colors inline-flex items-center gap-1 whitespace-nowrap"><Clock size={12} /> Track</button>
            </div>
        )},
    ];

    return (
        <div className="space-y-8">
            <div className="flex items-center justify-between">
                <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">My Components</h2>
                <button
                    onClick={() => setIsHistoryOpen(true)}
                    className="bg-ink text-card px-3 py-1.5 text-xs font-bold rounded-md hover:bg-black transition-colors shadow-sm"
                    title="Components you've returned, consumed, embedded, or disposed of"
                >
                    History {historyP.total > 0 && <span className="ml-1 text-[10px] opacity-80">({historyP.total})</span>}
                </button>
            </div>

            {/* Server-side search across the WHOLE set (active, overdue, and
                history), not just the loaded page — broadcasts to all three
                paginated tables. Column filters still refine within a page. */}
            <div className="max-w-xs">
                <SearchInput
                    value={activeP.search}
                    onChange={(e) => { const v = e.target.value; activeP.setSearch(v); overdueP.setSearch(v); historyP.setSearch(v); }}
                    placeholder="Search all my components…"
                />
            </div>

            {overdueP.total > 0 && (
                 <div className="bg-card border border-red-200 dark:border-red-400/30 rounded-xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] overflow-hidden">
                     <div className="bg-red-700 px-6 py-4 border-b border-red-800">
                         <h3 className="text-lg font-bold text-white tracking-tight leading-none">Overdue Components</h3>
                     </div>
                     <div className="p-0">
                         <div className="px-6 pt-3">
                             <BulkSelectionBar count={overdueSel.selectedIds.size} onClear={overdueSel.clearSelection}>
                                 <button onClick={() => openBulkReturn(overdueSel.selectedIds)} className="text-xs bg-brand text-white px-3 py-1.5 rounded-full font-bold hover:bg-brand-dark transition-colors whitespace-nowrap">Initiate Return</button>
                                 <button onClick={() => openBulkDisposition(overdueSel.selectedIds)} className="text-xs bg-card border border-emerald-300 dark:border-emerald-400/30 text-emerald-800 dark:text-emerald-200 px-3 py-1.5 rounded font-bold hover:bg-emerald-100 dark:bg-emerald-400/20 transition-colors whitespace-nowrap">Mark Disposition</button>
                             </BulkSelectionBar>
                         </div>
                         <DataTable
                            columns={overdueColumns}
                            data={overdueF.pageRows}
                            isLoading={overdueP.isLoading}
                            keyExtractor={r => r.id}
                            emptyStateMessage=""
                            selectedIds={overdueSel.selectedIds}
                            onToggleSelect={overdueSel.toggleSelect}
                            onToggleSelectAllVisible={overdueSel.toggleSelectAllVisible}
                         />
                         <div className="px-6"><Pagination currentPage={overdueF.page} totalPages={overdueF.totalPages} onPageChange={overdueF.setPage} /></div>
                     </div>
                     <div className="bg-red-50 dark:bg-red-400/15 p-4 border-t border-red-100 dark:border-red-400/25 flex items-center justify-center">
                         <svg className="h-5 w-5 text-red-700 dark:text-red-300 mr-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                         </svg>
                         <p className="text-sm text-red-700 dark:text-red-300 font-bold">Duration exceeded. Please return or request an extension for overdue components.</p>
                     </div>
                 </div>
            )}

            <div className="bg-card rounded-xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-zebra overflow-hidden">
                <div className="bg-card px-6 py-5 border-b border-line-soft">
                    <h3 className="text-lg font-bold text-ink">My Active Components</h3>
                </div>
                <div className="p-0">
                    <div className="px-6 pt-3">
                        <BulkSelectionBar count={activeSel.selectedIds.size} onClear={activeSel.clearSelection}>
                            <button onClick={() => openBulkReturn(activeSel.selectedIds)} className="text-xs bg-brand text-white px-3 py-1.5 rounded-full font-bold hover:bg-brand-dark transition-colors whitespace-nowrap">Initiate Return</button>
                            <button onClick={() => openBulkDisposition(activeSel.selectedIds)} className="text-xs bg-card border border-emerald-300 dark:border-emerald-400/30 text-emerald-800 dark:text-emerald-200 px-3 py-1.5 rounded font-bold hover:bg-emerald-100 dark:bg-emerald-400/20 transition-colors whitespace-nowrap">Mark Disposition</button>
                        </BulkSelectionBar>
                    </div>
                    <DataTable
                        columns={activeColumns}
                        data={activeF.pageRows}
                        isLoading={isLoading}
                        keyExtractor={r => r.id}
                        emptyStateMessage={
                          // "You have no active components" was shown whether or
                          // not a search was running, so a search that simply
                          // matched nothing read as "you hold nothing at all".
                          //
                          // Worse, this page is easily mistaken for the
                          // catalogue: it has a search box, and the items in it
                          // ARE inventory items. Someone looking for a part they
                          // know exists searches here, is told there is nothing,
                          // and concludes the item is missing from the system —
                          // the exact "why can't I see this item" report, arrived
                          // at without any item being hidden. So when a search is
                          // running, say what was actually searched and point at
                          // the page that lists everything.
                          activeP.search.trim()
                            ? `No component you are holding matches “${activeP.search.trim()}”. This page shows only what has been issued to you — to find and request an item, open Inventory Items.`
                            : 'You have no active components.'
                        }
                        selectedIds={activeSel.selectedIds}
                        onToggleSelect={activeSel.toggleSelect}
                        onToggleSelectAllVisible={activeSel.toggleSelectAllVisible}
                    />
                    <div className="px-6"><Pagination currentPage={activeF.page} totalPages={activeF.totalPages} onPageChange={activeF.setPage} /></div>
                </div>
            </div>

            <Modal isOpen={isExtModalOpen} onClose={() => setIsExtModalOpen(false)} title="Request Extension">
                <ExtensionForm requestDetails={selectedRequest} onSubmit={submitExtension} isLoading={false} />
            </Modal>

            <Modal isOpen={isReturnModalOpen} onClose={() => setIsReturnModalOpen(false)} title={returnIds.length > 0 ? `Initiate Return (${returnIds.length} item${returnIds.length === 1 ? '' : 's'})` : 'Initiate Return'}>
                <div className="space-y-5">
                    {returnIds.length > 0 ? (
                        <div className="bg-surface rounded-lg p-4 border border-line-soft">
                            <p className="text-sm font-bold text-ink">{returnIds.length} component{returnIds.length === 1 ? '' : 's'} selected</p>
                            <p className="text-xs text-muted mt-1">
                                The same condition + reason is applied to each. Items not eligible for return (already requested, permanent) are skipped and reported.
                            </p>
                        </div>
                    ) : returnRequest && (
                        <div className="bg-surface rounded-lg p-4 border border-line-soft">
                            <p className="text-sm font-bold text-ink">{returnRequest.inventoryItem?.name}</p>
                            <p className="text-xs text-muted mt-1">
                                {returnRequest.serialNo} &middot; Qty: {returnRequest.qtyRequested} &middot; {returnRequest.project?.name || 'General / Others'}
                            </p>
                        </div>
                    )}

                    <div>
                        <label className="block text-sm font-bold text-ink mb-2">Component Condition</label>
                        <div className="grid grid-cols-2 gap-2">
                            {CONDITION_OPTIONS.map(opt => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    onClick={() => setReturnCondition(opt.value)}
                                    className={`text-xs font-bold px-3 py-2.5 rounded-lg border transition-colors text-left ${
                                        returnCondition === opt.value
                                            ? 'border-brand bg-brand/10 text-ink'
                                            : 'border-line bg-card text-muted hover:border-line'
                                    }`}
                                >
                                    {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-ink mb-2">Reason / Notes <span className="font-normal text-faint">(optional)</span></label>
                        <textarea
                            value={returnReason}
                            onChange={e => setReturnReason(e.target.value)}
                            rows={3}
                            placeholder="e.g. Project completed, no longer needed..."
                            className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand resize-none"
                        />
                    </div>

                    <div className="bg-amber-50 dark:bg-amber-400/15 border border-amber-100 dark:border-amber-400/25 rounded-lg p-3">
                        <p className="text-xs text-amber-700 dark:text-amber-300">
                            <span className="font-bold">Note:</span> Your return will be sent to inventory staff for confirmation. Please bring the component to the inventory counter.
                        </p>
                    </div>

                    <div className="flex justify-end gap-3 pt-2">
                        <button
                            onClick={() => setIsReturnModalOpen(false)}
                            className="text-sm font-bold text-muted px-4 py-2 rounded-lg hover:bg-surface transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={submitReturn}
                            disabled={isSubmittingReturn}
                            className="text-sm font-bold bg-brand text-white px-5 py-2 rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50"
                        >
                            {isSubmittingReturn ? 'Submitting...' : 'Submit Return'}
                        </button>
                    </div>
                </div>
            </Modal>

            <DispositionModal
                isOpen={!!dispositionRequest || (dispositionIds != null && dispositionIds.length > 0)}
                onClose={() => { setDispositionRequest(null); setDispositionIds(null); }}
                request={dispositionRequest}
                requestIds={dispositionIds ?? undefined}
                // Bulk success also clears the selection sets (the dispositioned
                // rows leave the bucket anyway); single success just refreshes.
                // `dispositionIds` is read at render time, so the open session's
                // onSuccess is captured correctly before onClose nulls it.
                onSuccess={dispositionIds && dispositionIds.length > 0
                    ? () => { activeSel.clearSelection(); overdueSel.clearSelection(); refreshAll(); }
                    : refreshAll}
            />

            {/* History modal — view-only post-issuance terminal records. No
                action buttons because the lifecycle has ended: a RETURNED
                row can't be returned again, a CONSUMED row can't be undone.
                If a user needs the same component they raise a fresh
                request. */}
            <Modal size="2xl" isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} title="My Components History">
                <DataTable
                    columns={historyColumns}
                    data={historyRequests}
                    isLoading={historyP.isLoading}
                    keyExtractor={r => r.id}
                    emptyStateMessage="No completed components yet."
                    maxHeight="60vh"
                />
                <Pagination currentPage={historyP.page} totalPages={historyP.totalPages} onPageChange={historyP.setPage} />
            </Modal>

            <ComponentRequestReviewModal requestId={reviewRequestId} onClose={() => setReviewRequestId(null)} />
            <ComponentRequestTrackModal request={trackRequest} onClose={() => setTrackRequest(null)} />
        </div>
    );
};
