import { useEffect, useMemo, useState } from 'react';
import { client } from '@/api';
import { Modal } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { ArrowRight } from 'lucide-react';

interface AssetTransferModalProps {
    asset: any;
    users: any[];
    onClose: () => void;
    onSuccess: () => void;
}

// Dedicated transfer flow. Adding a modal instead of just having an inline
// custodian dropdown makes the action deliberate — transferring a $5k
// oscilloscope shouldn't be a one-click slip. The reason field is required
// server-side so the audit trail carries context.
export const AssetTransferModal = ({ asset, users, onClose, onSuccess }: AssetTransferModalProps) => {
    const { addToast } = useToast();
    const [newCustodianId, setNewCustodianId] = useState('');
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);

    useEffect(() => {
        // Reset form when the modal is reopened with a different asset.
        setNewCustodianId('');
        setReason('');
    }, [asset?.id]);

    // Hide the current custodian from the picker — selecting them would be
    // rejected server-side anyway, and showing them just confuses the UX.
    const eligibleUsers = useMemo(
        () => (users || []).filter((u: any) => u.id !== asset?.custodianId),
        [users, asset?.custodianId],
    );

    const handleSubmit = async () => {
        if (!newCustodianId) {
            addToast('Pick a new custodian', 'error');
            return;
        }
        if (!reason.trim()) {
            addToast('A reason is required for the audit trail', 'error');
            return;
        }
        setSubmitting(true);
        try {
            await client.post(`/fixed-assets/${asset.id}/transfer`, {
                newCustodianId,
                reason: reason.trim(),
            });
            addToast('Asset transferred', 'success');
            onSuccess();
            onClose();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to transfer asset'), 'error');
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Modal isOpen={!!asset} onClose={onClose} title={`Transfer Custodian — ${asset?.assetTag || ''}`}>
            {asset && (
                <div className="space-y-4">
                    <div className="bg-surface border border-line-soft rounded-lg p-3 text-xs">
                        <p className="text-faint mb-1">Asset</p>
                        <p className="font-bold text-ink">{asset.name}</p>
                        <div className="flex items-center gap-2 mt-2 text-muted">
                            <span className="font-medium">{asset.custodian?.name || 'Unassigned'}</span>
                            <ArrowRight size={12} />
                            <span className="font-medium text-brand">
                                {newCustodianId
                                    ? users.find((u: any) => u.id === newCustodianId)?.name || 'New custodian'
                                    : 'Select new custodian…'}
                            </span>
                        </div>
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-ink mb-1">New Custodian</label>
                        <select
                            value={newCustodianId}
                            onChange={(e) => setNewCustodianId(e.target.value)}
                            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none"
                        >
                            <option value="">— Select user —</option>
                            {eligibleUsers.map((u: any) => (
                                <option key={u.id} value={u.id}>
                                    {u.name} ({u.role})
                                </option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-ink mb-1">Reason</label>
                        <textarea
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                            rows={3}
                            placeholder="e.g. Lab handover to new owner, project closeout, departing employee…"
                            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none resize-none"
                        />
                        <p className="text-[10px] text-faint mt-1">
                            Required — appears in the asset's history. Both the current and new custodian will be notified.
                        </p>
                    </div>

                    <div className="flex justify-end gap-3 pt-2 border-t border-line-soft">
                        <button
                            onClick={onClose}
                            className="text-sm font-bold text-muted px-4 py-2 rounded-lg hover:bg-surface transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSubmit}
                            disabled={submitting || !newCustodianId || !reason.trim()}
                            className="text-sm font-bold bg-brand text-white px-5 py-2 rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50"
                        >
                            {submitting ? 'Transferring…' : 'Confirm Transfer'}
                        </button>
                    </div>
                </div>
            )}
        </Modal>
    );
};
