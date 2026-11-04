import { DataTable, Modal, PendingCell, Pagination, SlipDownloadButtons } from '@/components/ui';
import { IndentItemAttachment } from './IndentItemAttachment';
import type { KnownVendor } from '@/features/vendors';
import { useClientPagination } from '@/hooks';
import { EditableCell } from '@/components/ui/EditableCell';
import { ExternalLink } from 'lucide-react';
import { VendorAllocationPanel } from '../components/VendorAllocationPanel';
import { QuotationHistoryPanel } from './QuotationHistoryPanel';
import { BomVendorOrdersTable } from './BomVendorOrdersTable';
import { ViewReceiptLink } from './ViewReceiptLink';
import { RefundStatusBadge } from './RefundStatusBadge';
import { fmtDateTime } from '@/utils/date';
import { statusReasonForIndent } from '@/utils/pendingReason';
import { ALLOWED_CURRENCIES, rollupTotals, rollupWithVendorGst, ceoThresholdMoney, ceoGateCoversEverything } from '@/config/thresholds';

interface ApprovalCellProps {
  status: string;
  timestamp?: string;
  approverName?: string;
}

const ApprovalCell = ({ status, timestamp, approverName }: ApprovalCellProps) => {
  const colors: Record<string, string> = {
    PENDING: 'bg-yellow-100 dark:bg-yellow-400/20 text-yellow-800 dark:text-yellow-200',
    APPROVED: 'bg-green-100 dark:bg-green-400/20 text-green-800 dark:text-green-200',
    REJECTED: 'bg-red-100 dark:bg-red-400/20 text-red-800 dark:text-red-200',
  };
  return (
    <div className="flex flex-col items-start gap-0.5">
      <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold ${colors[status] || 'bg-hover text-secondary'}`}>
        {status}
      </span>
      {approverName && <span className="text-[10px] text-muted">{approverName}</span>}
      {timestamp && <span className="text-[10px] text-faint">{fmtDateTime(timestamp)}</span>}
    </div>
  );
};

export { ApprovalCell };

interface IndentDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedIndent: any;
  indentItems: any[];
  onItemEdit: (itemId: string, field: string, val: any) => void;
  onSaveChanges: () => void;
  isSavingItems?: boolean;
  /** True when there are unsaved edits in the items table. */
  hasDirtyItems?: boolean;
  // Vendor allocation props
  allocations: any[];
  knownVendors: KnownVendor[];
  onSaveVendorToList?: (name: string) => Promise<void>;
  onAddAllocationRow: (itemId: string, vendorName: string) => void;
  onUpdateAllocation: (idx: number, field: string, value: any) => void;
  onSetVendorGst?: (vendorName: string, currency: string, gstPercentage: number | null) => void;
  onSetVendorShipping?: (vendorName: string, currency: string, shippingCost: number | null) => void;
  onRemoveAllocation: (idx: number) => void;
  onSaveAllocations: () => void;
  onFinalizeQuotation: () => void;
  /** Advance a single vendor order's status from the BOM table. Resolves after
   *  the server confirms + the modal refreshes. */
  onUpdateVendorOrderStatus?: (orderId: string, status: string) => Promise<void>;
  /** Placing an order (PAID→ORDERED) needs an ETA + tracking, so the BOM table
   *  routes it here to open the per-vendor "Mark ordered" modal. */
  onMarkVendorOrderOrdered?: (orderId: string) => void;
  /** True for roles allowed to advance vendor-order status (PROCUREMENT /
   *  FINANCE / SUPER_ADMIN). */
  canUpdateVendorOrderStatus?: boolean;
  /** Open the per-line shipment tracker (In transit / Customs / Reached + ETA)
   *  for this indent. Surfaced from ORDERED / IN_TRANSIT vendor-order rows —
   *  that's where the retired manual IN_TRANSIT/RECEIVED dropdown moves live. */
  onTrackShipment?: () => void;
  /** 'view' (default) = read-only summary of the original indent.
   *  'quote' = procurement's editable working quotation (items + vendor
   *  allocations + Save/Finalise actions). Picked by the parent based on
   *  which button was clicked. */
  mode?: 'view' | 'quote';
}

export const IndentDetailsModal = ({
  isOpen,
  onClose,
  selectedIndent,
  indentItems,
  onItemEdit,
  onSaveChanges,
  isSavingItems = false,
  hasDirtyItems = false,
  allocations,
  knownVendors,
  onSaveVendorToList,
  onAddAllocationRow,
  onUpdateAllocation,
  onSetVendorGst,
  onSetVendorShipping,
  onRemoveAllocation,
  onSaveAllocations,
  onFinalizeQuotation,
  onUpdateVendorOrderStatus,
  onMarkVendorOrderOrdered,
  canUpdateVendorOrderStatus = false,
  onTrackShipment,
  mode = 'view',
}: IndentDetailsModalProps) => {
  const isQuoteMode = mode === 'quote';
  // Paginate the line-items table (10/page) so a large BOM-spawned indent
  // (can be 100+ lines) doesn't flood the DOM. Full set stays in memory for
  // the grand-total / drift / allocation rollups below. Reset to page 1 when
  // a different indent is opened.
  const itemsPager = useClientPagination<any>(indentItems, 10, selectedIndent?.id);
  // Items are editable only in quote mode AND while the indent is still in
  // pre-payment stages. View mode is always read-only. Once payment has been
  // processed, edits are locked even in quote mode.
  const itemsLocked = !isQuoteMode || (!!selectedIndent &&
    !['PENDING', 'APPROVED', 'QUOTATION_IN_PROGRESS'].includes(selectedIndent.status));

  // Live rollup of vendor allocations per indent-item id. Used to project the
  // Unit Price + Total cells in the items table while procurement is typing
  // allocations — without this, Unit Price stayed at 0 (the original Price
  // TBD value) until Save Allocations fired and the backend wrote back.
  // Each vendor row carries its own currency, so an item's total rolls up its
  // rows currency-aware (uniform → native; mixed → INR). We keep the per-row
  // currency-tagged lines so effectiveFor can derive both total + currency.
  const allocByItem: Record<string, { qty: number; lines: { total: number; currency: string }[] }> = {};
  for (const a of allocations || []) {
    const k = a.indentItemId;
    if (!allocByItem[k]) allocByItem[k] = { qty: 0, lines: [] };
    allocByItem[k].qty += Number(a.allocatedQty) || 0;
    allocByItem[k].lines.push({ total: (Number(a.allocatedQty) || 0) * (Number(a.unitPrice) || 0), currency: a.currency });
  }
  // For each row, an "effective" unit price + total that the table renders.
  // Whenever vendor allocations exist for the line we project from them — in
  // Quote mode that's the live preview procurement is editing; in View mode
  // it's the firm quote already saved. Either way the firm-quoted price is the
  // number people actually want to see, so it wins over the line's own (often
  // 0 / "price TBD") value. The original ask is still surfaced inline via the
  // "orig" hint on the cells below, and stays untouched in the DB.
  const effectiveFor = (row: any) => {
    const r = allocByItem[row.id];
    if (r && r.qty > 0) {
      const roll = rollupTotals(r.lines); // mixed vendor currencies → INR
      const unit = roll.grandTotal / r.qty;
      return { qty: Number(row.qty) || 0, unit, total: roll.grandTotal, currency: roll.currency, fromAllocations: true };
    }
    const qty = Number(row.qty) || 0;
    const unit = Number(row.unitPrice ?? row.unitAmount) || 0;
    return { qty, unit, total: qty * unit, currency: (row.currency || 'INR'), fromAllocations: false };
  };

  const detailColumns = [
    // Global row number, not the page-local index — DataTable passes a
    // page-local idx, so without the page offset page 2 restarted at 1.
    { header: 'S.No', accessor: (_row: any, idx?: number) => String((itemsPager.page - 1) * itemsPager.pageSize + (idx || 0) + 1) },
    { header: 'Item Name', accessor: (row: any) => (
      <EditableCell readOnly={itemsLocked} value={row.name || 'N/A'} onSave={(val) => onItemEdit(row.id, 'name', val)} />
    )},
    { header: 'Description', accessor: (row: any) => (
      <EditableCell readOnly={itemsLocked} value={row.description || 'N/A'} onSave={(val) => onItemEdit(row.id, 'description', val)} />
    )},
    // Read-only: procurement reads the requester's justification while sourcing
    // but doesn't edit it. Falls back to an em-dash when blank.
    { header: 'Purpose', accessor: (row: any) => (
      <span className="block max-w-[180px] truncate text-xs text-muted" title={row.purpose || ''}>{row.purpose || '—'}</span>
    )},
    { header: 'Part Number', accessor: (row: any) => (
      <EditableCell readOnly={itemsLocked} value={row.partNumber || 'N/A'} onSave={(val) => onItemEdit(row.id, 'partNumber', val)} />
    )},
    // The requester's photo of this specific line. `attachmentMime` is the only
    // attachment field the API returns — a non-null mime means a photo exists,
    // and the path stays server-side.
    { header: 'Photo', accessor: (row: any) => (
      <IndentItemAttachment
        indentId={selectedIndent?.id}
        itemId={row.id}
        hasAttachment={!!row.attachmentMime}
      />
    )},
    { header: 'Qty', accessor: (row: any) => {
      const original = row.originalQty != null ? Number(row.originalQty) : null;
      const current = Number(row.qty || 0);
      const changed = original !== null && original !== current;
      return (
        <div className="flex flex-col items-start gap-0.5">
          <EditableCell readOnly={itemsLocked} type="number" value={current} onSave={(val) => onItemEdit(row.id, 'qty', val)} />
          {changed && (
            <span title={`Originally raised at ${original} ${row.unit || ''}. Current value is ${current} after edits.`}
              className="text-[10px] font-bold text-amber-700 dark:text-amber-300 cursor-help">
              orig {original}
            </span>
          )}
        </div>
      );
    }},
    // Currency is per-line and procurement-editable while quoting. Once the
    // item has vendor rows, its currency is DERIVED from them (mixed vendor
    // currencies → INR), so it goes read-only here — edit it on the vendor
    // rows below. Read-only too outside quote mode / once locked.
    { header: 'Currency', accessor: (row: any) => {
      const eff = effectiveFor(row);
      if (eff.fromAllocations) {
        return (
          <div className="flex flex-col items-start gap-0.5">
            <span className="text-xs font-bold text-ink">{(eff.currency || 'INR').toUpperCase()}</span>
            <span className="text-[9px] font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wider">from allocations</span>
          </div>
        );
      }
      const cur = (row.currency || 'INR').toUpperCase();
      if (itemsLocked) {
        return <span className="text-xs font-bold text-ink">{cur}</span>;
      }
      return (
        <select
          value={ALLOWED_CURRENCIES.includes(cur) ? cur : 'INR'}
          onChange={(e) => onItemEdit(row.id, 'currency', e.target.value)}
          className="px-1.5 py-1 border rounded text-xs font-bold bg-card focus:border-brand outline-none cursor-pointer"
          title="Currency for this line. Mixed-currency indents are totalled in INR.">
          {ALLOWED_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      );
    }},
    { header: 'Unit Price', accessor: (row: any) => {
      const eff = effectiveFor(row);
      if (eff.fromAllocations) {
        // Projected from vendor allocations — render read-only so the user
        // doesn't try to edit a derived value. Italic + amber chip telegraphs
        // it's coming from the allocation rows below. When the original ask
        // differed (e.g. raised at 0 / "price TBD", or a different number) we
        // surface it as an "orig" hint so the original request isn't lost.
        const origUnit = row.originalUnitAmount != null ? Number(row.originalUnitAmount) : null;
        const showOrig = origUnit != null && Math.abs(origUnit - eff.unit) > 0.005;
        return (
          <div className="flex flex-col items-start gap-0.5">
            <span className="text-sm font-bold text-ink italic"
              title="Weighted-average of unit prices from vendor allocations below. Edit the allocation rows to change this — it'll be persisted on Save Allocations.">
              {eff.unit.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
            <span className="text-[9px] font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wider">from firm quote</span>
            {showOrig && (
              <span className="text-[10px] text-faint" title={`Originally requested at ${origUnit.toLocaleString()} ${(row.currency || '').toUpperCase()}.`}>
                orig {origUnit.toLocaleString()}
              </span>
            )}
          </div>
        );
      }
      return (
        <EditableCell readOnly={itemsLocked} type="number" value={row.unitPrice || row.unitAmount || 0} onSave={(val) => onItemEdit(row.id, 'unitPrice', val)} />
      );
    }},
    { header: 'Total', accessor: (row: any) => {
      const eff = effectiveFor(row);
      const currency = eff.currency || 'INR';
      return (
        <span className="text-sm font-bold text-emerald-700 dark:text-emerald-300"
          title={eff.fromAllocations
            ? 'Sum of allocation line totals for this item (mixed vendor currencies are converted to INR). Edit the allocation rows to change it; it persists on Save Allocations.'
            : 'Auto-calculated from Qty × Unit Price. Edit qty or unit price to change this.'}>
          {currency} {eff.total.toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </span>
      );
    }},
    { header: 'Website Link', accessor: (row: any) => {
      const url = row.url || '';
      const href = url && url !== 'http://' ? (url.startsWith('http') ? url : `https://${url}`) : '';
      // Procurement needs to paste vendor product pages here while
      // quoting (so reviewers can click through to verify prices).
      // When the row is locked (finalised / approved) we fall back to
      // the read-only link display — same look as before.
      if (itemsLocked) {
        return (
          <div className="max-w-[180px] overflow-hidden flex items-center gap-1">
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-xs text-blue-600 dark:text-blue-300 hover:underline truncate flex-1">{url}</a>
            ) : (
              <span className="text-xs text-faint flex-1">No link</span>
            )}
          </div>
        );
      }
      return (
        <div className="max-w-[200px] flex items-center gap-1">
          <div className="flex-1 min-w-0">
            {url ? (
              <EditableCell
                value={url}
                onSave={(val) => onItemEdit(row.id, 'url', String(val || '').trim())}
              />
            ) : (
              // Empty-state — show a clickable "Paste URL…" hint so the
              // cell is visible + obviously editable. Same EditableCell
              // underneath, just rendered with a placeholder string that
              // the user can click and overwrite.
              <EditableCell
                value="Paste vendor URL…"
                className="italic text-faint"
                onSave={(val) => {
                  const trimmed = String(val || '').trim();
                  // Don't save the placeholder back as the URL.
                  if (trimmed === 'Paste vendor URL…' || !trimmed) return;
                  onItemEdit(row.id, 'url', trimmed);
                }}
              />
            )}
          </div>
          {/* Quick-open icon when there IS a URL — saves the user a copy /
              paste / new-tab dance just to verify the link. */}
          {href && (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              title="Open in new tab"
              className="text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:text-blue-200 shrink-0"
            >
              <ExternalLink size={12} />
            </a>
          )}
        </div>
      );
    }}
  ];

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="3xl" title={`${selectedIndent?.serialNo || 'Indent'}${isQuoteMode ? ' · Quote' : ''}`}>
      {selectedIndent && (
        <div className="space-y-4 md:space-y-5">
          {/* Lightweight context strip — requester/dept/project + raised date on
              the left, the slip actions (View/PDF/CSV) centered, and the current
              status pill on the right. Replaces the heavy 3-cell grey grid. */}
          <div className="flex items-start justify-between gap-3 pb-3 border-b border-line-soft">
            <div className="min-w-0">
              <p className="text-sm text-muted leading-relaxed">
                Raised by <span className="font-bold text-ink">{selectedIndent?.createdBy?.name || 'Unknown'}</span>
                <span className="text-faint"> · </span>
                <span className="text-ink">{selectedIndent?.department?.name || 'Unknown'}</span>
                {selectedIndent?.project?.name && (
                  <>
                    <span className="text-faint"> · </span>
                    <span className="text-muted">{selectedIndent.project.name}</span>
                  </>
                )}
              </p>
              {selectedIndent?.createdAt && (
                <p className="text-[11px] text-faint mt-0.5">{fmtDateTime(selectedIndent.createdAt)}</p>
              )}
            </div>
            {selectedIndent?.id && (
              <div className="shrink-0 self-center">
                <SlipDownloadButtons kind="indents" id={selectedIndent.id} serialNo={selectedIndent.serialNo} size="sm" showView />
              </div>
            )}
            <div className="shrink-0 flex flex-col items-end gap-2">
              <PendingCell status={selectedIndent?.status || 'PENDING'} reason={statusReasonForIndent(selectedIndent)} />
            </div>
          </div>

          {/* Payment + refund — shown ONLY when it's actually relevant (paid /
              awaiting finance / a refund in flight). The approval status is
              already in the header pill, so the old Tech/CEO/Payment 3-card strip
              was pure repetition (and dead space) at earlier stages and has been
              dropped; only the non-redundant payment/refund detail remains. */}
          {(selectedIndent.paymentTransactionId || selectedIndent.status === 'AWAITING_PAYMENT' || (selectedIndent.refundStatus && selectedIndent.refundStatus !== 'NONE')) && (
            <div className="border border-line-soft rounded-lg p-3">
              <p className="text-[11px] font-bold text-faint mb-1">Payment</p>
              {selectedIndent.paymentTransactionId ? (
                <div className="flex flex-col items-start gap-0.5">
                  <span className="text-xs font-mono font-bold text-ink">{selectedIndent.paymentTransactionId}</span>
                  {selectedIndent.paidBy?.name && <span className="text-[10px] text-muted">by {selectedIndent.paidBy.name}</span>}
                  {selectedIndent.paidAt && <span className="text-[10px] text-faint">{new Date(selectedIndent.paidAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>}
                  {selectedIndent.paymentReceiptPath && <ViewReceiptLink indentId={selectedIndent.id} className="mt-0.5" />}
                </div>
              ) : selectedIndent.status === 'AWAITING_PAYMENT' ? (
                <span className="inline-block text-[11px] font-bold px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-400/30 self-start">Awaiting Finance</span>
              ) : null}
              {/* Refund tracking — surfaces only on cancelled paid indents
                  so the View modal mirrors the Finance receipt modal: any
                  refund still owed (or already received) is visible inline. */}
              {selectedIndent.refundStatus && selectedIndent.refundStatus !== 'NONE' && (
                <div className="mt-2 pt-2 border-t border-line-soft">
                  <p className="text-[10px] font-bold text-faint uppercase mb-1">Refund</p>
                  <RefundStatusBadge
                    status={selectedIndent.refundStatus}
                    paidAmount={selectedIndent.grandTotal}
                    receivedAmount={selectedIndent.refundReceivedAmount}
                    currency={selectedIndent.currency || 'INR'}
                  />
                  {selectedIndent.refundExpectedAmount != null && (
                    <p className="text-[10px] text-muted mt-0.5">
                      Expected {selectedIndent.currency || 'INR'} {Number(selectedIndent.refundExpectedAmount).toLocaleString('en-IN')}
                    </p>
                  )}
                  {selectedIndent.refundReceivedAmount != null && (
                    <p className="text-[10px] text-muted">
                      Received {selectedIndent.currency || 'INR'} {Number(selectedIndent.refundReceivedAmount).toLocaleString('en-IN')}
                      {selectedIndent.refundTransactionId && <> · <span className="font-mono">{selectedIndent.refundTransactionId}</span></>}
                    </p>
                  )}
                  {selectedIndent.refundReceiptPath && (
                    <ViewReceiptLink indentId={selectedIndent.id} kind="refund" className="mt-0.5" />
                  )}
                </div>
              )}
            </div>
          )}

          <div>
            {/* Two-line header: title on top, helper text under it. On narrow
                viewports the long "Read-only — items are locked…" sentence
                used to wrap awkwardly next to the heading and look like the
                title was sinking. Stacking it is cleaner and reads better. */}
            <div className="mb-3">
              <h4 className="font-bold text-ink">
                {isQuoteMode
                  ? <>Quotation items <span className="text-xs font-normal text-faint">— editable by procurement</span></>
                  : <>Indent items <span className="text-xs font-normal text-faint">— as originally requested</span></>}
              </h4>
              <p className="text-xs text-faint italic mt-0.5">
                {isQuoteMode
                  ? (itemsLocked
                      ? 'Read-only — payment has already been processed for this indent.'
                      : 'Click cell to edit · changes save on Save Edits or Finalise')
                  : 'The user\'s original request. The firm quote procurement submitted is below.'}
              </p>
            </div>

            {/* Re-quote banner — a quotation version >= 2 means a prior quote
                was rejected and bounced back. Make it explicit that this is a
                re-quote AND that finalising re-runs the approval chain, so
                procurement isn't surprised when it lands back in Tech/CEO. */}
            {isQuoteMode && (() => {
              const activeQuote = (selectedIndent?.quotations || [])[0];
              const reVersion = activeQuote ? Number(activeQuote.version) : 1;
              if (reVersion < 2) return null;
              return (
                <div className="mb-3 bg-orange-50 dark:bg-orange-400/15 border border-orange-200 dark:border-orange-400/30 rounded-md p-3">
                  <p className="text-xs font-bold text-orange-900 dark:text-orange-200">Re-quote v{reVersion}</p>
                  <p className="text-[11px] text-orange-800 dark:text-orange-200 mt-0.5">
                    A previous quotation was rejected and sent back to procurement. When you finalise this re-quote, the indent returns to <span className="font-bold">Tech</span> (and <span className="font-bold">CEO</span> {ceoGateCoversEverything() ? 'on any amount' : `if the firm total is ${ceoThresholdMoney()} or more`}) for fresh approval at the new firm price.
                  </p>
                </div>
              );
            })()}

            {/* Initial request callout — only renders in Quote mode when an
                item's current qty/price has drifted from what was originally
                raised. In View mode the items table IS the original request,
                so the callout would be redundant. */}
            {isQuoteMode && (() => {
              const drifted = indentItems.filter((it: any) => {
                const oq = it.originalQty != null ? Number(it.originalQty) : null;
                const op = it.originalUnitAmount != null ? Number(it.originalUnitAmount) : null;
                return (oq !== null && oq !== Number(it.qty)) || (op !== null && op !== Number(it.unitAmount));
              });
              if (drifted.length === 0) return null;
              return (
                <div className="mb-3 bg-blue-50 dark:bg-blue-400/15 border border-blue-200 dark:border-blue-400/30 rounded-md p-3">
                  <p className="text-xs font-bold text-blue-900 dark:text-blue-200 mb-2">Initial request <span className="text-[10px] font-normal text-blue-700 dark:text-blue-300">(snapshot from when this indent was raised — never edited)</span></p>
                  <ul className="space-y-1">
                    {drifted.map((it: any) => {
                      const oq = Number(it.originalQty ?? it.qty);
                      const op = Number(it.originalUnitAmount ?? it.unitAmount);
                      const cq = Number(it.qty);
                      const cp = Number(it.unitAmount);
                      const qtyChanged = oq !== cq;
                      const priceChanged = op !== cp;
                      return (
                        <li key={it.id} className="text-[11px] text-blue-900 dark:text-blue-200 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="font-bold">{it.name}</span>
                          <span className="text-blue-700 dark:text-blue-300">·</span>
                          <span>Qty: <span className={qtyChanged ? 'font-bold' : ''}>{oq}</span>{qtyChanged && <span className="text-amber-700 dark:text-amber-300"> → {cq}</span>} {it.unit || ''}</span>
                          <span className="text-blue-700 dark:text-blue-300">·</span>
                          <span>Unit: <span className={priceChanged ? 'font-bold' : ''}>₹{op.toLocaleString()}</span>{priceChanged && <span className="text-amber-700 dark:text-amber-300"> → ₹{cp.toLocaleString()}</span>}</span>
                          <span className="text-blue-700 dark:text-blue-300">·</span>
                          <span>Line total: <span className={qtyChanged || priceChanged ? 'font-bold' : ''}>₹{(oq * op).toLocaleString()}</span>{(qtyChanged || priceChanged) && <span className="text-amber-700 dark:text-amber-300"> → ₹{(cq * cp).toLocaleString()}</span>}</span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })()}
            {isQuoteMode && hasDirtyItems && (
              <div className="mb-3 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-md px-3 py-2 text-xs text-amber-900 dark:text-amber-200"
                title="After Finalise, the indent bounces back to the admin for re-approval at the firm quote — even when the price is unchanged.">
                <span className="font-bold">You have unsaved edits.</span>
                {' '}They'll be saved when you click <span className="font-bold">Save Edits</span> or <span className="font-bold">Finalise Quotation</span>.
              </div>
            )}
            <div className="border border-line rounded-lg overflow-hidden">
              <DataTable
                columns={detailColumns}
                data={itemsPager.pageRows}
                isLoading={false}
                keyExtractor={r => r.id}
              />
            </div>
            <Pagination currentPage={itemsPager.page} totalPages={itemsPager.totalPages} onPageChange={itemsPager.setPage} />
            {/* Grand Total — computed from local (possibly-unsaved) item state
                so it reflects what the user sees right now, not the last
                persisted snapshot. The actual indent.grandTotal updates on Save. */}
            {indentItems.length > 0 && (() => {
              // Use the same effective-rollup the cells use, so the grand
              // total stays consistent with the per-row Total column. When
              // allocations exist for an item, the projected allocation total
              // wins; otherwise fall back to qty × unitPrice from the row.
              // Currency-aware roll (mirrors the backend): uniform currency →
              // native sum in that currency; mixed → INR-normalised total.
              const roll = rollupTotals(
                indentItems.map((it: any) => { const e = effectiveFor(it); return { total: e.total, currency: e.currency }; }),
              );
              // GST-INCLUSIVE grand total when vendor allocations exist — per-
              // vendor GST is added on top of the line subtotal, mirroring the
              // backend indent.grandTotal (which drives the CEO gate + payment).
              // No allocations → no GST yet → the pre-GST line roll stands.
              const anyFromAllocations = indentItems.some((it: any) => effectiveFor(it).fromAllocations);
              const gstRoll = rollupWithVendorGst(
                (allocations || [])
                  .filter((a: any) => String(a.vendorName || '').trim() && !a.isAlternative)
                  .map((a: any) => ({ vendorName: String(a.vendorName).trim(), total: (Number(a.allocatedQty) || 0) * (Number(a.unitPrice) || 0), currency: a.currency, gstPercentage: a.gstPercentage, shippingCost: a.shippingCost })),
              );
              const hasGst = gstRoll.gstTotal > 0.005;
              const hasShipping = gstRoll.shippingTotal > 0.005;
              const grand = anyFromAllocations ? gstRoll.grandTotal : roll.grandTotal;
              const currency = anyFromAllocations ? gstRoll.currency : roll.currency;
              const isMixed = new Set(indentItems.map((it: any) => (effectiveFor(it).currency || 'INR').toUpperCase().trim())).size > 1;
              const savedGrand = Number(selectedIndent.grandTotal || 0);
              // The "(unsaved)" / "(projected)" chip only makes sense in Quote
              // mode — view mode is showing the immutable original snapshot,
              // there's nothing pending to save. In view mode also relabel as
              // "Original total" so it's clear this is the user's ask, not
              // the firm quote (which sits in its own section below).
              const drift = isQuoteMode && Math.abs(grand - savedGrand) > 0.005;
              return (
                <div className="mt-3 flex items-baseline justify-between border-t border-line-soft pt-3">
                  <span className="text-xs font-bold text-muted uppercase tracking-wider">
                    {isQuoteMode ? 'Grand Total' : 'Original total'}
                  </span>
                  <span className="text-lg font-bold text-emerald-700 dark:text-emerald-300">
                    {currency} {grand.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    {(hasGst || hasShipping) && (
                      <span className="ml-2 text-[10px] font-normal text-muted"
                        title={[
                          hasGst ? `${currency} ${gstRoll.gstTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })} GST` : '',
                          hasShipping ? `${currency} ${gstRoll.shippingTotal.toLocaleString(undefined, { maximumFractionDigits: 2 })} shipping` : '',
                        ].filter(Boolean).join(' and ') + ' across vendors.'}>
                        incl. {[hasGst ? 'GST' : '', hasShipping ? 'shipping' : ''].filter(Boolean).join(' & ')}
                      </span>
                    )}
                    {isMixed && (
                      <span className="ml-2 text-[10px] font-normal text-faint"
                        title="Lines use more than one currency, so the grand total is converted to INR at the reference rates. Each line keeps its own currency above.">
                        (mixed → INR)
                      </span>
                    )}
                    {drift && (
                      <span className="ml-2 text-[10px] font-normal text-amber-700 dark:text-amber-300"
                        title={anyFromAllocations
                          ? `Saved indent total is ${currency} ${savedGrand.toLocaleString()}. This figure is projected from your in-progress vendor allocations — it persists on Save Allocations.`
                          : `Saved total is ${currency} ${savedGrand.toLocaleString()} — click Save Edits to persist.`}>
                        {anyFromAllocations ? '(projected)' : '(unsaved)'}
                      </span>
                    )}
                  </span>
                </div>
              );
            })()}
          </div>

          {/* The BOM slip as a clean table — one row per vendor order (each a
              separate website checkout). Lists the items that vendor supplies,
              its amount + payment method, and a per-row Status updated
              independently of the other rows. This is the headline view of the
              vendor breakdown; the detailed firm-quote rollup stays below. */}
          {!isQuoteMode && allocations && allocations.length > 0 && (
            <div className="mt-4">
              <div className="mb-2">
                <h4 className="font-bold text-ink">Vendor orders <span className="text-xs font-normal text-faint">— one row per supplier · status tracked per order</span></h4>
                <p className="text-xs text-faint italic mt-0.5">Each vendor is a separate order (its own checkout, payment + tracking). Update each one's status on its own row.</p>
              </div>
              <BomVendorOrdersTable
                allocations={allocations}
                indentItems={indentItems}
                vendorOrders={selectedIndent?.vendorOrders || []}
                canUpdateStatus={canUpdateVendorOrderStatus}
                onUpdateStatus={onUpdateVendorOrderStatus}
                onMarkOrdered={onMarkVendorOrderOrdered}
                onTrackShipment={onTrackShipment}
              />
            </div>
          )}

          {/* View-mode firm-quote section — read-only display of what
              procurement has quoted. Lets everyone (especially procurement
              after they've submitted) see the firm quote without needing to
              jump into edit mode. Only renders when allocations exist. */}
          {!isQuoteMode && allocations && allocations.length > 0 && (() => {
            const allocsByItem: Record<string, any[]> = {};
            for (const a of allocations) {
              if (!allocsByItem[a.indentItemId]) allocsByItem[a.indentItemId] = [];
              allocsByItem[a.indentItemId].push(a);
            }
            const itemsWithAllocs = indentItems.filter((it: any) => allocsByItem[it.id]?.length > 0);
            if (itemsWithAllocs.length === 0) return null;
            // Currency-aware firm-quote total (mirrors the backend): each VENDOR
            // row is summed in its own currency; a mixed-currency quote rolls up
            // to an INR grand total.
            const firmRoll = rollupTotals(
              allocations.map((a: any) => ({ total: (Number(a.allocatedQty) || 0) * (Number(a.unitPrice) || 0), currency: a.currency })),
            );
            const firmGrand = firmRoll.grandTotal;
            const firmMixed = new Set(allocations.map((a: any) => (a.currency || 'INR').toUpperCase().trim())).size > 1;
            return (
              <div className="mt-4">
                <div className="flex items-center gap-2 mb-1">
                  <h4 className="font-bold text-ink">Firm quote <span className="text-xs font-normal text-faint">— what procurement quoted</span></h4>
                </div>
                <div className="border border-emerald-200 dark:border-emerald-400/30 bg-emerald-50/30 dark:bg-emerald-400/15 rounded-md divide-y divide-emerald-100">
                  {itemsWithAllocs.map((it: any) => {
                    const allocs = allocsByItem[it.id];
                    const allocQty = allocs.reduce((s: number, a: any) => s + (Number(a.allocatedQty) || 0), 0);
                    // Line total rolls the item's vendor rows by their own
                    // currency: uniform → native; mixed → INR.
                    const lineRoll = rollupTotals(allocs.map((a: any) => ({ total: (Number(a.allocatedQty) || 0) * (Number(a.unitPrice) || 0), currency: a.currency })));
                    const allocTotal = lineRoll.grandTotal;
                    const currency = lineRoll.currency;
                    const lineMixed = new Set(allocs.map((a: any) => (a.currency || 'INR').toUpperCase().trim())).size > 1;
                    const avgUnit = allocQty > 0 ? allocTotal / allocQty : 0;
                    const origQty = Number(it.originalQty ?? it.qty);
                    const reservedForRequester = it.assignedToUserQty != null ? Number(it.assignedToUserQty) : Math.min(allocQty, origQty);
                    const toGeneralStock = Math.max(0, allocQty - reservedForRequester);
                    return (
                      <div key={it.id} className="p-3 text-xs">
                        <p className="font-bold text-ink">{it.name}</p>
                        <div className="mt-1 grid grid-cols-3 gap-2 text-[11px]">
                          <div>
                            <p className="text-[10px] text-muted uppercase tracking-wider font-bold">Qty bought</p>
                            <p className="font-bold text-ink">{allocQty} {it.unit || ''}</p>
                          </div>
                          <div>
                            <p className="text-[10px] text-muted uppercase tracking-wider font-bold">Avg unit price</p>
                            <p className="font-bold text-ink" title={lineMixed ? 'This item mixes vendor currencies, so the average is shown in INR.' : undefined}>{currency} {avgUnit.toLocaleString(undefined, { maximumFractionDigits: 2 })}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-[10px] text-muted uppercase tracking-wider font-bold">Line total</p>
                            <p className="font-bold text-emerald-700 dark:text-emerald-300" title={lineMixed ? 'Vendors quoted this item in more than one currency, so the line total is converted to INR.' : undefined}>{currency} {allocTotal.toLocaleString()}{lineMixed && <span className="ml-1 text-[9px] font-normal text-faint">(mixed → INR)</span>}</p>
                          </div>
                        </div>
                        {/* Vendor breakdown */}
                        <div className="mt-2 border-t border-emerald-100 dark:border-emerald-400/25 pt-2">
                          <p className="text-[10px] text-muted uppercase tracking-wider font-bold mb-1">Vendors</p>
                          <ul className="space-y-0.5">
                            {allocs.map((a: any, i: number) => {
                              const vCur = (a.currency || 'INR').toUpperCase();
                              return (
                              <li key={i} className="flex items-center justify-between text-[11px] text-ink">
                                <span className="font-bold">{a.vendorName}</span>
                                <span className="text-muted font-mono">{Number(a.allocatedQty)} × {vCur} {Number(a.unitPrice || 0).toLocaleString()} = <span className="font-bold text-emerald-700 dark:text-emerald-300">{vCur} {Number(a.total || 0).toLocaleString()}</span></span>
                              </li>
                              );
                            })}
                          </ul>
                        </div>
                        {/* User assignment split (when there's stock-up) */}
                        {toGeneralStock > 0 && (
                          <div className="mt-2 border-t border-emerald-100 dark:border-emerald-400/25 pt-2 text-[11px]">
                            <p className="text-[10px] text-muted uppercase tracking-wider font-bold mb-1">Assignment</p>
                            <p className="text-ink">
                              <span className="font-bold">{reservedForRequester}</span> {it.unit || ''} reserved for requester
                              <span className="text-faint"> · </span>
                              <span className="font-bold">{toGeneralStock}</span> {it.unit || ''} to general stock
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div className="p-3 bg-emerald-100/40 dark:bg-emerald-400/15 flex items-baseline justify-between">
                    <span className="text-xs font-bold text-emerald-900 dark:text-emerald-200 uppercase tracking-wider">Firm quote total</span>
                    <span className="text-base font-bold text-emerald-700 dark:text-emerald-300">
                      {firmRoll.currency} {firmGrand.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      {firmMixed && (
                        <span className="ml-2 text-[10px] font-normal text-faint" title="Lines use more than one currency, so the total is converted to INR at the reference rates.">
                          (mixed → INR)
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Vendor allocations + Save/Finalise live only in the Quote
              experience. View is a clean read-only summary of the indent
              + approval state, no clutter. */}
          {isQuoteMode && (
            <>
              <VendorAllocationPanel
                selectedIndent={selectedIndent}
                indentItems={indentItems}
                allocations={allocations}
                knownVendors={knownVendors}
                onSaveVendorToList={onSaveVendorToList}
                onAddAllocationRow={onAddAllocationRow}
                onUpdateAllocation={onUpdateAllocation}
                onSetVendorGst={onSetVendorGst}
                onSetVendorShipping={onSetVendorShipping}
                onRemoveAllocation={onRemoveAllocation}
                onSaveAllocations={onSaveAllocations}
              />

              <div className="flex flex-wrap justify-end gap-3 pt-4 border-t border-line-soft mt-4">
                {!itemsLocked && (
                  <button
                    onClick={onSaveChanges}
                    disabled={isSavingItems}
                    className="bg-hover text-ink border border-line px-5 py-2 rounded-md text-sm font-bold hover:bg-line transition-colors shadow-sm disabled:opacity-60 disabled:cursor-not-allowed whitespace-nowrap"
                  >
                    {isSavingItems ? 'Saving…' : 'Save Edits'}
                  </button>
                )}
                {selectedIndent.status === 'QUOTATION_IN_PROGRESS' && (() => {
                  // Gate Finalise on having at least one vendor allocation
                  // saved. Without this the backend throws a 400 — surface
                  // that constraint up front so procurement isn't clicking a
                  // button that's destined to fail. Tooltip explains the
                  // next action.
                  const hasAllocations = (allocations || []).length > 0;
                  return (
                    <button
                      onClick={onFinalizeQuotation}
                      disabled={!hasAllocations}
                      title={hasAllocations
                        ? 'Lock in the firm quote and move the indent forward.'
                        : 'Assign vendors to at least one line below and click "Save Allocations" before finalising.'}
                      className="bg-brand text-white px-5 py-2 rounded-full text-sm font-bold hover:bg-brand-dark transition-colors shadow-sm border border-brand whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-brand"
                    >
                      Finalise Quotation
                    </button>
                  );
                })()}
              </div>
            </>
          )}

          {/* Procurement's record of every quote slip they worked on — all
              quotation versions, each viewable + downloadable (PDF/CSV). Shown
              once at least one quotation exists; lazy-loads on expand. */}
          {selectedIndent?.id && (selectedIndent?.quotations?.length ?? 0) > 0 && (
            <div className="mt-4">
              <QuotationHistoryPanel indentId={selectedIndent.id} serialNo={selectedIndent.serialNo} />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
};
