import { useState, FormEvent, useEffect } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { User, UserRole, Department } from '../../types';
import { useToast } from '../../context';
import { client } from '../../api';
// One shared validator, mirroring the backend — see lib/validateName.
import { validateName } from '../../lib/validateName';
import { passwordProblem, emailProblem } from '@/lib/passwordRule';
import { homeDepartmentId } from '@/lib/homeDepartment';

interface UserFormProps {
  initialData?: User;
  departments: Department[];
  allowedRoles: UserRole[];
  managers?: User[];
  onSubmit: (data: any) => void;
  isLoading: boolean;
  /** Super Admin edit: the role can be changed here in one step (the server
   *  applies the cleanup every promote / demote rung would). Others keep
   *  Promote / Demote. */
  allowRoleChange?: boolean;
  /** Super Admin edit: may set a new password for the person (optional field). */
  allowPasswordSet?: boolean;
}

/** Roles a team reports to — changing away from these hands the team over. */
const TEAM_ROLES: string[] = [UserRole.MANAGER, UserRole.ADMIN];

export const UserForm = ({ initialData, departments, allowedRoles, managers = [], onSubmit, isLoading, allowRoleChange = false, allowPasswordSet = false }: UserFormProps) => {
  const [email, setEmail] = useState(initialData?.email || '');
  const [name, setName] = useState(initialData?.name || '');
  const [role, setRole] = useState<UserRole>(initialData?.role || allowedRoles[0]);
  const [departmentId, setDepartmentId] = useState(initialData?.departmentId || '');
  // Everyone this person reports to — a department can be run by two managers.
  const [managerIds, setManagerIds] = useState<string[]>(
    initialData?.managers?.map((m: any) => m.managerId) ?? []
  );
  // Role change away from a manager / admin: who takes over their people.
  const [reassignToManagerId, setReassignToManagerId] = useState('');
  // Physical room. Applies to EVERY role — cross-department roles like
  // INVENTORY, PROCUREMENT and FINANCE still sit somewhere (and often share
  // a room), so this is deliberately outside the department branching below.
  const [labId, setLabId] = useState((initialData as any)?.labId || '');
  const [labs, setLabs] = useState<any[]>([]);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [nameError, setNameError] = useState('');
  const { addToast } = useToast();
  // ADMIN + LAB both use the AdminDepartment join table to record dept assignments
  // (admin-rights for ADMIN, departments-served for LAB). Either can pick multiple.
  const [multiDepartmentIds, setMultiDepartmentIds] = useState<string[]>(
    (initialData as any)?.adminDepartments?.map((ad: any) => ad.departmentId) ?? []
  );
  // Departments pinned to themselves — i.e. NOT covering what's nested under
  // them. Inheritance is the default, so this holds the exceptions.
  const [pinnedDepartmentIds, setPinnedDepartmentIds] = useState<string[]>(
    (initialData as any)?.adminDepartments
      ?.filter((ad: any) => ad.includeSubDepartments === false)
      .map((ad: any) => ad.departmentId) ?? []
  );

  useEffect(() => {
    // Fetched here rather than threaded through as a prop: three pages render
    // this form, and none of them otherwise cares about rooms.
    client.get('/asset-locations')
      .then(res => setLabs(res.data?.data ?? res.data ?? []))
      .catch(() => setLabs([]));
  }, []);

  useEffect(() => {
    if (initialData) {
      setEmail(initialData.email);
      setName(initialData.name);
      setRole(initialData.role);
      setDepartmentId(initialData.departmentId || '');
      setLabId((initialData as any).labId || '');
      setManagerIds(initialData.managers?.map((m: any) => m.managerId) ?? []);
      setMultiDepartmentIds((initialData as any)?.adminDepartments?.map((ad: any) => ad.departmentId) ?? []);
      setPinnedDepartmentIds((initialData as any)?.adminDepartments
        ?.filter((ad: any) => ad.includeSubDepartments === false)
        .map((ad: any) => ad.departmentId) ?? []);
    }
  }, [initialData]);

  const isMultiDept = role === UserRole.ADMIN || role === UserRole.LAB;
  const roleLocked = !!initialData && !allowRoleChange;
  // How many people report to this person today (Super Admin list rows carry it).
  const reportCount: number = (initialData as any)?._count?.managedUsers ?? 0;
  const handsOverTeam = !!initialData && initialData.role !== role
    && TEAM_ROLES.includes(initialData.role) && !TEAM_ROLES.includes(role) && reportCount > 0;
  // Nobody manages themselves.
  const managerChoices = managers.filter((m) => m.id !== initialData?.id);
  // INVENTORY / PROCUREMENT / FINANCE / ASSOCIATE_FINANCE see all departments
  // by design — there's no per-dept scoping to apply, so the form skips
  // the picker entirely and submits departmentId: null. Cleaner than asking
  // a question that has no operational meaning.
  // The team's own department (Finance / Procurement / Inventory), set by the role.
  const homeName = (departments as any[]).find((d) => d.id === homeDepartmentId(role, departments as any[]))?.name;
  const isCrossDeptRole =
    role === UserRole.INVENTORY ||
    role === UserRole.PROCUREMENT ||
    role === UserRole.FINANCE ||
    role === UserRole.ASSOCIATE_FINANCE;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const emailErr = emailProblem(email);
    if (emailErr) { addToast(emailErr, 'error'); return; }
    const nameErr = validateName(name);
    if (nameErr) { setNameError(nameErr); return; }
    // Required when creating; optional on a Super Admin edit (blank = unchanged).
    if (!initialData || password) {
      const pwErr = passwordProblem(password);
      if (pwErr) { addToast(pwErr, 'error'); return; }
    }
    if (isMultiDept) {
      if (multiDepartmentIds.length === 0) {
        addToast(
          role === UserRole.LAB
            ? 'Pick at least one department this lab serves.'
            : 'Pick at least one department for this admin to manage.',
          'error',
        );
        return;
      }
    }

    // Primary `departmentId`:
    //   - multi-dept roles (ADMIN/LAB) → first picked dept (so legacy reads of
    //     `user.departmentId` still resolve to something sensible).
    //   - cross-dept roles (INVENTORY/PROCUREMENT/FINANCE) → null (intentionally
    //     unaffiliated; visibility is role-driven, not dept-driven).
    //   - everyone else (MANAGER/USER) → whatever the dropdown picked.
    if (!isMultiDept && !isCrossDeptRole && !departmentId) { addToast('Pick a department.', 'error'); return; }
    const primaryDeptId = isMultiDept
      ? multiDepartmentIds[0]
      : (isCrossDeptRole ? null : departmentId);
    const data: any = { email: email.trim(), name: name.trim(), role, departmentId: primaryDeptId };
    if (isMultiDept) {
      data.adminDepartmentIds = multiDepartmentIds;
      // Only send exceptions for departments actually assigned — a stale pin
      // on a department since deselected would otherwise ride along.
      data.pinnedDepartmentIds = pinnedDepartmentIds.filter(id => multiDepartmentIds.includes(id));
    }
    if (password && (!initialData || allowPasswordSet)) {
      data.password = password;
    }
    // When the picker is on screen its value is always sent on an edit — [] as
    // "no managers" — so unassigning actually saves. A picker that is not on
    // screen (a role that reports to nobody) sends nothing: a selection left
    // over from before the role was switched must not ride along.
    const managerPickerShown = (role === UserRole.USER || role === UserRole.LAB) && managerChoices.length > 0;
    if (managerPickerShown && (initialData || managerIds.length)) {
      data.managerIds = managerIds.filter((id) => managerChoices.some((m) => m.id === id));
    }
    // Role goes to the server only when it may change here and did.
    if (initialData && (roleLocked || role === initialData.role)) delete data.role;
    if (handsOverTeam && reassignToManagerId) data.reassignToManagerId = reassignToManagerId;
    // Always sent (null when blank) so clearing someone's room actually saves.
    data.labId = labId || null;
    onSubmit(data);
  };

  // Every department nested under `id`, at any depth. Used only to decide
  // whether the inheritance toggle is worth showing, and to label it.
  const descendantsOf = (id: string): string[] => {
    const out: string[] = [];
    const stack = [id];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of departments as any[]) {
        if (d.parentId === cur) { out.push(d.id); stack.push(d.id); }
      }
    }
    return out;
  };

  const togglePinned = (id: string) => {
    setPinnedDepartmentIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleMultiDept = (id: string) => {
    setMultiDepartmentIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-ink">Email</label>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full border border-line rounded-md py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm" />
      </div>
      <div>
        <label className="block text-sm font-medium text-ink">Name</label>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => { setName(e.target.value); setNameError(validateName(e.target.value)); }}
          className={`mt-1 block w-full border rounded-md py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm ${nameError ? 'border-red-400' : 'border-line'}`}
        />
        {nameError && <p className="text-xs text-red-700 dark:text-red-300 mt-1">{nameError}</p>}
      </div>
      {(!initialData || allowPasswordSet) && (
        <div>
          <label className="block text-sm font-medium text-ink">
            {initialData ? <>New password <span className="text-muted font-normal">(optional)</span></> : 'Password'}
          </label>
          <div className="relative mt-1">
            <input
              type={showPassword ? 'text' : 'password'}
              required={!initialData}
              // Never the browser's saved password: autofilled here it would
              // quietly become this person's new password on Save.
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="block w-full border border-line rounded-md py-2 pl-3 pr-10 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
              className="absolute inset-y-0 right-0 px-3 flex items-center text-muted hover:text-ink focus:outline-none"
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p className="mt-1 text-xs text-muted">
            At least 8 characters, with a letter and a number.
            {initialData && ' Leave blank to keep their current one. Setting one signs them out everywhere.'}
          </p>
        </div>
      )}
      <div>
        <label className="block text-sm font-medium text-ink">Role</label>
        {/* Locked when editing: every role change here came back "not allowed —
            use the promote/demote workflow", because that is the only path
            that also fixes up department scope and reporting lines. */}
        <select value={role} onChange={(e) => setRole(e.target.value as UserRole)} disabled={roleLocked}
          title={roleLocked ? 'Change roles with Promote / Demote on the users list.' : undefined}
          className="mt-1 block w-full border border-line rounded-md py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm disabled:bg-surface disabled:text-muted">
          {/* Replace ALL underscores (not just the first) and Title-Case
              the words so "ASSOCIATE_FINANCE" renders as "Associate
              Finance" instead of the all-caps enum value. */}
          {allowedRoles.map((r) => (
            <option key={r} value={r}>
              {r.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}
            </option>
          ))}
        </select>
        {roleLocked && <p className="mt-1 text-xs text-muted">Role changes go through Promote / Demote on the users list.</p>}
        {!roleLocked && initialData && role !== initialData.role && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            They will be told their role changed. Sections they no longer need disappear for them.
          </p>
        )}
      </div>
      {isMultiDept ? (
        <div>
          <label className="block text-sm font-medium text-ink">
            {role === UserRole.LAB ? 'Departments this lab serves' : 'Departments this admin manages'}
          </label>
          <p className="text-xs text-muted mt-0.5 mb-2">
            {role === UserRole.LAB
              ? 'A lab can support multiple departments. Pick all that apply.'
              : 'An admin can manage one or more departments. Pick all that apply.'}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {departments.map((d) => {
              const active = multiDepartmentIds.includes(d.id);
              return (
                <button
                  type="button"
                  key={d.id}
                  onClick={() => toggleMultiDept(d.id)}
                  className={`px-2.5 py-1 text-xs font-bold rounded-full border transition-colors ${
                    active
                      ? 'bg-brand text-white border-brand'
                      : 'bg-surface text-muted border-line hover:border-line'
                  }`}
                >
                  {d.name}
                </button>
              );
            })}
          </div>
          {multiDepartmentIds.length === 0 && (
            <p className="text-[10px] text-amber-700 dark:text-amber-300 mt-1">At least one department is required.</p>
          )}

          {/* Inheritance is on by default, and only worth surfacing for a
              department that actually has something nested under it — so a flat
              org never sees this at all. */}
          {multiDepartmentIds
            .map(id => ({ dept: (departments as any[]).find(d => d.id === id), subs: descendantsOf(id) }))
            .filter(x => x.dept && x.subs.length > 0)
            .map(({ dept, subs }) => (
              <label key={dept.id}
                     className="flex items-start gap-2 mt-2 text-[11px] text-muted cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={!pinnedDepartmentIds.includes(dept.id)}
                  onChange={() => togglePinned(dept.id)}
                  className="mt-0.5 accent-brand"
                />
                <span>
                  Also cover the {subs.length} department{subs.length === 1 ? '' : 's'} under{' '}
                  <span className="font-bold text-ink">{dept.name}</span>
                  {pinnedDepartmentIds.includes(dept.id) && (
                    <span className="text-amber-700 dark:text-amber-300 font-bold"> — currently {dept.name} only</span>
                  )}
                </span>
              </label>
            ))}
        </div>
      ) : isCrossDeptRole ? (
        <div className="bg-surface border border-line rounded-md px-3 py-2 text-xs text-muted">
          The <span className="font-bold">{role.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())}</span> role works across every department.
          {homeName && <> Their own requests and indents go under <span className="font-bold">{homeName}</span>.</>}
        </div>
      ) : (
        <div>
          <label className="block text-sm font-medium text-ink">Department</label>
          <select required value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}
            className="mt-1 block w-full border border-line rounded-md py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm">
            <option value="">Select Department</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      )}
      {handsOverTeam && (
        <div>
          <label className="block text-sm font-medium text-ink">
            Who takes over the {reportCount} {reportCount === 1 ? 'person' : 'people'} assigned to {initialData?.name}?
          </label>
          <select value={reassignToManagerId} onChange={(e) => setReassignToManagerId(e.target.value)}
            className="mt-1 block w-full border border-line rounded-md py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm">
            <option value="">Nobody — their department's managers still cover them</option>
            {managerChoices.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
      )}
      {(role === UserRole.USER || role === UserRole.LAB) && managerChoices.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-ink">Reporting managers (optional)</label>
          <p className="text-xs text-muted mt-0.5 mb-2">
            Pick any number. Managers of their department already cover them — only add someone from outside it.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {managerChoices.map((m) => {
              const active = managerIds.includes(m.id);
              return (
                <button
                  type="button"
                  key={m.id}
                  aria-pressed={active}
                  onClick={() => setManagerIds((prev) => active ? prev.filter((x) => x !== m.id) : [...prev, m.id])}
                  className={`px-2.5 py-1 text-xs font-bold rounded-full border transition-colors ${
                    active ? 'bg-brand text-white border-brand' : 'bg-surface text-muted border-line hover:border-line'
                  }`}
                >
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div>
        <label className="block text-sm font-medium text-ink">Lab / Room (Optional)</label>
        <select value={labId} onChange={(e) => setLabId(e.target.value)}
          className="mt-1 block w-full border border-line rounded-md py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm">
          <option value="">No room assigned</option>
          {labs.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
        {labs.length === 0 ? (
          <p className="text-[10px] text-amber-700 dark:text-amber-300 mt-1">
            No rooms set up yet — add them under Labs first.
          </p>
        ) : (
          <p className="text-[10px] text-muted mt-1">
            Where this person physically sits. Independent of their department — a room can hold any mix of
            departments.
          </p>
        )}
      </div>
      <div className="flex justify-end pt-4">
        <button type="submit" disabled={isLoading}
          className="bg-brand text-white px-4 py-2 rounded-full shadow-sm text-sm font-medium hover:bg-brand-dark disabled:opacity-50">
          {isLoading ? 'Saving...' : 'Save User'}
        </button>
      </div>
    </form>
  );
};
