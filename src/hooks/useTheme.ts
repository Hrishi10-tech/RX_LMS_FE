import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'theme_preference';

/**
 * Reads the stored preference.
 *
 * localStorage THROWS (rather than returning null) when site data is blocked —
 * a locked-down private window, or "block third-party cookies and site data".
 * Every other localStorage site in this app is wrapped for the same reason;
 * an unguarded read here would run during render and take out the app shell.
 */
const readStored = (): ThemePreference => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
};

const systemPrefersDark = () => {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
};

const resolve = (pref: ThemePreference): ResolvedTheme =>
  pref === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : pref;

/**
 * Applies the theme by toggling `.dark` on <html>, which is the switch
 * `darkMode: 'class'` in tailwind.config.js watches. `color-scheme` is set
 * alongside it so the browser's own chrome — form controls, the scrollbar
 * gutter, the flash of background during navigation — matches instead of
 * staying stubbornly light.
 */
const apply = (theme: ResolvedTheme) => {
  const root = document.documentElement;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
};

/**
 * Theme preference, persisted, with 'system' as the default.
 *
 * 'system' is a real third state rather than a synonym for light: someone
 * whose OS is dark should land in dark without touching anything, and should
 * follow the OS when it flips at sunset. Choosing light or dark explicitly
 * pins it and stops the OS from overriding them.
 */
export const useTheme = () => {
  const [preference, setPreference] = useState<ThemePreference>(readStored);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readStored()));

  // Apply on mount and whenever the preference changes.
  useEffect(() => {
    const next = resolve(preference);
    setResolved(next);
    apply(next);
    try {
      localStorage.setItem(STORAGE_KEY, preference);
    } catch { /* site data blocked — the preference just won't persist */ }
  }, [preference]);

  // Follow the OS while (and only while) the preference is 'system'.
  useEffect(() => {
    if (preference !== 'system') return;
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = () => {
      const next = resolve('system');
      setResolved(next);
      apply(next);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [preference]);

  /** Flips between light and dark, pinning the result. */
  const toggle = useCallback(() => {
    setPreference(resolve(readStored()) === 'dark' ? 'light' : 'dark');
  }, []);

  return { preference, resolved, setPreference, toggle };
};
