import { useEffect, useMemo, useState } from 'react';
import { client } from '@/api';
import { extractErrorMessage } from '@/lib';
import { runPerId } from '@/utils/bulk';
import { DataTable, Modal, ColumnFilter, BulkSelectionBar, BulkActionButton, PendingCell, StatusBadge, ExportPanel, Pagination, statusLabel } from '@/components/ui';
import { useBulkSelection, useClientPagination, usePagedFilters, useTableFilters, FilterSpec } from '@/hooks';
import { EditableCell } from '@/components/ui/EditableCell';
import { useToast } from '@/context/ToastContext';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { resolveIssuedQty } from '@/utils/qty';
import { statusReasonForRequest } from '@/utils/pendingReason';
import { Package, ChevronRight } from 'lucide-react';

// The server clamps `take` to 200 (requests.controller.ts). Naming it here so
// the request matches what can actually come back — asking for 500 and getting
// 200 is what made the history tab truncate silently.
const PAGE_CAP = 200;

export const IssueSlipsPage = () => {
    const [slips, setSlips] = useState<any[]>([]);
    const [pastSlips, setPastSlips] = useState<any[]>([]);
    // Server-reported history count. When it exceeds what we could fetch, the
    // History modal says so instead of quietly showing a short list.
    const [historyTotal, setHistoryTotal] = useState<number | null>(null);
    const [isLoading, setIsLoading] = useState(false);
    // In-flight guard for the "Issued" confirm button — blocks a double-click
    // from firing two PATCHes (which would double-decrement stock).
    const [confirmingId, setConfirmingId] = useState<string | null>(null);
    

    const [isViewModalOpen, setIsViewModalOpen] = useState(false);
    const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
    const [selectedRequest, setSelectedRequest] = useState<any>(null);
    // Opened BOM Slip — when set, the consolidated BOM-level modal renders
    // and fetches /bom-lists/:id to show every line + the spawned indent.
    const [openBomSlipId, setOpenBomSlipId] = useState<string | null>(null);

    // Reason prompt — when the clerk drops the issued qty BELOW what was
    // requested, we hold the pending edit here and require a reason before
    // it's saved. The reason rides along to the requester + their manager so
    // a shortfall (100 asked, 50 issued) is never silent. `null` = closed.
    const [reasonPrompt, setReasonPrompt] = useState<{ id: string; newQty: number; oldQty: number; requested: number; itemName: string; unit: string } | null>(null);
    const [reasonText, setReasonText] = useState('');
    const [savingReason, setSavingReason] = useState(false);

    const { addToast } = useToast();
    const activeSel = useBulkSelection();

    const fetchRequests = async () => {
        setIsLoading(true);
        try {
            // Pull the working set in one shot — the page groups BOM lines,
            // splits active vs. history, and builds the filter dropdowns
            // client-side, so it needs the whole set rather than a single
            // server page. Bound it explicitly to the server's max (500)
            // instead of relying on the implicit default; the History modal +
            // Export cover the deeper archive.
            // Two scoped fetches instead of one unfiltered take:500. Previously
            // this pulled the newest 500 requests of ANY status and split them
            // client-side — so once the org had >500 total requests, older
            // still-in-hand ACTIVE slips fell outside the window and silently
            // vanished from the clerk's working queue. The active fetch now
            // filters to the in-hand statuses server-side, so the 500 cap bounds
            // only IN_USE/OVERDUE rows (far fewer than all-time requests) rather
            // than the entire request history. History stays a bounded archive
            // (the History modal + Export cover the deeper tail).
            // Each tab asks the server for ITS OWN rows (see the `issueSlip`
            // predicate in requests.service). The second call used to be
            // unfiltered, which while the org's total sat under the cap made it
            // a strict superset of the first — the page downloaded 383,759
            // bytes per load with 162,097 of them the same rows twice.
            //
            // `take` is the server's real ceiling (the controller clamps to
            // 200). It used to ask for 500 and silently receive 200, so the
            // history tab began dropping rows with no indication at all; the
            // server `total` is captured below so the History modal can say so.
            const [activeRes, historyRes] = await Promise.all([
                client.get('/requests', { params: { issueSlip: 'active', take: PAGE_CAP } }),
                client.get('/requests', { params: { issueSlip: 'history', take: PAGE_CAP } }),
            ]);
            const activePayload = activeRes.data.data ?? {};
            const historyPayload = historyRes.data.data ?? {};
            // Already filtered server-side — no second pass in the browser.
            // Active = still physically in-hand and not yet handover-confirmed;
            // OVERDUE is just IN_USE past its due date, so the item is STILL
            // out and stays on the active slip where the clerk chases it.
            setSlips(activePayload.items ?? activePayload ?? []);
            setPastSlips(historyPayload.items ?? historyPayload ?? []);
            setHistoryTotal(typeof historyPayload.total === 'number' ? historyPayload.total : null);
        } catch (e: any) {
            // Surface the real error so the clerk knows what to retry — e.g.
            // a 401 from an expired token vs. a 500 server error reads very
            // differently. The server's `message` lives at the top of the
            // wrapped error response (alongside `statusCode`).
            addToast(extractErrorMessage(e, 'Failed to fetch issue slips'), 'error');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchRequests();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- initial fetch of issue slips, runs once on mount
    }, []);

    const handleConfirmIssued = async (id: string) => {
        if (confirmingId) return; // already confirming one — ignore the double-click
        setConfirmingId(id);
        try {
            await client.patch(`/requests/${id}`, { issuedConfirmedAt: new Date().toISOString() });
            addToast('Marked as issued — moved to history', 'success');
            fetchRequests();
            // Tell the sidebar badge to recount without a refresh — same
            // pattern as the approvals/notifications dots.
            window.dispatchEvent(new Event('requests-updated'));
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to confirm issue'), 'error');
        } finally {
            setConfirmingId(null);
        }
    };

    const handleUpdateField = async (id: string, field: string, value: any) => {
         // A date cell that was cleared is not a date; the server answered "" with
         // "must be a date". An issued slip always has an issue date.
         if (field === 'issuedAt' && !value) {
             addToast('The issue date cannot be empty.', 'error');
             return;
         }
         try {
             const res = await client.patch(`/requests/${id}`, { [field]: value });
             const updated = res.data?.data || res.data;
             addToast(`Successfully updated field`, 'success');
             // Patch the row in place rather than re-pulling both lists. A
             // field edit doesn't move a slip between tabs, and the fresh row
             // is already in hand — the old `fetchRequests()` here re-fetched
             // every active AND history row on each single-cell edit.
             if (updated?.id) {
                 const patch = (rows: any[]) =>
                     rows.map((r) => (r.id === updated.id ? { ...r, ...updated, inventoryItem: updated.inventoryItem ?? r.inventoryItem } : r));
                 setSlips(patch);
                 setPastSlips(patch);
             } else {
                 fetchRequests();
             }
             // Keep the open modal in sync. The list refresh above only
             // rebuilds `slips`; `selectedRequest` is a captured snapshot, so
             // without this the modal kept showing the old value even after
             // the DB had the new one — exactly the "saved 3 but modal says
             // 1" bug.
             if (selectedRequest?.id === id && updated) {
                 setSelectedRequest((prev: any) => ({
                     ...prev,
                     ...updated,
                     // itemName edits update the related InventoryItem, not the
                     // request row — patch the nested field manually so the
                     // modal's item-name cell refreshes too.
                     inventoryItem: field === 'itemName'
                         ? { ...(prev?.inventoryItem || {}), name: value }
                         : prev?.inventoryItem,
                 }));
             }
         } catch (e: any) {
             // Common cases the backend rejects this edit with a useful message:
             //  - qtyIssued raise exceeds available stock
             //    ("Cannot raise issued qty by N — only X unit of 'item' in stock.")
             //  - qtyIssued < 0
             //  - role doesn't have write scope to this request's department
             // Don't swallow it — the clerk needs to know which.
             addToast(extractErrorMessage(e, `Could not update ${field}`), 'error');
         }
    };

    // Intercept the "Issued Qty" edit. If the clerk is issuing LESS than was
    // requested, open the reason prompt instead of saving straight away — the
    // backend rejects a shortfall edit without a reason anyway, and the reason
    // is what gets forwarded to the requester + their manager. A correction up
    // to / beyond the requested amount saves through the normal path.
    const handleQtyIssuedSave = (row: any, val: any) => {
        const newQty = Number(val);
        const requested = Number(row?.qtyRequested ?? 0);
        if (Number.isFinite(newQty) && newQty < requested) {
            setReasonText('');
            setReasonPrompt({
                id: row.id,
                newQty,
                oldQty: resolveIssuedQty(row),
                requested,
                itemName: row?.inventoryItem?.name || 'this item',
                unit: row?.inventoryItem?.unit || '',
            });
            return;
        }
        handleUpdateField(row.id, 'qtyIssued', newQty);
    };

    // Confirm the reduced quantity WITH a reason. Sends both to the backend,
    // which adjusts stock + the item's issued tally and notifies the requester
    // and their manager. Cancelling leaves the cell on its original value (the
    // EditableCell already reverts to its `value` prop on blur).
    const submitReason = async () => {
        if (!reasonPrompt) return;
        const reason = reasonText.trim();
        if (!reason) { addToast('Please enter a reason', 'error'); return; }
        setSavingReason(true);
        try {
            const res = await client.patch(`/requests/${reasonPrompt.id}`, { qtyIssued: reasonPrompt.newQty, issueReason: reason });
            const updated = res.data?.data || res.data;
            addToast('Issued quantity updated — requester & manager notified', 'success');
            if (selectedRequest?.id === reasonPrompt.id && updated) {
                setSelectedRequest((prev: any) => ({ ...prev, ...updated, inventoryItem: prev?.inventoryItem }));
            }
            setReasonPrompt(null);
            setReasonText('');
            // Same reasoning as handleUpdateField: a quantity edit keeps the
            // slip on its current tab, and the updated row is already here.
            if (updated?.id) {
                const patch = (rows: any[]) =>
                    rows.map((r) => (r.id === updated.id ? { ...r, ...updated, inventoryItem: updated.inventoryItem ?? r.inventoryItem } : r));
                setSlips(patch);
                setPastSlips(patch);
            } else {
                fetchRequests();
            }
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Could not update issued quantity'), 'error');
        } finally {
            setSavingReason(false);
        }
    };

    const handleView = (req: any) => {
        setSelectedRequest(req);
        setIsViewModalOpen(true);
    };

    // Group BOM-spawned slips by bomListId so the clerk sees ONE slip
    // per BOM instead of N scattered ComponentRequest rows. Standalone
    // (non-BOM) requests stay in the regular table below. Each bom group
    // aggregates: total lines, total issued qty, status span, requester.
    const buildBomGroups = (rows: any[]) => {
        const groups = new Map<string, any>();
        const standalone: any[] = [];
        for (const r of rows) {
            if (r.bomListId && r.bomList) {
                const key = r.bomListId;
                if (!groups.has(key)) {
                    groups.set(key, {
                        id: key,
                        serialNo: r.bomList.serialNo,
                        name: r.bomList.name,
                        requester: r.createdBy?.name || 'Unknown',
                        department: r.department?.name || 'Unknown',
                        rows: [],
                        totalQty: 0,
                        totalIssued: 0,
                        firstDate: r.issuedAt,
                        lastDate: r.issuedAt,
                    });
                }
                const g = groups.get(key);
                g.rows.push(r);
                g.totalQty += Number(r.qtyRequested || 0);
                g.totalIssued += Number(r.qtyIssued || 0);
                if (r.issuedAt && (!g.firstDate || r.issuedAt < g.firstDate)) g.firstDate = r.issuedAt;
                if (r.issuedAt && (!g.lastDate  || r.issuedAt > g.lastDate))  g.lastDate  = r.issuedAt;
            } else {
                standalone.push(r);
            }
        }
        return { boms: Array.from(groups.values()), standalone };
    };
    const activeGrouped  = useMemo(() => buildBomGroups(slips),     [slips]);
    const historyGrouped = useMemo(() => buildBomGroups(pastSlips), [pastSlips]);

    // A filter on every data column, live and History (owner, 27 Oct) — the
    // same per-column filters as Inventory Requests. Values match what each
    // cell shows, so a dropdown offers exactly what is on screen; they run
    // over every loaded slip, not just the visible page.
    const accountableNames = (r: any) => {
        const names = (r?.responsiblePersons ?? []).map((rp: any) => rp.user?.name).filter(Boolean);
        return names.length ? names : 'None';
    };
    const activeSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'reqId', getValue: (r) => r.serialNo || r.id.split('-')[0] },
        { key: 'issuedTo', getValue: (r) => r?.issuedToName || r?.createdBy?.name || 'Unknown' },
        { key: 'dept', getValue: (r) => r?.department?.name || 'Unknown' },
        { key: 'accountable', getValue: accountableNames },
        { key: 'date', getValue: (r) => (r?.issuedAt ? fmtDate(r.issuedAt) : '') },
    ], []);
    const historySpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'reqId', getValue: (r) => r.serialNo || r.id.split('-')[0] },
        { key: 'issuedTo', getValue: (r) => r?.issuedToName || r?.createdBy?.name || 'Unknown' },
        { key: 'dept', getValue: (r) => r?.department?.name || 'Unknown' },
        { key: 'issuedDate', getValue: (r) => (r?.issuedAt ? fmtDate(r.issuedAt) : '') },
        { key: 'confirmedAt', getValue: (r) => (r?.issuedConfirmedAt ? fmtDate(r.issuedConfirmedAt) : 'Not confirmed') },
        { key: 'status', getValue: (r) => (r?.status ? statusLabel(r.status) : '') },
    ], []);
    const activeF = usePagedFilters(activeGrouped.standalone, activeSpecs, 10);
    const historyF = usePagedFilters(historyGrouped.standalone, historySpecs, 10);
    const activeBomsPager = useClientPagination<any>(activeGrouped.boms, 10);
    const historyBomsPager = useClientPagination<any>(historyGrouped.boms, 10);

    // Header with its column filter (searchable — these lists run long).
    const filtered = (f: ReturnType<typeof useTableFilters<any>>, label: string, key: string) => ({
        filterActive: f.isActive(key),
        header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={f.getOptions(key)} value={f.filters[key] || ''} onChange={(v) => f.setFilter(key, v)} /></span>,
    });

    const columns = [
        { ...filtered(activeF, 'Request ID', 'reqId'), accessor: (row: any) => <span className="font-mono text-xs font-bold text-ink">{row.serialNo || row.id.split('-')[0]}</span> },
        { ...filtered(activeF, 'Issued To', 'issuedTo'), accessor: (row: any) => (
             <EditableCell 
                value={row?.issuedToName || row?.createdBy?.name || 'Unknown'} 
                onSave={(val) => handleUpdateField(row.id, 'issuedToName', val)} 
            />
        )},
        { ...filtered(activeF, 'Department', 'dept'), accessor: (row: any) => row?.department?.name || 'Unknown' },
        { ...filtered(activeF, 'Accountable', 'accountable'), accessor: (row: any) => <span className="text-xs text-muted max-w-[150px] truncate inline-block" title={row?.responsiblePersons?.map((rp: any) => rp.user?.name).join(', ')}>{row?.responsiblePersons?.map((rp: any) => rp.user?.name).join(', ') || 'None'}</span> },
        { ...filtered(activeF, 'Date', 'date'), accessor: (row: any) => (
             <EditableCell 
                type="date"
                value={row?.issuedAt ? new Date(row.issuedAt).toISOString().split('T')[0] : ''} 
                onSave={(val) => handleUpdateField(row.id, 'issuedAt', val)} 
            />
        )},
        { header: 'Confirm', accessor: (row: any) => (
            <button onClick={() => handleConfirmIssued(row.id)} disabled={confirmingId === row.id} className="text-xs bg-green-700 text-white px-3 py-1 rounded-md font-bold hover:bg-green-800 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">{confirmingId === row.id ? '…' : 'Issued'}</button>
        )},
        { header: 'Actions', accessor: (row: any) => (
            <button 
                onClick={() => handleView(row)} 
                className="text-sm bg-brand text-white px-3 py-1 rounded-full font-bold hover:bg-brand-dark transition-colors shadow-sm"
            >
                View
            </button>
        )}
    ];

    const historyColumns = [
        { ...filtered(historyF, 'Request ID', 'reqId'), accessor: (row: any) => <span className="font-mono text-xs font-bold text-ink">{row.serialNo || row.id.split('-')[0]}</span> },
        { ...filtered(historyF, 'Issued To', 'issuedTo'), accessor: (row: any) => <span className="text-sm text-ink">{row?.issuedToName || row?.createdBy?.name || 'Unknown'}</span> },
        { ...filtered(historyF, 'Department', 'dept'), accessor: (row: any) => row?.department?.name || 'Unknown' },
        { ...filtered(historyF, 'Issued Date', 'issuedDate'), accessor: (row: any) => row?.issuedAt ? fmtDateTime(row.issuedAt) : '-' },
        { ...filtered(historyF, 'Confirmed At', 'confirmedAt'), accessor: (row: any) => row?.issuedConfirmedAt ? (
            <span className="text-xs text-ink">{fmtDateTime(row.issuedConfirmedAt)}</span>
        ) : <span className="text-xs text-faint">-</span> },
        { ...filtered(historyF, 'Status', 'status'), accessor: (row: any) => <StatusBadge status={row?.status} /> },
        { header: 'Actions', accessor: (row: any) => (
            <button
                onClick={() => handleView(row)}
                className="text-sm bg-brand text-white px-3 py-1 rounded-full font-bold hover:bg-brand-dark transition-colors shadow-sm"
            >
                View
            </button>
        )},
    ];

    const detailColumns = [
        { header: 'Item Name', accessor: (row: any) => (
             <EditableCell
                value={row?.inventoryItem?.name || 'Unknown Item'}
                onSave={(val) => handleUpdateField(row.id, 'itemName', val)}
            />
        )},
        { header: 'Requested Qty', accessor: (row: any) => row?.qtyRequested || 0 },
        { header: 'Issued Qty', accessor: (row: any) => (
             <EditableCell
                type="number"
                value={resolveIssuedQty(row)}
                onSave={(val) => handleQtyIssuedSave(row, val)}
            />
        )}
    ];

    return (
        <div className="space-y-4 md:space-y-6">
            <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold tracking-tight font-bold text-ink">Issue Slips</h2>
                <button 
                    onClick={() => setIsHistoryModalOpen(true)}
                    className="bg-ink text-card px-4 py-2 font-bold rounded-md hover:bg-black transition-colors shadow-sm"
                >
                    History
                </button>
            </div>

            {/* BOM Slips section — one row per BOM that has issued items.
                Clicking opens a consolidated view showing every line +
                the linked indent (if any). Keeps related items together
                instead of scattered across the flat slips table below. */}
            {activeGrouped.boms.length > 0 && (
                <div className="bg-card rounded-xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-brand-200 overflow-hidden">
                    <div className="px-5 py-3 border-b border-brand-200 bg-brand-100/40 flex items-center gap-2">
                        <Package size={16} className="text-brand" />
                        <h3 className="text-sm font-bold text-ink">BOM Slips ({activeGrouped.boms.length})</h3>
                        <span className="text-[10px] text-faint">Each slip groups every item issued from one BOM.</span>
                    </div>
                    <div className="divide-y divide-line-soft">
                        {activeBomsPager.pageRows.map((g: any) => (
                            <button
                                key={g.id}
                                onClick={() => setOpenBomSlipId(g.id)}
                                className="w-full px-5 py-3 flex items-center gap-3 text-sm hover:bg-surface text-left"
                            >
                                <span className="font-mono text-xs font-bold text-ink">{g.serialNo}</span>
                                <span className="flex-1 min-w-0">
                                    <span className="font-bold text-ink block truncate">{g.name}</span>
                                    <span className="text-[10px] text-faint">
                                        {g.requester} · {g.department} · {g.firstDate ? fmtDateTime(g.firstDate) : '—'}
                                    </span>
                                </span>
                                <span className="text-xs text-muted shrink-0">
                                    {g.rows.length} line{g.rows.length === 1 ? '' : 's'} · {g.totalIssued}/{g.totalQty} issued
                                </span>
                                <ChevronRight size={14} className="text-faint shrink-0" />
                            </button>
                        ))}
                    </div>
                    <Pagination currentPage={activeBomsPager.page} totalPages={activeBomsPager.totalPages} onPageChange={activeBomsPager.setPage} />
                </div>
            )}

            <div className="bg-card rounded-xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-zebra overflow-hidden">
                {/* Standalone slips (non-BOM) — same flat table as before. */}
                {activeGrouped.boms.length > 0 && (
                    <div className="px-5 py-2 border-b border-line-soft bg-surface/60">
                        <h3 className="text-xs font-bold text-muted uppercase tracking-wider">Standalone Slips</h3>
                    </div>
                )}
                <div className="p-0">
                    <BulkSelectionBar count={activeSel.selectedIds.size} onClear={activeSel.clearSelection}>
                        {/* Bulk confirm-issued — every active slip is a valid target
                            (the list only holds unconfirmed IN_USE/OVERDUE rows), so this
                            loops the same PATCH the per-row "Issued" button fires and
                            sweeps a whole handover to history at once. */}
                        <BulkActionButton
                            label="Mark issued"
                            count={activeSel.selectedIds.size}
                            verb="confirmed"
                            confirmTitle="Confirm handover?"
                            confirmMessage={`Mark ${activeSel.selectedIds.size} selected slip${activeSel.selectedIds.size === 1 ? '' : 's'} as physically issued? They move to history.`}
                            onRun={() => runPerId([...activeSel.selectedIds], (id) => client.patch(`/requests/${id}`, { issuedConfirmedAt: new Date().toISOString() }))}
                            onDone={() => { activeSel.clearSelection(); fetchRequests(); window.dispatchEvent(new Event('requests-updated')); }}
                        />
                    </BulkSelectionBar>
                    <DataTable
                        columns={columns}
                        data={activeF.pageRows}
                        isLoading={isLoading}
                        keyExtractor={r => r.id}
                        emptyStateMessage={activeGrouped.boms.length > 0 ? 'No standalone (non-BOM) slips.' : 'No active issue slips.'}
                        maxHeight="60vh"
                        selectedIds={activeSel.selectedIds}
                        onToggleSelect={activeSel.toggleSelect}
                        onToggleSelectAllVisible={activeSel.toggleSelectAllVisible}
                    />
                    <Pagination currentPage={activeF.page} totalPages={activeF.totalPages} onPageChange={activeF.setPage} />
                </div>
            </div>

            <Modal isOpen={isViewModalOpen} onClose={() => setIsViewModalOpen(false)} title={`Issue Slip - ${selectedRequest?.serialNo || 'N/A'}`} size="lg">
                {selectedRequest && (
                    <div className="space-y-4 md:space-y-6">
                        <div className="bg-surface p-4 rounded-lg border border-line-soft space-y-3">
                            <div className="flex justify-between items-start gap-4">
                                <div className="grid grid-cols-2 gap-x-6 gap-y-3 flex-1">
                                    <div>
                                        <p className="text-xs text-muted uppercase font-bold tracking-wider">Issued To</p>
                                        <p className="text-sm font-medium text-ink">{selectedRequest?.issuedToName || selectedRequest?.createdBy?.name || 'Unknown'}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-muted uppercase font-bold tracking-wider">Department</p>
                                        <p className="text-sm font-medium text-ink">{selectedRequest?.department?.name || 'Unknown'}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-muted uppercase font-bold tracking-wider">Issued Date</p>
                                        <p className="text-sm font-medium text-ink">{selectedRequest?.issuedAt ? fmtDateTime(selectedRequest.issuedAt) : '—'}</p>
                                    </div>
                                    <div>
                                        <p className="text-xs text-muted uppercase font-bold tracking-wider">Confirmed At</p>
                                        <p className="text-sm font-medium text-ink">{selectedRequest?.issuedConfirmedAt ? fmtDateTime(selectedRequest.issuedConfirmedAt) : '—'}</p>
                                    </div>
                                </div>
                                <PendingCell status={selectedRequest?.status || 'PENDING'} reason={statusReasonForRequest(selectedRequest)} />
                            </div>
                            <div>
                                <p className="text-xs text-muted uppercase font-bold tracking-wider">Accountable</p>
                                <p className="text-sm font-medium text-ink">{selectedRequest?.responsiblePersons?.map((rp: any) => rp.user?.name).filter(Boolean).join(', ') || 'None'}</p>
                            </div>
                        </div>
                        
                        <div>
                            <h4 className="font-bold text-ink mb-3">Issued Items</h4>
                            <div className="border border-line rounded-lg overflow-hidden">
                                <DataTable 
                                    columns={detailColumns} 
                                    data={[selectedRequest]}
                                    isLoading={false} 
                                    keyExtractor={r => r.id} 
                                />
                            </div>
                        </div>
                    </div>
                )}
            </Modal>

            {/* Title says the SERVER count when it exceeds what could be
                fetched, so a clerk can tell a short list from a complete one —
                the page can only hold PAGE_CAP rows and used to show the
                truncated list with no hint. Export covers the deeper archive. */}
            <Modal
                isOpen={isHistoryModalOpen}
                onClose={() => setIsHistoryModalOpen(false)}
                title={
                    historyTotal !== null && historyTotal > pastSlips.length
                        ? `Issue History (showing the ${pastSlips.length} most recent of ${historyTotal} — use Export for the full archive)`
                        : `Issue History (${pastSlips.length})`
                }
                size="full"
            >
                <div className="mb-3">
                    <ExportPanel kind="requests" />
                </div>
                {/* History modal — same grouping pattern. BOM history at
                    the top, standalone past slips below. */}
                {historyGrouped.boms.length > 0 && (
                    <div className="mb-4 border border-brand-200 rounded-lg overflow-hidden">
                        <div className="px-4 py-2 bg-brand-100/40 border-b border-brand-200 flex items-center gap-2">
                            <Package size={14} className="text-brand" />
                            <h4 className="text-xs font-bold text-ink">BOM Slips ({historyGrouped.boms.length})</h4>
                        </div>
                        <div className="divide-y divide-line-soft">
                            {historyBomsPager.pageRows.map((g: any) => (
                                <button
                                    key={g.id}
                                    onClick={() => setOpenBomSlipId(g.id)}
                                    className="w-full px-4 py-2 flex items-center gap-3 text-sm hover:bg-surface text-left"
                                >
                                    <span className="font-mono text-xs font-bold text-ink">{g.serialNo}</span>
                                    <span className="flex-1 min-w-0">
                                        <span className="font-bold text-ink block truncate">{g.name}</span>
                                        <span className="text-[10px] text-faint">
                                            {g.requester} · {g.department} · {g.lastDate ? fmtDateTime(g.lastDate) : '—'}
                                        </span>
                                    </span>
                                    <span className="text-xs text-muted shrink-0">
                                        {g.rows.length} line{g.rows.length === 1 ? '' : 's'}
                                    </span>
                                    <ChevronRight size={12} className="text-faint shrink-0" />
                                </button>
                            ))}
                        </div>
                        <Pagination currentPage={historyBomsPager.page} totalPages={historyBomsPager.totalPages} onPageChange={historyBomsPager.setPage} />
                    </div>
                )}
                <DataTable
                    columns={historyColumns}
                    data={historyF.pageRows}
                    isLoading={isLoading}
                    keyExtractor={r => r.id}
                    emptyStateMessage="No past standalone slips."
                />
                <Pagination currentPage={historyF.page} totalPages={historyF.totalPages} onPageChange={historyF.setPage} />
            </Modal>

            {/* Reason prompt — required when issuing below the requested qty.
                The reason + old→new counts are forwarded to the requester and
                their manager so a shortfall is never silent. */}
            <Modal
                isOpen={!!reasonPrompt}
                onClose={() => { setReasonPrompt(null); setReasonText(''); }}
                title="Reason for reduced quantity"
            >
                {reasonPrompt && (
                    <div className="space-y-4">
                        <div className="bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-lg p-3 text-sm text-ink">
                            Issuing <span className="font-bold">{reasonPrompt.newQty}</span> of{' '}
                            <span className="font-bold">{reasonPrompt.requested}</span> requested
                            {reasonPrompt.unit ? ` ${reasonPrompt.unit}` : ''} for{' '}
                            <span className="font-bold">{reasonPrompt.itemName}</span>{' '}
                            (was {reasonPrompt.oldQty}). The requester and their manager will be
                            notified with your reason.
                        </div>
                        <div>
                            <label className="block text-xs font-bold text-muted uppercase tracking-wider mb-1">
                                Reason <span className="text-red-700 dark:text-red-300">*</span>
                            </label>
                            <textarea
                                value={reasonText}
                                onChange={(e) => setReasonText(e.target.value)}
                                rows={3}
                                autoFocus
                                placeholder="e.g. Only 50 units in stock; remainder back-ordered."
                                className="block w-full border border-line focus:border-brand focus:ring-brand rounded-md shadow-sm text-sm p-2"
                            />
                        </div>
                        <div className="flex justify-end gap-2">
                            <button
                                onClick={() => { setReasonPrompt(null); setReasonText(''); }}
                                className="px-4 py-2 text-sm font-bold text-muted hover:bg-hover rounded-md transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={submitReason}
                                disabled={savingReason || !reasonText.trim()}
                                className="px-4 py-2 text-sm font-bold bg-brand text-white rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {savingReason ? 'Saving…' : 'Issue & Notify'}
                            </button>
                        </div>
                    </div>
                )}
            </Modal>

            {/* Consolidated BOM Slip — fetched on open, shows every line +
                spawned indent under one umbrella. The "single slip" the
                user asked for: open BOM-001 → see all 5 items + IND-001
                + status of each. No need to track across multiple rows. */}
            <BomSlipDetailModal
                bomListId={openBomSlipId}
                onClose={() => setOpenBomSlipId(null)}
                onIssued={() => { fetchRequests(); window.dispatchEvent(new Event('requests-updated')); }}
            />
        </div>
    );
};

// One consolidated view per BOM. Loaded lazily — only fetches when a BOM
// row is clicked. Reuses the same /bom-lists/:id detail endpoint that the
// requester's editor modal uses, so the data shape is exactly what the
// rollup already understands (spawnedRequests + spawnedIndents).
const BomSlipDetailModal = ({ bomListId, onClose, onIssued }: { bomListId: string | null; onClose: () => void; onIssued?: () => void }) => {
    const [data, setData] = useState<any | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [issuingId, setIssuingId] = useState<string | null>(null);
    const { addToast } = useToast();

    useEffect(() => {
        if (!bomListId) { setData(null); setError(null); return; }
        let cancelled = false;
        setLoading(true);
        setError(null);
        client
            .get(`/bom-lists/${bomListId}`)
            .then(r => { if (!cancelled) setData(r.data?.data ?? r.data); })
            .catch((e: any) => { if (!cancelled) setError(extractErrorMessage(e, 'Failed to load BOM slip')); })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [bomListId]);

    // Re-pull after an action so the just-issued line flips to "Issued ✓".
    const reload = async () => {
        if (!bomListId) return;
        try { const r = await client.get(`/bom-lists/${bomListId}`); setData(r.data?.data ?? r.data); } catch { /* keep prior */ }
    };

    // Confirm hand-over of ONE line — the same PATCH the standalone Issue Slips
    // rows fire (issuedConfirmedAt). Two-step by design: the item was issued from
    // stock (IN_USE) earlier; this records it's been physically handed over.
    const markIssued = async (reqId: string) => {
        setIssuingId(reqId);
        try {
            await client.patch(`/requests/${reqId}`, { issuedConfirmedAt: new Date().toISOString() });
            addToast('Marked issued — handed over to the requester', 'success');
            await reload();
            onIssued?.();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to mark issued'), 'error');
        } finally {
            setIssuingId(null);
        }
    };

    const reqs    = data?.spawnedRequests || [];
    const indents = data?.spawnedIndents  || [];
    // Lines physically issued from stock (IN_USE/OVERDUE) but not yet confirmed
    // as handed over — these get the "Mark issued" action.
    const pendingHandover = reqs.filter((r: any) => !r.issuedConfirmedAt && (r.status === 'IN_USE' || r.status === 'OVERDUE'));
    // Client-paginate the in-stock lines at 10/page — a 250-line BOM spawns
    // ~100 request rows and rendering them all was unbounded. Reset to page 1
    // when a different BOM is opened. Note: markAllIssued still iterates the
    // FULL pendingHandover array (below), not this page slice.
    const reqsPager = useClientPagination<any>(reqs, 10, bomListId ?? '');
    const markAllIssued = async () => {
        for (const r of pendingHandover) {
            // Sequential on purpose: a mid-loop failure then surfaces per line.
            await markIssued(r.id);
        }
    };

    return (
        <Modal isOpen={!!bomListId} onClose={onClose} title={data ? `BOM Slip — ${data.serialNo} · ${data.name}` : 'BOM Slip'}>
            {loading && <p className="text-sm text-faint text-center py-6">Loading…</p>}
            {error && <p className="text-sm text-red-700 dark:text-red-300 text-center py-6">{error}</p>}
            {!loading && !error && data && (
                <div className="space-y-4 max-h-[70vh] overflow-y-auto p-1">
                    {/* Header meta */}
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                        <div>
                            <p className="text-[10px] font-bold text-faint uppercase">Requester</p>
                            <p className="font-medium text-ink">{data.createdBy?.name || '—'}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-bold text-faint uppercase">Department</p>
                            <p className="font-medium text-ink">{data.department?.name || '—'}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-bold text-faint uppercase">Project</p>
                            <p className="font-medium text-ink">{data.project?.name || 'General'}</p>
                        </div>
                        <div>
                            <p className="text-[10px] font-bold text-faint uppercase">Submitted</p>
                            <p className="font-medium text-ink">{data.submittedAt ? fmtDateTime(data.submittedAt) : '—'}</p>
                        </div>
                    </div>

                    {/* In-stock lines under this BOM — inventory hands each one
                        over to the requester (per-line "Mark issued"), the same
                        two-step model standalone slips use. Not auto-issued. */}
                    {reqs.length > 0 && (
                        <div>
                            <div className="flex items-center justify-between gap-2 mb-2">
                                <h4 className="text-xs font-bold text-muted uppercase">In-stock items ({reqs.length})</h4>
                                {pendingHandover.length > 1 && (
                                    <button
                                        onClick={markAllIssued}
                                        disabled={!!issuingId}
                                        className="text-[11px] font-bold text-white bg-green-700 hover:bg-green-800 rounded px-2 py-1 disabled:opacity-50 transition-colors"
                                        title="Mark every not-yet-handed-over line as issued"
                                    >
                                        Mark all issued ({pendingHandover.length})
                                    </button>
                                )}
                            </div>
                            <div className="border border-line-soft rounded-md divide-y divide-line-soft">
                                {reqsPager.pageRows.map((r: any) => {
                                    const confirmed = !!r.issuedConfirmedAt;
                                    const canIssue = !confirmed && (r.status === 'IN_USE' || r.status === 'OVERDUE');
                                    return (
                                        <div key={r.id} className="px-3 py-2 flex items-center gap-3 text-sm">
                                            <span className="font-mono text-[10px] text-muted shrink-0">{r.serialNo}</span>
                                            <span className="flex-1 text-ink truncate">{r.inventoryItem?.name}</span>
                                            <span className="text-xs text-muted shrink-0">
                                                {Number(r.qtyIssued || 0)} / {Number(r.qtyRequested)} {r.inventoryItem?.unit}
                                            </span>
                                            {confirmed ? (
                                                <span className="text-[11px] font-bold text-emerald-700 dark:text-emerald-300 shrink-0 whitespace-nowrap" title={`Handed over ${fmtDateTime(r.issuedConfirmedAt)}`}>Issued ✓</span>
                                            ) : canIssue ? (
                                                <button
                                                    onClick={() => markIssued(r.id)}
                                                    disabled={issuingId === r.id}
                                                    className="text-[11px] font-bold text-white bg-green-700 hover:bg-green-800 rounded px-2.5 py-1 disabled:opacity-50 shrink-0 whitespace-nowrap transition-colors"
                                                    title="Confirm this item has been physically handed to the requester"
                                                >
                                                    {issuingId === r.id ? '…' : 'Mark issued'}
                                                </button>
                                            ) : (
                                                <StatusBadge status={r.status} />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                            {reqsPager.totalPages > 1 && (
                                <Pagination currentPage={reqsPager.page} totalPages={reqsPager.totalPages} onPageChange={reqsPager.setPage} />
                            )}
                        </div>
                    )}

                    {/* Linked indent(s) — out-of-stock + custom items routed
                        through procurement land here. Surface them in the
                        same slip view so the clerk sees the FULL BOM. */}
                    {indents.length > 0 && (
                        <div>
                            <h4 className="text-xs font-bold text-muted uppercase mb-2">Procurement (in flight)</h4>
                            <div className="border border-sky-100 dark:border-sky-400/25 rounded-md divide-y divide-sky-50">
                                {indents.map((ind: any) => (
                                    <div key={ind.id} className="px-3 py-2 text-sm">
                                        <div className="flex items-center gap-3 flex-wrap">
                                            <span className="font-mono text-[10px] text-muted">{ind.serialNo}</span>
                                            <span className="flex-1 text-ink">{ind.items?.length || 0} line{(ind.items?.length || 0) === 1 ? '' : 's'}</span>
                                            <span className="text-[10px] text-faint shrink-0">{ind.currency} {Number(ind.grandTotal || 0).toLocaleString()}</span>
                                        </div>
                                        <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[10px]">
                                            <span className="text-muted">Tech head:</span>
                                            <StatusBadge status={ind.techApprovalStatus} />
                                            <span className="text-muted ml-2">CEO:</span>
                                            <StatusBadge status={ind.ceoApprovalStatus} />
                                            <span className="text-muted ml-2">Status:</span>
                                            <StatusBadge status={ind.status} />
                                        </div>
                                        {ind.items?.length > 0 && (
                                            <div className="mt-1 pl-1 text-[10px] text-faint truncate">
                                                {ind.items.map((it: any) => `${it.name} (${Number(it.qty)} ${it.unit})`).join(' · ')}
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {reqs.length === 0 && indents.length === 0 && (
                        <p className="text-sm text-faint text-center py-6">
                            This BOM hasn't spawned any items yet.
                        </p>
                    )}
                </div>
            )}
        </Modal>
    );
};
