import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { client } from '../api';
import { queryKeys } from '../lib/queryKeys';
import { useAuth } from './useAuth';

// Module-level singleton: register the 'notifications-updated' listener
// exactly once for the lifetime of the page, no matter how many components
// call the hook. Without this, every subscriber's useEffect attaches its
// own listener — and the event firing once causes N invalidations =
// N refetches. Confirmed live in DevTools: 2 hits per single event with
// TopBar + DashboardLayout both subscribed.
let listenerInstalled = false;
const installGlobalListener = (queryClient: QueryClient) => {
  if (listenerInstalled || typeof window === 'undefined') return;
  listenerInstalled = true;
  window.addEventListener('notifications-updated', () => {
    // Invalidate the whole notifications namespace so both the unread-count
    // badge (this hook) and any list view refresh together.
    queryClient.invalidateQueries({ queryKey: queryKeys.notifications.all });
  });
};

/**
 * Single source of truth for unread-notification badges.
 *
 * Previously TopBar + DashboardLayout each had their own useEffect that:
 *   - called `client.get('/notifications')` directly (no shared cache)
 *   - re-fetched on mount + focus + visibilitychange + 'notifications-updated'
 * That doubled every fetch (confirmed live in DevTools: notifications hit
 * 5–6× per page render). This hook collapses both consumers onto one
 * React Query subscription:
 *
 *   - one queryKey (`queryKeys.notifications.unreadCount()`) shared across the app
 *   - hits the integer-only `/notifications/unread-count` endpoint instead of
 *     pulling the full (capped-200) list just to count `!isRead` client-side
 *   - `refetchOnWindowFocus: true` replaces the manual focus / visibility
 *     listeners (RQ handles both)
 *   - `staleTime: 30s` deduplicates near-simultaneous mounts (TopBar +
 *     DashboardLayout mount together on every route change)
 *   - one global listener for the 'notifications-updated' event invalidates
 *     the cache, so when NotificationsPage marks something read, all
 *     subscribers refresh in one shot
 *
 * Returns both shapes the old code used: `hasUnread` (boolean — for the
 * TopBar bell dot) and `unreadCount` (number — for the sidebar badge).
 */
export const useUnreadNotifications = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: queryKeys.notifications.unreadCount(),
    queryFn: async () => {
      const { data } = await client.get('/notifications/unread-count');
      const count = Number(data?.data ?? 0);
      return Number.isFinite(count) ? count : 0;
    },
    enabled: !!user,
    refetchOnWindowFocus: true,
    staleTime: 30 * 1000,
  });

  // App-internal "I just marked something read" ping — fired by
  // NotificationsPage. Register the listener exactly once across the
  // whole app via the module-level singleton above. Per-instance
  // useEffect registration was the bug — N subscribers = N listeners
  // = N invalidations on a single event.
  useEffect(() => {
    installGlobalListener(queryClient);
  }, [queryClient]);

  const unreadCount = query.data ?? 0;
  return {
    unreadCount,
    hasUnread: unreadCount > 0,
    isLoading: query.isLoading,
  };
};
