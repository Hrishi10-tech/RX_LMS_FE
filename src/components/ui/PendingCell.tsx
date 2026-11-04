import { StatusBadge } from './StatusBadge';

interface PendingCellProps {
  status: string | null;
  /** Pre-computed reason text. Pass `null` (or omit) when there's nothing to add. */
  reason?: string | null;
  /**
   * True when the row was soft-deleted (user withdrew it). History views pass
   * `deleted={!!row.deletedAt}`; a red "Deleted" tag sits beside the frozen
   * status so the audit trail shows *what state it was withdrawn from*. The
   * pending/rejected reason line is suppressed — "awaiting approval" is
   * misleading on a row that no longer exists.
   */
  deleted?: boolean;
}

/**
 * Status badge + (when applicable) an italic reason line explaining the row's
 * state. Drop-in replacement for `<StatusBadge>` at any indent/request status
 * render-site — pair with `statusReasonForIndent` / `statusReasonForRequest`
 * from `utils/pendingReason`. The reason line's tone matches the badge:
 *   - REJECTED → red (a block),
 *   - APPROVED → emerald (good news — approved, one physical step left),
 *   - everything else (PENDING / YET_TO_ISSUE / …) → amber (still waiting).
 */
export function PendingCell({ status, reason, deleted }: PendingCellProps) {
  const s = (status || '').toUpperCase();
  const reasonTone =
    s === 'REJECTED' ? 'text-red-700 dark:text-red-300'
    : s === 'APPROVED' ? 'text-emerald-700 dark:text-emerald-300'
    : 'text-amber-700 dark:text-amber-300';
  return (
    <div className="flex flex-col items-start gap-0.5">
      <div className="flex items-center gap-1">
        <StatusBadge status={status} />
        {deleted && (
          <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold rounded-md ring-1 ring-inset bg-red-100 dark:bg-red-400/20 text-red-700 dark:text-red-300 ring-red-600/30 dark:ring-red-400/30">
            Deleted
          </span>
        )}
      </div>
      {reason && !deleted && (
        <span className={`text-[10px] italic ${reasonTone}`}>
          {reason}
        </span>
      )}
    </div>
  );
}
