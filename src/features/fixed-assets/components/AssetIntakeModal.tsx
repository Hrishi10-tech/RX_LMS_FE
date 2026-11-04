import { useEffect, useState } from 'react';
import { client } from '@/api';
import { extractErrorMessage } from '@/lib';
import { Modal } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { Inbox, ArrowRight, Package } from 'lucide-react';
import { useAbortOnUnmount } from '@/hooks';

const CATEGORIES = [
  { value: 'MACHINERIES', label: 'Machineries' },
  { value: 'RND_EQUIPMENT', label: 'R&D Equipment' },
  { value: 'FURNITURE_FIXTURES', label: 'Furniture & Fixtures' },
  { value: 'COMPUTERS_IT', label: 'Computers & IT Assets' },
  { value: 'TOOLS_SMALL_INSTRUMENTS', label: 'Tools (Small Instruments)' },
  { value: 'SAFETY_EQUIPMENT', label: 'Safety Equipment' },
  { value: 'INVENTORY_COMPONENTS', label: 'Inventory Components' },
];
const CONDITIONS = ['WORKING', 'NEEDS_REPAIR', 'DAMAGED', 'DISPOSED'];

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Refresh the asset register + intake badge after a receive. */
  onReceived: () => void;
  companies: any[];
  users: any[];
  assetLocations: any[];
}

/**
 * The "Receive from inventory" queue for Associate Finance. Lists PENDING
 * asset intakes (asset-tagged lines inventory routed here at receive time),
 * and registers a chosen one into the fixed-asset register — one FA-tagged
 * asset per unit. AF fills the classification; name / value / department are
 * pre-filled from the intake snapshot.
 */
export const AssetIntakeModal = ({ isOpen, onClose, onReceived, companies, users, assetLocations }: Props) => {
  const { addToast } = useToast();
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [intakes, setIntakes] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState<any>(null);
  const [submitting, setSubmitting] = useState(false);

  const [form, setForm] = useState<any>({
    category: 'MACHINERIES',
    condition: 'WORKING',
    assetType: 'TANGIBLE',
    ownership: 'OWNED',
    companyId: '',
    locationId: '',
    location: '',
    custodianId: '',
    purchaseValue: '' as number | '',
    count: '' as number | '',
  });

  const load = async () => {
    setLoading(true);
    try {
      const res = await client.get('/asset-intakes', { signal: abortSignal() });
      const rows = res.data?.data ?? res.data ?? [];
      setIntakes(Array.isArray(rows) ? rows : []);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to load intakes'), 'error');
    }
    setLoading(false);
  };

  useEffect(() => {
    if (isOpen) { setActive(null); load(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const startReceive = (intake: any) => {
    setActive(intake);
    setForm({
      category: 'MACHINERIES',
      condition: 'WORKING',
      assetType: 'TANGIBLE',
      ownership: 'OWNED',
      companyId: '',
      locationId: '',
      location: '',
      custodianId: '',
      purchaseValue: intake.unitValue != null ? Number(intake.unitValue) : ('' as number | ''),
      count: intake.qty,
    });
  };

  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!active) return;
    if (!form.category) { addToast('Pick an asset category.', 'error'); return; }
    setSubmitting(true);
    try {
      const body: any = {
        category: form.category,
        condition: form.condition,
        assetType: form.assetType,
        ownership: form.ownership,
      };
      if (form.companyId) body.companyId = form.companyId;
      if (form.locationId) body.locationId = form.locationId;
      else if (form.location.trim()) body.location = form.location.trim();
      if (form.custodianId) body.custodianId = form.custodianId;
      if (form.purchaseValue !== '' && form.purchaseValue != null) body.purchaseValue = Number(form.purchaseValue);
      if (form.count !== '' && form.count != null) body.count = Number(form.count);

      const res = await client.post(`/asset-intakes/${active.id}/receive`, body);
      const data = res.data?.data ?? res.data ?? {};
      addToast(`${data.createdCount || form.count} asset(s) added to the register.`, 'success');
      setActive(null);
      await load();
      onReceived();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to register asset'), 'error');
    }
    setSubmitting(false);
  };

  const custodians = users.filter((u: any) => u?.id);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Receive from Inventory — Assets">
      <div className="max-h-[75vh] overflow-y-auto space-y-4 p-1">
        {loading ? (
          <div className="text-center py-8 text-muted">Loading…</div>
        ) : active ? (
          /* ---- Receive form for the selected intake ---- */
          <div className="space-y-4">
            <button onClick={() => setActive(null)} className="text-xs text-violet-700 dark:text-violet-300 font-bold hover:underline">← Back to queue</button>
            <div className="rounded-lg border border-violet-200 dark:border-violet-400/30 bg-violet-50/50 dark:bg-violet-400/15 p-3 text-sm">
              <p className="font-bold text-ink">{active.name}</p>
              <p className="text-xs text-muted mt-0.5">
                From {active.indentSerialNo} · {active.qty} unit{active.qty === 1 ? '' : 's'}
                {active.unitValue != null && ` · ${active.currency || ''} ${Number(active.unitValue).toLocaleString('en-IN')} each`}
                {active.routedByName && ` · routed by ${active.routedByName}`}
              </p>
              <p className="text-[11px] text-violet-700 dark:text-violet-300 mt-1">
                Registering creates {Number(form.count) === 1 ? 'one FA-tagged asset' : `${Number(form.count)} FA-tagged assets`} (one per unit).
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-xs">
                <span className="block font-bold text-muted mb-1">Category *</span>
                <select value={form.category} onChange={e => set('category', e.target.value)} className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none">
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </label>
              <label className="text-xs">
                <span className="block font-bold text-muted mb-1">Condition</span>
                <select value={form.condition} onChange={e => set('condition', e.target.value)} className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none">
                  {CONDITIONS.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
                </select>
              </label>
              <label className="text-xs">
                <span className="block font-bold text-muted mb-1">Type</span>
                <select value={form.assetType} onChange={e => set('assetType', e.target.value)} className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none">
                  <option value="TANGIBLE">Tangible</option>
                  <option value="INTANGIBLE">Intangible</option>
                </select>
              </label>
              <label className="text-xs">
                <span className="block font-bold text-muted mb-1">Ownership</span>
                <select value={form.ownership} onChange={e => set('ownership', e.target.value)} className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none">
                  <option value="OWNED">Owned</option>
                  <option value="SHARED">Shared</option>
                </select>
              </label>
              <label className="text-xs">
                <span className="block font-bold text-muted mb-1">Company</span>
                <select value={form.companyId} onChange={e => set('companyId', e.target.value)} className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none">
                  <option value="">— none —</option>
                  {companies.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <label className="text-xs">
                <span className="block font-bold text-muted mb-1">Location</span>
                <select value={form.locationId} onChange={e => set('locationId', e.target.value)} className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none">
                  <option value="">— pick a lab —</option>
                  {assetLocations.map((l: any) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </label>
              <label className="text-xs">
                <span className="block font-bold text-muted mb-1">Custodian</span>
                <select value={form.custodianId} onChange={e => set('custodianId', e.target.value)} className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none">
                  <option value="">— unassigned —</option>
                  {custodians.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
              <label className="text-xs">
                <span className="block font-bold text-muted mb-1">Purchase value (per unit)</span>
                <input type="number" min={0} value={form.purchaseValue} onChange={e => set('purchaseValue', e.target.value === '' ? '' : Number(e.target.value))} className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none" />
              </label>
              <label className="text-xs">
                <span className="block font-bold text-muted mb-1">How many to register</span>
                <input type="number" min={1} max={active.qty} step={1} value={form.count} onChange={e => set('count', e.target.value === '' ? '' : Math.round(Number(e.target.value)))} className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none" />
                <span className="text-[10px] text-faint">Up to {active.qty} (the qty inventory sent).</span>
              </label>
            </div>

            <div className="flex justify-end gap-3 pt-3 border-t border-line-soft">
              <button onClick={() => setActive(null)} className="px-4 py-2 text-muted font-bold rounded-md hover:bg-hover text-sm">Cancel</button>
              <button onClick={submit} disabled={submitting} className="flex items-center gap-2 px-5 py-2 bg-violet-600 text-white font-bold rounded-md hover:bg-violet-700 transition-colors disabled:opacity-50 text-sm">
                <ArrowRight size={16} />
                {submitting ? 'Registering…' : 'Add to register'}
              </button>
            </div>
          </div>
        ) : (
          /* ---- Queue list ---- */
          <>
            <p className="text-sm text-muted">Assets inventory routed to you from received indents. Register each into the fixed-asset register.</p>
            {intakes.length === 0 ? (
              <div className="text-center py-8 border-2 border-dashed border-line rounded-lg">
                <Inbox className="w-10 h-10 text-faint mx-auto mb-2" />
                <p className="text-sm text-faint">Nothing to register.</p>
                <p className="text-xs text-faint mt-1">Asset-tagged items appear here when inventory receives them from procurement.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {intakes.map((it: any) => (
                  <div key={it.id} className="flex items-center justify-between gap-3 p-4 rounded-lg border border-line flex-wrap">
                    <div className="text-sm">
                      <p className="font-bold text-ink flex items-center gap-2"><Package size={14} className="text-violet-600 dark:text-violet-300" />{it.name}</p>
                      <p className="text-xs text-muted mt-0.5">
                        {it.indentSerialNo} · {it.qty} unit{it.qty === 1 ? '' : 's'}
                        {it.unitValue != null && ` · ${it.currency || ''} ${Number(it.unitValue).toLocaleString('en-IN')} each`}
                        {it.routedByName && ` · from ${it.routedByName}`}
                      </p>
                    </div>
                    {/* `canRegister` comes from the server, which owns the
                        four-eyes policy: whoever routed a line to Finance
                        cannot be the one who registers it. Gating here means
                        the clerk learns that from a disabled button and a
                        reason, instead of filling in the whole form and
                        collecting a 403 at submit. */}
                    {it.canRegister === false ? (
                      <div className="text-right">
                        <button
                          disabled
                          title="You routed this line to Finance, so someone else has to register it"
                          className="text-xs font-bold bg-hover text-faint px-3 py-1.5 rounded-md cursor-not-allowed"
                        >
                          Receive
                        </button>
                        <p className="text-[10px] text-amber-700 dark:text-amber-300 font-bold mt-1 max-w-[13rem]">
                          You routed this one — someone else has to register it.
                        </p>
                      </div>
                    ) : (
                      <button onClick={() => startReceive(it)} className="text-xs font-bold bg-violet-600 text-white px-3 py-1.5 rounded-md hover:bg-violet-700 transition-colors shadow-sm">
                        Receive
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
};
