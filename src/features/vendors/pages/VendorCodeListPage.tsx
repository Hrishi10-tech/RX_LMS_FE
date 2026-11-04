import { useEffect, useMemo, useState } from 'react';
import { client } from '@/api';
import { DataTable, Modal, SearchInput, ColumnFilter, BulkSelectionBar, BulkActionButton, Pagination, LoadAllCapNote } from '@/components/ui';
import { useBulkSelection, useServerPagination, useAbortOnUnmount, usePagedFilters, FilterSpec } from '@/hooks';
import { EditableCell } from '@/components/ui/EditableCell';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/hooks';
import { useConfirm } from '@/context/ConfirmContext';
import { Plus, Trash2, Settings, History, FolderOpen } from 'lucide-react';
import { VendorUploadButton } from '../components/VendorUploadButton';
import { VendorDocumentsModal } from '../components/VendorDocumentsModal';

import { extractErrorMessage } from '@/lib';
import { runPerId } from '@/utils/bulk';
const TABS = [
    { key: 'all', label: 'All' },
    { key: 'DOMESTIC', label: 'Domestic' },
    { key: 'INTERNATIONAL', label: 'International' },
];

// The same two values the tabs filter on, in the shape the cell editor wants.
// Derived rather than retyped: a select offering a value the tabs cannot show
// (or vice versa) is the kind of drift nobody notices until a vendor vanishes.
const CATEGORY_OPTS = TABS.filter(t => t.key !== 'all').map(t => ({ value: t.key, label: t.label }));

export const VendorCodeListPage = () => {


  const abortSignal = useAbortOnUnmount();

    const [activeTab, setActiveTab] = useState('all');
    const [sectionFilter, setSectionFilter] = useState('');
    const [typeFilter, setTypeFilter] = useState('');
    const [locationFilter, setLocationFilter] = useState('');
    const [showSettings, setShowSettings] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const [editHistory, setEditHistory] = useState<any[]>([]);
    const [showAddRow, setShowAddRow] = useState(false);
    // Which vendor's documents slip is open, if any.
    const [docsFor, setDocsFor] = useState<any>(null);
    // Documents left over from the standalone Vendor Forms page, which had no
    // vendor column. Zero on a clean install, so the banner below renders
    // nothing; non-zero only where such uploads already existed.
    const [unfiledCount, setUnfiledCount] = useState(0);
    const [showUnfiled, setShowUnfiled] = useState(false);
    const [newVendor, setNewVendor] = useState({ vendorName: '', productDealt: '', vendorType: '', location: '', email: '', contactNo: '', contactPerson: '', category: 'DOMESTIC', section: 'product' });

    // Custom vendor types & locations (editable filter options)
    const [customVendorTypes, setCustomVendorTypes] = useState<string[]>([]);
    const [customLocations, setCustomLocations] = useState<string[]>([]);
    const [newType, setNewType] = useState('');
    const [newLocation, setNewLocation] = useState('');

    const { addToast } = useToast();
    const confirm = useConfirm();
    // Mirrors the DELETE /vendor-forms/:id role gate. Only PROCUREMENT can
    // reach this page today, so this is belt-and-braces — but a hardcoded
    // `true` would quietly become wrong the day another role is let in.
    const { user } = useAuth();
    const canDeleteDocs = user?.role === 'PROCUREMENT' || user?.role === 'SUPER_ADMIN';
    const { selectedIds, toggleSelect, toggleSelectAllVisible, clearSelection } = useBulkSelection();

    // Tabs (category), section/type/location, and the search box are
    // server-side filters. Every vendor that matches them is loaded (loadAll —
    // a supplier register, not a transaction log, so far under LOAD_ALL_CAP) so the
    // per-column filters below search the whole list, then the result is
    // paged 10 at a time in the browser. The indents-page vendor dropdown
    // still reads this endpoint unpaginated (high default take on the backend).
    const { items: loadedItems, total, truncated, serverTotal, search, setSearch, isLoading, refetch } =
        useServerPagination<any>({ urlKey: 'page', loadAll: true,
            endpoint: '/vendor-codes',
            params: {
                category: activeTab === 'all' ? undefined : activeTab,
                section: sectionFilter || undefined,
                vendorType: typeFilter || undefined,
                location: locationFilter || undefined,
            },
        });
    // Local mirror of the loaded vendors so inline cell edits update
    // optimistically (a full refetch would reset scroll and the page).
    // Re-syncs whenever a fresh load arrives.
    const [vendors, setVendors] = useState<any[]>([]);
    useEffect(() => { setVendors(loadedItems); }, [loadedItems]);

    // Type / Location filter choices come from the WHOLE list, not the 10 rows
    // on screen — otherwise a type used only on page 3 could never be picked.
    // A failure leaves the dropdowns with what the visible page offers.
    const [allTypes, setAllTypes] = useState<string[]>([]);
    const [allLocations, setAllLocations] = useState<string[]>([]);
    const refreshFilterOptions = () => {
        client.get('/vendor-codes/filter-options', { signal: abortSignal() })
            .then(res => {
                const d = res.data?.data ?? res.data ?? {};
                setAllTypes(Array.isArray(d.vendorTypes) ? d.vendorTypes : []);
                setAllLocations(Array.isArray(d.locations) ? d.locations : []);
            })
            .catch(() => { /* the visible page's values are the fallback */ });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount; refreshed after edits below
    useEffect(refreshFilterOptions, []);
    const fetchVendors = () => { refetch(); refreshFilterOptions(); };

    // `take: 1` — only the total is wanted, never the rows.
    const refreshUnfiled = () => {
        client.get('/vendor-forms', { params: { unfiled: 'true', take: 1 }, signal: abortSignal() })
            .then(res => setUnfiledCount((res.data?.data || res.data)?.total || 0))
            .catch(() => { /* the banner is an extra; its absence is not an error */ });
    };
    useEffect(refreshUnfiled, []);

    const handleUpdate = async (id: string, field: string, value: any) => {
        if (field === 'vendorName' && !String(value ?? '').trim()) {
            addToast('Vendor name cannot be blank', 'error');
            return;
        }
        // Clearing a field sends null, not "". Same @IsOptional gap as above:
        // "" is validated and rejected, whereas null is treated as absent — so
        // null is what actually expresses "remove this value".
        const outgoing = typeof value === 'string' && value.trim() === '' ? null : value;
        try {
            await client.patch(`/vendor-codes/${id}`, { [field]: outgoing });
            // Update locally to avoid scroll reset from full refetch
            setVendors(prev => prev.map(v => v.id === id ? { ...v, [field]: value } : v));
            if (field === 'vendorType' || field === 'location') refreshFilterOptions();
        }
        catch (e: any) { addToast(extractErrorMessage(e, 'Failed to update'), 'error'); }
    };

    const [editingRow, setEditingRow] = useState<string | null>(null);

    const handleDelete = async (id: string) => {
        if (!await confirm('Delete this vendor?')) return;
        try { await client.delete(`/vendor-codes/${id}`); addToast('Deleted', 'success'); fetchVendors(); }
        catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
    };

    const handleAdd = async () => {
        const vendorName = newVendor.vendorName.trim();
        if (!vendorName) { addToast('Vendor name required', 'error'); return; }
        // Drop blank optionals rather than posting them as "".
        // The DTO marks email @IsOptional() @IsEmail(), and class-validator's
        // @IsOptional skips undefined and null but NOT the empty string — so an
        // untouched email box made the whole request 400 with "email must be a
        // valid email address", and a vendor could not be added without one
        // despite the field being optional.
        const payload = Object.fromEntries(
            Object.entries({ ...newVendor, vendorName })
                .filter(([, v]) => !(typeof v === 'string' && v.trim() === '')),
        );
        try {
            await client.post('/vendor-codes', payload);
            addToast('Vendor added (code auto-generated)', 'success');
            setShowAddRow(false);
            setNewVendor({ vendorName: '', productDealt: '', vendorType: '', location: '', email: '', contactNo: '', contactPerson: '', category: 'DOMESTIC', section: 'product' });
            fetchVendors();
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
    };

    // Failing silently here showed "no edit history" for a vendor that may
    // well have plenty — an absence the page never actually confirmed.
    const fetchHistory = async () => {
        try { const res = await client.get('/vendor-codes/edit-history', { signal: abortSignal() }); setEditHistory(res.data?.data || res.data || []); }
        catch (e: any) { addToast(extractErrorMessage(e, 'Could not load edit history'), 'error'); }
    };

    const addCustomType = () => {
        if (!newType.trim() || customVendorTypes.includes(newType.trim())) return;
        setCustomVendorTypes(prev => [...prev, newType.trim()]);
        setNewType('');
    };

    const addCustomLocation = () => {
        if (!newLocation.trim() || customLocations.includes(newLocation.trim())) return;
        setCustomLocations(prev => [...prev, newLocation.trim()]);
        setNewLocation('');
    };

    // Category/section/type/location/search are done server-side via the
    // pager params above — `vendors` is every vendor that matches them.
    const uniqueSections = [...new Set(vendors.map(v => v.section).filter(Boolean))].map(v => ({ value: v, label: v === 'product' ? 'Product' : 'Service' }));
    const uniqueTypes = [...new Set([...allTypes, ...vendors.map(v => v.vendorType).filter(Boolean), ...customVendorTypes])].map(v => ({ value: v, label: v }));
    const uniqueLocations = [...new Set([...allLocations, ...vendors.map(v => v.location).filter(Boolean), ...customLocations])].map(v => ({ value: v, label: v }));

    // Input for new row fields
    const ni = (field: string, placeholder?: string) => (
        <input type="text" value={(newVendor as any)[field] || ''} onChange={ev => setNewVendor({ ...newVendor, [field]: ev.target.value })}
            placeholder={placeholder || ''} className="w-full px-2 py-1 border border-emerald-300 dark:border-emerald-400/30 rounded text-xs bg-emerald-50/30 dark:bg-emerald-400/15 focus:border-brand outline-none" />
    );
    const ns = (field: string, opts: { value: string; label: string }[]) => (
        <select value={(newVendor as any)[field] || opts[0]?.value} onChange={ev => setNewVendor({ ...newVendor, [field]: ev.target.value })}
            className="w-full px-1 py-1 border border-emerald-300 dark:border-emerald-400/30 rounded text-xs bg-emerald-50/30 dark:bg-emerald-400/15 focus:border-brand outline-none">
            {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
    );

    const e = (r: any, field: string, val: string, type?: string, opts?: any[]) => {
        if (r._isNew) {
            if (field === 'vendorCode') return <span data-new-row className="text-xs text-faint italic">Auto</span>;
            if (type === 'select' && opts) return ns(field, opts);
            return ni(field, field);
        }
        if (editingRow === r.id) {
            return type === 'select'
                ? <EditableCell type="select" options={opts} value={val} onSave={v => handleUpdate(r.id, field, v)} />
                : <EditableCell value={val} onSave={v => handleUpdate(r.id, field, v)} />;
        }
        if (type === 'select' && opts) { const found = opts.find(o => o.value === val); return <span className="text-sm text-ink">{found?.label || val || '-'}</span>; }
        return <span className="text-sm text-ink">{val || '-'}</span>;
    };

    // A filter on every data column (owner, 27 Oct). Section / Type / Location
    // stay server-side above; these run over every loaded vendor, valued as
    // each cell reads.
    const pageSpecs = useMemo<FilterSpec<any>[]>(() => [
        { key: 'code', getValue: (r) => r.vendorCode || '-' },
        { key: 'name', getValue: (r) => r.vendorName || '-' },
        { key: 'product', getValue: (r) => r.productDealt || '-' },
        { key: 'category', getValue: (r) => CATEGORY_OPTS.find(o => o.value === (r.category || 'DOMESTIC'))?.label || r.category || '-' },
        { key: 'email', getValue: (r) => r.email || '-' },
        { key: 'contact', getValue: (r) => r.contactNo || '-' },
        { key: 'person', getValue: (r) => r.contactPerson || '-' },
        { key: 'responsive', getValue: (r) => (r.responsive !== false ? 'Yes' : 'No') },
    ], []);
    const pf = usePagedFilters(vendors, pageSpecs, 10, search);
    const columnFiltered = Object.keys(pf.filters).length > 0;
    const narrowed = columnFiltered || activeTab !== 'all' || !!sectionFilter || !!typeFilter || !!locationFilter || !!search.trim();
    const filtered = (label: string, key: string) => ({
        filterActive: pf.isActive(key),
        header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={pf.getOptions(key)} value={pf.filters[key] || ''} onChange={(v) => pf.setFilter(key, v)} /></span>,
    });

    const columns = [
        { ...filtered('Code', 'code'), accessor: (r: any) => e(r, 'vendorCode', r.vendorCode || '') },
        { ...filtered('Vendor Name', 'name'), accessor: (r: any) => e(r, 'vendorName', r.vendorName || '') },
        { ...filtered('Product/Service', 'product'), accessor: (r: any) => e(r, 'productDealt', r.productDealt || '') },
        { filterActive: !!sectionFilter, header: <span className="inline-flex items-center">Section<ColumnFilter options={uniqueSections} value={sectionFilter} onChange={setSectionFilter} /></span>,
          accessor: (r: any) => e(r, 'section', r.section || 'product', 'select', [{ value: 'product', label: 'Product' }, { value: 'service', label: 'Service' }]) },
        // Category had no control at all: it was hardcoded 'DOMESTIC' in the
        // add-row state and never editable afterwards, so every vendor created
        // here was Domestic and the International tab could only ever show rows
        // that arrived from an import. The backend already accepted it on both
        // create and update — only the input was missing.
        { ...filtered('Category', 'category'), accessor: (r: any) => e(r, 'category', r.category || 'DOMESTIC', 'select', CATEGORY_OPTS) },
        { filterActive: !!typeFilter, header: <span className="inline-flex items-center">Type<ColumnFilter searchable options={uniqueTypes} value={typeFilter} onChange={setTypeFilter} /></span>,
          accessor: (r: any) => e(r, 'vendorType', r.vendorType || '') },
        { filterActive: !!locationFilter, header: <span className="inline-flex items-center">Location<ColumnFilter searchable options={uniqueLocations} value={locationFilter} onChange={setLocationFilter} /></span>,
          accessor: (r: any) => e(r, 'location', r.location || '') },
        { ...filtered('Email', 'email'), accessor: (r: any) => e(r, 'email', r.email || '') },
        { ...filtered('Contact', 'contact'), accessor: (r: any) => e(r, 'contactNo', r.contactNo || '') },
        { ...filtered('Person', 'person'), accessor: (r: any) => e(r, 'contactPerson', r.contactPerson || '') },
        { ...filtered('Responsive', 'responsive'), accessor: (r: any) => {
            if (r._isNew) return null;
            const isResponsive = r.responsive !== false;
            return (
                <button
                    onClick={() => handleUpdate(r.id, 'responsive', !isResponsive)}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-bold transition-colors ${
                        isResponsive
                            ? 'bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-400/30 hover:bg-green-100 dark:bg-green-400/20'
                            : 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-400/30 hover:bg-red-100 dark:bg-red-400/20'
                    }`}
                    title={isResponsive ? 'Click to mark as unresponsive' : 'Click to mark as responsive'}
                >
                    <span className={`w-1.5 h-1.5 rounded-full ${isResponsive ? 'bg-green-500' : 'bg-red-400'}`} />
                    {isResponsive ? 'Yes' : 'No'}
                </button>
            );
        }},
        // Upload / View: vendor paperwork lives on the vendor's own row. This
        // replaced a standalone Vendor Forms page that held one flat pile of
        // PDFs with no column saying whose they were.
        { header: 'Upload', accessor: (r: any) => {
            // A row still being typed has no id to attach a file to.
            if (r._isNew) return null;
            return <VendorUploadButton vendor={r} onUploaded={fetchVendors} />;
        }},
        { header: 'View', accessor: (r: any) => {
            if (r._isNew) return null;
            const count = r._count?.forms ?? 0;
            return (
                <button
                    onClick={() => setDocsFor(r)}
                    disabled={count === 0}
                    className={`inline-flex items-center gap-1 px-2 py-1 text-xs font-bold rounded border transition-colors ${
                        count === 0
                            ? 'text-faint border-line cursor-not-allowed'
                            : 'text-brand-dark bg-brand/10 border-brand/20 hover:bg-brand/20'
                    }`}
                    title={count === 0 ? 'Nothing uploaded for this vendor yet' : `Open ${count} document${count === 1 ? '' : 's'}`}
                >
                    <FolderOpen size={12} /> {count === 0 ? 'None' : `View (${count})`}
                </button>
            );
        }},
        { header: 'Edit', accessor: (r: any) => {
            if (r._isNew) return (
                <div className="flex gap-1">
                    <button onClick={handleAdd} className="px-2 py-1 text-xs font-bold text-white bg-emerald-700 rounded hover:bg-emerald-800 transition-colors">Save</button>
                    <button onClick={() => setShowAddRow(false)} className="px-2 py-1 text-xs font-bold text-muted hover:bg-hover rounded">Cancel</button>
                </div>
            );
            return editingRow === r.id
                ? <button onClick={() => setEditingRow(null)} className="px-2 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 rounded hover:bg-emerald-100 dark:bg-emerald-400/20 transition-colors">Done</button>
                : <button onClick={() => setEditingRow(r.id)} className="px-2 py-1 text-xs font-bold text-brand bg-brand/10 border border-brand/20 rounded hover:bg-brand/20 transition-colors">Edit</button>;
        }},
        { header: '', accessor: (r: any) => r._isNew ? null : <button onClick={() => handleDelete(r.id)} className="text-faint hover:text-red-700 dark:text-red-300 transition-colors"><Trash2 size={14} /></button> },
    ];

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight text-ink">Vendor Code List</h2>
                    <p className="text-sm text-muted mt-0.5">{columnFiltered ? `${pf.filteredTotal} of ${total}` : total} vendors across domestic and international</p>
                    {unfiledCount > 0 && (
                        <button
                            onClick={() => setShowUnfiled(true)}
                            className="mt-2 inline-flex items-center gap-1.5 text-xs font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-md px-2.5 py-1.5 hover:bg-amber-100 transition-colors"
                        >
                            <FolderOpen size={13} />
                            {unfiledCount} document{unfiledCount === 1 ? '' : 's'} not filed under any vendor
                        </button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={() => setShowSettings(true)} className="p-2.5 rounded-lg border border-line text-muted hover:text-brand hover:border-brand transition-colors" title="Settings">
                        <Settings size={18} />
                    </button>
                    <button onClick={() => { setShowHistory(true); fetchHistory(); }} className="flex items-center gap-1.5 px-4 py-2 bg-ink text-card text-sm font-bold rounded-lg hover:bg-black transition-colors shadow-sm">
                        <History size={16} /> History
                    </button>
                </div>
            </div>

            <div className="bg-card rounded-xl shadow-sm border border-line-soft">
                <div className="px-4 pt-3 pb-2 flex items-center justify-between gap-3 border-b border-line-soft">
                    <div className="flex gap-1">
                        {TABS.map(t => (
                            <button key={t.key} onClick={() => setActiveTab(t.key)}
                                className={`px-3 py-1.5 text-xs font-bold rounded-lg transition-colors ${activeTab === t.key ? 'bg-brand text-white' : 'text-muted hover:bg-hover'}`}>
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <div className="flex items-center gap-2 flex-1 max-w-md">
                        <SearchInput value={search} onChange={e => setSearch(e.target.value)} placeholder="Search code, name, product..." />
                        <button onClick={() => { setShowAddRow(!showAddRow); if (!showAddRow) setTimeout(() => { const el = document.querySelector('[data-new-row]'); el?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 100); }} className={`p-2 rounded-lg border transition-colors shrink-0 ${showAddRow ? 'bg-brand text-white border-brand' : 'border-line text-muted hover:text-brand hover:border-brand'}`} title="Add new vendor">
                            <Plus size={16} />
                        </button>
                    </div>
                </div>


                {/* Active filters bar */}
                {(sectionFilter || typeFilter || locationFilter) && (
                    <div className="px-4 py-2 bg-amber-50/50 dark:bg-amber-400/15 border-b border-amber-100 dark:border-amber-400/25 flex items-center gap-2 flex-wrap">
                        <span className="text-[10px] font-bold text-amber-700 dark:text-amber-300 uppercase tracking-wider">Filters:</span>
                        {sectionFilter && (
                            <button onClick={() => setSectionFilter('')} className="flex items-center gap-1 px-2 py-0.5 text-xs font-bold bg-card text-ink border border-amber-200 dark:border-amber-400/30 rounded-full hover:bg-red-50 dark:bg-red-400/15 hover:border-red-200 dark:border-red-400/30 transition-colors">
                                Section: {sectionFilter === 'product' ? 'Product' : 'Service'} <Trash2 size={10} className="text-red-400 dark:text-red-300" />
                            </button>
                        )}
                        {typeFilter && (
                            <button onClick={() => setTypeFilter('')} className="flex items-center gap-1 px-2 py-0.5 text-xs font-bold bg-card text-ink border border-amber-200 dark:border-amber-400/30 rounded-full hover:bg-red-50 dark:bg-red-400/15 hover:border-red-200 dark:border-red-400/30 transition-colors">
                                Type: {typeFilter} <Trash2 size={10} className="text-red-400 dark:text-red-300" />
                            </button>
                        )}
                        {locationFilter && (
                            <button onClick={() => setLocationFilter('')} className="flex items-center gap-1 px-2 py-0.5 text-xs font-bold bg-card text-ink border border-amber-200 dark:border-amber-400/30 rounded-full hover:bg-red-50 dark:bg-red-400/15 hover:border-red-200 dark:border-red-400/30 transition-colors">
                                Location: {locationFilter} <Trash2 size={10} className="text-red-400 dark:text-red-300" />
                            </button>
                        )}
                        <button onClick={() => { setSectionFilter(''); setTypeFilter(''); setLocationFilter(''); }} className="text-[10px] font-bold text-red-700 dark:text-red-300 hover:underline ml-1">Clear all</button>
                    </div>
                )}

                <BulkSelectionBar count={selectedIds.size} onClear={clearSelection}>
                    <BulkActionButton
                        label="Delete"
                        count={selectedIds.size}
                        tone="danger"
                        verb="deleted"
                        confirmTitle="Delete vendors?"
                        confirmMessage={`Delete ${selectedIds.size} selected vendor${selectedIds.size === 1 ? '' : 's'}? This removes them from the vendor code list.`}
                        onRun={() => runPerId([...selectedIds], (id) => client.delete(`/vendor-codes/${id}`))}
                        onDone={() => { clearSelection(); fetchVendors(); }}
                    />
                </BulkSelectionBar>
                <DataTable
                    columns={columns}
                    data={showAddRow ? [...pf.pageRows, { id: '__new__', _isNew: true }] : pf.pageRows}
                    isLoading={isLoading}
                    keyExtractor={r => r.id}
                    emptyStateMessage={narrowed ? 'No vendors match these filters.' : 'No vendors yet. Use + to add one.'}
                    maxHeight="65vh"
                    selectedIds={selectedIds}
                    onToggleSelect={toggleSelect}
                    // The add-row placeholder is on screen but is not a vendor.
                    onToggleSelectAllVisible={(ids) => toggleSelectAllVisible(ids.filter(id => id !== '__new__'))}
                />
                <LoadAllCapNote truncated={truncated} shown={total} total={serverTotal} kept="first" hint="use a tab, the search or the Section / Type / Location filters to see the rest." />
                <Pagination currentPage={pf.page} totalPages={pf.totalPages} onPageChange={pf.setPage} />
            </div>

            {/* History Modal */}
            <Modal isOpen={showHistory} onClose={() => setShowHistory(false)} title="Edit History">
                <div className="max-h-[60vh] overflow-y-auto">
                    {editHistory.length === 0 ? (
                        <p className="text-sm text-faint text-center py-8">No edits recorded yet.</p>
                    ) : (
                        <div className="space-y-0">
                            {editHistory.map((h: any) => (
                                <div key={h.id} className="flex items-start gap-3 py-2.5 border-b border-line-soft last:border-0">
                                    <div className={`mt-1 w-2 h-2 rounded-full shrink-0 ${h.field === '_created' ? 'bg-emerald-500' : h.field === '_deleted' ? 'bg-red-500' : 'bg-brand'}`} />
                                    <div className="flex-1 min-w-0">
                                        {h.field === '_created' ? (
                                            <p className="text-sm text-ink">Created vendor <span className="font-bold font-mono">{h.newValue}</span></p>
                                        ) : h.field === '_deleted' ? (
                                            <p className="text-sm text-red-700 dark:text-red-300">Deleted vendor <span className="font-bold font-mono">{h.oldValue}</span></p>
                                        ) : (
                                            <p className="text-sm text-ink">Changed <span className="font-bold">{h.field}</span>: <span className="text-red-700 dark:text-red-300 line-through">{h.oldValue || '(empty)'}</span> → <span className="text-emerald-700 dark:text-emerald-300 font-medium">{h.newValue || '(empty)'}</span></p>
                                        )}
                                        <p className="text-[10px] text-faint">{h.editedBy?.name} · {new Date(h.createdAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </Modal>

            {/* Settings Modal */}
            <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title="Vendor List Settings">
                <div className="space-y-6 max-h-[70vh] overflow-y-auto p-1">
                    {/* "Custom Columns" was removed here: it was non-functional end to
                        end. The definitions were component state with no fetch and no
                        write, so a column vanished on close while the UI toasted
                        success — and each one rendered as an EDITABLE cell whose save
                        went to PATCH /vendor-codes/:id with a `custom_<name>` field
                        that UpdateVendorCodeDto does not declare, so with
                        forbidNonWhitelisted on every keystroke's save was a
                        guaranteed 400.
                        Doing this properly needs a definitions endpoint plus a values
                        table, the way /inventory/custom-columns already works for
                        inventory. Until then, offering it is worse than not. */}

                    {/* Vendor Types */}
                    <div>
                        <h3 className="text-sm font-bold text-ink mb-2">Vendor Types</h3>
                        <p className="text-xs text-faint mb-2">Add custom vendor types for the filter dropdown</p>
                        <div className="flex flex-wrap gap-1.5 mb-3">
                            {uniqueTypes.map(t => (
                                <span key={t.value} className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-hover text-ink flex items-center gap-1">
                                    {t.label}
                                    {customVendorTypes.includes(t.value) && (
                                        <button onClick={() => setCustomVendorTypes(prev => prev.filter(x => x !== t.value))} className="text-red-400 hover:text-red-700 dark:text-red-300"><Trash2 size={10} /></button>
                                    )}
                                </span>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <input type="text" value={newType} onChange={e => setNewType(e.target.value)} onKeyDown={e => e.key === 'Enter' && addCustomType()} placeholder="Add vendor type..." className="flex-1 px-2 py-1.5 border rounded text-sm focus:border-brand outline-none" />
                            <button onClick={addCustomType} className="px-3 py-1.5 bg-brand text-white text-xs font-bold rounded-full hover:bg-brand-dark transition-colors"><Plus size={14} /></button>
                        </div>
                    </div>

                    {/* Locations */}
                    <div>
                        <h3 className="text-sm font-bold text-ink mb-2">Locations</h3>
                        <p className="text-xs text-faint mb-2">Add custom locations for the filter dropdown</p>
                        <div className="flex flex-wrap gap-1.5 mb-3">
                            {uniqueLocations.map(l => (
                                <span key={l.value} className="px-2 py-0.5 text-[11px] font-bold rounded-full bg-hover text-ink flex items-center gap-1">
                                    {l.label}
                                    {customLocations.includes(l.value) && (
                                        <button onClick={() => setCustomLocations(prev => prev.filter(x => x !== l.value))} className="text-red-400 hover:text-red-700 dark:text-red-300"><Trash2 size={10} /></button>
                                    )}
                                </span>
                            ))}
                        </div>
                        <div className="flex gap-2">
                            <input type="text" value={newLocation} onChange={e => setNewLocation(e.target.value)} onKeyDown={e => e.key === 'Enter' && addCustomLocation()} placeholder="Add location..." className="flex-1 px-2 py-1.5 border rounded text-sm focus:border-brand outline-none" />
                            <button onClick={addCustomLocation} className="px-3 py-1.5 bg-brand text-white text-xs font-bold rounded-full hover:bg-brand-dark transition-colors"><Plus size={14} /></button>
                        </div>
                    </div>
                </div>
            </Modal>

            <VendorDocumentsModal
                vendor={null}
                unfiled={showUnfiled}
                onClose={() => setShowUnfiled(false)}
                onChanged={refreshUnfiled}
                canDelete={canDeleteDocs}
            />

            <VendorDocumentsModal
                vendor={docsFor}
                onClose={() => setDocsFor(null)}
                // Refresh the row's count after an upload or delete, so the
                // View button stops saying "None" the moment it stops being true.
                onChanged={fetchVendors}
                canDelete={canDeleteDocs}
            />
        </div>
    );
};
