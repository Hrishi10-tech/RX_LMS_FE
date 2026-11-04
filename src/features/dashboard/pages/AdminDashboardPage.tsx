import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '@/api';
import { logError } from '@/lib';
import { PendingCell, StatCard } from '@/components/ui';
import { statusReasonForIndent, statusReasonForRequest } from '@/utils/pendingReason';
import { fmtRelativeTime } from '@/utils/date';
import {
  Users, Package, AlertTriangle, TrendingDown, ArrowUpFromLine,
  Clock, CheckCircle, Flame, Building2, ShieldAlert, ClipboardList, FileText, Activity
} from 'lucide-react';

const fmtTime = (ts: string) => fmtRelativeTime(ts);

export const AdminDashboardPage = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Abort on unmount. A dashboard is the page people land on and click
    // straight off, so these are the requests most likely to be in flight
    // when it goes — and an abandoned GET is wasted server work plus a bare
    // `Network Error` indistinguishable from the backend being down.
    const abort = new AbortController();
    client.get('/admin/dashboard/dept', { signal: abort.signal })
      .then(res => setStats(res.data?.data || res.data))
      .catch(err => logError('AdminDashboard.dept', err))
      .finally(() => setLoading(false));
    return () => abort.abort();
  }, []);

  if (loading) return <div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-7 w-7 border-2 border-line border-t-brand" /></div>;
  if (!stats) return <div className="text-center text-muted py-12">Failed to load dashboard</div>;

  const getReqCount = (s: string) => stats.requestBreakdown?.find((r: any) => r.status === s)?.count || 0;
  const getIndCount = (s: string) => stats.indentBreakdown?.find((i: any) => i.status === s)?.count || 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Department Overview</h2>
        <div className="flex items-center gap-2 mt-1">
          {stats.departments?.map((d: any) => (
            <span key={d.id} className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-md bg-indigo-50 dark:bg-indigo-400/15 text-indigo-700 dark:text-indigo-300 ring-1 ring-inset ring-indigo-600/20 dark:ring-indigo-400/30">
              <Building2 size={11} /> {d.name}
            </span>
          ))}
        </div>
      </div>

      {/* Key metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <StatCard label="Pending Tech Approvals" value={stats.pendingApprovals} icon={Clock}
          color={stats.pendingApprovals > 0 ? 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300' : 'bg-surface text-faint'}
          accent={stats.pendingApprovals > 0}
          onClick={() => navigate('/admin/approvals')} />
        <StatCard label="Team Members" value={stats.users} icon={Users} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300"
          sub={`${stats.managers} managers · ${stats.regularUsers} users`}
          onClick={() => navigate('/admin/users')} />
        <StatCard label="Overdue Returns" value={stats.overdueRequests} icon={AlertTriangle}
          color={stats.overdueRequests > 0 ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300' : 'bg-surface text-faint'}
          accent={stats.overdueRequests > 0} />
        <StatCard label="Currently Issued" value={stats.currentlyIssued} icon={ArrowUpFromLine} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300" />
      </div>

      {/* Inventory + Indents side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Inventory */}
        {/* `h-full flex flex-col` on both cards in this row: they are grid
            items stretched to match each other, and their content was pinned
            to the top — Component Requests carried 80px of void against its
            neighbour's 18. Filling the height they are given reads as a card;
            sitting at the top of it reads as a bug. */}
        <div className="bg-card rounded-xl border border-line-soft shadow-sm p-5 flex h-full flex-col">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2 mb-4">
            <Package size={14} className="text-brand" /> Department Inventory
          </h3>
          <div className="grid flex-1 grid-cols-2 gap-3">
            <StatCard label="Unique Items" value={stats.totalItems} icon={Package} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300"
              onClick={() => navigate('/admin/components')} />
            <StatCard label="Total Stock" value={stats.totalStock?.toLocaleString()} icon={CheckCircle} color="bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300" />
            <StatCard label="Low Stock" value={stats.lowStock} icon={TrendingDown}
              color={stats.lowStock > 0 ? 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300' : 'bg-surface text-faint'} />
            <StatCard label="Out of Stock" value={stats.outOfStock} icon={Flame}
              color={stats.outOfStock > 0 ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300' : 'bg-surface text-faint'}
              accent={stats.outOfStock > 0} />
          </div>
        </div>

        {/* Requests */}
        <div className="bg-card rounded-xl border border-line-soft shadow-sm p-5 flex h-full flex-col">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2 mb-4">
            <ClipboardList size={14} className="text-brand" /> Component Requests
          </h3>
          <div className="grid flex-1 content-around grid-cols-3 gap-3">
            {[
              { s: 'PENDING', label: 'Pending', color: 'text-amber-700 dark:text-amber-300' },
              { s: 'APPROVED', label: 'Approved', color: 'text-green-700 dark:text-green-300' },
              { s: 'IN_USE', label: 'Issued', color: 'text-blue-600 dark:text-blue-300' },
              { s: 'OVERDUE', label: 'Overdue', color: 'text-red-700 dark:text-red-300' },
              { s: 'RETURNED', label: 'Returned', color: 'text-teal-600 dark:text-teal-300' },
              { s: 'RETURN_REQUESTED', label: 'Return Requested', color: 'text-orange-600 dark:text-orange-300' },
              { s: 'EMBEDDED', label: 'Embedded', color: 'text-purple-600 dark:text-purple-300' },
              { s: 'CONSUMED', label: 'Consumed', color: 'text-pink-600 dark:text-pink-300' },
              { s: 'DISPOSED', label: 'Disposed', color: 'text-muted' },
            ].map(r => (
              <div key={r.s} className="text-center py-2">
                <p className={`text-xl font-bold ${r.color}`}>{getReqCount(r.s)}</p>
                <p className="text-[9px] text-muted">{r.label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Indents */}
      <div className="bg-card rounded-xl border border-line-soft shadow-sm p-5">
        <h3 className="text-sm font-bold text-ink flex items-center gap-2 mb-4">
          <FileText size={14} className="text-brand" /> Department Indents
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Active Indents" value={stats.activeIndents} icon={FileText} color="bg-blue-50 dark:bg-blue-400/15 text-blue-600 dark:text-blue-300" accent />
          <StatCard label="Pending Tech" value={stats.pendingApprovals} icon={ShieldAlert}
            color={stats.pendingApprovals > 0 ? 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300' : 'bg-surface text-faint'}
            onClick={() => navigate('/admin/approvals')} />
          {[
            { s: 'APPROVED', label: 'Approved' },
            { s: 'RECEIVED', label: 'Received' },
          ].map(i => (
            <StatCard key={i.s} label={i.label} value={getIndCount(i.s)} icon={CheckCircle} color="bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300" />
          ))}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card rounded-xl border border-line-soft shadow-sm p-5">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2 mb-3">
            <Activity size={14} className="text-brand" /> Recent Requests
          </h3>
          <div className="space-y-0 max-h-[260px] overflow-y-auto">
            {stats.recentRequests?.length > 0 ? stats.recentRequests.map((r: any) => (
              <div key={r.id} className="flex items-center gap-3 py-2 border-b border-line-soft last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{r.item || r.serialNo}</p>
                  <p className="text-[10px] text-faint">{r.by} · {r.serialNo}</p>
                </div>
                <PendingCell status={r.status} reason={statusReasonForRequest(r)} />
                <span className="text-[10px] text-faint shrink-0">{fmtTime(r.date)}</span>
              </div>
            )) : <p className="text-sm text-faint text-center py-6">No recent requests</p>}
          </div>
        </div>

        <div className="bg-card rounded-xl border border-line-soft shadow-sm p-5">
          <h3 className="text-sm font-bold text-ink flex items-center gap-2 mb-3">
            <Activity size={14} className="text-brand" /> Recent Indents
          </h3>
          <div className="space-y-0 max-h-[260px] overflow-y-auto">
            {stats.recentIndents?.length > 0 ? stats.recentIndents.map((i: any) => (
              <div key={i.id} className="flex items-center gap-3 py-2 border-b border-line-soft last:border-0">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink truncate">{i.serialNo} · {i.project || '-'}</p>
                  <p className="text-[10px] text-faint">{i.by} · {i.currency} {i.total?.toLocaleString()}</p>
                </div>
                <PendingCell status={i.status} reason={statusReasonForIndent(i)} />
                <span className="text-[10px] text-faint shrink-0">{fmtTime(i.date)}</span>
              </div>
            )) : <p className="text-sm text-faint text-center py-6">No recent indents</p>}
          </div>
        </div>
      </div>
    </div>
  );
};
