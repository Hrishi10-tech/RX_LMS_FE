// Storage shims that don't throw in private/incognito mode.
// Safari and some Firefox configurations disable Web Storage entirely; the
// raw `sessionStorage.setItem` call then throws `QuotaExceededError` or a
// SecurityError, crashing the page on login. These shims swallow the error
// and fall back to an in-memory Map, so the app degrades to "you'll have to
// log in again on refresh" instead of breaking outright.

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

function makeShim(real: Storage | undefined): StorageLike {
  const memory = new Map<string, string>();
  let useReal = !!real;
  // Probe once at module load — if writing fails, fall back permanently for
  // this tab. We re-probe on each call when useReal is false so we don't
  // forever fall back if the user later re-enables storage.
  try {
    if (real) {
      const probe = '__probe__';
      real.setItem(probe, '1');
      real.removeItem(probe);
    }
  } catch {
    useReal = false;
  }
  return {
    getItem(key) {
      if (useReal) {
        try { return real!.getItem(key); } catch { /* fall through */ }
      }
      return memory.has(key) ? memory.get(key)! : null;
    },
    setItem(key, value) {
      if (useReal) {
        try { real!.setItem(key, value); return; } catch { useReal = false; }
      }
      memory.set(key, value);
    },
    removeItem(key) {
      if (useReal) {
        try { real!.removeItem(key); } catch { /* ignore */ }
      }
      memory.delete(key);
    },
  };
}

export const safeSessionStorage: StorageLike = makeShim(typeof window !== 'undefined' ? window.sessionStorage : undefined);
export const safeLocalStorage: StorageLike = makeShim(typeof window !== 'undefined' ? window.localStorage : undefined);
