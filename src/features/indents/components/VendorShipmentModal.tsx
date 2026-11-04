import { useEffect, useState } from 'react';
import { client } from '@/api';
import { Modal } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { fmtDate } from '@/utils/date';
import { extractErrorMessage } from '@/lib';
import { Truck, CheckCircle2, PackageCheck } from 'lucide-react';

interface Props {
  indent: any | null;
  onClose: () => void;
  onSaved: () => void;
}

// The per-line physical journey. Forward-only; CUSTOMS is optional ("mark when
// needed") so a line can jump straight to REACHED. REACHED is the procurement
// hand-off — inventory shelving (actualDeliveryDate) happens downstream.
const STAGES = ['IN_TRANSIT', 'CUSTOMS', 'REACHED'] as const;
type Stage = (typeof STAGES)[number];
const STAGE_RANK: Record<Stage, number> = { IN_TRANSIT: 1, CUSTOMS: 2, REACHED: 3 };
const STAGE_LABEL: Record<Stage, string> = { IN_TRANSIT: 'In transit', CUSTOMS: 'Customs', REACHED: 'Reached' };

// ISO → YYYY-MM-DD for <input type=date>, in the viewer's local timezone.
const toDateInput = (iso?: string | null): string => {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};

const rankOf = (s?: string | null): number => (s && s in STAGE_RANK ? STAGE_RANK[s as Stage] : 0);

/**
 * Per-LINE shipment tracker (procurement / super-admin). Lists every line item
 * on the indent, grouped by vendor, and lets procurement mark each line's stage
 * (In transit → Customs → Reached) and its own ETA independently — lines from
 * the same vendor can ship / clear customs / arrive on different days. Each save
 * hits PATCH /indents/:id/allocations/:allocId/shipment; the parent vendor order
 * + the indent status roll up from these stages automatically.
 *
 * Lines already shelved by inventory (actualDeliveryDate) are locked, and a line
 * marked REACHED is locked for procurement (inventory shelves it next). Reads the
 * authoritative grouping from GET /indents/:id/allocations.
 */
export const VendorShipmentModal = ({ indent, onClose, onSaved }: Props) => {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [byVendor, setByVendor] = useState<any[]>([]);
  const [edits, setEdits] = useState<Record<string, { stage: Stage; eta: string }>>({});
  // The ETA each line was loaded with. A late line arrives pre-filled with a
  // date that is now in the past; re-sending it untouched made every save —
  // including marking it Reached — fail "ETA can't be before today".
  const [loadedEta, setLoadedEta] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  // Min selectable ETA — a delivery date in the past is nonsensical. Server
  // enforces this too (assertEtaNotPast).
  const todayISO = new Date().toLocaleDateString('en-CA');

  const hydrate = (groups: any[]) => {
    setByVendor(groups);
    const init: Record<string, { stage: Stage; eta: string }> = {};
    for (const g of groups) {
      for (const a of g.items || []) {
        // Default the picker to the line's current stage, or the first forward
        // move (In transit) for a line that hasn't shipped yet.
        const cur = (a.shipmentStage && a.shipmentStage in STAGE_RANK ? a.shipmentStage : 'IN_TRANSIT') as Stage;
        init[a.id] = { stage: cur, eta: toDateInput(a.expectedDeliveryDate) };
      }
    }
    setEdits(init);
    setLoadedEta(Object.fromEntries(Object.entries(init).map(([id, v]) => [id, v.eta])));
  };

  useEffect(() => {
    if (!indent) { setByVendor([]); setEdits({}); return; }
    let cancelled = false;
    setLoading(true);
    client.get(`/indents/${indent.id}/allocations`)
      .then(res => { if (!cancelled) hydrate((res.data?.data || res.data)?.byVendor || []); })
      .catch(e => { if (!cancelled) addToast(extractErrorMessage(e, 'Failed to load shipments'), 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indent?.id]);

  const setEdit = (allocId: string, field: 'stage' | 'eta', value: string) =>
    setEdits(prev => ({ ...prev, [allocId]: { ...prev[allocId], [field]: value as any } }));

  const save = async (alloc: any) => {
    if (!indent) return;
    const e = edits[alloc.id] || { stage: 'IN_TRANSIT' as Stage, eta: '' };
    const etaChanged = e.eta !== (loadedEta[alloc.id] ?? '');
    if (etaChanged && e.eta && e.eta.slice(0, 10) < todayISO) {
      addToast("ETA can't be before today.", 'error');
      return;
    }
    setSavingId(alloc.id);
    try {
      await client.patch(`/indents/${indent.id}/allocations/${alloc.id}/shipment`, {
        stage: e.stage,
        // Only a date the user actually changed is sent; null leaves it as is.
        expectedDeliveryDate: etaChanged ? (e.eta || null) : null,
        expectedDeliveryHasTime: false,
      });
      addToast(`${alloc.indentItem?.name || 'Line'} → ${STAGE_LABEL[e.stage]}.`, 'success');
      onSaved();
      // Refresh so the rolled-up stage + ETA show immediately.
      const res = await client.get(`/indents/${indent.id}/allocations`);
      hydrate((res.data?.data || res.data)?.byVendor || []);
    } catch (err: any) {
      addToast(extractErrorMessage(err, 'Failed to update shipment'), 'error');
    }
    setSavingId(null);
  };

  return (
    <Modal isOpen={!!indent} onClose={onClose} title={`Shipment tracking — ${indent?.serialNo || ''}`}>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto p-1">
        <p className="text-sm text-muted">Mark each line's stage and ETA as it ships, clears customs, and arrives. Stages only move forward. Received lines are locked.</p>
        {loading ? (
          <div className="text-center py-8 text-faint">Loading...</div>
        ) : byVendor.length === 0 ? (
          <div className="text-center py-8 text-faint">No vendor allocations on this indent.</div>
        ) : (
          byVendor.map((g: any) => (
            <div key={g.vendorName} className="border border-line rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-bold text-ink flex items-center gap-1.5"><Truck size={14} className="text-brand" />{g.vendorName}</p>
                <span className="text-xs text-muted">{g.items?.length || 0} line(s)</span>
              </div>
              <div className="space-y-2.5">
                {(g.items || []).map((a: any) => {
                  const itemName = a.indentItem?.name || 'Item';
                  const qty = a.allocatedQty != null ? `${a.allocatedQty} ${a.unit || a.indentItem?.unit || ''}`.trim() : '';
                  const shelved = !!a.actualDeliveryDate;
                  const reached = !shelved && a.shipmentStage === 'REACHED';
                  const e = edits[a.id] || { stage: 'IN_TRANSIT' as Stage, eta: '' };
                  const curRank = rankOf(a.shipmentStage);

                  // --- Locked: already shelved by inventory ---
                  if (shelved) {
                    return (
                      <div key={a.id} className="rounded-lg bg-emerald-50 dark:bg-emerald-400/15 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-ink">{itemName}{qty ? <span className="font-normal text-muted"> · {qty}</span> : null}</span>
                          <span className="flex items-center gap-1 text-xs font-bold text-emerald-700 dark:text-emerald-300"><PackageCheck size={13} /> Received{a.actualDeliveryDate ? ` ${fmtDate(a.actualDeliveryDate)}` : ''}</span>
                        </div>
                      </div>
                    );
                  }

                  // --- Locked for procurement: reached, awaiting inventory shelving ---
                  if (reached) {
                    return (
                      <div key={a.id} className="rounded-lg bg-sky-50 dark:bg-sky-400/15 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-ink">{itemName}{qty ? <span className="font-normal text-muted"> · {qty}</span> : null}</span>
                          <span className="flex items-center gap-1 text-xs font-bold text-sky-700 dark:text-sky-300"><CheckCircle2 size={13} /> Reached — awaiting inventory</span>
                        </div>
                      </div>
                    );
                  }

                  // --- Editable: pick a forward stage + ETA ---
                  return (
                    <div key={a.id} className="rounded-lg border border-line-soft px-3 py-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-ink">{itemName}{qty ? <span className="font-normal text-muted"> · {qty}</span> : null}</span>
                        {a.shipmentStage ? <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300">{STAGE_LABEL[a.shipmentStage as Stage]}</span> : <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-hover text-muted">Not shipped</span>}
                      </div>
                      <div className="flex items-end gap-2">
                        <div className="flex-1">
                          <label className="text-[11px] font-bold text-muted block mb-1">Stage</label>
                          <select value={e.stage} onChange={ev => setEdit(a.id, 'stage', ev.target.value)}
                            className="w-full px-2.5 py-1.5 border border-line rounded-lg text-sm focus:border-brand outline-none">
                            {STAGES.map(s => (
                              // Forward-only: can't pick a stage earlier than where the line already is.
                              <option key={s} value={s} disabled={STAGE_RANK[s] < curRank}>{STAGE_LABEL[s]}</option>
                            ))}
                          </select>
                        </div>
                        <div className="flex-1">
                          <label className="text-[11px] font-bold text-muted block mb-1">ETA</label>
                          <input type="date" min={todayISO} value={e.eta} onChange={ev => setEdit(a.id, 'eta', ev.target.value)}
                            className="w-full px-2.5 py-1.5 border border-line rounded-lg text-sm focus:border-brand outline-none" />
                        </div>
                        <button onClick={() => save(a)} disabled={savingId === a.id}
                          className="px-3 py-1.5 bg-brand text-white text-sm font-bold rounded-full hover:bg-brand-600 disabled:opacity-50 whitespace-nowrap">
                          {savingId === a.id ? '…' : 'Save'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </Modal>
  );
};
