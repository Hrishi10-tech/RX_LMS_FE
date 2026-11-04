import { client } from './axios';
import { desktopAlertsMuted } from './alert-preference';

/**
 * Web Push wiring: register the notification-only service worker, subscribe this
 * browser, and hand the subscription to the backend.
 *
 * Why this exists: the socket path can only reach an OPEN tab. Web Push goes via
 * the browser vendor's push service and wakes public/sw.js, so a notification
 * still arrives with the LMS tab — or the whole browser — closed.
 *
 * Every function here is best-effort and never throws. Push is a bonus layer:
 * if anything about it fails (no service-worker support, no VAPID keys on the
 * server, a blocked registration) the app must keep working exactly as it did,
 * with in-page popups while a tab is open.
 */

// Set once a subscription is live, so useDesktopNotifications can stop firing
// its own banner and leave desktop popups to the service worker — otherwise an
// open tab shows two for the same event.
let pushActive = false;
export const isPushActive = (): boolean => pushActive;

const SW_URL = '/sw.js';

/**
 * base64url (how VAPID keys travel) → the byte view `subscribe()` wants.
 *
 * Backed by an explicit `new ArrayBuffer(...)`: TypeScript's DOM lib types
 * applicationServerKey as `BufferSource`, which requires a Uint8Array over a
 * plain ArrayBuffer. A bare `new Uint8Array(n)` widens to
 * `Uint8Array<ArrayBufferLike>` (SharedArrayBuffer included) and is rejected.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Was this subscription made with the server's CURRENT VAPID key?
 *
 * A subscription is bound to the key it was created with. After the server's
 * keys change, reusing the old one means every push is refused by the push
 * service (401/403) — silently, from the user's side. Null applicationServerKey
 * (older browsers don't expose it) counts as a match: we cannot tell, and
 * churning the subscription on every load would be worse.
 */
function subscribedWithKey(sub: PushSubscription, key: Uint8Array<ArrayBuffer>): boolean {
  const current = sub.options?.applicationServerKey;
  if (!current) return true;
  const bytes = new Uint8Array(current);
  if (bytes.length !== key.length) return false;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== key[i]) return false;
  return true;
}

const supported = (): boolean =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/**
 * Register the service worker. Safe to call on every load — the browser
 * de-duplicates by script URL. Returns null when unsupported or on failure.
 *
 * Registered even before permission is granted: the worker is also what handles
 * notificationclick, and having it ready avoids a race on the first subscribe.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  try {
    return await navigator.serviceWorker.register(SW_URL, { scope: '/' });
  } catch {
    return null;
  }
}

/**
 * Subscribe this browser to Web Push and store the subscription server-side.
 *
 * Requires notification permission to already be GRANTED — the browser rejects
 * a subscribe otherwise, and we must not trigger a permission prompt from here
 * (that belongs to an explicit click; see the Notifications page).
 *
 * Returns true when push is live. Reuses an existing subscription rather than
 * churning a new one on every load; re-posts it to the backend regardless, which
 * is an upsert, so a subscription made before a DB reset heals itself.
 */
export async function enablePush(): Promise<boolean> {
  // useDesktopNotifications calls this on every mount, so without this guard
  // the next page load would silently re-subscribe a browser whose owner had
  // just turned alerts off.
  if (desktopAlertsMuted()) return false;
  if (!supported() || Notification.permission !== 'granted') return false;
  try {
    const keyRes = await client.get('/push/public-key');
    const payload = keyRes.data?.data ?? keyRes.data;
    const publicKey: string = payload?.publicKey || '';
    // Server has no VAPID keys configured — push is off by design, not broken.
    if (!payload?.enabled || !publicKey) return false;

    const reg = (await navigator.serviceWorker.getRegistration(SW_URL)) || (await registerServiceWorker());
    if (!reg) return false;
    await navigator.serviceWorker.ready;

    const serverKey = urlBase64ToUint8Array(publicKey);
    let existing = await reg.pushManager.getSubscription();
    // Bound to an old VAPID key (the server's keys were rotated): drop it so a
    // fresh one is made with the current key. The server prunes the old row
    // the first time the push service refuses it.
    if (existing && !subscribedWithKey(existing, serverKey)) {
      await existing.unsubscribe().catch(() => {});
      existing = null;
    }
    const sub =
      existing ??
      (await reg.pushManager.subscribe({
        // Required by Chrome: every push must result in a visible notification.
        userVisibleOnly: true,
        applicationServerKey: serverKey,
      }));

    const json: any = sub.toJSON();
    if (!json?.endpoint || !json?.keys?.p256dh || !json?.keys?.auth) return false;

    await client.post('/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
    pushActive = true;
    return true;
  } catch {
    // Offline, blocked, or the push service refused — stay on the in-page path.
    return false;
  }
}

/** Drop this browser's subscription (used when someone turns alerts off). */
export async function disablePush(): Promise<void> {
  if (!supported()) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration(SW_URL);
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) { pushActive = false; return; }
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await client.post('/push/unsubscribe', { endpoint }).catch(() => {});
  } catch {
    /* best-effort */
  } finally {
    pushActive = false;
  }
}
