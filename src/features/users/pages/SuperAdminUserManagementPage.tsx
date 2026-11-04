import { useEffect, useMemo, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { client, usersApi } from '@/api';
import { DataTable, Modal, Pagination, StatusBadge, SearchInput, BulkSelectionBar, BulkActionButton, ColumnFilter, statusLabel } from '@/components/ui';
import { useBulkSelection, usePagedFilters, FilterSpec, useAbortOnUnmount, LOAD_ALL_CAP } from '@/hooks';
import { EditableCell } from '@/components/ui/EditableCell';
import { UserForm } from '@/components/forms';
import { UserRole } from '@/types';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { fmtDateTime, dateOnlyKey } from '@/utils/date';
import { ChevronLeft, ChevronRight, Plus, Users, ShieldCheck, UserCog, User, FlaskConical } from 'lucide-react';
import { DemoteManagerModal } from '../components/DemoteManagerModal';
import { PasswordCell } from '../components/PasswordCell';
import { homeDepartmentId } from '@/lib/homeDepartment';

import { extractErrorMessage, cachedGet } from '@/lib';
import { runPerId } from '@/utils/bulk';

const PAGE_SIZE = 10;

/** Every role a Super Admin can give in the Edit form (Super Admin itself is not handed out here). */
const EDITABLE_ROLES: UserRole[] = [
  UserRole.USER, UserRole.MANAGER, UserRole.ADMIN, UserRole.LAB,
  UserRole.PROCUREMENT, UserRole.INVENTORY, UserRole.FINANCE, UserRole.ASSOCIATE_FINANCE,
];
const roleLabel = (r: string) => r.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

const TABS = [
  { key: 'all', label: 'All', icon: Users },
  { key: 'ADMIN', label: 'Admins', icon: ShieldCheck },
  { key: 'MANAGER', label: 'Managers', icon: UserCog },
  { key: 'USER', label: 'Users', icon: User },
  { key: 'SPECIAL', label: 'Others', icon: FlaskConical },
];

export const SAUserManagementPage = () => {


  const abortSignal = useAbortOnUnmount();
  const [searchParams] = useSearchParams();
  // `users` is now the CURRENT PAGE only (server-paginated + sorted by
  // createdAt DESC). `directory` is every active user, for the manager
  // pickers in the Edit and Demote forms.

  const [users, setUsers] = useState<any[]>([]);
  const [directory, setDirectory] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(searchParams.get('tab') || 'all');
  const [search, setSearch] = useState('');
  // Server pager + counts (tab badges) come back in the same /users/paginated
  // response, so the strip + table + pager are filled by a single round-trip.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({ all: 0, ADMIN: 0, MANAGER: 0, USER: 0, SPECIAL: 0 });
  // Dept ids that already have at least one ADMIN — used for the "missing
  // admin" audit alert, kept accurate across pages by the backend rollup.
  const [adminDeptCoverage, setAdminDeptCoverage] = useState<string[]>([]);
  const [showAddModal, setShowAddModal] = useState(false);
  // Row open in the full Edit form (every field, role included).
  const [editTarget, setEditTarget] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Dept assignment for admins
  const [editingDepts, setEditingDepts] = useState<string | null>(null);
  const [selectedDeptIds, setSelectedDeptIds] = useState<string[]>([]);

  // Manager row pending demotion to USER — drives the reassignment modal so the
  // demoted manager's reports are never silently orphaned.
  const [demoteTarget, setDemoteTarget] = useState<any>(null);
  const [isDemoting, setIsDemoting] = useState(false);

  const { addToast } = useToast();
  const confirm = useConfirm();
  const { selectedIds, toggleSelect, toggleSelectAllVisible, clearSelection } = useBulkSelection();

  // Newest request wins — a slower, older answer must not overwrite it.
  const fetchSeq = useRef(0);
  const fetchUsers = async () => {
    const seq = ++fetchSeq.current;
    setIsLoading(true);
    try {
      // Every user in the tab, in server-sized chunks: the column filters run
      // in the browser and used to see only the current 10 rows (Department =
      // Hardware missed anyone on page 2). The result is paged by usePagedFilters.
      const all: any[] = [];
      let payload: any = {};
      // Advance by what came back — /users/paginated serves at most 100 a call.
      while (all.length < LOAD_ALL_CAP) {
        const params = new URLSearchParams();
        params.set('take', '100');
        params.set('skip', String(all.length));
        if (activeTab === 'SPECIAL') params.set('tab', 'SPECIAL');
        else if (activeTab !== 'all') params.set('role', activeTab);
        if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
        const res = await client.get(`/users/paginated?${params.toString()}`, { signal: abortSignal() });
        payload = res.data?.data ?? res.data ?? {};
        const rows = payload.items || [];
        all.push(...rows);
        if (rows.length === 0 || all.length >= (payload.total ?? 0)) break;
      }
      if (seq !== fetchSeq.current) return;
      setUsers(all);
      setCounts(payload.counts ?? { all: 0, ADMIN: 0, MANAGER: 0, USER: 0, SPECIAL: 0 });
      setAdminDeptCoverage(payload.adminDeptCoverage ?? []);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to load users'), 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // One-time fetches: departments (for the picker chips + audit) and the full
  // directory (for the manager pickers).
  useEffect(() => {
    (async () => {
      try {
        const [deptRes, dirRes] = await Promise.all([
          cachedGet<any>('/departments'),
          cachedGet<any>('/users/directory'),
        ]);
        setDepartments(deptRes?.data || deptRes || []);
        setDirectory(dirRes?.data || dirRes || []);
      } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to load reference data'), 'error'); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-time fetch of departments + directory on mount; addToast is used only in the error branch and must not retrigger the fetch
  }, []);

  // Debounce the search input — 300ms after the user stops typing.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Switching tab or narrowing the search must reset to page 1 — otherwise the
  // pager points at a page that may no longer exist in the new result set.

  // Refetch whenever the page / filters change. fetchUsers is intentionally
  // omitted from deps — we refetch on page/filter change, not on the callback's
  // identity changing — and the disable is placed on its own line so it's a
  // real (not vacuous) suppression if exhaustive-deps ever flags it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { fetchUsers(); }, [debouncedSearch, activeTab]);

  const handleCreateUser = async (data: any) => {
    setIsSubmitting(true);
    try {
      await client.post('/users', data);
      addToast('User created', 'success');
      setShowAddModal(false);
      fetchUsers();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
    setIsSubmitting(false);
  };

  const handleEditUser = async (data: any) => {
    if (!editTarget) return;
    if (data.role && !await confirm(
      `Change ${editTarget.name} from ${roleLabel(editTarget.role)} to ${roleLabel(data.role)}? They will be told, and what they can see changes straight away.`,
    )) return;
    setIsSubmitting(true);
    try {
      await client.patch(`/users/${editTarget.id}`, data);
      addToast(`${editTarget.name} updated`, 'success');
      setEditTarget(null);
      fetchUsers();
      // A role change can add or remove a manager from the pickers.
      cachedGet<any>('/users/directory').then((r) => setDirectory(r?.data || r || [])).catch(() => {});
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to save'), 'error'); }
    setIsSubmitting(false);
  };

  const handleUpdateField = async (userId: string, field: string, value: any) => {
    try {
      await client.patch(`/users/${userId}`, { [field]: value });
      addToast('Updated', 'success');
      fetchUsers();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
  };

  // Deactivate is the normal "remove a user": they can't log in or be assigned
  // anything new, but their row + all history stay intact. Reversible.
  const handleDeactivateUser = async (userId: string, userName: string) => {
    if (!await confirm(
      `Deactivate ${userName}? They will no longer be able to log in and cannot be assigned new approvals, requests, or chats. Their existing data and history are kept, and you can reactivate them anytime.`,
    )) return;
    try {
      await usersApi.deactivate(userId);
      addToast(`${userName} deactivated`, 'success');
      fetchUsers();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to deactivate'), 'error'); }
  };

  const handleReactivateUser = async (userId: string, userName: string) => {
    try {
      await usersApi.reactivate(userId);
      addToast(`${userName} reactivated`, 'success');
      fetchUsers();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to reactivate'), 'error'); }
  };

  // Permanent delete: physical removal, allowed only when the account has no
  // linked data (the backend refuses otherwise and tells you to deactivate).
  const handlePermanentDeleteUser = async (userId: string, userName: string) => {
    if (!await confirm(
      `Permanently delete ${userName}? This physically removes the account and cannot be undone. It only works if they have no linked records — otherwise deactivate instead.`,
    )) return;
    try {
      await client.delete(`/users/${userId}`);
      addToast(`${userName} permanently deleted`, 'success');
      fetchUsers();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to delete'), 'error'); }
  };

  // Promotion goes up one rung only — USER → MANAGER or MANAGER → ADMIN. The
  // backend enforces the matrix (and SUPER_ADMIN-only for the ADMIN step), so
  // the UI just needs to surface the right next-rung label and pass through.
  const handlePromote = async (row: any) => {
    const nextRole: 'MANAGER' | 'ADMIN' | 'FINANCE' | null =
      row.role === UserRole.USER ? 'MANAGER'
      : row.role === UserRole.MANAGER ? 'ADMIN'
      // Finance is its own ladder, not a rung above Admin — the only way onto
      // it is from Associate Finance.
      : row.role === UserRole.ASSOCIATE_FINANCE ? 'FINANCE'
      : null;
    if (!nextRole) return;
    const verb = `Promote ${row.name} from ${row.role} to ${nextRole}?`;
    const detail = nextRole === 'ADMIN'
      ? 'They will gain admin scope over their current department and be able to manage other users in it.'
      : nextRole === 'FINANCE'
      ? 'They will see and be able to pay the whole payment queue, not just what was delegated to them, and can delegate to other Associates. Anyone already Finance stays Finance — you can have several. Payments already assigned to this person stay theirs.'
      : 'They will be able to create users in their department and approve requests from their reports. Their existing reporting line will be cleared.';
    if (!await confirm(`${verb}\n\n${detail}`)) return;
    try {
      await client.post(`/users/${row.id}/promote`, { role: nextRole });
      addToast(`${row.name} promoted to ${nextRole}`, 'success');
      fetchUsers();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to promote'), 'error');
    }
  };

  // Symmetric counterpart of handlePromote — for when an accidental promotion
  // needs to be undone. Backend enforces the same authority + cleans up
  // adminDepartments / managerUser rows so the role and its side-effects
  // disappear together.
  const handleDemote = async (row: any) => {
    const prevRole: 'MANAGER' | 'USER' | 'ASSOCIATE_FINANCE' | null =
      row.role === UserRole.ADMIN ? 'MANAGER'
      : row.role === UserRole.MANAGER ? 'USER'
      : row.role === UserRole.FINANCE ? 'ASSOCIATE_FINANCE'
      : null;
    if (!prevRole) return;
    if (prevRole === 'ASSOCIATE_FINANCE') {
      // The undo for a mistaken Finance promotion. The backend refuses to
      // demote the last active Finance user, so this cannot strand payments.
      const okFin = await confirm({
        title: 'Demote Finance user',
        tone: 'danger',
        confirmLabel: 'Demote',
        message: `Demote ${row.name} from Finance to Associate Finance?\n\nThey will stop seeing the full payment queue and will only see payments another Finance user delegates to them. Payments already assigned to them stay assigned.`,
      });
      if (!okFin) return;
      try {
        await client.post(`/users/${row.id}/demote`, { role: prevRole });
        addToast(`${row.name} demoted to Associate Finance`, 'success');
        fetchUsers();
      } catch (e: any) {
        addToast(extractErrorMessage(e, 'Failed to demote'), 'error');
      }
      return;
    }
    // MANAGER → USER carries a team that must not be silently orphaned — defer
    // to the reassignment modal, which forces a reassign-vs-unassign decision.
    if (prevRole === 'USER') {
      setDemoteTarget(row);
      return;
    }
    // ADMIN → MANAGER: no reports concept, just strips admin scope. Plain confirm.
    const okGo = await confirm({
      title: 'Demote user',
      tone: 'danger',
      confirmLabel: 'Demote',
      message: `Demote ${row.name} from ${row.role} to ${prevRole}?\n\nThey will lose admin scope across every department they currently administer. They keep their primary department as a regular manager.`,
    });
    if (!okGo) return;
    try {
      await client.post(`/users/${row.id}/demote`, { role: prevRole });
      addToast(`${row.name} demoted to ${prevRole}`, 'success');
      fetchUsers();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to demote'), 'error');
    }
  };

  // Modal path for MANAGER → USER — applies the chosen report handling.
  const handleDemoteConfirm = async (reassignToManagerId: string | null) => {
    if (!demoteTarget) return;
    setIsDemoting(true);
    try {
      const res = await client.post(`/users/${demoteTarget.id}/demote`,
        reassignToManagerId ? { role: 'USER', reassignToManagerId } : { role: 'USER' });
      const data = res.data?.data ?? res.data ?? {};
      const moved = data.reportsReassigned ?? 0;
      const left = data.reportsUnassigned ?? 0;
      const suffix = moved > 0
        ? ` — ${moved} report${moved === 1 ? '' : 's'} reassigned`
        : left > 0
          ? ` — ${left} report${left === 1 ? '' : 's'} left unassigned`
          : '';
      addToast(`${demoteTarget.name} demoted to USER${suffix}`, 'success');
      setDemoteTarget(null);
      fetchUsers();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to demote'), 'error');
    } finally {
      setIsDemoting(false);
    }
  };

  const handleSaveDepts = async (userId: string) => {
    try {
      await client.patch(`/users/${userId}`, { adminDepartmentIds: selectedDeptIds });
      addToast('Departments updated', 'success');
      setEditingDepts(null);
      fetchUsers();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
  };


  // Per-column filters operate on the CURRENT PAGE only (10 rows). The tab
  // strip + search box above are the canonical full-dataset filters and go
  // through the backend; per-column is a row-level convenience.
  const filterSpecs = useMemo<FilterSpec<any>[]>(() => [
    { key: 'name',       getValue: (r) => r.name },
    { key: 'email',      getValue: (r) => r.email },
    // Role was the one data column without a filter (owner, 27 Oct).
    { key: 'role',       getValue: (r) => (r.role ? statusLabel(r.role) : null) },
    // One value per department (multi-valued column). Joined into "Hardware,
    // Quality and Testing, Software", an admin of three departments matched
    // none of them when you filtered by one.
    { key: 'department', getValue: (r) => {
        if (r.role === UserRole.ADMIN || r.role === UserRole.LAB) {
          const names = ([...new Set((r.adminDepartments || []).map((ad: any) => ad.department?.name).filter(Boolean))] as string[]).sort();
          return names.length ? names : null;
        }
        return r.department?.name
          || departments.find((d: any) => d.id === homeDepartmentId(r.role, departments))?.name
          || null;
      } },
    { key: 'manager',    getValue: (r) => {
        if (r.role !== UserRole.USER && r.role !== UserRole.LAB) return null;
        // Same list the column shows — filtering by Pooja finds everyone she covers.
        const names = (r.coveringManagers ?? []).map((m: any) => m.name);
        return names.length ? names : 'No manager';
    }},
    { key: 'created',    getValue: (r) => dateOnlyKey(r.createdAt) },
  ], [departments]);

  const f = usePagedFilters(users, filterSpecs, PAGE_SIZE, `${debouncedSearch}|${activeTab}`);

  // Audit warning: departments without an ADMIN. Uses the server-provided
  // `adminDeptCoverage` so the alert stays correct even with pagination.
  const deptsWithAdmins = new Set(adminDeptCoverage);
  const missingAdminDepts = departments.filter(d => !deptsWithAdmins.has(d.id));

  // The password / created / role-change columns are collapsed behind a single
  // chevron at the right edge. They stay COLUMNS — expanding widens the table
  // rather than pushing a panel under each row, because this table is read by
  // scanning down a column and a per-row panel breaks that scan.
  const [detailsOpenRaw, setDetailsOpen] = useState(false);
  // Forced open while a filter inside the group is active: collapsing would
  // hide the control holding the filter, leaving a narrowed list with no
  // visible reason and no way to clear it.
  const detailsOpen = detailsOpenRaw || f.isActive('created');

  const columns: any[] = [
    { filterActive: f.isActive('name'),       header: <span className="inline-flex items-center">Name<ColumnFilter searchable options={f.getOptions('name')}        value={f.filters.name       || ''} onChange={(v) => f.setFilter('name', v)}       /></span>, accessor: (row: any) => (
      <div className="flex items-center gap-2">
        <EditableCell value={row.name} onSave={(val) => handleUpdateField(row.id, 'name', val)} />
        {row.isActive === false && (
          <span className="shrink-0 text-[9px] font-bold uppercase tracking-wide text-muted bg-hover border border-line px-1.5 py-0.5 rounded-full" title="Deactivated — no login, not assignable">Inactive</span>
        )}
      </div>
    )},
    { filterActive: f.isActive('email'),      header: <span className="inline-flex items-center">Email<ColumnFilter searchable options={f.getOptions('email')}      value={f.filters.email      || ''} onChange={(v) => f.setFilter('email', v)}      /></span>, accessor: (row: any) => (
      <EditableCell value={row.email} onSave={(val) => handleUpdateField(row.id, 'email', val)} />
    )},
    { filterActive: f.isActive('role'),       header: <span className="inline-flex items-center">Role<ColumnFilter searchable options={f.getOptions('role')}        value={f.filters.role       || ''} onChange={(v) => f.setFilter('role', v)}       /></span>, accessor: (row: any) => <StatusBadge status={row.role} /> },
    { filterActive: f.isActive('department'), header: <span className="inline-flex items-center">Department<ColumnFilter searchable options={f.getOptions('department')} value={f.filters.department || ''} onChange={(v) => f.setFilter('department', v)} /></span>, accessor: (row: any) => {
      // ADMIN → multi-dept (departments they administer).
      // LAB   → multi-dept (one lab can serve multiple departments — physically
      //         common in a shared facility setup). When empty, lab keeps its
      //         legacy "sees everything" behaviour; once assigned, it scopes to
      //         the chosen departments.
      const isMultiDept = row.role === UserRole.ADMIN || row.role === UserRole.LAB;
      if (isMultiDept) {
        const depts = [...new Set<string>((row.adminDepartments || []).map((ad: any) => ad.department?.name).filter(Boolean))];
        const emptyLabel = row.role === UserRole.LAB ? 'All departments' : 'None';
        const pillColor = row.role === UserRole.LAB
          ? 'bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-400/30'
          : 'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30';

        if (editingDepts === row.id) {
          return (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1">
                {departments.map(dept => (
                  <button key={dept.id} onClick={() => setSelectedDeptIds(prev => prev.includes(dept.id) ? prev.filter(id => id !== dept.id) : [...prev, dept.id])}
                    className={`px-2 py-0.5 text-[10px] font-bold rounded-full border transition-colors ${selectedDeptIds.includes(dept.id) ? 'bg-brand text-white border-brand' : 'bg-surface text-muted border-line'}`}>
                    {dept.name}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                <button onClick={() => handleSaveDepts(row.id)} className="text-[10px] text-green-700 dark:text-green-300 font-bold bg-green-50 dark:bg-green-400/15 px-2 py-0.5 rounded">Save</button>
                <button onClick={() => setEditingDepts(null)} className="text-[10px] text-faint font-bold bg-surface px-2 py-0.5 rounded">Cancel</button>
              </div>
            </div>
          );
        }

        return (
          <div className="flex items-center gap-1 flex-wrap">
            {depts.length > 0 ? depts.map((name: string, i: number) => (
              <span key={i} className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold border ${pillColor}`}>{name}</span>
            )) : <span className="text-[10px] text-faint italic">{emptyLabel}</span>}
            <button onClick={() => { setEditingDepts(row.id); setSelectedDeptIds((row.adminDepartments || []).map((ad: any) => ad.departmentId)); }}
              className="text-[10px] text-brand font-bold hover:underline ml-1">Edit</button>
          </div>
        );
      }

      // Cross-department roles (INVENTORY / PROCUREMENT / FINANCE /
      // ASSOCIATE_FINANCE) intentionally have no dept assignment —
      // they operate org-wide. Show that plainly instead of an
      // editable dropdown that has no real effect.
      if (['INVENTORY', 'PROCUREMENT', 'FINANCE', 'ASSOCIATE_FINANCE'].includes(row.role)) {
        // Their own team is a department too (their needs are raised under it),
        // while their work still covers every department.
        const home = departments.find((d: any) => d.id === homeDepartmentId(row.role, departments));
        return <span className="text-xs text-ink">{home?.name ?? '—'}</span>;
      }

      // MANAGER / USER — single-dept dropdown.
      return (
        <EditableCell
          type="select"
          options={departments.map(d => ({ value: d.id, label: d.name }))}
          value={row.departmentId}
          onSave={(val) => handleUpdateField(row.id, 'departmentId', val)}
        />
      );
    }},
    ...((activeTab === 'USER' || activeTab === 'all') ? [{ filterActive: f.isActive('manager'), header: <span className="inline-flex items-center">Manager<ColumnFilter searchable options={f.getOptions('manager')} value={f.filters.manager || ''} onChange={(v) => f.setFilter('manager', v)} /></span>, accessor: (row: any) => {
      if (row.role !== UserRole.USER && row.role !== UserRole.LAB) return <span className="text-[10px] text-faint">—</span>;
      // Everyone who covers them: assigned managers first, then the managers
      // of their department (who cover them without any assignment).
      const covering: any[] = row.coveringManagers ?? [];
      if (!covering.length) return <span className="text-xs text-faint">No manager</span>;
      return <span className="text-xs text-secondary">{covering.map((m: any) => m.name).join(', ')}</span>;
    }}] : []),
    // Password column — Super Admin only, and the server enforces that too:
    // /users/paginated omits the visibility field for every other role, and
    // GET /users/:id/password refuses them outright. Masked until clicked; the
    // list carries no passwords, only which state each row is in.
    // Actions column: Promote (next-rung up) for USER + MANAGER rows, Demote
    // (next-rung down) for ADMIN + MANAGER rows — the symmetric counterpart so
    // accidental promotions can be reverted without deleting + recreating the
    // user (which would lose their audit trail). Delete shows on the ADMIN +
    // SPECIAL tabs (matching the previous behaviour).
    // Actions: Promote/Demote unchanged. For lifecycle we now use Deactivate
    // (retire, reversible) as the primary action for every non-SUPER_ADMIN role
    // — safe because it preserves all data. An already-inactive user shows
    // Reactivate plus a Delete-permanently escape hatch (backend refuses if the
    // account has linked records).
    // --- the collapsible group: password, created, role changes ---
    //
    // Kept as COLUMNS rather than folded into a per-row panel: this table is
    // read by scanning DOWN a column, and a panel per row turns one glance
    // into eleven clicks. The toggle lives in the toolbar above rather than in
    // a column of its own — as a column it was a strip of empty cells that
    // opened a gap through the middle of the table.
    ...(detailsOpen ? [
      { header: 'Password', accessor: (row: any) => (
        <PasswordCell
          userId={row.id}
          visibility={row.passwordVisibility}
          setByName={row.passwordSetByName}
          setAt={row.passwordSetAt}
        />
      )},
      { filterActive: f.isActive('created'), header: <span className="inline-flex items-center">Created<ColumnFilter searchable options={f.getOptions('created')} value={f.filters.created || ''} onChange={(v) => f.setFilter('created', v)} /></span>, accessor: (row: any) => (
        <span className="text-xs text-muted">{fmtDateTime(row.createdAt)}</span>
      )},
      // Not 'Role' — there is already a ROLE column showing the badge, and two
      // headers with the same word is its own small confusion.
      { header: 'Change role', accessor: (row: any) => {
        const nextRole: 'MANAGER' | 'ADMIN' | 'FINANCE' | null =
          row.role === UserRole.USER ? 'MANAGER'
          : row.role === UserRole.MANAGER ? 'ADMIN'
          : row.role === UserRole.ASSOCIATE_FINANCE ? 'FINANCE'
          : null;
        const prevRole: 'MANAGER' | 'USER' | 'ASSOCIATE_FINANCE' | null =
          row.role === UserRole.ADMIN ? 'MANAGER'
          : row.role === UserRole.MANAGER ? 'USER'
          : row.role === UserRole.FINANCE ? 'ASSOCIATE_FINANCE'
          : null;
        if (row.isActive === false || (!nextRole && !prevRole)) {
          return <span className="text-xs italic text-faint">—</span>;
        }
        return (
          <div className="flex items-center gap-2 whitespace-nowrap">
            {nextRole && (
              <button
                onClick={() => handlePromote(row)}
                className="text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 px-2 py-0.5 rounded hover:bg-emerald-100 dark:hover:bg-emerald-400/20 transition-colors"
                title={`Promote to ${nextRole}`}
              >
                ↑ {nextRole === 'MANAGER' ? 'Manager' : nextRole === 'FINANCE' ? 'Finance' : 'Admin'}
              </button>
            )}
            {prevRole && (
              <button
                onClick={() => handleDemote(row)}
                className="text-xs font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 px-2 py-0.5 rounded hover:bg-amber-100 dark:hover:bg-amber-400/20 transition-colors"
                title={`Demote to ${prevRole}`}
              >
                ↓ {prevRole === 'MANAGER' ? 'Manager' : prevRole === 'ASSOCIATE_FINANCE' ? 'Assoc. Finance' : 'User'}
              </button>
            )}
          </div>
        );
      }},
    ] : []),
    // Lifecycle stays out of the group and always visible — it is the action
    // people actually come to this table to use.
    { header: '', accessor: (row: any) => {
      if (row.role === UserRole.SUPER_ADMIN) return null;
      const isInactive = row.isActive === false;
      return (
        <div className="flex items-center gap-2 whitespace-nowrap">
          {!isInactive && (
            <button onClick={() => setEditTarget(row)} className="text-xs text-brand font-bold hover:underline" title="Edit name, email, password, role, department and managers">Edit</button>
          )}
          {!isInactive && (
            <button onClick={() => handleDeactivateUser(row.id, row.name)} className="text-xs text-red-700 dark:text-red-300 font-bold hover:text-red-800 dark:hover:text-red-200 transition-colors" title="Retire this account (reversible)">Deactivate</button>
          )}
          {isInactive && (
            <>
              <button onClick={() => handleReactivateUser(row.id, row.name)} className="text-xs text-emerald-700 dark:text-emerald-300 font-bold hover:text-emerald-900 dark:hover:text-emerald-200 transition-colors" title="Restore login + assignability">Reactivate</button>
              <button onClick={() => handlePermanentDeleteUser(row.id, row.name)} className="text-xs text-red-700 dark:text-red-300 font-bold hover:text-red-800 dark:hover:text-red-200 transition-colors" title="Physically delete (only if no linked data)">Delete permanently</button>
            </>
          )}
        </div>
      );
    }},
  ];

  return (
    <div className="space-y-4">
      {missingAdminDepts.length > 0 && (
        <div className="bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 text-red-700 dark:text-red-300 px-4 py-3 rounded-lg text-sm flex items-start gap-2 shadow-sm">
          <span className="font-bold shrink-0 mt-0.5">⚠️ Audit Warning:</span>
          <p>
            The following departments have <strong>no assigned Admin</strong>:
            <span className="font-bold ml-1">{missingAdminDepts.map(d => d.name).join(', ')}</span>. <br/>
            (Indents from these departments that contain approval-needed categories will be stuck — please assign an Admin from Admin Management.)
          </p>
        </div>
      )}
      <div className="bg-card rounded-lg shadow-sm border border-line-soft">
        <div className="p-4 md:px-6 border-b border-line-soft">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-ink">User Management</h2>
              <p className="text-xs text-muted mt-0.5">{counts.all} users across all roles</p>
            </div>
            {activeTab === 'ADMIN' && (
              <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 px-4 py-2 bg-brand text-white font-bold rounded-full hover:bg-brand-dark transition-colors text-sm">
                <Plus size={16} /> Add Admin
              </button>
            )}
            {activeTab === 'SPECIAL' && (
              <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 px-4 py-2 bg-brand text-white font-bold rounded-full hover:bg-brand-dark transition-colors text-sm">
                <Plus size={16} /> Add Login
              </button>
            )}
          </div>
          <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name or email..." />
        </div>

        {/* Tabs */}
        <div className="border-b border-line-soft px-4 md:px-6">
          <div className="flex items-end gap-1 overflow-x-auto pb-0">
            {TABS.map(tab => {
              const count = counts[tab.key as keyof typeof counts] || 0;
              const isActive = activeTab === tab.key;
              const Icon = tab.icon;
              return (
                <button key={tab.key} onClick={() => { setActiveTab(tab.key); clearSelection(); }}
                  className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-bold rounded-t-lg border-b-2 transition-colors whitespace-nowrap ${
                    isActive ? 'border-brand text-brand bg-brand/5' : 'border-transparent text-muted hover:text-ink'
                  }`}>
                  <Icon size={14} /> {tab.label}
                  <span className={`px-1.5 py-0.5 rounded-full text-[9px] ${isActive ? 'bg-brand/20 text-brand-700' : 'bg-hover text-faint'}`}>{count}</span>
                </button>
              );
            })}
            {/* Column group toggle. In the toolbar, not the header row: as a
                column it needed a header cell and an empty cell on every row,
                which read as a gap torn through the table. */}
            <button
              type="button"
              onClick={() => setDetailsOpen((o) => !o)}
              aria-expanded={detailsOpen}
              disabled={f.isActive('created')}
              title={f.isActive('created')
                ? 'Clear the Created filter to collapse these columns'
                : detailsOpen ? 'Hide password, created and role columns' : 'Show password, created and role columns'}
              className="ml-auto inline-flex shrink-0 items-center gap-1.5 self-center rounded-full border border-line px-3 py-1.5 text-[11px] font-bold text-muted transition-colors hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {detailsOpen ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
              {detailsOpen ? 'Fewer columns' : 'More columns'}
            </button>
          </div>
        </div>

        <div className="p-0">
          <div className="px-4 md:px-6 pt-3">
            {/* Bulk deactivate is offered on the Admins + Others tabs (where
                multi-select is enabled below). Per-row Deactivate is available
                for every non-super-admin role; managers/users are typically
                retired one at a time (demote/reassign is the alternative), so we
                don't render checkboxes on those tabs. */}
            <BulkSelectionBar count={selectedIds.size} onClear={clearSelection}>
              <BulkActionButton
                label="Deactivate"
                count={selectedIds.size}
                tone="danger"
                verb="deactivated"
                confirmTitle="Deactivate users?"
                confirmMessage={`Deactivate ${selectedIds.size} selected ${activeTab === 'ADMIN' ? 'admin' : 'login'}${selectedIds.size === 1 ? '' : 's'}? They lose login + assignability but keep all their data. Reversible. Super-admins and your own account are skipped.`}
                onRun={() => runPerId([...selectedIds], (id) => usersApi.deactivate(id))}
                onDone={() => { clearSelection(); fetchUsers(); }}
              />
            </BulkSelectionBar>
          </div>
          <DataTable
            columns={columns}
            data={f.pageRows}
            isLoading={isLoading}
            keyExtractor={r => r.id}
            emptyStateMessage="No users found."
            maxHeight="60vh"
            selectedIds={(activeTab === 'ADMIN' || activeTab === 'SPECIAL') ? selectedIds : undefined}
            onToggleSelect={(activeTab === 'ADMIN' || activeTab === 'SPECIAL') ? toggleSelect : undefined}
            onToggleSelectAllVisible={(activeTab === 'ADMIN' || activeTab === 'SPECIAL') ? toggleSelectAllVisible : undefined}
          />
          <Pagination
            currentPage={f.page}
            totalPages={f.totalPages}
            onPageChange={f.setPage}
          />
        </div>
      </div>

      <Modal isOpen={showAddModal} onClose={() => setShowAddModal(false)} title={activeTab === 'SPECIAL' ? 'Add New Login' : 'Add New Admin'}>
        <UserForm
          departments={departments}
          allowedRoles={activeTab === 'SPECIAL' ? [UserRole.LAB, UserRole.PROCUREMENT, UserRole.INVENTORY, UserRole.FINANCE, UserRole.ASSOCIATE_FINANCE] : [UserRole.ADMIN]}
          onSubmit={handleCreateUser}
          isLoading={isSubmitting}
        />
      </Modal>

      <Modal isOpen={!!editTarget} onClose={() => setEditTarget(null)} title={editTarget ? `Edit ${editTarget.name}` : 'Edit user'}>
        {editTarget && (
          <UserForm
            initialData={editTarget}
            departments={departments}
            allowedRoles={EDITABLE_ROLES}
            managers={directory.filter((u: any) => u.role === UserRole.MANAGER)}
            onSubmit={handleEditUser}
            isLoading={isSubmitting}
            allowRoleChange
            allowPasswordSet
          />
        )}
      </Modal>

      <DemoteManagerModal
        manager={demoteTarget}
        managers={directory.filter((u: any) => u.role === UserRole.MANAGER)}
        onClose={() => setDemoteTarget(null)}
        onConfirm={handleDemoteConfirm}
        isSubmitting={isDemoting}
      />
    </div>
  );
};
