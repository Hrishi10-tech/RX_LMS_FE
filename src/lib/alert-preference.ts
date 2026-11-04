/**
 * Whether this browser should show desktop alerts at all.
 *
 * Separate from the browser's permission, because the two are not the same
 * thing and only one of them a page can change. Once someone grants
 * permission, `Notification.permission` is 'granted' forever as far as the app
 * is concerned — there is no API to hand it back. So "turn these off" cannot
 * mean revoking permission; it has to mean the app choosing not to use it.
 *
 * That is what this holds. Before it existed, alerts could be switched on from
 * three places (the Notifications page, the DesktopAlertsPrompt banner, and
 * automatically on mount in useDesktopNotifications) and off from none:
 * `disablePush()` was written, exported, documented as "used when someone
 * turns alerts off", and called by nothing. Anyone who turned alerts on had no
 * way back short of their browser's site settings.
 *
 * Two things have to respect it or "off" does not hold:
 *   - `enablePush()`, because useDesktopNotifications re-subscribes on every
 *     mount and would otherwise undo the switch on the next page load;
 *   - `showDesktopNotification()`, because unsubscribing from Web Push only
 *     stops banners while the tab is CLOSED. An open tab fires its own, over
 *     the socket, and would keep doing so.
 *
 * Per-browser, not per-account: "do not pop things up on this machine" is a
 * property of the machine someone is sitting at, which is exactly what
 * localStorage answers. Absent key means ON, so nobody who already enabled
 * alerts loses them to this change.
 */
const KEY = 'lms.desktopAlerts';

/** True when the user has explicitly switched desktop alerts off here. */
export const desktopAlertsMuted = (): boolean => {
  try {
    return window.localStorage.getItem(KEY) === 'off';
  } catch {
    // Private window, or site data blocked. Treat as not muted: failing open
    // keeps the feature working rather than silently killing it.
    return false;
  }
};

export const setDesktopAlertsMuted = (muted: boolean): void => {
  try {
    window.localStorage.setItem(KEY, muted ? 'off' : 'on');
  } catch {
    /* site data blocked — the toggle just won't persist across reloads */
  }
};
