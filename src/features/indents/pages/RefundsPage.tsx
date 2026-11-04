// RefundsPage — a dedicated tracking queue for money owed back to us after a
// paid indent was cancelled or re-ordered. Refunds rarely land immediately;
// they get chased over days/weeks, so they need a home OUTSIDE the live indent
// list (where a months-old cancelled-with-refund row would paginate away).
//
// Shared by Procurement (chasing the vendor) and Finance / Associate Finance
// (verifying the money returned). Both open the same RefundStatusModal to move
// a refund forward — the backend records who acted in the audit timeline.
//
// Data: GET /indents?refundsOnly=true (refundStatus != NONE), scoped per role
// server-side. Split into Active (PENDING / DISPUTED — still chasing) and
// Resolved (RECEIVED / WRITE_OFF — closed).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { client } from '@/api';
import { DataTable, Pagination, ColumnFilter } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { toInr } from '@/config/thresholds';
import { extractErrorMessage } from '@/lib';
import { useAuth, useAbortOnUnmount, usePagedFilters, useTableFilters, FilterSpec } from '@/hooks';
import { RefundStatusModal } from '../components/RefundStatusModal';
import { RefundStatusBadge } from '../components/RefundStatusBadge';
import { UserRole } from '@/types';

type Tab = 'ACTIVE' | 'RESOLVED';
const ACTIVE_STATUSES = ['PENDING', 'DISPUTED'];
const RESOLVED_STATUSES = ['RECEIVED', 'WRITE_OFF'];

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const vendorOf = (r: any) =>
  r.vendorName || r.vendorAllocations?.[0]?.vendorName || null;

// A still-open refund whose expected-by date has passed needs attention.
const isOverdue = (r: any) =>
  ACTIVE_STATUSES.includes(r.refundStatus) &&
  !!r.refundExpectedDate &&
  new Date(r.refundExpectedDate).getTime() < Date.now();

export const RefundsPage = () => {


  const abortSignal = useAbortOnUnmount();
  const { addToast } = useToast();
  const { user } = useAuth();
  // ASSOCIATE_FINANCE is view-only on refunds — the backend 403s PATCH
  // /indents/:id/refund for it. Hide the write action so AF doesn't hit a
  // dead-end button (the page + refund detail stay readable).
  const canEditRefund = user?.role !== UserRole.ASSOCIATE_FINANCE;

  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('ACTIVE');
  const [refundRow, setRefundRow] = useState<any | null>(null);
  const [refundSubmitting, setRefundSubmitting] = useState(false);

  const fetchRefunds = useCallback(async () => {
    setLoading(true);
    try {
      // refunds are bounded (a small fraction of all indents), so one
      // generous page is plenty — no need for server pagination here.
      const res = await client.get('/indents?refundsOnly=true&take=500', { signal: abortSignal() });
      const items = res.data?.data?.items ?? res.data?.items ?? [];
      setRows(items);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to load refunds'), 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    fetchRefunds();
    // Stay in sync when a cancel/re-order/refund action fires elsewhere.
    const onUpd = () => fetchRefunds();
    window.addEventListener('indents-updated', onUpd);
    return () => window.removeEventListener('indents-updated', onUpd);
  }, [fetchRefunds]);

  const active = useMemo(() => rows.filter(r => ACTIVE_STATUSES.includes(r.refundStatus)), [rows]);
  const resolved = useMemo(() => rows.filter(r => RESOLVED_STATUSES.includes(r.refundStatus)), [rows]);

  // A filter on every data column (owner, 27 Oct), valued as each cell reads.
  // The refund labels mirror RefundStatusBadge's.
  const filterSpecs = useMemo<FilterSpec<any>[]>(() => {
    const money = (r: any, v: any) => `${r.currency} ${Number(v ?? 0).toLocaleString('en-IN')}`;
    const REFUND_LABELS: Record<string, string> = { PENDING: 'Refund pending', RECEIVED: 'Refund received', WRITE_OFF: 'Written off', DISPUTED: 'Refund disputed' };
    return [
      { key: 'indent', getValue: (r) => r.serialNo || '' },
      { key: 'paid', getValue: (r) => money(r, r.grandTotal) },
      { key: 'refund', getValue: (r) => REFUND_LABELS[r.refundStatus] || r.refundStatus || '' },
      { key: 'expected', getValue: (r) => (RESOLVED_STATUSES.includes(r.refundStatus) ? '—' : money(r, r.refundExpectedAmount ?? r.grandTotal)) },
      { key: 'received', getValue: (r) => (r.refundReceivedAmount == null ? '—' : money(r, r.refundReceivedAmount)) },
      { key: 'updated', getValue: (r) => (r.refundUpdatedAt ? fmtDate(r.refundUpdatedAt) : '—') },
    ];
  }, []);

  // Bound the render: hundreds of refund rows should never all mount at once.
  // One pager per list (Rules of Hooks — unconditional, top level). Reset key
  // ties to the list length so a background refetch that changes the set snaps
  // back to page 1.
  const activePager = usePagedFilters(active, filterSpecs, 10, `active-${active.length}`);
  const resolvedPager = usePagedFilters(resolved, filterSpecs, 10, `resolved-${resolved.length}`);
  const pager = tab === 'ACTIVE' ? activePager : resolvedPager;
  const filtered = (f: ReturnType<typeof useTableFilters<any>>, label: string, key: string) => ({
    filterActive: f.isActive(key),
    header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={f.getOptions(key)} value={f.filters[key] || ''} onChange={(v) => f.setFilter(key, v)} /></span>,
  });

  // Tiles — normalise mixed currencies to INR (same approach as the Finance
  // spend tiles) so the headline numbers are comparable at a glance.
  const expectedBack = useMemo(
    () => active.reduce((s, r) => s + toInr(Number(r.refundExpectedAmount ?? r.grandTotal ?? 0), r.currency), 0),
    [active],
  );
  const recovered = useMemo(
    () => rows.filter(r => r.refundStatus === 'RECEIVED')
      .reduce((s, r) => s + toInr(Number(r.refundReceivedAmount ?? 0), r.currency), 0),
    [rows],
  );
  const writtenOff = useMemo(() => rows.filter(r => r.refundStatus === 'WRITE_OFF'), [rows]);
  // Money lost = what we were owed back and won't recover (refundExpectedAmount),
  // NOT the whole indent value. A partly-paid indent cancelled before the rest
  // shipped has refundExpectedAmount < grandTotal — summing grandTotal would
  // overstate the write-off. Falls back to grandTotal only when no expected
  // amount was recorded. Same basis as the "Expected back" tile above.
  const writtenOffInr = useMemo(
    () => writtenOff.reduce((s, r) => s + toInr(Number(r.refundExpectedAmount ?? r.grandTotal ?? 0), r.currency), 0),
    [writtenOff],
  );
  const overdueCount = useMemo(() => active.filter(isOverdue).length, [active]);

  const submitRefundUpdate = async (payload: any) => {
    if (!refundRow) return;
    setRefundSubmitting(true);
    try {
      const { receiptFile, ...jsonPayload } = payload;
      await client.patch(`/indents/${refundRow.id}/refund`, jsonPayload);
      if (receiptFile) {
        try {
          const fd = new FormData();
          fd.append('receipt', receiptFile);
          await client.post(`/indents/${refundRow.id}/refund-receipt`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
        } catch (e: any) {
          addToast(extractErrorMessage(e, 'Refund saved but receipt upload failed — try again'), 'error');
        }
      }
      addToast('Refund status updated', 'success');
      setRefundRow(null);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to update refund'), 'error');
    } finally {
      setRefundSubmitting(false);
      fetchRefunds();
      window.dispatchEvent(new Event('indents-updated'));
    }
  };

  const columns = [
    {
      ...filtered(pager, 'Indent', 'indent'),
      accessor: (r: any) => (
        <div className="flex flex-col items-start gap-0.5">
          <span className="font-bold text-ink">{r.serialNo}</span>
          <span className="text-[10px] text-faint">{r.department?.name || 'Unknown dept'}</span>
          {vendorOf(r) && <span className="text-[10px] text-muted">Vendor: {vendorOf(r)}</span>}
        </div>
      ),
    },
    {
      ...filtered(pager, 'Paid', 'paid'),
      accessor: (r: any) => (
        <div className="flex flex-col items-start gap-0.5">
          <span className="font-bold text-ink">{r.currency} {Number(r.grandTotal ?? 0).toLocaleString('en-IN')}</span>
          {r.paymentTransactionId && <span className="text-[10px] font-mono text-faint">{r.paymentTransactionId}</span>}
          {r.paidAt && <span className="text-[10px] text-faint">{fmtDate(r.paidAt)}</span>}
        </div>
      ),
    },
    {
      ...filtered(pager, 'Refund', 'refund'),
      accessor: (r: any) => (
        <div className="flex flex-col items-start gap-1">
          <RefundStatusBadge
            status={r.refundStatus}
            paidAmount={r.grandTotal}
            receivedAmount={r.refundReceivedAmount}
            currency={r.currency || 'INR'}
            size="md"
          />
          {/* A re-ordered indent left the cancelled lane — flag it so the
              tracker knows the items are being re-sourced in parallel. */}
          {r.status !== 'CANCELLED' && (
            <span className="text-[9px] font-bold uppercase tracking-wide text-brand-700" title={`Indent is live again (${r.status}) — being re-ordered`}>
              ↻ re-ordered ({String(r.status).replace(/_/g, ' ').toLowerCase()})
            </span>
          )}
        </div>
      ),
    },
    {
      ...filtered(pager, 'Expected back', 'expected'),
      accessor: (r: any) => {
        if (RESOLVED_STATUSES.includes(r.refundStatus)) return <span className="text-[10px] text-faint">—</span>;
        return (
          <div className="flex flex-col items-start gap-0.5">
            <span className="text-[13px] text-ink">{r.currency} {Number(r.refundExpectedAmount ?? r.grandTotal ?? 0).toLocaleString('en-IN')}</span>
            {r.refundExpectedDate
              ? <span className={`text-[10px] ${isOverdue(r) ? 'text-red-700 dark:text-red-300 font-bold' : 'text-faint'}`}>
                  {isOverdue(r) ? '⚠ overdue · ' : 'by '}{fmtDate(r.refundExpectedDate)}
                </span>
              : <span className="text-[10px] text-faint italic">no date set</span>}
          </div>
        );
      },
    },
    {
      ...filtered(pager, 'Received', 'received'),
      accessor: (r: any) => {
        if (r.refundReceivedAmount == null) return <span className="text-[10px] text-faint">—</span>;
        return (
          <div className="flex flex-col items-start gap-0.5">
            <span className="text-[13px] font-bold text-emerald-700 dark:text-emerald-300">{r.currency} {Number(r.refundReceivedAmount).toLocaleString('en-IN')}</span>
            {r.refundReceivedDate && <span className="text-[10px] text-faint">{fmtDate(r.refundReceivedDate)}</span>}
          </div>
        );
      },
    },
    {
      ...filtered(pager, 'Last update', 'updated'),
      accessor: (r: any) => (
        <div className="flex flex-col items-start gap-0.5">
          <span className="text-[11px] text-muted">{r.refundUpdatedAt ? fmtDateTime(r.refundUpdatedAt) : '—'}</span>
          {r.refundNotes && (
            <span className="text-[10px] text-faint italic max-w-[180px] truncate" title={r.refundNotes}>
              {r.refundNotes}
            </span>
          )}
        </div>
      ),
    },
    {
      header: 'Action',
      accessor: (r: any) => r.refundStatus === 'RECEIVED' ? (
        <span className="text-[11px] font-bold text-emerald-700 dark:text-emerald-300">Settled ✓</span>
      ) : !canEditRefund ? (
        <span className="text-[11px] font-bold text-faint">View only</span>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); setRefundRow(r); }}
          className="px-3 py-1.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark rounded transition-colors"
        >
          Update refund
        </button>
      ),
    },
  ];

  const TabButton = ({ id, label, count }: { id: Tab; label: string; count: number }) => (
    <button
      onClick={() => setTab(id)}
      className={`px-4 py-2 text-sm font-bold rounded-lg transition-colors ${
        tab === id ? 'bg-brand text-white' : 'bg-card text-muted border border-line hover:bg-surface'
      }`}
    >
      {label} <span className={`ml-1 ${tab === id ? 'text-white/80' : 'text-faint'}`}>({count})</span>
    </button>
  );

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-ink">Refunds</h1>
        <p className="text-sm text-muted">Track money owed back after a paid indent was cancelled or re-ordered. Update each refund as you chase and recover it.</p>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-xl border border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-amber-800 dark:text-amber-200">Active refunds</p>
          <p className="text-2xl font-bold text-amber-900 dark:text-amber-200">{active.length}</p>
          {overdueCount > 0 && <p className="text-[11px] font-bold text-red-700 dark:text-red-300">⚠ {overdueCount} overdue</p>}
        </div>
        <div className="rounded-xl border border-line bg-card px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-muted">Expected back</p>
          <p className="text-2xl font-bold text-ink">{inr(expectedBack)}</p>
          <p className="text-[10px] text-faint">across active refunds</p>
        </div>
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-400/15 px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-emerald-800 dark:text-emerald-200">Recovered</p>
          <p className="text-2xl font-bold text-emerald-900 dark:text-emerald-200">{inr(recovered)}</p>
          <p className="text-[10px] text-emerald-700/70 dark:text-emerald-300">money returned</p>
        </div>
        <div className="rounded-xl border border-line bg-surface px-4 py-3">
          <p className="text-[11px] font-bold uppercase tracking-wider text-secondary">Written off</p>
          <p className="text-2xl font-bold text-secondary">{inr(writtenOffInr)}</p>
          <p className="text-[10px] text-muted">{writtenOff.length} indent{writtenOff.length === 1 ? '' : 's'}</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2">
        <TabButton id="ACTIVE" label="Active" count={active.length} />
        <TabButton id="RESOLVED" label="Resolved" count={resolved.length} />
      </div>

      <DataTable
        columns={columns}
        data={pager.pageRows}
        isLoading={loading}
        keyExtractor={(r: any) => r.id}
        emptyStateMessage={tab === 'ACTIVE' ? 'No refunds to chase right now 🎉' : 'No resolved refunds yet.'}
      />

      {pager.totalPages > 1 && (
        <Pagination currentPage={pager.page} totalPages={pager.totalPages} onPageChange={pager.setPage} />
      )}

      <RefundStatusModal
        isOpen={!!refundRow}
        onClose={() => setRefundRow(null)}
        row={refundRow}
        submitting={refundSubmitting}
        onSubmit={submitRefundUpdate}
        onUpdated={fetchRefunds}
      />
    </div>
  );
};

export default RefundsPage;
