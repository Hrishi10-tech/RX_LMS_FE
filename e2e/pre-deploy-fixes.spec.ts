import { test, expect, APIRequestContext } from '@playwright/test';
import { ACCOUNTS, signInAs } from './helpers/auth';
import { execFileSync } from 'node:child_process';
import { sql, sqlValue, lit, createIndentFixture, createInventoryItemFixture, createIssuedRequestFixture, createOpenRequestFixture, dropFixtures, fixtureTag, userFixtureIds } from './helpers/db';

/**
 * The 23 October pre-deploy fixes, one check each, against the running API.
 * Every one of these was found by the full test sweep (TEST-REPORT-2026-10-23.md,
 * Group 1) and each test was seen to fail with the fix taken out.
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

/** Status-log and notification rows the fixtures' indents picked up, removed before dropFixtures. */
const indentIds: string[] = [];
const dropIndentChildren = () => {
  const ids = indentIds.splice(0);
  if (!ids.length) return;
  const list = ids.map(lit).join(', ');
  sql(`DELETE FROM "CustomsDutyPayment" WHERE "indentId" IN (${list})`);
  sql(`DELETE FROM "VendorAllocation" WHERE "indentId" IN (${list})`);
  sql(`DELETE FROM "InventoryEvent" WHERE "indentId" IN (${list})`);
  sql(`DELETE FROM "VendorOrder" WHERE "indentId" IN (${list})`);
  sql(`DELETE FROM "QuotationItem" WHERE "quotationId" IN (SELECT id FROM "Quotation" WHERE "indentId" IN (${list}))`);
  sql(`DELETE FROM "Quotation" WHERE "indentId" IN (${list})`);
  sql(`DELETE FROM "IndentStatusLog" WHERE "indentId" IN (${list})`);
  sql(`DELETE FROM "Notification" WHERE "relatedEntityId" IN (${list})`);
};


/** An indent split across vendors with one vendor already paid — money has gone out. */
const indentWithPaidVendor = () => {
  const owner = userFixtureIds(ACCOUNTS.user);
  const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'AWAITING_PAYMENT' });
  indentIds.push(indent.id);
  const orderId = sqlValue(
    `INSERT INTO "VendorOrder" (id, "indentId", "vendorName", amount, currency, status, "paidAt", "paymentTransactionId", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(indent.id)}, 'E2E Paid Vendor', 1500, 'INR', 'PAID', now(), 'E2E-TXN', now(), now()) RETURNING id`,
  )!;
  return { indent, orderId };
};

test.describe('pre-deploy fixes (23 Oct)', () => {
  test.afterEach(() => { dropIndentChildren(); dropFixtures(); });

  test('a paid indent can still move on: Procurement marks it In transit', async ({ request }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'PAYMENT_DONE' });
    indentIds.push(indent.id);
    const token = await tokenFor(request, ACCOUNTS.procurement);
    const res = await request.patch(`${API}/indents/${indent.id}/status`, {
      headers: auth(token),
      data: { status: 'IN_TRANSIT' },
    });
    expect(res.status(), await res.text()).toBe(200);
    expect(sqlValue(`SELECT status::text FROM "Indent" WHERE id = ${lit(indent.id)}`)).toBe('IN_TRANSIT');
  });

  test('adding a project tag in the table keeps the other projects\' reservations', async ({ request }) => {
    const item = createInventoryItemFixture(); // stock 50, org-wide
    const [p1, p2] = sql(`SELECT id FROM "Project" WHERE "isActive" ORDER BY name LIMIT 2`).map((r) => r[0]!);
    sql(`INSERT INTO "InventoryItemProject" ("inventoryItemId", "projectId", "allottedQty", "rackAddress") VALUES (${lit(item.id)}, ${lit(p1)}, 5, 'E2E-BENCH')`);
    const token = await tokenFor(request, ACCOUNTS.inventory);

    const add = await request.patch(`${API}/inventory/${item.id}`, { headers: auth(token), data: { projectIds: [p1, p2] } });
    expect(add.status(), await add.text()).toBe(200);
    const links = sql(`SELECT "projectId", "allottedQty"::float8, coalesce("rackAddress", '') FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(item.id)} ORDER BY "allottedQty" DESC`);
    expect(links.map((l) => [l[0], Number(l[1]), l[2]])).toEqual([[p1, 5, 'E2E-BENCH'], [p2, 0, '']]);

    // A project still holding stock cannot be untagged from here.
    const drop = await request.patch(`${API}/inventory/${item.id}`, { headers: auth(token), data: { projectIds: [p2] } });
    expect(drop.status()).toBe(400);
    expect((await drop.json()).message).toContain('5 reserved');
  });

  test('a stock edit in the table cannot go below what projects have reserved', async ({ request }) => {
    const item = createInventoryItemFixture(); // stock 50
    const p1 = sqlValue(`SELECT id FROM "Project" WHERE "isActive" ORDER BY name LIMIT 1`)!;
    sql(`INSERT INTO "InventoryItemProject" ("inventoryItemId", "projectId", "allottedQty") VALUES (${lit(item.id)}, ${lit(p1)}, 30)`);
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const res = await request.patch(`${API}/inventory/${item.id}`, { headers: auth(token), data: { stock: 10, stockReason: 'E2E recount' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain('30 of this item is reserved');
    expect(Number(sqlValue(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(item.id)}`))).toBe(50);
    // At or above the reservation is fine.
    const ok = await request.patch(`${API}/inventory/${item.id}`, { headers: auth(token), data: { stock: 30, stockReason: 'E2E recount' } });
    expect(ok.status(), await ok.text()).toBe(200);
  });

  test('a department admin cannot bulk-change or archive org-wide items', async ({ request }) => {
    const item = createInventoryItemFixture(); // departmentId null = org-wide
    const token = await tokenFor(request, ACCOUNTS.admin);
    const move = await request.post(`${API}/inventory/bulk-update`, { headers: auth(token), data: { itemIds: [item.id], data: { rackAddress: 'E2E-X' } } });
    expect(move.status()).toBe(403);
    const share = await request.post(`${API}/inventory/bulk-set-shared`, { headers: auth(token), data: { itemIds: [item.id], isShared: false } });
    expect(share.status()).toBe(403);
    // Archive is Inventory's alone (the old bulk-delete is gone).
    const del = await request.post(`${API}/inventory/archive`, { headers: auth(token), data: { ids: [item.id] } });
    expect(del.status()).toBe(403);
    expect(sqlValue(`SELECT "deletedAt" IS NULL AND coalesce("rackAddress",'') = '' AND "isShared" FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('t');
  });

  test('an indent cannot be re-quoted once a vendor has been paid (Finance would pay them twice)', async ({ request }) => {
    const { indent } = indentWithPaidVendor();
    const token = await tokenFor(request, ACCOUNTS.procurement);
    const res = await request.post(`${API}/indents/${indent.id}/reopen-quotation`, { headers: auth(token), data: {} });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain('E2E Paid Vendor');
    expect(sqlValue(`SELECT status::text FROM "Indent" WHERE id = ${lit(indent.id)}`)).toBe('AWAITING_PAYMENT');
  });

  test('cancelling a paid vendor order records the refund owed; only Finance can undo a payment', async ({ request }) => {
    const { indent, orderId } = indentWithPaidVendor();
    const proc = await tokenFor(request, ACCOUNTS.procurement);
    const unpay = await request.patch(`${API}/indents/${indent.id}/vendor-orders/${orderId}/status`, { headers: auth(proc), data: { status: 'AWAITING_PAYMENT' } });
    expect(unpay.status()).toBe(403);
    const cancel = await request.patch(`${API}/indents/${indent.id}/vendor-orders/${orderId}/status`, { headers: auth(proc), data: { status: 'CANCELLED' } });
    expect(cancel.status(), await cancel.text()).toBe(200);
    const [row] = sql(`SELECT status::text, "refundStatus"::text, "refundExpectedAmount"::float8 FROM "VendorOrder" WHERE id = ${lit(orderId)}`);
    expect([row[0], row[1], Number(row[2])]).toEqual(['CANCELLED', 'PENDING', 1500]);
  });

  test('an approval cannot be revoked once a vendor has been paid', async ({ request }) => {
    const { indent } = indentWithPaidVendor();
    const token = await tokenFor(request, ACCOUNTS.superAdmin);
    const res = await request.patch(`${API}/indents/${indent.id}/tech-approve`, { headers: auth(token), data: { decision: 'PENDING', reason: 'e2e' } });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain('already paid');
    expect(sqlValue(`SELECT "techApprovalStatus"::text FROM "Indent" WHERE id = ${lit(indent.id)}`)).toBe('APPROVED');
  });

  test('editing a bounced, quoted indent cannot swap the quoted price for the original estimate', async ({ request }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'PENDING', grandTotal: 4200 });
    indentIds.push(indent.id);
    // The firm quote came in at 25,725; the indent went back to PENDING for re-approval at that price.
    sql(`INSERT INTO "Quotation" (id, "indentId", version, status, "grandTotal", "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${lit(indent.id)}, 1, 'DRAFT', 25725, now(), now())`);
    sql(`UPDATE "Indent" SET "grandTotal" = 25725 WHERE id = ${lit(indent.id)}`);
    const itemId = sqlValue(`SELECT id FROM "IndentItem" WHERE "indentId" = ${lit(indent.id)}`)!;
    const token = await tokenFor(request, ACCOUNTS.user);
    const res = await request.patch(`${API}/indents/${indent.id}`, { headers: auth(token), data: { items: [{ id: itemId, qty: 3 }] } });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain('already has a quote');
    expect(Number(sqlValue(`SELECT "grandTotal" FROM "Indent" WHERE id = ${lit(indent.id)}`))).toBe(25725);
    // Wording can still be fixed, and the quoted total stays.
    const ok = await request.patch(`${API}/indents/${indent.id}`, { headers: auth(token), data: { items: [{ id: itemId, purpose: 'e2e: clearer purpose' }] } });
    expect(ok.status(), await ok.text()).toBe(200);
    expect(Number(sqlValue(`SELECT "grandTotal" FROM "Indent" WHERE id = ${lit(indent.id)}`))).toBe(25725);
  });

  test('issued quantity can only be corrected while the item is out, and a returned request cannot claim a back-order', async ({ request }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const item = createInventoryItemFixture();
    const req = createIssuedRequestFixture({ itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, handoverConfirmed: true });
    sql(`UPDATE "ComponentRequest" SET status = 'PENDING', "qtyIssued" = 0 WHERE id = ${lit(req.id)}`);
    const inv = await tokenFor(request, ACCOUNTS.inventory);
    const edit = await request.patch(`${API}/requests/${req.id}`, { headers: auth(inv), data: { qtyIssued: 5, issueReason: 'e2e' } });
    expect(edit.status()).toBe(400);
    expect(Number(sqlValue(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(item.id)}`))).toBe(50);

    sql(`UPDATE "ComponentRequest" SET status = 'RETURNED', "qtyIssued" = 1, "qtyShortfall" = 3 WHERE id = ${lit(req.id)}`);
    const user = await tokenFor(request, ACCOUNTS.user);
    const claim = await request.post(`${API}/requests/${req.id}/redeem-shortfall`, { headers: auth(user) });
    expect(claim.status()).toBe(400);
    expect(Number(sqlValue(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(item.id)}`))).toBe(50);
    expect(sqlValue(`SELECT status::text FROM "ComponentRequest" WHERE id = ${lit(req.id)}`)).toBe('RETURNED');
  });

  // ------------------------------------------------------------ sign-in

  test('a % or _ in the email is not a wildcard — it cannot sign in as someone else', async ({ request }) => {
    for (const email of ['%@rhythmrx.ai', ACCOUNTS.user.replace(/^./, '_')]) {
      const res = await request.post(`${API}/auth/login`, { data: { email, password: 'password123' } });
      expect(res.status(), `${email} signed in`).toBe(401);
    }
    // The real address, in any case, still works.
    const ok = await request.post(`${API}/auth/login`, { data: { email: ACCOUNTS.user.toUpperCase(), password: 'password123' } });
    expect(ok.status()).toBe(201);
  });

  test('two tabs refreshing the same session a moment apart both stay signed in', async ({ request }) => {
    const login = await request.post(`${API}/auth/login`, { data: { email: ACCOUNTS.user, password: 'password123' } });
    const body = await login.json();
    const refreshToken = body.refreshToken ?? body.data?.refreshToken;
    const first = await request.post(`${API}/auth/refresh`, { data: { refreshToken } });
    const second = await request.post(`${API}/auth/refresh`, { data: { refreshToken } });
    expect(first.status()).toBe(201);
    expect(second.status(), 'the second tab was signed out').toBe(201);
    expect((await data(second)).refreshToken).toBe((await data(first)).refreshToken);
    // After logout the old token is dead for good — the grace does not outlive the session.
    const access = (await data(first)).accessToken;
    await request.post(`${API}/auth/logout`, { headers: auth(access), data: { refreshToken: (await data(first)).refreshToken } });
    const third = await request.post(`${API}/auth/refresh`, { data: { refreshToken } });
    expect(third.status()).toBe(401);
  });

  test('restarting the server does not sign people out', async ({ page }) => {
    test.setTimeout(180_000);
    await signInAs(page, 'user');
    // A boot fetches exchange rates and saves a snapshot — the app doing its
    // job, not this test's data. Removed afterwards so the run leaves no trace.
    const fxBefore = sql(`SELECT id FROM "FxRateSnapshot"`).map((r) => r[0]!);
    execFileSync('docker', ['restart', 'lms-ui-backend']);
    // Reload while it is coming back up: the session must wait, not end.
    await page.reload();
    await page.waitForTimeout(3_000);
    expect(page.url(), 'signed out by a server restart').not.toContain('/login');
    await expect(page.locator('main')).toBeVisible({ timeout: 120_000 });
    await expect.poll(() => page.url(), { timeout: 120_000 }).toMatch(/\/user(\/|$|\?)/);
    const notBefore = fxBefore.length ? `WHERE id NOT IN (${fxBefore.map(lit).join(', ')})` : '';
    await expect.poll(() => sqlValue(`SELECT count(*) FROM "FxRateSnapshot" ${notBefore}`), { timeout: 30_000 }).not.toBe('0');
    sql(`DELETE FROM "FxRateSnapshot" ${notBefore}`);
  });

  test('the login form shows the app\'s own message, not the browser\'s bubble', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await expect(page.getByText('Enter an email address.')).toBeVisible();
    await page.fill('#email-address', ACCOUNTS.user);
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await expect(page.getByText('Enter your password.')).toBeVisible();
  });

  // ------------------------------------------------------------ files

  test('an asset edit cannot point its photos at another stored file', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.finance);
    const deptId = sqlValue(`SELECT id FROM "Department" ORDER BY name LIMIT 1`)!;
    const made = await request.post(`${API}/fixed-assets`, { headers: auth(token), data: { name: `E2E asset ${Date.now()}`, category: 'COMPUTERS_IT', departmentId: deptId } });
    const asset = await data(made);
    try {
      expect(made.status()).toBe(201);
      const res = await request.patch(`${API}/fixed-assets/${asset.id}`, { headers: auth(token), data: { pictures: ['payment-receipts/somebody-elses.pdf'] } });
      expect(res.status()).toBe(400);
      expect(sqlValue(`SELECT array_length(pictures, 1) IS NULL FROM "FixedAsset" WHERE id = ${lit(asset.id)}`)).toBe('t');
    } finally {
      sql(`DELETE FROM "FixedAssetEvent" WHERE "fixedAssetId" = ${lit(asset.id)}`);
      sql(`DELETE FROM "FixedAsset" WHERE id = ${lit(asset.id)}`);
    }
  });

  // ------------------------------------------------------------ notifications

  test('a desktop alert link opens the record on the right page for each role', async ({ page }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'APPROVED' });
    indentIds.push(indent.id);
    const link = `/open-notification?type=INDENT&id=${indent.id}&nt=INFO`;
    // Signed out first: sign-in brings them back to it.
    await page.goto(link);
    await page.waitForURL(/\/login\?next=/);
    await page.fill('#email-address', ACCOUNTS.procurement);
    await page.fill('#password', 'password123');
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await page.waitForURL(new RegExp(`/procurement/indents\\?openIndent=${indent.id}`), { timeout: 30_000 });
  });

  test('Notifications page: Mark as read removes the card; "Request Extension" only on overdue loans', async ({ page }) => {
    const me = userFixtureIds(ACCOUNTS.user);
    const tag = `E2E-notif-${Date.now()}`;
    sql(`INSERT INTO "Notification" (id, "userId", type, title, message, "relatedEntityType", "relatedEntityId", "isRead", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), ${lit(me.id)}, 'OVERDUE', ${lit(tag + ' delivery')}, 'Delivery overdue', 'INDENT', gen_random_uuid()::text, false, now(), now()),
                (gen_random_uuid(), ${lit(me.id)}, 'INFO', ${lit(tag + ' info')}, 'Something happened', NULL, NULL, false, now(), now())`);
    try {
      await signInAs(page, 'user');
      await page.goto('/user/notifications');
      const overdueCard = page.locator('div.rounded-xl', { hasText: `${tag} delivery` });
      await expect(overdueCard).toBeVisible({ timeout: 20_000 });
      await expect(overdueCard.getByRole('button', { name: 'Request Extension' })).toHaveCount(0);
      const infoCard = page.locator('div.rounded-xl', { hasText: `${tag} info` });
      await infoCard.getByRole('button', { name: 'Dismiss' }).click();
      await expect(infoCard).toHaveCount(0, { timeout: 10_000 });
    } finally {
      sql(`DELETE FROM "Notification" WHERE title LIKE ${lit(tag + '%')}`);
    }
  });

  test('CEO dashboard: Awaiting Payment counts Finance\'s queue, and spend is in rupees', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.superAdmin);
    const before = await data(await request.get(`${API}/admin/dashboard`, { headers: auth(token) }));
    const owner = userFixtureIds(ACCOUNTS.user);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'AWAITING_PAYMENT', grandTotal: 100 });
    indentIds.push(indent.id);
    sql(`UPDATE "Indent" SET currency = 'USD' WHERE id = ${lit(indent.id)}`);
    const after = await data(await request.get(`${API}/admin/dashboard`, { headers: auth(token) }));
    expect(after.awaitingPayment - before.awaitingPayment).toBe(1);
    // USD 100 is thousands of rupees, never 100.
    expect(Number(after.totalSpendApproved) - Number(before.totalSpendApproved)).toBeGreaterThan(1000);
  });


  test('two clerks reserving the same item at the same moment cannot reserve more than is in stock', async ({ request }) => {
    const item = createInventoryItemFixture(); // stock 50
    sql(`UPDATE "InventoryItem" SET stock = 10 WHERE id = ${lit(item.id)}`);
    const [p1, p2] = sql(`SELECT id FROM "Project" WHERE "isActive" ORDER BY name LIMIT 2`).map((r) => r[0]!);
    const token = await tokenFor(request, ACCOUNTS.inventory);
    // Several rounds: without the row lock both sides usually passed.
    for (let round = 0; round < 5; round++) {
      sql(`DELETE FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(item.id)}`);
      const results = await Promise.all([p1, p2].map((projectId) =>
        request.patch(`${API}/inventory/allotments/${item.id}`, { headers: auth(token), data: { projectId, allottedQty: 8 } })));
      const reserved = Number(sqlValue(`SELECT coalesce(sum("allottedQty"), 0) FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(item.id)}`));
      expect(reserved, `round ${round}: ${results.map((r) => r.status()).join('/')}`).toBeLessThanOrEqual(10);
      expect(results.filter((r) => r.ok()).length).toBe(1);
    }
  });


  test('on screen: "+ Add Item" in Edit request adds a line to a raised indent', async ({ page }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'PENDING' });
    indentIds.push(indent.id);
    // The manager had signed the old version; editing it sends it back to them.
    sql(`UPDATE "Indent" SET "managerApprovalStatus" = 'APPROVED', "managerApprovedAt" = now() WHERE id = ${lit(indent.id)}`);
    await signInAs(page, 'user');
    await page.goto('/user/ip-requests');
    const row = page.getByRole('row', { name: new RegExp(indent.serialNo) });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByRole('button', { name: /^Edit$/ }).click();
    const dialog = page.getByRole('dialog', { name: new RegExp(`Edit request — ${indent.serialNo}`) });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: '+ Add Item' }).click();
    await dialog.locator('#ind-item-1-name').fill('E2E added line');
    await dialog.locator('#ind-item-1-purpose').fill('e2e: second line');
    await dialog.getByRole('button', { name: /Save changes/ }).click();
    await expect(page.getByText('Request slip updated')).toBeVisible({ timeout: 15_000 });
    expect(sql(`SELECT name FROM "IndentItem" WHERE "indentId" = ${lit(indent.id)} ORDER BY "createdAt", name`).map((r) => r[0])).toContain('E2E added line');
    expect(Number(sqlValue(`SELECT count(*) FROM "IndentItem" WHERE "indentId" = ${lit(indent.id)}`))).toBe(2);
    expect(sqlValue(`SELECT "managerApprovalStatus"::text FROM "Indent" WHERE id = ${lit(indent.id)}`)).toBe('PENDING');
  });

  test('customs duty can be raised when one vendor\'s goods are at customs, even if the indent is not wholly in transit', async ({ request }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const ind = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'ORDERED' });
    indentIds.push(ind.id);
    const line = sqlValue(`SELECT id FROM "IndentItem" WHERE "indentId" = ${lit(ind.id)}`)!;
    const token = await tokenFor(request, ACCOUNTS.procurement);
    const raise = () => request.post(`${API}/indents/${ind.id}/customs-duty`, { headers: auth(token), data: { kind: 'INTERNAL', amount: 100 } });
    // Nothing on its way yet: refused.
    expect((await raise()).status()).toBe(400);
    sql(`INSERT INTO "VendorAllocation" (id, "indentId", "indentItemId", "vendorName", "allocatedQty", "shipmentStage", "createdAt") VALUES (gen_random_uuid(), ${lit(ind.id)}, ${lit(line)}, 'E2E Vendor', 1, 'CUSTOMS', now())`);
    const res = await raise();
    expect(res.status(), await res.text()).toBe(201);
  });

  test('the CEO is told when new feedback arrives', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.user);
    const tag = `E2E feedback ${Date.now()}`;
    const res = await request.post(`${API}/feedback`, { headers: auth(token), multipart: { message: tag } });
    expect(res.status(), await res.text()).toBe(201);
    const fb = await data(res);
    try {
      const ceo = sqlValue(`SELECT id FROM "User" WHERE email = ${lit(ACCOUNTS.superAdmin)}`)!;
      expect(Number(sqlValue(`SELECT count(*) FROM "Notification" WHERE "userId" = ${lit(ceo)} AND "relatedEntityType" = 'FEEDBACK' AND "relatedEntityId" = ${lit(fb.id)}`))).toBe(1);
    } finally {
      sql(`DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(fb.id)}`);
      sql(`DELETE FROM "Feedback" WHERE id = ${lit(fb.id)}`);
    }
  });


  test('History counts are the real totals, not "how many of the newest 200"', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.superAdmin);
    // Enough decided, non-BOM requests to pass the old cap of 200.
    const owner = userFixtureIds(ACCOUNTS.user);
    const item = createInventoryItemFixture();
    const tag = `E2E-HIST-${Date.now()}`;
    sql(`INSERT INTO "ComponentRequest" (id, "serialNo", "inventoryItemId", "qtyRequested", "qtyIssued", nature, "durationValue", "durationUnit", status, "departmentId", "createdById", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), ${lit(tag)} || '-' || g, ${lit(item.id)}, 1, 0, 'PERMANENT', 0, 'DAYS', 'REJECTED', ${lit(owner.departmentId)}, ${lit(owner.id)}, now(), now() FROM generate_series(1, 210) g`);
    try {
      const res = await request.get(`${API}/requests`, { headers: auth(token), params: { excludeStatus: 'PENDING', regularOnly: 'true', take: '200' } });
      const body = await data(res);
      const expected = Number(sqlValue(`SELECT count(*) FROM "ComponentRequest" WHERE status <> 'PENDING' AND "bomListId" IS NULL AND "deletedAt" IS NULL`));
      expect(expected).toBeGreaterThan(200);
      expect(body.total).toBe(expected);
      expect(body.items.length).toBe(200);
      expect(body.items.every((r: any) => !r.bomListId)).toBe(true);
    } finally {
      sql(`DELETE FROM "ComponentRequest" WHERE "serialNo" LIKE ${lit(tag + '-%')}`);
    }
  });

  // ------------------------------------------------------------ Group 2: receiving

  test('receiving: refused on an unpaid indent; a short delivery stays open; over-receiving is refused', async ({ request }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const item = createInventoryItemFixture(); // stock 50
    const inv = await tokenFor(request, ACCOUNTS.inventory);

    // Legacy (no vendor split): an indent nobody has paid cannot be received.
    const unpaid = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'PENDING' });
    indentIds.push(unpaid.id);
    const unpaidLine = sqlValue(`SELECT id FROM "IndentItem" WHERE "indentId" = ${lit(unpaid.id)}`)!;
    const refused = await request.post(`${API}/inventory/receive-indent`, { headers: auth(inv), data: { indentId: unpaid.id, items: [{ indentItemId: unpaidLine, inventoryItemId: item.id, qty: 1 }] } });
    expect(refused.status()).toBe(400);
    expect(Number(sqlValue(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(item.id)}`))).toBe(50);

    // Split by vendor: 10 ordered from one vendor, 7 arrive.
    const ind = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'ORDERED' });
    indentIds.push(ind.id);
    const line = sqlValue(`SELECT id FROM "IndentItem" WHERE "indentId" = ${lit(ind.id)}`)!;
    sql(`UPDATE "IndentItem" SET qty = 10 WHERE id = ${lit(line)}`);
    sql(`INSERT INTO "VendorOrder" (id, "indentId", "vendorName", amount, currency, status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${lit(ind.id)}, 'E2E Vendor', 100, 'INR', 'RECEIVED', now(), now())`);
    const alloc = sqlValue(`INSERT INTO "VendorAllocation" (id, "indentId", "indentItemId", "vendorName", "allocatedQty", "createdAt") VALUES (gen_random_uuid(), ${lit(ind.id)}, ${lit(line)}, 'E2E Vendor', 10, now()) RETURNING id`)!;
    const receive = (qty: number) => request.post(`${API}/inventory/receive-indent`, {
      headers: auth(inv), data: { indentId: ind.id, vendorName: 'E2E Vendor', items: [{ indentItemId: line, inventoryItemId: item.id, qty }] },
    });

    const short = await receive(7);
    expect(short.status(), await short.text()).toBe(201);
    let row = sql(`SELECT "receivedQty"::float8, "actualDeliveryDate" IS NULL FROM "VendorAllocation" WHERE id = ${lit(alloc)}`)[0];
    expect([Number(row[0]), row[1]]).toEqual([7, 't']);
    expect(sqlValue(`SELECT status::text FROM "Indent" WHERE id = ${lit(ind.id)}`)).toBe('PARTIALLY_RECEIVED');

    const over = await receive(4);
    expect(over.status()).toBe(400);
    expect((await over.json()).message).toContain('only 3');

    const rest = await receive(3);
    expect(rest.status(), await rest.text()).toBe(201);
    row = sql(`SELECT "receivedQty"::float8, "actualDeliveryDate" IS NULL FROM "VendorAllocation" WHERE id = ${lit(alloc)}`)[0];
    expect([Number(row[0]), row[1]]).toEqual([10, 'f']);
    expect(sqlValue(`SELECT status::text FROM "Indent" WHERE id = ${lit(ind.id)}`)).toBe('RECEIVED');
    expect(Number(sqlValue(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(item.id)}`))).toBe(60);
    // "Your items arrived" notices point at the item, not the indent.
    sql(`DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(item.id)}`);
  });
});

/**
 * 24 Oct, from production: a manager's team is their department, not just the
 * people linked to them one by one. Prod had no links for two Software
 * managers, so "My Team (0)", no team indents (a MANAGER_REQUIRED indent
 * waited on a manager who could not see it), while every manager saw every
 * department's extensions and was then refused on Approve.
 */
test.describe('manager team = their department (24 Oct)', () => {
  const madeUsers: string[] = [];
  const madeExtensions: string[] = [];
  test.afterEach(() => {
    const ext = madeExtensions.splice(0);
    if (ext.length) sql(`DELETE FROM "ExtensionRequest" WHERE id IN (${ext.map(lit).join(', ')})`);
    dropIndentChildren();
    dropFixtures();
    const users = madeUsers.splice(0);
    if (users.length) sql(`DELETE FROM "User" WHERE id IN (${users.map(lit).join(', ')})`);
  });

  /** A user in `departmentId` with no reporting line to anyone. */
  const addUser = (role: 'USER' | 'MANAGER' | 'ADMIN', departmentId: string) => {
    const id = sqlValue(
      `INSERT INTO "User" (id, email, password, name, role, "departmentId", "isActive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(`${fixtureTag().toLowerCase()}@example.com`)}, 'x', ${lit(`E2E ${role} ${fixtureTag()}`)},
               ${lit(role)}, ${lit(departmentId)}, true, now(), now()) RETURNING id`,
    )!;
    madeUsers.push(id);
    return id;
  };
  const addExtension = (requestId: string) => {
    const id = sqlValue(
      `INSERT INTO "ExtensionRequest" (id, "componentRequestId", "newNature", "newDurationValue", "newDurationUnit", reason, "updatedAt")
       VALUES (gen_random_uuid(), ${lit(requestId)}, 'TEMPORARY', 3, 'DAYS', 'E2E', now()) RETURNING id`,
    )!;
    madeExtensions.push(id);
    return id;
  };

  test('My Team, team indents, team requests and extensions all follow the department', async ({ request }) => {
    const mgr = userFixtureIds(ACCOUNTS.manager);
    const otherDept = sqlValue(`SELECT id FROM "Department" WHERE id <> ${lit(mgr.departmentId)} ORDER BY name LIMIT 1`)!;
    const teammate = addUser('USER', mgr.departmentId);
    const peerManager = addUser('MANAGER', mgr.departmentId);
    const deptAdmin = addUser('ADMIN', mgr.departmentId);
    const outsider = addUser('USER', otherDept);
    const token = await tokenFor(request, ACCOUNTS.manager);

    // My Team: the unlinked teammate is there; fellow managers, the department's admin and the manager themselves are not.
    const team = await data(await request.get(`${API}/users/paginated?take=100`, { headers: auth(token) }));
    const teamIds = team.items.map((u: any) => u.id);
    expect(teamIds).toContain(teammate);
    expect(teamIds).not.toContain(peerManager);
    expect(teamIds).not.toContain(deptAdmin);
    expect(teamIds).not.toContain(mgr.id);
    expect(teamIds).not.toContain(outsider);

    // Team Approvals: the teammate's indent shows, the outsider's does not.
    const mine = createIndentFixture({ createdById: teammate, departmentId: mgr.departmentId, status: 'PENDING' });
    const theirs = createIndentFixture({ createdById: outsider, departmentId: otherDept, status: 'PENDING' });
    indentIds.push(mine.id, theirs.id);
    const indents = await data(await request.get(`${API}/indents?teamScope=true&take=500`, { headers: auth(token) }));
    const indentRows = (indents.items ?? indents).map((i: any) => i.id);
    expect(indentRows).toContain(mine.id);
    expect(indentRows).not.toContain(theirs.id);

    // Requests on Team Approvals, and the extension queue.
    const item = createInventoryItemFixture();
    const teamLoan = createIssuedRequestFixture({ itemId: item.id, createdById: teammate, departmentId: mgr.departmentId, handoverConfirmed: true });
    const outsideLoan = createIssuedRequestFixture({ itemId: item.id, createdById: outsider, departmentId: otherDept, handoverConfirmed: true });
    const reqs = await data(await request.get(`${API}/requests/team-approvals`, { headers: auth(token) }));
    const reqIds = reqs.items.map((r: any) => r.id);
    expect(reqIds).toContain(teamLoan.id);
    expect(reqIds).not.toContain(outsideLoan.id);

    const teamExt = addExtension(teamLoan.id);
    const outsideExt = addExtension(outsideLoan.id);
    const pending = await data(await request.get(`${API}/extensions/pending?take=200`, { headers: auth(token) }));
    const extIds = pending.items.map((e: any) => e.id);
    expect(extIds).toContain(teamExt);
    expect(extIds, 'another department\'s extension is listed, and Approve would refuse it').not.toContain(outsideExt);
  });
});

/**
 * 24 Oct: a Super Admin can edit everything about a person in one form — role
 * in one step (with the cleanup promote / demote would do), department, and
 * any number of managers.
 */
test.describe('Super Admin edits a user in one form (24 Oct)', () => {
  const madeUsers: string[] = [];
  test.afterEach(() => {
    const users = madeUsers.splice(0);
    if (!users.length) return;
    const list = users.map(lit).join(', ');
    sql(`DELETE FROM "ApprovalHistory" WHERE "entityType" = 'USER' AND "entityId" IN (${list})`);
    sql(`DELETE FROM "Notification" WHERE "userId" IN (${list})`);
    sql(`DELETE FROM "ManagerUser" WHERE "userId" IN (${list}) OR "managerId" IN (${list})`);
    sql(`DELETE FROM "AdminDepartment" WHERE "userId" IN (${list})`);
    sql(`DELETE FROM "User" WHERE id IN (${list})`);
  });

  const addUser = (role: string, departmentId: string | null) => {
    const id = sqlValue(
      `INSERT INTO "User" (id, email, password, name, role, "departmentId", "isActive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(`${fixtureTag().toLowerCase()}@example.com`)}, 'x', ${lit(`E2E ${role} ${fixtureTag()}`)},
               ${lit(role)}, ${departmentId ? lit(departmentId) : 'NULL'}, true, now(), now()) RETURNING id`,
    )!;
    madeUsers.push(id);
    return id;
  };
  const dept = () => userFixtureIds(ACCOUNTS.manager).departmentId;

  test('User straight to Finance: department and manager links go, they are told', async ({ request }) => {
    const mgr = addUser('MANAGER', dept());
    const u = addUser('USER', dept());
    sql(`INSERT INTO "ManagerUser" ("managerId", "userId") VALUES (${lit(mgr)}, ${lit(u)})`);
    const token = await tokenFor(request, ACCOUNTS.superAdmin);

    const res = await request.patch(`${API}/users/${u}`, { headers: auth(token), data: { role: 'FINANCE' } });
    expect(res.status(), await res.text()).toBe(200);
    const row = sql(`SELECT role::text, "departmentId" IS NULL FROM "User" WHERE id = ${lit(u)}`)[0];
    expect(row).toEqual(['FINANCE', 't']);
    expect(sqlValue(`SELECT count(*) FROM "ManagerUser" WHERE "userId" = ${lit(u)}`)).toBe('0');
    expect(sqlValue(`SELECT count(*) FROM "Notification" WHERE "userId" = ${lit(u)} AND title LIKE 'Your role changed%'`)).toBe('1');
    expect(sqlValue(`SELECT count(*) FROM "ApprovalHistory" WHERE "entityId" = ${lit(u)} AND action = 'ROLE_CHANGED'`)).toBe('1');
  });

  test('a manager made a User hands their people to the manager picked', async ({ request }) => {
    const oldMgr = addUser('MANAGER', dept());
    const newMgr = addUser('MANAGER', dept());
    const report = addUser('USER', dept());
    sql(`INSERT INTO "ManagerUser" ("managerId", "userId") VALUES (${lit(oldMgr)}, ${lit(report)})`);
    const token = await tokenFor(request, ACCOUNTS.superAdmin);

    const res = await request.patch(`${API}/users/${oldMgr}`, { headers: auth(token), data: { role: 'USER', reassignToManagerId: newMgr } });
    expect(res.status(), await res.text()).toBe(200);
    expect(sql(`SELECT "managerId" FROM "ManagerUser" WHERE "userId" = ${lit(report)}`).map((r) => r[0])).toEqual([newMgr]);
  });

  test('the guards: not the last Finance user, not by an Admin, never Super Admin', async ({ request }) => {
    const sa = await tokenFor(request, ACCOUNTS.superAdmin);
    const fin = sqlValue(`SELECT id FROM "User" WHERE email = ${lit(ACCOUNTS.finance)}`)!;
    const others = Number(sqlValue(`SELECT count(*) FROM "User" WHERE role = 'FINANCE' AND "isActive" AND "deletedAt" IS NULL AND id <> ${lit(fin)}`));
    if (others === 0) {
      const last = await request.patch(`${API}/users/${fin}`, { headers: auth(sa), data: { role: 'USER', departmentId: dept() } });
      expect(last.status()).toBe(400);
      expect((await last.json()).message).toContain('only active Finance user');
    }
    const u = addUser('USER', dept());
    const toSuper = await request.patch(`${API}/users/${u}`, { headers: auth(sa), data: { role: 'SUPER_ADMIN' } });
    expect(toSuper.status()).toBe(403);
    const admin = await tokenFor(request, ACCOUNTS.admin);
    const byAdmin = await request.patch(`${API}/users/${u}`, { headers: auth(admin), data: { role: 'MANAGER' } });
    expect(byAdmin.status()).toBe(403);
    expect(sqlValue(`SELECT role::text FROM "User" WHERE id = ${lit(u)}`)).toBe('USER');
  });

  test('on screen: Edit gives a user two managers; the Manager column shows them', async ({ page }) => {
    const other = sqlValue(`SELECT id FROM "Department" WHERE id <> ${lit(dept())} ORDER BY name LIMIT 1`)!;
    const m1 = addUser('MANAGER', other);
    const m2 = addUser('MANAGER', other);
    const u = addUser('USER', dept());
    const [m1Name, m2Name, uName] = [m1, m2, u].map((id) => sqlValue(`SELECT name FROM "User" WHERE id = ${lit(id)}`)!);

    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/users');
    await page.getByPlaceholder('Search by name or email...').fill(uName);
    const row = page.getByRole('row', { name: new RegExp(uName) });
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: m1Name }).click();
    await dialog.getByRole('button', { name: m2Name }).click();
    await dialog.getByRole('button', { name: 'Save User' }).click();
    await expect(dialog).toBeHidden();

    expect(sql(`SELECT "managerId" FROM "ManagerUser" WHERE "userId" = ${lit(u)} ORDER BY "managerId"`).map((r) => r[0]))
      .toEqual([m1, m2].sort());
    await expect(row).toContainText(m1Name);
    await expect(row).toContainText(m2Name);
  });
});

/**
 * 26 Oct audit of the production data: what a person sees must match what
 * they can act on, and nothing may sit waiting with nobody to act.
 */
test.describe('26 Oct audit fixes', () => {
  const madeUsers: string[] = [];
  const restoreModes: [string, string][] = [];
  test.afterEach(() => {
    for (const [id, mode] of restoreModes.splice(0)) {
      sql(`UPDATE "Department" SET "indentApprovalMode" = ${lit(mode)}::"IndentApprovalMode" WHERE id = ${lit(id)}`);
    }
    dropIndentChildren();
    dropFixtures();
    const users = madeUsers.splice(0);
    if (users.length) sql(`DELETE FROM "User" WHERE id IN (${users.map(lit).join(', ')})`);
  });

  const addUser = (role: string, departmentId: string | null) => {
    const id = sqlValue(
      `INSERT INTO "User" (id, email, password, name, role, "departmentId", "isActive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(`${fixtureTag().toLowerCase()}@example.com`)}, 'x', ${lit(`E2E ${role} ${fixtureTag()}`)},
               ${lit(role)}, ${departmentId ? lit(departmentId) : 'NULL'}, true, now(), now()) RETURNING id`,
    )!;
    madeUsers.push(id);
    return id;
  };
  const setMode = (deptId: string, mode: 'MANAGER_REQUIRED' | 'MANAGER_OPTIONAL') => {
    restoreModes.push([deptId, sqlValue(`SELECT "indentApprovalMode"::text FROM "Department" WHERE id = ${lit(deptId)}`)!]);
    sql(`UPDATE "Department" SET "indentApprovalMode" = ${lit(mode)}::"IndentApprovalMode" WHERE id = ${lit(deptId)}`);
  };
  const badge = async (request: APIRequestContext, email: string, path: string, key: string) => {
    const token = await tokenFor(request, email);
    const body = await data(await request.get(`${API}${path}`, { headers: auth(token) }));
    expect(typeof body[key], `${path} has no ${key}`).toBe('number');
    return body[key] as number;
  };

  test('a manager\'s red dot counts team indents waiting for their signature', async ({ request }) => {
    const mgr = userFixtureIds(ACCOUNTS.manager);
    const before = await badge(request, ACCOUNTS.manager, '/requests/badge-counts', 'pendingTeamIndentApprovals');
    const teammate = addUser('USER', mgr.departmentId);
    indentIds.push(createIndentFixture({ createdById: teammate, departmentId: mgr.departmentId }).id);
    expect(await badge(request, ACCOUNTS.manager, '/requests/badge-counts', 'pendingTeamIndentApprovals')).toBe(before + 1);
  });

  test('an admin\'s dot leaves out indents still waiting for the manager in a Required department', async ({ request }) => {
    const admin = userFixtureIds(ACCOUNTS.admin);
    setMode(admin.departmentId, 'MANAGER_REQUIRED');
    const managerHere = sqlValue(`SELECT count(*) FROM "User" WHERE role = 'MANAGER' AND "isActive" AND "departmentId" = ${lit(admin.departmentId)}`);
    expect(Number(managerHere), 'the admin\'s department needs a manager for this check').toBeGreaterThan(0);
    const before = await badge(request, ACCOUNTS.admin, '/indents/badge-counts', 'techPendingIndents');
    const requester = addUser('USER', admin.departmentId);
    indentIds.push(createIndentFixture({ createdById: requester, departmentId: admin.departmentId }).id);
    expect(await badge(request, ACCOUNTS.admin, '/indents/badge-counts', 'techPendingIndents'),
      'counted an indent the admin cannot approve yet').toBe(before);
  });

  test('no "manager hasn\'t approved" warning when nobody manages the requester', async ({ request }) => {
    const admin = userFixtureIds(ACCOUNTS.admin);
    setMode(admin.departmentId, 'MANAGER_OPTIONAL');
    // Procurement has no department, so no manager covers them — Harsha's case.
    const requester = addUser('PROCUREMENT', null);
    const ind = createIndentFixture({ createdById: requester, departmentId: admin.departmentId });
    indentIds.push(ind.id);
    const token = await tokenFor(request, ACCOUNTS.admin);
    const res = await request.patch(`${API}/indents/${ind.id}/tech-approve`, { headers: auth(token), data: { decision: 'APPROVED' } });
    expect(res.status(), await res.text()).toBe(200);
    const row = sql(`SELECT "managerApprovalBypassedById" IS NULL, "managerApprovalSkipped" FROM "Indent" WHERE id = ${lit(ind.id)}`)[0];
    expect(row, 'recorded as going past a manager who does not exist').toEqual(['t', 't']);
  });

  test('notes: switching to a new note keeps the last edit and puts new typing in the new note', async ({ page }) => {
    const owner = sqlValue(`SELECT id FROM "User" WHERE email = ${lit(ACCOUNTS.procurement)}`)!;
    const tagged = `E2E existing ${fixtureTag()}`;
    sql(`INSERT INTO "Note" (id, "authorId", body, pinned, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${lit(owner)}, ${lit(tagged)}, true, now(), now())`);
    try {
      await signInAs(page, 'procurement');
      await page.goto('/procurement/notes');
      const editor = page.getByPlaceholder(/Start typing/);
      await expect(editor).toHaveValue(tagged, { timeout: 20_000 });
      // Caret to the end directly: "End" does not move it in WebKit or
      // Firefox on a Mac, so the text went in at the start there.
      await editor.evaluate((el: HTMLTextAreaElement) => { el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
      await page.keyboard.type(' extra');
      // Inside the autosave pause — the edit has not been sent yet.
      // Exact: an empty note's row in the list is also labelled "New note".
      await page.getByRole('button', { name: 'New note', exact: true }).click();
      await expect(editor).toHaveValue('', { timeout: 20_000 });
      await expect(editor).toBeEditable();
      await editor.type('fresh');

      await expect.poll(() => sqlValue(`SELECT body FROM "Note" WHERE "authorId" = ${lit(owner)} AND body LIKE ${lit(`${tagged}%`)}`),
        { message: 'the last edit to the old note was lost', timeout: 20_000 }).toBe(`${tagged} extra`);
      await expect.poll(() => sqlValue(`SELECT count(*) FROM "Note" WHERE "authorId" = ${lit(owner)} AND body = 'fresh'`),
        { message: 'the new note never got its text', timeout: 20_000 }).toBe('1');
    } finally {
      sql(`DELETE FROM "Note" WHERE "authorId" = ${lit(owner)} AND (body LIKE ${lit(`%${tagged}%`)}
            OR (body IN ('', 'fresh') AND "createdAt" > now() - interval '10 minutes'))`);
    }
  });
});

/**
 * 26 Oct, production: every off-site backup and every "Full Backup" click
 * failed with "tar: uploads/lost+found: Cannot open: Permission denied". The
 * uploads folder is a mounted disk there, and a mounted disk carries a
 * root-only lost+found. Reproduced here by planting one.
 */
test('a full backup still works when the uploads folder holds an unreadable lost+found', async ({ request }) => {
  const dex = (...args: string[]) => execFileSync('docker', ['exec', ...args], { encoding: 'utf8' });
  const list = () => new Set(dex('lms-ui-backend', 'ls', '/app/backups').split('\n').filter(Boolean));
  const before = list();
  dex('-u', 'root', 'lms-ui-backend', 'sh', '-c', 'mkdir -p /app/uploads/lost+found && chmod 700 /app/uploads/lost+found');
  try {
    const token = await tokenFor(request, ACCOUNTS.superAdmin);
    const res = await request.post(`${API}/database-manager/backup/full`, { headers: auth(token) });
    expect(res.status(), await res.text()).toBe(201);
  } finally {
    dex('-u', 'root', 'lms-ui-backend', 'rm', '-rf', '/app/uploads/lost+found');
    const made = [...list()].filter((f) => !before.has(f));
    if (made.length) dex('lms-ui-backend', 'rm', '-f', ...made.map((f) => `/app/backups/${f}`));
  }
});

/** 26 Oct: the Super Admin sets anyone's password from Edit; blank leaves it alone. */
test('on screen: the Super Admin sets a new password from Edit, and a blank field changes nothing', async ({ page, request }) => {
  const email = `${fixtureTag().toLowerCase()}@example.com`;
  const hash = sqlValue(`SELECT password FROM "User" WHERE email = ${lit(ACCOUNTS.admin)}`)!;
  const dept = userFixtureIds(ACCOUNTS.user).departmentId;
  const id = sqlValue(
    `INSERT INTO "User" (id, email, password, name, role, "departmentId", "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(email)}, ${lit(hash)}, ${lit(`E2E Pw ${fixtureTag()}`)}, 'USER', ${lit(dept)}, true, now(), now()) RETURNING id`,
  )!;
  const name = sqlValue(`SELECT name FROM "User" WHERE id = ${lit(id)}`)!;
  const canLogin = async (pw: string) => (await request.post(`${API}/auth/login`, { data: { email, password: pw } })).ok();
  try {
    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/users');
    await page.getByPlaceholder('Search by name or email...').fill(name);
    const row = page.getByRole('row', { name: new RegExp(name) });
    const dialog = page.getByRole('dialog');

    // Blank: saving the form keeps the old password.
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save User' }).click();
    await expect(dialog).toBeHidden();
    expect(await canLogin('password123')).toBe(true);

    // Set: the new one works, the old one stops working.
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await dialog.locator('input[autocomplete="new-password"]').fill('Fresh-pass-2026');
    await dialog.getByRole('button', { name: 'Save User' }).click();
    await expect(dialog).toBeHidden();
    expect(await canLogin('Fresh-pass-2026')).toBe(true);
    expect(await canLogin('password123')).toBe(false);
  } finally {
    sql(`DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(id)}`);
    // Both the person's own notices and the "password changed" notice sent
    // to their admin, which points at them.
    sql(`DELETE FROM "Notification" WHERE "userId" = ${lit(id)} OR "relatedEntityId" = ${lit(id)}`);
    sql(`DELETE FROM "User" WHERE id = ${lit(id)}`);
  }
});

/** 26 Oct (owner): deactivating only signs out and blocks login; desktop alerts come back on reactivation. */
test('deactivate signs out and blocks login; reactivate restores login and keeps their desktop alerts', async ({ request }) => {
  const email = `${fixtureTag().toLowerCase()}@example.com`;
  const hash = sqlValue(`SELECT password FROM "User" WHERE email = ${lit(ACCOUNTS.admin)}`)!;
  const dept = userFixtureIds(ACCOUNTS.user).departmentId;
  const id = sqlValue(
    `INSERT INTO "User" (id, email, password, name, role, "departmentId", "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(email)}, ${lit(hash)}, ${lit(`E2E Deact ${fixtureTag()}`)}, 'USER', ${lit(dept)}, true, now(), now()) RETURNING id`,
  )!;
  sql(`INSERT INTO "PushSubscription" (id, "userId", endpoint, p256dh, auth, "updatedAt")
       VALUES (gen_random_uuid(), ${lit(id)}, ${lit(`https://push.example.com/${id}`)}, 'k', 'a', now())`);
  const canLogin = async () => (await request.post(`${API}/auth/login`, { data: { email, password: 'password123' } })).ok();
  try {
    expect(await canLogin()).toBe(true);
    const token = await tokenFor(request, ACCOUNTS.superAdmin);
    expect((await request.post(`${API}/users/${id}/deactivate`, { headers: auth(token) })).status()).toBe(201);
    expect(await canLogin()).toBe(false);
    expect(sqlValue(`SELECT count(*) FROM "PushSubscription" WHERE "userId" = ${lit(id)}`), 'alerts were switched off').toBe('1');
    expect((await request.post(`${API}/users/${id}/reactivate`, { headers: auth(token) })).status()).toBe(201);
    expect(await canLogin()).toBe(true);
  } finally {
    sql(`DELETE FROM "PushSubscription" WHERE "userId" = ${lit(id)}`);
    sql(`DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(id)}`);
    sql(`DELETE FROM "Notification" WHERE "userId" = ${lit(id)} OR "relatedEntityId" = ${lit(id)}`);
    sql(`DELETE FROM "User" WHERE id = ${lit(id)}`);
  }
});

/**
 * 27 Oct: the Issue slip can allot. Every unit of an item reserved for another
 * project used to mean "queue + raise an indent", then a trip to Allot Items.
 */
test('on screen: the Issue slip frees another project\'s reservation, and the request can then be issued in full', async ({ page }) => {
  const item = createInventoryItemFixture(); // stock 50
  const [p1, p2] = sql(`SELECT id FROM "Project" WHERE "isActive" ORDER BY name LIMIT 2`).map((r) => r[0]!);
  sql(`INSERT INTO "InventoryItemProject" ("inventoryItemId", "projectId", "allottedQty") VALUES (${lit(item.id)}, ${lit(p1)}, 50)`);
  const owner = userFixtureIds(ACCOUNTS.user);
  const serial = fixtureTag();
  const reqId = sqlValue(
    `INSERT INTO "ComponentRequest" (id, "serialNo", "inventoryItemId", "qtyRequested", "qtyIssued", nature,
                                     "durationValue", "durationUnit", status, "departmentId", "createdById", "projectId", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(serial)}, ${lit(item.id)}, 10, 0, 'TEMPORARY', 7, 'DAYS', 'APPROVED',
             ${lit(owner.departmentId)}, ${lit(owner.id)}, ${lit(p2)}, now(), now()) RETURNING id`,
  )!;
  try {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/requests');
    const row = page.getByRole('row', { name: new RegExp(serial) });
    await row.getByRole('button', { name: 'Issue', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(`Out of stock for ${item.name}.`)).toBeVisible();

    await dialog.getByRole('button', { name: /Free up reserved stock/ }).click();
    const p1Name = sqlValue(`SELECT name FROM "Project" WHERE id = ${lit(p1)}`)!;
    const p2Name = sqlValue(`SELECT name FROM "Project" WHERE id = ${lit(p2)}`)!;

    // "Edit numbers": a total over stock is said plainly, never "can then get".
    await dialog.getByRole('button', { name: /Edit numbers/ }).click();
    await dialog.getByLabel(`Allotted to ${p2Name}`).fill('1');
    await expect(dialog.getByText(/That's 1 PCS more than the 50 in stock — lower a number\./)).toBeVisible();
    await expect(dialog.getByText(/This request can then get/)).toHaveCount(0);
    await dialog.getByRole('button', { name: /Hide numbers/ }).click();

    // One click takes exactly what is short — 10 — from the other project into this request's.
    await dialog.getByRole('button', { name: `Move 10 to ${p2Name}` }).click();
    await expect(dialog.getByText('Stock available — full quantity will be issued.')).toBeVisible({ timeout: 15_000 });
    await expect(dialog.getByRole('button', { name: 'Issue 10' })).toBeVisible();
    const allotted = (pid: string) => Number(sqlValue(`SELECT "allottedQty" FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(item.id)} AND "projectId" = ${lit(pid)}`));
    expect(allotted(p1)).toBe(40);
    expect(allotted(p2)).toBe(10);
  } finally {
    sql(`DELETE FROM "Notification" WHERE "relatedEntityId" IN (${lit(reqId)}, ${lit(item.id)})`);
    sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(item.id)}`);
    sql(`DELETE FROM "ComponentRequest" WHERE id = ${lit(reqId)}`);
    sql(`DELETE FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(item.id)}`);
    dropFixtures();
  }
});

/**
 * 27 Oct, production: a feedback screenshot uploaded before the move to S3 is
 * no longer stored. The inbox said "Request failed with status code 404" twice
 * and "Loading attachment…" for ever; it now says what happened.
 */
test('on screen: a feedback attachment whose file is gone says so, instead of a 404 and a spinner', async ({ page }) => {
  const owner = userFixtureIds(ACCOUNTS.user).id;
  const message = `E2E missing attachment ${fixtureTag()}`;
  const id = sqlValue(
    `INSERT INTO "Feedback" (id, message, "attachmentPath", "attachmentMime", status, "createdById", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(message)}, 'uploads/feedback/e2e-gone.png', 'image/png', 'SEEN', ${lit(owner)}, now(), now()) RETURNING id`,
  )!;
  try {
    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/feedback');
    // Seen, as in production — opening a New one moves it to Seen mid-test.
    await page.getByRole('button', { name: 'Seen', exact: true }).click();
    await page.getByText(message).click();
    await expect(page.getByText('The file for this record is no longer stored.')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Request failed with status code 404/)).toHaveCount(0);
  } finally {
    sql(`DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(id)}`);
    sql(`DELETE FROM "Feedback" WHERE id = ${lit(id)}`);
  }
});

/** 27 Oct: every column on Inventory Requests (live and History) can be filtered, like the other tables. */
test('on screen: Inventory Requests History has a filter on every column, and filtering by item narrows the rows', async ({ page }) => {
  await signInAs(page, 'inventory');
  await page.goto('/inventory/requests');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Request History' });
  await expect(dialog.locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
  // Request ID, Item, Qty, Requested by, Accountable, Container, Tray, Location, Project.
  await expect(dialog.locator('thead').getByRole('button', { name: 'Filter this column' })).toHaveCount(9);

  // The item name is the row's first button (it opens the details).
  const itemCell = (row: ReturnType<typeof dialog.locator>) => row.getByRole('button').first();
  const firstItem = (await itemCell(dialog.locator('tbody tr').first()).innerText()).trim();
  const header = dialog.locator('thead th').filter({ hasText: 'Item Name' });
  await header.getByRole('button', { name: 'Filter this column' }).click();
  // The filter's dropdown (the one holding its Search box), not a table row of the same name.
  const dropdown = page.getByPlaceholder('Search...').locator('xpath=ancestor::div[contains(@class, "fixed")][1]');
  await dropdown.getByPlaceholder('Search...').fill(firstItem);
  await dropdown.getByRole('button', { name: firstItem, exact: true }).click();
  await expect(header.getByRole('button', { name: `Filter, currently filtered by ${firstItem}` })).toBeVisible();

  const rows = dialog.locator('tbody tr');
  const n = await rows.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) expect((await itemCell(rows.nth(i)).innerText()).trim()).toBe(firstItem);
});

/**
 * 27 Oct: delete became Archive. Requests with nothing issued are cancelled
 * (a reason is required and the requester and approver are told); issued
 * ones stay open and can still be returned into the archived item.
 */
test('archiving cancels un-issued requests with a reason, keeps issued ones, and a return still lands', async ({ request }) => {
  const item = createInventoryItemFixture();
  const owner = userFixtureIds(ACCOUNTS.user);
  const approver = userFixtureIds(ACCOUNTS.manager);
  const ownerName = sqlValue(`SELECT name FROM "User" WHERE id = ${lit(owner.id)}`)!;
  const pending = createOpenRequestFixture({ itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, status: 'PENDING' });
  const approved = createOpenRequestFixture({ itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, status: 'APPROVED', approvedById: approver.id });
  const loan = createIssuedRequestFixture({ itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, handoverConfirmed: true });
  try {
    const token = await tokenFor(request, ACCOUNTS.inventory);

    const preview = await request.post(`${API}/inventory/archive/preview`, { headers: auth(token), data: { ids: [item.id] } });
    expect(preview.status(), await preview.text()).toBe(201);
    const p = (await preview.json()).data;
    expect(p.toCancel.map((r: any) => r.serialNo).sort()).toEqual([pending.serialNo, approved.serialNo].sort());
    expect(p.staysOpen.map((r: any) => r.serialNo)).toEqual([loan.serialNo]);

    // No reason, nothing changes.
    const bare = await request.post(`${API}/inventory/archive`, { headers: auth(token), data: { ids: [item.id] } });
    expect(bare.status()).toBe(400);
    expect((await bare.json()).message).toContain('Give a reason');
    expect(sqlValue(`SELECT "deletedAt" IS NULL FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('t');

    const res = await request.post(`${API}/inventory/archive`, { headers: auth(token), data: { ids: [item.id], reason: 'Replaced by a better part' } });
    expect(res.status(), await res.text()).toBe(201);
    const body = (await res.json()).data;
    expect(body.archivedCount).toBe(1);
    expect(body.staysOpen).toEqual([loan.serialNo]);

    expect(sqlValue(`SELECT "deletedAt" IS NOT NULL FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('t');
    for (const r of [pending, approved]) {
      expect(sqlValue(`SELECT status::text FROM "ComponentRequest" WHERE id = ${lit(r.id)}`)).toBe('REJECTED');
      expect(sqlValue(`SELECT "rejectionReason" FROM "ComponentRequest" WHERE id = ${lit(r.id)}`)).toContain('Reason: Replaced by a better part');
    }
    expect(sqlValue(`SELECT status::text FROM "ComponentRequest" WHERE id = ${lit(loan.id)}`)).toBe('IN_USE');
    // The requester hears about both; the approver about the one they approved.
    expect(sqlValue(`SELECT count(*) FROM "Notification" WHERE "userId" = ${lit(owner.id)} AND "relatedEntityId" IN (${lit(pending.id)}, ${lit(approved.id)}) AND message LIKE '%Replaced by a better part%'`)).toBe('2');
    expect(sqlValue(`SELECT message FROM "Notification" WHERE "userId" = ${lit(approver.id)} AND "relatedEntityId" = ${lit(approved.id)}`)).toContain(`${ownerName}'s request ${approved.serialNo}`);

    // The issued one still returns, into the archived item.
    const ret = await request.patch(`${API}/requests/${loan.id}/return`, { headers: auth(token), data: { condition: 'Good' } });
    expect(ret.status(), await ret.text()).toBe(200);
    expect(sqlValue(`SELECT stock::int FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('51');
  } finally {
    dropFixtures();
  }
});

/** 27 Oct: adding an item with an archived item's name offers it back instead of a duplicate. */
test('adding an archived name offers unarchive; unarchive adds the stock, "create anyway" makes a new row', async ({ request }) => {
  const item = createInventoryItemFixture();
  const dept = userFixtureIds(ACCOUNTS.user).departmentId;
  // Archived straight in the database: archiving through the API would also
  // notify the department's admins, which is not what this test is about.
  sql(`UPDATE "InventoryItem" SET "departmentId" = ${lit(dept)}, stock = 3, "deletedAt" = now() WHERE id = ${lit(item.id)}`);
  const token = await tokenFor(request, ACCOUNTS.inventory);
  const add = { name: item.name.toUpperCase(), category: 'ELECTRONICS_GENERAL_ACCESSORIES', departmentId: dept, stock: 5, unit: 'PCS' };
  let createdId: string | undefined;
  try {
    const offered = await request.post(`${API}/inventory`, { headers: auth(token), data: add });
    expect(offered.status()).toBe(409);
    const o = await offered.json();
    expect(o.code).toBe('ARCHIVED_MATCH');
    expect(o.data).toMatchObject({ id: item.id, name: item.name, stock: 3, unit: 'PCS' });

    const back = await request.post(`${API}/inventory/${item.id}/unarchive`, { headers: auth(token), data: { addStock: 5 } });
    expect(back.status(), await back.text()).toBe(201);
    expect(sqlValue(`SELECT ("deletedAt" IS NULL)::text || ':' || stock::int FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('true:8');

    // Live again, so the ordinary duplicate rule applies to a second add.
    const dup = await request.post(`${API}/inventory`, { headers: auth(token), data: add });
    expect(dup.status()).toBe(400);

    // Archived again: "create new anyway" makes a separate row.
    sql(`UPDATE "InventoryItem" SET "deletedAt" = now() WHERE id = ${lit(item.id)}`);
    const fresh = await request.post(`${API}/inventory`, { headers: auth(token), data: { ...add, createAnyway: true } });
    expect(fresh.status(), await fresh.text()).toBe(201);
    createdId = (await fresh.json()).data.id;
    expect(createdId).not.toBe(item.id);

    // And the archived one cannot come back over the live twin.
    const blocked = await request.post(`${API}/inventory/${item.id}/unarchive`, { headers: auth(token), data: {} });
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).message).toContain('is already in the inventory list');
  } finally {
    if (createdId) {
      sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(createdId)}`);
      sql(`DELETE FROM "InventoryItem" WHERE id = ${lit(createdId)}`);
    }
    dropFixtures();
  }
});

/** 27 Oct: a spreadsheet row matching an archived item is held back and offered, not duplicated. */
test('bulk upload holds back rows that match archived items, and creates them only when asked', async ({ request }) => {
  const item = createInventoryItemFixture();
  const dept = userFixtureIds(ACCOUNTS.user);
  const deptName = sqlValue(`SELECT name FROM "Department" WHERE id = ${lit(dept.departmentId)}`)!;
  sql(`UPDATE "InventoryItem" SET "departmentId" = ${lit(dept.departmentId)}, "deletedAt" = now() WHERE id = ${lit(item.id)}`);
  const since = sqlValue('SELECT now()::text')!;
  const token = await tokenFor(request, ACCOUNTS.inventory);
  const csv = Buffer.from(`name,stock,unit,department\n${item.name},4,PCS,${deptName}\n`);
  const file = { name: 'archived-match.csv', mimeType: 'text/csv', buffer: csv };
  let createdIds: string[] = [];
  try {
    const first = await request.post(`${API}/inventory/bulk`, { headers: auth(token), multipart: { file } });
    expect(first.status(), await first.text()).toBe(201);
    const f = (await first.json()).data;
    expect(f.successCount).toBe(0);
    expect(f.archivedMatches).toHaveLength(1);
    expect(f.archivedMatches[0]).toMatchObject({ row: 2, name: item.name, stock: 4, archived: { id: item.id } });

    const second = await request.post(`${API}/inventory/bulk`, { headers: auth(token), multipart: { file, onlyRows: '2', createAnyway: 'true' } });
    const s = (await second.json()).data;
    expect(s.successCount, JSON.stringify(s)).toBe(1);
    createdIds = s.createdIds;
    expect(createdIds[0]).not.toBe(item.id);
  } finally {
    for (const id of createdIds) {
      sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(id)}`);
      sql(`DELETE FROM "InventoryItem" WHERE id = ${lit(id)}`);
    }
    sql(`DELETE FROM "UploadBatch" WHERE "createdAt" >= ${lit(since)}`);
    dropFixtures();
  }
});

/** 27 Oct: on screen — archive from the table, see what stays open, then unarchive from Archived items. */
test('on screen: archive an item that is still out, then unarchive it', async ({ page }) => {
  const item = createInventoryItemFixture();
  const owner = userFixtureIds(ACCOUNTS.user);
  const loan = createIssuedRequestFixture({ itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, handoverConfirmed: true });
  try {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    await page.getByPlaceholder('Search components...').fill(item.name);
    const row = page.locator('tbody tr').filter({ hasText: item.name });
    await row.getByRole('button', { name: 'Archive this item' }).click();

    const dialog = page.getByRole('dialog', { name: `Archive "${item.name}"?` });
    await expect(dialog.getByText('Already issued — this stays open and finishes as usual:')).toBeVisible();
    // The request number links to its story.
    await expect(dialog.getByRole('link', { name: loan.serialNo })).toHaveAttribute('href', `/inventory/history?componentRequestId=${loan.id}`);
    await dialog.getByRole('button', { name: 'Archive', exact: true }).click();
    // The toast sets its first clause as a headline and the rest beneath it.
    await expect(page.getByRole('status').filter({ hasText: loan.serialNo })).toContainText(`${loan.serialNo} still open`);
    await expect(row).toHaveCount(0);
    expect(sqlValue(`SELECT status::text FROM "ComponentRequest" WHERE id = ${lit(loan.id)}`)).toBe('IN_USE');

    await page.getByRole('button', { name: 'Archived items' }).click();
    const bin = page.getByRole('dialog', { name: 'Archived items' });
    await bin.getByPlaceholder('Search archived items by name…').fill(item.name);
    await bin.getByPlaceholder('Search archived items by name…').press('Enter');
    await bin.locator('tr').filter({ hasText: item.name }).getByRole('button', { name: 'Unarchive' }).click();
    await expect(page.getByText(`"${item.name}" unarchived`)).toBeVisible();
    expect(sqlValue(`SELECT "deletedAt" IS NULL FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('t');
  } finally {
    dropFixtures();
  }
});

/** 27 Oct: Issue Slips filters every data column, live and History, like Inventory Requests. */
test('on screen: Issue Slips has a filter on every column, and filtering by Request ID narrows to that slip', async ({ page }) => {
  const item = createInventoryItemFixture();
  const owner = userFixtureIds(ACCOUNTS.user);
  // Two unconfirmed handovers, so the live table has rows to narrow.
  const a = createIssuedRequestFixture({ itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, handoverConfirmed: false });
  createIssuedRequestFixture({ itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, handoverConfirmed: false });
  try {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/issue-slips');
    const live = page.locator('table').filter({ has: page.locator('thead', { hasText: 'Accountable' }) }).first();
    await expect(live.locator('tbody tr').first()).toBeVisible({ timeout: 20_000 });
    // Request ID, Issued To, Department, Accountable, Date.
    await expect(live.locator('thead').getByRole('button', { name: 'Filter this column' })).toHaveCount(5);

    const header = live.locator('thead th').filter({ hasText: 'Request ID' });
    await header.getByRole('button', { name: 'Filter this column' }).click();
    const dropdown = page.getByPlaceholder('Search...').locator('xpath=ancestor::div[contains(@class, "fixed")][1]');
    await dropdown.getByPlaceholder('Search...').fill(a.serialNo);
    await dropdown.getByRole('button', { name: a.serialNo, exact: true }).click();
    await expect(live.locator('tbody tr')).toHaveCount(1);
    await expect(live.locator('tbody tr').first()).toContainText(a.serialNo);

    await page.getByRole('button', { name: 'History', exact: true }).click();
    const history = page.getByRole('dialog', { name: /Issue History/ });
    // Request ID, Issued To, Department, Issued Date, Confirmed At, Status.
    await expect(history.locator('thead').getByRole('button', { name: 'Filter this column' })).toHaveCount(6);
  } finally {
    dropFixtures();
  }
});

/** 27 Oct: Component Database filters Item Name too, across the whole catalogue (server side). */
test('the inventory list filters by exact item name, and the name is offered as a filter option', async ({ request }) => {
  const item = createInventoryItemFixture();
  try {
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const opts = (await (await request.get(`${API}/inventory/filter-options`, { headers: auth(token) })).json()).data;
    expect(opts.names).toContain(item.name);
    const res = await request.get(`${API}/inventory`, { headers: auth(token), params: { name: item.name } });
    const body = (await res.json()).data;
    expect(body.items.map((i: any) => i.id)).toEqual([item.id]);
    expect(body.total).toBe(1);
  } finally {
    dropFixtures();
  }
});

/** 27 Oct: a delivery for an archived item asks first, then brings the item back with the stock. */
test('receiving a delivery for an archived item asks first, then unarchives it and adds the stock', async ({ request }) => {
  const owner = userFixtureIds(ACCOUNTS.user);
  const item = createInventoryItemFixture(); // stock 50
  sql(`UPDATE "InventoryItem" SET "departmentId" = ${lit(owner.departmentId)}, "deletedAt" = now() WHERE id = ${lit(item.id)}`);
  const ind = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'ORDERED' });
  try {
    const line = sqlValue(`SELECT id FROM "IndentItem" WHERE "indentId" = ${lit(ind.id)}`)!;
    sql(`UPDATE "IndentItem" SET qty = 4 WHERE id = ${lit(line)}`);
    sql(`INSERT INTO "VendorOrder" (id, "indentId", "vendorName", amount, currency, status, "createdAt", "updatedAt") VALUES (gen_random_uuid(), ${lit(ind.id)}, 'E2E Vendor', 100, 'INR', 'RECEIVED', now(), now())`);
    sql(`INSERT INTO "VendorAllocation" (id, "indentId", "indentItemId", "vendorName", "allocatedQty", "createdAt") VALUES (gen_random_uuid(), ${lit(ind.id)}, ${lit(line)}, 'E2E Vendor', 4, now())`);
    const inv = await tokenFor(request, ACCOUNTS.inventory);
    const receive = (archived?: string) => request.post(`${API}/inventory/receive-indent`, {
      headers: auth(inv),
      data: { indentId: ind.id, vendorName: 'E2E Vendor', items: [{ indentItemId: line, name: item.name, qty: 4, unit: 'PCS' }], ...(archived ? { archived } : {}) },
    });

    // Asked, and nothing booked.
    const asked = await receive();
    expect(asked.status()).toBe(409);
    const a = await asked.json();
    expect(a.code).toBe('ARCHIVED_ON_RECEIVE');
    expect(a.data.items[0].archived.id).toBe(item.id);
    expect(sqlValue(`SELECT status::text FROM "Indent" WHERE id = ${lit(ind.id)}`)).toBe('ORDERED');

    const done = await receive('unarchive');
    expect(done.status(), await done.text()).toBe(201);
    expect(sqlValue(`SELECT ("deletedAt" IS NULL)::text || ':' || stock::int FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('true:54');
    expect(sqlValue(`SELECT count(*) FROM "InventoryItem" WHERE name = ${lit(item.name)}`)).toBe('1');
  } finally {
    sql(`DELETE FROM "Notification" WHERE "relatedEntityId" IN (${lit(item.id)}, ${lit(ind.id)})`);
    dropFixtures();
  }
});

/** 27 Oct: per-vendor shipping sits next to GST, is added after it untaxed, and is what Finance pays. */
test('shipping is saved per vendor, counts in the indent total, and lands on the vendor order once', async ({ request }) => {
  const owner = userFixtureIds(ACCOUNTS.user);
  const ind = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'APPROVED' });
  try {
    const line = sqlValue(`SELECT id FROM "IndentItem" WHERE "indentId" = ${lit(ind.id)}`)!;
    sql(`UPDATE "IndentItem" SET qty = 2 WHERE id = ${lit(line)}`);
    const proc = await tokenFor(request, ACCOUNTS.procurement);
    const vendor = 'E2E Ship Vendor';
    // Two lines from one vendor (an item split 1 + 1), each carrying the vendor's 18% GST and ₹150 shipping.
    const row = { indentItemId: line, vendorName: vendor, allocatedQty: 1, unitPrice: 500, currency: 'INR', gstPercentage: 18, shippingCost: 150 };
    const saved = await request.post(`${API}/indents/${ind.id}/allocations`, { headers: auth(proc), data: { allocations: [row, row] } });
    expect(saved.status(), await saved.text()).toBe(201);
    // 1000 subtotal + 180 GST + 150 shipping, once.
    expect(Number(sqlValue(`SELECT "grandTotal" FROM "Indent" WHERE id = ${lit(ind.id)}`))).toBe(1330);
    expect(sqlValue(`SELECT string_agg(DISTINCT "shippingCost"::text, ',') FROM "VendorAllocation" WHERE "indentId" = ${lit(ind.id)}`)).toBe('150.00');

    // Firm quote approved (the state the approval flow leaves it in), then hand it to Finance.
    sql(`UPDATE "Indent" SET status = 'READY_FOR_PAYMENT', "techApprovedAtAmount" = 1330 WHERE id = ${lit(ind.id)}`);
    const sent = await request.post(`${API}/indents/${ind.id}/send-to-finance`, {
      headers: auth(proc), data: { vendors: [{ vendorName: vendor, currency: 'INR', paymentMethod: 'ONLINE' }] },
    });
    expect(sent.status(), await sent.text()).toBe(201);
    const order = sql(`SELECT amount::float8, "gstAmount"::float8, "shippingAmount"::float8 FROM "VendorOrder" WHERE "indentId" = ${lit(ind.id)}`);
    expect(order).toHaveLength(1);
    expect(order[0].map(Number)).toEqual([1330, 180, 150]);
  } finally {
    sql(`DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(ind.id)}`);
    dropFixtures();
  }
});

// "Restore files only" sent the literal body `null`, which the JSON parser
// rejects. The rejection went out without CORS headers, so the browser hid it
// and the app said "Can't reach the server" with the server up the whole time.
test('a body the server rejects still carries CORS, so the app shows the real error', async ({ request }) => {
  const origin = 'http://localhost:5174';
  const res = await request.post(`${API}/auth/login`, {
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    data: 'null',
  });
  expect(res.status()).toBe(400);
  expect(res.headers()['access-control-allow-origin']).toBe(origin);
});

/**
 * 28 Oct: the Returns desk showed REQ-016 as Dishant's when dhilipraj — a
 * second responsible person on it — had asked for the return, and gave no
 * time. It now says who asked and when, names everyone on the request, and
 * puts asked-for returns first, oldest ask on top.
 */
test('on screen: Returns shows who asked for a return and when, and everyone holding it', async ({ page, request }) => {
  const item = createInventoryItemFixture();
  const raiser = userFixtureIds(ACCOUNTS.manager);
  const asker = userFixtureIds(ACCOUNTS.user);
  const loan = createIssuedRequestFixture({ itemId: item.id, createdById: raiser.id, departmentId: raiser.departmentId, handoverConfirmed: true });
  sql(`INSERT INTO "RequestResponsiblePerson" ("requestId", "userId") VALUES (${lit(loan.id)}, ${lit(raiser.id)}), (${lit(loan.id)}, ${lit(asker.id)})`);
  const askerName = sqlValue(`SELECT name FROM "User" WHERE id = ${lit(asker.id)}`)!;
  const raiserName = sqlValue(`SELECT name FROM "User" WHERE id = ${lit(raiser.id)}`)!;
  try {
    const res = await request.post(`${API}/requests/${loan.id}/initiate-return`, {
      headers: auth(await tokenFor(request, ACCOUNTS.user)), data: { condition: 'Working' } });
    expect(res.status(), await res.text()).toBe(201);

    const list = await request.get(`${API}/requests?awaitingReturn=true&take=200`, { headers: auth(await tokenFor(request, ACCOUNTS.inventory)) });
    const row = ((await list.json()).data?.items ?? []).find((r: any) => r.id === loan.id);
    expect(row?.returnRequest?.byName, 'who asked').toBe(askerName);
    expect(row?.returnRequest?.at, 'when').toBeTruthy();

    await signInAs(page, 'inventory');
    await page.goto('/inventory/returns');
    await page.getByPlaceholder(/Search by item or request ID/).fill(loan.serialNo);
    const line = page.getByRole('row', { name: new RegExp(loan.serialNo) });
    await expect(line).toContainText(raiserName, { timeout: 20_000 });
    await expect(line).toContainText(`with ${askerName}`);
    await expect(line).toContainText(`by ${askerName}`);
  } finally {
    dropFixtures();
  }
});

/**
 * 29 Oct: stock taken without a request (the CEO, an admin) was reduced by
 * typing a new number, and Item History said only "10 → 7". Stock now changes
 * one way — the number opens Adjust Stock, which needs a reason — and the
 * server refuses a bare change from anywhere else.
 */
test('a stock change always carries a reason, and Item History keeps it', async ({ page, request }) => {
  const item = createInventoryItemFixture(); // stock 50
  try {
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const bare = await request.patch(`${API}/inventory/${item.id}`, { headers: auth(token), data: { stock: 47 } });
    expect(bare.status(), 'no reason, no change').toBe(400);
    expect(Number(sqlValue(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(item.id)}`))).toBe(50);
    // Saving other fields with the same count needs no reason.
    const same = await request.patch(`${API}/inventory/${item.id}`, { headers: auth(token), data: { stock: 50, rackAddress: 'E2E-R1' } });
    expect(same.status(), await same.text()).toBe(200);

    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    await page.getByPlaceholder(/Search/).first().fill(item.name);
    const row = page.getByRole('row', { name: new RegExp(item.name) });
    await expect(row.getByRole('button', { name: 'Edit value' }).filter({ hasText: '50' }), 'no pencil on the count').toHaveCount(0);
    await row.getByRole('button', { name: /Adjust stock of/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Adjust Stock' });
    await dialog.getByRole('button', { name: /Remove/ }).click();
    await dialog.getByPlaceholder('0').fill('3');
    await dialog.getByPlaceholder(/physical count correction/).fill('Taken by the CEO for a demo');
    await dialog.getByRole('button', { name: 'Save Adjustment' }).click();

    await expect.poll(() => sqlValue(`SELECT stock::int::text FROM "InventoryItem" WHERE id = ${lit(item.id)}`), { timeout: 15_000 }).toBe('47');
    expect(sqlValue(`SELECT notes FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(item.id)} AND "eventType" = 'ADJUSTMENT' ORDER BY "createdAt" DESC LIMIT 1`))
      .toBe('Taken by the CEO for a demo');
  } finally {
    dropFixtures();
  }
});

/**
 * 4 Nov: a removal bigger than the unallotted stock sent the clerk to Allot
 * Items first. Adjust Stock now asks which share it comes from — the pool or
 * a named project — and that project's allotment goes down with the stock.
 */
test('on screen: Adjust Stock takes a removal from a chosen project, and Item History names it', async ({ page, request }) => {
  const item = createInventoryItemFixture(); // stock 50
  const project = sql(`SELECT id, name FROM "Project" WHERE "isActive" ORDER BY name LIMIT 1`)[0];
  sql(`INSERT INTO "InventoryItemProject" ("inventoryItemId", "projectId", "allottedQty") VALUES (${lit(item.id)}, ${lit(project[0]!)}, 48)`);
  try {
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const pool = await request.post(`${API}/inventory/${item.id}/adjust`, { headers: auth(token), data: { quantityChange: -5, reason: 'E2E' } });
    expect(pool.status(), 'only 2 are unallotted').toBe(400);
    expect((await pool.json()).message).toContain('Choose the project to take it from');

    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    await page.getByPlaceholder(/Search/).first().fill(item.name);
    await page.getByRole('row', { name: new RegExp(item.name) }).getByRole('button', { name: /Adjust stock of/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Adjust Stock' });
    await dialog.getByRole('button', { name: /Remove/ }).click();
    await dialog.getByPlaceholder('0').fill('5');
    await expect(dialog.getByText('2 free')).toBeVisible();
    await dialog.getByRole('radio', { name: new RegExp(project[1]!) }).check();
    await dialog.getByPlaceholder(/physical count correction/).fill('Taken by the CEO for a demo');
    await dialog.getByRole('button', { name: 'Save Adjustment' }).click();

    await expect.poll(() => sqlValue(`SELECT stock::int::text FROM "InventoryItem" WHERE id = ${lit(item.id)}`), { timeout: 15_000 }).toBe('45');
    expect(sqlValue(`SELECT "allottedQty"::int::text FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(item.id)}`)).toBe('43');
    expect(sqlValue(`SELECT notes FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(item.id)} AND "eventType" = 'ADJUSTMENT' ORDER BY "createdAt" DESC LIMIT 1`))
      .toBe(`Taken by the CEO for a demo — taken from ${project[1]}'s allotment (48 → 43 PCS)`);
  } finally {
    dropFixtures();
  }
});
