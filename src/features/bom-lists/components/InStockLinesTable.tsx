import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { NumberInput, Pagination } from '@/components/ui';
import { extractErrorMessage } from '@/lib';
import { Trash2 } from 'lucide-react';
import { bomListsApi } from '../services/bom-lists.api';
import { NatureToggle, RoutingChip, ReviewChip, LineRejectNote } from './BomLineChips';
import { DURATION_UNITS, durationUnitLabel } from '@/utils/duration';

interface InStockLinesTableProps {
  canEdit: boolean;
  list: any;
  setList: Dispatch<SetStateAction<any>>;
  onChanged?: () => void;
  addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  inStockPager: any;
  splitPager: any;
  filteredInStockItems: any[];
  filteredSplitLines: any[];
  selectedLines: Set<string>;
  selKey: (table: 'indent' | 'request', id: string) => string;
  renderSelCell: (table: 'indent' | 'request', id: string, n: number) => ReactNode;
  renderSelAllHeader: (ids: string[]) => ReactNode;
  qtyDraft: Record<string, number>;
  setQtyDraft: Dispatch<SetStateAction<Record<string, number>>>;
  commitQty: (lineId: string) => void;
  patchInvItem: (lineId: string, payload: any) => void;
  commitVendorUrl: (el: HTMLInputElement, current: string | null | undefined, save: (url: string) => void) => void;
  durationDraft: Record<string, number>;
  setDurationDraft: Dispatch<SetStateAction<Record<string, number>>>;
  removeLine: (lineId: string) => void;
  jumpToIndentQty: (lineId: string) => void;
  itemQuery: string;
  itemSearch: string;
}

/**
 * Request-bound (in-stock) table: lines where qty ≤ stock issue straight from
 * inventory. Split lines mirror their in-stock portion here (read-only), with
 * the shortfall procured on the Indent-bound row. Scrolls horizontally on very
 * narrow screens.
 */
export const InStockLinesTable = ({
  canEdit,
  list,
  setList,
  onChanged,
  addToast,
  inStockPager,
  splitPager,
  filteredInStockItems,
  filteredSplitLines,
  selectedLines,
  selKey,
  renderSelCell,
  renderSelAllHeader,
  qtyDraft,
  setQtyDraft,
  commitQty,
  patchInvItem,
  commitVendorUrl,
  durationDraft,
  setDurationDraft,
  removeLine,
  jumpToIndentQty,
  itemQuery,
  itemSearch,
}: InStockLinesTableProps) => {
  return (
              <div className="border border-emerald-100 dark:border-emerald-400/25 rounded-md max-h-[46vh] overflow-auto bg-emerald-50/10 dark:bg-emerald-400/15">
                <div className="min-w-[920px]">
                {/* Column header — same table treatment as the procurement list. */}
                <div className="grid grid-cols-[32px_minmax(0,1.1fr)_96px_minmax(150px,1fr)_minmax(150px,1fr)_110px_44px] gap-x-3 items-center px-3 py-1.5 bg-emerald-50 dark:bg-emerald-400/15 border-b border-emerald-100 dark:border-emerald-400/25 sticky top-0 z-10 text-[10px] font-bold text-emerald-700 dark:text-emerald-300 uppercase tracking-wide text-center">
                  {renderSelAllHeader([...filteredInStockItems.map((l: any) => selKey('request', l.id)), ...filteredSplitLines.map((l: any) => selKey('request', l.id))])}
                  <span>Item</span>
                  <span>Qty</span>
                  <span className="text-left">Vendor URL</span>
                  <span>Description</span>
                  <span>Nature</span>
                  <span>Actions</span>
                </div>
                {inStockPager.pageRows.map((line: any, i: number) => {
                  const idx = (inStockPager.page - 1) * inStockPager.pageSize + i;
                  const stock = Number(line.inventoryItem?.stock || 0);
                  const qty = qtyDraft[line.id] ?? Number(line.qty);
                  const nature = line.nature || 'PERMANENT';
                  return (
                    <div key={line.id} className={`px-3 py-2 text-sm border-b border-emerald-50 dark:border-emerald-400/25 last:border-b-0 ${selectedLines.has(selKey('request', line.id)) ? 'bg-brand-50' : ''}`}>
                      <div className="grid grid-cols-[32px_minmax(0,1.1fr)_96px_minmax(150px,1fr)_minmax(150px,1fr)_110px_44px] gap-x-3 items-center">
                        {/* S.No / select */}
                        <div className="flex items-center justify-center">{renderSelCell('request', line.id, idx + 1)}</div>
                        {/* Item */}
                        <div className="min-w-0 text-center">
                          <div className="flex items-center justify-center gap-2 flex-wrap">
                            <p className="font-medium text-ink truncate">{line.inventoryItem?.name || 'Unknown'}</p>
                            <RoutingChip kind="request" />
                            <ReviewChip status={line.reviewStatus} />
                          </div>
                          <p className="text-[10px] text-faint truncate">
                            {line.inventoryItem?.category?.replace(/_/g, ' ')} · stock {stock} {line.inventoryItem?.unit}
                          </p>
                          <LineRejectNote status={line.reviewStatus} note={line.reviewNote} />
                        </div>
                        {/* Qty */}
                        <div className="flex items-center justify-center gap-1">
                          {canEdit ? (
                            <NumberInput
                              min={1}
                              value={qty}
                              onChange={(v) => setQtyDraft(d => ({ ...d, [line.id]: v }))}
                              onBlur={() => commitQty(line.id)}
                              className="w-14 px-2 py-1 border border-line rounded text-xs text-center focus:border-emerald-500 outline-none"
                            />
                          ) : (
                            <span className="font-mono font-bold text-ink">{Number(line.qty)}</span>
                          )}
                          <span className="text-[10px] text-faint w-7 truncate">{line.inventoryItem?.unit}</span>
                        </div>
                        {/* Vendor URL — optional fallback (issued from stock; rides along
                            only if stock drops before routing and the line flips to indent). */}
                        <div className="min-w-0">
                          {canEdit ? (
                            <input
                              type="url"
                              defaultValue={line.url || ''}
                              onBlur={(e) => commitVendorUrl(e.currentTarget, line.url, (url) => patchInvItem(line.id, { url }))}
                              placeholder="https://… (used if stock drops)"
                              title={line.url || ''}
                              className="w-full border border-line rounded py-1 px-2 text-xs focus:border-emerald-500 outline-none"
                            />
                          ) : line.url ? (
                            <a href={line.url} target="_blank" rel="noopener noreferrer"
                              className="block text-xs text-emerald-700 dark:text-emerald-300 hover:underline truncate">{line.url}</a>
                          ) : (
                            <span className="block text-xs text-faint italic">—</span>
                          )}
                        </div>
                        {/* Description / note — same inline field as the procurement
                            list, surfaced here too so request-bound lines have an
                            obvious place for a model / variant / spec or any note. */}
                        <div className="min-w-0">
                          {canEdit ? (
                            <input
                              type="text"
                              defaultValue={line.notes || ''}
                              onBlur={(e) => patchInvItem(line.id, { notes: e.currentTarget.value })}
                              placeholder="Model / variant / spec…"
                              title={line.notes || ''}
                              className="w-full border border-line rounded py-1 px-2 text-xs text-center focus:border-emerald-500 outline-none"
                            />
                          ) : line.notes ? (
                            <span className="block text-xs text-muted truncate text-center" title={line.notes}>{line.notes}</span>
                          ) : (
                            <span className="block text-xs text-faint italic text-center">—</span>
                          )}
                        </div>
                        {/* Nature (Permanent / Temporary) — classification kept as the
                            trailing data column, right before the row actions. */}
                        <div className="min-w-0 flex justify-center">
                          {canEdit ? (
                            <NatureToggle
                              value={nature}
                              onChange={async (next) => {
                                try {
                                  await bomListsApi.updateItem(list.id, line.id, { nature: next });
                                  const fresh = await bomListsApi.get(list.id);
                                  setList(fresh);
                                  onChanged?.();
                                } catch (e: any) {
                                  addToast(extractErrorMessage(e, 'Failed to update nature'), 'error');
                                }
                              }}
                            />
                          ) : (
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${nature === 'PERMANENT' ? 'bg-violet-100 dark:bg-violet-400/20 text-violet-800 dark:text-violet-200' : 'bg-blue-100 dark:bg-blue-400/20 text-blue-800 dark:text-blue-200'}`}>
                              {nature === 'PERMANENT' ? 'Permanent' : 'Temporary'}
                            </span>
                          )}
                        </div>
                        {/* Actions */}
                        <div className="flex items-center justify-center">
                          {canEdit && (
                            <button
                              onClick={() => removeLine(line.id)}
                              title="Remove from list"
                              className="text-faint hover:text-red-700 dark:text-red-300 p-1"
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                      {/* Per-row loan window — only on Temporary lines. Permanent items
                          have no return window. NULL durations fall back to the BOM's
                          list-level default. Draft + onBlur so we don't PATCH per keystroke. */}
                      {nature === 'TEMPORARY' && (
                        // Loan window shares the row grid and right-aligns to end under
                        // the trailing Nature column, so it reads as a detail of that
                        // Temporary toggle directly above it instead of floating centre-screen.
                        <div className="mt-1.5 grid grid-cols-[32px_minmax(0,1.1fr)_96px_minmax(150px,1fr)_minmax(150px,1fr)_110px_44px] gap-x-3 items-center text-xs">
                          <div className="col-start-3 col-span-4 flex items-center gap-2 justify-end">
                            <label className="text-[10px] font-bold text-blue-700 dark:text-blue-300 uppercase shrink-0">Loan for</label>
                            {canEdit ? (
                              <>
                                <NumberInput
                                  min={1}
                                  integer
                                  value={durationDraft[line.id] ?? (Number(line.durationValue) || 1)}
                                  onChange={(v) => setDurationDraft(d => ({ ...d, [line.id]: v }))}
                                  onBlur={() => {
                                    const v = durationDraft[line.id];
                                    if (v != null && v !== Number(line.durationValue)) {
                                      patchInvItem(line.id, { durationValue: v });
                                    }
                                  }}
                                  className="w-16 border border-line rounded py-1 px-2 text-xs text-right focus:border-blue-500 outline-none"
                                />
                                <select
                                  value={line.durationUnit || 'DAYS'}
                                  onChange={(e) => patchInvItem(line.id, { durationUnit: e.target.value })}
                                  className="border border-line rounded py-1 px-2 text-xs focus:border-blue-500 outline-none"
                                >
                                  {DURATION_UNITS.map((u) => (
                                    <option key={u} value={u}>
                                      {durationUnitLabel(u, Number(durationDraft[line.id] ?? line.durationValue ?? 1))}
                                    </option>
                                  ))}
                                  </select>
                              </>
                            ) : (
                              <span className="text-ink font-bold">
                                {line.durationValue || 1} {String(line.durationUnit || 'DAYS').toLowerCase()}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {inStockPager.totalPages > 1 && (
                  <Pagination currentPage={inStockPager.page} totalPages={inStockPager.totalPages} onPageChange={inStockPager.setPage} />
                )}
                {/* SPLIT mirror rows — the in-stock portion of a partly-short line.
                    Read-only: the quantity is edited on the Indent-bound row (which
                    also carries the shortfall + vendor URL). Shown here so the
                    "190 issued from stock" half of a split is visible where the
                    requests actually live, not buried as a note under procurement. */}
                {splitPager.pageRows.map((line: any, i: number) => {
                  const idx = (splitPager.page - 1) * splitPager.pageSize + i;
                  const stock = Number(line.inventoryItem?.stock || 0);
                  const qty = qtyDraft[line.id] ?? Number(line.qty);
                  const inStockQty = Math.min(qty, stock);
                  return (
                    <div key={`split-mirror-${line.id}`} className={`px-3 py-2 text-sm border-b border-emerald-50 dark:border-emerald-400/25 last:border-b-0 ${selectedLines.has(selKey('request', line.id)) ? 'bg-brand-50' : 'bg-amber-50/20 dark:bg-amber-400/15'}`}>
                      <div className="grid grid-cols-[32px_minmax(0,1.1fr)_96px_minmax(150px,1fr)_minmax(150px,1fr)_110px_44px] gap-x-3 items-center">
                        {/* S.No / select — request-scoped so selecting the mirror doesn't
                            also light up the same item's Indent-bound row (and vice-versa). */}
                        <div className="flex items-center justify-center">{renderSelCell('request', line.id, filteredInStockItems.length + idx + 1)}</div>
                        <div className="min-w-0 text-center">
                          <div className="flex items-center justify-center gap-2 flex-wrap">
                            <p className="font-medium text-ink truncate">{line.inventoryItem?.name || 'Unknown'}</p>
                            <RoutingChip kind="indent-split" />
                          </div>
                          <p className="text-[10px] text-faint truncate">
                            {line.inventoryItem?.category?.replace(/_/g, ' ')} · stock {stock} {line.inventoryItem?.unit}
                          </p>
                        </div>
                        {/* Read-only qty (the in-stock part). Clicking it jumps to
                            the editable total on the Indent-bound row + flashes it. */}
                        <div className="flex items-center justify-center gap-1">
                          {canEdit ? (
                            <button
                              type="button"
                              onClick={() => jumpToIndentQty(line.id)}
                              title="Edit this item's quantity on its Indent-bound row (click to jump there)"
                              className="font-mono font-bold text-ink underline decoration-dotted decoration-amber-400 underline-offset-2 hover:text-amber-700 dark:text-amber-300 cursor-pointer"
                            >
                              {inStockQty}
                            </button>
                          ) : (
                            <span className="font-mono font-bold text-ink">{inStockQty}</span>
                          )}
                          <span className="text-[10px] text-faint w-7 truncate">{line.inventoryItem?.unit}</span>
                        </div>
                        {/* Note spanning the URL + Description columns */}
                        <div className="col-span-2 text-[10px] text-amber-700 dark:text-amber-300 italic text-center px-2">
                          Issued from stock as a request · the {qty - stock} short is procured on the Indent-bound row (edit qty there).
                        </div>
                        {/* Nature (Perm/Temp) — this is a real request, so it carries a
                            loan nature just like the other request-bound rows. Edits the
                            underlying line. */}
                        <div className="min-w-0 flex justify-center">
                          {canEdit ? (
                            <NatureToggle
                              value={line.nature || 'PERMANENT'}
                              onChange={async (next) => {
                                try {
                                  await bomListsApi.updateItem(list.id, line.id, { nature: next });
                                  const fresh = await bomListsApi.get(list.id);
                                  setList(fresh);
                                  onChanged?.();
                                } catch (e: any) {
                                  addToast(extractErrorMessage(e, 'Failed to update nature'), 'error');
                                }
                              }}
                            />
                          ) : (
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${(line.nature || 'PERMANENT') === 'PERMANENT' ? 'bg-violet-100 dark:bg-violet-400/20 text-violet-800 dark:text-violet-200' : 'bg-blue-100 dark:bg-blue-400/20 text-blue-800 dark:text-blue-200'}`}>
                              {(line.nature || 'PERMANENT') === 'PERMANENT' ? 'Permanent' : 'Temporary'}
                            </span>
                          )}
                        </div>
                        {/* Actions — delete here removes the WHOLE item (both its
                            in-stock request + the procured shortfall). To keep the
                            in-stock request and only drop the procurement, use the
                            delete on the Indent-bound row instead. */}
                        <div className="flex items-center justify-center">
                          {canEdit && (
                            <button onClick={() => removeLine(line.id)} title="Remove the whole item (in-stock request + procured shortfall). To drop only the procurement, use the delete on the Indent-bound row." className="text-faint hover:text-red-700 dark:text-red-300 p-1">
                              <Trash2 size={14} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
                {splitPager.totalPages > 1 && (
                  <Pagination currentPage={splitPager.page} totalPages={splitPager.totalPages} onPageChange={splitPager.setPage} />
                )}
                {itemQuery && filteredInStockItems.length === 0 && filteredSplitLines.length === 0 && (
                  <div className="px-3 py-5 text-center text-faint italic text-xs">
                    No in-stock lines match “{itemSearch.trim()}”.
                  </div>
                )}
                </div>
              </div>
  );
};
