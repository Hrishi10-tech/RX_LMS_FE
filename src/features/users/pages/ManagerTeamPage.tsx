import { FormEvent, useMemo, useState } from 'react';
import { useUsers, useServerPagination, usePagedFilters, FilterSpec } from '@/hooks';
import { useAuth } from '@/context/AuthContext';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { DataTable, Modal, SearchInput, Pagination, ColumnFilter } from '@/components/ui';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { UserRole } from '@/types';
import { Plus } from 'lucide-react';
import { passwordProblem } from '@/lib/passwordRule';

// Manager-side team page. The backend (users.service.ts create() — MANAGER
// branch) enforces every constraint server-side: role is forced to USER,
// departmentId is forced to the manager's own, and managerId is forced to
// the calling manager's id. That means this form only needs to collect the
// fields the backend can't infer (name / email / password). Anything else
// the client sends is overridden.

export const ManagerTeamPage = () => {
    const { user: currentUser } = useAuth();
    const { addToast } = useToast();
    // useUsers stays lazy (its list query never runs — we only borrow createUser).
    // The whole team loads (it is one department), so the column filters see
    // every member, not just the ten on the current page. /users/paginated
    // already scopes to this manager's people and does the search.
    const { createUser } = useUsers();
    const {
        items: users, total,
        search, setSearch, isLoading, refetch,
    } = useServerPagination<any>({ loadAll: true, endpoint: '/users/paginated' });

    const [isAddOpen, setIsAddOpen] = useState(false);
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [submitting, setSubmitting] = useState(false);

    const resetForm = () => { setName(''); setEmail(''); setPassword(''); };

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        if (!name.trim() || !email.trim() || !password.trim()) {
            addToast('Name, email, and password are required.', 'error');
            return;
        }
        // Same rule the server enforces (8+ characters, a letter and a digit).
        const pwErr = passwordProblem(password);
        if (pwErr) { addToast(pwErr, 'error'); return; }
        setSubmitting(true);
        try {
            // The DTO requires `role`, so we send USER explicitly. The backend's
            // MANAGER branch validates it (must be USER) and forces departmentId
            // + managerId from the JWT claim, so a crafted POST can't escalate.
            await createUser({
                name: name.trim(),
                email: email.trim(),
                password,
                role: UserRole.USER,
            });
            addToast(`Added ${name.trim()} to your team.`, 'success');
            resetForm();
            setIsAddOpen(false);
            refetch();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to create user'), 'error');
        } finally {
            setSubmitting(false);
        }
    };

    // A filter on every data column (owner, 27 Oct).
    const filterSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'name', getValue: (r) => r.name },
        { key: 'email', getValue: (r) => r.email },
        { key: 'dept', getValue: (r) => r.department?.name || '-' },
        { key: 'added', getValue: (r) => (r.createdAt ? fmtDate(r.createdAt) : '-') },
    ], []);
    const f = usePagedFilters(users, filterSpecs, 10, search);
    const filtered = (label: string, key: string) => ({
        filterActive: f.isActive(key),
        header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={f.getOptions(key)} value={f.filters[key] || ''} onChange={(v) => f.setFilter(key, v)} /></span>,
    });

    const columns = [
        { ...filtered('Name', 'name'), accessor: (row: any) => <span className="text-sm font-bold text-ink">{row.name}</span> },
        { ...filtered('Email', 'email'), accessor: (row: any) => <span className="text-sm text-muted">{row.email}</span> },
        { ...filtered('Department', 'dept'), accessor: (row: any) =>
            <span className="text-xs text-muted">{row.department?.name || '-'}</span>
        },
        { ...filtered('Added', 'added'), accessor: (row: any) =>
            <span className="text-xs text-faint">{row.createdAt ? fmtDateTime(row.createdAt) : '-'}</span>
        },
    ];

    return (
        <div className="space-y-4 md:space-y-6">
            <div className="flex items-start justify-between">
                <div>
                    <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">My Team ({total})</h2>
                    <p className="text-xs text-muted mt-1">
                        Users reporting to you{currentUser?.department?.name ? ` in ${currentUser.department.name}` : ''}.
                        New users you add here are automatically scoped to your department and assigned to you.
                    </p>
                </div>
                <button
                    onClick={() => setIsAddOpen(true)}
                    className="flex items-center gap-2 px-4 py-2 bg-brand text-white font-bold rounded-full hover:bg-brand-dark transition-colors text-sm shadow-sm"
                >
                    <Plus size={16} /> Add User
                </button>
            </div>

            <div className="bg-card rounded-xl shadow-sm border border-zebra overflow-hidden">
                <div className="p-4 border-b border-line-soft">
                    <SearchInput
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Search by name or email..."
                    />
                </div>
                <DataTable
                    columns={columns}
                    data={f.pageRows}
                    isLoading={isLoading}
                    keyExtractor={(r) => r.id}
                    emptyStateMessage={users.length
                        ? 'Nobody on your team matches these filters.'
                        : search
                            ? 'Nobody on your team matches that search.'
                            : 'No team members yet — click Add User to create one.'}
                    maxHeight="65vh"
                />
                <div className="p-4 border-t border-line-soft">
                    <Pagination currentPage={f.page} totalPages={f.totalPages} onPageChange={f.setPage} />
                </div>
            </div>

            <Modal isOpen={isAddOpen} onClose={() => { setIsAddOpen(false); resetForm(); }} title="Add User to Your Team">
                <form noValidate onSubmit={handleSubmit} className="space-y-4">
                    <div className="bg-surface border border-line-soft rounded-lg p-3 text-xs text-muted">
                        <p>
                            New user will be added to <span className="font-bold text-ink">{currentUser?.department?.name || 'your department'}</span>
                            {' '}as a <span className="font-bold text-ink">USER</span> reporting to you. They can sign in immediately with the password you set.
                        </p>
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-ink mb-1">Full Name</label>
                        <input
                            type="text"
                            required
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="e.g. Priya Sharma"
                            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand focus:ring-2 focus:ring-brand/30 outline-none"
                            autoFocus
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-ink mb-1">Email</label>
                        <input
                            type="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="priya@example.com"
                            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand focus:ring-2 focus:ring-brand/30 outline-none"
                        />
                    </div>

                    <div>
                        <label className="block text-sm font-bold text-ink mb-1">Temporary Password</label>
                        <input
                            type="text"
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="At least 8 characters, with a letter and a number"
                            className="w-full border border-line rounded-md py-2 px-3 text-sm font-mono focus:border-brand focus:ring-2 focus:ring-brand/30 outline-none"
                        />
                        <p className="text-[10px] text-faint mt-1">
                            Share this with the user out-of-band (chat / in person). They can change it after their first sign-in.
                        </p>
                    </div>

                    <div className="flex justify-end gap-3 pt-2">
                        <button
                            type="button"
                            onClick={() => { setIsAddOpen(false); resetForm(); }}
                            className="text-sm font-bold text-muted px-4 py-2 rounded-lg hover:bg-surface transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            type="submit"
                            disabled={submitting}
                            className="text-sm font-bold bg-brand text-white px-5 py-2 rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50"
                        >
                            {submitting ? 'Creating...' : 'Add User'}
                        </button>
                    </div>
                </form>
            </Modal>
        </div>
    );
};
