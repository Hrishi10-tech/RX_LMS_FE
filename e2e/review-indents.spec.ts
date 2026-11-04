import { test, expect, APIRequestContext } from '@playwright/test';
import { ACCOUNTS, signInAs } from './helpers/auth';
import { sql, sqlValue, lit, createIndentFixture, dropFixtures, userFixtureIds } from './helpers/db';

/**
 * Review findings on per-vendor shipping (28 Oct), one check each, against the
 * running sandbox API. The owner's rules (27 Oct): shipping is typed as the
 * vendor charges it, added after GST and never taxed, counts in the indent
 * total and so in the CEO check, and is charged ONCE per vendor however the
 * lines are paid or sent.
 *
 * Fixtures are indents made by createIndentFixture; everything they gather —
 * quotations, allocations, vendor orders, status logs — cascades off the
 * indent, and dropFixtures removes the notifications and approval history
 * that point at it without a foreign key.
 */

const API = 'http://localhost:3001/api';

const tokenFor = async (request: APIRequestContext, email: string) => {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: 'password123' } });
  expect(res.ok(), `could not sign in as ${email}`).toBeTruthy();
  const body = await res.json();
  return (body.accessToken ?? body.data?.accessToken) as string;
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const data = async (res: any) => { const j = await res.json().catch(() => ({})); return j.data ?? j; };

/** An approved indent with two lines: L1 (1 × 1000) and L2 (1 × 500). */
const twoLineIndent = (status = 'APPROVED') => {
  const owner = userFixtureIds(ACCOUNTS.user);
  const ind = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status, grandTotal: 1000 });
  const l1 = sqlValue(`SELECT id FROM "IndentItem" WHERE "indentId" = ${lit(ind.id)}`)!;
  const l2 = sqlValue(
    `INSERT INTO "IndentItem" (id, "indentId", name, qty, unit, "unitAmount", currency, url, purpose, total, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(ind.id)}, 'E2E second part', 1, 'NOS', 500, 'INR', '', 'e2e fixture', 500, now(), now())
     RETURNING id`,
  )!;
  return { ...ind, l1, l2 };
};

/** Lines L1 + L2 from one vendor: 18% GST and ₹150 shipping on the vendor. Total 1500 + 270 + 150 = 1920. */
const oneVendorRows = (l1: string, l2: string, vendorName: string) => [
  { indentItemId: l1, vendorName, allocatedQty: 1, unitPrice: 1000, currency: 'INR', gstPercentage: 18, shippingCost: 150 },
  { indentItemId: l2, vendorName, allocatedQty: 1, unitPrice: 500, currency: 'INR', gstPercentage: 18, shippingCost: 150 },
];

const saveAllocations = async (request: APIRequestContext, token: string, indentId: string, allocations: any[]) => {
  const res = await request.post(`${API}/indents/${indentId}/allocations`, { headers: auth(token), data: { allocations } });
  expect(res.status(), await res.text()).toBe(201);
};

const grandTotalOf = (indentId: string) => Number(sqlValue(`SELECT "grandTotal" FROM "Indent" WHERE id = ${lit(indentId)}`));
const activeQuotationOf = (indentId: string) =>
  sqlValue(`SELECT id FROM "Quotation" WHERE "indentId" = ${lit(indentId)} AND status IN ('DRAFT', 'SUBMITTED') ORDER BY version DESC LIMIT 1`)!;

test.describe('review: indents, quotations, approvals (28 Oct)', () => {
  test.afterEach(() => { dropFixtures(); });

  test('a re-quote keeps a vendor option as an option — out of the total and the qty check', async ({ request }) => {
    const ind = twoLineIndent();
    const proc = await tokenFor(request, ACCOUNTS.procurement);
    await saveAllocations(request, proc, ind.id, [
      { indentItemId: ind.l1, vendorName: 'E2E RQ Main', allocatedQty: 1, unitPrice: 1000, currency: 'INR', gstPercentage: 18, shippingCost: 150 },
      // Quoted for the same line as an ALTERNATIVE, with its own price and shipping.
      { indentItemId: ind.l1, vendorName: 'E2E RQ Option', allocatedQty: 1, unitPrice: 900, currency: 'INR', gstPercentage: 18, shippingCost: 400, isAlternative: true },
    ]);
    expect(grandTotalOf(ind.id)).toBe(1330); // 1000 + 180 + 150; the option is not in it

    const sa = await tokenFor(request, ACCOUNTS.superAdmin);
    const rej = await request.post(`${API}/quotations/${activeQuotationOf(ind.id)}/reject`, { headers: auth(sa), data: { reason: 'e2e: re-quote please' } });
    expect(rej.status(), await rej.text()).toBe(201);

    // The new draft carries the option AS an option, with its money.
    const copied = sql(
      `SELECT va."vendorName", va."isAlternative"::text, va."isDiscarded"::text, va."shippingCost"::float8, va."gstPercentage"::float8
         FROM "VendorAllocation" va JOIN "Quotation" q ON q.id = va."quotationId"
        WHERE va."indentId" = ${lit(ind.id)} AND q.status = 'DRAFT' ORDER BY va."vendorName"`,
    );
    expect(copied).toEqual([
      ['E2E RQ Main', 'false', 'false', '150', '18'],
      ['E2E RQ Option', 'true', 'false', '400', '18'],
    ]);

    // Procurement opens the re-quote and saves what loaded, unchanged — what the
    // quote panel does. With the option turned committed this was 2 units on a
    // 1-unit line (refused), or the option's 900 + 400 in the total.
    const loaded = await data(await request.get(`${API}/indents/${ind.id}/allocations`, { headers: auth(proc) }));
    const back = (loaded.allocations as any[]).map((a) => ({
      indentItemId: a.indentItemId, vendorName: a.vendorName, allocatedQty: Number(a.allocatedQty), unitPrice: Number(a.unitPrice),
      currency: a.currency, gstPercentage: a.gstPercentage == null ? undefined : Number(a.gstPercentage),
      shippingCost: a.shippingCost == null ? undefined : Number(a.shippingCost), isAlternative: a.isAlternative === true,
    }));
    await saveAllocations(request, proc, ind.id, back);
    expect(grandTotalOf(ind.id)).toBe(1330);
  });

  test('on screen: the approver sees the total incl. GST & shipping, with shipping shown once per vendor', async ({ page, request }) => {
    const ind = twoLineIndent();
    const vendor = 'E2E Review Vendor';
    const proc = await tokenFor(request, ACCOUNTS.procurement);
    await saveAllocations(request, proc, ind.id, oneVendorRows(ind.l1, ind.l2, vendor));
    expect(grandTotalOf(ind.id)).toBe(1920);

    // Back for approval at the firm price — the state the review modal is for.
    sql(`UPDATE "Quotation" SET status = 'SUBMITTED' WHERE id = ${lit(activeQuotationOf(ind.id))}`);
    sql(`UPDATE "Indent" SET status = 'PENDING', "techApprovalStatus" = 'PENDING', "techApprovedAt" = NULL, "techApprovedAtAmount" = NULL WHERE id = ${lit(ind.id)}`);

    await signInAs(page, 'superAdmin');
    await page.goto(`/super-admin/approvals?openIndent=${ind.id}`);
    const review = page.getByRole('dialog', { name: new RegExp(`Indent ${ind.serialNo}`) });
    await expect(review).toBeVisible({ timeout: 20_000 });
    const totalRow = review.getByText('Firm quote total').locator('..');
    // The number the backend stored and the CEO check reads — not qty × price (1,500).
    await expect(totalRow).toContainText(/INR\s*1,920/);
    await expect(totalRow).toContainText('incl. GST & shipping');
    // Shipping is shown on the vendor's first line only; the second points back.
    await expect(review.getByText('₹150', { exact: true })).toHaveCount(1);
    await expect(review.getByText('once, above', { exact: true })).toHaveCount(1);
  });

  test('on screen: Send to Finance shows each vendor incl. GST & shipping', async ({ page, request }) => {
    const ind = twoLineIndent();
    const vendor = 'E2E Send Vendor';
    const proc = await tokenFor(request, ACCOUNTS.procurement);
    await saveAllocations(request, proc, ind.id, oneVendorRows(ind.l1, ind.l2, vendor));
    // Firm quote approved — ready to hand over.
    sql(`UPDATE "Indent" SET status = 'READY_FOR_PAYMENT', "techApprovalStatus" = 'APPROVED', "techApprovedAt" = now(), "techApprovedAtAmount" = 1920 WHERE id = ${lit(ind.id)}`);

    await signInAs(page, 'procurement');
    await page.goto('/procurement/indents');
    const row = page.locator('tr').filter({ hasText: ind.serialNo }).first();
    await expect(row).toBeVisible({ timeout: 25_000 });
    await row.getByRole('button', { name: /Send to Finance/ }).click();
    const send = page.getByRole('dialog', { name: new RegExp(`Send ${ind.serialNo} to Finance`) });
    await expect(send).toBeVisible({ timeout: 20_000 });
    await expect(send.getByText(/INR 1,920/).first()).toBeVisible();
    await expect(send.getByText('incl. GST & shipping').first()).toBeVisible();
    await expect(send.getByText(/INR 1,500/)).toHaveCount(0);
    // Look only — nothing is sent.
    await send.getByRole('button', { name: 'Cancel' }).click();
    expect(Number(sqlValue(`SELECT count(*) FROM "VendorOrder" WHERE "indentId" = ${lit(ind.id)}`))).toBe(0);
  });

  test('a full re-send after a re-quote never charges a line or the shipping twice', async ({ request }) => {
    const ind = twoLineIndent();
    const vendor = 'E2E Resend Vendor';
    const proc = await tokenFor(request, ACCOUNTS.procurement);
    const sa = await tokenFor(request, ACCOUNTS.superAdmin);
    await saveAllocations(request, proc, ind.id, oneVendorRows(ind.l1, ind.l2, vendor));
    sql(`UPDATE "Indent" SET status = 'READY_FOR_PAYMENT', "techApprovalStatus" = 'APPROVED', "techApprovedAtAmount" = 1920 WHERE id = ${lit(ind.id)}`);
    const allocId = (itemId: string) =>
      sqlValue(`SELECT id FROM "VendorAllocation" WHERE "indentId" = ${lit(ind.id)} AND "indentItemId" = ${lit(itemId)}`)!;
    const pay = { vendors: [{ vendorName: vendor, currency: 'INR', paymentMethod: 'ONLINE' }] };
    const markPaid = () => sql(
      `UPDATE "VendorOrder" SET status = 'PAID', "paidAt" = now(), "paymentTransactionId" = 'E2E-TXN'
        WHERE "indentId" = ${lit(ind.id)} AND status = 'AWAITING_PAYMENT'`,
    );

    // Two partial sends, each paid before the next: order A (L1 + the shipping), order B (L2).
    const first = await request.post(`${API}/indents/${ind.id}/send-to-finance`, { headers: auth(proc), data: { ...pay, allocationIds: [allocId(ind.l1)] } });
    expect(first.status(), await first.text()).toBe(201);
    markPaid();
    const second = await request.post(`${API}/indents/${ind.id}/send-to-finance`, { headers: auth(proc), data: { ...pay, allocationIds: [allocId(ind.l2)] } });
    expect(second.status(), await second.text()).toBe(201);
    markPaid();
    const before = sql(`SELECT amount::float8, "shippingAmount"::float8 FROM "VendorOrder" WHERE "indentId" = ${lit(ind.id)} ORDER BY "createdAt"`);
    expect(before).toEqual([['1330', '150'], ['590', '0']]);

    // Re-quote, the same plan saved again, re-approved — then a FULL send.
    const rej = await request.post(`${API}/quotations/${activeQuotationOf(ind.id)}/reject`, { headers: auth(sa), data: { reason: 'e2e: re-quote' } });
    expect(rej.status(), await rej.text()).toBe(201);
    await saveAllocations(request, proc, ind.id, oneVendorRows(ind.l1, ind.l2, vendor));
    sql(`UPDATE "Indent" SET status = 'READY_FOR_PAYMENT', "techApprovalStatus" = 'APPROVED', "techApprovedAt" = now(), "techApprovedAtAmount" = 1920 WHERE id = ${lit(ind.id)}`);
    const full = await request.post(`${API}/indents/${ind.id}/send-to-finance`, { headers: auth(proc), data: pay });
    expect(full.status(), await full.text()).toBe(201);

    const orders = sql(
      `SELECT status::text, amount::float8, "shippingAmount"::float8, "refundStatus"::text, coalesce("refundExpectedAmount", 0)::float8
         FROM "VendorOrder" WHERE "indentId" = ${lit(ind.id)} ORDER BY "createdAt"`,
    );
    // BOTH paid orders retired with their full amount on a refund — not just the last one.
    expect(orders.slice(0, 2)).toEqual([
      ['CANCELLED', '1330', '150', 'PENDING', '1330'],
      ['CANCELLED', '590', '0', 'PENDING', '590'],
    ]);
    // One live order for the vendor: L1 + L2 + GST + shipping, once.
    const live = orders.filter((o) => o[0] !== 'CANCELLED');
    expect(live).toEqual([['AWAITING_PAYMENT', '1920', '150', 'NONE', '0']]);
  });

  test('on screen: an option-only vendor takes GST & shipping, and they count once the admin picks it', async ({ page, request }) => {
    const ind = twoLineIndent();
    const main = 'E2E Opt Main';
    const opt = 'E2E Opt Only';
    const proc = await tokenFor(request, ACCOUNTS.procurement);
    await saveAllocations(request, proc, ind.id, [
      { indentItemId: ind.l1, vendorName: main, allocatedQty: 1, unitPrice: 1000, currency: 'INR', gstPercentage: 18, shippingCost: 150 },
      { indentItemId: ind.l2, vendorName: main, allocatedQty: 1, unitPrice: 500, currency: 'INR', gstPercentage: 18, shippingCost: 150 },
      // Quoted ONLY as an option, with no GST or shipping entered yet.
      { indentItemId: ind.l1, vendorName: opt, allocatedQty: 1, unitPrice: 900, currency: 'INR', isAlternative: true },
    ]);
    expect(grandTotalOf(ind.id)).toBe(1920);

    await signInAs(page, 'procurement');
    await page.goto('/procurement/indents');
    const row = page.locator('tr').filter({ hasText: ind.serialNo }).first();
    await expect(row).toBeVisible({ timeout: 25_000 });
    await row.getByRole('button', { name: /^(Quote|Requote)$/ }).click();
    const gst = page.getByLabel(`GST % for ${opt}`);
    await expect(gst).toBeVisible({ timeout: 20_000 });
    await gst.fill('18');
    await gst.press('Tab');
    const ship = page.getByLabel(`Shipping for ${opt}`);
    await ship.fill('400');
    await ship.press('Tab');
    await page.getByRole('button', { name: 'Save Allocations' }).click();
    // No ETA on the lines → the soft "save anyway?" check, every time.
    await page.getByRole('dialog').last().getByRole('button', { name: 'Save anyway' }).click();
    await expect(page.getByText('Vendor allocations saved')).toBeVisible({ timeout: 15_000 });

    // Saved on the option's row; the committed total is unchanged.
    const optRow = sql(`SELECT id, "gstPercentage"::float8, "shippingCost"::float8 FROM "VendorAllocation" WHERE "indentId" = ${lit(ind.id)} AND "vendorName" = ${lit(opt)}`);
    expect(optRow.map((r) => [r[1], r[2]])).toEqual([['18', '400']]);
    expect(grandTotalOf(ind.id)).toBe(1920);

    // The admin picks the option for L1. Its 900 + 162 GST + 400 shipping now count, with Main's L2 (500 + 90 + 150).
    const sa = await tokenFor(request, ACCOUNTS.superAdmin);
    const picked = await request.post(`${API}/indents/${ind.id}/select-vendors`, {
      headers: auth(sa), data: { selections: [{ indentItemId: ind.l1, picks: [{ allocationId: optRow[0][0], qty: 1 }] }] },
    });
    expect(picked.status(), await picked.text()).toBe(201);
    expect(grandTotalOf(ind.id)).toBe(900 + 162 + 400 + 500 + 90 + 150);
  });
});
