import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '@/api';
import { logError } from '@/lib';
import { fmtInt, fmtINR } from '@/utils/number';
import { fmtRelativeTime } from '@/utils/date';
import { palette } from '@/lib/palette';
import { StatCard, BrandLoader } from '@/components/ui';
import {
  Users, Building2, FolderKanban, Package, AlertTriangle, TrendingDown,
  ArrowUpFromLine, CreditCard, Truck, CheckCircle, Archive, RotateCcw,
  Wrench, Activity, IndianRupee, ShieldCheck, Clock, Flame
} from 'lucide-react';

const SectionTitle = ({ icon: Icon, title }: { icon: any; title: string }) => (
  <h3 className="text-sm font-bold text-ink flex items-center gap-2 mb-3">
    <Icon size={14} className="text-brand" /> {title}
  </h3>
);

// Per-stage status colours for the procurement pipeline. Reinstated from the
// old PipelineBadge so each stage reads as its own semantic colour (Pending →
// grey, Approved → green, Finance → amber, …) instead of a uniform amber bar.
const PIPE_STAGE_COLOR: Record<string, string> = {
  PENDING: 'bg-faint', APPROVED: 'bg-green-500', QUOTATION_IN_PROGRESS: 'bg-blue-500',
  AWAITING_PAYMENT: 'bg-amber-500', PAYMENT_DONE: 'bg-emerald-500',
  ORDERED: 'bg-purple-500', IN_TRANSIT: 'bg-cyan-500', PARTIALLY_RECEIVED: 'bg-teal-500',
};

const fmtTime = (ts: string) => fmtRelativeTime(ts);

export const SuperAdminDashboardPage = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<any>(null);
  const [assetStats, setAssetStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Abort on unmount, rather than letting these dangle.
    //
    // Without it, leaving the page while either request is in flight leaves
    // the browser to kill it — and axios reports a request killed that way as
    // a bare `Network Error`, the same text it uses when the server is
    // genuinely unreachable. So walking away from this dashboard wrote two
    // console errors that read exactly like a backend outage. Chromium
    // finished fast enough to usually avoid it; on WebKit it happened on
    // essentially every visit, which is how the cross-browser run surfaced it.
    //
    // With a signal the cancellation is explicit (`ERR_CANCELED`), so
    // logError can tell "nobody is waiting for this" from "this failed", and
    // the state setters below cannot fire after unmount either.
    const abort = new AbortController();

    client.get('/admin/dashboard', { signal: abort.signal })
      .then(res => setStats(res.data?.data || res.data))
      .catch(err => logError('SuperAdminDashboard', err))
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });

    // Tangible/intangible split + book value — independent of the main
    // admin/dashboard endpoint so it can fail without dropping the page.
    client.get('/fixed-assets/stats', { signal: abort.signal })
      .then(res => setAssetStats(res.data?.data ?? res.data))
      .catch(err => logError('SuperAdminDashboard.assets', err));

    return () => abort.abort();
  }, []);

  if (loading) return <BrandLoader />;
  if (!stats) return <div className="text-center text-muted py-12">Failed to load dashboard</div>;

  const getRoleCount = (role: string) => stats.usersByRole?.find((r: any) => r.role === role)?.count || 0;
  const getReqCount = (s: string) => stats.requestBreakdown?.find((r: any) => r.status === s)?.count || 0;
  const getAssetCond = (c: string) => stats.assetsByCondition?.find((a: any) => a.condition === c)?.count || 0;

  const pipelineStages = [
    { key: 'PENDING', label: 'Pending' }, { key: 'APPROVED', label: 'Approved' },
    { key: 'QUOTATION_IN_PROGRESS', label: 'Quoting' },
    { key: 'AWAITING_PAYMENT', label: 'Finance' }, { key: 'PAYMENT_DONE', label: 'Paid' },
    { key: 'ORDERED', label: 'Ordered' }, { key: 'IN_TRANSIT', label: 'Transit' },
    { key: 'PARTIALLY_RECEIVED', label: 'Partial' },
  ];
  const getPipeCount = (s: string) => stats.indentPipeline?.find((i: any) => i.status === s)?.count || 0;
  const maxPipe = Math.max(...pipelineStages.map(s => getPipeCount(s.key)), 1);


  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Command Center</h2>
          <p className="text-sm md:text-[15px] text-muted mt-1.5">Global overview across all operations</p>
        </div>
      </div>

      {/* Organization */}
      <div>
        <SectionTitle icon={Building2} title="Organization" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <StatCard label="Total Users" value={stats.totalUsers} icon={Users} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300"
            sub={`${getRoleCount('ADMIN')} admins · ${getRoleCount('MANAGER')} managers · ${getRoleCount('USER')} users`}
            onClick={() => navigate('/super-admin/users')} tooltip="Manage users" />
          <StatCard label="Departments" value={stats.totalDepartments} icon={Building2} color="bg-indigo-50 dark:bg-indigo-400/15 text-indigo-600 dark:text-indigo-300"
            onClick={() => navigate('/super-admin/departments')} tooltip="View departments" />
          <StatCard label="Active Projects" value={stats.totalProjects} icon={FolderKanban} color="bg-purple-50 dark:bg-purple-400/15 text-purple-600 dark:text-purple-300"
            onClick={() => navigate('/super-admin/projects')} tooltip="Manage projects" />
        </div>
      </div>

      {/* Inventory + Procurement side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inventory Health */}
        <div>
          <SectionTitle icon={Package} title="Inventory Health" />
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Unique Items" value={stats.totalUniqueItems} icon={Package} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300"
              onClick={() => navigate('/super-admin/inventory')} />
            <StatCard label="Total In Stock" value={fmtInt(stats.totalInStock)} icon={Archive} color="bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300"
              onClick={() => navigate('/super-admin/inventory')} />
            <StatCard label="Currently Issued" value={stats.currentlyIssued} icon={ArrowUpFromLine} color="bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300"
              onClick={() => navigate('/super-admin/lab?tab=issued')} />
            <StatCard label="Overdue Returns" value={stats.overdueRequests} icon={AlertTriangle}
              color={stats.overdueRequests > 0 ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300' : 'bg-surface text-faint'}
              accent={stats.overdueRequests > 0} 
              onClick={() => navigate('/super-admin/lab?tab=overdue')} />
            <StatCard label="Low Stock" value={stats.lowStock} icon={TrendingDown}
              color={stats.lowStock > 0 ? 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300' : 'bg-surface text-faint'} 
              onClick={() => navigate('/super-admin/inventory?stock=low')} />
            <StatCard label="Out of Stock" value={stats.outOfStock} icon={Flame}
              color={stats.outOfStock > 0 ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300' : 'bg-surface text-faint'}
              accent={stats.outOfStock > 0} 
              onClick={() => navigate('/super-admin/inventory?stock=out')} />
          </div>
        </div>

        {/* Procurement Pipeline */}
        <div>
          <SectionTitle icon={Truck} title="Procurement Pipeline" />
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
            <StatCard label="Active Indents" value={stats.activeIndents} icon={CreditCard} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300" accent
              onClick={() => navigate('/super-admin/history?tab=indents&filter=active')} />
            <StatCard label="Awaiting Payment" value={stats.awaitingPayment} icon={Clock}
              color={stats.awaitingPayment > 0 ? 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300' : 'bg-surface text-faint'}
              accent={stats.awaitingPayment > 0}
              tooltip="Indents whose vendor & quote are finalized, waiting for Finance to mark as paid"
              onClick={() => navigate('/super-admin/history?tab=indents&filter=active')} />
            <StatCard label="Pending Tech Approval" value={stats.pendingTechApproval} icon={Wrench}
              color={stats.pendingTechApproval > 0 ? 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300' : 'bg-surface text-faint'}
              accent={stats.pendingTechApproval > 0}
              onClick={() => navigate('/super-admin/approvals?filter=tech')} />
            <StatCard label="Pending CEO Approval" value={stats.pendingCeoApproval} icon={ShieldCheck}
              color={stats.pendingCeoApproval > 0 ? 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300' : 'bg-surface text-faint'}
              accent={stats.pendingCeoApproval > 0}
              onClick={() => navigate('/super-admin/approvals?filter=ceo')} />
            <StatCard label="Approved Spend" value={fmtINR(stats.totalSpendApproved, { nullish: '₹0' })} icon={IndianRupee} color="bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300"
              onClick={() => navigate('/super-admin/history?tab=indents&filter=approved')} />
            <StatCard label="Received Value" value={fmtINR(stats.totalSpendReceived, { nullish: '₹0' })} icon={CheckCircle} color="bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300"
              onClick={() => navigate('/super-admin/history?tab=indents&filter=received')} />
          </div>
          {/* Mini pipeline bar */}
          <div className="bg-card rounded-xl border border-line-soft p-4">
            <div className="flex items-end gap-1 overflow-x-auto">
              {pipelineStages.map(stage => {
                const count = getPipeCount(stage.key);
                const h = Math.max(12, (count / maxPipe) * 60);
                const dest = stage.key === 'PENDING' ? '/super-admin/approvals' : '/super-admin/history?tab=indents';
                return (
                  <div key={stage.key} className="flex flex-col items-center flex-1 min-w-[40px] cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate(dest)}>
                    <span className="text-xs font-bold text-ink mb-1">{count}</span>
                    <div className="w-full rounded-t" style={{ height: h, backgroundColor: count > 0 ? palette.brand : palette.empty }} />
                    <div className="flex items-center gap-1 mt-1">
                      {/* Per-stage status dot — dimmed when the stage is empty. */}
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${count > 0 ? (PIPE_STAGE_COLOR[stage.key] || 'bg-line') : 'bg-line'}`} />
                      <p className="text-[7px] text-faint text-center">{stage.label}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Fixed Assets + Alerts side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Fixed Assets */}
        {/* `h-full flex flex-col` + `justify-between` on the body: this card is
            a grid item beside a taller one, so it is STRETCHED to match and its
            content was pinned to the top, leaving 80px of void underneath while
            the card next to it had 18. Filling the height it is given reads as
            a card; sitting at the top of it reads as a bug. */}
        <div className="bg-card rounded-xl border border-line-soft shadow-sm p-5 flex h-full flex-col">
          <SectionTitle icon={ShieldCheck} title="Fixed Assets" />
          {/* Tangible / Intangible split chips — drives the high-signal
              dashboard ask. Falls back to plain total if the asset-stats
              endpoint didn't load (independent failure path). */}
          {assetStats?.byType && (
            <div className="flex items-center gap-2 mb-3 flex-wrap">
              <span className="text-[10px] font-bold px-2 py-1 rounded border bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-400/30">
                {assetStats.byType.tangible} tangible
              </span>
              <span className="text-[10px] font-bold px-2 py-1 rounded border bg-sky-50 dark:bg-sky-400/15 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-400/30">
                {assetStats.byType.intangible} intangible
              </span>
              {assetStats.byOwnership?.shared > 0 && (
                <span className="text-[10px] font-bold px-2 py-1 rounded border bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30">
                  {assetStats.byOwnership.shared} shared
                </span>
              )}
              {assetStats.totalCurrentValue > 0 && (
                <span className="text-[10px] font-bold px-2 py-1 rounded border bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30">
                  ₹{Number(assetStats.totalCurrentValue).toLocaleString('en-IN')} book value
                </span>
              )}
            </div>
          )}
          <div className="flex flex-1 items-center gap-6">
            <div className="cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate('/super-admin/inventory')}><p className="text-3xl font-bold text-ink">{stats.totalFixedAssets}</p><p className="text-xs text-muted">Total Assets</p></div>
            <div className="flex-1 space-y-3">
              {[
                { key: 'WORKING', label: 'Working', color: 'bg-green-500' },
                { key: 'NEEDS_REPAIR', label: 'Needs Repair', color: 'bg-amber-500' },
                { key: 'DAMAGED', label: 'Damaged', color: 'bg-red-500' },
                { key: 'DISPOSED', label: 'Disposed', color: 'bg-faint' },
              ].map(c => {
                const count = getAssetCond(c.key);
                const pct = stats.totalFixedAssets > 0 ? (count / stats.totalFixedAssets) * 100 : 0;
                return (
                  <div key={c.key} className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate('/super-admin/inventory')}>
                    <div className={`w-2 h-2 rounded-full ${c.color}`} />
                    <span className="text-[10px] text-muted w-20">{c.label}</span>
                    <div className="flex-1 bg-hover rounded-full h-2 overflow-hidden">
                      <div className={`h-full rounded-full ${c.color}`} style={{ width: `${Math.max(2, pct)}%` }} />
                    </div>
                    <span className="text-[10px] font-bold text-ink w-6 text-right">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Component Requests Breakdown */}
        <div className="bg-card rounded-xl border border-line-soft shadow-sm p-5">
          <SectionTitle icon={RotateCcw} title="Component Requests" />
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {[
              { s: 'PENDING', label: 'Pending', color: 'text-amber-700 dark:text-amber-300', dest: '/super-admin/approvals' },
              { s: 'APPROVED', label: 'Approved', color: 'text-green-700 dark:text-green-300', dest: '/super-admin/history?tab=requests&filter=approved' },
              { s: 'IN_USE', label: 'Issued', color: 'text-blue-600 dark:text-blue-300', dest: '/super-admin/lab?tab=issued' },
              { s: 'OVERDUE', label: 'Overdue', color: 'text-red-700 dark:text-red-300', dest: '/super-admin/lab?tab=overdue' },
              { s: 'RETURN_REQUESTED', label: 'Return Requested', color: 'text-orange-600 dark:text-orange-300', dest: '/super-admin/lab?tab=return_requested' },
              { s: 'RETURNED', label: 'Returned', color: 'text-teal-600 dark:text-teal-300', dest: '/super-admin/history?tab=requests&filter=completed' },
              { s: 'EMBEDDED', label: 'Embedded', color: 'text-purple-600 dark:text-purple-300', dest: '/super-admin/history?tab=requests&filter=completed' },
              { s: 'CONSUMED', label: 'Consumed', color: 'text-pink-600 dark:text-pink-300', dest: '/super-admin/history?tab=requests&filter=completed' },
              { s: 'DISPOSED', label: 'Disposed', color: 'text-muted', dest: '/super-admin/history?tab=requests&filter=completed' },
            ].map(r => (
              <div key={r.s} className="text-center py-2 cursor-pointer hover:opacity-80 transition-opacity" onClick={() => navigate(r.dest)}>
                <p className={`text-xl font-bold ${r.color}`}>{getReqCount(r.s)}</p>
                <p className="text-[9px] text-muted">{r.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Combined Activity Feed */}
      <div className="bg-card rounded-xl border border-line-soft shadow-sm p-5">
        <SectionTitle icon={Activity} title="Recent Activity" />
        <div className="max-h-[300px] overflow-y-auto space-y-0">
          {/* Merge and sort both feeds */}
          {[
            ...(stats.recentIndentLogs || []).map((l: any) => ({
              id: l.id, time: l.createdAt, type: 'indent',
              text: `${l.indent?.serialNo} → ${l.toStatus?.replace(/_/g, ' ')}`,
              by: l.changedBy?.name, notes: l.notes,
            })),
            ...(stats.recentInventoryEvents || []).map((e: any) => ({
              id: e.id, time: e.createdAt, type: 'inventory',
              text: `${e.inventoryItem?.name} ${e.quantityChange >= 0 ? '+' : ''}${e.quantityChange} ${e.inventoryItem?.unit || ''}`,
              by: e.performedBy?.name, notes: e.notes,
            })),
          ].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()).slice(0, 15).map(item => (
            <div key={item.id} className="flex items-start gap-3 py-2.5 border-b border-line-soft last:border-0">
              <div className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${item.type === 'indent' ? 'bg-brand' : 'bg-blue-500'}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ink">{item.text}</p>
                {item.notes && <p className="text-[10px] text-faint truncate">{item.notes}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="text-[10px] text-faint">{fmtTime(item.time)}</p>
                <p className="text-[10px] text-muted">{item.by}</p>
              </div>
            </div>
          ))}
          {(!stats.recentIndentLogs?.length && !stats.recentInventoryEvents?.length) && (
            <p className="text-sm text-faint text-center py-6">No recent activity</p>
          )}
        </div>
      </div>
    </div>
  );
};
