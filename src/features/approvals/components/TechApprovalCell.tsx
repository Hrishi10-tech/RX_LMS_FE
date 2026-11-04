import { ApprovalCell } from '@/features/indents/components/IndentDetailsModal';

interface TechApprovalCellProps {
    row: any;
    // Only department ADMINs act in the tech lane — everyone else sees the
    // read-only ApprovalCell.
    canTechApprove: boolean;
    // History rows are terminal + read-only: the pending-interactive branches
    // (the "Awaiting re-quote" mask and the Review-quote / Approve / Reject
    // buttons) never apply there, so historyMode short-circuits straight to the
    // ApprovalCell + optional Revoke display. This reproduces the original
    // historyColumns cell exactly while sharing one component with the live table.
    historyMode?: boolean;
    // setReviewIndent(row) — opens the read-only/quote-review modal.
    onReviewIndent: (row: any) => void;
    // handleTechApprove(id, decision) — APPROVED to approve, PENDING to revoke.
    onTechApprove: (id: string, decision: 'APPROVED' | 'PENDING') => void;
    // setRejectTarget({ kind: 'tech', id, serialNo }) — opens the rejection modal.
    onRejectTech: (row: any) => void;
}

export const TechApprovalCell = ({
    row,
    canTechApprove,
    historyMode = false,
    onReviewIndent,
    onTechApprove,
    onRejectTech,
}: TechApprovalCellProps) => {
    // If procurement has submitted a quotation, the approver MUST see
    // the firm quote first — replace inline buttons with a "Review
    // quote" CTA. Actual Approve/Reject lives inside the modal.
    const hasQuotation = (row.quotations || []).some((q: any) => q.status === 'DRAFT' || q.status === 'SUBMITTED');
    // Universal mask: tech PENDING + indent not in PENDING means the
    // indent isn't in an approver's stage — show "Awaiting re-quote"
    // for everyone so we don't lie about who the bottleneck is.
    if (!historyMode && row.techApprovalStatus === 'PENDING' && row.status !== 'PENDING') {
        return (
            <span className="text-[10px] text-faint italic" title={`Indent is in ${row.status.replace(/_/g, ' ').toLowerCase()} — tech will be asked once procurement re-submits the firm quote.`}>
                Awaiting re-quote
            </span>
        );
    }
    if (canTechApprove) {
        if (!historyMode && row.techApprovalStatus === 'PENDING') {
            if (hasQuotation) {
                return (
                    <button onClick={() => onReviewIndent(row)}
                        className="px-3 py-1 text-xs font-bold bg-amber-700 text-white rounded hover:bg-amber-800 transition-colors shadow-sm whitespace-nowrap">
                        Review quote →
                    </button>
                );
            }
            // Set by the server, from the same check the tech-approve endpoint
            // runs: non-null means approving right now would be refused —
            // in practice, a department that REQUIRES the manager to sign
            // first, where the manager has not. The button used to stay live
            // and answer the click with a red error; it is disabled instead,
            // with the reason on screen. Reject stays available on purpose —
            // turning an indent down does not need the manager's say-so.
            const blocked: string | null = row.techApproveBlockedReason ?? null;
            return (
                <div className="flex flex-col items-start gap-0.5">
                    <div className="flex gap-1">
                        <button
                            onClick={() => onTechApprove(row.id, 'APPROVED')}
                            disabled={!!blocked}
                            title={blocked ?? undefined}
                            className="px-2 py-1 text-xs font-bold bg-green-700 text-white rounded hover:bg-green-800 transition-colors disabled:bg-line disabled:text-faint disabled:cursor-not-allowed"
                        >
                            Approve
                        </button>
                        <button onClick={() => onRejectTech(row)} className="px-2 py-1 text-xs font-bold bg-red-600 text-white rounded hover:bg-red-700 transition-colors">Reject</button>
                    </div>
                    {blocked && (
                        <span className="text-[10px] italic text-amber-700 dark:text-amber-300" title={blocked}>
                            Waiting for manager
                        </span>
                    )}
                </div>
            );
        }
        const canRevoke = ['PENDING', 'APPROVED', 'QUOTATION_IN_PROGRESS', 'AWAITING_PAYMENT'].includes(row.status) && row.techApprovalStatus === 'APPROVED';
        return (
            <div className="flex flex-col items-start gap-1">
                <ApprovalCell status={row.techApprovalStatus} timestamp={row.techApprovedAt} approverName={row.techApprovedBy?.name} />
                {canRevoke && (
                    <button onClick={() => onTechApprove(row.id, 'PENDING')} className="text-[10px] bg-orange-100 dark:bg-orange-400/20 text-orange-700 dark:text-orange-300 px-2 py-0.5 rounded font-bold hover:bg-orange-200 transition-colors shadow-sm">Revoke Approval</button>
                )}
            </div>
        );
    }
    return <ApprovalCell status={row.techApprovalStatus} timestamp={row.techApprovedAt} approverName={row.techApprovedBy?.name} />;
};
