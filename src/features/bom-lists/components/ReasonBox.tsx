import type { ReactNode } from 'react';
import { XCircle } from 'lucide-react';

interface ReasonBoxProps {
  /** Uppercase red label above the textarea. */
  label: string;
  /** Optional explanatory paragraph rendered under the label. */
  description?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  /** Fully-formed confirm-button label (caller bakes in any busy text). */
  confirmLabel: string;
  /** Disables both buttons; confirm is also disabled while the value is blank. */
  busy?: boolean;
  rows?: number;
  autoFocus?: boolean;
  /** Wrap in the standalone red card (whole-BOM / whole-indent reject) vs a bare
   *  block (embedded inside the per-line selection action bar). */
  card?: boolean;
  placeholder?: string;
}

/**
 * The mandatory reject-reason textarea box, with its Cancel + Reject buttons.
 * Reused for the whole-BOM reject, the whole-indent reject, and (via
 * LineReviewActionBar) the per-line reject prompts, so the reason UI never
 * drifts between them.
 */
export const ReasonBox = ({
  label,
  description,
  value,
  onChange,
  onCancel,
  onConfirm,
  confirmLabel,
  busy = false,
  rows = 2,
  autoFocus = false,
  card = false,
  placeholder,
}: ReasonBoxProps) => {
  const pad = card ? 'py-1.5' : 'py-1';
  const inner = (
    <>
      <label className="block text-[10px] font-bold text-red-700 dark:text-red-300 uppercase tracking-wider">
        {label}
      </label>
      {description}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="w-full border border-red-200 dark:border-red-400/30 bg-card rounded py-1.5 px-2 text-sm focus:border-red-400 outline-none resize-none"
      />
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className={`px-3 ${pad} text-xs font-bold text-muted border border-line rounded hover:bg-card disabled:opacity-50`}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy || !value.trim()}
          className={`inline-flex items-center gap-1 px-3 ${pad} text-xs font-bold bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50`}
        >
          <XCircle size={12} /> {confirmLabel}
        </button>
      </div>
    </>
  );
  return card ? (
    <div className="border border-red-200 dark:border-red-400/30 bg-red-50/40 dark:bg-red-400/15 rounded-md p-3 space-y-2">{inner}</div>
  ) : (
    <div className="space-y-2">{inner}</div>
  );
};
