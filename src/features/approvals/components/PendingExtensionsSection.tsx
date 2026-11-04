import { useCallback, useEffect, useState } from 'react';
import { client } from '@/api';
import { Pagination } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage, logError } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import { CalendarClock, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { useAbortOnUnmount } from '@/hooks';

const PAGE_SIZE = 10;

/**
 * Approver queue for loan-extension requests.
 *
 * Why this exists: a USER on an IN_USE / OVERDUE component request can post an
 * extension (StandardMyComponentsPage → POST /requests/:id/extension), and the
 * backend has always had PATCH /extensions/:id/approve — but no screen ever
 * listed the pending extensions, so they sat PENDING forever with no UI path to
 * clear them. This section closes that loop.
 *
 * Self-contained on purpose: it owns its own fetch (GET /extensions/pending)
 * rather than piggy-backing on the host page's role-scoped /requests fetch,
 * because that fetch differs per role (manager = createdByMe, admin = dept) and
 * an IN_USE request with a pending extension isn't in the PENDING-approval set
 * those pages already show. Dropping this one component into both ApprovalsPage
 * and TeamApprovalsPage means every approver (ADMIN / MANAGER / SUPER_ADMIN)
 * sees the same queue wherever they land.
 *
 * Renders nothing when the queue is empty — same "hide empty sections" rule the
 * BOM-approvals block on ApprovalsPage follows, so it only appears when there's
 * something to act on.
 */
export const PendingExtensionsSection = () => {
  const { addToast } = useToast();
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loaded, setLoaded] = useState(false);
  const [actingId, setActingId] = useState<string | null>(null);
  // Which row has its decline panel open, and the reason typed into it. A
  // decline needs a reason (the backend requires one), so it can't be a
  // one-click action like approve.
  const [declineFor, setDeclineFor] = useState<string | null>(null);
  const [declineText, setDeclineText] = useState('');

  // Server-paginated: send take/skip, read the {items,total} envelope. Kept as
  // a hand-rolled fetch (not the shared useServerPagination hook) on purpose —
  // the hook toasts on load error, but this embedded section must SOFT-FAIL so
  // a hiccup loading extensions never disrupts the host approvals page.
  const fetchPending = useCallback(async (targetPage: number) => {
    try {
      const { data } = await client.get('/extensions/pending', { params: { take: PAGE_SIZE, skip: (targetPage - 1) * PAGE_SIZE }, signal: abortSignal() });
      const payload = data?.data ?? data ?? {};
      const list = Array.isArray(payload) ? payload : (payload.items || []);
      setRows(Array.isArray(list) ? list : []);
      setTotal(Array.isArray(payload) ? payload.length : (payload.total ?? 0));
    } catch (err) {
      // Soft-fail: a load error shouldn't blank out the rest of the approvals
      // page. Log it; the section just stays hidden (empty rows).
      logError('PendingExtensions.fetch', err);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetchPending(page);
    // Refresh when any approval/request action lands elsewhere on the page so
    // an extension approved (or a parent request returned) drops off the list
    // without a manual reload.
    const onChange = () => fetchPending(page);
    window.addEventListener('approvals-updated', onChange);
    window.addEventListener('requests-updated', onChange);
    return () => {
      window.removeEventListener('approvals-updated', onChange);
      window.removeEventListener('requests-updated', onChange);
    };
  }, [fetchPending, page]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Approving the last row on the last page shrinks the set — step back so the
  // user isn't stranded on an empty page (the effect above then refetches).
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const approve = async (ext: any) => {
    setActingId(ext.id);
    try {
      await client.patch(`/extensions/${ext.id}/approve`);
      addToast('Extension approved — due date updated', 'success');
      // Drop it locally for instant feedback, then resync from the server and
      // ping the badge/lists (the parent request's dueDate + status changed).
      setRows((prev) => prev.filter((r) => r.id !== ext.id));
      window.dispatchEvent(new Event('requests-updated'));
      window.dispatchEvent(new Event('approvals-updated'));
      fetchPending(page);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to approve extension'), 'error');
      // The action may have failed because the parent request was returned out
      // from under us — resync so a now-stale row disappears.
      fetchPending(page);
    } finally {
      setActingId(null);
    }
  };

  // Declining closes the extension without touching the loan: the due date and
  // any OVERDUE state stand. It also unblocks the borrower — `createExtension`
  // refuses a new request while one is PENDING, so before there was a decline
  // path a "no" left them unable to ask again with corrected terms.
  const decline = async (ext: any) => {
    const reason = declineText.trim();
    if (!reason) return;
    setActingId(ext.id);
    try {
      await client.patch(`/extensions/${ext.id}/reject`, { reason });
      addToast('Extension declined — the borrower has been notified', 'success');
      setDeclineFor(null);
      setDeclineText('');
      // Drop it locally for instant feedback, then resync. No 'requests-updated'
      // here: unlike approve, nothing about the parent request changed.
      setRows((prev) => prev.filter((r) => r.id !== ext.id));
      window.dispatchEvent(new Event('approvals-updated'));
      fetchPending(page);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to decline extension'), 'error');
      fetchPending(page);
    } finally {
      setActingId(null);
    }
  };

  // Hide entirely until we know there's something to show.
  if (!loaded || total === 0) return null;

  const describeTerms = (ext: any) => {
    if (ext.newNature === 'PERMANENT') return 'Convert to permanent';
    const unit = (ext.newDurationUnit || '').toLowerCase();
    const plural = ext.newDurationValue === 1 ? unit : `${unit}s`;
    return `Extend by ${ext.newDurationValue} ${plural}`;
  };

  return (
    <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
      <div className="px-6 py-3 border-b border-line-soft bg-surface flex items-center gap-2">
        <CalendarClock size={16} className="text-brand shrink-0" />
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-ink">
            Extension Requests ({total})
          </h3>
          <p className="text-xs text-muted mt-0.5">
            Loan extensions requested on issued components. Approving updates the request's due date; declining leaves it unchanged and frees the borrower to ask again.
          </p>
        </div>
      </div>
      <div className="divide-y divide-line-soft overflow-y-auto" style={{ maxHeight: '35vh' }}>
        {rows.map((ext: any) => {
          const req = ext.componentRequest || {};
          const busy = actingId === ext.id;
          return (
            <div key={ext.id} className="px-6 py-3">
              <div className="flex items-start gap-4">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-ink truncate">
                    {req.inventoryItem?.name || 'Unknown item'}
                  </span>
                  {req.serialNo && (
                    <span className="font-mono text-[10px] font-bold text-faint">{req.serialNo}</span>
                  )}
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-brand-100 text-brand-700 border border-brand-200">
                    {describeTerms(ext)}
                  </span>
                </div>
                <p className="text-[11px] text-muted mt-1">
                  <span className="font-bold">{req.createdBy?.name || 'Unknown'}</span>
                  {req.department?.name && <> · {req.department.name}</>}
                  {req.project?.name && <> · {req.project.name}</>}
                  <span className="inline-flex items-center gap-1 ml-1 text-faint">
                    <Clock size={11} /> due {req.dueDate ? fmtDateTime(req.dueDate) : 'N/A'}
                  </span>
                </p>
                {ext.reason && (
                  <p className="text-xs text-ink mt-1 italic">“{ext.reason}”</p>
                )}
              </div>
              <div className="shrink-0 flex items-center gap-2">
                <button
                  onClick={() => approve(ext)}
                  disabled={busy}
                  className="inline-flex items-center gap-1 text-xs font-bold text-white bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 rounded px-3 py-1.5 transition-colors"
                  title="Approve this extension and update the due date"
                >
                  <CheckCircle2 size={12} /> {busy ? 'Approving…' : 'Approve'}
                </button>
                <button
                  onClick={() => {
                    setDeclineFor(declineFor === ext.id ? null : ext.id);
                    setDeclineText('');
                  }}
                  disabled={busy}
                  className="inline-flex items-center gap-1 text-xs font-bold text-red-700 dark:text-red-300 border border-red-200 dark:border-red-400/30 bg-red-50 dark:bg-red-400/15 hover:bg-red-100 dark:bg-red-400/20 disabled:opacity-50 rounded px-3 py-1.5 transition-colors"
                  title="Decline this extension — the due date stays as it is"
                >
                  <XCircle size={12} /> Decline
                </button>
              </div>
              </div>

              {declineFor === ext.id && (
                <div className="mt-2 pt-2 border-t border-line-soft space-y-2">
                  <textarea
                    value={declineText}
                    onChange={(e) => setDeclineText(e.target.value)}
                    rows={2}
                    maxLength={1000}
                    placeholder="Why are you declining? (required — the borrower sees this)…"
                    className="w-full border border-line rounded px-2 py-1 text-xs focus:border-brand outline-none resize-none"
                  />
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => { setDeclineFor(null); setDeclineText(''); }}
                      className="text-xs font-bold text-muted px-2 py-1 rounded hover:bg-surface"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => decline(ext)}
                      disabled={!declineText.trim() || busy}
                      className="text-xs font-bold bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700 transition-colors disabled:opacity-50"
                    >
                      {busy ? 'Declining…' : 'Confirm Decline'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <Pagination currentPage={page} totalPages={totalPages} onPageChange={setPage} />
    </div>
  );
};
