import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { client } from '@/api';
import { cachedGet, extractErrorMessage } from '@/lib';
import { DataTable, Modal, StatusBadge, ColumnFilter, Pagination, LoadAllCapNote } from '@/components/ui';
import { useAuth, useServerPagination, useAbortOnUnmount, usePagedFilters, FilterSpec } from '@/hooks';
import { useToast } from '@/context/ToastContext';
import { usePrompt } from '@/context/ConfirmContext';
import { useConfirm } from '@/context/ConfirmContext';
import { Plus, Download, Camera, Trash2, Clock, ArrowRightLeft, Inbox, QrCode, Wrench, FileText, Video, TrendingDown, Percent, Ban } from 'lucide-react';
import { AssetDetailsModal, AssetPhotosModal } from '../components/AssetDetailsModal';
import { AssetHistoryModal } from '../components/AssetHistoryModal';
import { AssetDepreciationModal } from '../components/AssetDepreciationModal';
import { AssetTransferModal } from '../components/AssetTransferModal';
import { AssetApprovalsModal } from '../components/AssetApprovalsModal';
import { AssetIntakeModal } from '../components/AssetIntakeModal';
import { DepreciationDefaultsModal } from '../components/DepreciationDefaultsModal';
import { DisposeAssetModal } from '../components/DisposeAssetModal';
import { depreciationApi } from '../services/depreciation.api';
import { fmtINR } from '@/utils/number';
import { AssetQrModal } from '../components/AssetQrModal';
import { AssetFilters } from '../components/AssetFilters';
import { UserRole } from '@/types';

const DEFAULT_CATEGORIES = [
  { value: 'MACHINERIES', label: 'Machineries' },
  { value: 'RND_EQUIPMENT', label: 'R&D Equipment' },
  { value: 'FURNITURE_FIXTURES', label: 'Furniture & Fixtures' },
  { value: 'COMPUTERS_IT', label: 'Computers & IT Assets' },
  { value: 'TOOLS_SMALL_INSTRUMENTS', label: 'Tools (Small Instruments)' },
  { value: 'SAFETY_EQUIPMENT', label: 'Safety Equipment' },
  { value: 'INVENTORY_COMPONENTS', label: 'Inventory Components' },
];

const DEFAULT_LOCATIONS = [
  'R&D Lab', 'Web Development Lab', 'Design Lab', 'Inventory Room', 'Server Room', 'Conference Room', 'Reception',
];

const CONDITIONS = [
  { value: 'WORKING', label: 'Working' },
  { value: 'NEEDS_REPAIR', label: 'Needs Repair' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'DISPOSED', label: 'Disposed' },
];

export const FixedAssetsPage = () => {


  const abortSignal = useAbortOnUnmount();
  const { user } = useAuth();
  // ASSOCIATE_FINANCE is the proposal-only role — they can add / edit
  // assets BUT every change goes through the approval queue, where
  // FINANCE (the finance head) signs off. Everyone else (SUPER_ADMIN /
  // ADMIN / INVENTORY / FINANCE) writes directly.
  //
  //   - canEditDirectly: writes hit /fixed-assets/* directly (no queue)
  //   - canPropose:      writes go through /fixed-assets/approvals
  //
  // Add/Edit BUTTONS show whenever either is true. The Save click decides
  // which endpoint to hit.
  const canEditDirectly = user?.role !== UserRole.ASSOCIATE_FINANCE;
  const canPropose = user?.role === UserRole.ASSOCIATE_FINANCE;
  // Same role set as FinanceDashboardPage's canManageDepreciation, so the
  // switch appears in both places for the same people. The PUT is role-gated
  // server-side regardless.
  const canManageDepreciation =
    user?.role === UserRole.FINANCE ||
    user?.role === UserRole.SUPER_ADMIN ||
    user?.role === UserRole.ASSOCIATE_FINANCE;
  // Writing rates, posting and opening balances is Finance / Super Admin only
  // on the server; Associate Finance can view and flip the on/off switch.
  // Inventory sees the register but no depreciation screens at all (their
  // reads are Finance-side), so those buttons follow canManageDepreciation.
  const canWriteDepreciation = user?.role === UserRole.FINANCE || user?.role === UserRole.SUPER_ADMIN;

  const [companies, setCompanies] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [catFilter, setCatFilter] = useState('');
  const [condFilter, setCondFilter] = useState('');
  const [locFilter, setLocFilter] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingAsset, setEditingAsset] = useState<any>(null);
  // The purchase value and net book value of an EXISTING asset are Finance's
  // to change — the server refuses anyone else. Associate Finance is included
  // because their edits are proposals that Finance approves.
  const canEditAssetMoney =
    user?.role === UserRole.FINANCE ||
    user?.role === UserRole.SUPER_ADMIN ||
    user?.role === UserRole.ASSOCIATE_FINANCE;
  // Once depreciation is posted the cost is frozen server-side (the posted
  // periods were computed from it). Look it up when an edit opens so the field
  // is locked up front instead of failing on save. A failed lookup leaves it
  // open; the server's refusal still explains itself.
  const [purchaseValueLocked, setPurchaseValueLocked] = useState(false);
  useEffect(() => {
    setPurchaseValueLocked(false);
    if (!editingAsset?.id || !canEditAssetMoney) return;
    let stale = false;
    depreciationApi.getEntries(editingAsset.id)
      .then((rows: unknown) => { if (!stale) setPurchaseValueLocked(Array.isArray(rows) && rows.length > 0); })
      .catch(() => {});
    return () => { stale = true; };
  }, [editingAsset?.id, canEditAssetMoney]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPhotos, setShowPhotos] = useState<any>(null);
  const [showHistory, setShowHistory] = useState<any>(null);
  // Depreciation timeline — opens a per-asset modal showing every posted
  // entry + next-period preview. Separate from history modal because the
  // depreciation log is a different audit trail than the change events.
  const [showDepreciation, setShowDepreciation] = useState<any>(null);
  const [showTransfer, setShowTransfer] = useState<any>(null);
  const [showApprovals, setShowApprovals] = useState(false);
  const [showIntakes, setShowIntakes] = useState(false);
  const [showDeprDefaults, setShowDeprDefaults] = useState(false);
  const [disposeAsset, setDisposeAsset] = useState<any>(null);
  // Pending asset-intake count — drives the "Receive from inventory (N)" badge.
  const [intakeCount, setIntakeCount] = useState(0);
  const [showQr, setShowQr] = useState<any>(null);

  const [customCategories, setCustomCategories] = useState(DEFAULT_CATEGORIES);
  // Degraded-mode fallback only: the Location picker reads the live
  // AssetLocation list (assetLocations); this hardcoded list is used purely
  // when that fetch fails so the picker isn't empty. Not user-mutable.
  const customLocations = DEFAULT_LOCATIONS;
  const [newCatLabel, setNewCatLabel] = useState('');
  const [newLocation, setNewLocation] = useState('');

  // Initial form state — full shape (operational + maintenance + finance)
  // so the modal's controlled inputs never see `undefined`. Finance defaults
  // mirror the schema defaults so a quick "Add Asset" stays a 2-click flow.
  const emptyForm = {
    name: '', description: '', category: 'MACHINERIES', departmentId: '',
    locationId: '', location: '', custodianId: '', custodianLabel: '', condition: 'WORKING', remarks: '',
    warrantyExpiresAt: '', nextMaintenanceDueAt: '', maintenanceIntervalDays: '' as any,
    assetType: 'TANGIBLE' as 'TANGIBLE' | 'INTANGIBLE',
    companyId: '',
    ownership: 'OWNED' as 'OWNED' | 'SHARED',
    purchaseValue: '' as number | '',
    currentValue: '' as number | '',
    purchaseDate: '',
    // Depreciation — all blank means "inherit from CategoryDepreciationDefault
    // at submit". Per-asset overrides set when Finance opens the disclosure.
    usefulLifeMonths: '' as number | '',
    salvageValue: '' as number | '',
    depreciationMethod: '' as ('STRAIGHT_LINE' | 'DECLINING_BALANCE' | 'DOUBLE_DECLINING' | 'WRITTEN_DOWN_VALUE' | 'NONE' | ''),
    depreciationStartDate: '',
    customValues: {} as Record<string, string>,
  };
  const [form, setForm] = useState(emptyForm);
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [videoFiles, setVideoFiles] = useState<File[]>([]);

  // Asset locations master list — drives the redesigned Location picker
  // (grouped by department + standalone). Fetched alongside companies /
  // departments. When empty, the modal falls back to the legacy
  // customLocations string list.
  const [assetLocations, setAssetLocations] = useState<any[]>([]);
  // Tracks an in-progress draft so saves go to PATCH /approvals/:id
  // instead of creating a duplicate row each click.
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);

  // Proposer's draft count — drives the "My Drafts (N)" badge in the
  // header so they can find unfinished proposals without spelunking
  // through the Approvals modal. Refetched on page mount + after any
  // save/submit so the badge always matches reality.
  const [myDraftCount, setMyDraftCount] = useState(0);
  // Which tab the approvals modal opens to. 'DRAFT' when invoked from
  // the My Drafts button; 'PENDING' when invoked from the Approvals
  // button (reviewer's lens).
  const [approvalsInitialFilter, setApprovalsInitialFilter] = useState<'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>('PENDING');

  // Deep-link from a FIXED_ASSET_APPROVAL notification: ?openApprovals auto-opens
  // the reviewer queue (PENDING) so FINANCE lands straight on the review action.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('openApprovals')) {
      setApprovalsInitialFilter('PENDING');
      setShowApprovals(true);
      const next = new URLSearchParams(searchParams);
      next.delete('openApprovals');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const refreshDraftCount = async () => {
    try {
      const res = await client.get('/fixed-assets/approvals?status=DRAFT', { signal: abortSignal() });
      const rows = res.data?.data ?? res.data ?? [];
      setMyDraftCount(Array.isArray(rows) ? rows.length : 0);
    } catch {
      // Best-effort — a failed count fetch shouldn't block the page.
      setMyDraftCount(0);
    }
  };

  const refreshIntakeCount = async () => {
    try {
      const res = await client.get('/asset-intakes/count', { signal: abortSignal() });
      const n = res.data?.data ?? res.data ?? 0;
      setIntakeCount(typeof n === 'number' ? n : Number(n) || 0);
    } catch {
      setIntakeCount(0);
    }
  };

  const { addToast } = useToast();

  const prompt = usePrompt();
  const confirm = useConfirm();

  // The asset table. Category / condition / location filters and the
  // (debounced) search are sent to the backend; every matching asset is then
  // loaded (loadAll — an asset register runs to hundreds, not tens of
  // thousands, and the cap note says so if it ever doesn't) so the per-column
  // filters search the whole register and the result is paged 10 at a time
  // in the browser. Reference data (departments / companies / users / locations) is still
  // loaded by fetchData below. Keeping the `search`/`setSearch` names so the
  // existing AssetFilters wiring works unchanged.
  const assetsPager = useServerPagination<any>({ urlKey: 'page', loadAll: true,
    endpoint: '/fixed-assets',
    params: { category: catFilter || undefined, condition: condFilter || undefined, locationId: locFilter || undefined },
  });
  const {
    items: assetItems, total: assetTotal, truncated: assetsTruncated, serverTotal: assetServerTotal,
    search, setSearch, isLoading: assetsLoading, refetch: refetchAssets,
  } = assetsPager;

  const fetchData = async () => {
    try {
      // Asset rows come from the paginated hook (refetchAssets); here we only
      // load the shared slow-changing reference data → TTL cache to dedup across
      // mounts. Companies don't change often so the cache is safe.
      const [deptRes, companyRes, locRes] = await Promise.all([
        cachedGet<any>('/departments'),
        cachedGet<any>('/companies').catch(() => null),
        client.get('/asset-locations', { signal: abortSignal() }).catch(() => null),
      ]);
      // No refetchAssets() here. useServerPagination already fetches on mount,
      // so calling it from this mount effect pulled the whole asset list a
      // second time on every visit — two identical GET /fixed-assets, measured
      // on both the inventory and finance copies of this page. The reference
      // data below is what this function is actually for.
      setDepartments(deptRes?.data || deptRes || []);
      // Companies returns array directly; tolerate either shape.
      setCompanies(Array.isArray(companyRes) ? companyRes : (companyRes?.data || companyRes?.items || []));
      // Asset locations from the new master table. Falls back to empty
      // array so the modal can still render with the legacy string list.
      const lr = locRes?.data?.data ?? locRes?.data ?? [];
      setAssetLocations(Array.isArray(lr) ? lr : []);
      // Draft-count badge only renders for proposers (ASSOCIATE_FINANCE), so
      // only they need the fetch — skip the wasted round-trip for everyone else.
      if (canPropose) refreshDraftCount();
      // Pending asset-intake count for the "Receive from inventory" badge.
      refreshIntakeCount();
      // Fetch custom field definitions so the asset modal can render
      // per-category dynamic inputs. Cached client-side; refreshed when
      // the settings modal saves new definitions.
      try {
        const cfRes = await client.get('/fixed-assets/custom-fields', { signal: abortSignal() });
        const cf = cfRes.data?.data ?? cfRes.data ?? [];
        setCustomFields(Array.isArray(cf) ? cf : []);
      } catch {
        // Non-fatal — modal just won't render the Specifications block.
      }
      try {
        // Use /users/directory — same-shape user list, but the role gate
        // is open to every authenticated role (Associate Finance + USER
        // hit 403 on the locked /users endpoint). The directory endpoint
        // is what RequestForm / IndentForm / CreateBomListModal already
        // standardise on.
        const userRes = await cachedGet<any>('/users/directory');
        setUsers(userRes?.data || userRes || []);
      } catch {}
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to load assets'), 'error'); }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load of assets + users, runs once on mount
  useEffect(() => { fetchData(); }, []);

  const openAdd = () => {
    setEditingAsset(null);
    setEditingDraftId(null);
    setForm(emptyForm);
    setPhotoFiles([]);
    setVideoFiles([]);
    setShowModal(true);
  };

  // Date inputs need yyyy-mm-dd strings — DB returns ISO with time. Strip
  // to date-only so the controlled <input type=date> values render correctly.
  const isoToDateInput = (iso?: string | null) => (iso ? iso.slice(0, 10) : '');

  const openEdit = (asset: any) => {
    setEditingAsset(asset);
    setEditingDraftId(null);
    // Hydrate customValues from the asset's stored values. Backend returns
    // them as `customValues: [{ fieldId, value, field: { ... } }]` —
    // flatten to `{ [fieldId]: value }` for the form's controlled inputs.
    const flatCustom: Record<string, string> = {};
    if (Array.isArray(asset.customValues)) {
      for (const cv of asset.customValues) {
        if (cv?.fieldId) flatCustom[cv.fieldId] = cv.value ?? '';
      }
    }
    setForm({
      name: asset.name, description: asset.description || '', category: asset.category,
      departmentId: asset.departmentId, locationId: asset.locationId || '', location: asset.location || '',
      custodianId: asset.custodianId || '',
      custodianLabel: asset.custodianLabel || '',
      condition: asset.condition, remarks: asset.remarks || '',
      warrantyExpiresAt: isoToDateInput(asset.warrantyExpiresAt),
      nextMaintenanceDueAt: isoToDateInput(asset.nextMaintenanceDueAt),
      maintenanceIntervalDays: asset.maintenanceIntervalDays ?? ('' as any),
      // Finance fields fall back to schema defaults when the existing row
      // hasn't been migrated to carry them yet.
      assetType: (asset.assetType || 'TANGIBLE') as 'TANGIBLE' | 'INTANGIBLE',
      companyId: asset.companyId || '',
      ownership: (asset.ownership || 'OWNED') as 'OWNED' | 'SHARED',
      purchaseValue: asset.purchaseValue != null ? Number(asset.purchaseValue) : ('' as number | ''),
      currentValue: asset.currentValue != null ? Number(asset.currentValue) : ('' as number | ''),
      purchaseDate: isoToDateInput(asset.purchaseDate),
      // Depreciation overrides — leave blank if the asset is inheriting from
      // the category default (Finance can opt-in to per-asset overrides by
      // opening the disclosure + filling these in).
      usefulLifeMonths: asset.usefulLifeMonths != null ? Number(asset.usefulLifeMonths) : ('' as number | ''),
      salvageValue: asset.salvageValue != null ? Number(asset.salvageValue) : ('' as number | ''),
      depreciationMethod: (asset.depreciationMethod || '') as any,
      depreciationStartDate: isoToDateInput(asset.depreciationStartDate),
      customValues: flatCustom,
    });
    setPhotoFiles([]);
    setVideoFiles([]);
    setShowModal(true);
  };

  // Open a previously saved DRAFT (e.g. from the My Drafts list) so the
  // proposer can resume editing. Carries the proposal id so Save resolves
  // to PATCH /approvals/:id instead of creating a duplicate row.
  const openDraft = (draft: any) => {
    const c = draft.proposedChanges || {};
    setEditingAsset(null);
    setEditingDraftId(draft.id);
    setForm({
      name: c.name || '', description: c.description || '', category: c.category || 'MACHINERIES',
      departmentId: c.departmentId || '', locationId: c.locationId || '', location: c.location || '',
      custodianId: c.custodianId || '',
      custodianLabel: c.custodianLabel || '',
      condition: c.condition || 'WORKING', remarks: c.remarks || '',
      warrantyExpiresAt: isoToDateInput(c.warrantyExpiresAt),
      nextMaintenanceDueAt: isoToDateInput(c.nextMaintenanceDueAt),
      maintenanceIntervalDays: c.maintenanceIntervalDays ?? ('' as any),
      assetType: (c.assetType || 'TANGIBLE') as 'TANGIBLE' | 'INTANGIBLE',
      companyId: c.companyId || '',
      ownership: (c.ownership || 'OWNED') as 'OWNED' | 'SHARED',
      purchaseValue: c.purchaseValue != null ? Number(c.purchaseValue) : ('' as number | ''),
      currentValue: c.currentValue != null ? Number(c.currentValue) : ('' as number | ''),
      purchaseDate: isoToDateInput(c.purchaseDate),
      usefulLifeMonths: c.usefulLifeMonths != null ? Number(c.usefulLifeMonths) : ('' as number | ''),
      salvageValue: c.salvageValue != null ? Number(c.salvageValue) : ('' as number | ''),
      depreciationMethod: (c.depreciationMethod || '') as any,
      depreciationStartDate: isoToDateInput(c.depreciationStartDate),
      // Drafts store customValues as a flat map already (matches the form
      // shape exactly). Fall back to {} on legacy drafts.
      customValues: (c.customValues && typeof c.customValues === 'object' && !Array.isArray(c.customValues))
        ? c.customValues
        : {},
    });
    setPhotoFiles([]);
    setVideoFiles([]);
    setShowModal(true);
  };

  const handleLogMaintenance = async (asset: any) => {
    const notes = await prompt({
      title: 'Log maintenance',
      message: `${asset.assetTag} — ${asset.name}`,
      label: 'Notes (optional)',
      placeholder: 'e.g. Fan replaced, cleaned filters',
      multiline: true,
      confirmLabel: 'Log it',
    });
    if (notes === null) return; // user cancelled
    try {
      await client.post(`/fixed-assets/${asset.id}/maintenance`, { notes: notes.trim() || undefined });
      addToast('Maintenance logged', 'success');
      fetchData();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to log maintenance'), 'error');
    }
  };

  // Upload one file via the multipart endpoint. Returns the new key so callers
  // can know what got stored (useful if we ever surface "you uploaded these"
  // confirmation toasts per-file).
  const uploadOnePhoto = async (assetId: string, file: File): Promise<string> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await client.post(`/fixed-assets/${assetId}/photos`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data?.data?.key || res.data?.key;
  };

  // Shared payload builder — same for save + draft + submit paths so a
  // missing field in one path doesn't silently differ from another.
  const buildPayload = () => {
    const { name, description, category, departmentId, locationId, location, custodianId, custodianLabel, condition, remarks } = form;
    const payload: any = {
      name, description, category, departmentId,
      // Send the FK when a managed lab is picked; always send the name too
      // as the fallback for ad-hoc labels (backend prefers locationId).
      locationId: locationId || undefined,
      location,
      custodianId: custodianId || (editingAsset ? null : undefined),
      custodianLabel: custodianLabel?.trim() || (editingAsset ? null : undefined),
      condition, remarks,
      assetType: form.assetType,
      ownership: form.ownership,
    };
    // On an edit, a box the user emptied is sent as null so the server clears
    // it. Omitting it (all the create path needs) kept the old value while the
    // toast said "saved".
    const clearOnEdit = (key: string) => { if (editingAsset) payload[key] = null; };
    if (form.companyId) payload.companyId = form.companyId; else clearOnEdit('companyId');
    if (form.purchaseValue !== '') payload.purchaseValue = form.purchaseValue; else clearOnEdit('purchaseValue');
    if (form.currentValue !== '') payload.currentValue = form.currentValue; else clearOnEdit('currentValue');
    if (form.purchaseDate) payload.purchaseDate = form.purchaseDate; else clearOnEdit('purchaseDate');
    // Depreciation overrides — only send when explicitly set. Backend
    // auto-fills from CategoryDepreciationDefault when these are absent.
    if (form.usefulLifeMonths !== '') payload.usefulLifeMonths = form.usefulLifeMonths;
    if (form.salvageValue !== '') payload.salvageValue = form.salvageValue;
    if (form.depreciationMethod) payload.depreciationMethod = form.depreciationMethod;
    if (form.depreciationStartDate) payload.depreciationStartDate = form.depreciationStartDate;
    if (form.warrantyExpiresAt) payload.warrantyExpiresAt = form.warrantyExpiresAt; else clearOnEdit('warrantyExpiresAt');
    if (form.nextMaintenanceDueAt) payload.nextMaintenanceDueAt = form.nextMaintenanceDueAt; else clearOnEdit('nextMaintenanceDueAt');
    if (form.maintenanceIntervalDays !== '' && form.maintenanceIntervalDays !== null) payload.maintenanceIntervalDays = form.maintenanceIntervalDays; else clearOnEdit('maintenanceIntervalDays');
    // Custom field values — only include keys whose definition exists +
    // belongs to the asset's active category. Stale keys (e.g. from a
    // category switch mid-edit) are silently dropped so they don't
    // pollute the backend's value table.
    const activeCategoryFieldIds = new Set(
      customFields.filter(f => f.category === form.category).map(f => f.id),
    );
    const cleanedValues: Record<string, string> = {};
    for (const [fid, v] of Object.entries(form.customValues || {})) {
      if (activeCategoryFieldIds.has(fid) && v !== '' && v != null) {
        cleanedValues[fid] = String(v);
      }
    }
    if (Object.keys(cleanedValues).length > 0) payload.customValues = cleanedValues;
    return payload;
  };

  // Upload a video file via the multipart endpoint. Mirrors uploadOnePhoto.
  const uploadOneVideo = async (assetId: string, file: File): Promise<string> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await client.post(`/fixed-assets/${assetId}/videos`, fd, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    return res.data?.data?.key || res.data?.key;
  };

  // Save DRAFT (proposal mode only). Persists partial info under
  // status=DRAFT so the proposer can come back and finish later. Editing
  // an existing draft routes to PATCH instead of POST.
  const handleSaveDraft = async () => {
    if (!form.name?.trim()) { addToast('Give the draft a name first so you can find it again.', 'error'); return; }
    setIsSubmitting(true);
    try {
      const payload = buildPayload();
      if (editingDraftId) {
        await client.patch(`/fixed-assets/approvals/${editingDraftId}`, { proposedChanges: payload });
      } else {
        const res = await client.post('/fixed-assets/approvals', {
          proposalType: editingAsset ? 'UPDATE' : 'CREATE',
          fixedAssetId: editingAsset?.id,
          proposedChanges: payload,
          status: 'DRAFT',
        });
        // Capture the new draft id so subsequent saves PATCH instead.
        const newId = res.data?.data?.id || res.data?.id;
        if (newId) setEditingDraftId(newId);
      }
      addToast('Draft saved — pick it back up via the "My Drafts" button above.', 'success');
      if (photoFiles.length > 0 || videoFiles.length > 0) {
        addToast('Photos/videos can be uploaded after the proposal is approved.', 'info');
      }
      setShowModal(false);
      fetchData();
      refreshDraftCount();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to save draft'), 'error');
    }
    setIsSubmitting(false);
  };

  const handleSave = async () => {
    // Name the field that is actually missing, and check the same set the
    // server does (FixedAssetsService.CREATE_REQUIRED): name, category and
    // department, which the asset cannot exist without. Everything else —
    // location, purchase value and date included — is optional and can be
    // filled in later. On an edit only a name and department are checked, so
    // changing a custodian no longer needs an invented purchase date.
    const missing = [
      !form.name?.toString().trim() && 'name',
      !form.category && 'category',
      !form.departmentId && 'department',
    ].filter(Boolean) as string[];
    if (missing.length) {
      addToast(
        missing.length === 1
          ? `${missing[0][0].toUpperCase()}${missing[0].slice(1)} is required.`
          : `Still needed: ${missing.join(', ')}.`,
        'error',
      );
      return;
    }
    setIsSubmitting(true);
    try {
      const payload = buildPayload();

      // ASSOCIATE_FINANCE goes through the approval queue. Their click
      // creates a PENDING proposal that the finance head reviews. No
      // asset / no photos upload until Finance approves it. If they were
      // editing a DRAFT, we submit it (DRAFT→PENDING); otherwise we POST
      // a new PENDING proposal directly.
      if (canPropose && !canEditDirectly) {
        if (editingDraftId) {
          // Save latest payload to the draft first, then transition to PENDING.
          await client.patch(`/fixed-assets/approvals/${editingDraftId}`, { proposedChanges: payload });
          await client.post(`/fixed-assets/approvals/${editingDraftId}/submit`, {});
        } else {
          await client.post('/fixed-assets/approvals', {
            proposalType: editingAsset ? 'UPDATE' : 'CREATE',
            fixedAssetId: editingAsset?.id,
            proposedChanges: payload,
          });
        }
        addToast(
          editingAsset
            ? 'Update proposal sent to Finance for approval.'
            : 'New-asset proposal sent to Finance for approval.',
          'success',
        );
        if (photoFiles.length > 0 || videoFiles.length > 0) {
          // Associate Finance cannot upload media (the asset's file routes are
          // Finance/Inventory/Admin), so promising "upload after approval" sent
          // them to a 403. Say who can.
          addToast('Photos and videos are not sent with a proposal — ask Finance to add them once it is approved.', 'info');
        }
        setShowModal(false);
        fetchData();
        setIsSubmitting(false);
        return;
      }

      // Direct-write path for SUPER_ADMIN / ADMIN / INVENTORY / FINANCE.
      let assetId: string;
      if (editingAsset) {
        await client.patch(`/fixed-assets/${editingAsset.id}`, payload);
        assetId = editingAsset.id;
      } else {
        const res = await client.post('/fixed-assets', payload);
        assetId = res.data?.data?.id || res.data?.id;
        if (!assetId) throw new Error('Asset created but no id returned');
      }

      // Step 2: upload each newly-picked photo to the asset. Sequential so
      // upload failures don't get masked by parallel-failure noise. Partial
      // failures are surfaced as a per-file warning toast and we DO NOT
      // rollback the asset save — the asset exists, just without some photos.
      const uploadStaged = async (
        files: File[],
        uploader: (id: string, f: File) => Promise<string>,
        label: string,
      ): Promise<{ uploaded: number; failures: string[] }> => {
        let uploaded = 0;
        const failures: string[] = [];
        for (const file of files) {
          try { await uploader(assetId, file); uploaded++; }
          catch (e: any) { failures.push(`${file.name}: ${extractErrorMessage(e, `${label} upload failed`)}`); }
        }
        return { uploaded, failures };
      };

      const photoResult = photoFiles.length > 0 ? await uploadStaged(photoFiles, uploadOnePhoto, 'photo') : { uploaded: 0, failures: [] };
      const videoResult = videoFiles.length > 0 ? await uploadStaged(videoFiles, uploadOneVideo, 'video') : { uploaded: 0, failures: [] };

      const totalFailures = [...photoResult.failures, ...videoResult.failures];
      const mediaBits: string[] = [];
      if (photoResult.uploaded > 0) mediaBits.push(`${photoResult.uploaded} photo(s)`);
      if (videoResult.uploaded > 0) mediaBits.push(`${videoResult.uploaded} video(s)`);

      if (totalFailures.length === 0) {
        const msg = mediaBits.length > 0
          ? `${editingAsset ? 'Asset updated' : 'Asset created'} — ${mediaBits.join(' + ')} uploaded`
          : (editingAsset ? 'Asset updated' : 'Asset created');
        addToast(msg, 'success');
      } else if (mediaBits.length > 0) {
        addToast(`Asset saved — ${mediaBits.join(' + ')} uploaded, but ${totalFailures.length} file(s) failed: ${totalFailures[0]}`, 'info');
      } else {
        addToast(`Asset saved, but media uploads failed: ${totalFailures[0]}`, 'error');
      }

      setShowModal(false);
      fetchData();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to save'), 'error'); }
    setIsSubmitting(false);
  };

  // Delete by storage key (not by array index). The gallery modal passes the
  // key it got from GET /:id/photos — the parent doesn't need to know what
  // index it lives at, which makes concurrent uploads + deletions race-safe.
  const handleRemovePhoto = async (asset: any, key: string) => {
    try {
      await client.delete(`/fixed-assets/${asset.id}/photos?key=${encodeURIComponent(key)}`);
      addToast('Photo removed', 'success');
      fetchData();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to remove photo'), 'error'); }
  };

  // Same key-based pattern as photos — race-safe delete.
  const handleRemoveVideo = async (asset: any, key: string) => {
    try {
      await client.delete(`/fixed-assets/${asset.id}/videos?key=${encodeURIComponent(key)}`);
      addToast('Video removed', 'success');
      fetchData();
    } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to remove video'), 'error'); }
  };

  // ----- AssetLocation management (SettingsModal) -----
  // The settings modal lets SUPER_ADMIN / FINANCE edit the master
  // locations list — rename a typo'd entry, toggle off a defunct lab,
  // or delete unused rows. Backend gates writes via @Roles; the buttons
  // still render for other roles but will return 403 on click (handled
  // via toast). Role-aware hiding is optional polish — see canManageLocations below.
  const canManageLocations = user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.FINANCE;

  const renameAssetLocation = async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) { addToast('Name cannot be empty', 'error'); return; }
    try {
      const res = await client.patch(`/asset-locations/${id}`, { name: trimmed });
      const updated = res.data?.data ?? res.data;
      setAssetLocations(prev => prev.map(l => l.id === id ? updated : l));
      // Backend propagates the rename to every asset's denormalized name;
      // refetch the current page so the asset table reflects it.
      refetchAssets();
      addToast('Location renamed', 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not rename'), 'error');
    }
  };

  const toggleAssetLocationActive = async (id: string, isActive: boolean) => {
    try {
      const res = await client.patch(`/asset-locations/${id}`, { isActive });
      const updated = res.data?.data ?? res.data;
      setAssetLocations(prev => prev.map(l => l.id === id ? updated : l));
      addToast(isActive ? 'Location re-enabled' : 'Location hidden from picker', 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not toggle'), 'error');
    }
  };

  const deleteAssetLocation = async (id: string, name: string) => {
    if (!await confirm(`Delete "${name}"? This is blocked if any asset is still assigned here — reassign or hide it instead.`)) return;
    try {
      await client.delete(`/asset-locations/${id}`);
      setAssetLocations(prev => prev.filter(l => l.id !== id));
      addToast('Location deleted', 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not delete'), 'error');
    }
  };

  // ----- Custom field definitions (SettingsModal) -----
  // Per-category dynamic field definitions. Admins shape what extra
  // fields appear on the asset modal depending on the asset's category.
  // Backend gates writes to SUPER_ADMIN + ADMIN.
  const canManageCustomFields = user?.role === UserRole.SUPER_ADMIN || user?.role === UserRole.ADMIN;
  const [customFields, setCustomFields] = useState<any[]>([]);
  const [customFieldsCategory, setCustomFieldsCategory] = useState<string>('MACHINERIES');

  // Lazy-load definitions when the settings modal opens. We keep ALL
  // categories' fields in state at once (it's a small list — usually
  // <50 rows org-wide) and filter client-side, so the user can browse
  // between categories without a fetch per switch.
  useEffect(() => {
    if (!showSettings) return;
    client
      .get('/fixed-assets/custom-fields')
      .then(r => {
        const raw = r.data?.data ?? r.data ?? [];
        setCustomFields(Array.isArray(raw) ? raw : []);
      })
      .catch(() => setCustomFields([]));
  }, [showSettings]);

  const customFieldsForCategory = customFields.filter(f => f.category === customFieldsCategory);

  const addCustomField = async (payload: { name: string; fieldType: string; required: boolean; options?: string[] }) => {
    try {
      const res = await client.post('/fixed-assets/custom-fields', {
        category: customFieldsCategory,
        ...payload,
      });
      const row = res.data?.data ?? res.data;
      setCustomFields(prev => [...prev, row]);
      addToast(`Added field "${payload.name}"`, 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not add field'), 'error');
    }
  };

  const deleteCustomField = async (id: string, name: string) => {
    if (!await confirm(`Delete custom field "${name}"? Existing values on assets will be removed too.`)) return;
    try {
      await client.delete(`/fixed-assets/custom-fields/${id}`);
      setCustomFields(prev => prev.filter(f => f.id !== id));
      addToast('Field deleted', 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not delete field'), 'error');
    }
  };

  const toggleCustomFieldRequired = async (id: string, required: boolean) => {
    try {
      const res = await client.patch(`/fixed-assets/custom-fields/${id}`, { required });
      const row = res.data?.data ?? res.data;
      setCustomFields(prev => prev.map(f => f.id === id ? row : f));
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not toggle'), 'error');
    }
  };

  const handleExport = async () => {
    // The export endpoint is behind JwtAuthGuard. A bare window.open() can't
    // attach the Authorization: Bearer header (the token lives in sessionStorage,
    // not a cookie) so it 401s. Fetch via the authenticated axios client as a
    // blob, then trigger a programmatic anchor download — same pattern as
    // ExportPanel + ViewReceiptLink.
    try {
      const res = await client.get('/fixed-assets/export', {
        params: {
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(catFilter ? { category: catFilter } : {}),
          ...(condFilter ? { condition: condFilter } : {}),
          ...(locFilter ? { locationId: locFilter } : {}),
        },
        responseType: 'blob',
      });
      const blob = new Blob([res.data], { type: String(res.headers['content-type'] || 'text/csv') });
      const url = URL.createObjectURL(blob);
      const cd = res.headers['content-disposition'] || '';
      const match = /filename="?([^";]+)"?/i.exec(cd);
      const filename = match?.[1] || `fixed-assets-${new Date().toISOString().split('T')[0]}.csv`;
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Export failed'), 'error');
    }
  };

  const addCategory = () => {
    if (!newCatLabel.trim()) return;
    const val = newCatLabel.trim().toUpperCase().replace(/\s+/g, '_');
    if (customCategories.find(c => c.value === val)) { addToast('Already exists', 'error'); return; }
    setCustomCategories([...customCategories, { value: val, label: newCatLabel.trim() }]);
    setNewCatLabel('');
  };

  const getCatLabel = (val: string) => customCategories.find(c => c.value === val)?.label || val?.replace(/_/g, ' ');
  const hasFilters = !!(search || catFilter || condFilter || locFilter);

  // Currency formatter — INR by default. We don't store a per-asset
  // currency yet so always rupees. Compact (e.g. "₹1.25 L") so the
  // value column doesn't blow out the table on big numbers.
  const fmtMoney = (v: any) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n);
  };

  // A filter on every data column (owner, 27 Oct). Category / Location /
  // Condition stay server-side above; these run over every loaded asset,
  // valued as each cell reads.
  const pageSpecs = useMemo<FilterSpec<any>[]>(() => [
    { key: 'tag', getValue: (r) => r.assetTag || '' },
    { key: 'name', getValue: (r) => r.name || '' },
    { key: 'company', getValue: (r) => r.company?.name ? `${r.company.name}${r.company.isOwn ? '' : ' (partner)'}` : '—' },
    { key: 'value', getValue: (r) => fmtMoney(r.currentValue) ?? fmtMoney(r.purchaseValue) ?? '—' },
    { key: 'dept', getValue: (r) => r.department?.name || '-' },
    { key: 'custodian', getValue: (r) => r.custodian?.name || 'Unassigned' },
    { key: 'remarks', getValue: (r) => r.remarks || '-' },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fmtMoney is a pure formatter
  ], []);
  const pf = usePagedFilters(assetItems, pageSpecs, 10, search);
  const columnFiltered = Object.keys(pf.filters).length > 0;
  const filtered = (label: string, key: string) => ({
    filterActive: pf.isActive(key),
    header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={pf.getOptions(key)} value={pf.filters[key] || ''} onChange={(v) => pf.setFilter(key, v)} /></span>,
  });

  const columns = [
    { ...filtered('Asset Tag', 'tag'), accessor: (r: any) => <span className="font-mono font-bold text-ink text-xs">{r.assetTag}</span> },
    { ...filtered('Name', 'name'), accessor: (r: any) => (
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-ink">{r.name}</span>
          {/* Tiny type chip — Tangible vs Intangible. Intangibles get a
              different colour so they pop in a mostly-physical list. */}
          {r.assetType === 'INTANGIBLE' && (
            <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-violet-100 dark:bg-violet-400/20 text-violet-700 dark:text-violet-300">INTANGIBLE</span>
          )}
          {r.ownership === 'SHARED' && (
            <span className="text-[9px] font-bold px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-400/20 text-amber-700 dark:text-amber-300">SHARED</span>
          )}
          {/* Purchase value and date are optional, but depreciation needs both
              (a depreciation start date stands in for the purchase date). Flag
              the rows that are missing them so they can be found and filled. */}
          {(r.purchaseValue == null || (!r.purchaseDate && !r.depreciationStartDate)) && (
            <span
              className="text-[9px] font-bold px-1 py-0.5 rounded bg-orange-100 dark:bg-orange-400/20 text-orange-700 dark:text-orange-300 whitespace-nowrap"
              title="Not depreciated until a purchase value and purchase date are filled in."
            >
              NEEDS VALUE/DATE
            </span>
          )}
        </div>
        {r.description && <p className="text-[10px] text-faint truncate max-w-[150px]">{r.description}</p>}
      </div>
    )},
    { filterActive: !!catFilter, header: <span className="inline-flex items-center">Category<ColumnFilter options={customCategories} value={catFilter} onChange={setCatFilter} /></span>,
      accessor: (r: any) => <span className="text-xs text-muted">{getCatLabel(r.category)}</span> },
    { ...filtered('Company', 'company'), accessor: (r: any) => r.company?.name
        ? <span className="text-xs text-ink">{r.company.name}{!r.company.isOwn && <span className="ml-1 text-[9px] text-amber-700 dark:text-amber-300">(partner)</span>}</span>
        : <span className="text-[10px] text-faint italic">—</span> },
    { ...filtered('Value', 'value'), accessor: (r: any) => {
        const cur = fmtMoney(r.currentValue);
        const pur = fmtMoney(r.purchaseValue);
        if (!cur && !pur) return <span className="text-[10px] text-faint italic">—</span>;
        return (
          <div className="text-right">
            {cur && <p className="text-xs font-bold text-ink">{cur}</p>}
            {pur && cur !== pur && <p className="text-[9px] text-faint">was {pur}</p>}
            {pur && !cur && <p className="text-xs text-muted">{pur}</p>}
          </div>
        );
      } },
    { ...filtered('Dept', 'dept'), accessor: (r: any) => <span className="text-xs text-muted">{r.department?.name || '-'}</span> },
    { filterActive: !!locFilter, header: <span className="inline-flex items-center">Location<ColumnFilter searchable options={assetLocations.map(l => ({ value: l.id, label: l.name }))} value={locFilter} onChange={setLocFilter} /></span>,
      accessor: (r: any) => <span className="text-xs text-ink">{r.locationRef?.name ?? r.location ?? '-'}</span> },
    { ...filtered('Custodian', 'custodian'), accessor: (r: any) => (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">{r.custodian?.name || 'Unassigned'}</span>
        {/* Transfer is a direct write (Admin / Inventory / Finance); Associate
            Finance changes custodians through a proposal instead. */}
        {canEditDirectly && <button
          onClick={() => setShowTransfer(r)}
          className="text-[10px] text-brand font-bold hover:underline flex items-center gap-0.5"
          title="Transfer custodian"
        >
          <ArrowRightLeft size={10} /> Transfer
        </button>}
      </div>
    )},
    { filterActive: !!condFilter, header: <span className="inline-flex items-center">Condition<ColumnFilter options={CONDITIONS} value={condFilter} onChange={setCondFilter} /></span>,
      accessor: (r: any) => {
        // Step 10: surface maintenance signals next to the condition badge.
        // Two cues:
        //   - red dot: nextMaintenanceDueAt is past or within 7 days
        //   - orange dot: warrantyExpiresAt is within 30 days
        // Both are subtle (small badges) so they don't compete with the
        // primary condition pill, but visible enough to triage at a glance.
        const now = Date.now();
        const dueAt = r.nextMaintenanceDueAt ? new Date(r.nextMaintenanceDueAt).getTime() : null;
        const warrAt = r.warrantyExpiresAt ? new Date(r.warrantyExpiresAt).getTime() : null;
        const overdueSoon = dueAt != null && dueAt - now <= 7 * 86400000;
        const warrantySoon = warrAt != null && warrAt - now <= 30 * 86400000 && warrAt - now > 0;
        const warrantyExpired = warrAt != null && warrAt - now <= 0;
        return (
          <div className="flex items-center gap-1.5">
            <StatusBadge status={r.condition} />
            {overdueSoon && (
              <span title={dueAt! < now ? 'Maintenance overdue' : 'Maintenance due within 7 days'}
                className="inline-block w-1.5 h-1.5 rounded-full bg-red-500" />
            )}
            {(warrantySoon || warrantyExpired) && (
              <span title={warrantyExpired ? 'Warranty expired' : 'Warranty expires within 30 days'}
                className={`inline-block w-1.5 h-1.5 rounded-full ${warrantyExpired ? 'bg-rose-700' : 'bg-amber-500'}`} />
            )}
          </div>
        );
      } },
    { header: 'Media', accessor: (r: any) => {
      const photoN = r.pictures?.length || 0;
      const videoN = r.videos?.length || 0;
      return (
        <button onClick={() => setShowPhotos(r)} className="text-xs text-muted flex items-center gap-2 hover:text-brand" title={`${photoN} photo(s), ${videoN} video(s)`}>
          <span className="inline-flex items-center gap-1"><Camera size={12} /> {photoN}</span>
          {videoN > 0 && <span className="inline-flex items-center gap-1 text-brand"><Video size={12} /> {videoN}</span>}
        </button>
      );
    }},
    { ...filtered('Remarks', 'remarks'), accessor: (r: any) => <span className="text-xs text-faint truncate max-w-[120px] block" title={r.remarks || ''}>{r.remarks || '-'}</span> },
    { header: '', accessor: (r: any) => (
      <div className="flex items-center gap-2 whitespace-nowrap">
        <button onClick={() => openEdit(r)} className="text-xs text-brand font-bold hover:underline">
          {canPropose && !canEditDirectly ? 'Propose edit' : 'Edit'}
        </button>
        <button onClick={() => setShowHistory(r)} className="text-xs text-muted font-bold hover:text-ink flex items-center gap-1" title="View history">
          <Clock size={11} /> History
        </button>
        {/* Depreciation timeline — only meaningful for assets configured to
            depreciate. Method = NONE hides the button to avoid noise. */}
        {canManageDepreciation && r.depreciationMethod && r.depreciationMethod !== 'NONE' && r.purchaseValue != null && (
          <button onClick={() => setShowDepreciation(r)} className="text-xs text-amber-700 dark:text-amber-300 font-bold hover:text-amber-900 dark:text-amber-200 flex items-center gap-1" title="Depreciation timeline">
            <TrendingDown size={11} /> Depreciation
          </button>
        )}
        <button onClick={() => setShowQr(r)} className="text-xs text-muted font-bold hover:text-ink flex items-center gap-1" title="Show QR code">
          <QrCode size={11} /> QR
        </button>
        {/* Maintenance logging is direct-write only — Associate Finance
            can't approve their own log entries. The Service button shows
            for direct-write roles; finance approval covers create/update
            but not the maintenance log (out of scope for v1). */}
        {canEditDirectly && r.maintenanceIntervalDays && (
          <button onClick={() => handleLogMaintenance(r)} className="text-xs text-emerald-700 dark:text-emerald-300 font-bold hover:text-emerald-900 dark:text-emerald-200 flex items-center gap-1" title="Log maintenance done">
            <Wrench size={11} /> Service
          </button>
        )}
        {/* Dispose — sold, scrapped or written off. Hidden once disposed, and
            direct-write only: it stops depreciation and books a gain/loss, so
            it isn't something to route through the propose-edit queue. */}
        {canEditDirectly && !r.disposedAt && (
          <button onClick={() => setDisposeAsset(r)} className="text-xs text-red-700 dark:text-red-300 font-bold hover:text-red-900 dark:text-red-200 flex items-center gap-1" title="Sold, scrapped or written off">
            <Ban size={11} /> Dispose
          </button>
        )}
        {r.disposedAt && (
          <span
            className="text-xs font-bold text-faint flex items-center gap-1"
            title={`Disposed ${new Date(r.disposedAt).toLocaleDateString()}` +
              (r.disposalGainLoss != null
                ? ` — ${Number(r.disposalGainLoss) >= 0 ? 'gain' : 'loss'} of ${fmtINR(Math.abs(Number(r.disposalGainLoss)), { nullish: '₹0' })}`
                : '')}
          >
            <Ban size={11} /> Disposed
          </span>
        )}
      </div>
    )},
  ];

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="bg-card p-4 md:p-6 rounded-lg shadow-sm border border-line-soft">
        <div className="flex flex-col space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Fixed Assets</h2>
              <p className="text-sm md:text-[15px] text-muted mt-1.5">{columnFiltered ? `${pf.filteredTotal} of ${assetTotal}` : assetTotal} assets tracked · Audit-ready</p>
            </div>
            <div className="flex gap-2 flex-wrap">
              {/* My Drafts — proposers only. Opens the approvals modal
                  pre-filtered to their drafts so they can resume editing.
                  Count badge appears when there's at least 1 unfinished
                  draft so they know to come back. */}
              {canPropose && (
                <button
                  onClick={() => { setApprovalsInitialFilter('DRAFT'); setShowApprovals(true); }}
                  className="relative flex items-center gap-2 px-3 py-2 border border-line text-muted font-bold rounded-md hover:border-brand hover:text-brand transition-colors text-sm"
                  title="Resume an asset proposal you saved as a draft"
                >
                  <FileText size={16} /> My Drafts
                  {myDraftCount > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 bg-brand text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 border border-card shadow-sm">
                      {myDraftCount}
                    </span>
                  )}
                </button>
              )}
              <button
                onClick={() => { setApprovalsInitialFilter('PENDING'); setShowApprovals(true); }}
                className="flex items-center gap-2 px-3 py-2 border border-line text-muted font-bold rounded-md hover:border-brand hover:text-brand transition-colors text-sm"
                title="Review proposed changes"
              >
                <Inbox size={16} /> Approvals
              </button>
              {/* Receive from inventory — the asset intake queue. Inventory
                  routes asset-tagged received goods here; AF registers them. */}
              <button
                onClick={() => setShowIntakes(true)}
                className="relative flex items-center gap-2 px-3 py-2 border border-violet-200 dark:border-violet-400/30 text-violet-700 dark:text-violet-300 font-bold rounded-md hover:bg-violet-50 dark:bg-violet-400/15 transition-colors text-sm"
                title="Register assets inventory routed to you"
              >
                <Inbox size={16} /> Receive from inventory
                {intakeCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 bg-violet-600 text-white text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 border border-card shadow-sm">
                    {intakeCount}
                  </span>
                )}
              </button>
              {/* Depreciation rates. These decide how every new asset
                  depreciates, and the shipped values are a legal default
                  somebody's accountant has to sign off — so they need to be
                  visible somewhere, not just editable by API. */}
              {canManageDepreciation && (
              <button
                onClick={() => setShowDeprDefaults(true)}
                className="flex items-center gap-2 px-3 py-2 border border-line text-muted font-bold rounded-md hover:border-brand hover:text-brand transition-colors text-sm"
                title="Useful life, salvage and method applied to each asset category"
              >
                <Percent size={16} /> Depreciation rates
              </button>
              )}
              <button onClick={handleExport} className="flex items-center gap-2 px-3 py-2 border border-line text-muted font-bold rounded-md hover:border-brand hover:text-brand transition-colors text-sm">
                <Download size={16} /> Export
              </button>
              {(canEditDirectly || canPropose) && (
                <button onClick={openAdd} className="flex items-center gap-2 px-4 py-2 bg-brand text-white font-bold rounded-full hover:bg-brand-dark transition-colors text-sm">
                  <Plus size={16} /> {canPropose && !canEditDirectly ? 'Propose Asset' : 'Add Asset'}
                </button>
              )}
            </div>
          </div>
          <AssetFilters
            search={search}
            onSearchChange={setSearch}
            hasFilters={hasFilters}
            onClearAll={() => { setSearch(''); setCatFilter(''); setCondFilter(''); setLocFilter(''); }}
            onOpenSettings={() => setShowSettings(true)}
          />
        </div>
      </div>

      <div className="bg-card rounded-lg shadow-sm border border-line-soft overflow-hidden">
        <DataTable
          columns={columns}
          data={pf.pageRows}
          isLoading={assetsLoading}
          keyExtractor={r => r.id}
          emptyStateMessage={hasFilters || columnFiltered ? 'No assets match these filters.' : 'No fixed assets tracked yet. Add your first asset.'}
          maxHeight="60vh"
        />
        <LoadAllCapNote truncated={assetsTruncated} shown={assetTotal} total={assetServerTotal} hint="search or filter by category, condition or location to see older ones." />
        <Pagination currentPage={pf.page} totalPages={pf.totalPages} onPageChange={pf.setPage} />
      </div>

      <AssetDetailsModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        editingAsset={editingAsset}
        form={form}
        onFormChange={setForm}
        photoFiles={photoFiles}
        onSetPhotoFiles={setPhotoFiles}
        videoFiles={videoFiles}
        onSetVideoFiles={setVideoFiles}
        departments={departments}
        users={users}
        companies={companies}
        customCategories={customCategories}
        customLocations={customLocations}
        assetLocations={assetLocations}
        // Creating a location is Finance / Super Admin on the server; others get
        // the picker without "+ Add new location" rather than a refusal.
        onAddLocation={!canWriteDepreciation ? undefined : async (name, departmentId) => {
          try {
            // The API takes a list now; the quick-add offers one department.
            const res = await client.post('/asset-locations', { name, departmentIds: departmentId ? [departmentId] : [] });
            const row = res.data?.data ?? res.data;
            // Optimistically append + refresh on next fetch to keep
            // grouping correct (department include needs a server round-trip).
            setAssetLocations(prev => [...prev, row]);
            addToast(`Added location "${name}"`, 'success');
          } catch (e: any) {
            addToast(extractErrorMessage(e, 'Could not add location'), 'error');
          }
        }}
        conditions={CONDITIONS}
        moneyLocked={!!editingAsset && !canEditAssetMoney}
        purchaseValueLocked={!!editingAsset && purchaseValueLocked}
        customFields={customFields.filter(f => f.category === form.category)}
        isSubmitting={isSubmitting}
        onSave={handleSave}
        isProposalMode={canPropose && !canEditDirectly}
        onSaveDraft={canPropose && !canEditDirectly ? handleSaveDraft : undefined}
      />

      <AssetPhotosModal
        asset={showPhotos}
        onClose={() => setShowPhotos(null)}
        onRemovePhoto={handleRemovePhoto}
        onRemoveVideo={handleRemoveVideo}
      />

      <AssetHistoryModal
        asset={showHistory}
        onClose={() => setShowHistory(null)}
      />

      <AssetDepreciationModal
        assetId={showDepreciation?.id ?? null}
        assetMeta={showDepreciation ? {
          assetTag: showDepreciation.assetTag,
          name: showDepreciation.name,
          purchaseValue: showDepreciation.purchaseValue != null ? Number(showDepreciation.purchaseValue) : null,
          currentValue: showDepreciation.currentValue != null ? Number(showDepreciation.currentValue) : null,
          salvageValue: showDepreciation.salvageValue != null ? Number(showDepreciation.salvageValue) : null,
          depreciationMethod: showDepreciation.depreciationMethod ?? null,
          usefulLifeMonths: showDepreciation.usefulLifeMonths ?? null,
        } : null}
        onClose={() => setShowDepreciation(null)}
      />

      <AssetTransferModal
        asset={showTransfer}
        users={users}
        onClose={() => setShowTransfer(null)}
        onSuccess={fetchData}
      />

      <AssetApprovalsModal
        isOpen={showApprovals}
        onClose={() => { setShowApprovals(false); refreshDraftCount(); }}
        onApplied={() => { fetchData(); refreshDraftCount(); }}
        onResumeDraft={openDraft}
        initialFilter={approvalsInitialFilter}
      />

      <AssetQrModal
        asset={showQr}
        onClose={() => setShowQr(null)}
      />

      <DisposeAssetModal
        asset={disposeAsset}
        onClose={() => setDisposeAsset(null)}
        onDisposed={() => { refetchAssets(); }}
      />

      <DepreciationDefaultsModal
        isOpen={showDeprDefaults}
        onClose={() => setShowDeprDefaults(false)}
        canManage={canWriteDepreciation}
      />

      <AssetIntakeModal
        isOpen={showIntakes}
        onClose={() => { setShowIntakes(false); refreshIntakeCount(); }}
        onReceived={() => { refetchAssets(); refreshIntakeCount(); }}
        companies={companies}
        users={users}
        assetLocations={assetLocations}
      />

      {/* Settings Modal */}
      <Modal isOpen={showSettings} onClose={() => setShowSettings(false)} title="Asset Settings">
        <div className="space-y-6 max-h-[70vh] overflow-y-auto p-1">
          <div>
            <h3 className="text-sm font-bold text-ink mb-2">Categories ({customCategories.length})</h3>
            <div className="max-h-40 overflow-y-auto border border-line-soft rounded-lg mb-3">
              {customCategories.map(c => (
                <div key={c.value} className="flex items-center justify-between px-3 py-1.5 hover:bg-surface text-sm">
                  <span className="font-medium text-ink">{c.label}</span>
                  <button onClick={() => setCustomCategories(customCategories.filter(x => x.value !== c.value))} className="text-red-400 hover:text-red-700 dark:text-red-300"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <input type="text" value={newCatLabel} onChange={(e) => setNewCatLabel(e.target.value)} placeholder="New category name" className="flex-1 px-2 py-1.5 border rounded text-sm focus:border-brand outline-none" />
              <button onClick={addCategory} className="px-3 py-1.5 bg-brand text-white text-xs font-bold rounded-full hover:bg-brand-dark transition-colors"><Plus size={14} /></button>
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-sm font-bold text-ink">Locations ({assetLocations.length})</h3>
              {!canManageLocations && (
                <span className="text-[10px] text-faint">SUPER_ADMIN / FINANCE only — view-only here</span>
              )}
            </div>
            <p className="text-[10px] text-faint mb-2">
              Departments are auto-mirrored as lab locations. Add corridors, storerooms, off-site warehouses here too. Renaming a typo updates the picker for everyone.
            </p>
            <div className="max-h-60 overflow-y-auto border border-line-soft rounded-lg mb-3 divide-y divide-line-soft">
              {assetLocations.length === 0 && (
                <p className="text-xs text-faint px-3 py-4 text-center">No locations yet.</p>
              )}
              {assetLocations.map(l => (
                <LocationRow
                  key={l.id}
                  loc={l}
                  canManage={canManageLocations}
                  onRename={renameAssetLocation}
                  onToggleActive={toggleAssetLocationActive}
                  onDelete={deleteAssetLocation}
                />
              ))}
            </div>
            {canManageLocations && (
              <div className="flex gap-2 items-start">
                <input
                  type="text"
                  value={newLocation}
                  onChange={(e) => setNewLocation(e.target.value)}
                  placeholder="New location name (e.g. Corridor B)"
                  className="flex-1 px-2 py-1.5 border rounded text-sm focus:border-brand outline-none"
                />
                <button
                  onClick={async () => {
                    const name = newLocation.trim();
                    if (!name) return;
                    if (assetLocations.some(l => l.name.toLowerCase() === name.toLowerCase())) {
                      addToast('A location with that name already exists', 'error');
                      return;
                    }
                    try {
                      const res = await client.post('/asset-locations', { name });
                      const row = res.data?.data ?? res.data;
                      setAssetLocations(prev => [...prev, row]);
                      setNewLocation('');
                      addToast('Location added', 'success');
                    } catch (e: any) {
                      addToast(extractErrorMessage(e, 'Could not add'), 'error');
                    }
                  }}
                  className="px-3 py-1.5 bg-brand text-white text-xs font-bold rounded-full hover:bg-brand-dark transition-colors"
                >
                  <Plus size={14} />
                </button>
              </div>
            )}
          </div>

          {/* Custom fields per category — admins shape what extra inputs
              appear on the asset modal for each category. E.g.
              RND_EQUIPMENT might add Serial No / Manufacturer / Rated Power.
              Definitions live here; values get stored against assets. */}
          <div>
            <div className="flex items-baseline justify-between mb-2">
              <h3 className="text-sm font-bold text-ink">Custom fields per category</h3>
              {!canManageCustomFields && (
                <span className="text-[10px] text-faint">ADMIN / SUPER_ADMIN only</span>
              )}
            </div>
            <p className="text-[10px] text-faint mb-2">
              Define extra fields that appear on the asset modal based on the asset's category. E.g. RND_EQUIPMENT could carry <span className="font-mono">serial number</span> + <span className="font-mono">manufacturer</span> while FURNITURE doesn't.
            </p>
            <div className="mb-2">
              <select
                value={customFieldsCategory}
                onChange={(e) => setCustomFieldsCategory(e.target.value)}
                className="w-full px-2 py-1.5 border rounded text-sm focus:border-brand outline-none"
              >
                {customCategories.map(c => (
                  <option key={c.value} value={c.value}>{c.label}</option>
                ))}
              </select>
            </div>
            <div className="max-h-48 overflow-y-auto border border-line-soft rounded-lg mb-3 divide-y divide-line-soft">
              {customFieldsForCategory.length === 0 ? (
                <p className="text-xs text-faint px-3 py-4 text-center">
                  No custom fields defined for this category.
                </p>
              ) : (
                customFieldsForCategory.map(f => (
                  <div key={f.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-ink truncate">{f.name}</span>
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-surface text-secondary border-line">
                          {f.fieldType}
                        </span>
                        {f.required && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30">
                            required
                          </span>
                        )}
                      </div>
                      {f.options?.length > 0 && (
                        <p className="text-[10px] text-faint mt-0.5 truncate">
                          options: {f.options.join(', ')}
                        </p>
                      )}
                    </div>
                    {canManageCustomFields && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() => toggleCustomFieldRequired(f.id, !f.required)}
                          className="text-[10px] text-muted hover:text-ink font-bold px-1.5"
                          title={f.required ? 'Make optional' : 'Make required'}
                        >
                          {f.required ? 'Make optional' : 'Make required'}
                        </button>
                        <button onClick={() => deleteCustomField(f.id, f.name)} className="text-red-400 hover:text-red-700 dark:text-red-300 px-1">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
            {canManageCustomFields && (
              <CustomFieldAdder onAdd={addCustomField} />
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
};

// Inline form for adding a new custom field to the active category. Keeps
// state local so the parent doesn't churn on every keystroke. fieldType
// switches reveal the right inputs (options[] only for dropdown).
const CustomFieldAdder = ({ onAdd }: { onAdd: (p: { name: string; fieldType: string; required: boolean; options?: string[] }) => Promise<void> | void }) => {
  const [name, setName] = useState('');
  const [fieldType, setFieldType] = useState('text');
  const [required, setRequired] = useState(false);
  const [optionsCsv, setOptionsCsv] = useState('');

  const reset = () => { setName(''); setFieldType('text'); setRequired(false); setOptionsCsv(''); };

  return (
    <div className="bg-surface border border-line rounded-lg p-3 space-y-2">
      <p className="text-[10px] font-bold text-muted uppercase">Add field</p>
      <div className="grid grid-cols-2 gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Field name (e.g. Serial Number)"
          className="px-2 py-1.5 border rounded text-sm focus:border-brand outline-none"
        />
        <select
          value={fieldType}
          onChange={(e) => setFieldType(e.target.value)}
          className="px-2 py-1.5 border rounded text-sm focus:border-brand outline-none"
        >
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="date">Date</option>
          <option value="dropdown">Dropdown</option>
          <option value="boolean">Yes / No</option>
        </select>
      </div>
      {fieldType === 'dropdown' && (
        <input
          type="text"
          value={optionsCsv}
          onChange={(e) => setOptionsCsv(e.target.value)}
          placeholder="Options, comma-separated (e.g. Low, Medium, High)"
          className="w-full px-2 py-1.5 border rounded text-sm focus:border-brand outline-none"
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs text-muted inline-flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
            className="accent-brand"
          />
          Required
        </label>
        <button
          onClick={async () => {
            if (!name.trim()) return;
            const options = fieldType === 'dropdown'
              ? optionsCsv.split(',').map(s => s.trim()).filter(Boolean)
              : undefined;
            if (fieldType === 'dropdown' && (!options || options.length === 0)) {
              return; // backend would 400 anyway
            }
            await onAdd({ name: name.trim(), fieldType, required, options });
            reset();
          }}
          disabled={!name.trim() || (fieldType === 'dropdown' && !optionsCsv.trim())}
          className="px-3 py-1.5 bg-brand text-white text-xs font-bold rounded-full hover:bg-brand-dark disabled:opacity-50 inline-flex items-center gap-1"
        >
          <Plus size={12} /> Add field
        </button>
      </div>
    </div>
  );
};

// One row in the locations admin list. Lab-linked locations show a badge
// and can't be renamed (because the underlying Department.name is the
// source of truth — renaming would just create drift). Standalone
// locations are fully editable.
const LocationRow = ({
  loc,
  canManage,
  onRename,
  onToggleActive,
  onDelete,
}: {
  loc: any;
  canManage: boolean;
  onRename: (id: string, name: string) => Promise<void> | void;
  onToggleActive: (id: string, isActive: boolean) => Promise<void> | void;
  onDelete: (id: string, name: string) => Promise<void> | void;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(loc.name);
  // A room tagged with at least one department reads as a lab. (Was a single
  // `departmentId` before rooms could be shared by several departments.)
  const isLab = !!(loc.departments?.length);

  return (
    <div className={`flex items-center justify-between px-3 py-2 text-sm ${!loc.isActive ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {editing && canManage && !isLab ? (
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') { await onRename(loc.id, draft); setEditing(false); }
              if (e.key === 'Escape') { setDraft(loc.name); setEditing(false); }
            }}
            onBlur={async () => { if (draft !== loc.name) await onRename(loc.id, draft); setEditing(false); }}
            autoFocus
            className="flex-1 px-2 py-1 border rounded text-sm focus:border-brand outline-none"
          />
        ) : (
          <span className="font-medium text-ink truncate">{loc.name}</span>
        )}
        {isLab && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30 shrink-0">
            LAB
          </span>
        )}
        {!loc.isActive && (
          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded border bg-hover text-secondary border-line shrink-0">
            HIDDEN
          </span>
        )}
      </div>
      {canManage && (
        <div className="flex items-center gap-1 shrink-0">
          {!isLab && !editing && (
            <button onClick={() => setEditing(true)} className="text-[10px] text-brand font-bold hover:underline px-1.5">
              Rename
            </button>
          )}
          <button
            onClick={() => onToggleActive(loc.id, !loc.isActive)}
            className="text-[10px] text-muted hover:text-ink font-bold px-1.5"
            title={loc.isActive ? 'Hide from picker' : 'Show in picker'}
          >
            {loc.isActive ? 'Hide' : 'Show'}
          </button>
          {!isLab && (
            <button onClick={() => onDelete(loc.id, loc.name)} className="text-red-400 hover:text-red-700 dark:text-red-300 px-1">
              <Trash2 size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
};
