import { useEffect, useMemo, useState } from 'react';
import { useUsers, useDepartments, useTableFilters, usePagedFilters, useServerPagination, FilterSpec } from '@/hooks';
import { UserRole } from '@/types';
import { DataTable, Modal, ColumnFilter, Pagination, SearchInput } from '@/components/ui';
import { UserForm } from '@/components/forms';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { extractErrorMessage, cachedGet } from '@/lib';
import { DemoteManagerModal } from '../components/DemoteManagerModal';


export const AdminUserManagementPage = () => {
    // useUsers stays lazy (its list query is disabled until fetchUsers runs, which
    // we never call) — we only borrow its mutations. Listing goes through the
    // paginated hooks below so the full user set is never pulled into the client.
    const { createUser, updateUser, promoteUser, demoteUser } = useUsers();
    const { departments, fetchDepartments } = useDepartments();
    const { addToast } = useToast();
    const confirm = useConfirm();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [selectedUser, setSelectedUser] = useState<any>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Manager row pending demotion to USER — drives the reassignment modal.
    const [demoteTarget, setDemoteTarget] = useState<any>(null);
    const [isDemoting, setIsDemoting] = useState(false);
    // Full managers list for the reporting-manager dropdown — a user being
    // created may need to report to a manager who isn't on the current page.
    const [allManagers, setAllManagers] = useState<any[]>([]);

    const managersP = useServerPagination<any>({ loadAll: true, endpoint: '/users/paginated', params: { role: 'MANAGER' } });
    const standardP = useServerPagination<any>({ loadAll: true, endpoint: '/users/paginated', params: { tab: 'STANDARD' } });
    const refetchAll = () => { managersP.refetch(); standardP.refetch(); };

    useEffect(() => { fetchDepartments(); }, [fetchDepartments]);

    useEffect(() => {
        (async () => {
            try {
                const body = await cachedGet<any>('/users/directory');
                const dir = body?.data ?? body ?? [];
                setAllManagers(dir.filter((u: any) => u.role === UserRole.MANAGER));
            } catch (e: any) {
                addToast(extractErrorMessage(e, 'Failed to load managers'), 'error');
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleSubmit = async (data: any) => {
        setIsSubmitting(true);
        try {
            if (selectedUser) {
                await updateUser(selectedUser.id, data);
            } else {
                await createUser(data);
            }
            setIsModalOpen(false);
            setSelectedUser(null);
            refetchAll();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to save user'), 'error');
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleEdit = (user: any) => {
        setSelectedUser(user);
        setIsModalOpen(true);
    };

    // ADMINs can only promote USER → MANAGER (the MANAGER → ADMIN rung is
    // gated server-side to SUPER_ADMIN, so we don't even surface the button
    // on manager rows). Confirmation matters — this expands what the user
    // can do system-wide and clears their existing reporting line.
    const handlePromote = async (row: any) => {
        if (row.role !== UserRole.USER) return;
        const ok = await confirm({
            title: 'Promote user',
            tone: 'default',
            confirmLabel: 'Promote',
            message: `Promote ${row.name} from USER to MANAGER?\n\nThey will be able to create users in their department and approve requests from their reports. Their existing reporting line will be cleared.`,
        });
        if (!ok) return;
        try {
            await promoteUser(row.id, 'MANAGER');
            addToast(`${row.name} promoted to MANAGER`, 'success');
            // Promotion moves the row out of Standard and into Managers — refresh both.
            refetchAll();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to promote'), 'error');
        }
    };

    // Demote MANAGER → USER. The modal forces a decision on the manager's
    // reports (reassign to a replacement vs. explicitly leave unassigned), so
    // the team is never silently orphaned. Backend re-points the rows + reports
    // back how many moved / were left, which we echo in the toast.
    const handleDemoteConfirm = async (reassignToManagerId: string | null) => {
        if (!demoteTarget) return;
        setIsDemoting(true);
        try {
            const res = await demoteUser(demoteTarget.id, 'USER', reassignToManagerId);
            const moved = res?.reportsReassigned ?? 0;
            const left = res?.reportsUnassigned ?? 0;
            const suffix = moved > 0
                ? ` — ${moved} report${moved === 1 ? '' : 's'} reassigned`
                : left > 0
                    ? ` — ${left} report${left === 1 ? '' : 's'} left unassigned`
                    : '';
            addToast(`${demoteTarget.name} demoted to USER${suffix}`, 'success');
            setDemoteTarget(null);
            // Demotion moves the row out of Managers and into Standard — refresh both.
            refetchAll();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to demote'), 'error');
        } finally {
            setIsDemoting(false);
        }
    };

    const buildColumns = (f: ReturnType<typeof useTableFilters<any>>) => [
        { filterActive: f.isActive('name'),       header: <span className="inline-flex items-center">Name<ColumnFilter searchable options={f.getOptions('name')}  value={f.filters.name  || ''} onChange={(v) => f.setFilter('name', v)}  /></span>,  accessor: 'name' as const },
        { filterActive: f.isActive('email'),      header: <span className="inline-flex items-center">Email<ColumnFilter searchable options={f.getOptions('email')} value={f.filters.email || ''} onChange={(v) => f.setFilter('email', v)} /></span>, accessor: 'email' as const },
        { filterActive: f.isActive('role'),       header: <span className="inline-flex items-center">Role<ColumnFilter options={f.getOptions('role')}                  value={f.filters.role  || ''} onChange={(v) => f.setFilter('role', v)}  /></span>,  accessor: 'role' as const },
        { filterActive: f.isActive('department'), header: <span className="inline-flex items-center">Department<ColumnFilter options={f.getOptions('department')}      value={f.filters.department || ''} onChange={(v) => f.setFilter('department', v)} /></span>, accessor: (row: any) => (row?.department?.name || 'Unknown') },
        { header: 'Actions', accessor: (row: any) => (
            <div className="flex items-center gap-2 whitespace-nowrap">
                <button onClick={() => handleEdit(row)} className="bg-brand/10 hover:bg-brand/20 text-brand-700 px-3 py-1.5 rounded text-sm font-bold transition-colors">
                    Edit
                </button>
                {row.role === UserRole.USER && (
                    <button
                        onClick={() => handlePromote(row)}
                        className="text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 px-2 py-1 rounded hover:bg-emerald-100 dark:bg-emerald-400/20 transition-colors"
                        title="Promote to Manager"
                    >
                        ↑ Manager
                    </button>
                )}
                {row.role === UserRole.MANAGER && (
                    <button
                        onClick={() => setDemoteTarget(row)}
                        className="text-xs font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 px-2 py-1 rounded hover:bg-amber-100 dark:bg-amber-400/20 transition-colors"
                        title="Demote to User"
                    >
                        ↓ User
                    </button>
                )}
            </div>
        )}
    ];

    // Per-column filters operate on the CURRENT PAGE only (10 rows). The search
    // box above each table is the canonical full-dataset filter (server-side);
    // per-column is a row-level convenience, matching the Super Admin page.
    const userFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'name',       getValue: (r) => r.name },
        { key: 'email',      getValue: (r) => r.email },
        { key: 'role',       getValue: (r) => r.role },
        { key: 'department', getValue: (r) => r.department?.name || 'Unknown' },
    ], []);

    const managersF = usePagedFilters(managersP.items, userFilterSpecs, 10, managersP.search);
    const usersF = usePagedFilters(standardP.items, userFilterSpecs, 10, standardP.search);

    const managersCols = buildColumns(managersF);
    const usersCols = buildColumns(usersF);

    return (
        <div className="space-y-8">
            <div className="flex justify-between items-center">
                <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">User Management</h2>
                <button
                    onClick={() => { setSelectedUser(null); setIsModalOpen(true); }}
                    className="bg-brand hover:bg-brand-dark text-white px-4 py-2 rounded-full font-medium text-sm transition-colors shadow-sm"
                >
                    Add User
                </button>
            </div>

            <div className="space-y-4">
                <h3 className="text-lg border-b pb-2 font-bold text-ink">Managers</h3>
                <div className="bg-card rounded-lg shadow-sm border border-line-soft py-4 space-y-3">
                    <div className="px-4 md:px-6"><SearchInput value={managersP.search} onChange={(e) => managersP.setSearch(e.target.value)} placeholder="Search managers by name or email..." /></div>
                    <DataTable
                        columns={managersCols}
                        data={managersF.pageRows}
                        isLoading={managersP.isLoading}
                        keyExtractor={r=>r.id}
                        emptyStateMessage="No managers found."
                    />
                    <div className="px-4 md:px-6">
                    <Pagination
                        currentPage={managersF.page}
                        totalPages={managersF.totalPages}
                        onPageChange={managersF.setPage}
                    />
                </div>
                </div>
            </div>

            <div className="space-y-4">
                <h3 className="text-lg border-b pb-2 font-bold text-ink">Standard Users & Lab Viewers</h3>
                <div className="bg-card rounded-lg shadow-sm border border-line-soft py-4 space-y-3">
                    <div className="px-4 md:px-6"><SearchInput value={standardP.search} onChange={(e) => standardP.setSearch(e.target.value)} placeholder="Search users by name or email..." /></div>
                    <DataTable
                        columns={usersCols}
                        data={usersF.pageRows}
                        isLoading={standardP.isLoading}
                        keyExtractor={r=>r.id}
                        emptyStateMessage="No users found."
                    />
                    <div className="px-4 md:px-6">
                    <Pagination
                        currentPage={usersF.page}
                        totalPages={usersF.totalPages}
                        onPageChange={usersF.setPage}
                    />
                </div>
                </div>
            </div>

            <Modal isOpen={isModalOpen} onClose={() => { setIsModalOpen(false); setSelectedUser(null); }} title={selectedUser ? "Edit User" : "Add User"}>
                <UserForm
                    initialData={selectedUser}
                    departments={departments}
                    allowedRoles={[UserRole.MANAGER, UserRole.USER]}
                    managers={allManagers}
                    onSubmit={handleSubmit}
                    isLoading={isSubmitting}
                />
            </Modal>

            <DemoteManagerModal
                manager={demoteTarget}
                managers={allManagers}
                onClose={() => setDemoteTarget(null)}
                onConfirm={handleDemoteConfirm}
                isSubmitting={isDemoting}
            />
        </div>
    );
};
