import { useEffect, useState } from 'react';
import { client } from '@/api';
import { Modal, StatusBadge } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import { Loader2 } from 'lucide-react';

/**
 * One request's slip, opened from wherever its REQ number appears.
 *
 * Built for the audit trail, where the question behind "who is cibi?" is
 * usually their department and how to reach them. Rather than widening a table
 * that already carries twelve columns, the REQ number opens this — and the
 * answer is here anyway, because an issue slip has always recorded who took
 * the stock, for which department and project, and who is accountable for it.
 *
 * Fetched per open rather than passed in: the audit trail holds a deliberately
 * slim projection of the request (serial, status, issuedAt, requester's name)
 * and pulling every field of every linked request into a 10-row table to
 * service the occasional click would be the wrong trade.
 */

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <p className="text-[10px] uppercase font-bold tracking-wider text-faint">{label}</p>
    <div className="text-sm font-medium text-ink break-words">{children || <span className="text-faint">—</span>}</div>
  </div>
);

export function RequestDetailsModal({
  requestId,
  serialNo,
  onClose,
}: {
  requestId: string | null;
  /** Shown in the title while the fetch is in flight, so the dialog is never nameless. */
  serialNo?: string;
  onClose: () => void;
}) {
  const [req, setReq] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const { addToast } = useToast();

  useEffect(() => {
    if (!requestId) { setReq(null); return; }
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await client.get(`/requests/${requestId}`);
        if (!cancelled) setReq(res.data?.data ?? res.data);
      } catch (e: any) {
        if (!cancelled) {
          // A 404 here is the scope check doing its job, not a missing row —
          // getRequestDetail 404s rather than 403s so ids stay unprobeable.
          addToast(extractErrorMessage(e, 'Could not open that request'), 'error');
          onClose();
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [requestId]);

  const accountable = req?.responsiblePersons?.map((rp: any) => rp.user?.name).filter(Boolean).join(', ');
  const duration = req ? `${req.durationValue} ${String(req.durationUnit || '').toLowerCase()}` : '';

  return (
    <Modal
      isOpen={!!requestId}
      onClose={onClose}
      size="lg"
      title={`Request ${req?.serialNo || serialNo || ''}`}
    >
      {loading || !req ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex items-start justify-between gap-4">
            <h4 className="font-bold text-ink">Requested by</h4>
            <StatusBadge status={req.status} />
          </div>

          {/* The requester block is first and on its own: it is the reason this
              dialog exists from the audit trail. */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-3 bg-surface border border-line-soft rounded-lg p-4">
            <Field label="Name">{req.createdBy?.name}</Field>
            <Field label="Role">{req.createdBy?.role}</Field>
            <Field label="Email">
              {req.createdBy?.email
                ? <a href={`mailto:${req.createdBy.email}`} className="text-brand-dark hover:underline">{req.createdBy.email}</a>
                : null}
            </Field>
            <Field label="Department">{req.department?.name}</Field>
            <Field label="Project">{req.project?.name}</Field>
            <Field label="Accountable">{accountable}</Field>
          </div>

          <div>
            <h4 className="font-bold text-ink mb-3">The request</h4>
            <div className="grid grid-cols-2 gap-x-6 gap-y-3">
              <Field label="Item">{req.inventoryItem?.name}</Field>
              <Field label="Quantity">
                {req.qtyRequested} {req.inventoryItem?.unit}
                {req.qtyIssued != null && Number(req.qtyIssued) !== Number(req.qtyRequested)
                  ? <span className="text-muted"> · {req.qtyIssued} issued</span>
                  : null}
              </Field>
              <Field label="Nature">{req.nature}{req.nature === 'TEMPORARY' && duration ? ` · ${duration}` : ''}</Field>
              <Field label="Raised">{fmtDateTime(req.createdAt)}</Field>
            </div>
          </div>

          <div>
            <h4 className="font-bold text-ink mb-3">Issue slip</h4>
            {req.issuedAt ? (
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                <Field label="Issued to">{req.issuedToName || req.createdBy?.name}</Field>
                <Field label="Issued by">{req.issuedBy?.name}</Field>
                <Field label="Issued at">{fmtDateTime(req.issuedAt)}</Field>
                <Field label="Handover confirmed">{req.issuedConfirmedAt ? fmtDateTime(req.issuedConfirmedAt) : 'Not yet confirmed'}</Field>
                <Field label="Due back">{req.dueDate ? fmtDateTime(req.dueDate) : null}</Field>
                <Field label="Returned">{req.returnedAt ? fmtDateTime(req.returnedAt) : null}</Field>
                {req.disposition && <Field label="Disposition">{String(req.disposition).replace(/_/g, ' ')}</Field>}
                {/* Two different claims, deliberately shown separately: what the
                    holder declared when they started the return, and what the
                    clerk recorded on inspection. Collapsing them would hide the
                    case that matters — the two disagreeing. */}
                {req.returnCondition && <Field label="Condition declared by holder">{req.returnCondition}</Field>}
                {req.returnRecord?.condition && <Field label="Condition on return">{req.returnRecord.condition}</Field>}
              </div>
            ) : (
              // Said plainly rather than rendering a slip of em dashes, which
              // reads as missing data instead of "this has not happened yet".
              <p className="text-sm text-muted">
                Nothing has been issued against this request yet
                {req.approvedAt ? ` (approved ${fmtDateTime(req.approvedAt)})` : ''}.
              </p>
            )}
          </div>

          {req.rejectionReason && (
            <div>
              <h4 className="font-bold text-ink mb-2">Rejected</h4>
              <p className="text-sm text-muted">{req.rejectionReason}</p>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
