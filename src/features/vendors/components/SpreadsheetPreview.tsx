import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui';
import { Loader2, Download } from 'lucide-react';

/**
 * Renders an uploaded .xlsx/.xls in the app.
 *
 * A browser has a PDF viewer built in and no spreadsheet viewer at all, so a
 * vendor's price list used to be readable only by downloading it and opening
 * Excel. Procurement is comparing it against the row behind this dialog; making
 * them leave the app to read one column defeats the point of filing it here.
 *
 * `xlsx` is already a dependency (the indent form parses BOM uploads with it),
 * so this costs a lazy import rather than a package. Lazy because the parser is
 * large and most documents filed against a vendor are PDFs, which never need it.
 */

const MAX_ROWS = 500;

export function SpreadsheetPreview({
  file,
  onClose,
  onDownload,
}: {
  file: { id: string; fileName: string; blob: Blob } | null;
  onClose: () => void;
  onDownload: () => void;
}) {
  const [sheets, setSheets] = useState<string[]>([]);
  const [active, setActive] = useState('');
  const [rows, setRows] = useState<any[][]>([]);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [workbook, setWorkbook] = useState<any>(null);

  useEffect(() => {
    if (!file) { setWorkbook(null); setSheets([]); setActive(''); setError(''); return; }
    let cancelled = false;
    (async () => {
      setLoading(true); setError('');
      try {
        const XLSX = await import('xlsx');
        const buf = await file.blob.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        if (cancelled) return;
        setWorkbook(wb);
        setSheets(wb.SheetNames);
        setActive(wb.SheetNames[0] || '');
      } catch {
        if (!cancelled) setError('That file could not be read as a spreadsheet.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [file?.id]);

  // Re-render whenever the chosen sheet changes, off the workbook already in
  // memory — switching tabs must not re-download and re-parse the file.
  useEffect(() => {
    if (!workbook || !active) { setRows([]); return; }
    (async () => {
      const XLSX = await import('xlsx');
      // header: 1 → rows of raw cells, so a sheet whose first row is data
      // rather than headings still renders. defval keeps blank cells aligned;
      // without it a short row shifts every value left of where it belongs.
      const all: any[][] = XLSX.utils.sheet_to_json(workbook.Sheets[active], { header: 1, defval: '' });
      setTruncated(all.length > MAX_ROWS);
      setRows(all.slice(0, MAX_ROWS));
    })();
  }, [workbook, active]);

  const width = Math.max(0, ...rows.map(r => r.length));

  return (
    <Modal
      isOpen={!!file}
      onClose={onClose}
      size="3xl"
      title={file?.fileName ?? 'Spreadsheet'}
      headerRight={
        <button
          onClick={onDownload}
          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-bold text-brand-dark hover:underline"
          title="Download the original file"
        >
          <Download size={13} /> Download
        </button>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" /> Reading the spreadsheet…
        </div>
      ) : error ? (
        <p className="py-12 text-center text-sm text-red-700 dark:text-red-300">{error}</p>
      ) : (
        <>
          {sheets.length > 1 && (
            <div className="flex flex-wrap gap-1 mb-3">
              {sheets.map(name => (
                <button
                  key={name}
                  onClick={() => setActive(name)}
                  className={`px-2.5 py-1 text-xs font-bold rounded border transition-colors ${
                    name === active
                      ? 'bg-brand/15 text-brand-dark border-brand/30'
                      : 'text-muted border-line hover:bg-hover'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          {rows.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted">This sheet is empty.</p>
          ) : (
            // Its own scroll container: a wide price list must not make the
            // dialog — or the page behind it — scroll sideways.
            <div className="overflow-auto max-h-[60vh] border border-line rounded">
              <table className="text-xs border-collapse">
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri} className={ri === 0 ? 'bg-surface sticky top-0' : ''}>
                      {Array.from({ length: width }).map((_, ci) => (
                        <td
                          key={ci}
                          className={`border border-line-soft px-2 py-1 whitespace-nowrap max-w-[260px] truncate ${
                            ri === 0 ? 'font-bold text-ink' : 'text-muted'
                          }`}
                          title={String(row[ci] ?? '')}
                        >
                          {String(row[ci] ?? '')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {truncated && (
            <p className="mt-2 text-[11px] text-faint">
              Showing the first {MAX_ROWS} rows. Download the file for the rest.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
