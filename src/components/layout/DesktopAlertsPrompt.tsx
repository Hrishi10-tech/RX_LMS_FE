import { useEffect, useState } from 'react';
import { Bell, X, Loader2 } from 'lucide-react';
import { useToast } from '../../context/ToastContext';
import { requestNotificationPermission, notificationPermission } from '../../utils/desktopNotifications';
import { enablePush } from '../../lib/push';

/**
 * A one-line offer to turn desktop alerts on, shown to EVERY signed-in user.
 *
 * The plumbing was never role-specific — notification rows are written for all
 * seven roles and the socket/Web Push fan-out is keyed on user id — but in
 * practice only Procurement ever got a popup, because turning them on meant
 * finding a button on the Notifications page and clicking it, and that is the
 * one page most roles never open. Everyone else sat at permission 'default'
 * forever and concluded the feature was theirs alone.
 *
 * So the offer comes to them instead, on whatever page they are already on.
 *
 * It still has to be a real click. Asking on mount is what the hook deliberately
 * stopped doing: Safari ignores a gesture-less request outright and Chrome's
 * quieter-notifications heuristic auto-denies it, and a denial is PERMANENT —
 * the API will not re-prompt. A bar with a button is the cheapest thing that
 * keeps a genuine user gesture behind the request.
 *
 * Shown only while permission is still 'default' (never to someone who already
 * granted, already refused, or has no support for it), and dismissible. The
 * dismissal is stored per browser rather than per account because that is the
 * scope of the permission itself — granting it once covers every account that
 * signs in here.
 */

const DISMISS_KEY = 'desktop_alerts_prompt_dismissed_v1';

const wasDismissed = (): boolean => {
  // localStorage THROWS rather than returning null when site data is blocked,
  // and this sits in the authenticated shell — an unguarded read would take out
  // every page for anyone in a locked-down window.
  try { return window.localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
};

export const DesktopAlertsPrompt = () => {
  const { addToast } = useToast();
  const [perm, setPerm] = useState<string>(() => notificationPermission());
  const [hidden, setHidden] = useState<boolean>(() => wasDismissed());
  const [working, setWorking] = useState(false);

  // Another tab (or the Notifications page in this one) may answer the prompt
  // while this bar is on screen. Re-read on focus so it does not sit there
  // offering something the user has already granted.
  useEffect(() => {
    const sync = () => setPerm(notificationPermission());
    window.addEventListener('focus', sync);
    return () => window.removeEventListener('focus', sync);
  }, []);

  // Never offer what the browser cannot grant. On a plain-http LAN address
  // (how a local build reaches a tester) notifications and service workers are
  // unavailable regardless of permission, so a "Turn on" button here would burn
  // the one gesture-backed request on a prompt that can only fail — and in
  // Chrome a denial is permanent. The Notifications page explains the real
  // reason; this bar just stays out of the way.
  const insecureOrigin = typeof window !== 'undefined' && !window.isSecureContext;
  if (hidden || insecureOrigin || perm !== 'default') return null;

  const dismiss = () => {
    setHidden(true);
    try { window.localStorage.setItem(DISMISS_KEY, '1'); } catch { /* site data blocked */ }
  };

  const enable = async () => {
    setWorking(true);
    try {
      const res = await requestNotificationPermission();
      setPerm(res);
      if (res === 'granted') {
        // Subscribe to Web Push while the grant is fresh — this is what carries
        // a notification to a closed browser. Silently falls back to in-page
        // popups when the server has no VAPID keys.
        const pushOn = await enablePush();
        addToast(
          pushOn
            ? "Desktop alerts on — you'll get a popup even with the app closed."
            : "Desktop alerts on — you'll get a popup while the app is open.",
          'success',
        );
      } else if (res === 'unsupported') {
        addToast('This browser does not support desktop notifications.', 'error');
        dismiss();
      } else if (res === 'denied') {
        // Nothing to re-ask with. The Notifications page explains how to unblock.
        addToast('Desktop alerts are blocked for this site. You can allow them from the padlock in the address bar.', 'error');
      }
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="mb-4 flex items-center gap-3 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2.5">
      <Bell size={16} className="shrink-0 text-brand-dark" />
      <p className="flex-1 text-xs text-brand-700">
        <span className="font-bold">Get desktop alerts.</span>{' '}
        Approvals, issued items and payment updates pop up on your screen, even when this tab is in the background.
      </p>
      <button
        onClick={enable}
        disabled={working}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-brand px-3 py-1.5 text-xs font-bold text-white transition-colors hover:bg-brand-dark disabled:opacity-50"
      >
        {working && <Loader2 size={12} className="animate-spin" />}
        {working ? 'Asking…' : 'Turn on'}
      </button>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        title="Not now"
        className="shrink-0 rounded p-1 text-brand-dark transition-colors hover:bg-brand-100 hover:text-brand-700"
      >
        <X size={14} />
      </button>
    </div>
  );
};
