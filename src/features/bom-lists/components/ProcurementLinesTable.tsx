import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { NumberInput, Pagination } from '@/components/ui';
import { ALLOWED_CURRENCIES } from '@/config/thresholds';
import { Trash2, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import { RoutingChip, ReviewChip, LineRejectNote } from './BomLineChips';

interface ProcurementLinesTableProps {
  canEdit: boolean;
  /** The BOM list — used for the shared-purpose inherit hint on the expander. */
  list: any;
  indentPager: any;
  customPager: any;
  filteredIndentItems: any[];
  filteredCustomItems: any[];
  selectedLines: Set<string>;
  selKey: (table: 'indent' | 'request', id: string) => string;
  renderSelCell: (table: 'indent' | 'request', id: string, n: number) => ReactNode;
  renderSelAllHeader: (ids: string[]) => ReactNode;
  qtyDraft: Record<string, number>;
  setQtyDraft: Dispatch<SetStateAction<Record<string, number>>>;
  flashLineId: string | null;
  commitQty: (lineId: string) => void;
  openProcDetails: Record<string, boolean>;
  setOpenProcDetails: Dispatch<SetStateAction<Record<string, boolean>>>;
  urlAdvisory: { isDup: (raw: any) => boolean; missing: number; dupUrls: number };
  patchInvItem: (lineId: string, payload: any) => void;
  patchCustomItem: (customId: string, payload: any) => void;
  commitVendorUrl: (el: HTMLInputElement, current: string | null | undefined, save: (url: string) => void) => void;
  dropProcurementPortion: (lineId: string, stock: number, shortfall: number) => void;
  removeLine: (lineId: string) => void;
  removeCustom: (customId: string) => void;
  itemQuery: string;
  itemSearch: string;
}

/**
 * Combined indent-bound list as a single table: out-of-stock
 * inventory rows first, then custom items, under one aligned
 * column header (Item · Qty · Vendor URL · Description · Actions) —
 * one row per item, all columns centre-aligned. The vendor URL and
 * the free-text description each sit in their own column so buyers
 * see the link and the requested model/variant/spec at a glance.
 * Price / purpose / part number stay in the per-row expander so the
 * table stays compact even for 200+ line BOMs. Scrolls horizontally
 * on very narrow screens.
 */
export const ProcurementLinesTable = ({
  canEdit,
  list,
  indentPager,
  customPager,
  filteredIndentItems,
  filteredCustomItems,
  selectedLines,
  selKey,
  renderSelCell,
  renderSelAllHeader,
  qtyDraft,
  setQtyDraft,
  flashLineId,
  commitQty,
  openProcDetails,
  setOpenProcDetails,
  urlAdvisory,
  patchInvItem,
  patchCustomItem,
  commitVendorUrl,
  dropProcurementPortion,
  removeLine,
  removeCustom,
  itemQuery,
  itemSearch,
}: ProcurementLinesTableProps) => {
  return (
              <div className="border border-amber-100 dark:border-amber-400/25 rounded-md max-h-[46vh] overflow-auto bg-amber-50/10 dark:bg-amber-400/15">
                <div className="min-w-[880px]">
                {/* Column header — one aligned grid template shared by every row
                    below, so the whole list reads as a single table. Scrolls
                    horizontally on very narrow screens instead of clustering. */}
                <div className="grid grid-cols-[32px_minmax(0,1.1fr)_96px_minmax(170px,1fr)_minmax(160px,1fr)_56px] gap-x-3 items-center px-3 py-1.5 bg-amber-50 dark:bg-amber-400/15 border-b border-amber-100 dark:border-amber-400/25 sticky top-0 z-10 text-[10px] font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wide text-center">
                  {renderSelAllHeader([...filteredIndentItems.map((l: any) => selKey('indent', l.id)), ...filteredCustomItems.map((c: any) => selKey('indent', c.id))])}
                  <span>Item</span>
                  <span>Qty</span>
                  <span className="text-left">Vendor URL</span>
                  <span>Description</span>
                  <span>Actions</span>
                </div>
                {/* Out-of-stock inventory items — flagged for indent because
                    qty > stock. */}
                {indentPager.pageRows.map((line: any, i: number) => {
                  const idx = (indentPager.page - 1) * indentPager.pageSize + i;
                  const stock = Number(line.inventoryItem?.stock || 0);
                  const qty = qtyDraft[line.id] ?? Number(line.qty);
                  // Split line (some stock): the Indent-bound row represents ONLY
                  // the procured shortfall — the in-stock part is a request shown
                  // under Request-bound. So the qty field here is the shortfall,
                  // and editing it sets the line's total = stock + shortfall.
                  const isSplit = stock > 0;
                  const procuredQty = isSplit ? qty - stock : qty;
                  const detailsOpen = !!openProcDetails[line.id];
                  const urlMissing = !String(line.url || '').trim();
                  const urlDup = urlAdvisory.isDup(line.url);
                  return (
                    <div key={line.id} className={`px-3 py-2 text-sm border-b border-amber-50 dark:border-amber-400/25 last:border-b-0 ${selectedLines.has(selKey('indent', line.id)) ? 'bg-brand-50' : ''}`}>
                      <div className="grid grid-cols-[32px_minmax(0,1.1fr)_96px_minmax(170px,1fr)_minmax(160px,1fr)_56px] gap-x-3 items-center">
                        {/* S.No / select */}
                        <div className="flex items-center justify-center">{renderSelCell('indent', line.id, idx + 1)}</div>
                        {/* Item */}
                        <div className="min-w-0 text-center">
                          <div className="flex items-center justify-center gap-2 flex-wrap">
                            <p className="font-medium text-ink truncate">{line.inventoryItem?.name || 'Unknown'}</p>
                            <RoutingChip kind={stock > 0 ? 'indent-split' : 'indent-short'} />
                            <ReviewChip status={line.reviewStatus} />
                          </div>
                          <p className="text-[10px] text-faint truncate">
                            {line.inventoryItem?.category?.replace(/_/g, ' ')} · stock {stock} {line.inventoryItem?.unit}
                          </p>
                          <LineRejectNote status={line.reviewStatus} note={line.reviewNote} />
                        </div>
                        {/* Qty — the procured shortfall for a split (total = stock +
                            this), or the full qty for a pure out-of-stock line.
                            data-indent-qty + the flash ring let the Request-bound
                            mirror "jump here to edit". */}
                        <div data-indent-qty={line.id} className="relative flex items-center justify-center gap-1">
                          {flashLineId === line.id && (
                            <span className="absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-amber-700 text-white text-[10px] font-bold px-1.5 py-0.5 shadow z-10 animate-pulse">
                              Edit here ✏️
                            </span>
                          )}
                          {canEdit ? (
                            <NumberInput
                              min={1}
                              value={procuredQty}
                              onChange={(v) => setQtyDraft(d => ({ ...d, [line.id]: isSplit ? stock + Number(v || 0) : Number(v || 0) }))}
                              onBlur={() => commitQty(line.id)}
                              className={`w-14 px-2 py-1 border rounded text-xs text-center outline-none transition-shadow ${flashLineId === line.id ? 'border-amber-500 ring-2 ring-amber-400' : 'border-line focus:border-amber-500'}`}
                            />
                          ) : (
                            <span className="font-mono font-bold text-ink">{isSplit ? Number(line.qty) - stock : Number(line.qty)}</span>
                          )}
                          <span className="text-[10px] text-faint w-7 truncate">{line.inventoryItem?.unit}</span>
                        </div>
                        {/* Vendor URL — amber border when empty (procurement sources it
                            blind); red when the same URL sits on another line (hard block). */}
                        <div className="min-w-0">
                          {canEdit ? (
                            <input
                              type="url"
                              defaultValue={line.url || ''}
                              onBlur={(e) => commitVendorUrl(e.currentTarget, line.url, (url) => patchInvItem(line.id, { url }))}
                              placeholder="https://…"
                              title={line.url || ''}
                              className={`w-full border rounded py-1 px-2 text-xs outline-none focus:border-amber-500 ${urlDup ? 'border-red-400 bg-red-50/60 dark:bg-red-400/15' : urlMissing ? 'border-amber-400 bg-amber-50/60 dark:bg-amber-400/15' : 'border-line'}`}
                            />
                          ) : line.url ? (
                            <a href={line.url} target="_blank" rel="noopener noreferrer"
                              className="block text-xs text-amber-700 dark:text-amber-300 hover:underline truncate">{line.url}</a>
                          ) : (
                            <span className="block text-xs text-faint italic">—</span>
                          )}
                        </div>
                        {/* Description / note — surfaced inline (was buried in the
                            expander) so there's an obvious place to specify a model /
                            variant / spec. Carries onto the spawned IndentItem.description. */}
                        <div className="min-w-0">
                          {canEdit ? (
                            <input
                              type="text"
                              defaultValue={line.notes || ''}
                              onBlur={(e) => patchInvItem(line.id, { notes: e.currentTarget.value })}
                              placeholder="Model / variant / spec…"
                              title={line.notes || ''}
                              className="w-full border border-line rounded py-1 px-2 text-xs text-center focus:border-amber-500 outline-none"
                            />
                          ) : line.notes ? (
                            <span className="block text-xs text-muted truncate text-center" title={line.notes}>{line.notes}</span>
                          ) : (
                            <span className="block text-xs text-faint italic text-center">—</span>
                          )}
                        </div>
                        {/* Actions */}
                        <div className="flex items-center justify-center">
                          {canEdit && (
                            <button
                              onClick={() => setOpenProcDetails(s => ({ ...s, [line.id]: !s[line.id] }))}
                              title={detailsOpen ? 'Hide procurement details' : 'Add procurement details (price, purpose)'}
                              className="text-faint hover:text-amber-700 dark:text-amber-300 p-1"
                            >
                              {detailsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          )}
                          {canEdit && (
                            <button
                              onClick={() => isSplit
                                ? dropProcurementPortion(line.id, stock, procuredQty)
                                : removeLine(line.id)}
                              title={isSplit
                                ? `Drop the ${procuredQty} procured — the ${stock} in stock stays as a request. To remove the whole item, use the delete on its Request-bound row.`
                                : 'Remove from list'}
                              className="text-faint hover:text-red-700 dark:text-red-300 p-1"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                      {urlDup ? (
                        <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-red-700 dark:text-red-300">
                          <AlertTriangle size={11} className="shrink-0" /> Duplicate link — this URL is also on another line. Two products can't share a URL, so fix one before submitting.
                        </p>
                      ) : urlMissing ? (
                        <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                          <AlertTriangle size={11} className="shrink-0" /> No vendor link — procurement will have to source this without a reference.
                        </p>
                      ) : null}
                      {canEdit && detailsOpen && (
                        <div className="mt-2 ml-2 pl-3 border-l-2 border-amber-200 dark:border-amber-400/30 bg-amber-50/30 dark:bg-amber-400/15 rounded-r p-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                          <div className="grid grid-cols-[1fr_auto] gap-2">
                            <div>
                              <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Est. unit price</label>
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                defaultValue={line.estimatedUnitAmount ?? ''}
                                onBlur={(e) => {
                                  const v = e.currentTarget.value;
                                  patchInvItem(line.id, { estimatedUnitAmount: v === '' ? 0 : Number(v) });
                                }}
                                placeholder="0.00"
                                className="w-full border border-line rounded py-1 px-2 text-xs focus:border-amber-500 outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Currency</label>
                              <select
                                value={line.currency || 'INR'}
                                onChange={(e) => patchInvItem(line.id, { currency: e.target.value })}
                                title="Currency this estimated price is in — non-INR converts to INR in the BOM totals"
                                className="w-full border border-line rounded py-1 px-2 text-xs focus:border-amber-500 outline-none">
                                {ALLOWED_CURRENCIES.map((c) => (
                                  <option key={c} value={c}>{c}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Purpose (for procurement)</label>
                            <input
                              type="text"
                              defaultValue={line.purpose || ''}
                              onBlur={(e) => patchInvItem(line.id, { purpose: e.currentTarget.value })}
                              placeholder={list?.purpose ? `Inherits: ${list.purpose}` : 'Why this is needed'}
                              title={list?.purpose ? `Leave blank to inherit the BOM's shared purpose: ${list.purpose}` : ''}
                              className="w-full border border-line rounded py-1 px-2 text-xs focus:border-amber-500 outline-none"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {indentPager.totalPages > 1 && (
                  <Pagination currentPage={indentPager.page} totalPages={indentPager.totalPages} onPageChange={indentPager.setPage} />
                )}

                {/* Custom items — same row shape as out-of-stock items but
                    styled with sky tints so the user can visually
                    distinguish "not in our catalog" from "in catalog but
                    we're short". URL inline here too. */}
                {customPager.pageRows.map((cust: any, i: number) => {
                  const idx = (customPager.page - 1) * customPager.pageSize + i;
                  const detailsOpen = !!openProcDetails[`custom:${cust.id}`];
                  const urlMissing = !String(cust.url || '').trim();
                  const urlDup = urlAdvisory.isDup(cust.url);
                  return (
                    <div key={cust.id} className={`px-3 py-2 text-sm border-b border-amber-50 dark:border-amber-400/25 last:border-b-0 ${selectedLines.has(selKey('indent', cust.id)) ? 'bg-brand-50' : 'bg-sky-50/30 dark:bg-sky-400/15'}`}>
                      <div className="grid grid-cols-[32px_minmax(0,1.1fr)_96px_minmax(170px,1fr)_minmax(160px,1fr)_56px] gap-x-3 items-center">
                        {/* S.No / select */}
                        <div className="flex items-center justify-center">{renderSelCell('indent', cust.id, filteredIndentItems.length + idx + 1)}</div>
                        {/* Item */}
                        <div className="min-w-0 text-center">
                          <div className="flex items-center justify-center gap-2 flex-wrap">
                            <p className="font-medium text-ink truncate">{cust.name}</p>
                            <RoutingChip kind="indent-custom" />
                            <ReviewChip status={cust.reviewStatus} />
                          </div>
                          <p className="text-[10px] text-faint truncate">
                            {cust.category ? cust.category.replace(/_/g, ' ') : 'No category'}
                            {cust.partNumber ? ` · ${cust.partNumber}` : ''}
                          </p>
                          <LineRejectNote status={cust.reviewStatus} note={cust.reviewNote} />
                        </div>
                        {/* Qty */}
                        <div className="flex items-center justify-center gap-1">
                          {canEdit ? (
                            <NumberInput
                              min={1}
                              value={Number(cust.qty)}
                              onChange={(v) => patchCustomItem(cust.id, { qty: v })}
                              className="w-14 px-2 py-1 border border-line rounded text-xs text-center focus:border-sky-500 outline-none"
                            />
                          ) : (
                            <span className="font-mono font-bold text-ink">{Number(cust.qty)}</span>
                          )}
                          <span className="text-[10px] text-faint w-7 truncate">{cust.unit}</span>
                        </div>
                        {/* Vendor URL */}
                        <div className="min-w-0">
                          {canEdit ? (
                            <input
                              type="url"
                              defaultValue={cust.url || ''}
                              onBlur={(e) => commitVendorUrl(e.currentTarget, cust.url, (url) => patchCustomItem(cust.id, { url }))}
                              placeholder="https://…"
                              title={cust.url || ''}
                              className={`w-full border rounded py-1 px-2 text-xs outline-none focus:border-sky-500 ${urlDup ? 'border-red-400 bg-red-50/60 dark:bg-red-400/15' : urlMissing ? 'border-amber-400 bg-amber-50/60 dark:bg-amber-400/15' : 'border-line'}`}
                            />
                          ) : cust.url ? (
                            <a href={cust.url} target="_blank" rel="noopener noreferrer"
                              className="block text-xs text-sky-700 dark:text-sky-300 hover:underline truncate">{cust.url}</a>
                          ) : (
                            <span className="block text-xs text-faint italic">—</span>
                          )}
                        </div>
                        {/* Description / note — surfaced inline (was buried in the
                            expander) so there's an obvious place to specify a model /
                            variant / spec. Carries onto the spawned IndentItem.description. */}
                        <div className="min-w-0">
                          {canEdit ? (
                            <input
                              type="text"
                              defaultValue={cust.description || ''}
                              onBlur={(e) => patchCustomItem(cust.id, { description: e.currentTarget.value })}
                              placeholder="Model / variant / spec…"
                              title={cust.description || ''}
                              className="w-full border border-line rounded py-1 px-2 text-xs text-center focus:border-sky-500 outline-none"
                            />
                          ) : cust.description ? (
                            <span className="block text-xs text-muted truncate text-center" title={cust.description}>{cust.description}</span>
                          ) : (
                            <span className="block text-xs text-faint italic text-center">—</span>
                          )}
                        </div>
                        {/* Actions */}
                        <div className="flex items-center justify-center">
                          {canEdit && (
                            <button
                              onClick={() => setOpenProcDetails(s => ({ ...s, [`custom:${cust.id}`]: !s[`custom:${cust.id}`] }))}
                              title={detailsOpen ? 'Hide details' : 'Edit price / purpose / part number'}
                              className="text-faint hover:text-sky-700 dark:text-sky-300 p-1"
                            >
                              {detailsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            </button>
                          )}
                          {canEdit && (
                            <button
                              onClick={() => removeCustom(cust.id)}
                              title="Remove from list"
                              className="text-faint hover:text-red-700 dark:text-red-300 p-1"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                      {urlDup ? (
                        <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-red-700 dark:text-red-300">
                          <AlertTriangle size={11} className="shrink-0" /> Duplicate link — this URL is also on another line. Two products can't share a URL, so fix one before submitting.
                        </p>
                      ) : urlMissing ? (
                        <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                          <AlertTriangle size={11} className="shrink-0" /> No vendor link — procurement will have to source this without a reference.
                        </p>
                      ) : null}
                      {canEdit && detailsOpen && (
                        <div className="mt-2 ml-2 pl-3 border-l-2 border-sky-200 dark:border-sky-400/30 bg-sky-50/40 dark:bg-sky-400/15 rounded-r p-2 grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                          <div className="grid grid-cols-[1fr_auto] gap-2">
                            <div>
                              <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Est. unit price</label>
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                defaultValue={cust.estimatedUnitAmount ?? ''}
                                onBlur={(e) => {
                                  const v = e.currentTarget.value;
                                  patchCustomItem(cust.id, { estimatedUnitAmount: v === '' ? 0 : Number(v) });
                                }}
                                className="w-full border border-line rounded py-1 px-2 text-xs focus:border-sky-500 outline-none"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Currency</label>
                              <select
                                value={cust.currency || 'INR'}
                                onChange={(e) => patchCustomItem(cust.id, { currency: e.target.value })}
                                className="w-full border border-line rounded py-1 px-2 text-xs focus:border-sky-500 outline-none">
                                {ALLOWED_CURRENCIES.map((c) => (
                                  <option key={c} value={c}>{c}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Purpose</label>
                            <input
                              type="text"
                              defaultValue={cust.purpose || ''}
                              onBlur={(e) => patchCustomItem(cust.id, { purpose: e.currentTarget.value })}
                              placeholder={list?.purpose ? `Inherits: ${list.purpose}` : 'Why this is needed'}
                              title={list?.purpose ? `Leave blank to inherit the BOM's shared purpose: ${list.purpose}` : ''}
                              className="w-full border border-line rounded py-1 px-2 text-xs focus:border-sky-500 outline-none"
                            />
                          </div>
                          <div>
                            <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Part number</label>
                            <input
                              type="text"
                              defaultValue={cust.partNumber || ''}
                              onBlur={(e) => patchCustomItem(cust.id, { partNumber: e.currentTarget.value })}
                              className="w-full border border-line rounded py-1 px-2 text-xs focus:border-sky-500 outline-none"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {customPager.totalPages > 1 && (
                  <Pagination currentPage={customPager.page} totalPages={customPager.totalPages} onPageChange={customPager.setPage} />
                )}
                {itemQuery && filteredIndentItems.length === 0 && filteredCustomItems.length === 0 && (
                  <div className="px-3 py-5 text-center text-faint italic text-xs">
                    No procurement-bound lines match “{itemSearch.trim()}”.
                  </div>
                )}
                </div>
              </div>
  );
};
