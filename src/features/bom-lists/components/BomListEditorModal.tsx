import { ReactElement, useEffect, useMemo, useState } from 'react';
import { Modal, NumberInput, StatusBadge, SlipDownloadButtons, BulkSelectionBar } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { useNavigate } from 'react-router-dom';
import { useAuth, useClientPagination } from '@/hooks';
import { cachedGet, extractErrorMessage } from '@/lib';
import { ALLOWED_CURRENCIES, toInr, toInrForApprovalGate, ISSUED_STATUSES } from '@/config/thresholds';
import { Pencil, Send, Plus, History, AlertTriangle, Search, X } from 'lucide-react';
import { bomListsApi } from '../services/bom-lists.api';
import { effectiveIndentStatus } from '@/utils/indentStatus';
import { BomTimelineDrawer } from './BomTimelineDrawer';
import { ComponentsTracker } from './ComponentsTracker';
import { ProcurementLinesTable } from './ProcurementLinesTable';
import { InStockLinesTable } from './InStockLinesTable';
import { DURATION_UNITS, durationUnitLabel } from '@/utils/duration';

// Vendor URL is optional, but when the requester DOES type one it must be a
// real http(s) link: procurement clicks through to it and each row renders it
// as an <a href>, so a bare word ("cVendor URL") or a protocol-less domain
// ("amazon.com") would be a dead link. Empty == allowed (stays a soft warning).
const VENDOR_URL_HINT = 'Use a full link starting with http:// or https:// — or leave it blank.';
const isValidVendorUrl = (raw: unknown): boolean => {
  const v = String(raw ?? '').trim();
  if (!v) return true; // optional — empty is fine
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

interface Props {
  listId: string | null;
  onClose: () => void;
  onChanged?: () => void;
}

// ── BOM fulfillment model (the single source of truth) ──────────────────────
// Every component on a routed BOM collapses to exactly ONE of three phases,
// derived bottom-up from its furthest-along downstream artifact. The headline
// status chips and the per-row badge both read from this, so they can never
// disagree. These buckets MIRROR the backend's summarizeBomProgress, so the BOM
// Lists row ("2 issued · 1 pending") and this modal always show the same
// numbers. Phases:
//   • issued  — has been handed over to the requester at some point, and STAYS
//               counted as issued even after it's returned or used up: IN_USE,
//               OVERDUE, RETURN_REQUESTED, RETURNED, CONSUMED, EMBEDDED,
//               DISPOSED. Only the headline bucket is coarse — the row's Status
//               column still shows the REAL state (Returned / Disposed / …).
//   • pending — not yet issued: still moving through procurement (ordered / in
//               transit), or received into inventory but awaiting the issue step
//               (PENDING / APPROVED / YET_TO_ISSUE).
//   • closed  — REJECTED only: a dead line, never issued and never pending.
//               Counted in the total, kept out of both headline chips.
type ComponentPhase = 'issued' | 'pending' | 'closed';
const PENDING_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'YET_TO_ISSUE'];

type TrackRow = {
  key: string; name: string; qty: number; unit: string;
  sourced: 'stock' | 'ordered';
  req?: any;    // live/terminal ComponentRequest (stock row, or an issued ordered row)
  indent?: any; // ordered provenance
  line?: any;   // the indent line (for its per-line receipt status)
};

const classifyComponent = (row: TrackRow): { phase: ComponentPhase; badge: ReactElement } => {
  const r = row.req;
  if (r) {
    // Issued at some point → counts toward the headline "issued" tally, but the
    // per-row badge still shows the REAL state (Issued / Overdue / Returned /
    // Disposed / Embedded / Consumed) so the Status column stays truthful.
    if (ISSUED_STATUSES.includes(r.status)) return { phase: 'issued', badge: <StatusBadge status={r.status} /> };
    if (PENDING_REQUEST_STATUSES.includes(r.status)) {
      // Approved / awaiting = received into inventory, sitting on the shelf, not
      // yet handed over. "Yet to issue" reads far clearer to a hardware person
      // than a green "Approved" that looks finished.
      return { phase: 'pending', badge: <StatusBadge status="YET_TO_ISSUE" /> };
    }
    // REJECTED — a dead line: neither issued nor pending. Shown in the total
    // only, carrying its real "Rejected" badge.
    return { phase: 'closed', badge: <StatusBadge status={r.status} /> };
  }
  // No downstream request yet → the ordered part is still in procurement; show
  // where the shipment actually is rather than a bare "not started". The per-line
  // receipt stage (In Transit / Partly Received / Received) renders through the
  // same canonical StatusBadge used everywhere else, so it can't drift in colour
  // or wording. Before any goods move, fall back to the indent's own stage
  // (which surfaces "Customs clearance" when applicable).
  const rs = row.line?.receiptStatus;
  if (rs && rs !== 'NOT_STARTED') {
    return { phase: 'pending', badge: <StatusBadge status={rs} /> };
  }
  return { phase: 'pending', badge: <StatusBadge status={effectiveIndentStatus(row.indent)} /> };
};

const CATEGORY_OPTIONS = [
  { value: 'ELECTRONIC_PASSIVE', label: 'Electronic — Passive' },
  { value: 'ELECTRONIC_ACTIVE', label: 'Electronic — Active' },
  { value: 'MECHANICAL_TOOLS', label: 'Mechanical Tools' },
  { value: 'ELECTRONICS_GENERAL_ACCESSORIES', label: 'Electronics — General Accessories' },
  { value: 'ELECTRONICS_TOOLS', label: 'Electronics Tools' },
  { value: 'MECHANICAL_3D_PRINTING', label: 'Mechanical — 3D Printing' },
  { value: 'PACKING_MATERIALS', label: 'Packing Materials' },
  { value: 'SAFETY_WEARABLE', label: 'Safety / Wearable' },
  { value: 'STATIONARY_OFFICE', label: 'Stationary / Office' },
  { value: 'CLEANING_ITEMS', label: 'Cleaning Items' },
  { value: 'PCB_STENCILS', label: 'PCB / Stencils' },
];

// Suggestion list for the custom-item Unit field. Wired via a <datalist> so
// the box autocompletes the common cases but still accepts any free-text
// unit the requester needs to type.
const COMMON_UNITS = ['pcs', 'set', 'pair', 'box', 'pack', 'roll', 'sheet', 'unit', 'm', 'cm', 'mm', 'kg', 'g', 'L', 'mL'];

// Per-role path to the inventory-items catalog (where bulk-select → "Add to
// BOM" lives). Mirrors the "Inventory Items" nav entries in AppRoutes. Used to
// make the empty In-stock section a clickable shortcut. Roles without a catalog
// page (e.g. FINANCE) fall back to plain, non-clickable copy.
const INVENTORY_ITEMS_PATH_BY_ROLE: Record<string, string> = {
  SUPER_ADMIN: '/super-admin/inventory',
  ADMIN: '/admin/components',
  MANAGER: '/manager',
  USER: '/user',
  LAB: '/lab/inventory',
  PROCUREMENT: '/procurement/components',
};

/**
 * Edit + submit a single BOM list. DRAFT lists are fully editable (qty,
 * remove items, Submit). SUBMITTED lists render the same layout but
 * read-only with a spawned-requests sub-table.
 */
export const BomListEditorModal = ({ listId, onClose, onChanged }: Props) => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const navigate = useNavigate();
  const roleSlug = user?.role.toLowerCase().replace(/_/g, '-') || 'user';

  const [list, setList] = useState<any | null>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Re-raise UI state per rejected REQ. Keyed by request id so each row's
  // qty + reason draft is independent. `submitting` blocks the button
  // during the POST so the user can't fire twice.
  const [reraiseDraftFor, setReraiseDraftFor] = useState<string | null>(null);
  const [reraiseQty, setReraiseQty] = useState<number | ''>('');
  const [reraiseReason, setReraiseReason] = useState('');
  const [reraisingId, setReraisingId] = useState<string | null>(null);
  const [qtyDraft, setQtyDraft] = useState<Record<string, number>>({});
  // Split-line qty is edited on the Indent-bound row. Clicking the read-only qty
  // on the Request-bound mirror jumps there, flashes the input + shows "edit here".
  const [flashLineId, setFlashLineId] = useState<string | null>(null);
  const jumpToIndentQty = (lineId: string) => {
    setFlashLineId(lineId);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-indent-qty="${lineId}"]`) as HTMLElement | null;
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => (el.querySelector('input') as HTMLInputElement | null)?.focus(), 350);
    });
    setTimeout(() => setFlashLineId((cur) => (cur === lineId ? null : cur)), 2600);
  };
  // Bulk selection of inventory line items (both tables) for delete / set-nature.
  const [selectedLines, setSelectedLines] = useState<Set<string>>(new Set());
  const toggleLine = (id: string) => setSelectedLines(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const toggleMany = (ids: string[], on: boolean) => setSelectedLines(prev => {
    const next = new Set(prev);
    ids.forEach(id => (on ? next.add(id) : next.delete(id)));
    return next;
  });
  const clearSelection = () => setSelectedLines(new Set());
  // Selection keys are table-scoped ("indent:<id>" / "request:<id>") so a split
  // line — which shows in BOTH tables under the same item id — can be selected in
  // one table without the other table's row (or a hidden mirror) lighting up.
  // Bulk actions strip the prefix back to the item id (deduped) since they act on
  // the whole item regardless of which table it was picked in.
  const selKey = (table: 'indent' | 'request', id: string) => `${table}:${id}`;
  const selectedItemIds = () => [...new Set([...selectedLines].map(k => k.slice(k.indexOf(':') + 1)))];
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailsDraft, setDetailsDraft] = useState<any>({});
  const [savingDetails, setSavingDetails] = useState(false);
  const [projects, setProjects] = useState<any[]>([]);
  // Out-of-stock + custom lines expose a procurement-details expander
  // (estimated unit price, purpose). Track which line ids are open so
  // they don't all collapse on every refresh.
  const [openProcDetails, setOpenProcDetails] = useState<Record<string, boolean>>({});
  // Local draft for per-row duration input — mirrors qtyDraft so we
  // don't fire PATCH on every keystroke. Committed on blur.
  const [durationDraft, setDurationDraft] = useState<Record<string, number>>({});
  // Custom-item add panel state. Hidden by default to keep the modal compact.
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [customDraft, setCustomDraft] = useState<any>({
    name: '', qty: 1, unit: 'pcs', estimatedUnitAmount: '', currency: 'INR', category: 'ELECTRONICS_GENERAL_ACCESSORIES',
    description: '', partNumber: '', url: '', purpose: '',
  });
  const [addingCustom, setAddingCustom] = useState(false);
  // Audit timeline drawer — opens over the editor modal. Visible to
  // the BOM owner (and admins via assertOwnerOrAdmin) so they can see
  // every state transition + items-edit on this BOM with timestamps.
  const [timelineOpen, setTimelineOpen] = useState(false);
  // One filter box over all three item lists (procurement, custom, in-stock) —
  // a 200-500-line BOM is impractical to scroll, so let the requester jump to a
  // line by name / category / purpose. Filters the rendered rows only; the
  // URL/dup advisories + totals still reflect the WHOLE BOM.
  const [itemSearch, setItemSearch] = useState('');

  useEffect(() => {
    // `listId` is what opens this modal (null = closed), so gate on it: the
    // component mounts with the page and this used to fetch /projects on every
    // cold load whether or not anyone opened an editor.
    if (!listId) return;
    let cancelled = false;
    cachedGet<any>('/projects').then(p => {
      if (!cancelled) setProjects(p?.data || p || []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [listId]);

  useEffect(() => {
    if (!listId) {
      setList(null);
      setQtyDraft({});
      setEditingDetails(false);
      setShowCustomForm(false);
      setOpenProcDetails({});
      setItemSearch('');
      return;
    }
    let cancelled = false;
    setItemSearch('');
    setLoading(true);
    bomListsApi.get(listId)
      .then(d => {
        if (cancelled) return;
        setList(d);
        setQtyDraft(Object.fromEntries((d.items || []).map((i: any) => [i.id, Number(i.qty)])));
        setDetailsDraft({
          name: d.name,
          projectId: d.projectId || '__OTHERS__',
          durationValue: d.durationValue,
          durationUnit: d.durationUnit,
          purpose: d.purpose || '',
        });
      })
      .catch(e => addToast(extractErrorMessage(e, 'Failed to load list'), 'error'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads the list only when listId changes; addToast (toast context) is used only in the error branch and must not retrigger the fetch
  }, [listId]);

  const saveDetails = async () => {
    if (!list) return;
    setSavingDetails(true);
    try {
      await bomListsApi.update(list.id, {
        name: detailsDraft.name,
        projectId: detailsDraft.projectId === '__OTHERS__' ? null : detailsDraft.projectId,
        durationValue: Number(detailsDraft.durationValue),
        durationUnit: detailsDraft.durationUnit,
        purpose: detailsDraft.purpose?.trim() || null,
      });
      const fresh = await bomListsApi.get(list.id);
      setList(fresh);
      setEditingDetails(false);
      addToast('Details saved', 'success');
      onChanged?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to save details'), 'error');
    } finally {
      setSavingDetails(false);
    }
  };

  const isDraft = list?.status === 'DRAFT';
  const isOwner = list?.createdById === user?.id;
  const canEdit = isDraft && isOwner;

  // Partition preview — drives the adaptive Submit button copy + the
  // routing chips on each row. Done client-side from the same rule the
  // backend uses at submit (qty > stock → indent).
  const partition = useMemo(() => {
    const items = list?.items || [];
    const customs = list?.customItems || [];
    let inStock = 0;
    let shortStock = 0;
    // Live cost preview — mirrors the backend computeTotals() exactly:
    //   procurementSubtotal = ONLY the lines heading to the indent (short-
    //     stock inventory rows + every custom item) × est. unit price. This
    //     is the number the CEO-threshold gate checks downstream, so it uses
    //     the FAIL-CLOSED toInrForApprovalGate (unknown currency → ∞) — matching
    //     the backend snapshot — so an off-list currency can never understate it.
    //   estimatedGrandTotal = every line × est. unit price (display only) →
    //     lenient toInr.
    let procurementSubtotal = 0;
    let estimatedGrandTotal = 0;
    for (const line of items) {
      // Committed qty (not the in-flight draft) so the AT-SUBMIT chips don't
      // flip while typing — they settle when the qty is committed, in lockstep
      // with the table placement above.
      const qty = Number(line.qty);
      const stock = Math.max(0, Number(line.inventoryItem?.stock || 0));
      // Catalog lines default to INR but can carry a non-INR currency when the
      // requester prices an out-of-stock line in another currency — convert so
      // the preview matches the backend's INR totals + indent rollup.
      const unitInr = toInr(Number(line.estimatedUnitAmount ?? 0), line.currency);
      const unitInrGate = toInrForApprovalGate(Number(line.estimatedUnitAmount ?? 0), line.currency);
      estimatedGrandTotal += unitInr * qty;
      // SPLIT: a partly-in-stock line (0 < stock < qty) issues its in-stock qty
      // as a REQUEST *and* procures the shortfall via the INDENT — the backend
      // (routeBom) creates both artefacts. The editor mirrors that by rendering
      // the line in BOTH tables (in-stock qty under Request-bound, shortfall
      // under Indent-bound), so the count reflects both: +1 request if any of it
      // is in stock, +1 indent if any is short. (A pure in-stock line → request
      // only; a pure out-of-stock line → indent only.) The procurement subtotal
      // (CEO-gate number) still counts ONLY the shortfall.
      const indentQty = Math.max(0, qty - stock);
      const inStockQty = Math.min(qty, stock);
      if (inStockQty > 0) inStock += 1;
      if (indentQty > 0) { shortStock += 1; procurementSubtotal += unitInrGate * indentQty; }
    }
    for (const cust of customs) {
      // Custom lines can be in any currency — convert to INR so the preview
      // matches the backend (which stores totals in INR) and the indent rollup.
      // Grand total = lenient (display); procurement subtotal = fail-closed (gate).
      const qtyUnit = Number(cust.qty) * Number(cust.estimatedUnitAmount ?? 0);
      estimatedGrandTotal += toInr(qtyUnit, cust.currency);
      procurementSubtotal += toInrForApprovalGate(qtyUnit, cust.currency);
    }
    return {
      inStock,
      shortStock,
      custom: customs.length,
      total: items.length + customs.length,
      procurementSubtotal: Math.round(procurementSubtotal * 100) / 100,
      estimatedGrandTotal: Math.round(estimatedGrandTotal * 100) / 100,
      // Indent spawns when ANY short-stock OR custom line exists.
      spawnsIndent: shortStock + customs.length > 0,
    };
  }, [list, qtyDraft]);

  // A ROUTED / COMPLETED BOM no longer renders these editor tables at all — it
  // shows the unified "Components" tracker below (built straight from
  // the spawned requests + indent lines, the real ground truth). So this split
  // only ever drives the DRAFT / SUBMITTED editor, where it's a LIVE preview
  // off current stock: qty > stock → indent-bound, else request-bound. A row
  // flips between the two the instant the requester edits qty past stock.
  const isPostRouted = list?.status === 'ROUTED' || list?.status === 'COMPLETED';
  // Classify by the COMMITTED qty (line.qty), NOT the in-flight qtyDraft. A row
  // must not hop between tables on every keystroke — it only re-classifies once
  // the new qty is committed (which, for a line crossing into short-stock, is
  // gated by the "confirm split" dialog in commitQty). The qty INPUT still shows
  // the live draft; only the table placement waits for commit.
  const indentItems = useMemo(() => {
    const items = list?.items || [];
    return items.filter((line: any) => Number(line.qty) > Number(line.inventoryItem?.stock || 0));
  }, [list]);
  const inStockItems = useMemo(() => {
    const items = list?.items || [];
    return items.filter((line: any) => Number(line.qty) <= Number(line.inventoryItem?.stock || 0));
  }, [list]);
  // SPLIT lines (0 < stock < committed qty): editable (as the shortfall) in the
  // Indent-bound table, with the in-stock portion ALSO mirrored as a read-only
  // request row under Request-bound.
  const splitLines = useMemo(() => {
    const items = list?.items || [];
    return items.filter((line: any) => {
      const stock = Number(line.inventoryItem?.stock || 0);
      return stock > 0 && Number(line.qty) > stock;
    });
  }, [list]);
  // The routed BOM's fulfillment, folded to ONE row per physical component and
  // classified bottom-up (see classifyComponent). The SINGLE source of truth for
  // the headline status chips, the Components table, and the filter-box gate — a
  // received-then-issued part folds onto its originating indent line via the
  // robust FK (request.sourceIndentItemId → IndentItem.id), so it's counted once.
  const componentRollup = useMemo(() => {
    const reqs = list?.spawnedRequests || [];
    const indents = list?.spawnedIndents || [];
    const issueReqByIndentItem = new Map<string, any>();
    for (const r of reqs) if (r.sourceIndentItemId) issueReqByIndentItem.set(r.sourceIndentItemId, r);
    const stockReqs = reqs.filter((r: any) => !r.sourceIndentItemId);
    const baseRows: TrackRow[] = [
      ...stockReqs.map((r: any): TrackRow => ({
        key: `req:${r.id}`,
        name: r.inventoryItem?.name || 'Item',
        qty: Number(r.qtyRequested),
        unit: r.inventoryItem?.unit || '',
        sourced: 'stock',
        req: r,
      })),
      ...indents.flatMap((ind: any) =>
        (ind.items || []).map((line: any): TrackRow => ({
          key: `ind:${ind.id}:${line.id}`,
          name: line.name,
          qty: Number(line.qty),
          unit: line.unit || '',
          sourced: 'ordered',
          req: issueReqByIndentItem.get(line.id),
          indent: ind,
          line,
        })),
      ),
    ];
    const rows = baseRows.map((row) => ({ row, ...classifyComponent(row) }));
    return {
      rows,
      total: rows.length,
      issued: rows.filter((d) => d.phase === 'issued').length,
      pending: rows.filter((d) => d.phase === 'pending').length,
      closed: rows.filter((d) => d.phase === 'closed').length,
    };
  }, [list]);

  // ── Free-text item filter (all three lists) ───────────────────────────
  // The rendered rows only — counts/advisories/totals keep using the full
  // lists. Matches inventory lines on name/category/unit/purpose and custom
  // lines on name/category/description/partNumber/purpose, case-insensitive.
  const itemQuery = itemSearch.trim().toLowerCase();
  const matchInvLine = (line: any) =>
    `${line.inventoryItem?.name || ''} ${line.inventoryItem?.category || ''} ${line.inventoryItem?.unit || ''} ${line.purpose || ''}`
      .toLowerCase().includes(itemQuery);
  const matchCustomLine = (c: any) =>
    `${c.name || ''} ${c.category || ''} ${c.description || ''} ${c.partNumber || ''} ${c.purpose || ''} ${c.unit || ''}`
      .toLowerCase().includes(itemQuery);
  const filteredIndentItems = useMemo(
    () => (itemQuery ? indentItems.filter(matchInvLine) : indentItems),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchInvLine is a render-scope helper that closes only over itemQuery, which is already a dep
    [indentItems, itemQuery],
  );
  const filteredInStockItems = useMemo(
    () => (itemQuery ? inStockItems.filter(matchInvLine) : inStockItems),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchInvLine is a render-scope helper that closes only over itemQuery, which is already a dep
    [inStockItems, itemQuery],
  );
  const filteredSplitLines = useMemo(
    () => (itemQuery ? splitLines.filter(matchInvLine) : splitLines),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchInvLine closes only over itemQuery (already a dep)
    [splitLines, itemQuery],
  );
  const filteredCustomItems = useMemo(
    () => (itemQuery ? (list?.customItems || []).filter(matchCustomLine) : (list?.customItems || [])),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchCustomLine is a render-scope helper that closes only over itemQuery, which is already a dep
    [list, itemQuery],
  );

  // ── Client pagination (10/row) for the four editor tables ─────────────
  // A 250-line BOM otherwise mounts 250+ complex rows at once and freezes the
  // browser. Each of the four filtered lists renders only its current page
  // slice; the full arrays above stay intact so counts/select-all/advisories
  // are still computed over the whole dataset. Reset key mixes the list id
  // (dataset swap) with the free-text filter so the page snaps back to 1 when
  // either changes. Selection is keyed by composite id, so it survives paging.
  const PAGE_KEY = `${list?.id || ''}:${itemQuery}`;
  const indentPager = useClientPagination(filteredIndentItems, 10, PAGE_KEY);
  const customPager = useClientPagination(filteredCustomItems, 10, PAGE_KEY);
  const inStockPager = useClientPagination(filteredInStockItems, 10, PAGE_KEY);
  const splitPager = useClientPagination(filteredSplitLines, 10, PAGE_KEY);

  // ── Vendor-URL advisories (procurement-bound lines only) ──────────────
  // URL is OPTIONAL — never blocks submit. But two cases get a visible
  // caution so requester/reviewer notices: (a) a missing link (amber —
  // procurement has to source it blind); (b) the SAME url reused on another
  // line (red — almost always a copy-paste slip; each component needs its
  // own product page). In-stock lines are deliberately excluded — they're
  // issued from stock and the user asked to leave that section untouched.
  const urlAdvisory = useMemo(() => {
    const norm = (u: any) => String(u || '').trim().toLowerCase();
    const counts = new Map<string, number>();
    let missing = 0;
    const all = [
      ...indentItems.map((l: any) => l.url),
      ...((list?.customItems || []).map((c: any) => c.url)),
    ];
    for (const raw of all) {
      const n = norm(raw);
      if (!n) { missing++; continue; }
      counts.set(n, (counts.get(n) || 0) + 1);
    }
    const isDup = (raw: any) => { const n = norm(raw); return !!n && (counts.get(n) || 0) > 1; };
    const dupUrls = [...counts.values()].filter((c) => c > 1).length;
    return { missing, dupUrls, isDup };
  }, [indentItems, list]);

  const commitQty = async (lineId: string) => {
    if (!list) return;
    const newQty = qtyDraft[lineId];
    const original = list.items.find((i: any) => i.id === lineId);
    if (!original || Number(original.qty) === newQty) return;
    // Confirm before a line CROSSES from fully-in-stock into procurement — i.e.
    // when the new qty exceeds available stock and it wasn't short before. The
    // in-stock part is issued now; the shortfall is raised as a procurement
    // indent, so the requester should knowingly opt into that split. (No prompt
    // when it was already short, or for a pure out-of-stock item with no stock
    // to issue from.) Fires on blur/commit — not per keystroke.
    const stock = Number(original.inventoryItem?.stock || 0);
    const wasShort = Number(original.qty) > stock;
    if (stock > 0 && newQty > stock && !wasShort) {
      const proceed = await confirm({
        title: 'Part of this will be procured',
        message: `Only ${stock} of ${newQty} “${original.inventoryItem?.name || 'this item'}” are in stock.\n\n${stock} will be issued now from stock as a request, and the ${newQty - stock} short will be raised as a procurement indent.\n\nContinue?`,
        confirmLabel: 'Yes, split it',
        cancelLabel: 'Cancel',
      });
      if (!proceed) { setQtyDraft(d => ({ ...d, [lineId]: Number(original.qty) })); return; }
    }
    try {
      await bomListsApi.updateItem(list.id, lineId, { qty: newQty });
      const fresh = await bomListsApi.get(list.id);
      setList(fresh);
      onChanged?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to update qty'), 'error');
      setQtyDraft(d => ({ ...d, [lineId]: Number(original.qty) }));
    }
  };

  const removeLine = async (lineId: string) => {
    if (!list) return;
    if (!await confirm('Remove this item from the list?')) return;
    try {
      await bomListsApi.removeItem(list.id, lineId);
      const fresh = await bomListsApi.get(list.id);
      setList(fresh);
      onChanged?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to remove item'), 'error');
    }
  };

  // Deleting the INDENT (short) half of a split shouldn't nuke the whole item —
  // it just means "don't procure the shortfall." Cap the qty to available stock
  // so the line survives as a pure in-stock request (moves to Request-bound on
  // refetch). The item itself is only removed via the Request-bound row's delete.
  const dropProcurementPortion = async (lineId: string, stock: number, shortfall: number) => {
    if (!list) return;
    if (!await confirm({
      title: 'Drop the procurement?',
      message: `The ${shortfall} short won't be procured. The ${stock} in stock stays as a request.\n\nRemove the whole item instead? Use the delete on its Request-bound row.`,
      confirmLabel: `Drop procurement, keep ${stock}`,
      cancelLabel: 'Cancel',
    })) return;
    try {
      await bomListsApi.updateItem(list.id, lineId, { qty: stock });
      const fresh = await bomListsApi.get(list.id);
      setList(fresh);
      onChanged?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to update item'), 'error');
    }
  };

  // Bulk-delete the selected rows. Routes inventory lines → removeItem and custom
  // items → removeCustomItem (selection can include both). One confirm, one refetch.
  const bulkDeleteSelected = async () => {
    if (!list || selectedLines.size === 0) return;
    const ids = selectedItemIds();
    if (!await confirm({
      title: 'Remove selected items',
      message: `Remove ${ids.length} item${ids.length === 1 ? '' : 's'} from this BOM?`,
      confirmLabel: `Remove ${ids.length}`,
      cancelLabel: 'Cancel',
      tone: 'danger',
    })) return;
    const invIds = new Set((list.items || []).map((i: any) => i.id));
    try {
      await Promise.all(ids.map(id => invIds.has(id)
        ? bomListsApi.removeItem(list.id, id)
        : bomListsApi.removeCustomItem(list.id, id)));
      const fresh = await bomListsApi.get(list.id);
      setList(fresh);
      clearSelection();
      onChanged?.();
      addToast(`Removed ${ids.length} item${ids.length === 1 ? '' : 's'}`, 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to remove items'), 'error');
      // Intentionally silent: this is a best-effort re-read to resync the list
      // after the failure above, which has ALREADY been reported. A second
      // toast here would report the same problem twice.
      try { setList(await bomListsApi.get(list.id)); } catch {}
    }
  };

  // Bulk set Perm/Temp — inventory lines only (nature is a loan property of
  // inventory requests; custom items in the selection are skipped).
  const bulkSetNature = async (nature: 'PERMANENT' | 'TEMPORARY') => {
    if (!list || selectedLines.size === 0) return;
    const invIds = new Set((list.items || []).map((i: any) => i.id));
    const ids = selectedItemIds().filter(id => invIds.has(id));
    if (ids.length === 0) { addToast('Nature applies to inventory items only.', 'info'); return; }
    try {
      await Promise.all(ids.map(id => bomListsApi.updateItem(list.id, id, { nature })));
      const fresh = await bomListsApi.get(list.id);
      setList(fresh);
      onChanged?.();
      addToast(`Set ${ids.length} item${ids.length === 1 ? '' : 's'} to ${nature === 'PERMANENT' ? 'Permanent' : 'Temporary'}`, 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to update nature'), 'error');
    }
  };

  const removeCustom = async (customId: string) => {
    if (!list) return;
    if (!await confirm('Remove this custom item from the list?')) return;
    try {
      await bomListsApi.removeCustomItem(list.id, customId);
      const fresh = await bomListsApi.get(list.id);
      setList(fresh);
      onChanged?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to remove custom item'), 'error');
    }
  };

  // Leading "S.No" cell that doubles as the row's bulk-select toggle (matches the
  // other tables' click-the-number-to-select behaviour). Plain number when the
  // BOM isn't editable.
  const renderSelCell = (table: 'indent' | 'request', id: string, n: number) => {
    if (!canEdit) return <span className="text-[11px] font-mono text-faint">{n}</span>;
    const key = selKey(table, id);
    const sel = selectedLines.has(key);
    return (
      <button
        type="button"
        onClick={() => toggleLine(key)}
        title={sel ? 'Deselect' : 'Select (for bulk delete / set nature)'}
        className={`w-7 h-6 rounded text-[11px] font-mono flex items-center justify-center transition-colors ${sel ? 'bg-brand text-white font-bold' : 'text-faint hover:bg-line border border-transparent hover:border-line'}`}
      >
        {sel ? '✓' : n}
      </button>
    );
  };

  // Header "select all in this table" checkbox (drives the S.No column header).
  const renderSelAllHeader = (ids: string[]) => {
    if (!canEdit || ids.length === 0) return <span className="text-[9px]">#</span>;
    const allSel = ids.every(id => selectedLines.has(id));
    return (
      <button
        type="button"
        onClick={() => toggleMany(ids, !allSel)}
        title={allSel ? 'Deselect all' : 'Select all'}
        className={`w-4 h-4 rounded border flex items-center justify-center text-[10px] mx-auto ${allSel ? 'bg-brand border-brand text-white' : 'border-line text-transparent hover:border-brand'}`}
      >
        ✓
      </button>
    );
  };

  // Per-line PATCH for procurement-only fields (purpose, estimatedUnitAmount).
  // Used by the expander panel on out-of-stock + custom rows.
  const patchInvItem = async (lineId: string, payload: any) => {
    if (!list) return;
    try {
      await bomListsApi.updateItem(list.id, lineId, payload);
      const fresh = await bomListsApi.get(list.id);
      setList(fresh);
      onChanged?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to save'), 'error');
    }
  };

  const patchCustomItem = async (customId: string, payload: any) => {
    if (!list) return;
    try {
      await bomListsApi.updateCustomItem(list.id, customId, payload);
      const fresh = await bomListsApi.get(list.id);
      setList(fresh);
      onChanged?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to save'), 'error');
    }
  };

  // Shared onBlur committer for the inline vendor-URL inputs (uncontrolled).
  // Validates format before the PATCH; on a bad link it toasts + reverts the
  // field to its last good value so nothing invalid is ever persisted. Skips
  // the round-trip when the value is unchanged.
  const commitVendorUrl = (
    el: HTMLInputElement,
    current: string | null | undefined,
    save: (url: string) => void,
  ) => {
    const next = el.value.trim();
    const prev = String(current ?? '').trim();
    if (next === prev) return;
    if (next && !isValidVendorUrl(next)) {
      addToast(`That vendor URL isn't a valid link. ${VENDOR_URL_HINT}`, 'error');
      el.value = prev; // revert the uncontrolled input
      return;
    }
    save(next);
  };

  const addCustomItem = async () => {
    if (!list) return;
    if (!customDraft.name?.trim()) {
      addToast('Custom item name is required.', 'error');
      return;
    }
    if (!customDraft.unit?.trim()) {
      addToast('Unit is required.', 'error');
      return;
    }
    // Vendor URL is optional, but if one IS typed it must be a real link —
    // reject garbage ("cVendor URL") / protocol-less domains before the POST.
    if (customDraft.url?.trim() && !isValidVendorUrl(customDraft.url)) {
      addToast(`That vendor URL isn't a valid link. ${VENDOR_URL_HINT}`, 'error');
      return;
    }
    // A missing or duplicated link surfaces as a non-blocking caution on the row.
    setAddingCustom(true);
    try {
      await bomListsApi.addCustomItem(list.id, {
        name: customDraft.name.trim(),
        qty: Number(customDraft.qty),
        unit: customDraft.unit.trim(),
        estimatedUnitAmount: customDraft.estimatedUnitAmount ? Number(customDraft.estimatedUnitAmount) : undefined,
        currency: customDraft.currency || 'INR',
        category: customDraft.category,
        description: customDraft.description?.trim() || undefined,
        partNumber: customDraft.partNumber?.trim() || undefined,
        url: customDraft.url?.trim() || undefined,
        purpose: customDraft.purpose?.trim() || undefined,
      });
      const fresh = await bomListsApi.get(list.id);
      setList(fresh);
      onChanged?.();
      addToast('Custom item added', 'success');
      // Reset form, keep panel open so the user can add another without
      // re-clicking the toggle.
      setCustomDraft({
        name: '', qty: 1, unit: 'pcs', estimatedUnitAmount: '', currency: 'INR', category: 'ELECTRONICS_GENERAL_ACCESSORIES',
        description: '', partNumber: '', url: '', purpose: '',
      });
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to add custom item'), 'error');
    } finally {
      setAddingCustom(false);
    }
  };

  // Re-raise a rejected (or closed) BOM-spawned request. Opens an inline
  // form with the original's qty pre-filled; user can tweak qty + add
  // a reason explaining the change ("count was wrong" / "spec mismatch")
  // which lands on the new request's notes for the manager to see.
  const openReraise = (req: any) => {
    setReraiseDraftFor(req.id);
    setReraiseQty(Number(req.qtyRequested) || 1);
    setReraiseReason('');
  };
  const cancelReraise = () => {
    setReraiseDraftFor(null);
    setReraiseQty('');
    setReraiseReason('');
  };
  const submitReraise = async (req: any) => {
    if (!list) return;
    const qty = Number(reraiseQty);
    if (!Number.isFinite(qty) || qty < 1) {
      addToast('Quantity must be a positive number.', 'error');
      return;
    }
    setReraisingId(req.id);
    try {
      const fresh = await bomListsApi.reraiseRequest(list.id, req.id, {
        qty,
        reason: reraiseReason.trim() || undefined,
      });
      addToast(`Re-raised as ${fresh.serialNo}`, 'success');
      cancelReraise();
      // Refetch the BOM so the rollup shows the new request alongside
      // the original (which stays for audit).
      const d = await bomListsApi.get(list.id);
      setList(d);
      onChanged?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to re-raise request'), 'error');
    } finally {
      setReraisingId(null);
    }
  };

  const handleSubmit = async () => {
    if (!list) return;
    if (partition.total === 0) {
      addToast('Add at least one item before submitting.', 'error');
      return;
    }
    // Duplicate vendor URL is a HARD block — two products can't share a link,
    // so one is wrong. (Missing URL stays an allowed warning.) The backend
    // re-checks this on submit; we block here too so the click never round-trips.
    if (urlAdvisory.dupUrls > 0) {
      addToast('Two procurement lines share the same vendor URL. Each product needs its own link — fix the duplicate before submitting.', 'error');
      return;
    }
    // Deferred-split architecture: nothing spawns at submit. The BOM
    // moves to SUBMITTED and lands in the manager's approval queue. The
    // partition just informs what'll happen after all approvals clear
    // (and what gate the BOM has to pass — manager only / + tech / + CEO).
    const reqs = partition.inStock;
    const indentLines = partition.shortStock + partition.custom;
    const pieces: string[] = [];
    if (reqs > 0) pieces.push(`${reqs} in-stock line${reqs === 1 ? '' : 's'}`);
    if (indentLines > 0) pieces.push(`${indentLines} procurement line${indentLines === 1 ? '' : 's'}`);
    const summary = pieces.join(' + ');
    // Every submit goes through manager review — including a revised BOM
    // (revise() clears the prior sign-off, so edits after approval are always
    // re-reviewed). Keep the wording plain — no "routing"/jargon, since
    // requesters may be technicians.
    const confirmMsg = list.version && list.version > 1
      ? `Re-submit ${list.serialNo} (v${list.version}) for approval? Because you edited it, your manager reviews it again (${summary}). After approval, in-stock items come from inventory and the rest are ordered — automatically.`
      : `Submit ${list.serialNo} for approval? Your manager reviews it (${summary}). After approval, in-stock items come from inventory and the rest are ordered — automatically.`;
    if (!await confirm(confirmMsg)) return;
    setSubmitting(true);
    try {
      await bomListsApi.submit(list.id);
      addToast(`${list.serialNo} submitted — awaiting manager approval.`, 'success');
      onChanged?.();
      onClose();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to submit BOM'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // "Resubmit" vs "Submit": a BOM that's already been through review is being
  // submitted AGAIN, so the verb changes. Two ways that happens:
  //   • version > 1  → revised (revise / indent-bounce both bump the counter).
  //   • a line carries a review verdict → an approver sent it back for revision.
  //     That path keeps the BOM at v1 but PRESERVES per-line APPROVED/REJECTED
  //     verdicts (so the creator sees what to fix) — which is the signal here.
  const previouslyReviewed =
    (list?.version ?? 1) > 1 ||
    (list?.items || []).some((l: any) => l.reviewStatus && l.reviewStatus !== 'PENDING') ||
    (list?.customItems || []).some((c: any) => c.reviewStatus && c.reviewStatus !== 'PENDING');

  // A bounce (whole-BOM Reject or per-line Send back) lands the BOM here with
  // ≥1 line still flagged REJECTED — that's the signal it was sent back to be
  // reworked (vs. a plain revise() of a once-routed BOM, which carries no
  // rejected lines). Drives the banner copy below.
  const hasRejectedLines =
    (list?.items || []).some((l: any) => l.reviewStatus === 'REJECTED') ||
    (list?.customItems || []).some((c: any) => c.reviewStatus === 'REJECTED');

  // Helper for the adaptive Submit button label.
  const submitLabel = () => {
    const verb = previouslyReviewed ? 'Resubmit' : 'Submit';
    if (submitting) return previouslyReviewed ? 'Resubmitting…' : 'Submitting…';
    if (partition.total === 0) return verb;
    const reqs = partition.inStock;
    const indentLines = partition.shortStock + partition.custom;
    if (reqs > 0 && indentLines > 0) return `${verb} (${reqs} req + indent)`;
    if (reqs > 0) return `${verb} (${reqs} req${reqs === 1 ? '' : 's'})`;
    if (indentLines > 0) return `${verb} (indent · ${indentLines})`;
    return verb;
  };

  return (
    <>
    <Modal
      isOpen={!!listId}
      onClose={onClose}
      size="2xl"
      title={list ? `${list.serialNo} — ${list.name}` : 'BOM List'}
      headerRight={list && (
        /* Full audit history (every transition + items edit with timestamps).
           Sits on the title row so it's always in reach, not buried in the body.
           Alongside it: download this BOM as a printable slip (PDF) or data (CSV). */
        <div className="flex items-center gap-2">
          <SlipDownloadButtons kind="bom-lists" id={list.id} serialNo={list.serialNo} size="sm" />
          <button
            type="button"
            onClick={() => setTimelineOpen(true)}
            className="inline-flex items-center gap-1 text-[11px] font-bold text-muted border border-line px-2 py-1 rounded hover:bg-surface"
            title="Show full audit timeline (every transition + items edit)"
          >
            <History size={11} /> Timeline
          </button>
        </div>
      )}
    >
      {loading && <div className="text-center py-8 text-faint">Loading…</div>}
      {!loading && list && (
        <div className="space-y-4">
          {/* Re-work banner. Two ways a DRAFT lands back with the creator:
                • BOUNCE — an approver rejected the whole BOM or sent specific
                  lines back. Flagged lines show REJECTED with a reason; fix
                  them and resubmit (each bounce bumps the version).
                • REVISE — a once-routed BOM pulled back via revise() (no
                  flagged lines; the prior sign-off is cleared).
              Both re-enter a fresh manager review on resubmit. */}
          {canEdit && hasRejectedLines && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-700 dark:text-amber-300" />
              <div>
                <p className="font-bold">Sent back for revision{list.version > 1 ? ` (v${list.version})` : ''}</p>
                <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                  Fix the items flagged <span className="font-bold">Rejected</span> below (each shows the reason), then resubmit. Editing a flagged line clears its flag, and your manager re-reviews the BOM before anything is ordered or issued.
                </p>
              </div>
            </div>
          )}
          {canEdit && !hasRejectedLines && list.version > 1 && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
              <AlertTriangle size={14} className="shrink-0 mt-0.5 text-amber-700 dark:text-amber-300" />
              <div>
                <p className="font-bold">Revised — needs approval again (v{list.version})</p>
                <p className="mt-0.5 text-amber-700 dark:text-amber-300">
                  Make your edits, then re-submit. Because the BOM changed, your manager reviews it again before anything routes.
                </p>
              </div>
            </div>
          )}
          {canEdit && (
            <div className="sticky top-0 -mt-2 -mx-1 px-1 py-2 bg-card z-10 flex items-center justify-between border-b border-line-soft">
              <div className="text-xs text-muted">
                <span className="font-bold text-ink">Step 2:</span> Review qty + nature, then submit. In-stock → request; short stock + custom → one procurement indent.
              </div>
              <button
                onClick={handleSubmit}
                disabled={submitting || partition.total === 0 || urlAdvisory.dupUrls > 0}
                className="inline-flex items-center gap-1 bg-emerald-700 text-white px-3 py-1.5 rounded-md font-bold text-xs hover:bg-emerald-800 disabled:opacity-50 shadow-sm">
                <Send size={12} />
                {submitLabel()}
              </button>
            </div>
          )}

          {/* Routing summary — quick visual count of where each piece is
              going. Hidden when nothing routes (empty draft) since the
              read-only zeros are noise. */}
          {canEdit && partition.total > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-[11px]">
              <span className="text-[10px] font-bold text-faint uppercase">At submit:</span>
              {partition.inStock > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30 font-bold">
                  {partition.inStock} → requests
                </span>
              )}
              {partition.shortStock > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30 font-bold">
                  {partition.shortStock} short → indent
                </span>
              )}
              {partition.custom > 0 && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-sky-50 dark:bg-sky-400/15 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-400/30 font-bold">
                  {partition.custom} custom → indent
                </span>
              )}
              {/* Live cost preview — estimate only; procurement re-quotes at sourcing. */}
              <span className="ml-auto inline-flex items-center gap-2">
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-amber-50 dark:bg-amber-400/15 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-400/30 font-bold"
                  title="Estimated cost of everything going to procurement (short-stock + custom lines). This is the figure the approval threshold checks.">
                  Procurement ≈ ₹{partition.procurementSubtotal.toLocaleString('en-IN')}
                </span>
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded border bg-surface text-muted border-line font-bold"
                  title="Estimated value of the whole BOM, including in-stock pulls (which don't hit procurement).">
                  Grand total ≈ ₹{partition.estimatedGrandTotal.toLocaleString('en-IN')}
                </span>
              </span>
            </div>
          )}

          <div className="bg-surface rounded-md p-3 border border-line-soft">
            {/* Timeline now lives on the modal's title row (headerRight). */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div>
                <p className="text-[10px] text-faint uppercase font-bold">Status</p>
                {/* Once routed, "Approved" tells nobody where the parts are — the
                    honest status is the fulfillment rollup (how many issued vs.
                    still pending), counted bottom-up from the components below. */}
                {isPostRouted && componentRollup.total > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {componentRollup.issued > 0 && (
                      <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-md ring-1 ring-inset bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 ring-blue-600/20 dark:ring-blue-400/30">
                        {componentRollup.issued} issued
                      </span>
                    )}
                    {componentRollup.pending > 0 && (
                      <span className="inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-md ring-1 ring-inset bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 ring-amber-600/20 dark:ring-amber-400/30">
                        {componentRollup.pending} pending
                      </span>
                    )}
                    {componentRollup.issued === 0 && componentRollup.pending === 0 && (
                      <StatusBadge status={list.status} />
                    )}
                  </div>
                ) : (
                  <StatusBadge status={list.status} />
                )}
              </div>
              <div>
                <p className="text-[10px] text-faint uppercase font-bold">Project</p>
                <p className="font-medium text-ink truncate">{list.project?.name || <span className="italic text-faint">General / Others</span>}</p>
              </div>
              <div>
                <p className="text-[10px] text-faint uppercase font-bold">Department</p>
                <p className="font-medium text-ink truncate">{list.department?.name}</p>
              </div>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {/* Who raised the BOM and who's accountable for the parts —
                      far more useful on a routed list than the loan-duration
                      default (which now lives only in the edit form). We always
                      print the responsible person(s) explicitly, even on a
                      one-person BOM where that name repeats "Raised by": stating
                      accountability outright beats making the reader infer it. */}
                  <p className="text-[10px] text-faint uppercase font-bold">Raised by</p>
                  <p className="font-medium text-ink truncate" title={list.createdBy?.name || 'Unknown'}>
                    {list.createdBy?.name || 'Unknown'}
                  </p>
                  {(() => {
                    // Everyone accountable for the parts. The backend always
                    // stamps the raiser here too, so on a one-person BOM this
                    // name matches "Raised by" — that's intended: the
                    // responsible party is always stated explicitly.
                    const names: string[] = Array.from(new Set(
                      (list.responsiblePersons || [])
                        .map((rp: any) => rp.user?.name)
                        .filter(Boolean)
                    ));
                    if (names.length === 0) return null;
                    return (
                      <>
                        <p className="text-[10px] text-faint uppercase font-bold mt-1.5">
                          Responsible {names.length > 1 ? 'persons' : 'person'}
                        </p>
                        <p className="font-medium text-ink truncate" title={names.join(', ')}>
                          {names.join(', ')}
                        </p>
                      </>
                    );
                  })()}
                </div>
                {canEdit && (
                  <button
                    onClick={() => setEditingDetails(v => !v)}
                    title={editingDetails ? 'Close details editor' : 'Edit list name / project / duration / purpose'}
                    className="text-faint hover:text-brand p-1 shrink-0"
                  >
                    <Pencil size={14} />
                  </button>
                )}
              </div>
            </div>
            {/* Shared procurement purpose — visible at a glance, edited via the
                pencil above. Inherited by every procurement line that doesn't
                set its own. */}
            {(list.purpose || canEdit) && (
              <div className="mt-3 pt-3 border-t border-line-soft">
                <p className="text-[10px] text-faint uppercase font-bold">Shared purpose (procurement)</p>
                {list.purpose ? (
                  <p className="text-xs text-ink whitespace-pre-wrap">{list.purpose}</p>
                ) : (
                  <p className="text-xs italic text-faint">None set — each procurement line falls back to an auto-generated note. Use the pencil to add one for the whole BOM.</p>
                )}
              </div>
            )}
            {editingDetails && canEdit && (
              <div className="mt-3 pt-3 border-t border-line grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">List name</label>
                  <input
                    maxLength={120}
                    type="text"
                    value={detailsDraft.name || ''}
                    onChange={(e) => setDetailsDraft((d: any) => ({ ...d, name: e.target.value }))}
                    className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-brand outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Project</label>
                  <select
                    value={detailsDraft.projectId || '__OTHERS__'}
                    onChange={(e) => setDetailsDraft((d: any) => ({ ...d, projectId: e.target.value }))}
                    className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-brand outline-none">
                    {projects.filter((p: any) => p.isActive !== false).map((p: any) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                    <option value="__OTHERS__">General / Others</option>
                  </select>
                </div>
                <div className="flex gap-2">
                  <div className="flex-1">
                    <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Duration</label>
                    <NumberInput
                      min={1}
                      integer
                      value={Number(detailsDraft.durationValue) || 1}
                      onChange={(v) => setDetailsDraft((d: any) => ({ ...d, durationValue: v }))}
                      className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-brand outline-none"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Unit</label>
                    <select
                      value={detailsDraft.durationUnit || 'DAYS'}
                      onChange={(e) => setDetailsDraft((d: any) => ({ ...d, durationUnit: e.target.value }))}
                      className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-brand outline-none">
                      {DURATION_UNITS.map((u) => (
                        <option key={u} value={u}>
                          {durationUnitLabel(u, Number(detailsDraft.durationValue ?? 1), { capitalise: true })}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Shared purpose (procurement)</label>
                  <textarea
                    value={detailsDraft.purpose || ''}
                    onChange={(e) => setDetailsDraft((d: any) => ({ ...d, purpose: e.target.value }))}
                    rows={2}
                    placeholder="Why is this BOM being raised? Applied to every procurement line that doesn't set its own."
                    className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-brand outline-none resize-y"
                  />
                  <p className="text-[9px] text-faint mt-0.5">Each procurement line can still override this in its row details.</p>
                </div>
                <div className="md:col-span-2 flex justify-end gap-2 pt-1">
                  <button onClick={() => setEditingDetails(false)}
                    className="px-3 py-1 text-xs font-bold text-muted border border-line rounded hover:bg-surface">
                    Cancel
                  </button>
                  <button onClick={saveDetails} disabled={savingDetails}
                    className="px-3 py-1 text-xs font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50">
                    {savingDetails ? 'Saving…' : 'Save details'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Item filter — one box for whichever list is showing (the DRAFT/
              SUBMITTED editor tables, or the post-routed tracker). Shown only
              once the BOM is big enough to need it (200-500-component BOMs are
              the design target). Filters the rendered rows; advisories + totals
              are unaffected. */}
          {(isPostRouted
            ? componentRollup.total
            : indentItems.length + (list.customItems?.length || 0) + inStockItems.length) > 8 && (
            <div className="relative mb-3">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
              <input
                type="text"
                value={itemSearch}
                onChange={(e) => setItemSearch(e.target.value)}
                placeholder={isPostRouted
                  ? `Filter ${componentRollup.total} components by name or reference…`
                  : `Filter ${indentItems.length + (list.customItems?.length || 0) + inStockItems.length} lines by name, category, purpose…`}
                className="w-full border border-line rounded py-1.5 pl-8 pr-8 text-sm focus:border-brand outline-none"
              />
              {itemSearch && (
                <button
                  type="button"
                  onClick={() => setItemSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-muted"
                  title="Clear filter"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}

          {/* ──────────────────────────────────────────────────────────────
              PROCUREMENT (indent-bound) — TOP section.
              Combines out-of-stock inventory rows + custom items so the
              reviewer + requester see "what's going to procurement" in one
              place. URL surfaces INLINE on every row (not behind an
              expander) because the buyer's #1 question is "where do I
              source this?". Price + purpose + part number stay in the
              chevron-expander so the row itself stays compact for 200+
              line BOMs.
           ────────────────────────────────────────────────────────────── */}
          {/* Editor tables (Procurement + In stock) only render while the BOM is
              still being defined (DRAFT / SUBMITTED). Once ROUTED / COMPLETED,
              the unified tracker below replaces them — so a component is never
              restated as a read-only definition row AND a tracked artifact. */}
          {!isPostRouted && (<>
          {canEdit && (
            <BulkSelectionBar count={selectedItemIds().length} onClear={clearSelection}>
              <button
                onClick={() => bulkSetNature('PERMANENT')}
                className="px-2.5 py-1 text-xs font-bold rounded bg-violet-100 dark:bg-violet-400/20 text-violet-800 dark:text-violet-200 hover:bg-violet-200 transition-colors"
              >Set Permanent</button>
              <button
                onClick={() => bulkSetNature('TEMPORARY')}
                className="px-2.5 py-1 text-xs font-bold rounded bg-blue-100 dark:bg-blue-400/20 text-blue-800 dark:text-blue-200 hover:bg-blue-200 transition-colors"
              >Set Temporary</button>
              <button
                onClick={bulkDeleteSelected}
                className="px-2.5 py-1 text-xs font-bold rounded bg-red-600 text-white hover:bg-red-700 transition-colors"
              >Delete</button>
            </BulkSelectionBar>
          )}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h4 className="text-sm font-bold text-ink">
                {canEdit && <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wide mr-2">Procurement</span>}
                Indent-bound ({itemQuery
                  ? `${filteredIndentItems.length + filteredCustomItems.length} of ${indentItems.length + (list.customItems?.length || 0)}`
                  : indentItems.length + (list.customItems?.length || 0)})
              </h4>
              {canEdit && (
                <button
                  onClick={() => setShowCustomForm(v => !v)}
                  className="inline-flex items-center gap-1 text-xs font-bold text-sky-700 dark:text-sky-300 hover:text-sky-900 dark:text-sky-200 px-2 py-1 rounded hover:bg-sky-50 dark:bg-sky-400/15">
                  <Plus size={12} /> {showCustomForm ? 'Hide' : 'Add custom item'}
                </button>
              )}
            </div>

            {/* Roll-up caution for the procurement-bound lines. A MISSING link is
                a non-blocking amber note (submit still allowed). A DUPLICATE
                link is a hard block — the banner turns red and submit is disabled
                until it's fixed (no two products can share a vendor URL). */}
            {canEdit && (urlAdvisory.missing > 0 || urlAdvisory.dupUrls > 0) && (
              <div className={`mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-1.5 text-[11px] ${urlAdvisory.dupUrls > 0 ? 'border-red-300 dark:border-red-400/30 bg-red-50 dark:bg-red-400/15' : 'border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15'}`}>
                {urlAdvisory.dupUrls > 0 ? (
                  <span className="flex items-center gap-1 font-bold text-red-700 dark:text-red-300"><AlertTriangle size={12} /> Fix before submit</span>
                ) : (
                  <span className="flex items-center gap-1 font-bold text-amber-700 dark:text-amber-300"><AlertTriangle size={12} /> Heads up</span>
                )}
                {urlAdvisory.dupUrls > 0 && (
                  <span className="font-bold text-red-700 dark:text-red-300">{urlAdvisory.dupUrls} duplicated link{urlAdvisory.dupUrls === 1 ? '' : 's'} — two products can't share a URL, so one is wrong</span>
                )}
                {urlAdvisory.missing > 0 && (
                  <span className="text-amber-700 dark:text-amber-300">{urlAdvisory.missing} line{urlAdvisory.missing === 1 ? '' : 's'} with no vendor link — procurement sources blind</span>
                )}
              </div>
            )}

            {/* Add-custom form (unchanged below, just hoisted into this section) */}

            {/* Add-custom form */}
            {canEdit && showCustomForm && (
              <div className="mb-3 border border-sky-200 dark:border-sky-400/30 bg-sky-50/40 dark:bg-sky-400/15 rounded-md p-3 space-y-2 text-xs">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Name *</label>
                    <input
                      type="text"
                      value={customDraft.name}
                      onChange={(e) => setCustomDraft((d: any) => ({ ...d, name: e.target.value }))}
                      placeholder="e.g. ESP32-WROOM-32E"
                      className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-sky-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Category</label>
                    <select
                      value={customDraft.category}
                      onChange={(e) => setCustomDraft((d: any) => ({ ...d, category: e.target.value }))}
                      className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-sky-500 outline-none">
                      {CATEGORY_OPTIONS.map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Qty *</label>
                      <NumberInput
                        min={1}
                        value={Number(customDraft.qty) || 1}
                        onChange={(v) => setCustomDraft((d: any) => ({ ...d, qty: v }))}
                        className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-sky-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Unit *</label>
                      <input
                        type="text"
                        list="bom-unit-suggestions"
                        value={customDraft.unit}
                        onChange={(e) => setCustomDraft((d: any) => ({ ...d, unit: e.target.value }))}
                        placeholder="pcs / m / kg"
                        className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-sky-500 outline-none"
                      />
                      <datalist id="bom-unit-suggestions">
                        {COMMON_UNITS.map(u => <option key={u} value={u} />)}
                      </datalist>
                    </div>
                  </div>
                  <div className="grid grid-cols-[1fr_auto] gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Est. unit price</label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={customDraft.estimatedUnitAmount}
                        onChange={(e) => setCustomDraft((d: any) => ({ ...d, estimatedUnitAmount: e.target.value }))}
                        placeholder="0.00"
                        className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-sky-500 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Currency</label>
                      <select
                        value={customDraft.currency || 'INR'}
                        onChange={(e) => setCustomDraft((d: any) => ({ ...d, currency: e.target.value }))}
                        title="Currency this estimated price is in — non-INR converts to INR in the BOM totals"
                        className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-sky-500 outline-none">
                        {ALLOWED_CURRENCIES.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Part number</label>
                    <input
                      type="text"
                      value={customDraft.partNumber}
                      onChange={(e) => setCustomDraft((d: any) => ({ ...d, partNumber: e.target.value }))}
                      className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-sky-500 outline-none"
                    />
                  </div>
                  <div>
                    {/* URL is optional — recommended, not required. A missing or
                        duplicated link surfaces as a non-blocking caution on the
                        row; it never blocks submit. */}
                    <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Vendor URL</label>
                    <input
                      type="url"
                      value={customDraft.url}
                      onChange={(e) => setCustomDraft((d: any) => ({ ...d, url: e.target.value }))}
                      placeholder="https://… where procurement should buy this (recommended)"
                      className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-sky-500 outline-none"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Description</label>
                    <input
                      type="text"
                      value={customDraft.description}
                      onChange={(e) => setCustomDraft((d: any) => ({ ...d, description: e.target.value }))}
                      placeholder="Specs / variant / model"
                      className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-sky-500 outline-none"
                    />
                  </div>
                  <div className="md:col-span-2">
                    <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Purpose</label>
                    <input
                      type="text"
                      value={customDraft.purpose}
                      onChange={(e) => setCustomDraft((d: any) => ({ ...d, purpose: e.target.value }))}
                      placeholder={list?.purpose ? "Leave blank to inherit the BOM's shared purpose" : 'Why is this needed?'}
                      className="w-full border border-line rounded py-1.5 px-2 text-sm focus:border-sky-500 outline-none"
                    />
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <button onClick={() => setShowCustomForm(false)}
                    className="px-3 py-1 text-xs font-bold text-muted border border-line rounded hover:bg-surface">
                    Cancel
                  </button>
                  <button onClick={addCustomItem} disabled={addingCustom}
                    className="px-3 py-1 text-xs font-bold bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50">
                    {addingCustom ? 'Adding…' : 'Add to list'}
                  </button>
                </div>
              </div>
            )}

            {/* Empty-state: nothing routes to procurement yet. */}
            {indentItems.length === 0 && (list.customItems?.length || 0) === 0 && !showCustomForm && (
              <div className="text-center text-faint py-4 border border-dashed border-line rounded-md text-xs italic">
                No procurement-bound items yet. Out-of-stock inventory items and custom items both route here.
              </div>
            )}

            {/* Combined indent-bound list as a single table: out-of-stock
                inventory rows first, then custom items, under one aligned
                column header (Item · Qty · Vendor URL · Description · Actions) —
                one row per item, all columns centre-aligned. The vendor URL and
                the free-text description each sit in their own column so buyers
                see the link and the requested model/variant/spec at a glance.
                Price / purpose / part number stay in the per-row expander so the
                table stays compact even for 200+ line BOMs. Scrolls horizontally
                on very narrow screens. */}
            {(indentItems.length > 0 || (list.customItems?.length || 0) > 0) && (
              <ProcurementLinesTable
                canEdit={canEdit}
                list={list}
                indentPager={indentPager}
                customPager={customPager}
                filteredIndentItems={filteredIndentItems}
                filteredCustomItems={filteredCustomItems}
                selectedLines={selectedLines}
                selKey={selKey}
                renderSelCell={renderSelCell}
                renderSelAllHeader={renderSelAllHeader}
                qtyDraft={qtyDraft}
                setQtyDraft={setQtyDraft}
                flashLineId={flashLineId}
                commitQty={commitQty}
                openProcDetails={openProcDetails}
                setOpenProcDetails={setOpenProcDetails}
                urlAdvisory={urlAdvisory}
                patchInvItem={patchInvItem}
                patchCustomItem={patchCustomItem}
                commitVendorUrl={commitVendorUrl}
                dropProcurementPortion={dropProcurementPortion}
                removeLine={removeLine}
                removeCustom={removeCustom}
                itemQuery={itemQuery}
                itemSearch={itemSearch}
              />
            )}
          </div>

          {/* ──────────────────────────────────────────────────────────────
              IN STOCK (request-bound) — BOTTOM section.
              Only renders lines where qty ≤ stock at the moment. If the
              requester bumps qty above stock, the row reactively jumps to
              the indent section above.
              URL field IS still collected on these lines: at routing time
              the partition is re-done against live stock, and a row that
              was in-stock at edit time can flip to an indent line if
              someone else issued stock in between. Without a URL on every
              row, that path lands a blank URL in procurement's queue.
           ────────────────────────────────────────────────────────────── */}
          <div>
            <h4 className="text-sm font-bold text-ink mb-2">
              {canEdit && <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 uppercase tracking-wide mr-2">In stock</span>}
              Request-bound ({itemQuery
                ? `${filteredInStockItems.length + filteredSplitLines.length} of ${inStockItems.length + splitLines.length}`
                : inStockItems.length + splitLines.length})
            </h4>
            {inStockItems.length === 0 && splitLines.length === 0 && (
              (() => {
                // "All short-stock" branch is a status note, not an action.
                // The "none yet" branch is a real call-to-action: send the
                // requester to the inventory catalog where bulk-select adds rows.
                if (list.items?.length > 0) {
                  return (
                    <div className="text-center text-faint py-4 border border-dashed border-line rounded-md text-xs italic">
                      All inventory items on this BOM are short stock — they'll be bought through procurement.
                    </div>
                  );
                }
                const invPath = user?.role ? INVENTORY_ITEMS_PATH_BY_ROLE[user.role] : undefined;
                if (canEdit && invPath) {
                  return (
                    <button
                      type="button"
                      onClick={() => navigate(invPath)}
                      title="Go to Inventory Items — bulk-select rows there to add them to this BOM"
                      className="w-full text-center text-faint py-4 border border-dashed border-line rounded-md text-xs italic hover:border-emerald-300 dark:border-emerald-400/30 hover:bg-emerald-50/40 dark:bg-emerald-400/15 hover:text-emerald-700 dark:text-emerald-300 transition-colors cursor-pointer"
                    >
                      No inventory items yet. <span className="font-bold not-italic underline">Go to Inventory Items</span> and use bulk-select to add to this list.
                    </button>
                  );
                }
                return (
                  <div className="text-center text-faint py-4 border border-dashed border-line rounded-md text-xs italic">
                    No inventory items yet. Go to Inventory Items and use bulk-select to add to this list.
                  </div>
                );
              })()
            )}
            {(inStockItems.length > 0 || splitLines.length > 0) && (
              <InStockLinesTable
                canEdit={canEdit}
                list={list}
                setList={setList}
                onChanged={onChanged}
                addToast={addToast}
                inStockPager={inStockPager}
                splitPager={splitPager}
                filteredInStockItems={filteredInStockItems}
                filteredSplitLines={filteredSplitLines}
                selectedLines={selectedLines}
                selKey={selKey}
                renderSelCell={renderSelCell}
                renderSelAllHeader={renderSelAllHeader}
                qtyDraft={qtyDraft}
                setQtyDraft={setQtyDraft}
                commitQty={commitQty}
                patchInvItem={patchInvItem}
                commitVendorUrl={commitVendorUrl}
                durationDraft={durationDraft}
                setDurationDraft={setDurationDraft}
                removeLine={removeLine}
                jumpToIndentQty={jumpToIndentQty}
                itemQuery={itemQuery}
                itemSearch={itemSearch}
              />
            )}
          </div>
          </>)}

          {/* "Components" — the routed BOM's unified per-component tracker
              (one row per physical part, folded bottom-up). See ComponentsTracker
              for the full rationale. */}
          {isPostRouted && componentRollup.total > 0 && (
            <ComponentsTracker
              rollup={componentRollup}
              itemQuery={itemQuery}
              itemSearch={itemSearch}
              reraiseDraftFor={reraiseDraftFor}
              reraiseQty={reraiseQty}
              setReraiseQty={setReraiseQty}
              reraiseReason={reraiseReason}
              setReraiseReason={setReraiseReason}
              reraisingId={reraisingId}
              onOpenReraise={openReraise}
              onCancelReraise={cancelReraise}
              onSubmitReraise={submitReraise}
              onClose={onClose}
              navigate={navigate}
              roleSlug={roleSlug}
            />
          )}

          {canEdit && (
            <div className="flex justify-end gap-2 pt-3 border-t border-line-soft">
              <button type="button" onClick={onClose}
                className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface">
                Close
              </button>
              <button onClick={handleSubmit} disabled={submitting || partition.total === 0 || urlAdvisory.dupUrls > 0}
                className="bg-brand text-white px-6 py-2 rounded-full font-bold text-sm hover:bg-brand-dark disabled:opacity-50">
                {submitLabel()}
              </button>
            </div>
          )}
        </div>
      )}
    </Modal>
    <BomTimelineDrawer
      bomListId={timelineOpen ? list?.id ?? null : null}
      onClose={() => setTimelineOpen(false)}
    />
    </>
  );
};
