import { test, expect } from '@playwright/test';
import { signInAs } from './helpers/auth';

/**
 * List state lives in the URL, and Back closes a modal.
 *
 * All three were found by audit: a filtered list could not be shared or
 * survive a reload, a page number reset to 1 on refresh, and browser Back
 * walked off the page with a half-filled form rather than closing the panel
 * on top of it.
 */
test.describe('list state and navigation', () => {
  test('a search survives a reload and can be shared', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    await page.getByPlaceholder(/Search components/i).first().fill('resistor');
    await expect.poll(() => page.url(), { message: 'the search never reached the URL', timeout: 15_000 })
      .toMatch(/q=resistor/);

    // The real test of "shareable": open that URL cold and find the box filled.
    const shared = page.url();
    await page.goto('/inventory');
    await page.goto(shared);
    await expect(page.getByPlaceholder(/Search components/i).first(),
      'a shared link did not restore the search').toHaveValue('resistor', { timeout: 20_000 });
  });

  test('a page number survives a reload', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    // The control is Previous/Next, not numbered pages.
    const next = page.getByRole('button', { name: /^Next$/ }).first();
    await expect(next, 'there is no pagination on this list to test').toBeVisible({ timeout: 20_000 });
    await next.click();
    await expect.poll(() => page.url(), { message: 'the page number never reached the URL', timeout: 15_000 })
      .toMatch(/page=2/);

    await page.reload();
    await expect.poll(() => page.url(), { message: 'the page number was dropped on reload', timeout: 20_000 })
      .toMatch(/page=2/);
  });

  test('browser Back closes an open modal instead of leaving the page', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    const before = page.url();

    await page.getByRole('button', { name: /Add Component/ }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 });

    await page.goBack();
    await expect(page.getByRole('dialog'), 'Back did not close the modal').toHaveCount(0, { timeout: 15_000 });
    expect(page.url(), 'Back left the page instead of closing the modal').toBe(before);
  });

  test('Back will not discard a form that has been filled in', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');

    await page.getByRole('button', { name: /Add Component/ }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.locator('input[type="text"]').first().fill('half-typed component');

    await page.goBack();
    // Same rule Escape follows: once there is work in the panel, only an
    // explicit ✕ or Cancel throws it away.
    await expect(dialog, 'Back discarded a form with content in it').toBeVisible({ timeout: 10_000 });
    await expect(dialog.locator('input[type="text"]').first()).toHaveValue('half-typed component');
  });
});
