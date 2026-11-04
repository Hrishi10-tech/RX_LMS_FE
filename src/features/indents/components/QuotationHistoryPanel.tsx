import { useEffect, useRef, useState } from 'react';
import { ChevronDown, History } from 'lucide-react';
import { client } from '@/api';
import { fmtDate } from '@/utils/date';
import { SlipDownloadButtons } from '@/components/ui';

interface QuotationVersion {
  id: string;
  version: number;
  status: string;
  grandTotal: number | string;
  currency?: string;
  notes?: string | null;
  submittedAt?: string | null;
  createdAt?: string | null;
  submittedByName?: string | null;
  itemCount: number;
  vendorCount: number;
  vendors: string[];
}

interface Props {
  indentId: string;
  serialNo?: string;
  /** Start expanded (e.g. when the modal is opened straight to history). */
  defaultOpen?: boolean;
}

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'bg-hover text-secondary border-line',
  SUBMITTED: 'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30',
  APPROVED: 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30',
  REJECTED: 'bg-amber-50 dark:bg-amber-400/15 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-400/30',
  SUPERSEDED: 'bg-hover text-muted border-line',
};

const money = (n: number | string, cur = 'INR') =>
  `${cur} ${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

/**
 * Procurement's record of every quote slip they worked on. Lists all quotation
 * versions (v1, v2, … incl. rejected / superseded) for an indent, each with its
 * own PDF + CSV download so the team keeps a track of their work and effort.
 *
 * Lazy: only fetches when expanded, so it adds nothing to the indent modal's
 * initial load. Summaries are lightweight (counts + committed vendors); the full
 * per-version breakdown lives in the downloadable slip.
 */
export const QuotationHistoryPanel = ({ indentId, serialNo, defaultOpen = false }: Props) => {
  const [open, setOpen] = useState(defaultOpen);
  const [loading, setLoading] = useState(false);
  const [versions, setVersions] = useState<QuotationVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards a one-shot fetch WITHOUT putting loading/versions in the effect deps
  // — those would re-run the effect on setState, and the cleanup would cancel
  // the in-flight request (leaving it stuck on "Loading…" forever).
  const fetchedRef = useRef(false);

  // Reset when the modal switches to a different indent.
  useEffect(() => {
    fetchedRef.current = false;
    setVersions(null);
    setError(null);
  }, [indentId]);

  useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .get(`/indents/${indentId}/quotations`)
      .then((r: any) => { if (!cancelled) setVersions((r?.data?.data ?? r?.data ?? []) as QuotationVersion[]); })
      .catch(() => { if (!cancelled) { setError('Could not load quotation history.'); fetchedRef.current = false; } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, indentId]);

  return (
    <div className="border border-line rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-surface hover:bg-hover transition-colors text-left"
      >
        <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted">
          <History size={14} className="text-brand-dark" />
          Quotation history
          {versions && <span className="text-[10px] font-normal text-faint normal-case">({versions.length} version{versions.length === 1 ? '' : 's'})</span>}
        </span>
        <ChevronDown size={14} className={`text-faint transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>

      {open && (
        <div className="p-3 space-y-2">
          {loading && <p className="text-xs text-faint italic text-center py-2">Loading versions…</p>}
          {error && <p className="text-xs text-amber-700 dark:text-amber-300 italic text-center py-2">{error}</p>}
          {versions && versions.length === 0 && (
            <p className="text-xs text-faint italic text-center py-2">No quotations raised yet.</p>
          )}
          {versions && versions.map((q, i) => (
            <div key={q.id} className={`rounded-md border p-2.5 ${i === 0 ? 'border-brand-200 bg-brand-50' : 'border-line bg-card'}`}>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span className="font-mono font-bold text-sm text-ink">v{q.version}</span>
                  {i === 0 && <span className="text-[9px] font-bold text-brand-dark uppercase tracking-wider">latest</span>}
                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider border ${STATUS_STYLE[q.status] || 'bg-hover text-secondary border-line'}`}>{q.status}</span>
                  <span className="font-bold text-sm text-emerald-700 dark:text-emerald-300">{money(q.grandTotal, q.currency)}</span>
                </div>
                <SlipDownloadButtons
                  kind="indents"
                  id={indentId}
                  serialNo={`${serialNo || indentId}-v${q.version}`}
                  size="sm"
                  showView
                  exportPath={`/indents/${indentId}/quotations/${q.id}/export`}
                />
              </div>
              <div className="mt-1 flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[11px] text-muted">
                <span>{q.itemCount} item{q.itemCount === 1 ? '' : 's'}</span>
                <span>·</span>
                <span>{q.vendorCount} vendor{q.vendorCount === 1 ? '' : 's'}</span>
                {q.submittedByName && (<><span>·</span><span>by {q.submittedByName}</span></>)}
                <span>·</span>
                <span>{q.submittedAt ? `submitted ${fmtDate(q.submittedAt)}` : `created ${fmtDate(q.createdAt)}`}</span>
              </div>
              {q.vendors.length > 0 && (
                <p className="mt-1 text-[11px] text-faint truncate" title={q.vendors.join(', ')}>
                  Vendors: {q.vendors.join(', ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
