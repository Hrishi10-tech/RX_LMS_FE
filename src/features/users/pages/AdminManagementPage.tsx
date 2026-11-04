import { extractErrorMessage } from '@/lib';
import { useEffect, useMemo, useState } from 'react';
import { useUsers, useDepartments, usePagedFilters, useServerPagination, FilterSpec } from '@/hooks';
import { UserRole } from '@/types';
import { DataTable, Modal, ColumnFilter, SearchInput, Pagination } from '@/components/ui';
import { UserForm } from '@/components/forms';
import { EditableCell } from '@/components/ui/EditableCell';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';

export const AdminManagementPage = () => {
  // useUsers stays lazy (we only borrow createUser). The admin list is
  // server-paginated (10/page) via /users/paginated?role=ADMIN, with debounced
  // server-side search; the per-column filters below still refine the current page.
  const { createUser } = useUsers();
  const { departments, fetchDepartments } = useDepartments();
  const {
    items: admins, total,
    search, setSearch, isLoading, refetch,
  } = useServerPagination<any>({ urlKey: 'page', loadAll: true, endpoint: '/users/paginated', params: { role: 'ADMIN' } });
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingDepts, setEditingDepts] = useState<string | null>(null);
  const [selectedDeptIds, setSelectedDeptIds] = useState<string[]>([]);
  const { addToast } = useToast();

  useEffect(() => {
    fetchDepartments();
  }, [fetchDepartments]);

  const filterSpecs = useMemo<FilterSpec<any>[]>(() => [
    { key: 'name',        getValue: (r) => r.name },
    { key: 'email',       getValue: (r) => r.email },
    // An array, not a joined string. Joined, the dropdown offered whole
    // COMBINATIONS — "Hardware, Software" was one option and "Hardware" another
    // — so filtering by Hardware silently skipped every admin who also covers
    // something else, which is the exact group you are usually looking for.
    // Each department is now its own option and matches anyone who covers it.
    { key: 'departments', getValue: (r) => {
        const names = (r.adminDepartments || []).map((ad: any) => ad.department?.name).filter(Boolean).sort();
        return names.length ? names : null;
    } },
  ], []);

  const f = usePagedFilters(admins, filterSpecs, 10, search);

  const handleSubmit = async (data: any) => {
    setIsSubmitting(true);
    try {
      await createUser(data);
      setIsModalOpen(false);
      addToast('Admin created successfully', 'success');
      refetch();
    } catch (e: any) {
      // The server's reason (e.g. the password rule, a taken email) — not a
      // generic "failed" that leaves the person guessing what to change.
      addToast(extractErrorMessage(e, 'Failed to save admin'), 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateField = async (userId: string, field: string, value: any) => {
    try {
      await client.patch(`/users/${userId}`, { [field]: value });
      addToast(`Updated ${field}`, 'success');
      refetch();
    } catch {
      addToast(`Failed to update ${field}`, 'error');
    }
  };

  const handleStartEditDepts = (admin: any) => {
    const currentIds = (admin.adminDepartments || []).map((ad: any) => ad.departmentId);
    setSelectedDeptIds(currentIds);
    setEditingDepts(admin.id);
  };

  const handleSaveDepts = async (userId: string) => {
    try {
      await client.patch(`/users/${userId}`, { adminDepartmentIds: selectedDeptIds });
      addToast('Departments updated', 'success');
      setEditingDepts(null);
      refetch();
    } catch {
      addToast('Failed to update departments', 'error');
    }
  };

  const toggleDept = (deptId: string) => {
    setSelectedDeptIds(prev =>
      prev.includes(deptId) ? prev.filter(id => id !== deptId) : [...prev, deptId]
    );
  };

  const columns = [
    {
      filterActive: f.isActive('name'),
      header: <span className="inline-flex items-center">Name<ColumnFilter searchable options={f.getOptions('name')} value={f.filters.name || ''} onChange={(v) => f.setFilter('name', v)} /></span>,
      accessor: (row: any) => (
        <EditableCell
          value={row.name}
          onSave={(val) => handleUpdateField(row.id, 'name', val)}
        />
      ),
    },
    {
      filterActive: f.isActive('email'),
      header: <span className="inline-flex items-center">Email<ColumnFilter searchable options={f.getOptions('email')} value={f.filters.email || ''} onChange={(v) => f.setFilter('email', v)} /></span>,
      accessor: (row: any) => (
        <EditableCell
          value={row.email}
          onSave={(val) => handleUpdateField(row.id, 'email', val)}
        />
      ),
    },
    {
      filterActive: f.isActive('departments'),
      header: <span className="inline-flex items-center">Departments<ColumnFilter searchable options={f.getOptions('departments')} value={f.filters.departments || ''} onChange={(v) => f.setFilter('departments', v)} /></span>,
      accessor: (row: any) => {
        const depts = (row.adminDepartments || []).map((ad: any) => ad.department?.name).filter(Boolean);

        if (editingDepts === row.id) {
          return (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {departments.map(dept => {
                  const isSelected = selectedDeptIds.includes(dept.id);
                  return (
                    <button
                      key={dept.id}
                      onClick={() => toggleDept(dept.id)}
                      className={`px-2.5 py-1 text-xs font-bold rounded-full border transition-colors ${
                        isSelected
                          ? 'bg-brand text-white border-brand'
                          : 'bg-surface text-muted border-line hover:border-brand'
                      }`}
                    >
                      {dept.name}
                    </button>
                  );
                })}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleSaveDepts(row.id)}
                  className="text-xs text-green-700 dark:text-green-300 font-bold hover:text-green-800 dark:text-green-200 bg-green-50 dark:bg-green-400/15 px-2 py-1 rounded"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingDepts(null)}
                  className="text-xs text-faint font-bold hover:text-ink bg-surface px-2 py-1 rounded"
                >
                  Cancel
                </button>
              </div>
            </div>
          );
        }

        return (
          <div className="flex items-center gap-2 flex-wrap">
            {depts.length > 0 ? depts.map((name: string, i: number) => (
              <span key={i} className="bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 text-xs px-2 py-0.5 rounded-full font-bold border border-blue-200 dark:border-blue-400/30">
                {name}
              </span>
            )) : (
              <span className="text-faint text-xs italic">No departments</span>
            )}
            <button
              onClick={() => handleStartEditDepts(row)}
              className="text-xs text-brand font-bold hover:underline ml-1"
            >
              Edit
            </button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex justify-between items-center bg-card p-4 md:p-6 rounded-lg shadow-sm border border-line-soft">
        <div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Admin Management ({total})</h2>
          <p className="text-sm md:text-[15px] text-muted mt-1.5">Manage administrators and their department assignments.</p>
        </div>
        <button
          onClick={() => setIsModalOpen(true)}
          className="bg-brand hover:bg-brand-dark text-white px-4 py-2 rounded-full font-bold text-sm transition-colors shadow-sm"
        >
          + Add Admin
        </button>
      </div>

      <div className="bg-card rounded-lg shadow-sm border border-line-soft py-4 space-y-3">
        <div className="px-4 md:px-6"><SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search admins by name or email..." /></div>
        <DataTable
          columns={columns}
          data={f.pageRows}
          isLoading={isLoading}
          keyExtractor={(row) => row.id}
          emptyStateMessage="No administrators found."
        />
        <Pagination currentPage={f.page} totalPages={f.totalPages} onPageChange={f.setPage} />
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title="Add New Admin">
        <UserForm
          departments={departments}
          allowedRoles={[UserRole.ADMIN]}
          onSubmit={handleSubmit}
          isLoading={isSubmitting}
        />
      </Modal>
    </div>
  );
};
