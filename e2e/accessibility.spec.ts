import { test, expect } from '@playwright/test';
import { signInAs, ACCOUNTS } from './helpers/auth';
import { sql, sqlValue, lit, createIndentFixture, dropFixtures, userFixtureIds } from './helpers/db';

/**
 * The accessibility work UI-SANDBOX.md asks us not to undo.
 *
 * Each of these was fixed once and is easy to break again by accident during a
 * restyle — a nav item losing its icon, a drawer losing its focus trap, an
 * active filter going back to colour-only. They are behaviour, not appearance,
 * so they belong in a test rather than in a reviewer's memory.
 */
const ownerArgs = (o: { id: string; departmentId: string }) => ({
  createdById: o.id, departmentId: o.departmentId,
});

test.describe('accessibility invariants', () => {
  test('every nav item has an icon and an accessible name', async ({ page }) => {
    await signInAs(page, 'superAdmin');
    const items = page.locator('nav button');
    // signInAs only waits for the URL, so counting straight away races React
    // mounting the sidebar — and count() does not retry, it just returns 0.
    // Wait for the first item to exist before trusting the count.
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    expect(count).toBeGreaterThan(5);

    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      const label = await item.getAttribute('aria-label');
      expect(label, `nav item ${i} has no aria-label`).toBeTruthy();
      expect(
        await item.locator('svg').count(),
        `nav item "${label}" renders no icon`,
      ).toBeGreaterThan(0);
    }
  });

  test('icon-only controls carry a name', async ({ page }) => {
    await signInAs(page, 'superAdmin');
    await page.waitForLoadState('networkidle');

    // Buttons with no text content must say what they do some other way.
    const unnamed = await page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter((b) => !b.textContent?.trim() && b.querySelector('svg'))
        .filter((b) => !b.getAttribute('aria-label') && !b.getAttribute('title'))
        .map((b) => b.outerHTML.slice(0, 90)),
    );
    expect(unnamed, 'icon-only buttons with no aria-label or title').toEqual([]);
  });

  test('the mobile drawer leaves the tab order when closed', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await signInAs(page, 'superAdmin');

    const drawer = page.locator('[role="navigation"][aria-label="Main menu"]');

    // Closed: `invisible` is what actually removes the off-screen drawer's ~15
    // controls from the tab order. A `-translate-x-full` element is still
    // focusable, which was the original bug — a keyboard user on a phone
    // tabbed through the entire hidden menu before reaching the page.
    await expect(drawer).toHaveClass(/invisible/);
    await expect(drawer).toHaveClass(/-translate-x-full/);
    // ...but only below md; from md up it must stay visible.
    await expect(drawer).toHaveClass(/md:visible/);

    // A control inside the closed drawer must refuse focus.
    const focusTaken = await page.evaluate(() => {
      const d = document.querySelector('[role="navigation"][aria-label="Main menu"]');
      const btn = d?.querySelector('button') as HTMLElement | null;
      btn?.focus();
      return document.activeElement === btn;
    });
    expect(focusTaken, 'a control in the closed drawer accepted focus').toBe(false);

    // Open: the class comes off and Escape closes it again.
    await page.getByRole('button', { name: 'Open navigation menu' }).click();
    await expect(drawer).not.toHaveClass(/invisible/);
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveClass(/invisible/);
  });

  test('an active column filter is marked by a filled glyph, not colour alone', async ({ page }) => {
    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/inventory');
    await page.waitForLoadState('networkidle');

    const trigger = page.locator('button[aria-label*="Filter"]').first();
    await expect(trigger).toBeVisible();

    // Inactive: an outline chevron.
    await expect(trigger).toHaveAttribute('aria-label', /filter this column/i);
    expect(await trigger.locator('svg').getAttribute('fill')).toBe('none');

    // Pick a value.
    await trigger.click();
    const popover = page.locator('.fade-slide-down');
    await expect(popover).toBeVisible();
    await popover.locator('button').nth(1).click();

    // Active: a *different, filled* glyph, and the name says what it is
    // filtered by — so the state survives greyscale and screen readers.
    const active = page.locator('button[aria-label*="currently filtered by"]').first();
    await expect(active).toBeVisible();
    expect(
      await active.locator('svg').getAttribute('fill'),
      'the active filter glyph is not filled',
    ).toBe('currentColor');
  });

  test('an Associate Finance sees only the indents assigned to it', async ({ page }) => {
    // This replaces an older assertion that AF saw every indent with amounts
    // rendered as "Hidden". The 23 Sept handover tightened the rule: every AF
    // read — list AND single-indent — now carries `associateFinanceScope`
    // ({ paymentAssigneeId: me }), so a foreign row never reaches the server's
    // redaction step at all. The money is still protected; it is protected by
    // not being sent rather than by being blanked, so that is what this asserts.
    //
    // Worth knowing: the `amountsRedacted` flag and the "Hidden" cell it drives
    // are consequently unreachable in this build.
    // By ROLE, not by a hard-coded email. The demo data restored here and the
    // data `prisma db seed` creates use entirely different accounts, and a
    // spec pinned to either one fails everywhere the other is loaded.
    const afId = sqlValue(
      `SELECT id FROM "User" WHERE email = ${lit(ACCOUNTS.associateFinance)} AND "deletedAt" IS NULL`,
    );
    expect(afId, 'the associate-finance fixture user is missing').toBeTruthy();

    // Two indents of its own: one handed to this AF, one left alone. It used
    // to borrow the first two in-progress indents in the database, so it went
    // red on any sandbox holding fewer than two — and proved nothing when it
    // was green, because which indents it borrowed depended on that morning's
    // testing.
    const owner = userFixtureIds(ACCOUNTS.user);
    const mine = createIndentFixture({ ...ownerArgs(owner), paymentAssigneeId: afId! });
    const theirs = createIndentFixture(ownerArgs(owner));

    try {
      await signInAs(page, 'associateFinance');
      await page.goto('/associate-finance/indents');
      await page.waitForLoadState('networkidle');

      await expect(
        page.getByText(mine.serialNo, { exact: false }).first(),
        `${mine.serialNo} is assigned to this AF but is not on its screen`,
      ).toBeVisible();

      await expect(
        page.getByText(theirs.serialNo, { exact: false }),
        `${theirs.serialNo} is NOT assigned to this AF but leaked onto its screen`,
      ).toHaveCount(0);
    } finally {
      dropFixtures();
    }
  });

  test.describe('while a table is loading', () => {
    // The app's service worker (desktop alerts) takes control of the page, and
    // in WebKit that stops page.route from seeing — so delaying — any request.
    test.use({ serviceWorkers: 'block' });
    test('the loading skeleton is hidden from assistive tech but announced once', async ({ page }) => {
      await signInAs(page, 'superAdmin');

      // Hold the table's fetch open so the skeleton is on screen to inspect.
      await page.route('**/api/**', async (route) => {
        await new Promise((r) => setTimeout(r, 8000));
        await route.continue();
      });
      await page.goto('/super-admin/inventory');

      // All three read in ONE look at the page, while a table is still busy.
      // As separate assertions WebKit sometimes finished loading between them,
      // and a correct page failed on whichever check came last.
      await expect.poll(() => page.evaluate(() => {
        const busy = document.querySelector('table[aria-busy="true"]');
        if (!busy) return 'no table loading yet';
        return JSON.stringify({
          announced: /loading/i.test(document.querySelector('span[role="status"]')?.textContent ?? ''),
          skeletonRowsExposed: [...busy.querySelectorAll('tbody tr')].some((r) => r.getAttribute('aria-hidden') !== 'true'),
        });
      }), { timeout: 20_000 }).toBe(JSON.stringify({ announced: true, skeletonRowsExposed: false }));

      await page.unroute('**/api/**');
    });
  });
});
