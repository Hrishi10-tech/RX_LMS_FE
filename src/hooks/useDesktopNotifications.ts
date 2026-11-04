import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSocket } from '../context/SocketContext';
import { useAuth } from './useAuth';
import { queryKeys } from '../lib/queryKeys';
import { showDesktopNotification } from '../utils/desktopNotifications';
import { client } from '../lib/axios';
import { registerServiceWorker, enablePush, isPushActive } from '../lib/push';

/** The alert's click target — resolved per role by OpenNotificationPage. */
const openUrlFor = (type: unknown, id: unknown, notifType?: unknown): string | undefined =>
  typeof id === 'string' && id && typeof type === 'string' && type
    ? `/open-notification?${new URLSearchParams({ type, id, nt: typeof notifType === 'string' ? notifType : '' }).toString()}`
    : undefined;


// Newest notification this BROWSER has already popped, as an ISO timestamp.
// Per-browser (not per-account) on purpose: the point is "did this machine
// already show me a banner for it", which is exactly what localStorage answers.
const SEEN_KEY = 'desktop_notif_seen_v1';
// Never fire more than this many banners at once; the rest collapse into one
// summary. Coming back to 14 unread must not mean 14 separate popups.
const MAX_CATCHUP_POPUPS = 3;

const readSeen = (): string | null => {
  try { return window.localStorage.getItem(SEEN_KEY); } catch { return null; }
};
const writeSeen = (iso: string): void => {
  try { window.localStorage.setItem(SEEN_KEY, iso); } catch { /* site data blocked */ }
};

/**
 * Turns the live `notification:new` socket push (emitted by the backend
 * NotificationsService via the communication gateway) into two things:
 *   1. an (debounced) unread-badge refresh — no waiting for the next focus poll, and
 *   2. an OS-level desktop popup on the user's laptop, so they see new activity
 *      even when the LMS tab is in the background or another app is focused.
 *
 * Mount this ONCE per signed-in session — it lives in DashboardLayout, which
 * wraps every authenticated page and sits under both SocketProvider and
 * QueryClientProvider. The addListener/removeListener cleanup makes a remount
 * (e.g. switching role sections) safe: no duplicate handlers, no double popups.
 *
 * Especially relevant for Procurement, who need to react to incoming indents
 * without keeping the tab in view.
 */
export const useDesktopNotifications = () => {
  const { user } = useAuth();
  const { addListener, removeListener, socket } = useSocket();
  const queryClient = useQueryClient();
  const invalidateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // NOTE: permission is deliberately NOT requested here any more.
  //
  // Asking on mount is an unprompted request with no user gesture behind it,
  // and it backfires: Safari ignores a gesture-less request outright (so the
  // prompt never appears and permission stays 'default' forever), and Chrome
  // treats it as exactly the pattern its "quieter notifications" heuristic
  // auto-denies. A denial is PERMANENT as far as the page is concerned — the
  // API refuses to re-prompt — so this effect could silently and irreversibly
  // turn desktop alerts off for a user who never consciously declined.
  //
  // Permission is now requested only from a real click, on the Notifications
  // page ("Enable desktop alerts"), which is also where the current state is
  // surfaced. This hook just delivers popups once permission exists.

  // Catch-up pass. The live socket push above only fires at the INSTANT a
  // notification is created, so anything raised while this browser wasn't
  // connected produced an in-app row and no banner at all — the daily 8am cron,
  // a backend restart, a sleeping laptop, a closed tab. That reads as "desktop
  // notifications don't work", because from the user's side nothing ever popped.
  //
  // On mount, pop whatever is unread and newer than the last thing this browser
  // showed. Capped, with a summary beyond the cap. Note this can't cover a
  // fully-closed browser — that needs a service worker + Web Push, which is a
  // separate piece of work.
  // Register the service worker and, if permission is already granted, subscribe
  // this browser to Web Push. Registering is safe pre-permission (the browser
  // de-dupes by script URL) and never prompts — the prompt stays behind the
  // explicit click on the Notifications page.
  useEffect(() => {
    if (!user?.id) return;
    void (async () => {
      await registerServiceWorker();
      await enablePush();
    })();
  }, [user?.id]);

  // Read every render (it is not reactive on its own) so the effect below can
  // depend on it: granting permission re-renders, and the catch-up then runs.
  const notificationPermission =
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'denied';

  useEffect(() => {
    if (!user?.id) return;
    // Nothing to catch up ON without permission: showDesktopNotification bails
    // on `Notification.permission !== 'granted'`, so every banner below would
    // be a no-op and the request that feeds them is pure waste — 25 rows per
    // page load, for every user who never granted it, which is most of them.
    //
    // `notificationPermission` is read on each render rather than captured
    // once, and it is in this effect's dependency list, so the catch-up still
    // runs the moment someone grants permission from the Notifications page.
    if (notificationPermission !== 'granted') return;
    let cancelled = false;

    (async () => {
      try {
        // Ask the server for unread only, newest first. The endpoint is paged
        // now, and a catch-up never needs more than the most recent handful —
        // beyond the cap it collapses into one "+N more" banner anyway.
        const res = await client.get('/notifications', { params: { isRead: 'false', take: 25 } });
        if (cancelled) return;
        const payload = res.data?.data ?? res.data;
        const unread: any[] = (payload?.items ?? payload ?? []).filter(
          (n: any) => !n.isRead && typeof n.createdAt === 'string',
        );
        if (unread.length === 0) return;

        // Newest first from the API; newest timestamp becomes the new watermark
        // whether or not we actually pop anything.
        const newestIso = unread[0].createdAt as string;
        const seen = readSeen();

        // First run on this browser: adopt the watermark WITHOUT popping, so a
        // brand-new sign-in doesn't detonate the whole backlog at once.
        if (!seen) { writeSeen(newestIso); return; }

        const fresh = unread.filter((n) => n.createdAt > seen);
        if (fresh.length === 0) return;

        // Catch-up is different from the live path above: it fires on MOUNT, so
        // a tag collapse cannot help — the service worker's banners are already
        // gone from the screen by the time this runs, and re-popping a backlog
        // the user has seen is its own kind of noise. Only skip when this tab
        // genuinely owns the subscription and therefore did receive them.
        if (isPushActive()) { writeSeen(newestIso); return; }

        // Oldest-first so the banners read in the order things happened.
        const ordered = [...fresh].reverse();
        ordered.slice(0, MAX_CATCHUP_POPUPS).forEach((n) => {
          const tag = n.relatedEntityId
            ? `${n.relatedEntityType || 'entity'}:${n.relatedEntityId}`
            : undefined;
          showDesktopNotification(n.title || 'New notification', n.message || undefined, { tag, url: openUrlFor(n.relatedEntityType, n.relatedEntityId, n.type) });
        });
        const extra = ordered.length - MAX_CATCHUP_POPUPS;
        if (extra > 0) {
          showDesktopNotification(
            `+${extra} more notification${extra === 1 ? '' : 's'}`,
            'Open the Notifications page to see everything waiting for you.',
            { tag: 'lms:catchup-summary' },
          );
        }
        writeSeen(newestIso);
      } catch {
        // Offline or the request failed — nothing to catch up on, and this must
        // never surface as an error. The next mount tries again.
      }
    })();

    return () => { cancelled = true; };
  }, [user?.id, notificationPermission]);

  useEffect(() => {
    if (!user?.id) return;

    // Coalesce a burst of notifications into a single unread-count refetch.
    // invalidateQueries bypasses staleTime and forces an immediate refetch of
    // active queries, so K pushes in quick succession would otherwise fire K
    // back-to-back refetches. A trailing debounce collapses them into one.
    const scheduleInvalidate = () => {
      if (invalidateTimer.current) clearTimeout(invalidateTimer.current);
      invalidateTimer.current = setTimeout(() => {
        invalidateTimer.current = null;
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
      }, 400);
    };

    const handler = (data: unknown) => {
      const evt = data as { type?: string; notification?: Record<string, unknown> };
      if (!evt || evt.type !== 'notification:new') return;

      scheduleInvalidate();

      // The popup itself fires immediately per event — each new notification is
      // its own banner; only the badge refetch above is debounced.
      const n = evt.notification || {};
      const title = typeof n.title === 'string' && n.title ? n.title : 'New notification';
      const body = typeof n.message === 'string' ? n.message : undefined;
      const tag =
        typeof n.relatedEntityId === 'string' && n.relatedEntityId
          ? `${String(n.relatedEntityType || 'entity')}:${n.relatedEntityId}`
          : undefined;
      // Always fire from the open tab. This used to be suppressed whenever Web
      // Push was live, on the assumption the service worker would show the
      // banner instead — but that assumption breaks in the ordinary case of one
      // browser and several accounts.
      //
      // A browser has exactly ONE push subscription, and /push/subscribe
      // reassigns it to whoever signed in most recently. `isPushActive()` is
      // per-TAB, so a tab that registered push and then lost the subscription to
      // another account suppressed its own banner AND received no push: silent
      // on both paths, which is how a real notification went unseen here.
      //
      // Both paths tag identically (`<entityType>:<entityId>`), so when push IS
      // still ours the OS collapses the two into one banner. The trade is a
      // possible duplicate that merges, against silence — and silence is worse.
      showDesktopNotification(title, body, { tag, url: openUrlFor(n.relatedEntityType, n.relatedEntityId, n.type) });
      // Keep the catch-up watermark ahead of anything already shown live, so a
      // reconnect doesn't re-pop a banner the user just saw.
      if (typeof n.createdAt === 'string') writeSeen(n.createdAt);
      else writeSeen(new Date().toISOString());
    };

    // Chat messages pop a banner too. They arrive on their OWN socket event
    // rather than through `notification:new`, because the backend only writes
    // a notification row for members who are OFFLINE — an online user on any
    // page other than Connect fell between the two mechanisms and learned
    // nothing at all.
    //
    // Tagged per conversation, so a chatty thread replaces its own banner
    // instead of stacking one per line. Own messages are skipped: the echo
    // comes back to the sender too, and popping a banner for something you
    // just typed is pure noise.
    const onChatMessage = (msg: any) => {
      if (!msg || msg.senderId === user.id) return;
      const who = msg.sender?.name || 'New message';
      const text = typeof msg.text === 'string' ? msg.text : undefined;
      showDesktopNotification(who, text, { tag: `chat:${msg.conversationId}`, url: openUrlFor('CONVERSATION', msg.conversationId) });
    };

    addListener(handler);
    socket?.on('message:new', onChatMessage);
    return () => {
      removeListener(handler);
      socket?.off('message:new', onChatMessage);
      if (invalidateTimer.current) {
        clearTimeout(invalidateTimer.current);
        invalidateTimer.current = null;
      }
    };
  }, [user?.id, user, socket, addListener, removeListener, queryClient]);
};
