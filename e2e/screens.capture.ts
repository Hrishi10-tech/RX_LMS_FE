import { test } from '@playwright/test';
import { signInAs, type Role } from './helpers/auth';

/**
 * Not an assertion suite — a capture pass.
 *
 * The merge brought upstream logic onto reskinned components; tsc and the
 * behavioural specs prove they work, not that they look right. These are the
 * screens whose conflicts I resolved by hand, shot in both themes so the two
 * can be compared side by side.
 *
 * Run it on its own — it is NOT part of `npm run test:e2e`:
 *
 *   npm run test:shots
 *
 * Hence `.capture.ts` rather than `.spec.ts`: the suite's testMatch picks up
 * only `.spec.ts` files, so this one is invisible to it and a green suite keeps
 * meaning 11 real assertions. See playwright.capture.config.ts.
 *
 * The stack must already be up, and the frontend image must be current —
 * these shoot the built bundle, not your working tree.
 */
const SHOTS: { role: Role; path: string; name: string }[] = [
  { role: 'procurement', path: '/procurement/indents',  name: 'indents-management' },
  { role: 'finance',     path: '/finance/indents',      name: 'finance-indents' },
  { role: 'inventory',   path: '/inventory/history',    name: 'item-history' },
  { role: 'superAdmin',  path: '/super-admin/inventory', name: 'inventory-table' },
];

for (const theme of ['light', 'dark'] as const) {
  for (const { role, path, name } of SHOTS) {
    test(`${name} (${theme})`, async ({ page }) => {
      // Set before the app boots so the pre-paint script picks it up and there
      // is no flash of the other theme in the capture.
      await page.addInitScript((t) => {
        try { localStorage.setItem('theme_preference', t); } catch { /* blocked */ }
      }, theme);

      await signInAs(page, role);
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      // Let entrance animations settle so nothing is caught mid-transform.
      await page.waitForTimeout(1200);

      await page.screenshot({
        path: `e2e/shots/${name}-${theme}.png`,
        fullPage: false,
        // Without this the shots are not reproducible: the unread-bell
        // `.dot-ping` pulses forever, so each run catches it at a different
        // point in its scale and the PNG changes with nothing else having.
        // 'disabled' finishes every animation and freezes it, which is also
        // the honest thing to compare — a pulse mid-pulse is not the design.
        animations: 'disabled',
      });
    });
  }
}
