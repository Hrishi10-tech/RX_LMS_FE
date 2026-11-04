import { useState, FormEvent, useEffect, useRef } from 'react';
import { useToast, useConfirm } from '../../context';
import { useAuth, useFormBootstrap } from '../../hooks';
import { extractErrorMessage } from '@/lib';
import { client } from '../../api';
import { UserMultiSelect, NumberInput } from '../ui';
// papaparse and xlsx are loaded ON DEMAND, not at module scope.
// IndentForm mounts on every dashboard that can raise an indent, so a static
// import shipped the whole spreadsheet stack to everyone whether or not they
// ever touch the BOM upload — xlsx alone gzips to ~142 KB, larger than the
// main app chunk. Same pattern as SpreadsheetPreview.tsx.
import { UserRole } from '@/types';
import { DEFAULT_UNITS } from '../../features/inventory/components/InventoryTable';
import { PHOTO_VIDEO_ACCEPT, SHEET_ACCEPT } from '@/lib/fileAccept';
import { homeDepartmentId } from '@/lib/homeDepartment';

interface IndentItemForm {
  id?: string; // present in edit mode for existing lines (drives backend diff)
  name: string;
  description: string;
  partNumber: string;
  qty: number;
  unit: string;
  unitAmount: number | string;
  url: string;
  purpose: string;
  category: string;
}

const CATEGORY_OPTIONS = [
  { value: 'ELECTRONIC_PASSIVE', label: 'Electronic Passive' },
  { value: 'ELECTRONIC_ACTIVE', label: 'Electronic Active' },
  { value: 'ELECTRONICS_GENERAL_ACCESSORIES', label: 'Electronics General Accessories' },
  { value: 'ELECTRONICS_TOOLS', label: 'Electronics Tools & Machineries' },
  { value: 'MECHANICAL_TOOLS', label: 'Mechanical Tools & Machineries' },
  { value: 'MECHANICAL_3D_PRINTING', label: 'Mechanical & 3D Printing Accessories' },
  { value: 'PACKING_MATERIALS', label: 'Packing Materials' },
  { value: 'SAFETY_WEARABLE', label: 'Safety Wearable' },
  { value: 'STATIONARY_OFFICE', label: 'Stationary & Office Supplies' },
  { value: 'CLEANING_ITEMS', label: 'Cleaning Items' },
  { value: 'PCB_STENCILS', label: 'PCB & Stencils' },
];

interface PrefillItem {
  id?: string;
  name?: string;
  unit?: string;
  category?: string;
  departmentId?: string | null;
}

interface IndentFormProps {
  /**
   * Create (or update) the indent. Should RESOLVE WITH THE SAVED INDENT — the
   * optional per-line photos are uploaded to
   * `POST /indents/:id/items/:itemId/attachment`, which needs ids that only
   * exist after the row is written. A caller that returns nothing still works;
   * the form says the photos could not be attached rather than losing them
   * silently.
   */
  onSubmit: (data: any) => Promise<any>;
  isLoading: boolean;
  /** When provided (e.g. raising an indent from an out-of-stock inventory row),
   *  the first item is prefilled with this item's name + unit. */
  prefillItem?: PrefillItem;
  /** EDIT MODE: the existing indent to pre-fill (requestor editing a PENDING
   *  slip before approval). When set, the form loads its items (with ids) +
   *  request fields, and onSubmit should PATCH instead of POST. */
  initialValues?: any;
  /** Submit button label (default "Submit Indent"; edit mode passes e.g. "Save changes"). */
  submitLabel?: string;
}

type ItemErrors = Partial<Record<'name' | 'qty' | 'unit' | 'category' | 'purpose' | 'url', string>>;
interface FormErrors {
  projectId?: string;
  departmentId?: string;
  emergencyReason?: string;
  items: Record<number, ItemErrors>;
}

/** Red ring when the field is at fault, house style otherwise. */
const ring = (bad?: string) =>
  bad ? 'border-red-500 focus:border-red-500 bg-red-50 dark:bg-red-400/15' : 'border-line focus:border-brand';

const FieldError = ({ msg }: { msg?: string }) =>
  msg ? <p className="mt-0.5 text-[11px] font-bold text-red-700 dark:text-red-300">{msg}</p> : null;

export const IndentForm = ({ onSubmit, isLoading, prefillItem, initialValues, submitLabel }: IndentFormProps) => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const { user } = useAuth();
  const [projectId, setProjectId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [emergency, setEmergency] = useState(false);
  const [emergencyReason, setEmergencyReason] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [isBomUpload, setIsBomUpload] = useState(false);
  /**
   * Per-field validation messages, shown against the field itself.
   *
   * Every required field here carried only the HTML `required` attribute, so a
   * missing value was reported by the browser's own validation bubble. That
   * bubble is easy to miss and easy to lose entirely: this form scrolls inside
   * `max-h-[70vh] overflow-y-auto`, and the bubble for a field scrolled out of
   * the visible area can go unseen. What the user gets then is a Submit button
   * that does nothing at all — no message, no network call, no clue which of
   * ~8 fields per item is at fault. It reads as a broken button, and it is the
   * kind of fault a tester reports as "the app won't let me raise an indent".
   *
   * So the form is `noValidate` and owns its own validation: the message goes
   * next to the field, the field turns red, and the first offender is scrolled
   * to and focused.
   */
  const [errors, setErrors] = useState<FormErrors>({ items: {} });
  const [items, setItems] = useState<IndentItemForm[]>(() => [
     {
       name: prefillItem?.name || '',
       description: '',
       partNumber: '',
       qty: 1,
       unit: prefillItem?.unit || 'PCS',
       unitAmount: '',
       url: '',
       purpose: prefillItem?.name ? 'Replenishment of out-of-stock item' : '',
       category: prefillItem?.category || 'ELECTRONICS_GENERAL_ACCESSORIES',
     },
  ]);

  // One optional photo per LINE, staged by row index until the indent exists —
  // the upload endpoint is keyed on the line id, which the server assigns.
  const [photos, setPhotos] = useState<Record<number, File>>({});
  const setPhotoAt = (idx: number, f: File | null) =>
    setPhotos(prev => {
      const next = { ...prev };
      if (f) next[idx] = f; else delete next[idx];
      return next;
    });
  const [responsiblePersonIds, setResponsiblePersonIds] = useState<string[]>([]);

  /**
   * Unit suggestions for the Unit box, taken from the units already in the
   * inventory rather than a hardcoded list — a lab that counts in "STP" or
   * "Roll" gets its own vocabulary offered back, and typing stays free so a
   * genuinely new unit is never blocked.
   *
   * Deduplicated case-insensitively: the live data holds both "nos" and "NOS",
   * and offering the same unit twice in different cases is how that split
   * spreads. First spelling seen wins, which keeps whatever case the data
   * mostly uses. The full unit registry from Table Settings follows, so a
   * fresh database still offers all 50 codes.
   */
  const [unitOptions, setUnitOptions] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    client.get('/inventory/filter-options')
      .then(({ data }) => {
        if (cancelled) return;
        const fromData: string[] = (data?.data ?? data)?.units ?? [];
        const seen = new Map<string, string>();
        for (const u of [...fromData, ...DEFAULT_UNITS.map((d) => d.short)]) {
          const key = String(u).trim().toLowerCase();
          if (key && !seen.has(key)) seen.set(key, String(u).trim());
        }
        setUnitOptions([...seen.values()]);
      })
      // A failed lookup costs suggestions, not the form — the box is free text.
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);



  useEffect(() => {
    if (initialValues) return; // edit mode prefills dept + responsibles itself
    // Department: user's own takes priority; fall back to the prefill item's department
    // (relevant when LAB raises an indent for an out-of-stock item outside their dept).
    if (user?.departmentId) setDepartmentId(user.departmentId);
    else if (prefillItem?.departmentId) setDepartmentId(prefillItem.departmentId);
    // SUPER_ADMIN is a system account, not a person — don't auto-add as responsible.
    if (user?.id && user.role !== UserRole.SUPER_ADMIN) setResponsiblePersonIds([user.id]);
  }, [user, prefillItem?.departmentId, initialValues]);

  // EDIT MODE prefill — load the existing slip into the form once.
  useEffect(() => {
    if (!initialValues) return;
    setProjectId(initialValues.projectId ?? '__OTHERS__');
    setDepartmentId(initialValues.departmentId ?? '');
    setEmergency(!!initialValues.emergency);
    setEmergencyReason(initialValues.emergencyReason ?? '');
    setCurrency(initialValues.currency ?? 'INR');
    const rps = (initialValues.responsiblePersons ?? []).map((r: any) => r.userId ?? r.id).filter(Boolean);
    setResponsiblePersonIds(rps);
    const its = (initialValues.items ?? []).map((i: any) => ({
      id: i.id,
      name: i.name ?? '',
      description: i.description ?? '',
      partNumber: i.partNumber ?? '',
      qty: Number(i.qty) || 1,
      unit: i.unit ?? 'PCS',
      unitAmount: i.unitAmount != null ? Number(i.unitAmount) : '',
      url: i.url ?? '',
      purpose: i.purpose ?? '',
      category: i.category ?? 'ELECTRONICS_GENERAL_ACCESSORIES',
    }));
    if (its.length) setItems(its);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- prefill once per indent
  }, [initialValues?.id]);

  // Reset the items list whenever the prefill item changes (e.g. user closes
  // the modal, picks a different stockout, and reopens). Previously the form
  // kept the previous values, leading to accidental re-submission of stale data.
  useEffect(() => {
    if (initialValues) return; // edit mode owns the item state
    setItems([
      {
        name: prefillItem?.name || '',
        description: '',
        partNumber: '',
        qty: 1,
        unit: prefillItem?.unit || 'PCS',
        unitAmount: '',
        url: '',
        purpose: prefillItem?.name ? 'Replenishment of out-of-stock item' : '',
        category: prefillItem?.category || 'ELECTRONICS_GENERAL_ACCESSORIES',
      },
    ]);
    setProjectId('');
    setEmergency(false);
    setEmergencyReason('');
    setCurrency('INR');
    setIsBomUpload(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally resets only when a new prefill item arrives (id/name); excludes category/unit which are read from the same prefillItem snapshot
  }, [prefillItem?.id, prefillItem?.name]);

  // Projects, departments and the user directory — see useFormBootstrap.
  // Shared with the other form so a failure surfaces in both, instead of
  // leaving whichever one nobody fixed with silently empty dropdowns.
  const { projects, departments, usersDirectory } = useFormBootstrap();

  // Finance / Procurement / Inventory have no department on their record; a new
  // indent of theirs defaults to their team's department (after a prefilled
  // item's, which says whose stock it is). Still changeable.
  const homeDeptId = user?.departmentId ? '' : homeDepartmentId(user?.role, departments);
  useEffect(() => {
    if (!initialValues && homeDeptId) setDepartmentId((cur) => cur || homeDeptId);
  }, [homeDeptId, initialValues]);

  const grandTotal = items.reduce((sum, item) => sum + (item.qty * (Number(item.unitAmount) || 0)), 0);

  const handleItemChange = (index: number, field: keyof IndentItemForm, value: any) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };
    setItems(newItems);
    // Drop this field's complaint as soon as it is touched. Leaving a stale
    // red border under a field the user has just corrected trains people to
    // ignore the red.
    setErrors(prev => {
      const forItem = prev.items[index];
      if (!forItem || !(field in forItem)) return prev;
      const { [field as keyof ItemErrors]: _gone, ...rest } = forItem;
      return { ...prev, items: { ...prev.items, [index]: rest } };
    });
  };

  const addItem = () => {
    setItems([...items, { name: '', description: '', partNumber: '', qty: 1, unit: 'PCS', unitAmount: '', url: '', purpose: '', category: 'ELECTRONICS_GENERAL_ACCESSORIES' }]);
  };

  const bomFileRef = useRef<HTMLInputElement>(null);

  const handleBomUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const ALIASES: Record<string, string> = {
      name: 'name', componentname: 'name', itemname: 'name', component: 'name', partname: 'name',
      description: 'description', desc: 'description',
      partnumber: 'partNumber', manufacturerpartnumber1: 'partNumber', mpn: 'partNumber', mfgpart: 'partNumber', manufacturer1: 'manufacturer',
      qty: 'qty', quantity: 'qty', count: 'qty', physicalstockbalance: 'qty',
      unit: 'unit', uom: 'unit',
      unitprice: 'unitAmount', unitamount: 'unitAmount', price: 'unitAmount', cost: 'unitAmount',
      url: 'url', link: 'url', website: 'url', producturl: 'url',
      purpose: 'purpose', remark: 'purpose', remarks: 'purpose', note: 'purpose', notes: 'purpose',
      category: 'category', type: 'category',
      designator: 'designator',
    };

    // Match CSV/XLSX-supplied category strings against the canonical enum values.
    const VALID_CATEGORIES = new Set(CATEGORY_OPTIONS.map(o => o.value));
    const normalizeCategory = (raw?: string): string => {
      if (!raw) return 'ELECTRONICS_GENERAL_ACCESSORIES';
      const upper = String(raw).toUpperCase().replace(/[^A-Z0-9]/g, '_');
      if (VALID_CATEGORIES.has(upper)) return upper;
      // Best-effort fuzzy match on label words.
      const lc = String(raw).toLowerCase();
      const found = CATEGORY_OPTIONS.find(o => o.label.toLowerCase().includes(lc) || lc.includes(o.label.toLowerCase().split(' ')[0]));
      return found?.value || 'ELECTRONICS_GENERAL_ACCESSORIES';
    };

    const mapRow = (row: Record<string, any>): IndentItemForm | null => {
      const mapped: any = {};
      for (const [key, val] of Object.entries(row)) {
        const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        const alias = ALIASES[k];
        if (alias && val !== undefined && val !== null && String(val).trim()) mapped[alias] = String(val).trim();
      }
      if (!mapped.name && !mapped.description && !mapped.partNumber) return null;
      return {
        name: mapped.name || mapped.partNumber || '',
        description: mapped.description || '',
        partNumber: mapped.partNumber || '',
        qty: Math.max(1, Number(mapped.qty) || 1),
        unit: mapped.unit || 'PCS',
        unitAmount: Math.max(0, Number(mapped.unitAmount) || 0),
        url: mapped.url || '',
        purpose: mapped.purpose || 'Research',
        category: normalizeCategory(mapped.category),
      };
    };

    const isExcel = /\.(xlsx?|xls)$/i.test(file.name);
    if (isExcel) {
      // Hard cap on input size — the xlsx library has known prototype-pollution
      // + ReDoS advisories (GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9) and
      // bounded input is our cheapest mitigation while we plan a switch to
      // exceljs. 2 MB is comfortably above any legitimate BOM.
      if (file.size > 2 * 1024 * 1024) {
        addToast('Excel file too large (max 2 MB). Save a leaner copy or paste as CSV.', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const XLSX = await import('xlsx');
          const wb = XLSX.read(ev.target?.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          if (!ws) { addToast('No worksheet found in file', 'error'); return; }
          const rows: Record<string, any>[] = XLSX.utils.sheet_to_json(ws);
          // mapRow only reads explicit, known columns — even if a malicious
          // xlsx managed to inject prototype keys, none of them become part
          // of the IndentItemForm shape downstream.
          const parsed = rows.map(mapRow).filter(Boolean) as IndentItemForm[];
          if (parsed.length > 0) { setItems(parsed); addToast(`Loaded ${parsed.length} items from BOM`, 'success'); setIsBomUpload(true); }
          else addToast('No valid items found in file', 'error');
        } catch (e: any) { addToast(extractErrorMessage(e, 'Could not read Excel file'), 'error'); }
      };
      reader.readAsArrayBuffer(file);
    } else {
      const Papa = (await import('papaparse')).default;
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: (results) => {
          const parsed = (results.data as Record<string, any>[]).map(mapRow).filter(Boolean) as IndentItemForm[];
          if (parsed.length > 0) { setItems(parsed); addToast(`Loaded ${parsed.length} items from BOM`, 'success'); setIsBomUpload(true); }
          else addToast('No valid items found in CSV', 'error');
        },
        error: () => addToast('Failed to parse CSV', 'error'),
      });
    }
    e.target.value = '';
  };

  const removeItem = (index: number) => {
    if (items.length <= 1) return;
    setItems(items.filter((_, i) => i !== index));
    // Photos are keyed by row index, so deleting a row shifts every row after
    // it. Without re-keying, the photo staged for row 3 would end up on what
    // is now row 2 — attached to the wrong item, and silently.
    setPhotos(prev => {
      const next: Record<number, File> = {};
      for (const [k, file] of Object.entries(prev)) {
        const i = Number(k);
        if (i === index) continue;
        next[i > index ? i - 1 : i] = file;
      }
      return next;
    });
  };

  /**
   * Collect EVERY problem, not just the first.
   *
   * The old checks bailed on the first failure with a toast, so a form with
   * three things wrong took three submits to discover them. Returning the
   * whole map lets the user fix the lot in one pass.
   */
  const validate = (): { errs: FormErrors; firstBadId: string | null; count: number } => {
    const errs: FormErrors = { items: {} };
    let firstBadId: string | null = null;
    const mark = (id: string) => { if (!firstBadId) firstBadId = id; };

    if (!projectId) { errs.projectId = 'Pick a project, or "General / Others".'; mark('ind-project'); }
    if (!departmentId) { errs.departmentId = 'Pick a department.'; mark('ind-department'); }
    if (emergency && !emergencyReason.trim()) {
      errs.emergencyReason = 'Say why this needs to skip the regular queue.';
      mark('ind-emergency-reason');
    }

    // Per-item product URL rules. URL is optional, but WHEN provided it must be
    // a real http(s) link, and no two items may share the same URL — two
    // different products can't have the same product page. Matches the backend
    // format check (indents.service enforces both server-side too).
    const urlRe = /^https?:\/\/[^\s]+$/i;
    const seenUrls = new Map<string, number>(); // normalised url -> first item's 1-based index

    items.forEach((item, idx) => {
      const e: ItemErrors = {};
      if (!String(item.name || '').trim()) { e.name = 'Required.'; mark(`ind-item-${idx}-name`); }
      const q = Number(item.qty);
      if (!(q > 0)) { e.qty = 'Must be more than 0.'; mark(`ind-item-${idx}-qty`); }
      else if (Math.round(q * 100) !== q * 100) { e.qty = 'At most 2 decimals.'; mark(`ind-item-${idx}-qty`); }
      // The server refuses a blank unit; say so here rather than after submit.
      if (!String(item.unit || '').trim()) { e.unit = 'Required.'; mark(`ind-item-${idx}-unit`); }
      if (!item.category) { e.category = 'Required.'; mark(`ind-item-${idx}-category`); }
      if (!String(item.purpose || '').trim()) { e.purpose = 'Required.'; mark(`ind-item-${idx}-purpose`); }

      const raw = (item.url || '').trim();
      if (raw) {
        if (!urlRe.test(raw)) {
          e.url = 'Use a full http:// or https:// link.';
          mark(`ind-item-${idx}-url`);
        } else {
          const key = raw.toLowerCase();
          const first = seenUrls.get(key);
          if (first) {
            e.url = `Same link as item ${first}. Each product needs its own.`;
            mark(`ind-item-${idx}-url`);
          } else {
            seenUrls.set(key, idx + 1);
          }
        }
      }
      if (Object.keys(e).length) errs.items[idx] = e;
    });

    const count =
      (errs.projectId ? 1 : 0) + (errs.departmentId ? 1 : 0) + (errs.emergencyReason ? 1 : 0) +
      Object.values(errs.items).reduce((n, e) => n + Object.keys(e).length, 0);
    return { errs, firstBadId, count };
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const { errs, firstBadId, count } = validate();
    setErrors(errs);
    if (count > 0) {
      // Scroll to the first offender. A BOM of forty rows can easily put it
      // outside both this form's scroll box and the table's own, and a
      // message nobody can see is the problem we are fixing.
      if (firstBadId) {
        requestAnimationFrame(() => {
          const el = document.getElementById(firstBadId);
          el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          (el as HTMLElement | null)?.focus?.({ preventScroll: true });
        });
      }
      addToast(
        count === 1 ? 'One field needs fixing — it is highlighted below.'
                    : `${count} fields need fixing — they are highlighted below.`,
        'error',
      );
      return;
    }

    try {
      // Fallback to current user only if they're not the system super-admin.
      const fallbackResp = (user?.id && user.role !== UserRole.SUPER_ADMIN) ? [user.id] : [];
      const saved = await onSubmit({
        // "__OTHERS__" sentinel → null (not tied to a project)
        projectId: projectId === '__OTHERS__' ? null : projectId,
        departmentId,
        emergency,
        emergencyReason: emergency ? emergencyReason.trim() : undefined,
        currency,
        items: items.map(i => ({ ...i, currency, unitAmount: Number(i.unitAmount) || 0 })),
        grandTotal,
        responsiblePersonIds: responsiblePersonIds.length > 0 ? responsiblePersonIds : fallbackResp,
      });

      // Photos ride separately, once the lines have ids. A failure here must
      // never read as a failed indent — the indent IS raised.
      const staged = Object.entries(photos);
      if (staged.length > 0) {
        const indentId = saved?.id ?? saved?.data?.id;
        const savedLines: any[] = saved?.items ?? saved?.data?.items ?? [];
        if (!indentId || savedLines.length !== items.length) {
          addToast('Indent raised, but the photos could not be attached.', 'info');
        } else {
          let failed = 0;
          for (const [k, file] of staged) {
            const idx = Number(k);
            const line = savedLines[idx];
            if (!line?.id) { failed++; continue; }
            try {
              const body = new FormData();
              body.append('attachment', file);
              // The server checks this against the line it is about to write.
              // Rows are matched by position, and the create response has no
              // guaranteed order — so a disagreement is refused rather than
              // landing the photo on the wrong item.
              body.append('expectName', items[idx].name);
              await client.post(`/indents/${indentId}/items/${line.id}/attachment`, body, {
                // Named explicitly: the shared axios instance defaults to
                // 'application/json', which sends FormData as JSON and the
                // server parses no file.
                headers: { 'Content-Type': 'multipart/form-data' },
              });
            } catch { failed++; }
          }
          if (failed > 0) {
            addToast(`Indent raised. ${failed} photo${failed === 1 ? '' : 's'} did not attach.`, 'info');
          }
        }
      }
    } catch (error: any) {
      addToast(extractErrorMessage(error, 'Failed to raise indent'), 'error');
    }
  };

  // noValidate: the browser's own validation bubble is what used to swallow
  // these failures silently. Validation is ours now, and so is the reporting.
  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4 max-h-[70vh] overflow-y-auto p-1">
      {/* One shared datalist for every row's Unit box. A datalist SUGGESTS
          without constraining, which is what this needs — the list comes from
          existing stock, and a genuinely new unit must still be typeable. */}
      <datalist id="indent-unit-options">
        {unitOptions.map((u) => <option key={u} value={u} />)}
      </datalist>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Project *</label>
          <select id="ind-project" value={projectId}
            onChange={(e) => { setProjectId(e.target.value); setErrors(p => ({ ...p, projectId: undefined })); }}
            aria-invalid={!!errors.projectId}
            className={`w-full border rounded-md py-2 px-3 text-sm outline-none ${ring(errors.projectId)}`}>
            <option value="">-- Select Project --</option>
            {projects.filter((p: any) => p.isActive !== false).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="__OTHERS__">General / Others (not project-specific)</option>
          </select>
          <FieldError msg={errors.projectId} />
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Department *</label>
          <select id="ind-department" value={departmentId}
            onChange={(e) => { setDepartmentId(e.target.value); setErrors(p => ({ ...p, departmentId: undefined })); }}
            // Locked when editing too: the slip update deliberately ignores a
            // department change (it would move the indent to other approvers),
            // so an editable picker here changed nothing.
            disabled={!!user?.departmentId || !!initialValues}
            aria-invalid={!!errors.departmentId}
            className={`w-full border rounded-md py-2 px-3 text-sm outline-none disabled:bg-surface disabled:text-ink ${ring(errors.departmentId)}`}>
            <option value="">-- Select Department --</option>
            {departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <FieldError msg={errors.departmentId} />
          {initialValues
            ? <p className="text-[10px] text-faint mt-0.5">Can't be changed on an existing indent</p>
            : user?.departmentId && departmentId
              ? <p className="text-[10px] text-faint mt-0.5">Auto-set from your profile</p>
              : homeDeptId && departmentId === homeDeptId && <p className="text-[10px] text-faint mt-0.5">Your team — change it if this is for another department</p>}
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Currency</label>
          <select
            value={currency}
            onChange={async (e) => {
              const next = e.target.value;
              if (next === currency) return;
              // Item prices were entered in the previous currency; carrying
              // them over after a change would silently submit mismatched
              // money. Confirm with the user, then clear the unit amounts
              // so they re-enter at the new currency.
              const hasPriced = items.some(i => Number(i.unitAmount) > 0);
              if (hasPriced && !(await confirm(
                `Changing currency from ${currency} to ${next} will clear all unit prices on this indent so you can re-enter them in ${next}. Continue?`
              ))) {
                return;
              }
              setCurrency(next);
              if (hasPriced) {
                setItems(prev => prev.map(i => ({ ...i, unitAmount: '' })));
                addToast(`Unit prices cleared — please re-enter in ${next}.`, 'info');
              }
            }}
            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none"
          >
            <option value="INR">INR (₹)</option>
            <option value="USD">USD ($)</option>
            <option value="EUR">EUR (€)</option>
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center">
          <input id="emergency" type="checkbox" checked={emergency} onChange={(e) => {
            setEmergency(e.target.checked);
            if (!e.target.checked) setEmergencyReason('');
          }}
            className="h-4 w-4 text-red-700 dark:text-red-300 border-line rounded" />
          <label htmlFor="emergency" className="ml-2 text-sm text-ink">
            Mark as <span className="font-bold text-red-700 dark:text-red-300">Emergency</span>
            <span className="text-xs text-muted ml-1">— still requires normal approvals, but shown as priority to Finance & Procurement.</span>
          </label>
        </div>
        {emergency && (
          <div className="pl-6 animate-in fade-in">
            <label className="block text-xs font-bold text-red-700 dark:text-red-300 mb-1">Reason for emergency *</label>
            <textarea
              id="ind-emergency-reason"
              value={emergencyReason}
              onChange={(e) => { setEmergencyReason(e.target.value); setErrors(p => ({ ...p, emergencyReason: undefined })); }}
              rows={2}
              aria-invalid={!!errors.emergencyReason}
              placeholder="Why does this need to skip the regular queue? (e.g. live demo tomorrow, broken safety gear, …)"
              className={`w-full border rounded-md py-1.5 px-3 text-sm outline-none ${errors.emergencyReason ? 'border-red-500 bg-red-50 dark:bg-red-400/15 focus:border-red-500' : 'border-red-300 dark:border-red-400/30 focus:border-red-500'}`}
            />
            <FieldError msg={errors.emergencyReason} />
          </div>
        )}
      </div>

      <UserMultiSelect 
        usersDirectory={usersDirectory} 
        responsiblePersonIds={responsiblePersonIds} 
        setResponsiblePersonIds={setResponsiblePersonIds} 
        user={user} 
        departmentId={departmentId} 
      />

      <div className="space-y-3 pt-4">
        <h3 className="text-sm font-bold text-ink border-b pb-2">Items</h3>
        {isBomUpload ? (() => {
          // Dynamically determine which columns have data
          const hasDesc = items.some(i => i.description);
          const hasPart = items.some(i => i.partNumber);
          const hasUrl = items.some(i => i.url);
          const hasPrice = items.some(i => Number(i.unitAmount) > 0);
          const inp = "w-full border border-line rounded py-1 px-2 text-sm focus:border-brand outline-none";
          return (
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-muted">{items.length} items loaded from BOM</p>
              <button type="button" onClick={() => { setIsBomUpload(false); setItems([{ name: '', description: '', partNumber: '', qty: 1, unit: 'PCS', unitAmount: '', url: '', purpose: '', category: 'ELECTRONICS_GENERAL_ACCESSORIES' }]); }}
                className="text-xs text-red-700 dark:text-red-300 hover:underline font-bold">Clear BOM</button>
            </div>
            <div className="overflow-x-auto border border-line rounded-lg max-h-[40vh] overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-surface border-b border-line sticky top-0">
                  <tr className="text-[10px] text-muted uppercase">
                    <th className="py-2 px-2 font-bold w-8">#</th>
                    <th className="py-2 px-2 font-bold min-w-[160px]">Name *</th>
                    {hasDesc && <th className="py-2 px-2 font-bold min-w-[200px]">Description</th>}
                    {hasPart && <th className="py-2 px-2 font-bold min-w-[120px]">Part Number</th>}
                    <th className="py-2 px-2 font-bold min-w-[70px]">Qty</th>
                    <th className="py-2 px-2 font-bold min-w-[70px]">Unit</th>
                    {hasPrice && <th className="py-2 px-2 font-bold min-w-[80px]">Price</th>}
                    {hasUrl && <th className="py-2 px-2 font-bold min-w-[120px]">URL</th>}
                    <th className="py-2 px-2 font-bold min-w-[140px]">Category *</th>
                    <th className="py-2 px-2 font-bold min-w-[90px]">Purpose</th>
                    <th className="py-2 px-2 w-8"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => (
                    <tr key={idx} className="border-b border-line-soft hover:bg-hover/50 text-xs">
                      <td className="p-1 px-2 text-faint font-mono">{idx + 1}</td>
                      <td className="p-1 px-2 align-top">
                        <input id={`ind-item-${idx}-name`} type="text" value={item.name}
                          onChange={e => handleItemChange(idx, 'name', e.target.value)}
                          aria-invalid={!!errors.items[idx]?.name}
                          className={`w-full border rounded py-1 px-2 text-sm outline-none ${ring(errors.items[idx]?.name)}`} />
                        <FieldError msg={errors.items[idx]?.name} />
                      </td>
                      {hasDesc && <td className="p-1 px-2">
                        <input type="text" value={item.description} onChange={e => handleItemChange(idx, 'description', e.target.value)} className={inp} />
                      </td>}
                      {hasPart && <td className="p-1 px-2">
                        <input type="text" value={item.partNumber} onChange={e => handleItemChange(idx, 'partNumber', e.target.value)} className={`${inp} font-mono text-xs`} />
                      </td>}
                      <td className="p-1 px-2 align-top">
                        <NumberInput id={`ind-item-${idx}-qty`} min={0} value={item.qty} onChange={(v) => handleItemChange(idx, 'qty', v)}
                          className={`w-full border rounded py-1 px-2 text-sm outline-none ${ring(errors.items[idx]?.qty)}`} />
                        <FieldError msg={errors.items[idx]?.qty} />
                      </td>
                      <td className="p-1 px-2 align-top">
                        <input id={`ind-item-${idx}-unit`} type="text" list="indent-unit-options" value={item.unit} onChange={e => handleItemChange(idx, 'unit', e.target.value)}
                          aria-invalid={!!errors.items[idx]?.unit}
                          className={`w-full border rounded py-1 px-2 text-sm outline-none ${ring(errors.items[idx]?.unit)}`} placeholder="PCS" />
                        <FieldError msg={errors.items[idx]?.unit} />
                      </td>
                      {hasPrice && <td className="p-1 px-2">
                        <NumberInput min={0} step={0.01} value={Number(item.unitAmount) || 0} onChange={(v) => handleItemChange(idx, 'unitAmount', v)} className={inp} />
                      </td>}
                      {hasUrl && <td className="p-1 px-2 align-top">
                        <input id={`ind-item-${idx}-url`} type="url" value={item.url}
                          onChange={e => handleItemChange(idx, 'url', e.target.value)}
                          aria-invalid={!!errors.items[idx]?.url}
                          className={`w-full border rounded py-1 px-2 text-sm outline-none ${ring(errors.items[idx]?.url)}`} placeholder="https://..." />
                        <FieldError msg={errors.items[idx]?.url} />
                      </td>}
                      <td className="p-1 px-2 align-top">
                        <select id={`ind-item-${idx}-category`} value={item.category}
                          onChange={e => handleItemChange(idx, 'category', e.target.value)}
                          aria-invalid={!!errors.items[idx]?.category}
                          className={`w-full border rounded py-1 px-2 text-sm outline-none ${ring(errors.items[idx]?.category)}`}>
                          {CATEGORY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                        </select>
                        <FieldError msg={errors.items[idx]?.category} />
                      </td>
                      <td className="p-1 px-2 align-top">
                        <input id={`ind-item-${idx}-purpose`} type="text" value={item.purpose}
                          onChange={e => handleItemChange(idx, 'purpose', e.target.value)}
                          aria-invalid={!!errors.items[idx]?.purpose}
                          className={`w-full border rounded py-1 px-2 text-sm outline-none ${ring(errors.items[idx]?.purpose)}`} placeholder="Research" />
                        <FieldError msg={errors.items[idx]?.purpose} />
                      </td>
                      <td className="p-1 px-2 text-center">
                        <button type="button" onClick={() => removeItem(idx)} className="text-red-400 hover:text-red-700 dark:text-red-300 text-xs font-bold">✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          );
        })() : (
          <div className="space-y-3">
            {items.map((item, index) => (
              <div key={index} className="p-3 bg-surface border border-line rounded-lg space-y-3 relative">
                {items.length > 1 && (
                  <button type="button" onClick={() => removeItem(index)} className="absolute top-2 right-2 text-red-400 hover:text-red-700 dark:text-red-300 text-xs font-bold">✕</button>
                )}
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pr-6">
                  <div className="col-span-2">
                    <label className="block text-xs font-bold text-muted mb-1">Item Name *</label>
                    <input id={`ind-item-${index}-name`} type="text" value={item.name}
                      onChange={(e) => handleItemChange(index, 'name', e.target.value)}
                      aria-invalid={!!errors.items[index]?.name}
                      className={`w-full border rounded-md py-1.5 px-3 text-sm outline-none ${ring(errors.items[index]?.name)}`} />
                    <FieldError msg={errors.items[index]?.name} />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-bold text-muted mb-1">Description</label>
                    <input type="text" value={item.description} onChange={(e) => handleItemChange(index, 'description', e.target.value)}
                      className="w-full border border-line rounded-md py-1.5 px-3 text-sm focus:border-brand outline-none" placeholder="Optional" />
                  </div>
                  {/* Optional, per line. One indent routinely lists several
                      unrelated parts, so a photo belongs to the item it shows —
                      procurement reads these while sourcing. */}
                  <div className="col-span-2">
                    <label className="block text-xs font-bold text-muted mb-1">
                      Photo <span className="font-normal text-faint">(optional)</span>
                    </label>
                    <input
                      id={`indent-photo-${index}`}
                      type="file"
                      accept={PHOTO_VIDEO_ACCEPT}
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        if (f && f.size > 25 * 1024 * 1024) {
                          addToast('That file is over 25 MB — pick a smaller one.', 'error');
                          e.target.value = '';
                          return;
                        }
                        setPhotoAt(index, f);
                      }}
                    />
                    {photos[index] ? (
                      <div className="flex items-center gap-2 text-xs min-w-0">
                        {/* Truncates to the room actually available rather than a
                            fixed 200px, which cut names short in a wide column and
                            still overflowed a narrow one. */}
                        <span className="truncate text-ink" title={photos[index].name}>{photos[index].name}</span>
                        <button type="button"
                          onClick={() => {
                            setPhotoAt(index, null);
                            const el = document.getElementById(`indent-photo-${index}`) as HTMLInputElement | null;
                            if (el) el.value = '';
                          }}
                          className="text-red-700 dark:text-red-300 hover:underline font-bold shrink-0">Remove</button>
                      </div>
                    ) : (
                      <button type="button"
                        onClick={() => document.getElementById(`indent-photo-${index}`)?.click()}
                        className="text-xs font-bold text-brand-dark hover:underline">+ Attach a photo</button>
                    )}
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-muted mb-1">Part Number</label>
                    <input type="text" value={item.partNumber} onChange={(e) => handleItemChange(index, 'partNumber', e.target.value)}
                      className="w-full border border-line rounded-md py-1.5 px-3 text-sm font-mono focus:border-brand outline-none" placeholder="MPN" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-muted mb-1">Category *</label>
                    <select id={`ind-item-${index}-category`} value={item.category}
                      onChange={(e) => handleItemChange(index, 'category', e.target.value)}
                      aria-invalid={!!errors.items[index]?.category}
                      className={`w-full border rounded-md py-1.5 px-3 text-sm outline-none ${ring(errors.items[index]?.category)}`}>
                      {CATEGORY_OPTIONS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                    <FieldError msg={errors.items[index]?.category} />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-muted mb-1">Qty *</label>
                    <div className="flex">
                      <NumberInput
                        id={`ind-item-${index}-qty`}
                        min={0}
                        value={item.qty}
                        onChange={(v) => handleItemChange(index, 'qty', v)}
                        className={`w-3/5 border border-r-0 rounded-l-md py-1.5 px-2 text-sm outline-none ${ring(errors.items[index]?.qty)}`}
                      />
                      {/* 2/5 rather than 1/3, and text-sm not text-xs: a unit
                          like "ROLL" or "Pack" was being clipped to "rol" in
                          the narrower box. */}
                      <input type="text" list="indent-unit-options" value={item.unit}
                        onChange={(e) => handleItemChange(index, 'unit', e.target.value)}
                        className="w-2/5 border border-line rounded-r-md py-1.5 px-2 text-sm bg-surface focus:border-brand outline-none" placeholder="Unit" />
                    </div>
                    <FieldError msg={errors.items[index]?.qty} />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-muted mb-1">Unit Price ({currency})</label>
                    <NumberInput
                      min={0}
                      step={0.01}
                      value={Number(item.unitAmount) || 0}
                      onChange={(v) => handleItemChange(index, 'unitAmount', v)}
                      className="w-full border border-line rounded-md py-1.5 px-3 text-sm focus:border-brand outline-none"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-bold text-muted mb-1">Product URL</label>
                    <input id={`ind-item-${index}-url`} type="url" value={item.url}
                      onChange={(e) => handleItemChange(index, 'url', e.target.value)}
                      aria-invalid={!!errors.items[index]?.url}
                      className={`w-full border rounded-md py-1.5 px-3 text-sm outline-none ${ring(errors.items[index]?.url)}`} placeholder="https://..." />
                    <FieldError msg={errors.items[index]?.url} />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs font-bold text-muted mb-1">Purpose *</label>
                    <input id={`ind-item-${index}-purpose`} type="text" value={item.purpose}
                      onChange={(e) => handleItemChange(index, 'purpose', e.target.value)}
                      aria-invalid={!!errors.items[index]?.purpose}
                      className={`w-full border rounded-md py-1.5 px-3 text-sm outline-none ${ring(errors.items[index]?.purpose)}`} />
                    <FieldError msg={errors.items[index]?.purpose} />
                  </div>
                </div>
                <div className="text-right text-xs font-bold text-muted">
                   Line: {currency} {(item.qty * (Number(item.unitAmount) || 0)).toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button type="button" onClick={addItem} className="text-xs font-bold text-brand hover:underline">+ Add Item</button>
          <span className="text-xs text-faint">or</span>
          <button type="button" onClick={() => bomFileRef.current?.click()} className="text-xs font-bold text-blue-600 dark:text-blue-300 hover:underline">Upload BOM (CSV/XLSX)</button>
          <input ref={bomFileRef} type="file" accept={`${SHEET_ACCEPT},.tsv`} onChange={handleBomUpload} className="hidden" />
        </div>
      </div>

      {grandTotal > 0 && (
        <div className="border-t pt-3 flex justify-between items-center bg-surface p-3 rounded-md">
          <span className="font-bold text-ink">Grand Total:</span>
          <span className={`text-lg font-bold ${emergency && grandTotal >= 1000 ? 'text-red-700 dark:text-red-300' : 'text-ink'}`}>{currency} {grandTotal.toFixed(2)}</span>
        </div>
      )}

      <div className="flex justify-end pt-2">
        <button type="submit" disabled={isLoading}
          className="bg-brand text-white px-6 py-2 rounded-full font-bold text-sm hover:bg-brand-dark disabled:opacity-50">
          {isLoading ? 'Submitting...' : (submitLabel || 'Submit Indent')}
        </button>
      </div>
    </form>
  );
};
