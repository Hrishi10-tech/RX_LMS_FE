import { useCallback, useEffect, useState } from 'react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { extractErrorMessage } from '@/lib';
import { Modal } from '@/components/ui';
import { Building2, Plus, Pencil, Trash2 } from 'lucide-react';
import { BackLink } from '@/components/ui/BackLink';
import { useAbortOnUnmount } from '@/hooks';

interface Company {
  id: string;
  name: string;
  code?: string | null;
  isOwn: boolean;
  description?: string | null;
  _count?: { fixedAssets: number };
  createdAt: string;
}

/**
 * Lightweight Companies management page (SUPER_ADMIN). Lists the 2–3
 * sibling entities the org operates through + lets the admin add/edit
 * /delete them. Each company is referenced by FixedAssets via
 * `companyId`; the delete path is RESTRICT-guarded server-side so
 * the admin can't accidentally orphan an asset register.
 */
export const CompaniesPage = () => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [rows, setRows] = useState<Company[]>([]);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  const emptyForm = { name: '', code: '', isOwn: true, description: '' };
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await client.get('/companies', { signal: abortSignal() });
      const data = res.data?.data ?? res.data ?? [];
      setRows(Array.isArray(data) ? data : []);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to load companies'), 'error');
    } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { load(); }, [load]);

  const openAdd = () => {
    setEditing(null);
    setForm(emptyForm);
    setShowModal(true);
  };

  const openEdit = (c: Company) => {
    setEditing(c);
    setForm({
      name: c.name,
      code: c.code || '',
      isOwn: c.isOwn,
      description: c.description || '',
    });
    setShowModal(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      addToast('Name is required.', 'error');
      return;
    }
    setSaving(true);
    try {
      // On an edit, an emptied box is sent as "" so the server clears it —
      // omitted, the old value stayed and a company code could never be freed.
      const text = (v: string) => (editing ? v.trim() : v.trim() || undefined);
      const payload = {
        name: form.name.trim(),
        code: text(form.code),
        isOwn: form.isOwn,
        description: text(form.description),
      };
      if (editing) {
        await client.patch(`/companies/${editing.id}`, payload);
        addToast('Company updated', 'success');
      } else {
        await client.post('/companies', payload);
        addToast('Company added', 'success');
      }
      setShowModal(false);
      load();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to save'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (c: Company) => {
    if (!await confirm(`Delete ${c.name}? This is blocked if any asset references it.`)) return;
    try {
      await client.delete(`/companies/${c.id}`);
      addToast('Company removed', 'success');
      load();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to delete'), 'error');
    }
  };

  return (
    <div className="space-y-4 md:space-y-6">
      <BackLink label="Back" />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink flex items-center gap-2">
            <Building2 size={22} className="text-brand" />
            Companies
          </h2>
          <p className="text-sm md:text-[15px] text-muted mt-1.5">
            Sibling entities the org operates through. Each fixed asset belongs to one company.
            Mark <span className="font-bold">Own</span> for entities we control; mark <span className="font-bold">Partner</span> for sister companies we share assets with.
          </p>
        </div>
        <button onClick={openAdd}
          className="bg-brand text-white px-4 py-2 rounded-full font-bold hover:bg-brand-dark inline-flex items-center gap-2 shadow-sm">
          <Plus size={16} /> Add company
        </button>
      </div>

      <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
        {loading && <div className="text-center text-faint py-10 text-sm">Loading…</div>}
        {!loading && rows.length === 0 && (
          <div className="text-center text-faint py-10 text-sm">
            No companies yet. Click <span className="font-bold">Add company</span> above.
          </div>
        )}
        {!loading && rows.length > 0 && (
          <div className="divide-y divide-line-soft">
            {rows.map(c => (
              <div key={c.id} className="px-6 py-4 flex items-center gap-4">
                <div className="w-10 h-10 rounded-lg bg-brand/10 flex items-center justify-center shrink-0">
                  <Building2 size={18} className="text-brand" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-base font-bold text-ink">{c.name}</span>
                    {c.code && <span className="font-mono text-[10px] text-faint bg-hover px-1.5 py-0.5 rounded">{c.code}</span>}
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                      c.isOwn
                        ? 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30'
                        : 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30'
                    }`}>
                      {c.isOwn ? 'OWN' : 'PARTNER'}
                    </span>
                  </div>
                  {c.description && <p className="text-[11px] text-muted mt-0.5 line-clamp-1">{c.description}</p>}
                  <p className="text-[10px] text-faint mt-0.5">
                    {(c._count?.fixedAssets ?? 0)} fixed asset{(c._count?.fixedAssets ?? 0) === 1 ? '' : 's'} attributed
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <button onClick={() => openEdit(c)}
                    className="text-xs text-brand font-bold hover:underline inline-flex items-center gap-1 px-2 py-1">
                    <Pencil size={11} /> Edit
                  </button>
                  <button onClick={() => remove(c)}
                    className="text-xs text-red-700 dark:text-red-300 font-bold hover:text-red-700 dark:text-red-300 inline-flex items-center gap-1 px-2 py-1">
                    <Trash2 size={11} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Modal isOpen={showModal} onClose={() => !saving && setShowModal(false)} title={editing ? `Edit company — ${editing.name}` : 'Add company'}>
        <div className="space-y-3 p-1">
          <div>
            <label className="block text-[10px] font-bold text-muted uppercase mb-1">Name *</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Acme Pvt Ltd"
              className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Code (optional)</label>
              <input
                type="text"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="GST / internal abbr."
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Relationship</label>
              <select
                value={form.isOwn ? 'OWN' : 'PARTNER'}
                onChange={(e) => setForm({ ...form, isOwn: e.target.value === 'OWN' })}
                className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
              >
                <option value="OWN">Own (we operate it)</option>
                <option value="PARTNER">Partner (sister / shared)</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-[10px] font-bold text-muted uppercase mb-1">Description (optional)</label>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={2}
              className="w-full px-3 py-2 border rounded-md text-sm focus:border-brand outline-none resize-none"
              placeholder="What does this company do / where does it sit in the group?"
            />
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-line-soft">
            <button onClick={() => setShowModal(false)} disabled={saving}
              className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface disabled:opacity-50">
              Cancel
            </button>
            <button onClick={save} disabled={saving}
              className="px-5 py-2 text-sm font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50 shadow-sm">
              {saving ? 'Saving…' : editing ? 'Update' : 'Add company'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
