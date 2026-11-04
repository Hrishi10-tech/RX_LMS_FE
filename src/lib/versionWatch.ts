/**
 * Notices when a newer build has been deployed while this tab was left open.
 *
 * A rebuilt frontend gives every asset a new content hash, and index.html is
 * served `no-store` — but that only governs FETCHING it. A tab that loaded the
 * page an hour ago keeps running the old JavaScript forever, with no error to
 * reveal it, so a fix looks like it didn't land. That happened repeatedly
 * during development.
 *
 * The version stamp is the main bundle's filename, taken straight from
 * index.html. No build-time define, no version file to remember to bump —
 * the thing that changes on every build IS the signal.
 */

/** The bundle this tab is currently running, or null when it can't be read. */
export function loadedBundle(): string | null {
  // Vite's dev server serves `/src/main.tsx` instead of a hashed asset, so
  // this returns null there and the watcher stays off — hot reload already
  // covers dev.
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return el?.getAttribute('src') ?? null;
}

/** The bundle the server is currently serving, or null if it can't be determined. */
async function deployedBundle(): Promise<string | null> {
  try {
    // `no-store` on both the request and the cache mode: this must never be
    // answered from the very cache it exists to see past.
    const res = await fetch(`/index.html?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const html = await res.text();
    return html.match(/src="(\/assets\/index-[^"]+\.js)"/)?.[1] ?? null;
  } catch {
    // Offline, or the server is down. Not our problem to report — OfflineBanner
    // already covers that, and a failed check simply means we try again later.
    return null;
  }
}

const CHECK_EVERY_MS = 5 * 60 * 1000;

/**
 * Calls `onNewVersion` once, the first time a different build is detected.
 * Returns a cleanup function.
 *
 * Checks when the tab becomes visible again — which is when a person who left
 * it open overnight actually comes back to it — plus a slow interval for a tab
 * that stays in the foreground all day.
 */
export function startVersionWatch(onNewVersion: () => void): () => void {
  const mine = loadedBundle();
  if (!mine) return () => {};

  let done = false;
  const check = async () => {
    if (done) return;
    const theirs = await deployedBundle();
    if (theirs && theirs !== mine) {
      done = true;
      onNewVersion();
    }
  };

  const onVisible = () => { if (document.visibilityState === 'visible') void check(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  const timer = window.setInterval(() => void check(), CHECK_EVERY_MS);
  void check();

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('focus', onVisible);
    window.clearInterval(timer);
  };
}

/**
 * Is it safe to reload without throwing away someone's work?
 *
 * Deliberately conservative. We just spent effort stopping a stray keypress
 * from discarding a half-filled slip; silently reloading the page underneath
 * someone would be the same mistake with a bigger blast radius. So: an open
 * modal or ANY text a person has entered means we ask instead of acting.
 */
export function safeToReload(): boolean {
  if (document.querySelector('[role="dialog"]')) return false;

  const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea',
  );
  for (const f of fields) {
    // A non-empty field might be a prefilled form or just a search box, and we
    // can't tell them apart from here — so treat any content as work in
    // progress and let the person decide.
    if (f.value && f.value.trim() !== '') return false;
  }
  return true;
}
