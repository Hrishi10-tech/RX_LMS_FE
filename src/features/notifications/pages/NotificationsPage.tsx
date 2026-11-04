import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, BellOff, CheckCheck } from 'lucide-react';
import { client } from '@/api';
import { Notification } from '@/types';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/context/AuthContext';
import { extractErrorMessage } from '@/lib';
import { Modal, Pagination, BrandLoader } from '@/components/ui';
import { ExtensionForm } from '@/components/forms';
import { fmtDateTime } from '@/utils/date';
import { useServerPagination, useAbortOnUnmount } from '@/hooks';
import { useConfirm } from '@/context/ConfirmContext';
import { requestNotificationPermission, notificationPermission } from '@/utils/desktopNotifications';
import { enablePush, disablePush } from '@/lib/push';
import { desktopAlertsMuted, setDesktopAlertsMuted } from '@/lib/alert-preference';
import { buildClickTargetUrl } from '../utils/clickTarget';
import { TakeoverOffers } from '../components/TakeoverOffers';

// Click-through routing: each notification carries a relatedEntityId +
// relatedEntityType pair. We use them to deep-link to the canonical view
// for that entity instead of leaving the user to navigate manually.
//   - INDENT → depends on viewer: ADMIN/SUPER_ADMIN open the Approvals queue
//     (?openIndent auto-opens the timeline); MANAGER opens Team Approvals (their
//     indent pings are team-oversight, not their own to approve); PROCUREMENT
//     their indent queue; requesters their personal tracker with ?openIndent.
//   - COMPONENT_REQUEST → depends on viewer: MANAGER opens Team Approvals
//     (team requests live there with inline approve/reject); ADMIN opens the
//     dept-wide Approvals queue; the requester (USER/LAB) opens their
//     IP/Requests tracker with ?openRequest=<id> (scroll + highlight).
//   - COMPONENT_REQUEST_BACKORDER → stay on /notifications (the Claim/Decline
//     buttons are right there). Card is not navigable in that case.
//   - BOM_LIST → MANAGER opens the slip on Team Approvals (?openBom), ADMIN on
//     their Approvals console (?openBom); everyone else with a Lists route opens
//     the BOM via ?openList. SUPER_ADMIN has no Lists route, so they open the
//     slip on their Approvals console (?openBom) like ADMIN.
//   - SUBSCRIPTION → FINANCE expiry reminders open /finance/subscriptions.
//   - REQUEST → return reminders open the borrower's tracker (INVENTORY → returns).
//   - FIXED_ASSET → custodian copy opens the fixed-assets page (roles that have one).
//   - FIXED_ASSET_APPROVAL → FINANCE review ping opens the approvals modal
//     (?openApprovals); submitter outcome copy opens their fixed-assets page.
//   - Anything else / null → card is not clickable.
// Role goes in the route slug ('/[role-lowercased-hyphenated]/ip-requests') to
// match the existing per-role routing layout in AppRoutes.
// Where this entity actually lives depends on who the viewer is. An indent
// notification for a USER opens their IP/Requests tracker; for an ADMIN it
// opens the Approvals page (where the Approve/Reject buttons are); for
// PROCUREMENT it's their indent queue, etc.

export const NotificationsPage = () => {
    // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
    const abortSignal = useAbortOnUnmount();

    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [historyNotifications, setHistoryNotifications] = useState<Notification[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [isHistoryOpen, setIsHistoryOpen] = useState(false);
    const [isExtModalOpen, setIsExtModalOpen] = useState(false);
    const [selectedRequest, setSelectedRequest] = useState<any>(null);
    const { addToast } = useToast();
    // Desktop (OS-level) alert opt-in. This click is the ONLY place permission
    // is requested — see useDesktopNotifications for why asking on mount was
    // removed (a gesture-less request is ignored by Safari and auto-denied by
    // Chrome, and a denial can never be re-prompted).
    const [desktopPerm, setDesktopPerm] = useState<string>(() => notificationPermission());
    const enableDesktopAlerts = async () => {
        const res = await requestNotificationPermission();
        setDesktopPerm(res);
        if (res === 'granted') {
            // Subscribe to Web Push straight away, while the grant is fresh — this
            // is what lets a notification arrive with the tab (or the browser)
            // closed. Falls back silently to in-page popups if push is
            // unavailable or the server has no VAPID keys.
            const pushOn = await enablePush();
            addToast(
                pushOn
                    ? "Desktop alerts on — you'll get a popup even with the app closed."
                    : "Desktop alerts on — you'll get a popup while the app is open.",
                'success',
            );
        }
        else if (res === 'unsupported') addToast('This browser does not support desktop notifications.', 'error');
        // 'denied' needs more than a toast — the banner below explains how to
        // unblock, because the page is powerless to re-ask once blocked.
    };

    // Turning them back OFF. There was no way to do this: alerts could be
    // switched on from here, from the DesktopAlertsPrompt banner and
    // automatically on mount, and `disablePush()` — written and exported for
    // exactly this — was called by nothing.
    //
    // This cannot revoke the browser permission (no API does), so "off" means
    // the app declining to use it: drop the Web Push subscription, and
    // remember the choice so neither the open-tab banner nor the re-subscribe
    // on next mount brings them back.
    const [alertsMuted, setAlertsMuted] = useState<boolean>(() => desktopAlertsMuted());
    const [togglingAlerts, setTogglingAlerts] = useState(false);
    const toggleDesktopAlerts = async () => {
        setTogglingAlerts(true);
        try {
            if (alertsMuted) {
                // Permission is already granted, so this re-subscribes without
                // prompting anyone.
                setDesktopAlertsMuted(false);
                setAlertsMuted(false);
                const pushOn = await enablePush();
                addToast(
                    pushOn
                        ? "Desktop alerts back on — you'll get a popup even with the app closed."
                        : "Desktop alerts back on — you'll get a popup while the app is open.",
                    'success',
                );
            } else {
                // Order matters: mute first, so a notification landing during
                // the unsubscribe round-trip cannot slip a banner through.
                setDesktopAlertsMuted(true);
                setAlertsMuted(true);
                await disablePush();
                addToast('Desktop alerts off. Everything still arrives here and on the bell.', 'success');
            }
        } finally {
            setTogglingAlerts(false);
        }
    };

    // Once blocked, requestPermission() can never prompt again — the only route
    // back is the browser's own site settings. Spell that out per browser rather
    // than leaving a button that looks clickable but silently does nothing.
    // Browsers only allow notifications and service workers on a SECURE context
    // — HTTPS, or localhost. Reached over a plain-http LAN address (which is how
    // a local build gets handed to a tester), the Notifications API reports
    // "denied" and cannot be granted, and navigator.serviceWorker is absent
    // entirely. Telling that person to "click the padlock and set Notifications
    // to Allow" sends them after a setting the browser will not offer, and they
    // reasonably report the app as broken. Name the real reason instead.
    const insecureOrigin = typeof window !== 'undefined' && !window.isSecureContext;
    const blockedHelp = (() => {
        if (insecureOrigin)
            return `this page is served over plain http (${window.location.host}), and browsers only allow desktop popups on https or localhost. Nothing you change in browser settings will turn them on here.`;
        const ua = navigator.userAgent;
        if (/Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua))
            return 'Safari → Settings → Websites → Notifications → find this site → set it to Allow.';
        if (/Firefox/.test(ua))
            return 'Click the padlock in the address bar, clear the "Send Notifications" block, then reload.';
        return 'Click the padlock (or ⚙) at the left of the address bar → Site settings → set Notifications to Allow, then reload this page.';
    })();
    const { user } = useAuth();
    const confirm = useConfirm();
    const navigate = useNavigate();
    const roleSlug = user?.role.toLowerCase().replace(/_/g, '-') || 'user';

    // SERVER-paginated, one request per list. The old version fetched a single
    // hard-capped page of 200 and sliced it client-side, so anything older than
    // the newest 200 was unreachable — and a user with 200 unread saw an empty
    // History tab, because both lists were carved out of the same 200 rows.
    // `isRead` splits them server-side now, so each pages independently and
    // neither has a ceiling.
    const activePager = useServerPagination<Notification>({
        endpoint: '/notifications',
        params: { isRead: 'false' },
        serverSearch: false,
    });
    const historyPager = useServerPagination<Notification>({
        endpoint: '/notifications',
        params: { isRead: 'true' },
        serverSearch: false,
        // Only fetched when the History drawer is open — no cost for the
        // (common) case where nobody looks at it.
        enabled: isHistoryOpen,
    });

    // Keep the local arrays the rest of this page already reads from in sync
    // with whatever page the server returned.
    useEffect(() => { setNotifications(activePager.items); }, [activePager.items]);
    useEffect(() => { setHistoryNotifications(historyPager.items); }, [historyPager.items]);
    useEffect(() => { setIsLoading(activePager.isLoading); }, [activePager.isLoading]);

    // Re-pull both lists after anything that moves a row between them.
    const fetchNotifs = () => { activePager.refetch(); if (isHistoryOpen) historyPager.refetch(); };

    const [isMarkingAll, setIsMarkingAll] = useState(false);

    /**
     * Clear the whole unread list in one action. Scoped server-side to the
     * caller's own rows, so every role gets it — there is nothing to authorise
     * beyond being signed in.
     */
    const markAllAsRead = async () => {
        if (!await confirm(`Mark all ${activePager.total} notification${activePager.total === 1 ? '' : 's'} as read?`)) return;
        setIsMarkingAll(true);
        try {
            const res = await client.post('/notifications/read-all');
            const updated = (res.data?.data ?? res.data)?.updated ?? 0;
            addToast(updated > 0 ? `Marked ${updated} as read` : 'Nothing left to mark', 'success');
            fetchNotifs();
            // The TopBar bell + sidebar badges read their own counts.
            window.dispatchEvent(new Event('notifications-updated'));
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to mark all as read'), 'error');
        } finally { setIsMarkingAll(false); }
    };

    const markAsRead = async (id: string) => {
        try {
            await client.post(`/notifications/${id}/read`);
            addToast('Marked as read', 'success');
            // The list renders the server pager's page, not local state, so
            // reload both — editing local state alone said "Marked as read"
            // while the card stayed put and the "Mark all read (N)" count
            // stayed stale.
            activePager.refetch();
            if (isHistoryOpen) historyPager.refetch();
            // Let the TopBar bell + sidebar badges know to refresh their counts.
            // Without this, the orange dot persisted after marking every item
            // read until the user navigated.
            window.dispatchEvent(new Event('notifications-updated'));
        } catch {
            addToast('Failed to mark as read', 'error');
        }
    };

    const handleExtend = async (notif: any) => {
        // The overdue notification carries the ComponentRequest id in
        // relatedEntityId (NOT notif.id, which is the notification's own id).
        // Fetch the real request so the form header shows the item/serial/due
        // date and the extension POSTs against the correct request.
        try {
            const { data } = await client.get(`/requests/${notif.relatedEntityId}`, { signal: abortSignal() });
            setSelectedRequest(data?.data ?? data);
            setIsExtModalOpen(true);
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Could not load this request for extension'), 'error');
        }
    };

    const submitExtension = async (data: any) => {
        // Let any failure propagate so ExtensionForm surfaces the real backend
        // message and keeps the modal open; the form owns the success toast too.
        await client.post(`/requests/${selectedRequest.id}/extension`, data);
        setIsExtModalOpen(false);
    };

    const handleClaimBackorder = async (notif: any) => {
        try {
            await client.post(`/requests/${notif.relatedEntityId}/redeem-shortfall`);
            addToast('Back-ordered items issued — head to inventory to collect.', 'success');
            await markAsRead(notif.id);
            fetchNotifs();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to claim. Stock may have dropped — please raise a new request.'), 'error');
        }
    };

    const handleDeclineBackorder = async (notif: any) => {
        try {
            await client.post(`/requests/${notif.relatedEntityId}/decline-shortfall`);
            addToast('Back-order declined. The stock stays in inventory.', 'success');
            await markAsRead(notif.id);
            fetchNotifs();
        } catch (e: any) {
            addToast(extractErrorMessage(e, 'Failed to decline'), 'error');
        }
    };

    return (
        <div className="space-y-4 md:space-y-6 max-w-4xl mx-auto">
            <div className="flex justify-between items-center mb-4 md:mb-6 border-b border-line pb-4">
              <h2 className="text-2xl font-bold tracking-tight font-bold text-ink">Notifications</h2>
              <div className="flex items-center gap-2">
                {desktopPerm === 'granted' && (
                  <button
                      onClick={toggleDesktopAlerts}
                      disabled={togglingAlerts}
                      title={alertsMuted
                        ? 'Start getting OS-level popups on this machine again'
                        : 'Stop OS-level popups on this machine. Notifications still arrive here and on the bell.'}
                      className="inline-flex items-center gap-1.5 bg-hover border border-line text-secondary hover:bg-line px-4 py-2 font-bold rounded-md shadow-sm transition-colors disabled:opacity-50"
                  >
                      {alertsMuted ? <Bell size={15} /> : <BellOff size={15} />}
                      {togglingAlerts
                        ? 'Saving\u2026'
                        : alertsMuted ? 'Turn on desktop alerts' : 'Turn off desktop alerts'}
                  </button>
                )}
                {desktopPerm === 'default' && (
                  <button
                      onClick={enableDesktopAlerts}
                      title="Get an OS-level popup on your laptop when a new notification arrives"
                      className="bg-brand text-white hover:bg-brand-dark px-4 py-2 font-bold rounded-md shadow-sm transition-colors"
                  >
                      Enable desktop alerts
                  </button>
                )}
                {activePager.total > 0 && (
                  <button
                      onClick={markAllAsRead}
                      disabled={isMarkingAll}
                      title="Clear every unread notification"
                      className="inline-flex items-center gap-1.5 bg-hover border border-line text-secondary hover:bg-line px-4 py-2 font-bold rounded-md shadow-sm transition-colors disabled:opacity-50"
                  >
                      <CheckCheck size={15} /> {isMarkingAll ? 'Marking…' : `Mark all read (${activePager.total})`}
                  </button>
                )}
                <button
                    onClick={() => setIsHistoryOpen(true)}
                    className="bg-hover border border-line text-secondary hover:bg-line px-4 py-2 font-bold rounded-md shadow-sm transition-colors"
                >
                    History
                </button>
              </div>
            </div>

            {/* A deactivated person's open work, offered to this person. */}
            <TakeoverOffers />

            {/* Desktop-alert state. Previously this was invisible: if the browser
                had denied permission, popups just never arrived and nothing on
                the page said so — which reads as "the app is broken". */}
            {desktopPerm === 'denied' && (
              <div className="bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-lg p-3 flex items-start gap-2 text-xs text-amber-900 dark:text-amber-200">
                <BellOff size={15} className="mt-0.5 shrink-0" />
                <div>
                  <p className="font-bold">
                    {insecureOrigin
                      ? 'Desktop popups are not available at this address.'
                      : 'Desktop popups are blocked for this site.'}
                  </p>
                  <p className="mt-0.5">
                    You'll still see everything here and on the bell — but nothing will pop up on your
                    laptop while the tab is in the background.{' '}
                    {insecureOrigin
                      ? <>That is a browser rule, not a setting: {blockedHelp}</>
                      : <>Your browser blocked it, so it has to be turned back on there: {blockedHelp}</>}
                  </p>
                </div>
              </div>
            )}
            {desktopPerm === 'granted' && alertsMuted && (
              <div className="bg-hover border border-line rounded-lg p-3 flex items-start gap-2 text-xs text-secondary">
                <BellOff size={15} className="mt-0.5 shrink-0" />
                <p>
                  Desktop alerts are off on this machine, by your choice. Notifications still arrive
                  here and on the bell — nothing is lost, it just won't pop up.{' '}
                  <span className="font-bold">Turn on desktop alerts</span> above puts them back,
                  without asking your browser again.
                </p>
              </div>
            )}
            {desktopPerm === 'default' && (
              <div className="bg-blue-50 dark:bg-blue-400/15 border border-blue-200 dark:border-blue-400/30 rounded-lg p-3 flex items-start gap-2 text-xs text-blue-900 dark:text-blue-200">
                <BellOff size={15} className="mt-0.5 shrink-0" />
                <p>
                  Desktop popups are off. Hit <span className="font-bold">Enable desktop alerts</span> above
                  to get a popup on your laptop when something needs you, even with this tab in the background.
                </p>
              </div>
            )}

            {isLoading ? (
                 <BrandLoader />
            ) : notifications.length === 0 ? (
                 <div className="bg-card p-12 rounded-xl flex flex-col justify-center items-center h-64 border border-dashed border-line text-center">
                     <svg className="w-12 h-12 text-faint mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                         <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                     </svg>
                     <p className="text-ink font-bold text-lg">No notifications</p>
                 </div>
            ) : (
                <div className="space-y-4">
                   {activePager.items.map((notif: Notification) => {
                       let config: { bg: string; border: string; icon: ReactNode } = { bg: 'bg-card', border: 'border-l-gray-300', icon: null };
                       
                       switch(notif?.type || 'INFO') {
                           case 'APPROVAL':
                               config = { bg: 'bg-green-50 dark:bg-green-400/15', border: 'border-l-green-500', icon: (
                                   <svg className="h-6 w-6 text-green-500 dark:text-green-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                               )}; break;
                           case 'WARNING':
                           case 'DUE_SOON':
                               config = { bg: 'bg-amber-50 dark:bg-amber-400/15', border: 'border-l-amber-500', icon: (
                                   <svg className="h-6 w-6 text-amber-700 dark:text-amber-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                               )}; break;
                           case 'OVERDUE':
                               config = { bg: 'bg-red-50 dark:bg-red-400/15', border: 'border-l-red-500', icon: (
                                   <svg className="h-6 w-6 text-red-700 dark:text-red-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                               )}; break;
                           case 'INFO':
                           default:
                               config = { bg: 'bg-blue-50 dark:bg-blue-400/15', border: 'border-l-blue-500', icon: (
                                   <svg className="h-6 w-6 text-blue-500 dark:text-blue-300" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                               )}; break;
                       }

                       const clickTarget = buildClickTargetUrl(notif, user?.role || '', roleSlug);
                       // Card-level click navigates to the canonical entity view.
                       // Inner buttons (Claim, Decline, Mark as Read, Dismiss)
                       // stopPropagation so they don't accidentally also fire the
                       // navigation. If clickTarget is null the card is inert.
                       const handleCardClick = (e: React.MouseEvent) => {
                           if (!clickTarget) return;
                           // Defensive: ignore clicks that originated inside a <button>
                           // — covers stray clicks on icons inside the action buttons.
                           if ((e.target as HTMLElement).closest('button')) return;
                           navigate(clickTarget);
                       };
                       return (
                           <div
                               key={notif.id}
                               onClick={handleCardClick}
                               className={`${config.bg} p-4 rounded-xl border border-line-soft border-l-4 ${config.border} shadow-[0_2px_10px_rgb(0,0,0,0.02)] flex flex-col gap-4 relative ${clickTarget ? 'cursor-pointer hover:shadow-md transition-shadow' : ''}`}
                           >
                               <button
                                   onClick={(e) => { e.stopPropagation(); markAsRead(notif.id); }}
                                   className="absolute top-4 right-4 text-faint hover:text-ink transition-colors"
                                   title="Dismiss"
                               >
                                   <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                               </button>

                               <div className="flex items-start gap-4">
                                   <div className="mt-1 flex-shrink-0">{config.icon}</div>
                                   <div className="flex-1 pr-6">
                                       <h4 className={`font-bold text-ink text-base`}>{notif?.title || 'Notification'}</h4>
                                       <p className="text-sm text-ink leading-relaxed mt-1">{notif?.message || ''}</p>
                                       <span className="text-xs text-faint font-medium block mt-2">{fmtDateTime(notif?.createdAt, '')}</span>
                                       
                                       <div className="flex gap-3 shrink-0 mt-4" onClick={(e) => e.stopPropagation()}>
                                            {/* Loans only. Indent deliveries, subscriptions and asset
                                                maintenance also send OVERDUE, and the button then
                                                failed to load a "request" that was not one. */}
                                            {notif.type === 'OVERDUE' && notif.relatedEntityType === 'REQUEST' && (
                                                <button onClick={() => handleExtend(notif)} className="text-sm bg-amber-700 px-4 py-1.5 text-white font-bold rounded-md hover:bg-amber-800 transition-colors shadow-sm">
                                                    Request Extension
                                                </button>
                                            )}
                                            {notif.relatedEntityType === 'COMPONENT_REQUEST_BACKORDER' && (
                                                <>
                                                    <button onClick={() => handleClaimBackorder(notif)} className="text-sm bg-emerald-700 px-4 py-1.5 text-white font-bold rounded-md hover:bg-emerald-800 transition-colors shadow-sm">
                                                        Claim now
                                                    </button>
                                                    <button onClick={() => handleDeclineBackorder(notif)} className="text-sm border border-red-300 dark:border-red-400/30 text-red-700 dark:text-red-300 px-4 py-1.5 font-bold rounded-md hover:bg-red-50 dark:bg-red-400/15 transition-colors">
                                                        Decline
                                                    </button>
                                                </>
                                            )}
                                            {/* "Request Component" CTAs only navigate — they no longer
                                                mark-as-read on click. The card (plus any duplicate /
                                                sibling-typed cards for the same indent/item) is cleared
                                                on the *raise* instead, by the dashboard's read-by-entity
                                                call. So opening the form and then backing out correctly
                                                leaves the notification unread. */}
                                            {notif.relatedEntityType === 'INVENTORY_ITEM_AVAILABLE' && (
                                                <button onClick={() => navigate(`/${roleSlug}?requestItem=${notif.relatedEntityId}`)}
                                                    className="text-sm bg-brand px-4 py-1.5 text-white font-bold rounded-full hover:bg-brand-dark transition-colors shadow-sm">
                                                    Request Component
                                                </button>
                                            )}
                                            {notif.relatedEntityType === 'INDENT_RECEIVED_CLAIM' && (
                                                <button onClick={() => navigate(`/${roleSlug}?claimFromIndent=${notif.relatedEntityId}`)}
                                                    className="text-sm bg-brand px-4 py-1.5 text-white font-bold rounded-full hover:bg-brand-dark transition-colors shadow-sm">
                                                    Request Component
                                                </button>
                                            )}
                                            {/* Legacy rescue: notifications created before INDENT_RECEIVED_CLAIM
                                                existed are still tagged 'INDENT' but their title ends with
                                                "— RECEIVED". Render the same CTA so users with stale notifs
                                                aren't stranded waiting for the receive-flow to fire again. */}
                                            {notif.relatedEntityType === 'INDENT' && /— RECEIVED$/i.test(notif.title || '') && (
                                                <button onClick={() => navigate(`/${roleSlug}?claimFromIndent=${notif.relatedEntityId}`)}
                                                    className="text-sm bg-brand px-4 py-1.5 text-white font-bold rounded-full hover:bg-brand-dark transition-colors shadow-sm">
                                                    Request Component
                                                </button>
                                            )}
                                            <button onClick={() => markAsRead(notif.id)} className="text-sm border border-faint text-ink px-4 py-1.5 font-bold rounded-md hover:bg-surface transition-colors">
                                                Mark as Read
                                            </button>
                                       </div>
                                   </div>
                               </div>
                           </div>
                       );
                   })}
                   {activePager.totalPages > 1 && (
                       <Pagination currentPage={activePager.page} totalPages={activePager.totalPages} onPageChange={activePager.setPage} />
                   )}
                </div>
            )}

            <Modal isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} title="Notification History">
                <div className="max-h-96 overflow-y-auto pr-2 space-y-4">
                    {historyNotifications.length === 0 ? (
                        <p className="text-center text-faint py-8 border border-dashed border-line rounded-lg">No read notifications to display.</p>
                    ) : (
                        <>
                            {historyPager.items.map(hn => (
                                <div key={hn.id} className="border-b border-line-soft pb-4 last:border-0 last:pb-0">
                                    <h4 className="font-bold text-ink text-sm">{hn?.title || 'Notification'}</h4>
                                    <p className="text-xs text-muted mt-1">{hn?.message || ''}</p>
                                    <span className="text-xs text-faint font-medium block mt-1">{fmtDateTime(hn?.createdAt, '')}</span>
                                </div>
                            ))}
                            {historyPager.totalPages > 1 && (
                                <Pagination currentPage={historyPager.page} totalPages={historyPager.totalPages} onPageChange={historyPager.setPage} />
                            )}
                        </>
                    )}
                </div>
            </Modal>

            <Modal isOpen={isExtModalOpen} onClose={() => setIsExtModalOpen(false)} title="Request Extension">
                <ExtensionForm requestDetails={selectedRequest} onSubmit={submitExtension} isLoading={false} />
            </Modal>
        </div>
    );
};
