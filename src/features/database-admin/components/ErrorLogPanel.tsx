import { useEffect, useState, useCallback } from 'react';
import { client } from '@/api';
import { fmtDateTime } from '@/utils/date';
import { AlertTriangle, Check, Loader2, RefreshCw } from 'lucide-react';
import { useAbortOnUnmount } from '@/hooks';

interface Entry {
    id: string;
    source: string;
    message: string;
    detail: string | null;
    path: string | null;
    status: number | null;
    count: number;
    firstSeen: string;
    lastSeen: string;
    resolvedAt: string | null;
    user?: { id: string; name: string; email: string } | null;
}

/**
 * What has broken, for whom, and how often.
 *
 * Before this the app had nowhere to say it. A server failure reached the
 * container's stdout; a browser failure reached the user's own console. So
 * the only way anyone found out was somebody complaining, and the quiet ones
 * — a background refresh that stopped, a tile that silently never loaded —
 * were never reported at all.
 *
 * Rows are grouped by fingerprint with a count, so one component failing in a
 * loop is a single line that climbs rather than a thousand that bury
 * everything else. "Mark seen" hides a row until it happens AGAIN, which is
 * the useful behaviour: something marked fixed that recurs is not fixed, so
 * the server clears the flag on the next occurrence.
 */
export const ErrorLogPanel = () => {
    // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
    const abortSignal = useAbortOnUnmount();

    const [entries, setEntries] = useState<Entry[]>([]);
    const [openCount, setOpenCount] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [onlyOpen, setOnlyOpen] = useState(true);
    const [expanded, setExpanded] = useState<string | null>(null);
    // Shown rather than swallowed: "nothing has broken" and "the list could
    // not be loaded" look identical, and only one of them is good news.
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const res = await client.get('/errors', { params: { onlyOpen: String(onlyOpen), take: 50 }, signal: abortSignal() });
            const payload = res.data?.data ?? res.data;
            setEntries(payload?.items ?? []);
            setOpenCount(payload?.openCount ?? 0);
        } catch {
            setError('Could not load the error log.');
        } finally {
            setIsLoading(false);
        }
    }, [onlyOpen]);

    useEffect(() => { void load(); }, [load]);

    const markSeen = async (id: string) => {
        try {
            await client.patch(`/errors/${id}/resolve`);
            await load();
        } catch {
            setError('Could not mark that one as seen.');
        }
    };

    return (
        <div className="bg-surface border border-line rounded-lg p-4 md:p-6">
            <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                <h3 className="font-bold text-ink flex items-center gap-2">
                    <AlertTriangle size={16} className={openCount > 0 ? 'text-amber-500' : 'text-muted'} />
                    Errors
                    {openCount > 0 && (
                        <span className="text-xs font-bold bg-amber-100 dark:bg-amber-400/20 text-amber-900 dark:text-amber-200 rounded-full px-2 py-0.5">
                            {openCount} unseen
                        </span>
                    )}
                </h3>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setOnlyOpen((v) => !v)}
                        className="text-xs font-bold text-secondary hover:text-ink border border-line rounded-md px-2.5 py-1.5"
                    >
                        {onlyOpen ? 'Show all' : 'Show unseen only'}
                    </button>
                    <button
                        onClick={() => void load()}
                        title="Reload"
                        className="text-secondary hover:text-ink border border-line rounded-md p-1.5"
                    >
                        <RefreshCw size={14} />
                    </button>
                </div>
            </div>

            {error && <p className="text-xs text-red-600 dark:text-red-400 mb-3">{error}</p>}

            {isLoading ? (
                <div className="flex items-center gap-2 text-muted text-sm py-6 justify-center">
                    <Loader2 size={15} className="animate-spin" /> Loading…
                </div>
            ) : entries.length === 0 ? (
                <p className="text-sm text-muted py-6 text-center">
                    {onlyOpen ? 'Nothing unseen. ' : 'Nothing recorded. '}
                    Failures appear here on their own — server and browser both.
                </p>
            ) : (
                <ul className="space-y-2">
                    {entries.map((e) => (
                        <li key={e.id} className="border border-line rounded-md p-3 text-xs">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className="font-bold text-ink break-words">{e.message}</p>
                                    <p className="text-muted mt-1">
                                        <span className="uppercase font-bold">{e.source}</span>
                                        {e.path && <> · {e.path}</>}
                                        {e.status != null && <> · {e.status}</>}
                                        {e.count > 1 && <> · <span className="font-bold">×{e.count}</span></>}
                                        {' · '}last {fmtDateTime(e.lastSeen)}
                                        {e.user && <> · {e.user.name}</>}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1.5 shrink-0">
                                    {e.detail && (
                                        <button
                                            onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                                            className="text-secondary hover:text-ink border border-line rounded px-2 py-1 font-bold"
                                        >
                                            {expanded === e.id ? 'Hide' : 'Detail'}
                                        </button>
                                    )}
                                    {!e.resolvedAt && (
                                        <button
                                            onClick={() => void markSeen(e.id)}
                                            title="Hide until it happens again"
                                            className="inline-flex items-center gap-1 text-secondary hover:text-ink border border-line rounded px-2 py-1 font-bold"
                                        >
                                            <Check size={12} /> Seen
                                        </button>
                                    )}
                                </div>
                            </div>
                            {expanded === e.id && e.detail && (
                                <pre className="mt-2 p-2 bg-hover rounded text-[11px] text-secondary overflow-x-auto whitespace-pre-wrap break-words">
                                    {e.detail}
                                </pre>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
};
