import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Copy, Check, Loader2 } from 'lucide-react';
import { usersApi } from '../services/users.api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

/** How long a revealed password stays on screen before it re-masks itself. */
const AUTO_HIDE_MS = 60_000;

type Visibility = 'available' | 'self-changed' | 'not-recorded';

interface Props {
  userId: string;
  visibility: Visibility | undefined;
  /** Who issued this password, for the hover explanation. */
  setByName?: string | null;
  setAt?: string | null;
}

/**
 * The Password column on the Super Admin users page: reveal, copy, re-mask.
 *
 * Passwords are NOT part of the users list — the list only says which of three
 * states a row is in. Clicking the eye fetches that one password on its own
 * request, which the server logs. So the network trace of simply browsing the
 * page contains no credentials, and a reveal is a deliberate, recorded act.
 *
 * A revealed password re-masks itself after a minute (`AUTO_HIDE_MS`) so it
 * doesn't sit on an unattended screen. The timer lives in a ref because the
 * hide/re-reveal handlers have to be able to cancel it; state would go stale
 * inside the timeout closure.
 */
export const PasswordCell = ({ userId, visibility, setByName, setAt }: Props) => {
  const { addToast } = useToast();
  const [password, setPassword] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Don't leave timers running against an unmounted row — the table remounts
  // its rows on every page change, search keystroke and tab switch.
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  const hide = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    setPassword(null);
  };

  const reveal = async () => {
    setLoading(true);
    try {
      const res = await usersApi.getPassword(userId);
      if (res.available) {
        setPassword(res.password);
        hideTimer.current = setTimeout(() => setPassword(null), AUTO_HIDE_MS);
      } else {
        // Not an error — the row's state changed under us (someone reset it, or
        // the key rotated). The server's reason is written for a person.
        addToast(res.reason, 'info');
      }
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not read the password'), 'error');
    }
    setLoading(false);
  };

  const copy = async () => {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused (permissions, non-secure origin). Say
      // so rather than silently doing nothing — the password is on screen and
      // can be selected by hand.
      addToast('Could not copy — select the password and copy it manually.', 'error');
    }
  };

  if (visibility === 'self-changed') {
    return (
      <span
        className="text-[10px] italic text-faint"
        title="This person set their own password through the forgot-password link, so it isn't stored in readable form. Set a new one for them with Edit on this row and it will show here."
      >
        Changed by user
      </span>
    );
  }

  if (visibility === 'not-recorded' || visibility === undefined) {
    return (
      <span
        className="text-[10px] italic text-faint"
        title="No readable password on record — it was set before passwords started being kept this way. Set a new one with Edit on this row and it will show here."
      >
        Not recorded
      </span>
    );
  }

  const provenance = setByName
    ? `Set by ${setByName}${setAt ? ` on ${new Date(setAt).toLocaleDateString()}` : ''}`
    : undefined;

  return (
    <div className="flex items-center gap-1.5 whitespace-nowrap" title={provenance}>
      {password ? (
        <code className="rounded bg-brand-50 px-1.5 py-0.5 font-mono text-xs text-ink">{password}</code>
      ) : (
        <span className="select-none font-mono text-xs tracking-widest text-faint">••••••••</span>
      )}

      <button
        type="button"
        onClick={password ? hide : reveal}
        disabled={loading}
        aria-label={password ? 'Hide password' : 'Show password'}
        title={password ? 'Hide' : 'Show'}
        className="rounded p-0.5 text-faint transition-colors hover:text-brand disabled:opacity-50"
      >
        {loading ? <Loader2 size={13} className="animate-spin" /> : password ? <EyeOff size={13} /> : <Eye size={13} />}
      </button>

      {password && (
        <button
          type="button"
          onClick={copy}
          aria-label="Copy password"
          title="Copy"
          className="rounded p-0.5 text-faint transition-colors hover:text-brand"
        >
          {copied ? <Check size={13} className="text-emerald-700 dark:text-emerald-300" /> : <Copy size={13} />}
        </button>
      )}
    </div>
  );
};
