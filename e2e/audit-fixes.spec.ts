import { test, expect, APIRequestContext } from '@playwright/test';
import { ACCOUNTS, signInAs } from './helpers/auth';
import { sql, sqlValue, lit, createIndentFixture, dropFixtures, userFixtureIds } from './helpers/db';

/**
 * The 22 October audit, one check per fix, against the running API.
 *
 * Each of these was a real disagreement between what a screen offered and
 * what the server did, or a server answer that was simply wrong. They are
 * checked at the API where that is the thing that was broken, and on screen
 * where the screen was.
 */

const API = 'http://localhost:3001/api';

const tokenFor = async (request: APIRequestContext, email: string) => {
  const res = await request.post(`${API}/auth/login`, { data: { email, password: 'password123' } });
  expect(res.ok(), `could not sign in as ${email}`).toBeTruthy();
  const body = await res.json();
  return {
    access: (body.accessToken ?? body.data?.accessToken) as string,
    refresh: (body.refreshToken ?? body.data?.refreshToken) as string,
  };
};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const data = async (res: any) => { const j = await res.json().catch(() => ({})); return j.data ?? j; };

/** Indents this file raised through the API, removed child-first at the end. */
const raised: string[] = [];
const dropRaised = () => {
  const ids = raised.splice(0);
  if (!ids.length) return;
  const list = ids.map(lit).join(', ');
  for (const stmt of [
    `DELETE FROM "Notification" WHERE "relatedEntityId" IN (${list})`,
    `DELETE FROM "ApprovalHistory" WHERE "entityId" IN (${list})`,
    `DELETE FROM "IndentStatusLog" WHERE "indentId" IN (${list})`,
    `DELETE FROM "IndentResponsiblePerson" WHERE "indentId" IN (${list})`,
    `DELETE FROM "IndentItem" WHERE "indentId" IN (${list})`,
    `DELETE FROM "Indent" WHERE id IN (${list})`,
  ]) sql(stmt);
};

test.describe('audit fixes (22 Oct)', () => {
  test.afterEach(() => { dropRaised(); dropFixtures(); });

  test('payment receipts are scoped: an Associate Finance user not assigned the indent gets 404', async ({ request }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'AWAITING_PAYMENT' });
    const af = await tokenFor(request, ACCOUNTS.associateFinance);
    const res = await request.get(`${API}/indents/${indent.id}/payment-receipts`, { headers: auth(af.access) });
    expect(res.status(), 'an unassigned Associate Finance user could list the receipts').toBe(404);
    // Finance still can.
    const fin = await tokenFor(request, ACCOUNTS.finance);
    expect((await request.get(`${API}/indents/${indent.id}/payment-receipts`, { headers: auth(fin.access) })).status()).toBe(200);
  });

  test('Associate Finance can see an indent it raised itself', async ({ request }) => {
    const af = await tokenFor(request, ACCOUNTS.associateFinance);
    const afId = sqlValue(`SELECT id FROM "User" WHERE email = ${lit(ACCOUNTS.associateFinance)}`)!;
    const deptId = sqlValue(`SELECT id FROM "Department" ORDER BY name LIMIT 1`)!;
    const res = await request.post(`${API}/indents`, {
      headers: auth(af.access),
      data: { emergency: false, departmentId: deptId, currency: 'INR', responsiblePersonIds: [afId],
        items: [{ name: 'E2E AF own indent', qty: 1, unit: 'NOS', unitAmount: 10, currency: 'INR', purpose: 'e2e' }] },
    });
    expect(res.status(), 'Associate Finance could not raise an indent').toBe(201);
    const indent = await data(res);
    raised.push(indent.id);
    const mine = await data(await request.get(`${API}/indents?createdByMe=true&take=50`, { headers: auth(af.access) }));
    expect((mine.items ?? mine).some((i: any) => i.id === indent.id), 'the raised indent is missing from "My indents"').toBe(true);
    expect((await request.get(`${API}/indents/${indent.id}`, { headers: auth(af.access) })).status(), 'opening it 404d').toBe(200);
  });

  test('indent quantities may be decimal (two places), not three', async ({ request }) => {
    const user = await tokenFor(request, ACCOUNTS.user);
    const me = userFixtureIds(ACCOUNTS.user);
    const body = (qty: number) => ({ emergency: false, departmentId: me.departmentId, currency: 'INR', responsiblePersonIds: [me.id],
      items: [{ name: 'E2E cable', qty, unit: 'M', unitAmount: 40, currency: 'INR', purpose: 'e2e' }] });
    const ok = await request.post(`${API}/indents`, { headers: auth(user.access), data: body(0.5) });
    expect(ok.status(), '0.5 m was refused').toBe(201);
    raised.push((await data(ok)).id);
    const bad = await request.post(`${API}/indents`, { headers: auth(user.access), data: body(0.555) });
    expect(bad.status(), 'three decimal places were accepted').toBe(400);
  });

  test('an asset can be recorded with just a name, category and department', async ({ request }) => {
    const fin = await tokenFor(request, ACCOUNTS.finance);
    const deptId = sqlValue(`SELECT id FROM "Department" ORDER BY name LIMIT 1`)!;
    const res = await request.post(`${API}/fixed-assets`, {
      headers: auth(fin.access),
      data: { name: `E2E asset ${Date.now()}`, category: 'COMPUTERS_IT', departmentId: deptId },
    });
    const asset = await data(res);
    try {
      expect(res.status(), `asset without value/date was refused: ${JSON.stringify(asset).slice(0, 200)}`).toBe(201);
      expect(asset.purchaseValue ?? null).toBeNull();
    } finally {
      if (asset?.id) {
        for (const t of ['FixedAssetEvent', 'FixedAssetMaintenance']) { // custom values cascade
          sql(`DELETE FROM "${t}" WHERE "fixedAssetId" = ${lit(asset.id)}`);
        }
        sql(`DELETE FROM "FixedAsset" WHERE id = ${lit(asset.id)}`);
      }
    }
  });

  test('search: "100uf" finds the µF part, "req001" finds REQ-001, a department name finds its indents', async ({ request }) => {
    const sa = await tokenFor(request, ACCOUNTS.superAdmin);
    const micro = sqlValue(`SELECT name FROM "InventoryItem" WHERE name LIKE '%µF%' AND "deletedAt" IS NULL LIMIT 1`);
    if (micro) {
      // "100 µF ±20%…" → typed the way people type it: "100uf".
      const term = (micro.match(/[\d.]+\s*µF/i)?.[0] ?? 'µF').replace(/\s+/g, '').replace('µ', 'u').toLowerCase();
      const inv = await data(await request.get(`${API}/inventory?search=${encodeURIComponent(term)}&take=50`, { headers: auth(sa.access) }));
      expect((inv.items ?? inv).some((i: any) => i.name === micro), `"${term}" did not find "${micro}"`).toBe(true);
    }
    const req = sqlValue(`SELECT "serialNo" FROM "ComponentRequest" WHERE "serialNo" ~ '^REQ-0*[0-9]+$' AND "deletedAt" IS NULL ORDER BY "createdAt" LIMIT 1`);
    if (req) {
      const typed = req.replace('-', '').toLowerCase();
      const r = await data(await request.get(`${API}/requests?search=${typed}&take=50`, { headers: auth(sa.access) }));
      expect((r.items ?? r).some((x: any) => x.serialNo === req), `"${typed}" did not find ${req}`).toBe(true);
    }
    const owner = userFixtureIds(ACCOUNTS.user);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId });
    const deptName = sqlValue(`SELECT name FROM "Department" WHERE id = ${lit(owner.departmentId)}`)!;
    const ind = await data(await request.get(`${API}/indents?search=${encodeURIComponent(deptName)}&take=200`, { headers: auth(sa.access) }));
    expect((ind.items ?? ind).some((i: any) => i.id === indent.id), `searching "${deptName}" missed an indent in that department`).toBe(true);
  });

  test('"My history" export holds only my indents', async ({ request }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const someoneElse = userFixtureIds(ACCOUNTS.manager);
    const theirs = createIndentFixture({ createdById: someoneElse.id, departmentId: owner.departmentId, status: 'REJECTED' });
    const mine = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'REJECTED' });
    const user = await tokenFor(request, ACCOUNTS.user);
    const today = new Date().toISOString().slice(0, 10);
    const res = await request.get(`${API}/indents/export?format=csv&from=${today}&till=${today}&status=REJECTED&who=mine`, { headers: auth(user.access) });
    expect(res.status()).toBe(200);
    const csv = await res.text();
    expect(csv, 'my own indent is missing from my export').toContain(mine.serialNo);
    expect(csv, "a colleague's indent leaked into my export").not.toContain(theirs.serialNo);
  });

  test('spend tiles convert currencies to rupees', async ({ request }) => {
    const fin = await tokenFor(request, ACCOUNTS.finance);
    const before = (await data(await request.get(`${API}/indents/finance-summary`, { headers: auth(fin.access) }))).aggregates.pipeline;
    const owner = userFixtureIds(ACCOUNTS.user);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, grandTotal: 100 });
    sql(`UPDATE "Indent" SET currency = 'USD' WHERE id = ${lit(indent.id)}`);
    const after = (await data(await request.get(`${API}/indents/finance-summary`, { headers: auth(fin.access) }))).aggregates.pipeline;
    expect(after - before, 'USD 100 was added to the ₹ tile as ₹100').toBeGreaterThan(1000);
  });

  test('logging out ends the session even when the access token is no longer sent', async ({ request }) => {
    const t = await tokenFor(request, ACCOUNTS.user);
    const out = await request.post(`${API}/auth/logout`, { data: { refreshToken: t.refresh } });
    expect(out.ok(), `logout without an access token was refused (${out.status()})`).toBeTruthy();
    const again = await request.post(`${API}/auth/refresh`, { data: { refreshToken: t.refresh } });
    expect(again.status(), 'the refresh token still worked after logging out').toBe(401);
  });

  test('Finance does not see the BOM Lists button; a User does', async ({ page }) => {
    await signInAs(page, 'finance');
    await page.goto('/finance/inventory-items');
    await expect(page.getByRole('heading', { name: 'Inventory Items' })).toBeVisible({ timeout: 25_000 });
    await expect(page.getByRole('button', { name: /^Lists/ }), 'Finance was offered BOM Lists').toHaveCount(0);
    await signInAs(page, 'user');
    await expect(page.getByRole('button', { name: /^Lists/ }).first(), 'a User lost the BOM Lists button').toBeVisible({ timeout: 25_000 });
  });

  test('column filters see past page one (Super Admin users, Department filter)', async ({ page }) => {
    // The department with the most people, counted the way the column shows
    // them: a user's own department, or — for admins and lab users — every
    // department they cover.
    const dept = sql(
      `SELECT d.name, count(DISTINCT u.id) FROM "Department" d
         JOIN "User" u ON u."deletedAt" IS NULL AND (
              (u.role NOT IN ('ADMIN','LAB') AND u."departmentId" = d.id)
           OR (u.role IN ('ADMIN','LAB') AND EXISTS (SELECT 1 FROM "AdminDepartment" ad WHERE ad."userId" = u.id AND ad."departmentId" = d.id)))
        GROUP BY d.name ORDER BY count(DISTINCT u.id) DESC LIMIT 1`,
    )[0];
    const total = Number(sqlValue(`SELECT count(*) FROM "User" WHERE "deletedAt" IS NULL`));
    test.skip(total <= 10, 'every user fits on one page — nothing to prove here');
    const expected = Number(dept[1]);
    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/users');
    const header = page.getByRole('columnheader', { name: /Dep/ }).first();
    await expect(header).toBeVisible({ timeout: 25_000 });
    // Let every page of users arrive first — the dropdown re-renders as rows
    // land, and an option clicked mid-load is detached under the pointer.
    await expect(page.locator('tbody tr')).toHaveCount(10, { timeout: 25_000 });
    await page.waitForLoadState('networkidle');
    await header.getByRole('button', { name: /Filter/ }).click();
    await page.getByRole('button', { name: dept[0]!, exact: true }).last().click();
    await expect.poll(async () => page.locator('tbody tr').count(), { timeout: 15_000, message: `the ${dept[0]} filter did not show all ${expected} users` })
      .toBe(Math.min(expected, 10));
  });
});
