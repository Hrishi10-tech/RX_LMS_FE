import { test, expect } from '@playwright/test';
import { signInAs } from './helpers/auth';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Toasts are readable, dismissable, and stay up long enough to read.
 *
 * The long ones used to arrive as a single block of equal-weight text with a
 * forty-character filename in the middle of it, so nothing told you at a
 * glance what had happened. They also cleared in four seconds, which is
 * enough to notice one and not enough to read one.
 */
/**
 * The toast this test means — NOT the first `[role="status"]` on the page,
 * and NOT merely the oldest toast on screen.
 *
 * Two things made the bare `[role="status"]` locator pick the wrong element.
 * DataTable renders `<span role="status" class="sr-only">Loading table
 * data</span>` while it fetches, and toasts STACK: taking a JSON backup
 * raises "JSON backup created successfully!", which is still up when the
 * upload toast arrives beside it. `.first()` matched that one, found a short
 * span (which satisfied the headline check) and then no `<p>`, so the test
 * reported the detail had not been split out when the upload toast was fine.
 * Scope to the live region, and say which toast is meant.
 */
const toastLocator = (page: import('@playwright/test').Page, hasText?: RegExp) => {
  const toasts = page.locator('[aria-live="polite"]').locator('[role="status"], [role="alert"]');
  return (hasText ? toasts.filter({ hasText }) : toasts).first();
};

test.describe('toasts', () => {
  test('a long message is split into a headline and its detail', async ({ page }) => {
    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/database');
    await expect(page.getByRole('button', { name: /JSON Backup/ })).toBeVisible({ timeout: 25_000 });

    // The upload path produces the longest toast in the app: a filename, a
    // row count and an instruction. Feed it a real snapshot.
    //
    // Take one here rather than reaching for whatever happens to be lying in
    // /app/backups. The old version picked the LARGEST existing file, which
    // made the test depend on ambient server state: it failed on a fresh
    // machine, and it failed the moment someone cleared the snapshots to
    // reclaim disk — 364 MB of them had accumulated. A test that needs a
    // snapshot should make one.
    const listSnapshots = () => execFileSync(
      'docker', ['exec', 'lms-ui-backend', 'sh', '-c', 'ls -1 /app/backups 2>/dev/null || true'],
      { encoding: 'utf8' },
    ).split('\n').filter((f) => /^db_backup_.*\.json$/.test(f.trim())).map((f) => f.trim());

    const before = new Set(listSnapshots());
    await page.getByRole('button', { name: /^JSON Backup$/ }).click();
    await expect
      .poll(() => listSnapshots().filter((f) => !before.has(f)).length,
            { message: 'no new snapshot was written to the server', timeout: 90_000 })
      .toBe(1);
    const snapshot = '/app/backups/' + listSnapshots().find((f) => !before.has(f))!;
    const body = execFileSync('docker', ['exec', 'lms-ui-backend', 'cat', snapshot],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const local = join('/tmp', 'e2e-toast-snapshot.json');
    writeFileSync(local, body);

    await page.locator('input[type="file"]').first().setInputFiles(local);

    // By text: the backup toast raised above is still on screen next to it.
    const toast = toastLocator(page, /rows across/);
    await expect(toast, 'no upload toast appeared').toBeVisible({ timeout: 90_000 });

    // A headline in its own right, and the particulars under it — not one
    // run-on paragraph.
    const headline = toast.locator('span').first();
    await expect(headline).toBeVisible();
    const headlineText = (await headline.innerText()).trim();
    expect(headlineText.length,
      `the headline is ${headlineText.length} characters — it is still the whole message`)
      .toBeLessThan(62);
    // Detail AND filename are now separate lines under the headline — there
    // are two <p>s, so this must say which it means.
    await expect(toast.locator('p').first(),
      'the detail was not split onto its own line').toBeVisible();

    // The filename gets a line of its own. Inline it ran to forty characters
    // mid-sentence, wrapped across two lines, and was set in the same
    // proportional face as the prose around it.
    const lines = (await toast.innerText()).split('\n').map((l) => l.trim()).filter(Boolean);
    const fileLine = lines.find((l) => /^[\w.\-:]+\.json$/.test(l));
    expect(fileLine, `no line is just the filename; got:\n${lines.join('\n')}`).toBeTruthy();
    const stillInline = lines.filter((l) => l !== fileLine && l.includes('.json'));
    expect(stillInline, `the filename is still inside: ${stillInline.join(' | ')}`).toHaveLength(0);

    // And lifting it must not leave the sentence pointing at nothing — the
    // first attempt produced "…across 51 tables, saved as. Restore it…".
    const detail = lines.find((l) => /rows across/.test(l)) ?? '';
    expect(detail, `the connector was left dangling: "${detail}"`)
      .not.toMatch(/\b(as|to|from|at|in)\s*[.,]/);
  });

  test('a toast can be dismissed, and stays up long enough to read', async ({ page }) => {
    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/database');
    await page.getByRole('button', { name: /JSON Backup/ }).click();

    const toast = toastLocator(page);
    await expect(toast).toBeVisible({ timeout: 60_000 });

    // Still up well past the old seven-second success lifetime. These carry
    // row counts, filenames and what to do next; the ✕ is right there, so
    // outstaying a welcome costs a click and clearing early costs the content.
    await page.waitForTimeout(10_000);
    await expect(toast, 'the toast cleared before it could be read').toBeVisible();

    const close = toast.getByRole('button', { name: /Dismiss/i });
    await expect(close, 'there is no visible way to close a toast').toBeVisible();
    const box = (await close.boundingBox())!;
    expect(Math.min(box.width, box.height),
      'the close target is too small to hit comfortably').toBeGreaterThanOrEqual(24);

    await close.click();
    await expect(toast, 'clicking the cross did not dismiss the toast').toHaveCount(0, { timeout: 10_000 });
  });
});
