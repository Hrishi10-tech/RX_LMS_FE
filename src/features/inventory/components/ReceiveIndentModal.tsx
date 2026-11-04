import { PICKER_INITIAL_ITEMS } from '@/features/inventory/hooks/useInventoryOptions';
import { useEffect, useState } from 'react';
import { client } from '@/api';
import { cachedGet, extractErrorMessage } from '@/lib';
import { Modal, NumberInput } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { Package, Plus, Check, ArrowRight, Truck, CheckCircle2, Clock } from 'lucide-react';
import { useAbortOnUnmount } from '@/hooks';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onReceived: () => void;
  /** Pre-select a specific indent and skip the "pick one" step.
   *  Used by deep-links from notifications — clicking the "Items received"
   *  notification lands the clerk directly on the verify-and-shelf form
   *  for that indent (or the per-vendor picker for a multi-vendor split).
   *  Falls back to the picker when the indent isn't in the fetched list
   *  (already processed, or wrong status). */
  preselectIndentId?: string | null;
}

// Deliverable states. An indent's stock can start landing the moment it's
// ordered, so we fetch the whole live-with-vendors window — not just RECEIVED.
// Multi-vendor indents stay receivable across ORDERED → IN_TRANSIT →
// PARTIALLY_RECEIVED (each vendor's shipment received independently); legacy
// all-or-nothing indents (no vendor split) only surface once procurement marks
// them RECEIVED, preserving their original trigger.
const RECEIVABLE_STATUSES = 'ORDERED,IN_TRANSIT,PARTIALLY_RECEIVED,RECEIVED';

// Per-line physical stage — the single source of truth set on the shipment
// tracker. REACHED is procurement's "the box is physically here" hand-off,
// which is exactly what gates this receive flow.
const STAGE_LABEL: Record<string, string> = {
  IN_TRANSIT: 'In transit',
  CUSTOMS: 'At customs',
  REACHED: 'Reached',
};

interface Alloc {
  id: string;
  vendorName: string;
  vendorContact?: string | null;
  indentItemId: string;
  allocatedQty: number | string;
  unitPrice?: number | string | null;
  total?: number | null;
  shipmentStage?: string | null;
  expectedDeliveryDate?: string | null;
  expectedDeliveryHasTime?: boolean;
  actualDeliveryDate?: string | null;
  receivedQty?: number | string | null;
}

// --- pure helpers over an indent's embedded allocation rows ---
const allocsOf = (ind: any): Alloc[] => (ind?.vendorAllocations as Alloc[]) || [];
const isMultiVendor = (ind: any): boolean => allocsOf(ind).length > 0;
const pendingAllocs = (ind: any): Alloc[] => allocsOf(ind).filter(a => !a.actualDeliveryDate);

/** vendorName → its still-pending allocation rows (actualDeliveryDate null). */
const groupPendingByVendor = (ind: any): Map<string, Alloc[]> => {
  const map = new Map<string, Alloc[]>();
  for (const a of pendingAllocs(ind)) {
    const arr = map.get(a.vendorName) || [];
    arr.push(a);
    map.set(a.vendorName, arr);
  }
  return map;
};

/** Vendors whose entire shipment is already shelved (no pending lines left). */
const receivedVendors = (ind: any): string[] => {
  const pendingSet = new Set(pendingAllocs(ind).map(a => a.vendorName));
  const done = new Set<string>();
  for (const a of allocsOf(ind)) if (a.actualDeliveryDate && !pendingSet.has(a.vendorName)) done.add(a.vendorName);
  return [...done];
};

/** vendorName → its VendorOrder.status — the rolled-up order state (derived from
 *  its lines' shipmentStage; RECEIVED once every line has REACHED). Distinct from
 *  a single line's shipmentStage. Prefers a live order if a re-quote left a
 *  CANCELLED duplicate behind. */
const vendorOrderStatusOf = (ind: any, vendorName: string): string | null => {
  const orders = ((ind?.vendorOrders as any[]) || []).filter(o => o.vendorName === vendorName);
  if (orders.length === 0) return null;
  return (orders.find(o => o.status !== 'CANCELLED') || orders[0]).status ?? null;
};

/** Procurement closed this vendor's order as RECEIVED → strongest "the box is
 *  physically here, shelf it next" signal the clerk can get. */
const procurementReceived = (ind: any, vendorName: string): boolean =>
  vendorOrderStatusOf(ind, vendorName) === 'RECEIVED';

/** Rank a vendor by how likely its shipment has physically landed, so the
 *  picker floats arrived / imminent boxes to the top instead of listing
 *  vendors in arbitrary allocation order. Procurement's RECEIVED mark wins;
 *  per-line shipment stage (then the order's own lifecycle) orders the rest.
 *  Uses the MOST-advanced pending line so a vendor with one box already at the
 *  door floats up even if the rest is still in transit. */
const arrivalRank = (ind: any, vendorName: string, allocs: Alloc[]): number => {
  if (procurementReceived(ind, vendorName)) return 100;
  const STAGE_SCORE: Record<string, number> = { REACHED: 90, CUSTOMS: 60, IN_TRANSIT: 50 };
  const best = allocs.reduce((m, a) => Math.max(m, STAGE_SCORE[a.shipmentStage || ''] ?? 0), 0);
  if (best > 0) return best;
  return vendorOrderStatusOf(ind, vendorName) === 'IN_TRANSIT' ? 50 : 20;
};

/** A multi-vendor indent is receivable once procurement has marked at least one
 *  still-pending vendor's shipment RECEIVED — that's the handoff (procurement
 *  confirms arrival → inventory shelves). A vendor procurement hasn't marked
 *  received yet (still AWAITING_PAYMENT/PAID/ORDERED/IN_TRANSIT) is NOT shelvable
 *  — receiving it would book stock procurement never confirmed (or even paid for).
 *  A legacy (no-allocation) indent surfaces only once its whole status is RECEIVED. */
const isReceivable = (ind: any): boolean =>
  isMultiVendor(ind)
    ? [...groupPendingByVendor(ind).keys()].some(v => procurementReceived(ind, v))
    : ind.status === 'RECEIVED';

const fmtEta = (a: Alloc): string | null =>
  a.expectedDeliveryDate
    ? (a.expectedDeliveryHasTime ? fmtDateTime(a.expectedDeliveryDate) : fmtDate(a.expectedDeliveryDate))
    : null;

export const ReceiveIndentModal = ({ isOpen, onClose, onReceived, preselectIndentId = null }: Props) => {
  const { addToast } = useToast();
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [step, setStep] = useState<'select' | 'vendor' | 'map'>('select');
  // Lines that would land on an ARCHIVED item. The server asks first (409);
  // the clerk answers Unarchive and add / Create new (owner, 27 Oct).
  const [archivedAsk, setArchivedAsk] = useState<{ name: string; archived: { stock: number; unit: string; archivedAt: string | null } }[] | null>(null);
  const [receivableIndents, setReceivableIndents] = useState<any[]>([]);
  const [inventoryItems, setInventoryItems] = useState<any[]>([]);
  // Per-line item search. Each received line is matched to an inventory item
  // by hand, and with a plain <select> of the first N rows anything further
  // down the alphabet simply was not offered — the same failure the Request
  // picker had. Keyed by line index so two lines can search independently.
  const [itemSearch, setItemSearch] = useState<Record<number, string>>({});
  const [itemHits, setItemHits] = useState<Record<number, any[]>>({});
  const [departments, setDepartments] = useState<any[]>([]);
  const [selectedIndent, setSelectedIndent] = useState<any>(null);
  // Which vendor's shipment we're receiving. null = legacy all-or-nothing
  // (whole indent in one shot, no vendorName sent to the backend).
  const [selectedVendor, setSelectedVendor] = useState<string | null>(null);
  const [mappings, setMappings] = useState<any[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStep('select');
      setSelectedIndent(null);
      setSelectedVendor(null);
      setMappings([]);
      fetchData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // When the modal opens with a preselect id AND the indents have loaded,
  // jump straight to that indent (vendor-picker for a split, map form for a
  // legacy one). Separate effect so a notification arriving while the modal is
  // already open also resolves correctly.
  useEffect(() => {
    if (!isOpen || !preselectIndentId || receivableIndents.length === 0) return;
    const match = receivableIndents.find(i => i.id === preselectIndentId);
    if (match) {
      selectIndent(match);
    } else {
      addToast('That indent is no longer in the receive queue — pick another.', 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, preselectIndentId, receivableIndents]);

  const fetchData = async () => {
    setLoading(true);
    try {
      // Indents must be fresh (a shipment just arrived); inventory + departments
      // are slow-changing so they go through the shared TTL cache.
      const [indRes, invRes, deptRes] = await Promise.all([
        client.get(`/indents?status=${RECEIVABLE_STATUSES}&take=500`, { signal: abortSignal() }),
        // A SHORT list to start. This used to pull the whole scoped catalogue
        // on open — the matcher needs to reach every item, but it does that by
        // SEARCHING the server now, so downloading thousands of rows up front
        // only delayed the modal.
        cachedGet<any>(`/inventory/options?take=${PICKER_INITIAL_ITEMS}`),
        cachedGet<any>('/departments'),
      ]);
      const indRaw = indRes.data?.data;
      const indents = Array.isArray(indRaw) ? indRaw : (indRaw?.items || []);
      setReceivableIndents(indents.filter(isReceivable));
      const invRaw = invRes?.data ?? invRes;
      setInventoryItems(invRaw?.items || []);
      setDepartments(deptRes?.data || deptRes || []);
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to load data'), 'error'); }
    setLoading(false);
  };

  /** Debounced server search for one line's item picker. */
  const searchItemsFor = (idx: number, term: string) => {
    setItemSearch((m) => ({ ...m, [idx]: term }));
    const t = term.trim();
    if (!t) { setItemHits((m) => ({ ...m, [idx]: [] })); return; }
    window.clearTimeout((searchItemsFor as any)[`t${idx}`]);
    (searchItemsFor as any)[`t${idx}`] = window.setTimeout(async () => {
      try {
        const res = await client.get('/inventory/options', { params: { search: t }, signal: abortSignal() });
        const payload = res.data?.data ?? res.data;
        setItemHits((m) => ({ ...m, [idx]: payload?.items ?? [] }));
      } catch { /* keep the previous hits rather than blanking the list */ }
    }, 250);
  };

  const selectIndent = (indent: any) => {
    setSelectedIndent(indent);
    if (isMultiVendor(indent)) {
      // Split across vendors → pick which vendor's shipment arrived.
      setSelectedVendor(null);
      setStep('vendor');
    } else {
      // Legacy all-or-nothing → shelf the whole indent in one go.
      buildLegacyMappings(indent);
      setSelectedVendor(null);
      setStep('map');
    }
  };

  const buildLegacyMappings = (indent: any) => {
    const items = indent.items || [];
    setMappings(items.map((item: any) => ({
      indentItemId: item.id,
      name: item.name,
      qty: item.qty,
      unit: item.unit,
      mode: 'new' as 'new' | 'existing',
      inventoryItemId: '',
      category: 'ELECTRONIC_PASSIVE',
      departmentId: indent.departmentId || '',
      routeAs: 'INVENTORY' as 'INVENTORY' | 'ASSET',
    })));
  };

  const selectVendor = (vendorName: string) => {
    // Defensive: never proceed for a vendor procurement hasn't handed off, even
    // if a caller bypasses the disabled button (deep-link, future caller).
    if (!procurementReceived(selectedIndent, vendorName)) {
      addToast(`${vendorName}'s shipment hasn't been marked received by procurement yet.`, 'error');
      return;
    }
    const allocs = groupPendingByVendor(selectedIndent).get(vendorName) || [];
    const itemById = new Map<string, any>((selectedIndent.items || []).map((i: any) => [i.id, i]));
    // One row per distinct indent line this vendor supplies; qty defaults to the
    // sum of that vendor's allocated qty for the line (NOT the full line qty,
    // which may be split across vendors). Clerk can still override.
    const byItem = new Map<string, { qty: number; item: any }>();
    for (const a of allocs) {
      const entry = byItem.get(a.indentItemId) || { qty: 0, item: itemById.get(a.indentItemId) };
      entry.qty += Number(a.allocatedQty) || 0;
      byItem.set(a.indentItemId, entry);
    }
    const rows = [...byItem.entries()].map(([indentItemId, { qty, item }]) => ({
      indentItemId,
      name: item?.name || 'Item',
      qty,
      unit: item?.unit || 'PCS',
      mode: 'new' as 'new' | 'existing',
      inventoryItemId: '',
      category: 'ELECTRONIC_PASSIVE',
      departmentId: selectedIndent.departmentId || '',
      routeAs: 'INVENTORY' as 'INVENTORY' | 'ASSET',
    }));
    setSelectedVendor(vendorName);
    setMappings(rows);
    setStep('map');
  };

  const updateMapping = (idx: number, field: string, value: any) => {
    setMappings(prev => prev.map((m, i) => i === idx ? { ...m, [field]: value } : m));
  };

  const handleSubmit = async (archived?: 'unarchive' | 'new') => {
    setArchivedAsk(null);
    setIsSubmitting(true);
    try {
      const payload: any = {
        indentId: selectedIndent.id,
        items: mappings.map(m => {
          // Asset-routed lines skip the inventory-item mapping entirely — they
          // go to Associate Finance as an intake, keyed only by the line + qty.
          if (m.routeAs === 'ASSET') {
            return { indentItemId: m.indentItemId, name: m.name, qty: Number(m.qty), unit: m.unit, routeAs: 'ASSET' };
          }
          return {
            indentItemId: m.indentItemId,
            inventoryItemId: m.mode === 'existing' ? m.inventoryItemId : undefined,
            name: m.mode === 'new' ? m.name : undefined,
            qty: Number(m.qty),
            unit: m.unit,
            category: m.mode === 'new' ? m.category : undefined,
            departmentId: m.mode === 'new' ? m.departmentId : undefined,
            routeAs: 'INVENTORY',
          };
        }),
      };
      // Per-vendor receive: scope the backend to this vendor's pending lines so
      // the indent derives to PARTIALLY_RECEIVED (others still in transit) or
      // RECEIVED (last shipment). Omitted for legacy all-or-nothing indents.
      if (selectedVendor) payload.vendorName = selectedVendor;
      if (archived) payload.archived = archived;

      const res = await client.post('/inventory/receive-indent', payload);
      const data = res.data?.data || res.data || {};
      const count = data.receivedCount || 0;
      const assetCount = data.assetIntakeCount || 0;
      const partial = data.status === 'PARTIALLY_RECEIVED' || data.fullyReceived === false;
      const assetPart = assetCount ? ` ${assetCount} line(s) sent to Associate Finance as assets.` : '';
      addToast(
        partial
          ? `${count} item(s) shelved${selectedVendor ? ` from ${selectedVendor}` : ''} — indent partially received (other vendors still in transit).${assetPart}`
          : `${count} item(s) received into inventory — indent fully received.${assetPart}`,
        'success',
      );
      onReceived();
      onClose();
    } catch (e: any) {
      // Not a failure — a question about archived items. Nothing was booked.
      if (e?.details?.code === 'ARCHIVED_ON_RECEIVE' && e.details.data?.items?.length) {
        setArchivedAsk(e.details.data.items);
      } else {
        addToast(extractErrorMessage(e, 'Failed to receive items'), 'error');
      }
    }
    setIsSubmitting(false);
  };

  const backFromMap = () => setStep(selectedVendor ? 'vendor' : 'select');

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Receive from Procurement">
      <div className="max-h-[75vh] overflow-y-auto space-y-4 p-1">
        {loading ? (
          <div className="text-center py-8 text-muted">Loading...</div>
        ) : step === 'select' ? (
          <>
            <p className="text-sm text-muted">Select an indent whose shipment has arrived to add items into inventory stock.</p>
            {receivableIndents.length === 0 ? (
              <div className="text-center py-8 border-2 border-dashed border-line rounded-lg">
                <Package className="w-10 h-10 text-faint mx-auto mb-2" />
                <p className="text-sm text-faint">No indents awaiting receipt.</p>
                <p className="text-xs text-faint mt-1">Vendor shipments appear here once the indent is ordered (or marked Received for non-split orders).</p>
              </div>
            ) : (
              <div className="space-y-2">
                {receivableIndents.map((indent: any) => {
                  const pendingVendors = groupPendingByVendor(indent);
                  const done = receivedVendors(indent);
                  return (
                    <button
                      key={indent.id}
                      onClick={() => selectIndent(indent)}
                      className="w-full text-left p-4 rounded-lg border border-line hover:border-brand hover:bg-brand/5 transition-colors"
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-bold text-ink">{indent.serialNo}</p>
                          <p className="text-xs text-muted mt-0.5">{indent.department?.name} · {indent.items?.length || 0} item(s) · ₹{indent.grandTotal?.toLocaleString()}</p>
                          {isMultiVendor(indent) ? (
                            <p className="text-[11px] font-bold text-brand mt-1 flex items-center gap-1">
                              <Truck size={12} />
                              {pendingVendors.size} vendor shipment{pendingVendors.size === 1 ? '' : 's'} pending
                              {done.length > 0 && <span className="text-emerald-700 dark:text-emerald-300 font-normal"> · {done.length} received</span>}
                            </p>
                          ) : (
                            <p className="text-[10px] text-faint mt-0.5">By {indent.createdBy?.name} · {fmtDateTime(indent.createdAt)}</p>
                          )}
                        </div>
                        <ArrowRight size={16} className="text-brand" />
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        ) : step === 'vendor' ? (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-ink">Which shipment arrived? — {selectedIndent?.serialNo}</p>
                <p className="text-xs text-muted">{selectedIndent?.department?.name} · split across vendors — receive each as it lands</p>
              </div>
              <button onClick={() => setStep('select')} className="text-xs text-brand font-bold hover:underline">Back</button>
            </div>

            <div className="space-y-2">
              {[...groupPendingByVendor(selectedIndent).entries()]
                .sort((a, b) => arrivalRank(selectedIndent, b[0], b[1]) - arrivalRank(selectedIndent, a[0], a[1]))
                .map(([vendorName, allocs]) => {
                const eta = fmtEta(allocs[0]);
                // Show the least-advanced pending line's stage — the laggard
                // tells the clerk how much of this vendor's box is still moving.
                const STAGE_RANK: Record<string, number> = { IN_TRANSIT: 1, CUSTOMS: 2, REACHED: 3 };
                const stage = allocs.map(a => a.shipmentStage).filter(Boolean).sort((x, y) => STAGE_RANK[x!] - STAGE_RANK[y!])[0] || null;
                const procReceived = procurementReceived(selectedIndent, vendorName);
                // Inventory can only shelf a vendor procurement has explicitly
                // handed off (VendorOrder → RECEIVED). Until then the box isn't
                // cleared — show it greyed-out with the reason instead of letting
                // the clerk book stock procurement never confirmed.
                return (
                  <button
                    key={vendorName}
                    onClick={() => procReceived && selectVendor(vendorName)}
                    disabled={!procReceived}
                    title={procReceived ? undefined : 'Procurement hasn’t marked this vendor’s shipment received yet — they confirm arrival before inventory can shelf it.'}
                    className={`w-full text-left p-4 rounded-lg border transition-colors ${procReceived ? 'border-emerald-200 dark:border-emerald-400/30 bg-emerald-50/40 dark:bg-emerald-400/15 hover:border-brand hover:bg-brand/5 cursor-pointer' : 'border-line bg-surface/60 opacity-70 cursor-not-allowed'}`}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-bold text-ink flex items-center gap-1.5"><Truck size={14} className="text-brand" />{vendorName}</p>
                        <p className="text-xs text-muted mt-0.5">{allocs.length} line item{allocs.length === 1 ? '' : 's'}</p>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          {procReceived ? (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1"><CheckCircle2 size={11} /> Procurement marked received</span>
                          ) : (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 inline-flex items-center gap-1"><Clock size={11} /> Awaiting procurement</span>
                          )}
                          {stage && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-400/15 text-sky-700 dark:text-sky-300">{STAGE_LABEL[stage] || stage}</span>
                          )}
                          {eta && <span className="text-[10px] text-faint">ETA {eta}</span>}
                        </div>
                      </div>
                      <ArrowRight size={16} className={procReceived ? 'text-brand' : 'text-faint'} />
                    </div>
                  </button>
                );
              })}
            </div>

            {receivedVendors(selectedIndent).length > 0 && (
              <div className="text-[11px] text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5 pt-1">
                <CheckCircle2 size={13} />
                Already received: {receivedVendors(selectedIndent).join(', ')}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold text-ink">
                  Receiving: {selectedIndent?.serialNo}
                  {selectedVendor && <span className="text-brand"> · {selectedVendor}</span>}
                </p>
                <p className="text-xs text-muted">{selectedIndent?.department?.name} · {mappings.length} item(s)</p>
              </div>
              <button onClick={backFromMap} className="text-xs text-brand font-bold hover:underline">Back</button>
            </div>

            <div className="space-y-4">
              {mappings.map((m, idx) => (
                <div key={idx} className="border border-line rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-bold text-ink">{m.name}</p>
                    <span className="text-xs text-muted">{m.qty} {m.unit}</span>
                  </div>

                  {/* Destination toggle — shelve as inventory stock, or route to
                      Associate Finance to be registered as a fixed asset. */}
                  <div className="flex gap-2">
                    <button
                      onClick={() => updateMapping(idx, 'routeAs', 'INVENTORY')}
                      className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-colors ${
                        m.routeAs !== 'ASSET' ? 'border-green-600 bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300' : 'border-line text-muted'
                      }`}
                    >
                      <Package size={12} className="inline mr-1" />For Inventory
                    </button>
                    {/* Routes the line to Finance as an AssetIntake instead of
                        shelving it as stock. Re-enabled once /asset-intakes and
                        the AssetIntake table existed — before that this toggle
                        made every receive fail, since the backend had no
                        `routeAs` field at all. */}
                    <button
                      onClick={() => updateMapping(idx, 'routeAs', 'ASSET')}
                      className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-colors ${
                        m.routeAs === 'ASSET' ? 'border-violet-600 bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300' : 'border-line text-muted'
                      }`}
                    >
                      <ArrowRight size={12} className="inline mr-1" />For Asset
                    </button>
                  </div>

                  {m.routeAs === 'ASSET' ? (
                    <p className="text-[11px] text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-400/15 border border-violet-100 dark:border-violet-400/25 rounded-lg px-3 py-2">
                      Sent to Associate Finance to register as {Number(m.qty) === 1 ? 'an asset' : `${Number(m.qty)} assets`}. Not added to inventory stock.
                    </p>
                  ) : (
                    <>
                      {/* Mode toggle */}
                      <div className="flex gap-2">
                        <button
                          onClick={() => updateMapping(idx, 'mode', 'existing')}
                          className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-colors ${
                            m.mode === 'existing' ? 'border-brand bg-brand/10 text-brand' : 'border-line text-muted'
                          }`}
                        >
                          Add to Existing Item
                        </button>
                        <button
                          onClick={() => updateMapping(idx, 'mode', 'new')}
                          className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-colors ${
                            m.mode === 'new' ? 'border-brand bg-brand/10 text-brand' : 'border-line text-muted'
                          }`}
                        >
                          <Plus size={12} className="inline mr-1" />Create New Item
                        </button>
                      </div>

                      {m.mode === 'existing' ? (
                        <>
                          <input
                            type="text"
                            value={itemSearch[idx] ?? ''}
                            onChange={(e) => searchItemsFor(idx, e.target.value)}
                            placeholder="Search all items by name…"
                            className="w-full mb-1.5 px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none"
                          />
                          <select
                            value={m.inventoryItemId}
                            onChange={(e) => updateMapping(idx, 'inventoryItemId', e.target.value)}
                            className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none"
                          >
                            <option value="">-- Select inventory item --</option>
                            {((itemSearch[idx] ?? '').trim() ? (itemHits[idx] ?? []) : inventoryItems).map((item: any) => (
                              <option key={item.id} value={item.id}>{item.name} (Stock: {item.stock} {item.unit})</option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="text"
                            value={m.name}
                            onChange={(e) => updateMapping(idx, 'name', e.target.value)}
                            placeholder="Item name"
                            className="px-3 py-2 border border-line rounded-lg text-sm focus:border-brand outline-none"
                          />
                          {/* Not a choice: the server always shelves into the indent's own
                              department (so stock can't be routed elsewhere), and a
                              picker here was silently ignored. Shown so the clerk
                              knows where it will land. */}
                          <div
                            className="px-3 py-2 border border-line rounded-lg text-sm bg-surface text-muted truncate"
                            title="New items are added to the indent's department."
                          >
                            {departments.find((d: any) => d.id === m.departmentId)?.name || 'Indent\'s department'}
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* Quantity override */}
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-muted font-bold">Qty received:</label>
                    <NumberInput
                      min={0}
                      value={Number(m.qty) || 0}
                      onChange={(v) => updateMapping(idx, 'qty', v)}
                      className="w-24 px-3 py-1.5 border border-line rounded-lg text-sm focus:border-brand outline-none"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-line-soft">
              <button onClick={onClose} className="px-4 py-2 text-muted font-bold rounded-md hover:bg-hover">Cancel</button>
              <button
                onClick={() => handleSubmit()}
                disabled={isSubmitting}
                className="flex items-center gap-2 px-5 py-2 bg-green-700 text-white font-bold rounded-md hover:bg-green-800 transition-colors disabled:opacity-50"
              >
                <Check size={16} />
                {isSubmitting ? 'Receiving...' : `Receive ${mappings.length} Item(s)`}
              </button>
            </div>
          </>
        )}
      </div>
      <Modal isOpen={!!archivedAsk} onClose={() => setArchivedAsk(null)} title={archivedAsk && archivedAsk.length === 1 ? `"${archivedAsk[0].name}" is archived` : 'Archived items in this delivery'}>
        <div className="space-y-4">
          <p className="text-sm text-secondary">
            {archivedAsk && archivedAsk.length === 1 ? 'This item was archived.' : 'These items were archived.'} Unarchiving brings
            {archivedAsk && archivedAsk.length === 1 ? ' it' : ' them'} back with history, location and projects, and adds this delivery — so the list keeps one row per part.
          </p>
          <ul className="space-y-1">
            {(archivedAsk ?? []).map((a, i) => (
              <li key={i} className="text-sm">
                <span className="font-bold text-ink">{a.name}</span>
                <span className="text-muted"> — archived {a.archived.archivedAt ? fmtDate(a.archived.archivedAt) : 'earlier'} with {a.archived.stock} {a.archived.unit}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col sm:flex-row sm:justify-end gap-2 pt-2 border-t border-line-soft">
            <button onClick={() => setArchivedAsk(null)} className="px-4 py-2 text-sm font-bold text-muted hover:bg-surface rounded">Cancel</button>
            <button onClick={() => handleSubmit('new')} disabled={isSubmitting}
              className="px-4 py-2 text-sm font-bold border border-line text-ink rounded-full hover:bg-surface disabled:opacity-50 whitespace-nowrap">
              Create new
            </button>
            <button onClick={() => handleSubmit('unarchive')} disabled={isSubmitting}
              className="px-5 py-2 text-sm font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50 whitespace-nowrap">
              Unarchive and add
            </button>
          </div>
        </div>
      </Modal>
    </Modal>
  );
};
