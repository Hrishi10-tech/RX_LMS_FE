/* eslint-disable react-refresh/only-export-components --
   Idiomatic context module: Context + Provider + consumer hook are co-located.
   Dev-only Fast-Refresh hint with no runtime impact. */
import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '../hooks/useAuth';
import { safeSessionStorage } from '../lib/storage';
import { client, ensureFreshAccessToken } from '../lib/axios';
import { serverKickRetryDelay } from '../utils/socketRetry';

interface SocketContextType {
  socket: Socket | null;
  connected: boolean;
  send: (data: any) => void;
  addListener: (listener: (data: any) => void) => void;
  removeListener: (listener: (data: any) => void) => void;
  wsRef: React.MutableRefObject<Socket | null>;
}

export const SocketContext = createContext<SocketContextType>({ 
  socket: null, 
  connected: false,
  send: () => {},
  addListener: () => {},
  removeListener: () => {},
  wsRef: { current: null }
});

export const useSocket = () => useContext(SocketContext);

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  
  const wsRef = useRef<Socket | null>(null);
  const listeners = useRef<Array<(data: any) => void>>([]);

  const send = useCallback((data: any) => {
    if (wsRef.current?.connected) {
      wsRef.current.emit('relay', data);
    } else {
      console.warn('[Socket] send() called but socket not connected');
    }
  }, []);

  const addListener = useCallback((listener: (data: any) => void) => {
    listeners.current.push(listener);
  }, []);

  const removeListener = useCallback((listener: (data: any) => void) => {
    listeners.current = listeners.current.filter(l => l !== listener);
  }, []);

  useEffect(() => {
    if (user?.id) {
      // Same-origin by default, for the same reason as lib/axios.ts: an
      // absolute origin here would be compiled into the bundle and would be
      // wrong everywhere except the machine that built it. socket.io-client
      // treats '' as "connect to the page's own origin", and nginx proxies
      // /socket.io/ (with the Upgrade headers) exactly as it proxies /api/.
      // An explicit VITE_API_URL / VITE_API_BASE_URL still wins when the
      // gateway really does live somewhere else.
      const explicit = import.meta.env.VITE_API_URL
        || (import.meta.env.VITE_API_BASE_URL || '').replace(/\/api\/?$/, '');
      const apiUrl = /^https?:\/\//.test(explicit) ? explicit : '';
      // Identity comes from the JWT in `auth.token` — the gateway verifies the token
      // and derives `userId` from its `sub` claim. We no longer trust a client-supplied
      // userId because anyone could connect as anyone with the old query-param flow.
      // Reconnect with exponential backoff so a transient WiFi drop doesn't
      // permanently kill notifications & chat until the user refreshes.
      // socket.io-client's built-in reconnection handles this for us — we just
      // need to opt in explicitly and re-fetch the access token on each attempt
      // (it may have been refreshed by the API interceptor in the meantime).
      const newSocket = io(apiUrl, {
        auth: (cb) => {
          // Refresh the access token first if it is at (or near) expiry.
          //
          // The token lives ~15 minutes and was previously only refreshed
          // reactively, when an HTTP request 401s. A tab sitting idle in a chat
          // makes no HTTP requests, so the stored token quietly went stale —
          // and the moment the socket reconnected (wifi blip, laptop waking) it
          // handshook with an expired token and was rejected, leaving the user
          // silently cut off from live messages and presence until they
          // refreshed. ensureFreshAccessToken shares the HTTP layer's
          // single-flight lock, so this can never race a 401-driven refresh.
          ensureFreshAccessToken()
            .then((token) => cb({ token: token || safeSessionStorage.getItem('accessToken') || '' }))
            .catch(() => cb({ token: safeSessionStorage.getItem('accessToken') || '' }));
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 30_000,
        randomizationFactor: 0.5,
      });

      // Server kicks (`io server disconnect`) are the one case socket.io does
      // not retry, and the usual cause is a token that expired while the tab
      // sat idle — the socket then stayed dead until a full page reload. So:
      // refresh the token and reconnect, a bounded number of times with
      // backoff (serverKickRetryDelay). The count only resets once a
      // connection has STAYED up, because a rejected handshake still
      // connects first and is kicked a moment later — resetting on 'connect'
      // would retry forever.
      let kickRetries = 0;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let stableTimer: ReturnType<typeof setTimeout> | undefined;
      let disposed = false;

      newSocket.on('connect', () => {
        setConnected(true);
        clearTimeout(stableTimer);
        stableTimer = setTimeout(() => { kickRetries = 0; }, 30_000);
      });
      newSocket.on('disconnect', (reason: string) => {
        setConnected(false);
        clearTimeout(stableTimer);
        // For every other reason (transport close, ping timeout, etc.)
        // socket.io already retries with backoff under the hood.
        if (reason !== 'io server disconnect') return;
        const delay = serverKickRetryDelay(kickRetries);
        if (delay === null) {
          console.warn('[Socket] server keeps closing the connection — giving up until reload');
          return;
        }
        kickRetries += 1;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          // The auth callback above also refreshes, but only when the token is
          // near expiry by its own clock; asking here first makes sure the
          // reconnect carries the newest token there is.
          ensureFreshAccessToken()
            .catch(() => null)
            .finally(() => { if (!disposed) newSocket.connect(); });
        }, delay);
      });
      // The server says why it is about to kick us; nothing listened before,
      // so a rejected token left no trace in the console at all.
      newSocket.on('auth:error', (payload: { message?: string } | undefined) => {
        console.warn('[Socket] auth rejected:', payload?.message || 'unknown reason');
        // The server cuts a deactivated person (or one whose password was just
        // changed) off at once. Ask the API who we are: a dead session fails
        // its refresh and the normal 401 path signs this tab out now, instead
        // of on whatever the person happens to click next. A token that had
        // merely expired refreshes and nothing visible happens.
        client.get('/users/me').catch(() => undefined);
      });
      newSocket.on('connect_error', (err: any) => {
        console.warn('[Socket] connect_error:', err?.message || err);
      });
      newSocket.on('reconnect_attempt', (attempt: number) => {
        console.debug(`[Socket] reconnect attempt ${attempt}`);
      });

      newSocket.on('relayed_event', (data: any) => {
         listeners.current.forEach(fn => fn(data));
      });

      setSocket(newSocket);
      wsRef.current = newSocket;

      return () => {
        disposed = true;
        clearTimeout(retryTimer);
        clearTimeout(stableTimer);
        newSocket.disconnect();
      };
    } else {
        if (socket) {
            socket.disconnect();
            setSocket(null);
            wsRef.current = null;
            setConnected(false);
        }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-subscribes only on user?.id change; excludes 'socket' to avoid tearing down and reconnecting the socket every render
  }, [user?.id]);

  return (
    <SocketContext.Provider value={{ socket, connected, send, addListener, removeListener, wsRef }}>
      {children}
    </SocketContext.Provider>
  );
};
