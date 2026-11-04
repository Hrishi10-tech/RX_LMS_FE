import { ApprovalCell } from '@/features/indents/components/IndentDetailsModal';
import { ceoLaneVisible, isCeoApprovalRequired, ceoNotApplicableLabel, ceoNotApplicableTitle } from '@/config/thresholds';

interface CeoApprovalCellProps {
    row: any;
    // Only SUPER_ADMIN (the CEO) acts in this lane — everyone else sees the
    // read-only ApprovalCell.
    isSuperAdmin: boolean;
    // History rows are terminal + read-only, so historyMode changes two things
    // vs. the live table to reproduce the original historyColumns cell exactly:
    //   1) the "show the CEO lane" gate uses ceoLaneVisible(row) on the settled indent
    //      (and the N/A label is a bare "N/A"), instead of the live table's
    //      firm-quote-total threshold check (whose N/A names the Settings threshold);
    //   2) the pending-interactive branches (the "Awaiting re-quote" mask and
    //      the Review-quote / Approve / Reject buttons) are skipped.
    historyMode?: boolean;
    // setReviewIndent(row) — opens the read-only/quote-review modal.
    onReviewIndent: (row: any) => void;
    // handleCeoApprove(id, decision) — APPROVED to approve, PENDING to revoke.
    onCeoApprove: (id: string, decision: 'APPROVED' | 'PENDING') => void;
    // setRejectTarget({ kind: 'ceo', id, serialNo }) — opens the rejection modal.
    onRejectCeo: (row: any) => void;
}

export const CeoApprovalCell = ({
    row,
    isSuperAdmin,
    historyMode = false,
    onReviewIndent,
    onCeoApprove,
    onRejectCeo,
}: CeoApprovalCellProps) => {
    if (historyMode) {
        if (!ceoLaneVisible(row)) return <span className="text-[10px] text-faint">N/A</span>;
    } else {
        // Use firm-quote total when available — the indent.grandTotal
        // mirrors but we belt-and-suspender here so the CEO threshold
        // gate reads the right number.
        const activeQuotation = (row.quotations || []).find((q: any) => q.status === 'DRAFT' || q.status === 'SUBMITTED');
        const effectiveTotal = activeQuotation ? Number(activeQuotation.grandTotal || 0) : Number(row.grandTotal || 0);
        // ceoLaneVisible's amount test, applied to the firm-quote total. NOT
        // needsCeoSignoff: while CEO approval is optional nothing waits on the
        // CEO, but they keep the right to review, approve or reject high-value
        // spend — gating these buttons on "does it block?" would remove that.
        const showLane = ceoLaneVisible({ grandTotal: effectiveTotal, currency: row.currency });
        if (!showLane) return <span className="text-[10px] text-faint" title={ceoNotApplicableTitle()}>{ceoNotApplicableLabel()}</span>;
        // Universal mask: if CEO status is PENDING but the indent itself
        // isn't in PENDING state, CEO can't act right now (the indent is
        // back with procurement / finance / etc). Shown for ALL viewers —
        // was previously only super-admin, leaving admins staring at a
        // misleading "PENDING" pill.
        //
        // The wording splits on policy. "Awaiting re-quote" promises the CEO
        // will be asked later, which is only true while their sign-off is
        // required. With it optional, a moved-on indent was never waiting on
        // the CEO at all — saying "awaiting" anything would be the same
        // misleading pill this mask exists to prevent.
        if (row.ceoApprovalStatus === 'PENDING' && row.status !== 'PENDING') {
            const readableStatus = row.status.replace(/_/g, ' ').toLowerCase();
            return isCeoApprovalRequired() ? (
                <span className="text-[10px] text-faint italic" title={`Indent is in ${readableStatus} — CEO will be asked once procurement re-submits the firm quote.`}>
                    Awaiting re-quote
                </span>
            ) : (
                <span className="text-[10px] text-faint italic" title={`Indent is in ${readableStatus}. CEO sign-off isn't required — technical approval carried it forward.`}>
                    Not required
                </span>
            );
        }
    }
    if (isSuperAdmin) {
        if (!historyMode && row.ceoApprovalStatus === 'PENDING') {
            const hasQuotation = !!(row.quotations || []).find((q: any) => q.status === 'DRAFT' || q.status === 'SUBMITTED');
            if (hasQuotation) {
                return (
                    <button onClick={() => onReviewIndent(row)}
                        className="px-3 py-1 text-xs font-bold bg-amber-700 text-white rounded hover:bg-amber-800 transition-colors shadow-sm whitespace-nowrap">
                        Review quote →
                    </button>
                );
            }
            return (
                <div className="flex gap-1">
                    <button onClick={() => onCeoApprove(row.id, 'APPROVED')} className="px-2 py-1 text-xs font-bold bg-green-700 text-white rounded hover:bg-green-800 transition-colors shadow-sm">Approve</button>
                    <button onClick={() => onRejectCeo(row)} className="px-2 py-1 text-xs font-bold bg-red-600 text-white rounded hover:bg-red-700 transition-colors shadow-sm">Reject</button>
                </div>
            );
        }
        const canRevoke = ['PENDING', 'APPROVED', 'QUOTATION_IN_PROGRESS', 'AWAITING_PAYMENT'].includes(row.status) && row.ceoApprovalStatus === 'APPROVED';
        return (
            <div className="flex flex-col items-start gap-1">
                <ApprovalCell status={row.ceoApprovalStatus} timestamp={row.ceoApprovedAt} approverName={row.ceoApprovedBy?.name} />
                {canRevoke && (
                    <button onClick={() => onCeoApprove(row.id, 'PENDING')} className="text-[10px] bg-orange-100 dark:bg-orange-400/20 text-orange-700 dark:text-orange-300 px-2 py-0.5 rounded font-bold hover:bg-orange-200 transition-colors shadow-sm">Revoke Approval</button>
                )}
            </div>
        );
    }
    return <ApprovalCell status={row.ceoApprovalStatus} timestamp={row.ceoApprovedAt} approverName={row.ceoApprovedBy?.name} />;
};
