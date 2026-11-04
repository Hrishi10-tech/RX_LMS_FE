import { Pagination } from '@/components/ui';
import { useClientPagination } from '@/hooks';
import { fmtDateTime } from '@/utils/date';

/**
 * Read-only list of decided BOMs — the audit counterpart of the live BOM
 * queue. Each row opens the BOM (its read-only slip on the approver pages, or
 * the editor on the creator's BOM Lists page) via `onOpen`; both carry the
 * full per-version Timeline. Mirrors how the Indent / Component Request
 * History modals let you drill into a settled item.
 *
 * Lives in `bom-lists` (not `approvals`) so every consumer — the approver
 * console AND the creator-facing BOM Lists page — imports it from one place,
 * keeping the feature dependency one-directional (approvals → bom-lists).
 */
const STATUS_TONE: Record<string, string> = {
    ROUTED: 'bg-sky-50 dark:bg-sky-400/15 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-400/30',
    COMPLETED: 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30',
    REJECTED: 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30',
    MANAGER_APPROVED: 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30',
};

const STATUS_LABEL: Record<string, string> = {
    ROUTED: 'Approved',
    COMPLETED: 'Completed',
    REJECTED: 'Rejected',
    MANAGER_APPROVED: 'Approved',
};

export const BomHistorySection = ({ items, onOpen }: {
    items: any[];
    onOpen: (id: string) => void;
}) => {
    const pager = useClientPagination<any>(items, 10);
    if (items.length === 0) {
        return (
            <div className="text-center text-faint py-8 text-sm italic">
                No decided BOMs yet.
            </div>
        );
    }
    return (
        <div>
            <div className="divide-y divide-line-soft max-h-[60vh] overflow-y-auto">
                {pager.pageRows.map((b: any) => {
                    const itemCount = (b._count?.items ?? b.items?.length ?? 0) + (b._count?.customItems ?? b.customItems?.length ?? 0);
                    // Decision metadata varies by outcome — show the most
                    // relevant timestamp + actor for each terminal state.
                    const decidedAt = b.status === 'REJECTED' ? b.rejectedAt
                        : b.status === 'COMPLETED' ? (b.receivedAt || b.routedAt || b.managerApprovedAt)
                        : b.status === 'ROUTED' ? (b.routedAt || b.managerApprovedAt)
                        : b.managerApprovedAt;
                    // No completedBy is captured on the row (the fulfilment hook
                    // stamps only receivedAt) — so a COMPLETED row shows the
                    // timestamp without an actor. REJECTED/other keep their actor.
                    const decidedBy = b.status === 'REJECTED' ? b.rejectedBy?.name
                        : b.status === 'COMPLETED' ? undefined
                        : b.managerApprovedBy?.name;
                    const decidedVerb = b.status === 'REJECTED' ? 'rejected'
                        : b.status === 'COMPLETED' ? 'completed'
                        : 'decided';
                    return (
                        <button
                            key={b.id}
                            type="button"
                            onClick={() => onOpen(b.id)}
                            className="w-full text-left px-4 py-3 flex items-center gap-4 hover:bg-surface transition-colors"
                        >
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-mono text-[10px] font-bold text-faint">{b.serialNo}</span>
                                    <span className="text-sm font-bold text-ink truncate">{b.name}</span>
                                    {b.version > 1 && (
                                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-400/30">
                                            v{b.version}
                                        </span>
                                    )}
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${STATUS_TONE[b.status] || 'bg-surface text-secondary border-line'}`}>
                                        {STATUS_LABEL[b.status] || b.status}
                                    </span>
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-surface text-secondary border-line font-bold text-[10px]">
                                        {itemCount} line{itemCount === 1 ? '' : 's'}
                                    </span>
                                </div>
                                <p className="text-[11px] text-muted mt-0.5 truncate">
                                    <span className="font-bold">{b.createdBy?.name || 'Unknown'}</span>
                                    {b.project?.name && <> · {b.project.name}</>}
                                    {b.department?.name && <> · {b.department.name}</>}
                                    {decidedAt && (
                                        <span className="text-faint">
                                            {' · '}{decidedVerb} {fmtDateTime(decidedAt)}
                                            {decidedBy && <> by <span className="font-bold">{decidedBy}</span></>}
                                        </span>
                                    )}
                                    {b.rejectionReason && <> · <span className="italic text-red-700 dark:text-red-300">"{b.rejectionReason}"</span></>}
                                </p>
                            </div>
                            <span className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-hover text-ink text-xs font-bold hover:bg-line transition-colors">
                                View →
                            </span>
                        </button>
                    );
                })}
            </div>
            <Pagination currentPage={pager.page} totalPages={pager.totalPages} onPageChange={pager.setPage} />
        </div>
    );
};
