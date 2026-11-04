import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDepartments, useBulkSelection, useServerPagination, useAbortOnUnmount } from '@/hooks';
import { DataTable, SearchInput, ColumnFilter, BulkSelectionBar, BulkActionButton, Pagination } from '@/components/ui';
import { ALL_CATEGORIES, STOCK_FILTER_OPTIONS } from '@/features/inventory/components/InventoryTable';
import { stockColorClass } from '@/utils/stock';
import { client } from '@/api';


export const SuperAdminInventoryPage = () => {
  const { departments, fetchDepartments } = useDepartments();

  const [deptFilter, setDeptFilter] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  // Item Name column filter — an exact name, sent to the server like Category.
  const [nameFilter, setNameFilter] = useState('');
  const abortSignal = useAbortOnUnmount();
  const [searchParams, setSearchParams] = useSearchParams();
  const { selectedIds, toggleSelect, toggleSelectAllVisible, clearSelection } = useBulkSelection();

  // Server-driven: the backend handles name search + item-name/dept/category/
  // stock filters + 10/page pagination, so only one page of rows is ever in
  // memory and every filter covers the whole catalogue.
  // stock values low/out map to the LOW_STOCK/OUT_OF_STOCK enum server-side.
  const {
    items, total, page, setPage, totalPages,
    search, setSearch, isLoading, refetch,
  } = useServerPagination<any>({ urlKey: 'page',
    endpoint: '/inventory',
    params: {
      departmentId: deptFilter || undefined,
      category: catFilter || undefined,
      status: stockFilter || undefined,
      name: nameFilter || undefined,
    },
  });

  useEffect(() => {
    const stock = searchParams.get('stock');
    if (stock) {
      setStockFilter(stock);
      setSearchParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the stock param once on mount to seed the filter then strips it; must not re-run on searchParams/setSearchParams
  }, []);

  useEffect(() => {
    fetchDepartments();
  }, [fetchDepartments]);

  // A filter on every data column (owner, 27 Oct), all sent to the server:
  // Item Name (exact `name`), Stock level, Category and Department.
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
      : [...new Set<string>(items.map((r: any) => r?.name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    // A picked name stays offered even if the list has not caught up with it.
    const withPicked = nameFilter && !names.includes(nameFilter) ? [nameFilter, ...names] : names;
    return withPicked.map((n) => ({ value: n, label: n }));
  }, [allNames, items, nameFilter]);
  const hasFilters = !!(search || deptFilter || catFilter || stockFilter || nameFilter);

  const columns = [
    { filterActive: !!nameFilter, header: <span className="inline-flex items-center">Item Name<ColumnFilter searchable options={nameOptions} value={nameFilter} onChange={setNameFilter} /></span>, accessor: (row: any) => <span className="font-bold text-ink">{row?.name || 'Unknown'}</span> },
    { filterActive: !!stockFilter, header: <span className="inline-flex items-center">Stock<ColumnFilter options={STOCK_FILTER_OPTIONS} value={stockFilter} onChange={setStockFilter} /></span>, accessor: (row: any) => {
      const stock = row?.stock || 0;
      const color = stockColorClass(stock, 10);
      return <span className={`font-bold ${color}`}>{stock} {row?.unit || ''}</span>;
    }},
    { filterActive: !!catFilter, header: <span className="inline-flex items-center">Category<ColumnFilter searchable options={ALL_CATEGORIES} value={catFilter} onChange={setCatFilter} /></span>, accessor: (row: any) => <span className="text-sm text-muted">{row?.category?.replace(/_/g, ' ') || 'N/A'}</span> },
    { filterActive: !!deptFilter, header: <span className="inline-flex items-center">Department<ColumnFilter searchable options={departments.map(d => ({ label: d.name, value: d.id }))} value={deptFilter} onChange={setDeptFilter} /></span>, accessor: (row: any) => row?.department?.name || 'Unassigned' },
  ];

  const clearFilters = () => { setSearch(''); setDeptFilter(''); setCatFilter(''); setStockFilter(''); setNameFilter(''); };

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="bg-card p-4 md:p-6 rounded-lg shadow-sm border border-line-soft">
          <div className="flex flex-col space-y-4 w-full">
            <div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Inventory Items</h2>
              <p className="text-sm md:text-[15px] text-muted mt-1.5">{total} {hasFilters ? `item${total === 1 ? '' : 's'} match these filters` : 'items'} · Cross-department visibility.</p>
            </div>
            <div className="flex flex-col md:flex-row gap-3 items-center w-full">
              <div className="flex-1 w-full relative">
                  <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search inventory..." />
              </div>
              {hasFilters && (
                <button onClick={clearFilters} className="text-sm text-brand font-bold hover:underline whitespace-nowrap">Clear</button>
              )}
            </div>
            {stockFilter && (
              <div className="flex gap-2 text-xs font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 px-3 py-1.5 rounded-full w-max">
                Filtering by: {STOCK_FILTER_OPTIONS.find((o) => o.value === stockFilter)?.label ?? stockFilter}
                <button onClick={() => setStockFilter('')} className="ml-2 hover:text-amber-800 dark:text-amber-200">×</button>
              </div>
            )}
          </div>
      </div>

      <div className="bg-card rounded-lg shadow-sm border border-line-soft">
        <BulkSelectionBar count={selectedIds.size} onClear={clearSelection}>
          <BulkActionButton
            label="Share"
            count={selectedIds.size}
            verb="shared"
            confirmTitle="Mark items shared?"
            confirmMessage={`Make ${selectedIds.size} selected item${selectedIds.size === 1 ? '' : 's'} shared across departments?`}
            onRun={async () => {
              const ids = [...selectedIds];
              await client.post('/inventory/bulk-set-shared', { itemIds: ids, isShared: true });
              return { succeeded: ids.length, failed: [] };
            }}
            onDone={() => { clearSelection(); refetch(); }}
          />
          <BulkActionButton
            label="Unshare"
            count={selectedIds.size}
            verb="unshared"
            confirmTitle="Mark items private?"
            confirmMessage={`Make ${selectedIds.size} selected item${selectedIds.size === 1 ? '' : 's'} private to their own department?`}
            onRun={async () => {
              const ids = [...selectedIds];
              await client.post('/inventory/bulk-set-shared', { itemIds: ids, isShared: false });
              return { succeeded: ids.length, failed: [] };
            }}
            onDone={() => { clearSelection(); refetch(); }}
          />
          {/* No Archive here: archiving is the Inventory team's alone (owner,
              28 Oct — "only inventory can do that"), on the server as well. */}
        </BulkSelectionBar>
        <DataTable
          columns={columns}
          data={items}
          isLoading={isLoading}
          keyExtractor={(row) => row.id}
          emptyStateMessage={hasFilters ? 'No items match these filters.' : 'No inventory items found.'}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onToggleSelectAllVisible={toggleSelectAllVisible}
        />
        <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
      </div>
    </div>
  );
};
