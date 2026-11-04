import { CheckCircle2, XCircle } from 'lucide-react';
import { ReasonBox } from './ReasonBox';

interface LineReviewActionBarProps {
  /** Number of selected lines (drives the "N lines selected" label). */
  count: number;
  /** Action in flight — disables every control + swaps the Approve label. */
  busy: boolean;
  /** Whether the inline reject-reason box is expanded. */
  rejectOpen: boolean;
  onClear: () => void;
  onOpenReject: () => void;
  onApprove: () => void;
  // Reject-reason box wiring.
  reason: string;
  onReasonChange: (v: string) => void;
  onCancelReject: () => void;
  onConfirmReject: () => void;
  reasonLabel: string;
  /** Fully-formed reject confirm-button label (caller bakes in any busy text). */
  rejectConfirmLabel: string;
  /** Compact chrome (rounded p-2) for the nested indent bar vs the roomier
   *  standalone BOM bar (rounded-md p-3). */
  compact?: boolean;
}

/**
 * The per-line selection action bar — "N selected" + Clear / Reject selected /
 * Approve selected, with the mandatory reject-reason box expanding inline. One
 * component drives both the BOM per-line review and the spawned-indent per-line
 * review, so the two never drift.
 */
export const LineReviewActionBar = ({
  count,
  busy,
  rejectOpen,
  onClear,
  onOpenReject,
  onApprove,
  reason,
  onReasonChange,
  onCancelReject,
  onConfirmReject,
  reasonLabel,
  rejectConfirmLabel,
  compact = false,
}: LineReviewActionBarProps) => (
  <div className={`border border-brand/40 bg-brand-50 ${compact ? 'rounded p-2' : 'rounded-md p-3'} space-y-2`}>
    <div className="flex items-center justify-between gap-2 flex-wrap">
      <span className="text-xs font-bold text-muted">
        {count} line{count > 1 ? 's' : ''} selected
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onClear}
          disabled={busy}
          className="px-2.5 py-1 text-xs font-bold text-muted border border-line rounded hover:bg-card disabled:opacity-50"
        >
          Clear
        </button>
        {!rejectOpen && (
          <>
            <button
              type="button"
              onClick={onOpenReject}
              disabled={busy}
              className="inline-flex items-center gap-1 px-3 py-1 text-xs font-bold text-red-700 dark:text-red-300 border border-red-300 dark:border-red-400/30 rounded hover:bg-red-50 dark:bg-red-400/15 disabled:opacity-50"
            >
              <XCircle size={12} /> Reject selected
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={busy}
              className="inline-flex items-center gap-1 px-3 py-1 text-xs font-bold bg-emerald-700 text-white rounded hover:bg-emerald-800 disabled:opacity-50"
            >
              <CheckCircle2 size={12} /> {busy ? 'Working…' : 'Approve selected'}
            </button>
          </>
        )}
      </div>
    </div>
    {rejectOpen && (
      <ReasonBox
        label={reasonLabel}
        value={reason}
        onChange={onReasonChange}
        onCancel={onCancelReject}
        onConfirm={onConfirmReject}
        confirmLabel={rejectConfirmLabel}
        busy={busy}
        rows={2}
        autoFocus
        placeholder="Why these lines are rejected"
      />
    )}
  </div>
);
