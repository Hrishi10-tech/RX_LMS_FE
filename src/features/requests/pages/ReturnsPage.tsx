import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { client } from '@/api';
import { cachedGet, extractErrorMessage } from '@/lib';
import { runPerId } from '@/utils/bulk';
import { Eye } from 'lucide-react';
import { DataTable, StatusBadge, ColumnFilter, BulkSelectionBar, BulkActionButton, Pagination, ExportPanel, LoadAllCapNote } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { useBulkSelection, useServerPagination, useSocket, usePagedFilters, FilterSpec, useAbortOnUnmount } from '@/hooks';
import { fmtDateTime, formatDueDelta } from '@/utils/date';
import { ReturnDetailsModal } from '../components/ReturnDetailsModal';
import { ReturnFilters } from '../components/ReturnFilters';
import { ComponentRequestTrackModal } from '../components/ComponentRequestTrackModal';

const CONDITION_OPTIONS = [
  { value: 'RETURNED_GOOD', label: 'Good Condition' },
  { value: 'RETURNED_DAMAGED', label: 'Damaged' },
  { value: 'Tested', label: 'Tested / Working' },
  { value: 'Used', label: 'Used' },
];

export const ReturnsPage = () => {


  const abortSignal = useAbortOnUnmount();
    const [searchParams, setSearchParams] = useSearchParams();

    const [activeTab, setActiveTab] = useState<'pending' | 'history'>(() => {
        return searchParams.get('tab') === 'history' ? 'history' : 'pending';
    });

    // Server-reported count. When it exceeds what we could fetch, say so
    // rather than showing a short list as if it were the whole set.
    const [returnsTotal, setReturnsTotal] = useState<number | null>(null);
    const [allUsers, setAllUsers] = useState<any[]>([]);
    // Full-set sum of returned quantity — the "Total Units Returned" tile is a
    // cross-page aggregate, so it comes from the events endpoint's server-side
    // `_sum` rather than reducing the (paginated) rows in the browser.
    const [totalQtyReturned, setTotalQtyReturned] = useState(0);
    const [auxTick, setAuxTick] = useState(0);

    // File return modal
    const [isFileReturnModalOpen, setIsFileReturnModalOpen] = useState(false);
    const [inUseRequests, setInUseRequests] = useState<any[]>([]);
    const [selectedRequest, setSelectedRequest] = useState('');
    const [returnCondition, setReturnCondition] = useState('RETURNED_GOOD');
    const [returnNotes, setReturnNotes] = useState('');
    const [returnedById, setReturnedById] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    // History-row "View" — returns are ComponentRequests, so a history event's
    // nested `componentRequest` ({ id, serialNo }) opens the shared track modal.
    const [trackRequest, setTrackRequest] = useState<any | null>(null);
    const pendingSel = useBulkSelection();

    const { addToast } = useToast();

    const confirm = useConfirm();

    // Two server-side tables, 10/page each. History = RETURN events from
    // /inventory/events. Both pull one page per request.
    //
    // Pending asks the server for `awaitingReturn`, not a raw status list:
    // a return the holder explicitly raised (any nature), or a TEMPORARY loan
    // still out. PERMANENT loans are long-term by design (a lab coat kept for
    // years) and aren't chased on a schedule, so they don't belong in this
    // queue. Asking for `status=IN_USE,OVERDUE,RETURN_REQUESTED` put all of
    // them here: 137 rows of which 134 were PERMANENT, and the "Awaiting
    // Return" tile (pendingP.total) counted every one as outstanding work.
    //
    // The File Return picker below is deliberately NOT filtered this way — see
    // the note there.
    const pendingP = useServerPagination<any>({ loadAll: true, endpoint: '/requests', params: { awaitingReturn: 'true' } });
    // History loads only while its tab is showing. It is every RETURN event
    // ever recorded, up to 2,000 rows, and most visits are to work the Pending
    // queue. Its tab badge reads the count from the sum request below instead.
    const historyP = useServerPagination<any>({ loadAll: true, endpoint: '/inventory/events', itemsKey: 'events', params: { eventType: 'RETURN' }, enabled: activeTab === 'history' });
    // RETURN events in total, from the sum request (take=1). Feeds the History
    // badge while that tab, and so historyP, is idle.
    const [historyTotalAll, setHistoryTotalAll] = useState(0);

    // Refresh both tables + the modal picker + the sum tile after a return is
    // filed. Same name as the old fetcher so handleFileReturn is unchanged.
    const fetchData = () => {
        pendingP.refetch(); historyP.refetch(); setAuxTick(t => t + 1);
        // Confirming a return clears a RETURN_REQUESTED row — tell the sidebar so
        // the Returns badge decrements immediately (same convention as the Issue
        // Slips / Inventory Requests pages), not just on the 30s/focus refetch.
        window.dispatchEvent(new Event('requests-updated'));
    };

    // Withdraw a return the borrower asked for but didn't go through with —
    // the "changed their mind at the desk" case the endpoint was added for.
    // Without it the clerk's only options were to confirm a return that never
    // happened or leave the row parked in RETURN_REQUESTED, where it is neither
    // chased nor extendable.
    const [withdrawingId, setWithdrawingId] = useState<string | null>(null);
    const handleWithdrawReturn = async (row: any) => {
        if (withdrawingId) return;
        if (!await confirm({
            title: `Withdraw the return for ${row.serialNo}?`,
            message: `${row.inventoryItem?.name || 'The item'} goes back to being on loan to ${row.createdBy?.name || 'the borrower'}.`,
            confirmLabel: 'Withdraw',
        })) return;
        setWithdrawingId(row.id);
        try {
            await client.post(`/requests/${row.id}/cancel-return`, {});
            addToast(`Return withdrawn — ${row.serialNo} is back on loan.`, 'success');
            fetchData();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to withdraw the return'), 'error');
        }
        setWithdrawingId(null);
    };

    // Keep a live ref to the refresh fn so the socket listener (registered once)
    // always calls the latest closure without re-subscribing on every render.
    const fetchDataRef = useRef(fetchData);
    fetchDataRef.current = fetchData;

    // Live nudge: when a manager approves a loan extension, the backend pushes a
    // `returns:updated` event to inventory's sockets (CommunicationGateway →
    // RelayedEvent). Refetch so the moved due date / cleared-overdue status shows
    // on the Returns desk immediately, not only on the next manual reload.
    //
    // Debounced: one approval can emit several events in a row, and each used
    // to reload both lists in full. A burst now costs one refresh.
    const { addListener, removeListener } = useSocket();
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onRealtime = (data: any) => {
            if (data?.type !== 'returns:updated') return;
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { timer = undefined; fetchDataRef.current(); }, 500);
        };
        addListener(onRealtime);
        return () => {
            if (timer) clearTimeout(timer);
            removeListener(onRealtime);
        };
    }, [addListener, removeListener]);

    const handleFileReturn = async () => {
        if (!selectedRequest) { addToast('Select a request to return', 'error'); return; }
        setIsSubmitting(true);
        try {
            await client.patch(`/requests/${selectedRequest}/return`, {
                condition: returnCondition,
                notes: returnNotes,
                returnedById: returnedById || undefined,
            });
            addToast('Return filed successfully', 'success');
            setIsFileReturnModalOpen(false);
            setSelectedRequest('');
            setReturnCondition('RETURNED_GOOD');
            setReturnNotes('');
            setReturnedById('');
            fetchData();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to file return'), 'error');
        }
        setIsSubmitting(false);
    };

    // Auxiliary data the two paginated tables don't cover:
    //   - inUseRequests: the File-Return modal's <select> picker. A picker
    //     needs the WHOLE returnable set (not one table page), so it stays a
    //     bounded fetch like every other dropdown source in the app.
    //     Deliberately NOT `awaitingReturn`: the queue above is "what should be
    //     chased", but a clerk must still be able to accept an item somebody
    //     walks up and hands back — including a PERMANENT one, e.g. a lab coat
    //     returned because the holder is leaving. So this stays the full
    //     returnable set of any nature, which the backend now actually accepts.
    //   - allUsers: the "Returned By" picker. /users/directory is the
    //     public-read list (the admin-scoped /users 403s for other roles).
    //   - totalQtyReturned: the cross-page sum tile (server `_sum`).
    //
    // The two pickers load only while the File Return modal is open: they are
    // up to 200 requests plus the user directory, and used to be fetched on
    // every visit and every refresh whether or not anyone filed a return. The
    // sum tile is on the page, so it still loads straight away.
    useEffect(() => {
        (async () => {
            try {
                const sumRes = await client.get('/inventory/events?eventType=RETURN&take=1', { signal: abortSignal() });
                const sumPayload = sumRes.data?.data ?? sumRes.data ?? {};
                setTotalQtyReturned(sumPayload.sumQuantityChange ?? 0);
                setHistoryTotalAll(sumPayload.total ?? 0);
            } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to fetch returns data'), 'error'); }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [auxTick]);

    useEffect(() => {
        if (!isFileReturnModalOpen) return;
        (async () => {
            try {
                const [reqRes, usersRes] = await Promise.all([
                    client.get('/requests?status=IN_USE,OVERDUE,RETURN_REQUESTED&take=500', { signal: abortSignal() }),
                    cachedGet<any>('/users/directory').catch(() => ({ data: [] })),
                ]);
                const reqRaw = reqRes.data?.data;
                const items = Array.isArray(reqRaw) ? reqRaw : (reqRaw?.items || []);
                setInUseRequests(items);
                // `take=500` is asked for; the controller caps at 200 and says
                // so in `total`. Comparing them is the whole point — without it
                // the page renders a complete-looking list that is quietly
                // missing rows, which is the failure IssueSlipsPage already
                // learned to announce.
                const reportedTotal = Array.isArray(reqRaw) ? items.length : (reqRaw?.total ?? items.length);
                setReturnsTotal(typeof reportedTotal === 'number' ? reportedTotal : items.length);
                setAllUsers((usersRes as any)?.data || usersRes || []);
            } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to fetch returns data'), 'error'); }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [auxTick, isFileReturnModalOpen]);

    useEffect(() => {
        if (selectedRequest) {
            const req = inUseRequests.find(r => r.id === selectedRequest);
            if (req?.createdById) setReturnedById(req.createdById);
        } else {
            setReturnedById('');
        }
    }, [selectedRequest, inUseRequests]);

    // Strip the ?tab=... param on mount so the page lands on the default
    // tab. Intentionally runs only when the URL search-string changes
    // (notification deep-links). Without the dep, this would either run
    // once and miss subsequent deep-links, or stale-closure setSearchParams.
    useEffect(() => {
      if (searchParams.get('tab')) setSearchParams({}, { replace: true });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [searchParams]);

    // RET-ids come from the return event itself, so the same return always
    // carries the same id. They used to be positional (page offset + row
    // index): typing a search, or a newer return arriving, renumbered every
    // row, and a RET-012 someone had written down pointed at a different event.
    const historyRows = useMemo(
        () => historyP.items.map((e: any) => ({
            ...e,
            _retId: `RET-${String(e.id).replace(/-/g, '').slice(0, 6).toUpperCase()}`,
        })),
        [historyP.items],
    );

    // Column filters run over every row of the list (loadAll), then the result
    // is paged — they used to see only the current 10 rows.
    // A filter on every data column (owner, 27 Oct); values match the cells.
    const pendingSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'reqId', getValue: (r) => r.serialNo },
        { key: 'item', getValue: (r) => r.inventoryItem?.name || 'Unknown' },
        { key: 'qty', getValue: (r) => String(r.qtyRequested ?? '') },
        { key: 'heldBy', getValue: (r) => r.createdBy?.name || 'Unknown' },
        { key: 'issued', getValue: (r) => r.issuedAt ? new Date(r.issuedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '-' },
        { key: 'due', getValue: (r) => {
            if (!r.dueDate) return 'No due date';
            const dd = formatDueDelta(r.dueDate, 7 * 86400000);
            return dd.overdue ? 'Overdue' : dd.dueSoon ? 'Due Soon' : 'Not Soon';
        } },
        { key: 'status', getValue: (r) => r.status || 'UNKNOWN' },
    ], []);
    // Asked-for returns first, oldest ask on top — first come, first served —
    // then everything still out, soonest due first. It was newest-raised first,
    // with no sign of when (or whether) anyone had asked.
    const pendingSorted = useMemo(() => {
        const t = (d?: string | null) => (d ? new Date(d).getTime() : Number.POSITIVE_INFINITY);
        return [...pendingP.items].sort((a: any, b: any) => {
            const aAsk = a.status === 'RETURN_REQUESTED', bAsk = b.status === 'RETURN_REQUESTED';
            if (aAsk !== bAsk) return aAsk ? -1 : 1;
            if (aAsk) return t(a.returnRequest?.at) - t(b.returnRequest?.at);
            return t(a.dueDate) - t(b.dueDate);
        });
    }, [pendingP.items]);
    const pf = usePagedFilters(pendingSorted, pendingSpecs, 10, pendingP.search);

    const historySpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'retId', getValue: (r) => r._retId },
        { key: 'returnedBy', getValue: (r) => r.performedBy?.name || 'Unknown' },
        { key: 'date', getValue: (r) => r.createdAt ? new Date(r.createdAt).toISOString().split('T')[0] : '' },
        { key: 'condition', getValue: (r) => r.componentRequest?.returnRecord?.condition || r.disposition || '' },
        { key: 'item', getValue: (r) => r.inventoryItem?.name || 'Unknown' },
        { key: 'qty', getValue: (r) => `+${r.quantityChange} ${r.inventoryItem?.unit || ''}`.trim() },
        { key: 'stockAfter', getValue: (r) => String(r.stockAfter ?? '') },
        { key: 'notes', getValue: (r) => r.notes || '-' },
    ], []);
    const hf = usePagedFilters(historyRows, historySpecs, 10, historyP.search);

    // One search box drives whichever tab is showing — wire it to BOTH hooks
    // so the value stays in lockstep and the search runs server-side per tab.
    const search = activeTab === 'pending' ? pendingP.search : historyP.search;
    const onSearchChange = (v: string) => { pendingP.setSearch(v); historyP.setSearch(v); };

    const clearAllFilters = () => {
        pendingP.setSearch(''); historyP.setSearch('');
        pf.clearFilters(); hf.clearFilters();
    };

    const hasActiveFilters = !!search || Object.keys(pf.filters).length > 0 || Object.keys(hf.filters).length > 0;

    // Header with its column filter, for the columns added on 27 Oct.
    const filtered = (t: typeof pf, label: string, key: string) => ({
        filterActive: t.isActive(key),
        header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={t.getOptions(key)} value={t.filters[key] || ''} onChange={(v) => t.setFilter(key, v)} /></span>,
    });

    const dateOpts = hf.getOptions('date').map(o => { const [y, m, d] = o.value.split('-'); return { value: o.value, label: `${d}-${m}-${y}` }; });

    // The table narrows with the screen (DataTable `fit`), so a date may wrap —
    // between the day and the time, never in the middle of either.
    const when = (iso: string) => {
        const [day, time] = fmtDateTime(iso).split(', ');
        return <><span className="whitespace-nowrap">{day}{time ? ',' : ''}</span>{time && <> <span className="whitespace-nowrap">{time}</span></>}</>;
    };

    const pendingColumns = [
        // Request ID + BOM provenance chip. When a returned item is part
        // of a 150-row BOM, the clerk needs to know — they may be processing
        // the whole BOM's returns together. Chip tooltip carries the BOM name.
        { ...filtered(pf, 'Request ID', 'reqId'), accessor: (row: any) => (
            <div className="flex flex-col items-start gap-0.5">
                <span className="font-mono text-xs font-bold text-ink">{row.serialNo}</span>
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
        { ...filtered(pf, 'Item Name', 'item'), accessor: (row: any) => <span className="font-medium text-ink">{row.inventoryItem?.name || 'Unknown'}</span> },
        { ...filtered(pf, 'Qty', 'qty'), accessor: (row: any) => <span className="font-bold">{row.qtyRequested}</span> },
        { filterActive: pf.isActive('heldBy'), header: <span className="inline-flex items-center">Held By<ColumnFilter options={pf.getOptions('heldBy')} value={pf.filters.heldBy || ''} onChange={(v) => pf.setFilter('heldBy', v)} /></span>, accessor: (row: any) => (
            <div>
                <p className="text-sm font-medium text-ink">{row.createdBy?.name || 'Unknown'}</p>
                {/* Others on the request can hold and return it too. */}
                {(() => {
                    const others = (row.responsiblePersons || [])
                        .map((p: any) => p.user?.name).filter((n: string | undefined) => n && n !== row.createdBy?.name);
                    return others.length ? <p className="text-[10px] text-muted">with {others.join(', ')}</p> : null;
                })()}
                <p className="text-[10px] text-faint">{row.department?.name || ''}</p>
            </div>
        )},
        { filterActive: pf.isActive('issued'), header: <span className="inline-flex items-center">Issued<ColumnFilter options={pf.getOptions('issued')} value={pf.filters.issued || ''} onChange={(v) => pf.setFilter('issued', v)} /></span>, accessor: (row: any) => <span className="text-xs text-muted">{row.issuedAt ? when(row.issuedAt) : '-'}</span> },
        { filterActive: pf.isActive('due'), header: <span className="inline-flex items-center">Due<ColumnFilter options={pf.getOptions('due')} value={pf.filters.due || ''} onChange={(v) => pf.setFilter('due', v)} /></span>, accessor: (row: any) => {
            if (!row.dueDate) return <span className="text-xs text-faint">No due date</span>;
            const dd = formatDueDelta(row.dueDate, 7 * 86400000);
            const cls = dd.overdue ? 'text-red-700 dark:text-red-300 font-bold' : dd.dueSoon ? 'text-amber-700 dark:text-amber-300 font-bold' : 'text-green-700 dark:text-green-300';
            return <span className={`text-xs whitespace-nowrap ${cls}`}>{dd.text}</span>;
        }},
        { filterActive: pf.isActive('status'), header: <span className="inline-flex items-center">Status<ColumnFilter options={pf.getOptions('status')} value={pf.filters.status || ''} onChange={(v) => pf.setFilter('status', v)} /></span>, accessor: (row: any) => (
            <div className="flex flex-col items-start gap-0.5">
                <StatusBadge status={row.status} />
                {/* What the holder declared when they started the return. The
                    clerk needs it before they open the confirm dialog — it is
                    the difference between "put it back on the shelf" and "this
                    one is defective". */}
                {row.status === 'RETURN_REQUESTED' && row.returnCondition && (
                    <span className={`text-[10px] font-bold whitespace-nowrap ${['Damaged', 'Not Working'].includes(row.returnCondition) ? 'text-red-700 dark:text-red-300' : 'text-muted'}`}
                          title="Condition declared by the holder">
                        Declared: {row.returnCondition}
                    </span>
                )}
                {/* Who asked, and when — in this cell rather than a column of
                    its own, which pushed Actions off a laptop screen. */}
                {row.returnRequest && (
                    <span className="text-[10px] text-muted leading-tight">
                        Asked {when(row.returnRequest.at)}
                        <br />by {row.returnRequest.byName || 'Unknown'}
                    </span>
                )}
            </div>
        ) },
        { header: 'Actions', accessor: (row: any) => (
            <div className="flex flex-wrap gap-1.5">
                <button onClick={() => { setSelectedRequest(row.id); setIsFileReturnModalOpen(true); }}
                    className={`text-xs px-2 py-1.5 rounded font-bold transition-colors whitespace-nowrap ${row.status === 'RETURN_REQUESTED' ? 'bg-orange-700 text-white hover:bg-orange-800 ring-2 ring-orange-300' : 'bg-brand text-white hover:bg-brand-dark'}`}>
                    {row.status === 'RETURN_REQUESTED' ? 'Confirm Return' : 'Returned'}</button>
                {row.status === 'RETURN_REQUESTED' && (
                    <button onClick={() => handleWithdrawReturn(row)}
                        disabled={withdrawingId === row.id}
                        title="The borrower changed their mind — put the item back on loan"
                        className="text-xs px-2 py-1.5 rounded font-bold transition-colors whitespace-nowrap bg-card border border-faint text-ink hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed">
                        {withdrawingId === row.id ? 'Withdrawing…' : 'Withdraw'}</button>
                )}
                <button onClick={async () => {
                    // The empty `client.post('/notifications', {})` that
                    // used to live here was a leftover — 400'd on DTO
                    // validation and was silently caught. Removed.
                    try {
                      await client.post('/notifications', {
                        userId: row.createdById,
                        type: 'WARNING',
                        title: `Return Reminder: ${row.serialNo}`,
                        message: `Please return ${row.inventoryItem?.name || 'item'} (${row.serialNo}). ${row.status === 'OVERDUE' ? 'This item is OVERDUE.' : `Due date: ${fmtDateTime(row.dueDate, 'N/A')}`}`,
                        relatedEntityId: row.id,
                        relatedEntityType: 'REQUEST',
                      });
                      addToast(`Reminder sent to ${row.createdBy?.name || 'user'}`, 'success');
                    } catch (e) {
                      addToast(extractErrorMessage(e, 'Failed to send reminder — please try again.'), 'error');
                    }
                }} className="text-xs bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-400/30 px-2 py-1.5 rounded font-bold hover:bg-amber-100 dark:bg-amber-400/20 transition-colors whitespace-nowrap">Remind</button>
            </div>
        )}
    ];

    const historyColumns = [
        { filterActive: hf.isActive('retId'), header: <span className="inline-flex items-center">Return ID<ColumnFilter searchable options={hf.getOptions('retId')} value={hf.filters.retId || ''} onChange={(v) => hf.setFilter('retId', v)} /></span>, accessor: (row: any) => <span className="font-mono text-xs font-bold text-ink">{row._retId}</span> },
        { ...filtered(hf, 'Item Name', 'item'), accessor: (row: any) => <span className="font-medium text-ink">{row.inventoryItem?.name || 'Unknown'}</span> },
        { ...filtered(hf, 'Quantity', 'qty'), accessor: (row: any) => <span className="font-bold text-green-700 dark:text-green-300">+{row.quantityChange} {row.inventoryItem?.unit || ''}</span> },
        { filterActive: hf.isActive('returnedBy'), header: <span className="inline-flex items-center">Returned By<ColumnFilter searchable options={hf.getOptions('returnedBy')} value={hf.filters.returnedBy || ''} onChange={(v) => hf.setFilter('returnedBy', v)} /></span>, accessor: (row: any) => <span className="text-sm text-ink">{row.performedBy?.name || 'Unknown'}</span> },
        { filterActive: hf.isActive('date'), header: <span className="inline-flex items-center">Date<ColumnFilter searchable options={dateOpts} value={hf.filters.date || ''} onChange={(v) => hf.setFilter('date', v)} /></span>, accessor: (row: any) => {
             const dt = row.createdAt ? new Date(row.createdAt).toISOString().split('T')[0] : ''; if(!dt) return <span className="text-xs text-faint">-</span>;
             const [y, m, d] = dt.split('-'); return <span className="text-xs text-muted">{`${d}-${m}-${y}`}</span>;
        } },
        { filterActive: hf.isActive('condition'), header: <span className="inline-flex items-center">Condition<ColumnFilter options={CONDITION_OPTIONS} value={hf.filters.condition || ''} onChange={(v) => hf.setFilter('condition', v)} /></span>,
          accessor: (row: any) => {
            const cond = row.componentRequest?.returnRecord?.condition || row.disposition;
            if (!cond) return <span className="text-xs text-faint">-</span>;
            const label = CONDITION_OPTIONS.find(o => o.value === cond)?.label || cond;
            const isBad = cond === 'RETURNED_DAMAGED' || cond === 'Used' || cond === 'Damaged';
            const cls = isBad ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30' : 'bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300 border-green-200 dark:border-green-400/30';
            return <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${cls}`}>{label}</span>;
        }},
        { ...filtered(hf, 'Stock After', 'stockAfter'), accessor: (row: any) => <span className="text-xs font-mono text-muted">{row.stockAfter}</span> },
        { ...filtered(hf, 'Notes', 'notes'), accessor: (row: any) => <span className="text-xs text-faint truncate max-w-[200px] block">{row.notes || '-'}</span> },
        // View — opens the shared component-request track modal for the source
        // request. The event's `componentRequest` carries { id, serialNo }; if a
        // legacy event lacks it there's nothing to open, so the cell stays empty.
        { header: 'View', accessor: (row: any) => (
            row.componentRequest?.id ? (
                <button onClick={() => setTrackRequest(row.componentRequest)} title="View request details"
                    className="text-xs bg-hover text-ink px-3 py-1.5 rounded font-bold hover:bg-line transition-colors inline-flex items-center gap-1 whitespace-nowrap"><Eye size={12} /> View</button>
            ) : <span className="text-xs text-faint">-</span>
        )},
    ];

    // Tile + tab-badge counts come straight from each table's server-side
    // total (not the loaded page), so they stay accurate under pagination.
    const pendingCount = pendingP.total;
    // History's own count (which follows the search box) once it has loaded;
    // the plain RETURN total while its tab is idle or still loading.
    const historyCount = activeTab === 'history' && !historyP.isLoading ? historyP.serverTotal : historyTotalAll;

    return (
        <div className="space-y-4 md:space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Returns</h2>
                    <p className="text-sm md:text-[15px] text-muted mt-1.5">
                        {pendingCount} pending return{pendingCount !== 1 ? 's' : ''} · {totalQtyReturned} units returned in history
                    </p>
                    {/* The server caps this list at 200 regardless of what the
                        page asks for. Saying so is the difference between a
                        short list and a WRONG one: without it the page looks
                        complete and simply omits returns. */}
                    {returnsTotal !== null && returnsTotal > inUseRequests.length && (
                        <p className="mt-1.5 rounded-md border border-amber-300 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                            <span className="font-bold">This list is not complete.</span>{' '}
                            Showing {inUseRequests.length} of {returnsTotal} — use the filters or Export for the rest.
                        </p>
                    )}
                </div>
                <button onClick={() => setIsFileReturnModalOpen(true)}
                    className="bg-brand text-white px-4 py-2 font-bold rounded-full hover:bg-brand-dark transition-colors shadow-sm">File Return</button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-card rounded-lg border border-amber-100 dark:border-amber-400/25 shadow-sm p-4 text-center">
                    <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">{pendingCount}</p>
                    <p className="text-[10px] text-muted font-medium">Awaiting Return</p>
                </div>
                <div className="bg-card rounded-lg border border-green-100 dark:border-green-400/25 shadow-sm p-4 text-center">
                    <p className="text-2xl font-bold text-green-700 dark:text-green-300">{totalQtyReturned}</p>
                    <p className="text-[10px] text-muted font-medium">Total Units Returned</p>
                </div>
                <div className="bg-card rounded-lg border border-line-soft shadow-sm p-4 text-center">
                    <p className="text-2xl font-bold text-ink">{historyCount}</p>
                    <p className="text-[10px] text-muted font-medium">Return Events</p>
                </div>
            </div>

            <div className="bg-card rounded-lg shadow-sm border border-line-soft">
                <div className="border-b border-line-soft px-4 pt-4">
                    <div className="flex gap-1">
                        <button onClick={() => setActiveTab('pending')}
                            className={`px-4 py-2.5 text-xs font-bold rounded-t-lg border-b-2 transition-colors ${activeTab === 'pending' ? 'border-brand text-brand bg-brand/5' : 'border-transparent text-muted hover:text-ink'}`}>
                            Pending Returns <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[9px] ${activeTab === 'pending' ? 'bg-brand/20 text-brand-700' : 'bg-hover text-faint'}`}>{pendingCount}</span>
                        </button>
                        <button onClick={() => setActiveTab('history')}
                            className={`px-4 py-2.5 text-xs font-bold rounded-t-lg border-b-2 transition-colors ${activeTab === 'history' ? 'border-brand text-brand bg-brand/5' : 'border-transparent text-muted hover:text-ink'}`}>
                            Return History <span className={`ml-1 px-1.5 py-0.5 rounded-full text-[9px] ${activeTab === 'history' ? 'bg-brand/20 text-brand-700' : 'bg-hover text-faint'}`}>{historyCount}</span>
                        </button>
                    </div>
                </div>

                <div className="p-4">
                    <ReturnFilters
                        search={search}
                        onSearchChange={onSearchChange}
                        activeTab={activeTab}
                        hasActiveFilters={hasActiveFilters}
                        onClearAll={clearAllFilters}
                    />

                    {activeTab === 'pending' ? (
                        <>
                            <BulkSelectionBar count={pendingSel.selectedIds.size} onClear={pendingSel.clearSelection}>
                                {/* Bulk remind — loops the same per-row reminder notification
                                    the "Remind" button sends, so the clerk can nudge everyone
                                    holding overdue / still-out items in one click. Best-effort:
                                    each notification is independent, failures are tallied. */}
                                <BulkActionButton
                                    label="Remind"
                                    count={pendingSel.selectedIds.size}
                                    verb="sent"
                                    confirmTitle="Send return reminders?"
                                    confirmMessage={`Send a return reminder to the holder of each of the ${pendingSel.selectedIds.size} selected request${pendingSel.selectedIds.size === 1 ? '' : 's'}?`}
                                    onRun={() => runPerId([...pendingSel.selectedIds], async (id) => {
                                        const row = pendingP.items.find((r: any) => r.id === id);
                                        if (!row) throw new Error('not on this page — re-select');
                                        await client.post('/notifications', {
                                            userId: row.createdById,
                                            type: 'WARNING',
                                            title: `Return Reminder: ${row.serialNo}`,
                                            message: `Please return ${row.inventoryItem?.name || 'item'} (${row.serialNo}). ${row.status === 'OVERDUE' ? 'This item is OVERDUE.' : `Due date: ${fmtDateTime(row.dueDate, 'N/A')}`}`,
                                            relatedEntityId: row.id,
                                            relatedEntityType: 'REQUEST',
                                        });
                                    })}
                                    onDone={() => pendingSel.clearSelection()}
                                />
                            </BulkSelectionBar>
                            <DataTable fit columns={pendingColumns} data={pf.pageRows} isLoading={pendingP.isLoading} keyExtractor={r => r.id}
                                emptyStateMessage="No items awaiting return. All items are accounted for." maxHeight="55vh"
                                selectedIds={pendingSel.selectedIds}
                                onToggleSelect={pendingSel.toggleSelect}
                                onToggleSelectAllVisible={pendingSel.toggleSelectAllVisible}
                            />
                            <Pagination currentPage={pf.page} totalPages={pf.totalPages} onPageChange={pf.setPage} />
                        </>
                    ) : (
                        <>
                            {/* Return history is terminal ComponentRequests — scope the
                                export to the RETURNED status this tab surfaces. */}
                            <div className="mb-3">
                                <ExportPanel kind="requests" status="RETURNED" />
                            </div>
                            <DataTable fit columns={historyColumns} data={hf.pageRows} isLoading={historyP.isLoading} keyExtractor={r => r.id}
                                emptyStateMessage="No return history yet. Returns will appear here as items are returned." maxHeight="55vh"
                            />
                            <LoadAllCapNote truncated={historyP.truncated} shown={historyP.items.length} total={historyP.serverTotal} />
                            <Pagination currentPage={hf.page} totalPages={hf.totalPages} onPageChange={hf.setPage} />
                        </>
                    )}
                </div>
            </div>

            <ReturnDetailsModal
                isOpen={isFileReturnModalOpen}
                onClose={() => setIsFileReturnModalOpen(false)}
                selectedRequest={selectedRequest}
                onSelectRequest={setSelectedRequest}
                inUseRequests={inUseRequests}
                returnCondition={returnCondition}
                onSetReturnCondition={setReturnCondition}
                returnNotes={returnNotes}
                onSetReturnNotes={setReturnNotes}
                returnedById={returnedById}
                onSetReturnedById={setReturnedById}
                allUsers={allUsers}
                isSubmitting={isSubmitting}
                onSubmit={handleFileReturn}
            />

            <ComponentRequestTrackModal request={trackRequest} onClose={() => setTrackRequest(null)} />
        </div>
    );
};
