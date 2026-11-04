import { useState, FormEvent, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useConfirm, useToast } from '../../context';
import { useAuth, useFormBootstrap } from '../../hooks';
import { Nature, DurationUnit, InventoryItem } from '../../types';
import { client } from '../../api';
import { extractErrorMessage } from '@/lib';
import { UserMultiSelect, NumberInput } from '../ui';
import { UserRole } from '@/types';
import { PHOTO_VIDEO_ACCEPT } from '@/lib/fileAccept';
import { homeDepartmentId } from '@/lib/homeDepartment';

/** The subset of an inventory item a picker needs. */
export interface RequestFormItem {
  id: string;
  name: string;
  unit?: string | null;
  stock?: number | null;
  category?: string | null;
  departmentId?: string | null;
  status?: string | null;
}

interface RequestFormProps {
  item?: InventoryItem;
  /**
   * The item list to pick from — only the fields this dropdown actually reads.
   *
   * Deliberately NOT InventoryItem[]: that demands createdAt/updatedAt, which
   * forced callers to fetch whole rows (with their department join) just to
   * render a <select>. The complete-list endpoint /inventory/options returns
   * exactly this narrow shape for EVERY scoped item, which is what lets the
   * picker stop truncating at 200.
   */
  availableItems: RequestFormItem[];
  /**
   * True when `availableItems` hit the server's ceiling instead of being
   * everything the caller can see.
   *
   * /inventory/options stops at 5,000 rows ordered by name and reports
   * `truncated`. Nothing read that flag, so past the ceiling this dropdown
   * would quietly lose everything late in the alphabet — the exact failure the
   * endpoint was built to end, just moved from 200 to 5,000. A silently short
   * list is indistinguishable from a missing item, which is why it has to be
   * said out loud rather than left for someone to discover.
   */
  optionsTruncated?: boolean;
  /** How many items are in scope, so the notice can say how many are hidden. */
  optionsTotal?: number;
  /**
   * Create the request. Should RESOLVE WITH THE CREATED REQUEST (or anything
   * carrying its `id`) — the optional photo is uploaded to
   * `POST /requests/:id/attachment`, which cannot be called until the row
   * exists. A caller that returns nothing still works; the form just says the
   * photo could not be attached rather than dropping it silently.
   */
  onSubmit: (data: any) => Promise<any>;
  isLoading: boolean;
}

export const RequestForm = ({ item, availableItems, optionsTruncated, optionsTotal, onSubmit, isLoading }: RequestFormProps) => {
  const { addToast } = useToast();
  const { user } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  // Duplicate-request guard. When the user tries to raise a request for an item
  // they already have an open (PENDING/APPROVED) request for, we route them to
  // their requests table with that item highlighted (?dupItem=) — nudging them
  // to EDIT the quantity instead of stacking a fifth identical request (the
  // original bug) rather than creating yet another row.
  const [inventoryItemId, setInventoryItemId] = useState(item?.id || '');
  const [qtyRequested, setQtyRequested] = useState<number>(1);
  const [projectId, setProjectId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [nature, setNature] = useState<Nature>(Nature.TEMPORARY);
  const [durationValue, setDurationValue] = useState<number>(1);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>(DurationUnit.DAYS);

  // Optional photo, staged until the request exists. The upload endpoint is
  // keyed on the request id, so it cannot be sent in the same call.
  const [photo, setPhoto] = useState<File | null>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const [responsiblePersonIds, setResponsiblePersonIds] = useState<string[]>([]);


  const isRegularUser = user?.role === UserRole.USER || user?.role === UserRole.MANAGER || user?.role === UserRole.LAB;

  useEffect(() => {
    if (user?.departmentId) setDepartmentId(user.departmentId);
    // SUPER_ADMIN is a system account, not a person — don't auto-add as responsible.
    if (user?.id && user.role !== UserRole.SUPER_ADMIN) setResponsiblePersonIds([user.id]);
  }, [user]);

  // Projects, departments and the user directory — see useFormBootstrap.
  // Shared with the other form so a failure surfaces in both, instead of
  // leaving whichever one nobody fixed with silently empty dropdowns.
  const { projects, departments, usersDirectory } = useFormBootstrap();

  // Finance / Procurement / Inventory have no department on their record; their
  // own needs default to their team's department. Still changeable — they also
  // raise for the departments they serve.
  const homeDeptId = user?.departmentId ? '' : homeDepartmentId(user?.role, departments);
  useEffect(() => {
    if (homeDeptId) setDepartmentId((cur) => cur || homeDeptId);
  }, [homeDeptId]);

  /**
   * The options actually offered, with the preselected item guaranteed present.
   *
   * `availableItems` is capped by /inventory/options. When this form is opened
   * FOR a specific item — the notification deep links, the table's Request
   * button — that item may sit past the cap, and the <select> then had no
   * <option> to match: it rendered "-- Select Item --", disabled, with no way
   * to proceed. A modal that names an item and then cannot show it is worse
   * than the error it replaced, so the item is folded in rather than assumed
   * to be in the list.
   */
  /**
   * Typing searches the SERVER, not the list already in the browser.
   *
   * The picker used to be handed every item the user can see and filter them
   * locally. That works only while the whole catalogue fits in one download:
   * the endpoint stops at 5,000 rows, so past that the item genuinely is not
   * in the box and no amount of typing finds it — the same failure the 200-row
   * cap caused before, just further away. It also means every open of this
   * modal waits for the entire catalogue.
   *
   * `/inventory/options?search=` already does this server-side and always has;
   * the page simply never called it. Asking the server means it returns the
   * handful that match, so the ceiling stops mattering.
   */
  const [itemSearch, setItemSearch] = useState('');
  const [searchHits, setSearchHits] = useState<RequestFormItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  /** How many matched in total vs how many we asked for, so a capped search
   *  can say so instead of looking like the whole answer. */
  const [searchMeta, setSearchMeta] = useState<{ truncated: boolean } | null>(null);

  /** Trigram indexes are built from 3-character grams, so a 1-2 character
   *  term cannot use the index and degrades to a full scan — and returns a
   *  useless flood anyway. Gate the QUERY, not the individual words: dropping
   *  short words from the AND would break "22 AWG" and "sd card", which are
   *  exactly what people type into a parts catalogue. */
  const MIN_SEARCH_CHARS = 3;
  const SEARCH_PAGE = 50;

  useEffect(() => {
    const term = itemSearch.trim();
    if (!term) { setSearchHits(null); setSearchMeta(null); setSearching(false); return; }
    if (term.length < MIN_SEARCH_CHARS) { setSearchHits(null); setSearchMeta(null); setSearching(false); return; }
    // Debounced: a request per keystroke would put "s", "si", "sil" … on the
    // wire and let a slow earlier reply overwrite a later one.
    setSearching(true);
    let alive = true;
    const t = setTimeout(async () => {
      try {
        // Ask for ONE page, not the catalogue. Without `take` this returned up
        // to the server's 5,000-row ceiling for a dropdown that shows a dozen.
        const res = await client.get('/inventory/options', {
          params: { search: term, take: SEARCH_PAGE },
        });
        const payload = res.data?.data ?? res.data;
        const items = payload?.items ?? [];
        if (alive) {
          setSearchHits(items);
          // No `total` any more: counting every match cost a second full pass
          // per keystroke. The notice says there ARE more, not how many.
          setSearchMeta({ truncated: !!(payload?.hasMore ?? payload?.truncated) });
        }
      } catch {
        // Leave the previous hits rather than blanking the box on a blip.
      } finally {
        if (alive) setSearching(false);
      }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [itemSearch]);

  const itemOptions = useMemo<RequestFormItem[]>(() => {
    // While searching, show what the server returned. With an empty box, show
    // the list the page was given — so the dropdown is never blank on open.
    const base = searchHits ?? availableItems;
    if (!item) return base;
    return base.some(i => i.id === item.id)
      ? base
      : [item as RequestFormItem, ...base];
  }, [availableItems, searchHits, item]);

  const selectedItem = itemOptions.find(i => i.id === inventoryItemId);

  // "Claims" = received indents I raised for this item. They tell me how much
  // I originally asked for + how much procurement actually bought, so I know
  // the real ceiling I can claim before tapping into the general pool.
  const [myClaims, setMyClaims] = useState<any[]>([]);
  // Track whether the user has manually changed qty / project. If they have,
  // we stop auto-filling so we don't clobber their edits when claims load.
  const [qtyTouched, setQtyTouched] = useState(false);
  const [projectTouched, setProjectTouched] = useState(false);
  useEffect(() => {
    if (!inventoryItemId) { setMyClaims([]); return; }
    let cancelled = false;
    client.get('/indents/my-claims', { params: { inventoryItemId } })
      .then(res => { if (!cancelled) setMyClaims(res.data?.data || res.data || []); })
      .catch(() => { if (!cancelled) setMyClaims([]); });
    return () => { cancelled = true; };
  }, [inventoryItemId]);

  // When opening for an item the user has a single past claim on (the common
  // "Indent received → click notification → fill request" path), pre-fill the
  // qty and project from that claim so the form arrives ready to submit but
  // still fully editable — if needs grew or shrunk between raise + receive,
  // the user can override either field.
  useEffect(() => {
    if (myClaims.length !== 1) return;
    const c = myClaims[0];
    if (!qtyTouched && Number(c.claimableQty) > 0) {
      setQtyRequested(Number(c.claimableQty));
    }
    if (!projectTouched && c.projectId) {
      // Only adopt the claim's project if it's still in the projects list —
      // otherwise the <select> shows a broken value. Fall back to "Others".
      const stillExists = projects.some((p: any) => p.id === c.projectId);
      setProjectId(stillExists ? c.projectId : '__OTHERS__');
    } else if (!projectTouched && c.projectId === null) {
      // Indent was raised under General/Others — carry that through.
      setProjectId('__OTHERS__');
    }
  }, [myClaims, projects, qtyTouched, projectTouched]);

  // The requester's editable requests table — LAB's lives under /lab/indents,
  // USER/MANAGER under /<role>/ip-requests. Used to route the duplicate-guard's
  // "Edit existing" action.
  const myRequestsPath = () =>
    user?.role === UserRole.LAB ? '/lab/indents' : `/${(user?.role || 'user').toLowerCase().replace(/_/g, '-')}/ip-requests`;

  // Set before the first await below. The duplicate checks run two GETs before
  // the parent flips isLoading, so a double-click passed both and raised the
  // same request twice.
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await submitRequest();
    } finally {
      setSubmitting(false);
    }
  };

  const submitRequest = async () => {
    if (!inventoryItemId) { addToast('Select an item', 'error'); return; }
    if (!projectId) { addToast('Select a project (or "General / Others")', 'error'); return; }
    if (!departmentId) { addToast('Select a department', 'error'); return; }
    if (!(qtyRequested > 0)) { addToast('Enter a quantity greater than zero', 'error'); return; }
    if (Math.round(qtyRequested * 100) !== qtyRequested * 100) { addToast('Quantity can have at most 2 decimal places', 'error'); return; }
    if (selectedItem && qtyRequested > (selectedItem.stock ?? 0)) {
      addToast(`Only ${(selectedItem.stock ?? 0)} available in stock.`, 'error');
      return;
    }

    const fallbackResp = (user?.id && user.role !== UserRole.SUPER_ADMIN) ? [user.id] : [];
    const payload = {
      inventoryItemId,
      qtyRequested,
      // "__OTHERS__" sentinel → null (not tied to a project)
      projectId: projectId === '__OTHERS__' ? null : projectId,
      departmentId,
      nature,
      durationValue: nature === Nature.TEMPORARY ? durationValue : 0,
      durationUnit: nature === Nature.TEMPORARY ? durationUnit : DurationUnit.DAYS,
      responsiblePersonIds: responsiblePersonIds.length > 0 ? responsiblePersonIds : fallbackResp,
    };

    // Duplicate guard — only for roles that HAVE an editable requests table to
    // route to (USER/MANAGER/LAB). Look for the user's OWN open (PENDING/
    // APPROVED) requests on this exact item; if any exist, send them to that
    // table with the item highlighted (?dupItem=) so they edit the quantity
    // instead of stacking another identical request. A failed or empty check
    // just falls through to a normal submit — the guard can never block a
    // legitimate request.
    // The same item sitting on one of your own BOMs that has not been decided
    // yet. The ComponentRequest check below cannot see those: a BOM does not
    // become requests until it is ROUTED, which is after approval, so for the
    // whole time a BOM waits its lines are invisible and the same person could
    // ask for the same part twice without a word.
    //
    // A confirmation rather than the redirect used below, because a submitted
    // BOM is not editable the way an open request is — there may be nothing to
    // go and change. Asking twice can be perfectly deliberate, so this informs
    // and gets out of the way; only an explicit Cancel stops the request.
    //
    // Best-effort: any failure falls through to a normal submit. A guard that
    // blocks a legitimate request because a lookup failed is worse than the
    // duplicate it prevents.
    try {
      const bomRes = await client.get(`/bom-lists/open-for-item/${inventoryItemId}`);
      const boms: any[] = bomRes.data?.data ?? bomRes.data ?? [];
      if (Array.isArray(boms) && boms.length > 0) {
        const lines = boms
          .map((b) => `${b.serialNo}${b.name ? ` (${b.name})` : ''} — ${b.qty} ${b.unit || ''}`.trim())
          .join('\n');
        const go = await confirm({
          title: 'Already on a BOM of yours',
          message: `This component is on ${boms.length === 1 ? 'a list' : 'lists'} you raised that ${boms.length === 1 ? 'is' : 'are'} still awaiting a decision:\n\n${lines}\n\nRaising this request as well means asking for it twice. Continue?`,
          confirmLabel: 'Raise it anyway',
          cancelLabel: 'Go back',
        });
        if (!go) return;
      }
    } catch { /* non-fatal — proceed to the request check */ }

    if (['USER', 'MANAGER', 'LAB'].includes(user?.role || '')) {
      try {
        const res = await client.get('/requests', {
          params: { createdByMe: true, status: 'PENDING,APPROVED', inventoryItemId },
        });
        const rows: any[] = res.data?.data?.items ?? res.data?.items ?? [];
        // createdByMe also matches rows where the user is only a responsible
        // person; restrict to ones they actually OWN (those are editable).
        const mine = rows.filter((r) => r.createdById === user?.id);
        if (mine.length > 0) {
          // Carry the attempted payload along so the table can offer a
          // "raise it anyway" escape hatch (POST it as-is) without making the
          // user re-key everything. Lost harmlessly if they just edit instead.
          navigate(`${myRequestsPath()}?dupItem=${inventoryItemId}`, { state: { dupPayload: payload } });
          return;
        }
      } catch { /* non-fatal — proceed to submit */ }
    }

    const created = await onSubmit(payload);

    // The photo rides separately, after the row exists. A failure here must not
    // read as a failed request — the request IS raised, and the user can add
    // the photo from Revise. Say exactly that instead of a bare error.
    if (photo) {
      const newId = created?.id ?? created?.data?.id ?? created?.data?.data?.id;
      if (!newId) {
        addToast('Request raised, but the photo could not be attached — add it from Revise.', 'info');
      } else {
        try {
          const body = new FormData();
          body.append('attachment', photo);
          // Named explicitly: the shared axios instance defaults to
          // 'application/json', which would send the FormData as JSON and the
          // server would parse no file.
          await client.post(`/requests/${newId}/attachment`, body, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
        } catch (e: any) {
          addToast(extractErrorMessage(e, 'Request raised, but the photo did not upload — add it from Revise.'), 'info');
        }
      }
    }
  };

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-bold text-muted mb-1">Inventory Item *</label>
        {/* A capped SEARCH has to say so too. The server matches across the
            whole catalogue but now returns one page of it, so silence here
            would be the same silent-truncation bug in a new place: the item
            exists, it matched, and it is not on screen. */}
        {searchMeta?.truncated && !item && (
          <p className="mb-2 rounded-md border border-brand-200 bg-brand-50 px-3 py-2 text-xs text-secondary">
            Showing the best {SEARCH_PAGE} matches — keep typing to narrow it down.
          </p>
        )}
        {/* Only while the box is EMPTY. Once you are searching, the message
            above covers it — and telling someone to go and search elsewhere
            while they are already searching is the opposite of helpful. */}
        {optionsTruncated && !item && !searchHits && (
          <p className="mb-2 rounded-md border border-amber-300 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
            <span className="font-bold">This list is not complete.</span>{' '}
            Showing the first {availableItems.length.toLocaleString()} items by name
            {typeof optionsTotal === 'number' && optionsTotal > availableItems.length
              ? <> — {(optionsTotal - availableItems.length).toLocaleString()} more are not listed here</>
              : null}.
            {' '}If you can't find your item, open <span className="font-bold">Inventory</span>, search for it there,
            and use its <span className="font-bold">Request</span> button — that search covers everything.
          </p>
        )}
        {/* Hidden when the form was opened FOR a specific item: there is
            nothing to search for, and the select is disabled anyway. */}
        {!item && (
          <div className="relative mb-1.5">
            <input
              type="text"
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
              placeholder="Search all items by name…"
              className="w-full border border-line rounded-md py-2 pl-3 pr-16 text-sm focus:border-brand outline-none"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-faint">
              {searching ? 'searching…' : searchHits ? `${searchHits.length} found` : ''}
            </span>
          </div>
        )}
        <select required value={inventoryItemId} onChange={(e) => setInventoryItemId(e.target.value)} disabled={!!item}
          className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none disabled:bg-surface">
          <option value="">
            {searchHits && searchHits.length === 0 && !searching ? 'No item matches that search' : '-- Select Item --'}
          </option>
          {itemOptions.map((i) => (
            <option key={i.id} value={i.id}>{i.name} (Stock: {i.stock} {i.unit})</option>
          ))}
        </select>
      </div>

      {myClaims.length > 0 && (
        <div className="bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-300 dark:border-emerald-400/30 rounded-md p-3 text-xs">
          <p className="font-bold text-emerald-900 dark:text-emerald-200 mb-1.5">Your claim{myClaims.length > 1 ? 's' : ''} from past indents</p>
          <ul className="space-y-1.5 text-emerald-900 dark:text-emerald-200">
            {myClaims.map((c: any) => {
              const claimable = Number(c.claimableQty ?? Math.min(c.originalQty, c.purchasedQty));
              const purchased = Number(c.purchasedQty);
              const original = Number(c.originalQty);
              const toGeneral = Number(c.toGeneralStockQty ?? 0);
              const shortPurchase = purchased < original;
              return (
                <li key={c.indentId + ':' + c.itemName} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-bold">{c.indentSerial}</span>
                  <span>·</span>
                  <span>
                    Reserved for you: <span className="font-mono font-bold">{claimable}</span> {c.unit}
                    {toGeneral > 0 && <> · in general stock: <span className="font-mono">{toGeneral}</span> {c.unit}</>}
                  </span>
                  {shortPurchase && (
                    <span
                      className="text-amber-700 dark:text-amber-300 font-bold cursor-help"
                      title={`You asked for ${original} ${c.unit}; procurement could only secure ${purchased}.`}
                    >⚠ partial</span>
                  )}
                  <button type="button" onClick={() => { setQtyRequested(claimable); setQtyTouched(true); }}
                    className="ml-auto text-[10px] font-bold text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:text-emerald-200 underline">
                    Use {claimable}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
         <div>
          <label className="block text-sm font-bold text-muted mb-1">Quantity *</label>
          {/* No max: clamping a typed 50 down to the 10 in stock on blur
              submitted 10 without a word. The submit check says it instead. */}
          <NumberInput
            min={0}
            required
            value={qtyRequested}
            onChange={(v) => { setQtyRequested(v); setQtyTouched(true); }}
            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none"
          />
         </div>
         <div>
          <label className="block text-sm font-bold text-muted mb-1">Project *</label>
          <select required value={projectId} onChange={(e) => { setProjectId(e.target.value); setProjectTouched(true); }}
            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none">
            <option value="">-- Select Project --</option>
            {projects.filter((p: any) => p.isActive !== false).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            <option value="__OTHERS__">General / Others (not project-specific)</option>
          </select>
         </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Department *</label>
          <select required value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}
            disabled={isRegularUser && !!departmentId}
            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none disabled:bg-surface disabled:text-ink">
            <option value="">-- Select Department --</option>
            {departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {isRegularUser && departmentId && <p className="text-[10px] text-faint mt-0.5">Auto-set from your profile</p>}
          {homeDeptId && departmentId === homeDeptId && <p className="text-[10px] text-faint mt-0.5">Your team — change it if this is for another department</p>}
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Nature</label>
          <select value={nature} onChange={(e) => setNature(e.target.value as Nature)}
            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none">
            <option value={Nature.TEMPORARY}>Temporary</option>
            <option value={Nature.PERMANENT}>Permanent</option>
          </select>
        </div>
      </div>

      {nature === Nature.TEMPORARY && (
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="block text-sm font-bold text-muted mb-1">Duration *</label>
            <NumberInput
              min={1}
              required
              value={durationValue}
              onChange={setDurationValue}
              integer
              className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none"
            />
          </div>
          <div className="flex-1">
            <label className="block text-sm font-bold text-muted mb-1">Unit</label>
            <select value={durationUnit} onChange={(e) => setDurationUnit(e.target.value as DurationUnit)}
              className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none">
              <option value={DurationUnit.MINUTES}>Minutes</option>
              <option value={DurationUnit.HOURS}>Hours</option>
              <option value={DurationUnit.DAYS}>Days</option>
              <option value={DurationUnit.WEEKS}>Weeks</option>
              <option value={DurationUnit.MONTHS}>Months</option>
            </select>
          </div>
        </div>
      )}

      <UserMultiSelect 
        usersDirectory={usersDirectory} 
        responsiblePersonIds={responsiblePersonIds} 
        setResponsiblePersonIds={setResponsiblePersonIds} 
        user={user} 
        departmentId={departmentId} 
      />

      {/* Footer: photo on the left, submit on the right.
          This was `flex justify-end` with no gap and no flex sizing, so both
          children were shoved against the right edge and a long filename —
          "Screenshot 2026-03-06 at 3.18.12PM.png" is a normal one — ran
          underneath the Submit button with nothing to stop it. The photo block
          now takes the free space and truncates inside it; the button keeps its
          width and never gets overlapped; and the row wraps at phone width
          instead of squashing. */}
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 pt-4 border-t border-line-soft">
        {/* Optional. A photo of the damaged part, the label, the empty shelf —
            whatever makes "this one" unambiguous to whoever fulfils it. */}
        <div className="min-w-0 flex-1">
          <label className="block text-sm font-bold text-muted mb-1">
            Photo <span className="font-normal text-faint">(optional)</span>
          </label>
          <input
            ref={photoRef}
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
              setPhoto(f);
            }}
          />
          {photo ? (
            <div className="flex items-center gap-2 text-xs min-w-0">
              {/* Truncates to whatever room is left rather than a fixed 220px,
                  so Remove stays reachable at every width. */}
              <span className="truncate text-ink" title={photo.name}>{photo.name}</span>
              <button type="button" onClick={() => { setPhoto(null); if (photoRef.current) photoRef.current.value = ''; }}
                className="text-red-700 dark:text-red-300 hover:underline font-bold shrink-0">Remove</button>
            </div>
          ) : (
            <button type="button" onClick={() => photoRef.current?.click()}
              className="text-xs font-bold text-brand-dark hover:underline">+ Attach a photo</button>
          )}
        </div>

        <button type="submit" disabled={isLoading || submitting}
          className="shrink-0 bg-brand text-white px-6 py-2 rounded-md font-bold text-sm hover:bg-brand-dark disabled:opacity-50 disabled:cursor-not-allowed">
          {isLoading || submitting ? 'Submitting...' : 'Submit Request'}
        </button>
      </div>
    </form>
  );
};
