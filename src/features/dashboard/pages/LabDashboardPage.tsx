import { PICKER_INITIAL_ITEMS } from '@/features/inventory/hooks/useInventoryOptions';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRequests, useIndents, useInventoryOptions, useTableFilters, useClientPagination, FilterSpec } from '@/hooks';
import { client } from '@/api';
import { extractErrorMessage } from '@/lib';
import { DataTable, Modal, ColumnFilter, PendingCell, Pagination, StatCard } from '@/components/ui';
import { RequestForm, IndentForm } from '@/components/forms';
import { useToast } from '@/context/ToastContext';
import { fmtDateTime, formatDueDelta, fmtRelativeTime, dateOnlyKey } from '@/utils/date';
import { statusReasonForIndent, statusReasonForRequest } from '@/utils/pendingReason';
import { ceoLaneVisible } from '@/config/thresholds';
import { ApprovalCell } from '@/features/indents/components/IndentDetailsModal';
import {
  Package, ArrowUpFromLine, AlertTriangle, FileText, Plus, Activity
} from 'lucide-react';

const fmtTime = (ts: string) => fmtRelativeTime(ts);

export const LabDashboardPage = () => {
    const { requests, isLoading: reqLoading, fetchRequests } = useRequests();
    const { indents, isLoading: indLoading, fetchIndents } = useIndents();
    const { addToast } = useToast();

    // The shared hook rather than a hand-rolled fetch of the same endpoint:
    // this page had its own copy, which meant it also had its own copy of the
    // bug — it threw away the `truncated` flag, so past the 5,000-item ceiling
    // the picker below would have gone quietly short with nothing to say so.
    // Short list, not the whole catalogue: this only fills the Request
    // Component picker, and that picker now searches the server as you
    // type. Pulling every scoped row on mount made everyone wait for a
    // download they mostly never used.
const { items: inventoryItems, truncated: optionsTruncated, total: optionsTotal } = useInventoryOptions(PICKER_INITIAL_ITEMS);
    const [showRequestModal, setShowRequestModal] = useState(false);
    const [showIndentModal, setShowIndentModal] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => { fetchRequests(); fetchIndents(); }, [fetchRequests, fetchIndents]);

    // The stat cards counted the rows of the two lists above, and both list
    // endpoints stop at 200 rows by default — so past 200 the cards quietly
    // read 200. Each list also returns the server's `total` for its filter,
    // so ask for one row per card and read that instead. Until those land (or
    // if they fail) the cards fall back to counting the loaded rows.
    const [totals, setTotals] = useState<{ requests?: number; active?: number; overdue?: number; pipeline?: number }>({});
    const fetchTotals = useCallback(() => {
        const totalOf = (path: string, params: Record<string, string>) =>
            client.get(path, { params: { ...params, take: 1 } })
                .then(res => {
                    const t = (res.data?.data ?? res.data)?.total;
                    return typeof t === 'number' ? t : undefined;
                })
                .catch(() => undefined);
        Promise.all([
            totalOf('/requests', {}),
            totalOf('/requests', { status: 'IN_USE' }),
            totalOf('/requests', { status: 'OVERDUE' }),
            totalOf('/indents', { excludeStatus: 'RECEIVED,REJECTED,CANCELLED' }),
        ]).then(([requestsTotal, active, overdue, pipeline]) =>
            setTotals({ requests: requestsTotal, active, overdue, pipeline }));
    }, []);
    useEffect(() => { fetchTotals(); }, [fetchTotals]);

    const activeRequests = requests.filter(r => r.status === 'IN_USE');
    const overdueRequests = useMemo(() => requests.filter(r => r.status === 'OVERDUE').sort((a: any, b: any) => {
        const da = a.dueDate ? new Date(a.dueDate).getTime() : 0;
        const db = b.dueDate ? new Date(b.dueDate).getTime() : 0;
        return da - db;
    }), [requests]);
    const pipelineIndents = useMemo(() => indents.filter((i: any) => !['RECEIVED', 'REJECTED', 'CANCELLED'].includes(i.status)), [indents]);
    const overdueCount = totals.overdue ?? overdueRequests.length;
    const recentRequests = [...requests].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 10);

    const pipelineFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'indentNo',   getValue: (r) => r.serialNo },
        { key: 'department', getValue: (r) => r.department?.name },
        { key: 'amount',     getValue: (r) => `${r.currency} ${r.grandTotal?.toLocaleString() ?? ''}` },
        { key: 'tech',       getValue: (r) => r.techApprovalStatus || 'PENDING' },
        { key: 'ceo',        getValue: (r) => (ceoLaneVisible(r) ? (r.ceoApprovalStatus || 'PENDING') : 'N/A') },
        { key: 'payment',    getValue: (r) => r.paymentTransactionId },
        { key: 'status',     getValue: (r) => r.status },
    ], []);

    const overdueFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'serial',     getValue: (r) => r.serialNo },
        { key: 'component',  getValue: (r) => r.inventoryItem?.name },
        { key: 'holder',     getValue: (r) => r.createdBy?.name },
        { key: 'department', getValue: (r) => r.department?.name },
        { key: 'dueDate',    getValue: (r) => dateOnlyKey(r.dueDate) },
        // A filter on every data column (owner, 27 Oct) — the value the cell shows.
        { key: 'overdue',    getValue: (r) => { const dd = formatDueDelta(r.dueDate); return dd.overdue ? dd.magnitude : '0'; } },
    ], []);

    const pipelineF = useTableFilters(pipelineIndents, pipelineFilterSpecs);
    const overdueF = useTableFilters(overdueRequests, overdueFilterSpecs);

    const pipelinePager = useClientPagination<any>(pipelineF.filteredRows, 10, JSON.stringify(pipelineF.filters));
    const overduePager = useClientPagination<any>(overdueF.filteredRows, 10, JSON.stringify(overdueF.filters));

    const handleCreateRequest = async (data: any) => {
        setIsSubmitting(true);
        // The response is returned so RequestForm can attach its optional photo,
        // which needs the new id (POST /requests/:id/attachment).
        try {
            const res = await client.post('/requests', data);
            addToast('Request submitted', 'success'); setShowRequestModal(false); fetchRequests(); fetchTotals();
            return res.data?.data ?? res.data;
        }
        catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
        finally { setIsSubmitting(false); }
    };

    const handleCreateIndent = async (data: any) => {
        setIsSubmitting(true);
        // The response is returned so IndentForm can attach its optional
        // per-line photos, which need the ids the server assigns.
        try {
            const res = await client.post('/indents', data);
            addToast('Indent raised', 'success'); setShowIndentModal(false); fetchIndents(); fetchTotals();
            return res.data?.data ?? res.data;
        }
        catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
        finally { setIsSubmitting(false); }
    };

    // Indent pipeline columns
    const pipelineCols = [
        { filterActive: pipelineF.isActive('indentNo'),   header: <span className="inline-flex items-center">Indent #<ColumnFilter searchable options={pipelineF.getOptions('indentNo')}   value={pipelineF.filters.indentNo   || ''} onChange={(v) => pipelineF.setFilter('indentNo', v)}   /></span>, accessor: (r: any) => <span className="font-mono text-xs font-bold text-ink">{r.serialNo}</span> },
        { filterActive: pipelineF.isActive('department'), header: <span className="inline-flex items-center">Dept<ColumnFilter options={pipelineF.getOptions('department')}                       value={pipelineF.filters.department || ''} onChange={(v) => pipelineF.setFilter('department', v)} /></span>, accessor: (r: any) => <span className="text-xs text-muted">{r.department?.name || '-'}</span> },
        { filterActive: pipelineF.isActive('amount'),     header: <span className="inline-flex items-center">Amount<ColumnFilter searchable options={pipelineF.getOptions('amount')}       value={pipelineF.filters.amount     || ''} onChange={(v) => pipelineF.setFilter('amount', v)}     /></span>, accessor: (r: any) => <span className="text-xs font-bold">{r.currency} {r.grandTotal?.toLocaleString()}</span> },
        { filterActive: pipelineF.isActive('tech'),       header: <span className="inline-flex items-center">Tech<ColumnFilter options={pipelineF.getOptions('tech')}                             value={pipelineF.filters.tech       || ''} onChange={(v) => pipelineF.setFilter('tech', v)}       /></span>, accessor: (r: any) => <ApprovalCell status={r.techApprovalStatus || 'PENDING'} timestamp={r.techApprovedAt} approverName={r.techApprovedBy?.name} /> },
        { filterActive: pipelineF.isActive('ceo'),        header: <span className="inline-flex items-center">CEO<ColumnFilter options={pipelineF.getOptions('ceo')}                               value={pipelineF.filters.ceo        || ''} onChange={(v) => pipelineF.setFilter('ceo', v)}        /></span>, accessor: (r: any) => {
            if (!ceoLaneVisible(r)) return <span className="text-[9px] text-faint">N/A</span>;
            return <ApprovalCell status={r.ceoApprovalStatus || 'PENDING'} timestamp={r.ceoApprovedAt} approverName={r.ceoApprovedBy?.name} />;
        }},
        { filterActive: pipelineF.isActive('payment'),    header: <span className="inline-flex items-center">Payment<ColumnFilter searchable options={pipelineF.getOptions('payment')}     value={pipelineF.filters.payment    || ''} onChange={(v) => pipelineF.setFilter('payment', v)}    /></span>, accessor: (r: any) => r.paymentTransactionId
            ? <span className="text-[10px] font-mono text-ink" title={r.paymentTransactionId}>{r.paymentTransactionId.slice(0, 14)}{r.paymentTransactionId.length > 14 ? '…' : ''}</span>
            : (r.status === 'AWAITING_PAYMENT'
                ? <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300">Awaiting</span>
                : <span className="text-[9px] text-faint">—</span>) },
        { filterActive: pipelineF.isActive('status'),     header: <span className="inline-flex items-center">Status<ColumnFilter options={pipelineF.getOptions('status')}                         value={pipelineF.filters.status     || ''} onChange={(v) => pipelineF.setFilter('status', v)}     /></span>, accessor: (r: any) => <PendingCell status={r.status} reason={statusReasonForIndent(r)} /> },
    ];

    // Overdue columns
    const overdueCols = [
        { filterActive: overdueF.isActive('serial'),     header: <span className="inline-flex items-center">Serial<ColumnFilter searchable options={overdueF.getOptions('serial')}      value={overdueF.filters.serial     || ''} onChange={(v) => overdueF.setFilter('serial', v)}     /></span>, accessor: (r: any) => <span className="font-mono text-xs text-ink">{r.serialNo}</span> },
        { filterActive: overdueF.isActive('component'),  header: <span className="inline-flex items-center">Component<ColumnFilter searchable options={overdueF.getOptions('component')} value={overdueF.filters.component  || ''} onChange={(v) => overdueF.setFilter('component', v)}  /></span>, accessor: (r: any) => <span className="text-sm font-medium text-ink">{r.inventoryItem?.name || '-'}</span> },
        { filterActive: overdueF.isActive('holder'),     header: <span className="inline-flex items-center">Holder<ColumnFilter searchable options={overdueF.getOptions('holder')}      value={overdueF.filters.holder     || ''} onChange={(v) => overdueF.setFilter('holder', v)}     /></span>, accessor: (r: any) => <span className="text-xs font-bold text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-400/15 px-1.5 py-0.5 rounded">{r.createdBy?.name || '-'}</span> },
        { filterActive: overdueF.isActive('department'), header: <span className="inline-flex items-center">Dept<ColumnFilter options={overdueF.getOptions('department')}                     value={overdueF.filters.department || ''} onChange={(v) => overdueF.setFilter('department', v)} /></span>, accessor: (r: any) => <span className="text-xs text-muted">{r.department?.name || '-'}</span> },
        { filterActive: overdueF.isActive('dueDate'),    header: <span className="inline-flex items-center">Due Date<ColumnFilter searchable options={overdueF.getOptions('dueDate')}    value={overdueF.filters.dueDate    || ''} onChange={(v) => overdueF.setFilter('dueDate', v)}    /></span>, accessor: (r: any) => <span className="text-xs text-muted">{fmtDateTime(r.dueDate)}</span> },
        { filterActive: overdueF.isActive('overdue'),    header: <span className="inline-flex items-center">Overdue<ColumnFilter searchable options={overdueF.getOptions('overdue')}    value={overdueF.filters.overdue    || ''} onChange={(v) => overdueF.setFilter('overdue', v)}    /></span>, accessor: (r: any) => {
            const dd = formatDueDelta(r.dueDate);
            return <span className="text-xs font-bold text-red-700 dark:text-red-300">{dd.overdue ? dd.magnitude : '0'}</span>;
        }},
    ];

    const loading = reqLoading || indLoading;
    if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-7 w-7 border-2 border-line border-t-brand" /></div>;

    return (
        <div className="space-y-6">
            {/* Header + Actions */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Lab Command Center</h2>
                    <p className="text-sm text-muted mt-0.5">Cross-department overview of all components and indents</p>
                </div>
                <div className="flex gap-2">
                    <button onClick={() => setShowRequestModal(true)} className="flex items-center gap-1.5 px-3 py-2 bg-card border border-line text-ink text-sm font-bold rounded-lg hover:border-brand transition-colors">
                        <Plus size={15} /> Request
                    </button>
                    <button onClick={() => setShowIndentModal(true)} className="flex items-center gap-1.5 px-3 py-2 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-dark transition-colors shadow-sm">
                        <Plus size={15} /> Raise Indent
                    </button>
                </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <StatCard label="Total Requests" value={totals.requests ?? requests.length} icon={Package} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300" />
                <StatCard label="Active in Lab" value={totals.active ?? activeRequests.length} icon={ArrowUpFromLine} color="bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300" />
                <StatCard label="Overdue Returns" value={overdueCount} icon={AlertTriangle}
                    color={overdueCount > 0 ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300' : 'bg-surface text-faint'}
                    accent={overdueCount > 0} />
                <StatCard label="Indents in Pipeline" value={totals.pipeline ?? pipelineIndents.length} icon={FileText} color="bg-violet-50 dark:bg-violet-400/15 text-violet-600 dark:text-violet-300" />
            </div>

            {/* Indent Pipeline */}
            <div className="bg-card rounded-xl border border-line-soft shadow-sm">
                <div className="px-4 pt-4 pb-2">
                    <h3 className="text-sm font-bold text-ink flex items-center gap-2">
                        <FileText size={14} className="text-brand" /> Indent Approval Pipeline
                    </h3>
                    <p className="text-[11px] text-faint mt-0.5">Track every indent from submission to delivery</p>
                </div>
                <div className="p-4 pt-0">
                    <DataTable
                        columns={pipelineCols}
                        data={pipelinePager.pageRows}
                        isLoading={false}
                        keyExtractor={r => r.id}
                        emptyStateMessage="No active indents."
                        maxHeight="300px"
                    />
                    <Pagination currentPage={pipelinePager.page} totalPages={pipelinePager.totalPages} onPageChange={pipelinePager.setPage} />
                </div>
            </div>

            {/* Overdue + Recent side by side */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* Overdue */}
                <div className="bg-card rounded-xl border border-line-soft shadow-sm">
                    <div className="px-4 pt-4 pb-2">
                        <h3 className="text-sm font-bold text-red-700 dark:text-red-300 flex items-center gap-2">
                            <AlertTriangle size={14} /> Overdue Returns ({overdueRequests.length})
                        </h3>
                    </div>
                    <div className="p-4 pt-0">
                        <DataTable
                            columns={overdueCols}
                            data={overduePager.pageRows}
                            isLoading={false}
                            keyExtractor={r => r.id}
                            emptyStateMessage="No overdue items — all clear!"
                            maxHeight="280px"
                        />
                        <Pagination currentPage={overduePager.page} totalPages={overduePager.totalPages} onPageChange={overduePager.setPage} />
                    </div>
                </div>

                {/* Recent Requests Feed */}
                <div className="bg-card rounded-xl border border-line-soft shadow-sm p-4">
                    <h3 className="text-sm font-bold text-ink flex items-center gap-2 mb-3">
                        <Activity size={14} className="text-brand" /> Recent Requests
                    </h3>
                    <div className="max-h-[280px] overflow-y-auto space-y-0">
                        {recentRequests.length > 0 ? recentRequests.map((r: any) => (
                            <div key={r.id} className="flex items-center gap-3 py-2 border-b border-line-soft last:border-0">
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-ink truncate">{r.inventoryItem?.name || r.serialNo}</p>
                                    <p className="text-[10px] text-faint">{r.createdBy?.name} · {r.department?.name} · {r.serialNo}</p>
                                </div>
                                <PendingCell status={r.status} reason={statusReasonForRequest(r)} />
                                <span className="text-[10px] text-faint shrink-0">{fmtTime(r.createdAt)}</span>
                            </div>
                        )) : <p className="text-sm text-faint text-center py-6">No requests yet</p>}
                    </div>
                </div>
            </div>

            {/* Request Modal */}
            <Modal isOpen={showRequestModal} onClose={() => setShowRequestModal(false)} title="Request Component">
                <RequestForm availableItems={inventoryItems} optionsTruncated={optionsTruncated} optionsTotal={optionsTotal} onSubmit={handleCreateRequest} isLoading={isSubmitting} />
            </Modal>

            {/* Indent Modal */}
            <Modal isOpen={showIndentModal} onClose={() => setShowIndentModal(false)} title="Raise Indent" size="xl">
                <IndentForm onSubmit={handleCreateIndent} isLoading={isSubmitting} />
            </Modal>
        </div>
    );
};
