import { Page, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNTS_FILE } from './accounts-file';

/**
 * Sign-in helpers.
 *
 * Accounts are resolved BY ROLE from the database rather than hard-coded.
 *
 * That is not tidiness — it is the difference between a suite that runs in CI
 * and one that does not. The demo data restored into this sandbox has
 * @rhythmrx.ai accounts; `prisma db seed`, which is all a fresh CI database
 * gets, creates entirely different @example.com ones. A suite pinned to either
 * set passes in exactly one of those two worlds, and the first time it was
 * pointed at a seeded database every single test failed at the login screen.
 *
 * Both datasets use the same local password, so resolving the email is the
 * only thing that has to adapt.
 */
const LOCAL_PASSWORD = 'password123';

/**
 * Resolved by global-setup.ts, which asks the API which account per role can
 * actually sign in with the local password. Read synchronously here so the
 * emails stay plain strings and can be dropped straight into SQL literals in
 * the specs.
 */
const resolved: Record<string, string> = JSON.parse(
  readFileSync(ACCOUNTS_FILE, 'utf8'),
);

export const ACCOUNTS = {
  user: resolved.user ?? '',
  manager: resolved.manager ?? '',
  admin: resolved.admin ?? '',
  procurement: resolved.procurement ?? '',
  finance: resolved.finance ?? '',
  inventory: resolved.inventory ?? '',
  associateFinance: resolved.associateFinance ?? '',
  superAdmin: resolved.superAdmin ?? '',
} as const;

export type Role = keyof typeof ACCOUNTS;

/** The route each role should land on after signing in. */
export const HOME_PATH: Record<Role, string> = {
  user: '/user',
  manager: '/manager',
  admin: '/admin',
  procurement: '/procurement',
  finance: '/finance',
  inventory: '/inventory',
  associateFinance: '/associate-finance',
  superAdmin: '/super-admin',
};

/**
 * Sign in through the real login form.
 *
 * The quick-fill panel this used to click is a localhost-only convenience
 * whose account list is hard-coded in the frontend, so it only works against
 * one particular dataset. The form works against any, and exercises the same
 * path a real person takes. (The panel still has its own test.)
 */
export const signInAs = async (page: Page, role: Role) => {
  const email = ACCOUNTS[role];
  expect(
    email,
    `no ${role} account exists in this database — seed it or restore a snapshot before running the suite`,
  ).toBeTruthy();

  await page.goto('/login');
  await page.fill('#email-address', email);
  await page.fill('#password', LOCAL_PASSWORD);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await page.waitForURL(new RegExp(`${HOME_PATH[role]}(/|$)`), { timeout: 30_000 });

  // Wait for the authenticated shell, not just the URL.
  //
  // `waitForURL` resolves on the first navigation that matches, but the app
  // then performs a second, replacing navigation once auth state settles. A
  // `page.goto` issued in between starts and is then aborted by it, and
  // Playwright reports "Navigation to <target> is interrupted by another
  // navigation to <home>". Chromium happened to win that race almost every
  // time; WebKit lost it in 20 of 92 tests, which read as a browser
  // incompatibility and was really this helper returning too early.
  //
  // `main`, not `navigation`: on a mobile viewport the nav is a drawer that is
  // CLOSED by default, so waiting for it to be visible never resolves — which
  // is how the first version of this broke the one spec that sets a phone
  // viewport. The main region is rendered by DashboardLayout in every
  // viewport, so it marks "the shell is up" without encoding a layout choice.
  await page.getByRole('main').first().waitFor({ state: 'visible', timeout: 30_000 });

  // And let the dashboard finish loading. It writes its own address (page,
  // filters) with replaceState once its lists arrive; WebKit and Firefox count
  // that as a navigation, so a `page.goto` issued in that window was reported
  // "interrupted by another navigation to /manager" (WebKit) or
  // NS_BINDING_ABORTED (Firefox) — 11 of 13 cross-browser failures on 28 Oct.
  // Bounded: a live socket or a polling badge must not hold the test hostage.
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  // A socket or a polling badge can keep the network from ever idling, so
  // also wait for the address itself to stop changing (Playwright reports a
  // replaceState as a frame navigation): 1.5 s quiet, 10 s at most.
  let last = Date.now();
  const onNav = () => { last = Date.now(); };
  page.on('framenavigated', onNav);
  const until = Date.now() + 10_000;
  while (Date.now() - last < 1_500 && Date.now() < until) await page.waitForTimeout(250);
  page.off('framenavigated', onNav);
};

/** Clears the session so the next navigation starts unauthenticated. */
export const signOut = async (page: Page) => {
  await page.evaluate(() => {
    try { sessionStorage.clear(); localStorage.removeItem('token'); } catch { /* blocked */ }
  });
};

/** Navigates via the sidebar, which also proves the nav item exists. */
export const navigateTo = async (page: Page, label: string) => {
  const item = page.locator('nav button', { hasText: new RegExp(`^${label}`) }).first();
  await expect(item).toBeVisible();
  await item.click();
};
