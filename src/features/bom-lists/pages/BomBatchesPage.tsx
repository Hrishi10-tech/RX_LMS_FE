import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/context/ToastContext';
import { useClientPagination } from '@/hooks';
import { Pagination, ExportPanel } from '@/components/ui';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import { Package, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { bomListsApi } from '../services/bom-lists.api';
import { BomBatchIssueDrawer } from '../components/BomBatchIssueDrawer';

/**
 * Inventory clerk's BOM batch page. Two tabs:
 *
 *  - **Active**: BOMs that have ≥1 spawned request the clerk can act on
 *    (APPROVED or YET_TO_ISSUE). Click a card → drawer with the tick list.
 *  - **History**: BOMs where every spawned request has reached a terminal
 *    state. Card title carries the `BOM Issued` badge. Click → read-only
 *    drawer with per-line `Issued X on {date} by {clerk}` stamps.
 *
 * Pure read + bulk-action surface — no schema changes. Active/History is
 * computed server-side from each BOM's spawned-request statuses.
 */
export const BomBatchesPage = () => {
  const { addToast } = useToast();
  const [tab, setTab] = useState<'active' | 'history'>('active');
  const [active, setActive] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [openBatchId, setOpenBatchId] = useState<string | null>(null);
  const [openMode, setOpenMode] = useState<'issue' | 'history'>('issue');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [a, h] = await Promise.all([
        bomListsApi.listActiveBatches(),
        bomListsApi.listHistoryBatches(),
      ]);
      setActive(a?.items ?? a ?? []);
      setHistory(h?.items ?? h ?? []);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to load BOM batches'), 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const openBatch = (id: string, mode: 'issue' | 'history') => {
    setOpenMode(mode);
    setOpenBatchId(id);
  };

  const visible = tab === 'active' ? active : history;
  const pager = useClientPagination(visible, 10, tab);

  return (
    <div className="space-y-4 md:space-y-6">
      <div>
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">BOM Batches</h2>
        <p className="text-sm md:text-[15px] text-muted mt-1.5">
          Issue a BOM's component requests in one go. Each card is a submitted BOM — open it, untick anything you don't want to issue right now, click <span className="font-bold">Issue selected</span>.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-line">
        <button
          onClick={() => setTab('active')}
          className={`px-4 py-2 text-sm font-bold border-b-2 transition-colors ${
            tab === 'active'
              ? 'border-brand text-ink'
              : 'border-transparent text-faint hover:text-muted'
          }`}
        >
          Active
          {active.length > 0 && <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-brand text-white">{active.length}</span>}
        </button>
        <button
          onClick={() => setTab('history')}
          className={`px-4 py-2 text-sm font-bold border-b-2 transition-colors ${
            tab === 'history'
              ? 'border-brand text-ink'
              : 'border-transparent text-faint hover:text-muted'
          }`}
        >
          History
          {history.length > 0 && <span className="ml-2 text-[10px] font-bold px-1.5 py-0.5 rounded bg-line text-muted">{history.length}</span>}
        </button>
      </div>

      {/* Grid of BOM cards */}
      {loading && (
        <div className="text-center py-12 text-faint text-sm">Loading BOM batches…</div>
      )}

      {!loading && visible.length === 0 && (
        <div className="text-center py-12 border border-dashed border-line rounded-xl text-faint">
          <Package size={32} className="mx-auto mb-2 text-faint" />
          {tab === 'active'
            ? 'No active BOM batches — all submitted BOMs have been fully issued.'
            : 'No BOM history yet — once a BOM is fully issued it will appear here.'}
        </div>
      )}

      {!loading && visible.length > 0 && (
        <>
          {tab === 'history' && (
            <div className="mb-3">
              <ExportPanel kind="bom-lists" />
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {pager.pageRows.map((b: any) => (
              <BomCard
                key={b.id}
                batch={b}
                mode={tab}
                onOpen={() => openBatch(b.id, tab === 'active' ? 'issue' : 'history')}
              />
            ))}
          </div>
          {pager.totalPages > 1 && (
            <Pagination currentPage={pager.page} totalPages={pager.totalPages} onPageChange={pager.setPage} />
          )}
        </>
      )}

      <BomBatchIssueDrawer
        batchId={openBatchId}
        mode={openMode}
        onClose={() => setOpenBatchId(null)}
        onIssued={fetchAll}
      />
    </div>
  );
};

/**
 * Single BOM card — the actionable surface in both Active and History tabs.
 *
 * Active card title is the BOM's serial + name. History card prepends the
 * green `BOM Issued` badge so the clerk sees at a glance which ones are
 * fully done.
 */
const BomCard = ({ batch, mode, onOpen }: { batch: any; mode: 'active' | 'history'; onOpen: () => void }) => {
  const counts = batch.counts || {};
  const ready = counts.ready ?? 0;
  const shortStock = counts.shortStock ?? 0;
  const issued = counts.issued ?? 0;
  const pending = counts.pending ?? 0;
  const queued = counts.queued ?? 0;
  const total = counts.total ?? 0;

  return (
    <button
      type="button"
      onClick={onOpen}
      className="text-left bg-card border border-line-soft rounded-xl shadow-sm hover:shadow-md hover:border-brand/40 transition-all overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-line-soft">
        <div className="flex items-start gap-2">
          {mode === 'history' && (
            <span className="text-[9px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 px-1.5 py-0.5 rounded mt-0.5 shrink-0">
              BOM Issued
            </span>
          )}
          <div className="flex-1 min-w-0">
            <p className="font-mono text-[10px] font-bold text-faint">{batch.serialNo}</p>
            <p className="font-bold text-ink truncate">{batch.name}</p>
          </div>
        </div>
        <p className="text-[10px] text-muted mt-1 truncate">
          <span className="font-bold">{batch.createdBy?.name || 'Unknown'}</span>
          {batch.project?.name && <> · {batch.project.name}</>}
          {batch.department?.name && <> · {batch.department.name}</>}
        </p>
      </div>

      {/* Counts strip — what's in this BOM, at a glance */}
      <div className="px-4 py-3 flex flex-wrap items-center gap-1.5 text-[10px]">
        <span className="font-bold text-faint mr-1">{total} line{total === 1 ? '' : 's'}</span>
        {ready > 0 && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30 font-bold">
            {ready} ready
          </span>
        )}
        {shortStock > 0 && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30 font-bold">
            <AlertTriangle size={9} /> {shortStock} short stock
          </span>
        )}
        {queued > 0 && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-orange-50 dark:bg-orange-400/15 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-400/30 font-bold">
            <Clock size={9} /> {queued} queued
          </span>
        )}
        {pending > 0 && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-400/30 font-bold">
            {pending} pending approval
          </span>
        )}
        {issued > 0 && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border bg-surface text-secondary border-line font-bold">
            <CheckCircle2 size={9} /> {issued} issued
          </span>
        )}
      </div>

      {/* Footer — timestamps */}
      <div className="px-4 py-2 bg-surface/60 border-t border-line-soft text-[10px] text-faint">
        Submitted {batch.submittedAt ? fmtDateTime(batch.submittedAt) : '—'}
        {batch.lastIssuedAt && <> · last issued {fmtDateTime(batch.lastIssuedAt)}</>}
      </div>
    </button>
  );
};
