import { useState, useEffect } from 'react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { fmtDateTime } from '@/utils/date';
import { Archive, Database, Download, Trash2, ShieldCheck, HardDrive, FileSpreadsheet, RotateCcw, Eye, Upload, Loader2, History } from 'lucide-react';
import { useRef } from 'react';
import { OffSiteBackupPanel } from '../components/OffSiteBackupPanel';
import { WipeTestDataPanel } from '../components/WipeTestDataPanel';
import { SnapshotHistoryPanel } from '../components/SnapshotHistoryPanel';
import { ErrorLogPanel } from '../components/ErrorLogPanel';

import { extractErrorMessage } from '@/lib';
import { Modal } from '@/components/ui';
import { BackLink } from '@/components/ui/BackLink';
import { useAbortOnUnmount } from '@/hooks';
export const DatabaseManagerPage = () => {
    // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
    const abortSignal = useAbortOnUnmount();

    const [backups, setBackups] = useState<any[]>([]);
    const [historyKey, setHistoryKey] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [isCreatingJson, setIsCreatingJson] = useState(false);
    const [isCreatingExcel, setIsCreatingExcel] = useState(false);
    const [isCreatingFull, setIsCreatingFull] = useState(false);
    const [isRestoring, setIsRestoring] = useState<string | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [showHistory, setShowHistory] = useState(false);
    const uploadRef = useRef<HTMLInputElement>(null);
    const { addToast } = useToast();
    const confirm = useConfirm();

    // Snapshots are paged. They only ever accumulate — every manual backup,
    // every scheduled one, and two more per wipe — so loading the whole
    // directory meant an unbounded payload and a row in the DOM for each. Fine
    // at thirty, unusable at three thousand.
    const PAGE_SIZE = 10;
    const [page, setPage] = useState(0);
    const [total, setTotal] = useState(0);

    const fetchBackups = async (toPage = page) => {
        try {
            const res = await client.get('/database-manager/backups', { params: { take: PAGE_SIZE, skip: toPage * PAGE_SIZE }, signal: abortSignal() });
            const payload = res.data?.data ?? res.data;
            // Tolerates the old un-paged shape (a bare array) so a stale API
            // build still lists something rather than rendering nothing.
            const items = Array.isArray(payload) ? payload : (payload?.items ?? []);
            const count = Array.isArray(payload) ? payload.length : (payload?.total ?? items.length);
            // Deleting the last row on the last page would otherwise strand the
            // admin on an empty page with no way back but the Newer button.
            //
            // Re-fetches rather than only calling setPage: when `page` already
            // holds the target value, setting it to the same number is a no-op,
            // the [page] effect never re-runs, and this `return` leaves the old
            // (empty) list on screen forever. That is precisely what turned an
            // off-by-one page request into a permanent "No backups found."
            if (items.length === 0 && toPage > 0 && count > 0) {
                setPage(toPage - 1);
                await fetchBackups(toPage - 1);
                return;
            }
            setBackups(items);
            setTotal(count);
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to load database backups'), 'error'); } finally {
            setIsLoading(false);
        }
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch whenever the page changes
    useEffect(() => { fetchBackups(page); }, [page]);

    const handleCreateJsonBackup = async () => {
        setIsCreatingJson(true);
        try {
            await client.post('/database-manager/backup');
            addToast('JSON backup created successfully!', 'success');
            fetchBackups();
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to create JSON backup'), 'error'); }
        finally { setIsCreatingJson(false); }
    };

    const handleCreateExcelBackup = async () => {
        setIsCreatingExcel(true);
        try {
            await client.post('/database-manager/backup-excel');
            addToast('Excel backup created successfully!', 'success');
            fetchBackups();
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to create Excel backup'), 'error'); }
        finally { setIsCreatingExcel(false); }
    };

    // Database AND the files it points at. A JSON snapshot stores the path to
    // a payment receipt, not the receipt — restore it onto a fresh server and
    // every attachment is a dead link. This is the one to take before a
    // migration or a move.
    const handleCreateFullBackup = async () => {
        setIsCreatingFull(true);
        try {
            const res = await client.post('/database-manager/backup/full');
            const data = res.data?.data || res.data;
            addToast(data?.message || 'Full backup created.', 'success');
            fetchBackups();
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to create full backup'), 'error'); }
        finally { setIsCreatingFull(false); }
    };

    const handleDownload = async (filename: string) => {
        try {
            const res = await client.get(`/database-manager/download/${encodeURIComponent(filename)}`, { responseType: 'blob', signal: abortSignal() });
            const url = window.URL.createObjectURL(new Blob([res.data]));
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            window.URL.revokeObjectURL(url);
        } catch (e: any) { addToast(extractErrorMessage(e, 'Download failed'), 'error'); }
    };

    const handleView = async (filename: string) => {
        try {
            const res = await client.get(`/database-manager/download/${encodeURIComponent(filename)}`, { responseType: 'blob', signal: abortSignal() });
            const url = window.URL.createObjectURL(new Blob([res.data], { type: 'application/json' }));
            window.open(url, '_blank');
            setTimeout(() => window.URL.revokeObjectURL(url), 1000);
        } catch (e: any) { addToast(extractErrorMessage(e, 'View failed'), 'error'); }
    };

    const handleDelete = async (filename: string) => {
        if (!await confirm(`Are you sure you want to delete backup ${filename}?`)) return;
        try {
            await client.delete(`/database-manager/backups/${encodeURIComponent(filename)}`);
            addToast('Backup deleted', 'success');
            fetchBackups();
            // Pull the history too, so the entry for this deletion appears
            // straight away rather than on the next page load.
            setHistoryKey((k) => k + 1);
        } catch (e: any) { addToast(extractErrorMessage(e, 'Failed to delete backup'), 'error'); }
    };

    const handleRestore = async (filename: string) => {
        if (!await confirm(
            'WARNING: This will REPLACE ALL current data with this backup.\n\n'
            + 'All existing records will be permanently deleted and replaced with the backup contents.\n\n'
            + 'PASSWORDS ARE PART OF THE BACKUP. Everyone\'s password — including yours — '
            + 'goes back to what it was when this snapshot was taken, and anyone who has '
            + 'changed theirs since will be locked out. Make sure you know a password that '
            + 'worked when this snapshot was taken before you continue.\n\n'
            + (filename.endsWith('.tar.gz')
                ? 'This is a full archive: the uploaded files in it (receipts, photos, documents) are put back too.\n\n'
                : '')
            + 'Are you sure you want to proceed?'
        )) return;
        setIsRestoring(filename);
        try {
            // A .tar.gz carries uploads as well, and goes through the archive
            // route so the files land before the database does.
            const endpoint = filename.endsWith('.tar.gz')
                ? `/database-manager/restore-archive/${filename}`
                : `/database-manager/restore/${filename}`;
            const res = await client.post(endpoint);
            const data = res.data?.data || res.data;
            addToast(data?.message || 'Database restored successfully!', 'success');
            fetchBackups();
        } catch (err: any) {
            addToast(extractErrorMessage(err, 'Failed to restore database'), 'error');
        } finally { setIsRestoring(null); }
    };

    // Files only — for rescuing attachments from an older server's archive
    // without rolling the database back to when that archive was made.
    const handleRestoreFiles = async (filename: string) => {
        if (!await confirm(
            'Restore only the uploaded files from this archive?\n\n'
            + 'Receipts, photos and documents in it are put back (into S3 when that is the store). '
            + 'The database is NOT changed.',
        )) return;
        setIsRestoring(`files:${filename}`);
        try {
            const res = await client.post(`/database-manager/restore-archive/${filename}`, {}, { params: { filesOnly: 'true' } });
            const data = res.data?.data || res.data;
            addToast(data?.message || 'Files restored.', 'success');
        } catch (err: any) {
            addToast(extractErrorMessage(err, 'Failed to restore files'), 'error');
        } finally { setIsRestoring(null); }
    };

    const formatBytes = (bytes: number) => {
        if (bytes === 0) return '0 B';
        const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const isReadableJson = (f: string) => f.includes('db_readable_');
    // Restorable = anything the restore engine can actually read:
    //   db_backup_              the compact file the server writes
    //   db_upload_              one an operator uploaded
    //   db_readable_structured_ the pretty-printed twin of a db_backup_
    //
    // The third was the odd one out, and only by accident. Restore is decided
    // by CONTENT — it parses the file, checks _meta.version and recomputes the
    // SHA-256 from the parsed object, so indentation cannot affect it — but
    // this gate matched on the filename and left the pretty copy looking
    // un-restorable. Verified by actually restoring one: identical row counts,
    // logins intact. It matters because the two files are deleted separately,
    // so a readable copy is often the ONLY surviving record of that moment.
    //
    // The .xlsx export is genuinely not restorable: it is a lossy spreadsheet,
    // and `db_readable_` alone (no `_structured_`) is what names it.
    const isBackupJson = (f: string) =>
        f.includes('db_backup_') || f.includes('db_upload_') || f.includes('db_readable_structured_');
    // full_upload_ is an archive someone uploaded, and gets the same badge.
    const isUploaded = (f: string) => f.includes('db_upload_') || f.includes('full_upload_');
    // A .tar.gz is the database AND the uploaded files. It was labelled
    // "JSON (compact)" and offered only "Restore files only", so a full
    // archive brought over from another server could not be restored whole.
    const isArchive = (f: string) => f.endsWith('.tar.gz');
    const isExcelFile = (f: string) => f.endsWith('.xlsx');

    return (
        <div className="space-y-4 md:space-y-6">
            <BackLink to="/super-admin/settings" label="Settings" />
            {/* Header */}
            <div className="bg-card p-4 md:p-6 rounded-xl shadow-sm border border-line-soft">
                <div className="flex flex-col gap-4">
                    <div>
                        <h2 className="text-xl md:text-2xl md:text-3xl font-bold tracking-tight text-ink flex items-center gap-2">
                            <HardDrive size={22} className="text-brand shrink-0" /> Database Manager
                        </h2>
                        <p className="text-xs md:text-sm text-muted mt-1">Create, download, restore, and manage database snapshots.</p>
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                        <button
                            onClick={handleCreateJsonBackup}
                            disabled={isCreatingJson || isCreatingExcel || isCreatingFull}
                            className="bg-brand text-white px-4 py-2.5 text-sm font-bold rounded-full hover:bg-brand-dark transition-colors shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            <Database size={16} />
                            {isCreatingJson ? 'Creating...' : 'JSON Backup'}
                        </button>
                        <button
                            onClick={handleCreateFullBackup}
                            disabled={isCreatingJson || isCreatingExcel || isCreatingFull}
                            title="Database plus every uploaded file — receipts, vendor forms, asset photos. Use this one before a migration or a server move."
                            className="bg-indigo-700 text-white px-4 py-2.5 text-sm font-bold rounded-lg hover:bg-indigo-800 transition-colors shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            <Archive size={16} />
                            {isCreatingFull ? 'Creating...' : 'Full Backup (+ files)'}
                        </button>
                        <button
                            onClick={handleCreateExcelBackup}
                            disabled={isCreatingJson || isCreatingExcel || isCreatingFull}
                            className="bg-emerald-700 text-white px-4 py-2.5 text-sm font-bold rounded-lg hover:bg-emerald-800 transition-colors shadow-sm disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            <FileSpreadsheet size={16} />
                            {isCreatingExcel ? 'Creating...' : 'Excel Backup'}
                        </button>
                    </div>
                </div>
            </div>

            {/* Off-site backup (GitHub OR S3, both encrypted) — config + manual upload + status */}
            <OffSiteBackupPanel />

            {/* Backup List */}
            <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
                <div className="px-4 md:px-6 py-3 md:py-4 border-b border-line-soft bg-surface flex items-center gap-2">
                    <ShieldCheck size={16} className="text-emerald-700 dark:text-emerald-300 shrink-0" />
                    <h3 className="text-xs md:text-sm font-bold text-ink">Server Snapshots ({total})</h3>
                    {/* Upload lives HERE, beside the list it adds to.
                        Restore could only read snapshots this server had taken
                        itself, so an operator with no shell on the box could
                        download a backup but never put one back — which is
                        exactly what you need when moving data onto a freshly
                        deployed instance. */}
                    <div className="ml-auto flex items-center gap-2">
                        <input
                            ref={uploadRef}
                            type="file"
                            accept=".json,application/json,.gz,.tar.gz,application/gzip"
                            className="hidden"
                            onChange={async (e) => {
                                const f = e.target.files?.[0];
                                if (!f) return;
                                setIsUploading(true);
                                try {
                                    const body = new FormData();
                                    body.append('file', f);
                                    // The shared axios instance defaults to
                                    // application/json; a FormData body sent
                                    // under that header arrives with no file.
                                    const res: any = await client.post('/database-manager/upload', body, {
                                        headers: { 'Content-Type': 'multipart/form-data' },
                                    });
                                    const d = res?.data?.data ?? res?.data ?? {};
                                    addToast(d.message || 'Snapshot uploaded.', 'success');
                                    // Page 0, not 1. `page` is ZERO-indexed
                                    // (skip = toPage * PAGE_SIZE), so asking
                                    // for 1 fetched rows 11-20 — the SECOND
                                    // page. On an instance with a handful of
                                    // snapshots that page is empty, so the
                                    // upload succeeded, said so in a toast,
                                    // and then the list underneath rendered
                                    // "No backups found." The file was there
                                    // the whole time; the UI just looked at
                                    // the wrong page for it.
                                    setPage(0);
                                    await fetchBackups(0);
                                } catch (err: any) {
                                    addToast(extractErrorMessage(err, 'Could not upload that snapshot'), 'error');
                                } finally {
                                    setIsUploading(false);
                                    if (uploadRef.current) uploadRef.current.value = '';
                                }
                            }}
                        />
                        {/* Visible text, not a `title`. As a tooltip this was
                            80 characters — about 560px — on a button sitting
                            43px from the right edge, so the browser shifted it
                            ~400px left to keep it on screen and it landed in
                            the middle of the header, pointing at nothing.
                            Native tooltips are placed relative to the CURSOR
                            and clamped to the viewport, not anchored to their
                            element, so a long one on a right-aligned control
                            always drifts like this.
                            Hidden below `lg`: the header has no room for it on
                            a phone, and "Upload snapshot" carries itself. */}
                        <span className="hidden lg:inline text-[11px] text-faint mr-2 text-right">
                            Took a snapshot on another instance? Upload it here, then Restore it from the list.
                        </span>
                        <button
                            onClick={() => uploadRef.current?.click()}
                            disabled={isUploading}
                            className="inline-flex items-center gap-1.5 text-xs font-bold text-muted hover:text-brand-dark disabled:opacity-50 shrink-0"
                        >
                            {isUploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
                            {isUploading ? 'Uploading…' : 'Upload snapshot'}
                        </button>
                        {/* The deletion log belongs to this list, not to the
                            page. It sat as its own panel under the error log,
                            where it read as a third unrelated section and an
                            operator looking for "what happened to that
                            snapshot" had no reason to scroll past Errors to
                            find out. */}
                        <button
                            onClick={() => setShowHistory(true)}
                            className="inline-flex items-center gap-1.5 text-xs font-bold text-muted hover:text-brand-dark shrink-0"
                            title="Which snapshots were deleted, and by whom"
                        >
                            <History size={13} /> History
                        </button>
                    </div>
                </div>

                {isLoading ? (
                    <div className="flex justify-center py-12">
                        <div className="animate-spin rounded-full h-8 w-8 border-2 border-line border-t-brand"></div>
                    </div>
                ) : backups.length === 0 ? (
                    <div className="text-center py-12 px-4">
                        <HardDrive size={32} className="mx-auto text-faint mb-3" />
                        <p className="text-muted font-medium text-sm">No backups found.</p>
                        <p className="text-xs text-faint mt-1">Create your first backup above.</p>
                    </div>
                ) : (
                    <div className="divide-y divide-line-soft">
                        {backups.map((backup) => (
                            /* An uploaded snapshot is the one row an operator is
                               hunting for — it is the file they just put there,
                               among a hundred auto-generated ones whose names
                               differ only by a timestamp. So it gets a tint, a
                               left rule and a badge, rather than a word in a
                               metadata line that reads like all the others. */
                            <div key={backup.filename} className={`p-3 md:p-4 px-4 md:px-6 transition-colors ${isUploaded(backup.filename) ? 'bg-amber-50/70 dark:bg-amber-400/15 border-l-4 border-amber-400 dark:border-amber-400/50 hover:bg-amber-50 dark:hover:bg-amber-400/20' : 'hover:bg-hover/50'}`}>
                                {/* Top row: icon + info */}
                                <div className="flex items-start gap-3 mb-2 md:mb-0">
                                    <div className={`w-9 h-9 md:w-10 md:h-10 rounded-lg flex items-center justify-center shrink-0 ${isExcelFile(backup.filename) ? 'bg-emerald-50 dark:bg-emerald-400/15' : isUploaded(backup.filename) ? 'bg-amber-100 dark:bg-amber-400/20' : 'bg-indigo-50 dark:bg-indigo-400/15'}`}>
                                        {isExcelFile(backup.filename)
                                            ? <FileSpreadsheet size={16} className="text-emerald-700 dark:text-emerald-300" />
                                            : isUploaded(backup.filename)
                                                ? <Upload size={16} className="text-amber-700 dark:text-amber-300" />
                                                : <Database size={16} className="text-indigo-600 dark:text-indigo-300" />}
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <p className="font-bold text-ink text-sm truncate">{backup.filename}</p>
                                            {isUploaded(backup.filename) && (
                                                <span className="shrink-0 rounded-full bg-amber-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                                                    Uploaded
                                                </span>
                                            )}
                                        </div>
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-[10px] md:text-xs text-muted">
                                            <span>{fmtDateTime(backup.createdAt)}</span>
                                            <span className="hidden sm:inline w-1 h-1 rounded-full bg-faint"></span>
                                            <span className="font-mono text-muted">{formatBytes(backup.sizeBytes)}</span>
                                            <span className="hidden sm:inline w-1 h-1 rounded-full bg-faint"></span>
                                            <span className={`font-semibold ${isExcelFile(backup.filename) ? 'text-emerald-700 dark:text-emerald-300' : isReadableJson(backup.filename) ? 'text-blue-600 dark:text-blue-300' : 'text-amber-700 dark:text-amber-300'}`}>
                                                {isExcelFile(backup.filename) ? 'Excel (not restorable)' : isArchive(backup.filename) ? 'Full archive (database + files)' : isReadableJson(backup.filename) ? 'JSON (readable copy)' : 'JSON (compact)'}
                                            </span>
                                        </div>
                                    </div>
                                </div>
                                {/* Actions row */}
                                <div className="flex items-center gap-1 ml-12 md:ml-13 flex-wrap">
                                    {(isBackupJson(backup.filename) || isArchive(backup.filename)) && (
                                        <button
                                            onClick={() => handleRestore(backup.filename)}
                                            disabled={isRestoring !== null}
                                            className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:bg-amber-400/15 rounded-md transition-colors disabled:opacity-50"
                                        >
                                            <RotateCcw size={12} className={isRestoring === backup.filename ? 'animate-spin' : ''} />
                                            {isRestoring === backup.filename ? 'Restoring...' : 'Restore'}
                                        </button>
                                    )}
                                    {backup.filename.endsWith('.tar.gz') && (
                                        <button
                                            onClick={() => handleRestoreFiles(backup.filename)}
                                            disabled={isRestoring !== null}
                                            title="Put back only the uploaded files in this archive; the database is not changed"
                                            className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:bg-amber-400/15 rounded-md transition-colors disabled:opacity-50"
                                        >
                                            <Upload size={12} className={isRestoring === `files:${backup.filename}` ? 'animate-pulse' : ''} />
                                            {isRestoring === `files:${backup.filename}` ? 'Restoring files...' : 'Restore files only'}
                                        </button>
                                    )}
                                    {isReadableJson(backup.filename) && (
                                        <button
                                            onClick={() => handleView(backup.filename)}
                                            className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:bg-blue-400/15 rounded-md transition-colors"
                                        >
                                            <Eye size={12} /> View
                                        </button>
                                    )}
                                    <button
                                        onClick={() => handleDownload(backup.filename)}
                                        className="flex items-center gap-1 px-2.5 py-1 text-xs font-bold text-brand hover:bg-brand/10 rounded-md transition-colors"
                                    >
                                        <Download size={12} /> Download
                                    </button>
                                    <button
                                        onClick={() => handleDelete(backup.filename)}
                                        className="p-1 text-faint hover:text-red-700 dark:text-red-300 hover:bg-red-50 dark:bg-red-400/15 rounded-md transition-colors"
                                        title="Delete"
                                    >
                                        <Trash2 size={14} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {/* Pager. Hidden on a single page so the common case stays quiet. */}
                {!isLoading && total > PAGE_SIZE && (
                    <div className="px-4 md:px-6 py-3 border-t border-line-soft bg-surface/60 flex items-center justify-between gap-3 flex-wrap">
                        <span className="text-[11px] text-muted font-mono tabular-nums">
                            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of {total}
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setPage(p => Math.max(p - 1, 0))}
                                disabled={page === 0}
                                className="px-3 py-1 text-xs font-bold text-ink bg-card border border-line rounded-md hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                Newer
                            </button>
                            <span className="text-[11px] text-muted tabular-nums">
                                page {page + 1} of {Math.max(Math.ceil(total / PAGE_SIZE), 1)}
                            </span>
                            <button
                                onClick={() => setPage(p => ((p + 1) * PAGE_SIZE < total ? p + 1 : p))}
                                disabled={(page + 1) * PAGE_SIZE >= total}
                                className="px-3 py-1 text-xs font-bold text-ink bg-card border border-line rounded-md hover:bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                            >
                                Older
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Danger Zone — destructive operations behind a strong confirm.
                Used to flip the system from demo / pilot state into a clean
                production-ready slate without touching user accounts, vendors,
                or the off-site backup config (GitHub / S3). */}
            {/* Read-only record of deleted snapshots. Keyed on the same
                counter the backup list uses, so deleting one refreshes both
                and the operator sees the entry appear immediately. */}
            <ErrorLogPanel />

            <WipeTestDataPanel onWipeComplete={() => fetchBackups()} />

            {/* Opened from the Snapshots header. Mounted only while open so
                it fetches when asked for rather than on every page load. */}
            <Modal isOpen={showHistory} onClose={() => setShowHistory(false)} title="Snapshot history" size="xl">
                <SnapshotHistoryPanel refreshKey={historyKey} chrome={false} />
            </Modal>
        </div>
    );
};
