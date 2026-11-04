// Finalise review modal — fires at Finalise time when any item is
// short-allocated (procurement buying less) OR over-allocated (procurement
// buying more to fill general stock). One modal handles both:
//   - Short rows need a reason
//   - Over rows need a split decision (how much for the requester vs
//     general stock)
// userAssignments is keyed by indentItemId → "for user" qty.
import type { Dispatch, SetStateAction } from 'react';
import { Modal } from '@/components/ui/Modal';

interface Props {
    reviewModal: { shortfalls: any[]; overages: any[] } | null;
    reviewReason: string;
    setReviewReason: Dispatch<SetStateAction<string>>;
    userAssignments: Record<string, number>;
    setUserAssignments: Dispatch<SetStateAction<Record<string, number>>>;
    finalisingPartial: boolean;
    setFinalisingPartial: Dispatch<SetStateAction<boolean>>;
    selectedIndent: any;
    onUpdateStatus: (id: string, type: 'status', val: any, extras?: Record<string, any>) => Promise<boolean>;
    onClose: () => void;
    onFinalised: () => void;
}

export const FinaliseReviewModal = ({
    reviewModal,
    reviewReason,
    setReviewReason,
    userAssignments,
    setUserAssignments,
    finalisingPartial,
    setFinalisingPartial,
    selectedIndent,
    onUpdateStatus,
    onClose,
    onFinalised,
}: Props) => {
    return (
            <Modal isOpen={!!reviewModal} onClose={onClose} title="Finalise review — quantity mismatch">
                {reviewModal && (() => {
                    const needsReason = reviewModal.shortfalls.length > 0;
                    const reasonReady = !needsReason || reviewReason.trim().length > 0;
                    return (
                        <div className="space-y-4">
                            {needsReason && (
                                <div className="bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-md p-3 text-xs text-amber-900 dark:text-amber-200">
                                    Some items are being purchased in <span className="font-bold">smaller</span> quantity than requested. Tell the requester why.
                                </div>
                            )}
                            {reviewModal.overages.length > 0 && (
                                <div className="bg-blue-50 dark:bg-blue-400/15 border border-blue-200 dark:border-blue-400/30 rounded-md p-3 text-xs text-blue-900 dark:text-blue-200">
                                    Some items are being purchased in a <span className="font-bold">larger</span> quantity than requested (stock-up). Decide how much of each to reserve for the requester — the rest goes to general inventory.
                                </div>
                            )}

                            {/* Shortfall rows — read-only summary */}
                            {reviewModal.shortfalls.length > 0 && (
                                <div className="space-y-1.5">
                                    <p className="text-[11px] font-bold text-amber-900 dark:text-amber-200 uppercase tracking-wider">Buying less than requested</p>
                                    {reviewModal.shortfalls.map((s: any) => (
                                        <div key={s.itemId} className="border border-line rounded p-2 bg-surface">
                                            <p className="text-sm font-bold text-ink">{s.name}</p>
                                            <p className="text-[11px] text-muted">Requested: <span className="font-mono">{s.requested}</span> {s.unit || ''} · Buying: <span className="font-mono font-bold text-amber-700 dark:text-amber-300">{s.allocated}</span> {s.unit || ''} · Short by <span className="font-mono">{s.short}</span></p>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Overage rows — split decision per item */}
                            {reviewModal.overages.length > 0 && (
                                <div className="space-y-1.5">
                                    <p className="text-[11px] font-bold text-blue-900 dark:text-blue-200 uppercase tracking-wider">Buying more than requested (stock-up)</p>
                                    {reviewModal.overages.map((o: any) => {
                                        const assigned = userAssignments[o.itemId] ?? o.requested;
                                        const allForUser = assigned >= o.allocated;
                                        const requestedOnly = assigned === o.requested;
                                        return (
                                            <div key={o.itemId} className="border border-line rounded p-2 bg-surface">
                                                <p className="text-sm font-bold text-ink">{o.name}</p>
                                                <p className="text-[11px] text-muted">Requested: <span className="font-mono">{o.requested}</span> {o.unit || ''} · Buying: <span className="font-mono font-bold text-blue-700 dark:text-blue-300">{o.allocated}</span> {o.unit || ''} · Over by <span className="font-mono">{o.over}</span></p>
                                                <div className="mt-2 space-y-1">
                                                    <label className="flex items-start gap-2 cursor-pointer text-[11px]">
                                                        <input type="radio" className="mt-0.5" checked={requestedOnly}
                                                            onChange={() => setUserAssignments(prev => ({ ...prev, [o.itemId]: o.requested }))} />
                                                        <span className="text-ink">
                                                            <span className="font-bold">{o.requested}</span> {o.unit || ''} for requester · <span className="text-muted">{o.over} {o.unit || ''} to general stock</span>
                                                        </span>
                                                    </label>
                                                    <label className="flex items-start gap-2 cursor-pointer text-[11px]">
                                                        <input type="radio" className="mt-0.5" checked={allForUser}
                                                            onChange={() => setUserAssignments(prev => ({ ...prev, [o.itemId]: o.allocated }))} />
                                                        <span className="text-ink">
                                                            All <span className="font-bold">{o.allocated}</span> {o.unit || ''} for requester · <span className="text-muted">nothing to general stock</span>
                                                        </span>
                                                    </label>
                                                    <label className="flex items-center gap-2 cursor-pointer text-[11px]">
                                                        <input type="radio" className="mt-0.5" checked={!requestedOnly && !allForUser}
                                                            onChange={() => setUserAssignments(prev => ({ ...prev, [o.itemId]: Math.min(o.allocated, o.requested + Math.floor(o.over / 2)) }))} />
                                                        <span className="text-ink">Custom:
                                                            <input type="number" min={0} max={o.allocated} value={assigned}
                                                                onChange={e => setUserAssignments(prev => ({ ...prev, [o.itemId]: Math.max(0, Math.min(o.allocated, Number(e.target.value) || 0)) }))}
                                                                className="mx-1 w-16 px-1 py-0.5 border rounded text-xs" />
                                                            {o.unit || ''} for requester · <span className="text-muted">{Math.max(0, o.allocated - assigned)} {o.unit || ''} to general stock</span>
                                                        </span>
                                                    </label>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}

                            {needsReason && (
                                <div>
                                    <label className="block text-xs font-bold text-muted mb-1">Reason for short purchase *</label>
                                    <textarea value={reviewReason} onChange={e => setReviewReason(e.target.value)} rows={3}
                                        placeholder="e.g. Vendor stock limited to 4 units; backordered remainder will be on a follow-up indent."
                                        className="w-full text-sm px-3 py-2 border rounded focus:border-brand outline-none" />
                                </div>
                            )}

                            <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
                                <button onClick={onClose} disabled={finalisingPartial}
                                    className="px-3 py-1.5 text-xs font-bold text-muted border border-line rounded hover:bg-surface">
                                    Cancel
                                </button>
                                <button
                                    disabled={!reasonReady || finalisingPartial}
                                    onClick={async () => {
                                        setFinalisingPartial(true);
                                        const userAssignmentsPayload = reviewModal.overages.map((o: any) => ({
                                            indentItemId: o.itemId,
                                            assignedToUserQty: userAssignments[o.itemId] ?? o.requested,
                                        }));
                                        await onUpdateStatus(selectedIndent?.id, 'status', 'AWAITING_PAYMENT', {
                                            ...(needsReason ? { partialPurchaseReason: reviewReason.trim() } : {}),
                                            ...(userAssignmentsPayload.length > 0 ? { userAssignments: userAssignmentsPayload } : {}),
                                        });
                                        setFinalisingPartial(false);
                                        onClose();
                                        onFinalised();
                                    }}
                                    className="px-4 py-1.5 text-xs font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50 disabled:cursor-not-allowed">
                                    {finalisingPartial ? 'Finalising…' : 'Finalise + notify requester'}
                                </button>
                            </div>
                        </div>
                    );
                })()}
            </Modal>
    );
};
