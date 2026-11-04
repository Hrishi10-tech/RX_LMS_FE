import { useEffect, useState } from 'react';
import { Modal, Pagination, NumberInput } from '@/components/ui';
import { useConfirm } from '@/context';
import { useClientPagination } from '@/hooks';
import { fmtDateTime } from '@/utils/date';
import { AlertTriangle, ExternalLink, Pencil, User as UserIcon } from 'lucide-react';
import { toInr, rollupTotals, rollupWithVendorGst } from '@/config/thresholds';

// Normalize a currency code; missing/blank → INR (matches the rate table).
const normCur = (c?: string | null) => (c || 'INR').toUpperCase().trim();

// Per-currency symbol; unknown codes fall back to a "CODE " prefix so the
// amount is never silently shown as ₹ when it isn't rupees.
const CURRENCY_SYMBOLS: Record<string, string> = {
  INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥',
  CNY: '¥', AED: 'AED ', SGD: 'S$', AUD: 'A$', CAD: 'C$',
};
const money = (amount: number, currency?: string | null) => {
  const cur = normCur(currency);
  const sym = CURRENCY_SYMBOLS[cur] ?? `${cur} `;
  return `${sym}${Number(amount || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

// Read-only review pane for an indent — the data an approver actually needs
// before clicking Approve/Reject. When procurement has already submitted a
// quotation (re-approval scenario), the firm vendor breakdown is shown too,
// and the Approve/Reject buttons live INSIDE this modal so the approver can't
// act without seeing what they're approving.
//
// ONE unified item table: the firm quote and the inline edit controls (line
// qty + per-vendor pick/split, with each vendor's price / GST / ETA shown as
// decision factors) live in the same paginated list. There is no separate
// "adjust order" table — that split was confusing and, on a 200+ line indent,
// rendered every row twice. Pagination keeps the DOM bounded either way.
interface Props {
  indent: any | null;
  onClose: () => void;
  /** Approve the firm quote at the current price (or the indent itself when
   *  no quotation exists yet). */
  onApprove?: (qtyByItem?: Record<string, number>) => void;
  /**
   * Let the approver change line quantities before signing, on an indent that
   * has not been quoted yet. Separate from `canAdjust`, which is the
   * procurement lane and ties the quantity to vendor splits — here there are
   * no allocations to balance, just the number that was asked for.
   */
  canEditQty?: boolean;
  /**
   * When set, approving right now would be refused by the server — the
   * department requires the manager to sign first and they have not. Approve
   * is disabled with this sentence shown; reject stays available.
   */
  approveBlockedReason?: string | null;
  /** Reject the firm quote — sends the indent back to procurement to re-quote.
   *  The indent itself stays alive. Only relevant when a quotation exists. */
  onRejectQuote?: () => void;
  /** Reject the indent itself — kills the request. Use when the user
   *  shouldn't have raised it or it's no longer needed. */
  onRejectIndent?: () => void;
  /** What the modal advertises in the action footer — e.g. "Tech approval"
   *  or "CEO approval". */
  actionLabel?: string;
  /** Persist the admin's vendor selection (pick vendor(s) + split qty) for the
   *  items procurement quoted with multiple options — and, when canAdjust is on,
   *  any edited line quantities. Resolves once the indent has been refetched so
   *  the modal re-renders with the saved state. */
  onSelectVendors?: (selections: { indentItemId: string; qty?: number; picks: { allocationId: string; qty: number }[] }[]) => Promise<void> | void;
  /** Tech-approval lane only: let the approver edit the line quantity per item
   *  (and the vendor split) before approving. CEO lane stays read-only. */
  canAdjust?: boolean;
}

export const IndentReviewModal = ({ indent, onClose, onApprove, onRejectQuote, onRejectIndent, actionLabel, onSelectVendors, canAdjust, canEditQty, approveBlockedReason }: Props) => {
  const items: any[] = indent?.items || [];
  // ONE paginated list for the whole item table — 10/page keeps the DOM bounded
  // so a 200+ line BOM-spawned indent never renders hundreds of rows (or two
  // parallel tables) at once. The single table shows the firm quote AND carries
  // the inline edit controls (line qty + per-vendor pick/split), so there's no
  // separate "adjust order" table to reconcile. Hook lives above the `!indent`
  // guard so it runs unconditionally (Rules of Hooks).
  const pager = useClientPagination<any>(items, 10, indent?.id);
  const confirm = useConfirm();

  // Admin vendor selection state: itemId → allocationId → chosen qty. Seeded from
  // the current allocations — committed rows keep their suggested qty, alternative
  // options start at 0. The admin adjusts to pick vendor(s) + split the qty.
  const [picks, setPicks] = useState<Record<string, Record<string, number>>>({});
  const [lineQtys, setLineQtys] = useState<Record<string, number>>({});
  // Which lines the APPROVER has opened for editing. The procurement lane
  // (canAdjust) is always-on by design — that reviewer is there to retype
  // numbers. An approver is normally just reading, so a row of open input
  // boxes invites an accidental edit on a form whose main job is yes or no.
  const [qtyEditIds, setQtyEditIds] = useState<Set<string>>(new Set());
  // Keep/Discard per vendor: itemId → allocationId → keep?. A discarded vendor
  // drops out of the count (and is deleted on save); only KEPT vendors' split
  // quantities are summed and verified against the item's required qty.
  const [kept, setKept] = useState<Record<string, Record<string, boolean>>>({});
  const [confirming, setConfirming] = useState(false);
  // Snapshot of the seeded state so we can detect unsaved edits (dirty).
  const [initialSnapshot, setInitialSnapshot] = useState('');
  useEffect(() => {
    const byItem: Record<string, Record<string, number>> = {};
    const keptByItem: Record<string, Record<string, boolean>> = {};
    for (const a of (indent?.vendorAllocations || [])) {
      byItem[a.indentItemId] = byItem[a.indentItemId] || {};
      byItem[a.indentItemId][a.id] = a.isAlternative ? 0 : Number(a.allocatedQty) || 0;
      // Default: committed rows are kept, alternative options start discarded —
      // the admin chooses which option(s) to keep.
      keptByItem[a.indentItemId] = keptByItem[a.indentItemId] || {};
      keptByItem[a.indentItemId][a.id] = !a.isAlternative;
    }
    // Seed line qtys from the active quotation line (falls back to the item qty).
    const activeQ = (indent?.quotations || []).find((q: any) => q.status === 'DRAFT' || q.status === 'SUBMITTED');
    const qtyByItem: Record<string, number> = {};
    for (const it of (indent?.items || [])) {
      const qLine = (activeQ?.items || []).find((qi: any) => qi.indentItemId === it.id);
      qtyByItem[it.id] = Number(qLine?.qty ?? it.qty ?? 0);
    }
    setPicks(byItem);
    setLineQtys(qtyByItem);
    // A newly opened indent starts closed for editing, so the previous one's
    // open fields do not carry over.
    setQtyEditIds(new Set());
    setKept(keptByItem);
    setInitialSnapshot(JSON.stringify({ byItem, qtyByItem, kept: keptByItem }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reseed only when the modal switches indents
  }, [indent?.id]);

  if (!indent) return null;
  const responsibles: any[] = indent.responsiblePersons || [];
  // Latest quotation in any status — DRAFT/SUBMITTED (active), REJECTED
  // (procurement was told to re-quote), or APPROVED (signed off, in motion).
  // We render the firm-quote section even for rejected quotes so the admin
  // has context for what they previously sent back, and so a stale modal
  // doesn't look like "no quote ever existed". A status pill clarifies.
  const allQuotations = (indent.quotations || []).slice().sort((a: any, b: any) => (b.version ?? 0) - (a.version ?? 0));
  const latestQuotation: any | null = allQuotations[0] || null;
  const activeQuotation: any | null = allQuotations.find((q: any) => q.status === 'DRAFT' || q.status === 'SUBMITTED') || null;
  // For displaying the firm quote, prefer the active one but fall back to the
  // latest of any status so the breakdown stays visible after a rejection.
  const displayedQuotation: any | null = activeQuotation || latestQuotation;
  const vendorAllocations: any[] = indent.vendorAllocations || [];

  // Group vendor allocations by indent item id.
  const allocByItem: Record<string, any[]> = {};
  for (const a of vendorAllocations) {
    if (!allocByItem[a.indentItemId]) allocByItem[a.indentItemId] = [];
    allocByItem[a.indentItemId].push(a);
  }
  // Per-item map for the QuotationItem fields (fallback when an item has no
  // allocations yet).
  const quotationByItem: Record<string, any> = displayedQuotation
    ? Object.fromEntries((displayedQuotation.items || []).map((qi: any) => [qi.indentItemId, qi]))
    : {};

  // The Firm Quote section derives its numbers from the actual vendor
  // allocations — those are the source of truth. The QuotationItem fields
  // are a cached projection that can lag if allocations are added without
  // a Save Allocations call. Trusting the cache here led to "vendors sum
  // to ₹20k but line total shows ₹0" inconsistencies. Compute live instead.
  // Per-item firm numbers, currency-aware. Each vendor allocation carries its
  // OWN currency, so the per-item total is only meaningful in a single currency
  // when every allocation for that line agrees; if they differ we convert each
  // to INR (mirrors backend rollupTotals) and flag `mixed`. `currency` is the
  // unit the returned unitAmount/total are expressed in. Committed rows only —
  // alternatives (options the admin hasn't picked) must not inflate the total.
  const firmPerItem = (it: any) => {
    const allocs = (allocByItem[it.id] || []).filter((a: any) => !a.isAlternative);
    if (allocs.length > 0) {
      const allocQty = allocs.reduce((s, a) => s + (Number(a.allocatedQty) || 0), 0);
      const currencies = new Set(allocs.map((a) => normCur(a.currency)));
      if (currencies.size <= 1) {
        const currency = normCur(allocs[0].currency);
        const total = allocs.reduce((s, a) => s + (Number(a.allocatedQty) || 0) * (Number(a.unitPrice) || 0), 0);
        return { qty: allocQty, unitAmount: allocQty ? total / allocQty : 0, total, currency, mixed: false, source: 'allocations' as const };
      }
      // Mixed currencies within one line → convert each alloc to INR.
      const totalInr = allocs.reduce((s, a) => s + toInr((Number(a.allocatedQty) || 0) * (Number(a.unitPrice) || 0), a.currency), 0);
      return { qty: allocQty, unitAmount: allocQty ? totalInr / allocQty : 0, total: totalInr, currency: 'INR', mixed: true, source: 'allocations' as const };
    }
    // No committed allocations — fall back to the QuotationItem numbers (rare:
    // procurement edited qty/price but hasn't committed vendors yet).
    // QuotationItem has no currency column, so use the indent line's own
    // currency as the proxy.
    const qLine = quotationByItem[it.id];
    if (qLine) return { qty: Number(qLine.qty) || 0, unitAmount: Number(qLine.unitAmount) || 0, total: Number(qLine.total) || 0, currency: normCur(it.currency), mixed: false, source: 'quotation' as const };
    return { qty: 0, unitAmount: 0, total: 0, currency: normCur(it.currency), mixed: false, source: 'empty' as const };
  };
  // Roll the per-item firm totals into ONE grand total: native currency when
  // every line agrees, INR when they don't (same rule as the backend persists).
  const firmLines = items.map((it) => firmPerItem(it)).filter((f) => f.source !== 'empty');
  const firmRoll = rollupTotals(firmLines.map((f) => ({ total: f.total, currency: f.currency })));
  // The firm total is what the backend stores as the indent's grandTotal and
  // what the CEO check and Finance read: each vendor's subtotal PLUS its GST
  // PLUS its shipping, over the COMMITTED rows. Summing qty × price alone
  // showed the approver a smaller number than the one they were signing for.
  // Names trimmed so "Robu " and "Robu" are one vendor, as they are on save.
  const committedAllocs = vendorAllocations.filter((a: any) => !a.isAlternative && String(a.vendorName || '').trim());
  const vendorRoll = rollupWithVendorGst(committedAllocs.map((a: any) => ({
    vendorName: String(a.vendorName).trim(),
    total: (Number(a.allocatedQty) || 0) * (Number(a.unitPrice) || 0),
    currency: a.currency,
    gstPercentage: a.gstPercentage,
    shippingCost: a.shippingCost,
  })));
  // No committed vendors yet → nothing to tax or ship; the quotation lines stand.
  const fromVendors = committedAllocs.length > 0;
  const firmGrandTotal = fromVendors ? vendorRoll.grandTotal : firmRoll.grandTotal;
  const firmGrandCurrency = fromVendors ? vendorRoll.currency : firmRoll.currency;
  const firmMixed = new Set(firmLines.map((f) => f.currency)).size > 1;
  const firmHasGst = fromVendors && vendorRoll.gstTotal > 0.005;
  const firmHasShipping = fromVendors && vendorRoll.shippingTotal > 0.005;
  // "incl. GST & shipping" — only the parts actually present, as the quote
  // screen (IndentDetailsModal) words it.
  const firmInclLabel = (firmHasGst || firmHasShipping)
    ? `incl. ${[firmHasGst ? 'GST' : '', firmHasShipping ? 'shipping' : ''].filter(Boolean).join(' & ')}`
    : '';
  const firmInclTitle = [
    firmHasGst ? `${money(vendorRoll.gstTotal, firmGrandCurrency)} GST` : '',
    firmHasShipping ? `${money(vendorRoll.shippingTotal, firmGrandCurrency)} shipping` : '',
  ].filter(Boolean).join(' and ') + ' across vendors.';
  // Shipping is charged once per vendor, but the vendor appears on every line it
  // supplies. Show the figure on the vendor's FIRST row only (item order), so
  // nobody adds it up line by line; the other rows point back to it.
  const vendorKey = (a: any) => `${String(a.vendorName || '').trim()}||${normCur(a.currency)}`;
  const shippingShownOn = new Map<string, { allocId: string; itemName: string }>();
  for (const it of items) {
    for (const a of (allocByItem[it.id] || [])) {
      if (!shippingShownOn.has(vendorKey(a))) shippingShownOn.set(vendorKey(a), { allocId: a.id, itemName: it.name });
    }
  }
  // The "Amount" displayed in the top metadata:
  // - When there's an ACTIVE quotation (DRAFT/SUBMITTED) → firm-quote total
  //   (matches what the approver is signing off on).
  // - When the latest quotation is REJECTED or there's no quotation →
  //   the original ask (sum of originalQty × originalUnitAmount). Avoids
  //   showing a stale "(quotation v1)" total for a quote that was rejected.
  const origRoll = rollupTotals(items.map((it) => ({
    total: Number(it.originalQty ?? it.qty) * Number(it.originalUnitAmount ?? it.unitAmount ?? 0),
    currency: it.currency,
  })));
  const originalTotal = origRoll.grandTotal;
  const grand = activeQuotation ? firmGrandTotal : originalTotal;
  const grandCurrency = activeQuotation ? firmGrandCurrency : origRoll.currency;

  // --- Admin vendor selection + quantity adjustment -----------------------
  // Items procurement quoted with alternative options MUST be resolved (pick
  // vendor(s) + split) before approval. In the tech lane (canAdjust) the
  // approver can additionally edit the line qty for EVERY quoted item.
  const savedLineQtyOf = (it: any) => Number(quotationByItem[it.id]?.qty ?? it.qty ?? 0);
  const effLineQty = (it: any) => Number(lineQtys[it.id] ?? savedLineQtyOf(it));
  // Only UNDECIDED options block approval. A discarded option (isDiscarded) is
  // a made decision — retained for undo but no longer "needs a pick".
  const itemsNeedingSelection = items.filter((it) => (allocByItem[it.id] || []).some((a: any) => a.isAlternative && !a.isDiscarded));
  const needsSelection = itemsNeedingSelection.length > 0;
  // Which items are editable: in the adjust lane, every item that has a quote;
  // otherwise only the ones with unresolved options.
  const editableItems = (canAdjust
    ? items.filter((it) => (allocByItem[it.id] || []).length > 0)
    : itemsNeedingSelection);
  const showEditor = !!onSelectVendors && editableItems.length > 0;
  const editableIdSet = new Set(editableItems.map((it: any) => it.id));
  // keep? for a vendor row. Falls back to committed-by-default before the seed
  // effect has run (or for any alloc not yet in state).
  const keptOf = (itemId: string, a: any) => kept[itemId]?.[a.id] ?? !a.isAlternative;
  // Only KEPT vendors count toward the split sum.
  const keptAllocs = (it: any) => (allocByItem[it.id] || []).filter((a: any) => keptOf(it.id, a));
  const pickSum = (it: any) => keptAllocs(it).reduce((s: number, a: any) => s + (Number(picks[it.id]?.[a.id]) || 0), 0);
  const itemValid = (it: any) =>
    Math.abs(pickSum(it) - effLineQty(it)) < 0.001 &&
    effLineQty(it) > 0 &&
    keptAllocs(it).some((a: any) => Number(picks[it.id]?.[a.id]) > 0);
  const editorValid = editableItems.every(itemValid);
  const dirty = JSON.stringify({ byItem: picks, qtyByItem: lineQtys, kept }) !== initialSnapshot;
  // Guard the close: an accidental X/backdrop click after adjusting the vendor
  // selection would silently drop the edits, so warn while there are unsaved
  // changes. Clean (no edits) → close straight away.
  const handleClose = async () => {
    if (dirty) {
      const discard = await confirm({
        title: 'Discard unsaved changes?',
        message: "You've adjusted the vendor selection but haven't saved it. Close without saving?",
        confirmLabel: 'Discard changes',
        cancelLabel: 'Keep editing',
        tone: 'danger',
      });
      if (!discard) return;
    }
    onClose();
  };
  const setPick = (itemId: string, allocId: string, qty: number) =>
    setPicks((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), [allocId]: qty } }));
  const setLineQty = (itemId: string, qty: number) => {
    setLineQtys((prev) => ({ ...prev, [itemId]: qty }));
    // Convenience: when only ONE kept vendor has a qty, keep its split in
    // lockstep with the line qty so the sum stays valid without extra typing.
    const active = (allocByItem[itemId] || []).filter((a: any) => keptOf(itemId, a) && Number(picks[itemId]?.[a.id]) > 0);
    if (active.length === 1) setPick(itemId, active[0].id, qty);
  };
  // Toggle keep/discard. On discard → qty forced to 0 (excluded). On keep → if
  // it had no qty, seed it with the still-unallocated remainder so the split
  // stays easy to balance.
  const toggleKeep = (it: any, a: any) => {
    const itemId = it.id;
    const next = !keptOf(itemId, a);
    setKept((prev) => ({ ...prev, [itemId]: { ...(prev[itemId] || {}), [a.id]: next } }));
    if (!next) {
      setPick(itemId, a.id, 0);
    } else if ((Number(picks[itemId]?.[a.id]) || 0) < 1) {
      const lineQty = effLineQty(it);
      const otherKeptSum = (allocByItem[itemId] || [])
        .filter((o: any) => o.id !== a.id && keptOf(itemId, o))
        .reduce((s: number, o: any) => s + (Number(picks[itemId]?.[o.id]) || 0), 0);
      setPick(itemId, a.id, Math.max(0, lineQty - otherKeptSum) || lineQty);
    }
  };
  // Undo all unsaved edits — restore the split / keep-discard / line-qty state
  // to what was loaded from the server. Nothing has been deleted yet (that only
  // happens on Save), so this brings back every discarded vendor option.
  const revert = () => {
    try {
      const snap = JSON.parse(initialSnapshot || '{}');
      setPicks(snap.byItem || {});
      setLineQtys(snap.qtyByItem || {});
      setKept(snap.kept || {});
    } catch { /* nothing to restore */ }
  };
  // Save is NON-destructive now: discarded vendors are only MARKED (retained in
  // the DB), not deleted — so this never loses data and needs no scary confirm.
  // Revert (below) or re-ticking Keep brings them back; they're deleted only on
  // Approve (handleApprove confirms that).
  const confirmSelection = async () => {
    if (!onSelectVendors || !editorValid || confirming) return;
    setConfirming(true);
    try {
      const selections = editableItems.map((it) => ({
        indentItemId: it.id,
        ...(canAdjust ? { qty: effLineQty(it) } : {}),
        // Only kept vendors with a positive qty are sent; the backend marks the
        // rest discarded (retained until approval), not deleted.
        picks: keptAllocs(it)
          .filter((a: any) => Number(picks[it.id]?.[a.id]) > 0)
          .map((a: any) => ({ allocationId: a.id, qty: Number(picks[it.id]?.[a.id]) })),
      }));
      await onSelectVendors(selections);
      // The parent refetches the SAME indent id, so the seed effect (keyed on
      // indent.id) won't re-run — rebaseline here so the just-saved state reads
      // as clean (no false "unsaved changes" prompt on close, Approve enabled).
      setInitialSnapshot(JSON.stringify({ byItem: picks, qtyByItem: lineQtys, kept }));
    } finally {
      setConfirming(false);
    }
  };
  // Approve IS the destructive step — the backend hard-deletes discarded vendors
  // on sign-off. Confirm it, listing exactly which options are about to be lost
  // for good, so the "delete only after Approve" contract is explicit.
  const handleApprove = async () => {
    if (!onApprove) return;
    const dropping = vendorAllocations
      .filter((a: any) => a.isDiscarded)
      .map((a: any) => {
        const it = items.find((x) => x.id === a.indentItemId);
        return `${a.vendorName} — ${it?.name || 'item'}`;
      });
    if (dropping.length > 0) {
      const preview = dropping.slice(0, 10).join('\n');
      const okToGo = await confirm({
        title: 'Approve & finalize?',
        message: `Approving locks in the firm quote and PERMANENTLY removes the ${dropping.length} discarded vendor option${dropping.length === 1 ? '' : 's'} below (kept until now so you could still undo):\n\n${preview}${dropping.length > 10 ? `\n…and ${dropping.length - 10} more` : ''}\n\nContinue?`,
        confirmLabel: 'Approve & finalize',
        cancelLabel: 'Go back',
        tone: 'danger',
      });
      if (!okToGo) return;
    }
    // Only the lines the approver actually touched, so an untouched indent
    // approves exactly as it did before and nothing is rewritten needlessly.
    const edited: Record<string, number> = {};
    if (canEditQty) {
      for (const it of items) {
        const next = Number(lineQtys[it.id]);
        if (Number.isFinite(next) && next > 0 && next !== Number(it.qty)) edited[it.id] = next;
      }
    }
    await onApprove(Object.keys(edited).length > 0 ? edited : undefined);
  };

  // Jump-to helper so a reviewer never has to hunt across pages for the item(s)
  // that still need a vendor pick.
  const unresolvedIdxs = items
    .map((it: any, i: number) => ((allocByItem[it.id] || []).some((a: any) => a.isAlternative && !a.isDiscarded) ? i : -1))
    .filter((i: number) => i >= 0);
  const jumpToUnresolved = () => {
    if (unresolvedIdxs.length === 0) return;
    const off = unresolvedIdxs.find((i: number) => Math.floor(i / pager.pageSize) + 1 !== pager.page);
    const target = off ?? unresolvedIdxs[0];
    pager.setPage(Math.floor(target / pager.pageSize) + 1);
  };

  const quoted = !!displayedQuotation;

  // One item row — firm-quote breakdown + (in an editable lane) the inline
  // line-qty and per-vendor split controls. Kept as a function so the map body
  // stays readable; only the current page's rows ever mount.
  const renderItemRow = (it: any, i: number) => {
    const absIdx = (pager.page - 1) * pager.pageSize + i + 1;
    const allAllocs = allocByItem[it.id] || [];
    const eff = firmPerItem(it);
    const isEditable = editableIdSet.has(it.id);
    const showFirm = quoted && eff.source !== 'empty';

    const origQty = Number(it.originalQty ?? it.qty);
    const origUnit = Number(it.originalUnitAmount ?? it.unitAmount ?? 0);
    // What to display in the numbers row: firm figures once quoted, else the ask.
    const dispQty = showFirm ? eff.qty : origQty;
    const dispUnit = showFirm ? eff.unitAmount : origUnit;
    const dispTotal = showFirm ? eff.total : origQty * origUnit;
    const dispCur = showFirm ? eff.currency : normCur(it.currency);
    const qtyChanged = showFirm && dispQty !== origQty;
    const sameCurrency = showFirm && !eff.mixed && normCur(it.currency) === eff.currency;
    const priceChanged = sameCurrency && Math.abs(dispUnit - origUnit) > 0.005;

    // Assignment split — how much of an over-order is reserved for the requester
    // vs pushed to general stock. Only meaningful once committed.
    const committedQty = allAllocs.filter((a: any) => !a.isAlternative).reduce((s: number, a: any) => s + (Number(a.allocatedQty) || 0), 0);
    const reservedForRequester = it.assignedToUserQty != null ? Number(it.assignedToUserQty) : Math.min(committedQty, origQty);
    const toGeneralStock = Math.max(0, committedQty - reservedForRequester);

    const lineQty = effLineQty(it);
    const sum = pickSum(it);
    const ok = itemValid(it);

    // Right-most vendor column: an editable "Split" input, or the read-only
    // "qty × price = total" amount. Header + rows share the same width so they
    // line up as a real table.
    const lastColCls = isEditable ? 'w-20 text-center' : 'w-32 text-right';

    return (
      <div key={it.id} className={`rounded-lg border overflow-hidden shadow-sm ${quoted ? 'border-emerald-200 dark:border-emerald-400/30' : 'border-line'}`}>
        {/* ── Tier 1: item header band (name + meta + split-validity chip) ── */}
        <div className={`px-3 py-2 flex items-start justify-between gap-3 ${quoted ? 'bg-emerald-50 dark:bg-emerald-400/15' : 'bg-surface'}`}>
          <div className="min-w-0 flex items-start gap-2">
            <span className={`mt-0.5 shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold ${quoted ? 'bg-emerald-200/70 dark:bg-emerald-400/20 text-emerald-900 dark:text-emerald-200' : 'bg-line text-secondary'}`}>{absIdx}</span>
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-bold text-ink text-[13px] leading-tight">{it.name}</span>
                {it.partNumber && <span className="text-[10px] text-faint font-mono">PN {it.partNumber}</span>}
              </div>
              {it.description && <p className="text-[11px] text-muted truncate max-w-[520px]" title={it.description}>{it.description}</p>}
              {it.purpose && <p className="text-[11px] text-muted italic truncate max-w-[520px]" title={it.purpose}>{it.purpose}</p>}
              {it.url && (
                <a href={it.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 text-[10px] text-blue-600 dark:text-blue-300 hover:underline">
                  Source link <ExternalLink size={10} />
                </a>
              )}
            </div>
          </div>
          {isEditable && (
            <span className={`text-[11px] font-bold shrink-0 whitespace-nowrap px-2 py-0.5 rounded-full ${ok ? 'bg-emerald-100 dark:bg-emerald-400/20 text-emerald-700 dark:text-emerald-300' : 'bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200'}`}>
              {sum} / {lineQty} {it.unit || ''} {ok ? '✓' : '⚠ split'}
            </span>
          )}
        </div>

        {/* ── Tier 2: numbers strip (Qty · Unit price · Line total) ── */}
        <div className="px-3 py-2 grid grid-cols-3 gap-3 bg-card border-t border-line-soft">
          <div className="group">
            <p className="text-[10px] text-muted uppercase tracking-wider font-bold">Qty</p>
            {(canAdjust && isEditable) || (canEditQty && qtyEditIds.has(it.id)) ? (
              <div className="flex items-center gap-1 mt-0.5">
                <NumberInput
                  min={1} max={100000}
                  value={lineQty}
                  onChange={(v) => setLineQty(it.id, Number(v) || 0)}
                  className="w-16 px-1.5 py-0.5 border rounded text-[11px] text-center focus:border-brand outline-none" />
                <span className="text-[10px] text-faint">{it.unit || ''}</span>
              </div>
            ) : (
              <p className={`font-bold inline-flex items-center gap-1 ${qtyChanged ? 'text-amber-700 dark:text-amber-300' : 'text-ink'}`}>
                {dispQty} {it.unit || ''}
                {qtyChanged && <span className="ml-1 text-[10px] font-normal text-muted">(asked {origQty})</span>}
                {canEditQty && (
                  <button
                    type="button"
                    onClick={() => setQtyEditIds((prev) => new Set(prev).add(it.id))}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted hover:text-brand"
                    title="Approve a different quantity"
                    aria-label={`Edit the quantity for ${it.name}`}
                  >
                    <Pencil size={11} />
                  </button>
                )}
              </p>
            )}
          </div>
          <div>
            <p className="text-[10px] text-muted uppercase tracking-wider font-bold">Unit price</p>
            {dispUnit > 0 ? (
              <p className={`font-bold ${priceChanged ? 'text-amber-700 dark:text-amber-300' : 'text-ink'}`}>
                {money(dispUnit, dispCur)}
                {priceChanged && <span className="ml-1 text-[10px] font-normal text-muted">(asked {money(origUnit, it.currency)})</span>}
              </p>
            ) : (
              <p className={quoted ? 'text-faint' : 'italic text-amber-700 dark:text-amber-300'}>{quoted ? 'priced below' : 'Price TBD'}</p>
            )}
          </div>
          <div className="text-right">
            <p className="text-[10px] text-muted uppercase tracking-wider font-bold">Line total</p>
            <p className={`font-bold ${showFirm ? 'text-emerald-700 dark:text-emerald-300' : 'text-ink'}`}>{dispTotal > 0 ? money(dispTotal, dispCur) : '—'}</p>
          </div>
        </div>

        {/* ── Tier 3: vendors sub-panel (shaded, with aligned column headers) ── */}
        {allAllocs.length > 0 && (
          <div className="px-3 py-2 bg-zebra border-t border-line-soft">
            <div className="flex items-center gap-2 text-[9px] uppercase tracking-wider text-muted font-bold pb-1 mb-1 border-b border-line">
              <span className="flex-1">Vendor</span>
              <span className="w-20 text-right">Unit price</span>
              <span className="w-12 text-center">GST</span>
              <span className="w-20 text-right" title="The vendor's delivery charge — once per vendor, not per line, and not taxed">Shipping</span>
              <span className="w-24 text-center">ETA</span>
              <span className={lastColCls}>{isEditable ? 'Split' : 'Amount'}</span>
              {isEditable && <span className="w-20 text-center">Keep?</span>}
            </div>
            <div className="space-y-1">
              {allAllocs.map((a: any) => {
                const isAlt = !!a.isAlternative;
                const keep = keptOf(it.id, a);
                return (
                  <div key={a.id} className={`flex items-center gap-2 text-[11px] ${isEditable && !keep ? 'opacity-45' : ''}`}>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate font-semibold text-ink">
                        {a.vendorName} <span className="text-[10px] text-faint">{normCur(a.currency)}</span>
                        {isAlt && isEditable && <span className="ml-1 text-[9px] font-bold text-brand-dark uppercase">option</span>}
                        {a.url && /^https?:\/\//i.test(a.url) && (
                          <a href={a.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
                            className="ml-1 text-brand-dark hover:text-ink font-normal" title={`Open product link — ${a.url}`}>↗</a>
                        )}
                      </span>
                      {a.notes && <span className="block text-[10px] text-faint italic truncate" title={a.notes}>📝 {a.notes}</span>}
                    </span>
                    <span className="w-20 text-right font-mono text-muted">{money(Number(a.unitPrice || 0), a.currency)}</span>
                    <span className="w-12 text-center text-muted">{a.gstPercentage != null ? `${Number(a.gstPercentage)}%` : '—'}</span>
                    {(() => {
                      if (!(Number(a.shippingCost) > 0)) return <span className="w-20 text-right font-mono text-muted">—</span>;
                      const first = shippingShownOn.get(vendorKey(a));
                      return first?.allocId === a.id
                        ? <span className="w-20 text-right font-mono text-muted" title="Charged once for this vendor, whatever the number of lines">{money(Number(a.shippingCost), a.currency)}</span>
                        : <span className="w-20 text-right text-[10px] italic text-faint" title={`Charged once per vendor — counted on ${first?.itemName ?? 'its first line'}`}>once, above</span>;
                    })()}
                    <span className="w-24 text-center text-muted">{a.quotedEtaDate ? new Date(a.quotedEtaDate).toLocaleDateString() : '—'}</span>
                    {isEditable ? (
                      keep ? (
                        <NumberInput
                          min={0} max={lineQty}
                          value={picks[it.id]?.[a.id] ?? 0}
                          onChange={(v) => setPick(it.id, a.id, Number(v) || 0)}
                          className="w-20 px-2 py-1 border rounded text-[11px] text-center focus:border-brand outline-none" />
                      ) : (
                        <span className="w-20 text-center text-[10px] italic text-faint line-through">discarded</span>
                      )
                    ) : (
                      <span className="w-32 text-right font-mono text-muted">
                        {Number(a.allocatedQty)} × {money(Number(a.unitPrice || 0), a.currency)} = <span className="font-bold text-emerald-700 dark:text-emerald-300">{money(Number(a.total || 0), a.currency)}</span>
                      </span>
                    )}
                    {isEditable && (
                      <label className="w-20 flex items-center justify-center gap-1 cursor-pointer" title={keep ? 'This vendor is counted toward the split. Click to discard.' : 'This vendor is discarded — not counted and removed on save. Click to keep.'}>
                        <input
                          type="checkbox"
                          checked={keep}
                          onChange={() => toggleKeep(it, a)}
                          className="accent-emerald-600 cursor-pointer" />
                        <span className={`text-[9px] font-bold uppercase ${keep ? 'text-emerald-700 dark:text-emerald-300' : 'text-faint'}`}>{keep ? 'Keep' : 'Off'}</span>
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Assignment split — only when procurement over-ordered to stock. */}
        {toGeneralStock > 0 && (
          <div className="px-3 py-1.5 bg-card border-t border-line-soft text-[11px] text-ink">
            <span className="text-[10px] text-muted uppercase tracking-wider font-bold mr-1">Assignment</span>
            <span className="font-bold">{reservedForRequester}</span> {it.unit || ''} to requester
            <span className="text-faint"> · </span>
            <span className="font-bold">{toGeneralStock}</span> {it.unit || ''} to general stock
          </div>
        )}
      </div>
    );
  };

  return (
    <Modal isOpen={!!indent} onClose={handleClose} title={`Indent ${indent.serialNo}`} size="2xl">
      <div className="space-y-4 max-h-[80vh] overflow-y-auto pr-1">
        {/* Emergency reason banner — only renders when the indent was flagged. */}
        {indent.emergency && (
          <div className="bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 rounded-lg p-3 text-sm flex items-start gap-2">
            <AlertTriangle size={16} className="text-red-700 dark:text-red-300 mt-0.5 shrink-0" />
            <div>
              <p className="font-bold text-red-900 dark:text-red-200">Emergency indent</p>
              <p className="text-xs text-red-800 dark:text-red-200 mt-0.5">
                {(indent.emergencyReason || '').trim() || <span className="italic">No reason given.</span>}
              </p>
            </div>
          </div>
        )}

        {/* Top-line facts */}
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div><span className="text-faint text-xs">Requested by</span><p className="font-bold text-ink">{indent.createdBy?.name || 'Unknown'} <span className="text-xs font-normal text-muted">{indent.createdBy?.email ? `(${indent.createdBy.email})` : ''}</span></p></div>
          <div><span className="text-faint text-xs">Raised on</span><p className="font-medium text-ink">{indent.createdAt ? fmtDateTime(indent.createdAt) : '—'}</p></div>
          <div><span className="text-faint text-xs">Department</span><p className="font-medium text-ink">{indent.department?.name || 'Unknown'}</p></div>
          <div><span className="text-faint text-xs">Project</span><p className="font-medium text-ink">{indent.project?.name || <span className="italic text-faint">General / Others</span>}</p></div>
          <div><span className="text-faint text-xs">{activeQuotation ? 'Firm quote' : 'Amount asked'}</span>
            {grand > 0
              ? <p className="font-bold text-ink">{grandCurrency} {grand.toLocaleString(undefined, { maximumFractionDigits: 2 })}{activeQuotation && firmInclLabel && <span className="ml-1 text-[10px] font-normal text-muted" title={firmInclTitle}>{firmInclLabel}</span>}{activeQuotation && <span className="ml-1 text-[10px] font-normal text-emerald-700 dark:text-emerald-300">(quotation v{activeQuotation.version})</span>}</p>
              : <p className="font-bold text-amber-700 dark:text-amber-300">Price TBD <span className="text-[10px] font-normal text-muted">(procurement to quote)</span></p>}
          </div>
          <div><span className="text-faint text-xs">Currently with</span><p className="font-medium text-ink">{indent.currentHolder || indent.status}</p></div>
        </div>

        {/* Responsible persons */}
        {responsibles.length > 0 && (
          <div>
            <span className="text-faint text-xs">Responsible person{responsibles.length > 1 ? 's' : ''}</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {responsibles.map((rp: any) => (
                <span key={rp.userId} className="inline-flex items-center gap-1 text-xs bg-hover text-ink rounded-full px-2 py-0.5">
                  <UserIcon size={10} /> {rp.user?.name || 'Unknown'}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* ONE unified item table: firm quote + inline edit, paginated so a
            200+ line indent never mounts more than a page of rows at once. */}
        <div>
          <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={`text-xs font-bold uppercase tracking-wider ${quoted ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted'}`}>
                {quoted ? 'Firm quote' : 'Items'} ({items.length})
              </span>
              {quoted && displayedQuotation.status !== 'DRAFT' && displayedQuotation.status !== 'SUBMITTED' && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${
                  displayedQuotation.status === 'REJECTED' ? 'bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-400/30'
                  : displayedQuotation.status === 'APPROVED' ? 'bg-emerald-100 dark:bg-emerald-400/20 text-emerald-800 dark:text-emerald-200 border border-emerald-200 dark:border-emerald-400/30'
                  : 'bg-hover text-secondary border border-line'
                }`}>{displayedQuotation.status} · v{displayedQuotation.version}</span>
              )}
              {showEditor && (
                needsSelection
                  ? <button type="button" onClick={jumpToUnresolved}
                      className="text-[10px] font-bold text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded px-1.5 py-0.5 hover:bg-amber-100 dark:bg-amber-400/20 transition-colors">
                      {itemsNeedingSelection.length} need a vendor pick →
                    </button>
                  : editorValid && <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300">all set ✓</span>
              )}
            </div>
            <span className="text-[10px] text-faint">
              {quoted
                ? (canAdjust ? '— edit qty / pick vendors inline, then save' : (needsSelection ? '— pick vendor(s) + split the qty' : '— what procurement negotiated'))
                : '— the request as raised'}
            </span>
          </div>

          {items.length === 0 ? (
            <div className="border border-line-soft rounded-md px-3 py-4 text-center text-xs text-faint italic">
              No items on this indent.
            </div>
          ) : (
            <>
              <div className="space-y-2.5">
                {pager.pageRows.map((it: any, i: number) => renderItemRow(it, i))}
              </div>
              {pager.totalPages > 1 && (
                <Pagination currentPage={pager.page} totalPages={pager.totalPages} onPageChange={pager.setPage} />
              )}
              {/* Grand total — computed across ALL items, not just this page. */}
              <div className={`mt-2 p-3 rounded-md flex items-baseline justify-between ${quoted ? 'bg-emerald-100/40 dark:bg-emerald-400/15' : 'bg-surface'}`}>
                <span className={`text-xs font-bold uppercase tracking-wider ${quoted ? 'text-emerald-900 dark:text-emerald-200' : 'text-muted'}`}>
                  {quoted ? 'Firm quote total' : 'Amount asked'}
                  {quoted && firmMixed && <span className="ml-1 text-[10px] font-normal normal-case text-emerald-700 dark:text-emerald-300">(mixed currencies → INR)</span>}
                </span>
                <span className={`text-base font-bold ${quoted ? 'text-emerald-700 dark:text-emerald-300' : 'text-ink'}`}>
                  {grandCurrency} {grand.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  {activeQuotation && firmInclLabel && (
                    <span className="ml-2 text-[10px] font-normal text-muted" title={firmInclTitle}>{firmInclLabel}</span>
                  )}
                </span>
              </div>
              {/* Per vendor, so the total above can be checked by hand: each
                  vendor's lines, its GST, and its shipping counted once. */}
              {activeQuotation && fromVendors && (firmHasGst || firmHasShipping) && (
                <div className="mt-1 px-3 space-y-0.5" aria-label="Per-vendor totals">
                  {vendorRoll.groups.map((g) => (
                    <div key={g.key} className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
                      <span className="truncate">{g.vendorName} <span className="text-[10px] text-faint">{g.currency}</span></span>
                      <span className="font-mono">
                        {money(g.subtotal, g.currency)}
                        {g.gstAmount > 0 && <> + GST {money(g.gstAmount, g.currency)}</>}
                        {g.shippingAmount > 0 && <> + shipping {money(g.shippingAmount, g.currency)}</>}
                        {' = '}<span className="font-bold text-ink">{money(g.total, g.currency)}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {/* Save bar — commits the vendor picks / qty edits made inline above.
              Save is destructive (discarded vendors are deleted), so it's guarded
              by a confirm dialog listing what's dropped, and Revert undoes any
              unsaved edits (bringing discarded options back — nothing's gone
              until Save). */}
          {showEditor && (
            <div className="flex items-center justify-end gap-2 mt-2">
              <span className="text-[11px] text-muted italic mr-auto">
                {canAdjust ? 'Save changes, then approve.' : 'Confirm the split, then approve.'} Discarded vendors are kept until you Approve — Revert or re-tick Keep to bring them back.
              </span>
              <button
                onClick={revert}
                disabled={!dirty || confirming}
                title="Undo all unsaved edits and bring back every discarded vendor option."
                className={`px-3 py-1.5 text-xs font-bold rounded border transition-colors ${dirty && !confirming ? 'border-line text-muted hover:bg-surface' : 'border-line text-faint cursor-not-allowed'}`}>
                Revert changes
              </button>
              <button
                onClick={confirmSelection}
                disabled={!editorValid || confirming || (!dirty && !needsSelection)}
                className={`px-3 py-1.5 text-xs font-bold rounded shadow-sm transition-colors ${editorValid && !confirming && (dirty || needsSelection) ? 'bg-brand-dark text-white hover:bg-brand-700' : 'bg-line text-faint cursor-not-allowed'}`}>
                {confirming ? 'Saving…' : canAdjust ? 'Save changes' : 'Confirm vendor selection'}
              </button>
            </div>
          )}
        </div>

        {/* Action footer — distinct buttons for distinct outcomes:
            - Approve: green, signs off
            - Send to re-quote: amber, only kicks the quote back to procurement
              (indent stays alive). Hidden when there's no quotation yet —
              there's no quote to bounce.
            - Reject indent: red, kills the indent entirely. Always available
              to the approver as the escape hatch when the request itself
              shouldn't proceed. */}
        {onApprove || onRejectQuote || onRejectIndent ? (
          <div className="pt-3 border-t border-line-soft flex flex-col gap-2">
            <p className="text-[11px] text-muted italic">
              {actionLabel ? `${actionLabel} — ` : ''}You're signing off on {activeQuotation ? 'the firm quote above' : canEditQty ? 'the request, with any quantity you change above' : 'the request as shown'}.
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {onRejectIndent && (
                <button onClick={onRejectIndent}
                  title="Kills the entire indent — the user's original request is rejected outright. Use only when the request shouldn't have been raised at all."
                  className="px-3 py-1.5 text-xs font-bold bg-red-600 text-white rounded hover:bg-red-700 transition-colors shadow-sm">Reject indent</button>
              )}
              {onRejectQuote && activeQuotation && (
                <button onClick={onRejectQuote}
                  title="Sends the firm quote back to procurement to re-quote. The user's original request stays alive."
                  className="px-3 py-1.5 text-xs font-bold bg-amber-700 text-white rounded hover:bg-amber-800 transition-colors shadow-sm">Send to re-quote</button>
              )}
              {onApprove && (() => {
                // `dirty` blocks approval in the PROCUREMENT lane, where the
                // vendor split has its own Save and approving around it would
                // sign off numbers that were never stored. In the approver's
                // lane there is no Save — the edited quantity is applied BY
                // approving — so the same guard locks the button the moment
                // the quantity is touched, which is exactly when it is needed.
                const blocked = !!approveBlockedReason || needsSelection || (dirty && !canEditQty);
                return (
                  <button onClick={handleApprove}
                    disabled={blocked}
                    title={approveBlockedReason
                      ? approveBlockedReason
                      : needsSelection ? 'Pick the vendor(s) for each multi-option item + confirm the selection above before approving.'
                      : blocked ? 'Save your quantity/vendor changes above before approving.' : undefined}
                    className={`px-4 py-1.5 text-xs font-bold rounded transition-colors shadow-sm ${blocked ? 'bg-line text-faint cursor-not-allowed' : 'bg-emerald-700 text-white hover:bg-emerald-800'}`}>Approve</button>
                );
              })()}
            </div>
          </div>
        ) : (
          <p className="text-[10px] text-faint text-center italic pt-2 border-t border-line-soft">
            Read-only view.
          </p>
        )}
      </div>
    </Modal>
  );
};
