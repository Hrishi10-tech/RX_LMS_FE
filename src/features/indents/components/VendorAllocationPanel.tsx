import { useState } from 'react';
import { NumberInput } from '@/components/ui';
import { HelpCircle } from 'lucide-react';
import { toInr, ALLOWED_CURRENCIES, rollupTotals, rollupWithVendorGst, ceoThresholdMoney, ceoGateCoversEverything } from '@/config/thresholds';
import { useFxMeta } from '@/lib/fx';
import { findSimilarVendor, type KnownVendor } from '@/features/vendors';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

interface Allocation {
  indentItemId: string;
  vendorName: string;
  allocatedQty: number;
  unitPrice?: number;
  /** Per-vendor quote currency. A single item can mix vendors in different
   *  currencies (Amazon India INR, Alibaba USD); the line total then rolls
   *  up to INR. Defaults to INR. */
  currency?: string;
  /** Per-vendor unit of measure. Defaults from the indent item's unit but is
   *  editable per row (a vendor may quote in a different pack size). Null/blank
   *  on legacy rows → UI falls back to the indent item's unit. */
  unit?: string;
  /** Per-vendor GST rate (%). Same on every row of one (vendor, currency) — the
   *  GST section edits it once per vendor via onSetVendorGst. */
  gstPercentage?: number | null;
  /** Per-vendor shipping — same on every row of one (vendor, currency), set once
   *  per vendor via onSetVendorShipping. Added after GST, never taxed. */
  shippingCost?: number | null;
  /** Alternative vendor OPTION (admin chooses at approval) vs the committed
   *  suggested split. Excluded from qty/total/GST until the admin picks it. */
  isAlternative?: boolean;
  /** Quote-time ETA estimate for this vendor option (ISO date string). */
  quotedEtaDate?: string | null;
  quotedEtaHasTime?: boolean;
  /** Per-vendor product URL — the admin can click it on the approval slip to
   *  inspect the actual product. Optional; http(s) only. */
  url?: string | null;
  /** Free-text note for this vendor line, shown to the admin at approval. */
  notes?: string | null;
  _isNew?: boolean;
}

/**
 * The vendor name box: suggestions, a nudge when the name looks like a typo of
 * one already in use, and a one-click way to add a genuinely new vendor to the
 * Vendor Code List.
 *
 * The nudge WARNS, never blocks. Real vendors have genuinely similar names
 * (Robu and Robu.in), so a hard stop would be wrong often enough to be worked
 * around, and a control people learn to defeat is worse than none. It also
 * stays silent when the only difference is capitalisation — "amazon" and
 * "Amazon" are one vendor, and asking about them would be the noise that
 * teaches people to dismiss the box without reading it.
 */
const VendorNameNotice = ({
  value,
  onChange,
  knownVendors,
  onSaveToList,
}: {
  value: string;
  onChange: (v: string) => void;
  knownVendors: KnownVendor[];
  onSaveToList?: (name: string) => Promise<void>;
}) => {
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const { addToast } = useToast();
  const typed = (value || '').trim();
  const similar = typed ? findSimilarVendor(typed, knownVendors) : null;
  const showSimilar = similar && dismissed !== similar;
  // Only offer to curate a name substantial enough to be worth a row, and not
  // already known under any capitalisation.
  const isNew =
    typed.length >= 2 &&
    !knownVendors.some((k) => k.name.trim().toLowerCase() === typed.toLowerCase());

  if (showSimilar) {
    return (
      <div className="flex items-center gap-2 pl-1 pt-0.5 text-[10px] text-brand-700">
        <span>
          Similar to <span className="font-bold">{similar}</span> — did you mean that?
        </span>
        <button type="button" onClick={() => onChange(similar!)}
          className="font-bold text-brand hover:underline">Use it</button>
        <button type="button" onClick={() => setDismissed(similar!)}
          className="text-faint hover:underline">No, it's different</button>
      </div>
    );
  }
  if (isNew && onSaveToList) {
    return (
      <div className="pl-1 pt-0.5">
        <button
          type="button"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            // A refused save (duplicate, no permission, offline) used to just
            // re-enable the button with no word of why.
            try { await onSaveToList(typed); }
            catch (e) { addToast(extractErrorMessage(e, 'Could not add it to the vendor code list'), 'error'); }
            finally { setSaving(false); }
          }}
          className="text-[10px] font-bold text-brand hover:underline disabled:opacity-50"
          title="Add this vendor to the Vendor Code List so it is suggested next time"
        >{saving ? 'Adding…' : `+ Add "${typed}" to the vendor code list`}</button>
      </div>
    );
  }
  return null;
};

interface VendorAllocationPanelProps {
  selectedIndent: any;
  indentItems: any[];
  allocations: Allocation[];
  /**
   * Every vendor name in use, for suggestions and near-miss detection.
   *
   * Replaces the old `vendorCodes` prop: the server already merges the Vendor
   * Code List into this, so passing both would be two sources for one list —
   * and it was the narrower of the two that the suggestions were reading.
   */
  knownVendors: KnownVendor[];
  /** Promote a typed name into the Vendor Code List. */
  onSaveVendorToList?: (name: string) => Promise<void>;
  /** Add a vendor row to an item. The name is per-item (the panel owns the
   *  draft input state locally), so typing in one item's + Add box no longer
   *  bleeds into every other item's box. */
  onAddAllocationRow: (itemId: string, vendorName: string) => void;
  onUpdateAllocation: (idx: number, field: string, value: any) => void;
  /** Set the GST rate for a whole vendor (name + currency) at once. */
  onSetVendorGst?: (vendorName: string, currency: string, gstPercentage: number | null) => void;
  /** Set the shipping for a whole vendor (name + currency) at once. */
  onSetVendorShipping?: (vendorName: string, currency: string, shippingCost: number | null) => void;
  onRemoveAllocation: (idx: number) => void;
  onSaveAllocations: () => void;
}

export const VendorAllocationPanel = ({
  selectedIndent,
  indentItems,
  allocations,
  knownVendors,
  onSaveVendorToList,
  onAddAllocationRow,
  onUpdateAllocation,
  onSetVendorGst,
  onSetVendorShipping,
  onRemoveAllocation,
  onSaveAllocations,
}: VendorAllocationPanelProps) => {
  const fx = useFxMeta();
  // Today (local) as yyyy-mm-dd — the min selectable ETA. A quoted delivery
  // date in the past is nonsensical (would read as instantly overdue); the
  // server enforces this too.
  const todayISO = new Date().toLocaleDateString('en-CA');
  // Per-item "+ Add vendor" draft text, keyed by item id. Local to the panel so
  // typing in one item's box never mirrors into every other item's box (the old
  // single shared newVendorName bug).
  const [vendorDrafts, setVendorDrafts] = useState<Record<string, string>>({});
  const addVendor = (itemId: string) => {
    const name = (vendorDrafts[itemId] || '').trim();
    if (!name) return;
    onAddAllocationRow(itemId, name);
    setVendorDrafts((d) => { const n = { ...d }; delete n[itemId]; return n; });
  };
  if (!selectedIndent) return null;
  // Edit affordances (qty/price inputs, Add row, Save button) are only enabled
  // while procurement actually owns the indent. Once it's bounced back for
  // re-approval (PENDING) or beyond payment (AWAITING_PAYMENT+), the panel
  // renders read-only so the work isn't hidden from the admin reviewing the
  // re-approval. Empty + non-editable = hide entirely.
  const canEdit = ['APPROVED', 'QUOTATION_IN_PROGRESS'].includes(selectedIndent.status);
  const hasAnyAllocs = allocations && allocations.length > 0;
  if (!canEdit && !hasAnyAllocs) return null;

  // Per-vendor GST. GST is charged per vendor invoice, so it's entered ONCE per
  // vendor (name + currency = one order) and applied to that vendor's subtotal
  // (Σ its allocation line totals). Mirrors the backend exactly, so this live
  // preview matches what saveAllocations/finalise will persist.
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const toGstLine = (a: any) => ({
    vendorName: String(a.vendorName).trim(),
    total: (Number(a.allocatedQty) || 0) * (Number(a.unitPrice) || 0),
    currency: a.currency,
    gstPercentage: a.gstPercentage,
    shippingCost: a.shippingCost,
  });
  const named = (allocations || []).filter((a: any) => String(a.vendorName || '').trim());
  // Footer roll-up = COMMITTED rows only. This is what drives the indent total
  // and the ₹20k CEO gate, so alternatives (options the admin hasn't picked)
  // must never inflate it.
  const gst = rollupWithVendorGst(named.filter((a: any) => !a.isAlternative).map(toGstLine));
  // GST rows = COMMITTED vendors only. An option isn't bought, so no GST is due
  // on it — its price must never inflate a vendor's GST subtotal. (A vendor with
  // both a committed line and an option line shows GST on the committed part
  // alone.) Options only enter GST once the admin picks them at approval.
  const vendorGroups = gst.groups;
  // Vendors quoted ONLY as an option still need their GST and shipping typed in
  // now. If the admin picks one at review, the backend totals it from the rate
  // and shipping stored on that row — and procurement can no longer edit by
  // then, so a vendor left out here was bought at 0% and ₹0 shipping, and the
  // CEO check ran on the smaller figure. Listed separately and never summed
  // into the footer, which stays committed-only.
  const committedKeys = new Set(vendorGroups.map((g) => g.key));
  const optionGroups = rollupWithVendorGst(
    named.filter((a: any) => a.isAlternative && !a.isDiscarded).map(toGstLine),
  ).groups.filter((g) => !committedKeys.has(g.key));
  const money = (n: number, cur: string) => `${cur} ${Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  return (
    <div className="border-t border-line pt-4">
      <div className="flex justify-between items-center mb-3">
        <div className="flex items-center gap-1.5">
          <h4 className="font-bold text-ink">Vendor Allocation{!canEdit && <span className="ml-2 text-[10px] font-normal text-muted uppercase tracking-wider">read-only · {selectedIndent.status.replace(/_/g, ' ').toLowerCase()}</span>}</h4>
          {/* Help text used to be a paragraph below the title which felt heavy.
              Tucked it behind a hoverable (?) icon — visible only when needed. */}
          <span
            tabIndex={0}
            className="text-faint hover:text-muted cursor-help"
            title="For each item, type a vendor name and click + Add (or press Enter). Then fill in the quantity and unit price per vendor. The total allocated should match the requested quantity — if it's less, you'll be asked for a reason when finalising and the requester will be notified.">
            <HelpCircle size={14} />
          </span>
          {/* FX provenance — mixed/foreign currencies roll up to INR using these
              rates, so surface whether they're live or the static fallback. */}
          <span
            className="ml-1 text-[10px] text-faint"
            title={fx.source === 'live'
              ? `Currency conversions use live FX rates${fx.providerTimestamp ? ` as of ${new Date(fx.providerTimestamp).toLocaleString()}` : ''}. Auto-refreshed daily.`
              : 'Live FX feed unavailable — using built-in reference rates as a fallback.'}>
            {fx.source === 'live'
              ? `FX live${fx.lastUpdated ? ` · ${new Date(fx.lastUpdated).toLocaleDateString()}` : ''}`
              : 'FX reference rates'}
          </span>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <button onClick={onSaveAllocations} className="px-3 py-1.5 text-xs font-bold bg-brand text-white rounded-full hover:bg-brand-dark transition-colors">Save Allocations</button>
          </div>
        )}
      </div>

      {indentItems.map((item: any) => {
        const itemAllocs = allocations.filter((a: any) => a.indentItemId === item.id);
        // Only COMMITTED rows count toward the requested qty — alternatives are
        // options the admin may pick later, so they never trigger over/short.
        const committedAllocs = itemAllocs.filter((a: any) => !a.isAlternative);
        const hasOptions = itemAllocs.length > 1; // multiple vendors quoted → admin will choose
        const totalAllocated = committedAllocs.reduce((s: number, a: any) => s + Number(a.allocatedQty || 0), 0);
        const remaining = Number(item.qty) - totalAllocated;
        const overAllocated = remaining < 0;
        const fullyAllocated = remaining === 0;

        // The indent line's total now FOLLOWS the vendor allocations (the
        // firm vendor quote is the source of truth). On Save Allocations the
        // backend re-syncs the indent item's unitAmount + total to match the
        // allocation rollup. We just show the running allocation total here
        // so procurement can see what the indent total will be set to.
        const currentItemTotal = Number(item.qty) * Number(item.unitAmount);
        // The item's firm total rolls up its vendor rows by EACH row's own
        // currency: uniform → native sum; mixed → INR. So one item can mix an
        // INR vendor and a USD vendor and still show a coherent line total.
        const itemRoll = rollupTotals(
          committedAllocs.map((a: any) => ({ total: Number(a.allocatedQty || 0) * Number(a.unitPrice || 0), currency: a.currency })),
        );
        const allocatedTotal = itemRoll.grandTotal;
        const allocCurrency = itemRoll.currency;
        const allocMixed = new Set(committedAllocs.map((a: any) => (a.currency || 'INR').toUpperCase().trim())).size > 1;
        const totalDelta = +(allocatedTotal - currentItemTotal).toFixed(2);
        // "Unchanged" only makes sense when both totals are in the same currency;
        // a mixed firm total (INR) isn't comparable to the item's native total.
        const totalUnchanged = Math.abs(totalDelta) < 0.005 && !allocMixed;
        const itemCurrency = item.currency || 'INR';
        const fmtItem = (n: number) => `${itemCurrency} ${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
        const fmtAlloc = (n: number) => `${allocCurrency} ${Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
        // Uniform-foreign firm total → show the INR equivalent. A mixed total is
        // already in INR, so just flag that it was converted.
        const isForeign = !allocMixed && allocCurrency.toUpperCase().trim() !== 'INR';
        const inrHint = isForeign
          ? ` (≈ ₹${Math.round(toInr(Math.abs(allocatedTotal), allocCurrency)).toLocaleString('en-IN')})`
          : allocMixed
            ? ' (mixed → INR)'
            : '';

        // Soft status — never blocks save/finalise, just signals to the user.
        // Under: amber (will trigger reason prompt on finalise).
        // Over:  amber (procurement bought more than requested — allowed, just flagged).
        // Equal: emerald check.
        const qtyBadge = fullyAllocated
          ? { text: 'Qty ✓', cls: 'text-emerald-700 dark:text-emerald-300', tooltip: 'Allocations match the requested quantity exactly.' }
          : overAllocated
            ? { text: `Qty over by ${-remaining} ${item.unit || ''} ⚠`, cls: 'text-amber-700 dark:text-amber-300', tooltip: `Allocations exceed the requested quantity by ${-remaining} ${item.unit || 'unit(s)'}. Procurement chose to buy more than requested — allowed.` }
            : { text: `Qty short by ${remaining} ${item.unit || ''} ✗`, cls: 'text-amber-700 dark:text-amber-300', tooltip: `${remaining} ${item.unit || 'unit(s)'} not yet allocated. You can still finalise — you'll be asked for a reason and the requester will be notified.` };
        const priceBadge = allocatedTotal === 0
          ? { text: 'Total —', cls: 'text-faint', tooltip: 'Add allocations + unit prices to set the firm quote.' }
          : totalUnchanged
            ? { text: `Total ${fmtAlloc(allocatedTotal)}${inrHint} ✓`, cls: 'text-emerald-700 dark:text-emerald-300', tooltip: 'Allocations already match the indent line — no change on save.' }
            : { text: `Total ${fmtAlloc(allocatedTotal)}${inrHint}`, cls: 'text-amber-700 dark:text-amber-300', tooltip: `On save, this item's unit price + total are updated to reflect the vendor quote: ${fmtItem(currentItemTotal)} → ${fmtAlloc(allocatedTotal)}. The vendor quote is the firm price — the indent line follows it.` };
        return (
          <div key={item.id} className="mb-3 p-3 bg-surface rounded-lg border border-line-soft">
            <div className="flex justify-between items-start mb-2 gap-3">
              <div className="min-w-0 flex-1">
                <span className="text-sm font-bold text-ink">{item.name}</span>
                {hasOptions && (
                  <span className="ml-2 text-[9px] font-bold text-brand-dark uppercase tracking-wider"
                    title="More than one vendor quoted for this item. The admin will pick the vendor(s) + split the quantity at approval.">
                    {itemAllocs.length} options
                  </span>
                )}
                <span className="block text-xs text-faint mt-0.5">
                  Qty: {item.qty} {item.unit} · {itemCurrency} {Number(item.unitAmount).toLocaleString()}/unit · Total {fmtItem(currentItemTotal)}
                </span>
              </div>
              <div className="flex flex-col items-end gap-0.5 shrink-0">
                <span title={qtyBadge.tooltip} className={`text-xs font-bold cursor-help whitespace-nowrap ${qtyBadge.cls}`}>
                  {qtyBadge.text}
                </span>
                <span title={priceBadge.tooltip} className={`text-[11px] font-bold cursor-help whitespace-nowrap ${priceBadge.cls}`}>
                  {priceBadge.text}
                </span>
              </div>
            </div>
            {/* Column headers — without these the qty / unit-price inputs were
                ambiguous and people kept typing the price into the qty field
                and vice versa. */}
            {itemAllocs.length > 0 && (
              <div className="flex items-center gap-2 mb-1 px-0.5">
                <span className="flex-1 text-[10px] font-bold uppercase tracking-wider text-muted">Vendor</span>
                <span className="w-20 text-[10px] font-bold uppercase tracking-wider text-muted text-center">Quantity</span>
                <span className="w-16 text-[10px] font-bold uppercase tracking-wider text-muted text-center">Unit</span>
                <span className="w-20 text-[10px] font-bold uppercase tracking-wider text-muted text-center">Unit Price</span>
                <span className="w-16 text-[10px] font-bold uppercase tracking-wider text-muted text-center">Currency</span>
                <span className="w-32 text-[10px] font-bold uppercase tracking-wider text-muted text-center">ETA</span>
                <span className="w-40 text-[10px] font-bold uppercase tracking-wider text-muted text-center" title="Product link for this vendor — the approving admin can click it to inspect the item.">URL</span>
                <span className="w-40 text-[10px] font-bold uppercase tracking-wider text-muted text-center" title="Free-text note for this vendor line — shown to the admin at approval.">Notes</span>
                <span className="w-14 text-[10px] font-bold uppercase tracking-wider text-muted text-center" title="Mark this vendor as an alternative option for the admin to choose from (not part of the suggested split).">Option</span>
                <span className="w-3"></span>
              </div>
            )}
            {itemAllocs.map((alloc: any, aIdx: number) => {
              const realIdx = allocations.indexOf(alloc);
              if (!canEdit) {
                // Read-only render — plain spans, no controls, no remove button.
                return (
                  <div key={aIdx} className="flex items-center gap-2 mb-1 text-xs text-ink">
                    <span className="flex-1 truncate px-2 py-1">{alloc.vendorName || '—'}{alloc.isAlternative && <span className="ml-1 text-[9px] font-bold text-brand-dark uppercase">alt</span>}</span>
                    <span className="w-20 px-2 py-1 text-center font-mono">{Number(alloc.allocatedQty).toLocaleString()}</span>
                    <span className="w-16 px-2 py-1 text-center text-faint">{alloc.unit || item.unit || '—'}</span>
                    <span className="w-20 px-2 py-1 text-center font-mono">{Number(alloc.unitPrice || 0).toLocaleString()}</span>
                    <span className="w-16 px-2 py-1 text-center font-bold">{(alloc.currency || 'INR').toUpperCase()}</span>
                    <span className="w-32 px-2 py-1 text-center text-muted">{alloc.quotedEtaDate ? new Date(alloc.quotedEtaDate).toLocaleDateString() : '—'}</span>
                    <span className="w-40 px-2 py-1 text-center truncate">
                      {alloc.url && /^https?:\/\//i.test(alloc.url)
                        ? <a href={alloc.url} target="_blank" rel="noopener noreferrer" className="text-brand-dark hover:text-ink underline" title={alloc.url}>↗ link</a>
                        : <span className="text-faint">—</span>}
                    </span>
                    <span className="w-40 px-2 py-1 text-center truncate text-muted" title={alloc.notes || ''}>{alloc.notes || <span className="text-faint">—</span>}</span>
                    <span className="w-14 px-2 py-1 text-center">{alloc.isAlternative ? '○' : '✓'}</span>
                    <span className="w-3"></span>
                  </div>
                );
              }
              return (
                <div key={aIdx} className="mb-1">
                 <div className="flex items-center gap-2">
                  <input type="text" value={alloc.vendorName}
                    onChange={e => onUpdateAllocation(realIdx, 'vendorName', e.target.value)}
                    list="vendor-suggestions" placeholder="Vendor"
                    className="flex-1 min-w-0 px-2 py-1 border rounded text-xs focus:border-brand outline-none" />
                  <NumberInput min={0} value={alloc.allocatedQty} onChange={(v) => onUpdateAllocation(realIdx, 'allocatedQty', v)}
                    className="w-20 px-2 py-1 border rounded text-xs focus:border-brand outline-none" />
                  <input
                    type="text"
                    value={alloc.unit ?? item.unit ?? ''}
                    onChange={(e) => onUpdateAllocation(realIdx, 'unit', e.target.value)}
                    placeholder={item.unit || 'Unit'}
                    className="w-16 px-2 py-1 border rounded text-xs text-center focus:border-brand outline-none"
                    title="Unit this vendor quotes in. Defaults to the indent item's unit — edit if this vendor sells in a different pack size." />
                  <NumberInput min={0} step={0.01} value={Number(alloc.unitPrice) || 0} onChange={(v) => onUpdateAllocation(realIdx, 'unitPrice', v)}
                    placeholder="Price" className="w-20 px-2 py-1 border rounded text-xs focus:border-brand outline-none" />
                  <select
                    value={ALLOWED_CURRENCIES.includes((alloc.currency || 'INR').toUpperCase().trim()) ? (alloc.currency || 'INR').toUpperCase().trim() : 'INR'}
                    onChange={(e) => onUpdateAllocation(realIdx, 'currency', e.target.value)}
                    className="w-16 px-1 py-1 border rounded text-xs font-bold bg-card focus:border-brand outline-none cursor-pointer"
                    title="Currency this vendor quotes in. Mixing currencies on one item totals the line in INR.">
                    {ALLOWED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <input
                    type="date"
                    min={todayISO}
                    value={alloc.quotedEtaDate ? String(alloc.quotedEtaDate).slice(0, 10) : ''}
                    onChange={(e) => { onUpdateAllocation(realIdx, 'quotedEtaDate', e.target.value || null); onUpdateAllocation(realIdx, 'quotedEtaHasTime', false); }}
                    className="w-32 px-2 py-1 border rounded text-xs focus:border-brand outline-none"
                    title="Estimated delivery date this vendor quotes — can't be before today. A factor the admin weighs when choosing between vendors." />
                  <div className="w-40 flex items-center gap-1">
                    <input
                      type="url"
                      value={alloc.url || ''}
                      onChange={(e) => onUpdateAllocation(realIdx, 'url', e.target.value)}
                      placeholder="https://…"
                      className="flex-1 min-w-0 px-2 py-1 border rounded text-xs focus:border-brand outline-none"
                      title="Product link for this vendor. The approving admin can click it to inspect the item instead of judging on vendor name alone." />
                    {alloc.url && /^https?:\/\//i.test(alloc.url) && (
                      <a href={alloc.url} target="_blank" rel="noopener noreferrer" className="text-brand-dark hover:text-ink shrink-0" title="Open link">↗</a>
                    )}
                  </div>
                  <input
                    type="text"
                    value={alloc.notes || ''}
                    onChange={(e) => onUpdateAllocation(realIdx, 'notes', e.target.value)}
                    placeholder="Note…"
                    maxLength={500}
                    className="w-40 px-2 py-1 border rounded text-xs focus:border-brand outline-none"
                    title="Free-text note for this vendor line (e.g. bulk discount, lead-time caveat). Shown to the admin at approval." />
                  <label className="w-14 flex items-center justify-center cursor-pointer" title="Mark as an alternative OPTION (not part of your suggested split). The admin picks between options + splits the qty at approval.">
                    <input
                      type="checkbox"
                      checked={alloc.isAlternative === true}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        onUpdateAllocation(realIdx, 'isAlternative', checked);
                        // An option is a candidate to supply the whole line, so
                        // give it the full line qty by default (it's excluded
                        // from the committed split anyway). Without this a row
                        // toggled to Option keeps qty 0 and fails save.
                        if (checked && (Number(alloc.allocatedQty) || 0) < 1) {
                          onUpdateAllocation(realIdx, 'allocatedQty', item.qty);
                        }
                      }}
                      className="accent-brand cursor-pointer" />
                  </label>
                  <button onClick={() => onRemoveAllocation(realIdx)} className="text-red-400 hover:text-red-700 dark:text-red-300 text-xs w-3">x</button>
                 </div>
                 {/* Its own full-width line rather than inside the vendor
                     column: squeezed into one cell of a nine-field row it
                     wrapped onto three lines and read as clutter, which is how
                     a warning gets ignored. */}
                 <VendorNameNotice
                   value={alloc.vendorName}
                   onChange={(v) => onUpdateAllocation(realIdx, 'vendorName', v)}
                   knownVendors={knownVendors}
                   onSaveToList={onSaveVendorToList}
                 />
                </div>
              );
            })}
            {/* The "+ Add" row stays visible even when fully allocated so
                procurement can split a vendor row or add a second source
                (over-allocate) without dancing around the UI. Hidden entirely
                in read-only mode (re-approval or post-payment). */}
            {canEdit && (
              <div className="flex items-center gap-2 mt-1">
                <input
                  type="text"
                  value={vendorDrafts[item.id] ?? ''}
                  onChange={e => setVendorDrafts(d => ({ ...d, [item.id]: e.target.value }))}
                  list="vendor-suggestions"
                  placeholder="Type vendor name + press Enter (or click + Add)"
                  className="flex-1 px-2 py-1 border border-dashed border-line rounded text-xs focus:border-brand outline-none"
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addVendor(item.id); } }}
                  onBlur={() => addVendor(item.id)}
                />
                <button onClick={() => addVendor(item.id)} className="text-xs font-bold text-brand hover:underline">+ Add</button>
              </div>
            )}
          </div>
        );
      })}
      {/* Per-vendor GST. One row per distinct vendor (name + currency). Enter
          either the rate or the amount — the other fills in automatically. The
          amount is added to that vendor's order (what Finance pays) and into the
          indent total. */}
      {(vendorGroups.length > 0 || optionGroups.length > 0) && (
        <div className="mt-4 p-3 bg-brand-50 rounded-lg border border-brand-200">
          <div className="flex items-center gap-1.5 mb-2">
            <h5 className="text-xs font-bold uppercase tracking-wider text-brand-700">GST &amp; shipping (per vendor)</h5>
            <span
              tabIndex={0}
              className="text-brand hover:text-brand-700 cursor-help"
              title={`GST is charged per vendor invoice. Enter each vendor's GST rate (%) OR the GST amount — the other is calculated from the vendor's subtotal. The GST is added to that vendor's order total (what Finance pays) and to the indent's grand total. Shipping is what the vendor charges for delivery, typed exactly as on their invoice; it is added after GST and not taxed again. Both count in the grand total, which drives the CEO-approval gate${ceoGateCoversEverything() ? ' (currently every indent)' : ` (currently ${ceoThresholdMoney()} and above)`}.`}>
              <HelpCircle size={13} />
            </span>
          </div>
          <div className="flex items-center gap-2 mb-1 px-0.5">
            <span className="flex-1 text-[10px] font-bold uppercase tracking-wider text-brand-600">Vendor</span>
            <span className="w-24 text-[10px] font-bold uppercase tracking-wider text-brand-600 text-right">Subtotal</span>
            <span className="w-16 text-[10px] font-bold uppercase tracking-wider text-brand-600 text-center">GST %</span>
            <span className="w-24 text-[10px] font-bold uppercase tracking-wider text-brand-600 text-center">GST amt</span>
            <span className="w-24 text-[10px] font-bold uppercase tracking-wider text-brand-600 text-center">Shipping</span>
            <span className="w-28 text-[10px] font-bold uppercase tracking-wider text-brand-600 text-right">Total</span>
          </div>
          {[...vendorGroups.map((g) => ({ g, isOption: false })), ...optionGroups.map((g) => ({ g, isOption: true }))].map(({ g, isOption }) => (
            <div key={`${g.vendorName}||${g.currency}`} className={`flex items-center gap-2 mb-1${isOption ? ' opacity-80' : ''}`}>
              <span className="flex-1 truncate text-xs font-semibold text-ink">
                {g.vendorName} <span className="text-[10px] text-faint">{g.currency}</span>
                {isOption && (
                  <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wider text-brand-dark"
                    title="Quoted only as an option. Its GST and shipping are kept for when the admin picks it at approval; not counted in the total below until then.">
                    option
                  </span>
                )}
              </span>
              <span className="w-24 text-right text-xs font-mono text-muted">{money(g.subtotal, g.currency)}</span>
              {canEdit ? (
                <NumberInput
                  min={0} max={100} step={0.5}
                  value={g.gstPercentage || 0}
                  aria-label={`GST % for ${g.vendorName}`}
                  onChange={(v) => { onSetVendorGst?.(g.vendorName, g.currency, Number(v) > 0 ? round2(Number(v)) : null); }}
                  className="w-16 px-2 py-1 border rounded text-xs text-center focus:border-brand outline-none" />
              ) : (
                <span className="w-16 text-center text-xs font-mono text-ink">{(g.gstPercentage || 0).toLocaleString(undefined, { maximumFractionDigits: 3 })}%</span>
              )}
              {canEdit ? (
                <NumberInput
                  min={0} step={0.01}
                  value={g.gstAmount || 0}
                  onChange={(v) => { onSetVendorGst?.(g.vendorName, g.currency, g.subtotal > 0 ? round2((Number(v) / g.subtotal) * 100) : null); }}
                  className="w-24 px-2 py-1 border rounded text-xs text-right focus:border-brand outline-none" />
              ) : (
                <span className="w-24 text-right text-xs font-mono text-ink">{money(g.gstAmount, g.currency)}</span>
              )}
              {canEdit ? (
                <NumberInput
                  min={0} step={0.01}
                  value={g.shippingAmount || 0}
                  aria-label={`Shipping for ${g.vendorName}`}
                  onChange={(v) => { onSetVendorShipping?.(g.vendorName, g.currency, Number(v) > 0 ? round2(Number(v)) : null); }}
                  className="w-24 px-2 py-1 border rounded text-xs text-right focus:border-brand outline-none" />
              ) : (
                <span className="w-24 text-right text-xs font-mono text-ink">{money(g.shippingAmount, g.currency)}</span>
              )}
              <span className="w-28 text-right text-xs font-mono font-bold text-ink">{money(g.total, g.currency)}</span>
            </div>
          ))}
          {/* Panel roll-up — Subtotal + GST + Shipping = Total (mixed vendor currencies roll to INR).
              COMMITTED only: option-only vendors above take their GST and shipping
              now but aren't summed here. */}
          <div className="flex items-center justify-end gap-4 mt-2 pt-2 border-t border-brand-200 text-xs">
            <span className="text-brand-700">Subtotal <span className="font-mono font-bold text-ink">{money(gst.subtotal, gst.currency)}</span></span>
            <span className="text-brand-700">GST <span className="font-mono font-bold text-ink">{money(gst.gstTotal, gst.currency)}</span></span>
            <span className="text-brand-700">Shipping <span className="font-mono font-bold text-ink">{money(gst.shippingTotal, gst.currency)}</span></span>
            <span className="text-brand-700">Total <span className="font-mono font-bold text-brand-dark">{money(gst.grandTotal, gst.currency)}</span></span>
          </div>
        </div>
      )}

      {/* Every name the organisation has actually used, not only the curated
          few. Fed from useKnownVendorNames, which merges the Vendor Code List
          with what has been typed on past allocations and orders — the list
          held two entries while twenty-two names were in use, so the control
          looked like a picker and behaved like free text. */}
      <datalist id="vendor-suggestions">
        {knownVendors.map((v) => <option key={v.name} value={v.name} />)}
      </datalist>
    </div>
  );
};
