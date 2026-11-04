import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui';
import { client } from '@/api';
import { fmtDateTime } from '@/utils/date';
import { Clock } from 'lucide-react';

interface Props {
  /** The request row to track — needs at least { id, serialNo }. Null closes. */
  request: any | null;
  onClose: () => void;
}

type Tone = 'emerald' | 'amber' | 'red' | 'gray' | 'blue';

const TONE_CLASSES: Record<Tone, string> = {
  emerald: 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30',
  amber: 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30',
  red: 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30',
  gray: 'bg-hover text-secondary border-line',
  blue: 'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30',
};

// Maps the raw ApprovalHistory `action` string to a human label + colour. The
// DISPOSITION_* actions encode the disposition in the suffix (e.g.
// DISPOSITION_CONSUMED) so they're handled by prefix below.
const actionMeta = (action: string): { label: string; tone: Tone } => {
  if (action?.startsWith('DISPOSITION_')) {
    return { label: `Marked ${action.slice('DISPOSITION_'.length).replace(/_/g, ' ').toLowerCase()}`, tone: 'gray' };
  }
  switch (action) {
    case 'CREATED': return { label: 'Created', tone: 'blue' };
    case 'REVISED': return { label: 'Revised by requester', tone: 'blue' };
    case 'AUTO_APPROVED': return { label: 'Auto-approved', tone: 'emerald' };
    case 'APPROVED': return { label: 'Approved', tone: 'emerald' };
    case 'REJECTED': return { label: 'Rejected', tone: 'red' };
    case 'QUEUED': return { label: 'Queued — out of stock', tone: 'amber' };
    case 'PARTIAL_ISSUED': return { label: 'Partially issued', tone: 'amber' };
    case 'ISSUED': return { label: 'Issued', tone: 'emerald' };
    case 'RETURN_REQUESTED': return { label: 'Return requested', tone: 'amber' };
    case 'RETURNED': return { label: 'Returned', tone: 'gray' };
    case 'BACKORDER_CLAIMED': return { label: 'Back-order claimed', tone: 'emerald' };
    default: return { label: (action || 'Updated').replace(/_/g, ' '), tone: 'gray' };
  }
};

/**
 * Track modal for a component request — the full approval/status history (who
 * acted, when, with what note), so the requester/approver/auditor can see where
 * it stalled. Fetched lazily via GET /requests/:id/timeline (ApprovalHistory
 * rows, visibility-scoped server-side). Mirrors IndentTrackModal's timeline
 * visuals; the difference is requests log discrete actions (not status
 * transitions), so each row shows a humanised action chip rather than a status
 * badge. Extension approvals log under a separate entity and appear in the View
 * modal, not here.
 */
export const ComponentRequestTrackModal = ({ request, onClose }: Props) => {
  const [timeline, setTimeline] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!request) { setTimeline([]); return; }
    let cancelled = false;
    setLoading(true);
    client.get(`/requests/${request.id}/timeline`)
      .then(res => { if (!cancelled) setTimeline(res.data?.data || res.data || []); })
      .catch(() => { if (!cancelled) setTimeline([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetches the timeline only when the request id changes; keying on the whole request object would refetch on unrelated field updates
  }, [request?.id]);

  return (
    <Modal isOpen={!!request} onClose={onClose} title={`Request Tracking — ${request?.serialNo || ''}`}>
      {request && (
        <div className="space-y-4">
          {/* Header facts — drawn from whatever the calling row already has, so
              there's context even before/if the timeline is empty. */}
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-faint text-xs">Component</span><p className="font-medium text-ink">{request.inventoryItem?.name || '—'}</p></div>
            <div><span className="text-faint text-xs">Raised by</span><p className="font-medium text-ink">{request.createdBy?.name || '—'}</p></div>
            <div><span className="text-faint text-xs">Department</span><p className="font-medium text-ink">{request.department?.name || '—'}</p></div>
            <div><span className="text-faint text-xs">Quantity</span><p className="font-medium text-ink">{request.qtyRequested != null ? `${Number(request.qtyRequested)} ${request.inventoryItem?.unit || ''}` : '—'}</p></div>
          </div>

          <div>
            <h4 className="text-sm font-bold text-ink mb-3 flex items-center gap-2"><Clock size={14} className="text-brand" /> Timeline</h4>
            {loading ? (
              <div className="text-center py-4 text-faint">Loading...</div>
            ) : (
              <div className="space-y-0 max-h-[360px] overflow-y-auto">
                {timeline.map((log: any, idx: number) => {
                  // Gap chip = time since previous step. Red if ≥2 days — the
                  // "this is where it stalled" threshold (same as indents).
                  const prev = idx > 0 ? timeline[idx - 1] : null;
                  const gapMs = prev ? new Date(log.createdAt).getTime() - new Date(prev.createdAt).getTime() : 0;
                  const gapDays = gapMs > 0 ? Math.floor(gapMs / 86400000) : 0;
                  const gapHours = gapMs > 0 ? Math.floor((gapMs % 86400000) / 3600000) : 0;
                  const gapLabel = prev
                    ? (gapDays >= 1 ? `${gapDays}d ${gapHours}h after previous` : (gapHours >= 1 ? `${gapHours}h after previous` : `${Math.max(1, Math.floor(gapMs / 60000))}m after previous`))
                    : null;
                  const gapWarn = gapDays >= 2;
                  const meta = actionMeta(log.action);
                  return (
                    <div key={log.id} className="flex gap-3 py-2.5 border-b border-line-soft last:border-0">
                      <div className="flex flex-col items-center">
                        <div className={`w-2.5 h-2.5 rounded-full mt-1 ${idx === timeline.length - 1 ? 'bg-brand ring-2 ring-brand/30' : 'bg-line'}`} />
                        {idx < timeline.length - 1 && <div className="w-0.5 flex-1 bg-line mt-1" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-[11px] font-bold px-2 py-0.5 rounded-full border ${TONE_CLASSES[meta.tone]}`}>{meta.label}</span>
                          <span className="text-[10px] text-faint">{fmtDateTime(log.createdAt)}</span>
                          {gapLabel && (
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${gapWarn ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border border-red-100 dark:border-red-400/25' : 'bg-surface text-faint border border-line-soft'}`}>
                              {gapWarn ? '⚠ ' : ''}{gapLabel}
                            </span>
                          )}
                        </div>
                        {log.notes && <p className="text-xs text-muted mt-0.5">{log.notes}</p>}
                        <p className="text-[10px] text-faint mt-0.5">
                          by <span className="font-medium text-ink">{log.performedBy?.name || 'System'}</span>
                          {log.performedBy?.role && <span className="ml-1">· {String(log.performedBy.role).replace(/_/g, ' ')}</span>}
                        </p>
                      </div>
                    </div>
                  );
                })}
                {timeline.length === 0 && <p className="text-sm text-faint text-center py-4">No timeline data</p>}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};
