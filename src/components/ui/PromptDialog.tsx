import { ReactNode, useEffect, useState } from 'react';
import { Modal } from './Modal';

interface PromptDialogProps {
  isOpen: boolean;
  title: string;
  message?: ReactNode;
  /** Label above the box, e.g. "Why? (optional)". */
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  /** Multi-line box for notes; single line otherwise. */
  multiline?: boolean;
  /** When set, OK stays disabled until something is typed. */
  required?: boolean;
  maxLength?: number;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
  onSubmit: (value: string) => void;
  onClose: () => void;
}

/**
 * App-styled replacement for `window.prompt`. The browser's own prompt cannot
 * be themed, shows "localhost:5174 says" above whatever we ask, and looks
 * broken in a deployed product — the same reason ConfirmDialog exists.
 */
export const PromptDialog = ({
  isOpen, title, message, label, placeholder, defaultValue = '', multiline = false, required = false,
  maxLength, confirmLabel = 'OK', cancelLabel = 'Cancel', tone = 'default', onSubmit, onClose,
}: PromptDialogProps) => {
  const [value, setValue] = useState(defaultValue);
  useEffect(() => { if (isOpen) setValue(defaultValue); }, [isOpen, defaultValue]);
  const blocked = required && !value.trim();
  const inputClass = 'w-full border border-line rounded-md px-3 py-2 text-sm bg-card text-ink focus:border-brand outline-none';
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <form noValidate
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (!blocked) onSubmit(value); }}
      >
        {message && <div className="text-sm text-muted leading-relaxed whitespace-pre-line">{message}</div>}
        <div>
          {label && <label className="block text-xs font-bold text-muted mb-1">{label}</label>}
          {multiline ? (
            <textarea autoFocus rows={3} value={value} maxLength={maxLength} placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)} className={`${inputClass} resize-none`} />
          ) : (
            <input autoFocus type="text" value={value} maxLength={maxLength} placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)} className={inputClass} />
          )}
        </div>
        <div className="flex justify-end gap-3 pt-1">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface">
            {cancelLabel}
          </button>
          <button type="submit" disabled={blocked}
            className={`px-5 py-2 text-sm font-bold rounded-md shadow-sm disabled:opacity-50 transition-colors ${
              tone === 'danger' ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-brand text-white hover:bg-brand-dark'
            }`}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
};
