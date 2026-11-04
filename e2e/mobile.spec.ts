import { test, expect, devices } from '@playwright/test';
import { signInAs, Role } from './helpers/auth';

/**
 * What actually needs checking on a phone.
 *
 * Running the DESKTOP suite at phone size was tried and is close to useless:
 * 31 of 92 failed, almost all on `nav button ... Received: hidden`, because
 * the navigation is a drawer that is closed by default. Those tests assume a
 * sidebar that is on screen; failing them on a phone measures the tests, not
 * the app, and a wall of red that means nothing is worse than no run at all.
 *
 * So this file is the phone-shaped questions instead: does the drawer work,
 * does anything spill off the side, can a finger hit the controls, and does a
 * real page still load. The desktop suite keeps its own job.
 *
 * Runs under the `iphone` project (real WebKit, phone viewport, touch).
 * It is NOT a real handset — the iOS Simulator needs a full Xcode install —
 * so this catches layout and engine problems, not hardware ones.
 */
test.use({ ...devices['iPhone 13'] });

const PAGES: [Role, string][] = [
  ['superAdmin', '/super-admin'], ['superAdmin', '/super-admin/inventory'], ['superAdmin', '/super-admin/indents'],
  ['superAdmin', '/super-admin/users'],
  // Screens changed on 27–28 Oct: column filters, archive, shipping, take-over, deep links.
  ['superAdmin', '/super-admin/approvals'], ['superAdmin', '/super-admin/database'], ['superAdmin', '/super-admin/notifications'], ['superAdmin', '/super-admin/projects'],
  ['inventory', '/inventory/components'], ['inventory', '/inventory/history'], ['inventory', '/inventory/allot'],
  ['inventory', '/inventory/dispositions'], ['inventory', '/inventory/issue-slips'],
  ['procurement', '/procurement/indents'], ['procurement', '/procurement/vendor-codes'], ['procurement', '/procurement/notifications'],
  ['manager', '/manager/team'], ['manager', '/manager/team-approvals'],
];

test.describe('on a phone', () => {
  test('the navigation drawer opens, and closes again', async ({ page }) => {
    await signInAs(page, 'superAdmin');
    // Closed by default — that is the point of a drawer at this width.
    await expect(page.locator('nav button').first()).toBeHidden();

    const opener = page.getByRole('button', { name: /menu|navigation|open/i }).first();
    await expect(opener, 'no control opens the drawer on a phone').toBeVisible({ timeout: 15_000 });
    await opener.click();
    await expect(page.locator('nav button').first()).toBeVisible({ timeout: 10_000 });

    // And it must be dismissible, or a phone user is stuck behind it.
    await page.keyboard.press('Escape');
    await expect(page.locator('nav button').first()).toBeHidden({ timeout: 10_000 });
  });

  for (const [role, path] of PAGES) {
    test(`${path} fits the screen — nothing spills off the side`, async ({ page }) => {
      await signInAs(page, role);
      await page.goto(path);
      await expect(page.getByRole('main').first()).not.toBeEmpty({ timeout: 30_000 });
      await page.waitForTimeout(400);

      const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        win: window.innerWidth,
      }));
      // A few px of rounding is normal; a real overflow is tens or hundreds.
      expect(
        overflow.doc - overflow.win,
        `${path} scrolls sideways: content is ${overflow.doc}px in a ${overflow.win}px window. ` +
        'A wide table should scroll inside its own container, not push the page.',
      ).toBeLessThanOrEqual(2);
    });
  }

  test('the primary controls are big enough to hit with a thumb', async ({ page }) => {
    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/inventory');
    await expect(page.getByRole('main').first()).not.toBeEmpty({ timeout: 30_000 });

    // 44x44 CSS px is Apple's own guidance, and the number most design
    // systems settled on. Checked on what is actually visible rather than
    // every control in the DOM.
    const tooSmall = await page.evaluate(() => {
      const bad: string[] = [];
      document.querySelectorAll('main button, main a[href]').forEach((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;            // hidden
        // A control may grow its tap area with a transparent ::after that
        // takes no layout space, so the element's own box understates it.
        // Measure what a finger would actually land on.
        const after = getComputedStyle(el, '::after');
        const grow = (v: string) => (v && v.endsWith('px') ? Math.abs(parseFloat(v)) : 0);
        const pad = after.content !== 'none'
          ? Math.min(grow(after.top), grow(after.left), grow(after.right), grow(after.bottom))
          : 0;
        if (r.height + pad * 2 < 28 || r.width + pad * 2 < 28) {
          bad.push(`${el.tagName.toLowerCase()}[${(el as HTMLElement).innerText.trim().slice(0, 20) ||
            el.getAttribute('aria-label') || '?'}] ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      });
      return bad.slice(0, 8);
    });
    // 28px rather than 44: this asserts "reachable", not "ideal", so it fails
    // on genuinely tiny targets without bikeshedding every icon button.
    expect(tooSmall, 'controls too small to tap reliably').toEqual([]);
  });
});
