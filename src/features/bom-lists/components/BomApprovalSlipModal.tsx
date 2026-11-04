import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Modal, StatusBadge, statusClasses, statusLabel, SlipDownloadButtons } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { useAuth } from '@/hooks';
import { client } from '@/api';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import { effectiveIndentStatus } from '@/utils/indentStatus';
import { CEO_APPROVAL_THRESHOLD, ceoApprovalRequiredFor, ceoLaneVisible, isCeoApprovalRequired, ceoThresholdMoney, ceoGateCoversEverything, BOM_APPROVER_ROLES } from '@/config/thresholds';
import { CheckCircle2, XCircle, History, Loader2, ExternalLink, Undo2, RotateCcw, Search, X, Plus, Pencil, Check } from 'lucide-react';
import { bomListsApi, type ReviewerEdits } from '../services/bom-lists.api';
import { inventoryApi } from '@/features/inventory/services/inventory.api';
import { indentsApi } from '@/features/indents/services/indents.api';
import { BomTimelineDrawer } from './BomTimelineDrawer';
import { ReasonBox } from './ReasonBox';
import { LineReviewActionBar } from './LineReviewActionBar';
import { UserRole } from '@/types';

// Quantities may be decimal (metres of cable, kg of solder) — more than 0, at most 2 places, as the server accepts.
const isValidQty = (q: number) => Number.isFinite(q) && q > 0 && Math.round(q * 100) === q * 100;

interface Props {
  /** BOM list id when open, null when closed. */
  bomListId: string | null;
  onClose: () => void;
  /** Fired after a successful approve / reject so the parent page can refetch. */
  onProcessed?: () => void;
  /**
   * Audit / history view. When true the slip is purely informational — every
   * action control is suppressed (no per-line review, no approve / reject /
   * send-back, no indent tech/CEO sign-off, no revoke, no notes box). Only the
   * BOM contents + the Timeline button remain. History rows open the slip this
   * way so "View" never doubles as an action surface; the live queue (and the
   * routed-BOM indent card) keep the actionable mode (readOnly={false}).
   */
  readOnly?: boolean;
}

/**
 * Whole-BOM approval slip (v2 — deferred-split architecture).
 *
 * The previous version of this modal bulk-processed N pending component
 * requests + showed the indent as informational. That model assumed
 * spawning happened at submit-time, which led to the manager juggling N
 * REQs and an IND for a single conceptual BOM.
 *
 * The model: a BOM is ONE thing reviewed in ONE slip. The approver sees the
 * full BOM (indent-bound on top, in-stock below — the layout the requester
 * saw) and can either:
 *   - tick individual rows and Approve / Reject just those (reason required
 *     on reject) — the rejected lines go back to the creator as a list with
 *     the reason while the rest stay; OR
 *   - hit the bottom "Approve BOM" to route the whole thing in one go.
 *
 *   - Approval is one stage: a SUBMITTED BOM is approved/rejected by the
 *     creator's manager, a dept admin, or a super-admin. The final approve
 *     routes every non-REJECTED line (in-stock → inventory, procurement →
 *     one indent). There is no tech/CEO stage at the BOM level — any spawned
 *     indent runs its own approval cycle downstream.
 *   - Per-line review keeps the BOM SUBMITTED (the reviewer can work through
 *     it across visits). Two distinct ways to NOT approve: "Send back for
 *     revision" bounces the BOM to the creator as a new version (v+1) to fix
 *     + resubmit (recoverable, repeatable); "Reject" is terminal — it closes
 *     the BOM for good (duplicate / mistake / against policy). Approve BOM and
 *     Reject are the terminal actions. Line actions are disabled when the role
 *     can't act (backend holds the real gate; this is cosmetic to avoid 403s).
 *   - Timeline drawer slides in from the right showing the full audit log
 *     (every transition + items-edit + per-line review action).
 */

// Per-line money formatter. Each line is priced in its OWN currency, so a
// foreign line must NOT show a ₹ glyph (that's the bug this fixes). Symbols are
// only used where they're unambiguous (₹ $ € £ ¥ = INR USD EUR GBP JPY); the
// dollar/yen-sharing currencies (AUD/CAD/SGD/CNY/AED) fall back to a code
// prefix ("SGD 400") so the cell is never misleading. Header totals stay INR
// (FX-converted) — only these line cells reflect the native price.
const CCY_SYMBOL: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
const fmtMoney = (amount: number, currency?: string | null) => {
  const code = (currency || 'INR').toUpperCase().trim();
  const n = amount.toLocaleString('en-IN');
  const sym = CCY_SYMBOL[code];
  return sym ? `${sym}${n}` : `${code} ${n}`;
};

// Row tint + status chip for a per-line review verdict. PENDING rows render
// plain (no chip, no tint) so an untouched BOM looks exactly as before.
const lineTint = (s?: string) =>
  s === 'APPROVED' ? 'bg-emerald-50/50 dark:bg-emerald-400/15' : s === 'REJECTED' ? 'bg-red-50/60 dark:bg-red-400/15' : '';

const LineStatusChip = ({ status }: { status?: string }) => {
  if (status === 'APPROVED') {
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-400/20 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-400/30 shrink-0">
        <CheckCircle2 size={9} /> Approved
      </span>
    );
  }
  if (status === 'REJECTED') {
    return (
      <span className="inline-flex items-center gap-0.5 text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-400/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-400/30 shrink-0">
        <XCircle size={9} /> Rejected
      </span>
    );
  }
  return null;
};

/**
 * One slip line. Shared module-scope so the virtualized <LineTable> below can be
 * a sibling component (hooks can't live in the per-table render closure). The
 * server seals snapshots in this exact shape, so a sealed past version replays
 * through the same renderer as the live BOM.
 */
export type SlipRow = {
  key: string;
  selId: string | null;
  selKind: 'item' | 'custom' | 'indent' | null;
  name: string;
  meta: string;
  purpose?: string | null;
  url?: string | null;
  custom?: boolean;
  qty: number;
  unit: string;
  amount: number | null;
  // Native currency the line's `amount` is denominated in — drives the per-line
  // symbol so a foreign line never shows a misleading ₹. The header totals stay
  // INR (FX-converted); only the line cell reflects the original.
  currency?: string | null;
  reviewStatus?: string;
  reviewNote?: string | null;
  // Live fulfilment state of the line, derived post-route: in-stock lines carry
  // their spawned ComponentRequest's status (APPROVED→"Yet to Issue", IN_USE…);
  // procurement lines carry the indent's receipt stage. Pre-route this is unset
  // so the Status column falls back to the per-line review verdict chip.
  liveStatus?: string | null;
  dest: 'PROCUREMENT' | 'INSTOCK';
  // A not-yet-saved line the reviewer added in this slip — rendered in its
  // destination table with a NEW badge + remove control; persists on
  // Approve / Send-back. pendingIndex points into addedItems / addedCustom.
  pending?: boolean;
  pendingIndex?: number;
};

// Free-text line filter — name / meta / purpose / unit, case-insensitive. One
// box drives both tables (the parent owns the query); each table filters its own
// rows so the "X of Y" count is per-sheet.
const matchesLineSearch = (r: SlipRow, q: string) =>
  !q || `${r.name} ${r.meta} ${r.purpose || ''} ${r.unit}`.toLowerCase().includes(q);

interface LineTableProps {
  rows: SlipRow[];
  title: string;
  caption: ReactNode;
  /** Already-lowercased, already-trimmed query (parent owns the input). */
  query: string;
  rowSelectable: (r: SlipRow) => boolean;
  rowSelected: (r: SlipRow) => boolean;
  toggleRow: (r: SlipRow) => void;
  toggleTable: (rows: SlipRow[]) => void;
  acting: boolean;
  aiBusy: boolean;
  /** Reviewer-edit mode: render the qty cell as an editable input on catalog/
   *  custom lines. Virtualization means only the visible ~15 rows mount inputs,
   *  so this stays cheap at 500-line BOMs. */
  editableQty?: boolean;
  qtyDraft?: (r: SlipRow) => string;
  onQtyChange?: (r: SlipRow, val: string) => void;
  /** Remove a reviewer-added (pending) line. */
  onRemovePending?: (r: SlipRow) => void;
}

/**
 * One dense sheet of BOM lines, virtualized so a 500-line BOM renders only the
 * visible window (min ~200 lines per BOM is the design target). The table is a
 * CSS grid (not a <table>) because virtualization needs absolutely-positioned
 * rows; columns are conditional so neither sheet shows dead space (Est. only
 * when a row is priced, Status only once a verdict exists). Rows self-measure
 * (variable height: meta / purpose / rejection reason / url) so the scroll math
 * stays correct without a fixed row height.
 */
const LineTable = ({
  rows, title, caption, query,
  rowSelectable, rowSelected, toggleRow, toggleTable, acting, aiBusy,
  editableQty, qtyDraft, onQtyChange, onRemovePending,
}: LineTableProps) => {
  const filtered = useMemo(
    () => (query ? rows.filter(r => matchesLineSearch(r, query)) : rows),
    [rows, query],
  );
  const sel = filtered.filter(rowSelectable);
  const all = sel.length > 0 && sel.every(rowSelected);
  // Column shape is derived from the FULL set (not the filtered set) so the grid
  // template doesn't shift while the user types into the search box.
  const showEst = rows.some(r => r.amount != null);
  // Status column shows once ANY row has either a review verdict OR a live
  // fulfilment state (the post-route "Yet to Issue" / "In Use" / receipt chips).
  const showStatus = rows.some(r => r.reviewStatus === 'APPROVED' || r.reviewStatus === 'REJECTED' || !!r.liveStatus);
  const gridCols = `2.25rem minmax(0,1fr) 4.5rem${showEst ? ' 5.5rem' : ''}${showStatus ? ' 6.5rem' : ''}`;

  const parentRef = useRef<HTMLDivElement>(null);
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 10,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-1.5">
        <p className="text-[11px] text-muted">
          <span className="font-bold text-ink">{title}</span> — {caption}
        </p>
        <span className="text-[10px] text-muted font-bold uppercase tracking-wider shrink-0">
          {query && filtered.length !== rows.length
            ? <>{filtered.length} of {rows.length} lines</>
            : <>{rows.length} line{rows.length === 1 ? '' : 's'}</>}
        </span>
      </div>
      <div className="border border-line rounded-md overflow-hidden">
        {/* Header — a grid row that mirrors the body's column template. */}
        <div
          className="grid items-center bg-surface border-b border-line text-[10px] uppercase tracking-wider text-muted"
          style={{ gridTemplateColumns: gridCols }}
        >
          <div className="px-2 py-2 text-left">
            {sel.length > 0 && (
              <input
                type="checkbox"
                checked={all}
                onChange={() => toggleTable(filtered)}
                className="w-4 h-4 accent-brand cursor-pointer align-middle"
                title={all ? 'Clear selection' : 'Select all reviewable lines'}
              />
            )}
          </div>
          <div className="px-2 py-2 text-left font-bold">Item</div>
          <div className="px-2 py-2 text-right font-bold">Qty</div>
          {showEst && <div className="px-2 py-2 text-right font-bold">Est.</div>}
          {showStatus && <div className="px-2 py-2 text-right font-bold">Status</div>}
        </div>
        {/* Body — bounded scroll container; only the visible window is mounted. */}
        {filtered.length === 0 ? (
          <div className="px-3 py-6 text-center text-faint italic text-xs">
            No lines match “{query}”.
          </div>
        ) : (
          <div ref={parentRef} className="overflow-y-auto max-h-[44vh]">
            <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
              {virtualItems.map((vi) => {
                const r = filtered[vi.index];
                const selectable = rowSelectable(r);
                const selected = rowSelected(r);
                return (
                  <div
                    key={r.key}
                    data-index={vi.index}
                    ref={rowVirtualizer.measureElement}
                    className={`grid items-start border-b border-line-soft text-sm ${selected ? 'bg-brand-50' : r.pending ? 'bg-emerald-50/70 dark:bg-emerald-400/15' : lineTint(r.reviewStatus)}`}
                    style={{
                      gridTemplateColumns: gridCols,
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vi.start}px)`,
                    }}
                  >
                    <div className="px-2 py-2">
                      {r.pending && onRemovePending ? (
                        <button
                          type="button"
                          onClick={() => onRemovePending(r)}
                          disabled={acting}
                          title="Remove this added line"
                          className="text-emerald-700 dark:text-emerald-300 hover:text-red-700 dark:text-red-300 disabled:opacity-50 mt-0.5"
                        >
                          <X size={14} />
                        </button>
                      ) : selectable && (
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleRow(r)}
                          disabled={acting || aiBusy}
                          className="w-4 h-4 accent-brand cursor-pointer align-middle mt-0.5"
                          title="Select for approve / reject"
                        />
                      )}
                    </div>
                    <div className="px-2 py-2 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-ink">{r.name}</span>
                        {r.pending && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-400/20 text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-400/30">NEW</span>
                        )}
                        {r.custom && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-sky-100 dark:bg-sky-400/20 text-sky-700 dark:text-sky-300 border border-sky-200 dark:border-sky-400/30">Custom</span>
                        )}
                      </div>
                      {r.meta && <p className="text-[10px] text-faint">{r.meta}</p>}
                      {r.purpose && <p className="text-[10px] text-muted italic">{r.purpose}</p>}
                      {r.reviewStatus === 'REJECTED' && r.reviewNote && (
                        <p className="text-[10px] text-red-700 dark:text-red-300 italic mt-0.5">Reason: {r.reviewNote}</p>
                      )}
                      {r.url && (
                        <a href={r.url} target="_blank" rel="noopener noreferrer"
                          className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-sky-700 dark:text-sky-300 hover:underline break-all">
                          <ExternalLink size={9} className="shrink-0" /> {r.url}
                        </a>
                      )}
                    </div>
                    <div className="px-2 py-2 text-right whitespace-nowrap">
                      {(editableQty || r.pending) && qtyDraft && onQtyChange && (r.selKind === 'item' || r.selKind === 'custom') ? (
                        <input
                          type="number"
                          min={1}
                          value={qtyDraft(r)}
                          onChange={(e) => onQtyChange(r, e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          disabled={acting}
                          aria-label={`Quantity for ${r.name}`}
                          className={`w-16 text-right font-mono font-bold border rounded py-0.5 px-1.5 text-sm outline-none focus:border-brand disabled:opacity-50 ${qtyDraft(r) !== String(r.qty) ? 'border-amber-400 bg-amber-50 dark:bg-amber-400/15 text-amber-900 dark:text-amber-200' : 'border-line text-ink'}`}
                        />
                      ) : (
                        <span
                          className={`font-mono font-bold ${qtyDraft && qtyDraft(r) !== String(r.qty) ? 'text-amber-700 dark:text-amber-300' : 'text-ink'}`}
                          title={qtyDraft && qtyDraft(r) !== String(r.qty) ? `Changed from ${r.qty} — applies on Approve / Send back` : undefined}
                        >
                          {qtyDraft ? qtyDraft(r) : r.qty}
                        </span>
                      )}
                      <span className="text-[10px] text-faint ml-1">{r.unit}</span>
                    </div>
                    {showEst && (
                      <div className="px-2 py-2 text-right text-muted whitespace-nowrap">
                        {r.amount != null ? fmtMoney(r.amount, r.currency) : <span className="text-faint">&mdash;</span>}
                      </div>
                    )}
                    {showStatus && (
                      <div className="px-2 py-2 text-right">
                        {r.liveStatus ? (
                          <span className={`inline-flex items-center px-1.5 py-0.5 text-[9px] font-bold rounded ring-1 ring-inset shrink-0 ${statusClasses(r.liveStatus)}`}>
                            {statusLabel(r.liveStatus)}
                          </span>
                        ) : (
                          <LineStatusChip status={r.reviewStatus} />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const BomApprovalSlipModal = ({ bomListId, onClose, onProcessed, readOnly = false }: Props) => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();

  const [list, setList] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  // "Send back for revision" fork — the alternative to approving once the
  // reviewer has rejected one or more lines. Expands an optional note box.
  const [showReturn, setShowReturn] = useState(false);
  const [returnNote, setReturnNote] = useState('');
  const [notes, setNotes] = useState('');
  const [timelineOpen, setTimelineOpen] = useState(false);

  // ---- Reviewer in-slip edits (qty tweaks + added lines) ------------------
  // A manager can adjust a SUBMITTED BOM before deciding: change quantities on
  // existing lines, add catalog/custom items. Changes stay LOCAL until they
  // commit an Approve or Send-back — then they ride the reviewerEdits payload,
  // apply server-side in the same transaction, and the requester is notified
  // of the exact diff. Keyed by line id → qty (string, for controlled inputs).
  const [showAdjust, setShowAdjust] = useState(false);
  // Qty cells are read-only until the reviewer clicks the pencil to unlock them.
  const [editingQty, setEditingQty] = useState(false);
  const [qtyEdits, setQtyEdits] = useState<Record<string, string>>({});
  const [customQtyEdits, setCustomQtyEdits] = useState<Record<string, string>>({});
  const [addedItems, setAddedItems] = useState<{ inventoryItemId: string; name: string; qty: number; stock: number; unit: string }[]>([]);
  const [addedCustom, setAddedCustom] = useState<{ name: string; qty: number; unit: string }[]>([]);
  // Add-catalog-item search box.
  const [invSearch, setInvSearch] = useState('');
  const [invResults, setInvResults] = useState<any[]>([]);
  const [invSearching, setInvSearching] = useState(false);
  // Add-custom-item mini-form.
  const [cName, setCName] = useState('');
  const [cQty, setCQty] = useState('1');
  const [cUnit, setCUnit] = useState('pcs');
  // One search box filters both line sheets (procurement + in-stock) — the
  // 200-500-line BOM is hard to scan otherwise. Owned here so the query
  // survives across both <LineTable>s; each table filters + counts its own rows.
  const [lineSearch, setLineSearch] = useState('');

  // Version viewer — the dropdown that replaces the static v{n} chip lets the
  // reader jump across v1..current. `versions` is the metadata list (from the
  // backend); `viewVersion` is the selected version (defaults to the live
  // current one). Selecting any PAST version loads it into `snapshot` and
  // renders the whole slip read-only against those rows — a sealed snapshot
  // when one exists, otherwise a best-effort reconstruction from the audit log
  // (flagged `reconstructed`). `timelineFocusVersion` is now only a last-resort
  // fallback for a version with no record at all.
  const [versions, setVersions] = useState<any[]>([]);
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<any | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [timelineFocusVersion, setTimelineFocusVersion] = useState<number | null>(null);

  // Per-line review selection. Two Sets keyed by line id (catalog items vs
  // custom items live in separate tables, so we track them separately and
  // send both arrays to the review endpoint). `showLineReject` expands the
  // mandatory reason box for a "Reject selected" action.
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [selectedCustomIds, setSelectedCustomIds] = useState<Set<string>>(new Set());
  const [showLineReject, setShowLineReject] = useState(false);
  const [reviewReason, setReviewReason] = useState('');

  // Spawned-indent approval (post-routing): which indent is being acted on
  // (id, for the spinner), and the inline reject box state (which indent +
  // which lane + the mandatory reason). The indent's tech/CEO approve + reject
  // live right here in the slip so the BOM is the single place its whole
  // lifecycle is decided — no loose indent row in the Approvals table.
  const [indentActingId, setIndentActingId] = useState<string | null>(null);
  const [indentReject, setIndentReject] = useState<{ id: string; lane: 'tech' | 'ceo' } | null>(null);
  const [indentRejectReason, setIndentRejectReason] = useState('');

  // Per-LINE review of a spawned indent's items — the indent analogue of the
  // BOM per-line selection above. `selectedIndentItemIds` holds ticked
  // IndentItem ids (globally-unique cuids, so one Set spans all indent cards;
  // each card's bar acts only on its own intersection). `indentLineReject` is
  // the indent id whose "reject selected" reason box is expanded.
  const [selectedIndentItemIds, setSelectedIndentItemIds] = useState<Set<string>>(new Set());
  const [indentLineReject, setIndentLineReject] = useState<string | null>(null);
  const [indentLineReason, setIndentLineReason] = useState('');

  // Clear all per-slip UI state that must never leak across BOMs — the per-line
  // selections, reviewer edits (qty tweaks + added lines), the reject/send-back
  // reason boxes, and the version viewer. Called both when the modal closes
  // (bomListId → null) and when it opens a fresh id. NB: this is the intersection
  // shared by both paths; the close path resets a few extra fields (fetched list,
  // whole-BOM reject box, approver notes, timeline drawer) that the open path
  // deliberately leaves alone, so those stay inline below.
  const resetSlipState = () => {
    // Opening a fresh id — drop any selection carried over from a prior BOM.
    setSelectedItemIds(new Set());
    setSelectedCustomIds(new Set());
    setShowLineReject(false);
    setReviewReason('');
    setShowReturn(false);
    setReturnNote('');
    // Drop reviewer edits from a prior BOM so they never leak across slips.
    setShowAdjust(false); setEditingQty(false);
    setQtyEdits({}); setCustomQtyEdits({}); setAddedItems([]); setAddedCustom([]);
    setInvSearch(''); setInvResults([]); setCName(''); setCQty('1'); setCUnit('pcs');
    setSelectedIndentItemIds(new Set());
    setIndentLineReject(null);
    setIndentLineReason('');
    setIndentReject(null);
    setIndentRejectReason('');
    // Reset the version viewer to "live current" for the new BOM.
    setVersions([]);
    setViewVersion(null);
    setSnapshot(null);
    setSnapshotLoading(false);
    setTimelineFocusVersion(null);
    setLineSearch('');
  };

  // Re-fetch the BOM whenever the modal opens for a new id. We always fetch
  // fresh — the queue row data is a stripped summary; the slip needs the
  // full items + customItems + approval stamps.
  useEffect(() => {
    if (!bomListId) {
      resetSlipState();
      // Close-only extras (not reset when merely switching to another BOM).
      setList(null);
      setShowReject(false);
      setRejectReason('');
      setNotes('');
      setTimelineOpen(false);
      return;
    }
    let cancelled = false;
    resetSlipState();
    setLoading(true);
    bomListsApi.get(bomListId)
      .then(d => { if (!cancelled) setList(d); })
      .catch(e => { if (!cancelled) addToast(extractErrorMessage(e, 'Failed to load BOM'), 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    // Version list drives the dropdown. Default the view to the live current
    // version. Best-effort — a failure just leaves the dropdown hidden.
    bomListsApi.versions(bomListId)
      .then(d => {
        if (cancelled) return;
        setVersions(d?.items || []);
        setViewVersion(d?.currentVersion ?? null);
      })
      .catch(() => { if (!cancelled) setVersions([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetches the BOM only when bomListId changes; addToast (toast context) is only used in error branches and must not retrigger the fetch
  }, [bomListId]);

  // Switch the viewer to a specific version. Current → live rows; any PAST
  // version → load + render it read-only inline (a sealed snapshot when one
  // exists, else a best-effort reconstruction from the audit log — the backend
  // serves both from the same endpoint, flagging `reconstructed`). Only a
  // version with no record at all (never submitted) falls back to the Timeline.
  const selectVersion = (v: number) => {
    const meta = versions.find((x) => x.version === v);
    if (!meta || !bomListId) return;
    if (meta.isCurrent) {
      setViewVersion(v);
      setSnapshot(null);
      return;
    }
    if (meta.hasSnapshot || meta.reconstructed) {
      setViewVersion(v);
      setSnapshotLoading(true);
      bomListsApi.versionSnapshot(bomListId, v)
        .then((s) => setSnapshot(s))
        .catch((e) => {
          addToast(extractErrorMessage(e, `Failed to load v${v}`), 'error');
          setSnapshot(null);
          setViewVersion(list?.version ?? null);
        })
        .finally(() => setSnapshotLoading(false));
      return;
    }
    // Nothing to render (a version with no SUBMITTED record) → change history.
    setTimelineFocusVersion(v);
    setTimelineOpen(true);
  };

  // Re-derive the partition for the items table the same way the editor
  // modal does. Procurement-bound rows on top (out-of-stock + custom),
  // in-stock rows below.
  const indentItems = useMemo(() => {
    const items = list?.items || [];
    return items.filter((line: any) => Number(line.qty) > Number(line.inventoryItem?.stock || 0));
  }, [list]);
  const inStockItems = useMemo(() => {
    const items = list?.items || [];
    return items.filter((line: any) => Number(line.qty) <= Number(line.inventoryItem?.stock || 0));
  }, [list]);
  const customItems = useMemo(() => list?.customItems || [], [list]);

  // Version-viewer derivation: are we looking at a sealed PAST snapshot rather
  // than the live BOM? When so, the whole slip is read-only against the frozen
  // rows — every action surface is suppressed and the line tables + totals read
  // from the snapshot instead of the live list.
  const currentVersion = list?.version ?? null;
  const viewingSnapshot =
    !!snapshot &&
    viewVersion != null &&
    currentVersion != null &&
    viewVersion !== currentVersion;

  // Single approval stage: only a SUBMITTED BOM is actionable. Anything
  // else (DRAFT / ROUTED / REJECTED) renders the modal read-only — as does
  // an explicit `readOnly` (History / audit view), which collapses every
  // pre-route action surface (fork, per-line review, notes) in one gate.
  const canApprove = !readOnly && !!list && list.status === 'SUBMITTED';

  // Cosmetic role check — keeps a USER from seeing an "Approve" button they'd
  // get a 403 on. Backend enforces the real gate (manager-link / dept-admin).
  const canActAtStage = useMemo(() => {
    if (!user || !canApprove) return false;
    return BOM_APPROVER_ROLES.includes(user.role);
  }, [user, canApprove]);

  // Per-line review is live only while the BOM is SUBMITTED and the viewer
  // can act. `actionable` gates every checkbox + the selection action bar.
  // Viewing a sealed past snapshot forces it off — old versions are read-only.
  const actionable = canApprove && canActAtStage && !viewingSnapshot;
  const selectedCount = selectedItemIds.size + selectedCustomIds.size;

  // Tally of where the lines stand so we can warn before the final approve
  // ("3 rejected lines will be excluded") and label the header.
  const reviewCounts = useMemo(() => {
    const all = [...(list?.items || []), ...(list?.customItems || [])];
    let approved = 0, rejected = 0, pending = 0;
    for (const l of all) {
      if (l.reviewStatus === 'APPROVED') approved++;
      else if (l.reviewStatus === 'REJECTED') rejected++;
      else pending++;
    }
    return { approved, rejected, pending, total: all.length };
  }, [list]);

  // Every line rejected ⇒ the final approve would route nothing (backend
  // throws a 400 and rolls back). Disable the button instead of letting the
  // reviewer dead-click it; they should whole-BOM Reject (or un-reject a line).
  const allRejected = reviewCounts.total > 0 && reviewCounts.rejected === reviewCounts.total;

  const toggleItem = (lineId: string) =>
    setSelectedItemIds(prev => {
      const next = new Set(prev);
      next.has(lineId) ? next.delete(lineId) : next.add(lineId);
      return next;
    });
  const toggleCustom = (custId: string) =>
    setSelectedCustomIds(prev => {
      const next = new Set(prev);
      next.has(custId) ? next.delete(custId) : next.add(custId);
      return next;
    });
  const clearSelection = () => {
    setSelectedItemIds(new Set());
    setSelectedCustomIds(new Set());
    setShowLineReject(false);
    setReviewReason('');
  };

  // Approve / reject just the ticked subset. The BOM stays SUBMITTED — the
  // reviewer can keep working through it (or hit the bottom Approve BOM when
  // done). On reject the reason is mandatory and the creator is notified.
  const handleReviewSelected = async (decision: 'APPROVE' | 'REJECT') => {
    if (!list || !actionable || selectedCount === 0) return;
    if (decision === 'REJECT' && !reviewReason.trim()) {
      addToast('A reason is required to reject the selected lines.', 'error');
      return;
    }
    setActing(true);
    try {
      const updated = await bomListsApi.reviewItems(list.id, {
        itemIds: [...selectedItemIds],
        customItemIds: [...selectedCustomIds],
        decision,
        reason: decision === 'REJECT' ? reviewReason.trim() : undefined,
      });
      setList(updated);
      clearSelection();
      addToast(
        decision === 'APPROVE'
          ? `${selectedCount} line${selectedCount > 1 ? 's' : ''} approved.`
          : `${selectedCount} line${selectedCount > 1 ? 's' : ''} rejected. Send the BOM back for revision so the creator can fix them, or approve the accepted lines to move them forward.`,
        'success',
      );
      // Keep the queue badge / parent list fresh without closing the slip.
      window.dispatchEvent(new Event('approvals-updated'));
      onProcessed?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to review the selected lines'), 'error');
    } finally {
      setActing(false);
    }
  };

  // ---- Reviewer-edit helpers ----------------------------------------------
  const origItemQty = (id: string): number | undefined => {
    const l = (list?.items || []).find((x: any) => x.id === id);
    return l ? Number(l.qty) : undefined;
  };
  const origCustomQty = (id: string): number | undefined => {
    const c = (list?.customItems || []).find((x: any) => x.id === id);
    return c ? Number(c.qty) : undefined;
  };

  // Assemble the reviewerEdits payload from local state — only genuinely-changed
  // qtys + added lines. undefined when the reviewer changed nothing.
  const buildReviewerEdits = (): ReviewerEdits | undefined => {
    const qtyUpdates = Object.entries(qtyEdits)
      .map(([itemId, v]) => ({ itemId, qty: Number(v) }))
      .filter((u) => isValidQty(u.qty) && u.qty !== origItemQty(u.itemId));
    const customQtyUpdates = Object.entries(customQtyEdits)
      .map(([customItemId, v]) => ({ customItemId, qty: Number(v) }))
      .filter((u) => isValidQty(u.qty) && u.qty !== origCustomQty(u.customItemId));
    const newItems = addedItems.map((a) => ({ inventoryItemId: a.inventoryItemId, qty: a.qty }));
    const newCustomItems = addedCustom.map((c) => ({ name: c.name, qty: c.qty, unit: c.unit }));
    const edits: ReviewerEdits = {};
    if (qtyUpdates.length) edits.qtyUpdates = qtyUpdates;
    if (customQtyUpdates.length) edits.customQtyUpdates = customQtyUpdates;
    if (newItems.length) edits.newItems = newItems;
    if (newCustomItems.length) edits.newCustomItems = newCustomItems;
    return Object.keys(edits).length ? edits : undefined;
  };
  const pendingEdits = buildReviewerEdits();
  const editCount = pendingEdits
    ? (pendingEdits.qtyUpdates?.length || 0) + (pendingEdits.customQtyUpdates?.length || 0) +
      (pendingEdits.newItems?.length || 0) + (pendingEdits.newCustomItems?.length || 0)
    : 0;
  const resetEdits = () => {
    setQtyEdits({}); setCustomQtyEdits({}); setAddedItems([]); setAddedCustom([]);
    setInvSearch(''); setInvResults([]); setCName(''); setCQty('1'); setCUnit('pcs');
  };
  // Inline qty-cell editing lives IN the line table (not a separate list) so it
  // scales with the virtualized 500-line sheet. These bridge a row → the draft
  // qty state keyed by the line id (selId).
  const qtyDraftFor = (r: SlipRow): string => {
    if (r.pending) return String(r.qty); // pending rows carry their own live qty
    if (!r.selId) return String(r.qty);
    if (r.selKind === 'item') return qtyEdits[r.selId] ?? String(r.qty);
    if (r.selKind === 'custom') return customQtyEdits[r.selId] ?? String(r.qty);
    return String(r.qty);
  };
  const onQtyDraftChange = (r: SlipRow, val: string) => {
    if (r.pending) {
      const n = parseInt(val, 10);
      const q = Number.isInteger(n) && n >= 1 ? n : 1;
      if (r.selKind === 'custom') setAddedCustom((prev) => prev.map((c, i) => i === r.pendingIndex ? { ...c, qty: q } : c));
      else setAddedItems((prev) => prev.map((a, i) => i === r.pendingIndex ? { ...a, qty: q } : a));
      return;
    }
    if (!r.selId) return;
    if (r.selKind === 'item') setQtyEdits((p) => ({ ...p, [r.selId!]: val }));
    else if (r.selKind === 'custom') setCustomQtyEdits((p) => ({ ...p, [r.selId!]: val }));
  };
  const removePendingRow = (r: SlipRow) => {
    if (!r.pending || r.pendingIndex === undefined) return;
    if (r.selKind === 'custom') setAddedCustom((prev) => prev.filter((_, i) => i !== r.pendingIndex));
    else setAddedItems((prev) => prev.filter((_, i) => i !== r.pendingIndex));
  };
  const runInvSearch = async (term: string) => {
    setInvSearch(term);
    if (term.trim().length < 2) { setInvResults([]); return; }
    setInvSearching(true);
    try {
      const items = await inventoryApi.getAll({ search: term.trim(), take: 8 });
      setInvResults(Array.isArray(items) ? items.slice(0, 8) : []);
    } catch { setInvResults([]); }
    finally { setInvSearching(false); }
  };
  const addCatalogItem = (it: any) => {
    if (addedItems.some((a) => a.inventoryItemId === it.id) || (list?.items || []).some((l: any) => l.inventoryItem?.id === it.id)) {
      addToast('That item is already on this BOM — adjust its qty instead.', 'error');
      return;
    }
    setAddedItems((prev) => [...prev, { inventoryItemId: it.id, name: it.name, qty: 1, stock: Number(it.stock ?? 0), unit: it.unit || '' }]);
    setInvSearch(''); setInvResults([]);
    setShowAdjust(true);
  };
  const addCustomLine = () => {
    if (!cName.trim()) { addToast('Custom item needs a name.', 'error'); return; }
    const q = Number(cQty);
    if (!isValidQty(q)) { addToast('Qty must be more than 0 (up to 2 decimals).', 'error'); return; }
    setAddedCustom((prev) => [...prev, { name: cName.trim(), qty: q, unit: cUnit.trim() || 'pcs' }]);
    setCName(''); setCQty('1'); setCUnit('pcs');
  };

  const handleApprove = async () => {
    if (!list || !canApprove) return;
    const rejectedNote = reviewCounts.rejected > 0
      ? ` The ${reviewCounts.rejected} rejected line${reviewCounts.rejected > 1 ? 's' : ''} will be excluded (use "Send back for revision" instead if the creator should fix them).`
      : '';
    const editNote = editCount > 0
      ? ` Your ${editCount} change${editCount > 1 ? 's' : ''} (qty/added items) will be applied and ${list.createdBy?.name || 'the requester'} will be notified.`
      : '';
    // The CEO clause is only true while CEO sign-off is required — don't promise
    // the approver a second gate that isn't there.
    const ceoClause = !isCeoApprovalRequired()
    ? ''
    : ceoGateCoversEverything()
      ? ' — and CEO sign-off on every indent'
      : ` — and CEO sign-off above ${ceoThresholdMoney()}`;
    if (!await confirm(`Approve ${list.serialNo}? In-stock lines issue from inventory; any procurement lines bundle into one indent that still needs admin (Tech) approval${ceoClause}.${editNote}${rejectedNote}`)) return;
    setActing(true);
    try {
      const payload: { notes?: string; reviewerEdits?: ReviewerEdits } = {};
      if (notes.trim()) payload.notes = notes.trim();
      if (pendingEdits) payload.reviewerEdits = pendingEdits;
      await bomListsApi.approveManager(list.id, payload);
      resetEdits();
      addToast(editCount > 0 ? `${list.serialNo} approved with your changes.` : `${list.serialNo} approved and moving forward.`, 'success');
      // Approval routes the BOM — spawns a ComponentRequest per in-stock line
      // into the inventory issue queue. Notify request views + the request/
      // issue-slip badges (approvals-updated alone doesn't refresh those).
      window.dispatchEvent(new Event('requests-updated'));
      window.dispatchEvent(new Event('approvals-updated'));
      onProcessed?.();
      onClose();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to approve'), 'error');
    } finally {
      setActing(false);
    }
  };

  const handleReject = async () => {
    if (!list) return;
    if (!rejectReason.trim()) {
      addToast('A rejection reason is required.', 'error');
      return;
    }
    if (!await confirm(`Reject ${list.serialNo}? This closes the BOM for good — ${list.createdBy?.name || 'the creator'} can't rework it. If it just needs fixing, use "Send back for revision" instead.`)) return;
    setActing(true);
    try {
      await bomListsApi.reject(list.id, rejectReason.trim());
      addToast(`${list.serialNo} rejected and closed.`, 'success');
      window.dispatchEvent(new Event('approvals-updated'));
      onProcessed?.();
      onClose();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to reject'), 'error');
    } finally {
      setActing(false);
    }
  };

  // The "fix it" fork (vs. approve's "proceed to procurement"). Bounces the
  // whole BOM back to DRAFT with the per-line verdicts preserved, so the
  // creator sees exactly which lines to fix and resubmits for a fresh review.
  // Requires ≥1 rejected line (backend enforces; this is the cosmetic guard).
  const handleReturnForRevision = async () => {
    if (!list || !canApprove) return;
    // Send-back needs SOMETHING to act on: a note, a rejected line, or edits.
    if (reviewCounts.rejected === 0 && !returnNote.trim() && editCount === 0) {
      addToast('Add a note, reject a line, or make a change before sending it back.', 'error');
      return;
    }
    const who = list.createdBy?.name || 'the creator';
    const bits: string[] = [];
    if (reviewCounts.rejected > 0) bits.push(`the ${reviewCounts.rejected} rejected item${reviewCounts.rejected > 1 ? 's' : ''} (with reasons)`);
    if (editCount > 0) bits.push(`your ${editCount} change${editCount > 1 ? 's' : ''}`);
    const carry = bits.length ? ` ${who} sees ${bits.join(' and ')} and resubmits.` : ` ${who} reviews your note and resubmits.`;
    if (!await confirm(`Send ${list.serialNo} back to ${who} for revision?${carry} Nothing is ordered or issued yet.`)) return;
    setActing(true);
    try {
      await bomListsApi.returnForRevision(list.id, returnNote.trim() || undefined, pendingEdits);
      resetEdits();
      addToast(`${list.serialNo} sent back to ${who} for revision.`, 'success');
      // Sending back tears down any spawned issue-requests — refresh request
      // views/badges too, not just the approvals queue.
      window.dispatchEvent(new Event('approvals-updated'));
      window.dispatchEvent(new Event('requests-updated'));
      onProcessed?.();
      onClose();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to send back for revision'), 'error');
    } finally {
      setActing(false);
    }
  };

  // Re-pull the BOM after a spawned-indent action so the slip reflects the new
  // approval stamps without closing (the BOM is ROUTED — it isn't going
  // anywhere; the approver should see "tech approved → now awaiting CEO" or
  // "→ in procurement" land in place).
  const refreshSlip = async () => {
    if (!bomListId) return;
    try {
      const d = await bomListsApi.get(bomListId);
      setList(d);
    } catch {
      // Non-fatal — the action succeeded; a stale slip self-heals on reopen.
    }
  };

  // Tech (ADMIN) / CEO (SUPER_ADMIN) approval of a routed BOM's spawned indent,
  // done in-slip. Same endpoints the Approvals table used — backend holds the
  // real role + department gate; the buttons are only shown when they'd succeed.
  const handleIndentApprove = async (indent: any, lane: 'tech' | 'ceo') => {
    const verb = lane === 'tech' ? 'Tech-approve' : 'CEO-approve';
    const rejectedCount = (indent.items || []).filter((it: any) => it.reviewStatus === 'REJECTED').length;
    const dropNote = rejectedCount > 0
      ? ` The ${rejectedCount} rejected line${rejectedCount > 1 ? 's' : ''} will be dropped and the total recomputed from the accepted lines.`
      : '';
    if (!await confirm(`${verb} ${indent.serialNo}? This clears the ${lane === 'tech' ? 'technical' : 'CEO'} gate so procurement can proceed.${dropNote}`)) return;
    setIndentActingId(indent.id);
    try {
      await client.patch(`/indents/${indent.id}/${lane === 'tech' ? 'tech-approve' : 'ceo-approve'}`, { decision: 'APPROVED' });
      addToast(`${lane === 'tech' ? 'Tech' : 'CEO'} approval recorded for ${indent.serialNo}.`, 'success');
      await refreshSlip();
      window.dispatchEvent(new Event('approvals-updated'));
      onProcessed?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to approve the indent'), 'error');
    } finally {
      setIndentActingId(null);
    }
  };

  const handleIndentReject = async (indent: any, lane: 'tech' | 'ceo') => {
    if (!indentRejectReason.trim()) {
      addToast('A reason is required to reject the indent.', 'error');
      return;
    }
    setIndentActingId(indent.id);
    try {
      await client.patch(`/indents/${indent.id}/${lane === 'tech' ? 'tech-approve' : 'ceo-approve'}`, { decision: 'REJECTED', reason: indentRejectReason.trim() });
      addToast(`${indent.serialNo} rejected.`, 'success');
      setIndentReject(null);
      setIndentRejectReason('');
      await refreshSlip();
      window.dispatchEvent(new Event('approvals-updated'));
      onProcessed?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to reject the indent'), 'error');
    } finally {
      setIndentActingId(null);
    }
  };

  const toggleIndentItem = (itemId: string) =>
    setSelectedIndentItemIds(prev => {
      const next = new Set(prev);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });
  const clearIndentSelection = () => {
    setSelectedIndentItemIds(new Set());
    setIndentLineReject(null);
    setIndentLineReason('');
  };

  // Approve / reject just the ticked subset of ONE indent's lines — the indent
  // analogue of handleReviewSelected on the BOM above. The indent stays PENDING
  // (verdicts are reversible) until the whole-indent "approve & advance" drops
  // the rejected lines. `selectedIds` are this indent's ticked item ids only.
  const handleIndentReviewSelected = async (indent: any, selectedIds: string[], decision: 'APPROVE' | 'REJECT') => {
    if (selectedIds.length === 0) return;
    if (decision === 'REJECT' && !indentLineReason.trim()) {
      addToast('A reason is required to reject the selected lines.', 'error');
      return;
    }
    setIndentActingId(indent.id);
    try {
      await indentsApi.reviewLines(indent.id, {
        itemIds: selectedIds,
        decision,
        reason: decision === 'REJECT' ? indentLineReason.trim() : undefined,
      });
      addToast(
        decision === 'APPROVE'
          ? `${selectedIds.length} line${selectedIds.length > 1 ? 's' : ''} approved.`
          : `${selectedIds.length} line${selectedIds.length > 1 ? 's' : ''} rejected. Approve & advance to drop them, or send the BOM back to the requester to fix them.`,
        'success',
      );
      clearIndentSelection();
      await refreshSlip();
      window.dispatchEvent(new Event('approvals-updated'));
      onProcessed?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to review the selected lines'), 'error');
    } finally {
      setIndentActingId(null);
    }
  };

  // The GO-BACK fork: bounce the WHOLE BOM back to the requester as a new
  // version. Tears down this pending indent + reverses in-stock requests, and
  // (unlike revise) clears the approval so the resubmit re-enters the full
  // cycle. Requires ≥1 rejected indent line (backend enforces). Closes the slip
  // — the BOM has left ROUTED for DRAFT and is no longer actionable here.
  const handleSendBackToUser = async (indent: any) => {
    if (!list) return;
    const rejectedCount = (indent.items || []).filter((it: any) => it.reviewStatus === 'REJECTED').length;
    if (rejectedCount === 0) {
      addToast('Reject at least one line before sending the BOM back to the requester.', 'error');
      return;
    }
    const who = list.createdBy?.name || 'the requester';
    if (!await confirm(`Send ${list.serialNo} back to ${who}? Indent ${indent.serialNo} is cancelled and the whole BOM returns to ${who} as a new version with the ${rejectedCount} flagged line${rejectedCount > 1 ? 's' : ''} — they re-spec and resubmit for fresh approval. Nothing proceeds to procurement.`)) return;
    setIndentActingId(indent.id);
    try {
      await bomListsApi.returnRoutedForRevision(list.id);
      addToast(`${list.serialNo} sent back to ${who} for revision.`, 'success');
      // Sending back tears down any spawned issue-requests — refresh request
      // views/badges too, not just the approvals queue.
      window.dispatchEvent(new Event('approvals-updated'));
      window.dispatchEvent(new Event('requests-updated'));
      onProcessed?.();
      onClose();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to send the BOM back'), 'error');
    } finally {
      setIndentActingId(null);
    }
  };

  // Spawned procurement indents that live on this BOM (only present once it has
  // routed). For each, work out what THIS viewer can do: tech approval is
  // ADMIN-only, CEO sign-off is SUPER_ADMIN-only and only on ≥ ₹20k indents
  // after tech has cleared. We only offer inline actions while the indent is in
  // its INITIAL approval window — PENDING with no vendor allocations yet. Once
  // procurement has quoted (allocations exist → firm-price re-approval), the
  // decision needs the quote-review modal in the Indents view, so the slip
  // shows it read-only and points there.
  const indentAction = (ind: any): { lane: 'tech' | 'ceo' } | null => {
    // History / audit view never offers the indent's tech/CEO sign-off — the
    // live action lives on the routed-BOM "Indent approval" card, not here.
    if (readOnly) return null;
    const initial = ind.status === 'PENDING' && (ind._count?.vendorAllocations ?? 0) === 0;
    if (!initial) return null;
    if (user?.role === UserRole.ADMIN && ind.techApprovalStatus === 'PENDING') return { lane: 'tech' };
    if (
      user?.role === UserRole.SUPER_ADMIN &&
      ind.techApprovalStatus === 'APPROVED' &&
      ind.ceoApprovalStatus === 'PENDING' &&
      // Amount test only: a Super Admin keeps the CEO lane on high-value indents
      // even when their sign-off no longer blocks anything.
      ceoLaneVisible(ind)
    ) return { lane: 'ceo' };
    return null;
  };

  // Compact totals strip — drives the threshold preview banner.
  // Totals follow the viewed version: snapshot totals when replaying a sealed
  // past version, live list totals otherwise.
  const procurementSubtotal = viewingSnapshot
    ? Number(snapshot?.procurementSubtotal ?? 0)
    : Number(list?.procurementSubtotal ?? 0);
  const estimatedGrandTotal = viewingSnapshot
    ? Number(snapshot?.estimatedGrandTotal ?? 0)
    : Number(list?.estimatedGrandTotal ?? 0);

  // ── Line model ───────────────────────────────────────────────────────────
  // The BOM renders as TWO dense sheets — a procurement table (the indent half,
  // for procurement) and an in-stock table (the inventory half, for the stores
  // team) — so each reads cleanly for the team that actions it. Dense tables,
  // not cards: a BOM can carry 250+ lines. Pre-route the procurement rows come
  // from the BOM's own out-of-stock + custom items (per-line BOM review).
  // Post-route they come from the LIVE spawned indent instead (per-line indent
  // review) — so the indent isn't a *second thing* shown beside the BOM; it IS
  // the procurement table. In-stock rows always come from the BOM (they issue at
  // routing; read-only once routed).
  // "Post-route" — ROUTED or its terminal COMPLETED. Both read the procurement
  // half from the LIVE spawned indent (the post-route source of truth); a
  // COMPLETED BOM opens here read-only from the approver history. The indent
  // action buttons stay gated by indentAction() (null in readOnly + on any
  // non-PENDING indent), so a completed BOM never shows live sign-off controls.
  const isRouted = list?.status === 'ROUTED' || list?.status === 'COMPLETED';
  // A BOM accumulates more than one spawned indent over its life: revising a
  // ROUTED BOM cancels its current indent and re-routing spawns a fresh one, so
  // `spawnedIndents` is [old CANCELLED, …, live] (createdAt asc). The BOM's
  // *current* indent — the LIVE (non-terminal) one, or the most recent if all
  // are terminal — is computed backend-side (bom-lists.service findOne) so it's
  // the single source of truth; the slip just consumes it. Acting on this
  // (not spawnedIndents[0], which is the OLDEST/dead indent) is what makes the
  // approve lane render on a freshly re-routed BOM.
  const activeIndent: any = list?.activeIndent ?? null;
  const indentActionForActive = activeIndent ? indentAction(activeIndent) : null;

  // Live fulfilment status of each in-stock line. At routing every in-stock line
  // spawns a ComponentRequest with sourceIndentItemId === null; procured lines
  // ALSO spawn requests after receipt (sourceIndentItemId !== null) — we skip
  // those so the map only carries the route-time in-stock issue requests, which
  // map 1:1 to a BOM in-stock line by inventoryItemId (BomListItem is unique per
  // [bomListId, inventoryItemId]). Keyed inventoryItemId → request status.
  const requestStatusByItem = useMemo(() => {
    const m = new Map<string, string>();
    for (const req of (list?.spawnedRequests || [])) {
      if (req.sourceIndentItemId) continue;
      if (req.inventoryItemId) m.set(req.inventoryItemId, req.status);
    }
    return m;
  }, [list]);

  const tableRows = useMemo<SlipRow[]>(() => {
    const rows: SlipRow[] = [];
    if (isRouted && activeIndent) {
      // Procurement half = the live indent's lines (post-route source of truth).
      for (const it of (activeIndent.items || [])) {
        rows.push({
          key: `ind-${it.id}`,
          selId: it.id,
          selKind: 'indent',
          name: it.name,
          meta: [
            it.category ? String(it.category).replace(/_/g, ' ') : 'No category',
            it.partNumber ? `P/N ${it.partNumber}` : null,
          ].filter(Boolean).join(' · '),
          purpose: it.purpose,
          url: it.url,
          qty: Number(it.qty),
          unit: it.unit || '',
          amount: it.total != null && Number(it.total) > 0 ? Number(it.total) : null,
          currency: it.currency,
          reviewStatus: it.reviewStatus,
          reviewNote: it.reviewNote,
          // Procurement line's live state: a rejected line stays "Rejected";
          // once goods start arriving the receipt stage wins (In Transit / Partly
          // Received / Received); before that the indent's own stage is the most
          // informative thing to show — via effectiveIndentStatus so an in-transit
          // indent held at customs surfaces as "Customs clearance", matching the
          // Indents and Requests pages instead of a bare "In Transit".
          liveStatus: it.reviewStatus === 'REJECTED'
            ? 'REJECTED'
            : (it.receiptStatus && it.receiptStatus !== 'NOT_STARTED')
              ? it.receiptStatus
              // A still-pending indent is more precisely "awaiting tech" (then
              // "awaiting CEO") than a bare PENDING — match the header phase so
              // the line chip and the header never disagree.
              : (effectiveIndentStatus(activeIndent) === 'PENDING'
                  ? (activeIndent.techApprovalStatus === 'PENDING' ? 'AWAITING_TECH'
                     : activeIndent.ceoApprovalStatus === 'PENDING' ? 'AWAITING_CEO'
                     : 'PENDING')
                  : effectiveIndentStatus(activeIndent)),
          dest: 'PROCUREMENT',
        });
      }
    } else {
      // Pre-route procurement half = BOM out-of-stock lines + custom lines.
      for (const line of indentItems) {
        rows.push({
          key: `item-${line.id}`,
          selId: line.id,
          selKind: 'item',
          name: line.inventoryItem?.name || 'Unknown',
          meta: [
            line.inventoryItem?.category?.replace(/_/g, ' '),
            `stock ${Number(line.inventoryItem?.stock || 0)} ${line.inventoryItem?.unit || ''}`.trim(),
          ].filter(Boolean).join(' · '),
          purpose: line.purpose,
          url: line.url,
          qty: Number(line.qty),
          unit: line.inventoryItem?.unit || '',
          amount: line.estimatedUnitAmount != null && Number(line.estimatedUnitAmount) > 0
            ? Number(line.qty) * Number(line.estimatedUnitAmount) : null,
          currency: line.currency,
          reviewStatus: line.reviewStatus,
          reviewNote: line.reviewNote,
          dest: 'PROCUREMENT',
        });
      }
      for (const cust of customItems) {
        rows.push({
          key: `cust-${cust.id}`,
          selId: cust.id,
          selKind: 'custom',
          custom: true,
          name: cust.name,
          meta: [
            cust.category ? cust.category.replace(/_/g, ' ') : 'No category',
            cust.partNumber ? `P/N ${cust.partNumber}` : null,
          ].filter(Boolean).join(' · '),
          purpose: cust.purpose,
          url: cust.url,
          qty: Number(cust.qty),
          unit: cust.unit || '',
          amount: cust.estimatedUnitAmount != null && Number(cust.estimatedUnitAmount) > 0
            ? Number(cust.qty) * Number(cust.estimatedUnitAmount) : null,
          currency: cust.currency,
          reviewStatus: cust.reviewStatus,
          reviewNote: cust.reviewNote,
          dest: 'PROCUREMENT',
        });
      }
    }
    // In-stock half — always from the BOM (read-only once routed).
    for (const line of inStockItems) {
      rows.push({
        key: `instk-${line.id}`,
        selId: line.id,
        selKind: 'item',
        name: line.inventoryItem?.name || 'Unknown',
        meta: [
          line.inventoryItem?.category?.replace(/_/g, ' '),
          `stock ${Number(line.inventoryItem?.stock || 0)} ${line.inventoryItem?.unit || ''}`.trim(),
          line.nature === 'TEMPORARY' ? 'Temporary' : 'Permanent',
        ].filter(Boolean).join(' · '),
        purpose: line.purpose,
        qty: Number(line.qty),
        unit: line.inventoryItem?.unit || '',
        amount: null,
        reviewStatus: line.reviewStatus,
        reviewNote: line.reviewNote,
        // In-stock line's live state: rejected stays "Rejected"; otherwise the
        // spawned request's status (APPROVED means routed-to-stores but not yet
        // handed over → show the honest "Yet to Issue"; IN_USE onward = issued).
        // No request yet (pre-route) → leave unset so the verdict chip shows.
        liveStatus: line.reviewStatus === 'REJECTED'
          ? 'REJECTED'
          : (() => {
              const reqStatus = requestStatusByItem.get(line.inventoryItem?.id);
              if (!reqStatus) return undefined;
              return reqStatus === 'APPROVED' ? 'YET_TO_ISSUE' : reqStatus;
            })(),
        dest: 'INSTOCK',
      });
    }
    // Reviewer-added lines (not yet saved) — drop each into its destination
    // table so the reviewer sees it in context: a catalog item goes IN-STOCK
    // when its qty is covered by stock, else PROCUREMENT; custom items always
    // bundle into the procurement indent. Only pre-route (you can't add to an
    // already-routed BOM).
    if (!isRouted) {
      addedItems.forEach((a, i) => {
        rows.push({
          key: `new-item-${i}`,
          selId: `new-item-${i}`,
          selKind: 'item',
          name: a.name,
          meta: `stock ${a.stock} ${a.unit}`.trim(),
          qty: a.qty,
          unit: a.unit,
          amount: null,
          dest: a.qty <= a.stock ? 'INSTOCK' : 'PROCUREMENT',
          pending: true,
          pendingIndex: i,
        });
      });
      addedCustom.forEach((c, i) => {
        rows.push({
          key: `new-cust-${i}`,
          selId: `new-cust-${i}`,
          selKind: 'custom',
          custom: true,
          name: c.name,
          meta: 'off-catalog',
          qty: c.qty,
          unit: c.unit,
          amount: null,
          dest: 'PROCUREMENT',
          pending: true,
          pendingIndex: i,
        });
      });
    }
    return rows;
  }, [isRouted, activeIndent, indentItems, customItems, inStockItems, requestStatusByItem, addedItems, addedCustom]);

  // Selection helpers — one table, three underlying Sets (BOM items, BOM custom,
  // indent items). The row's selKind routes the toggle to the right Set so the
  // existing per-line review handlers keep working unchanged.
  const rowSelected = (r: SlipRow) =>
    r.selKind === 'item' ? selectedItemIds.has(r.selId!)
      : r.selKind === 'custom' ? selectedCustomIds.has(r.selId!)
      : r.selKind === 'indent' ? selectedIndentItemIds.has(r.selId!)
      : false;
  const rowSelectable = (r: SlipRow) =>
    r.pending
      ? false // a not-yet-saved line can't be per-line approved/rejected
      : isRouted
        ? (!!indentActionForActive && r.selKind === 'indent')
        : (actionable && (r.selKind === 'item' || r.selKind === 'custom'));
  const toggleRow = (r: SlipRow) => {
    if (r.selKind === 'item') toggleItem(r.selId!);
    else if (r.selKind === 'custom') toggleCustom(r.selId!);
    else if (r.selKind === 'indent') toggleIndentItem(r.selId!);
  };
  // Two sheets — procurement (the indent half) and in-stock (the inventory
  // half) — partitioned from the same row model by destination. When viewing a
  // sealed past version, the rows come from the snapshot (already SlipRow-shaped
  // on the server) instead of the live BOM, so the same renderer replays them.
  const displayRows: SlipRow[] = viewingSnapshot ? (snapshot?.rows || []) : tableRows;
  const procurementRows = displayRows.filter(r => r.dest === 'PROCUREMENT');
  const inStockRows = displayRows.filter(r => r.dest === 'INSTOCK');

  // Per-table select-all. Acts only on the given table's selectable rows and
  // MERGES into the live selection (ticking one table's header never clears the
  // other's), so the bottom action bar still aggregates across both. selKind
  // routes each id to its Set (BOM items / BOM custom / indent items).
  const toggleTable = (rows: SlipRow[]) => {
    const sel = rows.filter(rowSelectable);
    if (sel.length === 0) return;
    const turnOff = sel.every(rowSelected);
    const apply = (prev: Set<string>, kind: SlipRow['selKind']) => {
      const next = new Set(prev);
      for (const r of sel) if (r.selKind === kind) turnOff ? next.delete(r.selId!) : next.add(r.selId!);
      return next;
    };
    if (isRouted) {
      setSelectedIndentItemIds(prev => apply(prev, 'indent'));
    } else {
      setSelectedItemIds(prev => apply(prev, 'item'));
      setSelectedCustomIds(prev => apply(prev, 'custom'));
    }
  };

  // Post-route indent tallies — drive the footer indent panel (lifted out of the
  // old per-card layout so the controls stay reachable on long BOMs).
  const aiItems: any[] = activeIndent?.items ?? [];
  let aiApproved = 0, aiRejected = 0, aiPending = 0;
  for (const it of aiItems) {
    if (it.reviewStatus === 'APPROVED') aiApproved++;
    else if (it.reviewStatus === 'REJECTED') aiRejected++;
    else aiPending++;
  }
  const aiAllRejected = aiItems.length > 0 && aiRejected === aiItems.length;
  const aiSelectedHere = aiItems.filter((it: any) => selectedIndentItemIds.has(it.id));
  const aiBusy = !!activeIndent && indentActingId === activeIndent.id;
  const aiRejecting = !!activeIndent && indentReject?.id === activeIndent.id;
  const aiLineRejectOpen = !!activeIndent && indentLineReject === activeIndent.id;
  // Blocking gate: only say "awaiting CEO" when something really is waiting on
  // the CEO. False throughout while CEO approval is optional.
  const aiNeedsCeo = activeIndent ? ceoApprovalRequiredFor(activeIndent.grandTotal, activeIndent.currency) : false;
  const aiHasQuoteActivity = activeIndent ? (activeIndent._count?.vendorAllocations ?? 0) > 0 : false;

  // Human phase for the live indent. Critical because status "PENDING" is
  // AMBIGUOUS: an indent is PENDING both when brand-new (awaiting its FIRST
  // approval) AND after procurement finishes quoting, when it BOUNCES back to
  // PENDING to be re-approved at the firm quoted price. The disambiguator is
  // quote activity (vendor allocations exist). Showing raw "PENDING" made a
  // finalised-quote-awaiting-re-approval indent read as "nothing happened" —
  // this spells out exactly whose sign-off it's waiting on.
  const activeIndentPhase: string | null = (() => {
    if (!activeIndent) return null;
    // effectiveIndentStatus (not raw status) so an in-transit indent held at
    // customs reads as CUSTOMS_CLEARANCE here too — otherwise this phase line
    // would say "In transit" while the per-line badge says "Customs clearance".
    const s = effectiveIndentStatus(activeIndent);
    const techPending = activeIndent.techApprovalStatus === 'PENDING';
    const ceoPending = activeIndent.ceoApprovalStatus === 'PENDING';
    if (s === 'PENDING') {
      // Post-quote firm-price re-approval vs. first-time approval.
      const prefix = aiHasQuoteActivity ? 'Quote finalised — awaiting' : 'Awaiting';
      if (techPending) return `${prefix} technical (admin) approval`;
      if (aiNeedsCeo && ceoPending) {
        return aiHasQuoteActivity
          ? 'Quote finalised, tech-approved — awaiting CEO sign-off'
          : 'Tech-approved — awaiting CEO sign-off';
      }
      return aiHasQuoteActivity ? 'Quote finalised — awaiting re-approval' : 'Awaiting approval';
    }
    const map: Record<string, string> = {
      QUOTATION_IN_PROGRESS: 'Procurement is getting vendor quotes',
      READY_FOR_PAYMENT: 'Ready for payment',
      AWAITING_PAYMENT: 'With Finance for payment',
      PAYMENT_DONE: 'Paid — awaiting order',
      ORDERED: 'Ordered',
      IN_TRANSIT: 'In transit',
      CUSTOMS_CLEARANCE: 'In transit — held at customs',
      PARTIALLY_RECEIVED: 'Partially received',
      RECEIVED: 'Received',
      CANCELLED: 'Cancelled',
      REJECTED: 'Rejected',
    };
    return map[s] ?? s;
  })();

  // Revoke approval (post-route undo) — any approver role may revoke a still-
  // revisable ROUTED BOM. Lands it back in SUBMITTED (slip stays open and
  // becomes actionable again); backend re-checks the window + role.
  const canRevoke =
    !readOnly && isRouted && !!list?.revisable && !!user &&
    // Only the person who actually granted the manager approval can revoke it
    // (or a SUPER_ADMIN, for oversight). A tech-reviewing ADMIN who didn't
    // approve shouldn't see "Revoke approval" — it undoes someone else's
    // decision and reads as nonsense when they haven't approved anything.
    // They use "Send back to requester" / "Reject indent" at this stage instead.
    (user.role === UserRole.SUPER_ADMIN || list?.managerApprovedBy?.id === user.id);

  const handleRevoke = async () => {
    if (!list || !canRevoke) return;
    if (!await confirm(
      `Revoke approval of ${list.serialNo}? It returns to SUBMITTED for re-review${
        activeIndent ? `; indent ${activeIndent.serialNo} is cancelled and re-raises once it's re-approved` : ''
      }. Any un-issued in-stock requests are reversed.`,
    )) return;
    setActing(true);
    try {
      const updated = await bomListsApi.revokeApproval(list.id);
      setList(updated);
      clearIndentSelection();
      addToast(`${list.serialNo} approval revoked — back to SUBMITTED.`, 'success');
      // Revoke reverses un-issued in-stock requests + cancels the indent —
      // refresh request/indent views + badges, not just the approvals queue.
      window.dispatchEvent(new Event('approvals-updated'));
      window.dispatchEvent(new Event('requests-updated'));
      window.dispatchEvent(new Event('indents-updated'));
      onProcessed?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to revoke approval'), 'error');
    } finally {
      setActing(false);
    }
  };

  return (
    <>
      <Modal isOpen={!!bomListId} onClose={onClose} size="2xl" title={list ? `${list.serialNo} — ${list.name}` : 'BOM approval'}>
        {loading && (
          <div className="flex items-center justify-center py-12 text-muted">
            <Loader2 size={20} className="animate-spin mr-2" /> Loading BOM…
          </div>
        )}
        {!loading && list && (
          // Vertical shell: one flexing scroll surface over the item lists, with
          // the approver's controls pinned below so Approve / Reject stay reachable
          // on long BOMs. No nested mini-scrollbars; the modal itself is wide (2xl).
          <div className="flex flex-col max-h-[78vh]">
            <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1 space-y-4">
            {/* Header: status + key meta + Timeline button. The Timeline
                button is prominent here because reviewers want to know
                "who's already touched this and what did they say?". */}
            <div className="bg-surface rounded-md p-3 border border-line-soft">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <StatusBadge status={list.status} />
                    {/* Version selector — replaces the static v{n} chip. A
                        single-version BOM keeps the plain chip (nothing to pick);
                        a multi-version BOM gets a dropdown of v1..current so the
                        reader can replay any earlier version inline — sealed
                        snapshots exactly, pre-snapshot ones reconstructed. */}
                    {versions.length > 1 ? (
                      <span className="inline-flex items-center gap-1">
                        <select
                          value={viewVersion ?? currentVersion ?? ''}
                          onChange={(e) => selectVersion(Number(e.target.value))}
                          title="View an earlier version of this BOM"
                          className="text-[10px] font-bold px-2 py-0.5 rounded border bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-400/30 outline-none cursor-pointer focus:border-violet-400"
                        >
                          {versions.map((vinfo) => (
                            <option key={vinfo.version} value={vinfo.version}>
                              v{vinfo.version}
                              {vinfo.isCurrent
                                ? ' · current'
                                : vinfo.hasSnapshot
                                  ? ''
                                  : vinfo.reconstructed
                                    ? ' · reconstructed'
                                    : ' · timeline'}
                            </option>
                          ))}
                        </select>
                        {snapshotLoading && (
                          <Loader2 size={11} className="animate-spin text-violet-700 dark:text-violet-300" />
                        )}
                      </span>
                    ) : (
                      list.version > 1 && (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded border bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-400/30">
                          v{list.version}
                        </span>
                      )
                    )}
                    {viewingSnapshot && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-violet-100 dark:bg-violet-400/20 text-violet-800 dark:text-violet-200 border border-violet-300 dark:border-violet-400/30">
                        Viewing v{viewVersion} · {snapshot?.reconstructed ? 'reconstructed' : 'sealed'}
                      </span>
                    )}
                    {canApprove && !viewingSnapshot && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-400/30">
                        Awaiting approval
                      </span>
                    )}
                    {readOnly && (
                      <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-hover text-muted border border-line">
                        Read-only · history
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-muted">
                    Submitted by <span className="font-bold text-muted">{list.createdBy?.name || 'Unknown'}</span>
                    {list.submittedAt && <> · {fmtDateTime(list.submittedAt)}</>}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {/* Slip download — only for the LIVE BOM. When replaying an
                      earlier version the endpoint would still render the current
                      one, so we hide it to keep "download" honest. */}
                  {!viewingSnapshot && (
                    <SlipDownloadButtons kind="bom-lists" id={list.id} serialNo={list.serialNo} size="sm" />
                  )}
                  <button
                    type="button"
                    onClick={() => setTimelineOpen(true)}
                    className="inline-flex items-center gap-1 text-xs font-bold text-muted border border-line px-2.5 py-1 rounded hover:bg-card"
                    title="Show full audit timeline (every transition + items edit)"
                  >
                    <History size={12} /> Timeline
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <div>
                  <p className="text-[10px] text-muted uppercase font-bold">Project</p>
                  <p className="font-medium text-ink truncate">
                    {list.project?.name || <span className="italic text-muted">General / Others</span>}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted uppercase font-bold">Department</p>
                  <p className="font-medium text-ink truncate">{list.department?.name || '—'}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted uppercase font-bold">Procurement total</p>
                  <p className="font-medium text-ink">
                    ₹{procurementSubtotal.toLocaleString('en-IN')}
                    {isCeoApprovalRequired() && procurementSubtotal >= CEO_APPROVAL_THRESHOLD() && (
                      <span className="ml-1 text-[9px] font-bold text-amber-700 dark:text-amber-300 uppercase">CEO gate</span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] text-muted uppercase font-bold">Est. grand total</p>
                  <p className="font-medium text-ink">₹{estimatedGrandTotal.toLocaleString('en-IN')}</p>
                </div>
              </div>

              {/* Approval stamp — who cleared this BOM (single approval). */}
              {list.managerApprovedBy && (
                <div className="mt-3 pt-3 border-t border-line flex items-center gap-4 flex-wrap text-[10px]">
                  <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 size={11} />
                    <span className="font-bold">Approved:</span> {list.managerApprovedBy?.name} · {fmtDateTime(list.managerApprovedAt)}
                  </span>
                </div>
              )}

              {/* Rejection banner — only when the BOM is terminal-rejected
                  (Reject closes it for good; "Send back for revision" instead
                  drops it to DRAFT and never lands here). */}
              {list.status === 'REJECTED' && (
                <div className="mt-3 pt-3 border-t border-line">
                  <p className="text-xs text-red-700 dark:text-red-300">
                    <span className="font-bold">Rejected</span>
                    {list.rejectedBy?.name && <> by {list.rejectedBy.name}</>}
                    {list.rejectedAt && <> · {fmtDateTime(list.rejectedAt)}</>}
                  </p>
                  {list.rejectionReason && (
                    <p className="text-xs text-red-700 dark:text-red-300 mt-1 italic">Reason: {list.rejectionReason}</p>
                  )}
                </div>
              )}
            </div>

            {/* Past-version banner — replaces the line tables' live source with
                an earlier version. A SEALED snapshot is exact; a RECONSTRUCTED
                one is best-effort (pre-feature version), so it carries an honest
                accuracy caveat. Both give a one-click way back to current. */}
            {viewingSnapshot && (
              <div className="flex items-start justify-between gap-3 text-[11px] text-violet-800 dark:text-violet-200 bg-violet-50 dark:bg-violet-400/15 border border-violet-200 dark:border-violet-400/30 rounded px-3 py-2">
                {snapshot?.reconstructed ? (
                  <p>
                    Viewing <span className="font-bold">version {viewVersion}</span> —{' '}
                    <span className="font-bold">reconstructed from the audit log</span> (this version predates
                    sealed snapshots). The <span className="font-bold">totals + review verdicts</span> shown are this
                    version's actual record; the per-line <span className="font-bold">quantities &amp; prices</span> reflect
                    the latest values (they weren't journalled per version). Switch the dropdown back to{' '}
                    <span className="font-bold">v{currentVersion} · current</span> to act on the live BOM.
                  </p>
                ) : (
                  <p>
                    Viewing <span className="font-bold">version {viewVersion}</span> — a sealed, read-only snapshot
                    of this BOM as it stood then ({snapshot?.itemCount ?? procurementRows.length + inStockRows.length} line
                    {(snapshot?.itemCount ?? 0) === 1 ? '' : 's'}). Switch the dropdown back to{' '}
                    <span className="font-bold">v{currentVersion} · current</span> to act on the live BOM.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => currentVersion != null && selectVersion(currentVersion)}
                  className="shrink-0 font-bold text-violet-700 dark:text-violet-300 border border-violet-300 dark:border-violet-400/30 px-2 py-0.5 rounded hover:bg-card"
                >
                  Back to current
                </button>
              </div>
            )}

            {/* Version trail hint (history view) — the dropdown (top) jumps to
                any version; this points multi-round BOMs at it + the Timeline.
                Hidden while a snapshot is open (its own banner covers it). */}
            {readOnly && list.version > 1 && !viewingSnapshot && (
              <p className="text-[11px] text-violet-800 dark:text-violet-200 bg-violet-50 dark:bg-violet-400/15 border border-violet-200 dark:border-violet-400/30 rounded px-3 py-2">
                This BOM went through <span className="font-bold">{list.version} versions</span>. The lines below are the
                latest — use the <span className="font-bold">version dropdown</span> (top) to replay an earlier one, or
                open the <span className="font-bold">Timeline</span> to see what changed in each.
              </p>
            )}

            {/* Per-line review hint — only while the BOM is actionable. Makes
                the row checkboxes discoverable (the verdict mechanic isn't
                obvious otherwise). */}
            {actionable && (
              <p className="text-[11px] text-muted bg-brand-50 border border-brand/30 rounded px-3 py-2">
                Tick one or more lines to <span className="font-bold text-emerald-700 dark:text-emerald-300">approve</span> or{' '}
                <span className="font-bold text-red-700 dark:text-red-300">reject</span> just those (a reason is required to reject).
                Once a line is rejected you choose at the bottom: <span className="font-bold text-amber-700 dark:text-amber-300">send the BOM back</span>{' '}
                for the creator to fix it, or <span className="font-bold">approve the accepted lines</span> (rejected lines are skipped).
                {reviewCounts.approved + reviewCounts.rejected > 0 && (
                  <span className="block mt-1 font-bold">
                    Reviewed so far: {reviewCounts.approved} approved · {reviewCounts.rejected} rejected · {reviewCounts.pending} pending.
                  </span>
                )}
              </p>
            )}

            {/* Two stacked sheets — procurement (the indent half, for the
                procurement team) and in-stock (the inventory half, for the
                stores team). Splitting them keeps each table single-purpose:
                no Destination column — the heading says where the lines go.
                Pre-route the procurement rows are the BOM's out-of-stock +
                custom lines; post-route they ARE the live spawned indent's
                lines (per-line review happens here). In-stock rows always come
                from the BOM and issue at routing. An empty half is hidden; a
                BOM with no lines at all says so once. */}
            {displayRows.length === 0 ? (
              <div className="border border-line rounded-md px-3 py-6 text-center text-muted italic text-xs">
                No lines on this BOM.
              </div>
            ) : (
              <div className="space-y-4">
                {/* Edit-quantities toggle — qty cells stay read-only until the
                    reviewer unlocks them, so a normal review never risks a stray
                    keystroke changing a number. */}
                {canApprove && canActAtStage && !isRouted && !viewingSnapshot && (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted">
                      {editingQty
                        ? <>Editing quantities — type new values in the <span className="font-bold text-amber-700 dark:text-amber-300">Qty</span> column. Changes apply when you Approve or Send back.</>
                        : <>Need to change quantities before deciding?</>}
                    </span>
                    <button
                      type="button"
                      onClick={() => setEditingQty((v) => !v)}
                      disabled={acting}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-md border shrink-0 disabled:opacity-50 ${
                        editingQty
                          ? 'bg-amber-700 text-white border-amber-600 hover:bg-amber-800'
                          : 'text-ink border-line hover:border-brand hover:text-brand'
                      }`}
                    >
                      {editingQty ? <><Check size={13} /> Done editing</> : <><Pencil size={13} /> Edit quantities</>}
                    </button>
                  </div>
                )}
                {/* One search box over both sheets — a 200-500-line BOM is hard
                    to eyeball; filtering by name / category / purpose / unit lets
                    the reviewer jump straight to a line. Shown only once the BOM
                    is big enough to need it. */}
                {displayRows.length > 8 && (
                  <div className="relative">
                    <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
                    <input
                      type="text"
                      value={lineSearch}
                      onChange={(e) => setLineSearch(e.target.value)}
                      placeholder={`Search ${displayRows.length} lines by name, category, purpose…`}
                      className="w-full border border-line rounded py-1.5 pl-8 pr-8 text-sm focus:border-brand outline-none"
                    />
                    {lineSearch && (
                      <button
                        type="button"
                        onClick={() => setLineSearch('')}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-muted"
                        title="Clear search"
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                )}
                {procurementRows.length > 0 && (
                  <LineTable
                    rows={procurementRows}
                    title="Procurement"
                    query={lineSearch.trim().toLowerCase()}
                    rowSelectable={rowSelectable}
                    rowSelected={rowSelected}
                    toggleRow={toggleRow}
                    toggleTable={toggleTable}
                    acting={acting}
                    aiBusy={aiBusy}
                    editableQty={editingQty && canApprove && canActAtStage && !isRouted && !viewingSnapshot}
                    qtyDraft={qtyDraftFor}
                    onQtyChange={onQtyDraftChange}
                    onRemovePending={removePendingRow}
                    caption={isRouted && activeIndent ? (
                      <>
                        live indent{' '}
                        <span className="font-mono font-bold text-ink">{activeIndent.serialNo}</span>{' '}
                        · <span className="font-bold text-ink">{activeIndentPhase}</span> · for the procurement team.
                      </>
                    ) : (
                      <>these bundle into <span className="font-bold">one indent</span> on approval · for the procurement team.</>
                    )}
                  />
                )}
                {inStockRows.length > 0 && (
                  <LineTable
                    rows={inStockRows}
                    title="In stock"
                    query={lineSearch.trim().toLowerCase()}
                    rowSelectable={rowSelectable}
                    rowSelected={rowSelected}
                    toggleRow={toggleRow}
                    toggleTable={toggleTable}
                    acting={acting}
                    aiBusy={aiBusy}
                    editableQty={editingQty && canApprove && canActAtStage && !isRouted && !viewingSnapshot}
                    qtyDraft={qtyDraftFor}
                    onQtyChange={onQtyDraftChange}
                    onRemovePending={removePendingRow}
                    caption={isRouted
                      ? <>issued from inventory on approval · for the stores team.</>
                      : <>issue from inventory on approval · for the stores team.</>}
                  />
                )}
              </div>
            )}

            {/* Reviewer adjustments — add catalog/custom lines before deciding
                (qty edits happen inline in the table above). Held locally;
                applied server-side on Approve or Send-back, with the requester
                notified of the exact diff. */}
            {canApprove && canActAtStage && !viewingSnapshot && !isRouted && (
              <div className="border border-brand/40 rounded-md">
                <button
                  type="button"
                  onClick={() => setShowAdjust((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-brand-50/50 rounded-md"
                >
                  <span className="inline-flex items-center gap-1.5 text-xs font-bold text-ink">
                    <Plus size={13} className="text-brand" /> Add items (optional)
                  </span>
                  <span className="inline-flex items-center gap-2">
                    {editCount > 0 && (
                      <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-400/20 rounded-full px-2 py-0.5">
                        {editCount} pending
                      </span>
                    )}
                    <span className="text-[10px] text-muted">{showAdjust ? 'Hide' : 'Show'}</span>
                  </span>
                </button>
                {showAdjust && (
                  <div className="border-t border-line-soft p-3 space-y-4">
                    <p className="text-[11px] text-muted -mt-0.5">
                      Items you add appear in the table above with a{' '}
                      <span className="font-bold text-emerald-700 dark:text-emerald-300">NEW</span> tag — an inventory item goes to
                      <span className="font-bold"> In stock</span> if qty ≤ stock, else{' '}
                      <span className="font-bold">Procurement</span>; custom items always go to Procurement. Set qty or remove them right there.
                    </p>
                    <div>
                      <div className="text-[10px] font-bold text-muted uppercase tracking-wider mb-1.5">Add an inventory item</div>
                      <div className="relative">
                        <Search size={13} className="absolute left-2 top-2.5 text-muted" />
                        <input value={invSearch} onChange={(e) => runInvSearch(e.target.value)} placeholder="Search inventory by name…"
                          className="w-full border border-line rounded py-1.5 pl-7 pr-2 text-sm outline-none focus:border-brand" />
                        {invSearch.trim().length >= 2 && (invSearching || invResults.length >= 0) && (
                          <div className="absolute z-10 mt-1 w-full bg-card border border-line rounded shadow-lg max-h-44 overflow-y-auto">
                            {invSearching && <div className="px-2 py-1.5 text-xs text-muted">Searching…</div>}
                            {!invSearching && invResults.length === 0 && <div className="px-2 py-1.5 text-xs text-muted">No matches.</div>}
                            {invResults.map((it: any) => (
                              <button key={it.id} type="button" onClick={() => addCatalogItem(it)}
                                className="w-full text-left px-2 py-1.5 text-sm hover:bg-brand-50 flex items-center justify-between">
                                <span className="truncate">{it.name}</span>
                                <span className="text-[10px] text-muted ml-2 shrink-0">stock {Number(it.stock ?? 0)} {it.unit || ''}</span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] font-bold text-muted uppercase tracking-wider mb-1.5">Add a custom (off-catalog) item</div>
                      <div className="flex items-center gap-2">
                        <input value={cName} onChange={(e) => setCName(e.target.value)} placeholder="Item name"
                          className="flex-1 border border-line rounded py-1.5 px-2 text-sm outline-none focus:border-brand" />
                        <input type="number" min={0.01} step="any" value={cQty} onChange={(e) => setCQty(e.target.value)} placeholder="Qty"
                          className="w-16 text-right border border-line rounded py-1.5 px-2 text-sm outline-none" />
                        <input value={cUnit} onChange={(e) => setCUnit(e.target.value)} placeholder="unit"
                          className="w-16 border border-line rounded py-1.5 px-2 text-sm outline-none" />
                        <button type="button" onClick={addCustomLine}
                          className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold text-emerald-700 dark:text-emerald-300 border border-emerald-300 dark:border-emerald-400/30 rounded hover:bg-emerald-50 dark:bg-emerald-400/15">
                          <Plus size={12} /> Add
                        </button>
                      </div>
                    </div>
                    {editCount > 0 && (
                      <div className="flex items-center justify-between text-[11px] bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded px-2 py-1.5">
                        <span className="text-amber-800 dark:text-amber-200 font-medium">{editCount} change{editCount > 1 ? 's' : ''} pending — applied when you Approve or Send back, and the requester is notified.</span>
                        <button type="button" onClick={resetEdits} className="text-amber-700 dark:text-amber-300 hover:underline font-bold shrink-0 ml-2">Clear</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Approver notes — optional context that lands on the audit
                entry for this approval. Skip the field entirely in
                terminal states (REJECTED / ROUTED). */}
            {canApprove && canActAtStage && !viewingSnapshot && (
              <div>
                <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">
                  Approval notes (optional)
                </label>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={2}
                  placeholder="Anything the requester should know? (visible on the timeline)"
                  className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-brand outline-none resize-none"
                />
              </div>
            )}
            </div>{/* end scrollable body */}

            {/* Approver action controls — pinned below the scroll area so
                Approve / Reject / per-line review stay reachable on long BOMs. */}
            <div className="shrink-0 pt-3 mt-3 border-t border-line-soft space-y-3">
            {/* Reject form — collapsed by default to keep Approve as the
                visual default action. Click "Reject" to expand. */}
            {showReject && canApprove && canActAtStage && !viewingSnapshot && (
              <ReasonBox
                card
                label="Rejection reason (required — visible to creator + on the timeline)"
                description={
                  <p className="text-[11px] text-red-700/90 dark:text-red-300">
                    This closes the BOM permanently — the creator can't rework it. For a BOM that just needs fixing, use <span className="font-bold">Send back for revision</span> instead.
                  </p>
                }
                value={rejectReason}
                onChange={setRejectReason}
                onCancel={() => { setShowReject(false); setRejectReason(''); }}
                onConfirm={handleReject}
                confirmLabel={acting ? 'Rejecting…' : 'Reject BOM'}
                busy={acting}
                rows={3}
                placeholder="Why this BOM is being closed (e.g. duplicate, submitted by mistake)"
              />
            )}

            {/* Send-back-for-revision form — the "fix it" alternative to
                approving the survivors. Expands an optional note (the per-line
                reasons already ride along). Only reachable once ≥1 line is
                rejected, so the creator has something concrete to revise. */}
            {showReturn && canApprove && canActAtStage && !viewingSnapshot && (
              <div className="border border-amber-200 dark:border-amber-400/30 bg-amber-50/50 dark:bg-amber-400/15 rounded-md p-3 space-y-2">
                <label className="block text-[10px] font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wider">
                  Send back for revision — note (optional)
                </label>
                <p className="text-[11px] text-muted">
                  Bounces {list.serialNo} to{' '}
                  <span className="font-bold">{list.createdBy?.name || 'the creator'}</span> as a draft
                  {reviewCounts.rejected > 0 && (
                    <> with the <span className="font-bold text-red-700 dark:text-red-300">{reviewCounts.rejected} rejected line{reviewCounts.rejected > 1 ? 's' : ''}</span> flagged</>
                  )}
                  {editCount > 0 && (
                    <> — your <span className="font-bold text-amber-700 dark:text-amber-300">{editCount} change{editCount > 1 ? 's' : ''}</span> applied and itemised for them</>
                  )}
                  . They review and resubmit — nothing routes to procurement yet.
                </p>
                <textarea
                  value={returnNote}
                  onChange={(e) => setReturnNote(e.target.value)}
                  rows={2}
                  placeholder="Anything to add beyond the per-line reasons? (optional)"
                  className="w-full border border-amber-200 dark:border-amber-400/30 bg-card rounded py-1.5 px-2 text-sm focus:border-amber-400 outline-none resize-none"
                />
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowReturn(false); setReturnNote(''); }}
                    disabled={acting}
                    className="px-3 py-1.5 text-xs font-bold text-muted border border-line rounded hover:bg-card disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleReturnForRevision}
                    disabled={acting}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold bg-amber-700 text-white rounded hover:bg-amber-800 disabled:opacity-50"
                  >
                    <Undo2 size={12} /> {acting ? 'Sending…' : 'Send back for revision'}
                  </button>
                </div>
              </div>
            )}

            {/* Per-line selection action bar — appears only when ≥1 row is
                ticked. Approve applies immediately; Reject expands a mandatory
                reason box. Either way the BOM stays SUBMITTED. */}
            {actionable && selectedCount > 0 && (
              <LineReviewActionBar
                count={selectedCount}
                busy={acting}
                rejectOpen={showLineReject}
                onClear={clearSelection}
                onOpenReject={() => setShowLineReject(true)}
                onApprove={() => handleReviewSelected('APPROVE')}
                reason={reviewReason}
                onReasonChange={setReviewReason}
                onCancelReject={() => { setShowLineReject(false); setReviewReason(''); }}
                onConfirmReject={() => handleReviewSelected('REJECT')}
                reasonLabel="Rejection reason (required — sent to the creator with the rejected lines)"
                rejectConfirmLabel={acting ? 'Rejecting…' : `Reject ${selectedCount} line${selectedCount > 1 ? 's' : ''}`}
              />
            )}

            {/* ── Post-route indent controls ──────────────────────────────
                Once the BOM is ROUTED the spawned indent's per-line review +
                tech/CEO sign-off happen right here in the footer (not in a
                separate card), so the BOM stays the single place its whole
                lifecycle is decided. Shown only while this viewer owns the
                indent's current gate. */}
            {isRouted && activeIndent && indentActionForActive && !aiRejecting && !viewingSnapshot && (
              <div className="border border-sky-100 dark:border-sky-400/25 bg-sky-50/30 dark:bg-sky-400/15 rounded-md p-3 space-y-2">
                <p className="text-[11px] text-muted">
                  Reviewing indent <span className="font-mono font-bold text-ink">{activeIndent.serialNo}</span>{' '}
                  — tick the procurement lines above to <span className="font-bold text-emerald-700 dark:text-emerald-300">approve</span> or{' '}
                  <span className="font-bold text-red-700 dark:text-red-300">reject</span>, then{' '}
                  <span className="font-bold">{indentActionForActive.lane === 'tech' ? 'tech-approve' : 'CEO-approve'} &amp; advance</span>{' '}
                  the accepted lines — or <span className="font-bold text-amber-700 dark:text-amber-300">send the BOM back</span> to the requester.
                  {aiApproved + aiRejected > 0 && (
                    <span className="block font-bold mt-0.5">
                      Reviewed: {aiApproved} approved · {aiRejected} rejected · {aiPending} pending.
                    </span>
                  )}
                </p>
                {aiSelectedHere.length > 0 && (
                  <LineReviewActionBar
                    compact
                    count={aiSelectedHere.length}
                    busy={aiBusy}
                    rejectOpen={aiLineRejectOpen}
                    onClear={clearIndentSelection}
                    onOpenReject={() => { setIndentLineReject(activeIndent.id); setIndentLineReason(''); }}
                    onApprove={() => handleIndentReviewSelected(activeIndent, aiSelectedHere.map((it: any) => it.id), 'APPROVE')}
                    reason={indentLineReason}
                    onReasonChange={setIndentLineReason}
                    onCancelReject={() => { setIndentLineReject(null); setIndentLineReason(''); }}
                    onConfirmReject={() => handleIndentReviewSelected(activeIndent, aiSelectedHere.map((it: any) => it.id), 'REJECT')}
                    reasonLabel="Rejection reason (required — sent to the requester with the rejected lines)"
                    rejectConfirmLabel={aiBusy ? 'Rejecting…' : `Reject ${aiSelectedHere.length} line${aiSelectedHere.length > 1 ? 's' : ''}`}
                  />
                )}
                {aiAllRejected && !aiLineRejectOpen && (
                  <p className="text-[10px] font-medium text-amber-700 dark:text-amber-300">
                    Every line is rejected — <span className="font-bold">send the BOM back</span> to the requester, or <span className="font-bold text-red-700 dark:text-red-300">reject the indent</span>.
                  </p>
                )}
              </div>
            )}

            {/* Whole-indent reject reason box (post-route) — kills the indent. */}
            {isRouted && activeIndent && indentActionForActive && aiRejecting && !viewingSnapshot && (
              <ReasonBox
                card
                label="Rejection reason (required — kills the whole indent, sent to the requester)"
                value={indentRejectReason}
                onChange={setIndentRejectReason}
                onCancel={() => { setIndentReject(null); setIndentRejectReason(''); }}
                onConfirm={() => handleIndentReject(activeIndent, indentActionForActive.lane)}
                confirmLabel={aiBusy ? 'Rejecting…' : 'Reject indent'}
                busy={aiBusy}
                rows={2}
                autoFocus
                placeholder={`Why ${activeIndent.serialNo} is rejected`}
              />
            )}

            {/* Read-only context: post-route but this viewer can't act on the
                indent (e.g. the manager who approved it, or it's mid-quote). */}
            {isRouted && activeIndent && !indentActionForActive && !viewingSnapshot && (
              <p className="text-[11px] text-faint italic">
                {aiHasQuoteActivity && activeIndent.status === 'PENDING'
                  // Quote is in and the indent has bounced back for firm-price
                  // re-approval — this can't be done blind on the slip; it needs
                  // the quote-review modal in the Indents view.
                  ? `Indent ${activeIndent.serialNo}: ${activeIndentPhase}. Review it against the quote in the Indents view.`
                  : activeIndent.status !== 'PENDING'
                    // Genuinely mid-procurement / downstream (quoting, payment, in transit…).
                    ? `Indent ${activeIndent.serialNo} is with procurement — ${activeIndentPhase!.toLowerCase()}. Track it in the Indents view.`
                    // Still awaiting its first approval, just not by this viewer.
                    : `Indent ${activeIndent.serialNo}: ${activeIndentPhase}.`}
              </p>
            )}

            {canApprove && canActAtStage && !viewingSnapshot && !showReject && !showReturn && allRejected && (
              <p className="text-right text-[11px] font-medium text-amber-700 dark:text-amber-300 pt-2">
                Every line is rejected — nothing left to approve. <span className="font-bold">Send back for revision</span> so the creator can fix them, or <span className="font-bold text-red-700 dark:text-red-300">Reject</span> to close the BOM for good.
              </p>
            )}
            {/* Footer actions. Pre-route shows the BOM approval fork; post-route
                shows the spawned indent's tech/CEO fork plus a Revoke-approval
                undo. In terminal states (REJECTED, or ROUTED past the window)
                only Close remains and the modal is purely informational. */}
            <div className="flex items-center justify-end gap-2 pt-1 flex-wrap">
              <button onClick={onClose}
                className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface">
                Close
              </button>

              {/* Pre-route (SUBMITTED) — approve / reject / send-back the BOM. */}
              {canApprove && canActAtStage && !viewingSnapshot && !showReject && !showReturn && (
                <>
                  <button
                    onClick={() => setShowReject(true)}
                    disabled={acting}
                    className="inline-flex items-center gap-1 px-4 py-2 text-sm font-bold text-red-700 dark:text-red-300 border border-red-300 dark:border-red-400/30 rounded-md hover:bg-red-50 dark:bg-red-400/15 disabled:opacity-50"
                  >
                    <XCircle size={14} /> Reject
                  </button>
                  <button
                    onClick={() => setShowReturn(true)}
                    disabled={acting}
                    title="Send the BOM back to the creator with a note, flagged lines, and/or your changes — they resubmit for approval."
                    className="inline-flex items-center gap-1 px-4 py-2 text-sm font-bold text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-400/30 rounded-md hover:bg-amber-50 dark:bg-amber-400/15 disabled:opacity-50"
                  >
                    <Undo2 size={14} /> Send back for revision
                  </button>
                  <button
                    onClick={handleApprove}
                    disabled={acting || allRejected}
                    title={allRejected ? 'Every line is rejected — nothing left to approve. Send it back for revision so the creator can fix them, or use Reject to close the BOM for good.' : undefined}
                    className="inline-flex items-center gap-1 bg-emerald-700 text-white px-5 py-2 rounded-md font-bold text-sm hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                  >
                    <CheckCircle2 size={14} /> {acting ? 'Approving…' : reviewCounts.rejected > 0 ? 'Approve accepted lines' : 'Approve BOM'}
                  </button>
                </>
              )}
              {canApprove && !canActAtStage && !viewingSnapshot && (
                <span className="text-xs text-faint italic">
                  Awaiting approval — your role can't act on this BOM.
                </span>
              )}

              {/* Post-route (ROUTED) — the spawned indent's tech/CEO fork. */}
              {isRouted && activeIndent && indentActionForActive && !aiRejecting && !viewingSnapshot && (
                <>
                  <button
                    type="button"
                    disabled={aiBusy}
                    onClick={() => { setIndentReject({ id: activeIndent.id, lane: indentActionForActive.lane }); setIndentRejectReason(''); }}
                    className="inline-flex items-center gap-1 px-4 py-2 text-sm font-bold text-red-700 dark:text-red-300 border border-red-300 dark:border-red-400/30 rounded-md hover:bg-red-50 dark:bg-red-400/15 disabled:opacity-50"
                  >
                    <XCircle size={14} /> Reject indent
                  </button>
                  <button
                    type="button"
                    disabled={aiBusy || aiRejected === 0}
                    onClick={() => handleSendBackToUser(activeIndent)}
                    title={aiRejected === 0
                      ? 'Tick the procurement line(s) that need fixing as Reject first, then send the BOM back to the requester to re-spec them.'
                      : 'Send the whole BOM back to the requester to re-spec the rejected line(s), then resubmit for fresh approval.'}
                    className="inline-flex items-center gap-1 px-4 py-2 text-sm font-bold text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-400/30 rounded-md hover:bg-amber-50 dark:bg-amber-400/15 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <Undo2 size={14} /> Send back to requester
                  </button>
                  <button
                    type="button"
                    disabled={aiBusy || aiAllRejected}
                    onClick={() => handleIndentApprove(activeIndent, indentActionForActive.lane)}
                    title={aiAllRejected ? 'Every line is rejected — nothing left to advance. Send the BOM back to the requester, or reject the indent.' : undefined}
                    className="inline-flex items-center gap-1 bg-emerald-700 text-white px-5 py-2 rounded-md font-bold text-sm hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                  >
                    <CheckCircle2 size={14} /> {aiBusy ? 'Working…' : aiRejected > 0 ? 'Approve accepted lines' : indentActionForActive.lane === 'tech' ? 'Tech approve' : 'CEO approve'}
                  </button>
                </>
              )}

              {/* Revoke approval — any approver role may undo a still-revisable
                  routed BOM, independent of the indent gate. */}
              {canRevoke && !aiRejecting && !viewingSnapshot && (
                <button
                  type="button"
                  onClick={handleRevoke}
                  disabled={acting || aiBusy}
                  title="Undo the approval — returns the BOM to SUBMITTED, cancels the spawned indent, and reverses un-issued in-stock requests."
                  className="inline-flex items-center gap-1 px-4 py-2 text-sm font-bold text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-400/30 rounded-md hover:bg-amber-50 dark:bg-amber-400/15 disabled:opacity-50"
                >
                  <RotateCcw size={14} /> {acting ? 'Revoking…' : 'Revoke approval'}
                </button>
              )}
            </div>
            </div>{/* end pinned footer */}
          </div>
        )}
      </Modal>

      {/* Timeline drawer — slides in on top of the modal. The drawer is
          self-contained (fetches its own audit entries) so it can be
          reused from anywhere a BOM is open. */}
      <BomTimelineDrawer
        bomListId={timelineOpen ? bomListId : null}
        focusVersion={timelineFocusVersion}
        onClose={() => { setTimelineOpen(false); setTimelineFocusVersion(null); }}
      />
    </>
  );
};
