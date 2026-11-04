/* eslint-disable react-refresh/only-export-components --
   Idiomatic context module: Context + Provider + consumer hook are co-located.
   Dev-only Fast-Refresh hint with no runtime impact. */
import { createContext, ReactNode, useCallback, useContext, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PromptDialog } from '@/components/ui/PromptDialog';

interface ConfirmOptions {
  title?: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'danger' | 'default';
}

type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

export interface PromptOptions {
  title: string;
  message?: ReactNode;
  label?: string;
  placeholder?: string;
  defaultValue?: string;
  multiline?: boolean;
  required?: boolean;
  maxLength?: number;
  confirmLabel?: string;
  tone?: 'danger' | 'default';
}
/** Resolves to the typed text, or null when cancelled — like window.prompt. */
type PromptFn = (options: PromptOptions) => Promise<string | null>;
const PromptContext = createContext<PromptFn | null>(null);

const ConfirmContext = createContext<ConfirmFn | null>(null);

/**
 * Global confirm dialog — one styled `ConfirmDialog` portal rendered at app
 * root, exposed via the imperative `useConfirm()` hook so callers can replace
 * `window.confirm(msg)` with `await confirm(msg)`:
 *
 *   const confirm = useConfirm();
 *   if (!(await confirm('Delete this thing?'))) return;
 *
 * Plain-string messages with `\n` line breaks render correctly (the dialog
 * uses `whitespace-pre-line`). For richer content, pass `{ message: <jsx /> }`.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<ConfirmOptions>({ message: '' });
  // Holds the promise resolver for the active confirm() call. Cleared when
  // the dialog closes — every confirm() call gets its own fresh resolver.
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  const confirm: ConfirmFn = useCallback((input) => {
    const options: ConfirmOptions = typeof input === 'string' ? { message: input } : input;
    return new Promise<boolean>((resolve) => {
      // If another confirm is already open (rare), resolve the prior one as
      // cancelled so its caller doesn't hang forever.
      if (resolverRef.current) resolverRef.current(false);
      resolverRef.current = resolve;
      setOpts(options);
      setOpen(true);
    });
  }, []);

  // The text-input twin of confirm(): same provider, its own dialog.
  const [promptOpts, setPromptOpts] = useState<PromptOptions | null>(null);
  const promptResolverRef = useRef<((v: string | null) => void) | null>(null);
  const prompt: PromptFn = useCallback((options) => new Promise<string | null>((resolve) => {
    if (promptResolverRef.current) promptResolverRef.current(null);
    promptResolverRef.current = resolve;
    setPromptOpts(options);
  }), []);
  const finishPrompt = useCallback((value: string | null) => {
    setPromptOpts(null);
    const r = promptResolverRef.current;
    promptResolverRef.current = null;
    r?.(value);
  }, []);

  const finish = useCallback((result: boolean) => {
    setOpen(false);
    const r = resolverRef.current;
    resolverRef.current = null;
    r?.(result);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
     <PromptContext.Provider value={prompt}>
      {children}
      <PromptDialog
        isOpen={!!promptOpts}
        title={promptOpts?.title ?? ''}
        message={promptOpts?.message}
        label={promptOpts?.label}
        placeholder={promptOpts?.placeholder}
        defaultValue={promptOpts?.defaultValue}
        multiline={promptOpts?.multiline}
        required={promptOpts?.required}
        maxLength={promptOpts?.maxLength}
        confirmLabel={promptOpts?.confirmLabel}
        tone={promptOpts?.tone}
        onSubmit={(v) => finishPrompt(v)}
        onClose={() => finishPrompt(null)}
      />
      <ConfirmDialog
        isOpen={open}
        title={opts.title ?? 'Are you sure?'}
        message={opts.message}
        confirmLabel={opts.confirmLabel}
        cancelLabel={opts.cancelLabel}
        tone={opts.tone ?? 'default'}
        onConfirm={() => finish(true)}
        onClose={() => finish(false)}
      />
     </PromptContext.Provider>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be called inside a <ConfirmProvider>.');
  }
  return ctx;
}

/** Themed replacement for window.prompt — `await prompt({...})` gives the text, or null if cancelled. */
export function usePrompt(): PromptFn {
  const ctx = useContext(PromptContext);
  if (!ctx) {
    throw new Error('usePrompt must be called inside a <ConfirmProvider>.');
  }
  return ctx;
}
