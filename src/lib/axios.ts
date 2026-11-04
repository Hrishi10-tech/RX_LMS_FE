/// <reference types="vite/client" />
import axios, { AxiosInstance, AxiosResponse, AxiosError, InternalAxiosRequestConfig } from 'axios';
import { RefreshResponse } from '@/types';
import { mapResponseToAppError } from './app-error';
import { safeSessionStorage } from './storage';

// Relative by default — the API is served from the SAME origin as the app.
//
// This used to default to an absolute `http://localhost:<port>/api`, which made
// the server's address a BUILD-TIME constant: Vite inlines import.meta.env at
// compile time, so whatever value was present when the image was built is
// frozen into the bundle forever. Build the prod image without passing
// VITE_API_BASE_URL and every user's browser calls its own localhost — an
// app that works perfectly for whoever built it and for nobody else. Nothing
// in the running container can correct it; it needs a rebuild.
//
// A relative '/api' removes the question. nginx already proxies /api/ to the
// backend in front of the built app, and vite.config.ts now proxies the same
// path in dev, so one bundle is correct on localhost, staging and production
// alike, on any hostname or port, with no build arg at all.
//
// VITE_API_BASE_URL still overrides, for the one case this cannot cover: an
// API on a genuinely different origin. It is an escape hatch, not the path.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

export const client: AxiosInstance = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

let isRefreshing = false;
let failedQueue: { resolve: (value?: unknown) => void; reject: (reason?: any) => void }[] = [];

/**
 * Seconds until a JWT expires, or null if it can't be read. Purely local — we
 * only need the `exp` claim to decide whether to pre-emptively refresh.
 */
function secondsUntilExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? ''));
    if (!payload?.exp) return null;
    return payload.exp - Math.floor(Date.now() / 1000);
  } catch {
    return null;
  }
}

/**
 * The actual refresh call. Shared by the 401 interceptor and by
 * `ensureFreshAccessToken` so there is exactly ONE place that knows how to
 * rotate the pair (the server issues single-use refresh tokens — two
 * concurrent refreshes would revoke each other and log the user out).
 */
async function refreshTokenPair(): Promise<string> {
  const refreshToken = safeSessionStorage.getItem('refreshToken');
  if (!refreshToken) throw new Error('No refresh token available');
  const { data } = await axios.post<{ data: RefreshResponse }>(
    `${API_BASE_URL}/auth/refresh`,
    { refreshToken },
  );
  safeSessionStorage.setItem('accessToken', data.data.accessToken);
  safeSessionStorage.setItem('refreshToken', data.data.refreshToken);
  return data.data.accessToken;
}

/**
 * Return a token that will still be valid for at least `marginSeconds`,
 * refreshing first if needed.
 *
 * Exists for the WebSocket: the access token lives ~15 minutes and is only
 * refreshed reactively, when an HTTP call 401s. During a long call the app can
 * go that long without making any HTTP request at all, so the stored token
 * quietly goes stale — and the moment the socket reconnects (a wifi blip, a
 * laptop waking) it authenticates with an expired token, gets kicked, and the
 * call's signalling dies. Refreshing at reconnect time closes that window.
 *
 * Deliberately reuses the SAME `isRefreshing` / `failedQueue` pair as the
 * interceptor, so a socket refresh and an HTTP refresh can never run
 * concurrently and burn each other's single-use refresh token. Returns null on
 * failure WITHOUT redirecting — being bounced to /login mid-call is worse than
 * letting the reconnect fail and retry.
 */
export async function ensureFreshAccessToken(marginSeconds = 120): Promise<string | null> {
  const current = safeSessionStorage.getItem('accessToken');
  if (!current) return null;

  const remaining = secondsUntilExpiry(current);
  // Unreadable exp → leave it alone; the 401 path is still the safety net.
  if (remaining === null || remaining > marginSeconds) return current;

  if (isRefreshing) {
    // A refresh is already in flight (ours or the interceptor's) — wait for it
    // rather than starting a second one.
    return new Promise<string | null>((resolve) => {
      failedQueue.push({
        resolve: (token?: unknown) => resolve((token as string) ?? null),
        reject: () => resolve(null),
      });
    });
  }

  isRefreshing = true;
  try {
    const token = await refreshTokenPair();
    processQueue(null, token);
    return token;
  } catch (err) {
    processQueue(err as AxiosError, null);
    return null;
  } finally {
    isRefreshing = false;
  }
}

const processQueue = (error: AxiosError | null, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) prom.reject(error);
    else prom.resolve(token);
  });
  failedQueue = [];
};

client.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = safeSessionStorage.getItem('accessToken');
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error: AxiosError) => Promise.reject(error),
);

// Track the API up/down state so we only fire `api-online` when state
// actually flips (avoids spamming the banner on every successful request).
let apiOfflineState = false;
const setApiOffline = (offline: boolean) => {
  if (apiOfflineState === offline) return;
  apiOfflineState = offline;
  window.dispatchEvent(new Event(offline ? 'api-offline' : 'api-online'));
};

client.interceptors.response.use(
  (response: AxiosResponse) => {
    // Successful response → clear the offline banner if it was up.
    setApiOffline(false);
    return response;
  },
  async (error: AxiosError) => {
    // No HTTP response at all = the request never reached the server.
    // Network down, server down, CORS preflight blocked, DNS fail, etc.
    // Fire the offline event so the global banner can show; callers still
    // see the rejected promise the way they always did.
    // A client-side cancellation (component unmount, superseded request) is
    // NOT a connectivity failure — skip it so we don't flash the offline
    // banner on routine aborts.
    if (error.code === 'ERR_CANCELED') {
      return Promise.reject(error);
    }
    if (!error.response) {
      setApiOffline(true);
    } else {
      setApiOffline(false);
    }
    // A file download (responseType 'blob') gets its error as a Blob too, so
    // the server's sentence — "The file for this record is no longer stored."
    // — was unreadable and every caller showed "Request failed with status
    // code 404". Turn a JSON error body back into JSON for every caller.
    const body: unknown = error.response?.data;
    if (typeof Blob !== 'undefined' && body instanceof Blob && /json/i.test(body.type)) {
      try { error.response!.data = JSON.parse(await body.text()); } catch { /* leave it as it was */ }
    }
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // Auth endpoints (login + refresh) must NOT enter the refresh flow.
    // A 401 on /auth/login means "wrong credentials" — there's literally
    // no token to refresh. Without this guard the interceptor would chase
    // a non-existent refresh token, bounce the page to /login, and reject
    // with the raw axios error (which is why every bad password used to
    // show "Request failed with status code 401" instead of the actual
    // backend message like "Invalid email or password").
    const url = originalRequest?.url || '';
    const isAuthEndpoint = /\/auth\/(login|refresh|logout)\b/.test(url);

    // JWT refresh flow on 401 — try once, then bail to /login.
    // Skipped for auth endpoints + already-retried requests.
    if (error.response?.status === 401 && !originalRequest._retry && !isAuthEndpoint) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            // Mark as retried so that if this replayed request 401s AGAIN
            // (e.g. the freshly-minted token is itself rejected) it falls
            // through to the error mapper instead of re-entering the refresh
            // branch and kicking off a second refresh storm.
            originalRequest._retry = true;
            if (originalRequest.headers) originalRequest.headers.Authorization = 'Bearer ' + token;
            return client(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const refreshToken = safeSessionStorage.getItem('refreshToken');
      if (!refreshToken) {
        safeSessionStorage.removeItem('accessToken');
        // Only redirect if we're not ALREADY on /login — reloading the
        // login page in the middle of a failed call wipes the error
        // toast the user needs to see ("Invalid password" flashes red
        // for half a second and disappears).
        if (!window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
        // Reject with the mapped AppError so callers see a friendly
        // message instead of the raw axios string.
        return Promise.reject(mapResponseToAppError(error));
      }

      try {
        // Shared with ensureFreshAccessToken(); rotates BOTH tokens, since the
        // server issues single-use refresh tokens.
        const newAccessToken = await refreshTokenPair();

        if (originalRequest.headers) originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        processQueue(null, newAccessToken);
        return client(originalRequest);
      } catch (err) {
        processQueue(err as AxiosError, null);
        // Only a refusal ends the session. A refresh that could not REACH the
        // server — network drop, the backend restarting during a deploy, a 5xx,
        // a 429 — says nothing about the session, and wiping the tokens there
        // signed everyone out at once (with whatever they were typing) just
        // because the server was down for a minute. Keep them; the offline
        // banner is already up and the next request tries again.
        const refusal = [401, 403].includes((err as AxiosError)?.response?.status ?? 0);
        // Rejected with the REFRESH failure, not the original 401, so callers
        // (session restore on page load) see "could not reach" and retry
        // instead of reading a 401 as "signed out".
        if (!refusal) return Promise.reject(mapResponseToAppError(err as AxiosError));
        safeSessionStorage.removeItem('accessToken');
        safeSessionStorage.removeItem('refreshToken');
        // Bounce back to the same page after re-login instead of dumping the
        // user on a generic dashboard. We can't preserve in-memory form state
        // across the navigation, but at least we return them to the right URL.
        const current = window.location.pathname + window.location.search + window.location.hash;
        const next = current && current !== '/login' ? `?next=${encodeURIComponent(current)}` : '';
        window.location.replace(`/login${next}`);
        return Promise.reject(err);
      } finally {
        isRefreshing = false;
      }
    }

    // Everything else: map backend AppError response → typed frontend error so callers
    // can `catch (e) { if (e instanceof NotFoundError) ... }` instead of inspecting status codes.
    return Promise.reject(mapResponseToAppError(error));
  },
);
