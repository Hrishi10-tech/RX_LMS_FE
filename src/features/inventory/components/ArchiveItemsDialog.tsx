import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { client } from '@/api';
import { Modal } from '@/components/ui';
import { useAuth } from '@/hooks';
import { extractErrorMessage } from '@/lib';
import { UserRole } from '@/types';

type OpenRequest = {
  id: string;
  serialNo: string;
  status: string;
  qtyRequested: number;
  qtyIssued: number;
  unit: string | null;
  holder: string;
  itemName: string;
};
type Preview = { items: { id: string; name: string }[]; toCancel: OpenRequest[]; staysOpen: OpenRequest[] };

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
const STATUS_WORDS: Record<string, string> = {
  PENDING: 'waiting for approval',
  APPROVED: 'approved, not issued',
  YET_TO_ISSUE: 'waiting for stock',
  IN_USE: 'in use',
  OVERDUE: 'overdue',
  RETURN_REQUESTED: 'being returned',
};

/**
 * Archive one or more items (owner, 27 Oct — replaces delete).
 *
 * Reads the server's preview first so the clerk sees, before anything
 * changes, which requests will be cancelled (nothing issued yet) and which
 * stay open (the parts are with someone). A reason is required only when
 * something is cancelled — it is what the requester and approver are told.
 */
export const ArchiveItemsDialog: React.FC<{
  items: { id: string; name: string }[] | null;
  onClose: () => void;
  onDone: (result: { archivedCount: number; cancelled: string[]; staysOpen: string[] }) => void;
}> = ({ items, onClose, onDone }) => {
  const { user } = useAuth();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ids = (items ?? []).map((i) => i.id);
  const key = ids.join(',');

  useEffect(() => {
    if (!items || items.length === 0) return;
    setPreview(null); setError(''); setReason(''); setBusy(false);
    let live = true;
    client.post('/inventory/archive/preview', { ids })
      .then((res) => { if (live) setPreview(res.data?.data ?? res.data); })
      .catch((e) => { if (live) setError(extractErrorMessage(e, 'Could not check this item\'s requests')); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Request numbers open where the clerk can see them. Inventory's own routes
  // only — other roles get plain text rather than a link to a page they lack.
  const isInventory = user?.role === UserRole.INVENTORY;
  const requestRef = (r: OpenRequest, issued: boolean) =>
    isInventory ? (
      <Link
        to={issued ? `/inventory/history?componentRequestId=${r.id}` : `/inventory/requests?openRequest=${r.id}`}
        onClick={onClose}
        className="font-bold text-brand hover:underline"
      >
        {r.serialNo}
      </Link>
    ) : (
      <span className="font-bold text-ink">{r.serialNo}</span>
    );

  const line = (r: OpenRequest, issued: boolean) => {
    const unit = r.unit ? ` ${r.unit}` : '';
    const qty = issued ? `${fmt(r.qtyIssued)}${unit} with ${r.holder}` : `${fmt(r.qtyRequested)}${unit} for ${r.holder}`;
    const many = (preview?.items.length ?? 0) > 1 ? ` · ${r.itemName}` : '';
    return (
      <li key={r.id} className="flex flex-wrap gap-x-1.5 text-sm">
        {requestRef(r, issued)}
        <span className="text-secondary">— {qty}, {STATUS_WORDS[r.status] ?? r.status.toLowerCase()}{many}</span>
      </li>
    );
  };

  const cancelCount = preview?.toCancel.length ?? 0;
  const needsReason = cancelCount > 0;
  const title = items && items.length === 1 ? `Archive "${items[0].name}"?` : `Archive ${items?.length ?? 0} items?`;

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const res = await client.post('/inventory/archive', { ids, ...(needsReason ? { reason: reason.trim() } : {}) });
      onDone(res.data?.data ?? res.data);
    } catch (e) {
      setError(extractErrorMessage(e, 'Could not archive'));
      setBusy(false);
    }
  };

  return (
    <Modal isOpen={!!items && items.length > 0} onClose={onClose} title={title}>
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          {items && items.length === 1 ? 'It disappears' : 'They disappear'} from the inventory list and from new requests.
          History is kept, and you can unarchive any time from <span className="font-bold">Archived items</span>.
        </p>

        {!preview && !error && <p className="text-sm text-muted">Checking open requests…</p>}

        {preview && preview.toCancel.length > 0 && (
          <div className="rounded-lg border border-amber-300 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 p-3 space-y-2">
            <p className="text-sm font-bold text-amber-900 dark:text-amber-200">
              {cancelCount === 1 ? 'This request has' : `These ${cancelCount} requests have`} not been issued yet and will be cancelled:
            </p>
            <ul className="space-y-1">{preview.toCancel.map((r) => line(r, false))}</ul>
            <label className="block">
              <span className="text-xs font-bold text-amber-900 dark:text-amber-200">Reason — sent to the requester and whoever approved it</span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                placeholder="e.g. Replaced by 120E/5%/0402"
                className="mt-1 w-full border border-line rounded-md py-2 px-3 text-sm bg-card focus:border-brand outline-none"
              />
            </label>
          </div>
        )}

        {preview && preview.staysOpen.length > 0 && (
          <div className="rounded-lg border border-line bg-surface p-3 space-y-2">
            <p className="text-sm font-bold text-ink">Already issued — {preview.staysOpen.length === 1 ? 'this stays open and finishes' : 'these stay open and finish'} as usual:</p>
            <ul className="space-y-1">{preview.staysOpen.map((r) => line(r, true))}</ul>
            <p className="text-xs text-muted">Returns and dispositions still work. Anything returned goes back into the archived item.</p>
          </div>
        )}

        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}

        <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
          <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-muted hover:bg-surface rounded">Cancel</button>
          <button
            onClick={submit}
            disabled={!preview || busy || (needsReason && !reason.trim())}
            className="px-5 py-2 text-sm font-bold bg-red-600 text-white rounded-full hover:bg-red-700 disabled:opacity-50"
          >
            {busy ? 'Archiving…' : needsReason ? `Archive and cancel ${cancelCount} request${cancelCount === 1 ? '' : 's'}` : 'Archive'}
          </button>
        </div>
      </div>
    </Modal>
  );
};
