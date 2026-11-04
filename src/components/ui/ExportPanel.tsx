import { useState } from 'react';
import { useToast } from '@/context/ToastContext';
import { downloadFromEndpoint, extractBlobError } from '@/lib';
import { Download, FileText, FileSpreadsheet } from 'lucide-react';

type Kind = 'indents' | 'requests' | 'bom-lists';
type Format = 'csv' | 'list-pdf' | 'detailed-pdf';

interface ExportPanelProps {
  kind: Kind;
  /** Optional default date range — defaults to current FY if omitted. */
  defaultFrom?: string;
  defaultTill?: string;
  /**
   * Optional scope forwarded to the export endpoint so the downloaded file
   * matches the table it sits above. History surfaces pass a terminal status
   * set (`status`) or an exclusion list (`excludeStatus`) plus the withdrawn
   * toggle (`includeDeleted`). Operational / finance mounts pass none → the
   * endpoint returns the whole date-scoped set, exactly as before. `status`
   * wins over `excludeStatus` server-side if both are somehow set.
   */
  status?: string;
  excludeStatus?: string;
  includeDeleted?: boolean;
  /** Whose rows: 'mine' (My I/P Requests) or 'team' (Team Approvals). Omitted = everything the role can see. */
  who?: 'mine' | 'team';
}

/**
 * Compact panel that lets an admin / auditor export a date range as
 * CSV / List PDF / Detailed PDF. Sits at the top of each history modal.
 *
 * Why this lives behind backend endpoints instead of generating files
 * client-side: PDFs need to be tamper-evident for audit (server-signed),
 * and big date ranges chew through browser memory. Backend rendering
 * with @react-pdf/renderer is ~5x faster than browser jsPDF and
 * produces consistent output regardless of who's downloading.
 *
 * Date-field dropdown lets the auditor choose WHICH timestamp to filter
 * on (Created vs Approved vs Paid vs Received). Different audit
 * standards use different cut-offs — accrual basis vs cash basis, etc.
 */
export const ExportPanel = ({ kind, defaultFrom, defaultTill, status, excludeStatus, includeDeleted, who }: ExportPanelProps) => {
  const { addToast } = useToast();

  // Sensible defaults: start of current FY (April 1) to today.
  // April is Indian FY start; most labs operate on that calendar.
  const today = new Date();
  const fyYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  const defaultFromIso = defaultFrom || `${fyYear}-04-01`;
  const defaultTillIso = defaultTill || today.toISOString().slice(0, 10);

  const [from, setFrom] = useState(defaultFromIso);
  const [till, setTill] = useState(defaultTillIso);
  const [dateField, setDateField] = useState<string>('created');
  const [busy, setBusy] = useState<Format | null>(null);

  // Which lifecycle timestamp the range filters on — differs per record type.
  const dateFieldOptions =
    kind === 'indents'
      ? [
          { value: 'created',  label: 'Created date' },
          { value: 'approved', label: 'Approved date' },
          { value: 'paid',     label: 'Paid date' },
          { value: 'received', label: 'Received date' },
        ]
      : kind === 'bom-lists'
      ? [
          { value: 'created',   label: 'Created date' },
          { value: 'submitted', label: 'Submitted date' },
          { value: 'approved',  label: 'Approved date' },
          { value: 'completed', label: 'Fulfilled date' },
        ]
      : [
          { value: 'created',  label: 'Created date' },
          { value: 'approved', label: 'Approved date' },
          { value: 'issued',   label: 'Issued date' },
        ];

  const triggerExport = async (format: Format) => {
    if (!from || !till) {
      addToast('Pick both a From and a Till date first.', 'error');
      return;
    }
    if (from > till) {
      addToast('From date must be on or before Till date.', 'error');
      return;
    }
    setBusy(format);
    try {
      // Only attach scope params the caller actually passed — an absent
      // status/excludeStatus/includeDeleted leaves the endpoint at its
      // generic default (whole date-scoped set), so non-history mounts are
      // byte-for-byte unchanged. includeDeleted is sent only when true.
      const filename = await downloadFromEndpoint(
        `/${kind}/export`,
        {
          format, from, till, dateField,
          ...(status ? { status } : {}),
          ...(excludeStatus ? { excludeStatus } : {}),
          ...(includeDeleted ? { includeDeleted: true } : {}),
          ...(who ? { who } : {}),
        },
        `${kind}_${format}_${from}_to_${till}.${format === 'csv' ? 'csv' : 'pdf'}`,
      );
      addToast(`Downloaded ${filename}`, 'success');
    } catch (e) {
      addToast(await extractBlobError(e, 'Export failed'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="bg-brand-100/40 border border-brand-200 rounded-lg p-3 space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">From</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="border border-line rounded px-2 py-1 text-xs focus:border-brand outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Till</label>
          <input
            type="date"
            value={till}
            onChange={(e) => setTill(e.target.value)}
            className="border border-line rounded px-2 py-1 text-xs focus:border-brand outline-none"
          />
        </div>
        <div>
          <label className="block text-[10px] font-bold text-muted uppercase mb-0.5">Filter by</label>
          <select
            value={dateField}
            onChange={(e) => setDateField(e.target.value)}
            className="border border-line rounded px-2 py-1 text-xs focus:border-brand outline-none bg-card"
          >
            {dateFieldOptions.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-1.5 pt-3">
          {/* Three export buttons. CSV first (most-used for reconciliation),
              List PDF (filing summary), Detailed PDF (audit binder). */}
          <button
            onClick={() => triggerExport('csv')}
            disabled={busy !== null}
            title="Download CSV — opens in Excel, best for spreadsheet analysis"
            className="inline-flex items-center gap-1 text-xs font-bold text-[#2D6B4F] hover:text-[#1F5240] border border-[#BFE0C8] bg-card hover:bg-[#F0F9F4] disabled:opacity-50 disabled:cursor-not-allowed rounded px-2.5 py-1.5 transition-colors whitespace-nowrap"
          >
            <FileSpreadsheet size={12} />
            {busy === 'csv' ? '...' : 'CSV'}
          </button>
          <button
            onClick={() => triggerExport('list-pdf')}
            disabled={busy !== null}
            title="Download List PDF — tabular summary, paginated, one row per record"
            className="inline-flex items-center gap-1 text-xs font-bold text-brand-700 hover:text-ink border border-brand-200 bg-card hover:bg-brand-100 disabled:opacity-50 disabled:cursor-not-allowed rounded px-2.5 py-1.5 transition-colors whitespace-nowrap"
          >
            <FileText size={12} />
            {busy === 'list-pdf' ? '...' : 'List PDF'}
          </button>
          <button
            onClick={() => triggerExport('detailed-pdf')}
            disabled={busy !== null}
            title="Download Detailed PDF — one page per record with full audit details"
            className="inline-flex items-center gap-1 text-xs font-bold text-card bg-ink hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed rounded px-2.5 py-1.5 transition-colors whitespace-nowrap"
          >
            <Download size={12} />
            {busy === 'detailed-pdf' ? '...' : 'Detailed PDF'}
          </button>
        </div>
      </div>
      <p className="text-[10px] text-faint italic">
        Date range filter respects "{dateFieldOptions.find(o => o.value === dateField)?.label}". Server-rendered, tamper-evident. Role-scoped: you only see records you have permission to view.
      </p>
    </div>
  );
};
