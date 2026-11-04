import { useState } from 'react';
import { useToast } from '@/context/ToastContext';
import { downloadFromEndpoint, fetchBlobUrl, extractBlobError } from '@/lib';
import { FileText, FileSpreadsheet, Eye } from 'lucide-react';
import { SlipPreviewModal } from './SlipPreviewModal';

type SlipKind = 'bom-lists' | 'indents' | 'requests';

interface SlipDownloadButtonsProps {
  kind: SlipKind;
  /** Record id — the `/:id/export` path segment. */
  id: string;
  /** Human serial (BOM-001 / IND-001 / REQ-001) for the fallback filename + toast. */
  serialNo?: string;
  /** Compact variant for tight modal headers. */
  size?: 'sm' | 'md';
  className?: string;
  /** Override the export endpoint (default `/{kind}/{id}/export`). Used to point
   *  at a sub-resource slip, e.g. one quotation version:
   *  `/indents/{id}/quotations/{quotationId}/export`. */
  exportPath?: string;
  /** Show an inline "View" button that opens the PDF slip in a new tab (no
   *  download). Off by default so existing headers are unchanged. */
  showView?: boolean;
}

const NOUN: Record<SlipKind, string> = {
  'bom-lists': 'BOM',
  indents: 'indent',
  requests: 'request',
};

/**
 * Two small buttons — PDF slip + CSV — that download a SINGLE record from its
 * detail view. The bulk counterpart is ExportPanel; both share the same
 * server-rendered, role-scoped endpoints and the same blob plumbing
 * (downloadFromEndpoint), so a single record and a range download identically.
 *
 * Hits `GET /{kind}/{id}/export?format=pdf|csv`. The backend gates visibility
 * (you can only download a record you're allowed to see) and sets the
 * filename, so this component stays presentational + stateless beyond its busy
 * flag.
 */
export const SlipDownloadButtons = ({ kind, id, serialNo, size = 'md', className = '', exportPath, showView = false }: SlipDownloadButtonsProps) => {
  const { addToast } = useToast();
  const [busy, setBusy] = useState<'view' | 'pdf' | 'csv' | null>(null);
  const [preview, setPreview] = useState<{ url: string; title: string } | null>(null);

  const view = async () => {
    if (busy) return;
    setBusy('view');
    try {
      const url = await fetchBlobUrl(exportPath || `/${kind}/${id}/export`, { format: 'pdf' });
      setPreview({ url, title: `${NOUN[kind]} ${serialNo || id}` });
    } catch (e) {
      addToast(await extractBlobError(e, 'Could not open slip'), 'error');
    } finally {
      setBusy(null);
    }
  };
  const closePreview = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };

  const run = async (format: 'pdf' | 'csv') => {
    if (busy) return;
    setBusy(format);
    try {
      const slug = serialNo || id;
      const filename = await downloadFromEndpoint(
        exportPath || `/${kind}/${id}/export`,
        { format },
        `${NOUN[kind]}_${slug}.${format}`,
      );
      addToast(`Downloaded ${filename}`, 'success');
    } catch (e) {
      addToast(await extractBlobError(e, 'Download failed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pad = size === 'sm' ? 'px-2 py-1' : 'px-2.5 py-1.5';
  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`}>
      {showView && (
        <button
          type="button"
          onClick={view}
          disabled={busy !== null}
          title={`Open this ${NOUN[kind]} slip in a new tab (no download)`}
          className={`inline-flex items-center gap-1 text-xs font-bold text-ink border border-line bg-card hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed rounded ${pad} transition-colors whitespace-nowrap`}
        >
          <Eye size={12} />
          {busy === 'view' ? '...' : 'View'}
        </button>
      )}
      <button
        type="button"
        onClick={() => run('pdf')}
        disabled={busy !== null}
        title={`Download this ${NOUN[kind]} as a printable PDF slip`}
        className={`inline-flex items-center gap-1 text-xs font-bold text-card bg-ink hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed rounded ${pad} transition-colors whitespace-nowrap`}
      >
        <FileText size={12} />
        {busy === 'pdf' ? '...' : 'PDF'}
      </button>
      <button
        type="button"
        onClick={() => run('csv')}
        disabled={busy !== null}
        title={`Download this ${NOUN[kind]}'s data as CSV (opens in Excel)`}
        className={`inline-flex items-center gap-1 text-xs font-bold text-[#2D6B4F] hover:text-[#1F5240] border border-[#BFE0C8] bg-card hover:bg-[#F0F9F4] disabled:opacity-50 disabled:cursor-not-allowed rounded ${pad} transition-colors whitespace-nowrap`}
      >
        <FileSpreadsheet size={12} />
        {busy === 'csv' ? '...' : 'CSV'}
      </button>

      {showView && (
        <SlipPreviewModal
          isOpen={!!preview}
          onClose={closePreview}
          url={preview?.url ?? null}
          title={preview?.title ?? ''}
          onDownload={() => run('pdf')}
        />
      )}
    </div>
  );
};
