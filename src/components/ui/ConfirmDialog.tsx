import { ReactNode } from 'react';
import { Modal } from './Modal';
import { AlertTriangle } from 'lucide-react';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  /** Body copy — string or rich nodes (e.g. a bolded name). */
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 'danger' paints the confirm button red for destructive actions. */
  tone?: 'danger' | 'default';
  /** Disables both buttons + shows a busy label while the action runs. */
  isLoading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * App-styled replacement for `window.confirm`. Built on Modal so it inherits
 * the focus trap, Esc-to-close, and backdrop the rest of the app uses — the
 * native browser dialog looks broken in a deployed product and can't be themed.
 */
export const ConfirmDialog = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  isLoading = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) => (
  <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
    <div className="space-y-5">
      <div className="flex gap-3">
        {tone === 'danger' && (
          <span className="shrink-0 w-9 h-9 rounded-full bg-red-50 dark:bg-red-400/15 flex items-center justify-center">
            <AlertTriangle size={18} className="text-red-700 dark:text-red-300" />
          </span>
        )}
        <div className="text-sm text-muted leading-relaxed whitespace-pre-line">{message}</div>
      </div>
      <div className="flex justify-end gap-3 pt-1">
        <button
          onClick={onClose}
          disabled={isLoading}
          className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface disabled:opacity-50"
        >
          {cancelLabel}
        </button>
        <button
          onClick={onConfirm}
          disabled={isLoading}
          className={`px-5 py-2 text-sm font-bold rounded-md shadow-sm disabled:opacity-50 transition-colors ${
            tone === 'danger'
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-brand text-white hover:bg-brand-dark'
          }`}
        >
          {isLoading ? 'Working…' : confirmLabel}
        </button>
      </div>
    </div>
  </Modal>
);
