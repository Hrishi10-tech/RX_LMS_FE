import React, { useState, useEffect, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { useAuth, useServerPagination, useAbortOnUnmount } from '@/hooks';
import { extractErrorMessage, cachedGet } from '@/lib';
import { X, AlertTriangle } from 'lucide-react';

import { InventoryFilters } from '../components/InventoryFilters';
import { InventoryTable, ALL_CATEGORIES, DEFAULT_UNITS, ALL_COLUMNS } from '../components/InventoryTable';
import type { CategoryDef, UnitDef } from '../components/InventoryTable';
import { BulkUploadModal } from '../components/BulkUploadModal';
import { RestoreFromDownloadModal } from '../components/RestoreFromDownloadModal';
import { SettingsModal } from '../components/SettingsModal';
import { AddComponentModal } from '../components/AddComponentModal';
import { AdjustStockModal } from '../components/AdjustStockModal';
import { ArchiveItemsDialog } from '../components/ArchiveItemsDialog';
import { UnarchiveOfferDialog, UnarchiveRowsDialog } from '../components/UnarchiveOffer';
import type { ArchivedMatch, ArchivedRowMatch, RowChoice } from '../components/UnarchiveOffer';
import { groupUnarchiveRows, summariseFailures } from '../utils/unarchiveRows';
import { Modal, Pagination } from '@/components/ui';
import { UserRole } from '@/types';
import { defaultStockMode, detectPhantomDuplicates } from '../utils/mergeStockMode';

export const ComponentManagementPage = () => {


  const abortSignal = useAbortOnUnmount();
    const { user } = useAuth();
    const navigate = useNavigate();
    // Only INVENTORY / SUPER_ADMIN may post audited stock adjustments (matches
    // the /inventory/:id/adjust role guard). ADMIN can raw-edit stock but not
    // adjust, so we don't show them the button.
    const canAdjust = user?.role === UserRole.INVENTORY || user?.role === UserRole.SUPER_ADMIN;
    // The per-item history link goes to /inventory/history, which only exists
    // under the inventory area — and GET /inventory/events is Inventory and
    // Super Admin only. Offering the link to anyone else would be a dead end
    // dressed up as a feature, so it is shown to the role that owns the page.
    const canSeeItemHistory = user?.role === UserRole.INVENTORY;
    // Restore from download is the inventory team's tool (POST
    // /inventory/restore/* is Inventory-only). The Super Admin's whole-database
    // restore lives on the Database Manager page.
    const canRestore = user?.role === UserRole.INVENTORY;
    const [restoreOpen, setRestoreOpen] = useState(false);

    const [adjustTarget, setAdjustTarget] = useState<any | null>(null);
    const [searchParams, setSearchParams] = useSearchParams();
    const isReadOnly = user?.role === UserRole.PROCUREMENT;
    const tableRef = useRef<HTMLDivElement>(null);
    const scrollToSerial = useRef<number | null>(null);

    const [departments, setDepartments] = useState<any[]>([]);
    const [projects, setProjects] = useState<any[]>([]);
    // Distinct filter values + duplicate groups come from dedicated server
    // endpoints so the dropdowns and dupe banner stay correct without ever
    // loading the whole inventory into the browser.
    const [filterOptions, setFilterOptions] = useState<any | null>(null);
    const [duplicateGroups, setDuplicateGroups] = useState<any[][]>([]);

    const [stockSort, setStockSort] = useState<'none' | 'asc' | 'desc'>('none');
    const [stockFilter, setStockFilter] = useState('');
    const [filters, setFilters] = useState<Record<string, string>>({});
    // "Last edited" range + sort. Server-side, so they narrow the whole
    // catalogue rather than the ten rows currently in memory.
    const [updatedFrom, setUpdatedFrom] = useState('');
    const [updatedTo, setUpdatedTo] = useState('');
    const [editedSort, setEditedSort] = useState<'recent' | 'oldest' | null>(null);
    const setFilter = (key: string, val: string) => setFilters(prev => ({ ...prev, [key]: val }));

    const [showSettings, setShowSettings] = useState(false);
    const [units, setUnits] = useState<UnitDef[]>(DEFAULT_UNITS);
    // Read-only now: the category set is the ComponentCategory enum, so this is
    // the fixed list the UI displays and the approval toggles hang off — nothing
    // mutates it. (It used to be mutable local state that pretended to save.)
    const [customCategories] = useState<CategoryDef[]>(ALL_CATEGORIES);
    const [visibleCols, setVisibleCols] = useState(ALL_COLUMNS.map(c => c.key));
    const [lowStockThreshold, setLowStockThreshold] = useState(10);

    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
    const [isUploading, setIsUploading] = useState(false);
    // Merge-dialog state — the group being merged + which row was picked as canonical.
    const [mergeGroup, setMergeGroup] = useState<any[] | null>(null);
    const [mergeCanonicalId, setMergeCanonicalId] = useState<string>('');
    // When the dupe rows are *double-counted phantoms* (e.g. our receive-indent
    // double-write bug), summing their stock inflates the canonical 2×. This
    // toggle lets the user override the default 'sum' behaviour and just trash
    // the dupes' stock alongside the dupe rows.
    const [mergeStockMode, setMergeStockMode] = useState<'sum' | 'keep'>('sum');
    const [mergeSubmitting, setMergeSubmitting] = useState(false);
    const [lastUploadIds, setLastUploadIds] = useState<string[]>([]);
    // The batch the last upload wrote. "Undo Upload" undoes THAT batch, so the
    // server can mark its rows as never created rather than archived.
    const [lastUploadBatchId, setLastUploadBatchId] = useState<string | null>(null);
    const [showRecentOnly, setShowRecentOnly] = useState(false);
    const [uploadHistory, setUploadHistory] = useState<any[]>([]);
    const [customColumns, setCustomColumns] = useState<any[]>([]);
    // category → needsApproval flag. Drives whether an indent containing this category triggers tech approval.
    const [categoryApproval, setCategoryApproval] = useState<Record<string, boolean>>({});

    // Bulk-select state for the "Mark Shared / Mark Dept-only" workflow.
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    // --- Archived items --------------------------------------------------------
    // Archiving an inventory item is a SOFT delete (InventoryItem is in the
    // backend's SOFT_DELETE_MODELS, so the row keeps existing with deletedAt
    // set). This panel is how an archived item comes back.
    const [archiveTarget, setArchiveTarget] = useState<{ id: string; name: string }[] | null>(null);
    // "An archived item has this name" — the Add Item form waits on the answer.
    const [archivedOffer, setArchivedOffer] = useState<{ match: ArchivedMatch; addStock: number; resolve: (c: 'unarchive' | 'new' | 'cancel') => void } | null>(null);
    // Spreadsheet rows held back because they match archived items, and the
    // file they came from (a "create new" choice sends it back for those rows).
    const [archivedRows, setArchivedRows] = useState<{ rows: ArchivedRowMatch[]; file: File } | null>(null);
    const [deletedOpen, setDeletedOpen] = useState(false);
    const [deletedItems, setDeletedItems] = useState<any[]>([]);
    const [deletedLoading, setDeletedLoading] = useState(false);
    const [deletedSearch, setDeletedSearch] = useState('');
    const [restoringId, setRestoringId] = useState<string | null>(null);
    const [bulkSubmitting, setBulkSubmitting] = useState(false);

    const toggleSelect = (id: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };
    const toggleSelectAllVisible = (visibleIds: string[]) => {
        setSelectedIds(prev => {
            const allOn = visibleIds.length > 0 && visibleIds.every(id => prev.has(id));
            const next = new Set(prev);
            if (allOn) visibleIds.forEach(id => next.delete(id));
            else visibleIds.forEach(id => next.add(id));
            return next;
        });
    };
    const clearSelection = () => setSelectedIds(new Set());

    // Bulk Edit Field modal state
    const [bulkEditOpen, setBulkEditOpen] = useState(false);
    const [bulkField, setBulkField] = useState<'containerName' | 'rackAddress' | 'trayNumber' | 'category' | 'departmentId'>('containerName');
    const [bulkValue, setBulkValue] = useState('');

    const openBulkEdit = () => { setBulkField('containerName'); setBulkValue(''); setBulkEditOpen(true); };
    const submitBulkEdit = async () => {
        if (selectedIds.size === 0 || !bulkValue) { addToast('Pick a value first', 'error'); return; }
        setBulkSubmitting(true);
        try {
            const { data } = await client.post('/inventory/bulk-update', {
                itemIds: Array.from(selectedIds),
                data: { [bulkField]: bulkValue },
            });
            const updated = data?.data?.updated ?? data?.updated ?? selectedIds.size;
            addToast(`${updated} item${updated === 1 ? '' : 's'} updated`, 'success');
            setBulkEditOpen(false);
            clearSelection();
            fetchItems();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Bulk update failed'), 'error');
        } finally {
            setBulkSubmitting(false);
        }
    };

    const handleBulkSetShared = async (isShared: boolean) => {
        if (selectedIds.size === 0) return;
        setBulkSubmitting(true);
        try {
            const { data } = await client.post('/inventory/bulk-set-shared', {
                itemIds: Array.from(selectedIds),
                isShared,
            });
            const updated = data?.data?.updated ?? data?.updated ?? selectedIds.size;
            addToast(`${updated} item${updated === 1 ? '' : 's'} marked as ${isShared ? 'shared' : 'dept-only'}`, 'success');
            clearSelection();
            fetchItems();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Bulk update failed'), 'error');
        } finally {
            setBulkSubmitting(false);
        }
    };

    const { addToast } = useToast();
    const confirm = useConfirm();

    // Server-driven table: the backend does name search + every column filter +
    // stock sort + 10/page pagination, so only one page of rows is ever held in
    // memory. Column filters map to query params; custom-column filters pass
    // through as custom_<id>; `ids` powers the post-upload "Show recent only".
    const serverParams: Record<string, string | undefined> = {
        category: filters.category || undefined,
        departmentId: filters.department || undefined,
        projectId: filters.project || undefined,
        name: filters.name || undefined,
        unit: filters.unit || undefined,
        rack: filters.rack || undefined,
        container: filters.container || undefined,
        tray: filters.tray || undefined,
        status: stockFilter || undefined,
        updatedFrom: updatedFrom || undefined,
        updatedTo: updatedTo || undefined,
        // One sort at a time: picking "last edited" releases the stock sort and
        // vice versa, because the server takes a single orderBy and a UI that
        // shows two active sort arrows is lying about one of them.
        orderBy: editedSort ? editedSort
          : stockSort === 'asc' ? 'stockAsc'
          : stockSort === 'desc' ? 'stockDesc'
          : undefined,
        // Cap the id list so a very large upload can't overflow the request URL;
        // beyond the cap the toggle just shows everything (the upload toast
        // already reported the count).
        ids: showRecentOnly && lastUploadIds.length > 0 && lastUploadIds.length <= 400
            ? lastUploadIds.join(',')
            : undefined,
    };
    for (const [k, v] of Object.entries(filters)) {
        if (k.startsWith('custom_') && v) serverParams[k] = v;
    }

    const [exporting, setExporting] = useState(false);

    // Download the table as .xlsx. Sends the SAME serverParams the table is
    // showing, minus pagination, so the file matches the screen rather than
    // being a fresh unfiltered dump — and `search` is passed explicitly
    // because it lives outside serverParams.
    //
    // responseType 'blob': without it axios parses the body as text and the
    // zip container is corrupted by the time it reaches the anchor, producing
    // a file Excel refuses to open.
    const handleExport = async () => {
        setExporting(true);
        try {
            const params: Record<string, string> = {};
            for (const [k, v] of Object.entries(serverParams)) if (v) params[k] = String(v);
            if (search.trim()) params.search = search.trim();
            const res = await client.get('/inventory/export', { params, responseType: 'blob', signal: abortSignal() });
            const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1]
                ?? `component_database_${new Date().toISOString().slice(0, 10)}.xlsx`;
            const url = URL.createObjectURL(res.data as Blob);
            const a = document.createElement('a');
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click(); a.remove();
            // Revoked on the next tick, not immediately — Safari cancels the
            // download if the object URL dies in the same frame as the click.
            setTimeout(() => URL.revokeObjectURL(url), 0);
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Could not download the components'), 'error');
        }
        setExporting(false);
    };

    const {
        items: pageItems, page, setPage, totalPages,
        search, setSearch, isLoading, refetch: refetchTable,
    } = useServerPagination<any>({ urlKey: 'page', endpoint: '/inventory', params: serverParams });

    // Page-relative running serial for the S.No column.
    const tableRows = pageItems.map((item, idx) => ({ ...item, _serial: (page - 1) * 10 + idx + 1 }));

    // --- Data fetching ---
    // Metadata the page needs alongside the paginated table: dept + project
    // lookups (editors/modals), the filter-dropdown option lists, and the
    // duplicate-name groups. The table rows come from the hook above.
    const refreshMeta = async () => {
        try {
            const [deptRes, projRes, foRes, dupRes] = await Promise.all([
                cachedGet<any>('/departments'),
                cachedGet<any>('/projects'),
                client.get('/inventory/filter-options', { signal: abortSignal() }),
                client.get('/inventory/duplicates', { signal: abortSignal() }),
            ]);
            setDepartments(deptRes.data || deptRes);
            setProjects(projRes.data || projRes);
            setFilterOptions(foRes.data?.data ?? foRes.data ?? null);
            const groups = (dupRes.data?.data ?? dupRes.data)?.groups || [];
            setDuplicateGroups(groups);
            // Returned as well as stored: the upload handler needs to know
            // whether the rows it just created collided with anything, and
            // reading the state it just set would give it the previous value.
            // Returning avoids a second /inventory/duplicates request.
            return groups as any[][];
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to load inventory'), 'error'); }
        return [] as any[][];
    };

    // Refresh after a mutation: re-pull the current table page + all metadata.
    // (Kept the `fetchItems` name so every existing call site still refreshes
    // the table the way it used to.)
    const fetchItems = () => { refetchTable(); refreshMeta(); };

    // These three swallowed their errors, so a failed fetch rendered as an
    // EMPTY list — indistinguishable from genuinely having no custom columns,
    // no upload history, no category rules. That is the same shape as the
    // "this item isn't in the system" reports: the UI states an absence it has
    // not actually verified. Say the load failed instead.
    const fetchCustomColumns = async () => {
        try { const res = await client.get('/inventory/custom-columns', { signal: abortSignal() }); setCustomColumns(res.data?.data || res.data || []); }
        catch (e: any) { addToast(extractErrorMessage(e, 'Could not load custom columns — the list below may be incomplete'), 'error'); }
    };

    const fetchUploadHistory = async () => {
        try { const res = await client.get('/inventory/upload-history', { signal: abortSignal() }); setUploadHistory(res.data?.data || res.data || []); }
        catch (e: any) { addToast(extractErrorMessage(e, 'Could not load upload history'), 'error'); }
    };

    const fetchCategoryApproval = async () => {
        try {
            const res = await client.get('/inventory/category-settings', { signal: abortSignal() });
            const rows = res.data?.data || res.data || [];
            const map: Record<string, boolean> = {};
            for (const r of rows) map[r.category] = !!r.needsApproval;
            setCategoryApproval(map);
        } catch (e: any) { addToast(extractErrorMessage(e, 'Could not load category approval rules'), 'error'); }
    };

    const toggleCategoryApproval = async (category: string, needsApproval: boolean) => {
        // Optimistic update so the checkbox feels instant.
        setCategoryApproval(prev => ({ ...prev, [category]: needsApproval }));
        try {
            await client.patch(`/inventory/category-settings/${category}`, { needsApproval });
        } catch (e: any) {
            // Revert on failure.
            setCategoryApproval(prev => ({ ...prev, [category]: !needsApproval }));
            addToast(extractErrorMessage(e, 'Failed to update category'), 'error');
        }
    };

    // The server-pagination hook loads the first table page itself; here we
    // only pull the metadata (don't call fetchItems → avoids a double fetch).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial metadata load (server-pagination hook loads the first page itself), runs once on mount
    useEffect(() => { refreshMeta(); fetchCustomColumns(); fetchCategoryApproval(); }, []);

    // Auto-refresh on focus / visibility — keeps the table in sync when work
    // happens in another tab or another user's session (e.g. someone else just
    // merged a duplicate, or a soft-delete migration finished on the backend).
    // Avoids the "why am I having to manually refresh every time" failure mode.
    useEffect(() => {
        // Switching tabs fires BOTH 'focus' and 'visibilitychange' on return, which
        // used to double-fetch everything. Collapse repeats while keeping both
        // triggers (tab-return via visibility, app-refocus via focus).
        //
        // At most once a minute, counted from the page's own first load. Each
        // refresh is the table, the filter options, the duplicate scan and the
        // category settings, and alt-tabbing to copy a part number out of a
        // datasheet used to run all of them every time. Changes made on this
        // page refresh it directly, so the minute only delays seeing someone
        // else's edit.
        const MIN_GAP_MS = 60_000;
        let lastRefresh = Date.now();
        const refresh = () => {
            const now = Date.now();
            if (now - lastRefresh < MIN_GAP_MS) return;
            lastRefresh = now;
            fetchItems(); fetchCategoryApproval();
        };
        const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
        window.addEventListener('focus', refresh);
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.removeEventListener('focus', refresh);
            document.removeEventListener('visibilitychange', onVisible);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- registers the focus/visibility refresh listeners once on mount; fetchItems is a render-scope helper and re-registering would churn the listeners
    }, []);

    useEffect(() => {
        const sf = searchParams.get('stockFilter');
        const scrollTo = searchParams.get('scrollTo');
        if (sf) { setStockFilter(sf); setSearchParams({}, { replace: true }); }
        if (scrollTo) { scrollToSerial.current = parseInt(scrollTo); setSearchParams({}, { replace: true }); }
        // eslint-disable-next-line react-hooks/exhaustive-deps -- reads searchParams once on mount to seed the stock filter / scroll target then strips them; must not re-run on searchParams/setSearchParams
    }, []);

    useEffect(() => {
        if (scrollToSerial.current && pageItems.length > 0) {
            const target = scrollToSerial.current;
            scrollToSerial.current = null;
            setTimeout(() => {
                const row = document.querySelector(`[data-serial="${target}"]`);
                if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 300);
        }
    }, [pageItems]);

    // --- Handlers ---
    const handleUpdateField = async (id: string, field: string, value: any) => {
        try {
            await client.patch(`/inventory/${id}`, { [field]: value });
            addToast(`Updated ${field}`, 'success');
            fetchItems();
        } catch (e: any) { addToast(extractErrorMessage(e, `Failed to update ${field}`), 'error'); }
    };

    const handleAddItem = async (item: any) => {
        // Throws on failure so AddComponentModal keeps what was typed — it only
        // clears after onAdd resolves, and swallowing the error here made every
        // rejected save look like a success to it, wiping the form.
        if (!item.name || !item.departmentId) {
            addToast('Name and department required.', 'error');
            throw new Error('missing fields');
        }
        try {
            await client.post('/inventory', item);
        } catch (e: any) {
            // Not a failure — a question: an archived item has this name.
            if (e?.details?.code === 'ARCHIVED_MATCH' && e.details.data) {
                const match = e.details.data as ArchivedMatch;
                const addStock = Number(item.stock) || 0;
                const choice = await new Promise<'unarchive' | 'new' | 'cancel'>((resolve) => setArchivedOffer({ match, addStock, resolve }));
                setArchivedOffer(null);
                try {
                    if (choice === 'cancel') throw e;
                    if (choice === 'unarchive') {
                        await client.post(`/inventory/${match.id}/unarchive`, { addStock });
                        addToast(`"${match.name}" unarchived${addStock > 0 ? ` with ${addStock} ${match.unit} added` : ''}`, 'success');
                    } else {
                        await client.post('/inventory', { ...item, createAnyway: true });
                        addToast('Item added', 'success');
                    }
                } catch (err: any) {
                    if (err !== e) addToast(extractErrorMessage(err, 'Failed to add item'), 'error');
                    throw err;
                }
                setIsAddModalOpen(false);
                fetchItems();
                return;
            }
            addToast(extractErrorMessage(e, 'Failed to add item'), 'error');
            throw e;
        }
        addToast('Item added', 'success');
        setIsAddModalOpen(false);
        fetchItems();
    };

    const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setIsUploading(true);
        try {
            const formData = new FormData();
            formData.append('file', file);
            const res = await client.post('/inventory/bulk', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
            const data = res.data?.data || res.data;
            const count = data?.successCount ?? 0;
            const ids = data?.createdIds || [];
            const fileErrors: string[] = data?.errors || [];
            const held: ArchivedRowMatch[] = data?.archivedMatches || [];
            if (held.length > 0) {
                setIsBulkModalOpen(false);
                setArchivedRows({ rows: held, file });
            }
            if (count > 0) {
                addToast(`Uploaded ${count} items`, 'success');
                setIsBulkModalOpen(false);
                setLastUploadIds(ids);
                setLastUploadBatchId(data?.batchId ?? null);
                setShowRecentOnly(true);
                refetchTable();
                // The import deliberately does NOT merge by name — two parts
                // can legitimately share one — so a collision creates a second
                // row and the amber banner offers a merge. That banner was the
                // only signal, though: the upload itself reported
                // "Uploaded N items" with no hint that some of them landed on
                // top of an existing name, so you had to happen to notice it.
                //
                // Only groups containing a row from THIS upload are mentioned.
                // Counting every duplicate in the inventory would blame the
                // upload for pre-existing ones.
                const groups = await refreshMeta();
                const touched = groups.filter((g) => g.some((r: any) => ids.includes(r.id)));
                if (touched.length > 0) {
                    addToast(
                        touched.length === 1
                            ? `"${touched[0][0]?.name}" already existed — it's now on two rows. Merge them in the banner below, or rename one if they're different parts.`
                            : `${touched.length} uploaded items share a name with an existing row. Merge them in the banner below, or rename them if they're different parts.`,
                        'info',
                    );
                }
                // Partial-success: rows that failed validation (unknown project,
                // unknown category, missing name, …) were silently swallowed
                // before — surface them now so the user can act on them.
                if (fileErrors.length > 0) {
                    addToast(fileErrors[0], 'info');
                    if (fileErrors.length > 1) {
                        console.warn('[bulk upload] additional issues:', fileErrors.slice(1));
                    }
                }
            } else if (held.length === 0) {
                addToast(fileErrors.length > 0 ? fileErrors[0] : 'No valid items in CSV', 'error');
            }
        } catch (err: any) { addToast(extractErrorMessage(err, 'Failed to upload file'), 'error'); }
        finally { setIsUploading(false); e.target.value = ''; }
    };

    // Open the merge dialog for a given duplicate group. Default the canonical
    // selection to the row with the most stock — least surprising starting point.
    //
    // The stock mode is NOT hardcoded to Sum any more. When the rows carry the
    // fingerprint of one pile recorded several times, this opens on "Keep
    // canonical only" instead. Summing a group of 14 phantom rows multiplies
    // that item's stock by 14 and leaves nothing behind that looks wrong — it
    // is simply too big, for ever, until somebody counts the shelf.
    const openMergeDialog = (group: any[]) => {
        const sorted = [...group].sort((a, b) => Number(b.stock || 0) - Number(a.stock || 0));
        setMergeGroup(group);
        setMergeCanonicalId(sorted[0]?.id || '');
        setMergeStockMode(defaultStockMode(group));
    };
    const closeMergeDialog = () => { setMergeGroup(null); setMergeCanonicalId(''); setMergeSubmitting(false); setMergeStockMode('sum'); };
    const submitMerge = async () => {
        if (!mergeGroup || !mergeCanonicalId) return;
        const duplicateIds = mergeGroup.map(r => r.id).filter(id => id !== mergeCanonicalId);
        if (duplicateIds.length === 0) return;
        setMergeSubmitting(true);
        try {
            const res = await client.post(`/inventory/${mergeCanonicalId}/merge`, { duplicateIds, stockMode: mergeStockMode });
            const d = res.data?.data || res.data;
            const stockMsg = d?.stockDiscarded > 0
                ? `Stock kept: ${d?.canonical?.stock ?? '?'} (discarded ${d.stockDiscarded} phantom from dupes).`
                : `Stock added: ${d?.stockAdded ?? 0}.`;
            addToast(`Merged ${d?.mergedCount ?? duplicateIds.length} row(s). ${stockMsg}`, 'success');
            closeMergeDialog();
            fetchItems();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Merge failed'), 'error');
            setMergeSubmitting(false);
            // "Not found" usually means our view is stale (someone else already
            // merged/deleted, or a soft-deleted row was hard-cleaned). Re-pull
            // so the banner reflects reality instead of leaving the user stuck.
            if (/not found/i.test(e?.message || '')) {
                closeMergeDialog();
                fetchItems();
            }
        }
    };

    // Undo goes through the upload's batch, not bulk-delete. bulk-delete is an
    // archive: the rows landed in Archived items and the next upload of the
    // same sheet was offered "unarchive + add" against them. The owner's rule
    // (28 Oct) is that an undone upload never happened, and only the batch
    // route marks the rows that way.
    const handleUndoUpload = async () => {
        if (lastUploadIds.length === 0 || !lastUploadBatchId) return;
        try {
            const res = await client.post(`/inventory/undo-batch/${lastUploadBatchId}`);
            addToast(`Undo complete \u2014 removed ${res.data?.data?.deletedCount ?? 0} items`, 'success');
            setLastUploadIds([]); setLastUploadBatchId(null); setShowRecentOnly(false); fetchItems();
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to undo upload'), 'error'); }
    };

    const handleUndoBatch = async (batchId: string) => {
        if (!await confirm('Delete all items from this upload?')) return;
        try {
            const res = await client.post(`/inventory/undo-batch/${batchId}`);
            addToast(`Undo complete \u2014 removed ${res.data?.data?.deletedCount ?? 0} items`, 'success');
            fetchUploadHistory(); fetchItems();
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to undo'), 'error'); }
    };

    const handleSaveCustomValue = async (columnId: string, itemId: string, value: string) => {
        try { await client.post(`/inventory/custom-columns/${columnId}/values`, { values: [{ inventoryItemId: itemId, value }] }); fetchItems(); }
        catch (e: any) { addToast(extractErrorMessage(e, 'Failed to save'), 'error'); }
    };

    const handleCreateCustomColumn = async (data: any) => {
        try {
            await client.post('/inventory/custom-columns', data);
            addToast(`Column "${data.name}" created \u2014 click Edit to add dropdown options`, 'success');
            fetchCustomColumns();
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed'), 'error'); }
    };

    const handleUpdateColumn = async (colId: string, data: any) => {
        try { await client.patch(`/inventory/custom-columns/${colId}`, data); fetchCustomColumns(); }
        catch (e: any) { addToast(extractErrorMessage(e, 'Failed to update column'), 'error'); }
    };

    // Archive and unarchive are the Inventory desk's alone (owner, 28 Oct) —
    // the /inventory/archive, /unarchive and /bulk-restore guards say the same.
    const canArchive = user?.role === UserRole.INVENTORY;

    // Archive a single item. The dialog shows what happens to its open
    // requests before anything changes (see ArchiveItemsDialog).
    const handleArchiveItem = (row: any) => setArchiveTarget([{ id: row.id, name: row.name }]);
    const onArchived = (r: { archivedCount: number; cancelled: string[]; staysOpen: string[] }) => {
        setArchiveTarget(null);
        const extra = [
            r.cancelled.length ? `${r.cancelled.join(', ')} cancelled` : '',
            r.staysOpen.length ? `${r.staysOpen.join(', ')} still open` : '',
        ].filter(Boolean).join('; ');
        addToast(`Archived${extra ? ` — ${extra}` : ''}. Find it under "Archived items".`, 'success');
        clearSelection();
        fetchItems();
    };

    // Rows a spreadsheet held back because they match archived items.
    const applyArchivedRows = async (choices: Record<number, RowChoice>) => {
        if (!archivedRows) return;
        const { rows, file } = archivedRows;
        let unarchived = 0;
        const failures: string[] = [];
        // One unarchive per archived item, with every row's quantity for it
        // added together. Two rows of one sheet naming the same archived part
        // used to send two unarchives: the second found it live already,
        // failed, and its quantity was lost.
        for (const g of groupUnarchiveRows(rows, choices)) {
            try { await client.post(`/inventory/${g.id}/unarchive`, { addStock: g.addStock, source: 'BULK_UPLOAD' }); unarchived += g.rows.length; }
            catch (e: any) { failures.push(`${g.rows.length === 1 ? 'Row' : 'Rows'} ${g.rows.join(', ')}: ${extractErrorMessage(e, 'could not unarchive')}`); }
        }
        const fresh = rows.filter((x) => choices[x.row] === 'new').map((x) => x.row);
        let created = 0;
        if (fresh.length > 0) {
            try {
                const formData = new FormData();
                formData.append('file', file);
                formData.append('onlyRows', fresh.join(','));
                formData.append('createAnyway', 'true');
                const res = await client.post('/inventory/bulk', formData, { headers: { 'Content-Type': 'multipart/form-data' } });
                const data = res.data?.data || res.data;
                created = data?.successCount ?? 0;
                failures.push(...(data?.errors || []));
            } catch (e: any) { failures.push(extractErrorMessage(e, 'Could not create the new rows')); }
        }
        setArchivedRows(null);
        const done = [unarchived ? `${unarchived} unarchived` : '', created ? `${created} added as new` : ''].filter(Boolean).join(', ');
        if (done) addToast(`${done[0].toUpperCase()}${done.slice(1)}.`, 'success');
        // Every failure, not just the first — each one is a row whose stock
        // did not land, and the clerk has to know which.
        if (failures.length) addToast(summariseFailures(failures), 'error');
        fetchItems();
    };

    // Load the recycle bin. Its own request against the role-guarded
    // /inventory/deleted route — deliberately NOT a flag on the main list, so
    // deleted rows can never appear in normal inventory views.
    // The term last loaded. Leaving the search box reloads only when the term
    // changed: clicking Unarchive right after typing used to blur the box,
    // reload, swap the table for "Loading…" mid-click, and lose the click.
    const deletedTermRef = useRef<string | null>(null);
    const fetchDeletedItems = async (searchTerm = '') => {
        if (deletedTermRef.current === searchTerm && deletedOpen) return;
        deletedTermRef.current = searchTerm;
        setDeletedLoading(true);
        try {
            const res = await client.get('/inventory/deleted', { params: { take: 100, ...(searchTerm ? { search: searchTerm } : {}) }, signal: abortSignal() });
            const payload = res.data?.data ?? res.data;
            setDeletedItems(payload?.items ?? payload ?? []);
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to load archived items'), 'error');
            setDeletedItems([]);
            deletedTermRef.current = null; // let the same search be tried again
        } finally { setDeletedLoading(false); }
    };

    const openDeletedPanel = () => { deletedTermRef.current = null; setDeletedOpen(true); setDeletedSearch(''); fetchDeletedItems(); };

    const handleRestoreItem = async (row: any) => {
        setRestoringId(row.id);
        try {
            await client.post('/inventory/bulk-restore', { ids: [row.id] });
            addToast(`"${row.name}" unarchived`, 'success');
            // Drop it from the bin list immediately, then refresh the live table
            // so it reappears there without a manual reload.
            setDeletedItems(prev => prev.filter(i => i.id !== row.id));
            fetchItems();
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to unarchive item'), 'error'); }
        finally { setRestoringId(null); }
    };

    const handleDeleteCustomColumn = async (colId: string) => {
        if (!await confirm('Delete this column and all its data?')) return;
        try { await client.delete(`/inventory/custom-columns/${colId}`); addToast('Column deleted', 'success'); fetchCustomColumns(); fetchItems(); }
        catch (e: any) { addToast(extractErrorMessage(e, 'Failed to delete column'), 'error'); }
    };

    // Units are a genuinely local convenience: `InventoryItem.unit` is a free
    // string column, so a unit added here is usable immediately on this
    // session's data entry and whatever the user types is what persists on the
    // item. It is NOT a saved setting though, and the UI used to imply
    // otherwise — a green "Unit added" success toast and a "Delete unit?"
    // confirm dialog for a list that reset on reload. Both are now honest.
    //
    // The category mutators that sat here have been removed entirely rather
    // than made honest: `InventoryItem.category` is a Prisma ENUM, so a
    // category invented at runtime could never be saved on an item — and the
    // list feeds both the item form and the BULK-EDIT category picker, so a
    // made-up value could be applied to many rows at once and fail on every
    // one. The persisted part of that section (the Needs-Approval toggle) is
    // untouched.
    const addCustomUnit = (short: string, full: string) => {
        if (units.find(u => u.short === short)) { addToast('Unit already exists', 'error'); return; }
        setUnits([...units, { short, full }]);
        addToast(`Unit ${short} available for this session`, 'info');
    };

    const removeUnit = (short: string) => {
        setUnits(units.filter(u => u.short !== short));
        addToast(`Unit ${short} hidden for this session`, 'info');
    };

    const addProject = async (name: string) => {
        try {
            await client.post('/projects', { name });
            addToast('Project created', 'success'); fetchItems();
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to create project'), 'error'); }
    };

    const editProject = async (id: string, name: string) => {
        try { await client.patch(`/projects/${id}`, { name }); addToast('Project renamed', 'success'); fetchItems(); }
        catch (e: any) { addToast(extractErrorMessage(e, 'Failed to rename project'), 'error'); }
    };

    const deleteProject = async (id: string) => {
        if (!await confirm('Are you sure you want to delete this project?')) return;
        try { await client.delete(`/projects/${id}`); addToast('Project deleted', 'success'); fetchItems(); }
        catch (e: any) { addToast(extractErrorMessage(e, 'Failed to delete project'), 'error'); }
    };

    const toggleColumn = (key: string) => { setVisibleCols(prev => prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]); };

    // Filtering, sorting, serial numbering, pagination and duplicate detection
    // are all server-driven now (see serverParams + refreshMeta above).
    const hasActiveFilters = !!(search || stockSort !== 'none' || stockFilter || Object.values(filters).some(v => v));

    return (
        <div className="space-y-4 md:space-y-6">
            <InventoryFilters
                search={search}
                onSearchChange={setSearch}
                stockFilter={stockFilter}
                onStockFilterClear={() => setStockFilter('')}
                hasActiveFilters={hasActiveFilters}
                onClearAll={() => { setSearch(''); setFilters({}); setStockSort('none'); setStockFilter(''); }}
                isReadOnly={isReadOnly}
                onOpenSettings={() => { setShowSettings(true); fetchUploadHistory(); }}
                onOpenBulkUpload={() => setIsBulkModalOpen(true)}
                onOpenAddComponent={() => setIsAddModalOpen(true)}
                canViewDeleted={canArchive}
                onOpenDeleted={openDeletedPanel}
                onExport={handleExport}
                exporting={exporting}
                onOpenRestore={canRestore ? () => setRestoreOpen(true) : undefined}
            />

            {lastUploadIds.length > 0 && (
                <div className="flex items-center justify-between bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">{lastUploadIds.length} items uploaded</span>
                        <button onClick={() => setShowRecentOnly(!showRecentOnly)}
                            className={`px-3 py-1 text-xs font-bold rounded-full transition-colors border ${showRecentOnly ? 'bg-brand text-white border-brand' : 'bg-card text-muted border-line hover:bg-surface'}`}>
                            {showRecentOnly ? 'Show All' : 'Show Recent Only'}
                        </button>
                    </div>
                    <div className="flex items-center gap-2">
                        <button onClick={handleUndoUpload} className="px-3 py-1 text-xs font-bold bg-red-600 text-white rounded-md hover:bg-red-700 transition-colors">Undo Upload</button>
                        <button onClick={() => { setLastUploadIds([]); setShowRecentOnly(false); }} className="text-xs text-faint hover:text-secondary"><X size={16} /></button>
                    </div>
                </div>
            )}

            {!isReadOnly && selectedIds.size > 0 && (
              <div className="sticky top-0 z-20 bg-ink text-card px-4 py-2.5 rounded-lg shadow-md flex items-center justify-between gap-3 flex-wrap">
                <span className="text-sm font-bold">
                  {selectedIds.size} item{selectedIds.size === 1 ? '' : 's'} selected
                  <span className="text-faint font-normal ml-2 text-xs">(click S.No to toggle · click the S.No header to select all visible)</span>
                </span>
                <div className="flex items-center gap-2 flex-wrap">
                  <button onClick={openBulkEdit} disabled={bulkSubmitting}
                    className="px-3 py-1.5 text-xs font-bold bg-brand text-white hover:bg-brand-dark rounded transition-colors disabled:opacity-50">
                    ✏️ Bulk Edit Field…
                  </button>
                  <button onClick={() => handleBulkSetShared(true)} disabled={bulkSubmitting}
                    className="px-3 py-1.5 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 rounded transition-colors disabled:opacity-50">
                    🌐 Mark Shared
                  </button>
                  <button onClick={() => handleBulkSetShared(false)} disabled={bulkSubmitting}
                    className="px-3 py-1.5 text-xs font-bold bg-amber-600 hover:bg-amber-700 rounded transition-colors disabled:opacity-50">
                    🔒 Mark Dept-only
                  </button>
                  <button onClick={clearSelection} disabled={bulkSubmitting}
                    className="px-3 py-1.5 text-xs font-bold border border-muted hover:bg-card/10 rounded transition-colors">
                    Clear
                  </button>
                </div>
              </div>
            )}

            {duplicateGroups.length > 0 && !isReadOnly && (
                <div className="bg-amber-50 dark:bg-amber-400/15 border border-amber-300 dark:border-amber-400/30 rounded-lg p-4">
                    <div className="flex items-start gap-3">
                        <AlertTriangle size={20} className="text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
                                {duplicateGroups.length === 1 ? '1 duplicate name detected in your inventory' : `${duplicateGroups.length} duplicate names detected in your inventory`}
                            </p>
                            <p className="text-xs text-amber-800 dark:text-amber-200 mt-0.5">
                                Multiple rows share the same name in the same department. Decide which is canonical, top up its stock from the duplicate(s), then delete the extras. Use a more specific name if they really are different items (e.g. include brand, spec, or part number).
                            </p>
                            <div className="mt-3 space-y-2">
                                {duplicateGroups.map((group, gi) => (
                                    <div key={gi} className="bg-card/60 border border-amber-200 dark:border-amber-400/30 rounded-md p-2.5">
                                        <div className="flex items-center justify-between mb-1.5 gap-2">
                                            <p className="text-xs font-bold text-amber-900 dark:text-amber-200">"{group[0].name}" — {group[0].department?.name || 'No dept'} ({group.length} rows)</p>
                                            <button onClick={() => openMergeDialog(group)}
                                                className="text-[11px] font-bold px-2.5 py-1 rounded bg-amber-700 text-white hover:bg-amber-800 transition-colors shrink-0">
                                                Merge…
                                            </button>
                                        </div>
                                        <ul className="space-y-1">
                                            {group.map((d: any) => (
                                                <li key={d.id} className="text-[11px] text-amber-900 dark:text-amber-200 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                                    <span>{d.category?.replace(/_/g, ' ') || 'Uncategorised'}</span>
                                                    <span className="text-amber-700 dark:text-amber-300">·</span>
                                                    <span>{d.isShared ? 'Shared' : 'Dept-only'}</span>
                                                    <span className="text-amber-700 dark:text-amber-300">·</span>
                                                    <span>Stock {d.stock ?? 0} {d.unit || ''}</span>
                                                    <button
                                                        onClick={() => { setSearch(d.name); tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
                                                        className="ml-auto text-[10px] text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:text-amber-200 font-bold underline">
                                                        Show in table
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <InventoryTable
                items={tableRows}
                allItems={pageItems}
                filterOptions={filterOptions}
                isLoading={isLoading}
                isReadOnly={isReadOnly}
                visibleCols={visibleCols}
                stockSort={stockSort}
                onStockSortChange={() => { setEditedSort(null); setStockSort(s => s === 'none' ? 'asc' : s === 'asc' ? 'desc' : 'none'); }}
                updatedFrom={updatedFrom}
                updatedTo={updatedTo}
                onUpdatedRangeChange={(f, t) => { setUpdatedFrom(f); setUpdatedTo(t); }}
                editedSort={editedSort}
                onEditedSortChange={() => {
                  setStockSort('none');
                  setEditedSort(v => v === null ? 'recent' : v === 'recent' ? 'oldest' : null);
                }}
                onShowHistory={canSeeItemHistory ? (row) => navigate(`/inventory/history?inventoryItemId=${row.id}`) : undefined}
                stockFilter={stockFilter}
                onStockFilterChange={setStockFilter}
                filters={filters}
                onFilterChange={setFilter}
                lowStockThreshold={lowStockThreshold}
                units={units}
                customCategories={customCategories}
                departments={departments}
                projects={projects}
                customColumns={customColumns}
                onUpdateField={handleUpdateField}
                onSaveCustomValue={handleSaveCustomValue}
                tableRef={tableRef as React.RefObject<HTMLDivElement>}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
                onToggleSelectAllVisible={toggleSelectAllVisible}
                onAdjustStock={canAdjust ? (row) => setAdjustTarget(row) : undefined}
                onArchiveItem={canArchive ? handleArchiveItem : undefined}
            />
            <ArchiveItemsDialog items={archiveTarget} onClose={() => setArchiveTarget(null)} onDone={onArchived} />
            <UnarchiveOfferDialog offer={archivedOffer} canUnarchive={canArchive} onChoose={(c) => archivedOffer?.resolve(c)} />
            <UnarchiveRowsDialog rows={archivedRows?.rows ?? null} canUnarchive={canArchive} onApply={applyArchivedRows} onClose={() => { setArchivedRows(null); fetchItems(); }} />
            <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />

            <AdjustStockModal
                isOpen={!!adjustTarget}
                onClose={() => setAdjustTarget(null)}
                item={adjustTarget}
                onSuccess={fetchItems}
            />

            <SettingsModal
                isOpen={showSettings}
                onClose={() => setShowSettings(false)}
                userId={user?.id}
                visibleCols={visibleCols}
                onToggleColumn={toggleColumn}
                uploadHistory={uploadHistory}
                onUndoBatch={handleUndoBatch}
                customColumns={customColumns}
                onCreateCustomColumn={handleCreateCustomColumn}
                onUpdateColumn={handleUpdateColumn}
                onDeleteCustomColumn={handleDeleteCustomColumn}
                lowStockThreshold={lowStockThreshold}
                onLowStockThresholdChange={setLowStockThreshold}
                customCategories={customCategories}
                categoryApproval={categoryApproval}
                onToggleCategoryApproval={toggleCategoryApproval}
                units={units}
                onAddUnit={addCustomUnit}
                onRemoveUnit={removeUnit}
                projects={projects}
                departments={departments}
                onAddProject={addProject}
                onEditProject={editProject}
                onDeleteProject={deleteProject}
            />

            <AddComponentModal
                isOpen={isAddModalOpen}
                onClose={() => setIsAddModalOpen(false)}
                onAdd={handleAddItem}
                departments={departments}
                projects={projects}
                customCategories={customCategories}
                units={units}
                existingItems={pageItems}
            />

            <RestoreFromDownloadModal
                isOpen={restoreOpen}
                onClose={() => setRestoreOpen(false)}
                onRestored={() => { refetchTable(); refreshMeta(); }}
            />

            <BulkUploadModal
                isOpen={isBulkModalOpen}
                onClose={() => setIsBulkModalOpen(false)}
                onFileUpload={handleFileUpload}
                isUploading={isUploading}
            />

            <Modal isOpen={!!mergeGroup} onClose={closeMergeDialog} title={mergeGroup ? `Merge duplicates — "${mergeGroup[0].name}"` : ''}>
                {mergeGroup && (() => {
                    const dupes = mergeGroup.filter(r => r.id !== mergeCanonicalId);
                    const canonical = mergeGroup.find(r => r.id === mergeCanonicalId);
                    const stockSum = dupes.reduce((s, d) => s + Number(d.stock || 0), 0);
                    const stockAdded = mergeStockMode === 'keep' ? 0 : stockSum;
                    const finalStock = Number(canonical?.stock || 0) + stockAdded;
                    const unitsMatch = mergeGroup.every(r => (r.unit || '').toUpperCase() === (mergeGroup[0].unit || '').toUpperCase());
                    // Heuristic for the double-receive bug: all rows have the
                    // exact same totalReceived (and >0). If receive logic
                    // double-wrote, two rows end up with identical
                    // totalReceived. Real duplicates from different batches
                    // almost never produce identical numbers.
                    const phantomSignal = detectPhantomDuplicates(mergeGroup);
                    const suspectedDoubleCount = phantomSignal.suspected;
                    // Sort oldest-first so the user has an obvious mental model:
                    // "the top row is the original, the rest were added later."
                    // Falls back to id ordering when createdAt is missing.
                    const ordered = [...mergeGroup].sort((a, b) => {
                        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                        if (ta && tb) return ta - tb;
                        return String(a.id).localeCompare(String(b.id));
                    });
                    const oldestId = ordered[0]?.id;
                    const newestId = ordered[ordered.length - 1]?.id;
                    const fmtCreated = (iso?: string) => iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
                    return (
                        <div className="space-y-3">
                            <div className="bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-md p-2.5 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
                                <span>Pick the row to <span className="font-bold">keep</span>. The rest are deleted; their data moves onto the kept row first.</span>
                                <span
                                    className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-200 text-amber-900 dark:text-amber-200 text-[10px] font-bold cursor-help flex-shrink-0 mt-0.5"
                                    title={'Stock, requests, events, indent links, project tags — all carried over to the kept row before deletion. No data is lost.\n\nRows are sorted oldest → newest. ORIGINAL is the row created first; ADDED LATER were created after (often via CSV import or an indent that didn\'t dedupe by name).'}
                                >?</span>
                            </div>
                            <div className="space-y-1.5">
                                {ordered.map(r => (
                                    <label key={r.id} className={`flex items-start gap-2 p-2.5 border rounded-md cursor-pointer transition-colors ${r.id === mergeCanonicalId ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-400/15' : 'border-line hover:border-amber-300 dark:border-amber-400/30'}`}>
                                        <input type="radio" name="canonical" checked={r.id === mergeCanonicalId} onChange={() => setMergeCanonicalId(r.id)} className="mt-1" />
                                        <div className="flex-1 min-w-0">
                                            <p className="text-sm font-bold text-ink flex items-center flex-wrap gap-1.5">
                                                {r.name}
                                                {r.id === oldestId && ordered.length > 1 && (
                                                    <span className="text-[10px] font-bold text-indigo-700 dark:text-indigo-300 bg-indigo-100 dark:bg-indigo-400/20 px-1.5 py-0.5 rounded" title="Created earliest — likely the original entry">ORIGINAL</span>
                                                )}
                                                {r.id === newestId && r.id !== oldestId && (
                                                    <span className="text-[10px] font-bold text-secondary bg-hover px-1.5 py-0.5 rounded" title="Added later">ADDED LATER</span>
                                                )}
                                                {r.id === mergeCanonicalId && <span className="text-[10px] font-bold text-emerald-700 dark:text-emerald-300 bg-emerald-100 dark:bg-emerald-400/20 px-1.5 py-0.5 rounded">KEEP</span>}
                                            </p>
                                            <p className="text-[11px] text-muted mt-0.5">
                                                {r.category?.replace(/_/g, ' ') || 'Uncategorised'} · {r.isShared ? 'Shared' : 'Dept-only'} · Stock {r.stock ?? 0} {r.unit || ''}
                                            </p>
                                            <p className="text-[10px] text-faint mt-0.5">
                                                Created {fmtCreated(r.createdAt)}{r.department?.name ? ` · ${r.department.name}` : ''}
                                            </p>
                                        </div>
                                    </label>
                                ))}
                            </div>
                            {!unitsMatch && (
                                <div className="bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 rounded-md p-3 text-xs text-red-900 dark:text-red-200">
                                    <span className="font-bold">Unit mismatch.</span> These rows are in different units — summing them is not safe. Edit one of them to match before merging.
                                </div>
                            )}
                            {unitsMatch && dupes.length > 0 && (
                                <div className="bg-card border border-line rounded-md p-2.5 text-xs">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-bold text-ink">Stock:</span>
                                        <label className="inline-flex items-center gap-1 cursor-pointer" title={'Adds the duplicates\' stock onto the kept row. Use when each row holds a real, separate batch (e.g. an item created twice by different people, each with their own physical inventory).'}>
                                            <input type="radio" name="stockMode" checked={mergeStockMode === 'sum'} onChange={() => setMergeStockMode('sum')} />
                                            <span className="text-ink">Sum</span>
                                        </label>
                                        <label className="inline-flex items-center gap-1 cursor-pointer" title={'Discards the duplicates\' stock — keeps only the canonical\'s. Use when the duplicates are phantoms sharing the kept row\'s physical stock (the pre-fix double-receive residue).'}>
                                            <input type="radio" name="stockMode" checked={mergeStockMode === 'keep'} onChange={() => setMergeStockMode('keep')} />
                                            <span className="text-ink">Keep canonical only</span>
                                        </label>
                                        {suspectedDoubleCount && (
                                            <span
                                                className="ml-auto text-[10px] font-bold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 px-1.5 py-0.5 rounded cursor-help"
                                                title={`${phantomSignal.suspected ? phantomSignal.detail : ''}\n\nSo this has been started on "Keep canonical only", which merges without inventing stock. If you know these really are separate batches that happen to match, switch it to Sum.\n\nNeither cause can recur: re-uploading a sheet no longer creates duplicate rows, and the receive flow now uses an atomic DB claim.`}
                                            >Looks like one pile recorded {mergeGroup.length}×</span>
                                        )}
                                    </div>
                                </div>
                            )}
                            {canonical && unitsMatch && (
                                <div className="bg-surface border border-line rounded-md p-3 text-xs">
                                    <p className="font-bold text-ink">Result</p>
                                    <p className="text-muted mt-0.5">
                                        "{canonical.name}" stock goes from <span className="font-mono">{canonical.stock || 0}</span> → <span className="font-mono font-bold">{finalStock}</span> {canonical.unit || ''}
                                        {mergeStockMode === 'sum'
                                            ? <> (+{stockAdded} from {dupes.length} merged row{dupes.length === 1 ? '' : 's'}).</>
                                            : <> ({stockSum} {canonical.unit || ''} from {dupes.length} duplicate row{dupes.length === 1 ? '' : 's'} discarded).</>}
                                    </p>
                                </div>
                            )}
                            <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
                                <button onClick={closeMergeDialog} disabled={mergeSubmitting}
                                    className="px-3 py-1.5 text-xs font-bold text-muted border border-line rounded hover:bg-surface disabled:opacity-50">
                                    Cancel
                                </button>
                                <button onClick={submitMerge} disabled={mergeSubmitting || !unitsMatch || !mergeCanonicalId}
                                    className="px-4 py-1.5 text-xs font-bold bg-amber-700 text-white rounded hover:bg-amber-800 disabled:opacity-50 disabled:cursor-not-allowed">
                                    {mergeSubmitting ? 'Merging…' : `Merge ${dupes.length} row${dupes.length === 1 ? '' : 's'}`}
                                </button>
                            </div>
                        </div>
                    );
                })()}
            </Modal>

            <Modal isOpen={bulkEditOpen} onClose={() => setBulkEditOpen(false)} title={`Bulk Edit · ${selectedIds.size} item${selectedIds.size === 1 ? '' : 's'}`}>
                <div className="space-y-4">
                    <div className="bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-lg p-3 text-xs text-amber-900 dark:text-amber-200">
                        Set <span className="font-bold">one field</span> across all {selectedIds.size} selected item{selectedIds.size === 1 ? '' : 's'}. Tip: filter the table first to narrow the selection.
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-muted mb-1">Field to update *</label>
                        <select value={bulkField} onChange={(e) => { setBulkField(e.target.value as any); setBulkValue(''); }}
                          className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none">
                            <option value="containerName">Container</option>
                            <option value="rackAddress">Rack Address</option>
                            <option value="trayNumber">Tray Number</option>
                            <option value="category">Category</option>
                            <option value="departmentId">Department</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs font-bold text-muted mb-1">New value *</label>
                        {bulkField === 'category' ? (
                            <select value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
                              className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none">
                                <option value="">-- Choose category --</option>
                                {customCategories.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                            </select>
                        ) : bulkField === 'departmentId' ? (
                            <select value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
                              className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none">
                                <option value="">-- Choose department --</option>
                                {departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
                            </select>
                        ) : (
                            <input type="text" value={bulkValue} onChange={(e) => setBulkValue(e.target.value)}
                              placeholder={bulkField === 'containerName' ? 'e.g. Box AC' : bulkField === 'rackAddress' ? 'e.g. R-3' : 'e.g. T-04'}
                              className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none" />
                        )}
                    </div>
                    <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
                        <button onClick={() => setBulkEditOpen(false)} className="px-4 py-2 text-sm font-bold text-muted hover:bg-surface rounded">Cancel</button>
                        <button onClick={submitBulkEdit} disabled={bulkSubmitting || !bulkValue}
                          className="px-5 py-2 text-sm font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50">
                            {bulkSubmitting ? 'Applying…' : `Apply to ${selectedIds.size}`}
                        </button>
                    </div>
                </div>
            </Modal>

            {/* Archived items — bring back anything you need again. */}
            <Modal isOpen={deletedOpen} onClose={() => setDeletedOpen(false)} title="Archived items">
                <div className="space-y-4">
                    <div className="bg-blue-50 dark:bg-blue-400/15 border border-blue-200 dark:border-blue-400/30 rounded-lg p-3 text-xs text-blue-900 dark:text-blue-200">
                        Archived items are kept, not erased. Unarchiving puts one back in the inventory list with its
                        stock and history intact.
                    </div>

                    <input
                        type="text"
                        value={deletedSearch}
                        onChange={(e) => setDeletedSearch(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') fetchDeletedItems(deletedSearch); }}
                        onBlur={() => fetchDeletedItems(deletedSearch)}
                        placeholder="Search archived items by name…"
                        className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none"
                    />

                    {deletedLoading ? (
                        <p className="text-sm text-muted py-6 text-center">Loading…</p>
                    ) : deletedItems.length === 0 ? (
                        <p className="text-sm text-muted py-6 text-center">
                            {deletedSearch ? 'No archived items match that search.' : 'Nothing has been archived.'}
                        </p>
                    ) : (
                        <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1">
                            <table className="w-full text-sm">
                                <thead className="sticky top-0 bg-card">
                                    <tr className="text-left text-[10px] uppercase font-bold text-faint border-b border-line">
                                        <th className="py-2 pr-2">Item</th>
                                        <th className="py-2 pr-2">Dept</th>
                                        <th className="py-2 pr-2 text-right">Stock</th>
                                        <th className="py-2 pr-2">Archived</th>
                                        <th className="py-2" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {deletedItems.map((row: any) => (
                                        <tr key={row.id} className="border-b border-line-soft last:border-0">
                                            <td className="py-2 pr-2">
                                                <span className="font-bold text-ink">{row.name}</span>
                                                {row.category && <span className="block text-[10px] text-faint">{row.category}</span>}
                                            </td>
                                            <td className="py-2 pr-2 text-xs text-muted">{row.department?.name || '—'}</td>
                                            <td className="py-2 pr-2 text-right text-xs text-muted">{row.stock} {row.unit}</td>
                                            <td className="py-2 pr-2 text-xs text-muted">
                                                {row.deletedAt
                                                    ? new Date(row.deletedAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                                                    : '—'}
                                            </td>
                                            <td className="py-2 text-right">
                                                <button onClick={() => handleRestoreItem(row)} disabled={restoringId === row.id}
                                                  className="px-3 py-1 text-xs font-bold bg-emerald-700 text-white rounded hover:bg-emerald-800 transition-colors disabled:opacity-50">
                                                    {restoringId === row.id ? 'Unarchiving…' : 'Unarchive'}
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    <div className="flex justify-end pt-2 border-t border-line-soft">
                        <button onClick={() => setDeletedOpen(false)} className="px-4 py-2 text-sm font-bold text-muted hover:bg-surface rounded">Close</button>
                    </div>
                </div>
            </Modal>
        </div>
    );
};
