import { useMemo, useState } from 'react';
import { DataTable, Modal, ColumnFilter, BulkSelectionBar, SearchInput, ExportPanel, Pagination } from '@/components/ui';
import { useBulkSelection, useServerPagination, usePagedFilters, useTableFilters, FilterSpec } from '@/hooks';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { resolveIssuedQty } from '@/utils/qty';
import { DispositionModal } from '@/features/communication';
// Items eligible for disposition: anything inventory has already handed over
// and that has NOT yet been returned or dispositioned. We key off the
// issue-slip side of the request (qtyIssued / issuedAt / issuedToName) so the
// user sees what was *actually* given — those numbers can differ from
// qtyRequested when inventory edited the slip before marking issued.
const NEEDS_DISPOSITION_STATUSES = ['IN_USE', 'OVERDUE'];

// Only these disposition values count as "the user marked it" — the
// disposition column is overloaded: it also stores defaults like IN_USE and
// return-side values like RETURNED_GOOD/RETURNED_DAMAGED. Matching the
// backend's `validDispositions` set in updateDisposition() keeps the two
// concepts in sync.
const TERMINAL_DISPOSITIONS = new Set(['EMBEDDED', 'CONSUMED', 'DAMAGED', 'DISPOSED', 'LONG_TERM_LOAN']);

const DISPOSITION_COLORS: Record<string, string> = {
    EMBEDDED: 'bg-purple-50 dark:bg-purple-400/15 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-400/30',
    CONSUMED: 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30',
    DAMAGED: 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30',
    DISPOSED: 'bg-hover text-secondary border-line',
    LONG_TERM_LOAN: 'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30',
};

const daysSince = (iso?: string | null) => {
    if (!iso) return null;
    const ms = Date.now() - new Date(iso).getTime();
    return Math.max(0, Math.floor(ms / 86400000));
};

export const DispositionPage = () => {
    const [dispositionRequest, setDispositionRequest] = useState<any>(null);
    // Bulk-disposition mode (null = single-item). Lets the clerk mark a whole
    // selection — e.g. every line of one BOM — with one disposition + note.
    const [dispositionIds, setDispositionIds] = useState<string[] | null>(null);
    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);

    const sel = useBulkSelection();

    // Two server-side buckets, 10/page each. Eligible = issued-out items not
    // yet returned/dispositioned (status IN_USE/OVERDUE, disposition NOT in the
    // terminal set). History = anything the user has explicitly marked
    // (disposition IN the terminal set — keyed off disposition, not status,
    // because LONG_TERM_LOAN keeps status=IN_USE). The split + search run
    // server-side via the status / excludeDisposition / disposition comma
    // params, so neither table ever loads the full request log.
    const eligibleP = useServerPagination<any>({ loadAll: true,
        endpoint: '/requests',
        params: { status: NEEDS_DISPOSITION_STATUSES.join(','), excludeDisposition: [...TERMINAL_DISPOSITIONS].join(',') },
    });
    // History loads in full while its modal is open, so its column filters
    // see every row rather than one page of ten. Closed, it still loads one
    // page: the "dispositioned" tile, the History badge and the empty-state
    // line all need the count, and with the query switched off they read 0
    // until somebody happened to open History.
    const historyP = useServerPagination<any>({ loadAll: isHistoryModalOpen,
        endpoint: '/requests',
        params: { disposition: [...TERMINAL_DISPOSITIONS].join(',') },
    });
    // The server's count, right in both modes (`total` is rows loaded).
    const historyCount = historyP.serverTotal;
    const requests = eligibleP.items;
    const pastDispositions = historyP.items;

    // Refresh both buckets after a disposition is recorded. Same name as the
    // old fetcher so the DispositionModal onSuccess call site is unchanged.
    const fetchRequests = () => {
        eligibleP.refetch(); historyP.refetch();
        // A disposition flips a request out of IN_USE — refresh the Issue Slips
        // badge + sibling request views, which listen on requests-updated.
        window.dispatchEvent(new Event('requests-updated'));
    };

    // Column filters run over every eligible row (loadAll), then the result is
    // paged — they used to see only the current 10 rows.
    // A filter on every data column (owner, 27 Oct); values match the cells.
    const filterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'reqId', getValue: (r) => r.serialNo || r.id.split('-')[0] },
        { key: 'item', getValue: (r) => r?.inventoryItem?.name || 'Unknown' },
        { key: 'issuedTo', getValue: (r) => r?.issuedToName || r?.createdBy?.name || 'Unknown' },
        { key: 'qty', getValue: (r) => String(resolveIssuedQty(r)) },
        { key: 'dept', getValue: (r) => r?.department?.name || 'Unknown' },
        { key: 'issuedAt', getValue: (r) => (r?.issuedAt ? fmtDate(r.issuedAt) : '-') },
        { key: 'daysOut', getValue: (r) => { const d = daysSince(r?.issuedAt); return d == null ? '-' : `${d}d`; } },
        { key: 'status', getValue: (r) => r.status },
    ], []);
    const f = usePagedFilters(requests, filterSpecs, 10, eligibleP.search);
    const historySpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'reqId', getValue: (r) => r.serialNo || r.id.split('-')[0] },
        { key: 'item', getValue: (r) => r?.inventoryItem?.name || 'Unknown' },
        { key: 'issuedTo', getValue: (r) => r?.issuedToName || r?.createdBy?.name || 'Unknown' },
        { key: 'qty', getValue: (r) => String(resolveIssuedQty(r)) },
        { key: 'disposition', getValue: (r) => r.disposition || '' },
        { key: 'dispositionedAt', getValue: (r) => (r?.dispositionDate ? fmtDate(r.dispositionDate) : '-') },
        { key: 'notes', getValue: (r) => r?.dispositionNotes || '—' },
    ], []);
    const hf = usePagedFilters(pastDispositions, historySpecs, 10, historyP.search);

    // Header with its column filter (searchable — these lists run long).
    const filtered = (t: ReturnType<typeof useTableFilters<any>>, label: string, key: string) => ({
        filterActive: t.isActive(key),
        header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={t.getOptions(key)} value={t.filters[key] || ''} onChange={(v) => t.setFilter(key, v)} /></span>,
    });

    const hasFilters = !!eligibleP.search || Object.keys(f.filters).length > 0;

    const columns = [
        // Request ID + BOM chip — when this disposition row is part of a
        // larger BOM, the clerk often wants to handle all of that BOM's
        // dispositions together (consumed, embedded, damaged, etc.).
        { ...filtered(f, 'Request ID', 'reqId'), accessor: (row: any) => (
            <div className="flex flex-col items-start gap-0.5">
                <span className="font-mono text-xs font-bold text-ink">{row.serialNo || row.id.split('-')[0]}</span>
                {row.bomList?.serialNo && (
                    <span
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full bg-brand-100 text-brand-700 border border-brand-200"
                        title={`From BOM ${row.bomList.serialNo} — ${row.bomList.name || ''}`}
                    >
                        📦 {row.bomList.serialNo}
                    </span>
                )}
            </div>
        )},
        { ...filtered(f, 'Item', 'item'), accessor: (row: any) =>
            <span className="text-sm font-bold text-ink">{row?.inventoryItem?.name || 'Unknown'}</span>
        },
        { ...filtered(f, 'Issued To', 'issuedTo'),
          accessor: (row: any) =>
            <span className="text-sm text-ink">{row?.issuedToName || row?.createdBy?.name || 'Unknown'}</span>
        },
        // The issued qty is what was *actually* handed over (inventory may have
        // edited the slip before marking issued). Fall back to qtyRequested only
        // when qtyIssued is null/undefined — older rows pre-date the split.
        { ...filtered(f, 'Issued Qty', 'qty'), accessor: (row: any) => {
            const issued = row?.qtyIssued;
            const requested = row?.qtyRequested ?? 0;
            const displayed = resolveIssuedQty(row);
            const diverged = issued != null && Number(issued) !== Number(requested);
            return (
                <span className="text-sm font-bold text-ink">
                    {displayed}
                    {diverged && (
                        <span className="ml-1 text-[10px] font-bold text-amber-700 dark:text-amber-300" title={`Requested ${requested}, issued ${issued}`}>
                            (req {requested})
                        </span>
                    )}
                </span>
            );
        }},
        { ...filtered(f, 'Department', 'dept'),
          accessor: (row: any) => <span className="text-xs text-muted">{row?.department?.name || 'Unknown'}</span>
        },
        { ...filtered(f, 'Issued At', 'issuedAt'), accessor: (row: any) =>
            row?.issuedAt
                ? <span className="text-xs text-muted">{fmtDateTime(row.issuedAt)}</span>
                : <span className="text-xs text-faint">-</span>
        },
        { ...filtered(f, 'Days Out', 'daysOut'), accessor: (row: any) => {
            const days = daysSince(row?.issuedAt);
            if (days == null) return <span className="text-xs text-faint">-</span>;
            const isOverdue = row.status === 'OVERDUE' || days > 30;
            return (
                <span className={`text-xs font-bold ${isOverdue ? 'text-red-700 dark:text-red-300' : 'text-muted'}`}>
                    {days}d
                </span>
            );
        }},
        { ...filtered(f, 'Status', 'status'),
          accessor: (row: any) => {
            const color = row.status === 'OVERDUE'
                ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30'
                : 'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30';
            return (
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${color}`}>
                    {row.status}
                </span>
            );
        }},
        { header: 'Action', accessor: (row: any) => (
            <button
                onClick={() => setDispositionRequest(row)}
                className="text-xs bg-purple-50 dark:bg-purple-400/15 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-400/30 px-3 py-1 rounded font-bold hover:bg-purple-100 dark:bg-purple-400/20 transition-colors"
            >
                Mark Disposition
            </button>
        )},
    ];

    // History modal columns — view-only; data of record is the disposition
    // event itself (type, date, notes) keyed against the issued slip.
    const historyColumns = [
        { ...filtered(hf, 'Request ID', 'reqId'), accessor: (row: any) =>
            <span className="font-mono text-xs font-bold text-ink">{row.serialNo || row.id.split('-')[0]}</span>
        },
        { ...filtered(hf, 'Item', 'item'), accessor: (row: any) =>
            <span className="text-sm font-bold text-ink">{row?.inventoryItem?.name || 'Unknown'}</span>
        },
        { ...filtered(hf, 'Issued To', 'issuedTo'), accessor: (row: any) =>
            <span className="text-sm text-ink">{row?.issuedToName || row?.createdBy?.name || 'Unknown'}</span>
        },
        { ...filtered(hf, 'Issued Qty', 'qty'), accessor: (row: any) =>
            <span className="text-sm font-bold text-ink">{resolveIssuedQty(row)}</span>
        },
        { ...filtered(hf, 'Disposition', 'disposition'), accessor: (row: any) => {
            const color = DISPOSITION_COLORS[row.disposition] || 'bg-surface text-secondary border-line';
            return (
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${color}`}>
                    {row.disposition}
                </span>
            );
        }},
        { ...filtered(hf, 'Dispositioned At', 'dispositionedAt'), accessor: (row: any) =>
            row?.dispositionDate
                ? <span className="text-xs text-muted">{fmtDateTime(row.dispositionDate)}</span>
                : <span className="text-xs text-faint">-</span>
        },
        { ...filtered(hf, 'Notes', 'notes'), accessor: (row: any) =>
            row?.dispositionNotes
                ? <span className="text-xs text-muted max-w-[200px] truncate inline-block" title={row.dispositionNotes}>{row.dispositionNotes}</span>
                : <span className="text-xs text-faint italic">—</span>
        },
        // EMBEDDED / CONSUMED / DISPOSED / DAMAGED are physically terminal —
        // they leave the request in a non-IN_USE status and the backend
        // rejects further disposition changes. LONG_TERM_LOAN is the one
        // soft state (status stays IN_USE) so the user can change their
        // mind later — surface an action just for those rows.
        { header: '', accessor: (row: any) => row.disposition === 'LONG_TERM_LOAN' ? (
            <button
                onClick={() => { setIsHistoryModalOpen(false); setDispositionRequest(row); }}
                className="text-xs bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-400/30 px-2 py-1 rounded font-bold hover:bg-blue-100 dark:bg-blue-400/20 transition-colors"
                title="Change disposition (only available for long-term loans)"
            >
                Change
            </button>
        ) : null },
    ];

    return (
        <div className="space-y-4 md:space-y-6">
            {/* Stacks below sm — see LabsPage: the two counters plus the
                History button overflow the header at phone width, and History
                was clipped off the edge. */}
            <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-start">
                <div className="min-w-0">
                    <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Item Dispositions</h2>
                    <p className="text-xs text-muted mt-1">
                        Items currently checked out — record what happened to them (consumed, embedded, damaged, long-term loan).
                    </p>
                    {hasFilters && (
                        <button
                            onClick={() => { eligibleP.setSearch(''); f.clearFilters(); }}
                            className="text-xs text-brand font-bold hover:underline mt-1"
                        >
                            Clear filters
                        </button>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-4">
                    <div className="text-right">
                        <p className="text-3xl font-bold text-ink">{eligibleP.total}</p>
                        <p className="text-[10px] text-muted uppercase font-bold tracking-wider">pending</p>
                    </div>
                    {/* Dispositioned counter — twin of the "pending" tile so
                        the user can SEE at a glance that their recent marks
                        went through. Was previously buried behind the
                        History button: users would mark a disposition, see
                        the pending list shrink, and not realise the History
                        modal was where their entry now lived. */}
                    <div className="text-right">
                        <p className="text-3xl font-bold text-emerald-700 dark:text-emerald-300">{historyCount}</p>
                        <p className="text-[10px] text-muted uppercase font-bold tracking-wider">dispositioned</p>
                    </div>
                    <button
                        onClick={() => setIsHistoryModalOpen(true)}
                        className="bg-ink text-card px-4 py-2 font-bold rounded-md hover:bg-black transition-colors shadow-sm inline-flex items-center gap-2"
                    >
                        History
                        {historyCount > 0 && (
                            <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 bg-card text-ink text-[11px] font-bold rounded-full">
                                {historyCount}
                            </span>
                        )}
                    </button>
                </div>
            </div>

            <div className="bg-card rounded-xl shadow-sm border border-zebra overflow-hidden">
                <div className="p-4 border-b border-line-soft">
                    <SearchInput
                        value={eligibleP.search}
                        onChange={(e) => eligibleP.setSearch(e.target.value)}
                        placeholder="Search by serial, item, or requester..."
                    />
                </div>
                <BulkSelectionBar count={sel.selectedIds.size} onClear={sel.clearSelection}>
                    <button
                        onClick={() => { if (sel.selectedIds.size > 0) { setDispositionRequest(null); setDispositionIds([...sel.selectedIds]); } }}
                        className="text-xs bg-purple-600 text-white px-3 py-1.5 rounded font-bold hover:bg-purple-700 transition-colors whitespace-nowrap"
                    >
                        Mark Disposition
                    </button>
                </BulkSelectionBar>
                <DataTable
                    columns={columns}
                    data={f.pageRows}
                    isLoading={eligibleP.isLoading}
                    keyExtractor={r => r.id}
                    emptyStateMessage={historyCount > 0
                        ? `Nothing pending right now. ${historyCount} item${historyCount === 1 ? '' : 's'} already dispositioned — click History above to view.`
                        : 'Nothing to disposition right now — all issued items are accounted for.'}
                    maxHeight="65vh"
                    selectedIds={sel.selectedIds}
                    onToggleSelect={sel.toggleSelect}
                    onToggleSelectAllVisible={sel.toggleSelectAllVisible}
                />
                <Pagination currentPage={f.page} totalPages={f.totalPages} onPageChange={f.setPage} />
            </div>

            <Modal size="2xl" isOpen={isHistoryModalOpen} onClose={() => setIsHistoryModalOpen(false)} title={`Disposition History (${historyCount})`}>
                <div className="space-y-3">
                    <ExportPanel kind="requests" />
                    <SearchInput
                        value={historyP.search}
                        onChange={(e) => historyP.setSearch(e.target.value)}
                        placeholder="Search history by serial, item, or requester..."
                    />
                    <div className="border border-line rounded-lg overflow-hidden">
                        <DataTable
                            columns={historyColumns}
                            data={hf.pageRows}
                            isLoading={historyP.isLoading}
                            keyExtractor={r => r.id}
                            emptyStateMessage="No dispositioned items yet."
                            maxHeight="65vh"
                        />
                        <Pagination currentPage={hf.page} totalPages={hf.totalPages} onPageChange={hf.setPage} />
                    </div>
                </div>
            </Modal>

            <DispositionModal
                isOpen={!!dispositionRequest || (dispositionIds != null && dispositionIds.length > 0)}
                onClose={() => { setDispositionRequest(null); setDispositionIds(null); }}
                request={dispositionRequest}
                requestIds={dispositionIds ?? undefined}
                onSuccess={dispositionIds && dispositionIds.length > 0
                    ? () => { sel.clearSelection(); fetchRequests(); }
                    : () => { setDispositionRequest(null); fetchRequests(); }}
            />
        </div>
    );
};
