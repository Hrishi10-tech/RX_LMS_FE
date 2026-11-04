import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams, useLocation } from 'react-router-dom';
import { useAuth, useServerPagination, useBulkSelection, usePagedFilters, useRowDeepLink, FilterSpec, useAbortOnUnmount } from '@/hooks';
import { DataTable, StatusBadge, Modal, IndentProgressStepper, BulkSelectionBar, BulkActionButton, ColumnFilter, PendingCell, ExportPanel, Pagination, SearchInput, LoadAllCapNote } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { client } from '@/api';
import { extractErrorMessage } from '@/lib';
import { runPerId } from '@/utils/bulk';
import { IndentForm } from '@/components/forms';
import { fmtDateTime, fmtDate, dateOnlyKey } from '@/utils/date';
import { statusReasonForIndent, statusReasonForRequest } from '@/utils/pendingReason';
import { inCustomsClearance } from '@/utils/indentStatus';
import { Clock, Eye, Pencil, AlertCircle, Trash2 } from 'lucide-react';
import { ReviseRequestModal } from '@/features/requests/components/ReviseRequestModal';
import { UserRole } from '@/types';


// Human-readable "Where is it?" text
const WHERE_IS_IT: Record<string, string> = {
  PENDING: 'Waiting for admin approval',
  APPROVED: 'Procurement team is working on it',
  QUOTATION_IN_PROGRESS: 'Getting vendor quotes',
  AWAITING_PAYMENT: 'Waiting for finance to process payment',
  PAYMENT_DONE: 'Payment done — placing order',
  ORDERED: 'Order placed with vendor',
  IN_TRANSIT: 'Shipped — on the way',
  PARTIALLY_RECEIVED: 'Partly delivered — claim what arrived; rest on the way',
  RECEIVED: 'Received in inventory',
  REJECTED: 'Rejected by admin',
  CANCELLED: 'Cancelled',
};

// `inCustomsClearance` (and its `hasCustomsActivity` basis) now live in
// @/utils/indentStatus so the Indents page, Requests page and BOM status rollup
// all derive the "Customs clearance" pseudo-status identically.

const getWhereText = (indent: any) => {


  if (inCustomsClearance(indent)) return 'Clearing customs';
  const base = WHERE_IS_IT[indent.status] || indent.status;
  if ((indent.status === 'ORDERED' || indent.status === 'IN_TRANSIT' || indent.status === 'PARTIALLY_RECEIVED') && indent.vendorName) {
    return `${base} (${indent.vendorName})`;
  }
  if (indent.status === 'AWAITING_PAYMENT') {
    const days = indent.holderSince ? Math.ceil((Date.now() - new Date(indent.holderSince).getTime()) / 86400000) : 0;
    return days > 2 ? `${base} — ${days} days waiting` : base;
  }
  return base;
};

// The I/P Requests page: raise + track your own indents and component requests.
// Mounted for every role that can raise them (USER/MANAGER/LAB and the central
// roles PROCUREMENT/INVENTORY/FINANCE/ASSOCIATE_FINANCE).
export const StandardIPRequestsPage = () => {
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();
   const { user } = useAuth();
   const navigate = useNavigate();
   const roleSlug = user?.role.toLowerCase().replace(/_/g, '-') || 'user';
   const { addToast } = useToast();
   const confirm = useConfirm();

   // Per-modal opt-in for withdrawn (soft-deleted) rows — off by default. Each
   // history modal has its own toggle (indents vs. requests) that drives both
   // that modal's fetch and its export, so each download matches its own table.
   // Declared before the pagination hooks below (they read these in `params`,
   // so the const must exist first — no temporal-dead-zone error).

   const [showDeletedIndents, setShowDeletedIndents] = useState(false);
   const [showDeletedReqs, setShowDeletedReqs] = useState(false);

   // Four independent server-side buckets (two data sources), each 10/page and
   // scoped to the signed-in user (createdByMe). Indents split active vs. done;
   // component requests split pre-issuance-active vs. rejected. Post-issuance
   // request statuses (IN_USE/OVERDUE/…/DISPOSED) deliberately live on the "My
   // Components" page, so they're excluded from both request buckets here.
   const activeIndentsP = useServerPagination<any>({ loadAll: true, endpoint: '/indents', params: { createdByMe: true, status: 'PENDING,APPROVED,QUOTATION_IN_PROGRESS,READY_FOR_PAYMENT,AWAITING_PAYMENT,PAYMENT_DONE,ORDERED,IN_TRANSIT,PARTIALLY_RECEIVED' } });
   // The two history lists are shown only in their modals, so they load only
   // while their modal is open. Ungated they pulled up to 2,000 rows each on
   // every visit, and again on every keystroke in the search box (which feeds
   // all four lists). The History buttons' counts come from a one-row request
   // per list instead (pageSize 1 → take=1, which still returns `total`).
   const [isIndentHistoryOpen, setIsIndentHistoryOpen] = useState(false);
   const [isRequestHistoryOpen, setIsRequestHistoryOpen] = useState(false);
   const pastIndentsParams = { createdByMe: true, status: 'RECEIVED,REJECTED,CANCELLED', includeDeleted: showDeletedIndents };
   const pastIndentsP   = useServerPagination<any>({ loadAll: true, endpoint: '/indents', params: pastIndentsParams, enabled: isIndentHistoryOpen });
   const pastIndentsCountP = useServerPagination<any>({ endpoint: '/indents', pageSize: 1, params: pastIndentsParams });
   const activeReqP     = useServerPagination<any>({ loadAll: true, endpoint: '/requests', params: { createdByMe: true, status: 'PENDING,APPROVED,YET_TO_ISSUE' } });
   // Everything the active list above does NOT show. It asked for REJECTED
   // alone, so a request you raised and actually received disappeared off this
   // page the moment it was issued: active covers PENDING/APPROVED/YET_TO_ISSUE,
   // and the other seven statuses appeared in neither list. The item turns up
   // under My Components, but the REQUEST — its number, who approved it, what
   // was issued against it — had nowhere to be seen.
   //
   // The indent side of this page already works that way (active up to
   // PARTIALLY_RECEIVED, history RECEIVED/REJECTED/CANCELLED), so between the
   // two lists no status is unreachable. This makes requests match.
   const REQUEST_HISTORY_STATUSES = 'IN_USE,OVERDUE,RETURN_REQUESTED,RETURNED,REJECTED,DISPOSED,EMBEDDED,CONSUMED';
   const pastReqParams = { createdByMe: true, status: REQUEST_HISTORY_STATUSES, includeDeleted: showDeletedReqs };
   const pastReqP       = useServerPagination<any>({ loadAll: true, endpoint: '/requests', params: pastReqParams, enabled: isRequestHistoryOpen });
   const pastReqCountP  = useServerPagination<any>({ endpoint: '/requests', pageSize: 1, params: pastReqParams });
   const activeIndents = activeIndentsP.items;
   const pastIndents   = pastIndentsP.items;
   const activeRequests = activeReqP.items;
   const pastRequests   = pastReqP.items;
   const indLoading = activeIndentsP.isLoading;
   const reqLoading = activeReqP.isLoading;
   const refreshIndents = () => {
     activeIndentsP.refetch(); pastIndentsP.refetch(); pastIndentsCountP.refetch();
     // Edit-qty / delete / create on an own indent must nudge the procurement/
     // admin queue + badges, which listen on indents-updated (this refetch alone
     // only updated the requester's own view).
     window.dispatchEvent(new Event('indents-updated'));
   };

   const [editingIndent, setEditingIndent] = useState<any>(null);
   const [loadingEditId, setLoadingEditId] = useState<string | null>(null);
   const [isNewIndentModalOpen, setIsNewIndentModalOpen] = useState(false);
   const [isSubmitting, setIsSubmitting] = useState(false);
   const [timelineModal, setTimelineModal] = useState<any>(null);
   const [timeline, setTimeline] = useState<any[]>([]);
   const [timelineLoading, setTimelineLoading] = useState(false);
   const indSel = useBulkSelection();
   const reqSel = useBulkSelection();
   // Requester-facing edit of a pre-issue request. The duplicate-guard routes
   // users here and highlights the row(s); the pencil opens the editor. Holds
   // the target id + its current stock for the qty cap; null = closed.
   const [reviseTarget, setReviseTarget] = useState<{ id: string; stock?: number } | null>(null);
   // Duplicate-guard landing state: the ids of the user's existing open
   // request(s) for the item they just tried to re-raise (highlighted in the
   // table), the item name for the popper copy, and whether the popper shows.
   const [dupHighlightIds, setDupHighlightIds] = useState<Set<string>>(new Set());
   const [dupItemName, setDupItemName] = useState<string>('');
   const [showDupNote, setShowDupNote] = useState(false);
   // The exact payload the user tried to submit (carried in via navigation
   // state from RequestForm's dup guard). Lets the popper offer a one-click
   // "raise it anyway" without re-keying. null = no escape hatch to offer.
   const [dupPayload, setDupPayload] = useState<any>(null);
   const [raisingSeparate, setRaisingSeparate] = useState(false);

   // Deep-link from notifications. When a user clicks a back-order /
   // procurement notification on /notifications, we navigate them here with
   // ?openIndent=<id> in the URL and auto-open the timeline modal. The ref
   // guard makes sure we only do this ONCE per query-param value — otherwise
   // opening the modal would race with the next render and re-trigger.
   const [searchParams, setSearchParams] = useSearchParams();
   const location = useLocation();
   const openIndentId = searchParams.get('openIndent');
   const dupItemId = searchParams.get('dupItem');
   const handledQueryParamRef = useRef<string | null>(null);

   useEffect(() => {
     if (!openIndentId) return;
     if (handledQueryParamRef.current === `i:${openIndentId}`) return;
     handledQueryParamRef.current = `i:${openIndentId}`;
     // With server-side pagination the target indent may be on any page (or in
     // History), so fetch it directly by id instead of scanning the current
     // page. Scoping is enforced server-side — a 404/403 just means "not yours".
     (async () => {
       try {
         const res = await client.get(`/indents/${openIndentId}`, { signal: abortSignal() });
         const indent = res.data?.data ?? res.data;
         if (indent?.id) openTimeline(indent);
       } catch { /* indent not visible to this user — ignore */ }
     })();
     // Strip the query param so a refresh doesn't re-open the modal.
     const next = new URLSearchParams(searchParams);
     next.delete('openIndent');
     setSearchParams(next, { replace: true });
   }, [openIndentId, searchParams, setSearchParams]);

   // openRequest deep-link: scroll the request row into view + flash-highlight.
   // The request modal logic doesn't exist (requests are just rows), so a
   // visual cue is the best we can do.
   //
   // This looked for `[data-request-id]`, which nothing renders — DataTable
   // emits `data-row-id`. So the highlight never fired on any of the three
   // pages notifications deep-link to. `useRowDeepLink` owns the corrected
   // lookup and is shared with Approvals / Inventory Requests.
   const deepLinkHighlightId = useRowDeepLink({
     param: 'openRequest',
     ready: !reqLoading,
     onMissing: () =>
       addToast("That request isn't on this page of your tracker — try another page or the History log.", 'info'),
   });

   // dupItem landing from the duplicate-guard: the Raise form found the user
   // already has open request(s) for this item and routed them here instead of
   // stacking another. Highlight their editable rows for that item, scroll the
   // first into view, and pop a note nudging them to edit the quantity. No
   // auto-open — the highlighted pencil is the call-to-action.
   useEffect(() => {
     if (!dupItemId || reqLoading) return;
     if (handledQueryParamRef.current === `d:${dupItemId}`) return;
     handledQueryParamRef.current = `d:${dupItemId}`;
     const dupes = activeRequests.filter(
       (r: any) => r?.inventoryItem?.id === dupItemId
         && r?.createdById === user?.id
         && (r?.status === 'PENDING' || r?.status === 'APPROVED'),
     );
     setDupHighlightIds(new Set(dupes.map((r: any) => r.id)));
     setDupItemName(dupes[0]?.inventoryItem?.name || '');
     // Captured before the param strip below clears navigation state. Only set
     // when RequestForm actually handed us a payload (manual ?dupItem= won't).
     setDupPayload((location.state as any)?.dupPayload ?? null);
     setShowDupNote(true);
     // Defer until the rows render, then bring the first match into view.
     setTimeout(() => {
       const el = document.querySelector(`[data-row-id="${dupes[0]?.id}"]`);
       if (el && (el as HTMLElement).scrollIntoView) (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
     }, 200);
     const next = new URLSearchParams(searchParams);
     next.delete('dupItem');
     setSearchParams(next, { replace: true });
     // eslint-disable-next-line react-hooks/exhaustive-deps -- location.state is captured imperatively when resolving the dup link; adding it would re-fire on unrelated navigation-state changes
   }, [dupItemId, reqLoading, activeRequests, user?.id, searchParams, setSearchParams]);

   // Escape hatch from the dup popper: the user genuinely wants a *separate*
   // request for the same item, not an edit of the existing one. Re-submit the
   // exact payload they tried before (no dup guard on a direct POST), then
   // refresh the active bucket so the new PENDING row appears.
   const handleRaiseSeparately = async () => {
     if (!dupPayload || raisingSeparate) return;
     setRaisingSeparate(true);
     try {
       await client.post('/requests', dupPayload);
       addToast('New request submitted', 'success');
       setShowDupNote(false);
       setDupHighlightIds(new Set());
       setDupPayload(null);
       activeReqP.refetch();
     } catch (e: any) {
       addToast(extractErrorMessage(e, 'Failed to submit request'), 'error');
     } finally {
       setRaisingSeparate(false);
     }
   };

   // Full request-slip edit (requestor, PENDING only). Fetch the whole indent
   // so the form pre-fills every line + request field, then PATCH /:id/slip.
   const openSlipEdit = async (row: any) => {
       setLoadingEditId(row.id);
       try {
           const res = await client.get(`/indents/${row.id}`, { signal: abortSignal() });
           setEditingIndent(res.data?.data ?? res.data);
       } catch (e: any) {
           addToast(extractErrorMessage(e, 'Could not load the request to edit'), 'error');
       } finally { setLoadingEditId(null); }
   };

   const handleSaveSlip = async (data: any) => {
       if (!editingIndent) return;
       setIsSubmitting(true);
       try {
           await client.patch(`/indents/${editingIndent.id}/slip`, {
               items: data.items,
               emergency: data.emergency,
               emergencyReason: data.emergencyReason,
               projectId: data.projectId,
               responsiblePersonIds: data.responsiblePersonIds,
           });
           addToast('Request slip updated', 'success');
           setEditingIndent(null);
           refreshIndents();
       } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to update the slip'), 'error'); }
       finally { setIsSubmitting(false); }
   };

   const handleDeleteIndent = async (indentId: string) => {
       if (await confirm('Delete this indent?')) {
           try {
               await client.delete(`/indents/${indentId}`);
               addToast('Indent deleted', 'success');
               refreshIndents();
           } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to delete'), 'error'); }
       }
   };

   // Requester-facing withdraw of a not-yet-issued component request. The
   // trash affordance only renders on owned PENDING/APPROVED rows (same gate
   // the backend enforces), so this is a confirm → DELETE → refetch.
   const handleDeleteRequest = async (row: any) => {
       if (await confirm(`Delete ${row?.serialNo || 'this request'}? This can't be undone.`)) {
           try {
               await client.delete(`/requests/${row.id}`);
               addToast('Request deleted', 'success');
               // If the dup popper was pointing at this row, drop the highlight.
               setDupHighlightIds((prev) => { const n = new Set(prev); n.delete(row.id); return n; });
               activeReqP.refetch();
           } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to delete request'), 'error'); }
       }
   };

   const handleCreateIndent = async (data: any) => {
       setIsSubmitting(true);
       try {
           // Returned so IndentForm can attach its optional per-line photos,
           // which need the ids the server assigns.
           const indentRes = await client.post('/indents', data);
           addToast('Indent raised', 'success');
           setIsNewIndentModalOpen(false);
           refreshIndents();
       // Hand the saved indent back so the form can attach its photos.
       return indentRes.data?.data ?? indentRes.data;
       } catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
       finally { setIsSubmitting(false); }
   };

   const openTimeline = async (indent: any) => {
       // If the user opened Track from inside one of the History modals,
       // close that modal first — otherwise the Track modal stacks behind
       // the History one and only its edges are visible.
       setIsIndentHistoryOpen(false);
       setIsRequestHistoryOpen(false);
       setTimelineModal(indent);
       setTimelineLoading(true);
       try {
           const res = await client.get(`/indents/${indent.id}/timeline`, { signal: abortSignal() });
           setTimeline(res.data?.data || res.data || []);
       } catch { setTimeline([]); }
       setTimelineLoading(false);
   };

   // "Request" on a RECEIVED indent row → drop the user into the Request
   // Component form pre-filled from this indent's claim. The dashboard does
   // the actual modal + auto-fill (so the deep-link UX is identical to the
   // notification flow). We just navigate with ?claimFromIndent=<id>;
   // resolution to the canonical inventoryItemId happens dashboard-side
   // (handles the null-FK + merged-canonical cases without us reaching for
   // /inventory here just to find one row).

   // Bucket membership is now enforced server-side by each hook's status
   // filter (see the four useServerPagination calls above):
   //   active indents   = NOT RECEIVED/REJECTED/CANCELLED
   //   past indents     = RECEIVED/REJECTED/CANCELLED
   //   active requests  = PENDING/APPROVED/YET_TO_ISSUE (pre-issuance, not rejected)
   //   past requests    = REJECTED
   // Post-issuance request statuses (IN_USE … DISPOSED) belong to "My
   // Components", so they appear in neither request bucket here.

   const indFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
       { key: 'indentNo', getValue: (r) => r?.serialNo },
       // Every line on the indent is a value (multi-valued column) — filtering on
       // the first line only made the 2nd+ items unfindable.
       { key: 'item',     getValue: (r) => { const names = (r?.items || []).map((i: any) => i?.name).filter(Boolean); return names.length ? names : (r?.serialNo ?? null); } },
       { key: 'amount',   getValue: (r) => r?.grandTotal != null ? `₹${r.grandTotal.toLocaleString()}` : '—' },
       { key: 'status',   getValue: (r) => r?.status },
       { key: 'where',    getValue: (r) => getWhereText(r) },
       { key: 'expected', getValue: (r) => r.expectedDeliveryDate ? dateOnlyKey(r.expectedDeliveryDate) : (['RECEIVED', 'REJECTED', 'CANCELLED'].includes(r.status) ? '—' : 'TBD') },
   ], []);

   const reqFilterSpecs = useMemo<FilterSpec<any>[]>(() => [
       { key: 'requestNo', getValue: (r) => r?.serialNo },
       { key: 'item',   getValue: (r) => r?.inventoryItem?.name },
       { key: 'qty',    getValue: (r) => r?.qtyRequested },
       { key: 'status', getValue: (r) => r?.status },
       { key: 'nature', getValue: (r) => r?.nature === 'PERMANENT' ? 'Permanent' : 'Temporary' },
   ], []);

   // Active tables filter only on in-flight rows; History modals filter on
   // their respective done buckets. Keeping two filter contexts means the
   // user's "show me REJECTED in history" filter doesn't leak into the active
   // table and vice versa.
   const indF = usePagedFilters(activeIndents, indFilterSpecs, 10, activeIndentsP.search);
   const reqF = usePagedFilters(activeRequests, reqFilterSpecs, 10, activeReqP.search);
   const indHistF = usePagedFilters(pastIndents, indFilterSpecs, 10, pastIndentsP.search);
   const reqHistF = usePagedFilters(pastRequests, reqFilterSpecs, 10, pastReqP.search);

   const buildIndCols = (f: any) => [
       { filterActive: f.isActive('indentNo'), header: <span className="inline-flex items-center">Indent #<ColumnFilter searchable options={f.getOptions('indentNo')} value={f.filters.indentNo || ''} onChange={(v) => f.setFilter('indentNo', v)} /></span>, accessor: (row: any) => (
           <div className="flex flex-col items-start gap-0.5">
               <span className="font-mono text-xs font-bold text-ink">{row?.serialNo || '—'}</span>
               {/* "from BOM-XXX" chip — only renders when this indent was
                   bundled out of a BOM submission (out-of-stock + custom
                   lines route here). Click → opens the source BOM in
                   read-only mode. */}
               {row?.bomListId && row?.bomList?.serialNo && (
                   <button type="button"
                       onClick={() => navigate(`/${roleSlug}/lists?openList=${row.bomListId}`)}
                       title={`Part of ${row.bomList.serialNo}${row.bomList.name ? ` — ${row.bomList.name}` : ''}. Click to see the full BOM.`}
                       className="text-[9px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 px-1.5 py-0.5 rounded hover:bg-emerald-100 dark:bg-emerald-400/20">
                       from {row.bomList.serialNo}
                   </button>
               )}
           </div>
       ) },
       { filterActive: f.isActive('item'),     header: <span className="inline-flex items-center">Item<ColumnFilter searchable options={f.getOptions('item')}        value={f.filters.item     || ''} onChange={(v) => f.setFilter('item', v)}     /></span>, accessor: (row: any) => {
           const items: any[] = row?.items || [];
           const first = items[0]?.name || row?.serialNo || 'N/A';
           const extra = Math.max(0, items.length - 1);
           // Show first item + "(+N more)" tag so users with multi-item indents
           // can see at a glance that there's more than what's listed. The chip
           // is clickable — opens the Track modal with the full breakdown so
           // users don't have to hunt for the Track button to see the rest.
           const titleText = items.length > 1 ? `${items.map((it) => `${it.name} × ${it.qty}`).join('\n')}\n\nClick to see the full breakdown` : '';
           return (
             <span className="font-bold text-ink">
               {first}
               {extra > 0 && (
                 <button type="button" onClick={() => openTimeline(row)} title={titleText}
                   className="ml-1.5 text-[10px] font-bold bg-brand/15 text-brand-700 px-1.5 py-0.5 rounded hover:bg-brand/25 transition-colors cursor-pointer">
                   +{extra} more
                 </button>
               )}
             </span>
           );
       } },
       { filterActive: f.isActive('amount'),   header: <span className="inline-flex items-center">Amount<ColumnFilter searchable options={f.getOptions('amount')}    value={f.filters.amount   || ''} onChange={(v) => f.setFilter('amount', v)}   /></span>, accessor: (row: any) => <span className="font-bold text-ink">{row?.grandTotal != null ? `₹${row.grandTotal.toLocaleString()}` : '—'}</span> },
       { filterActive: f.isActive('status'),   header: <span className="inline-flex items-center">Status<ColumnFilter options={f.getOptions('status')}                  value={f.filters.status   || ''} onChange={(v) => f.setFilter('status', v)}   /></span>, accessor: (row: any) => <PendingCell status={inCustomsClearance(row) ? 'CUSTOMS_CLEARANCE' : (row?.status || 'UNKNOWN')} reason={inCustomsClearance(row) ? null : statusReasonForIndent(row)} deleted={!!row?.deletedAt} /> },
       { filterActive: f.isActive('where'),    header: <span className="inline-flex items-center">Where is it?<ColumnFilter options={f.getOptions('where')}            value={f.filters.where    || ''} onChange={(v) => f.setFilter('where', v)}    /></span>, accessor: (row: any) => {
           const text = getWhereText(row);
           const isFinance = row.status === 'AWAITING_PAYMENT';
           return (
               <span className={`text-xs ${isFinance ? 'text-amber-700 dark:text-amber-300 font-bold' : 'text-muted'}`}>
                   {text}
               </span>
           );
       }},
       { filterActive: f.isActive('expected'), header: <span className="inline-flex items-center">Expected<ColumnFilter searchable options={f.getOptions('expected')} value={f.filters.expected || ''} onChange={(v) => f.setFilter('expected', v)} /></span>, accessor: (row: any) => {
           if (row.expectedDeliveryDate) return <span className="text-xs text-muted">{row.expectedDeliveryHasTime ? fmtDateTime(row.expectedDeliveryDate) : fmtDate(row.expectedDeliveryDate)}</span>;
           if (['RECEIVED', 'REJECTED', 'CANCELLED'].includes(row.status)) return <span className="text-xs text-faint">—</span>;
           // "TBD" = procurement hasn't allocated a vendor yet, so no delivery
           // date exists. Tooltip makes that explicit so users don't think it's
           // a bug or a placeholder we forgot to fill.
           return <span className="text-xs text-faint cursor-help underline decoration-dotted decoration-faint/60" title="Expected delivery date — set by Procurement once a vendor is allocated">TBD</span>;
       }},
       { header: '', accessor: (row: any) => {
           // Only the creator (or SUPER_ADMIN / ADMIN) sees Edit/Delete. Previously
           // the buttons were shown to everyone and clicking just produced a 403 toast.
           const isOwner = row?.createdById === user?.id;
           const canManage = isOwner || user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.ADMIN;
           const isEditableStatus = row.status === 'PENDING' || row.status === 'APPROVED';
           return (
             <div className="flex items-center gap-2">
                 <button onClick={() => openTimeline(row)} className="text-xs text-brand font-bold hover:underline flex items-center gap-1" title="View timeline">
                     <Eye size={12} /> Track
                 </button>
                 {/* "Request" used to live here for RECEIVED indents — but
                     RECEIVED is now in History, which is view-only. Users
                     claim items via the notification CTA or the Inventory
                     Items page. Track stays because it's read-only. */}
                 {/* Full request-slip edit — only BEFORE any approval (PENDING).
                     Opens the raise form pre-filled; saves via PATCH /:id/slip. */}
                 {canManage && row.status === 'PENDING' && (
                     <button onClick={() => openSlipEdit(row)} disabled={loadingEditId === row.id}
                         className="text-xs text-blue-600 dark:text-blue-300 font-bold hover:underline">
                         {loadingEditId === row.id ? 'Opening…' : 'Edit'}
                     </button>
                 )}
                 {canManage && isEditableStatus && (
                     <button onClick={() => handleDeleteIndent(row.id)} className="text-xs text-red-700 dark:text-red-300 font-bold hover:underline">Delete</button>
                 )}
             </div>
           );
       }},
   ];

   const buildReqCols = (f: any) => [
       { filterActive: f.isActive('requestNo'), header: <span className="inline-flex items-center">Request #<ColumnFilter searchable options={f.getOptions('requestNo')} value={f.filters.requestNo || ''} onChange={(v) => f.setFilter('requestNo', v)} /></span>, accessor: (row: any) => (
           <div className="flex flex-col items-start gap-0.5">
               <span className="font-mono text-xs font-bold text-ink">{row?.serialNo || '—'}</span>
               {/* "from BOM-XXX" chip — only renders when this request was
                   spawned from a BOM submission. Click → opens the source BOM
                   in read-only mode so the user can see the full batch. */}
               {row?.bomListId && row?.bomList?.serialNo && (
                   <button type="button"
                       onClick={() => navigate(`/${roleSlug}/lists?openList=${row.bomListId}`)}
                       title={`Part of ${row.bomList.serialNo}${row.bomList.name ? ` — ${row.bomList.name}` : ''}. Click to see the full BOM.`}
                       className="text-[9px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 px-1.5 py-0.5 rounded hover:bg-emerald-100 dark:bg-emerald-400/20">
                       from {row.bomList.serialNo}
                   </button>
               )}
           </div>
       ) },
       { filterActive: f.isActive('item'),   header: <span className="inline-flex items-center">Item<ColumnFilter searchable options={f.getOptions('item')}   value={f.filters.item   || ''} onChange={(v) => f.setFilter('item', v)}   /></span>, accessor: (row: any) => <span className="font-bold text-ink">{row?.inventoryItem?.name || 'Unknown'}</span> },
       { filterActive: f.isActive('qty'),    header: <span className="inline-flex items-center">Qty<ColumnFilter options={f.getOptions('qty')}                    value={f.filters.qty    || ''} onChange={(v) => f.setFilter('qty', v)}    /></span>, accessor: (row: any) => <span className="font-bold">{row?.qtyRequested || 0}</span> },
       { filterActive: f.isActive('status'), header: <span className="inline-flex items-center">Status<ColumnFilter options={f.getOptions('status')}              value={f.filters.status || ''} onChange={(v) => f.setFilter('status', v)} /></span>, accessor: (row: any) => <PendingCell status={row?.status || 'UNKNOWN'} reason={statusReasonForRequest(row)} deleted={!!row?.deletedAt} /> },
       { filterActive: f.isActive('nature'), header: <span className="inline-flex items-center">Nature<ColumnFilter options={f.getOptions('nature')}              value={f.filters.nature || ''} onChange={(v) => f.setFilter('nature', v)} /></span>, accessor: (row: any) => <span className="text-xs text-muted">{row?.nature === 'PERMANENT' ? 'Permanent' : 'Temporary'}</span> },
       { header: '', accessor: (row: any) => {
           // Editable only by the owner, and only while pre-issue
           // (PENDING/APPROVED). Once any qty is issued (YET_TO_ISSUE → …) or
           // it's REJECTED (in History), the intent is locked. The pencil is
           // tinted with the brand accent so users see at a glance that these
           // rows are editable — the same chip in the active table and History.
           const isOwner = row?.createdById === user?.id;
           const editable = isOwner && (row?.status === 'PENDING' || row?.status === 'APPROVED');
           if (!editable) return <span className="text-faint">—</span>;
           // When the duplicate-guard routed the user here, the matched row(s)
           // get an extra pulsing ring so the edit affordance is unmissable.
           const highlighted = dupHighlightIds.has(row.id);
           return (
             <div className="flex items-center gap-1.5">
               <button
                 onClick={() => { setReviseTarget({ id: row.id, stock: row?.inventoryItem?.stock }); setShowDupNote(false); setDupPayload(null); }}
                 title="Edit this request (quantity, project, nature, duration)"
                 className={`inline-flex items-center gap-1 text-xs font-bold text-brand-700 bg-brand/20 border border-brand/40 px-2 py-1 rounded hover:bg-brand/35 transition-colors ${highlighted ? 'ring-2 ring-amber-400 bg-brand/40 animate-pulse' : ''}`}
               >
                 <Pencil size={12} /> Edit
               </button>
               <button
                 onClick={() => handleDeleteRequest(row)}
                 title="Delete this request"
                 className="inline-flex items-center justify-center text-xs font-bold text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 px-2 py-1 rounded hover:bg-red-100 dark:bg-red-400/20 transition-colors"
               >
                 <Trash2 size={12} />
               </button>
             </div>
           );
       }},
   ];

   return (
       <div className="space-y-6">
           <div className="flex flex-col md:flex-row md:justify-between items-start gap-4">
               <div>
                   <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">I/P Requests</h2>
                   <p className="text-sm md:text-[15px] text-muted mt-1.5">Track your indents and component requests</p>
               </div>
               <button
                   onClick={() => setIsNewIndentModalOpen(true)}
                   className="bg-brand text-white px-4 py-2 font-bold rounded-full hover:bg-brand-dark transition-colors shadow-sm"
               >
                   Raise New Indent
               </button>
           </div>

           {/* One box searches all four lists (and their History views) — this
               page had no search at all, so an old indent could only be found
               by paging. */}
           <SearchInput
               value={activeIndentsP.search}
               onChange={(e) => { const v = e.target.value; activeIndentsP.setSearch(v); pastIndentsP.setSearch(v); pastIndentsCountP.setSearch(v); activeReqP.setSearch(v); pastReqP.setSearch(v); pastReqCountP.setSearch(v); }}
               placeholder="Search your indents and requests — number, item…"
           />

           {/* Indent Items */}
           <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
               <div className="bg-brand px-6 py-4 flex items-center justify-between">
                   <h3 className="text-lg font-bold text-white tracking-tight">My Indents</h3>
                   <button
                       onClick={() => setIsIndentHistoryOpen(true)}
                       className="bg-ink text-card px-3 py-1.5 text-xs font-bold rounded-md hover:bg-black transition-colors shadow-sm"
                       title="See RECEIVED / REJECTED / CANCELLED indents"
                   >
                       History {pastIndentsCountP.total > 0 && <span className="ml-1 text-[10px] opacity-80">({pastIndentsCountP.total})</span>}
                   </button>
               </div>
               <div className="px-6 pt-3">
                   <BulkSelectionBar count={indSel.selectedIds.size} onClear={indSel.clearSelection}>
                       {/* Bulk delete — loops the same per-row DELETE the trash icon
                           fires. The backend only lets the owner remove a not-yet-
                           approved indent, so any row past that gate just lands in the
                           failed tally rather than being force-deleted. */}
                       <BulkActionButton
                           label="Delete"
                           count={indSel.selectedIds.size}
                           tone="danger"
                           verb="deleted"
                           confirmTitle="Delete indents?"
                           confirmMessage={`Delete ${indSel.selectedIds.size} selected indent${indSel.selectedIds.size === 1 ? '' : 's'}? Only your own not-yet-approved indents can be deleted — anything already in approval is skipped.`}
                           onRun={() => runPerId([...indSel.selectedIds], (id) => client.delete(`/indents/${id}`))}
                           onDone={() => { indSel.clearSelection(); refreshIndents(); }}
                       />
                   </BulkSelectionBar>
               </div>
               <DataTable
                   columns={buildIndCols(indF)}
                   data={indF.pageRows}
                   isLoading={indLoading}
                   keyExtractor={r => r.id}
                   emptyStateMessage="No active indents — completed ones are in History."
                   maxHeight="50vh"
                   selectedIds={indSel.selectedIds}
                   onToggleSelect={indSel.toggleSelect}
                   onToggleSelectAllVisible={indSel.toggleSelectAllVisible}
               />
               <div className="px-6">
                   <Pagination currentPage={indF.page} totalPages={indF.totalPages} onPageChange={indF.setPage} />
               </div>
           </div>

           {(<>
           {/* Component Requests */}
           <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
               <div className="bg-brand px-6 py-4 flex items-center justify-between border-b border-brand">
                   <h3 className="text-lg font-bold text-white tracking-tight">My Component Requests</h3>
                   <button
                       onClick={() => setIsRequestHistoryOpen(true)}
                       className="bg-ink text-card px-3 py-1.5 text-xs font-bold rounded-md hover:bg-black transition-colors shadow-sm"
                       title="See RETURNED / CONSUMED / EMBEDDED / DISPOSED / REJECTED requests"
                   >
                       History {pastReqCountP.total > 0 && <span className="ml-1 text-[10px] opacity-80">({pastReqCountP.total})</span>}
                   </button>
               </div>
               {/* Duplicate-guard popper — shown when the Raise form routed the
                   user here because they already have an open request for the
                   item. Points at the highlighted row(s) below. */}
               {showDupNote && (
                   <div className="mx-6 mt-3 relative">
                       <div className="flex items-start gap-2 bg-amber-50 dark:bg-amber-400/15 border border-amber-300 dark:border-amber-400/30 text-amber-900 dark:text-amber-200 rounded-md px-3 py-2.5 text-sm shadow-sm">
                           <AlertCircle size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
                           <div className="flex-1">
                               <p>
                                   You already have {dupHighlightIds.size > 1 ? 'open requests' : 'an open request'} for{' '}
                                   <span className="font-bold">{dupItemName || 'this item'}</span>
                                   {dupHighlightIds.size > 0 ? ' — highlighted below.' : '.'} Edit the quantity instead of raising a duplicate.
                               </p>
                               {dupPayload && (
                                   <button
                                       type="button"
                                       onClick={handleRaiseSeparately}
                                       disabled={raisingSeparate}
                                       className="mt-1.5 text-xs font-semibold text-amber-800 dark:text-amber-200 underline underline-offset-2 hover:text-amber-950 dark:text-amber-200 disabled:opacity-50 disabled:no-underline"
                                   >
                                       {raisingSeparate ? 'Submitting…' : 'Need a genuinely separate one? Raise it anyway →'}
                                   </button>
                               )}
                           </div>
                           <button type="button" onClick={() => { setShowDupNote(false); setDupHighlightIds(new Set()); setDupPayload(null); }}
                               title="Dismiss"
                               className="shrink-0 text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:text-amber-200 font-bold leading-none text-base">×</button>
                       </div>
                       <div className="absolute left-6 -bottom-1 w-2.5 h-2.5 bg-amber-50 dark:bg-amber-400/15 border-r border-b border-amber-300 dark:border-amber-400/30 rotate-45"></div>
                   </div>
               )}
               <div className="px-6 pt-3">
                   <BulkSelectionBar count={reqSel.selectedIds.size} onClear={reqSel.clearSelection}>
                       {/* Bulk delete — same per-row DELETE the trash fires; backend
                           gates it to the owner's own PENDING/APPROVED requests, so
                           anything already issued is skipped into the failed tally. */}
                       <BulkActionButton
                           label="Delete"
                           count={reqSel.selectedIds.size}
                           tone="danger"
                           verb="deleted"
                           confirmTitle="Delete requests?"
                           confirmMessage={`Delete ${reqSel.selectedIds.size} selected request${reqSel.selectedIds.size === 1 ? '' : 's'}? Only your own not-yet-issued requests can be deleted — anything already issued is skipped.`}
                           onRun={() => runPerId([...reqSel.selectedIds], (id) => client.delete(`/requests/${id}`))}
                           onDone={() => { reqSel.clearSelection(); activeReqP.refetch(); }}
                       />
                   </BulkSelectionBar>
               </div>
               <DataTable
                   columns={buildReqCols(reqF)}
                   data={reqF.pageRows}
                   isLoading={reqLoading}
                   keyExtractor={r => r.id}
                   emptyStateMessage="No active component requests — completed ones are in History."
                   maxHeight="40vh"
                   selectedIds={reqSel.selectedIds}
                   onToggleSelect={reqSel.toggleSelect}
                   onToggleSelectAllVisible={reqSel.toggleSelectAllVisible}
                   rowClassName={(r: any) => (dupHighlightIds.has(r.id) || r.id === deepLinkHighlightId) ? 'bg-amber-100/70 dark:bg-amber-400/15' : ''}
               />
               <div className="px-6">
                   <Pagination currentPage={reqF.page} totalPages={reqF.totalPages} onPageChange={reqF.setPage} />
               </div>
           </div>
           </>)}

           {/* Timeline Modal */}
           <Modal isOpen={!!timelineModal} onClose={() => setTimelineModal(null)} title={`Indent Tracking — ${timelineModal?.serialNo || ''}`}>
               {timelineModal && (
                   <div className="space-y-4">
                       {/* Progress Stepper */}
                       <div className="bg-surface rounded-lg p-4 border border-line-soft">
                           <IndentProgressStepper status={timelineModal.status} quoted={(timelineModal.quotations?.length ?? 0) > 0} />
                       </div>

                       {/* Info */}
                       <div className="grid grid-cols-2 gap-3 text-sm">
                           <div><span className="text-faint text-xs">Amount</span><p className="font-bold text-ink">₹{timelineModal.grandTotal?.toLocaleString()}</p></div>
                           <div><span className="text-faint text-xs">Currently with</span><p className={`font-medium ${timelineModal.status === 'AWAITING_PAYMENT' ? 'text-amber-700 dark:text-amber-300' : 'text-ink'}`}>{timelineModal.currentHolder || timelineModal.status}</p></div>
                           {timelineModal.expectedDeliveryDate && <div><span className="text-faint text-xs">Expected delivery</span><p className="font-medium text-ink">{timelineModal.expectedDeliveryHasTime ? fmtDateTime(timelineModal.expectedDeliveryDate) : fmtDate(timelineModal.expectedDeliveryDate)}</p></div>}
                           {timelineModal.vendorName && <div><span className="text-faint text-xs">Vendor</span><p className="font-medium text-ink">{timelineModal.vendorName}</p></div>}
                       </div>

                       {/* All items in this indent. The old single-line "Item: <first.name>"
                           was misleading when an indent had multiple lines — users had no
                           way to see what else they'd raised. */}
                       <div>
                           <span className="text-faint text-xs">Items in this indent ({timelineModal.items?.length || 0})</span>
                           <div className="mt-1 border border-line-soft rounded-md divide-y divide-line-soft max-h-[160px] overflow-y-auto">
                               {(timelineModal.items || []).map((it: any) => (
                                   <div key={it.id} className="px-3 py-2 flex items-center justify-between text-sm">
                                       <span className="font-medium text-ink">{it.name}</span>
                                       <span className="text-xs text-muted">{Number(it.qty)} {it.unit || ''} {it.unitAmount ? `× ₹${Number(it.unitAmount).toLocaleString()}` : ''}</span>
                                   </div>
                               ))}
                               {(!timelineModal.items || timelineModal.items.length === 0) && (
                                   <div className="px-3 py-2 text-xs text-faint">No items recorded.</div>
                               )}
                           </div>
                       </div>

                       {/* Timeline */}
                       <div>
                           <h4 className="text-sm font-bold text-ink mb-3 flex items-center gap-2"><Clock size={14} className="text-brand" /> Timeline</h4>
                           {timelineLoading ? (
                               <div className="text-center py-4 text-faint">Loading...</div>
                           ) : (
                               <div className="space-y-0 max-h-[300px] overflow-y-auto">
                                   {timeline.map((log: any, idx: number) => (
                                       <div key={log.id} className="flex gap-3 py-2.5 border-b border-line-soft last:border-0">
                                           <div className="flex flex-col items-center">
                                               <div className={`w-2.5 h-2.5 rounded-full mt-1 ${idx === timeline.length - 1 ? 'bg-brand ring-2 ring-brand/30' : 'bg-line'}`} />
                                               {idx < timeline.length - 1 && <div className="w-0.5 flex-1 bg-line mt-1" />}
                                           </div>
                                           <div className="flex-1 min-w-0">
                                               <div className="flex items-center gap-2">
                                                   <StatusBadge status={log.toStatus} />
                                                   <span className="text-[10px] text-faint">{fmtDateTime(log.createdAt)}</span>
                                               </div>
                                               {log.notes && <p className="text-xs text-muted mt-0.5">{log.notes}</p>}
                                               <p className="text-[10px] text-faint mt-0.5">by {log.changedBy?.name || 'System'}</p>
                                           </div>
                                       </div>
                                   ))}
                                   {timeline.length === 0 && <p className="text-sm text-faint text-center py-4">No timeline data</p>}
                               </div>
                           )}
                       </div>
                   </div>
               )}
           </Modal>

           <Modal isOpen={isNewIndentModalOpen} onClose={() => setIsNewIndentModalOpen(false)} title="Raise Indent" size="xl">
                <IndentForm onSubmit={handleCreateIndent} isLoading={isSubmitting} />
           </Modal>

           {/* Edit the request slip — requestor only, PENDING only (pre-approval).
               size="xl" to match "Raise Indent" above: it is the SAME IndentForm,
               and without it this one fell back to the md default and squeezed a
               multi-column form into max-w-lg — currency, items, quantities and
               prices all stacked into one narrow column. */}
           <Modal isOpen={!!editingIndent} onClose={() => setEditingIndent(null)} title={`Edit request — ${editingIndent?.serialNo || ''}`} size="xl">
                {editingIndent && (
                    <IndentForm onSubmit={handleSaveSlip} isLoading={isSubmitting} initialValues={editingIndent} submitLabel="Save changes" />
                )}
           </Modal>

           {/* Requester edit of a pre-issue component request. Opened by the
               highlighted pencil in the requests table — including the row(s)
               the duplicate-guard flags via ?dupItem when it routes here. */}
           <ReviseRequestModal
               requestId={reviseTarget?.id ?? null}
               stock={reviseTarget?.stock}
               onClose={() => setReviseTarget(null)}
               onSaved={() => activeReqP.refetch()}
           />

           {/* History modals — reuse the exact same row cells/columns as the
               active tables so Track / Request / Edit actions still work on
               historical rows (esp. RECEIVED indents where Request is the
               most common follow-up action). */}
           <Modal size="2xl" isOpen={isIndentHistoryOpen} onClose={() => setIsIndentHistoryOpen(false)} title={`Indent History (${pastIndentsCountP.total})`}>
               <div className="space-y-3">
                   <label className="flex items-center gap-1.5 text-[11px] font-bold text-muted cursor-pointer select-none w-fit" title="Show withdrawn (deleted) indents too — they stay marked in the table and the export.">
                       <input type="checkbox" checked={showDeletedIndents} onChange={(e) => setShowDeletedIndents(e.target.checked)} className="accent-brand" />
                       Include withdrawn
                   </label>
                   <ExportPanel kind="indents" who="mine" status="RECEIVED,REJECTED,CANCELLED" includeDeleted={showDeletedIndents} />
                   <DataTable
                       columns={buildIndCols(indHistF)}
                       data={indHistF.pageRows}
                       isLoading={pastIndentsP.isLoading}
                       keyExtractor={r => r.id}
                       emptyStateMessage="No completed indents yet."
                       maxHeight="60vh"
                   />
                   <LoadAllCapNote truncated={pastIndentsP.truncated} shown={pastIndents.length} total={pastIndentsP.serverTotal} />
                   <Pagination currentPage={indHistF.page} totalPages={indHistF.totalPages} onPageChange={indHistF.setPage} />
               </div>
           </Modal>

           <Modal size="2xl" isOpen={isRequestHistoryOpen} onClose={() => setIsRequestHistoryOpen(false)} title={`Request History (${pastReqCountP.total})`}>
               <div className="space-y-3">
                   <label className="flex items-center gap-1.5 text-[11px] font-bold text-muted cursor-pointer select-none w-fit" title="Show withdrawn (deleted) requests too — they stay marked in the table and the export.">
                       <input type="checkbox" checked={showDeletedReqs} onChange={(e) => setShowDeletedReqs(e.target.checked)} className="accent-brand" />
                       Include withdrawn
                   </label>
                   {/* Same status set as the table, or the export would disagree
                       with what is on screen. */}
                   <ExportPanel kind="requests" who="mine" status={REQUEST_HISTORY_STATUSES} includeDeleted={showDeletedReqs} />
                   <DataTable
                       columns={buildReqCols(reqHistF)}
                       data={reqHistF.pageRows}
                       isLoading={pastReqP.isLoading}
                       keyExtractor={r => r.id}
                       emptyStateMessage="Nothing here yet — issued, returned and rejected requests land here."
                       maxHeight="60vh"
                   />
                   <LoadAllCapNote truncated={pastReqP.truncated} shown={pastRequests.length} total={pastReqP.serverTotal} />
                   <Pagination currentPage={reqHistF.page} totalPages={reqHistF.totalPages} onPageChange={reqHistF.setPage} />
               </div>
           </Modal>
       </div>
   );
};
