import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useServerPagination, usePagedFilters, FilterSpec } from '@/hooks';
import { DataTable, ColumnFilter, PendingCell, Pagination, ExportPanel, SearchInput, LoadAllCapNote } from '@/components/ui';
import { ClipboardList, FileText, Eye } from 'lucide-react';
import { fmtDateTime, dateOnlyKey } from '@/utils/date';
import { statusReasonForIndent, statusReasonForRequest } from '@/utils/pendingReason';
import { IndentTrackModal } from '@/features/indents/components/IndentTrackModal';

// Normalise a timestamp to a date-only string we can use as a filter dropdown value.

const TABS = [
  { key: 'requests', label: 'Request History', icon: ClipboardList },
  { key: 'indents', label: 'Indent History', icon: FileText },
];

// History = only rows something actually HAPPENED to: an item was issued /
// concluded, or it was rejected. In-flight rows (pending / approval-queue /
// not-yet-issued) are NOT history — they live on the active management pages.
// So each pill is a server param fragment scoping to history-eligible statuses:
//   - requests 'all' uses excludeStatus (issued-or-later + rejected = everything
//     EXCEPT the three pre-issue states) so a new terminal status added later is
//     in History by default without editing this map.
//   - the sub-pills use a positive status list.
// Withdrawn (soft-deleted) rows are layered on top via the includeDeleted toggle
// (see reqP/indP below), independent of which pill is active.
const REQ_FILTER: Record<string, { status?: string; excludeStatus?: string }> = {
  all:       { excludeStatus: 'PENDING,APPROVED,YET_TO_ISSUE' },
  inUse:     { status: 'IN_USE,OVERDUE,RETURN_REQUESTED' },
  completed: { status: 'RETURNED,EMBEDDED,CONSUMED,DISPOSED' },
  rejected:  { status: 'REJECTED' },
};
const IND_FILTER: Record<string, { status?: string; excludeStatus?: string }> = {
  all:      { status: 'RECEIVED,REJECTED,CANCELLED' },
  received: { status: 'RECEIVED' },
  closed:   { status: 'REJECTED,CANCELLED' },
  // Deep-link-only ids. The SuperAdmin dashboard's Procurement tiles link here
  // with ?filter=active / ?filter=approved, which this map didn't define — so
  // both fell through to 'all' and the "Active Indents" tile landed on a table
  // of RECEIVED/REJECTED/CANCELLED rows, i.e. the exact complement of what the
  // tile counted. Status sets mirror the backend aggregates they come from
  // (indent-query.service: totalActive excludes RECEIVED/REJECTED/CANCELLED,
  // totalSpendApproved excludes PENDING/REJECTED/CANCELLED) so the row count
  // reconciles with the number on the tile.
  active:   { excludeStatus: 'RECEIVED,REJECTED,CANCELLED' },
  approved: { excludeStatus: 'PENDING,REJECTED,CANCELLED' },
};

/**
 * Labels for the deep-link-only indent filters — they get no pill in the row
 * (they aren't history buckets), so without this the pill row showed nothing
 * selected while the table was filtered, and there was no way to tell why the
 * rows looked wrong or how to clear it.
 */
const IND_DEEPLINK_LABEL: Record<string, string> = {
  active: 'Active indents (from dashboard)',
  approved: 'Approved spend (from dashboard)',
};

export const HistoryPage = () => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'requests');
  const [indentFilter, setIndentFilter] = useState(searchParams.get('filter') || 'all');
  const [requestFilter, setRequestFilter] = useState(searchParams.get('filter') || 'all');
  // Opt-in withdrawn (soft-deleted) rows — off by default, shared across both
  // tabs. Drives the table fetch below; deleted rows render with a "Deleted"
  // badge (status accessors already pass `deleted`).
  const [showDeleted, setShowDeleted] = useState(false);

  useEffect(() => {
    const tab = searchParams.get('tab');
    const filter = searchParams.get('filter');
    if (tab && (tab === 'requests' || tab === 'indents')) {
      setActiveTab(tab);
    }
    if (filter) {
      if (tab === 'indents') setIndentFilter(filter);
      if (tab === 'requests') setRequestFilter(filter);
    }
    if (tab || filter) {
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads searchParams once on mount to seed tab/filter then strips them; searchParams/setSearchParams must not retrigger this seed
  }, []);
  // Each tab paginates server-side, 10/page. The status-pill drives the status/
  // excludeStatus param (see the maps above) instead of a client .filter over a
  // full fetch, so History scales with tens of thousands of historical rows.
  // Withdrawn rows are opt-in via the shared `showDeleted` toggle (default off),
  // independent of the pill: when on, the backend ORs the history-status bucket
  // with "any deleted row in scope", so a withdrawn row surfaces (marked) even
  // though its pre-deletion status sits outside the bucket. An unknown/retired
  // filter id (e.g. a stale dashboard deep-link `?filter=active`) falls back to
  // 'all' so it lands on history — never a crash or an unscoped in-flight leak.
  // loadAll: the column filters below run in the browser, so they need every
  // row, not the current 10 (see usePagedFilters).
  //
  // Only the visible tab loads. Both used to load on mount, so opening History
  // pulled up to 2,000 requests AND 2,000 indents when only one table is ever
  // on screen. Switching tabs loads the other one then, fresh.
  const reqP = useServerPagination<any>({ endpoint: '/requests', loadAll: true, enabled: activeTab === 'requests', params: { ...(REQ_FILTER[requestFilter] ?? REQ_FILTER.all), includeDeleted: showDeleted } });
  const indP = useServerPagination<any>({ endpoint: '/indents', loadAll: true, enabled: activeTab === 'indents', params: { ...(IND_FILTER[indentFilter] ?? IND_FILTER.all), includeDeleted: showDeleted } });
  const requests = reqP.items;
  const indents = indP.items;
  const reqLoading = reqP.isLoading;
  const indLoading = indP.isLoading;

  // Track modal — admin/super-admin opens this to see where an indent stalled.
  // Same shared modal used on IndentsManagementPage + StandardIPRequestsPage.
  const [trackIndent, setTrackIndent] = useState<any>(null);

  // The Status column already has the pill-filter row above the table, so it deliberately
  // gets no per-column ColumnFilter here (per user rule: one filter UI per column).
  const reqFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
    { key: 'reqId',       getValue: (r) => r.serialNo },
    { key: 'component',   getValue: (r) => r.inventoryItem?.name },
    { key: 'requestedBy', getValue: (r) => r.createdBy?.name },
    { key: 'department',  getValue: (r) => r.department?.name },
    { key: 'date',        getValue: (r) => dateOnlyKey(r.createdAt) },
  ], []);

  const indFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
    { key: 'indentId',   getValue: (r) => r.serialNo },
    { key: 'department', getValue: (r) => r.department?.name },
    { key: 'project',    getValue: (r) => r.project?.name ?? 'General / Others' },
    { key: 'amount',     getValue: (r) => `${r.currency} ${r.grandTotal?.toLocaleString() ?? ''}` },
    { key: 'date',       getValue: (r) => dateOnlyKey(r.createdAt) },
  ], []);

  // Status narrowing happens server-side via the status param (see the maps +
  // hooks above); the per-column filters then run over every row of that
  // status, and only their result is paged.
  const reqF = usePagedFilters(requests, reqFilterSpecs, 10, reqP.search);
  const indF = usePagedFilters(indents, indFilterSpecs, 10, indP.search);

  const reqCols = [
    { filterActive: reqF.isActive('reqId'),       header: <span className="inline-flex items-center">Req ID<ColumnFilter searchable options={reqF.getOptions('reqId')}       value={reqF.filters.reqId       || ''} onChange={(v) => reqF.setFilter('reqId', v)}       /></span>, accessor: (r: any) => <span className="font-mono text-xs font-bold text-ink">{r.serialNo}</span> },
    { filterActive: reqF.isActive('component'),   header: <span className="inline-flex items-center">Component<ColumnFilter searchable options={reqF.getOptions('component')}  value={reqF.filters.component   || ''} onChange={(v) => reqF.setFilter('component', v)}   /></span>, accessor: (r: any) => <span className="text-sm text-ink">{r.inventoryItem?.name || '-'}</span> },
    { filterActive: reqF.isActive('requestedBy'), header: <span className="inline-flex items-center">Requested By<ColumnFilter searchable options={reqF.getOptions('requestedBy')} value={reqF.filters.requestedBy || ''} onChange={(v) => reqF.setFilter('requestedBy', v)} /></span>, accessor: (r: any) => <span className="text-xs text-muted">{r.createdBy?.name || '-'}</span> },
    { filterActive: reqF.isActive('department'),  header: <span className="inline-flex items-center">Department<ColumnFilter options={reqF.getOptions('department')}                       value={reqF.filters.department  || ''} onChange={(v) => reqF.setFilter('department', v)}  /></span>, accessor: (r: any) => <span className="text-xs text-muted">{r.department?.name || '-'}</span> },
    { header: 'Status', accessor: (r: any) => <PendingCell status={r?.status || 'UNKNOWN'} reason={statusReasonForRequest(r)} deleted={!!r?.deletedAt} /> },
    { filterActive: reqF.isActive('date'),        header: <span className="inline-flex items-center">Date<ColumnFilter searchable options={reqF.getOptions('date')}                value={reqF.filters.date        || ''} onChange={(v) => reqF.setFilter('date', v)}        /></span>, accessor: (r: any) => <span className="text-xs text-muted">{fmtDateTime(r.createdAt)}</span> },
  ];

  const indCols = [
    { filterActive: indF.isActive('indentId'),   header: <span className="inline-flex items-center">Indent ID<ColumnFilter searchable options={indF.getOptions('indentId')}   value={indF.filters.indentId   || ''} onChange={(v) => indF.setFilter('indentId', v)}   /></span>, accessor: (r: any) => <span className="font-mono text-xs font-bold text-ink">{r.serialNo}</span> },
    { filterActive: indF.isActive('department'), header: <span className="inline-flex items-center">Department<ColumnFilter options={indF.getOptions('department')}                  value={indF.filters.department || ''} onChange={(v) => indF.setFilter('department', v)} /></span>, accessor: (r: any) => <span className="text-xs text-muted">{r.department?.name || '-'}</span> },
    { filterActive: indF.isActive('project'),    header: <span className="inline-flex items-center">Project<ColumnFilter options={indF.getOptions('project')}                       value={indF.filters.project    || ''} onChange={(v) => indF.setFilter('project', v)}    /></span>, accessor: (r: any) => <span className="text-xs text-muted">{r.project?.name || <span className="italic text-faint">General / Others</span>}</span> },
    { filterActive: indF.isActive('amount'),     header: <span className="inline-flex items-center">Amount<ColumnFilter searchable options={indF.getOptions('amount')}             value={indF.filters.amount     || ''} onChange={(v) => indF.setFilter('amount', v)}     /></span>, accessor: (r: any) => <span className="text-xs font-bold">{r.currency} {r.grandTotal?.toLocaleString()}</span> },
    { header: 'Status', accessor: (r: any) => <PendingCell status={r?.status || 'UNKNOWN'} reason={statusReasonForIndent(r)} deleted={!!r?.deletedAt} /> },
    { filterActive: indF.isActive('date'),       header: <span className="inline-flex items-center">Date<ColumnFilter searchable options={indF.getOptions('date')}                 value={indF.filters.date       || ''} onChange={(v) => indF.setFilter('date', v)}       /></span>, accessor: (r: any) => <span className="text-xs text-muted">{fmtDateTime(r.createdAt)}</span> },
    { header: 'Track', accessor: (r: any) => (
        <button onClick={(e) => { e.stopPropagation(); setTrackIndent(r); }} className="text-xs text-brand font-bold hover:underline inline-flex items-center gap-1" title="View timeline — see who acted when, and where the indent stalled">
          <Eye size={12} /> Track
        </button>
      ) },
  ];

  const filteredRequests = reqF.pageRows;
  const filteredIndents  = indF.pageRows;

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="bg-card rounded-xl shadow-sm border border-line-soft">
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-xl font-bold tracking-tight text-ink">History Log</h2>
          <p className="text-xs text-muted mt-0.5">View past requests and indent records</p>
        </div>

        <div className="border-b border-line-soft px-4">
          <div className="flex gap-1">
            {TABS.map(tab => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-bold rounded-t-lg border-b-2 transition-colors whitespace-nowrap ${
                    isActive
                      ? 'border-brand text-brand bg-brand/5'
                      : 'border-transparent text-muted hover:text-ink hover:bg-surface'
                  }`}
                >
                  <Icon size={14} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {activeTab === 'requests' && (
          <div className="px-4 pt-4 pb-2 flex flex-wrap items-center gap-2 border-b border-line-soft">
            <span className="text-xs font-bold text-muted">Filter Status:</span>
            {[
              { id: 'all', label: 'All History' },
              { id: 'inUse', label: 'Currently Issued' },
              { id: 'completed', label: 'Completed/Returned' },
              { id: 'rejected', label: 'Rejected' },
            ].map(f => (
               <button
                key={f.id}
                onClick={() => setRequestFilter(f.id)}
                className={`px-3 py-1 text-[10px] font-bold rounded-full transition-colors border ${
                  requestFilter === f.id
                    ? 'bg-brand text-white border-brand shadow-sm'
                    : 'bg-card text-muted border-line hover:bg-surface'
                }`}
              >
                {f.label}
              </button>
            ))}
            <label className="flex w-full items-center gap-1.5 text-[10px] font-bold text-muted cursor-pointer select-none whitespace-nowrap sm:ml-auto sm:w-auto" title="Show withdrawn (deleted) requests too — they stay marked.">
              <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} className="accent-brand" />
              Include withdrawn
            </label>
          </div>
        )}

        {activeTab === 'indents' && (
          <div className="px-4 pt-4 pb-2 flex flex-wrap items-center gap-2 border-b border-line-soft">
            <span className="text-xs font-bold text-muted">Filter Status:</span>
            {[
              { id: 'all', label: 'All History' },
              { id: 'received', label: 'Received Only' },
              { id: 'closed', label: 'Rejected/Cancelled' },
            ].map(f => (
              <button
                key={f.id}
                onClick={() => setIndentFilter(f.id)}
                className={`px-3 py-1 text-[10px] font-bold rounded-full transition-colors border ${
                  indentFilter === f.id
                    ? 'bg-brand text-white border-brand shadow-sm'
                    : 'bg-card text-muted border-line hover:bg-surface'
                }`}
              >
                {f.label}
              </button>
            ))}
            {IND_DEEPLINK_LABEL[indentFilter] && (
              <button
                onClick={() => setIndentFilter('all')}
                title="Clear this filter and show all history"
                className="px-3 py-1 text-[10px] font-bold rounded-full border bg-brand text-white border-brand shadow-sm"
              >
                {IND_DEEPLINK_LABEL[indentFilter]} &times;
              </button>
            )}
            <label className="flex w-full items-center gap-1.5 text-[10px] font-bold text-muted cursor-pointer select-none whitespace-nowrap sm:ml-auto sm:w-auto" title="Show withdrawn (deleted) indents too — they stay marked.">
              <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} className="accent-brand" />
              Include withdrawn
            </label>
          </div>
        )}

        <div className="p-4">
          {activeTab === 'requests' && (
            <>
              <div className="mb-4">
                <ExportPanel kind="requests" {...(REQ_FILTER[requestFilter] ?? REQ_FILTER.all)} includeDeleted={showDeleted} />
              </div>
              {/* History had no search at all — a past request could only be
                  found by paging through. */}
              <div className="mb-3">
                <SearchInput value={reqP.search} onChange={(e) => reqP.setSearch(e.target.value)} placeholder="Search by request number, item or requester…" />
              </div>
              <DataTable
                columns={reqCols}
                data={filteredRequests}
                isLoading={reqLoading}
                keyExtractor={(row) => row.id}
                emptyStateMessage="No request history."
              />
              <LoadAllCapNote truncated={reqP.truncated} shown={requests.length} total={reqP.serverTotal} />
              <Pagination currentPage={reqF.page} totalPages={reqF.totalPages} onPageChange={reqF.setPage} />
            </>
          )}
          {activeTab === 'indents' && (
            <>
              <div className="mb-4">
                <ExportPanel kind="indents" {...(IND_FILTER[indentFilter] ?? IND_FILTER.all)} includeDeleted={showDeleted} />
              </div>
              <div className="mb-3">
                <SearchInput value={indP.search} onChange={(e) => indP.setSearch(e.target.value)} placeholder="Search by indent number, item, requester, department or project…" />
              </div>
              <DataTable
                columns={indCols}
                data={filteredIndents}
                isLoading={indLoading}
                keyExtractor={(row) => row.id}
                emptyStateMessage="No indent history."
              />
              <LoadAllCapNote truncated={indP.truncated} shown={indents.length} total={indP.serverTotal} />
              <Pagination currentPage={indF.page} totalPages={indF.totalPages} onPageChange={indF.setPage} />
            </>
          )}
        </div>
      </div>

      <IndentTrackModal indent={trackIndent} onClose={() => setTrackIndent(null)} />
    </div>
  );
};
