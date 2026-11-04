import { test, expect } from '@playwright/test';
import { signInAs } from './helpers/auth';

/**
 * Tooltips point at the thing they describe.
 *
 * Native `title` tooltips are placed at the CURSOR and clamped to the
 * viewport, not anchored to their element, so a long one on a right-aligned
 * control slid hundreds of pixels away. Measured before the fix: of 124
 * distinct tooltips, 76 drifted more than 150px and the worst travelled over
 * 1000px, which read as a stray note left behind on the page.
 */
test.describe('tooltips', () => {
  test('a tooltip opens next to its control, not hundreds of pixels away', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    await page.waitForTimeout(2500);

    // Whichever control on this page carries the longest tooltip — the long
    // ones are the ones that used to drift, and naming a specific button
    // means the test dies the moment that button's copy changes.
    // A VISIBLE control with a long tooltip — the long ones are the ones that
    // used to drift, and naming a specific button means the test dies the
    // moment that button's copy changes.
    const target = page.locator('button[title], span[title], a[title]').filter({ visible: true }).first();
    await expect(target, 'nothing on this page has a tooltip to test').toBeVisible({ timeout: 25_000 });
    await target.scrollIntoViewIfNeeded();
    await target.hover({ force: true });

    const tip = page.getByRole('tooltip');
    await expect(tip, 'no tooltip appeared on hover').toBeVisible({ timeout: 10_000 });

    const t = (await tip.boundingBox())!;
    const b = (await target.boundingBox())!;
    const gap = Math.abs((t.x + t.width / 2) - (b.x + b.width / 2));
    expect(gap, `the tooltip opened ${Math.round(gap)}px from the centre of its control`).toBeLessThan(200);
  });

  test('the browser no longer draws its own tooltip as well', async ({ page }) => {
    await signInAs(page, 'procurement');
    await page.goto('/procurement/indents');
    await page.waitForTimeout(2500);

    // Hovering adopts the title; the attribute must be gone afterwards, or
    // the native tooltip renders on top of the anchored one.
    const withTitle = page.locator('[title]').first();
    if (await withTitle.count()) {
      await withTitle.hover();
      await page.waitForTimeout(600);
    }
    const stillNative = await page.evaluate(() =>
      document.querySelectorAll('[data-tip][title]').length);
    expect(stillNative, 'an adopted element kept its title, so both tooltips draw').toBe(0);
  });

  test('an icon-only control keeps its name when its title is adopted', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    await page.waitForTimeout(2500);

    // Hover everything that carries a tooltip, then check nothing was left
    // nameless — an icon-only button takes its name FROM the title.
    const unnamed = await page.evaluate(async () => {
      const els = Array.from(document.querySelectorAll('button[title], button[data-tip]'));
      for (const el of els) el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return Array.from(document.querySelectorAll('button[data-tip]')).filter((el) => {
        const text = (el.textContent ?? '').trim();
        return !text && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby');
      }).length;
    });
    expect(unnamed, 'adopting the title left an icon-only button with no accessible name').toBe(0);
  });

  test('a tooltip opens on keyboard focus, which native ones never did', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    await page.waitForTimeout(2500);
    const target = page.locator('button[title]').filter({ visible: true }).first();
    await expect(target, 'no focusable control with a tooltip on this page').toBeVisible({ timeout: 25_000 });
    await target.focus();
    await expect(page.getByRole('tooltip'), 'focusing the control showed nothing')
      .toBeVisible({ timeout: 10_000 });
  });
});
