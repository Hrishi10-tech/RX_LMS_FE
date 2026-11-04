import { test, expect, Page } from '@playwright/test';
import { ACCOUNTS, signInAs } from './helpers/auth';
import { lit, sql, sqlValue } from './helpers/db';

/**
 * The progress bar must not contradict the timeline printed under it.
 *
 * Both are rendered in the same modal from different sources: the bar from
 * the indent's CURRENT status, the timeline from its recorded history. When
 * an indent moves backwards they disagree, and the bar is the one that lies.
 *
 * Production, IND-067: raised 7 Oct, approved 13 Oct and handed to
 * procurement, quoted 14 Oct at ₹1,182, then returned for approval at the
 * firm price — which resets the status to PENDING and clears the signatures.
 * The bar read "Submitted", step 1 of 7, directly above a timeline listing
 * the approval and the quote.
 *
 * No spec caught it because every indent spec walks the pipeline FORWARDS and
 * the fixtures held no indent that had come back. This one creates that state
 * on purpose, so the case exists in the suite from now on.
 */

const tag = () => `E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Ids are recorded the instant the row exists, not returned at the end.
 *
 * The first run of this spec threw partway through the helper — a wrong
 * column name on IndentStatusLog — so the caller never received an id and
 * teardown had nothing to delete, leaving an orphan indent and quotation
 * behind. The row-count guard did not notice, because by the next run those
 * rows were already there when the fingerprint was taken.
 */
const created: string[] = [];

/** An indent that has been approved, quoted, and then sent back to PENDING. */
const makeReQuotedIndent = (departmentId: string, createdById: string) => {
  const serialNo = tag();
  const id = sqlValue(
    `INSERT INTO "Indent" (id, "serialNo", "grandTotal", currency, status, "departmentId", "createdById", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(serialNo)}, 1182, 'INR', 'PENDING', ${lit(departmentId)}, ${lit(createdById)}, now(), now())
     RETURNING id`,
  );
  created.push(id!);
  sql(
    `INSERT INTO "IndentItem" (id, "indentId", name, qty, "unitAmount", currency, unit, url, purpose, total, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(id!)}, 'E2E re-quoted part', 2, 591, 'INR', 'PCS', '', 'Tracker truth check', 1182, now(), now())`,
  );
  // The quotation is what makes this a RE-approval rather than a fresh one.
  sql(
    `INSERT INTO "Quotation" (id, "indentId", version, status, "grandTotal", "submittedAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(id!)}, 1, 'SUBMITTED', 1182, now(), now())`,
  );
  // History saying it got as far as quoting, which is what the timeline reads.
  for (const [fromStatus, toStatus, notes] of [
    [null, 'PENDING', 'Indent raised'],
    ['PENDING', 'QUOTATION_IN_PROGRESS', 'Approved — handed to Procurement for quotation'],
    ['QUOTATION_IN_PROGRESS', 'PENDING', 'Quotation finalised at INR 1,182 — approval required at the firm price'],
  ] as const) {
    sql(
      `INSERT INTO "IndentStatusLog" (id, "indentId", "fromStatus", "toStatus", notes, "changedById", "createdAt")
       VALUES (gen_random_uuid(), ${lit(id!)}, ${fromStatus ? lit(fromStatus) : 'NULL'}, ${lit(toStatus)}, ${lit(notes)}, ${lit(createdById)}, now())`,
    );
  }
  return { id: id!, serialNo };
};

const dropIndent = (id: string) => {
  sql(`DELETE FROM "IndentStatusLog" WHERE "indentId" = ${lit(id)}`);
  sql(`DELETE FROM "Quotation" WHERE "indentId" = ${lit(id)}`);
  sql(`DELETE FROM "IndentItem" WHERE "indentId" = ${lit(id)}`);
  sql(`DELETE FROM "Indent" WHERE id = ${lit(id)}`);
};

/** Each bubble as 'done' | 'current' | 'todo', in pipeline order. */
const readBar = async (page: Page) =>
  page.evaluate(() => {
    const labels = ['Submitted', 'Approved', 'Quoting', 'Payment', 'Ordered', 'Shipped', 'Received'];
    return labels.map((label) => {
      const caption = [...document.querySelectorAll('span')].find((s) => s.textContent?.trim() === label);
      const bubble = caption?.parentElement?.firstElementChild as HTMLElement | undefined;
      if (!bubble) return 'missing';
      if (bubble.textContent?.trim() === '✓') return 'done';
      return bubble.className.includes('ring-2') ? 'current' : 'todo';
    });
  });

test.describe('indent tracker tells the same story as its timeline', () => {
  let made: { id: string; serialNo: string } | null = null;

  // Everything this file made, whether or not the helper finished.
  test.afterAll(() => { for (const id of created.splice(0)) dropIndent(id); });

  test('an indent returned for approval at the firm price is not shown back at step 1', async ({ page }) => {
    const deptId = sqlValue(
      `SELECT u."departmentId" FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}`,
    )!;
    const userId = sqlValue(`SELECT id FROM "User" WHERE email = ${lit(ACCOUNTS.user)}`)!;
    made = makeReQuotedIndent(deptId, userId);

    await signInAs(page, 'user');
    await page.goto('/user/ip-requests');

    const row = page.locator('tr').filter({ hasText: made.serialNo }).first();
    await expect(row, `${made.serialNo} is not in My Indents`).toBeVisible({ timeout: 25_000 });
    // TooltipLayer adopts `title` into aria-label on icon-only controls, so
    // match either rather than guessing which one this build renders.
    await row.locator('button[title="View timeline"], button[aria-label="View timeline"]')
      .first().click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByText('Submitted')).toBeVisible();

    const bar = await readBar(page);

    // THE BUG: step 1 current and everything after it untouched, under a
    // timeline that records the approval and the quote.
    expect(bar[0], 'Submitted is not marked done, so the bar denies the indent was ever raised')
      .toBe('done');
    expect(bar[2], 'Quoting reads not-yet-reached though the indent has a quotation')
      .not.toBe('todo');
    expect(bar[1], 'the indent is waiting on approval, so Approved is where it sits')
      .toBe('current');

    // The general rule, not just this case: done steps form an unbroken run
    // from the start. A gap means the bar is describing an impossible history.
    const lastDone = bar.lastIndexOf('done');
    for (let i = 0; i < lastDone; i++) {
      expect(bar[i], `step ${i + 1} is '${bar[i]}' but a later step is done`).not.toBe('todo');
    }
  });
});
