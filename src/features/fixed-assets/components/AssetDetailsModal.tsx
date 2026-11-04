import { useEffect, useMemo, useRef, useState } from 'react';
import { client } from '@/api';
import { Modal } from '@/components/ui';
import { Camera, X, Upload, Video, AlertCircle, FileText } from 'lucide-react';
import { ASSET_PHOTO_ACCEPT } from '@/lib/fileAccept';

interface AssetFormData {
  name: string;
  description: string;
  category: string;
  departmentId: string;
  // Location: `locationId` is the canonical FK to an AssetLocation (lab /
  // place). `location` is the denormalized name kept for display + legacy
  // free-text labels not yet promoted to a managed location. Picking a lab
  // sets both; an ad-hoc string sets only `location`.
  locationId: string;
  location: string;
  // Custodian: either a User FK (custodianId) OR a free-form label
  // (custodianLabel). Pickers enforce only one is set at a time; the
  // backend accepts either independently.
  custodianId: string;
  custodianLabel: string;
  condition: string;
  remarks: string;
  // Step 8 maintenance fields. Stored as ISO date strings (yyyy-mm-dd)
  // because the underlying <input type="date"> hands us strings. Always
  // present in state ('' = unset) so React's controlled inputs stay happy.
  warrantyExpiresAt: string;
  nextMaintenanceDueAt: string;
  maintenanceIntervalDays: number | '';
  // Finance-side fields. Same string-in-state pattern as the date fields
  // above ('' = unset) so the controlled inputs don't oscillate between
  // undefined / null. Numbers are parsed at submit time.
  assetType: 'TANGIBLE' | 'INTANGIBLE';
  companyId: string;          // '' = no company chosen (legacy rows)
  ownership: 'OWNED' | 'SHARED';
  purchaseValue: number | '';
  currentValue: number | '';
  purchaseDate: string;        // '' = unknown / not entered
  // Depreciation overrides. All optional — leave blank to inherit from the
  // CategoryDepreciationDefault for the asset's category. Setting
  // `depreciationMethod: 'NONE'` is the explicit opt-out signal.
  usefulLifeMonths: number | '';
  salvageValue: number | '';
  depreciationMethod: 'STRAIGHT_LINE' | 'DECLINING_BALANCE' | 'DOUBLE_DECLINING' | 'WRITTEN_DOWN_VALUE' | 'NONE' | '';
  depreciationStartDate: string;  // '' = use purchaseDate
  // Per-category dynamic field values, keyed by FixedAssetCustomField.id.
  // Always present (default `{}`) so the modal's render path doesn't have
  // to null-check. Empty string per field = unset. Backend only persists
  // the keys belonging to the asset's active category.
  customValues: Record<string, string>;
}

interface AssetLocationRow {
  id: string;
  name: string;
  departmentId?: string | null;
  department?: { id: string; name: string } | null;
}

// Reserved label values used by the custodian picker for the non-user
// options. Picked so they can't collide with a real user id.
const CUSTODIAN_OPT_COMMON = '__common__';
const CUSTODIAN_OPT_CUSTOM = '__custom__';

interface CategoryOption {
  value: string;
  label: string;
}

interface ConditionOption {
  value: string;
  label: string;
}

interface AssetDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingAsset: any;
  form: AssetFormData;
  onFormChange: (form: AssetFormData) => void;
  photoFiles: File[];
  onSetPhotoFiles: (files: File[]) => void;
  // New: separate video staging. Mirrors the photo pattern — videos are
  // collected here and uploaded after the asset/draft is persisted.
  videoFiles?: File[];
  onSetVideoFiles?: (files: File[]) => void;
  departments: any[];
  users: any[];
  // Companies list — passed from parent so the picker stays a fast
  // synchronous render (no in-modal fetch). Empty array = no companies
  // configured yet; the picker still renders with an instructional option.
  companies: { id: string; name: string; code?: string | null; isOwn: boolean }[];
  customCategories: CategoryOption[];
  customLocations: string[];
  // New: AssetLocation master rows. When provided, used as the primary
  // location picker source (departmental groupings + standalone places).
  // Falls back to `customLocations` when this is empty/undefined.
  assetLocations?: AssetLocationRow[];
  // Optional callback for inline "Add new location" — when provided,
  // the picker shows a "+ Add new location" entry that opens a tiny
  // inline form. Receives the name and the (optional) departmentId.
  onAddLocation?: (name: string, departmentId: string | null) => Promise<void> | void; // single tag is fine here — the quick-add is for ad-hoc places
  conditions: ConditionOption[];
  // Editing an existing asset as a role that may not change its money fields
  // (only Finance may) — the inputs show the values but are read-only.
  moneyLocked?: boolean;
  // Depreciation is already posted for this asset, so its cost is frozen.
  purchaseValueLocked?: boolean;
  // Custom field DEFINITIONS for the asset's active category. Comes from
  // the parent which fetched them on mount; the modal renders them as
  // dynamic inputs in a Specifications block. Empty array = no extras
  // for this category, no block rendered.
  customFields?: { id: string; name: string; fieldType: string; options?: string[]; required?: boolean }[];
  isSubmitting: boolean;
  onSave: () => void;
  // True when the current user can only PROPOSE (associate finance) —
  // changes the primary button label so they're not surprised by the
  // approval routing. Optional; defaults to direct-write.
  isProposalMode?: boolean;
  // New (proposal mode only): "Save as draft" callback. When provided,
  // a secondary button appears that parks the proposal in DRAFT state.
  onSaveDraft?: () => void;
}

interface AssetPhotosModalProps {
  asset: any;
  onClose: () => void;
  // New signature: receives the storage KEY, not the index. The gallery
  // fetches { key, url } pairs from the server and passes the key back so
  // delete is race-safe (no off-by-one if another tab uploaded mid-view).
  onRemovePhoto: (asset: any, key: string) => void;
  // Optional video remove handler. When provided, the videos tab shows
  // a per-tile delete button. Same key-based pattern as photos.
  onRemoveVideo?: (asset: any, key: string) => void;
}

export const AssetDetailsModal = ({
  isOpen,
  onClose,
  editingAsset,
  form,
  onFormChange,
  photoFiles,
  onSetPhotoFiles,
  videoFiles = [],
  onSetVideoFiles,
  departments,
  users,
  companies,
  customCategories,
  customLocations,
  assetLocations,
  onAddLocation,
  conditions,
  moneyLocked = false,
  purchaseValueLocked = false,
  customFields = [],
  isSubmitting,
  onSave,
  isProposalMode = false,
  onSaveDraft,
}: AssetDetailsModalProps) => {
  const photoInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);

  // Inline "Add new location" form state.
  const [showAddLoc, setShowAddLoc] = useState(false);
  const [newLocName, setNewLocName] = useState('');
  const [newLocDept, setNewLocDept] = useState('');

  // Inline custom-custodian text input. Visible only when the user picks
  // the "Custom (enter name)" option in the custodian dropdown.
  const showCustomCustodian = !!form.custodianLabel && !form.custodianId;

  // Custodian picker option value derived from form state.
  // If a userId is set → that id; if a label is set → CUSTOM sentinel;
  // empty → unassigned.
  const custodianSelectValue = form.custodianId
    ? form.custodianId
    : form.custodianLabel?.trim().toLowerCase() === 'common / general'
      ? CUSTODIAN_OPT_COMMON
      : form.custodianLabel
        ? CUSTODIAN_OPT_CUSTOM
        : '';

  // Group users by role for the picker (Admin/Finance/Manager/User…).
  const usersByRole = useMemo(() => {
    const groups: Record<string, any[]> = {};
    for (const u of users) {
      const r = (u.role || 'OTHER').toString();
      (groups[r] = groups[r] || []).push(u);
    }
    // Sort group keys by a sensible role hierarchy first, then alpha.
    const roleOrder = ['SUPER_ADMIN', 'ADMIN', 'FINANCE', 'ASSOCIATE_FINANCE', 'INVENTORY', 'PROCUREMENT', 'MANAGER', 'LAB', 'USER'];
    const orderedKeys = Object.keys(groups).sort((a, b) => {
      const ai = roleOrder.indexOf(a);
      const bi = roleOrder.indexOf(b);
      if (ai === -1 && bi === -1) return a.localeCompare(b);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return orderedKeys.map(k => ({ role: k, users: groups[k] }));
  }, [users]);

  // Defensive dedupe: collapse departments by name so legacy duplicates
  // from past seeding don't appear thrice in the picker. Keep the row
  // with the most user-facing context (we prefer the one with a path —
  // i.e. carries a parent — since that's the actively-used hierarchy).
  // The backend now ships a one-shot cleanup script (dedupe-departments)
  // to fix the root cause; this is just belt-and-suspenders.
  const uniqueDepartments = useMemo(() => {
    const seen = new Map<string, any>();
    for (const d of departments || []) {
      if (!seen.has(d.name)) seen.set(d.name, d);
    }
    return Array.from(seen.values());
  }, [departments]);

  // The active picker list, plus the editing asset's CURRENT location even
  // if it's been hidden (isActive=false) — a hidden lab is dropped from the
  // fetched list, which would otherwise make the select render blank when
  // editing such an asset. Surfacing it keeps the value visible + intact.
  const effectiveLocations = useMemo<AssetLocationRow[]>(() => {
    const base = assetLocations || [];
    const cur = editingAsset?.locationRef;
    if (cur?.id && !base.some(l => l.id === cur.id)) {
      return [...base, { id: cur.id, name: cur.name, departmentId: null, department: null }];
    }
    return base;
  }, [assetLocations, editingAsset]);

  // Build the merged location picker source. Prefer AssetLocation rows
  // when supplied (they carry departmental grouping + real FK ids); fall
  // back to the legacy string list. For legacy rows we use the NAME as the
  // option value (no real id exists) so the change handler can tell a
  // managed lab (real id → set locationId) apart from an ad-hoc label.
  const locationGroups = useMemo(() => {
    if (effectiveLocations.length > 0) {
      const labGrouped: Record<string, AssetLocationRow[]> = {};
      const standalone: AssetLocationRow[] = [];
      for (const l of effectiveLocations) {
        const depts = (l as any).departments as { id: string; name: string }[] | undefined;
        if (depts?.length) {
          // Listed under every department that uses it — a bay shared by
          // compliance and the UI devs should be findable under both.
          for (const d of depts) {
            (labGrouped[d.name] = labGrouped[d.name] || []).push(l);
          }
        } else {
          standalone.push(l);
        }
      }
      return { labGrouped, standalone };
    }
    return { labGrouped: {}, standalone: customLocations.map((n) => ({ id: n, name: n })) };
  }, [effectiveLocations, customLocations]);

  // Real AssetLocation rows keyed by id — used to tell a managed-lab pick
  // (value is a real id) from an ad-hoc / legacy name pick.
  const locationById = useMemo(() => {
    const m = new Map<string, AssetLocationRow>();
    for (const l of effectiveLocations) m.set(l.id, l);
    return m;
  }, [effectiveLocations]);

  // Resolve the <select>'s current value from form state. Prefer the FK
  // when it points at a known row; otherwise try to match the stored name
  // back to a managed lab (so a legacy asset whose location string equals a
  // lab name still pre-selects); else fall back to the raw name.
  const selectedLocationValue = useMemo(() => {
    if (form.locationId && locationById.has(form.locationId)) return form.locationId;
    const name = (form.location || '').trim().toLowerCase();
    if (name) {
      for (const l of effectiveLocations) {
        if (l.name.toLowerCase() === name) return l.id;
      }
    }
    return form.location || '';
  }, [form.locationId, form.location, locationById, effectiveLocations]);

  const handleLocationChange = (val: string) => {
    if (val === '__add__') { setShowAddLoc(true); return; }
    const row = locationById.get(val);
    if (row) onFormChange({ ...form, locationId: row.id, location: row.name });
    else onFormChange({ ...form, locationId: '', location: val });
  };

  // Validation summary (proposal mode only). Lists the fields that still
  // need to be filled before Submit-for-Approval can fire.
  const missingFields = useMemo(() => {
    if (!isProposalMode) return [];
    const missing: string[] = [];
    // The same three the server requires (FixedAssetsService.CREATE_REQUIRED)
    // — the asset cannot exist without them. This list used to demand
    // condition, location, custodian, type, company, ownership and a photo,
    // none of which the server needs, while purchase value and date (which it
    // did need) were marked optional. Value and date are now optional on both
    // sides; an asset without them is flagged on the register instead.
    if (!form.name?.trim()) missing.push('Asset name');
    if (!form.category) missing.push('Category');
    if (!form.departmentId) missing.push('Department');
    // Required custom fields for this category.
    for (const cf of customFields) {
      if (cf.required && !form.customValues?.[cf.id]?.toString().trim()) {
        missing.push(cf.name);
      }
    }
    return missing;
  }, [form, isProposalMode, customFields, editingAsset, photoFiles, videoFiles]);
  const canSubmitForApproval = missingFields.length === 0;

  const handleAddLocationInline = async () => {
    if (!onAddLocation) return;
    const name = newLocName.trim();
    if (!name) return;
    await onAddLocation(name, newLocDept || null);
    // Auto-select by name — once the parent refetches assetLocations the
    // new row's id resolves via selectedLocationValue's name match, and the
    // backend matches the name to set the FK even before the refetch lands.
    onFormChange({ ...form, locationId: '', location: name });
    setShowAddLoc(false);
    setNewLocName('');
    setNewLocDept('');
  };

  const handleCustodianChange = (val: string) => {
    if (val === CUSTODIAN_OPT_COMMON) {
      onFormChange({ ...form, custodianId: '', custodianLabel: 'Common / General' });
    } else if (val === CUSTODIAN_OPT_CUSTOM) {
      // Initialise to empty label so the inline text input appears.
      onFormChange({ ...form, custodianId: '', custodianLabel: ' ' });
    } else if (val === '') {
      onFormChange({ ...form, custodianId: '', custodianLabel: '' });
    } else {
      onFormChange({ ...form, custodianId: val, custodianLabel: '' });
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={
      editingAsset
        ? `${isProposalMode ? 'Propose update — ' : 'Edit Asset — '}${editingAsset.assetTag}`
        : (isProposalMode ? 'Propose new asset (awaits Finance approval)' : 'Add New Asset')
    }>
      <div className="space-y-4 max-h-[70vh] overflow-y-auto p-1">
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Asset Name *</label>
          <input type="text" value={form.name} onChange={(e) => onFormChange({ ...form, name: e.target.value })} className="w-full px-3 py-2 border rounded-md focus:border-brand outline-none" placeholder="e.g. Rigol DS1054Z Oscilloscope" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Category *</label>
            <select value={form.category} onChange={(e) => onFormChange({ ...form, category: e.target.value })} className="w-full px-3 py-2 border rounded-md focus:border-brand outline-none">
              {customCategories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Condition</label>
            <select value={form.condition} onChange={(e) => onFormChange({ ...form, condition: e.target.value })} className="w-full px-3 py-2 border rounded-md focus:border-brand outline-none">
              {/* Disposal has its own action (it records the book value and
                  gain/loss) and the server refuses DISPOSED through an edit, so
                  it is only listed when the asset is already disposed. */}
              {conditions
                .filter(c => c.value !== 'DISPOSED' || editingAsset?.condition === 'DISPOSED')
                .map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Department *</label>
            <select value={form.departmentId} onChange={(e) => onFormChange({ ...form, departmentId: e.target.value })} className="w-full px-3 py-2 border rounded-md focus:border-brand outline-none">
              <option value="">-- Select --</option>
              {uniqueDepartments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Location</label>
            <select
              value={selectedLocationValue}
              onChange={(e) => handleLocationChange(e.target.value)}
              className="w-full px-3 py-2 border rounded-md focus:border-brand outline-none"
            >
              <option value="">-- Select --</option>
              {/* Lab-grouped locations — one optgroup per department. Value
                  is the AssetLocation id so the asset links by FK. */}
              {Object.entries(locationGroups.labGrouped).map(([dept, rows]) => (
                <optgroup key={dept} label={`Lab · ${dept}`}>
                  {rows.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </optgroup>
              ))}
              {/* Non-lab locations (corridors, off-site, etc.) */}
              {locationGroups.standalone.length > 0 && (
                <optgroup label="Other locations">
                  {locationGroups.standalone.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                </optgroup>
              )}
              {onAddLocation && <option value="__add__">+ Add new location…</option>}
            </select>
            {showAddLoc && (
              <div className="mt-2 p-3 bg-brand-100 border border-brand-200 rounded-md space-y-2">
                <p className="text-[10px] font-bold text-muted uppercase">Add new location</p>
                <input
                  type="text"
                  value={newLocName}
                  onChange={(e) => setNewLocName(e.target.value)}
                  placeholder="e.g. Corridor B / Storeroom 2"
                  className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
                />
                <select
                  value={newLocDept}
                  onChange={(e) => setNewLocDept(e.target.value)}
                  className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
                >
                  <option value="">Not linked to a lab (standalone)</option>
                  {uniqueDepartments.map((d: any) => <option key={d.id} value={d.id}>Lab — {d.name}</option>)}
                </select>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => { setShowAddLoc(false); setNewLocName(''); setNewLocDept(''); }} className="px-3 py-1 text-xs text-muted hover:bg-hover rounded">Cancel</button>
                  <button type="button" onClick={handleAddLocationInline} disabled={!newLocName.trim()} className="px-3 py-1 text-xs font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50">Add</button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Custodian (who has it?)</label>
          <select
            value={custodianSelectValue}
            onChange={(e) => handleCustodianChange(e.target.value)}
            className="w-full px-3 py-2 border rounded-md focus:border-brand outline-none"
          >
            <option value="">-- Unassigned --</option>
            <option value={CUSTODIAN_OPT_COMMON}>Common / General (no specific person)</option>
            {usersByRole.map(group => (
              <optgroup key={group.role} label={group.role.replace(/_/g, ' ')}>
                {group.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </optgroup>
            ))}
            <option value={CUSTODIAN_OPT_CUSTOM}>Custom (enter name)…</option>
          </select>
          {showCustomCustodian && (
            <input
              type="text"
              autoFocus
              value={form.custodianLabel.trim() === '' ? '' : form.custodianLabel}
              onChange={(e) => onFormChange({ ...form, custodianLabel: e.target.value, custodianId: '' })}
              placeholder="e.g. Reception desk, Security office"
              className="w-full mt-2 px-3 py-2 border rounded-md text-sm focus:border-brand outline-none"
            />
          )}
        </div>

        {/* Finance — company, ownership (ours vs shared), purchase value,
            current book value, purchase date. Optional but encouraged so
            the dashboard tiles show meaningful totals. Tangible/Intangible
            sits here too because it's a financial classification (drives
            depreciation rules), not a physical attribute. */}
        <div className="border border-blue-100 dark:border-blue-400/25 rounded-lg p-3 bg-blue-50/40 dark:bg-blue-400/15 space-y-3">
          <p className="text-xs font-bold text-ink uppercase tracking-wider">Finance</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Type</label>
              <select
                value={form.assetType}
                onChange={(e) => onFormChange({ ...form, assetType: e.target.value as 'TANGIBLE' | 'INTANGIBLE' })}
                className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
              >
                <option value="TANGIBLE">Tangible (physical)</option>
                <option value="INTANGIBLE">Intangible (software / IP)</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Company</label>
              <select
                value={form.companyId}
                onChange={(e) => onFormChange({ ...form, companyId: e.target.value })}
                className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
              >
                <option value="">{companies.length === 0 ? '— no companies configured —' : '-- choose --'}</option>
                {companies.map(c => (
                  <option key={c.id} value={c.id}>{c.name}{c.code ? ` (${c.code})` : ''}{!c.isOwn ? ' · partner' : ''}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Ownership</label>
              <select
                value={form.ownership}
                onChange={(e) => onFormChange({ ...form, ownership: e.target.value as 'OWNED' | 'SHARED' })}
                className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
              >
                <option value="OWNED">Owned (our title)</option>
                <option value="SHARED">Shared (with sister / partner)</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              {/* Optional (owner's decision, 22 Oct 2026). Depreciation needs this
                  and the purchase date; an asset saved without them is flagged
                  on the register until someone fills them in. */}
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Purchase value (₹) <span className="normal-case font-normal text-faint">(optional)</span></label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.purchaseValue === '' ? '' : form.purchaseValue}
                onChange={(e) => onFormChange({ ...form, purchaseValue: e.target.value === '' ? '' : Number(e.target.value) })}
                placeholder="e.g. 125000"
                disabled={moneyLocked || purchaseValueLocked}
                className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none disabled:bg-surface disabled:text-muted"
              />
              {moneyLocked ? (
                <p className="text-[9px] text-faint mt-0.5">Only Finance can change asset values.</p>
              ) : purchaseValueLocked ? (
                <p className="text-[9px] text-faint mt-0.5">Locked — depreciation has been posted from this cost.</p>
              ) : null}
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">
                Net book value (₹) <span className="text-[9px] font-medium text-faint normal-case">(optional)</span>
                {form.purchaseValue !== '' && form.currentValue !== '' && Number(form.currentValue) < Number(form.purchaseValue) && (
                  <span className="ml-1.5 text-[9px] font-medium text-faint normal-case">
                    · accum. dep. ₹{(Number(form.purchaseValue) - Number(form.currentValue)).toLocaleString('en-IN')}
                  </span>
                )}
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.currentValue === '' ? '' : form.currentValue}
                onChange={(e) => onFormChange({ ...form, currentValue: e.target.value === '' ? '' : Number(e.target.value) })}
                placeholder="Auto-computed by depreciation cron"
                disabled={moneyLocked}
                className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none disabled:bg-surface disabled:text-muted"
              />
              <p className="text-[9px] text-faint mt-0.5">
                {moneyLocked ? 'Only Finance can change asset values.' : form.depreciationMethod && form.depreciationMethod !== 'NONE'
                  ? 'Auto-updated monthly. Override only for legacy assets.'
                  : 'Manual — no depreciation method set.'}
              </p>
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Purchase date <span className="normal-case font-normal text-faint">(optional)</span></label>
              <input
                type="date"
                value={form.purchaseDate || ''}
                onChange={(e) => onFormChange({ ...form, purchaseDate: e.target.value })}
                className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
          </div>

          {/* Depreciation panel — inside Finance section because depreciation
              IS a finance concept. Hidden behind a disclosure so the form
              doesn't feel intimidating; defaults are inherited from
              CategoryDepreciationDefault at create time and the cron does
              the rest. Finance only opens this for legacy assets that need
              overrides (e.g. mid-life method change, opt-out of depreciation). */}
          <details className="border border-blue-200 dark:border-blue-400/30 rounded-md bg-card/60 p-2">
            <summary className="text-[11px] font-bold text-blue-900 dark:text-blue-200 cursor-pointer hover:text-blue-700 dark:text-blue-300">
              Depreciation settings (advanced — auto-filled from category defaults)
            </summary>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <div>
                <label className="block text-[10px] font-bold text-muted uppercase mb-1">Method</label>
                <select
                  value={form.depreciationMethod}
                  onChange={(e) => onFormChange({ ...form, depreciationMethod: e.target.value as any })}
                  className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none bg-card"
                >
                  <option value="">(use category default)</option>
                  <option value="STRAIGHT_LINE">Straight-line (SLM)</option>
                  <option value="WRITTEN_DOWN_VALUE">Written-down value (WDV)</option>
                  <option value="DECLINING_BALANCE">Declining balance</option>
                  <option value="DOUBLE_DECLINING">Double declining</option>
                  <option value="NONE">None — don't depreciate</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-bold text-muted uppercase mb-1">Useful life (months)</label>
                <input
                  type="number"
                  min={1}
                  max={600}
                  step="1"
                  value={form.usefulLifeMonths === '' ? '' : form.usefulLifeMonths}
                  // Whole months, 1–600 — the server's range (50 years).
                  onChange={(e) => onFormChange({ ...form, usefulLifeMonths: e.target.value === '' ? '' : Math.min(600, Math.round(Number(e.target.value))) })}
                  placeholder="e.g. 60 (= 5 years)"
                  className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-muted uppercase mb-1">Salvage value (₹)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.salvageValue === '' ? '' : form.salvageValue}
                  onChange={(e) => onFormChange({ ...form, salvageValue: e.target.value === '' ? '' : Number(e.target.value) })}
                  placeholder="Residual at end-of-life (e.g. 5% of purchase)"
                  className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-bold text-muted uppercase mb-1">Depreciation start date</label>
                <input
                  type="date"
                  value={form.depreciationStartDate || ''}
                  onChange={(e) => onFormChange({ ...form, depreciationStartDate: e.target.value })}
                  className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
                />
                <p className="text-[9px] text-faint mt-0.5">Defaults to purchase date.</p>
              </div>
            </div>
          </details>
        </div>

        {/* Specifications — per-category dynamic fields (defined by admins
            via Settings → Custom fields). Only renders when there are
            fields defined for the asset's active category, so the modal
            stays compact for categories without extras. */}
        {customFields.length > 0 && (
          <div className="border border-violet-100 dark:border-violet-400/25 rounded-lg p-3 bg-violet-50/40 dark:bg-violet-400/15 space-y-3">
            <p className="text-xs font-bold text-ink uppercase tracking-wider">Specifications</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {customFields.map(cf => {
                const v = form.customValues?.[cf.id] ?? '';
                const setV = (val: string) => onFormChange({
                  ...form,
                  customValues: { ...(form.customValues || {}), [cf.id]: val },
                });
                return (
                  <div key={cf.id}>
                    <label className="block text-[10px] font-bold text-muted uppercase mb-1">
                      {cf.name}{cf.required ? ' *' : ''}
                    </label>
                    {cf.fieldType === 'text' && (
                      <input type="text" value={v} onChange={(e) => setV(e.target.value)} className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none" />
                    )}
                    {cf.fieldType === 'number' && (
                      <input type="number" value={v} onChange={(e) => setV(e.target.value)} className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none" />
                    )}
                    {cf.fieldType === 'date' && (
                      <input type="date" value={v} onChange={(e) => setV(e.target.value)} className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none" />
                    )}
                    {cf.fieldType === 'dropdown' && (
                      <select value={v} onChange={(e) => setV(e.target.value)} className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none">
                        <option value="">-- Select --</option>
                        {(cf.options || []).map(o => <option key={o} value={o}>{o}</option>)}
                      </select>
                    )}
                    {cf.fieldType === 'boolean' && (
                      <select value={v} onChange={(e) => setV(e.target.value)} className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none">
                        <option value="">-- Select --</option>
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <label className="block text-sm font-bold text-muted mb-1">Description</label>
          <input type="text" value={form.description} onChange={(e) => onFormChange({ ...form, description: e.target.value })} className="w-full px-3 py-2 border rounded-md focus:border-brand outline-none" placeholder="Brand, model, serial number..." />
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Remarks</label>
          <textarea value={form.remarks} onChange={(e) => onFormChange({ ...form, remarks: e.target.value })} rows={2} className="w-full px-3 py-2 border rounded-md focus:border-brand outline-none resize-none" placeholder="Audit notes, conditions..." />
        </div>

        {/* Step 8 — Maintenance & Warranty. All optional. Leaving these blank
            opts the asset out of any maintenance tracking. */}
        <div className="border border-line-soft rounded-lg p-3 bg-surface/40 space-y-3">
          <p className="text-xs font-bold text-ink uppercase tracking-wider">
            Maintenance & Warranty
            <span className="ml-1.5 text-[10px] font-medium text-faint normal-case tracking-normal">(all optional)</span>
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Warranty expires</label>
              <input
                type="date"
                value={form.warrantyExpiresAt || ''}
                onChange={(e) => onFormChange({ ...form, warrantyExpiresAt: e.target.value })}
                className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Next maintenance due</label>
              <input
                type="date"
                value={form.nextMaintenanceDueAt || ''}
                onChange={(e) => onFormChange({ ...form, nextMaintenanceDueAt: e.target.value })}
                className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-muted uppercase mb-1">Service every (days)</label>
              <input
                type="number"
                min={1}
                value={form.maintenanceIntervalDays ?? ''}
                onChange={(e) => onFormChange({ ...form, maintenanceIntervalDays: e.target.value === '' ? '' : Number(e.target.value) })}
                placeholder="e.g. 90"
                className="w-full px-2 py-1.5 border rounded-md text-sm focus:border-brand outline-none"
              />
            </div>
          </div>
          <p className="text-[10px] text-faint">
            When you log maintenance done (from the asset row), next-due advances by the interval automatically. The custodian gets a notification.
          </p>
        </div>

        {/* Photo Upload — files staged here are uploaded by the parent after
            the asset is saved (new asset) or PATCHed (edit). We don't preview
            the existing photos here as thumbnails because signed URLs need
            a separate fetch; the gallery modal handles that view. */}
        <div>
          <label className="block text-sm font-bold text-muted mb-1">
            Photos
            <span className="ml-1.5 text-[10px] font-medium text-faint">(optional)</span>
          </label>
          {editingAsset && (editingAsset.pictures?.length ?? 0) > 0 && (
            <p className="text-xs text-faint mb-2">
              {editingAsset.pictures.length} existing photo(s) — open the Photos column from the list to view or delete.
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <input
              ref={photoInputRef}
              type="file"
              accept={ASSET_PHOTO_ACCEPT}
              multiple
              // capture="environment" tells mobile browsers to open the rear
              // camera directly when this input is tapped. Desktop browsers
              // ignore the attribute and show the regular file picker.
              capture="environment"
              className="hidden"
              onChange={(e) => onSetPhotoFiles(Array.from(e.target.files || []))}
            />
            <button type="button" onClick={() => photoInputRef.current?.click()}
              className="flex items-center gap-2 px-3 py-2 border border-dashed border-line rounded-lg text-sm text-muted hover:border-brand hover:text-brand transition-colors">
              <Upload size={14} /> {photoFiles.length > 0 ? `${photoFiles.length} file(s) selected` : 'Add Photos'}
            </button>
            {photoFiles.length > 0 && (
              <button onClick={() => onSetPhotoFiles([])} className="text-xs text-red-400 hover:text-red-700 dark:text-red-300"><X size={14} /></button>
            )}
          </div>
          {photoFiles.length > 0 && (
            <p className="text-[10px] text-faint mt-1">
              These will upload after {editingAsset ? 'you click Update Asset' : 'the asset is created'}.
            </p>
          )}
        </div>

        {/* Video upload — staged + uploaded after the asset/draft is
            persisted, same pattern as photos. Supported formats: mp4,
            webm, quicktime (the three the HTML5 <video> tag handles
            natively). 100 MB cap per file. */}
        {onSetVideoFiles && (
          <div>
            <label className="block text-sm font-bold text-muted mb-1 flex items-center gap-2">
              <Video size={14} /> Videos
            </label>
            {editingAsset && (editingAsset.videos?.length ?? 0) > 0 && (
              <p className="text-xs text-faint mb-2">
                {editingAsset.videos.length} existing video(s) — open the asset to view or delete.
              </p>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <input
                ref={videoInputRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm"
                multiple
                className="hidden"
                onChange={(e) => onSetVideoFiles(Array.from(e.target.files || []))}
              />
              <button type="button" onClick={() => videoInputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-2 border border-dashed border-line rounded-lg text-sm text-muted hover:border-brand hover:text-brand transition-colors">
                <Upload size={14} /> {videoFiles.length > 0 ? `${videoFiles.length} video(s) selected` : 'Add Videos'}
              </button>
              {videoFiles.length > 0 && (
                <button onClick={() => onSetVideoFiles([])} className="text-xs text-red-400 hover:text-red-700 dark:text-red-300"><X size={14} /></button>
              )}
            </div>
            <p className="text-[10px] text-faint mt-1">
              MP4 / WebM / MOV up to 100 MB each. {videoFiles.length > 0 && `Uploads after the ${editingAsset ? 'update' : 'create'} completes.`}
            </p>
          </div>
        )}

        {/* Validation summary (proposal mode only) — surfaces the missing
            fields up-front so the proposer doesn't hit a vague server
            error after clicking Submit. */}
        {isProposalMode && missingFields.length > 0 && (
          <div className="border border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 rounded-lg p-3 flex items-start gap-2">
            <AlertCircle size={16} className="text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
            <div className="text-xs text-amber-900 dark:text-amber-200 leading-relaxed">
              <p className="font-bold mb-1">Still required before this can go for approval ({missingFields.length}):</p>
              <p>{missingFields.join(' · ')}</p>
              <p className="mt-1 text-amber-800 dark:text-amber-200">
                You can <span className="font-bold">Save as draft</span> now and finish later.
              </p>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-3 pt-4 border-t border-line-soft">
          <button onClick={onClose} className="px-4 py-2 text-muted font-bold rounded-md hover:bg-hover">Cancel</button>

          {/* Save as draft — only in proposal mode and only when a draft
              callback is wired. Always enabled so the proposer can park
              partial info without satisfying full validation. */}
          {isProposalMode && onSaveDraft && (
            <button
              onClick={onSaveDraft}
              disabled={isSubmitting || !form.name?.trim()}
              className="px-4 py-2 border border-line text-muted font-bold rounded-md hover:bg-surface disabled:opacity-50 inline-flex items-center gap-2"
              title={!form.name?.trim() ? 'Give the draft a name first so you can find it again' : ''}
            >
              <FileText size={14} /> Save as draft
            </button>
          )}

          <button
            onClick={onSave}
            disabled={isSubmitting || (isProposalMode && !canSubmitForApproval)}
            className="px-5 py-2 bg-brand text-white font-bold rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50"
            title={
              isProposalMode && !canSubmitForApproval
                ? `Fill in: ${missingFields.slice(0, 3).join(', ')}${missingFields.length > 3 ? '…' : ''}`
                : ''
            }
          >
            {isSubmitting
              ? (isProposalMode ? 'Submitting…' : 'Saving...')
              : isProposalMode
                ? (editingAsset ? 'Submit for approval' : 'Submit for approval')
                : (editingAsset ? 'Update Asset' : 'Add Asset')}
          </button>
        </div>
      </div>
    </Modal>
  );
};

// Gallery view of an asset's photos AND videos. Fetches signed read URLs
// from the backend on open — keys alone aren't enough (S3 mode needs
// presigned URLs, local mode needs JWT-signed query params). Re-fetches
// when the asset changes so the gallery is always fresh.
//
// Why a separate fetch instead of enriching the asset list response: the
// list endpoint can return hundreds of assets, each with multiple media
// files. Building signed URLs for every one of them up-front means N×P
// SDK calls in S3 mode for a page the user may never scroll. Lazy-
// fetching on gallery open scopes the cost to one asset at a time.
//
// The component keeps the legacy name `AssetPhotosModal` for compat with
// existing imports, but it now renders both photos and videos via a tab
// toggle at the top.
export const AssetPhotosModal = ({ asset, onClose, onRemovePhoto, onRemoveVideo }: AssetPhotosModalProps) => {
  const [photos, setPhotos] = useState<{ key: string; url: string }[]>([]);
  const [videos, setVideos] = useState<{ key: string; url: string }[]>([]);
  const [loading, setLoading] = useState(false);
  // Default to whichever kind is non-empty so a user clicking the row's
  // Media button sees content immediately rather than an empty Photos tab.
  const [tab, setTab] = useState<'photos' | 'videos'>('photos');

  useEffect(() => {
    if (!asset?.id) {
      setPhotos([]);
      setVideos([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      client.get(`/fixed-assets/${asset.id}/photos`).then(r => r.data?.data ?? r.data ?? []).catch(() => []),
      client.get(`/fixed-assets/${asset.id}/videos`).then(r => r.data?.data ?? r.data ?? []).catch(() => []),
    ]).then(([p, v]) => {
      if (cancelled) return;
      const photoRows = Array.isArray(p) ? p : [];
      const videoRows = Array.isArray(v) ? v : [];
      setPhotos(photoRows);
      setVideos(videoRows);
      // Pick the tab that has content — if both are empty, default to
      // photos. Don't override if the user has explicitly switched tabs
      // mid-session (i.e. asset.id changed but tab state is fresh).
      if (photoRows.length === 0 && videoRows.length > 0) setTab('videos');
      else setTab('photos');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [asset?.id, asset?.pictures?.length, asset?.videos?.length]);

  const handleDeletePhoto = (key: string) => {
    onRemovePhoto(asset, key);
    setPhotos((prev) => prev.filter((p) => p.key !== key));
  };
  const handleDeleteVideo = (key: string) => {
    if (!onRemoveVideo) return;
    onRemoveVideo(asset, key);
    setVideos((prev) => prev.filter((v) => v.key !== key));
  };

  return (
    <Modal isOpen={!!asset} onClose={onClose} title={`Media — ${asset?.assetTag || ''}`}>
      {asset && (
        <div className="space-y-3">
          {/* Tabs — photos / videos with counts. Tabs render even when one
              is empty so the user knows the other kind of media exists for
              this asset. */}
          <div className="flex items-center gap-2 border-b border-line-soft pb-2">
            <button
              onClick={() => setTab('photos')}
              className={`text-xs font-bold px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 transition-colors ${
                tab === 'photos' ? 'bg-brand text-white' : 'text-muted hover:bg-surface'
              }`}
            >
              <Camera size={12} /> Photos ({photos.length})
            </button>
            <button
              onClick={() => setTab('videos')}
              className={`text-xs font-bold px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 transition-colors ${
                tab === 'videos' ? 'bg-brand text-white' : 'text-muted hover:bg-surface'
              }`}
            >
              <Video size={12} /> Videos ({videos.length})
            </button>
          </div>

          {loading ? (
            <p className="text-sm text-faint text-center py-6">Loading…</p>
          ) : tab === 'photos' ? (
            photos.length === 0 ? (
              <p className="text-sm text-faint text-center py-6">No photos uploaded for this asset.</p>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {photos.map(({ key, url }, idx) => (
                  <div key={key} className="relative group overflow-hidden">
                    <div className="aspect-square bg-hover rounded-lg flex items-center justify-center border border-line overflow-hidden relative">
                      <img
                        src={url}
                        alt={`Asset photo ${idx + 1}`}
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          (e.target as HTMLImageElement).style.display = 'none';
                          ((e.target as HTMLImageElement).nextSibling as HTMLDivElement).classList.remove('hidden');
                        }}
                      />
                      <div className="hidden absolute inset-0 flex flex-col items-center justify-center bg-hover p-2 text-center text-faint">
                        <Camera className="w-8 h-8 mx-auto" />
                        <p className="text-[9px] mt-1 break-all line-clamp-2 w-full">{key}</p>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeletePhoto(key)}
                      className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                      title="Delete photo"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
              </div>
            )
          ) : (
            // Videos tab. HTML5 <video> handles mp4 / webm / quicktime
            // natively in modern browsers — exactly the formats the
            // backend MIME whitelist allows. `preload="metadata"` keeps
            // the gallery lightweight; the user clicks to actually play.
            videos.length === 0 ? (
              <p className="text-sm text-faint text-center py-6">No videos uploaded for this asset.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {videos.map(({ key, url }, idx) => (
                  <div key={key} className="relative group overflow-hidden bg-black rounded-lg border border-line">
                    <video
                      src={url}
                      controls
                      preload="metadata"
                      className="w-full aspect-video object-contain bg-black"
                      aria-label={`Asset video ${idx + 1}`}
                    >
                      Your browser does not support HTML5 video.
                    </video>
                    {onRemoveVideo && (
                      <button
                        onClick={() => handleDeleteVideo(key)}
                        className="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity z-10"
                        title="Delete video"
                      >
                        <X size={11} />
                      </button>
                    )}
                    <p className="text-[10px] text-faint px-2 pb-1 truncate" title={key}>{key.split('/').pop()}</p>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}
    </Modal>
  );
};
