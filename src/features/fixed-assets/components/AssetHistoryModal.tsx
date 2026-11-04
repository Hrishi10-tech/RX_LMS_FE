import { useEffect, useState } from 'react';
import { client } from '@/api';
import { Modal } from '@/components/ui';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import { csvTextCell } from '@/utils/csv';
import { ArrowRight, Clock, Wrench, History as HistoryIcon, Download } from 'lucide-react';

interface AssetHistoryModalProps {
    asset: any;
    onClose: () => void;
}

interface HistoryEvent {
    id: string;
    eventType: string;
    diff?: Record<string, any> | null;
    notes?: string | null;
    createdAt: string;
    performedBy?: { id: string; name: string; email: string } | null;
}

interface MaintenanceLog {
    id: string;
    createdAt: string;
    notes?: string | null;
    nextDueSnapshot?: string | null;
    performedBy?: { id: string; name: string } | null;
}

// Type → badge palette. Centralised so adding a new event type only
// requires one entry. Falls back to neutral grey when unknown so the UI
// doesn't break if the backend adds a type the frontend hasn't shipped yet.
const EVENT_STYLES: Record<string, { bg: string; text: string; label: string }> = {
    CREATED:               { bg: 'bg-emerald-50 dark:bg-emerald-400/15 border-emerald-200 dark:border-emerald-400/30', text: 'text-emerald-700 dark:text-emerald-300', label: 'Created' },
    UPDATED:               { bg: 'bg-blue-50 dark:bg-blue-400/15 border-blue-200 dark:border-blue-400/30',       text: 'text-blue-700 dark:text-blue-300',    label: 'Updated' },
    CUSTODIAN_TRANSFERRED: { bg: 'bg-violet-50 dark:bg-violet-400/15 border-violet-200 dark:border-violet-400/30',   text: 'text-violet-700 dark:text-violet-300',  label: 'Transferred' },
    CONDITION_CHANGED:     { bg: 'bg-amber-50 dark:bg-amber-400/15 border-amber-200 dark:border-amber-400/30',     text: 'text-amber-700 dark:text-amber-300',   label: 'Condition changed' },
    PHOTO_ADDED:           { bg: 'bg-cyan-50 dark:bg-cyan-400/15 border-cyan-200 dark:border-cyan-400/30',       text: 'text-cyan-700 dark:text-cyan-300',    label: 'Photo added' },
    PHOTO_REMOVED:         { bg: 'bg-rose-50 dark:bg-rose-400/15 border-rose-200 dark:border-rose-400/30',       text: 'text-rose-700 dark:text-rose-300',    label: 'Photo removed' },
    APPROVAL_REQUESTED:    { bg: 'bg-orange-50 dark:bg-orange-400/15 border-orange-200 dark:border-orange-400/30',   text: 'text-orange-700 dark:text-orange-300',  label: 'Approval requested' },
    APPROVED:              { bg: 'bg-emerald-50 dark:bg-emerald-400/15 border-emerald-200 dark:border-emerald-400/30', text: 'text-emerald-700 dark:text-emerald-300', label: 'Approved' },
    REJECTED:              { bg: 'bg-red-50 dark:bg-red-400/15 border-red-200 dark:border-red-400/30',         text: 'text-red-700 dark:text-red-300',     label: 'Rejected' },
    MAINTENANCE_LOGGED:    { bg: 'bg-green-50 dark:bg-green-400/15 border-green-200 dark:border-green-400/30',     text: 'text-green-700 dark:text-green-300',   label: 'Maintenance logged' },
};

const FIELD_LABELS: Record<string, string> = {
    name: 'Name',
    category: 'Category',
    departmentId: 'Department',
    location: 'Location',
    custodianId: 'Custodian',
    condition: 'Condition',
};

// Render a single diff entry. Handles three shapes: { from, to } (UPDATED
// + specialised events), bare key/value snapshots (CREATED), and photo
// metadata blobs (PHOTO_ADDED / PHOTO_REMOVED).
const renderDiffValue = (v: any) => {
    if (v === null || v === undefined) return <span className="italic text-faint">none</span>;
    if (typeof v === 'object') return <span className="font-mono text-[10px]">{JSON.stringify(v)}</span>;
    return <span className="font-medium">{String(v)}</span>;
};

const DiffRow = ({ field, value }: { field: string; value: any }) => {
    const label = FIELD_LABELS[field] || field;
    // { from, to } shape
    if (value && typeof value === 'object' && 'from' in value && 'to' in value) {
        return (
            <div className="flex items-center gap-2 text-xs">
                <span className="text-muted font-medium min-w-[80px]">{label}:</span>
                {renderDiffValue(value.from)}
                <ArrowRight size={12} className="text-faint" />
                {renderDiffValue(value.to)}
            </div>
        );
    }
    // Bare value (CREATED snapshot / photo metadata)
    return (
        <div className="flex items-center gap-2 text-xs">
            <span className="text-muted font-medium min-w-[80px]">{label}:</span>
            {renderDiffValue(value)}
        </div>
    );
};

// Client-side CSV download of already-loaded rows. Dependency-free —
// builds a CSV string, blobs it, clicks a synthetic anchor, revokes.
const downloadCSV = (filename: string, header: string, rows: string) => {
    const blob = new Blob([header + rows], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
};

// Text cells go through csvTextCell: notes and names are user-typed, and a
// note starting with "=" would otherwise run as a formula when the file is
// opened in Excel.
const csvCell = csvTextCell;

export const AssetHistoryModal = ({ asset, onClose }: AssetHistoryModalProps) => {
    const [events, setEvents] = useState<HistoryEvent[]>([]);
    const [serviceLog, setServiceLog] = useState<MaintenanceLog[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Two tabs: full event timeline + service-only log. The service log
    // is the "how often has this been serviced?" view — chronological,
    // service-row only, with next-due snapshot per row.
    const [tab, setTab] = useState<'events' | 'service'>('events');

    useEffect(() => {
        if (!asset?.id) {
            setEvents([]);
            setServiceLog([]);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setError(null);
        Promise.all([
            client.get(`/fixed-assets/${asset.id}/history`).then(r => r.data?.data ?? r.data ?? []).catch(() => { throw new Error('history'); }),
            client.get(`/fixed-assets/${asset.id}/maintenance`).then(r => r.data?.data ?? r.data ?? []).catch(() => []),
        ])
            .then(([h, m]) => {
                if (cancelled) return;
                setEvents(Array.isArray(h) ? h : []);
                setServiceLog(Array.isArray(m) ? m : []);
            })
            .catch((e: any) => {
                if (cancelled) return;
                setError(extractErrorMessage(e, 'Failed to load history'));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [asset?.id]);

    const tag = asset?.assetTag || 'asset';
    const today = new Date().toISOString().split('T')[0];

    // Export the events timeline currently shown. The diff blob is flattened
    // to a compact JSON string so the change detail survives the round-trip.
    const exportEvents = () => {
        const header = 'S.No,Timestamp,Event,Performed By,Notes,Changes\n';
        const rows = events.map((ev, i) => {
            const label = EVENT_STYLES[ev.eventType]?.label || ev.eventType;
            const changes = ev.diff && Object.keys(ev.diff).length ? JSON.stringify(ev.diff) : '';
            return [
                i + 1,
                csvCell(fmtDateTime(ev.createdAt)),
                csvCell(label),
                csvCell(ev.performedBy?.name || 'Unknown'),
                csvCell(ev.notes || ''),
                csvCell(changes),
            ].join(',');
        }).join('\n');
        downloadCSV(`asset-history-${tag}-${today}.csv`, header, rows);
    };

    // Export the service-only log currently shown.
    const exportService = () => {
        const header = 'S.No,Timestamp,Performed By,Notes,Next Due\n';
        const rows = serviceLog.map((s, i) => [
            i + 1,
            csvCell(fmtDateTime(s.createdAt)),
            csvCell(s.performedBy?.name || 'Unknown'),
            csvCell(s.notes || ''),
            csvCell(s.nextDueSnapshot ? new Date(s.nextDueSnapshot).toDateString() : ''),
        ].join(',')).join('\n');
        downloadCSV(`asset-service-log-${tag}-${today}.csv`, header, rows);
    };

    return (
        <Modal isOpen={!!asset} onClose={onClose} title={`History — ${asset?.assetTag || ''}`}>
            <div className="space-y-3 max-h-[70vh] overflow-y-auto p-1">
                {/* Tabs */}
                <div className="flex items-center gap-2 border-b border-line-soft pb-2">
                    <button
                        onClick={() => setTab('events')}
                        className={`text-xs font-bold px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 transition-colors ${
                            tab === 'events' ? 'bg-brand text-white' : 'text-muted hover:bg-surface'
                        }`}
                    >
                        <HistoryIcon size={12} /> All events ({events.length})
                    </button>
                    <button
                        onClick={() => setTab('service')}
                        className={`text-xs font-bold px-3 py-1.5 rounded-md inline-flex items-center gap-1.5 transition-colors ${
                            tab === 'service' ? 'bg-brand text-white' : 'text-muted hover:bg-surface'
                        }`}
                    >
                        <Wrench size={12} /> Service log ({serviceLog.length})
                    </button>
                </div>

                {loading && <p className="text-sm text-faint text-center py-6">Loading…</p>}
                {error && <p className="text-sm text-red-700 dark:text-red-300 text-center py-6">{error}</p>}

                {!loading && !error && tab === 'events' && (
                    events.length === 0 ? (
                        <p className="text-sm text-faint text-center py-6">No history yet — events will appear here as the asset changes.</p>
                    ) : (
                      <>
                        <div className="flex justify-end">
                            <button
                                onClick={exportEvents}
                                className="text-[10px] font-bold text-muted hover:text-brand inline-flex items-center gap-1"
                            >
                                <Download size={11} /> Download CSV
                            </button>
                        </div>
                        <div className="relative pl-4 border-l-2 border-line-soft">
                            {events.map((ev) => {
                                const style = EVENT_STYLES[ev.eventType] || { bg: 'bg-surface border-line', text: 'text-secondary', label: ev.eventType };
                                const diffEntries = ev.diff ? Object.entries(ev.diff) : [];
                                return (
                                    <div key={ev.id} className="relative mb-4 last:mb-0">
                                        {/* Timeline dot */}
                                        <span className={`absolute -left-[1.4rem] top-1 w-2.5 h-2.5 rounded-full border-2 ${style.bg.replace('bg-', 'bg-').replace('-50', '-400')} border-card`} />
                                        <div className={`rounded-lg border ${style.bg} p-3`}>
                                            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                                                <span className={`text-xs font-bold ${style.text}`}>{style.label}</span>
                                                <span className="text-[10px] text-muted flex items-center gap-1">
                                                    <Clock size={10} /> {fmtDateTime(ev.createdAt)}
                                                </span>
                                            </div>
                                            <p className="text-[11px] text-muted mb-1">
                                                by <span className="font-bold text-ink">{ev.performedBy?.name || 'Unknown'}</span>
                                            </p>
                                            {ev.notes && <p className="text-[11px] text-ink italic mb-1">{ev.notes}</p>}
                                            {diffEntries.length > 0 && (
                                                <div className="space-y-0.5 mt-2 pt-2 border-t border-card/50">
                                                    {diffEntries.map(([field, value]) => (
                                                        <DiffRow key={field} field={field} value={value} />
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                      </>
                    )
                )}

                {!loading && !error && tab === 'service' && (
                    serviceLog.length === 0 ? (
                        <div className="text-center py-8">
                            <Wrench className="w-10 h-10 text-faint mx-auto mb-2" />
                            <p className="text-sm text-muted font-bold">No service entries yet.</p>
                            <p className="text-xs text-faint mt-1">
                                Click <span className="font-bold">Service</span> on the asset row to log maintenance.
                            </p>
                        </div>
                    ) : (
                      <>
                        <div className="flex justify-end mb-2">
                            <button
                                onClick={exportService}
                                className="text-[10px] font-bold text-muted hover:text-brand inline-flex items-center gap-1"
                            >
                                <Download size={11} /> Download CSV
                            </button>
                        </div>
                        <div className="space-y-2">
                            {serviceLog.map((s) => (
                                <div key={s.id} className="border border-emerald-200 dark:border-emerald-400/30 bg-emerald-50/50 dark:bg-emerald-400/15 rounded-lg p-3">
                                    <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                                        <span className="text-xs font-bold text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1">
                                            <Wrench size={11} /> Serviced
                                        </span>
                                        <span className="text-[10px] text-muted inline-flex items-center gap-1">
                                            <Clock size={10} /> {fmtDateTime(s.createdAt)}
                                        </span>
                                    </div>
                                    <p className="text-[11px] text-muted mb-1">
                                        by <span className="font-bold text-ink">{s.performedBy?.name || 'Unknown'}</span>
                                    </p>
                                    {s.notes && <p className="text-[11px] text-ink italic mb-1">"{s.notes}"</p>}
                                    {s.nextDueSnapshot && (
                                        <p className="text-[10px] text-faint">
                                            Next due bumped to: <span className="font-bold text-muted">{new Date(s.nextDueSnapshot).toDateString()}</span>
                                        </p>
                                    )}
                                </div>
                            ))}
                        </div>
                      </>
                    )
                )}
            </div>
        </Modal>
    );
};
