import { useCallback, useEffect, useMemo, useState } from 'react';
import { client } from '@/api';
import { extractErrorMessage, validateName, validateEmail } from '@/lib';
import { Modal, ConfirmDialog, BrandLoader } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { Plus, Building2, EyeOff, Eye, Pencil, Trash2, Users, Monitor } from 'lucide-react';
import { useAbortOnUnmount } from '@/hooks';
import { passwordProblem } from '@/lib/passwordRule';

/**
 * Super Admin master-data screen for physical rooms — labs, offices,
 * storerooms, anywhere a person sits or an asset lives.
 *
 * Rooms are deliberately independent of Departments: one room holds
 * several departments, one department spreads across rooms, and some
 * rooms (HR, marketing, the finance office) map to no department at
 * all. The department field below is an optional grouping tag, never a
 * restriction on who can be placed in the room.
 *
 * Backed by /asset-locations, which Fixed Assets also reads — the same
 * physical place, one list, so the two can never drift apart.
 */
export const LabsPage = () => {
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [labs, setLabs] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [name, setName] = useState('');
  const [departmentIds, setDepartmentIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Bulk "put a whole department in one room" — the common case, after which
  // the admin fixes the handful of exceptions person by person.
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkDeptId, setBulkDeptId] = useState('');
  const [bulkLabId, setBulkLabId] = useState('');
  const [bulkRunning, setBulkRunning] = useState(false);

  // "Create a login for this room" — a shared terminal account, deliberately
  // view-only (see the note in the dialog).
  const [loginFor, setLoginFor] = useState<any>(null);
  const [loginName, setLoginName] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginSaving, setLoginSaving] = useState(false);

  const { addToast } = useToast();

  // includeInactive: this is the management screen, so hidden rooms have to
  // be visible here — they're hidden from *pickers*, not from the admin.
  const fetchLabs = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await client.get('/asset-locations?includeInactive=true', { signal: abortSignal() });
      setLabs(res.data?.data ?? res.data ?? []);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load labs'), 'error');
    } finally {
      setIsLoading(false);
    }
  }, [addToast]);

  useEffect(() => {
    fetchLabs();
    client.get('/departments', { signal: abortSignal() })
      .then(res => setDepartments(res.data?.data ?? res.data ?? []))
      // A failed department fetch only costs the optional grouping tag, so
      // the screen stays usable rather than erroring out wholesale.
      .catch(() => setDepartments([]));
  }, [fetchLabs]);

  const openAdd = () => { setEditing(null); setName(''); setDepartmentIds([]); setIsModalOpen(true); };
  const openEdit = (lab: any) => {
    setEditing(lab);
    setName(lab.name || '');
    setDepartmentIds((lab.departments || []).map((d: any) => d.id));
    setIsModalOpen(true);
  };

  const handleSubmit = async () => {
    const trimmed = name.trim();
    if (!trimmed) { addToast('Give the room a name', 'error'); return; }
    // Client-side duplicate check purely for a friendlier message — the
    // unique(name) index is what actually guarantees it.
    const clash = labs.some(l => l.name.toLowerCase() === trimmed.toLowerCase() && l.id !== editing?.id);
    if (clash) { addToast(`"${trimmed}" already exists`, 'error'); return; }

    setIsSubmitting(true);
    try {
      // Always sent, including as [], so clearing every tag actually saves —
      // an omitted key means "leave them alone" on the server.
      const body = { name: trimmed, departmentIds };
      if (editing) {
        await client.patch(`/asset-locations/${editing.id}`, body);
        addToast('Lab updated', 'success');
      } else {
        await client.post('/asset-locations', body);
        addToast(`Added "${trimmed}"`, 'success');
      }
      setIsModalOpen(false);
      fetchLabs();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not save'), 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const toggleActive = async (lab: any) => {
    try {
      await client.patch(`/asset-locations/${lab.id}`, { isActive: !lab.isActive });
      addToast(lab.isActive ? `"${lab.name}" hidden` : `"${lab.name}" visible again`, 'success');
      fetchLabs();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not update'), 'error');
    }
  };

  // Checked as you type, against the same rule the server enforces. Before
  // this the only feedback was a toast after Create — which for a room like
  // "Bay 3" meant a rejection with no indication that the NAME was the issue.
  const loginNameError = loginFor ? validateName(loginName, 'Display name') : '';
  const loginEmailError = loginFor ? validateEmail(loginEmail) : '';

  const openLogin = (lab: any) => {
    const slug = lab.name.toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');
    setLoginFor(lab);
    setLoginName(`${lab.name} Terminal`);
    setLoginEmail(`${slug}@lab.local`);
    setLoginPassword('');
    setIsModalOpen(false);
  };

  const createLogin = async () => {
    if (!loginFor) return;
    if (loginNameError || loginEmailError) return; // button is disabled too; belt and braces
    const pwErr = passwordProblem(loginPassword);
    if (pwErr) { addToast(pwErr, 'error'); return; }
    setLoginSaving(true);
    try {
      // Reuses the normal user-create endpoint, so it gets the same name,
      // email and password-strength validation as any other account.
      await client.post('/users', {
        name: loginName.trim(),
        email: loginEmail.trim(),
        password: loginPassword,
        role: 'LAB',
        labId: loginFor.id,
        isViewOnly: true,
      });
      addToast(`Login created for ${loginFor.name}`, 'success');
      setLoginFor(null);
      setLoginPassword('');
      fetchLabs();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not create the login'), 'error');
    } finally {
      setLoginSaving(false);
    }
  };

  const runBulkAssign = async () => {
    if (!bulkDeptId) { addToast('Pick a department', 'error'); return; }
    setBulkRunning(true);
    try {
      // labId '' means "unassign this department" — the undo for a mis-click.
      const res = await client.post('/users/assign-lab-by-department', {
        departmentId: bulkDeptId,
        labId: bulkLabId || null,
      });
      const d = res.data?.data ?? res.data ?? {};
      addToast(
        d.lab
          ? `Moved ${d.updated} ${d.updated === 1 ? 'person' : 'people'} in ${d.department} to ${d.lab}`
          : `Unassigned ${d.updated} ${d.updated === 1 ? 'person' : 'people'} in ${d.department}`,
        'success',
      );
      setBulkOpen(false);
      setBulkDeptId(''); setBulkLabId('');
      fetchLabs(); // occupancy counts moved
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not assign'), 'error');
    } finally {
      setBulkRunning(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await client.delete(`/asset-locations/${deleteTarget.id}`);
      const freed = (res.data?.data ?? res.data ?? {}).unassignedUsers ?? 0;
      addToast(
        freed > 0
          ? `Deleted "${deleteTarget.name}" — ${freed} ${freed === 1 ? 'person is' : 'people are'} now unassigned`
          : `Deleted "${deleteTarget.name}"`,
        'success',
      );
      setDeleteTarget(null);
      fetchLabs();
    } catch (e: any) {
      // The service refuses to delete a room that still has assets in it and
      // says so — pass that reason straight through.
      addToast(extractErrorMessage(e, 'Could not delete'), 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  const { active, hidden } = useMemo(() => ({
    active: labs.filter(l => l.isActive),
    hidden: labs.filter(l => !l.isActive),
  }), [labs]);

  const renderRow = (lab: any) => {
    // The server refuses to delete a room that still has assets linked to it,
    // so disable the button rather than letting the click fail.
    const assets = lab._count?.fixedAssets ?? 0;
    const people = lab._count?.users ?? 0;
    return (
    <div key={lab.id} className="flex items-center justify-between px-4 py-3 border-b border-line-soft last:border-b-0 hover:bg-surface/60 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <Building2 className="w-4 h-4 text-faint shrink-0" />
        <span className={`font-medium truncate ${lab.isActive ? 'text-ink' : 'text-faint line-through'}`}>{lab.name}</span>
        {(lab.departments || []).map((d: any) => (
          <span key={d.id}
                className="text-[10px] font-bold text-brand-dark bg-brand-50 border border-brand-200 px-1.5 py-0.5 rounded shrink-0"
                title="Grouping tag only — anyone from any department can be placed in this room">
            {d.name}
          </span>
        ))}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {people > 0 && (
          <span className="text-[10px] font-bold text-muted bg-hover border border-line px-1.5 py-0.5 rounded"
                title={`${people} ${people === 1 ? 'person works' : 'people work'} in this room`}>
            {people} {people === 1 ? 'person' : 'people'}
          </span>
        )}
        {assets > 0 && (
          <span className="text-[10px] font-bold text-muted bg-hover border border-line px-1.5 py-0.5 rounded"
                title={`${assets} asset${assets === 1 ? '' : 's'} recorded here`}>
            {assets} {assets === 1 ? 'asset' : 'assets'}
          </span>
        )}
        {/* Icon-only with the label in the tooltip — three words per row on
            every row was noise once the list grew. */}
        <button onClick={() => openLogin(lab)} aria-label="Create a login for this room"
                title="Create a login for this room — a shared, view-only account for a screen in the lab"
                className="p-1.5 rounded-md text-faint hover:text-ink hover:bg-hover transition-colors">
          <Monitor className="w-4 h-4" />
        </button>
        <button onClick={() => openEdit(lab)} aria-label="Edit room"
                title="Edit — change the name or which departments mainly use it"
                className="p-1.5 rounded-md text-faint hover:text-ink hover:bg-hover transition-colors">
          <Pencil className="w-4 h-4" />
        </button>
        <button onClick={() => toggleActive(lab)}
                aria-label={lab.isActive ? 'Hide room' : 'Show room'}
                title={lab.isActive
                  ? 'Hide — stops this room being offered when adding new people or assets. Everything already recorded here is untouched.'
                  : 'Show — offer this room again when adding new people or assets.'}
                className="p-1.5 rounded-md text-faint hover:text-ink hover:bg-hover transition-colors">
          {lab.isActive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
        <button
          onClick={() => setDeleteTarget(lab)}
          disabled={assets > 0}
          title={assets > 0
            ? `Can't delete — ${assets} asset${assets === 1 ? ' is' : 's are'} recorded in this room. Move them first, or hide it instead.`
            : 'Delete — permanent. To just retire the room, hide it instead.'}
          aria-label="Delete room"
          className="p-1.5 rounded-md text-red-400 hover:text-red-700 dark:text-red-300 hover:bg-red-50 dark:bg-red-400/15 transition-colors disabled:text-[#E5E7EB] disabled:cursor-not-allowed disabled:hover:bg-transparent">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
    );
  };

  if (isLoading && labs.length === 0) {
    return <BrandLoader />;
  }

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Stacks below sm: at 375px "Labs & Rooms", its paragraph and the two
          buttons do not fit on one line, and the scroll container clips
          horizontally — "Add Lab" was cut off the card and unreachable, with
          no sideways scroll to recover it. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-start bg-card p-4 md:p-6 rounded-lg shadow-sm border border-line-soft">
        <div className="min-w-0">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Labs &amp; Rooms</h2>
          <p className="text-sm text-muted mt-1 max-w-2xl">
            Every physical place your team works — labs, offices, storerooms. A room can hold people from
            any mix of departments, and one department can be spread across several rooms.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <button onClick={() => setBulkOpen(true)} disabled={labs.length === 0}
            title={labs.length === 0 ? 'Add a room first' : 'Put everyone in a department into one room'}
            className="bg-card border border-faint text-ink px-4 py-2 rounded-md font-bold text-sm hover:bg-surface transition-colors disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-2">
            <Users className="w-4 h-4" />Assign a department
          </button>
          <button onClick={openAdd}
            className="bg-brand hover:bg-brand-dark text-white px-4 py-2 rounded-full font-bold text-sm transition-colors shadow-sm inline-flex items-center gap-2">
            <Plus className="w-4 h-4" />Add Lab
          </button>
        </div>
      </div>

      <div className="bg-card rounded-lg shadow-sm border border-line-soft overflow-hidden">
        {labs.length === 0 ? (
          <div className="text-center p-10">
            <Building2 className="w-8 h-8 text-brand mx-auto mb-2" />
            <p className="text-sm font-bold text-ink">No labs yet</p>
            <p className="text-xs text-muted mt-1 max-w-md mx-auto">
              Add your rooms one by one — a lab per team, plus any shared spaces. You can assign people to
              them once they exist.
            </p>
          </div>
        ) : (
          <>
            <div className="px-4 py-2 bg-surface/80 border-b border-line-soft">
              <span className="text-[11px] font-bold text-muted uppercase tracking-wide">In use ({active.length})</span>
            </div>
            {active.map(renderRow)}
            {active.length === 0 && <p className="px-4 py-3 text-xs text-faint italic">Every room is hidden.</p>}

            {hidden.length > 0 && (
              <>
                <div className="px-4 py-2 bg-surface/80 border-y border-line-soft">
                  <span className="text-[11px] font-bold text-muted uppercase tracking-wide">Hidden ({hidden.length})</span>
                  <span className="text-[10px] text-faint ml-2">Not offered on new records; existing ones keep them.</span>
                </div>
                {hidden.map(renderRow)}
              </>
            )}
          </>
        )}
      </div>

      <Modal isOpen={isModalOpen} onClose={() => setIsModalOpen(false)} title={editing ? 'Edit Lab' : 'Add Lab'}>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Room name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Hardware Lab, Finance Office, Storeroom B"
              className="w-full px-3 py-2 border border-line rounded-md text-sm focus:border-brand outline-none"
            />
          </div>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">
              Mainly used by <span className="font-normal text-faint">(optional, pick any number)</span>
            </label>
            {departments.length === 0 ? (
              <p className="text-xs text-faint italic">No departments yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {departments.map((d: any) => {
                  const on = departmentIds.includes(d.id);
                  return (
                    <button
                      key={d.id}
                      type="button"
                      onClick={() => setDepartmentIds(prev =>
                        prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id])}
                      className={`px-2.5 py-1 text-xs font-bold rounded-full border transition-colors ${
                        on
                          ? 'bg-brand text-white border-brand'
                          : 'bg-surface text-muted border-line hover:border-brand'
                      }`}
                    >
                      {d.name}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-[11px] text-faint mt-1.5">
              Just a label to make the list easier to scan. It does not limit who can be placed in this
              room — anyone from any department can work here.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setIsModalOpen(false)} disabled={isSubmitting}
              className="px-4 py-2 text-sm font-bold text-muted hover:text-ink disabled:opacity-50">Cancel</button>
            <button onClick={handleSubmit} disabled={isSubmitting}
              className="bg-brand hover:bg-brand-dark text-white px-4 py-2 rounded-full font-bold text-sm disabled:opacity-50">
              {isSubmitting ? 'Saving…' : editing ? 'Save' : 'Add Lab'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={!!loginFor} onClose={() => setLoginFor(null)}
             title={`Login for ${loginFor?.name || ''}`}>
        <div className="space-y-4">
          <div className="bg-brand-50 border border-brand-200 rounded-md p-3 text-xs text-muted">
            <p className="font-bold text-ink mb-1">This account can look, but not touch.</p>
            <p>
              It's meant for a screen left in the room, where anyone walking past can use it. Because
              it's shared, it's created <b>view-only</b>: it can see stock, requests and what's out on
              loan, but it can't raise a request, approve anything, or change a record. Those stay
              tied to a named person so you always know who did what.
            </p>
          </div>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Display name</label>
            <input value={loginName} onChange={e => setLoginName(e.target.value)}
              className={`w-full px-3 py-2 border rounded-md text-sm outline-none ${
                loginNameError ? 'border-red-400 focus:border-red-500' : 'border-line focus:border-brand'
              }`} />
            {loginNameError && <p className="text-[11px] text-red-700 dark:text-red-300 mt-1">{loginNameError}</p>}
          </div>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Email (used to sign in)</label>
            <input value={loginEmail} onChange={e => setLoginEmail(e.target.value)}
              className={`w-full px-3 py-2 border rounded-md text-sm outline-none ${
                loginEmailError ? 'border-red-400 focus:border-red-500' : 'border-line focus:border-brand'
              }`} />
            {loginEmailError && <p className="text-[11px] text-red-700 dark:text-red-300 mt-1">{loginEmailError}</p>}
          </div>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Password</label>
            <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)}
              placeholder="At least 8 characters, with a letter and a number"
              className="w-full px-3 py-2 border border-line rounded-md text-sm focus:border-brand outline-none" />
            {loginPassword && passwordProblem(loginPassword) && (
              <p className="text-[11px] text-red-700 dark:text-red-300 mt-1">
                Needs at least 8 characters, including a letter and a number.
              </p>
            )}
            <p className="text-[11px] text-faint mt-1">
              You choose it and hand it to the lab. Nobody else can see it afterwards.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setLoginFor(null)} disabled={loginSaving}
              className="px-4 py-2 text-sm font-bold text-muted hover:text-ink disabled:opacity-50">Cancel</button>
            <button onClick={createLogin}
              disabled={loginSaving || !!loginNameError || !!loginEmailError
                || !!passwordProblem(loginPassword)}
              className="bg-brand hover:bg-brand-dark text-white px-4 py-2 rounded-full font-bold text-sm disabled:opacity-50">
              {loginSaving ? 'Creating…' : 'Create login'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal isOpen={bulkOpen} onClose={() => setBulkOpen(false)} title="Assign a department to a room">
        <div className="space-y-4">
          <p className="text-xs text-muted">
            Moves everyone currently in a department into one room, in one go. Afterwards you can move
            individuals out — a department split across rooms is normal.
          </p>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Department</label>
            <select value={bulkDeptId} onChange={e => setBulkDeptId(e.target.value)}
              className="w-full px-3 py-2 border border-line rounded-md text-sm focus:border-brand outline-none bg-card">
              <option value="">-- Choose department --</option>
              {departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Room</label>
            <select value={bulkLabId} onChange={e => setBulkLabId(e.target.value)}
              className="w-full px-3 py-2 border border-line rounded-md text-sm focus:border-brand outline-none bg-card">
              <option value="">-- No room (unassign them) --</option>
              {active.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
            <p className="text-[11px] text-faint mt-1">
              This replaces whatever room those people are in now.
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setBulkOpen(false)} disabled={bulkRunning}
              className="px-4 py-2 text-sm font-bold text-muted hover:text-ink disabled:opacity-50">Cancel</button>
            <button onClick={runBulkAssign} disabled={bulkRunning || !bulkDeptId}
              className="bg-brand hover:bg-brand-dark text-white px-4 py-2 rounded-full font-bold text-sm disabled:opacity-50">
              {bulkRunning ? 'Assigning…' : 'Assign'}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="Delete lab"
        tone="danger"
        confirmLabel="Delete"
        isLoading={isDeleting}
        onClose={() => !isDeleting && setDeleteTarget(null)}
        onConfirm={confirmDelete}
        message={deleteTarget ? (
          <>
            Delete <span className="font-bold text-ink">{deleteTarget.name}</span>? This can't be undone.
            {(deleteTarget._count?.users ?? 0) > 0 && (
              <span className="block mt-2 text-xs font-bold text-amber-700 dark:text-amber-300">
                {deleteTarget._count.users} {deleteTarget._count.users === 1 ? 'person' : 'people'} work
                {deleteTarget._count.users === 1 ? 's' : ''} here and will be left with no room. Nobody is
                deleted — you'll just need to re-assign them.
              </span>
            )}
            <span className="block mt-1 text-xs text-faint">
              If you only want it off new records, use Hide instead — that keeps existing history intact.
            </span>
          </>
        ) : null}
      />
    </div>
  );
};
