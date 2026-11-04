import { useEffect, useRef, useState } from 'react';
import { History, FileText } from 'lucide-react';

/**
 * The REQ number in the audit trail, which can mean two different things.
 *
 * It used to do one on click — narrow the table to that request's movements.
 * But most clicks on a REQ are asking the other question: who asked for this,
 * which department, is anyone accountable. That answer already exists on the
 * slip, so the number now offers both rather than guessing, and the second
 * option is labelled for what the request actually is: a request that has
 * never been issued has no issue slip, and saying so beats opening one made
 * entirely of dashes.
 */
export function RequestLinkMenu({
  serialNo,
  issued,
  onShowHistory,
  onShowDetails,
}: {
  serialNo: string;
  /** Whether stock has actually been issued — decides the second label. */
  issued: boolean;
  onShowHistory: () => void;
  onShowDetails: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  // Close on an outside click or Escape. Both, because a menu you can only
  // dismiss by choosing something is a trap — and this one sits in a table
  // cell where a stray click elsewhere is the natural way out.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <span ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="text-xs text-blue-600 dark:text-blue-300 font-medium underline decoration-dotted underline-offset-2 hover:text-blue-800"
        title={`${serialNo} — movements or request details`}
      >
        {serialNo}
      </button>
      {open && (
        <div
          role="menu"
          // Right-aligned and above the row's own stacking context: the Request
          // column sits mid-table, and a left-aligned popup ran off the edge on
          // the last column's rows.
          className="absolute z-30 mt-1 right-0 w-56 bg-card border border-line rounded-md shadow-lg py-1"
        >
          <button
            role="menuitem"
            onClick={() => choose(onShowHistory)}
            className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-hover"
          >
            <History size={13} className="mt-0.5 text-brand-dark shrink-0" />
            <span>
              <span className="block text-xs font-bold text-ink">Full history</span>
              <span className="block text-[10px] text-faint">Every movement on {serialNo}</span>
            </span>
          </button>
          <button
            role="menuitem"
            onClick={() => choose(onShowDetails)}
            className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-hover"
          >
            <FileText size={13} className="mt-0.5 text-brand-dark shrink-0" />
            <span>
              <span className="block text-xs font-bold text-ink">
                {issued ? 'Issue slip' : 'Request details'}
              </span>
              <span className="block text-[10px] text-faint">
                {issued ? 'Who took it, for which department' : 'Who asked, and what for'}
              </span>
            </span>
          </button>
        </div>
      )}
    </span>
  );
}
