import { useEffect, useMemo, useRef, useState } from 'react';
import { client } from '@/api';
import { Modal, ColumnFilter } from '@/components/ui';
import { EditableCell } from '@/components/ui/EditableCell';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { extractErrorMessage } from '@/lib';
import { dateOnlyKey, fmtDayNumeric } from '@/utils/date';
import { Download, Trash2, FileText, FileSpreadsheet, Loader2 } from 'lucide-react';
import { SpreadsheetPreview } from './SpreadsheetPreview';
import { useAbortOnUnmount } from '@/hooks';

/**
 * Everything filed against one vendor, opened from the View column.
 *
 * Deliberately a slip rather than a page: the documents are read while looking
 * at the vendor's row — a contract is checked against the contact person next
 * to it — and a separate page was what this replaced.
 */

const formatSize = (bytes: number) => {


  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const isSpreadsheet = (fileName: string) => /\.xlsx?$/i.test(fileName);

/**
 * PDFs open in a browser tab, which has a viewer for them.
 *
 * Spreadsheets do not — nothing in a browser renders .xlsx, and pointing a tab
 * at one just produces a second download with a worse filename. Those open in
 * SpreadsheetPreview instead, parsed in the page.
 */
const opensInTab = (fileName: string) => /\.pdf$/i.test(fileName);

export function VendorDocumentsModal({
  vendor,
  unfiled = false,
  onClose,
  onChanged,
  canDelete,
}: {
  vendor: { id: string; vendorName: string; vendorCode?: string; _count?: { forms?: number } } | null;
  /**
   * Show the documents that belong to no vendor instead of one vendor's.
   *
   * These are uploads from before paperwork moved onto the vendor row: the old
   * flat page had no vendor column, so there is nothing to infer an owner
   * from. They would be unreachable now that page is gone, and unreachable is
   * how paperwork gets lost.
   */
  unfiled?: boolean;
  onClose: () => void;
  /** Bumps the vendor row's document count after an upload or delete. */
  onChanged: () => void;
  canDelete: boolean;
}) {
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [docs, setDocs] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const { addToast } = useToast();
  const confirm = useConfirm();

  const load = async () => {
    if (!vendor && !unfiled) return;
    setLoading(true);
    try {
      const params = unfiled ? { unfiled: 'true', take: 200 } : { vendorCodeId: vendor!.id, take: 200 };
      const res = await client.get('/vendor-forms', { params, signal: abortSignal() });
      const d = res.data?.data || res.data;
      const items = d?.items || [];
      setDocs(items);
      // The row's count came from the vendor list; these documents came from
      // just now. They disagree whenever the page has been open while somebody
      // else uploaded or deleted — and then the button goes on promising a
      // number the slip cannot show. Refresh the counts only on a real
      // mismatch, so opening a slip does not refetch the table every time.
      if (unfiled) {
        // The banner's count is a separate query and goes stale the same way.
        // Re-asking is one cheap count, and only when the banner is clicked.
        onChanged();
      } else if (vendor && (vendor._count?.forms ?? 0) !== items.length) {
        onChanged();
      }
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load the documents'), 'error');
    } finally {
      setLoading(false);
    }
  };

  // Reload whenever a different vendor's slip is opened. Clearing the filter
  // too: a date carried over from the last vendor hides everything here and
  // looks like the vendor has no documents.
  useEffect(() => { setDateFrom(''); setDateTo(''); load(); }, [vendor?.id, unfiled]); // reload when the vendor or filter changes

  // Inclusive both ends, and either end may be left blank — "everything since
  // March" is as ordinary a question as a closed range. dateOnlyKey yields
  // YYYY-MM-DD, the same shape the native date input produces, so these compare
  // as plain strings without constructing a Date per row per keystroke.
  const rows = useMemo(() => {
    if (!dateFrom && !dateTo) return docs;
    return docs.filter(d => {
      const key = dateOnlyKey(d.createdAt);
      if (!key) return false;
      if (dateFrom && key < dateFrom) return false;
      if (dateTo && key > dateTo) return false;
      return true;
    });
  }, [docs, dateFrom, dateTo]);

  // Object URLs handed to a new tab cannot be revoked straight away — the tab
  // is still loading from them. They are released when the slip closes.
  const openedUrls = useRef<string[]>([]);
  useEffect(() => () => { openedUrls.current.forEach(URL.revokeObjectURL); openedUrls.current = []; }, []);

  const fetchBlob = async (doc: any) => {
    const res = await client.get(`/vendor-forms/${doc.id}/download`, { responseType: 'blob', signal: abortSignal() });
    return res.data as Blob;
  };

  const download = async (doc: any) => {
    setBusyId(doc.id);
    try {
      const url = URL.createObjectURL(await fetchBlob(doc));
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not download that file'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  /** The spreadsheet currently open in the in-page preview. */
  const [sheetFile, setSheetFile] = useState<{ id: string; fileName: string; blob: Blob } | null>(null);

  /** Clicking the file name shows the document; only the icon downloads it. */
  const view = async (doc: any) => {
    if (!opensInTab(doc.fileName)) {
      // Spreadsheet: fetch it and render it here. No new tab to pre-open,
      // because nothing is being handed to the browser to display.
      setBusyId(doc.id);
      try {
        const blob = await fetchBlob(doc);
        setSheetFile({ id: doc.id, fileName: doc.fileName, blob });
      } catch (e: any) {
        addToast(extractErrorMessage(e, 'Could not open that file'), 'error');
      } finally {
        setBusyId(null);
      }
      return;
    }
    // Opened BEFORE the await, while the click is still on the stack: a
    // window.open() after an async gap has lost the user gesture and browsers
    // block it as a popup.
    const tab = window.open('', '_blank');
    setBusyId(doc.id);
    try {
      const blob = await fetchBlob(doc);
      const url = URL.createObjectURL(blob);
      openedUrls.current.push(url);
      if (tab) {
        tab.location.href = url;
      } else {
        // Popups blocked. Don't silently download something they asked to
        // read — say why, and leave the download icon to do that job.
        addToast('Your browser blocked the preview window. Allow popups for this site, or use the download icon.', 'error');
      }
    } catch (e: any) {
      tab?.close();
      addToast(extractErrorMessage(e, 'Could not open that file'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  const rename = async (doc: any, next: string) => {
    const value = String(next ?? '').trim();
    if (value === (doc.notes || '')) return;
    // Optimistic: the cell already shows what was typed, and snapping back to
    // the old text for the length of a round trip reads as the edit failing.
    setDocs(prev => prev.map(d => (d.id === doc.id ? { ...d, notes: value || null } : d)));
    try {
      await client.patch(`/vendor-forms/${doc.id}`, { notes: value });
    } catch (e: any) {
      setDocs(prev => prev.map(d => (d.id === doc.id ? { ...d, notes: doc.notes } : d)));
      addToast(extractErrorMessage(e, 'Could not rename that document'), 'error');
    }
  };

  const remove = async (doc: any) => {
    const ok = await confirm({
      title: 'Delete this document?',
      message: `"${doc.fileName}" will be removed${vendor ? ` from ${vendor.vendorName}` : ''}. This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    if (!ok) return;
    setBusyId(doc.id);
    try {
      await client.delete(`/vendor-forms/${doc.id}`);
      addToast('Document deleted', 'success');
      await load();
      onChanged();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not delete that file'), 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal
      isOpen={!!vendor || unfiled}
      onClose={onClose}
      size="lg"
      title={unfiled
        ? 'Documents not filed under any vendor'
        : `Documents — ${vendor?.vendorName ?? ''}${vendor?.vendorCode ? ` (${vendor.vendorCode})` : ''}`}
    >
      {loading ? (
        <div className="flex items-center gap-2 py-10 justify-center text-sm text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading documents…
        </div>
      ) : docs.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">
          {unfiled
            ? 'Every document is filed under a vendor.'
            : <>Nothing uploaded for this vendor yet. Use the <span className="font-bold">Upload</span> button on its row.</>}
        </p>
      ) : (
        <>
          {unfiled && (
            <p className="mb-3 text-xs text-muted bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-md px-3 py-2">
              These were uploaded before documents moved onto the vendor row, so nothing records which
              vendor they belong to. Download one to check, then re-upload it against the right vendor
              using that row's <span className="font-bold">Upload</span> button and delete it here.
            </p>
          )}
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-line">
                  <th className="py-2 pr-4 text-[11px] font-bold uppercase tracking-wide text-muted">
                    <span className="inline-flex items-center">
                      Upload date
                      <ColumnFilter
                        options={[]}
                        value=""
                        onChange={() => {}}
                        range={{
                          from: dateFrom,
                          to: dateTo,
                          onChange: (from, to) => { setDateFrom(from); setDateTo(to); },
                        }}
                      />
                    </span>
                  </th>
                  <th className="py-2 pr-4 text-[11px] font-bold uppercase tracking-wide text-muted">Name</th>
                  <th className="py-2 pr-4 text-[11px] font-bold uppercase tracking-wide text-muted">File</th>
                  <th className="py-2 text-[11px] font-bold uppercase tracking-wide text-muted" />
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className="border-b border-line-soft last:border-0">
                    <td className="py-2.5 pr-4 text-xs text-muted whitespace-nowrap">{fmtDayNumeric(d.createdAt)}</td>
                    <td className="py-2.5 pr-4 text-xs text-ink min-w-[140px]">
                      {/* Editable in place: the name is the one field here that
                          is a judgement call, and it is usually got right only
                          once the document is open in front of you. A document
                          with no name shows a dash to click, not an empty cell
                          — an empty cell reads as a rendering fault and gives
                          nothing to aim at. */}
                      {canDelete ? (
                        <EditableCell
                          value={d.notes || ''}
                          onSave={(v) => rename(d, String(v))}
                          placeholder="—"
                          className="text-xs"
                        />
                      ) : (
                        d.notes || <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="py-2.5 pr-4">
                      <button
                        onClick={() => view(d)}
                        disabled={busyId === d.id}
                        className="inline-flex items-center gap-1.5 text-xs font-bold text-brand-dark hover:underline disabled:opacity-50"
                        title={`Open ${d.fileName}`}
                      >
                        {busyId === d.id
                          ? <Loader2 size={13} className="animate-spin" />
                          : isSpreadsheet(d.fileName)
                            ? <FileSpreadsheet size={13} />
                            : <FileText size={13} />}
                        <span className="max-w-[240px] truncate">{d.fileName}</span>
                        <span className="font-normal text-faint">({formatSize(d.fileSize)})</span>
                      </button>
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      <button
                        onClick={() => download(d)}
                        disabled={busyId === d.id}
                        className="p-1.5 text-muted hover:text-brand-dark disabled:opacity-50"
                        title="Download"
                      >
                        <Download size={14} />
                      </button>
                      {canDelete && (
                        <button
                          onClick={() => remove(d)}
                          disabled={busyId === d.id}
                          className="p-1.5 text-muted hover:text-red-700 disabled:opacity-50"
                          title="Delete"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && (
            <p className="py-6 text-center text-xs text-muted">
              No documents uploaded in that date range.
            </p>
          )}
          <p className="mt-3 text-[11px] text-faint">
            {rows.length} of {docs.length} document{docs.length === 1 ? '' : 's'}
          </p>
        </>
      )}
      <SpreadsheetPreview
        file={sheetFile}
        onClose={() => setSheetFile(null)}
        onDownload={() => { const d = docs.find(x => x.id === sheetFile?.id); if (d) download(d); }}
      />
    </Modal>
  );
}
