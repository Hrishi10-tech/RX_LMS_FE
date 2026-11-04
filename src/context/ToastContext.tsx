/* eslint-disable react-refresh/only-export-components --
   Idiomatic context module: Context + Provider + consumer hook are co-located.
   Dev-only Fast-Refresh hint with no runtime impact. */
import { createContext, useContext, useState, useCallback, useRef, useEffect, ReactNode } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X, LucideIcon } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastOptions {
  /**
   * Milliseconds before auto-dismiss. `0` keeps the toast up until the user
   * closes it (use for things they must read/act on). Omit to use the
   * per-type default below.
   */
  duration?: number;
}

interface Toast {
  id: string;
  /** First line, carried in bold — what happened. */
  message: string;
  /** Everything after it, in a lighter weight — the particulars. */
  detail?: string;
  /** A filename lifted out of the message, shown on its own line in mono. */
  file?: string;
  type: ToastType;
  duration: number;
  /** How many times this exact message fired — shown as "×N" when > 1. */
  count: number;
}

/**
 * Split a message into a headline and the detail under it.
 *
 * Long toasts used to arrive as one undifferentiated block of equal-weight
 * text — "Uploaded as "db_upload_2026-10-06T06-40-09-803Z.json" — 6527 rows
 * across 51 tables. Restore it from the list when you are ready." — where a
 * forty-character filename dominated the first line and nothing told you at a
 * glance what had actually happened.
 *
 * The app already writes many of these with an em dash between the outcome
 * and its particulars, so that is the seam. Messages without one are left
 * exactly as they are: most toasts here are a single short sentence and would
 * only be hurt by being carved up.
 */
/** The HTTP library's text for a request the app called off itself — never an error to show. */
export const isCancellationNotice = (msg: string): boolean => /^cancell?ed\.?$/i.test(msg.trim());

export const splitMessage = (raw: string): { message: string; detail?: string; file?: string } => {
  // Lift the filename FIRST, then split.
  //
  // These run to forty characters — "db_upload_2026-10-06T06-54-58-718Z.json"
  // — and sitting mid-sentence they wrapped across two lines, broke the
  // reading rhythm, and were still hard to read because they were set in the
  // same proportional face as the prose around them. On their own line, in
  // mono, they are scannable and the sentence is a sentence again.
  //
  // Doing it first also means the headline-length check below measures the
  // text a person will actually see, rather than the text plus a filename
  // that is about to be moved out of it.
  // The connector comes out WITH the filename. Removing the quoted name on
  // its own left "…across 51 tables, saved as. Restore it from the list",
  // which is worse than what it replaced — a preposition pointing at nothing.
  const quoted =
    /(?:,?\s*\b(?:saved|stored|written|uploaded|created|restored)?\s*\b(?:as|to|from|at|in)\s+)?["\u201c]([^"\u201d]*\.[A-Za-z0-9]{2,5})["\u201d]\s*/;
  const match = raw.match(quoted);
  const file = match?.[1];
  const cleaned = file
    ? raw
        .replace(quoted, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s+([.,])/g, '$1')
        // A clause that ended at the filename leaves ", ." or " ." behind.
        .replace(/,\s*\./g, '.')
        .replace(/\(\s*\)/g, '')
        .trim()
    : raw;

  // The app already writes many of these with an em dash between the outcome
  // and its particulars, so that is the seam. Messages without one are left
  // exactly as they are: most toasts here are a single short sentence and
  // would only be hurt by being carved up.
  const at = cleaned.indexOf(' \u2014 ');
  const head = at === -1 || at > 60 ? null : cleaned.slice(0, at).trim();
  const detail = head === null ? undefined : cleaned.slice(at + 3).trim();

  // Lifting the filename can leave a dangling preposition behind —
  // "Uploaded as" — so tidy that off the end.
  const tidy = (t: string) => t.replace(/\s+(as|to|from|at|in)\s*[.,]?$/i, '').replace(/[,\s]+$/, '').trim();

  // A headline loses its trailing full stop — it is a label, not a sentence,
  // and "Restored." reads oddly in bold above the detail explaining it.
  //
  // Only when it IS a label, though. With no detail the message is the whole
  // sentence ("Only 4 unallotted, so 10 units cannot be issued against it.")
  // and stripping its full stop would just be rewriting someone's copy.
  const isLabel = head !== null || !!file;
  const trimmed = tidy(head ?? cleaned);
  const headline = isLabel ? trimmed.replace(/\.$/, '').trim() : trimmed;

  return {
    message: headline || raw,
    detail: detail ? tidy(detail) || detail : undefined,
    file,
  };
};

interface ToastContextType {
  /** `type` defaults to 'info'. Pass `{ duration: 0 }` to make it sticky. */
  addToast: (message: string, type?: ToastType, options?: ToastOptions) => void;
  dismissToast: (id: string) => void;
}

export const ToastContext = createContext<ToastContextType | undefined>(undefined);

// Errors linger so a user can actually read and act on them; quick "saved!"
// confirmations clear fast. Pause-on-hover + the close button mean these are
// floors, not hard caps.
// Roughly doubled from the originals. Four seconds is enough to notice a
// toast and not enough to read one — especially the longer ones, which carry
// a filename or a count and are exactly the ones worth reading. Pause-on-hover
// and the close button mean these are floors, not hard caps.
/**
 * How long each kind stays up.
 *
 * Generous on purpose. These carry real content — row counts, filenames, what
 * to do next — and the old timings gave you about as long as it takes to
 * finish reading, which is not the same as long enough to read it, look away,
 * and look back. There is a large, obvious ✕ on every toast, so the cost of
 * leaving one up too long is a click; the cost of taking it away too early is
 * the information.
 */
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 12000,
  info: 15000,
  // Something needs attention, and the longer ones usually say what to do.
  warning: 20000,
  // Errors stay until dismissed. A failure you did not read is a failure you
  // will hit again, and this is the one case where outlasting its welcome is
  // clearly better than vanishing.
  error: 0,
};

// Cap the visible stack so a burst of failures (e.g. the API going down mid-
// session) can't bury the whole screen. Identical messages dedupe before they
// ever reach this cap.
const MAX_VISIBLE = 4;

const STYLES: Record<ToastType, { bar: string; Icon: LucideIcon }> = {
  success: { bar: 'bg-green-600', Icon: CheckCircle2 },
  error: { bar: 'bg-red-600', Icon: XCircle },
  warning: { bar: 'bg-amber-500', Icon: AlertTriangle },
  info: { bar: 'bg-brand', Icon: Info },
};

export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Mirror of `toasts` for reads inside addToast without it being a dep.
  const toastsRef = useRef<Toast[]>([]);
  toastsRef.current = toasts;
  // id -> auto-dismiss timer. Lets us clear/restart on hover + manual close.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) {
      clearTimeout(t);
      timers.current.delete(id);
    }
  }, []);

  const dismissToast = useCallback(
    (id: string) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  // (Re)start a toast's auto-dismiss countdown. duration <= 0 means "sticky".
  const scheduleDismiss = useCallback(
    (id: string, duration: number) => {
      clearTimer(id);
      if (duration <= 0) return;
      const handle = setTimeout(() => {
        timers.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, duration);
      timers.current.set(id, handle);
    },
    [clearTimer],
  );

  const addToast = useCallback(
    (message: string, type: ToastType = 'info', options?: ToastOptions) => {
      const msg = (message ?? '').toString().trim();
      if (!msg) return; // never show an empty toast
      // A request the app itself called off (the page closed, the list was
      // re-asked) rejects with the HTTP library's bare "canceled". Nobody is
      // waiting for that answer, so it is never an error to show — production
      // showed two red "canceled" boxes after leaving a page mid-load (27 Oct).
      // One check here covers every page that toasts a failed load.
      if (type === 'error' && isCancellationNotice(msg)) return;
      const duration = options?.duration ?? DEFAULT_DURATION[type];

      // Dedup: if the same message+type is already up, bump its counter and
      // reset its timer instead of stacking a duplicate.
      const existing = toastsRef.current.find((t) => t.message === msg && t.type === type);
      if (existing) {
        setToasts((prev) => prev.map((t) => (t.id === existing.id ? { ...t, count: t.count + 1, duration } : t)));
        scheduleDismiss(existing.id, duration);
        return;
      }

      const id = Math.random().toString(36).slice(2, 11);
      const { message: headline, detail, file } = splitMessage(msg);
      setToasts((prev) => {
        const next = [...prev, { id, message: headline, detail, file, type, duration, count: 1 }];
        // Drop oldest beyond the cap so a flood can't fill the viewport.
        while (next.length > MAX_VISIBLE) {
          const dropped = next.shift();
          if (dropped) clearTimer(dropped.id);
        }
        return next;
      });
      scheduleDismiss(id, duration);
    },
    [scheduleDismiss, clearTimer],
  );

  // Clear every pending timer on unmount.
  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((t) => clearTimeout(t));
      map.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ addToast, dismissToast }}>
      {children}
      <div
        className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-[calc(100vw-2rem)] pointer-events-none"
        aria-live="polite"
        aria-relevant="additions"
      >
        {toasts.map((toast) => {
          const { bar, Icon } = STYLES[toast.type];
          const assertive = toast.type === 'error' || toast.type === 'warning';
          return (
            <div
              key={toast.id}
              role={assertive ? 'alert' : 'status'}
              onMouseEnter={() => clearTimer(toast.id)}
              onMouseLeave={() => scheduleDismiss(toast.id, toast.duration)}
              className={`pointer-events-auto flex pl-3.5 pr-2.5 py-3 rounded-lg shadow-lg text-white min-w-[300px] max-w-[420px] transition-all duration-300 ${bar}`}
            >
              {/* `break-words` alone leaves a 40-character filename sitting on
                  its own line and pushing everything around it; `anywhere`
                  lets it wrap mid-token like any other overlong string. */}
              <div className="flex-1 min-w-0 [overflow-wrap:anywhere]">
                {/* The icon, the headline and the dismiss button share ONE row,
                    centred on each other.
                    
                    They used to be siblings of the whole text block with
                    `items-start` on the toast, which only approximates "line up
                    with the first line" — and the approximation was visible:
                    measured against the headline's centre the icon sat 1.58px
                    low and the dismiss button 3.83px low. Putting them in the
                    same flex row makes it exact, and stays exact when the toast
                    grows to three lines, because the row is still just the
                    headline. */}
                <div className="flex items-center gap-3">
                  <Icon size={18} className="shrink-0" />
                  <span className="min-w-0 flex-1 text-sm font-semibold leading-snug">{toast.message}</span>
                  {toast.count > 1 && (
                    <span className="shrink-0 px-1.5 py-0.5 rounded-full bg-card/25 text-[11px] font-bold">
                      ×{toast.count}
                    </span>
                  )}
                  {/* Was 16px at 70% opacity and people did not see it. A toast
                      that now stays up for seven seconds needs an obvious way to
                      get rid of it early. */}
                  <button
                    onClick={() => dismissToast(toast.id)}
                    aria-label="Dismiss notification"
                    title="Dismiss"
                    className="shrink-0 -mr-0.5 grid place-items-center h-7 w-7 rounded-md bg-card/15 hover:bg-card/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-card/60 transition"
                  >
                    <X size={16} strokeWidth={2.5} />
                  </button>
                </div>
                {toast.detail && (
                  <p className="mt-1 pl-[28.5px] text-[13px] leading-relaxed text-white/85">{toast.detail}</p>
                )}
                {/* The filename gets its own line, in mono, on a tinted strip.
                    It is the part people copy or go looking for in a list, and
                    it is the part that reads worst inline. */}
                {toast.file && (
                  <p className="mt-1.5 ml-[28.5px] rounded px-1.5 py-1 bg-card/20 font-mono text-[11.5px] leading-snug text-white/95">
                    {toast.file}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};
