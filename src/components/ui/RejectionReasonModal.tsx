import { useEffect, useState } from 'react';
import { Modal } from './Modal';

interface RejectionReasonModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Called with the trimmed reason text once the approver confirms. The caller is
   * responsible for firing the API call and closing the modal on success/failure.
   * The component will re-disable its Submit button while `submitting` is true.
   */
  onSubmit: (reason: string) => void | Promise<void>;
  /** Short context about what's being rejected — e.g. "Indent IND-007", "Request REQ-042". */
  entityLabel: string;
  /** Who the reason will be shown to — defaults to "the requester". */
  audienceLabel?: string;
  /** Set true by the parent while the API call is in flight. */
  submitting?: boolean;
}

export function RejectionReasonModal({
  isOpen,
  onClose,
  onSubmit,
  entityLabel,
  audienceLabel = 'the requester',
  submitting = false,
}: RejectionReasonModalProps) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (isOpen) setReason('');
  }, [isOpen]);

  const trimmed = reason.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await onSubmit(trimmed);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Reject ${entityLabel}`}>
      <p className="text-sm text-muted mb-3">
        Tell {audienceLabel} <span className="font-bold">why</span> this is being rejected.
        The reason will appear on their indent/request inline and as a notification.
      </p>
      <textarea
        autoFocus
        // The tightest reject-reason limit on the server is 1,000 characters.
        maxLength={1000}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. Project scope changed — please raise this under the new project header."
        rows={4}
        className="w-full bg-card border border-line rounded-lg px-3 py-2 text-sm outline-none focus:border-brand transition-colors resize-none"
      />
      <div className="flex items-center justify-end gap-2 mt-4">
        <button
          onClick={onClose}
          disabled={submitting}
          className="px-3 py-1.5 text-xs font-bold text-muted hover:bg-hover rounded-lg transition-colors disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-3 py-1.5 text-xs font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? 'Rejecting…' : 'Reject'}
        </button>
      </div>
    </Modal>
  );
}
