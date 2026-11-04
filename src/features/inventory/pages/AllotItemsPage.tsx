import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { normalizeQtyInput } from '@/utils/normalizeQtyInput';
import { Boxes, PackageOpen, Loader2, Check, X } from 'lucide-react';
import { client } from '@/api';
import { Pagination, SearchInput, ColumnFilter } from '@/components/ui';
import { EditableCell } from '@/components/ui/EditableCell';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context';
import { useSearchParams } from 'react-router-dom';
import { extractErrorMessage, cachedGet } from '@/lib';
import { useAbortOnUnmount } from '@/hooks';

type Tab = 'unallotted' | 'allotted';

interface AllottedRow {
  itemId: string; name: string; unit: string | null; category: string;
  totalStock: number; projectId: string | null; projectName: string;
  projectIsActive: boolean; allottedQty: number;
  // Where this project's share sits. The `effective*` fields already have the
  // item-level fallback applied by the server; the bare ones are the override
  // as stored, where null means "no override". Display uses effective, the
  // editor binds to the override — mixing them up would make clearing a box
  // impossible, because it would immediately refill with the item's value.
  rackAddress: string | null; containerName: string | null; trayNumber: string | null;
  // The item's own address, and what is left of it after every project's
  // reservation — both carried on each row so the remainder can be shown
  // beside the splits without another request.
  itemRackAddress: string | null; itemContainerName: string | null; itemTrayNumber: string | null;
  itemAllottedTotal: number; itemUnallotted: number;
}

interface UnallottedRow {
  itemId: string; name: string; unit: string | null; category: string;
  totalStock: number; allottedTotal: number; unallotted: number;
}

/** The three location boxes as the editor holds them: '' means "no override". */
interface LocDraft { rackAddress: string; containerName: string; trayNumber: string }

const EMPTY_LOC: LocDraft = { rackAddress: '', containerName: '', trayNumber: '' };

const PAGE = 25;

/**
 * Allot Items — split an item's stock between projects and the unallotted pool.
 *
 * 10 pens can read as "Gateway 2, Watch 3, Ultra 1, 4 unallotted". The two tabs
 * list STOCK, not items, so those pens appear in both: three rows under
 * Allotted and one under Unallotted. An item only leaves Unallotted when every
 * unit is reserved — which is the honest signal, and keeps the 4 spare pens
 * visible instead of hidden inside a row on the other tab.
 *
 * Allotments are binding. Stock reserved for Gateway cannot be issued against a
 * Watch request, so this page decides who actually gets scarce parts — which is
 * why it is Inventory/Admin only, enforced server-side too.
 */
// Rack / Container / Tray filters (owner, 27 Oct — a filter on every data
// column). Server-side like the rest, as rack / container / tray on
// GET /inventory/allotments; their choices come from the tab's
// filter-options. They match the allotment's OWN location, as the cells show
// it. BLANK_LOCATION is the server's value for "no location of its own".
const BLANK_LOCATION = '__blank__';
type LocKey = 'rack' | 'container' | 'tray';
const LOCATION_COLUMNS = [
  { label: 'Rack Address', key: 'rack', optsKey: 'racks' },
  { label: 'Container', key: 'container', optsKey: 'containers' },
  { label: 'Tray', key: 'tray', optsKey: 'trays' },
] as const;
const NO_LOC: Record<LocKey, string> = { rack: '', container: '', tray: '' };

export const AllotItemsPage = () => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  /** The item's own value for a location field — the editor's empty-state hint. */
  const itemLocationFor = (row: any, field: 'rackAddress' | 'containerName' | 'trayNumber') =>
    (field === 'rackAddress' ? row.itemRackAddress
      : field === 'containerName' ? row.itemContainerName
      : row.itemTrayNumber) ?? '';

  /**
   * Save one inline edit.
   *
   * allottedQty is required by the endpoint, so the row's current quantity
   * rides along on a location edit — otherwise the quantity would be sent as
   * undefined and rejected. Only the FIELD being edited is included beyond
   * that: an omitted location key means "leave it as it is", so editing the
   * rack cannot blank the tray.
   */
  const saveInline = async (row: any, patch: Record<string, unknown>) => {
    if (!row.projectId) return;
    try {
      await client.patch(`/inventory/allotments/${row.itemId}`, {
        projectId: row.projectId,
        allottedQty: 'allottedQty' in patch ? patch.allottedQty : row.allottedQty,
        ...('allottedQty' in patch ? {} : patch),
      });
      await load();
      // A new rack / container / tray value belongs in its filter's choices.
      if (!('allottedQty' in patch)) refreshFilterOpts();
    } catch (e: any) {
      // The server's refusal names the ceiling and why, so surface it verbatim.
      addToast(extractErrorMessage(e, 'Could not save'), 'error');
      await load();   // put the cell back to what the server actually holds
    }
  };

  // Deep links from the Component Database land here: clicking a project tag
  // there opens this page already narrowed to that item and project, so the
  // initial state is read from the URL rather than defaulting. Read once, at
  // mount — after that the filters are the user's, and re-syncing from the URL
  // would fight whatever they change.
  const [searchParams] = useSearchParams();
  const tabInitRef = useRef(true);
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [tab, setTab] = useState<Tab>(searchParams.get('tab') === 'allotted' ? 'allotted' : 'unallotted');
  const [search, setSearch] = useState('');
  // What the server is asked for: the box's value once typing pauses for
  // 300 ms, the same delay as the shared useServerPagination search. Without
  // it every keystroke started its own /inventory/allotments request.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(t);
  }, [search]);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<any[]>([]);
  const [projectFilter, setProjectFilter] = useState(searchParams.get('project') ?? '');
  // Column filters. All applied SERVER-side: this table is paginated, so
  // filtering the rows already fetched would quietly filter one page of 25 and
  // present the result as the whole answer.
  const [itemFilter, setItemFilter] = useState(searchParams.get('item') ?? '');
  const [qtyFilter, setQtyFilter] = useState('');
  const [stockFilter, setStockFilter] = useState('');
  const [locFilter, setLocFilter] = useState<Record<LocKey, string>>(NO_LOC);
  const [filterOpts, setFilterOpts] = useState<any>({ itemNames: [], projects: [], qtyBands: [], stockBands: [], racks: [], containers: [], trays: [] });
  // Which item's allot editor is open, and the draft values in it.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [locDraft, setLocDraft] = useState<Record<string, LocDraft>>({});
  const [breakdown, setBreakdown] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    cachedGet<any>('/projects')
      .then((d) => setProjects((d?.data ?? d ?? []).filter((p: any) => p.isActive)))
      .catch(() => setProjects([]));
  }, []);

  // Dropdown contents come from the server, scoped the same way the list is —
  // so a filter can never offer a value that returns nothing, or name an item
  // in a department this person can't see.
  //
  // Refetched per TAB: the Allotted tab only lists items that actually hold a
  // reservation, and the Unallotted tab only those with stock left over. The
  // two sets differ, so one shared list would offer dead options on whichever
  // tab you were not on.
  const refreshFilterOpts = () => {
    client.get(`/inventory/allotments/filter-options?tab=${tab}`, { signal: abortSignal() })
      .then(({ data }) => setFilterOpts(data?.data ?? data ?? {}))
      .catch(() => undefined);
  };
  useEffect(() => {
    refreshFilterOpts();
    // A name picked on one tab may not exist on the other, which would leave a
    // filter applied that the dropdown can no longer show as selected.
    //
    // Skipped on the FIRST run, or a deep link's item filter would be wiped by
    // the very effect that reacts to the tab it arrived on.
    if (tabInitRef.current) { tabInitRef.current = false; return; }
    setItemFilter('');
    // The location columns exist on the Allotted tab only.
    setLocFilter(NO_LOC);
  }, [tab]);

  // Only the newest request may write the table. Typing fires a load per
  // keystroke, and the page-reset effect fires another; whichever answered
  // last used to win, so an older, emptier answer could land on top.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams({ tab, take: String(PAGE), skip: String(page * PAGE) });
      if (debouncedSearch.trim()) params.set('search', debouncedSearch.trim());
      if (tab === 'allotted' && projectFilter) params.set('projectId', projectFilter);
      if (itemFilter) params.set('itemName', itemFilter);
      if (qtyFilter) params.set('qtyBand', qtyFilter);
      if (stockFilter) params.set('stockBand', stockFilter);
      if (tab === 'allotted') {
        for (const k of ['rack', 'container', 'tray'] as const) if (locFilter[k]) params.set(k, locFilter[k]);
      }
      const { data } = await client.get(`/inventory/allotments?${params.toString()}`, { signal: abortSignal() });
      if (seq !== loadSeq.current) return;
      const payload = data?.data ?? data;
      setRows(payload.items ?? []);
      setTotal(payload.total ?? 0);
    } catch (e: any) {
      if (seq !== loadSeq.current) return;
      addToast(extractErrorMessage(e, 'Could not load allotments'), 'error');
      setRows([]); setTotal(0);
    }
    setLoading(false);
  }, [tab, page, debouncedSearch, projectFilter, itemFilter, qtyFilter, stockFilter, locFilter, addToast]);

  useEffect(() => { load(); }, [load]);
  // Any tab/filter/search change starts a new result set, so page 1.
  // Any filter change starts a new result set, so go back to page 1 —
  // otherwise you can land on page 4 of a 2-page result and see nothing.
  useEffect(() => { setPage(0); }, [tab, debouncedSearch, projectFilter, itemFilter, qtyFilter, stockFilter, locFilter]);

  /**
   * Load one item's split.
   *
   * `resetProjectId` decides what happens to drafts already on screen:
   *   undefined -> opening fresh, so every draft is (re)seeded from the server
   *   a project -> a save just landed, so ONLY that row is reseeded and every
   *                other row keeps what the user typed
   *
   * The second case is the whole point. Saving used to re-run the fresh-open
   * path, which reseeded all the drafts from the server — so typing rack and
   * tray into three projects and hitting Save on one silently discarded the
   * other two, and it read as the save having "refreshed" them away.
   */
  const loadBreakdown = async (itemId: string, resetProjectId?: string) => {
    try {
      const { data } = await client.get(`/inventory/allotments/${itemId}`, { signal: abortSignal() });
      const b = data?.data ?? data;
      setBreakdown(b);
      const fresh: Record<string, string> = {};
      const freshLoc: Record<string, LocDraft> = {};
      for (const p of b.projects ?? []) {
        fresh[p.projectId] = String(p.allottedQty);
        // Seed from the OVERRIDE, not the effective value. Seeding from
        // effective would put the item's own location into the boxes, so
        // saving an untouched row would silently turn an inherited location
        // into a per-project override — and clearing a box would be
        // impossible, because it would come back filled on the next refresh.
        freshLoc[p.projectId] = {
          rackAddress: p.rackAddress ?? '',
          containerName: p.containerName ?? '',
          trayNumber: p.trayNumber ?? '',
        };
      }
      if (resetProjectId === undefined) {
        setDraft(fresh);
        setLocDraft(freshLoc);
      } else {
        // Keep the user's in-progress edits; take the server's word only for
        // the row that was just saved, and fill in any row that has no draft
        // yet (a project linked by someone else since this editor opened).
        setDraft((d) => {
          const next = { ...fresh, ...d };
          if (fresh[resetProjectId] !== undefined) next[resetProjectId] = fresh[resetProjectId];
          return next;
        });
        setLocDraft((d) => {
          const next = { ...freshLoc, ...d };
          if (freshLoc[resetProjectId]) next[resetProjectId] = freshLoc[resetProjectId];
          return next;
        });
      }
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load this item'), 'error');
      setEditing(null);
    }
  };

  const openEditor = async (itemId: string) => {
    setEditing(itemId); setBreakdown(null); setDraft({}); setLocDraft({});
    await loadBreakdown(itemId);
  };

  const closeEditor = () => { setEditing(null); setBreakdown(null); };

  /**
   * Is anything in the editor unsaved?
   *
   * Compares every row's draft against what the server last returned. Saving
   * one project re-opens the editor and reseeds the drafts, so a row that has
   * been saved stops counting as dirty without any extra bookkeeping.
   *
   * Quantities are compared as NUMBERS: the draft is a string, so "5" against
   * a stored 5 is not a string match, and comparing as text would flag an
   * untouched row as dirty and nag on every close.
   */
  const editorIsDirty = () => {
    if (!breakdown) return false;
    // Walk the DRAFTS, not breakdown.projects. The editor shows a row for
    // every project, but breakdown.projects only carries the ones that already
    // have a link — so a project being given stock for the first time has no
    // entry there, and checking that list alone declared those edits clean and
    // discarded them without asking. A project with no link reads as qty 0 and
    // no location, which is exactly what its row starts out showing.
    const stored = new Map<string, any>((breakdown.projects ?? []).map((p: any) => [p.projectId, p]));
    const touched = new Set([...Object.keys(draft), ...Object.keys(locDraft)]);
    for (const projectId of touched) {
      const p = stored.get(projectId);
      const q = draft[projectId];
      if (q !== undefined && Number(q) !== Number(p?.allottedQty ?? 0)) return true;
      const loc = locDraft[projectId];
      if (loc && (
        loc.rackAddress !== (p?.rackAddress ?? '') ||
        loc.containerName !== (p?.containerName ?? '') ||
        loc.trayNumber !== (p?.trayNumber ?? '')
      )) return true;
    }
    return false;
  };

  // Escape closes, through the same guard. It did nothing at all before, which
  // is its own small bug — every other modal in the app closes on Escape.
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void requestCloseEditor(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- requestCloseEditor closes over draft/locDraft, which change on every keystroke; re-binding the listener that often is wasteful, and reading the latest values happens inside the handler anyway
  }, [editing, breakdown, draft, locDraft]);

  const requestCloseEditor = async () => {
    if (editorIsDirty() && !(await confirm(
      'You have unsaved changes to this split.\n\nClose anyway and lose them?'
    ))) return;
    closeEditor();
  };

  /** Which project rows differ from what the server last returned. */
  const dirtyProjectIds = (): string[] => {
    if (!breakdown) return [];
    const stored = new Map<string, any>((breakdown.projects ?? []).map((p: any) => [p.projectId, p]));
    const touched = new Set([...Object.keys(draft), ...Object.keys(locDraft)]);
    const out: string[] = [];
    for (const projectId of touched) {
      const p = stored.get(projectId);
      const q = draft[projectId];
      const loc = locDraft[projectId];
      const qtyChanged = q !== undefined && Number(q) !== Number(p?.allottedQty ?? 0);
      const locChanged = !!loc && (
        loc.rackAddress !== (p?.rackAddress ?? '') ||
        loc.containerName !== (p?.containerName ?? '') ||
        loc.trayNumber !== (p?.trayNumber ?? '')
      );
      if (qtyChanged || locChanged) out.push(projectId);
    }
    return out;
  };

  /**
   * Save every changed row in one go.
   *
   * ORDER MATTERS. The server refuses an allotment that would push the item
   * over its stock, checked per call — so moving 10 units from one project to
   * another fails if the increase is applied before the decrease, even though
   * the end state is perfectly valid. Rows whose quantity goes DOWN (or does
   * not move) are sent first, which frees the headroom the increases need.
   *
   * Sequential, not parallel: the ceiling each call checks depends on what the
   * previous ones committed, and firing them together reintroduces exactly the
   * race the ordering is there to avoid.
   */
  const saveAll = async () => {
    if (!breakdown) return;
    const ids = dirtyProjectIds();
    if (ids.length === 0) return;

    const stored = new Map<string, any>((breakdown.projects ?? []).map((p: any) => [p.projectId, p]));
    const delta = (id: string) => Number(draft[id] ?? 0) - Number(stored.get(id)?.allottedQty ?? 0);
    for (const id of ids) {
      const q = Number(draft[id] ?? 0);
      if (!Number.isFinite(q) || q < 0) { addToast('Enter zero or more.', 'error'); return; }
    }
    const ordered = [...ids].sort((a, b) => delta(a) - delta(b));

    setSaving(true);
    const failures: string[] = [];
    let saved = 0;
    for (const projectId of ordered) {
      // Always send the three location fields. The boxes are bound to the
      // override, so what they hold IS the intended override — including
      // empty, which the server reads as "clear it and fall back to the
      // item's location".
      const loc = locDraft[projectId] ?? EMPTY_LOC;
      try {
        await client.patch(`/inventory/allotments/${breakdown.itemId}`, {
          projectId,
          allottedQty: Number(draft[projectId] ?? 0),
          rackAddress: loc.rackAddress,
          containerName: loc.containerName,
          trayNumber: loc.trayNumber,
        });
        saved += 1;
      } catch (e: any) {
        // Keep going: one project over its ceiling should not silently drop
        // the other edits the user made. The server's refusal names the
        // ceiling and why, so it is surfaced verbatim rather than replaced
        // with something vaguer.
        const name = (breakdown.projects ?? []).find((p: any) => p.projectId === projectId)?.projectName
          ?? projects.find((p) => p.id === projectId)?.name
          ?? 'A project';
        failures.push(`${name}: ${extractErrorMessage(e, 'could not be saved')}`);
      }
    }

    // Reload from scratch: several rows moved, so every draft should now show
    // what the server actually holds.
    await loadBreakdown(breakdown.itemId);
    await load();
    // Splits and locations both feed the filter choices (items, racks…).
    refreshFilterOpts();
    setSaving(false);

    if (failures.length === 0) {
      addToast(`${breakdown.name}: ${saved} project${saved === 1 ? '' : 's'} updated.`, 'success');
    } else {
      addToast(failures.join('\n'), 'error');
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE));
  // A count, plus one control to undo them all — with four filters and a search
  // box it is otherwise easy to stare at an empty table and not see why.
  const locCount = Object.values(locFilter).filter(Boolean).length;
  const activeFilters = [projectFilter, itemFilter, qtyFilter, stockFilter].filter(Boolean).length + locCount;
  const clearFilters = () => { setProjectFilter(''); setItemFilter(''); setQtyFilter(''); setStockFilter(''); setLocFilter(NO_LOC); };
  const locOpts = (vals: string[] | undefined, picked: string) => {
    const list = vals ?? [];
    const withPicked = picked && !list.includes(picked) ? [picked, ...list] : list;
    return withPicked.map((v) => ({ value: v, label: v === BLANK_LOCATION ? '(none set)' : v }));
  };
  const itemOpts = (filterOpts.itemNames ?? []).map((n: string) => ({ value: n, label: n }));
  const projectOpts = (filterOpts.projects ?? projects).map((p: any) => ({ value: p.id, label: p.name }));
  const qtyOpts = filterOpts.qtyBands ?? [];
  const stockOpts = filterOpts.stockBands ?? [];
  const tabs: Array<{ key: Tab; label: string; icon: any }> = useMemo(() => ([
    { key: 'unallotted', label: 'Unallotted', icon: PackageOpen },
    { key: 'allotted', label: 'Allotted', icon: Boxes },
  ]), []);

  return (
    <div className="p-6">
      <div className="mb-4">
        <h1 className="text-xl font-bold text-ink">Allot Items</h1>
        <p className="mt-1 max-w-3xl text-xs text-muted">
          Split an item's stock between projects. 10 pens can be 2 for one project, 3 for another and
          4 left unallotted. <b>Allotments are binding</b> — stock reserved for a project can't be
          issued against a different one, so what you set here decides who gets scarce parts.
        </p>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-bold transition-colors ${
                active ? 'bg-ink text-white' : 'border border-line text-muted hover:border-brand'
              }`}
            >
              <Icon size={13} /> {t.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          {/* The project picker used to live here as a second control doing the
              same job as the PROJECT column filter. One of them had to go. */}
          {activeFilters > 0 && (
            <button
              onClick={clearFilters}
              className="rounded-md border border-line px-2.5 py-1.5 text-[11px] font-bold text-muted transition-colors hover:border-brand hover:text-brand"
            >
              Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
            </button>
          )}
          <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items…" />
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line bg-card">
        {/* table-fixed, with explicit widths.
            Default `table-layout: auto` sizes every column to whatever happens
            to be on screen, so the columns visibly jumped each time a filter
            changed which rows were showing — "32 gb sd card" and
            "0.9pF/+-0.05pF/50V/0402" want very different amounts of room. With
            only three or four columns the spare width swings hard, which reads
            as the layout breaking rather than as the content changing.
            Fixed widths mean the page holds still while you filter. */}
        <table className="w-full table-fixed text-sm">
          <colgroup>
            {tab === 'allotted' ? (
              <>
                <col className="w-[20%]" />
                <col className="w-[12%]" />
                <col className="w-[10%]" />
                <col className="w-[12%]" />
                <col className="w-[11%]" />
                <col className="w-[14%]" />
                <col className="w-[8%]" />
                <col className="w-[13%]" />
              </>
            ) : (
              <>
                <col className="w-[46%]" />
                <col className="w-[16%]" />
                <col className="w-[16%]" />
                <col className="w-[22%]" />
              </>
            )}
          </colgroup>
          <thead>
            <tr className="border-b border-line text-left text-[10px] font-bold uppercase tracking-wider text-faint">
              <th className="px-4 py-2.5">
                <span className="inline-flex items-center">Item
                  <ColumnFilter searchable options={itemOpts} value={itemFilter} onChange={setItemFilter} />
                </span>
              </th>
              {tab === 'allotted' && (
                <th className="px-4 py-2.5">
                  <span className="inline-flex items-center">Project
                    <ColumnFilter searchable options={projectOpts} value={projectFilter} onChange={setProjectFilter} allLabel="All projects" />
                  </span>
                </th>
              )}
              <th className="px-4 py-2.5">
                <span className="inline-flex items-center">{tab === 'allotted' ? 'Allotted' : 'Unallotted'}
                  {/* Bands, not every distinct number — hundreds of quantities
                      would make a dropdown that is a filter in name only. */}
                  <ColumnFilter options={qtyOpts} value={qtyFilter} onChange={setQtyFilter} allLabel="Any quantity" />
                </span>
              </th>
              <th className="px-4 py-2.5">
                <span className="inline-flex items-center">Total stock
                  <ColumnFilter options={stockOpts} value={stockFilter} onChange={setStockFilter} allLabel="Any stock level" />
                </span>
              </th>
              {/* Three columns, matching the Component Database — one "Location"
                  cell jamming rack, container and tray together could not be
                  scanned down, and the two pages showing the same three facts
                  differently made them look like different data. */}
              {tab === 'allotted' && <>
                {LOCATION_COLUMNS.map(({ label, key, optsKey }) => (
                  <th key={key} className={`px-4 py-2.5 ${locFilter[key] ? 'bg-brand-100' : ''}`}>
                    <span className="inline-flex items-center">{label}
                      <ColumnFilter searchable options={locOpts(filterOpts[optsKey], locFilter[key])} value={locFilter[key]} onChange={(v) => setLocFilter((prev) => ({ ...prev, [key]: v }))} />
                    </span>
                  </th>
                ))}
              </>}
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={tab === 'allotted' ? 8 : 4} className="py-10 text-center text-sm text-faint">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={tab === 'allotted' ? 8 : 4} className="py-10 text-center text-sm text-faint">
                {activeFilters > 0 || search.trim()
                  ? 'Nothing matches these filters.'
                  : tab === 'unallotted'
                    ? 'Every item with stock is fully allotted to a project.'
                    : 'Nothing is allotted to a project yet — start from the Unallotted tab.'}
              </td></tr>
            ) : tab === 'allotted' ? (
              (rows as AllottedRow[]).map((r, i, all) => {
                // One item split across N projects is N rows, and at a glance
                // they read as N unrelated items — the whole point of this tab
                // is seeing how ONE item is divided up. Rows are ordered by
                // item, so a group is a contiguous run: draw a divider above
                // each new item and repeat the name only on the first row of
                // its group, the way a grouped report reads.
                const firstOfGroup = i === 0 || all[i - 1].itemId !== r.itemId;
                const lastOfGroup = i === all.length - 1 || all[i + 1].itemId !== r.itemId;
                const grouped = !firstOfGroup || !lastOfGroup;
                return (
                // Keyed Fragment: this returns two rows from inside a map, and
                // a shorthand fragment cannot carry the key React needs.
                <Fragment key={`${r.itemId}-${r.projectId}`}>
                <tr
                    className={`last:border-0 ${firstOfGroup ? 'border-t border-line' : ''} ${lastOfGroup ? 'border-b border-line-soft' : ''} ${grouped ? 'bg-hover/30' : ''}`}>
                  {/* title: with fixed widths a long part number is truncated,
                      so hovering has to be able to show the whole thing. */}
                  <td className="truncate px-4 py-2.5 font-bold text-ink" title={r.name}>
                    {firstOfGroup
                      ? r.name
                      // Blank, the way a grouped report reads — repeating the
                      // name adds nothing, and a label like "same item" is
                      // more visual noise than the tint and rule already
                      // carry. Screen readers still get the name, because an
                      // empty cell would leave the row unidentifiable to them.
                      : <span className="sr-only">{r.name}, continued</span>}
                  </td>
                  <td className="truncate px-4 py-2.5">
                    <span className="rounded-full border border-violet-200 dark:border-violet-400/30 bg-violet-50 dark:bg-violet-400/15 px-2 py-0.5 text-[10px] font-bold text-violet-700 dark:text-violet-300">
                      {r.projectName}
                    </span>
                    {!r.projectIsActive && (
                      <span className="ml-1 text-[9px] font-bold uppercase text-amber-700 dark:text-amber-300" title="This project is inactive — its allotment can only be reduced">
                        inactive
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-bold text-ink">
                    <span className="inline-flex items-baseline gap-1">
                      <EditableCell
                        value={r.allottedQty}
                        type="number"
                        onSave={(v) => saveInline(r, { allottedQty: Number(v) })}
                        className="font-bold text-ink"
                      />
                      <span className="text-[10px] font-normal text-faint">{r.unit}</span>
                    </span>
                  </td>
                  {/* Printed once per group, like the name: it is a property
                      of the ITEM, and repeating it on every project row made
                      the reader check whether the numbers differed. */}
                  <td className="px-4 py-2.5 text-xs text-muted">
                    {firstOfGroup && r.totalStock}
                  </td>
                  {/* This project's OWN location. No fallback to the item's:
                      blank means blank, because reserved stock can genuinely
                      have no designated place, and showing the item's address
                      would assert one nobody chose. */}
                  {(['rackAddress', 'containerName', 'trayNumber'] as const).map((field) => (
                    <td key={field} className="truncate px-4 py-2.5 text-xs text-ink">
                      <EditableCell
                        value={r[field] ?? ''}
                        // The item's own value as the empty-state hint, not as
                        // a fallback: it suggests where the stock probably is
                        // without claiming this project has been given that
                        // address. Clearing the box still means blank.
                        placeholder={(itemLocationFor(r, field) || '—')}
                        onSave={(v) => saveInline(r, { [field]: String(v) })}
                        className="text-xs"
                      />
                    </td>
                  ))}
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => openEditor(r.itemId)} className="whitespace-nowrap text-xs font-bold text-brand-700 hover:underline">Change split</button>
                  </td>
                </tr>
                {/* What is left over, as the group's last line. It is here
                    mainly for its LOCATION: unreserved stock sits at the
                    item's own address, and that address appears nowhere else
                    on this page once every project row shows its own
                    override. Only rendered on the group's last row, so it
                    appears once per item, and only when something is free. */}
                {lastOfGroup && r.itemUnallotted > 0 && (
                  <tr className="border-b border-line-soft last:border-0">
                    <td className="truncate px-4 py-2.5">
                      <span className="sr-only">{r.name}, unallotted</span>
                    </td>
                    <td className="truncate px-4 py-2.5">
                      {/* Not a project pill: this is the absence of a project,
                          and the same chip would read as one actually named
                          "none". */}
                      <span className="text-[11px] italic text-faint">none</span>
                    </td>
                    {/* Nothing is reserved for "none" — that is what makes it
                        the free pool — so the allotted figure is 0, and the
                        quantity that matters shows as stock. */}
                    <td className="px-4 py-2.5 font-bold text-faint">
                      0 <span className="text-[10px] font-normal text-faint">{r.unit}</span>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted">
                      {r.itemUnallotted} <span className="text-[10px] text-faint">free</span>
                    </td>
                    {([r.itemRackAddress, r.itemContainerName, r.itemTrayNumber] as (string | null)[]).map((v, ci) => (
                      <td key={ci} className="truncate px-4 py-2.5 text-xs text-muted"
                          title="The item's own location — unreserved stock sits where the item does">
                        {(v ?? '').trim() || <span className="text-faint">—</span>}
                      </td>
                    ))}
                    <td className="px-4 py-2.5 text-right">
                      <button onClick={() => openEditor(r.itemId)} className="whitespace-nowrap text-xs font-bold text-brand-700 hover:underline">Allot</button>
                    </td>
                  </tr>
                )}
                </Fragment>
                );
              })
            ) : (
              (rows as UnallottedRow[]).map((r) => (
                <tr key={r.itemId} className="border-b border-line-soft last:border-0">
                  <td className="truncate px-4 py-2.5 font-bold text-ink" title={r.name}>{r.name}</td>
                  <td className="px-4 py-2.5 font-bold text-ink">{r.unallotted} <span className="text-[10px] font-normal text-faint">{r.unit}</span></td>
                  <td className="px-4 py-2.5 text-xs text-muted">
                    {r.totalStock}
                    {r.allottedTotal > 0 && <span className="text-[10px] text-faint"> ({r.allottedTotal} already allotted)</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <button onClick={() => openEditor(r.itemId)} className="text-xs font-bold text-brand-700 hover:underline">Allot to a project</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {pageCount > 1 && (
        <div className="mt-3">
          <Pagination currentPage={page + 1} totalPages={pageCount} onPageChange={(p: number) => setPage(p - 1)} />
        </div>
      )}

      {editing && (
        <AllotEditor
          breakdown={breakdown}
          projects={projects}
          draft={draft}
          saving={saving}
          // Normalised on the way in, not on save: the operator has to be able
          // to read back what they typed. Clicking into a field showing "0"
          // and typing 50 otherwise leaves "050" sitting there.
          onDraft={(pid, v) => setDraft((d) => ({ ...d, [pid]: normalizeQtyInput(v) }))}
          locDraft={locDraft}
          onLocDraft={(pid, v) => setLocDraft((d) => ({ ...d, [pid]: v }))}
          onSave={saveAll}
          dirtyIds={dirtyProjectIds()}
          onRequestClose={requestCloseEditor}
        />
      )}
    </div>
  );
};

/**
 * The split editor. Deliberately one Save per project row rather than a single
 * Save for the whole item: each project's ceiling depends on what the others
 * hold, so saving them one at a time means the server can explain a refusal
 * precisely ("stock is 10, 8 is allotted elsewhere, so at most 2 fits here")
 * instead of rejecting a batch without saying which line was the problem.
 */
const AllotEditor = ({
  breakdown, projects, draft, locDraft, saving, onDraft, onLocDraft, onSave, onRequestClose, dirtyIds,
}: {
  breakdown: any | null;
  projects: any[];
  draft: Record<string, string>;
  saving: boolean;
  locDraft: Record<string, LocDraft>;
  onDraft: (projectId: string, value: string) => void;
  onLocDraft: (projectId: string, value: LocDraft) => void;
  onSave: () => void;
  /** Projects whose row differs from the server — drives the per-row marker. */
  dirtyIds: string[];
  /** The only way out: checks for unsaved edits before closing. */
  onRequestClose: () => void;
}) => {
  if (!breakdown) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
        <div className="rounded-xl bg-card px-6 py-5 text-sm text-muted shadow-lg">Loading…</div>
      </div>
    );
  }
  // Projects already holding some of this item, plus every other active
  // project so stock can be allotted somewhere new without leaving the modal.
  const held = new Map<string, any>((breakdown.projects ?? []).map((p: any) => [p.projectId, p]));
  const all = [
    ...(breakdown.projects ?? []),
    ...projects.filter((p) => !held.has(p.id)).map((p) => ({ projectId: p.id, projectName: p.name, allottedQty: 0, projectIsActive: true })),
  ];

  /**
   * What a project's box currently reads — the unsaved edit if there is one,
   * otherwise what the server last returned. The "Allot N" shortcut ADDS to
   * this rather than replacing it, so clicking it twice does not quietly
   * throw away the first click, and a quantity already typed is respected.
   */
  const currentQty = (projectId: string): number =>
    Number(draft[projectId] ?? held.get(projectId)?.allottedQty ?? 0) || 0;

  /**
   * The most this project could hold, given what every OTHER project is
   * currently asking for in this same modal.
   *
   * The server already refuses an over-allotment, but only after Save, as a red
   * toast that states the ceiling and then throws the typed number away. That
   * is the right rule arriving at the wrong time: the modal knows the stock and
   * every drafted quantity, so it can say so while the number is still being
   * typed — and offer the ceiling as a click rather than making someone work it
   * out from the sentence.
   */
  const ceilingFor = (projectId: string): number => {
    const others = all.reduce(
      (sum: number, p: any) => (p.projectId === projectId ? sum : sum + currentQty(p.projectId)),
      0,
    );
    return Math.max(0, Number(breakdown.stock ?? 0) - others);
  };

  /** Rows asking for more than there is. Save stays disabled while any exist. */
  const overAllotted = all.filter((p: any) => currentQty(p.projectId) > ceilingFor(p.projectId));

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4">
        {/* Clicking away is a close too, and was previously inert. */}
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onRequestClose} />
        <div className="relative z-10 w-full max-w-lg rounded-xl bg-card p-5 shadow-lg">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-ink">{breakdown.name}</h3>
              <p className="mt-0.5 text-xs text-muted">
                {breakdown.stock} {breakdown.unit} in stock · <b>{breakdown.allottedTotal}</b> allotted ·{' '}
                <b>{breakdown.unallotted}</b> unallotted
              </p>
            </div>
            <button onClick={onRequestClose} aria-label="Close" className="rounded-md p-1 text-faint hover:bg-hover hover:text-secondary">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Who is already waiting on this item.
              A short-stocked request turns its remainder into an indent, and
              when that stock arrives it is added here as plain untagged
              stock — receiving goods and reserving them are separate
              decisions, and the clerk makes the second one. But without this
              they have no way to know the 40 that just landed were bought for
              Phone at cibi's request: they either guess or leave it loose for
              whoever asks next. So the outstanding demand sits next to the
              field that answers it, with the number ready to accept. */}
          {Array.isArray(breakdown.awaiting) && breakdown.awaiting.length > 0 && (
            <div className="mb-3 rounded-lg border border-brand-200 bg-brand-50 p-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-brand-700">Waiting on this item</p>
              <ul className="mt-1.5 space-y-1.5">
                {breakdown.awaiting.map((w: any) => (
                  <li key={w.projectId ?? 'none'} className="flex flex-wrap items-center gap-x-2 text-xs text-ink">
                    <span>
                      <b>{w.qty}</b> {breakdown.unit} for <b>{w.projectName}</b>
                      {w.requesters.length > 0 && <> · requested by {w.requesters.join(', ')}</>}
                      {' '}({w.serials.join(', ')})
                    </span>
                    {/* Fills the box, does not save. Allotting is still the
                        clerk's call and still goes through the same Save as
                        every other change on this screen. */}
                    {w.projectId && (
                      <button
                        type="button"
                        onClick={() => onDraft(w.projectId, String(currentQty(w.projectId) + Number(w.qty)))}
                        className="ml-auto rounded-full border border-brand px-2 py-0.5 text-[11px] font-bold text-brand hover:bg-brand hover:text-white"
                      >
                        Allot {w.qty} to {w.projectName}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="max-h-80 space-y-2 overflow-y-auto">
            {all.length === 0 && <p className="py-6 text-center text-sm text-faint">No projects defined yet.</p>}
            {all.map((p: any) => {
              const stored: LocDraft = {
                rackAddress: p.rackAddress ?? '',
                containerName: p.containerName ?? '',
                trayNumber: p.trayNumber ?? '',
              };
              const loc = locDraft[p.projectId] ?? stored;
              const qtyChanged = String(p.allottedQty) !== (draft[p.projectId] ?? String(p.allottedQty));
              const locChanged =
                loc.rackAddress !== stored.rackAddress ||
                loc.containerName !== stored.containerName ||
                loc.trayNumber !== stored.trayNumber;
              const changed = qtyChanged || locChanged;
              const locField = (
                key: keyof LocDraft,
                label: string,
                itemValue: string | null | undefined,
              ) => (
                <label className="flex-1 min-w-0">
                  <span className="block text-[9px] font-bold uppercase tracking-wide text-faint">{label}</span>
                  <input
                    type="text"
                    value={loc[key]}
                    onChange={(e) => onLocDraft(p.projectId, { ...loc, [key]: e.target.value })}
                    // The item's own value as placeholder, so an empty box
                    // reads as "inherits this" rather than "nothing here".
                    placeholder={(itemValue ?? '').trim() || '—'}
                    aria-label={`${label} for ${p.projectName}`}
                    className="w-full rounded-md border border-line px-2 py-1 text-xs outline-none focus:border-brand"
                  />
                </label>
              );
              return (
                <div key={p.projectId} className={`rounded-md border px-3 py-2 ${changed ? 'border-brand/50 bg-brand/5' : 'border-line-soft'}`}>
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-sm text-ink">
                      {p.projectName}
                      {p.projectIsActive === false && <span className="ml-1 text-[9px] font-bold uppercase text-amber-700 dark:text-amber-300">inactive</span>}
                    </span>
                    <input
                      // step="any" rather than "0.01": with a hundredth step the
                      // spinner arrows crawl 1 -> 1.01 -> 1.02, which is useless
                      // for the pieces most stock is counted in. "any" makes the
                      // arrows move whole units while still ACCEPTING a typed
                      // decimal, which items measured in metres or litres need
                      // (stock is Decimal(14,2), and the server still caps at
                      // two places).
                      type="number" min={0} step="any"
                      value={draft[p.projectId] ?? String(p.allottedQty)}
                      onChange={(e) => onDraft(p.projectId, e.target.value)}
                      aria-label={`Quantity allotted to ${p.projectName}`}
                      // Centred. NOT right-aligned: Chrome lays the spin
                      // button out inside the padding box, so right-aligned
                      // digits run under the arrows and adding padding only
                      // drags the arrows inward with them.
                      className="w-24 rounded-md border border-line px-2 py-1 text-center text-sm outline-none focus:border-brand"
                    />
                    {/* No per-row Save any more — one button saves the lot.
                        This dot is what tells you the row is IN that save. */}
                    <span aria-hidden="true"
                      title={changed ? 'Changed — will be saved' : 'Unchanged'}
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${changed ? 'bg-brand' : 'bg-transparent'}`} />
                  </div>
                  {/* Said before Save, not after it. The server enforces the
                      same rule; this only stops the round trip that ends in a
                      red toast and a discarded number. */}
                  {currentQty(p.projectId) > ceilingFor(p.projectId) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 dark:bg-amber-400/15">
                      <span className="text-[11px] text-amber-900 dark:text-amber-200">
                        Only <b>{ceilingFor(p.projectId)}</b> {breakdown.unit} can go here
                        {ceilingFor(p.projectId) < Number(breakdown.stock ?? 0) && ' — the rest is allotted to other projects'}.
                      </span>
                      <button
                        type="button"
                        onClick={() => onDraft(p.projectId, String(ceilingFor(p.projectId)))}
                        className="rounded border border-amber-300 px-1.5 py-0.5 text-[11px] font-bold text-amber-900 hover:bg-amber-100 dark:border-amber-400/40 dark:text-amber-200 dark:hover:bg-amber-400/20"
                      >
                        Use {ceilingFor(p.projectId)}
                      </button>
                    </div>
                  )}
                  <div className="mt-1.5 flex items-end gap-2">
                    {locField('rackAddress', 'Rack', breakdown.rackAddress)}
                    {locField('containerName', 'Container', breakdown.containerName)}
                    {locField('trayNumber', 'Tray', breakdown.trayNumber)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            {overAllotted.length > 0 ? (
              <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                {overAllotted.length === 1
                  ? `${overAllotted[0].projectName} is asking for more than there is.`
                  : `${overAllotted.length} projects are asking for more than there is.`}{' '}
                Lower it, or use the suggested number.
              </p>
            ) : (
              <p className="text-[11px] text-faint">
                Setting a project to 0 releases its stock back to the unallotted pool. The item stays
                tagged with the project.
              </p>
            )}
            <button
              onClick={onSave}
              // Blocked while any row asks for more than there is. The save is
              // all-or-nothing, so letting it through would fail the whole
              // batch over one row and lose the other edits with it.
              disabled={saving || dirtyIds.length === 0 || overAllotted.length > 0}
              title={
                overAllotted.length
                  ? `${overAllotted.length} project${overAllotted.length === 1 ? ' is' : 's are'} asking for more than there is`
                  : dirtyIds.length
                    ? `Save ${dirtyIds.length} changed project${dirtyIds.length === 1 ? '' : 's'}`
                    : 'Nothing changed'
              }
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-brand-dark disabled:opacity-40"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {saving ? 'Saving…' : dirtyIds.length ? `Save ${dirtyIds.length} change${dirtyIds.length === 1 ? '' : 's'}` : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
