/* Service worker — NOTIFICATIONS ONLY.
 *
 * Deliberately does NOT cache anything. A caching service worker on an app that
 * deploys behind nginx is a foot-gun: users get pinned to a stale bundle and the
 * only cure is clearing site data, which they will not do. nginx already handles
 * caching correctly (immutable hashed /assets, no-store index.html). This worker
 * exists for exactly one capability the page cannot provide: receiving a push
 * while the tab is closed.
 *
 * Keep it dependency-free and boring. It is the one file that keeps running when
 * the app is not.
 */

// Take over immediately on first install rather than waiting for every tab to
// close — otherwise the first subscription can't receive anything until the user
// fully quits the browser.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Same clipping the in-page path applies (src/utils/desktopNotifications.ts).
// Duplicated rather than imported on purpose: this file is dependency-free and
// must keep working when the app is not running. An OS banner truncates a long
// message mid-word with no ellipsis; the full text stays on the in-app row.
var TITLE_MAX = 40;
var BODY_MAX = 50;
function clip(text, max) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  var cut = t.slice(0, max - 1);
  // Prefer ending on a finished sentence (see the note in the sibling helper).
  var dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (dot > max * 0.55) return cut.slice(0, dot) + '\u2026';
  var sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\u2014-]+$/, '') + '\u2026';
}

// Keep the serial when a long title has to be cut (see the sibling helper).
var SERIAL_TAIL = /\s[\u2014-]\s((?:IND|REQ|BOM|FA|PO)-\d+)\s*$/;
function clipTitle(text, max) {
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  var m = t.match(SERIAL_TAIL);
  if (!m) return clip(t, max);
  var serial = m[1];
  var head = t.slice(0, m.index);
  var budget = max - serial.length - 3;
  return (budget > 8 ? clip(head, budget) : head.slice(0, Math.max(1, budget))) + ' \u2014 ' + serial;
}

self.addEventListener('push', (event) => {
  // A push with no/invalid payload still deserves a banner rather than silence —
  // the user knows something happened and can open the app.
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = clipTitle(data.title || 'Lab Management System', TITLE_MAX);
  const options = {
    body: clip(data.body || 'You have a new notification.', BODY_MAX),
    icon: '/icon.svg',
    badge: '/icon.svg',
    // Same tag the in-page path uses, so an open tab and a push about the same
    // event collapse into ONE banner instead of two.
    tag: data.tag || undefined,
    // Let a same-tag push re-alert rather than silently swapping the old banner:
    // a second event on one indent is still news.
    renotify: Boolean(data.tag),
    data: { url: data.url || '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  // Focus an existing window if there is one — opening a duplicate tab every
  // time someone clicks a banner is its own kind of annoying.
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) {
          if (client.url.includes(target) === false && 'navigate' in client) {
            return client.navigate(target).then((c) => c && c.focus());
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
