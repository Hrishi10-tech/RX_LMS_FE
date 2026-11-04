import { useEffect, useState, useCallback } from 'react';

/**
 * Tracks which BOM list the user has "picked" as their active list on the
 * inventory items page. Only the id is persisted — title and contents are
 * fetched fresh from the API so a list rename or item edit from another tab
 * shows up immediately.
 *
 * localStorage is fine here: it's a UX-state-only value, lost on
 * sign-out/clear (which is desirable — your dad's not going to pick up
 * where you left off mid-session anyway).
 */
const STORAGE_KEY = 'activeBomListId';

export const useActiveBomList = () => {
  const [activeId, setActiveIdState] = useState<string | null>(() => {
    try { return window.localStorage.getItem(STORAGE_KEY); } catch { return null; }
  });

  // Cross-tab sync — if the user picks a different list in another tab,
  // mirror it here without forcing a reload.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setActiveIdState(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setActiveId = useCallback((id: string | null) => {
    try {
      if (id) window.localStorage.setItem(STORAGE_KEY, id);
      else window.localStorage.removeItem(STORAGE_KEY);
    } catch {}
    setActiveIdState(id);
  }, []);

  return { activeId, setActiveId };
};
