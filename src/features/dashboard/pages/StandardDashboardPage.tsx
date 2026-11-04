import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PICKER_INITIAL_ITEMS } from '@/features/inventory/hooks/useInventoryOptions';
import { useInventoryOptions, useAuth, useBulkSelection, useServerPagination, useAbortOnUnmount } from '@/hooks';
import { DataTable, StatusBadge, SearchInput, Modal, ColumnFilter, BulkSelectionBar, Pagination } from '@/components/ui';
import { ALL_CATEGORIES, STOCK_FILTER_OPTIONS } from '@/features/inventory/components/InventoryTable';
import { extractErrorMessage, cachedGet } from '@/lib';
import { stockColorClass } from '@/utils/stock';
import {
  ActiveBomListChip,
  ListsDropdown,
  CreateBomListModal,
  BomListEditorModal,
  AddToBomListButton,
} from '@/features/bom-lists';
import { RequestForm, IndentForm } from '@/components/forms';
import { useToast } from '@/context/ToastContext';
import { client } from '@/api';
import { UserRole } from '@/types';

// Rows per page. A page IS a place a user can fail to look, so whatever this
// is, the "showing X–Y of N" line above the table has to stay: that is what
// stops a second page from being invisible.
const INV_PAGE_SIZE = 10;


export const StandardDashboardPage = () => {




  const abortSignal = useAbortOnUnmount();
  const { user } = useAuth();
  // BOM lists are created by these roles only (bom-lists.controller POST).
  // Finance and Associate Finance also land on this page, and were offered
  // "Lists" / "Add to BOM list" that ended in "no permission".
  const canBuildBom = ['USER', 'MANAGER', 'ADMIN', 'LAB'].includes(user?.role || '');
  // TWO different reads on purpose:
  //   optionItems — the COMPLETE scoped list, for the Request Component picker
  //                 and the deep-link lookups below. `/inventory` caps at 200
  //                 rows ordered by name, so using it here made any item late
  //                 in the alphabet unpickable once the lab passed 200 items.
  //   invPager    — one page at a time for the browsable table, with search and
  //                 filters resolved SERVER-side so they see every item rather
  //                 than only the page in hand.
  // A SHORT list, not the whole catalogue.
  //
  // This pulled every scoped item on mount — up to 5,000 rows — so the page
  // could fill a dropdown and resolve notification deep links by scanning the
  // array. Everyone paid that download on every visit, whether or not they
  // opened the picker. The picker now searches the server as you type and the
  // deep links ask for the single id they need, so the initial list only has
  // to look populated.
  const { items: optionItems, truncated: optionsTruncated, total: optionsTotal, refetch: refetchOptions } = useInventoryOptions(PICKER_INITIAL_ITEMS);
  const { addToast } = useToast();


  const [categoryFilter, setCategoryFilter] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  // Item Name column filter — an exact name, sent to the server like Category.
  const [nameFilter, setNameFilter] = useState('');
  const [departments, setDepartments] = useState<{value: string, label: string}[]>([]);

  const [isRequestModalOpen, setIsRequestModalOpen] = useState(false);
  const [isIndentModalOpen, setIsIndentModalOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<any>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { selectedIds, toggleSelect, toggleSelectAllVisible, clearSelection } = useBulkSelection();

  // BOM list wiring — surfaced via the AddToBomListButton (smart picker)
  // which both adds items to an active list AND offers to create/pick one
  // inline when there isn't one. State below is just for the create/editor
  // modals the dropdown can trigger.
  const [isCreateBomOpen, setIsCreateBomOpen] = useState(false);
  const [editorListId, setEditorListId] = useState<string | null>(null);
  const [bomRefreshKey, setBomRefreshKey] = useState(0);

  // Only LAB sees department filter (they have global view)
  const showDepartmentFilter = user?.role === UserRole.LAB;
  const [searchParams, setSearchParams] = useSearchParams();

  // When the Request Component modal was opened from a notification's CTA
  // (?requestItem=<inventoryItemId> or ?claimFromIndent=<indentId>), we stash
  // the source entity id here. On a *successful* raise we then clear every
  // unread notification for that entity — killing the whole cluster of
  // duplicate / sibling-typed "go claim it" cards at once, on the raise (not on
  // the click), so the requester's unread pile shrinks as they work through
  // their claims. Null whenever the modal was opened manually from the table.
  const claimSourceEntityIdRef = useRef<string | null>(null);

  // Deliberately does NOT call refetchOptions() / invPager.refetch(): both hooks
  // already fetch on mount of their own accord (useInventoryOptions.ts's
  // `useEffect(() => { void refetch(); }, [refetch])` with a stable callback,
  // and useServerPagination's own mount effect). Calling them here as well made
  // this page issue /inventory/options and /inventory?take=10 TWICE on every
  // visit — confirmed in the browser network log across three separate visits.
  // The post-mutation refetch further down is the one that has to stay.
  useEffect(() => {
    if (showDepartmentFilter) {
        const fetchDeps = async () => {
            try {
                const data = await cachedGet<any>('/departments');
                setDepartments((data.data || data).map((d: any) => ({ value: d.id, label: d.name })));
            } catch (e) {
                // Logged to the console only, the department filter just sat
                // empty with nothing saying why. One toast: this effect runs
                // once per mount.
                console.error("Failed fetching departments");
                addToast(extractErrorMessage(e, 'Could not load departments for the filter'), 'error');
            }
        };
        fetchDeps();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- addToast is render-scope; re-run only when the filter appears
  }, [showDepartmentFilter]);

  /**
   * Find an inventory item by id, without trusting the loaded list to be
   * complete.
   *
   * The deep links below used to conclude "no longer in stock" / "not in your
   * accessible inventory anymore" from a miss against `optionItems`. That list
   * is capped (/inventory/options stops at 5,000 rows ordered by name), so past
   * the ceiling a perfectly valid notification CTA would tell the user their
   * item was gone — a false statement about their own data, arrived at from a
   * list that had simply been cut short. Ask the server for the one id instead;
   * only a real miss (deleted, or genuinely out of scope) reaches the toast.
   */
  const resolveOptionItem = useCallback(async (id: string) => {
    const hit = optionItems.find((i: any) => i.id === id);
    if (hit) return hit;
    try {
      const res = await client.get(`/inventory/${id}`, { signal: abortSignal() });
      return res.data?.data ?? res.data ?? null;
    } catch {
      return null;
    }
  }, [optionItems]);

  // Deep-link from the "Indent received" notification: ?requestItem=<inventoryItemId>
  // auto-opens the Request Component modal for that item once inventory loads.
  // Without this the user has to find the item in the table again, which defeats
  // the point of the in-notification CTA.
  useEffect(() => {
    const targetId = searchParams.get('requestItem');
    // No `optionItems.length` guard: the id is resolved from the SERVER, so
    // waiting for a list that is now deliberately short would just delay it.
    if (!targetId) return;
    void (async () => {
      const target = await resolveOptionItem(targetId);
      if (target) {
        // Remember the source so a successful raise clears this item's
        // "now available" notification(s). Keyed on the inventory item id —
        // exactly what INVENTORY_ITEM_AVAILABLE stamps as relatedEntityId.
        claimSourceEntityIdRef.current = targetId;
        setSelectedItem(target);
        setIsRequestModalOpen(true);
      } else {
        addToast('That component is no longer in stock.', 'info');
      }
      // Strip the param so a reload doesn't keep re-opening the modal.
      setSearchParams({}, { replace: true });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opens the request modal when searchParams/items change; addToast/setSearchParams are render-scope and must not drive this effect
  }, [searchParams, optionItems]);

  // Deep-link from the I/P Requests page's "Request" button on a RECEIVED
  // indent: ?claimFromIndent=<indentId> resolves to the canonical inventory
  // row via my-claims (handles the legacy null-FK + post-merge cases that the
  // raw requestItem= link can't survive on its own).
  // Ref-guarded so we run the resolution exactly once per id — without it
  // setSearchParams('') would re-fire the effect, the new run's cleanup
  // would flip `cancelled` on the in-flight fetch, and the modal would
  // never open.
  const handledClaimRef = useRef<string | null>(null);
  useEffect(() => {
    const indentId = searchParams.get('claimFromIndent');
    if (!indentId) return;
    if (handledClaimRef.current === indentId) return;
    handledClaimRef.current = indentId;
    (async () => {
      try {
        const res = await client.get('/indents/my-claims', { signal: abortSignal() });
        const all: any[] = res.data?.data || res.data || [];
        const claim = all.find((c) => c.indentId === indentId);
        // Prefer the explicit inventoryItemId on the claim, fall back to a
        // name+dept lookup against the loaded inventory list (catches the
        // legacy null-FK case where the indent line was never linked).
        let target: any = null;
        if (claim?.inventoryItemId) {
          target = await resolveOptionItem(claim.inventoryItemId);
        }
        if (!target && claim?.itemName) {
          // Ask the SERVER by name rather than scanning the loaded list. The
          // list is now a short first page, and even when it was 5,000 rows a
          // legacy item past the ceiling would never be found — the lookup
          // that exists precisely to rescue those rows was itself capped.
          try {
            const res = await client.get('/inventory/options', { params: { search: claim.itemName }, signal: abortSignal() });
            const hits = (res.data?.data ?? res.data)?.items ?? [];
            const wantName = String(claim.itemName).toLowerCase();
            target = hits.find((i: any) =>
              (i.name || '').toLowerCase() === wantName &&
              (!claim.departmentId || i.departmentId === claim.departmentId),
            ) ?? null;
          } catch { /* fall through to the "not accessible" toast */ }
        }
        if (target) {
          // Key the clear-on-raise on the INDENT id (what INDENT_RECEIVED_CLAIM
          // stamps as relatedEntityId), not the resolved inventory item — that's
          // the entity the notification cluster is about.
          claimSourceEntityIdRef.current = indentId;
          setSelectedItem(target);
          setIsRequestModalOpen(true);
        } else {
          addToast('That item is not in your accessible inventory anymore.', 'info');
        }
      } catch (e: any) { addToast(extractErrorMessage(e, 'Could not resolve the indent item.'), 'error'); } finally {
        // Strip the param so a refresh doesn't re-open the modal.
        setSearchParams({}, { replace: true });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs the claim resolution when searchParams/items change (ref-guarded to once per id); addToast/setSearchParams are render-scope and must not drive this effect
  }, [searchParams, optionItems]);

  const handleRequest = (item: any) => {
    // Manual open from the inventory table — not driven by a notification, so
    // drop any stale source id from a prior deep-link that was cancelled.
    claimSourceEntityIdRef.current = null;
    setSelectedItem(item);
    setIsRequestModalOpen(true);
  };

  const handleRaiseIndent = (item?: any) => {
    setSelectedItem(item || null);
    setIsIndentModalOpen(true);
  };

  const handleSubmitRequest = async (data: any) => {
    setIsSubmitting(true);
    try {
        // Returned so RequestForm can attach the optional photo, which needs
        // the new id — POST /requests/:id/attachment.
        const res = await client.post('/requests', data);
        addToast('Component requested successfully', 'success');
        setIsRequestModalOpen(false);
        refetchOptions(); invPager.refetch();
        // If this raise came from a notification's "Request Component" CTA,
        // now that they've actually raised it, clear the whole cluster of
        // unread cards for that indent/item (duplicates + sibling types) in one
        // call — best-effort, so a failure here never blocks the raise.
        const sourceId = claimSourceEntityIdRef.current;
        if (sourceId) {
            claimSourceEntityIdRef.current = null;
            try {
                await client.post('/notifications/read-by-entity', { relatedEntityId: sourceId });
                // Refresh the bell + sidebar badge so the count drops immediately.
                window.dispatchEvent(new Event('notifications-updated'));
            } catch { /* non-fatal — the request itself already succeeded */ }
        }
        // Hand the created request back so the form can attach its photo.
        return res.data?.data ?? res.data;
    } catch (e: any) {
        addToast(extractErrorMessage(e, 'Failed to request component'), 'error');
    } finally {
        setIsSubmitting(false);
    }
  };

  const handleSubmitIndent = async (data: any) => {
    setIsSubmitting(true);
    try {
        // Returned so IndentForm can attach its optional per-line photos,
        // which need the ids the server assigns.
        const indentRes = await client.post('/indents', data);
        addToast('Indent raised successfully', 'success');
        setIsIndentModalOpen(false);
    // Hand the saved indent back so the form can attach its photos.
    return indentRes.data?.data ?? indentRes.data;
    } catch (e: any) {
        addToast(extractErrorMessage(e, 'Failed to raise indent'), 'error');
    } finally {
        setIsSubmitting(false);
    }
  };

  const clearFilters = () => {
      setSearch('');
      setCategoryFilter('');
      setDepartmentFilter('');
      setStockFilter('');
      setNameFilter('');
  };

  // Server-paginated + server-searched. The old version filtered client-side
  // over the 200 rows it happened to receive, so the search box literally could
  // not find an item outside that alphabetical window.
  const invPager = useServerPagination<any>({
    endpoint: '/inventory',
    // Passed explicitly (it is also the hook default) so the "showing X–Y of N"
    // arithmetic below cannot silently drift away from the real page size.
    pageSize: INV_PAGE_SIZE,
    params: {
      category: categoryFilter || undefined,
      departmentId: departmentFilter || undefined,
      status: stockFilter || undefined,
      name: nameFilter || undefined,
    },
  });
  const { search, setSearch } = invPager;

  // A filter on every data column (owner, 27 Oct). Every one of them is sent
  // to the server — Status and Stock are the same stock level, Item Name is
  // the backend's exact `name` param — so they filter the whole catalogue, not
  // the ten rows on screen. The Item Name choices come from
  // /inventory/filter-options (every name in the user's scope), the same
  // source the other inventory tables use.
  const [allNames, setAllNames] = useState<string[]>([]);
  useEffect(() => {
    client.get('/inventory/filter-options', { signal: abortSignal() })
      .then(res => {
        const d = res.data?.data ?? res.data ?? {};
        setAllNames(Array.isArray(d.names) ? d.names : []);
      })
      .catch(() => { /* fall back to the names on screen, below */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);
  const nameOptions = useMemo(() => {
    const names = allNames.length > 0
      ? allNames
      : [...new Set(invPager.items.map((r: any) => r?.name).filter(Boolean))].sort((a: string, b: string) => a.localeCompare(b));
    // A picked name stays offered even if the list has not caught up with it.
    const withPicked = nameFilter && !names.includes(nameFilter) ? [nameFilter, ...names] : names;
    return withPicked.map((n: string) => ({ value: n, label: n }));
  }, [allNames, invPager.items, nameFilter]);
  const hasFilters = !!(search || categoryFilter || departmentFilter || stockFilter || nameFilter);
  const stockLevelHeader = (label: string) => (
    <span className="inline-flex items-center">{label}<ColumnFilter options={STOCK_FILTER_OPTIONS} value={stockFilter} onChange={setStockFilter} /></span>
  );
  const isLoading = invPager.isLoading;

  const getStockColorClass = (stock: number) => stockColorClass(stock, 10);

  const columns = [
    { filterActive: !!nameFilter, header: <span className="inline-flex items-center">Item Name<ColumnFilter searchable options={nameOptions} value={nameFilter} onChange={setNameFilter} /></span>, accessor: (row: any) => <span className="font-bold text-ink">{row?.name || 'Unknown'}</span> },
    { filterActive: !!categoryFilter, header: <span className="inline-flex items-center">Category<ColumnFilter searchable options={ALL_CATEGORIES} value={categoryFilter} onChange={setCategoryFilter} /></span>, accessor: (row: any) => <span className="text-sm text-muted">{row?.category?.replace(/_/g, ' ') || 'N/A'}</span> },
    { filterActive: !!stockFilter, header: stockLevelHeader('Status'), accessor: (row: any) => <StatusBadge status={row?.status || 'UNKNOWN'} /> },
    {
        filterActive: !!stockFilter,
        header: stockLevelHeader('Stock'),
        accessor: (row: any) => (
            <span className={`font-bold ${getStockColorClass(row?.stock || 0)}`}>
               {row?.stock || 0} {row?.unit || ''}
            </span>
        )
    },
    {
        header: 'Action',
        accessor: (row: any) => (row?.stock || 0) > 0 ? (
            <button
                onClick={() => handleRequest(row)}
                className="bg-brand hover:bg-brand-dark text-white px-3 py-1 rounded-full font-bold text-sm transition-colors shadow-sm"
            >
                Request Component
            </button>
        ) : (
            <button
                onClick={() => handleRaiseIndent(row)}
                className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded-md font-bold text-sm transition-colors shadow-sm"
            >
                Raise Indent
            </button>
        )
    }
  ];

  // Determine page title based on role
  const isLabView = user?.role === UserRole.LAB;
  const pageTitle = isLabView ? 'Inventory Items' : 'Inventory Items';
  const pageDesc = isLabView
    ? 'All department components visible.'
    : 'Components available in your department.';

  return (
    <div className="space-y-8">
      <div className="bg-card p-4 md:p-6 rounded-xl shadow-[0_2px_10px_rgb(0,0,0,0.02)] border border-zebra">
         <div className="flex flex-col space-y-2 mb-4 md:mb-6">
             <div className="flex flex-col md:flex-row gap-4 items-start md:items-center w-full">
                 <div className="flex-1">
                     <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">{pageTitle}</h2>
                     <p className="text-sm md:text-[15px] text-muted mt-1.5">{pageDesc}</p>
                 </div>
                 {/* Lists dropdown + active-list chip — only shown for roles
                     that can build BOMs (USER, MANAGER, LAB; everyone reading
                     this page is one of those by route gating). */}
                 <div className="flex items-center gap-2">
                     {/* Opens the picker with NOTHING selected, which is the
                         only way to reach its search box. Every other route in
                         gets here from a table row and arrives locked to that
                         item, so the search — which queries the whole
                         catalogue — had no entry point at all. */}
                     <button
                         onClick={() => { setSelectedItem(undefined); setIsRequestModalOpen(true); }}
                         className="inline-flex items-center gap-1.5 rounded-md border border-brand px-3 py-1.5 text-xs font-bold text-brand-dark transition-colors hover:bg-brand-100"
                         title="Search the whole catalogue and request any item"
                     >
                         Request an item
                     </button>
                     {canBuildBom && (
                       <>
                         <ActiveBomListChip />
                         <ListsDropdown
                             refreshKey={bomRefreshKey}
                             onCreateNew={() => setIsCreateBomOpen(true)}
                             onOpenList={(id) => setEditorListId(id)}
                         />
                       </>
                     )}
                 </div>
             </div>
             <div className="flex flex-col md:flex-row gap-3 items-center w-full">
                 <div className="flex-1 w-full relative">
                     <SearchInput
                         value={search}
                         onChange={(e) => setSearch(e.target.value)}
                         placeholder="Search inventory..."
                     />
                 </div>
                 {showDepartmentFilter && (
                    <div className="flex items-center gap-2">
                         <span className="text-sm font-bold text-ink">Department:</span>
                         <div className="inline-flex">
                             <ColumnFilter searchable options={departments} value={departmentFilter} onChange={setDepartmentFilter} />
                         </div>
                    </div>
                 )}
                 {hasFilters && (
                     <button onClick={clearFilters} className="text-sm text-brand font-bold hover:underline whitespace-nowrap">
                         Clear filters
                     </button>
                 )}
             </div>
         </div>

         {/* One search, one list. This screen used to render invPager.items
             TWICE while a filter was active — a card grid headed "Filtered
             Results" and then the same ten rows again as "Full Inventory" —
             so every result was reported to the user twice and the second
             heading promised a completeness neither view had. The table is
             the strict superset (it carries the row checkboxes that feed
             "Add to list" and the Category column filter, which the cards
             never had), so the cards went and the status badge they were
             carrying moved into the table as its own column. */}
         <div>
             <div className="flex items-baseline justify-between mb-4 gap-3 flex-wrap">
                 {hasFilters && (
                     <h3 className="text-lg font-bold text-ink">Filtered Results</h3>
                 )}
                 {hasFilters && invPager.total > 0 && (
                     <p className="text-sm text-muted">
                         Showing <span className="font-bold text-ink">{(invPager.page - 1) * INV_PAGE_SIZE + 1}–{Math.min(invPager.page * INV_PAGE_SIZE, invPager.total)}</span> of{' '}
                         <span className="font-bold text-ink">{invPager.total}</span> {invPager.total === 1 ? 'match' : 'matches'}
                         {invPager.page < invPager.totalPages && <span className="text-brand-dark font-bold"> · more on the next page</span>}
                     </p>
                 )}
             </div>
             {/* Bulk-action row. When items are selected, the smart picker
                 surfaces "Add N to list" with a chevron dropdown — clicking
                 the main button uses the active list (or opens the picker
                 if none); the chevron always opens the picker explicitly.
                 Picker offers a "+ New list" entry so a user with zero
                 drafts isn't dead-ended. */}
             {canBuildBom && <BulkSelectionBar count={selectedIds.size} onClear={clearSelection}>
                 <AddToBomListButton
                     selectedIds={Array.from(selectedIds)}
                     onAdded={() => { clearSelection(); setBomRefreshKey(k => k + 1); }}
                     onCreateNew={() => setIsCreateBomOpen(true)}
                 />
             </BulkSelectionBar>}
             <DataTable
                 columns={columns}
                 data={invPager.items}
                 isLoading={isLoading}
                 keyExtractor={(r) => r.id}
                 emptyStateMessage={hasFilters ? 'No items match these filters.' : 'No items found in inventory.'}
                 // Row checkboxes only feed "Add to BOM list".
                 selectedIds={canBuildBom ? selectedIds : undefined}
                 onToggleSelect={canBuildBom ? toggleSelect : undefined}
                 onToggleSelectAllVisible={canBuildBom ? toggleSelectAllVisible : undefined}
             />
             <Pagination currentPage={invPager.page} totalPages={invPager.totalPages} onPageChange={invPager.setPage} />
         </div>
      </div>

      <Modal isOpen={isRequestModalOpen} onClose={() => setIsRequestModalOpen(false)} title="Request Component">
          <RequestForm
             item={selectedItem}
             availableItems={optionItems}
             optionsTruncated={optionsTruncated}
             optionsTotal={optionsTotal}
             onSubmit={handleSubmitRequest}
             isLoading={isSubmitting}
          />
      </Modal>

      <Modal isOpen={isIndentModalOpen} onClose={() => setIsIndentModalOpen(false)} title="Raise Indent" size="xl">
          <IndentForm
             onSubmit={handleSubmitIndent}
             isLoading={isSubmitting}
             prefillItem={selectedItem}
          />
      </Modal>

      {/* BOM Lists modals — co-located here so the ListsDropdown can trigger
          them without a route change. The Create flow auto-opens the editor
          for the new list so the user can immediately add items. */}
      <CreateBomListModal
          isOpen={isCreateBomOpen}
          onClose={() => setIsCreateBomOpen(false)}
          onCreated={(list) => {
              setIsCreateBomOpen(false);
              setEditorListId(list.id);
              setBomRefreshKey(k => k + 1);
          }}
      />
      <BomListEditorModal
          listId={editorListId}
          onClose={() => setEditorListId(null)}
          onChanged={() => setBomRefreshKey(k => k + 1)}
      />
    </div>
  );
};
