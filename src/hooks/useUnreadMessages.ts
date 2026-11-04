import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { client } from '../api';
import { queryKeys } from '../lib/queryKeys';
import { useAuth } from './useAuth';
import { useSocket } from './useSocket';

/**
 * Unread-message count for the Connect sidebar badge.
 *
 * WHY THIS EXISTS
 * Connect was the one badged-worthy nav item with no badge. A message reached
 * you over the live socket only if you happened to be looking at the Connect
 * page; from anywhere else in the app a new message produced nothing at all —
 * no sidebar mark, no bell, no popup — and you found out by opening Connect on
 * the off chance. (The bell stayed empty by design: the backend only writes a
 * notification row for members who are OFFLINE, so an online user on another
 * page fell between the two mechanisms.)
 *
 * Hits `/messaging/messages/unread-count`, which returns just the two numbers,
 * rather than the conversation list the Connect page loads. The badge is
 * fetched on every page and after every incoming message, so the cheap
 * endpoint matters.
 *
 * Refreshed by the same `message:new` socket event the Connect page already
 * receives — the gateway emits it to every member's room, so it arrives
 * wherever the user is. `refetchOnWindowFocus` covers anything missed while
 * the socket was down.
 */
export const useUnreadMessages = () => {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { socket } = useSocket();

  const query = useQuery({
    queryKey: queryKeys.messages.unreadCount(),
    queryFn: async () => {
      const { data } = await client.get('/messaging/messages/unread-count');
      const payload = data?.data ?? data ?? {};
      const total = Number(payload.total ?? 0);
      const conversations = Number(payload.conversations ?? 0);
      return {
        total: Number.isFinite(total) ? total : 0,
        conversations: Number.isFinite(conversations) ? conversations : 0,
      };
    },
    enabled: !!user,
    refetchOnWindowFocus: true,
    staleTime: 15 * 1000,
  });

  useEffect(() => {
    if (!user) return;
    // Refetch rather than increment locally: the count must also go DOWN when
    // the user reads a thread, and the server already owns that rule via
    // lastReadAt. Counting messages here would drift the moment a read happens
    // in another tab.
    const refetchCount = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.messages.unreadCount() });
    };
    // The server echoes every message back to its sender too. Your own
    // message can never be unread for you, so that echo was a wasted refetch
    // on every send.
    const onMessage = (msg?: { senderId?: string }) => {
      if (msg?.senderId && msg.senderId === user.id) return;
      refetchCount();
    };
    // The raw socket, not the context's addListener — that one only relays
    // `relayed_event` payloads, and `message:new` is its own socket event.
    socket?.on('message:new', onMessage);
    // Fired by the Connect page when a thread is opened and the read marker
    // moves, so the badge clears without waiting for a focus refetch.
    window.addEventListener('messages-read', refetchCount);
    return () => {
      socket?.off('message:new', onMessage);
      window.removeEventListener('messages-read', refetchCount);
    };
  }, [user, socket, queryClient]);

  const data = query.data ?? { total: 0, conversations: 0 };
  return {
    unreadMessages: data.total,
    unreadConversations: data.conversations,
    hasUnreadMessages: data.total > 0,
    isLoading: query.isLoading,
  };
};
