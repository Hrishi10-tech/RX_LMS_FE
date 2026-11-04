import { useState, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { client } from '@/api';
import { DataTable, SearchInput, ColumnFilter, Pagination } from '@/components/ui';
import { useServerPagination, useAbortOnUnmount } from '@/hooks';
import { Download, Loader2 } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { RequestLinkMenu } from '../components/RequestLinkMenu';
import { RequestDetailsModal } from '@/features/requests/components/RequestDetailsModal';

const EVENT_TYPES = [
  { value: 'STOCK_IN', label: 'Stock In' },
  { value: 'STOCK_OUT', label: 'Stock Out' },
  { value: 'RETURN', label: 'Return' },
  { value: 'DISPOSITION_CHANGE', label: 'Disposition Change' },
  { value: 'ADJUSTMENT', label: 'Adjustment' },
  { value: 'DISPOSAL', label: 'Disposal' },
];

const DISPOSITIONS = [
  { value: 'RETURNED_GOOD', label: 'Returned Good' },
  { value: 'RETURNED_DAMAGED', label: 'Returned Damaged' },
  { value: 'EMBEDDED', label: 'Embedded' },
  { value: 'CONSUMED', label: 'Consumed' },
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'LONG_TERM_LOAN', label: 'Long-term Loan' },
  { value: 'DISPOSED', label: 'Disposed' },
];

// LOCAL day key (YYYY-MM-DD) — NOT toISOString(), which is UTC and shifts any
// event logged between local-midnight and the UTC offset (e.g. 00:00–05:30 IST)
// onto the previous day. The table display, the date-column filter options, and
// the CSV export must all key off the SAME local day or the filter silently
// misses rows and the export disagrees with the on-screen dates.
const localDayKey = (ts?: string) => {
  if (!ts) return '';
  const dt = new Date(ts);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

// The two exact instants bounding a LOCAL day picked as `YYYY-MM-DD`. Sent
// instead of the bare date: the server runs in UTC, and a bare date there
// covers a UTC day — up to five and a half hours adrift of the day whose rows
// are on screen.
const localDayStartIso = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
};
const localDayEndIso = (day: string) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();
};

const fmtTime = (ts: string) => {
  if (!ts) return '-';
  const [y, m, d] = localDayKey(ts).split('-');
  return `${d}-${m}-${y}`;
};

// The clock time, in the same LOCAL zone as localDayKey above. Its own column
// rather than crammed into the date: a day with eleven movements on it used to
// render as eleven identical cells, and "which came first" is most of what an
// audit trail is for.
const fmtClock = (ts: string) => {
  if (!ts) return '';
  const dt = new Date(ts);
  return `${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
};

// How stock arrived — only asked of arrivals, blank elsewhere.
const SOURCES = [
  { value: 'MANUAL_ADD', label: 'Added by hand' },
  { value: 'BULK_UPLOAD', label: 'Bulk upload' },
  { value: 'PROCUREMENT', label: 'Procurement' },
  { value: 'MERGE', label: 'Merged rows' },
  { value: 'RECONSTRUCTED', label: 'Before tracking' },
];
const SOURCE_LABEL: Record<string, string> = Object.fromEntries(SOURCES.map(s => [s.value, s.label]));

const EventBadge = ({ type }: { type: string }) => {
  const map: Record<string, string> = {
    STOCK_IN: 'bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300 border-green-200 dark:border-green-400/30',
    STOCK_OUT: 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30',
    RETURN: 'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30',
    ADJUSTMENT: 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30',
    DISPOSITION_CHANGE: 'bg-purple-50 dark:bg-purple-400/15 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-400/30',
    DISPOSAL: 'bg-hover text-secondary border-line',
  };
  return <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${map[type] || 'bg-surface text-secondary border-line'}`}>{type?.replace(/_/g, ' ')}</span>;
};

// The schema stores `quantityChange` as a signed Decimal (`+N inflow, -N outflow`
// per the comment on InventoryEvent) because stock arithmetic relies on signed
// math. The audit table used to render that raw value, which double-signalled
// direction next to the EventBadge — "STOCK OUT" + "-2 ROLL" reads as "minus
// negative". This helper presents the user-facing concept: event type → arrow
// + colour, magnitude → unsigned number. ADJUSTMENT is the one event whose
// type doesn't carry direction (a manual correction can go either way) so we
// keep the sign there.
const renderQtyChange = (eventType: string, rawQty: any, unit: string) => {
  const n = Number(rawQty) || 0;
  if (n === 0) {
    return <span className="font-bold text-sm text-muted">0 {unit}</span>;
  }

  const isInflow = eventType === 'STOCK_IN' || eventType === 'RETURN';
  const isOutflow = eventType === 'STOCK_OUT' || eventType === 'DISPOSAL';

  if (isInflow || isOutflow) {
    // Magnitude only — direction lives in the EventBadge.
    const magnitude = Math.abs(n);
    const colour = isInflow ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300';
    const arrow = isInflow ? '↑' : '↓';
    return (
      <span className={`font-bold text-sm ${colour}`}>
        {arrow} {magnitude} {unit}
      </span>
    );
  }

  // ADJUSTMENT (and anything else without intrinsic direction): the sign IS
  // the data — a manual -3 correction means stock went down by 3.
  const colour = n > 0 ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300';
  const prefix = n > 0 ? '+' : '';
  return (
    <span className={`font-bold text-sm ${colour}`}>
      {prefix}{n} {unit}
    </span>
  );
};

const DispositionBadge = ({ disposition }: { disposition: string }) => {
  const map: Record<string, string> = {
    RETURNED_GOOD: 'bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300 border-green-200 dark:border-green-400/30',
    RETURNED_DAMAGED: 'bg-orange-50 dark:bg-orange-400/15 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-400/30',
    EMBEDDED: 'bg-purple-50 dark:bg-purple-400/15 text-purple-700 dark:text-purple-300 border-purple-200 dark:border-purple-400/30',
    CONSUMED: 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30',
    DAMAGED: 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30',
    LONG_TERM_LOAN: 'bg-indigo-50 dark:bg-indigo-400/15 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-400/30',
    DISPOSED: 'bg-hover text-secondary border-line',
  };
  return <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${map[disposition] || 'bg-surface text-secondary border-line'}`}>{disposition?.replace(/_/g, ' ')}</span>;
};


export const ItemHistoryPage = () => {
  const { addToast } = useToast();
  // Which request's slip is open, if any. Separate from the focus filter —
  // reading the details should not also narrow the table under the dialog.
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [detailsFor, setDetailsFor] = useState<{ id: string; serialNo: string } | null>(null);
  const [eventType, setEventType] = useState('');
  const [disposition, setDisposition] = useState('');
  // The By column: who moved the stock, sent to the server as performedById.
  const [performedById, setPerformedById] = useState('');
  // Item / Request / Requested by / Notes column filters — exact values from
  // /inventory/events/filter-options, sent to the server as itemName,
  // requestSerial, requestedById and notes.
  const [itemName, setItemName] = useState('');
  const [requestSerial, setRequestSerial] = useState('');
  const [requestedById, setRequestedById] = useState('');
  const [notesFilter, setNotesFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [source, setSource] = useState('');
  // Drill-down: one item's whole life, or one request's whole story. Driven by
  // the URL so the inventory table can link straight here, and so a narrowed
  // view can be copied to somebody else and still be the same view.
  const [searchParams, setSearchParams] = useSearchParams();
  const itemId = searchParams.get('inventoryItemId') || '';
  const requestId = searchParams.get('componentRequestId') || '';
  const [focusLabel, setFocusLabel] = useState('');
  const focusOn = (params: { inventoryItemId?: string; componentRequestId?: string }, label: string) => {
    const next = new URLSearchParams();
    if (params.inventoryItemId) next.set('inventoryItemId', params.inventoryItemId);
    if (params.componentRequestId) next.set('componentRequestId', params.componentRequestId);
    setFocusLabel(label);
    setSearchParams(next);
  };
  const clearFocus = () => { setFocusLabel(''); setSearchParams(new URLSearchParams()); };
  // A link arriving from another page carries the id but not a human name for
  // it; take the name off the first row that comes back.
  useEffect(() => { if (!itemId && !requestId) setFocusLabel(''); }, [itemId, requestId]);

  // 10/page server-side — the trail runs to hundreds of thousands of events,
  // so it is never loaded whole. Every column filter, the From–To range (the
  // same range as the Date column) and the search box go to the server, so
  // each one searches the whole trail.
  const { items: events, total, page, setPage, totalPages, search, setSearch, isLoading: loading } =
    useServerPagination<any>({ urlKey: 'page',
      endpoint: '/inventory/events',
      itemsKey: 'events',
      params: {
        eventType: eventType || undefined,
        disposition: disposition || undefined,
        from: dateFrom ? localDayStartIso(dateFrom) : undefined,
        to: dateTo ? localDayEndIso(dateTo) : undefined,
        performedById: performedById || undefined,
        itemName: itemName || undefined,
        requestSerial: requestSerial || undefined,
        requestedById: requestedById || undefined,
        notes: notesFilter || undefined,
        source: source || undefined,
        inventoryItemId: itemId || undefined,
        componentRequestId: requestId || undefined,
      },
    });

  useEffect(() => {
    if (focusLabel || events.length === 0) return;
    if (itemId) setFocusLabel(events[0]?.inventoryItem?.name || 'this item');
    else if (requestId) setFocusLabel(events[0]?.componentRequest?.serialNo || 'this request');
  }, [events, itemId, requestId, focusLabel]);

  // By column choices: every user (deactivated ones too — they still appear
  // in old events). GET /users is open to both roles that reach this page.
  // Falls back to the names on screen if it fails.
  const [allUsers, setAllUsers] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    client.get('/users', { signal: abortSignal() })
      .then(res => {
        const d = res.data?.data ?? res.data ?? [];
        setAllUsers(Array.isArray(d) ? d.filter((u: any) => u?.id && u?.name).map((u: any) => ({ id: u.id, name: u.name })) : []);
      })
      .catch(() => { /* fall back to the names on screen, below */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);
  const byOptions = useMemo(() => {
    const src = allUsers.length > 0
      ? allUsers
      : events.map((e: any) => e.performedBy).filter((u: any) => u?.id && u?.name);
    const seen = new Map<string, string>();
    for (const u of src) seen.set(u.id, u.name);
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [allUsers, events]);

  // Item / Request / Requested by / Notes choices, from the whole trail
  // (server-side, same predicate as the list). Request serials and notes are
  // the 500 most recently used; older ones are still found by the search box.
  // Falls back to the values on screen if the call fails.
  const [eventOpts, setEventOpts] = useState<{
    itemNames: string[]; requestSerials: string[]; requesters: { id: string; name: string }[]; notes: string[];
  } | null>(null);
  useEffect(() => {
    client.get('/inventory/events/filter-options', { signal: abortSignal() })
      .then(res => setEventOpts(res.data?.data ?? res.data ?? null))
      .catch(() => { /* fall back to the values on screen, below */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  }, []);
  // Value list -> dropdown options, keeping a picked value offered even when
  // the list does not hold it (an older serial typed in from a link, say).
  const toOpts = (vals: string[] | undefined, fallback: (e: any) => string | undefined, picked: string) => {
    const list = vals && vals.length > 0
      ? vals
      : [...new Set(events.map(fallback).filter((v): v is string => !!v))].sort((a, b) => a.localeCompare(b));
    const withPicked = picked && !list.includes(picked) ? [picked, ...list] : list;
    return withPicked.map((v) => ({ value: v, label: v }));
  };
  const itemOptions = toOpts(eventOpts?.itemNames, (e) => e.inventoryItem?.name, itemName);
  const requestOptions = toOpts(eventOpts?.requestSerials, (e) => e.componentRequest?.serialNo, requestSerial);
  const notesOptions = toOpts(eventOpts?.notes, (e) => e.notes, notesFilter);
  const requesterOptions = useMemo(() => {
    const src: { id: string; name: string }[] = eventOpts?.requesters?.length
      ? eventOpts.requesters
      : events.map((e: any) => e.componentRequest?.createdBy).filter((u: any) => u?.id && u?.name);
    const seen = new Map<string, string>();
    for (const u of src) seen.set(u.id, u.name);
    return [...seen].map(([value, label]) => ({ value, label })).sort((a, b) => a.label.localeCompare(b.label));
  }, [eventOpts, events]);
  const serverFilter = (label: string, value: string, onChange: (v: string) => void, options: { value: string; label: string }[]) => ({
    filterActive: !!value,
    header: <span className="inline-flex items-center">{label}<ColumnFilter searchable options={options} value={value} onChange={onChange} /></span>,
  });
  // Time, Qty and Stock After carry no column filter: a filter needs a value
  // the server can match across the whole trail, and an exact clock minute or
  // a single stock figure is not one worth offering (the Date range and the
  // Event filter answer the questions those would).

  // Export the FULL filtered dataset, not just the visible 10-row page.
  //
  // Built by the server, not here. This used to ask the list endpoint for
  // `take=10000` and assemble the CSV in the browser, which meant the whole
  // audit trail crossed the wire as JSON with every relation expanded just to
  // become text — and it capped the export at whatever the client dared ask
  // for. The list endpoint now refuses a take that large, so the two had to
  // move together. The endpoint shares one filter predicate with the list, so
  // the file cannot select a different set from the table it was launched
  // from.
  const [exporting, setExporting] = useState(false);
  const exportCSV = async () => {
    const params = new URLSearchParams();
    if (eventType) params.set('eventType', eventType);
    if (disposition) params.set('disposition', disposition);
    if (source) params.set('source', source);
    if (itemId) params.set('inventoryItemId', itemId);
    if (requestId) params.set('componentRequestId', requestId);
    if (performedById) params.set('performedById', performedById);
    if (itemName) params.set('itemName', itemName);
    if (requestSerial) params.set('requestSerial', requestSerial);
    if (requestedById) params.set('requestedById', requestedById);
    if (notesFilter) params.set('notes', notesFilter);
    if (search.trim()) params.set('search', search.trim());
    // Same local-day instants as the table's own query above.
    if (dateFrom) params.set('from', localDayStartIso(dateFrom));
    if (dateTo) params.set('to', localDayEndIso(dateTo));

    setExporting(true);
    try {
      const res = await client.get(`/inventory/events/export?${params.toString()}`, { responseType: 'blob', signal: abortSignal() });
      const url = URL.createObjectURL(res.data as Blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `inventory-audit-${localDayKey(new Date().toISOString())}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      // A refusal here carries a reason worth reading — too many rows for one
      // file, or the per-minute export limit. axios hands back a Blob because
      // that is what we asked for, so the JSON has to be read out of it.
      let msg = 'Could not build the export';
      try {
        const body = e?.response?.data;
        const text = body instanceof Blob ? await body.text() : '';
        msg = JSON.parse(text)?.message || msg;
      } catch { /* keep the generic message */ }
      addToast(msg, 'error');
    } finally {
      setExporting(false);
    }
  };

  const clearFilters = () => { setSearch(''); setEventType(''); setDisposition(''); setDateFrom(''); setDateTo(''); setPerformedById(''); setSource(''); setItemName(''); setRequestSerial(''); setRequestedById(''); setNotesFilter(''); };
  const hasFilters = !!(search || eventType || disposition || dateFrom || dateTo || performedById || source || itemName || requestSerial || requestedById || notesFilter);
  const narrowed = hasFilters || !!itemId || !!requestId;

  const columns = [
    { filterActive: !!(dateFrom || dateTo), header: <span className="inline-flex items-center">Date<ColumnFilter options={[]} value="" onChange={() => {}} allLabel="Any time" range={{ from: dateFrom, to: dateTo, onChange: (f, t) => { setDateFrom(f); setDateTo(t); } }} /></span>, accessor: (r: any) => <span className="text-xs text-muted">{fmtTime(r.createdAt)}</span> },
    // Its own column, not tacked onto the date: eleven movements on one day
    // used to render as eleven identical cells, and the order they happened in
    // is most of what an audit trail is for.
    { header: 'Time', accessor: (r: any) => <span className="text-xs font-mono text-muted">{fmtClock(r.createdAt)}</span> },
    { ...serverFilter('Item', itemName, setItemName, itemOptions), accessor: (r: any) => (
        r.inventoryItem?.id
          ? <button
              type="button"
              onClick={() => focusOn({ inventoryItemId: r.inventoryItem.id }, r.inventoryItem.name)}
              className="font-medium text-sm text-ink underline decoration-dotted underline-offset-2 hover:text-brand text-left"
              title={`Show everything that has happened to ${r.inventoryItem.name}`}
            >{r.inventoryItem.name}</button>
          : <span className="font-medium text-ink text-sm">-</span>
      ) },
    { filterActive: !!eventType, header: <span className="inline-flex items-center">Event<ColumnFilter options={EVENT_TYPES} value={eventType} onChange={setEventType} /></span>,
      accessor: (r: any) => <EventBadge type={r.eventType} /> },
    { header: 'Qty', accessor: (r: any) =>
      renderQtyChange(r.eventType, r.quantityChange, r.inventoryItem?.unit || '')
    },
    { header: 'Stock After', accessor: (r: any) => <span className="text-sm font-mono text-muted">{r.stockAfter}</span> },
    { ...serverFilter('Request', requestSerial, setRequestSerial, requestOptions), accessor: (r: any) => r.componentRequest?.serialNo
        ? <RequestLinkMenu
            serialNo={r.componentRequest.serialNo}
            issued={!!r.componentRequest.issuedAt}
            onShowHistory={() => focusOn({ componentRequestId: r.componentRequest.id }, r.componentRequest.serialNo)}
            onShowDetails={() => setDetailsFor({ id: r.componentRequest.id, serialNo: r.componentRequest.serialNo })}
          />
        : <span className="text-xs text-faint">-</span> },
    // Who ASKED for the part — not the same person as "By", which is whoever
    // moved the stock and is almost always the same storekeeper on every row.
    // Without this the trail showed three different people's withdrawals all
    // attributed to one name.
    { ...serverFilter('Requested by', requestedById, setRequestedById, requesterOptions), accessor: (r: any) => r.componentRequest?.createdBy?.name
        ? <span className="text-xs text-ink">{r.componentRequest.createdBy.name}</span>
        : <span className="text-xs text-faint">-</span> },
    // Only arrivals have a provenance; an issue or a return does not, and the
    // linked request already says where those went.
    { filterActive: !!source, header: <span className="inline-flex items-center">Via<ColumnFilter options={SOURCES} value={source} onChange={setSource} /></span>,
      accessor: (r: any) => r.source
        ? <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border ${
            r.source === 'RECONSTRUCTED'
              ? 'bg-surface text-muted border-line italic'
              : 'bg-sky-50 dark:bg-sky-400/15 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-400/30'}`}
            title={r.source === 'RECONSTRUCTED'
              ? 'Inferred from when the item row was created — this arrival was never actually recorded'
              : undefined}
          >{SOURCE_LABEL[r.source] || r.source}</span>
        : <span className="text-xs text-faint">-</span> },
    { filterActive: !!disposition, header: <span className="inline-flex items-center">Disposition<ColumnFilter options={DISPOSITIONS} value={disposition} onChange={setDisposition} /></span>,
      accessor: (r: any) => r.disposition ? <DispositionBadge disposition={r.disposition} /> : <span className="text-faint text-xs">-</span> },
    { filterActive: !!performedById, header: <span className="inline-flex items-center">By<ColumnFilter searchable options={byOptions} value={performedById} onChange={setPerformedById} /></span>, accessor: (r: any) => <span className="text-xs text-muted">{r.performedBy?.name || '-'}</span> },
    { ...serverFilter('Notes', notesFilter, setNotesFilter, notesOptions), accessor: (r: any) => <span className="text-xs text-faint truncate max-w-[150px] block" title={r.notes || ''}>{r.notes || '-'}</span> },
  ];

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="bg-card p-4 md:p-6 rounded-lg shadow-sm border border-line-soft">
        <div className="flex flex-col space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Inventory Audit Trail</h2>
              <p className="text-sm md:text-[15px] text-muted mt-1.5">{total} {hasFilters ? `event${total === 1 ? '' : 's'} match these filters` : 'events recorded'}</p>
            </div>
            <button onClick={exportCSV} disabled={exporting} className="flex items-center gap-2 px-4 py-2 bg-brand text-white font-bold rounded-md hover:bg-brand-dark transition-colors text-sm disabled:opacity-60">
              {exporting ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} {exporting ? 'Building…' : 'Export CSV'}
            </button>
          </div>
          <div className="flex flex-col md:flex-row gap-3 items-center">
            <div className="flex-1 w-full">
              <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by item name or notes..." />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-faint">From</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="px-2 py-1.5 border border-line rounded-lg text-xs focus:border-brand outline-none" />
              <span className="text-xs text-faint">To</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="px-2 py-1.5 border border-line rounded-lg text-xs focus:border-brand outline-none" />
            </div>
            {hasFilters && <button onClick={clearFilters} className="text-sm text-brand font-bold hover:underline whitespace-nowrap">Clear</button>}
          </div>
        </div>
      </div>

      {/* Narrowed to one item or one request. Says so plainly and offers the way
          back — a filtered table that does not announce itself reads as missing
          data. */}
      {(itemId || requestId) && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2">
          <span className="text-sm text-brand-700">
            Showing the full history of{' '}
            <span className="font-bold">{focusLabel || (itemId ? 'one item' : 'one request')}</span>
            {total > 0 && <> — {total} event{total === 1 ? '' : 's'}</>}
          </span>
          <button
            type="button"
            onClick={clearFocus}
            className="ml-auto text-sm font-bold text-brand hover:underline"
          >Show everything again</button>
        </div>
      )}

      <div className="bg-card rounded-lg shadow-sm border border-line-soft overflow-hidden">
        <DataTable
          columns={columns}
          data={events}
          isLoading={loading}
          keyExtractor={(r) => r.id}
          emptyStateMessage={narrowed
            ? 'No events match these filters.'
            : 'No inventory events found. Events appear as items are received, issued, returned, and tracked.'}
          maxHeight="60vh"
        />
        <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
      </div>
      <RequestDetailsModal
        requestId={detailsFor?.id ?? null}
        serialNo={detailsFor?.serialNo}
        onClose={() => setDetailsFor(null)}
      />
    </div>
  );
};
