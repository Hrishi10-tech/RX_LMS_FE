import { useEffect, useMemo, useRef, useState } from 'react';
import { client } from '@/api';
import { DataTable, ColumnFilter, ExportPanel, Pagination } from '@/components/ui';
import { useTableFilters, useClientPagination, FilterSpec, useAbortOnUnmount } from '@/hooks';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { toInr } from '@/config/thresholds';
import { IndentTrackModal } from '../components/IndentTrackModal';
import { ViewReceiptLink } from '../components/ViewReceiptLink';

type TxnType = 'PAYMENT' | 'REFUND' | 'CUSTOMS_INTERNAL' | 'CUSTOMS_INTERNATIONAL';

interface TxnEvent {
  id: string;
  date: string | null;
  type: TxnType;
  typeLabel: string;
  indent: any;
  serialNo: string;
  amount: number;
  currency: string;
  status: string;
  txnId: string | null;
  paidByName: string | null;
  receipt: { kind: 'payment' | 'refund' | 'customs-duty'; paymentId?: string } | null;
}

const TYPE_STYLE: Record<TxnType, string> = {
  PAYMENT: 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 ring-emerald-600/20 dark:ring-emerald-400/30',
  REFUND: 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 ring-amber-600/20 dark:ring-amber-400/30',
  CUSTOMS_INTERNAL: 'bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 ring-violet-600/20 dark:ring-violet-400/30',
  CUSTOMS_INTERNATIONAL: 'bg-indigo-50 dark:bg-indigo-400/15 text-indigo-700 dark:text-indigo-300 ring-indigo-600/20 dark:ring-indigo-400/30',
};

/**
 * Super-admin Finances — a read-only, org-wide transaction ledger. Flattens
 * every money event off /indents (main payment, refunds, customs duty) into one
 * filterable, exportable table. No mark-paid here: super-admin audits; FINANCE
 * acts. Click an indent # to open its full status timeline.
 */
export const SuperAdminFinancesPage = () => {
  const { addToast } = useToast();
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [indents, setIndents] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [trackIndent, setTrackIndent] = useState<any>(null);

  // A full load is every indent, 200 at a time, so two must never overlap.
  // A trigger that arrives mid-load is remembered and runs once when the
  // current load ends, rather than being dropped: an 'indents-updated' during
  // a load means the data being fetched may already be out of date.
  const loadingRef = useRef(false);
  const reloadQueuedRef = useRef(false);
  const mountedRef = useRef(true);

  const fetchIndents = async () => {
    if (loadingRef.current) { reloadQueuedRef.current = true; return; }
    loadingRef.current = true;
    setIsLoading(true);
    try {
      // This ledger needs the FULL set: the summary tiles are org-wide
      // aggregates and every indent explodes into 1..N transaction rows. So
      // page through with take/skip until `total` is satisfied — otherwise
      // the tiles silently under-count. (The DOM stays bounded — client
      // pagination still renders only 10 rows at a time.)
      //
      // PAGE matches the server's own ceiling. It used to ask for 500, and
      // the server caps a page at 200 — so the first batch came back short of
      // what was asked for, `batch.length < PAGE` was true immediately, and
      // the loop stopped after one page. The ledger loaded 200 of 225 and the
      // org-wide totals were quietly wrong: exactly the failure this loop was
      // written to prevent.
      //
      // The guard is now "the server returned nothing", which cannot be
      // confused with "the server returned less than I asked for".
      // `view=ledger` asks the API for the money fields only. This page reads
      // no line items, quotations or vendor orders, and they were ~73% of the
      // bytes on every row — on a full-table pull that is the whole cost.
      const PAGE = 200; // keep in step with MAX_PAGE_SIZE on the API
      let skip = 0;
      let all: any[] = [];
      for (;;) {
        const { data } = await client.get('/indents', { params: { take: PAGE, skip, view: 'ledger' }, signal: abortSignal() });
        const payload = data.data ?? data ?? {};
        const batch: any[] = Array.isArray(payload) ? payload : (payload.items ?? []);
        all = all.concat(batch);
        const total = Array.isArray(payload) ? batch.length : (payload.total ?? all.length);
        skip += batch.length || PAGE;
        if (batch.length === 0 || all.length >= total) break;
      }
      setIndents(all);
    } catch (e: any) {
      if (mountedRef.current) addToast(extractErrorMessage(e, 'Failed to load finances'), 'error');
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
      if (reloadQueuedRef.current && mountedRef.current) {
        reloadQueuedRef.current = false;
        fetchIndents();
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    fetchIndents();
    // Refreshes are debounced: a save elsewhere can dispatch 'indents-updated'
    // several times in a row, and each one used to start its own full load.
    //
    // Only visibilitychange is listened to for "came back to this tab", not
    // 'focus' as well. Returning to the tab fires both, and with both wired
    // every return started two full loads of the whole indent table.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; fetchIndents(); }, 300);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') scheduleRefresh(); };
    window.addEventListener('indents-updated', scheduleRefresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      mountedRef.current = false;
      if (timer) clearTimeout(timer);
      window.removeEventListener('indents-updated', scheduleRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tiles = useMemo(() => {
    let pipeline = 0, committed = 0, received = 0, dutyPaid = 0, dutyPending = 0;
    const PIPELINE_STATES = ['PENDING', 'QUOTATION_IN_PROGRESS', 'READY_FOR_PAYMENT', 'AWAITING_PAYMENT'];
    const COMMITTED_STATES = ['PAYMENT_DONE', 'ORDERED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED'];
    for (const i of indents) {
      // Normalise to INR: the tiles are ₹-denominated (see fmt), but grandTotal
      // is native for a single-currency indent — summing raw would drop a bare
      // USD number into a ₹ total. Mirrors the RefundsPage tiles, which convert.
      const gt = toInr(Number(i.grandTotal || 0), i.currency);
      // Money clawed back via a received refund, in INR. refundReceivedAmount is
      // stored in the indent's currency (see updateVendorOrderRefund rollup), so
      // it converts the same way as gt.
      const refundBack = toInr(Number(i.refundReceivedAmount || 0), i.currency);
      if (PIPELINE_STATES.includes(i.status)) pipeline += gt;
      // Committed = net money still out with a vendor. A refund received while
      // the indent is STILL in a committed status (e.g. a defective-item return
      // on a RECEIVED indent) reduces what's actually committed — net it out.
      // (Cancelled / reordered indents leave the committed set entirely, so this
      // only fires when the money genuinely is still committed.)
      if (COMMITTED_STATES.includes(i.status)) committed += Math.max(0, gt - refundBack);
      if (i.status === 'RECEIVED') received += gt;
      for (const d of (i.customsDutyPayments || [])) {
        if (d.status === 'PAID') dutyPaid += 1; else dutyPending += 1;
      }
    }
    return { pipeline, committed, received, dutyPaid, dutyPending };
  }, [indents]);

  const events = useMemo<TxnEvent[]>(() => {
    const out: TxnEvent[] = [];
    for (const ind of indents) {
      if (ind.paymentTransactionId || ind.paidAt) {
        out.push({
          id: `pay-${ind.id}`, date: ind.paidAt || null, type: 'PAYMENT', typeLabel: 'Payment',
          indent: ind, serialNo: ind.serialNo, amount: Number(ind.grandTotal || 0), currency: ind.currency || 'INR',
          status: 'PAID', txnId: ind.paymentTransactionId || null, paidByName: ind.paidBy?.name || null,
          receipt: ind.paymentReceiptPath ? { kind: 'payment' } : null,
        });
      }
      for (const d of (ind.customsDutyPayments || [])) {
        out.push({
          id: `duty-${d.id}`, date: d.paidAt || d.createdAt || null,
          type: d.kind === 'INTERNAL' ? 'CUSTOMS_INTERNAL' : 'CUSTOMS_INTERNATIONAL',
          typeLabel: d.kind === 'INTERNAL' ? 'Other payments' : 'Customs duty',
          indent: ind, serialNo: ind.serialNo, amount: Number(d.amount || 0), currency: d.currency || 'INR',
          status: d.status, txnId: d.transactionId || null, paidByName: d.paidBy?.name || null,
          receipt: d.receiptPath ? { kind: 'customs-duty', paymentId: d.id } : null,
        });
      }
      if (ind.refundStatus && ind.refundStatus !== 'NONE') {
        out.push({
          id: `refund-${ind.id}`, date: ind.refundReceivedDate || ind.refundUpdatedAt || null, type: 'REFUND', typeLabel: 'Refund',
          indent: ind, serialNo: ind.serialNo,
          amount: Number(ind.refundReceivedAmount ?? ind.refundExpectedAmount ?? 0), currency: ind.currency || 'INR',
          status: ind.refundStatus, txnId: ind.refundTransactionId || null, paidByName: null,
          receipt: ind.refundReceiptPath ? { kind: 'refund' } : null,
        });
      }
    }
    out.sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime());
    return out;
  }, [indents]);

  const filterSpecs = useMemo<FilterSpec<TxnEvent>[]>(() => [
    { key: 'type', getValue: (r) => r.typeLabel },
    { key: 'indent', getValue: (r) => r.serialNo },
    { key: 'status', getValue: (r) => r.status },
    { key: 'paidBy', getValue: (r) => r.paidByName || '—' },
    // A filter on every data column (owner, 27 Oct).
    { key: 'date', getValue: (r) => (r.date ? fmtDate(r.date) : '—') },
    { key: 'amount', getValue: (r) => `${r.currency} ${r.amount.toLocaleString('en-IN')}` },
    { key: 'txnId', getValue: (r) => r.txnId || '—' },
  ], []);
  const f = useTableFilters(events, filterSpecs);

  // Client-side pagination fallback (documented). This ledger is computed: each
  // indent explodes into 1..N transaction rows (payment + customs duties +
  // refund), and the summary tiles above need org-wide aggregates — neither
  // maps onto a server take/skip on /indents. So we keep the full fetch (for
  // correct tiles + flattening) but render only 10 rows at a time to keep the
  // DOM bounded, which is the actual crash vector.
  const PAGE_SIZE = 10;
  const { pageRows, page: safePage, setPage, totalPages } = useClientPagination(f.filteredRows, PAGE_SIZE, JSON.stringify(f.filters));

  const fmt = (n: number) => `₹ ${n.toLocaleString('en-IN')}`;
  const statusChip = (s: string) => {
    const good = s === 'PAID' || s === 'RECEIVED';
    const warn = s === 'PENDING' || s === 'DISPUTED';
    const cls = good ? 'bg-emerald-100 dark:bg-emerald-400/20 text-emerald-700 dark:text-emerald-300' : warn ? 'bg-amber-100 dark:bg-amber-400/20 text-amber-700 dark:text-amber-300' : 'bg-hover text-secondary';
    return <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${cls}`}>{s.replace(/_/g, ' ')}</span>;
  };

  const columns: any[] = [
    { header: 'S.No', accessor: (_r: any, idx?: number) => String((safePage - 1) * PAGE_SIZE + (idx ?? 0) + 1) },
    { filterActive: f.isActive('date'), header: <span className="inline-flex items-center">Date<ColumnFilter searchable options={f.getOptions('date')} value={f.filters.date || ''} onChange={(v) => f.setFilter('date', v)} /></span>, accessor: (r: TxnEvent) => r.date ? <span className="text-xs text-muted">{fmtDateTime(r.date)}</span> : <span className="text-xs text-faint">—</span> },
    {
      filterActive: f.isActive('type'),
      header: <span className="inline-flex items-center">Type<ColumnFilter options={f.getOptions('type')} value={f.filters.type || ''} onChange={(v) => f.setFilter('type', v)} /></span>,
      accessor: (r: TxnEvent) => <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-bold rounded-md ring-1 ring-inset ${TYPE_STYLE[r.type]}`}>{r.typeLabel}</span>,
    },
    {
      filterActive: f.isActive('indent'),
      header: <span className="inline-flex items-center">Indent #<ColumnFilter searchable options={f.getOptions('indent')} value={f.filters.indent || ''} onChange={(v) => f.setFilter('indent', v)} /></span>,
      accessor: (r: TxnEvent) => (
        <button onClick={() => setTrackIndent(r.indent)} className="font-mono text-xs font-bold text-brand hover:underline" title="View timeline">{r.serialNo}</button>
      ),
    },
    { filterActive: f.isActive('amount'), header: <span className="inline-flex items-center">Amount<ColumnFilter searchable options={f.getOptions('amount')} value={f.filters.amount || ''} onChange={(v) => f.setFilter('amount', v)} /></span>, accessor: (r: TxnEvent) => <span className="font-mono text-xs font-bold text-ink">{r.currency} {r.amount.toLocaleString('en-IN')}</span> },
    {
      filterActive: f.isActive('status'),
      header: <span className="inline-flex items-center">Status<ColumnFilter options={f.getOptions('status')} value={f.filters.status || ''} onChange={(v) => f.setFilter('status', v)} /></span>,
      accessor: (r: TxnEvent) => statusChip(r.status),
    },
    { filterActive: f.isActive('txnId'), header: <span className="inline-flex items-center">Txn ID<ColumnFilter searchable options={f.getOptions('txnId')} value={f.filters.txnId || ''} onChange={(v) => f.setFilter('txnId', v)} /></span>, accessor: (r: TxnEvent) => r.txnId ? <span className="font-mono text-[11px] text-ink">{r.txnId}</span> : <span className="text-xs text-faint">—</span> },
    {
      filterActive: f.isActive('paidBy'),
      header: <span className="inline-flex items-center">By<ColumnFilter searchable options={f.getOptions('paidBy')} value={f.filters.paidBy || ''} onChange={(v) => f.setFilter('paidBy', v)} /></span>,
      accessor: (r: TxnEvent) => r.paidByName ? <span className="text-xs text-muted">{r.paidByName}</span> : <span className="text-xs text-faint">—</span>,
    },
    {
      header: 'Receipt',
      accessor: (r: TxnEvent) => r.receipt
        ? <ViewReceiptLink indentId={r.indent.id} kind={r.receipt.kind} paymentId={r.receipt.paymentId} label="View" />
        : <span className="text-xs text-faint">—</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Finances</h2>
        <p className="text-sm md:text-[15px] text-muted mt-1.5">Org-wide transaction ledger — payments, refunds, and customs duty. Read-only audit view.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Tile label="In Pipeline" value={fmt(tiles.pipeline)} sub="Pending / quoting / awaiting payment" accent="text-ink" />
        <Tile label="Committed" value={fmt(tiles.committed)} sub="Paid and / or with vendor" accent="text-amber-700 dark:text-amber-300" />
        <Tile label="Received" value={fmt(tiles.received)} sub="Delivered and shelved" accent="text-emerald-700 dark:text-emerald-300" />
        <Tile label="Customs duty" value={`${tiles.dutyPending} pending`} sub={`${tiles.dutyPaid} settled`} accent="text-violet-700 dark:text-violet-300" />
      </div>

      <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
        <div className="px-6 py-3 border-b border-line-soft">
          <h3 className="text-sm font-bold text-ink">All transactions ({f.filteredRows.length})</h3>
          <p className="text-xs text-muted mt-0.5">Every money event across the org. Click an indent # for its full timeline.</p>
        </div>
        <div className="px-6 py-3 border-b border-line-soft bg-surface/60">
          {/* Audit-grade export — CSV / List PDF / Detailed PDF, server-rendered. */}
          <ExportPanel kind="indents" />
        </div>
        <DataTable
          columns={columns}
          data={pageRows}
          isLoading={isLoading}
          keyExtractor={(r: TxnEvent) => r.id}
          emptyStateMessage="No transactions yet."
          maxHeight="60vh"
        />
        <div className="px-6 py-2">
          <Pagination currentPage={safePage} totalPages={totalPages} onPageChange={setPage} />
        </div>
      </div>

      <IndentTrackModal indent={trackIndent} onClose={() => setTrackIndent(null)} />
    </div>
  );
};

const Tile = ({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) => (
  <div className="bg-card rounded-xl border border-line-soft shadow-sm p-4">
    <p className="text-xs font-bold text-muted uppercase tracking-wider">{label}</p>
    <p className={`text-2xl font-bold mt-1 ${accent}`}>{value}</p>
    <p className="text-[11px] text-muted mt-1">{sub}</p>
  </div>
);
