import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '@/api';
import { logError } from '@/lib';
import { fmtINR } from '@/utils/number';
import { fmtRelativeTime } from '@/utils/date';
import { StatCard, BrandLoader } from '@/components/ui';
import { ClipboardList, CreditCard, Truck, AlertTriangle, CheckCircle, XCircle, Package, Activity, IndianRupee } from 'lucide-react';

const StatusBadge = ({ status }: { status: string }) => {
  const map: Record<string, string> = {
    PENDING: 'bg-hover text-secondary',
    APPROVED: 'bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300',
    REJECTED: 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300',
    QUOTATION_IN_PROGRESS: 'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300',
    AWAITING_PAYMENT: 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300',
    PAYMENT_DONE: 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300',
    ORDERED: 'bg-purple-50 dark:bg-purple-400/15 text-purple-700 dark:text-purple-300',
    IN_TRANSIT: 'bg-cyan-50 dark:bg-cyan-400/15 text-cyan-700 dark:text-cyan-300',
    PARTIALLY_RECEIVED: 'bg-lime-50 dark:bg-lime-400/15 text-lime-700 dark:text-lime-300',
    RECEIVED: 'bg-green-100 dark:bg-green-400/20 text-green-800 dark:text-green-200',
    CANCELLED: 'bg-line text-secondary',
  };
  return <span className={`px-2 py-0.5 text-[9px] font-bold rounded-full ${map[status] || 'bg-hover text-secondary'}`}>{status?.replace(/_/g, ' ')}</span>;
};

const fmtTime = (ts: string) => fmtRelativeTime(ts, { days: true });

export const ProcurementDashboardPage = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Abort on unmount. A dashboard is the page people land on and click
    // straight off, so these are the requests most likely to be in flight
    // when it goes — and an abandoned GET is wasted server work plus a bare
    // `Network Error` indistinguishable from the backend being down.
    const abort = new AbortController();
    client.get('/indents/dashboard/stats', { signal: abort.signal })
      .then(res => setStats(res.data?.data || res.data))
      .catch(err => logError('ProcurementDashboard.stats', err))
      .finally(() => setLoading(false));
    return () => abort.abort();
  }, []);

  if (loading) return <BrandLoader />;
  if (!stats) return <div className="text-center text-muted py-12">Failed to load dashboard</div>;

  const statusBreakdown = stats.statusBreakdown || [];
  const getCount = (s: string) => statusBreakdown.find((b: any) => b.status === s)?.count || 0;

  // Pipeline data for the visual
  const pipeline = [
    { key: 'PENDING', label: 'Pending', count: getCount('PENDING'), color: 'bg-faint' },
    { key: 'APPROVED', label: 'Approved', count: getCount('APPROVED'), color: 'bg-green-500' },
    { key: 'QUOTATION_IN_PROGRESS', label: 'Quoting', count: getCount('QUOTATION_IN_PROGRESS'), color: 'bg-blue-500' },
    { key: 'AWAITING_PAYMENT', label: 'Finance', count: getCount('AWAITING_PAYMENT'), color: 'bg-amber-500' },
    { key: 'PAYMENT_DONE', label: 'Paid', count: getCount('PAYMENT_DONE'), color: 'bg-emerald-500' },
    { key: 'ORDERED', label: 'Ordered', count: getCount('ORDERED'), color: 'bg-purple-500' },
    { key: 'IN_TRANSIT', label: 'In Transit', count: getCount('IN_TRANSIT'), color: 'bg-cyan-500' },
    { key: 'PARTIALLY_RECEIVED', label: 'Partial', count: getCount('PARTIALLY_RECEIVED'), color: 'bg-lime-500' },
  ];

  // Spend bars cover every pipeline stage, zeros included, so the card reads
  // as the same eight stages the Indent Pipeline above it shows — plus any
  // status outside the pipeline that actually carries money (RECEIVED does).
  // Showing only the stages with spend meant four bars under a card sized for
  // the list beside it.
  const spendByStage = [
    ...pipeline.map((p) => p.key),
    ...statusBreakdown.filter((s: any) => s.totalSpend > 0).map((s: any) => s.status),
  ]
    .filter((status, i, all) => all.indexOf(status) === i)
    .map((status) => ({
      status,
      totalSpend: statusBreakdown.find((b: any) => b.status === status)?.totalSpend || 0,
    }))
    .sort((a, b) => b.totalSpend - a.totalSpend);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Procurement Dashboard</h2>
          <p className="text-sm md:text-[15px] text-muted mt-1.5">Pipeline overview and action items</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-faint">
          <Activity size={14} />
          {new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
        </div>
      </div>

      {/* Action Cards — 3x3 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Needs My Action" value={stats.needsMyAction} icon={ClipboardList} color="bg-brand/20 text-brand-700" accent
          onClick={() => navigate('/procurement/indents')}
          tooltip="Indents in Approved, Quoting, or Payment Done — procurement needs to act" />
        <StatCard label="Awaiting Payment" value={stats.awaitingPayment} icon={CreditCard}
          color={stats.awaitingPayment > 0 ? 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300' : 'bg-surface text-faint'}
          accent={stats.awaitingPayment > 0}
          onClick={() => navigate('/procurement/indents')}
          tooltip="Indents waiting for finance to process payment" />
        <StatCard label="With Vendors" value={stats.withVendors} icon={Truck} color="bg-purple-50 dark:bg-purple-400/15 text-purple-600 dark:text-purple-300"
          onClick={() => navigate('/procurement/indents')}
          tooltip="Orders placed or in transit from vendors" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total Active" value={stats.totalActive} icon={Package} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300"
          onClick={() => navigate('/procurement/indents')}
          tooltip="All indents in the pipeline (not received/rejected/cancelled)" />
        <StatCard label="Overdue Deliveries" value={stats.overdueDeliveries} icon={AlertTriangle}
          color={stats.overdueDeliveries > 0 ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300' : 'bg-surface text-faint'}
          accent={stats.overdueDeliveries > 0}
          tooltip="Ordered/in-transit items past their expected delivery date" />
        <StatCard label="Received (Completed)" value={getCount('RECEIVED')} icon={CheckCircle} color="bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300"
          tooltip="Indents successfully received into inventory" />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Total Approved Spend" value={fmtINR(stats.totalSpendApproved, { nullish: '₹0' })} icon={IndianRupee} color="bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300"
          tooltip="Grand total of all non-pending, non-rejected indents" />
        <StatCard label="Received Spend" value={fmtINR(stats.totalSpendReceived, { nullish: '₹0' })} icon={IndianRupee} color="bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300"
          tooltip="Total value of items successfully received" />
        <StatCard label="Rejected" value={getCount('REJECTED')} icon={XCircle} color="bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300"
          tooltip="Indents rejected by admin" />
      </div>

      {/* Pipeline Visual */}
      <div className="bg-card rounded-xl border border-line-soft shadow-sm p-6">
        <h3 className="text-sm font-bold text-ink mb-4">Indent Pipeline</h3>
        <div className="flex items-end gap-1 sm:gap-2 overflow-x-auto pb-2">
          {pipeline.map((stage) => {
            const maxCount = Math.max(...pipeline.map(p => p.count), 1);
            const height = Math.max(20, (stage.count / maxCount) * 120);
            return (
              <div key={stage.key} className="flex flex-col items-center flex-1 min-w-[60px]">
                <span className="text-lg font-bold text-ink mb-1">{stage.count}</span>
                <div className={`w-full rounded-t-lg ${stage.color} transition-all`} style={{ height: `${height}px`, opacity: stage.count > 0 ? 1 : 0.2 }} />
                <div className="w-full bg-hover h-1" />
                <p className="text-[9px] text-muted mt-2 text-center font-medium">{stage.label}</p>
              </div>
            );
          })}
        </div>
      </div>

      {/* Two columns: Spend Breakdown + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Spend by Status */}
        {/* `h-full flex flex-col` on both cards in this row, and a `flex-1`
            list inside each: they are grid items stretched to match, and
            whichever is shorter was pinning its rows to the top of the height
            it had been given — Spend by Stage carried 207px of void. */}
        <div className="bg-card rounded-xl border border-line-soft shadow-sm p-6 flex h-full flex-col">
          <h3 className="text-sm font-bold text-ink mb-4">Spend by Stage</h3>
          {spendByStage.some((s) => s.totalSpend > 0) ? (
          <div className="flex flex-1 flex-col justify-between gap-2.5">
            {spendByStage.map((s) => {
              const maxSpend = Math.max(...statusBreakdown.map((b: any) => b.totalSpend || 0), 1);
              return (
                <div key={s.status} className="flex items-center gap-3">
                  <StatusBadge status={s.status} />
                  <div className="flex-1 bg-hover rounded-full h-3 overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-brand to-brand-dark rounded-full" style={{ width: `${Math.max(3, (s.totalSpend / maxSpend) * 100)}%` }} />
                  </div>
                  <span className="text-xs font-bold text-ink w-20 text-right">{fmtINR(s.totalSpend, { nullish: '₹0' })}</span>
                </div>
              );
            })}
          </div>
          ) : (
            <p className="flex-1 text-sm text-faint text-center py-4">No spend data yet</p>
          )}
        </div>

        {/* Recent Activity */}
        <div className="bg-card rounded-xl border border-line-soft shadow-sm p-6 flex h-full flex-col">
          <h3 className="text-sm font-bold text-ink mb-4">Recent Activity</h3>
          {/* `flex-1` so the scroll area takes the height the row actually
              has, `max-h` so an endless activity log cannot set that height
              and strand the nine spend bars beside it in 500px of space. */}
          <div className="flex-1 min-h-0 max-h-[340px] overflow-y-auto space-y-0">
            {(stats.recentLogs || []).map((log: any) => (
              <div key={log.id} className="flex items-start gap-3 py-2.5 border-b border-line-soft last:border-0">
                <div className="mt-1.5 w-2 h-2 rounded-full bg-brand shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-ink">{log.indent?.serialNo || '?'}</span>
                    <StatusBadge status={log.toStatus} />
                  </div>
                  {log.notes && <p className="text-[10px] text-faint mt-0.5 truncate">{log.notes}</p>}
                </div>
                <div className="text-right shrink-0">
                  <p className="text-[10px] text-faint">{fmtTime(log.createdAt)}</p>
                  <p className="text-[10px] text-muted">{log.changedBy?.name}</p>
                </div>
              </div>
            ))}
            {(!stats.recentLogs || stats.recentLogs.length === 0) && (
              <p className="text-sm text-faint text-center py-6">No recent activity</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
