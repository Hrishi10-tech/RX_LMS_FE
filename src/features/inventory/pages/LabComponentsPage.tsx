import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDepartments, useAuth, useBulkSelection, useServerPagination, useAbortOnUnmount, usePagedFilters, FilterSpec } from '@/hooks';
import { DataTable, StatusBadge, SearchInput, Modal, ColumnFilter, BulkSelectionBar, Pagination, statusLabel } from '@/components/ui';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { fmtDate, fmtDateTime, formatDueDelta } from '@/utils/date';
import { AlertTriangle, Cpu, Package, RotateCcw } from 'lucide-react';
import { UserRole } from '@/types';

const TABS = [
  { key: 'all', label: 'All Active', icon: Package },
  { key: 'issued', label: 'Currently Issued', icon: Cpu },
  { key: 'overdue', label: 'Overdue', icon: AlertTriangle },
  { key: 'return_requested', label: 'Return Requested', icon: RotateCcw },
];

const DISPOSITION_OPTIONS = [
  { value: 'EMBEDDED', label: 'Embedded in Product', desc: 'Permanently soldered/integrated — will not return' },
  { value: 'CONSUMED', label: 'Consumed / Used Up', desc: 'Consumable item fully used (solder, patches, etc.)' },
  { value: 'DAMAGED', label: 'Damaged — Dispose', desc: 'Item damaged beyond repair, disposed as waste' },
  { value: 'DISPOSED', label: 'Written Off / Disposed', desc: 'Item officially written off from inventory' },
  { value: 'LONG_TERM_LOAN', label: 'Long-term Loan', desc: 'Extended equipment loan (laptops, monitors, etc.)' },
];

export const LabComponentsPage = () => {


  const abortSignal = useAbortOnUnmount();
  const { user } = useAuth();
  const { departments, fetchDepartments } = useDepartments();
  const { addToast } = useToast();


  const [deptFilter, setDeptFilter] = useState('');
  // Filters on the HOLDER's current room, server-side, so it narrows the whole
  // set rather than just the visible page (same reasoning as deptFilter).
  const [labFilter, setLabFilter] = useState('');
  const [labs, setLabs] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState('all');

  // Each tab is its own server-side query with its own status filter. Loaded
  // in full (loadAll) so the column filters below see every row of the tab,
  // then paged 10 at a time on screen.
  // `all` is the union of the active statuses; the others are single statuses.
  // Switching tabs changes the `status` param → the hook resets to page 1.
  const TAB_STATUS: Record<string, string> = {
    all: 'IN_USE,OVERDUE,RETURN_REQUESTED',
    issued: 'IN_USE',
    overdue: 'OVERDUE',
    return_requested: 'RETURN_REQUESTED',
  };
  const {
    items: tabRequests,
    search, setSearch, isLoading, refetch,
  } = useServerPagination<any>({ loadAll: true,
    endpoint: '/requests',
    params: {
      status: TAB_STATUS[activeTab],
      departmentId: deptFilter || undefined,
      labId: labFilter || undefined,
    },
  });

  // Tab badges count the WHOLE active set (not just the visible page, and
  // independent of the search/dept filters) — same as before, when counts came
  // off the full unpaginated fetch. Three lightweight `take=1` queries give the
  // totals; `all` is their sum.
  const [counts, setCounts] = useState({ all: 0, issued: 0, overdue: 0, return_requested: 0 });
  const loadCounts = useCallback(async () => {
    try {
      const [issued, overdue, return_requested] = await Promise.all(
        ['IN_USE', 'OVERDUE', 'RETURN_REQUESTED'].map((s) =>
          client.get(`/requests?status=${s}&take=1`, { signal: abortSignal() }).then((r) => r.data?.data?.total ?? 0),
        ),
      );
      setCounts({ issued, overdue, return_requested, all: issued + overdue + return_requested });
    } catch { /* keep last-known counts on a transient failure */ }
  }, []);

  // Disposition modal. `bulkDispositionOpen` drives the SAME modal in bulk
  // mode (one disposition + note applied to the whole selection); single mode
  // is driven by `dispositionModal` (a row) exactly as before.
  const [dispositionModal, setDispositionModal] = useState<any>(null);
  const [bulkDispositionOpen, setBulkDispositionOpen] = useState(false);
  const [selectedDisposition, setSelectedDisposition] = useState('');
  const [dispositionNotes, setDispositionNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const canMarkDisposition = user?.role === UserRole.INVENTORY;
  const { selectedIds, toggleSelect, toggleSelectAllVisible, clearSelection } = useBulkSelection();

  const closeDisposition = () => {
    setDispositionModal(null);
    setBulkDispositionOpen(false);
    setSelectedDisposition('');
    setDispositionNotes('');
  };

  // Read tab from URL params (from dashboard navigation)
  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab && ['all', 'issued', 'overdue', 'return_requested'].includes(tab)) {
      setActiveTab(tab);
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the tab param once on mount to seed the active tab then strips it; must not re-run on searchParams/setSearchParams
  }, []);

  useEffect(() => { fetchDepartments(); }, [fetchDepartments]);
  // Rooms for the Lab/Room column filter. A failure only costs the filter
  // options, so the page stays usable rather than erroring out.
  useEffect(() => {
    client.get('/asset-locations', { signal: abortSignal() })
      .then(res => setLabs(res.data?.data ?? res.data ?? []))
      .catch(() => setLabs([]));
  }, []);
  useEffect(() => { loadCounts(); }, [loadCounts]);

  const getDaysInfo = (req: any) => {
    if (!req.dueDate) return null;
    const dd = formatDueDelta(req.dueDate, 7 * 24 * 60 * 60 * 1000);
    const cls = dd.overdue ? 'text-red-700 dark:text-red-300 font-bold' : dd.dueSoon ? 'text-amber-700 dark:text-amber-300 font-bold' : 'text-green-700 dark:text-green-300';
    return { text: dd.text, cls };
  };

  const handleDisposition = async () => {
    if (!selectedDisposition) return;
    if (!bulkDispositionOpen && !dispositionModal) return;
    setIsSubmitting(true);
    try {
      if (bulkDispositionOpen) {
        const res = await client.post('/requests/bulk-disposition', {
          ids: [...selectedIds],
          disposition: selectedDisposition,
          notes: dispositionNotes || undefined,
        });
        const summary = res.data?.data ?? res.data ?? {};
        const ok = summary.succeeded?.length ?? 0;
        const fail = summary.failed?.length ?? 0;
        if (fail === 0) {
          addToast(`Disposition updated for ${ok} item${ok === 1 ? '' : 's'}.`, 'success');
        } else if (ok === 0) {
          addToast(`Couldn't update any item. ${summary.failed?.[0]?.reason || ''}`.trim(), 'error');
        } else {
          addToast(`Updated ${ok} item${ok === 1 ? '' : 's'}; ${fail} skipped (${summary.failed?.[0]?.reason || 'not eligible'}).`, 'warning');
        }
        clearSelection();
      } else {
        await client.patch(`/requests/${dispositionModal.id}/disposition`, {
          disposition: selectedDisposition,
          notes: dispositionNotes,
        });
        addToast('Disposition updated', 'success');
      }
      closeDisposition();
      refetch();
      loadCounts();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to update disposition'), 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  // A filter on every data column (owner, 27 Oct); values match the cells.
  // Department and Lab / Room keep their server-side filters above.
  const filterSpecs = useMemo<FilterSpec<any>[]>(() => [
    { key: 'serial', getValue: (r) => r.serialNo },
    { key: 'component', getValue: (r) => r.inventoryItem?.name || 'Unknown' },
    { key: 'qty', getValue: (r) => String(r.qtyRequested ?? '') },
    { key: 'holder', getValue: (r) => r.createdBy?.name || 'Unknown' },
    { key: 'issued', getValue: (r) => (r.issuedAt ? fmtDate(r.issuedAt) : '-') },
    { key: 'due', getValue: (r) => (r.dueDate ? formatDueDelta(r.dueDate, 7 * 24 * 60 * 60 * 1000).text : 'No due date') },
    { key: 'status', getValue: (r) => statusLabel(r?.status || 'UNKNOWN') },
    { key: 'disposition', getValue: (r) => (r.disposition ? r.disposition.replace(/_/g, ' ') : 'Not set') },
  ], []);
  const pf = usePagedFilters(tabRequests, filterSpecs, 10, `${search}|${activeTab}|${deptFilter}|${labFilter}`);
  const filtered = (label: string, key: string) => ({
    filterActive: pf.isActive(key),
    header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={pf.getOptions(key)} value={pf.filters[key] || ''} onChange={(v) => pf.setFilter(key, v)} /></span>,
  });

  const columns = [
    { ...filtered('Serial', 'serial'), accessor: (row: any) => <span className="font-mono text-xs text-muted">{row.serialNo}</span> },
    { ...filtered('Component', 'component'), accessor: (row: any) => <span className="font-medium text-ink">{row.inventoryItem?.name || 'Unknown'}</span> },
    { ...filtered('Qty', 'qty'), accessor: (row: any) => <span className="font-bold">{row.qtyRequested}</span> },
    { ...filtered('Holder', 'holder'), accessor: (row: any) => <span className="text-sm font-medium text-ink">{row.createdBy?.name || 'Unknown'}</span> },
    { filterActive: !!deptFilter, header: <span className="inline-flex items-center">Department<ColumnFilter searchable options={departments.map(d => ({ value: d.id, label: d.name }))} value={deptFilter} onChange={setDeptFilter} /></span>, accessor: (row: any) => <span className="text-xs text-muted">{row.department?.name || '-'}</span> },
    // Sits beside Department, which alone can't answer "where is this thing?":
    // one department's people are spread across rooms. Shows the room the item
    // is physically in RIGHT NOW (the holder's current room), not the room it
    // was issued to — that historical fact lives on the request slip.
    { filterActive: !!labFilter, header: <span className="inline-flex items-center">Lab / Room<ColumnFilter searchable options={labs.map(l => ({ value: l.id, label: l.name }))} value={labFilter} onChange={setLabFilter} /></span>,
      accessor: (row: any) => row.createdBy?.lab?.name
        ? <span className="text-xs text-muted">{row.createdBy.lab.name}</span>
        : <span className="text-xs text-faint italic" title="This person has no room assigned yet — set one on their user record.">Unassigned</span> },
    { ...filtered('Issued', 'issued'), accessor: (row: any) => row.issuedAt ? <span className="text-xs text-muted">{fmtDateTime(row.issuedAt)}</span> : <span className="text-xs text-faint">-</span> },
    { ...filtered('Due / Timeline', 'due'), accessor: (row: any) => {
      const info = getDaysInfo(row);
      if (!info) return <span className="text-xs text-faint">No due date</span>;
      return <span className={`text-xs ${info.cls}`}>{info.text}</span>;
    }},
    { ...filtered('Status', 'status'), accessor: (row: any) => <StatusBadge status={row?.status || 'UNKNOWN'} /> },
    { ...filtered('Disposition', 'disposition'), accessor: (row: any) => {
      if (!row.disposition) return <span className="text-xs text-faint italic">Not set</span>;
      const colors: Record<string, string> = {
        IN_USE: 'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30',
        EMBEDDED: 'bg-purple-50 dark:bg-purple-400/15 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-400/30',
        CONSUMED: 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30',
        DAMAGED: 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30',
        LONG_TERM_LOAN: 'bg-indigo-50 dark:bg-indigo-400/15 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-400/30',
        RETURNED_GOOD: 'bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300 border-green-200 dark:border-green-400/30',
        RETURNED_DAMAGED: 'bg-orange-50 dark:bg-orange-400/15 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-400/30',
        DISPOSED: 'bg-hover text-secondary border-line',
      };
      return <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${colors[row.disposition] || 'bg-surface text-secondary'}`}>{row.disposition?.replace(/_/g, ' ')}</span>;
    }},
    ...(canMarkDisposition ? [{
      header: 'Action',
      accessor: (row: any) => {
        if (row.status !== 'IN_USE' && row.status !== 'OVERDUE') return null;
        return (
          <button
            onClick={() => setDispositionModal(row)}
            className="text-xs bg-brand text-white px-2.5 py-1 rounded-full font-bold hover:bg-brand-dark transition-colors"
          >
            Mark Disposition
          </button>
        );
      }
    }] : []),
  ];

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Tabs + Filters */}
      <div className="bg-card rounded-lg shadow-sm border border-line-soft">
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-xl font-bold tracking-tight text-ink">Lab Items</h2>
          <p className="text-xs text-muted mt-0.5">Track every component issued from inventory</p>
        </div>
        <div className="border-b border-line-soft px-4">
          <div className="flex gap-1 overflow-x-auto pb-0">
            {TABS.map(tab => {
              const count = counts[tab.key as keyof typeof counts] || 0;
              const isActive = activeTab === tab.key;
              const Icon = tab.icon;
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
                  <span className={`px-1.5 py-0.5 rounded-full text-[9px] ${isActive ? 'bg-brand/20 text-brand-700' : 'bg-hover text-faint'}`}>{count}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="p-4">
          <div className="flex items-center gap-3 mb-4">
            <div className="flex-1">
              <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by component, serial, or holder..." />
            </div>
            {(search || deptFilter || labFilter || Object.keys(pf.filters).length > 0) && (
              <button onClick={() => { setSearch(''); setDeptFilter(''); setLabFilter(''); pf.clearFilters(); }} className="text-sm text-brand font-bold hover:underline whitespace-nowrap">Clear</button>
            )}
          </div>

          <BulkSelectionBar count={selectedIds.size} onClear={clearSelection}>
            {canMarkDisposition && (
              <button
                onClick={() => { setDispositionModal(null); setSelectedDisposition(''); setDispositionNotes(''); setBulkDispositionOpen(true); }}
                className="text-xs bg-brand text-white px-3 py-1.5 rounded-full font-bold hover:bg-brand-dark transition-colors whitespace-nowrap"
              >
                Mark Disposition
              </button>
            )}
          </BulkSelectionBar>
          <DataTable
            columns={columns}
            data={pf.pageRows}
            isLoading={isLoading}
            keyExtractor={(row) => row.id}
            emptyStateMessage={activeTab === 'overdue' ? 'No overdue items — great!' : 'No items found for this filter.'}
            maxHeight="60vh"
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleSelectAllVisible={toggleSelectAllVisible}
          />
          <Pagination currentPage={pf.page} totalPages={pf.totalPages} onPageChange={pf.setPage} />
        </div>
      </div>

      {/* Disposition Modal — single (a row) or bulk (the whole selection). */}
      <Modal isOpen={!!dispositionModal || bulkDispositionOpen} onClose={closeDisposition} title={bulkDispositionOpen ? `Mark Disposition (${selectedIds.size} item${selectedIds.size === 1 ? '' : 's'})` : 'Mark Item Disposition'}>
        {(dispositionModal || bulkDispositionOpen) && (
          <div className="space-y-4">
            {bulkDispositionOpen ? (
              <div className="bg-surface rounded-lg p-4 border border-line-soft">
                <p className="text-sm font-bold text-ink">{selectedIds.size} item{selectedIds.size === 1 ? '' : 's'} selected</p>
                <p className="text-xs text-muted mt-1">The same disposition + note is applied to each. Items not currently issued (e.g. return-requested) are skipped and reported.</p>
              </div>
            ) : (
              <div className="bg-surface rounded-lg p-4 border border-line-soft">
                <p className="text-sm font-bold text-ink">{dispositionModal.inventoryItem?.name}</p>
                <p className="text-xs text-muted mt-1">{dispositionModal.serialNo} · {dispositionModal.qtyRequested} units · Held by {dispositionModal.createdBy?.name}</p>
              </div>
            )}

            <div>
              <label className="block text-sm font-bold text-muted mb-2">What happened to this item?</label>
              <div className="space-y-2">
                {DISPOSITION_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setSelectedDisposition(opt.value)}
                    className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                      selectedDisposition === opt.value
                        ? 'border-brand bg-brand/5'
                        : 'border-line hover:border-brand/50'
                    }`}
                  >
                    <p className="text-sm font-bold text-ink">{opt.label}</p>
                    <p className="text-[10px] text-faint mt-0.5">{opt.desc}</p>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-sm font-bold text-muted mb-1">Notes (optional)</label>
              <textarea
                value={dispositionNotes}
                onChange={(e) => setDispositionNotes(e.target.value)}
                rows={3}
                className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none resize-none"
                placeholder="e.g. Soldered onto PCB Rev 2.1, Disposed as e-waste per safety protocol..."
              />
            </div>

            <div className="flex justify-end gap-3 pt-2 border-t border-line-soft">
              <button onClick={closeDisposition} className="px-4 py-2 text-muted font-bold rounded-md hover:bg-hover transition-colors">Cancel</button>
              <button
                onClick={handleDisposition}
                disabled={!selectedDisposition || isSubmitting}
                className="px-4 py-2 bg-brand text-white font-bold rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50"
              >
                {isSubmitting ? 'Updating...' : 'Confirm Disposition'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};
