import { PICKER_INITIAL_ITEMS } from '@/features/inventory/hooks/useInventoryOptions';
import { useEffect, useMemo, useState } from 'react';
import { useInventoryOptions, useBulkSelection, useServerPagination, useAbortOnUnmount } from '@/hooks';
import { DataTable, SearchInput, ColumnFilter, Modal, BulkSelectionBar, Pagination } from '@/components/ui';
import { ALL_CATEGORIES, STOCK_FILTER_OPTIONS } from '@/features/inventory/components/InventoryTable';
import { RequestForm, IndentForm } from '@/components/forms';
import { AddToBomListButton, CreateBomListModal, BomListEditorModal } from '@/features/bom-lists';
import { useToast } from '@/context/ToastContext';
import { client } from '@/api';
import { extractErrorMessage } from '@/lib';


export const AdminComponentsPage = () => {
    // The table below is server-paginated; this is the COMPLETE scoped list the
    // Request Component picker needs. /inventory caps at 200 rows ordered by
    // name, so the picker used to lose every item after that alphabetically.
    // Short list, not the whole catalogue: this only fills the Request
    // Component picker, and that picker now searches the server as you
    // type. Pulling every scoped row on mount made everyone wait for a
    // download they mostly never used.
const { items: optionItems, truncated: optionsTruncated, total: optionsTotal, refetch: refetchOptions } = useInventoryOptions(PICKER_INITIAL_ITEMS);
    const { addToast } = useToast();

    const [catFilter, setCatFilter] = useState('');
    const [stockFilter, setStockFilter] = useState('');
    // Item Name column filter — an exact name, sent to the server like Category.
    const [nameFilter, setNameFilter] = useState('');
    const abortSignal = useAbortOnUnmount();

    // Server-paginated table data. Item name, category and stock filters are
    // sent to the backend, so they cover the whole catalogue;
    // search is debounced inside the hook. `search`/`setSearch` keep their names
    // so the SearchInput wiring below is unchanged.
    const {
      items: pageItems, total, page, setPage, totalPages,
      search, setSearch, isLoading: tableLoading, refetch: refetchTable,
    } = useServerPagination<any>({ urlKey: 'page', endpoint: '/inventory', params: { category: catFilter || undefined, status: stockFilter || undefined, name: nameFilter || undefined } });

    // A filter on every data column (owner, 27 Oct), all sent to the server.
    // Item Name choices: every name in the user's scope, from
    // /inventory/filter-options (as the other inventory tables do), falling
    // back to the names on screen if that call fails.
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
      const names: string[] = allNames.length > 0
        ? allNames
        : [...new Set<string>(pageItems.map((r: any) => r?.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      // A picked name stays offered even if the list has not caught up with it.
      const withPicked = nameFilter && !names.includes(nameFilter) ? [nameFilter, ...names] : names;
      return withPicked.map((n) => ({ value: n, label: n }));
    }, [allNames, pageItems, nameFilter]);
    const hasFilters = !!(search || catFilter || stockFilter || nameFilter);

    const [isRequestModalOpen, setIsRequestModalOpen] = useState(false);
    const [isIndentModalOpen, setIsIndentModalOpen] = useState(false);
    const [selectedItem, setSelectedItem] = useState<any>(null);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const { selectedIds, toggleSelect, toggleSelectAllVisible, clearSelection } = useBulkSelection();

    // BOM-list bulk wiring — the same smart picker the standard dashboard uses:
    // tick components, "Add N to list", and create/pick a draft inline. Admins
    // are allowed to raise BOMs (POST /bom-lists permits ADMIN), so this is a
    // real workflow, not just dead selection.
    const [isCreateBomOpen, setIsCreateBomOpen] = useState(false);
    const [editorListId, setEditorListId] = useState<string | null>(null);

    // No mount-time refetchOptions() here: useInventoryOptions already fetches on
    // mount, so this effect only ever produced a second identical
    // /inventory/options request (61 KB) per visit. The post-save refetch below
    // is the one that matters.

    const handleRequest = (item: any) => {
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
        refetchOptions();
        refetchTable();
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
        // Surface the new PENDING indent to the procurement/admin queue + badges.
        window.dispatchEvent(new Event('indents-updated'));
      // Hand the saved indent back so the form can attach its photos.
      return indentRes.data?.data ?? indentRes.data;
      } catch (e: any) {
        addToast(extractErrorMessage(e, 'Failed to raise indent'), 'error');
      } finally {
        setIsSubmitting(false);
      }
    };

    const columns = [
        { filterActive: !!nameFilter, header: <span className="inline-flex items-center">Item Name<ColumnFilter searchable options={nameOptions} value={nameFilter} onChange={setNameFilter} /></span>, accessor: (row: any) => <span className="font-bold text-ink">{row?.name || 'Unknown'}</span> },
        { filterActive: !!stockFilter, header: <span className="inline-flex items-center">Stock<ColumnFilter options={STOCK_FILTER_OPTIONS} value={stockFilter} onChange={setStockFilter} /></span>, accessor: (row: any) => {
          const stock = row?.stock || 0;
          const color = stock >= 10 ? 'text-green-700 dark:text-green-300' : stock > 0 ? 'text-amber-700 dark:text-amber-300' : 'text-red-700 dark:text-red-300';
          return <span className={`font-bold ${color}`}>{stock} {row?.unit || ''}</span>;
        }},
        { filterActive: !!catFilter, header: <span className="inline-flex items-center">Category<ColumnFilter allLabel="All Categories" options={ALL_CATEGORIES} value={catFilter} onChange={setCatFilter} /></span>, accessor: (row: any) => <span className="text-sm text-muted">{row?.category?.replace(/_/g, ' ') || 'N/A'}</span> },
        {
            header: 'Action',
            accessor: (row: any) => row.stock > 0
                ? <button onClick={() => handleRequest(row)} className="bg-brand hover:bg-brand-dark text-white px-3 py-1 rounded-full font-bold text-sm transition-colors shadow-sm">Request</button>
                : <button onClick={() => handleRaiseIndent(row)} className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded-md font-bold text-sm transition-colors shadow-sm">Raise Indent</button>
        },
    ];

    return (
        <div className="space-y-4 md:space-y-6">
          <div className="bg-card p-4 md:p-6 rounded-lg shadow-sm border border-line-soft">
            <div className="flex flex-col space-y-4 w-full">
              <div>
                <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Inventory Items</h2>
                <p className="text-sm md:text-[15px] text-muted mt-1.5">{total} {hasFilters ? `component${total === 1 ? '' : 's'} match these filters` : 'components'} within your designated departments.</p>
              </div>
              <div className="w-full">
                <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by item name..." />
              </div>
            </div>
          </div>

          <div className="bg-card rounded-lg shadow-sm border border-line-soft p-4 min-h-[400px]" style={{ overflow: 'visible' }}>
            <BulkSelectionBar count={selectedIds.size} onClear={clearSelection}>
              <AddToBomListButton
                selectedIds={Array.from(selectedIds)}
                onAdded={() => clearSelection()}
                onCreateNew={() => setIsCreateBomOpen(true)}
              />
            </BulkSelectionBar>
            <DataTable
              columns={columns}
              data={pageItems}
              isLoading={tableLoading}
              keyExtractor={(row) => row.id}
              emptyStateMessage={hasFilters ? 'No components match these filters.' : 'No components in your departments yet.'}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelect}
              onToggleSelectAllVisible={toggleSelectAllVisible}
            />
            <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
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

          {/* BOM-list modals — co-located so the bulk "Add to list" picker can
              create a fresh list and drop straight into its editor. */}
          <CreateBomListModal
              isOpen={isCreateBomOpen}
              onClose={() => setIsCreateBomOpen(false)}
              onCreated={(list) => { setIsCreateBomOpen(false); setEditorListId(list.id); }}
          />
          <BomListEditorModal
              listId={editorListId}
              onClose={() => setEditorListId(null)}
          />
        </div>
      );
}
