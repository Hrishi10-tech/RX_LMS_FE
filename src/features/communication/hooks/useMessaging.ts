import { useState, useEffect, useRef } from 'react';
import { useAuth, useSocket, useAbortOnUnmount } from '@/hooks';
import { client } from '@/api/client';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { matchesQuery } from '@/features/communication/utils/search';
import { extractErrorMessage } from '@/lib';

/** Messages per page — matches CommunicationService.MESSAGE_PAGE_LIMIT on the server. */
const MESSAGE_PAGE = 500;

/**
 * Tell the rest of the app a conversation's read marker just moved, so the
 * Connect sidebar badge clears without waiting for its next focus refetch.
 * A plain window event rather than a shared store: the badge hook lives in the
 * layout, far outside this feature's tree, and one event keeps the coupling to
 * a single string instead of a provider wrapped around the whole app.
 */
const announceMessagesRead = () => {
  try { window.dispatchEvent(new Event('messages-read')); } catch { /* non-DOM env */ }
};

export const useMessaging = () => {
  const { user } = useAuth();
  const { socket, connected } = useSocket();
  const { addToast } = useToast();
  const confirm = useConfirm();

  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [users, setUsers] = useState<any[]>([]);
  const [conversations, setConversations] = useState<any[]>([]);
  const [selectedConv, setSelectedConv] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  // The server returns at most MESSAGE_PAGE messages per call. A full page
  // means there may be more behind it — reachable with ?before=<oldest id>.
  // The UI never asked, so anything older than the newest 500 was unreachable.
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [showStarredView, setShowStarredView] = useState(false);
  const [starredMessages, setStarredMessages] = useState<any[]>([]);
  const [chatSearch, setChatSearch] = useState('');

  // Always-current view of `conversations` for use inside socket handlers,
  // whose closures would otherwise capture a stale list (they only re-bind on
  // socket/selectedConv change). Lets the message handler update the sidebar
  // in place without re-fetching.
  const conversationsRef = useRef<any[]>([]);
  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);

  // The conversation whose messages we most recently asked for. A response
  // for any other id is stale — the user has already clicked elsewhere.
  const latestConvRequest = useRef<string | null>(null);

  // --- Data fetching ---

  // Background loads used to fail into the console only, so a dead API looked
  // like an empty inbox. Toast it — but once, not on every retry (the
  // conversations refresh re-runs on inbound messages), until a load succeeds.
  // Cancellations are not failures: they mean we left the page.
  const loadFailureShown = useRef(false);
  const reportLoadFailure = (e: any, what: string) => {
    if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') return;
    console.error(e);
    if (loadFailureShown.current) return;
    loadFailureShown.current = true;
    addToast(extractErrorMessage(e, `Could not load ${what}`), 'error');
  };
  const loadSucceeded = () => { loadFailureShown.current = false; };

  const fetchUsersAndConversations = async () => {
    try {
      const [uRes, cRes] = await Promise.all([
        client.get('/messaging/users', { signal: abortSignal() }),
        client.get('/messaging/conversations', { signal: abortSignal() })
      ]);
      setUsers((uRes.data.data || uRes.data).filter((u: any) => u.id !== user?.id));
      setConversations(cRes.data.data || cRes.data);
      loadSucceeded();
    } catch (e) { reportLoadFailure(e, 'conversations'); }
  };

  // Conversations-only refresh. Used on the hot path (every inbound message),
  // where the user directory can't have changed — avoids the wasted /users
  // round-trip that fetchUsersAndConversations would also make.
  const fetchConversations = async () => {
    try {
      const cRes = await client.get('/messaging/conversations', { signal: abortSignal() });
      setConversations(cRes.data.data || cRes.data);
      loadSucceeded();
    } catch (e) { reportLoadFailure(e, 'conversations'); }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load of users + conversations, runs once on mount
  useEffect(() => { fetchUsersAndConversations(); }, []);

  useEffect(() => {
    if (showStarredView) {
      client.get('/messaging/messages/starred', { signal: abortSignal() })
        .then(res => { setStarredMessages(res.data.data || res.data); loadSucceeded(); })
        .catch(e => reportLoadFailure(e, 'starred messages'));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the starred view opens; the helpers are render-scope
  }, [showStarredView]);

  useEffect(() => {
    setChatSearch('');
  }, [selectedConv]);

  // --- Socket events ---

  useEffect(() => {
    // Named handlers, removed one by one. `socket.off('message:new')` with no
    // handler removes EVERY listener for that event — including the app-wide
    // ones for the Connect badge (useUnreadMessages) and chat desktop alerts
    // (useDesktopNotifications). This effect re-runs on every conversation
    // switch, so opening any chat silently switched both off until a reload.
    const handlers: Array<[string, (...args: any[]) => void]> = [];
    const on = (event: string, fn: (...args: any[]) => void) => {
      socket?.on(event, fn);
      handlers.push([event, fn]);
    };
    if (socket) {
      on('message:new', (msg) => {
        if (selectedConv && msg.conversationId === selectedConv.id) {
          setMessages(prev => {
            // The server echoes MessageNew to every member INCLUDING the sender,
            // carrying the original tempId. Replace our optimistic bubble in
            // place instead of appending a duplicate...
            if (msg.tempId && prev.some(m => m.id === msg.tempId)) {
              return prev.map(m => (m.id === msg.tempId ? msg : m));
            }
            // ...and never append a real message we already have (idempotent
            // against duplicate emits / reconnect replays).
            if (prev.some(m => m.id === msg.id)) return prev;
            return [...prev, msg];
          });
        }
        // Update the sidebar row IN PLACE — no server call. The backend
        // denormalises lastMessage/updatedAt onto the Conversation with exactly
        // these values at send time, so the local row matches the server. This
        // keeps message throughput from driving any HTTP/DB load. unreadCount is
        // now a real server-computed value, so bump it locally for chats that
        // are NOT open rather than waiting for the next list fetch.
        // If the chat is open on screen the message is being read as it lands,
        // so keep the marker moving — otherwise switching away would leave a
        // badge for messages the user already saw.
        if (selectedConv?.id === msg.conversationId) {
          client.patch(`/messaging/conversations/${msg.conversationId}/read`)
            .then(announceMessagesRead).catch(() => {});
        }
        const known = conversationsRef.current.some((c) => c.id === msg.conversationId);
        if (!known) {
          // First message of a conversation we don't have yet (someone just
          // started a chat with us) — the only case that needs a fetch.
          fetchConversations();
          return;
        }
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.id === msg.conversationId);
          if (idx === -1) return prev;
          // Bump the badge only when the chat is NOT open and it isn't my own
          // message echoed back — otherwise you'd get an unread count for a
          // conversation you are looking at, or for something you just sent.
          const isOpen = selectedConv?.id === msg.conversationId;
          const isMine = msg.senderId === user?.id;
          const updated = {
            ...prev[idx],
            lastMessage: msg.text,
            updatedAt: msg.createdAt || new Date().toISOString(),
            unreadCount: isOpen || isMine ? 0 : (prev[idx].unreadCount || 0) + 1,
          };
          // Move to the top to mirror the server's `orderBy updatedAt desc`.
          return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)];
        });
      });
      // Presence is broadcast to EVERY connected client on every connect and
      // disconnect. Re-fetching the whole user directory + conversation list
      // here made that O(N^2): with N people online, one login triggered N
      // clients x 2 requests (one returning the entire user table). A morning
      // login rush effectively DDoS'd the API. The payload already carries
      // everything the UI shows for presence, so patch the one user in place.
      on('presence', (p: { userId: string; status: string; lastSeen?: string }) => {
        if (!p?.userId) return;
        setUsers(prev => prev.map(u =>
          u.id === p.userId
            ? { ...u, isOnline: p.status === 'online', ...(p.lastSeen ? { lastSeen: p.lastSeen } : {}) }
            : u
        ));
      });
      // A send the server refused (not a member, over the 10,000-character cap,
      // empty text). `socket.emit` is fire-and-forget and never throws, so the
      // try/catch in sendMessage only ever covered the HTTP fallback — a
      // rejected socket send left the optimistic bubble sitting there with a
      // "sent" tick and told the user nothing. Surface the server's own reason
      // and mark that exact bubble failed, matched on the tempId it echoes back.
      on('error', (p: { message?: string; tempId?: string }) => {
        addToast(p?.message || 'Message failed to send', 'error');
        if (p?.tempId) {
          setMessages(prev => prev.map(m => (m.id === p.tempId ? { ...m, status: 'failed' } : m)));
        }
      });
      // Server says "you've been removed from this conversation" — drop it
      // from the sidebar and clear the open chat if it was the active one,
      // so cached history isn't readable post-removal.
      on('conversation:removed', ({ conversationId }: { conversationId: string }) => {
        setConversations(prev => prev.filter(c => c.id !== conversationId));
        setSelectedConv((curr: any) => {
          if (curr?.id === conversationId) {
            setMessages([]);
            addToast('You were removed from this conversation', 'info');
            return null;
          }
          return curr;
        });
      });
    }
    return () => {
      for (const [event, fn] of handlers) socket?.off(event, fn);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribes only when socket/selectedConv change; addToast and fetchUsersAndConversations are render-scope and would needlessly churn the socket listeners
  }, [socket, selectedConv]);

  // --- API helpers ---

  const selectConversation = async (conv: any) => {
    setSelectedConv(conv);
    // Clear rather than keep the previous chat's messages on screen under the
    // new header while this one loads.
    setMessages([]);
    setHasOlder(false);
    latestConvRequest.current = conv.id;
    try {
      const res = await client.get(`/messaging/conversations/${conv.id}/messages`, { signal: abortSignal() });
      // Switching A -> B quickly could land A's (slower) response after B's,
      // painting A's messages under B's header. Only the latest click counts.
      if (latestConvRequest.current !== conv.id) return;
      const page = res.data.data || res.data;
      setMessages(page);
      setHasOlder(Array.isArray(page) && page.length >= MESSAGE_PAGE);
    } catch (e: any) {
      if (latestConvRequest.current !== conv.id) return;
      if (e?.code === 'ERR_CANCELED' || e?.name === 'CanceledError') return;
      addToast(extractErrorMessage(e, 'Failed to load messages'), 'error');
    }

    // Opening a chat IS reading it — move the server-side read marker and clear
    // the badge locally so it disappears immediately rather than on the next
    // list refetch. Fire-and-forget: a failed mark must not break opening the
    // conversation, and the next open retries it.
    client.patch(`/messaging/conversations/${conv.id}/read`)
      .then(announceMessagesRead).catch(() => {});
    setConversations((prev: any[]) =>
      prev.map((c) => (c.id === conv.id ? { ...c, unreadCount: 0 } : c)),
    );
  };

  /** Prepend the page of messages before the oldest one on screen. */
  const loadOlder = async () => {
    if (!selectedConv || !messages.length || loadingOlder) return;
    setLoadingOlder(true);
    const convId = selectedConv.id;
    try {
      const res = await client.get(`/messaging/conversations/${convId}/messages`, {
        params: { before: messages[0].id },
        signal: abortSignal(),
      });
      // Same stale-response rule as selectConversation: if the user switched
      // chats meanwhile, this page belongs to the chat they left.
      if (latestConvRequest.current !== convId) return;
      const page = res.data.data || res.data;
      setMessages((prev: any[]) => [...page, ...prev]);
      setHasOlder(Array.isArray(page) && page.length >= MESSAGE_PAGE);
    } catch {
      if (latestConvRequest.current === convId) addToast('Could not load earlier messages', 'error');
    } finally {
      setLoadingOlder(false);
    }
  };

  const startConversation = async (targetUser: any) => {
    try {
      const res = await client.post('/messaging/conversations', { type: 'direct', memberIds: [targetUser.id] });
      const conv = res.data.data || res.data;
      fetchUsersAndConversations();
      selectConversation(conv);
    } catch { addToast('Error starting conversation', 'error'); }
  };

  const createGroup = async (groupName: string, selectedUsers: string[]) => {
    try {
      const res = await client.post('/messaging/conversations', { type: 'group', name: groupName, memberIds: selectedUsers });
      const conv = res.data.data || res.data;
      fetchUsersAndConversations();
      selectConversation(conv);
      addToast('Group created', 'success');
    } catch { addToast('Error creating group', 'error'); }
  };

  const sendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || !selectedConv) return;
    const tempId = 't-' + Math.random().toString(36).substr(2, 9);
    const msgData = {
      id: tempId, conversationId: selectedConv.id, senderId: user?.id,
      sender: { name: user?.name }, text: text.trim(), status: 'sent', createdAt: new Date().toISOString()
    };
    setMessages(prev => [...prev, msgData]);
    setText('');
    try {
      if (socket && connected) {
        socket.emit('sendMessage', { conversationId: selectedConv.id, text: msgData.text, tempId });
      } else {
        const res = await client.post(`/messaging/conversations/${selectedConv.id}/messages`, { text: msgData.text });
        // The HTTP endpoint now also fans the message out over sockets, so a
        // copy can arrive here first. Drop any echoed duplicate before swapping
        // the optimistic bubble for the saved row, so the order of the two
        // never leaves the message rendered twice.
        setMessages(prev => {
          const saved = res.data.data || res.data;
          return prev
            .filter(m => m.id !== saved.id)
            .map(m => (m.id === tempId ? saved : m));
        });
        fetchUsersAndConversations();
      }
    } catch { addToast('Message failed to send', 'error'); }
  };

  const getOtherUser = (conv: any) => {
    if (conv.type !== 'direct') return null;
    return conv.members.find((m: any) => m.userId !== user?.id)?.user || null;
  };

  const updateGroup = async (payload: { name?: string; profilePicture?: string }) => {
    if (!selectedConv) return;
    try {
      await client.patch(`/messaging/conversations/${selectedConv.id}`, payload);
      fetchUsersAndConversations();
      setSelectedConv({ ...selectedConv, ...payload });
      addToast('Group updated successfully', 'success');
    } catch { addToast('Failed to update group', 'error'); }
  };

  const deleteGroup = async () => {
    if (!selectedConv || !await confirm('Are you absolutely sure you want to delete this entire team and its history?')) return;
    try {
      await client.delete(`/messaging/conversations/${selectedConv.id}`);
      fetchUsersAndConversations();
      setSelectedConv(null);
      addToast('Team permanently deleted', 'success');
    } catch { addToast('Failed to delete group', 'error'); }
  };

  const addGroupMember = async (userId: string) => {
    if (!selectedConv) return;
    try {
      await client.post(`/messaging/conversations/${selectedConv.id}/members`, { userId });
      const listRes = await client.get('/messaging/conversations', { signal: abortSignal() });
      setConversations(listRes.data.data || listRes.data);
      const match = (listRes.data.data || listRes.data).find((c: any) => c.id === selectedConv.id);
      if (match) setSelectedConv(match);
      addToast('Member added', 'success');
    } catch { addToast('Failed to add member', 'error'); }
  };

  const removeGroupMember = async (userId: string) => {
    if (!selectedConv || !await confirm('Remove member from group?')) return;
    try {
      await client.delete(`/messaging/conversations/${selectedConv.id}/members/${userId}`);
      const listRes = await client.get('/messaging/conversations', { signal: abortSignal() });
      setConversations(listRes.data.data || listRes.data);
      const match = (listRes.data.data || listRes.data).find((c: any) => c.id === selectedConv.id);
      if (match) setSelectedConv(match);
      addToast('Member removed', 'success');
    } catch { addToast('Failed to remove member', 'error'); }
  };

  const makeGroupAdmin = async (userId: string) => {
    if (!selectedConv) return;
    try {
      await client.patch(`/messaging/conversations/${selectedConv.id}/members/${userId}/role`, { role: 'ADMIN' });
      // Single conversations fetch refreshes both the sidebar list and the open
      // conversation (was two round-trips: fetchUsersAndConversations + this).
      const res = await client.get('/messaging/conversations', { signal: abortSignal() });
      const list = res.data.data || res.data;
      setConversations(list);
      const match = list.find((c: any) => c.id === selectedConv.id);
      if (match) setSelectedConv(match);
      addToast('Promoted to Admin', 'success');
    } catch { addToast('Failed to promote user', 'error'); }
  };

  const leaveGroup = async () => {
    if (!selectedConv || !await confirm('Are you sure you want to leave this group?')) return;
    try {
      await client.delete(`/messaging/conversations/${selectedConv.id}/members/${user?.id}`);
      fetchUsersAndConversations();
      setSelectedConv(null);
      addToast('You left the group', 'success');
    } catch { addToast('Failed to leave group', 'error'); }
  };

  const togglePinGroup = async () => {
    if (!selectedConv) return;
    const currentPin = selectedConv.members.find((m: any) => m.userId === user?.id)?.isPinned;
    try {
      await client.patch(`/messaging/conversations/${selectedConv.id}/pin`, { isPinned: !currentPin });
      fetchUsersAndConversations();
      addToast(!currentPin ? 'Conversation pinned' : 'Conversation unpinned', 'success');
    } catch { addToast('Failed to toggle pin', 'error'); }
  };

  const markAsRead = async () => {
    if (!selectedConv) return;
    // A bare `catch { }` here meant a failed request looked exactly like a
    // successful one that happened to change nothing: no toast, no error, the
    // unread badge simply stayed put. Every mutation below had the same hole.
    try {
      await client.patch(`/messaging/conversations/${selectedConv.id}/read`);
      announceMessagesRead();
      addToast('Marked as read', 'success');
    } catch (e: any) { addToast(extractErrorMessage(e, 'Could not mark as read'), 'error'); }
  };

  // writeText rejects when the page lacks focus or clipboard permission (and
  // is undefined outside a secure context) — say so rather than claim success.
  const copyMessage = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast('Message copied to clipboard', 'info');
    } catch {
      addToast('Could not copy — your browser blocked clipboard access', 'error');
    }
  };

  const toggleStarMessage = async (msg: any) => {
    const isStarred = msg.starredBy?.includes(user?.id);
    try {
      await client.patch(`/messaging/messages/${msg.id}/star`, { starred: !isStarred });
      setMessages(prev => prev.map(m => {
        if (m.id === msg.id) {
          const stars = m.starredBy || [];
          return { ...m, starredBy: !isStarred ? [...stars, user?.id] : stars.filter((id: any) => id !== user?.id) };
        }
        return m;
      }));
      addToast(!isStarred ? 'Saved to Starred' : 'Removed from Starred', 'success');
    } catch (e: any) { addToast(extractErrorMessage(e, 'Could not update Starred'), 'error'); }
  };

  const reactToMessage = async (msgId: string, reaction: string) => {
    try {
      await client.patch(`/messaging/messages/${msgId}/react`, { reaction });
      setMessages(prev => prev.map(m => {
        if (m.id === msgId) {
          const reacts = { ...(m.reactions || {}) };
          if (!reacts[reaction]) reacts[reaction] = [];
          if (reacts[reaction].includes(user?.id)) {
            reacts[reaction] = reacts[reaction].filter((id: any) => id !== user?.id);
            if (reacts[reaction].length === 0) delete reacts[reaction];
          } else { reacts[reaction].push(user?.id); }
          return { ...m, reactions: reacts };
        }
        return m;
      }));
    } catch (e: any) { addToast(extractErrorMessage(e, 'Could not save that reaction'), 'error'); }
  };

  const forwardMessage = () => { addToast('Forward message (Coming soon)', 'info'); };

  const togglePinMessage = async (msg: any) => {
    try {
      await client.patch(`/messaging/messages/${msg.id}/pin`, { isPinned: !msg.isPinned });
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, isPinned: !msg.isPinned } : m));
      addToast(!msg.isPinned ? 'Message Pinned' : 'Message Unpinned', 'success');
    } catch (e: any) { addToast(extractErrorMessage(e, 'Could not pin that message'), 'error'); }
  };

  // --- Derived data ---

  const isGroupAdmin = !!(user?.role === 'SUPER_ADMIN' || selectedConv?.members?.find((m: any) => m.userId === user?.id)?.role === 'ADMIN');

  const sortedConversations = [...conversations].sort((a, b) => {
    const aPinned = a.members?.find((m: any) => m.userId === user?.id)?.isPinned ? 1 : 0;
    const bPinned = b.members?.find((m: any) => m.userId === user?.id)?.isPinned ? 1 : 0;
    if (aPinned !== bPinned) return bPinned - aPinned;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  // You are not someone you can start a chat with, and a group adds you as its
  // creator regardless — so keep yourself out of both pickers. Clicking your own
  // name used to POST a DIRECT conversation whose only member was you, which
  // rendered in the sidebar with a blank name and no one to talk to. (The server
  // now rejects that outright; this stops the UI offering it in the first place.)
  // `users` itself is left whole — the presence handler patches rows in it by id.
  const selectableUsers = users.filter(u => u.id !== user?.id);
  const filteredUsers = selectableUsers.filter(u => matchesQuery(u.name, search));
  const filteredTeams = sortedConversations.filter(c => c.type === 'group' && c.name?.toLowerCase().includes(search.toLowerCase()));
  const filteredStarred = starredMessages.filter(sm => (sm.text || '').toLowerCase().includes(search.toLowerCase()) || sm.conversation?.name?.toLowerCase().includes(search.toLowerCase()) || sm.sender?.name?.toLowerCase().includes(search.toLowerCase()));
  const filteredMessages = messages.filter(m => chatSearch.trim() === '' || matchesQuery(m.text, chatSearch));

  return {
    user, users, conversations, selectedConv, setSelectedConv, messages, text, setText,
    hasOlder, loadingOlder, loadOlder,
    search, setSearch, showStarredView, setShowStarredView,     starredMessages, chatSearch, setChatSearch, isGroupAdmin,
    sortedConversations, selectableUsers, filteredUsers, filteredTeams, filteredStarred, filteredMessages,
    selectConversation, startConversation, createGroup, sendMessage, getOtherUser, updateGroup, deleteGroup, addGroupMember, removeGroupMember,
    makeGroupAdmin, leaveGroup, togglePinGroup, markAsRead, copyMessage,
    toggleStarMessage, reactToMessage, forwardMessage, togglePinMessage,
  };
};
