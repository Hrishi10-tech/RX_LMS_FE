import { useState } from 'react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { Modal } from '@/components/ui';
import { fmtDateTime } from '@/utils/date';
import { FileText, Image as ImageIcon, Loader2 } from 'lucide-react';

interface Props {
  indentId: string;
  // Which receipt endpoint to hit — defaults to the main payment receipt for
  // backward compat with existing callers. 'refund' targets the refund receipt
  // endpoint; 'customs-duty' targets a specific CustomsDutyPayment row (needs
  // `paymentId`); 'vendor-order' targets one vendor order's receipt (needs
  // `orderId`) — each vendor checkout has its own receipt.
  kind?: 'payment' | 'refund' | 'customs-duty' | 'vendor-order' | 'vendor-order-refund';
  /** Required when kind === 'customs-duty' — the CustomsDutyPayment row id. */
  paymentId?: string;
  /** Required when kind === 'vendor-order' — the VendorOrder row id. */
  orderId?: string;
  label?: string;                           // override the button label
  className?: string;
}

interface ReceiptMeta {
  id: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  createdAt: string;
  uploadedBy?: { name: string } | null;
}

const fmtSize = (b: number) =>
  !b ? '' : b < 1024 ? `${b} B` : b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`;

// `<a href="/api/...">` won't work for the receipt endpoint because the browser
// doesn't attach the Authorization: Bearer header on a plain anchor click — the
// request hits the backend unauthenticated and 401s. Fetch via the authenticated
// axios client, blob the response, then show it IN-APP (image inline, PDF in an
// iframe) — no jarring jump to a raw browser tab.
export const ViewReceiptLink = ({ indentId, kind = 'payment', paymentId, orderId, label, className = '' }: Props) => {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ url: string; type: string; name?: string } | null>(null);
  /**
   * When a payment has several proofs, the button opens a list first.
   *
   * Payments were one file; they are now many, and the two cases want different
   * things — one receipt should open straight away rather than making you click
   * a list of one.
   */
  const [picker, setPicker] = useState<ReceiptMeta[] | null>(null);
  const { addToast } = useToast();

  const endpoint =
    kind === 'refund'              ? `/indents/${indentId}/refund-receipt` :
    kind === 'customs-duty'        ? `/indents/${indentId}/customs-duty/${paymentId}/receipt` :
    kind === 'vendor-order'        ? `/indents/${indentId}/vendor-orders/${orderId}/payment-receipt` :
    kind === 'vendor-order-refund' ? `/indents/${indentId}/vendor-orders/${orderId}/refund-receipt` :
                                     `/indents/${indentId}/payment-receipt`;
  // Only payment receipts became many. Refunds and customs duty are still one
  // document each, and asking their endpoints for a list would 404.
  const multiKind = kind === 'payment' || kind === 'vendor-order';
  const buttonLabel = label || (
    kind === 'refund'              ? 'View refund receipt' :
    kind === 'customs-duty'        ? 'View duty receipt' :
    kind === 'vendor-order'        ? 'View receipt' :
    kind === 'vendor-order-refund' ? 'View refund receipt' :
                                     'View receipt'
  );

  /** Fetch one file and show it. */
  const showBlob = async (url: string, name?: string) => {
    const res = await client.get(url, { responseType: 'blob' });
    const blob = res.data as Blob;
    setPreview({ url: URL.createObjectURL(blob), type: blob.type || '', name });
  };

  const open = async () => {
    if (loading) return;
    setLoading(true);
    try {
      if (multiKind) {
        const res = await client.get(`/indents/${indentId}/payment-receipts`, {
          params: kind === 'vendor-order' ? { vendorOrderId: orderId } : {},
        });
        const items: ReceiptMeta[] = (res.data?.data ?? res.data)?.items ?? [];
        if (items.length > 1) { setPicker(items); return; }
        if (items.length === 1) { await showBlob(`/indents/${indentId}/payment-receipts/${items[0].id}`, items[0].fileName); return; }
        // Nothing in the table — fall back to the single-path endpoint, which
        // still answers for anything uploaded before receipts became many.
      }
      await showBlob(endpoint);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not open receipt'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const openFromPicker = async (r: ReceiptMeta) => {
    setLoading(true);
    try {
      await showBlob(`/indents/${indentId}/payment-receipts/${r.id}`, r.fileName);
      setPicker(null);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not open that receipt'), 'error');
    } finally {
      setLoading(false);
    }
  };

  const close = () => {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
  };

  const isImage = preview?.type.startsWith('image/');

  return (
    <>
      <button type="button" onClick={open} disabled={loading}
        className={`text-[10px] text-brand hover:underline font-bold disabled:opacity-50 disabled:cursor-wait text-left ${className}`}>
        {loading ? 'Opening…' : buttonLabel}
      </button>

      <Modal
        isOpen={!!picker}
        onClose={() => setPicker(null)}
        size="lg"
        title={`Payment receipts (${picker?.length ?? 0})`}
      >
        <div className="divide-y divide-line-soft">
          {picker?.map((r) => (
            <button
              key={r.id}
              onClick={() => openFromPicker(r)}
              disabled={loading}
              className="w-full flex items-center gap-3 py-2.5 text-left hover:bg-hover px-2 rounded disabled:opacity-50"
            >
              {r.mimeType?.startsWith('image/')
                ? <ImageIcon size={14} className="text-brand-dark shrink-0" />
                : <FileText size={14} className="text-brand-dark shrink-0" />}
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-bold text-ink truncate">{r.fileName}</span>
                <span className="block text-[10px] text-faint">
                  {fmtDateTime(r.createdAt)}{r.uploadedBy?.name ? ` · ${r.uploadedBy.name}` : ''}
                  {fmtSize(r.fileSize) ? ` · ${fmtSize(r.fileSize)}` : ''}
                </span>
              </span>
              {loading && <Loader2 size={13} className="animate-spin text-faint" />}
            </button>
          ))}
        </div>
      </Modal>

      <Modal
        isOpen={!!preview}
        onClose={close}
        size="2xl"
        title={preview?.name || buttonLabel}
        headerRight={preview && (
          <a
            href={preview.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs font-bold text-brand-700 hover:underline"
            title="Open the receipt in a new browser tab"
          >
            Open in tab ↗
          </a>
        )}
      >
        {preview && (
          isImage ? (
            <div className="flex justify-center bg-surface rounded-md p-2 max-h-[80vh] overflow-auto">
              <img src={preview.url} alt="Receipt" className="max-w-full h-auto rounded" />
            </div>
          ) : (
            <iframe title="Receipt" src={preview.url} className="w-full h-[80vh] rounded-md border border-line bg-surface" />
          )
        )}
      </Modal>
    </>
  );
};
