import { useEffect, useState } from 'react';
import { Modal, StatusBadge, IndentProgressStepper } from '@/components/ui';
import { client } from '@/api';
import { fmtDateTime, fmtDate } from '@/utils/date';
import { Clock, Truck, ChevronDown } from 'lucide-react';

// Approval-history action → human label. These fill the gaps the status-only
// timeline hid — e.g. the long "Quoting → Ready for Payment" stretch was really
// Tech + CEO approval time, not procurement being slow.
const APPROVAL_LABEL: Record<string, string> = {
  CREATED: 'Created',
  TECH_APPROVED: 'Tech approved',
  TECH_REJECTED: 'Tech rejected',
  TECH_REVOKED: 'Tech approval revoked',
  CEO_APPROVED: 'CEO approved',
  CEO_REJECTED: 'CEO rejected',
  CEO_REVOKED: 'CEO approval revoked',
  LINES_APPROVED: 'Lines approved',
  LINES_REJECTED: 'Lines sent back',
  SENT_TO_FINANCE: 'Sent to Finance',
  PAYMENT_DONE: 'Payment done',
  // The manager stage. All three are facts someone may later be asked about,
  // so they are named rather than left as raw enum text.
  MANAGER_APPROVED: 'Manager approved',
  MANAGER_REJECTED: 'Manager rejected',
  MANAGER_SKIPPED: 'Manager stage skipped',
  MANAGER_BYPASSED: 'Manager bypassed',
  AUTO_APPROVED: 'Auto approved',
};

/**
 * Anything without an explicit label reads as the raw enum —
 * "VENDOR_LINE_SHIPMENT" — which is the database talking, not the app. There
 * are two dozen of these and inventing wording for each is a different job, so
 * the fallback just makes the enum legible: underscores out, sentence case.
 */
const approvalLabel = (action: string) =>
  APPROVAL_LABEL[action]
  || (action || '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const approvalTone = (action: string) =>
  /APPROVED|DONE/.test(action) ? 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30'
  : /REJECT|REVOK/.test(action) ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30'
  : 'bg-surface text-muted border-line';

// Per-line physical stage (the single source of truth post-order).
const STAGE_LABEL: Record<string, string> = {
  IN_TRANSIT: 'In transit',
  CUSTOMS: 'At customs',
  REACHED: 'Reached',
};
const STAGE_RANK: Record<string, number> = { IN_TRANSIT: 1, CUSTOMS: 2, REACHED: 3 };

interface Props {
  indent: any | null;
  onClose: () => void;
}

// Reusable Track modal — shows the indent's full status log so admin/super-admin
// (and the requester, on their dashboard) can see who acted when and where the
// indent stalled. Same UI everywhere, fetched lazily via /indents/:id/timeline.
export const IndentTrackModal = ({ indent, onClose }: Props) => {
  const [timeline, setTimeline] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  // Timeline is a collapsible drop-down so the modal opens compact (stepper +
  // shipments); expand for the full who-did-what-when trail.
  const [showTimeline, setShowTimeline] = useState(false);

  useEffect(() => {
    if (!indent) { setTimeline([]); return; }
    let cancelled = false;
    setLoading(true);
    // /audit (not /timeline) — merges status transitions WITH the granular
    // approval actions (tech + CEO approve/reject) and inventory events, so the
    // trail shows exactly who held the indent when.
    client.get(`/indents/${indent.id}/audit`)
      .then(res => { if (!cancelled) setTimeline(res.data?.data || res.data || []); })
      .catch(() => { if (!cancelled) setTimeline([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fetches only when the indent id changes; keying on the whole indent object would refetch on unrelated field updates
  }, [indent?.id]);

  return (
    <Modal isOpen={!!indent} onClose={onClose} title={`Indent Tracking — ${indent?.serialNo || ''}`}>
      {indent && (
        <div className="space-y-4">
          <div className="bg-surface rounded-lg p-4 border border-line-soft">
            <IndentProgressStepper status={indent.status} quoted={(indent.quotations?.length ?? 0) > 0} />
          </div>

          {/* BOM provenance — when the indent was bundled from a BOM,
              call it out clearly. The reviewer needs to know if this is
              one line out of a 150-row BOM (different decision context)
              vs. an ad-hoc indent for one item. */}
          {indent.bomList?.serialNo && (
            <div className="rounded-lg border border-brand-200 bg-brand-100/40 px-3 py-2 flex items-center gap-2">
              <span className="text-base">📦</span>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-bold text-brand-700 uppercase tracking-wider">Bundled from BOM</p>
                <p className="text-sm font-bold text-ink truncate">
                  {indent.bomList.serialNo}{indent.bomList.name ? ` — ${indent.bomList.name}` : ''}
                </p>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><span className="text-faint text-xs">Raised by</span><p className="font-medium text-ink">{indent.createdBy?.name || '—'}</p></div>
            <div><span className="text-faint text-xs">Department</span><p className="font-medium text-ink">{indent.department?.name || '—'}</p></div>
            <div><span className="text-faint text-xs">Amount</span><p className="font-bold text-ink">{indent.currency || 'INR'} {indent.grandTotal?.toLocaleString() ?? '—'}</p></div>
            <div><span className="text-faint text-xs">Currently with</span><p className={`font-medium ${indent.status === 'AWAITING_PAYMENT' ? 'text-amber-700 dark:text-amber-300' : 'text-ink'}`}>{indent.currentHolder || indent.status}</p></div>
            {indent.holderSince && (
              <div><span className="text-faint text-xs">In current stage since</span><p className="font-medium text-ink">{fmtDateTime(indent.holderSince)}</p></div>
            )}
            {indent.expectedDeliveryDate && (
              <div><span className="text-faint text-xs">Expected delivery</span><p className="font-medium text-ink">{indent.expectedDeliveryHasTime ? fmtDateTime(indent.expectedDeliveryDate) : fmtDate(indent.expectedDeliveryDate)}</p></div>
            )}
          </div>

          {/* Per-vendor shipment tracking — for indents split across vendors,
              each vendor's leg arrives independently. Show every vendor's
              dispatch state / ETA / received status so "where is it?" answers
              per shipment, not just the whole-indent stage. */}
          {Array.isArray(indent.vendorAllocations) && indent.vendorAllocations.length > 0 && (
            <div>
              <h4 className="text-sm font-bold text-ink mb-2 flex items-center gap-2"><Truck size={14} className="text-brand" /> Vendor shipments</h4>
              <div className="space-y-2">
                {[...indent.vendorAllocations.reduce((m: Map<string, any[]>, a: any) => {
                  const arr = m.get(a.vendorName) || []; arr.push(a); m.set(a.vendorName, arr); return m;
                }, new Map<string, any[]>()).entries()].map(([vendorName, allocs]: [string, any[]]) => {
                  const received = allocs.every(a => a.actualDeliveryDate);
                  const someReceived = allocs.some(a => a.actualDeliveryDate);
                  const pending = allocs.filter(a => !a.actualDeliveryDate);
                  // "Where is it" = the LEAST-advanced still-pending line (the laggard
                  // governs when the whole vendor leg is complete).
                  const ref = pending.slice().sort((x, y) => STAGE_RANK[x.shipmentStage] - STAGE_RANK[y.shipmentStage] || 0)[0] || allocs[0];
                  const eta = ref.expectedDeliveryDate ? (ref.expectedDeliveryHasTime ? fmtDateTime(ref.expectedDeliveryDate) : fmtDate(ref.expectedDeliveryDate)) : null;
                  const stage = pending.map(a => a.shipmentStage).filter(Boolean).sort((x, y) => STAGE_RANK[x] - STAGE_RANK[y])[0] || null;
                  const recvDate = allocs.map(a => a.actualDeliveryDate).filter(Boolean).sort().pop();
                  return (
                    <div key={vendorName} className="rounded-lg border border-line-soft bg-surface px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-bold text-ink flex items-center gap-1.5"><Truck size={13} className="text-faint" />{vendorName}</p>
                        {received ? (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300">Received{recvDate ? ` · ${fmtDate(recvDate)}` : ''}</span>
                        ) : someReceived ? (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-lime-50 dark:bg-lime-400/15 text-lime-700 dark:text-lime-300">Partly received</span>
                        ) : stage ? (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-sky-50 dark:bg-sky-400/15 text-sky-700 dark:text-sky-300">{STAGE_LABEL[stage] || stage}</span>
                        ) : (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-hover text-muted">Not shipped</span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1 text-[11px] text-muted">
                        <span>{allocs.length} line{allocs.length === 1 ? '' : 's'}</span>
                        {!received && eta && <span>ETA {eta}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="border border-line-soft rounded-lg overflow-hidden">
            <button
              type="button"
              onClick={() => setShowTimeline((o) => !o)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-surface hover:bg-hover transition-colors text-left"
            >
              <span className="flex items-center gap-2 text-sm font-bold text-ink">
                <Clock size={14} className="text-brand" /> Timeline
                {!loading && <span className="text-[11px] font-normal text-faint">({timeline.length} event{timeline.length === 1 ? '' : 's'})</span>}
              </span>
              <ChevronDown size={14} className={`text-faint transition-transform ${showTimeline ? '' : '-rotate-90'}`} />
            </button>
            {showTimeline && (
              <div className="p-3">
                {loading ? (
                  <div className="text-center py-4 text-faint">Loading...</div>
                ) : (
                  <div className="space-y-0 max-h-[360px] overflow-y-auto">
                    {timeline.map((ev: any, idx: number) => {
                      // Gap chip = time since previous step. Lights up red if ≥2 days
                      // — "this is where the indent stalled". Now accurate because
                      // approval steps sit between the status transitions.
                      const prev = idx > 0 ? timeline[idx - 1] : null;
                      const gapMs = prev ? new Date(ev.createdAt).getTime() - new Date(prev.createdAt).getTime() : 0;
                      const gapDays = gapMs > 0 ? Math.floor(gapMs / 86400000) : 0;
                      const gapHours = gapMs > 0 ? Math.floor((gapMs % 86400000) / 3600000) : 0;
                      const gapLabel = prev
                        ? (gapDays >= 1 ? `${gapDays}d ${gapHours}h after previous` : (gapHours >= 1 ? `${gapHours}h after previous` : `${Math.max(1, Math.floor(gapMs / 60000))}m after previous`))
                        : null;
                      const gapWarn = gapDays >= 2;
                      const actor = ev.actor || ev.changedBy;
                      return (
                        <div key={`${ev.kind || 'status'}-${ev.id}`} className="flex gap-3 py-2.5 border-b border-line-soft last:border-0">
                          <div className="flex flex-col items-center">
                            <div className={`w-2.5 h-2.5 rounded-full mt-1 ${idx === timeline.length - 1 ? 'bg-brand ring-2 ring-brand/30' : 'bg-line'}`} />
                            {idx < timeline.length - 1 && <div className="w-0.5 flex-1 bg-line mt-1" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              {ev.kind === 'approval' ? (
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider border ${approvalTone(ev.action)}`}>
                                  {approvalLabel(ev.action)}
                                </span>
                              ) : ev.kind === 'inventory' ? (
                                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider border bg-sky-50 dark:bg-sky-400/15 text-sky-700 dark:text-sky-300 border-sky-200 dark:border-sky-400/30">
                                  Stock {ev.eventType}
                                </span>
                              ) : (
                                <StatusBadge status={ev.toStatus} />
                              )}
                              <span className="text-[10px] text-faint">{fmtDateTime(ev.createdAt)}</span>
                              {gapLabel && (
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${gapWarn ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border border-red-100 dark:border-red-400/25' : 'bg-surface text-faint border border-line-soft'}`}>
                                  {gapWarn ? '⚠ ' : ''}{gapLabel}
                                </span>
                              )}
                            </div>
                            {ev.notes && <p className="text-xs text-muted mt-0.5">{ev.notes}</p>}
                            <p className="text-[10px] text-faint mt-0.5">
                              by <span className="font-medium text-ink">{actor?.name || 'System'}</span>
                              {actor?.role && <span className="ml-1">· {actor.role}</span>}
                            </p>
                          </div>
                        </div>
                      );
                    })}
                    {timeline.length === 0 && <p className="text-sm text-faint text-center py-4">No timeline data</p>}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};
