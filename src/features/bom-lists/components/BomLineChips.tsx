import { CheckCircle2, XCircle } from 'lucide-react';

/**
 * Two-state pill toggle for per-line nature. Permanent = item gets consumed/
 * embedded in the build (most BOM lines). Temporary = loaned for the
 * list-level duration window.
 */
export const NatureToggle = ({ value, onChange }: { value: 'PERMANENT' | 'TEMPORARY'; onChange: (v: 'PERMANENT' | 'TEMPORARY') => void }) => (
  <div className="inline-flex items-center bg-hover rounded p-0.5 text-[10px] font-bold">
    <button
      type="button"
      onClick={() => value !== 'PERMANENT' && onChange('PERMANENT')}
      title="Item is consumed / embedded in the build"
      className={`px-2 py-0.5 rounded transition-colors ${value === 'PERMANENT' ? 'bg-violet-600 text-white shadow-sm' : 'text-muted hover:text-ink'}`}
    >Perm</button>
    <button
      type="button"
      onClick={() => value !== 'TEMPORARY' && onChange('TEMPORARY')}
      title="Item is borrowed and will be returned within the list's duration"
      className={`px-2 py-0.5 rounded transition-colors ${value === 'TEMPORARY' ? 'bg-blue-600 text-white shadow-sm' : 'text-muted hover:text-ink'}`}
    >Temp</button>
  </div>
);

/**
 * Routing chip — tells the user which destination this line is going to at
 * submit. Green = component request (in inventory). Amber = indent to
 * procurement (short stock). Blue = custom indent line (not in catalog).
 *
 * Computed live from current qty vs stock — flipping qty above stock
 * instantly re-routes the chip from green to amber so the user understands
 * why the procurement-details expander appeared.
 */
export const RoutingChip = ({ kind }: { kind: 'request' | 'indent-short' | 'indent-split' | 'indent-custom' }) => {
  const cfg = {
    'request': { label: 'In stock → Request', cls: 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30', title: 'Issued from inventory via a component request.' },
    'indent-short': { label: 'Short stock → Indent', cls: 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30', title: 'None in stock — the whole line is bundled into a procurement indent.' },
    'indent-split': { label: 'Split → Stock + Indent', cls: 'bg-amber-50 dark:bg-amber-400/15 text-amber-800 dark:text-amber-200 border-amber-300 dark:border-amber-400/30', title: 'Partly in stock: the in-stock quantity is issued as a request, and only the shortfall is procured via the indent.' },
    'indent-custom': { label: 'Custom → Indent', cls: 'bg-sky-50 dark:bg-sky-400/15 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-400/30', title: 'Not in our catalog — sent to procurement to source.' },
  }[kind];
  return (
    <span title={cfg.title} className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${cfg.cls} whitespace-nowrap`}>
      {cfg.label}
    </span>
  );
};

/**
 * Per-line reviewer verdict, shown to the requester on a SUBMITTED BOM so they
 * can see exactly which lines a reviewer approved or rejected before deciding
 * to recall + fix. Renders nothing while a line is still PENDING (the common
 * case), and — because recall() resets every line to PENDING server-side —
 * these only ever appear while the BOM is awaiting / under review.
 */
export const ReviewChip = ({ status }: { status?: string }) => {
  if (status === 'APPROVED') {
    return (
      <span title="A reviewer approved this line" className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30 whitespace-nowrap">
        <CheckCircle2 size={10} /> Approved
      </span>
    );
  }
  if (status === 'REJECTED') {
    return (
      <span title="A reviewer rejected this line — see the reason below" className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded border bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30 whitespace-nowrap">
        <XCircle size={10} /> Rejected
      </span>
    );
  }
  return null;
};

/**
 * The reviewer's rejection reason, surfaced under the rejected line so the
 * requester knows what to fix. Only renders for REJECTED lines that carry a
 * note (reason is mandatory on reject, so in practice every rejected line has
 * one). Left-aligned + wrapping inside the otherwise centred item cell.
 */
export const LineRejectNote = ({ status, note }: { status?: string; note?: string | null }) => {
  if (status !== 'REJECTED' || !note) return null;
  return (
    <p className="mt-1 flex items-start gap-1 text-left text-[10px] font-medium text-red-700 dark:text-red-300 break-words">
      <XCircle size={11} className="shrink-0 mt-px" />
      <span><span className="font-bold uppercase tracking-wide">Reviewer:</span> {note}</span>
    </p>
  );
};
