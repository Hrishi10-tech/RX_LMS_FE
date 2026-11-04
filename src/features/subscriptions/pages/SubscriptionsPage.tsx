import { useCallback, useEffect, useMemo, useState } from 'react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { useServerPagination, useAbortOnUnmount, useTableFilters, FilterSpec } from '@/hooks';
import { extractErrorMessage } from '@/lib';
import { Modal, SearchInput, Pagination, ColumnFilter } from '@/components/ui';
import {
  Repeat,
  Plus,
  Pencil,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Calendar,
  ExternalLink,
} from 'lucide-react';

type SubscriptionStatus = 'PAID' | 'UNPAID';

interface Subscription {
  id: string;
  name: string;
  vendor?: string | null;
  description?: string | null;
  amount?: string | number | null;
  currency: string;
  expiryDate: string;
  renewalIntervalDays?: number | null;
  status: SubscriptionStatus;
  lastPaidAt?: string | null;
  lastPaidReference?: string | null;
  lastPaidBy?: { id: string; name: string } | null;
  notes?: string | null;
  url?: string | null;
  notified14DaysBefore: boolean;
  notified7DaysBefore: boolean;
  lastDayOfExpiryNotifiedAt?: string | null;
  createdBy?: { id: string; name: string } | null;
  createdAt: string;
}

/**
 * Finance-only ledger of recurring subscriptions (Claude, Zoho, Tally…).
 * Backend gates this to FINANCE + SUPER_ADMIN; ASSOCIATE_FINANCE is
 * deliberately excluded — finance head's books.
 *
 * UX rules of thumb:
 *  - UNPAID rows float to top; expiry chip turns amber/red as the date
 *    nears / passes.
 *  - Mark Paid is the primary inline action — it stamps audit metadata,
 *    rolls expiryDate forward by renewalIntervalDays (or accepts an
 *    override), and re-arms the cron reminders for the next cycle.
 *  - Edit + Delete are secondary.
 */
// What the Amount and Last paid cells show — shared so a filter offers the same text.
const fmtSubAmount = (sub: Subscription) =>
  sub.amount != null
    ? `${sub.currency} ${Number(sub.amount).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
const fmtLastPaid = (sub: Subscription) => (sub.lastPaidAt ? new Date(sub.lastPaidAt).toLocaleDateString() : '—');

// A filter on every data column (owner, 27 Oct). Values match what each cell
// shows; they narrow the rows on this page, like the other server-paged tables.
const SUB_FILTER_SPECS: FilterSpec<Subscription>[] = [
  { key: 'name', getValue: (s) => s.name },
  { key: 'amount', getValue: fmtSubAmount },
  { key: 'expiry', getValue: (s) => new Date(s.expiryDate).toDateString() },
  { key: 'status', getValue: (s) => (s.status === 'PAID' ? 'Paid' : 'Unpaid') },
  { key: 'lastPaid', getValue: fmtLastPaid },
];

export const SubscriptionsPage = () => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [statusFilter, setStatusFilter] = useState<'ALL' | SubscriptionStatus>('ALL');

  // Table: 10/page server-side, narrowed by the status tabs + search box.
  const { items: rows, page, setPage, totalPages, search, setSearch, isLoading: loading, refetch } =
    useServerPagination<Subscription>({ urlKey: 'page',
      endpoint: '/subscriptions',
      params: { status: statusFilter === 'ALL' ? undefined : statusFilter },
    });
  const f = useTableFilters(rows, SUB_FILTER_SPECS);
  const th = (label: string, key: string) => (
    <th className={`text-left px-4 py-3 ${f.isActive(key) ? 'bg-brand-100' : ''}`}>
      <span className="inline-flex items-center">
        {label}
        <ColumnFilter searchable options={f.getOptions(key)} value={f.filters[key] || ''} onChange={(v) => f.setFilter(key, v)} />
      </span>
    </th>
  );

  // Summary chips count across ALL unpaid rows (not just the current page),
  // from a server-side aggregate (4 integers) — no full UNPAID row pull.
  // `dueToday` is the subset of `due14` expiring today, exposed so the chips
  // keep their today-inclusive overdue bucket (see `totals` below).
  const [summary, setSummary] = useState<{ due14: number; overdue: number; dueToday: number; unpaid: number }>(
    { due14: 0, overdue: 0, dueToday: 0, unpaid: 0 },
  );
  const loadSummary = useCallback(async () => {
    try {
      const res = await client.get('/subscriptions/expiry-summary', { signal: abortSignal() });
      const d = res.data?.data ?? res.data ?? {};
      setSummary({ due14: d.due14 ?? 0, overdue: d.overdue ?? 0, dueToday: d.dueToday ?? 0, unpaid: d.unpaid ?? 0 });
    } catch { /* best-effort: chips fall back to 0 */ }
  }, []);
  const reloadAll = () => { refetch(); loadSummary(); };

  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Subscription | null>(null);
  const emptyForm = {
    name: '',
    vendor: '',
    description: '',
    amount: '',
    currency: 'INR',
    expiryDate: '',
    renewalIntervalDays: '',
    notes: '',
    url: '',
  };
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const [payModalFor, setPayModalFor] = useState<Subscription | null>(null);
  const [payForm, setPayForm] = useState({ reference: '', newExpiryDate: '' });
  const [paying, setPaying] = useState(false);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEdit = (s: Subscription) => {
    setEditing(s);
    setForm({
      name: s.name,
      vendor: s.vendor || '',
      description: s.description || '',
      amount: s.amount != null ? String(s.amount) : '',
      currency: s.currency || 'INR',
      expiryDate: s.expiryDate.slice(0, 10),
      renewalIntervalDays: s.renewalIntervalDays != null ? String(s.renewalIntervalDays) : '',
      notes: s.notes || '',
      url: s.url || '',
    });
    setShowModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      addToast('Name is required.', 'error');
      return;
    }
    if (!form.expiryDate) {
      addToast('Expiry date is required.', 'error');
      return;
    }
    setSaving(true);
    try {
      // On an edit a cleared box must reach the server as "clear it": the
      // update only touches fields it receives, so sending nothing for an
      // emptied "renews every N days" kept the old interval and Mark Paid went
      // on rolling the expiry forward. Strings go as "" (stored as null),
      // numbers as null. A create still simply omits them.
      const cleared = editing ? null : undefined;
      const text = (v: string) => (editing ? v.trim() : v.trim() || undefined);
      const payload: any = {
        name: form.name.trim(),
        vendor: text(form.vendor),
        description: text(form.description),
        expiryDate: new Date(form.expiryDate).toISOString(),
        amount: form.amount ? Number(form.amount) : cleared,
        currency: form.currency.trim() || 'INR',
        renewalIntervalDays: form.renewalIntervalDays
          ? Number(form.renewalIntervalDays)
          : cleared,
        notes: text(form.notes),
        url: text(form.url),
      };
      if (editing) {
        await client.patch(`/subscriptions/${editing.id}`, payload);
        addToast('Subscription updated', 'success');
      } else {
        await client.post('/subscriptions', payload);
        addToast('Subscription added', 'success');
      }
      setShowModal(false);
      reloadAll();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to save'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const openMarkPaid = (s: Subscription) => {
    setPayModalFor(s);
    setPayForm({ reference: '', newExpiryDate: '' });
  };

  const submitMarkPaid = async () => {
    if (!payModalFor) return;
    setPaying(true);
    try {
      const payload: any = {};
      if (payForm.reference.trim()) payload.reference = payForm.reference.trim();
      if (payForm.newExpiryDate) {
        payload.newExpiryDate = new Date(payForm.newExpiryDate).toISOString();
      }
      await client.post(`/subscriptions/${payModalFor.id}/mark-paid`, payload);
      addToast(`Marked ${payModalFor.name} paid`, 'success');
      setPayModalFor(null);
      reloadAll();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to mark paid'), 'error');
    } finally {
      setPaying(false);
    }
  };

  const remove = async (s: Subscription) => {
    if (!await confirm(`Delete ${s.name}? You can always re-add it later.`)) return;
    try {
      await client.delete(`/subscriptions/${s.id}`);
      addToast('Subscription removed', 'success');
      reloadAll();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to delete'), 'error');
    }
  };

  // Chips keep their original today-inclusive buckets, derived from the
  // aggregate: "expires today" counts as overdue (not upcoming), matching the
  // old client-side `days <= 0`. overdue = before-today + today; upcoming14 =
  // the [today, +14] window minus today; unpaid = total UNPAID.
  const totals = useMemo(() => ({
    unpaid: summary.unpaid,
    upcoming14: summary.due14 - summary.dueToday,
    overdue: summary.overdue + summary.dueToday,
  }), [summary]);

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink flex items-center gap-2">
            <Repeat size={22} className="text-brand" />
            Subscriptions
          </h2>
          <p className="text-sm md:text-[15px] text-muted mt-1.5">
            Recurring SaaS bills the org pays — Claude, Zoho, Tally, and so on. You'll get
            a notification 2 weeks out, 1 week out, and then repeatedly on/after the expiry
            day until you mark the cycle paid.
          </p>
        </div>
        <button
          onClick={openAdd}
          className="bg-brand text-white px-4 py-2 rounded-full font-bold hover:bg-brand-dark inline-flex items-center gap-2 shadow-sm"
        >
          <Plus size={16} /> Add subscription
        </button>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SummaryChip
          label="Unpaid"
          value={totals.unpaid}
          accent="text-ink"
          bg="bg-card border border-line"
        />
        <SummaryChip
          label="Due within 2 weeks"
          value={totals.upcoming14}
          accent="text-amber-700 dark:text-amber-300"
          bg="bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30"
        />
        <SummaryChip
          label="Overdue"
          value={totals.overdue}
          accent="text-red-700 dark:text-red-300"
          bg="bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30"
        />
      </div>

      {/* Filter + search */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs">
          {(['ALL', 'UNPAID', 'PAID'] as const).map(s => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-md font-bold border ${
                statusFilter === s
                  ? 'bg-brand text-white border-brand'
                  : 'bg-card text-muted border-line hover:border-brand'
              }`}
            >
              {s === 'ALL' ? 'All' : s === 'UNPAID' ? 'Unpaid' : 'Paid'}
            </button>
          ))}
        </div>
        <div className="w-full sm:w-64">
          <SearchInput value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, vendor..." />
        </div>
      </div>

      <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
        {loading && <div className="text-center text-faint py-10 text-sm">Loading…</div>}
        {!loading && rows.length === 0 && (
          <div className="text-center text-faint py-10 text-sm">
            No subscriptions yet. Click <span className="font-bold">Add subscription</span> above to
            start tracking one (e.g. Claude Pro, Zoho One, Tally Prime).
          </div>
        )}
        {!loading && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-surface text-[10px] font-bold text-muted uppercase">
                <tr>
                  {th('Subscription', 'name')}
                  {th('Amount', 'amount')}
                  {th('Expiry', 'expiry')}
                  {th('Status', 'status')}
                  {th('Last paid', 'lastPaid')}
                  <th className="text-right px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {f.filteredRows.length === 0 && (
                  <tr><td colSpan={6} className="text-center text-faint py-8 text-sm">No subscriptions match these filters.</td></tr>
                )}
                {f.filteredRows.map(s => (
                  <SubscriptionRow
                    key={s.id}
                    sub={s}
                    onEdit={() => openEdit(s)}
                    onMarkPaid={() => openMarkPaid(s)}
                    onDelete={() => remove(s)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
      </div>

      {/* Add / Edit modal */}
      <Modal
        isOpen={showModal}
        onClose={() => !saving && setShowModal(false)}
        title={editing ? `Edit subscription — ${editing.name}` : 'Add subscription'}
      >
        <div className="space-y-3 p-1">
          <div>
            <label className="block text-[10px] font-bold text-muted uppercase mb-1">Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Claude Pro"
              className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Vendor</label>
              <input
                type="text"
                value={form.vendor}
                onChange={e => setForm({ ...form, vendor: e.target.value })}
                placeholder="e.g. Anthropic"
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Expiry date *</label>
              <input
                type="date"
                value={form.expiryDate}
                onChange={e => setForm({ ...form, expiryDate: e.target.value })}
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Amount</label>
              <input
                type="number"
                value={form.amount}
                onChange={e => setForm({ ...form, amount: e.target.value })}
                placeholder="0.00"
                min="0"
                step="0.01"
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Currency</label>
              <input
                type="text"
                value={form.currency}
                onChange={e => setForm({ ...form, currency: e.target.value.toUpperCase().slice(0, 8) })}
                placeholder="INR"
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none uppercase"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">
                Renewal (days)
              </label>
              <input
                type="number"
                value={form.renewalIntervalDays}
                onChange={e => setForm({ ...form, renewalIntervalDays: e.target.value })}
                placeholder="30 = monthly, 365 = annual"
                min="1"
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-muted uppercase mb-1">Description</label>
            <textarea
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              rows={2}
              placeholder="What's this subscription for?"
              className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none resize-none"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">
                Vendor portal URL
              </label>
              <input
                type="url"
                value={form.url}
                onChange={e => setForm({ ...form, url: e.target.value })}
                placeholder="https://console.anthropic.com"
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Notes</label>
              <input
                type="text"
                value={form.notes}
                onChange={e => setForm({ ...form, notes: e.target.value })}
                placeholder="Account-holder, vendor login, etc."
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-line-soft">
            <button
              onClick={() => setShowModal(false)}
              disabled={saving}
              className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="px-5 py-2 text-sm font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50 shadow-sm"
            >
              {saving ? 'Saving…' : editing ? 'Update' : 'Add subscription'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Mark Paid modal */}
      <Modal
        isOpen={!!payModalFor}
        onClose={() => !paying && setPayModalFor(null)}
        title={payModalFor ? `Mark paid — ${payModalFor.name}` : ''}
      >
        {payModalFor && (
          <div className="space-y-3 p-1">
            <div className="text-xs text-muted bg-brand-50 border border-brand-200 rounded-md p-3 leading-relaxed">
              Current expiry:{' '}
              <span className="font-bold text-ink">
                {new Date(payModalFor.expiryDate).toDateString()}
              </span>
              {payModalFor.renewalIntervalDays ? (
                <>
                  <br />
                  We'll roll expiry forward by{' '}
                  <span className="font-bold">{payModalFor.renewalIntervalDays} days</span>{' '}
                  automatically. Override below if you've paid a different cycle.
                </>
              ) : (
                <>
                  <br />
                  No renewal cadence set. Provide the new expiry below, or leave blank to
                  mark it paid as a one-shot (no next cycle).
                </>
              )}
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">
                Invoice / reference (optional)
              </label>
              <input
                type="text"
                value={payForm.reference}
                onChange={e => setPayForm({ ...payForm, reference: e.target.value })}
                placeholder="INV-2024-..."
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">
                Override next expiry (optional)
              </label>
              <input
                type="date"
                value={payForm.newExpiryDate}
                onChange={e => setPayForm({ ...payForm, newExpiryDate: e.target.value })}
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
            <div className="flex justify-end gap-2 pt-3 border-t border-line-soft">
              <button
                onClick={() => setPayModalFor(null)}
                disabled={paying}
                className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submitMarkPaid}
                disabled={paying}
                className="px-5 py-2 text-sm font-bold bg-emerald-700 text-white rounded-md hover:bg-emerald-800 disabled:opacity-50 shadow-sm inline-flex items-center gap-2"
              >
                <CheckCircle2 size={14} />
                {paying ? 'Saving…' : 'Mark paid'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

const SummaryChip = ({
  label,
  value,
  accent,
  bg,
}: {
  label: string;
  value: number;
  accent: string;
  bg: string;
}) => (
  <div className={`rounded-xl px-4 py-3 ${bg}`}>
    <div className="text-[10px] font-bold uppercase text-muted">{label}</div>
    <div className={`text-2xl font-bold mt-0.5 ${accent}`}>{value}</div>
  </div>
);

const SubscriptionRow = ({
  sub,
  onEdit,
  onMarkPaid,
  onDelete,
}: {
  sub: Subscription;
  onEdit: () => void;
  onMarkPaid: () => void;
  onDelete: () => void;
}) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const exp = new Date(sub.expiryDate);
  exp.setHours(0, 0, 0, 0);
  const days = Math.round((exp.getTime() - today.getTime()) / 86_400_000);

  let chipClass = 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30';
  let chipText = `in ${days} days`;
  if (sub.status === 'PAID' && days > 14) {
    chipClass = 'bg-surface text-secondary border-line';
    chipText = `in ${days} days`;
  } else if (days < 0) {
    chipClass = 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30';
    chipText = `overdue ${Math.abs(days)}d`;
  } else if (days === 0) {
    chipClass = 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30';
    chipText = 'today';
  } else if (days <= 7) {
    chipClass = 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30';
    chipText = `${days}d left`;
  } else if (days <= 14) {
    chipClass = 'bg-yellow-50 dark:bg-yellow-400/15 text-yellow-700 dark:text-yellow-300 border-yellow-200 dark:border-yellow-400/30';
    chipText = `${days}d left`;
  }

  const amount = fmtSubAmount(sub);

  return (
    <tr className="hover:bg-surface/60">
      <td className="px-4 py-3 align-top">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold text-ink">{sub.name}</span>
              {sub.vendor && (
                <span className="text-[10px] text-faint">· {sub.vendor}</span>
              )}
              {/* Only http(s) becomes a link. Older rows were saved before the
                  server checked the scheme, and a javascript: URL here would
                  run in the viewer's session on click. */}
              {sub.url && /^https?:\/\//i.test(sub.url) && (
                <a
                  href={sub.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[10px] text-brand hover:underline inline-flex items-center gap-0.5"
                >
                  <ExternalLink size={10} /> portal
                </a>
              )}
            </div>
            {sub.description && (
              <p className="text-[11px] text-muted mt-0.5 line-clamp-1">{sub.description}</p>
            )}
            {sub.renewalIntervalDays && (
              <p className="text-[10px] text-faint mt-0.5">
                Renews every {sub.renewalIntervalDays}d
              </p>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 align-top text-[13px] text-ink font-medium whitespace-nowrap">
        {amount}
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        <div className="flex items-center gap-2">
          <Calendar size={12} className="text-faint" />
          <span className="text-[12px] text-ink">{exp.toDateString()}</span>
          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${chipClass}`}>
            {chipText}
          </span>
        </div>
      </td>
      <td className="px-4 py-3 align-top whitespace-nowrap">
        {sub.status === 'PAID' ? (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded border bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30 inline-flex items-center gap-1">
            <CheckCircle2 size={11} /> Paid
          </span>
        ) : (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded border bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30 inline-flex items-center gap-1">
            <AlertTriangle size={11} /> Unpaid
          </span>
        )}
      </td>
      <td className="px-4 py-3 align-top text-[11px] text-muted whitespace-nowrap">
        {sub.lastPaidAt ? (
          <>
            {fmtLastPaid(sub)}
            {sub.lastPaidBy && <div className="text-[10px] text-faint">by {sub.lastPaidBy.name}</div>}
            {sub.lastPaidReference && (
              <div className="text-[10px] text-faint">ref: {sub.lastPaidReference}</div>
            )}
          </>
        ) : (
          <span className="text-faint">—</span>
        )}
      </td>
      <td className="px-4 py-3 align-top text-right whitespace-nowrap">
        <div className="inline-flex items-center gap-1">
          {sub.status === 'UNPAID' && (
            <button
              onClick={onMarkPaid}
              className="text-[11px] font-bold text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:text-emerald-200 inline-flex items-center gap-1 px-2 py-1 rounded border border-emerald-200 dark:border-emerald-400/30 bg-emerald-50 dark:bg-emerald-400/15 hover:bg-emerald-100 dark:bg-emerald-400/20"
            >
              <CheckCircle2 size={11} /> Mark paid
            </button>
          )}
          <button
            onClick={onEdit}
            className="text-[11px] text-brand font-bold hover:underline inline-flex items-center gap-1 px-2 py-1"
          >
            <Pencil size={11} /> Edit
          </button>
          <button
            onClick={onDelete}
            className="text-[11px] text-red-700 dark:text-red-300 font-bold hover:text-red-700 dark:text-red-300 inline-flex items-center gap-1 px-2 py-1"
            title="Delete subscription"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </td>
    </tr>
  );
};
