import { Pagination } from '@/components/ui';
import { useClientPagination } from '@/hooks';
import { fmtDateTime } from '@/utils/date';

/**
 * Compact card list for one BOM approval queue stage. Renders the
 * essentials per row (serial, name, creator, project, dept, line count)
 * and defers full content to the slip modal opened on click.
 *
 * Shared between the personal Approvals page (ADMIN/SUPER_ADMIN BOM lanes)
 * and the Team Approvals page (MANAGER's direct-report BOM queue), so the
 * row layout never drifts between the two surfaces.
 */
export const BomQueueSection = ({ label, stageTone, items, onOpen, cta }: {
    label: string;
    stageTone: string;
    items: any[];
    onOpen: (id: string) => void;
    // Per-row CTA. Defaults to the active "Review & decide →" pill. A lane
    // whose BOMs are already decided for this viewer (e.g. an admin who has
    // tech-approved an indent that's now only awaiting CEO) passes a muted
    // "View approved BOM →" so the button stops implying a pending decision.
    cta?: (item: any) => { label: string; muted?: boolean };
}) => {
    const bomPager = useClientPagination<any>(items, 10);
    if (items.length === 0) return null;
    return (
        <div className="border-t border-line-soft first:border-t-0">
            <div className={`px-6 py-2 flex items-center gap-2 border-b border-line-soft ${stageTone.includes('amber') ? 'bg-amber-50/40 dark:bg-amber-400/15' : stageTone.includes('sky') ? 'bg-sky-50/40 dark:bg-sky-400/15' : 'bg-violet-50/40 dark:bg-violet-400/15'}`}>
                <span className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${stageTone}`}>
                    {label}
                </span>
                <span className="text-[10px] text-muted font-bold">
                    {items.length} BOM{items.length === 1 ? '' : 's'}
                </span>
            </div>
            <div className="divide-y divide-line-soft overflow-y-auto" style={{ maxHeight: '30vh' }}>
                {bomPager.pageRows.map((b: any) => {
                    const itemCount = (b._count?.items ?? b.items?.length ?? 0) + (b._count?.customItems ?? b.customItems?.length ?? 0);
                    const action = cta?.(b) ?? { label: 'Review & decide →' };
                    return (
                        <button
                            key={b.id}
                            type="button"
                            onClick={() => onOpen(b.id)}
                            className="w-full text-left px-6 py-3 flex items-center gap-4 hover:bg-surface transition-colors"
                        >
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className="font-mono text-[10px] font-bold text-faint">{b.serialNo}</span>
                                    <span className="text-base font-bold text-ink truncate">{b.name}</span>
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-surface text-secondary border-line font-bold text-[10px]">
                                        {itemCount} line{itemCount === 1 ? '' : 's'}
                                    </span>
                                </div>
                                <p className="text-[11px] text-muted mt-0.5 truncate">
                                    <span className="font-bold">{b.createdBy?.name || 'Unknown'}</span>
                                    {b.project?.name && <> · {b.project.name}</>}
                                    {b.department?.name && <> · {b.department.name}</>}
                                    {b.submittedAt && <span className="text-faint"> · submitted {fmtDateTime(b.submittedAt)}</span>}
                                </p>
                            </div>
                            <div className="shrink-0 text-right">
                                <span className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-bold transition-colors ${
                                    action.muted
                                        ? 'bg-hover text-muted border border-line hover:bg-line'
                                        : 'bg-brand text-white hover:bg-brand-dark shadow-sm'
                                }`}>
                                    {action.label}
                                </span>
                            </div>
                        </button>
                    );
                })}
            </div>
            <Pagination currentPage={bomPager.page} totalPages={bomPager.totalPages} onPageChange={bomPager.setPage} />
        </div>
    );
};
