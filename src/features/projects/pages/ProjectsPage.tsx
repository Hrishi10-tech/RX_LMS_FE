import { useMemo, useState } from 'react';
import { client } from '@/api';
import { DataTable, Modal, SearchInput, BulkSelectionBar, BulkActionButton, ColumnFilter, Pagination, LoadAllCapNote } from '@/components/ui';
import { useBulkSelection, useServerPagination, usePagedFilters, FilterSpec } from '@/hooks';
import { EditableCell } from '@/components/ui/EditableCell';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { Plus, FolderKanban, Trash2 } from 'lucide-react';
import { BackLink } from '@/components/ui/BackLink';

import { extractErrorMessage } from '@/lib';
import { runPerId } from '@/utils/bulk';

const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

export const ProjectsPage = () => {
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');

  const { addToast } = useToast();
  const confirm = useConfirm();
  const { selectedIds, toggleSelect, toggleSelectAllVisible, clearSelection } = useBulkSelection();

  // Name search + the status filter run on the server; every matching project
  // is loaded (loadAll — a settings list of tens, not thousands) so the column
  // filters below see all of them, and the filtered result is paged here.
  const {
    items: projects, total, truncated, serverTotal,
    search, setSearch, isLoading, refetch,
  } = useServerPagination<any>({ urlKey: 'page', loadAll: true,
    endpoint: '/projects',
    params: {
      isActive: statusFilter === 'active' ? 'true' : statusFilter === 'inactive' ? 'false' : undefined,
    },
  });

  const handleCreate = async () => {
    if (!newName.trim()) { addToast('Name required', 'error'); return; }
    setIsSubmitting(true);
    try {
      await client.post('/projects', { name: newName.trim() });
      addToast('Project created', 'success');
      setShowAdd(false);
      setNewName('');
      refetch();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
    setIsSubmitting(false);
  };

  const handleUpdate = async (id: string, field: string, value: any) => {
    try {
      await client.patch(`/projects/${id}`, { [field]: value });
      addToast('Updated', 'success');
      refetch();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to update'), 'error'); }
  };

  const handleToggleActive = async (id: string, isActive: boolean) => {
    try {
      await client.patch(`/projects/${id}`, { isActive: !isActive });
      addToast(!isActive ? 'Project activated' : 'Project deactivated', 'success');
      refetch();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
  };

  const handleDelete = async (id: string) => {
    if (!await confirm('Delete this project? This cannot be undone.')) return;
    try {
      await client.delete(`/projects/${id}`);
      addToast('Project deleted', 'success');
      refetch();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed — project may have linked items'), 'error'); }
  };

  // A filter on every data column (owner, 27 Oct). Status stays server-side;
  // these run over every loaded project. Created filters by day.
  const pageSpecs = useMemo<FilterSpec<any>[]>(() => [
    { key: 'name', getValue: (r) => r.name || '' },
    { key: 'created', getValue: (r) => (r.createdAt ? fmtDate(r.createdAt) : '') },
  ], []);
  const pf = usePagedFilters(projects, pageSpecs, 10, search);
  const columnFiltered = Object.keys(pf.filters).length > 0;
  const narrowed = columnFiltered || !!search.trim() || !!statusFilter;
  const filtered = (label: string, key: string) => ({
    filterActive: pf.isActive(key),
    header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={pf.getOptions(key)} value={pf.filters[key] || ''} onChange={(v) => pf.setFilter(key, v)} /></span>,
  });

  const columns = [
    { ...filtered('Project Name', 'name'), accessor: (row: any) => (
      <EditableCell value={row.name} onSave={(val) => handleUpdate(row.id, 'name', val)} />
    )},
    { filterActive: !!statusFilter, header: <span className="inline-flex items-center">Status<ColumnFilter options={STATUS_OPTIONS} value={statusFilter} onChange={setStatusFilter} /></span>, accessor: (row: any) => (
      <button onClick={() => handleToggleActive(row.id, row.isActive)}
        className={`px-2 py-0.5 text-[10px] font-bold rounded-full border transition-colors ${
          row.isActive ? 'bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300 border-green-200 dark:border-green-400/30 hover:bg-red-50 dark:bg-red-400/15 hover:text-red-700 dark:text-red-300 hover:border-red-200 dark:border-red-400/30' : 'bg-hover text-muted border-line hover:bg-green-50 dark:bg-green-400/15 hover:text-green-700 dark:text-green-300 hover:border-green-200 dark:border-green-400/30'
        }`}>
        {row.isActive ? 'Active' : 'Inactive'}
      </button>
    )},
    { ...filtered('Created', 'created'), accessor: (row: any) => <span className="text-xs text-muted">{fmtDateTime(row.createdAt)}</span> },
    { header: '', accessor: (row: any) => (
      <button onClick={() => handleDelete(row.id)} className="text-xs text-red-400 hover:text-red-700 dark:text-red-300"><Trash2 size={14} /></button>
    )},
  ];

  return (
    <div className="space-y-4">
      <BackLink to="/super-admin/settings" label="Settings" />
      <div className="bg-card rounded-lg shadow-sm border border-line-soft">
        <div className="p-4 md:px-6">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-ink flex items-center gap-2">
                <FolderKanban size={20} className="text-brand" /> Projects
              </h2>
              <p className="text-xs text-muted mt-0.5">{columnFiltered ? `${pf.filteredTotal} of ${total}` : total} projects</p>
            </div>
            <button onClick={() => setShowAdd(true)} className="flex items-center gap-2 px-4 py-2 bg-brand text-white font-bold rounded-full hover:bg-brand-dark transition-colors text-sm">
              <Plus size={16} /> New Project
            </button>
          </div>
          <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects..." />
        </div>

        <div className="px-4 md:px-6 pt-3">
          <BulkSelectionBar count={selectedIds.size} onClear={clearSelection}>
            <BulkActionButton
              label="Delete"
              count={selectedIds.size}
              tone="danger"
              verb="deleted"
              confirmTitle="Delete projects?"
              confirmMessage={`Delete ${selectedIds.size} selected project${selectedIds.size === 1 ? '' : 's'}? Projects linked to indents, requests, or BOMs can't be deleted and will be skipped.`}
              onRun={() => runPerId([...selectedIds], (id) => client.delete(`/projects/${id}`))}
              onDone={() => { clearSelection(); refetch(); }}
            />
          </BulkSelectionBar>
        </div>
        <DataTable
          columns={columns}
          data={pf.pageRows}
          isLoading={isLoading}
          keyExtractor={r => r.id}
          emptyStateMessage={narrowed ? 'No projects match these filters.' : 'No projects. Create your first project.'}
          maxHeight="60vh"
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onToggleSelectAllVisible={toggleSelectAllVisible}
        />
        <div className="px-4 md:px-6 pb-2">
          <LoadAllCapNote truncated={truncated} shown={total} total={serverTotal} hint="search or filter by status to see older ones." />
          <Pagination currentPage={pf.page} totalPages={pf.totalPages} onPageChange={pf.setPage} />
        </div>
      </div>

      <Modal isOpen={showAdd} onClose={() => setShowAdd(false)} title="Create Project">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Project Name *</label>
            <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
              className="w-full px-3 py-2 border rounded-md focus:border-brand outline-none" placeholder="e.g. IoT Research Phase 2" />
          </div>
          <div className="flex justify-end gap-3 pt-4 border-t">
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-muted font-bold rounded-md hover:bg-hover">Cancel</button>
            <button onClick={handleCreate} disabled={isSubmitting}
              className="px-5 py-2 bg-brand text-white font-bold rounded-full hover:bg-brand-dark disabled:opacity-50">
              {isSubmitting ? 'Creating...' : 'Create Project'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
