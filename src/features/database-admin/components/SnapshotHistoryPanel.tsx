import { useEffect } from 'react';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { History, Loader2, Trash2 } from 'lucide-react';
import { Pagination, ColumnFilter, LoadAllCapNote } from '@/components/ui';
import { useServerPagination } from '@/hooks/useServerPagination';
import { usePagedFilters, FilterSpec } from '@/hooks';

interface Entry {
    id: string;
    filename: string;
    action: string;
    sizeBytes: number | null;
    performedByName: string | null;
    performedBy?: { id: string; name: string } | null;
    createdAt: string;
}

const fmtSize = (bytes: number | null) => {
    if (!bytes) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
};

const byName = (e: Entry) => e.performedByName || e.performedBy?.name || 'Unknown';

// A filter on every data column (owner, 27 Oct), over the whole loaded log.
// "When" filters by day: every row's time is unique, so a list of exact
// times would only ever match one row.
const HISTORY_FILTER_SPECS: FilterSpec<Entry>[] = [
    { key: 'when', getValue: (e) => fmtDate(e.createdAt) },
    { key: 'file', getValue: (e) => e.filename },
    { key: 'size', getValue: (e) => fmtSize(e.sizeBytes) },
    { key: 'by', getValue: byName },
];

/**
 * Who removed a server snapshot, and when.
 *
 * Snapshots are the only copy of the database that lives outside the database,
 * and deleting one is irreversible, one click, from a page full of destructive
 * controls. Until this existed it left no trace at all: a snapshot that should
 * have been there was simply absent, and nothing could say whether it was
 * removed deliberately, removed by mistake, or never taken in the first place.
 *
 * Deliberately read-only and not clearable from the UI. A log an operator can
 * erase after the fact is not a log — if these rows ever need pruning it should
 * be a deliberate retention job, not a button next to the thing it records.
 */
export const SnapshotHistoryPanel = ({
    refreshKey = 0,
    // `false` when the panel is mounted inside a Modal, which already draws a
    // card and a title — without this the operator gets a bordered box with
    // the same heading twice, nested one inside the other.
    chrome = true,
}: { refreshKey?: number; chrome?: boolean }) => {
    // Paged rather than one unbounded list. The log only grows — nothing
    // prunes it, deliberately — and it used to render every row the endpoint
    // returned, stopping at an arbitrary 100 with nothing on screen admitting
    // older entries existed. One clean-out can add a hundred rows in a minute,
    // which is precisely when somebody needs to look further back.
    //
    // loadAll: one row per deleted snapshot grows slowly, so the whole log
    // (newest first, up to LOAD_ALL_CAP, with a note if it is ever cut) is
    // loaded and the column filters search all of it; only the filtered
    // result is cut into pages of 15.
    //
    // No urlKey: this panel sits among several on the Database Manager page,
    // and a ?page= in the address bar for a side panel would fight whatever
    // else that page wants to put there.
    const {
        items: entries, isLoading, error, refetch, truncated, serverTotal,
    } = useServerPagination<Entry>({
        endpoint: '/database-manager/backups/history',
        loadAll: true,
    });
    const f = usePagedFilters(entries, HISTORY_FILTER_SPECS, 15);
    const th = (label: string, key: string, last = false) => (
        <th className={`pb-2 ${last ? '' : 'pr-3'} font-semibold ${f.isActive(key) ? 'bg-brand-100' : ''}`}>
            <span className="inline-flex items-center">
                {label}
                <ColumnFilter searchable options={f.getOptions(key)} value={f.filters[key] || ''} onChange={(v) => f.setFilter(key, v)} />
            </span>
        </th>
    );
    // Failure is shown rather than swallowed: an empty history and a history
    // that could not be loaded look identical, and only one of them is fine.
    const failed = !!error;

    // The parent bumps refreshKey after a delete, so the newest row appears
    // without a reload. Page 1 is where it lands, hence the reset.
    useEffect(() => {
        if (refreshKey === 0) return;
        f.setPage(1);
        refetch();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch/setPage are stable; keying on them would loop
    }, [refreshKey]);

    return (
        <div className={chrome ? 'bg-card rounded-xl border border-line-soft shadow-sm overflow-hidden' : ''}>
            {chrome ? (
                <div className="px-4 md:px-6 py-4 border-b border-line-soft flex items-center gap-2">
                    <History size={16} className="text-brand" />
                    <div>
                        <h3 className="text-sm font-bold text-ink">Snapshot history</h3>
                        <p className="text-[11px] text-muted mt-0.5">
                            Every server snapshot that has been deleted, and who deleted it.
                        </p>
                    </div>
                </div>
            ) : (
                <p className="text-[11px] text-muted mb-3">
                    Every server snapshot that has been deleted, and who deleted it.
                </p>
            )}

            <div className={chrome ? 'p-4 md:p-6' : ''}>
                {isLoading ? (
                    <p className="text-xs text-muted flex items-center gap-2">
                        <Loader2 size={13} className="animate-spin" /> Loading…
                    </p>
                ) : failed ? (
                    <p className="text-xs text-rose-700 dark:text-rose-300">
                        Could not load the history. It is not empty — it could not be read.
                    </p>
                ) : entries.length === 0 ? (
                    <p className="text-xs text-muted">
                        No snapshot has been deleted yet. Recording starts from the version that
                        introduced this, so anything removed before it is not listed.
                    </p>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-xs">
                            <thead>
                                <tr className="text-left text-faint border-b border-line-soft">
                                    {th('When', 'when')}
                                    {th('Snapshot', 'file')}
                                    {th('Size', 'size')}
                                    {th('By', 'by', true)}
                                </tr>
                            </thead>
                            <tbody>
                                {f.filteredTotal === 0 && (
                                    <tr><td colSpan={4} className="py-4 text-center text-muted">No entries match these filters.</td></tr>
                                )}
                                {f.pageRows.map((e) => (
                                    <tr key={e.id} className="border-b border-line-soft last:border-0">
                                        <td className="py-2 pr-3 text-muted whitespace-nowrap">{fmtDateTime(e.createdAt)}</td>
                                        <td className="py-2 pr-3">
                                            <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-ink break-all">
                                                <Trash2 size={11} className="text-rose-500 shrink-0" />
                                                {e.filename}
                                            </span>
                                        </td>
                                        <td className="py-2 pr-3 text-muted whitespace-nowrap">{fmtSize(e.sizeBytes)}</td>
                                        {/* The stored name, falling back to the live account. The name is
                                            denormalised on write so this still answers after the account
                                            is deleted. */}
                                        <td className="py-2 text-ink">{byName(e)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        <LoadAllCapNote truncated={truncated} shown={entries.length} total={serverTotal} hint="older entries are not listed here." />
                        {f.totalPages > 1 && (
                            <div className="pt-3 mt-3 border-t border-line-soft">
                                <Pagination currentPage={f.page} totalPages={f.totalPages} onPageChange={f.setPage} />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
