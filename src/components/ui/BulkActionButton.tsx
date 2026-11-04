import { ReactNode, useState } from 'react';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import type { BulkResult } from '@/utils/bulk';

interface BulkActionButtonProps {
  /** Button text prefix — rendered as `{label} {count}`, e.g. "Delete 3". */
  label: string;
  /** Number of items the action will affect (drives the label + disabled state). */
  count: number;
  confirmTitle: string;
  confirmMessage: ReactNode;
  confirmLabel?: string;
  /** 'danger' paints the trigger + confirm button red for destructive actions. */
  tone?: 'danger' | 'default';
  /** Override the default trigger button styling. */
  className?: string;
  /** Disable the trigger (with an optional explanatory tooltip). */
  disabled?: boolean;
  title?: string;
  /** Toast verb, e.g. "deleted", "issued". Default "updated". */
  verb?: string;
  /** Runs the bulk work; resolves to a per-id tally so the toast is honest. */
  onRun: () => Promise<BulkResult>;
  /** Called after the run finishes (success or partial) — clear selection + refetch. */
  onDone: () => void;
}

/**
 * Shared trigger for a bulk-selection action: renders an action button inside a
 * `<BulkSelectionBar>`, gates it behind a themed ConfirmDialog, runs the work,
 * then shows a result toast that's honest about partial failure (e.g.
 * "5 deleted, 2 failed — Project linked to an indent"). Pages supply `onRun`,
 * which returns a {@link BulkResult}; that keeps every action — whether it hits a
 * dedicated bulk endpoint or loops a per-row one — funnelling through one UX.
 */
export function BulkActionButton({
  label,
  count,
  confirmTitle,
  confirmMessage,
  confirmLabel,
  tone = 'default',
  className,
  disabled,
  title,
  verb = 'updated',
  onRun,
  onDone,
}: BulkActionButtonProps) {
  const { addToast } = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const { succeeded, failed } = await onRun();
      if (succeeded > 0 && failed.length === 0) {
        addToast(`${succeeded} ${verb}`, 'success');
      } else if (succeeded > 0 && failed.length > 0) {
        addToast(`${succeeded} ${verb} · ${failed.length} failed — ${failed[0].message}`, 'info');
      } else {
        addToast(`Nothing ${verb} — ${failed[0]?.message || 'all failed'}`, 'error');
      }
      onDone();
    } catch (e) {
      // A dedicated bulk endpoint refuses with a reason (wrong status, no
      // permission) — show it rather than a generic line that hides it.
      addToast(extractErrorMessage(e, 'Bulk action failed'), 'error');
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const defaultCls =
    tone === 'danger'
      ? 'bg-red-600 text-white hover:bg-red-700'
      : 'bg-ink text-card hover:bg-black';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || count === 0}
        title={title}
        className={
          className ||
          `text-xs ${defaultCls} px-3 py-1.5 rounded font-bold transition-colors whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed`
        }
      >
        {label} {count}
      </button>
      <ConfirmDialog
        isOpen={open}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={confirmLabel || label}
        tone={tone}
        isLoading={busy}
        onConfirm={run}
        onClose={() => {
          if (!busy) setOpen(false);
        }}
      />
    </>
  );
}
