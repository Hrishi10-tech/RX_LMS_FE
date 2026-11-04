import { useCallback, useEffect, useState } from 'react';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { useConfirm } from '@/context/ConfirmContext';
import { fmtDateTime } from '@/utils/date';
import { Inbox, Trash2, X } from 'lucide-react';
import { useClientPagination } from '@/hooks';
import { Pagination } from '@/components/ui';
import { feedbackApi } from '../services/feedback.api';

type Status = 'NEW' | 'SEEN' | 'RESOLVED';

const STATUS_STYLES: Record<Status, string> = {
  NEW: 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30',
  SEEN: 'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30',
  RESOLVED: 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30',
};

const ROLE_STYLES: Record<string, string> = {
  SUPER_ADMIN: 'bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-400/30',
  ADMIN: 'bg-orange-50 dark:bg-orange-400/15 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-400/30',
  MANAGER: 'bg-blue-50 dark:bg-blue-400/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-400/30',
  USER: 'bg-surface text-secondary border-line',
  LAB: 'bg-cyan-50 dark:bg-cyan-400/15 text-cyan-700 dark:text-cyan-300 border-cyan-200 dark:border-cyan-400/30',
  INVENTORY: 'bg-teal-50 dark:bg-teal-400/15 text-teal-700 dark:text-teal-300 border-teal-200 dark:border-teal-400/30',
  PROCUREMENT: 'bg-indigo-50 dark:bg-indigo-400/15 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-400/30',
  FINANCE: 'bg-pink-50 dark:bg-pink-400/15 text-pink-700 dark:text-pink-300 border-pink-200 dark:border-pink-400/30',
  ASSOCIATE_FINANCE: 'bg-rose-50 dark:bg-rose-400/15 text-rose-700 dark:text-rose-300 border-rose-200 dark:border-rose-400/30',
};

/**
 * SUPER_ADMIN feedback inbox. Tabs filter by status (NEW / SEEN / RESOLVED).
 * Clicking a row opens the detail panel with the full message + attachment
 * (image or video) and status controls. Auto-marks NEW → SEEN on open so
 * the badge clears.
 */
export const FeedbackInboxPage = () => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Status>('NEW');
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [attachmentUrl, setAttachmentUrl] = useState<string | null>(null);
  // Why the attachment could not be shown (e.g. the stored file is gone), in
  // place of "Loading attachment…" spinning for ever.
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const fetchInbox = useCallback(async () => {
    setLoading(true);
    try {
      const data = await feedbackApi.list(tab);
      setItems(data?.items ?? []);
      setUnreadCount(data?.unreadCount ?? 0);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to load feedback'), 'error');
    } finally {
      setLoading(false);
    }
  }, [tab, addToast]);

  useEffect(() => { fetchInbox(); }, [fetchInbox]);

  const opened = items.find(i => i.id === openId) || null;

  // Client-paginate the active tab's list at 10/page; reset to page 1 when the
  // tab changes so switching tabs starts fresh.
  const pager = useClientPagination(items, 10, tab);

  // Lazy-load the attachment blob when a row with media is opened.
  // Re-runs when openId changes; revokes the old blob URL to avoid leaks.
  useEffect(() => {
    if (!opened || !opened.attachmentPath) {
      if (attachmentUrl) URL.revokeObjectURL(attachmentUrl);
      setAttachmentUrl(null);
      return;
    }
    let cancelled = false;
    let createdUrl: string | null = null;
    setAttachmentError(null);
    feedbackApi.fetchAttachmentBlob(opened.id)
      .then(url => {
        if (cancelled) { URL.revokeObjectURL(url); return; }
        createdUrl = url;
        setAttachmentUrl(url);
      })
      .catch(e => { if (!cancelled) setAttachmentError(extractErrorMessage(e, 'Could not load the attachment.')); });
    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-loads the attachment only when the opened row id changes; including attachmentUrl/opened/addToast would re-fire on every blob set and leak/loop
  }, [opened?.id]);

  // Auto-bump NEW → SEEN on open, so the badge accurately reflects
  // unread items without making the super-admin click a separate button.
  useEffect(() => {
    if (!opened || opened.status !== 'NEW') return;
    feedbackApi.updateStatus(opened.id, 'SEEN')
      .then(() => fetchInbox())
      .catch(() => { /* silent — not blocking */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bumps NEW→SEEN once per opened row (keyed on opened?.id); fetchInbox/opened are render-scope and keying on them would re-fire the status bump
  }, [opened?.id]);

  const setStatus = async (status: Status) => {
    if (!opened) return;
    try {
      await feedbackApi.updateStatus(opened.id, status);
      addToast(`Marked as ${status.toLowerCase()}`, 'success');
      await fetchInbox();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to update status'), 'error');
    }
  };

  const remove = async () => {
    if (!opened) return;
    if (!await confirm('Delete this feedback? Attachment will be removed too. Cannot be undone.')) return;
    try {
      await feedbackApi.remove(opened.id);
      addToast('Feedback deleted', 'success');
      setOpenId(null);
      await fetchInbox();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to delete'), 'error');
    }
  };

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink flex items-center gap-2">
            <Inbox size={22} className="text-brand" />
            Feedback Inbox
            {unreadCount > 0 && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-400/20 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-400/30">
                {unreadCount} new
              </span>
            )}
          </h2>
          <p className="text-sm md:text-[15px] text-muted mt-1.5">
            Everything submitted via the Feedback button across the app, with attachments and timestamps. NEW items auto-flip to SEEN once you open them.
          </p>
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex items-center gap-1 border-b border-line">
        {(['NEW', 'SEEN', 'RESOLVED'] as Status[]).map(s => (
          <button key={s} onClick={() => { setOpenId(null); setTab(s); }}
            className={`px-4 py-2 text-sm font-bold border-b-2 transition-colors ${
              tab === s
                ? 'border-brand text-ink'
                : 'border-transparent text-faint hover:text-muted'
            }`}>
            {s.charAt(0) + s.slice(1).toLowerCase()}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Left: list */}
        <div className="lg:col-span-2 bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
          {loading && <div className="text-center text-faint py-8 text-sm">Loading…</div>}
          {!loading && items.length === 0 && (
            <div className="text-center text-faint py-10 text-sm">
              No {tab.toLowerCase()} feedback.
            </div>
          )}
          {!loading && items.length > 0 && (
            <div className="divide-y divide-line-soft max-h-[70vh] overflow-y-auto">
              {pager.pageRows.map(f => {
                const isOpen = f.id === openId;
                return (
                  <button key={f.id} type="button" onClick={() => setOpenId(f.id)}
                    className={`w-full text-left px-4 py-3 transition-colors ${
                      isOpen ? 'bg-brand/10' : 'hover:bg-surface'
                    }`}>
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="font-bold text-sm text-ink truncate">
                        {f.createdBy?.name || 'Unknown'}
                      </span>
                      {f.createdBy?.role && (
                        <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${ROLE_STYLES[f.createdBy.role] || 'bg-surface text-secondary border-line'}`}>
                          {f.createdBy.role.replace(/_/g, ' ')}
                        </span>
                      )}
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${STATUS_STYLES[f.status as Status] || 'bg-surface text-secondary border-line'}`}>
                        {f.status}
                      </span>
                      {f.attachmentPath && (
                        <span title="Has attachment" className="text-brand">
                          <ImageIconInline />
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted line-clamp-2">{f.message}</p>
                    <p className="text-[10px] text-faint mt-1">{fmtDateTime(f.createdAt)}</p>
                  </button>
                );
              })}
            </div>
          )}
          {!loading && pager.totalPages > 1 && (
            <Pagination currentPage={pager.page} totalPages={pager.totalPages} onPageChange={pager.setPage} />
          )}
        </div>

        {/* Right: detail */}
        <div className="lg:col-span-3 bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
          {!opened && (
            <div className="text-center text-faint py-16 text-sm">
              Select a feedback entry to see the full message and attachment.
            </div>
          )}
          {opened && (
            <div className="flex flex-col">
              <div className="px-5 py-3 border-b border-line-soft bg-surface flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-ink">{opened.createdBy?.name || 'Unknown'}</span>
                    {opened.createdBy?.role && (
                      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${ROLE_STYLES[opened.createdBy.role] || 'bg-surface text-secondary border-line'}`}>
                        {opened.createdBy.role.replace(/_/g, ' ')}
                      </span>
                    )}
                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${STATUS_STYLES[opened.status as Status] || 'bg-surface text-secondary border-line'}`}>
                      {opened.status}
                    </span>
                  </div>
                  <p className="text-[11px] text-faint mt-0.5">
                    {opened.createdBy?.email && <>{opened.createdBy.email} · </>}
                    Submitted {fmtDateTime(opened.createdAt)}
                  </p>
                </div>
                <button onClick={() => setOpenId(null)} title="Close"
                  className="text-faint hover:text-ink p-1 shrink-0">
                  <X size={16} />
                </button>
              </div>

              <div className="px-5 py-4 space-y-4 max-h-[60vh] overflow-y-auto">
                <p className="text-sm text-ink whitespace-pre-wrap leading-relaxed">{opened.message}</p>

                {opened.attachmentPath && (
                  <div className="border border-line rounded-md overflow-hidden bg-surface">
                    {!attachmentUrl && (
                      <div className="text-center text-faint py-8 text-xs">{attachmentError ?? 'Loading attachment…'}</div>
                    )}
                    {attachmentUrl && opened.attachmentMime?.startsWith('video/') && (
                      <video src={attachmentUrl} controls className="w-full max-h-[60vh] bg-black" />
                    )}
                    {attachmentUrl && opened.attachmentMime?.startsWith('image/') && (
                      <img src={attachmentUrl} alt="feedback attachment" className="w-full max-h-[60vh] object-contain" />
                    )}
                    <div className="px-3 py-1.5 text-[10px] text-muted border-t border-line-soft bg-card">
                      {opened.attachmentMime || 'attachment'}
                    </div>
                  </div>
                )}
              </div>

              <div className="px-5 py-3 border-t border-line-soft bg-surface flex items-center gap-2 flex-wrap">
                <span className="text-[10px] font-bold text-faint uppercase mr-2">Set status:</span>
                {(['NEW', 'SEEN', 'RESOLVED'] as Status[]).map(s => (
                  <button key={s} onClick={() => setStatus(s)}
                    disabled={opened.status === s}
                    className={`px-3 py-1 text-xs font-bold rounded border transition-colors ${
                      opened.status === s
                        ? `${STATUS_STYLES[s]} cursor-default`
                        : 'bg-card border-line text-muted hover:bg-surface'
                    }`}>
                    {s.charAt(0) + s.slice(1).toLowerCase()}
                  </button>
                ))}
                <div className="ml-auto">
                  <button onClick={remove}
                    className="inline-flex items-center gap-1 px-3 py-1 text-xs font-bold text-red-700 dark:text-red-300 hover:bg-red-50 dark:bg-red-400/15 rounded">
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// Tiny inline icon to mark attachment-bearing rows in the list. Stays in
// this file because it's only used here.
const ImageIconInline = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
    <circle cx="9" cy="9" r="2" />
    <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
  </svg>
);

