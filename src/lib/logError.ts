import { client } from './axios';
// Lightweight error logger for the frontend. Wraps console.error with a
// consistent scope prefix so we can grep prod logs by feature, and keeps
// out of the way in dev by not toasting (dashboards shouldn't pop a toast
// every time a stat call hiccups).
//
// Why not just `console.error`? Easier to swap in Sentry / Datadog later by
// changing one file. And easier to silence in tests by mocking this module
// instead of patching the global console.

/**
 * True once the page has started going away.
 *
 * Leaving a page aborts whatever it had in flight, and axios reports an
 * aborted XHR as a plain `Network Error` — the same text it uses when the
 * server is genuinely unreachable. So every navigation away from a page that
 * was still loading wrote console errors that looked like real failures.
 *
 * That is not only noise. This module exists to become the Sentry call site,
 * and shipping it as-is would mean an alert every time somebody clicked away
 * from a slow dashboard. It also made the cross-browser suite unusable: the
 * page sweep walks fifteen pages in a row, and on WebKit — slower to settle
 * than Chromium — eight of those tests failed on `[SuperAdminDashboard]
 * Network Error` from requests the browser had simply abandoned.
 *
 * `pagehide` rather than `beforeunload`: it fires for back/forward navigation
 * and on mobile Safari, where `beforeunload` is unreliable.
 */
let unloading = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => { unloading = true; });
  // A restored bfcache page is live again, so stop suppressing.
  window.addEventListener('pageshow', () => { unloading = false; });
}

/** Errors that only mean "nobody is waiting for this answer any more". */
const isAbandoned = (err: unknown): boolean => {
  const e = err as { code?: string; name?: string; message?: string } | null;
  if (!e) return false;
  // Axios/fetch cancellation, explicit or via AbortController.
  if (e.code === 'ERR_CANCELED' || e.name === 'CanceledError' || e.name === 'AbortError') return true;
  // The browser itself dropped the request (Firefox does this to everything in
  // flight when a page is left, sometimes before \`pagehide\`): axios reports
  // the XHR's abort event as ECONNABORTED "Request aborted". A timeout shares
  // the code but not the text, and stays an error.
  if (e.code === 'ECONNABORTED' && /request aborted/i.test(e.message ?? '')) return true;
  // A request killed by navigation surfaces as a bare network error, which is
  // indistinguishable from a real one by its text alone — so it only counts
  // as abandoned while the page is actually leaving.
  return unloading && (e.code === 'ERR_NETWORK' || /network error/i.test(e.message ?? ''));
};

/**
 * Problems already sent this page-load, so a component failing in a render
 * loop does not post thousands of times. The server groups by fingerprint
 * anyway, but the requests themselves still cost.
 */
const reported = new Set<string>();
const REPORT_CAP = 20;

/**
 * Tell the server, so somebody other than this user knows.
 *
 * Until this existed the console was the only destination — i.e. the user's
 * own machine, where it helps nobody. A failure in production was learned
 * about by someone complaining, and the quiet ones never at all.
 *
 * Fire-and-forget, and failures here are swallowed: reporting an error must
 * never be able to cause one, and if the API is the thing that is down then
 * the report was never going to arrive.
 */
function report(scope: string, err: unknown): void {
  try {
    const e = err as { message?: string; stack?: string } | null;
    const message = `[${scope}] ${e?.message ?? String(err)}`.slice(0, 500);
    if (reported.has(message) || reported.size >= REPORT_CAP) return;
    reported.add(message);

    // Path only. The query string is where ids and search terms live, and
    // this lands in a table read by whoever is on support.
    const path = typeof window !== 'undefined' ? window.location.pathname : undefined;

    // Signed-out pages (forgot / reset password) cannot report: the endpoint
    // needs a session, and the 401 sent the user to /login mid-reset, losing
    // the link they came in on. A crash there is not worth that.
    let signedIn = false;
    try { signedIn = !!window.sessionStorage.getItem('accessToken'); } catch { /* storage blocked */ }
    if (!signedIn) return;

    // The server caps `detail` at 4,000 characters and rejected anything
    // longer outright, so the longest stacks — often the worst crashes — were
    // the ones that never arrived.
    void client.patch('/errors/client', { message, detail: e?.stack?.slice(0, 4000), path }).catch(() => {});
  } catch {
    /* never let reporting throw */
  }
}

export function logError(scope: string, err: unknown) {
  // Dropped silently: there is no failure here to tell anyone about, and the
  // alternative is a log line that cries wolf on every navigation.
  if (isAbandoned(err)) return;

  report(scope, err);

  if (import.meta.env.DEV) {
    // Surface in dev so we don't paper over broken endpoints during development.
    console.error(`[${scope}]`, err);
  } else {
    // In prod we'd ship this to Sentry/etc. For now, still log to console so
    // browser devtools can pick it up without spamming the user with toasts.
    console.error(`[${scope}]`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Report what never passes through `logError`.
 *
 * A `.catch(logError)` only covers the failures somebody remembered to catch.
 * A component throwing during render, or a promise rejected with no handler,
 * bypassed all of it — and those are the quiet ones: a blank panel, a button
 * that does nothing, no trace anywhere a person would look.
 *
 * Call once, before the first render.
 */
export function installGlobalErrorReporting(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event) => {
    // Resource load failures (a missing image) arrive here too and are not
    // application errors; they have no `error` object.
    if (!event.error) return;
    logError('window', event.error);
  });

  window.addEventListener('unhandledrejection', (event) => {
    logError('unhandledrejection', event.reason);
  });
}
