/* eslint-disable react-refresh/only-export-components --
   Idiomatic context module: the Context, its Provider component, and the `useAuth`
   consumer hook are intentionally co-located. The Fast-Refresh hint is dev-only and
   carries no runtime impact; splitting would only add import churn across the app. */
import { createContext, useContext, useState, useEffect, ReactNode, useCallback } from 'react';
import { User, LoginResponse, ApiResponse } from '../types';
import { client } from '../api/client';
import { safeSessionStorage, safeLocalStorage } from '../lib/storage';
import { applyRoleFavicon } from '../lib/favicon';
import { disablePush } from '@/lib/push';

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (data: LoginResponse) => void;
  logout: () => void | Promise<void>;
  api: typeof client;
}

// Default is `undefined` (not a stub object) so consuming this context outside
// an <AuthProvider> is caught by the guard in `useAuth` instead of silently
// handing back a logged-out-looking stub that masks the wiring bug.
export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Load user profile if tokens exist
  //
  // Only a refusal (401/403) clears the session. Pressing F5 while the server
  // is restarting used to sign the person out, because any failure here —
  // network, 5xx — wiped the tokens. Now those are retried, with the loading
  // screen and the offline banner up, until the server answers.
  const fetchUser = useCallback(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const { data } = await client.get<ApiResponse<User>>('/users/me');
        setUser(data.data);
        break;
      } catch (error) {
        const status = (error as { statusCode?: number })?.statusCode;
        const refused = status === 401 || status === 403;
        if (refused || !safeSessionStorage.getItem('accessToken') || attempt >= 40) {
          setUser(null);
          safeSessionStorage.removeItem('accessToken');
          safeSessionStorage.removeItem('refreshToken');
          break;
        }
        await new Promise((r) => setTimeout(r, Math.min(15_000, 1_000 * 2 ** Math.min(attempt, 4))));
      }
    }
    setIsLoading(false);
  }, []);

  // Give the tab this role's own icon and title. Everyone keeps several
  // logins open at once, and every tab used to read "Lab Management System"
  // behind the same flask, which made them indistinguishable. Driven off
  // `user?.role` so it also resets on logout.
  useEffect(() => {
    applyRoleFavicon(user?.role ?? null);
  }, [user?.role]);

  useEffect(() => {
    const accessToken = safeSessionStorage.getItem('accessToken');
    if (accessToken) {
      fetchUser();
    } else {
      setIsLoading(false);
    }
  }, [fetchUser]);

  const login = (data: LoginResponse) => {
    safeSessionStorage.setItem('accessToken', data.accessToken);
    safeSessionStorage.setItem('refreshToken', data.refreshToken);
    setUser(data.user);
  };

  const logout = async () => {
    // Drop this browser's push subscription first, while the token still
    // works. Left in place, desktop alerts kept arriving for this account after
    // it signed out — on a shared lab PC, in front of the next person.
    await disablePush().catch(() => undefined);
    const refreshToken = safeSessionStorage.getItem('refreshToken');
    // Best-effort server-side revoke so the refresh token can't be replayed.
    // Don't block logout on it — if the network is down we still clear local state.
    try {
      await client.post('/auth/logout', refreshToken ? { refreshToken } : {});
    } catch {
      // ignore — local cleanup must happen regardless
    }

    // Clear *all* auth-bearing storage (sessionStorage today, plus localStorage
    // in case anything ever caches there). Then hard-reload via location.href so
    // every in-memory cache (React Query, Context state in useIndents/useInventory/
    // useRequests, etc.) is dropped along with the page lifecycle — no risk of the
    // next user seeing the previous user's data via the browser back button.
    // Clear via the SAME shim axios uses, so the in-memory fallback Map (used
    // when Web Storage is unavailable, e.g. Safari private mode) is actually
    // emptied — a raw sessionStorage.clear() would leave the shim's Map intact
    // and the next user could inherit the previous session's token.
    safeSessionStorage.removeItem('accessToken');
    safeSessionStorage.removeItem('refreshToken');
    try { sessionStorage.clear(); } catch {}
    safeLocalStorage.removeItem('accessToken');
    safeLocalStorage.removeItem('refreshToken');
    setUser(null);
    // replace() rather than assign() so the back button doesn't return to an
    // authenticated screen still rendering stale data before redirect kicks in.
    window.location.replace('/login');
  };

  return (
    <AuthContext.Provider value={{ user, isAuthenticated: !!user, isLoading, login, logout, api: client }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
