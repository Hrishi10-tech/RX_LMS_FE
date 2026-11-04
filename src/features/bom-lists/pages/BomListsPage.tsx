import { useEffect, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DataTable, LoadAllCapNote, StatusBadge, BulkSelectionBar, BulkActionButton, ColumnFilter, SearchInput, Pagination, Modal, ExportPanel } from '@/components/ui';
import { useBulkSelection, usePagedFilters, useServerPagination, FilterSpec } from '@/hooks';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { extractErrorMessage } from '@/lib';
import { runPerId } from '@/utils/bulk';
import { fmtDateTime, dateOnlyKey } from '@/utils/date';
import { Trash2, Pencil, Send, Eye, Undo2, History, Download } from 'lucide-react';
import { bomListsApi } from '../services/bom-lists.api';
import { CreateBomListModal } from '../components/CreateBomListModal';
import { BomListEditorModal } from '../components/BomListEditorModal';
import { BomHistorySection } from '../components/BomHistorySection';


/**
 * BOM Lists page — the requester's "build a batch of component requests"
 * workspace. Lists are private to creator; SUPER_ADMIN can audit anyone's.
 *
 * Two modes per row:
 *   - DRAFT → Open → editable BomListEditorModal (qty inputs + Submit button)
 *   - SUBMITTED → Open → read-only summary + spawned-requests sub-table
 */
export const BomListsPage = () => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editorListId, setEditorListId] = useState<string | null>(null);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // BOM History — the user's OWN settled BOMs (completed / rejected),
  // un-paginated so the History button reflects every settled BOM, not just the
  // current table page. A ROUTED BOM is still in flight and stays in the active
  // table above until its last component is issued (→ COMPLETED). Each row opens
  // the editor + its per-version Timeline. Mirrors the approver console.
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  // The server's total, not the rows loaded (one page of up to 200).
  const [historyTotal, setHistoryTotal] = useState(0);
  // Bulk-export panel is collapsed by default — date pickers + three format
  // buttons are an occasional tool, not something the page should wear 24/7.
  const [exportOpen, setExportOpen] = useState(false);
  const fetchHistory = () =>
    bomListsApi.myHistory()
      .then((res: any) => { setHistory(res?.items || []); setHistoryTotal(typeof res?.total === 'number' ? res.total : (res?.items || []).length); })
      .catch(() => { setHistory([]); setHistoryTotal(0); });

  // Server-paginated (10/page) BOM list with debounced server-side search.
  // The list is scoped to the creator server-side; the per-column filters
  // below still refine the current page. `fetchLists` aliases the pager's
  // refetch so the existing mutation/child-modal callbacks work unchanged.
  const {
    items: lists, total,
    search, setSearch, isLoading, refetch,
  } = useServerPagination<any>({ urlKey: 'page', loadAll: true, endpoint: '/bom-lists' });
  const fetchLists = refetch;

  const sel = useBulkSelection();

  // Submit a list straight from the row, without going through the editor —
  // the "I'm done iterating" shortcut for users who already shaped the list
  // and just want to ship it. Same confirm-then-submit behaviour the editor
  // uses, just one click closer.
  const handleSubmitFromRow = async (list: any) => {
    if (submittingId) return;
    const n = (list._count?.items ?? 0) + (list._count?.customItems ?? 0);
    if (n === 0) { addToast('Add items before submitting', 'error'); return; }
    // Deferred-split architecture: nothing spawns at submit. The BOM
    // moves to SUBMITTED and the manager gets a single notification.
    // Spawning (ComponentRequests + Indent) happens at routeBom after
    // all approvals clear.
    //
    // Every submit goes through manager review — including a revised BOM. Edits
    // after approval clear the prior sign-off (revise()), so re-submitting is a
    // fresh review, not an auto-route.
    const confirmMsg = (list.version ?? 1) > 1
      ? `Re-submit ${list.serialNo} (v${list.version}) for approval? Because you edited it, your manager reviews it again (${n} line${n === 1 ? '' : 's'}). Components flow to inventory + procurement automatically after approval.`
      : `Submit ${list.serialNo} for approval? Manager will review the whole BOM (${n} line${n === 1 ? '' : 's'}). Components flow to inventory + procurement automatically after the final approval.`;
    if (!await confirm(confirmMsg)) return;
    setSubmittingId(list.id);
    try {
      await bomListsApi.submit(list.id);
      addToast(`${list.serialNo} submitted — awaiting manager approval.`, 'success');
      fetchLists();
      // Refresh the Approvals sidebar dot. Matters when the submitter also sees
      // this BOM in their own approval queue (ADMIN dept-scope / SUPER_ADMIN sees
      // all SUBMITTED) — the badge then reflects the new pending item same-session.
      window.dispatchEvent(new Event('approvals-updated'));
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to submit'), 'error');
    } finally {
      setSubmittingId(null);
    }
  };

  // Load the decided-BOM history once on mount (drives the History button
  // count + modal). Refreshed alongside the table after mutations that can
  // move a BOM in/out of "decided" (e.g. revise pulls a ROUTED BOM back).
  useEffect(() => { fetchHistory(); }, []);

  // Deep-link support: /user/lists?openList=<id> opens the editor on a
  // specific list (used from the "from BOM-XXX" chip on the IP/Requests page).
  useEffect(() => {
    const openId = searchParams.get('openList');
    if (openId) {
      setEditorListId(openId);
      const next = new URLSearchParams(searchParams);
      next.delete('openList');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const filterSpecs: FilterSpec<any>[] = [
    { key: 'serialNo', getValue: (r) => r.serialNo },
    { key: 'name', getValue: (r) => r.name },
    { key: 'project', getValue: (r) => r.project?.name || 'General / Others' },
    // Items filters by the count shown (owner, 27 Oct — a filter on every column).
    { key: 'items', getValue: (r) => String((r._count?.items ?? 0) + (r._count?.customItems ?? 0)) },
    { key: 'status', getValue: (r) => r.status },
    { key: 'date', getValue: (r) => dateOnlyKey(r.createdAt) },
  ];

  const f = usePagedFilters(lists, filterSpecs, 10, search);

  const handleDelete = async (id: string) => {
    if (!await confirm('Delete this draft list? This cannot be undone.')) return;
    try {
      await bomListsApi.remove(id);
      addToast('List deleted', 'success');
      fetchLists();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to delete list'), 'error');
    }
  };

  // Recall a SUBMITTED BOM back to DRAFT so the requester can tweak before
  // any reviewer has acted. Confirms first so they don't accidentally
  // nuke a submitted BOM. Backend re-checks the all-pending gate and
  // 400s with a specific reason if anyone has already approved/rejected.
  const handleRecall = async (row: any) => {
    if (!await confirm(
      `Recall ${row.serialNo} back to DRAFT? It hasn't been approved yet, so this just flips it back so you can edit + re-submit.`,
    )) return;
    try {
      await bomListsApi.recall(row.id);
      addToast(`${row.serialNo} recalled — edit + re-submit when ready`, 'success');
      fetchLists();
      // Recall pulls the BOM out of the approver queue → refresh the BOM dot.
      window.dispatchEvent(new Event('approvals-updated'));
      // Auto-open the editor since the user wanted to edit something.
      setEditorListId(row.id);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to recall'), 'error');
    }
  };

  // A SUBMITTED BOM is recallable only while no approver has acted yet.
  // Deferred-split architecture: at SUBMITTED there are NO spawned
  // children — recall just flips status back to DRAFT. The instant the
  // BOM moves past SUBMITTED (MANAGER_APPROVED or beyond), recall is
  // blocked. Frontend mirrors the backend gate purely for UX.
  const isRecallable = (row: any) => row.status === 'SUBMITTED';

  // Revise a ROUTED BOM — edit-after-route. Unlike recall, this acts on a
  // BOM that already spawned downstream artefacts, so it's heavier: the
  // backend cancels the spawned indent + un-issued in-stock requests and bumps
  // the version. The prior approval is CLEARED — re-submitting goes back
  // through a fresh manager review (edits after approval are never
  // auto-routed). Confirm spells out the teardown so it's never a surprise.
  // Backend re-checks the window (isRevisable) and 400s if quoting finished.
  const handleRevise = async (row: any) => {
    if (!await confirm(
      `Revise ${row.serialNo}? This pulls it back to DRAFT as v${(row.version ?? 1) + 1}, cancels its procurement indent + any not-yet-issued stock requests, and lets you edit. Because it changes after approval, re-submitting needs a fresh manager approval.`,
    )) return;
    try {
      await bomListsApi.revise(row.id);
      addToast(`${row.serialNo} pulled back to Draft (v${(row.version ?? 1) + 1}) — edit and re-submit for approval`, 'success');
      fetchLists();
      // Revise pulls a ROUTED BOM out of "decided" → drop it from History too.
      fetchHistory();
      // Revise cancels the spawned indent + reverses un-issued stock requests —
      // refresh request/indent views + badges + the approver queue.
      window.dispatchEvent(new Event('requests-updated'));
      window.dispatchEvent(new Event('indents-updated'));
      window.dispatchEvent(new Event('approvals-updated'));
      // Auto-open the editor — revise exists to make an edit.
      setEditorListId(row.id);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to revise'), 'error');
    }
  };

  // A ROUTED BOM is revisable only until procurement's quote is done. The
  // backend computes the authoritative `revisable` flag (indent not past
  // QUOTATION_IN_PROGRESS + no stock issued) and ships it on each row; the
  // frontend just trusts it. Once the window closes the button disappears.
  const isRevisable = (row: any) => row.status === 'ROUTED' && row.revisable === true;

  const columns = [
    { filterActive: f.isActive('serialNo'), header: <span className="inline-flex items-center">BOM #<ColumnFilter searchable options={f.getOptions('serialNo')} value={f.filters.serialNo || ''} onChange={(v) => f.setFilter('serialNo', v)} /></span>, accessor: (row: any) => (
      <span className="inline-flex items-center gap-1.5">
        <span className="font-mono text-xs font-bold text-ink">{row.serialNo}</span>
        {/* Version badge — only once past v1, so first-pass BOMs stay visually
            clean. Bumps on every round-trip: a revise() of a routed BOM, or a
            bounce back to the creator (whole-BOM reject / per-line send-back). */}
        {(row.version ?? 1) > 1 && (
          <span className="text-[9px] font-bold text-violet-700 dark:text-violet-300 bg-violet-50 dark:bg-violet-400/15 border border-violet-200 dark:border-violet-400/30 px-1 py-0.5 rounded" title={`Version ${row.version} — bumped each time this BOM was sent back or revised`}>
            v{row.version}
          </span>
        )}
      </span>
    ) },
    { filterActive: f.isActive('name'), header: <span className="inline-flex items-center">Name<ColumnFilter searchable options={f.getOptions('name')} value={f.filters.name || ''} onChange={(v) => f.setFilter('name', v)} /></span>, accessor: (row: any) => <span className="font-bold text-ink">{row.name}</span> },
    { filterActive: f.isActive('project'), header: <span className="inline-flex items-center">Project<ColumnFilter options={f.getOptions('project')} value={f.filters.project || ''} onChange={(v) => f.setFilter('project', v)} /></span>, accessor: (row: any) => <span className="text-xs text-muted">{row.project?.name || <span className="italic text-faint">General / Others</span>}</span> },
    { filterActive: f.isActive('items'), header: <span className="inline-flex items-center">Items<ColumnFilter searchable options={f.getOptions('items')} value={f.filters.items || ''} onChange={(v) => f.setFilter('items', v)} /></span>, accessor: (row: any) => {
      const inv = row._count?.items ?? 0;
      const custom = row._count?.customItems ?? 0;
      const total = inv + custom;
      return (
        <span className="font-bold" title={custom > 0 ? `${inv} inventory + ${custom} custom` : undefined}>
          {total}
          {custom > 0 && <span className="ml-1 text-[10px] font-medium text-sky-700 dark:text-sky-300">(+{custom} custom)</span>}
        </span>
      );
    } },
    { filterActive: f.isActive('status'), header: <span className="inline-flex items-center">Status<ColumnFilter options={f.getOptions('status')} value={f.filters.status || ''} onChange={(v) => f.setFilter('status', v)} /></span>, accessor: (row: any) => {
      // The row status is the requester's headline, kept deliberately spare:
      //   • Draft / Submitted / Rejected → the StatusBadge alone. The coarse
      //     lifecycle stage says all there is to say.
      //   • Routed (in fulfillment) → the "N issued · M pending" counts stand
      //     IN PLACE of the badge, not beside it. A routed BOM is by definition
      //     already approved, so an "Approved" chip next to the counts is pure
      //     noise — the counts themselves imply it. Issued = parts handed to the
      //     requester (inventory→user), still counted even if later returned or
      //     used up; Pending = anything not yet in their hands (awaiting
      //     approval, in procurement, ordered, in transit, or received-but-not-
      //     yet-issued). We don't spell out WHICH up here — the editor shows that
      //     per line, so the row stays scannable whether a BOM has 3 or 700.
      //   • Completed → badge + a "✓ all issued" line (normally lives in History).
      // `issued`/`pending` are computed server-side from the same predicates as
      // the completion check, so "0 pending" is exactly when the BOM
      // auto-completes and moves to History.
      const { issued = 0, pending = 0 } = (row.progress || {}) as { issued?: number; pending?: number };

      const labelCls: Record<'amber' | 'sky' | 'emerald', string> = {
        amber:   'text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border-amber-200 dark:border-amber-400/30',
        sky:     'text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-400/15 border-sky-200 dark:border-sky-400/30',
        emerald: 'text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-400/15 border-emerald-200 dark:border-emerald-400/30',
      };
      const label = (text: string, tone: 'amber' | 'sky' | 'emerald') => (
        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded border ${labelCls[tone]}`}>{text}</span>
      );

      // Routed-BOM progress counts, computed up here (not inside the switch) so
      // the badge-visibility check below can read them: once a routed BOM has
      // real counts, they replace the "Approved" badge entirely.
      const routedSegs: { text: string; cls: string }[] = [];
      if (row.status === 'ROUTED') {
        if (issued > 0) routedSegs.push({ text: `${issued} issued`, cls: 'text-blue-700 dark:text-blue-300' });
        if (pending > 0) routedSegs.push({ text: `${pending} pending`, cls: 'text-amber-700 dark:text-amber-300' });
      }

      let secondary: ReactNode = null;
      switch (row.status) {
        case 'SUBMITTED':
          // Single approval: the creator's manager OR — when they have no
          // manager (or are one) — a department admin. "manager/admin" so a
          // manager-creator isn't misled into thinking they wait on themselves.
          secondary = label('Waiting for manager/admin approval', 'amber');
          break;
        case 'MANAGER_APPROVED':
          // Transient: approval + routing commit together, so this is never
          // really observed at rest. Defensive label only.
          secondary = label('Finalising…', 'sky');
          break;
        case 'ROUTED': {
          // Two coloured counts and nothing else — they REPLACE the "Approved"
          // badge (see showBadge below). A routed BOM always spawned something,
          // so issued + pending is normally > 0; the neutral "Processing…" is a
          // defensive fallback for the instant before the first artefact
          // registers, and in that one case we keep the badge for context.
          secondary = routedSegs.length === 0
            ? <span className="text-[10px] text-faint">Processing…</span>
            : (
              <span
                className="text-[10px] font-bold flex items-center gap-1.5"
                title="Issued = handed over to you from inventory (stays counted even if later returned or used up). Pending = still in approval, procurement, or received into inventory but not yet issued to you."
              >
                {routedSegs.map((s, i) => (
                  <span key={s.text} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-brand-200 font-normal">·</span>}
                    <span className={s.cls}>{s.text}</span>
                  </span>
                ))}
              </span>
            );
          break;
        }
        // Terminal "fully fulfilled" — every component issued. Normally
        // excluded from this list (it's in History); defensive for an explicit
        // status filter that surfaces one here.
        case 'COMPLETED':
          secondary = <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300">✓ All {issued} issued</span>;
          break;
        // DRAFT + REJECTED: the badge alone already says it — no second line.
        default:
          secondary = null;
      }

      // Two states say it better underneath than the chip does, so the chip
      // goes rather than repeating them:
      //   ROUTED   — "N issued · M pending" already implies approved.
      //   SUBMITTED — "Waiting for manager/admin approval" already implies
      //               submitted; nothing waits for approval unsubmitted.
      // Every other state keeps the badge, and ROUTED keeps it for the brief
      // routed-but-no-artefacts-yet moment where the counts are empty.
      const showBadge = !(
        (row.status === 'ROUTED' && routedSegs.length > 0) ||
        row.status === 'SUBMITTED'
      );

      return (
        <div className="flex flex-col items-start gap-1">
          {showBadge && <StatusBadge status={row.status} />}
          {secondary}
        </div>
      );
    }},
    { filterActive: f.isActive('date'), header: <span className="inline-flex items-center">Created<ColumnFilter searchable options={f.getOptions('date')} value={f.filters.date || ''} onChange={(v) => f.setFilter('date', v)} /></span>, accessor: (row: any) => <span className="text-xs text-muted">{fmtDateTime(row.createdAt)}</span> },
    { header: 'Action', accessor: (row: any) => {
      // Row is also clickable as a whole (see DataTable onRowClick below),
      // but we surface explicit action buttons so the available verbs
      // (Edit, Submit, Delete) are visible without having to learn the
      // row-click affordance. Order matters: Edit first because it's the
      // most common action; Submit second; Delete last (destructive).
      const isDraft = row.status === 'DRAFT';
      const empty = ((row._count?.items ?? 0) + (row._count?.customItems ?? 0)) === 0;
      return (
        <div className="flex items-center gap-1.5">
          {isDraft ? (
            <>
              <button onClick={() => setEditorListId(row.id)} title="Edit items, qty, nature"
                className="inline-flex items-center gap-1 text-xs font-bold text-brand hover:text-brand-dark px-2 py-1 rounded hover:bg-brand/10">
                <Pencil size={12} /> Edit
              </button>
              <button
                onClick={() => handleSubmitFromRow(row)}
                disabled={empty || submittingId === row.id}
                title={empty ? 'Add items before submitting' : 'Submit BOM for approval — once approved, in-stock items are issued from stock and the rest go for procurement approval'}
                className="inline-flex items-center gap-1 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 px-2 py-1 rounded shadow-sm disabled:opacity-50 disabled:cursor-not-allowed">
                <Send size={12} /> {submittingId === row.id ? 'Submitting…' : 'Submit'}
              </button>
              <button onClick={() => handleDelete(row.id)} title="Delete draft"
                className="text-faint hover:text-red-700 dark:text-red-300 p-1">
                <Trash2 size={14} />
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setEditorListId(row.id)} title="View read-only summary + spawned requests"
                className="inline-flex items-center gap-1 text-xs font-bold text-muted hover:text-ink px-2 py-1 rounded hover:bg-hover">
                <Eye size={12} /> View
              </button>
              {/* Recall button — only shown when nothing downstream has been
                  acted on yet. Lets the requester pull a SUBMITTED BOM back
                  to DRAFT, fix qty / add lines, then re-submit fresh. */}
              {isRecallable(row) && (
                <button
                  onClick={() => handleRecall(row)}
                  title="Recall to DRAFT — works only while no manager / tech head has acted yet. Lets you edit + re-submit."
                  className="inline-flex items-center gap-1 text-xs font-bold text-brand-700 hover:text-brand-700 px-2 py-1 rounded hover:bg-brand-100"
                >
                  <Undo2 size={12} /> Recall to edit
                </button>
              )}
              {/* Revise button — edit-after-route. Shown on a ROUTED BOM only
                  while the backend says the quote window is still open
                  (row.revisable). Heavier than recall: it tears down the
                  spawned indent + un-issued requests, so the confirm spells
                  that out. Re-submitting needs a fresh manager approval. */}
              {isRevisable(row) && (
                <button
                  onClick={() => handleRevise(row)}
                  title="Revise — pull back to DRAFT for one more edit cycle. Cancels the procurement indent + un-issued stock requests; because it changes after approval, re-submitting needs a fresh manager review. Allowed until procurement's quote is done."
                  className="inline-flex items-center gap-1 text-xs font-bold text-violet-700 dark:text-violet-300 hover:text-violet-900 dark:text-violet-200 px-2 py-1 rounded hover:bg-violet-50 dark:bg-violet-400/15"
                >
                  <Undo2 size={12} /> Revise to edit
                </button>
              )}
            </>
          )}
        </div>
      );
    } },
  ];

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Stacks below sm — see LabsPage: the header clips at phone width and
          "+ New list" was the control that fell off the edge. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:justify-between sm:items-start">
        <div className="min-w-0">
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">BOM Lists ({total})</h2>
          <p className="text-sm md:text-[15px] text-muted mt-1.5">
            Build a batch of components for a project. Submit once for review — a manager or admin approves the whole BOM as one unit. After approval, items flow to inventory + procurement automatically.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          <button onClick={() => setExportOpen((o) => !o)}
            title="Download your BOMs for a date range — CSV, summary PDF, or full slips"
            aria-expanded={exportOpen}
            className={`inline-flex items-center gap-1.5 px-3 py-2 font-bold rounded-md transition-colors shadow-sm whitespace-nowrap text-sm border ${
              exportOpen
                ? 'bg-brand-100 text-brand-700 border-brand-200'
                : 'bg-card text-ink border-line hover:bg-surface'
            }`}>
            <Download size={14} /> Download
          </button>
          <button onClick={() => setHistoryOpen(true)}
            title="See your settled BOMs (completed / rejected) and open any one's Timeline"
            className="inline-flex items-center gap-1.5 bg-ink text-card px-3 py-2 font-bold rounded-md hover:bg-black transition-colors shadow-sm whitespace-nowrap text-sm">
            <History size={14} /> History{historyTotal > 0 ? ` (${historyTotal})` : ''}
          </button>
          <button onClick={() => setIsCreateOpen(true)}
            className="bg-brand text-white px-4 py-2 font-bold rounded-full hover:bg-brand-dark transition-colors shadow-sm whitespace-nowrap">
            + New list
          </button>
        </div>
      </div>

      {/* Bulk export — download your BOMs across a date range as a spreadsheet
          (CSV), a one-row-per-BOM summary (List PDF), or a full slip-per-BOM
          binder (Detailed PDF). Scoped server-side to BOMs you raised. Lives at
          page level (not the History modal) because it covers every BOM you
          own — drafts and in-flight included — but stays hidden behind the
          header's Download button so it doesn't crowd the page. The active
          button shares the panel's cream palette so the two read as one unit. */}
      {exportOpen && <ExportPanel kind="bom-lists" />}

      <div className="bg-card rounded-xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-zebra overflow-hidden">
        <div className="p-4 border-b border-line-soft">
          <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by BOM # or name..." />
        </div>
        <BulkSelectionBar count={sel.selectedIds.size} onClear={sel.clearSelection}>
          <BulkActionButton
            label="Delete"
            count={sel.selectedIds.size}
            tone="danger"
            verb="deleted"
            confirmTitle="Delete BOM lists?"
            confirmMessage={`Delete ${sel.selectedIds.size} selected list${sel.selectedIds.size === 1 ? '' : 's'}? Only DRAFT lists can be deleted — submitted or approved ones are skipped.`}
            onRun={() => runPerId([...sel.selectedIds], (id) => bomListsApi.remove(id))}
            onDone={() => { sel.clearSelection(); fetchLists(); }}
          />
        </BulkSelectionBar>
        <DataTable
          columns={columns}
          data={f.pageRows}
          isLoading={isLoading}
          keyExtractor={r => r.id}
          emptyStateMessage="No BOM lists yet. Click + New list to create one."
          selectedIds={sel.selectedIds}
          onToggleSelect={sel.toggleSelect}
          onToggleSelectAllVisible={sel.toggleSelectAllVisible}
          // Whole-row click opens the editor — same destination as the Edit
          // button, but lets users click anywhere on a row to drill in.
          // DataTable ignores clicks landing on per-row buttons / inputs
          // so the explicit Submit / Delete actions still work.
          onRowClick={(row: any) => setEditorListId(row.id)}
        />
        <div className="p-4 border-t border-line-soft">
          <Pagination currentPage={f.page} totalPages={f.totalPages} onPageChange={f.setPage} />
        </div>
      </div>

      <CreateBomListModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={(list) => {
          setIsCreateOpen(false);
          fetchLists();
          // Auto-open the new list so the user can start adding items.
          setEditorListId(list.id);
        }}
      />

      <BomListEditorModal
        listId={editorListId}
        onClose={() => setEditorListId(null)}
        onChanged={() => { fetchLists(); fetchHistory(); }}
      />

      {/* BOM History — your decided BOMs (routed / rejected), un-paginated.
          Each row opens the editor + its per-version Timeline. The main table
          above is server-paginated, so this is the complete settled-BOM view. */}
      <Modal isOpen={historyOpen} onClose={() => setHistoryOpen(false)} title="BOM History">
        <LoadAllCapNote truncated={historyTotal > history.length} shown={history.length} total={historyTotal} />
        <BomHistorySection
          items={history}
          onOpen={(id: string) => { setHistoryOpen(false); setEditorListId(id); }}
        />
      </Modal>
    </div>
  );
};
