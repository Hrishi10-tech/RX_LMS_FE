import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { client } from '@/api';
import { logError } from '@/lib';
import { fmtInt } from '@/utils/number';
import { fmtRelativeTime } from '@/utils/date';
import { StatCard, BrandLoader } from '@/components/ui';
import { Package, ArrowDownToLine, ArrowUpFromLine, RotateCcw, Trash2, AlertTriangle, TrendingDown, Archive, Activity, Eye, Clock, Zap, Truck, Wrench, ShieldCheck, ChevronRight } from 'lucide-react';
import { ReceiveIndentModal } from '@/features/inventory';

const EventBadge = ({ type }: { type: string }) => {
  const map: Record<string, { label: string; cls: string }> = {
    STOCK_IN: { label: 'IN', cls: 'bg-green-100 dark:bg-green-400/20 text-green-700 dark:text-green-300' },
    STOCK_OUT: { label: 'OUT', cls: 'bg-red-100 dark:bg-red-400/20 text-red-700 dark:text-red-300' },
    RETURN: { label: 'RTN', cls: 'bg-blue-100 dark:bg-blue-400/20 text-blue-700 dark:text-blue-300' },
    ADJUSTMENT: { label: 'ADJ', cls: 'bg-amber-100 dark:bg-amber-400/20 text-amber-700 dark:text-amber-300' },
    DISPOSITION_CHANGE: { label: 'DSP', cls: 'bg-purple-100 dark:bg-purple-400/20 text-purple-700 dark:text-purple-300' },
    DISPOSAL: { label: 'DEL', cls: 'bg-line text-secondary' },
  };
  const info = map[type] || { label: type?.slice(0, 3), cls: 'bg-hover text-secondary' };
  return <span className={`px-1.5 py-0.5 text-[9px] font-bold rounded ${info.cls}`}>{info.label}</span>;
};

const DispositionIcon = ({ type }: { type: string }) => {
  const map: Record<string, { label: string; color: string }> = {
    IN_USE: { label: 'In Use', color: 'bg-blue-500' },
    EMBEDDED: { label: 'Embedded', color: 'bg-purple-500' },
    CONSUMED: { label: 'Consumed', color: 'bg-amber-500' },
    DAMAGED: { label: 'Damaged', color: 'bg-red-500' },
    LONG_TERM_LOAN: { label: 'Long-term', color: 'bg-indigo-500' },
    RETURNED_GOOD: { label: 'Returned OK', color: 'bg-green-500' },
    RETURNED_DAMAGED: { label: 'Returned Dmg', color: 'bg-orange-500' },
    DISPOSED: { label: 'Disposed', color: 'bg-muted' },
  };
  const info = map[type] || { label: type, color: 'bg-faint' };
  return (
    <div className="flex items-center gap-2">
      <div className={`w-3 h-3 rounded-full ${info.color}`} />
      <span className="text-sm text-ink">{info.label}</span>
    </div>
  );
};

const fmtTime = (ts: string) => fmtRelativeTime(ts, { justNow: true, days: true });

/**
 * Every disposition a request can end in, shown whether or not any item is in
 * it — the same way the Fixed Assets card lists all four asset conditions
 * including the zeros.
 *
 * The backend groups by disposition over rows that HAVE one, so a state nobody
 * has used yet simply does not come back. That left this card with two rows
 * beside a neighbour with seven, and 192px of void under it. It also left the
 * reader unable to tell "nothing is damaged" from "damaged is not a thing we
 * track".
 */
const ALL_DISPOSITIONS = [
  'IN_USE', 'EMBEDDED', 'CONSUMED', 'DAMAGED',
  'LONG_TERM_LOAN', 'RETURNED_GOOD', 'RETURNED_DAMAGED', 'DISPOSED',
] as const;

export const InventoryDashboardPage = () => {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showReceive, setShowReceive] = useState(false);
  // Indent id to pre-select when the modal opens. Set by the `?openReceive=`
  // query param coming from the Items-received notification. Lifted to the
  // page so the param-clearing happens here too — we don't want the modal
  // re-opening on every render after the user closes it.
  const [preselectReceiveId, setPreselectReceiveId] = useState<string | null>(null);

  // Watch the URL for ?openReceive=<id> and open the modal pre-selected.
  // Consumes the param (removes it from the URL) so a subsequent close +
  // re-open of the modal doesn't keep re-pre-selecting the same indent.
  useEffect(() => {
    const id = searchParams.get('openReceive');
    if (id) {
      setPreselectReceiveId(id);
      setShowReceive(true);
      const next = new URLSearchParams(searchParams);
      next.delete('openReceive');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);
  // Asset-side tile data — inventory clerks are the day-to-day stewards
  // of maintenance + warranty. Without surfacing this here they only see
  // the bell notifications, which is easy to miss in a busy console. The
  // four attention counts come from the asset stats aggregate (no
  // full-list pull); INVENTORY is in the stats endpoint's read roles.
  const [assetStats, setAssetStats] = useState<any>(null);

  const loadStats = () => {
    setLoading(true);
    client.get('/inventory/dashboard/stats')
      .then(res => setStats(res.data?.data || res.data))
      .catch(err => logError('InventoryDashboard.stats', err))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadStats(); }, []);

  // Fixed-asset tile fetch (independent — non-fatal on failure). Reads the
  // four attention counts from the stats aggregate rather than pulling the
  // full asset list to bucket client-side.
  useEffect(() => {
    // Abort on unmount. A dashboard is the page people land on and click
    // straight off, so these are the requests most likely to be in flight
    // when it goes — and an abandoned GET is wasted server work plus a bare
    // `Network Error` indistinguishable from the backend being down.
    const abort = new AbortController();
    client.get('/fixed-assets/stats', { signal: abort.signal })
      .then(({ data }) => setAssetStats(data.data ?? data))
      .catch(err => logError('InventoryDashboard.assetStats', err));
    return () => abort.abort();
  }, []);

  // Map the backend stat field names (maintenance*/warranty*) onto the
  // maint*/warranty* names the tiles render. Same buckets as before:
  // maintDue7 = due within 7d, warrantyDue30 = expiring within 30d.
  const assetSummary = {
    maintDue7: assetStats?.maintenanceDue7 ?? 0,
    maintOverdue: assetStats?.maintenanceOverdue ?? 0,
    warrantyDue30: assetStats?.warrantyDue30 ?? 0,
    warrantyExpired: assetStats?.warrantyExpired ?? 0,
  };

  if (loading) return (
    <BrandLoader />
  );
  if (!stats) return <div className="text-center text-muted py-12">Failed to load dashboard</div>;

  const maxCatStock = Math.max(...(stats.stockByCategory?.map((s: any) => s.totalStock) || [1]), 1);
  const totalDispositionCount = (stats.dispositionBreakdown || []).reduce((sum: number, d: any) => sum + d.count, 0);

  // Audit summary
  const auditBalance = (stats.totalReceived || 0) - (stats.totalIssued || 0) + (stats.totalReturned || 0) - (stats.totalDisposed || 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Inventory Dashboard</h2>
          <p className="text-sm md:text-[15px] text-muted mt-1.5">Real-time overview of inventory health and activity</p>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setShowReceive(true)} className="flex items-center gap-2 px-4 py-2 bg-green-700 text-white font-bold rounded-md hover:bg-green-800 transition-colors text-sm">
            <Truck size={16} /> Receive from Procurement
          </button>
          <div className="hidden md:flex items-center gap-2 text-xs text-faint">
            <Activity size={14} />
            {new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      </div>

      {/* Fixed-asset attention band — only renders when there's work to
          do, so the dashboard stays clean for healthy states. Inventory
          clerks are the ones who actually perform maintenance, so this
          surface sits between the page header and the inventory metrics. */}
      {(assetSummary.maintDue7 > 0 || assetSummary.maintOverdue > 0 ||
        assetSummary.warrantyDue30 > 0 || assetSummary.warrantyExpired > 0) && (
        <div>
          <h3 className="text-sm font-bold text-ink mb-3 flex items-center gap-2">
            <Wrench size={14} className="text-brand" /> Fixed Assets — needs attention
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(assetSummary.maintDue7 > 0 || assetSummary.maintOverdue > 0) && (
              <button
                onClick={() => navigate('/inventory/fixed-assets')}
                className={`text-left bg-card rounded-xl shadow-sm border p-4 transition-colors group ${
                  assetSummary.maintOverdue > 0 ? 'border-red-200 dark:border-red-400/30 bg-red-50/40 dark:bg-red-400/15 hover:bg-red-50/70 dark:bg-red-400/15'
                                                : 'border-amber-200 dark:border-amber-400/30 bg-amber-50/40 dark:bg-amber-400/15 hover:bg-amber-50/70 dark:bg-amber-400/15'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Wrench size={16} className="text-amber-700 dark:text-amber-300" />
                  <p className="text-[10px] text-muted uppercase font-bold tracking-wider">Maintenance due</p>
                </div>
                <p className="text-2xl font-bold text-ink mt-2">
                  {assetSummary.maintDue7} <span className="text-sm font-normal text-muted">within 7 days</span>
                </p>
                {assetSummary.maintOverdue > 0 && (
                  <p className="text-[11px] text-red-700 dark:text-red-300 font-bold mt-1">⚠ {assetSummary.maintOverdue} already overdue</p>
                )}
                <p className="text-[10px] text-faint mt-2 inline-flex items-center gap-0.5 group-hover:text-brand group-hover:underline">
                  Open Fixed Assets <ChevronRight size={11} />
                </p>
              </button>
            )}
            {(assetSummary.warrantyDue30 > 0 || assetSummary.warrantyExpired > 0) && (
              <button
                onClick={() => navigate('/inventory/fixed-assets')}
                className={`text-left bg-card rounded-xl shadow-sm border p-4 transition-colors group ${
                  assetSummary.warrantyExpired > 0 ? 'border-red-200 dark:border-red-400/30 bg-red-50/40 dark:bg-red-400/15 hover:bg-red-50/70 dark:bg-red-400/15'
                                                  : 'border-amber-200 dark:border-amber-400/30 bg-amber-50/40 dark:bg-amber-400/15 hover:bg-amber-50/70 dark:bg-amber-400/15'
                }`}
              >
                <div className="flex items-center gap-2">
                  <ShieldCheck size={16} className="text-amber-700 dark:text-amber-300" />
                  <p className="text-[10px] text-muted uppercase font-bold tracking-wider">Warranty expiring</p>
                </div>
                <p className="text-2xl font-bold text-ink mt-2">
                  {assetSummary.warrantyDue30} <span className="text-sm font-normal text-muted">within 30 days</span>
                </p>
                {assetSummary.warrantyExpired > 0 && (
                  <p className="text-[11px] text-red-700 dark:text-red-300 font-bold mt-1">⚠ {assetSummary.warrantyExpired} already expired</p>
                )}
                <p className="text-[10px] text-faint mt-2 inline-flex items-center gap-0.5 group-hover:text-brand group-hover:underline">
                  Open Fixed Assets <ChevronRight size={11} />
                </p>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Metric Cards — always complete rows: 1 col mobile, 3 col sm+ */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Unique Items" value={stats.totalUniqueItems} icon={Package} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300" accent
          onClick={() => navigate(`/inventory/components?scrollTo=${stats.totalUniqueItems}`)}
          tooltip="Total number of distinct products in inventory. Click to scroll to the last item." />
        <StatCard label="Total In Stock" value={fmtInt(stats.totalInStock)} icon={Archive} color="bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300"
          onClick={() => navigate('/inventory/components?stockFilter=available')}
          tooltip="Sum of current stock counts across all items. Click to view available items." />
        <StatCard label="Currently Issued" value={stats.inUseCount} icon={ArrowUpFromLine} color="bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300"
          onClick={() => navigate('/inventory/lab-items?tab=issued')}
          tooltip="Items currently in use by lab users. Click to see who has what." />

        <StatCard label="Total Received" value={fmtInt(stats.totalReceived)} icon={ArrowDownToLine} color="bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300" sub="Lifetime inflow"
          onClick={() => navigate('/inventory/history')}
          tooltip="Total units ever received into inventory from procurement. Click to view receive events." />
        <StatCard label="Total Returned" value={fmtInt(stats.totalReturned)} icon={RotateCcw} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300" sub="Lifetime returns"
          onClick={() => navigate('/inventory/returns?tab=history')}
          tooltip="Total units returned back to inventory by users. Click to view return history." />
        <StatCard label="Disposed / Written Off" value={fmtInt(stats.totalDisposed)} icon={Trash2} color="bg-hover text-secondary" sub="Lifetime"
          onClick={() => navigate('/inventory/history')}
          tooltip="Items permanently removed — damaged, consumed, or written off. Click to view audit trail." />

        <StatCard label="Overdue Alerts" value={stats.overdueCount} icon={AlertTriangle} color={stats.overdueCount > 0 ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300' : 'bg-surface text-faint'} accent={stats.overdueCount > 0}
          onClick={() => navigate('/inventory/lab-items?tab=overdue')}
          tooltip="Requests past their due date that haven't been returned. Click to view overdue items." />
        <StatCard label="Low Stock" value={stats.lowStockCount} icon={TrendingDown} color={stats.lowStockCount > 0 ? 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300' : 'bg-surface text-faint'} sub="Stock between 1–9"
          onClick={() => navigate('/inventory/components?stockFilter=low')}
          tooltip="Items with critically low stock (1-9 units remaining). Click to view only low stock items." />
        <StatCard label="Out of Stock" value={stats.outOfStockCount} icon={AlertTriangle} color={stats.outOfStockCount > 0 ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300' : 'bg-surface text-faint'} accent={stats.outOfStockCount > 0} sub="Zero stock"
          onClick={() => navigate('/inventory/components?stockFilter=out')}
          tooltip="Items completely out of stock (0 units). Click to view only out-of-stock items." />
      </div>

      {/* Audit Balance Card */}
      <div className="bg-card rounded-xl border border-line-soft shadow-sm p-5 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-brand/10 flex items-center justify-center">
            <Eye className="w-5 h-5 text-brand" />
          </div>
          <div>
            <p className="text-sm font-bold text-ink">Audit Balance Check</p>
            <p className="text-[10px] text-faint">Received − Issued + Returned − Disposed</p>
          </div>
        </div>
        <div className="flex items-center gap-6 text-sm">
          <span className="text-green-700 dark:text-green-300 font-mono font-bold">+{fmtInt(stats.totalReceived)} in</span>
          <span className="text-red-700 dark:text-red-300 font-mono font-bold">−{fmtInt(stats.totalIssued)} out</span>
          <span className="text-blue-600 dark:text-blue-300 font-mono font-bold">+{fmtInt(stats.totalReturned)} rtn</span>
          <span className="text-muted font-mono font-bold">−{fmtInt(stats.totalDisposed)} disposed</span>
          <span className="px-3 py-1 bg-brand/10 rounded-full font-bold text-ink">= {fmtInt(auditBalance)}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Stock by Category */}
        {/* `h-full flex flex-col` on both cards in this row, and `flex-1` on
            the list inside: they are grid items stretched to match each other,
            and whichever has fewer rows was pinning its content to the top of
            the height it had been given — 67px of void under seven categories
            beside eight dispositions. The row counts differ with the data, so
            either card can be the short one. */}
        <div className="bg-card rounded-xl border border-line-soft shadow-sm p-6 flex h-full flex-col">
          <h3 className="text-sm font-bold text-ink mb-4 flex items-center gap-2"><Zap size={14} className="text-brand" /> Stock by Category</h3>
          <div className="flex flex-1 flex-col justify-between gap-2.5">
            {(stats.stockByCategory || []).sort((a: any, b: any) => b.totalStock - a.totalStock).map((cat: any) => (
              <div key={cat.category} className="group">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[11px] text-muted font-medium truncate max-w-[200px]">{cat.category?.replace(/_/g, ' ')}</span>
                  <span className="text-[11px] font-bold text-ink">{fmtInt(cat.totalStock)} <span className="text-faint font-normal">({cat.itemCount})</span></span>
                </div>
                <div className="bg-hover rounded-full h-3 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-brand to-brand-dark rounded-full transition-all duration-500"
                    style={{ width: `${Math.max(3, (cat.totalStock / maxCatStock) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {(!stats.stockByCategory || stats.stockByCategory.length === 0) && (
              <p className="text-sm text-faint text-center py-4">No category data</p>
            )}
          </div>
        </div>

        {/* Disposition Breakdown */}
        <div className="bg-card rounded-xl border border-line-soft shadow-sm p-6 flex h-full flex-col">
          <h3 className="text-sm font-bold text-ink mb-4 flex items-center gap-2"><Clock size={14} className="text-brand" /> Item Disposition Tracker</h3>
          {totalDispositionCount > 0 ? (
            <div className="flex flex-1 flex-col justify-between gap-3">
              {ALL_DISPOSITIONS.map((type) => ({
                disposition: type,
                count: (stats.dispositionBreakdown || []).find((d: any) => d.disposition === type)?.count ?? 0,
              })).sort((a: any, b: any) => b.count - a.count).map((d: any) => (
                <div key={d.disposition} className="flex items-center justify-between py-2 border-b border-line-soft last:border-0">
                  <DispositionIcon type={d.disposition} />
                  <div className="flex items-center gap-3">
                    <div className="bg-hover rounded-full h-2 w-24 overflow-hidden">
                      <div className="h-full bg-brand rounded-full" style={{ width: `${totalDispositionCount > 0 ? (d.count / totalDispositionCount) * 100 : 0}%` }} />
                    </div>
                    <span className="text-sm font-bold text-ink w-8 text-right">{d.count}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-sm text-faint">No disposition data yet</p>
              <p className="text-xs text-faint mt-1">Items will appear here once issued and tracked</p>
            </div>
          )}
        </div>
      </div>

      {/* Recent Activity Timeline */}
      <div className="bg-card rounded-xl border border-line-soft shadow-sm p-6">
        <h3 className="text-sm font-bold text-ink mb-4 flex items-center gap-2"><Activity size={14} className="text-brand" /> Recent Activity</h3>
        <div className="max-h-[320px] overflow-y-auto space-y-0">
          {(stats.recentEvents || []).map((evt: any) => (
            <div key={evt.id} className="flex items-start gap-3 py-3 border-b border-line-soft last:border-0 hover:bg-surface/50 -mx-2 px-2 rounded-lg transition-colors">
              <div className="mt-1 shrink-0">
                <div className={`w-2.5 h-2.5 rounded-full ${
                  evt.eventType === 'STOCK_IN' || evt.eventType === 'RETURN' ? 'bg-green-500'
                  : evt.eventType === 'STOCK_OUT' ? 'bg-red-500'
                  : evt.eventType === 'ADJUSTMENT' ? 'bg-amber-500'
                  : evt.eventType === 'DISPOSITION_CHANGE' ? 'bg-purple-500'
                  : 'bg-faint'
                }`} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-ink">{evt.inventoryItem?.name || 'Unknown'}</span>
                  <EventBadge type={evt.eventType} />
                  <span className={`text-sm font-bold ${evt.quantityChange >= 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                    {evt.quantityChange >= 0 ? '+' : ''}{evt.quantityChange} {evt.inventoryItem?.unit || ''}
                  </span>
                </div>
                {evt.notes && <p className="text-[11px] text-faint mt-0.5 truncate">{evt.notes}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] text-faint">{fmtTime(evt.createdAt)}</p>
                <p className="text-[10px] text-muted">{evt.performedBy?.name}</p>
              </div>
            </div>
          ))}
          {(!stats.recentEvents || stats.recentEvents.length === 0) && (
            <div className="text-center py-8">
              <p className="text-sm text-faint">No activity recorded yet</p>
              <p className="text-xs text-faint mt-1">Events appear as items are received, issued, returned, and tracked</p>
            </div>
          )}
        </div>
      </div>

      <ReceiveIndentModal
        isOpen={showReceive}
        onClose={() => { setShowReceive(false); setPreselectReceiveId(null); }}
        onReceived={loadStats}
        preselectIndentId={preselectReceiveId}
      />
    </div>
  );
};
