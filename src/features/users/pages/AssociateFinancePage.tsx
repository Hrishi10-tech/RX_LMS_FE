import { useCallback, useEffect, useState } from 'react';
import { UserPlus, Users, KeyRound, Loader2, CircleSlash, RotateCcw, ArrowUpCircle, ArrowDownCircle } from 'lucide-react';
import { usersApi } from '../services/users.api';
import { Modal, ColumnFilter } from '@/components/ui';
import { useTableFilters, FilterSpec } from '@/hooks';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import { UserRole } from '@/types';
import { PasswordCell } from '../components/PasswordCell';
import { useAuth } from '@/context/AuthContext';
import { passwordProblem } from '@/lib/passwordRule';

interface Row {
  id: string;
  /** ASSOCIATE_FINANCE, or FINANCE for someone promoted from this page. */
  role: string;
  name: string;
  email: string;
  isActive: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  assignedPaymentCount: number;
  passwordVisibility: 'available' | 'self-changed' | 'not-recorded';
  passwordSetByName: string | null;
  passwordSetAt: string | null;
  /** Who promoted this user to FINANCE and when — drives the undo affordance
   *  below. Absent for anyone this system never saw promoted. */
  financePromotedAt?: string | null;
  financePromotedById?: string | null;
}

/**
 * Finance's page for the Associate Finance people who help it pay.
 *
 * Finance already decides which payments an Associate Finance sees (the
 * "Send to" picker on Payments & Spend), but creating the login itself needed a
 * Super Admin — so the one relationship Finance owns end to end had a step in
 * the middle it couldn't do. This closes that.
 *
 * Everything here is pinned to ASSOCIATE_FINANCE server-side: the list query
 * filters on the role, and the edit endpoint refuses a target of any other
 * role. Nothing on this page can reach another account even if the id is
 * tampered with.
 */
// A filter on every data column (owner, 27 Oct). Values match what each cell
// shows. Password is left out: its cell is a control, not a value to list.
const AF_FILTER_SPECS: FilterSpec<Row>[] = [
  { key: 'name', getValue: (r) => r.name },
  { key: 'email', getValue: (r) => r.email },
  { key: 'status', getValue: (r) => (r.isActive ? 'Active' : 'Inactive') },
  { key: 'assigned', getValue: (r) => (r.assignedPaymentCount > 0 ? String(r.assignedPaymentCount) : 'None') },
  { key: 'created', getValue: (r) => fmtDateTime(r.createdAt) },
];

export const AssociateFinancePage = () => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const { user: me } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const f = useTableFilters(rows, AF_FILTER_SPECS);
  const th = (label: string, key: string) => (
    <th className={`px-4 py-2.5 ${f.isActive(key) ? 'bg-brand-100' : ''}`}>
      <span className="inline-flex items-center">
        {label}
        <ColumnFilter searchable options={f.getOptions(key)} value={f.filters[key] || ''} onChange={(v) => f.setFilter(key, v)} />
      </span>
    </th>
  );
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [resetFor, setResetFor] = useState<Row | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await usersApi.listAssociateFinance());
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load the Associate Finance list'), 'error');
    }
    setLoading(false);
  }, [addToast]);

  useEffect(() => { load(); }, [load]);

  const setActive = async (row: Row, isActive: boolean) => {
    // Deactivating releases whatever they were holding back to the unassigned
    // pool (the server does it in the same transaction as the flag). Say the
    // number up front so it isn't a surprise, and so Finance knows there is a
    // queue to re-triage afterwards.
    const warning =
      !isActive && row.assignedPaymentCount > 0
        ? ` The ${row.assignedPaymentCount} payment${row.assignedPaymentCount === 1 ? '' : 's'} they're holding will go back to the unassigned pool, so you can pay them yourself or send them to someone else. They won't come back automatically if you reactivate.`
        : '';
    const okToGo = await confirm({
      title: isActive ? `Reactivate ${row.name}?` : `Deactivate ${row.name}?`,
      message: isActive
        ? `${row.name} will be able to sign in again with their existing password.`
        : `${row.name} will be signed out everywhere and won't be able to sign back in.${warning}`,
      confirmLabel: isActive ? 'Reactivate' : 'Deactivate',
      tone: isActive ? 'default' : 'danger',
    });
    if (!okToGo) return;

    setBusyId(row.id);
    try {
      const res: any = await usersApi.updateAssociateFinance(row.id, { isActive });
      // Report what actually moved, from the server's count rather than the
      // number the row was showing — the queue may have changed since it loaded.
      const released = res?.releasedPayments ?? 0;
      addToast(
        `${row.name} ${isActive ? 'reactivated' : 'deactivated'}.` +
          (released > 0
            ? ` ${released} payment${released === 1 ? '' : 's'} returned to the unassigned pool.`
            : ''),
        'success',
      );
      await load();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not update the account'), 'error');
    }
    setBusyId(null);
  };

  /**
   * Hand an associate the whole payment queue.
   *
   * Deliberately loud. Everything else on this page is reversible from this
   * page; this is not — once they are Finance they no longer appear in this
   * list, and putting them back is a Super Admin's demote. The confirm has to
   * say that plainly rather than reading like another toggle, because the
   * difference between an associate and Finance is "sees what you send them"
   * versus "sees and can pay everything".
   */
  const promote = async (row: Row) => {
    const okToGo = await confirm({
      title: `Make ${row.name} a Finance user?`,
      message:
        `${row.name} will stop being an associate and become Finance: they will see and be able to pay the ENTIRE payment queue, not just what you send them. ` +
        `They will also be able to create and promote associates themselves.\n\n` +
        `You stay Finance — this does not replace you. But this page cannot undo it: only a Super Admin can put them back.`,
      confirmLabel: 'Promote to Finance',
      tone: 'danger',
    });
    if (!okToGo) return;

    setBusyId(row.id);
    try {
      await usersApi.promote(row.id, 'FINANCE');
      addToast(`${row.name} is now a Finance user.`, 'success');
      await load();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not promote this account'), 'error');
    }
    setBusyId(null);
  };

  /**
   * Take the whole queue back — the undo for the promotion above.
   *
   * The server refuses two cases this button therefore does not need to
   * second-guess: demoting yourself, and demoting the last active Finance user
   * (which would leave nobody able to pay anything). Both come back as a plain
   * message on the toast.
   */
  /** Finance may undo only a promotion IT made, within three minutes (the
   *  server enforces this — see demoteUser). Ticking so the button disappears
   *  when the window closes instead of lingering until the next refetch and
   *  then 403-ing. */
  const UNDO_WINDOW_MS = 3 * 60_000;
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClockTick(n => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);
  const canUndoPromotion = (row: Row) =>
    !!row.financePromotedAt &&
    row.financePromotedById === me?.id &&
    Date.now() - new Date(row.financePromotedAt).getTime() <= UNDO_WINDOW_MS;

  const demote = async (row: Row) => {
    const okToGo = await confirm({
      title: `Return ${row.name} to Associate Finance?`,
      message:
        `${row.name} will stop seeing the whole payment queue. From then on they only see payments you send them from Payments & Spend — which is nothing until you send some.` +
        (row.assignedPaymentCount > 0
          ? `\n\nThe ${row.assignedPaymentCount} payment${row.assignedPaymentCount === 1 ? '' : 's'} assigned to them will go back to the unassigned pool, so you can pay ${row.assignedPaymentCount === 1 ? 'it' : 'them'} yourself or send ${row.assignedPaymentCount === 1 ? 'it' : 'them'} to someone else.`
          : ''),
      confirmLabel: 'Return to associate',
      tone: 'danger',
    });
    if (!okToGo) return;

    setBusyId(row.id);
    try {
      const res: any = await usersApi.demote(row.id, 'ASSOCIATE_FINANCE');
      // Report the server's count, not the number the row was showing — the
      // queue may have moved since the page loaded.
      const released = res?.releasedPayments ?? 0;
      addToast(
        `${row.name} is an Associate Finance again.` +
          (released > 0
            ? ` ${released} payment${released === 1 ? '' : 's'} returned to the unassigned pool.`
            : ''),
        'success',
      );
      await load();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not change this account'), 'error');
    }
    setBusyId(null);
  };

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <Users size={20} className="text-brand" /> Associate Finance
          </h1>
          <p className="mt-1 max-w-2xl text-xs text-muted">
            The people who help you pay. Create their login here, then choose which payments each of
            them sees from <b>Payments &amp; Spend</b> — they only ever see the ones you send them.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-brand-dark"
        >
          <UserPlus size={16} /> Add Associate Finance
        </button>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-[10px] font-bold uppercase tracking-wider text-faint">
              {th('Name', 'name')}
              {th('Email', 'email')}
              {th('Status', 'status')}
              {th('Assigned payments', 'assigned')}
              <th className="px-4 py-2.5">Password</th>
              {th('Created', 'created')}
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="py-10 text-center text-sm text-faint">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-10 text-center text-sm text-faint">
                  No Associate Finance logins yet. Create one to start delegating payments.
                </td>
              </tr>
            ) : f.filteredRows.length === 0 ? (
              <tr><td colSpan={7} className="py-10 text-center text-sm text-faint">No one matches these filters.</td></tr>
            ) : f.filteredRows.map((row) => (
              <tr key={row.id} className="border-b border-line-soft last:border-0">
                <td className="px-4 py-2.5 font-bold text-ink">
                  {row.name}
                  {/* A promoted colleague is in this list only so the role can
                      be handed back — say so, or the row reads like an
                      associate with a missing set of buttons. */}
                  {row.role === 'FINANCE' && (
                    <span
                      className="ml-2 rounded-full border border-brand-200 bg-brand-100 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-brand-700"
                      title="Full Finance — sees and can pay the entire queue"
                    >
                      Finance
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted">{row.email}</td>
                <td className="px-4 py-2.5">
                  {/* Same wording and pill the Super Admin users table uses for
                      a retired account — ACTIVE/INACTIVE aren't in statusStyles,
                      so StatusBadge would render them unstyled. */}
                  {row.isActive ? (
                    <span className="text-[10px] font-bold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">Active</span>
                  ) : (
                    <span
                      className="rounded-full border border-line bg-hover px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted"
                      title="Deactivated — no login, not assignable"
                    >
                      Inactive
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-xs text-muted">
                  {row.assignedPaymentCount > 0
                    ? <span className="font-bold text-ink">{row.assignedPaymentCount}</span>
                    : <span className="text-faint">None</span>}
                </td>
                <td className="px-4 py-2.5">
                  <PasswordCell
                    userId={row.id}
                    visibility={row.passwordVisibility}
                    setByName={row.passwordSetByName}
                    setAt={row.passwordSetAt}
                  />
                </td>
                <td className="px-4 py-2.5 text-xs text-muted">{fmtDateTime(row.createdAt)}</td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center justify-end gap-3 whitespace-nowrap">
                    {/* A FINANCE row is a colleague, not an account this page
                        administers: rename / reset-password / deactivate are
                        refused server-side for them (updateAssociateFinance is
                        associate-only), so offering the buttons would only
                        produce 403s. The one thing this page may do with them
                        is hand the role back. */}
                    {row.role === 'FINANCE' ? (
                      row.id === me?.id ? (
                        <span className="text-xs text-faint italic">This is you</span>
                      ) : !canUndoPromotion(row) ? (
                        // A Finance colleague this user did not just promote is
                        // a Super Admin's business. Offering the button here
                        // would only produce a 403.
                        <span className="text-xs text-faint italic">Super Admin can change this</span>
                      ) : (
                        <button
                          onClick={() => demote(row)}
                          disabled={busyId === row.id}
                          className="inline-flex items-center gap-1 text-xs font-bold text-red-700 dark:text-red-300 transition-colors hover:text-red-800 disabled:opacity-50"
                          title="Take back the full queue — they go back to seeing only what you send them"
                        >
                          {busyId === row.id ? <Loader2 size={13} className="animate-spin" /> : <ArrowDownCircle size={13} />} Return to associate
                        </button>
                      )
                    ) : (
                    <>
                    <button
                      onClick={() => setResetFor(row)}
                      className="inline-flex items-center gap-1 text-xs font-bold text-muted transition-colors hover:text-brand"
                      title="Set a new password for this login"
                    >
                      <KeyRound size={13} /> Reset password
                    </button>
                    {/* Only on a live login: promoting a deactivated account
                        would hand the whole queue to someone who cannot sign
                        in, and the role change would outlive the deactivation. */}
                    {row.isActive && (
                      <button
                        onClick={() => promote(row)}
                        disabled={busyId === row.id}
                        className="inline-flex items-center gap-1 text-xs font-bold text-muted transition-colors hover:text-brand-dark disabled:opacity-50"
                        title="Make them a full Finance user — they will see and be able to pay the entire queue"
                      >
                        <ArrowUpCircle size={13} /> Promote to Finance
                      </button>
                    )}
                    {row.isActive ? (
                      <button
                        onClick={() => setActive(row, false)}
                        disabled={busyId === row.id}
                        className="inline-flex items-center gap-1 text-xs font-bold text-red-700 dark:text-red-300 transition-colors hover:text-red-800 disabled:opacity-50"
                        title="Retire this login (reversible)"
                      >
                        {busyId === row.id ? <Loader2 size={13} className="animate-spin" /> : <CircleSlash size={13} />} Deactivate
                      </button>
                    ) : (
                      <button
                        onClick={() => setActive(row, true)}
                        disabled={busyId === row.id}
                        className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700 dark:text-emerald-300 transition-colors hover:text-emerald-900 disabled:opacity-50"
                        title="Restore this login"
                      >
                        {busyId === row.id ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />} Reactivate
                      </button>
                    )}
                    </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AddAssociateFinanceModal
        isOpen={showAdd}
        onClose={() => setShowAdd(false)}
        onCreated={() => { setShowAdd(false); load(); }}
      />
      <ResetPasswordModal
        row={resetFor}
        onClose={() => setResetFor(null)}
        onDone={() => { setResetFor(null); load(); }}
      />
    </div>
  );
};


const AddAssociateFinanceModal = ({
  isOpen, onClose, onCreated,
}: { isOpen: boolean; onClose: () => void; onCreated: () => void }) => {
  const { addToast } = useToast();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Don't leave a typed password sitting in state behind a closed modal.
    if (!isOpen) { setName(''); setEmail(''); setPassword(''); }
  }, [isOpen]);

  const save = async () => {
    if (!name.trim() || !email.trim() || !password) {
      addToast('Name, email and password are all required.', 'error');
      return;
    }
    const problem = passwordProblem(password);
    if (problem) { addToast(problem, 'error'); return; }

    setSaving(true);
    try {
      // `role` is sent for clarity, but the server forces it for a Finance
      // caller regardless — this field can't be used to create anything else.
      await usersApi.create({ name: name.trim(), email: email.trim(), password, role: UserRole.ASSOCIATE_FINANCE } as any);
      addToast(`${name.trim()} can now sign in as Associate Finance.`, 'success');
      onCreated();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not create the login'), 'error');
    }
    setSaving(false);
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add Associate Finance">
      <div className="space-y-3">
        <p className="text-xs text-muted">
          They'll be able to sign in straight away with the password you set — pass it on to them.
          They see no payments until you send them some from <b>Payments &amp; Spend</b>.
        </p>
        <Field label="Name" value={name} onChange={setName} placeholder="Full name" />
        <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="name@rhythmrx.ai" />
        <Field
          label="Password" value={password} onChange={setPassword} type="password"
          placeholder="At least 8 characters, with a letter and a number"
        />
        <div className="flex justify-end pt-1">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-brand-dark disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />} Create login
          </button>
        </div>
      </div>
    </Modal>
  );
};

const ResetPasswordModal = ({
  row, onClose, onDone,
}: { row: Row | null; onClose: () => void; onDone: () => void }) => {
  const { addToast } = useToast();
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (!row) setPassword(''); }, [row]);

  const save = async () => {
    if (!row) return;
    const problem = passwordProblem(password);
    if (problem) { addToast(problem, 'error'); return; }
    setSaving(true);
    try {
      await usersApi.updateAssociateFinance(row.id, { password });
      addToast(`New password set for ${row.name}. They've been signed out everywhere.`, 'success');
      setPassword('');
      onDone();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not set the password'), 'error');
    }
    setSaving(false);
  };

  return (
    <Modal isOpen={!!row} onClose={onClose} title={row ? `Reset password — ${row.name}` : 'Reset password'}>
      <div className="space-y-3">
        <p className="text-xs text-muted">
          This signs {row?.name ?? 'them'} out of every device immediately, so tell them the new
          password. It will show in the Password column here afterwards.
        </p>
        <Field
          label="New password" value={password} onChange={setPassword} type="password"
          placeholder="At least 8 characters, with a letter and a number"
        />
        <div className="flex justify-end pt-1">
          <button
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-brand px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-brand-dark disabled:opacity-50"
          >
            {saving && <Loader2 size={14} className="animate-spin" />} Set password
          </button>
        </div>
      </div>
    </Modal>
  );
};

const Field = ({
  label, value, onChange, type = 'text', placeholder,
}: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) => (
  <label className="block">
    <span className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-faint">{label}</span>
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-line px-3 py-2 text-sm text-ink outline-none transition-colors focus:border-brand"
    />
  </label>
);
