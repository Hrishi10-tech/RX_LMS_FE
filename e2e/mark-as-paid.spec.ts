import { test, expect } from '@playwright/test';
import { ACCOUNTS, signInAs } from './helpers/auth';
import {
  createIndentFixture,
  dropFixtures,
  userFixtureIds,
  deleteUploadedFixtures,
  countUploadedFixtures,
  sql,
  lit,
} from './helpers/db';

/**
 * Finance marks an indent paid.
 *
 * This is the flow that could not be tested by hand: settling a payment is
 * irreversible through the UI, and `DELETE /indents/:id` is refused once an
 * indent leaves PENDING/APPROVED, so there is no API route back either. Hence
 * snapshot -> mutate -> restore, with both ends in SQL.
 *
 * The precondition is also created rather than looked for: the sandbox
 * snapshot has no AWAITING_PAYMENT indents at rest, and a test that only runs
 * when the data happens to suit it is a test that quietly stops running.
 */
/** Fixture filename, so teardown can find and delete the upload again. */
const RECEIPT_NAME = 'e2e-receipt.pdf';

test.describe('money path: mark as paid', () => {
  // Its own indent, already waiting for payment. It used to borrow one —
  // "the first indent near payment" — rewrite its payment columns, and put
  // them back afterwards across FOUR separate trails (the row, the approval
  // history, the status log, the notifications, plus the receipt row), each
  // added after a run was caught leaving it behind. It also depended on the
  // sandbox holding a suitable indent, which it often did not.
  //
  // A fixture removes all of that: it is deleted, and the status log and
  // receipt rows cascade with it. Only the uploaded receipt FILE lives on
  // disk and needs removing separately.
  let snap: { id: string; serialNo: string };

  test.beforeAll(() => {
    const owner = userFixtureIds(ACCOUNTS.user);
    snap = createIndentFixture({
      createdById: owner.id,
      departmentId: owner.departmentId,
      status: 'AWAITING_PAYMENT',
    });
  });

  test.afterAll(() => {
    deleteUploadedFixtures(RECEIPT_NAME);
    dropFixtures();
  });

  test('an awaiting-payment indent can be settled, and it lands in the database', async ({ page }) => {
    await signInAs(page, 'finance');
    await page.goto('/finance/indents');

    // The indent should now be in the "Awaiting Payment" band.
    const row = page.locator('tr', { hasText: snap.serialNo }).first();
    await expect(row, `${snap.serialNo} is not on the payments screen`).toBeVisible();

    const markPaid = row.getByRole('button', { name: /mark as paid/i });
    await expect(markPaid).toBeVisible();
    await markPaid.click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    const submit = dialog.getByRole('button', { name: /^mark as paid$/i });

    // The transaction ID is MANDATORY — the server refuses a payment without
    // one, so the dialog must not offer to submit until it is filled.
    await expect(submit, 'Mark as Paid was clickable with no transaction ID').toBeDisabled();
    const txnId = `E2E-${Date.now().toString().slice(-8)}`;
    await dialog.locator('input[type="text"]').first().fill(txnId);
    // The receipt is optional: the transaction ID alone is enough to submit.
    await expect(submit, 'submit stayed disabled with a transaction ID and no receipt').toBeEnabled();

    // Attached anyway, so the stored-receipt path below is still exercised.
    await dialog.locator('input[type="file"]').setInputFiles({
      name: RECEIPT_NAME,
      mimeType: 'application/pdf',
      // Smallest thing the accept="application/pdf,image/*" filter will take.
      buffer: Buffer.from('%PDF-1.4\n% e2e payment receipt fixture\n'),
    });
    await submit.click();

    // UI settles: the dialog closes and the row stops offering to be paid.
    await expect(dialog).toBeHidden();
    await expect(row.getByRole('button', { name: /mark as paid/i })).toHaveCount(0);

    // The assertion that actually matters — it reached Postgres, rather than
    // only updating the React Query cache.
    await expect
      .poll(() => sql(`SELECT status FROM "Indent" WHERE id = ${lit(snap.id)}`)[0]?.[0], {
        message: 'indent status never became PAYMENT_DONE in the database',
        timeout: 15_000,
      })
      .toBe('PAYMENT_DONE');

    const [[paidAt, storedTxn, paidById]] = sql(
      `SELECT "paidAt"::text, coalesce("paymentTransactionId",''), coalesce("paidById",'')
       FROM "Indent" WHERE id = ${lit(snap.id)}`,
    );
    expect(paidAt, 'paidAt was not stamped').not.toBe('');
    expect(storedTxn, 'the transaction reference was not persisted').toBe(txnId);
    expect(paidById, 'paidById was not recorded').not.toBe('');

    // The upload is a real file, not just a column — check it exists, since
    // teardown has to know to delete it.
    expect(
      countUploadedFixtures(RECEIPT_NAME),
      'the receipt was not written to the uploads volume',
    ).toBeGreaterThan(0);
  });

  test('the settled indent moves out of the awaiting-payment queue', async ({ page }) => {
    // Runs after the test above (workers: 1, fullyParallel: false), so the
    // indent is PAYMENT_DONE here. Asserting the *consequence* rather than
    // re-doing the action: a paid indent must not still be actionable.
    await signInAs(page, 'finance');
    await page.goto('/finance/indents');

    const awaitingBand = page.getByText(/awaiting payment/i).first();
    await expect(awaitingBand).toBeVisible();

    const row = page.locator('tr', { hasText: snap.serialNo }).first();
    if (await row.count()) {
      await expect(
        row.getByRole('button', { name: /mark as paid/i }),
        'a paid indent is still offering "Mark as Paid"',
      ).toHaveCount(0);
    }
  });
});
