// Web Notifications API helpers — OS-level popups shown by the browser while it
// is open, including when the LMS tab is in the background or another app is
// focused. Sibling of callNotifications.ts (which uses the same API for
// incoming calls); kept generic here for ordinary in-app notifications.
//
// This is the "popup on the laptop" layer. It needs no service worker and no
// push server: the live signal already arrives over the app's Socket.IO
// connection (see useDesktopNotifications), so popups fire only while the
// browser is running. (True push-when-closed would need a service worker +
// Web Push/VAPID — deliberately out of scope here.)

import { desktopAlertsMuted } from '../lib/alert-preference';

/**
 * Ask the browser for notification permission. Safe to call repeatedly: it
 * no-ops once the user has answered (granted/denied) and only prompts while the
 * permission is still 'default'. Returns the resulting permission, or
 * 'unsupported' where the API is missing.
 */
export const requestNotificationPermission = async (): Promise<
  NotificationPermission | 'unsupported'
> => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
};

/** Current permission, or 'unsupported' where the API is missing. */
export const notificationPermission = (): NotificationPermission | 'unsupported' => {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
};

// An OS banner is not a place to read a paragraph. macOS shows roughly one line
// of title and two of body before it truncates mid-word with no ellipsis, and
// Windows is not much kinder — so a 109-character message arrives as a sentence
// that stops dead, and even a message that fits is more than anyone reads at a
// glance. Kept to one short line each: enough to know what happened and which
// IND/REQ it is about. Clipped here, at the display edge, rather than shortening what
// the backend writes: the in-app notification row keeps the full text, which is
// where someone goes to actually read it.
const TITLE_MAX = 40;
const BODY_MAX = 50;
const clip = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  // Break on the last word boundary inside the budget, so the banner ends on a
  // word rather than half of one. Falls back to a hard cut for text with no
  // spaces near the limit.
  const cut = t.slice(0, max - 1);
  // Prefer ending on a finished sentence. A banner that stops at a full stop
  // reads as complete; one that stops mid-clause ("… The next") reads as
  // broken, which is what made the depreciation banner look like noise.
  const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (dot > max * 0.55) return cut.slice(0, dot) + '\u2026';
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.\u2014-]+$/, '') + '\u2026';
};

// A title is "<what happened> — IND-039", and the serial is the part you cannot
// lose: "Your indent is waiting to be paid — IND-039" is 43 characters, so a
// plain clip took the serial off the end and left a banner that named no
// indent at all. Clip the descriptive half instead and always keep the id.
const SERIAL_TAIL = /\s[\u2014-]\s((?:IND|REQ|BOM|FA|PO)-\d+)\s*$/;
const clipTitle = (text: string, max: number): string => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const m = t.match(SERIAL_TAIL);
  if (!m) return clip(t, max);
  const serial = m[1];
  const head = t.slice(0, m.index);
  const budget = max - serial.length - 3; // " \u2014 "
  return (budget > 8 ? clip(head, budget) : head.slice(0, Math.max(1, budget))) + ' \u2014 ' + serial;
};

/**
 * Fire a desktop popup if the user has granted permission. No-op otherwise, so
 * callers never have to guard. `tag` collapses repeats of the same underlying
 * event (e.g. two cards for one indent) into a single popup. Clicking the popup
 * focuses the app tab.
 */
export const showDesktopNotification = (
  title: string,
  body?: string,
  opts: { tag?: string; url?: string } = {},
): Notification | null => {
  if (typeof window === 'undefined' || !('Notification' in window)) return null;
  if (Notification.permission !== 'granted') return null;
  // Permission says the browser WOULD allow a banner; this says the user asked
  // us not to. Dropping the push subscription only silences the closed-tab
  // path — an open tab pops its own from the socket, so "off" has to be
  // honoured here too or it only half works.
  if (desktopAlertsMuted()) return null;
  try {
    const notif = new Notification(clipTitle(title, TITLE_MAX), {
      body: body ? clip(body, BODY_MAX) : undefined,
      // /favicon.ico does not exist — the app ships icon.svg (as sw.js uses).
      icon: '/icon.svg',
      tag: opts.tag,
    });
    notif.onclick = () => {
      try {
        window.focus();
      } catch {
        /* focusing a background tab can be blocked — harmless */
      }
      // Open what it is about, not just the tab — same target as the card on
      // the Notifications page (see OpenNotificationPage).
      if (opts.url) window.location.assign(opts.url);
      notif.close();
    };
    return notif;
  } catch {
    return null;
  }
};
