import { useState } from 'react';
import { Modal } from '@/components/ui';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

interface DispositionModalProps {
    isOpen: boolean;
    onClose: () => void;
    /** Single-item mode: the request being dispositioned. */
    request?: any;
    /**
     * Bulk mode: when a non-empty array is passed, the modal applies the SAME
     * disposition + note to every id via POST /requests/bulk-disposition and
     * reports a succeeded/failed summary. Takes precedence over `request`.
     * Leaving this undefined keeps the original single-item behaviour
     * byte-for-byte, so existing call sites are unaffected.
     */
    requestIds?: string[];
    onSuccess: () => void;
}

// Disposition = "the item is NOT coming back to stock". If you want to give
// the item back damaged so inventory can decide what to do, use the Returns
// page with condition=Damaged instead — that puts the item back as damaged
// stock. The DAMAGED option here means "I'm scrapping it on my end."
const DISPOSITION_OPTIONS = [
    { value: 'EMBEDDED', label: 'Embedded', description: 'Permanently installed in a product or project', accent: 'purple', border: 'border-purple-400', bg: 'bg-purple-50 dark:bg-purple-400/15', text: 'text-purple-700 dark:text-purple-300', ring: 'ring-purple-300' },
    { value: 'CONSUMED', label: 'Consumed', description: 'Used up — soldered, mixed, or worn out', accent: 'amber', border: 'border-amber-400', bg: 'bg-amber-50 dark:bg-amber-400/15', text: 'text-amber-700 dark:text-amber-300', ring: 'ring-amber-300' },
    { value: 'DAMAGED', label: 'Damaged / Scrapped', description: 'Broken on my end — scrapping it (won’t go back to stock)', accent: 'red', border: 'border-red-400', bg: 'bg-red-50 dark:bg-red-400/15', text: 'text-red-700 dark:text-red-300', ring: 'ring-red-300' },
    { value: 'LONG_TERM_LOAN', label: 'Long-Term Loan', description: 'Keeping indefinitely, no return planned', accent: 'blue', border: 'border-blue-400', bg: 'bg-blue-50 dark:bg-blue-400/15', text: 'text-blue-700 dark:text-blue-300', ring: 'ring-blue-300' },
];

export const DispositionModal = ({ isOpen, onClose, request, requestIds, onSuccess }: DispositionModalProps) => {
    const { addToast } = useToast();
    const [disposition, setDisposition] = useState<string>('');
    const [notes, setNotes] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    const isBulk = Array.isArray(requestIds) && requestIds.length > 0;
    const bulkCount = requestIds?.length ?? 0;

    const handleClose = () => {
        setDisposition('');
        setNotes('');
        onClose();
    };

    const handleSubmit = async () => {
        if (!disposition) return;
        if (!isBulk && !request) return;
        setIsSubmitting(true);
        try {
            if (isBulk) {
                const res = await client.post('/requests/bulk-disposition', {
                    ids: requestIds,
                    disposition,
                    notes: notes || undefined,
                });
                // Envelope is { message, data: { succeeded, failed } } (TransformInterceptor).
                const summary = res.data?.data ?? res.data ?? {};
                const ok = summary.succeeded?.length ?? 0;
                const fail = summary.failed?.length ?? 0;
                if (fail === 0) {
                    addToast(`Disposition recorded for ${ok} item${ok === 1 ? '' : 's'}.`, 'success');
                } else if (ok === 0) {
                    addToast(`Couldn't disposition any item. ${summary.failed?.[0]?.reason || ''}`.trim(), 'error');
                } else {
                    addToast(`Dispositioned ${ok} item${ok === 1 ? '' : 's'}; ${fail} skipped (${summary.failed?.[0]?.reason || 'not eligible'}).`, 'warning');
                }
            } else {
                await client.patch(`/requests/${request.id}/disposition`, { disposition, notes: notes || undefined });
                addToast('Disposition recorded successfully.', 'success');
            }
            handleClose();
            onSuccess();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to record disposition'), 'error');
        }
        setIsSubmitting(false);
    };

    return (
        <Modal isOpen={isOpen} onClose={handleClose} title={isBulk ? `Mark Disposition (${bulkCount} item${bulkCount === 1 ? '' : 's'})` : 'Mark Disposition'}>
            <div className="space-y-5">
                {isBulk && (
                    <div className="bg-surface rounded-lg p-4 border border-line-soft">
                        <p className="text-sm font-bold text-ink">{bulkCount} item{bulkCount === 1 ? '' : 's'} selected</p>
                        <p className="text-xs text-muted mt-1">
                            The same disposition + note is applied to each. Items that can’t be dispositioned (already returned, not yours) are skipped and reported.
                        </p>
                    </div>
                )}
                {!isBulk && request && (() => {
                    // Show what was *actually* issued. The requested number is for
                    // reference only and is dimmed when it differs — inventory may
                    // have edited the slip before marking issued, and that edit is
                    // what the user physically received, so disposition is recorded
                    // against the issued qty.
                    const issuedQty = request.qtyIssued ?? request.qtyRequested ?? 0;
                    const diverged = request.qtyIssued != null && Number(request.qtyIssued) !== Number(request.qtyRequested);
                    return (
                        <div className="bg-surface rounded-lg p-4 border border-line-soft">
                            <p className="text-sm font-bold text-ink">{request.inventoryItem?.name}</p>
                            <p className="text-xs text-muted mt-1">
                                {request.serialNo} &middot; Issued Qty: <span className="font-bold text-ink">{issuedQty}</span>
                                {diverged && (
                                    <span className="ml-1 text-[10px] text-amber-700 dark:text-amber-300" title={`Original request was for ${request.qtyRequested}`}>
                                        (req {request.qtyRequested})
                                    </span>
                                )}
                                {' '}&middot; {request.project?.name || 'General / Others'}
                            </p>
                            {request.issuedToName && (
                                <p className="text-[11px] text-faint mt-0.5">
                                    Issued to {request.issuedToName}
                                </p>
                            )}
                        </div>
                    );
                })()}

                <div>
                    <label className="block text-sm font-bold text-ink mb-2">Disposition Type</label>
                    <div className="grid grid-cols-2 gap-2">
                        {DISPOSITION_OPTIONS.map(opt => (
                            <button
                                key={opt.value}
                                type="button"
                                onClick={() => setDisposition(opt.value)}
                                className={`text-left px-3 py-2.5 rounded-lg border-2 transition-all ${
                                    disposition === opt.value
                                        ? `${opt.border} ${opt.bg} ring-2 ${opt.ring}`
                                        : 'border-line bg-card hover:border-line'
                                }`}
                            >
                                <p className={`text-xs font-bold ${disposition === opt.value ? opt.text : 'text-ink'}`}>
                                    {opt.label}
                                </p>
                                <p className="text-[11px] text-muted mt-0.5">{opt.description}</p>
                            </button>
                        ))}
                    </div>
                </div>

                <div>
                    <label className="block text-sm font-bold text-ink mb-2">
                        Notes <span className="font-normal text-faint">(optional)</span>
                    </label>
                    <textarea
                        value={notes}
                        onChange={e => setNotes(e.target.value)}
                        rows={3}
                        placeholder="e.g. Soldered onto PCB for Project Alpha..."
                        className="w-full border border-line rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand/30 focus:border-brand resize-none"
                    />
                </div>

                <div className="bg-red-50 dark:bg-red-400/15 border border-red-100 dark:border-red-400/25 rounded-lg p-3">
                    <p className="text-xs text-red-700 dark:text-red-300">
                        <span className="font-bold">Heads up:</span> This is for items that are NOT coming back to stock.
                        If you’re physically returning the item (even damaged), use the <span className="font-bold">Returns</span> page instead.
                    </p>
                </div>

                <div className="flex justify-end gap-3 pt-2">
                    <button
                        onClick={handleClose}
                        className="text-sm font-bold text-muted px-4 py-2 rounded-lg hover:bg-surface transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={handleSubmit}
                        disabled={!disposition || isSubmitting}
                        className="text-sm font-bold bg-brand text-white px-5 py-2 rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50"
                    >
                        {isSubmitting ? 'Submitting...' : 'Confirm Disposition'}
                    </button>
                </div>
            </div>
        </Modal>
    );
};
