import { test, expect, APIRequestContext } from '@playwright/test';
import { ACCOUNTS, signInAs } from './helpers/auth';
import { sql, sqlValue, lit, createIndentFixture, createInventoryItemFixture, createIssuedRequestFixture, createOpenRequestFixture, dropFixtures, fixtureTag, userFixtureIds } from './helpers/db';

/**
 * Review fixes, 28 Oct — inventory, requests and disposition. One check per
 * finding, against the running API (and the screen where the bug was on it).
 * Needs migration 20261028120000_upload_undone_marker applied.
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

/** Children of the indents a test made: receiving writes events, status logs and notices against them. */
const indentIds: string[] = [];
const dropIndentChildren = () => {
  const ids = indentIds.splice(0);
  if (!ids.length) return;
  const list = ids.map(lit).join(', ');
  sql(`UPDATE "ComponentRequest" SET "backorderIndentId" = NULL WHERE "backorderIndentId" IN (${list})`);
  sql(`DELETE FROM "InventoryEvent" WHERE "indentId" IN (${list})`);
  sql(`DELETE FROM "IndentStatusLog" WHERE "indentId" IN (${list})`);
  sql(`DELETE FROM "Notification" WHERE "relatedEntityId" IN (${list})`);
  // "Indent received — <serial>" points at the ITEM it landed on, not the indent.
  sql(`DELETE FROM "Notification" WHERE "relatedEntityType" = 'INVENTORY_ITEM_AVAILABLE'
         AND title IN (SELECT 'Indent received — ' || "serialNo" FROM "Indent" WHERE id IN (${list}))`);
};

/** Items a test made through the app (uploads, "create new") — not in dropFixtures' list. */
const appItems: string[] = [];
const dropAppItems = () => {
  const ids = appItems.splice(0);
  if (!ids.length) return;
  const list = ids.map(lit).join(', ');
  sql(`UPDATE "IndentItem" SET "inventoryItemId" = NULL WHERE "inventoryItemId" IN (${list})`);
  sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" IN (${list})`);
  sql(`DELETE FROM "CustomColumnValue" WHERE "inventoryItemId" IN (${list})`);
  sql(`DELETE FROM "InventoryItem" WHERE id IN (${list})`);
};

/** Upload batches and the "upload undone" notice to department admins, both written after `since`. */
const dropUploadLeftovers = (since: string) => {
  sql(`DELETE FROM "UploadBatch" WHERE "createdAt" >= ${lit(since)}`);
  sql(`DELETE FROM "Notification" WHERE "createdAt" >= ${lit(since)} AND "relatedEntityType" = 'INVENTORY_ITEM' AND title LIKE '%upload undone%'`);
};

const deptOf = (email: string) => {
  const d = userFixtureIds(email).departmentId;
  return { id: d, name: sqlValue(`SELECT name FROM "Department" WHERE id = ${lit(d)}`)! };
};

test.describe('review fixes: inventory (28 Oct)', () => {
  test.afterEach(() => { dropIndentChildren(); dropAppItems(); dropFixtures(); });

  // ---------------------------------------------------------------- #1

  test('an undone upload counts as never created: not archived, not offered back, re-upload makes it fresh', async ({ request }) => {
    const since = sqlValue('SELECT now()::text')!;
    const dept = deptOf(ACCOUNTS.user);
    const name = `${fixtureTag()} undo part`;
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const sheet = (qty: number) => ({ name: 'undo.csv', mimeType: 'text/csv', buffer: Buffer.from(`name,stock,unit,department\n${name},${qty},PCS,${dept.name}\n`) });
    try {
      const first = await data(await request.post(`${API}/inventory/bulk`, { headers: auth(token), multipart: { file: sheet(4) } }));
      expect(first.successCount, JSON.stringify(first)).toBe(1);
      const oldId = first.createdIds[0] as string;
      appItems.push(oldId);

      const undo = await request.post(`${API}/inventory/undo-batch/${first.batchId}`, { headers: auth(token) });
      expect(undo.status(), await undo.text()).toBe(201);
      expect(sqlValue(`SELECT ("deletedAt" IS NOT NULL AND "uploadUndoneAt" IS NOT NULL)::text FROM "InventoryItem" WHERE id = ${lit(oldId)}`)).toBe('true');

      // Not in Archived items, and cannot be brought back through it.
      const bin = await data(await request.get(`${API}/inventory/deleted?search=${encodeURIComponent(name)}`, { headers: auth(token) }));
      expect((bin.items ?? bin).length).toBe(0);
      expect((await request.post(`${API}/inventory/${oldId}/unarchive`, { headers: auth(token), data: { addStock: 1 } })).status()).toBe(404);
      expect((await data(await request.post(`${API}/inventory/bulk-restore`, { headers: auth(token), data: { ids: [oldId] } }))).restoredCount).toBe(0);

      // The same sheet again, different number: created fresh with the sheet's figure.
      const again = await data(await request.post(`${API}/inventory/bulk`, { headers: auth(token), multipart: { file: sheet(9) } }));
      expect(again.archivedMatches, JSON.stringify(again)).toEqual([]);
      expect(again.successCount).toBe(1);
      const newId = again.createdIds[0] as string;
      appItems.push(newId);
      expect(newId).not.toBe(oldId);
      expect(sqlValue(`SELECT stock::int FROM "InventoryItem" WHERE id = ${lit(newId)}`)).toBe('9');
    } finally {
      dropUploadLeftovers(since);
    }
  });

  test('on screen: Undo Upload, then the same sheet again, adds the items without an "archived" question', async ({ page }) => {
    const since = sqlValue('SELECT now()::text')!;
    const dept = deptOf(ACCOUNTS.user);
    const name = `${fixtureTag()} undo screen`;
    const file = { name: 'undo-screen.csv', mimeType: 'text/csv', buffer: Buffer.from(`name,stock,unit,department\n${name},5,PCS,${dept.name}\n`) };
    const rows = () => sql(`SELECT id, ("deletedAt" IS NULL)::text, coalesce(("uploadUndoneAt" IS NOT NULL)::text, 'false') FROM "InventoryItem" WHERE name = ${lit(name)} ORDER BY "createdAt"`);
    try {
      await signInAs(page, 'inventory');
      await page.goto('/inventory/components');
      await page.getByRole('button', { name: /^Bulk Upload$/ }).click();
      await page.getByRole('dialog').locator('input[type="file"]').setInputFiles(file);
      await expect.poll(() => rows().length, { timeout: 30_000 }).toBe(1);
      appItems.push(rows()[0][0]!);

      await page.getByRole('button', { name: /^Undo Upload$/ }).click();
      await expect.poll(() => rows()[0][1], { timeout: 30_000 }).toBe('false');
      expect(rows()[0][2]).toBe('true');

      await page.getByRole('button', { name: /^Bulk Upload$/ }).click();
      await page.getByRole('dialog').locator('input[type="file"]').setInputFiles(file);
      await expect.poll(() => rows().length, { timeout: 30_000 }).toBe(2);
      appItems.push(rows()[1][0]!);
      expect(rows()[1][1]).toBe('true');
      await expect(page.getByRole('dialog', { name: /match(es)? an? archived item/ })).toHaveCount(0);
    } finally {
      dropUploadLeftovers(since);
    }
  });

  // ---------------------------------------------------------------- #2

  test('on screen: the dispositioned counter is right before History is opened', async ({ page, request }) => {
    const item = createInventoryItemFixture();
    const owner = userFixtureIds(ACCOUNTS.user);
    const loan = createIssuedRequestFixture({ itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, handoverConfirmed: true });
    sql(`UPDATE "ComponentRequest" SET disposition = 'CONSUMED', "dispositionDate" = now() WHERE id = ${lit(loan.id)}`);
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const terminal = 'EMBEDDED,CONSUMED,DAMAGED,DISPOSED,LONG_TERM_LOAN';
    const expected = (await data(await request.get(`${API}/requests?disposition=${terminal}&take=10&skip=0`, { headers: auth(token) }))).total;
    expect(expected).toBeGreaterThan(0);

    await signInAs(page, 'inventory');
    await page.goto('/inventory/dispositions');
    const tile = page.locator('div.text-right').filter({ hasText: 'dispositioned' }).locator('p').first();
    await expect(tile).toHaveText(String(expected));
    await expect(page.getByRole('button', { name: new RegExp(`^History\\s*${expected}$`) })).toBeVisible();
  });

  // ---------------------------------------------------------------- #3

  test('an issued quantity can be corrected up and down after its item was archived', async ({ request }) => {
    const item = createInventoryItemFixture(); // stock 50
    const owner = userFixtureIds(ACCOUNTS.user);
    const loan = createIssuedRequestFixture({ itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, handoverConfirmed: true });
    sql(`UPDATE "InventoryItem" SET "deletedAt" = now() WHERE id = ${lit(item.id)}`);
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const events = () => sqlValue(`SELECT count(*) FROM "InventoryEvent" WHERE "componentRequestId" = ${lit(loan.id)} AND "eventType" = 'ADJUSTMENT'`);

    const up = await request.patch(`${API}/requests/${loan.id}`, { headers: auth(token), data: { qtyIssued: 3 } });
    expect(up.status(), await up.text()).toBe(200);
    expect(sqlValue(`SELECT stock::int FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('48');
    expect(events()).toBe('1');

    const down = await request.patch(`${API}/requests/${loan.id}`, { headers: auth(token), data: { qtyIssued: 1 } });
    expect(down.status(), await down.text()).toBe(200);
    expect(sqlValue(`SELECT stock::int FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('50');
    expect(events()).toBe('2');
    // Still archived — correcting the loan does not bring the item back.
    expect(sqlValue(`SELECT ("deletedAt" IS NOT NULL)::text FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('true');
  });

  // ---------------------------------------------------------------- #4

  test('on screen: two sheet rows naming one archived item are unarchived once, with both quantities', async ({ page }) => {
    const since = sqlValue('SELECT now()::text')!;
    const item = createInventoryItemFixture();
    const dept = deptOf(ACCOUNTS.user);
    sql(`UPDATE "InventoryItem" SET "departmentId" = ${lit(dept.id)}, stock = 3, "deletedAt" = now() WHERE id = ${lit(item.id)}`);
    const csv = `name,stock,unit,department\n${item.name},4,PCS,${dept.name}\n${item.name},6,PCS,${dept.name}\n`;
    try {
      await signInAs(page, 'inventory');
      await page.goto('/inventory/components');
      await page.getByRole('button', { name: /^Bulk Upload$/ }).click();
      await page.getByRole('dialog').locator('input[type="file"]').setInputFiles({ name: 'twice.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });

      const held = page.getByRole('dialog', { name: '2 rows match archived items' });
      await expect(held.getByText('same item as row 3')).toBeVisible();
      await held.getByRole('button', { name: 'Apply' }).click();
      await expect(page.getByText('2 unarchived.')).toBeVisible();
      expect(sqlValue(`SELECT ("deletedAt" IS NULL)::text || ':' || stock::int FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('true:13');
    } finally {
      dropUploadLeftovers(since);
    }
  });

  // ---------------------------------------------------------------- #5

  test('receiving onto an archived item with a live twin adds to the live one, even when told to unarchive', async ({ request }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'ORDERED' });
    indentIds.push(indent.id);
    const lineId = sqlValue(`SELECT id FROM "IndentItem" WHERE "indentId" = ${lit(indent.id)}`)!;
    const archived = createInventoryItemFixture();
    const twin = createInventoryItemFixture();
    sql(`UPDATE "InventoryItem" SET "deletedAt" = now() WHERE id = ${lit(archived.id)}`);
    sql(`UPDATE "InventoryItem" SET name = ${lit(archived.name)} WHERE id = ${lit(twin.id)}`);
    const token = await tokenFor(request, ACCOUNTS.inventory);

    const res = await request.post(`${API}/inventory/receive-indent`, {
      headers: auth(token),
      data: { indentId: indent.id, items: [{ indentItemId: lineId, inventoryItemId: archived.id, qty: 1 }], archived: 'unarchive' },
    });
    expect(res.status(), await res.text()).toBe(201);
    expect(sqlValue(`SELECT stock::int FROM "InventoryItem" WHERE id = ${lit(twin.id)}`)).toBe('51');
    expect(sqlValue(`SELECT ("deletedAt" IS NOT NULL)::text || ':' || stock::int FROM "InventoryItem" WHERE id = ${lit(archived.id)}`)).toBe('true:50');
    expect(sqlValue(`SELECT "inventoryItemId" FROM "IndentItem" WHERE id = ${lit(lineId)}`)).toBe(twin.id);
  });

  test('receiving an id-linked archived line as "new" makes a fresh item instead of "not found"', async ({ request }) => {
    const owner = userFixtureIds(ACCOUNTS.user);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'ORDERED' });
    indentIds.push(indent.id);
    const lineId = sqlValue(`SELECT id FROM "IndentItem" WHERE "indentId" = ${lit(indent.id)}`)!;
    const archived = createInventoryItemFixture();
    sql(`UPDATE "InventoryItem" SET "deletedAt" = now() WHERE id = ${lit(archived.id)}`);
    const token = await tokenFor(request, ACCOUNTS.inventory);

    const res = await request.post(`${API}/inventory/receive-indent`, {
      headers: auth(token),
      data: { indentId: indent.id, items: [{ indentItemId: lineId, inventoryItemId: archived.id, qty: 1 }], archived: 'new' },
    });
    expect(res.status(), await res.text()).toBe(201);
    const fresh = sql(`SELECT id, stock::int FROM "InventoryItem" WHERE name = ${lit(archived.name)} AND "deletedAt" IS NULL`);
    for (const r of fresh) appItems.push(r[0]!);
    expect(fresh).toHaveLength(1);
    expect(fresh[0][0]).not.toBe(archived.id);
    expect(fresh[0][1]).toBe('1');
    expect(sqlValue(`SELECT ("deletedAt" IS NOT NULL)::text FROM "InventoryItem" WHERE id = ${lit(archived.id)}`)).toBe('true');
  });

  // ---------------------------------------------------------------- #6

  test('archiving cancels a back-ordered request, keeps its indent, and tells every buyer', async ({ request }) => {
    const item = createInventoryItemFixture();
    const owner = userFixtureIds(ACCOUNTS.user);
    const approver = userFixtureIds(ACCOUNTS.manager);
    const indent = createIndentFixture({ createdById: owner.id, departmentId: owner.departmentId, status: 'APPROVED' });
    indentIds.push(indent.id);
    const req = createOpenRequestFixture({ itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, status: 'APPROVED', approvedById: approver.id });
    sql(`UPDATE "ComponentRequest" SET status = 'YET_TO_ISSUE', "qtyShortfall" = 2, "backorderIndentId" = ${lit(indent.id)} WHERE id = ${lit(req.id)}`);
    const buyers = sql(`SELECT id FROM "User" WHERE role = 'PROCUREMENT' AND "isActive" AND "deletedAt" IS NULL`).map((r) => r[0]!).sort();
    expect(buyers.length, 'no active Procurement user to notify').toBeGreaterThan(0);
    const token = await tokenFor(request, ACCOUNTS.inventory);

    const res = await request.post(`${API}/inventory/archive`, { headers: auth(token), data: { ids: [item.id], reason: 'E2E part withdrawn' } });
    expect(res.status(), await res.text()).toBe(201);
    expect((await data(res)).cancelled).toEqual([req.serialNo]);

    expect(sqlValue(`SELECT status::text || ':' || coalesce("backorderIndentId", 'none') FROM "ComponentRequest" WHERE id = ${lit(req.id)}`)).toBe('REJECTED:none');
    // The indent stays — whether to still buy is Procurement's call.
    expect(sqlValue(`SELECT ("deletedAt" IS NULL)::text || ':' || status::text FROM "Indent" WHERE id = ${lit(indent.id)}`)).toBe('true:APPROVED');

    const notes = sql(`SELECT "userId", message FROM "Notification" WHERE "relatedEntityId" = ${lit(indent.id)} AND "relatedEntityType" = 'INDENT' ORDER BY "userId"`);
    expect(notes.map((n) => n[0]).sort()).toEqual(buyers);
    for (const n of notes) {
      expect(n[1]).toContain(req.serialNo);
      expect(n[1]).toContain(indent.serialNo);
      expect(n[1]).toContain('E2E part withdrawn');
    }
  });

  // ---------------------------------------------------------------- #7

  test('archive, unarchive and restore belong to Inventory alone, on the server', async ({ request }) => {
    const item = createInventoryItemFixture();
    const tokens = {
      admin: await tokenFor(request, ACCOUNTS.admin),
      superAdmin: await tokenFor(request, ACCOUNTS.superAdmin),
      procurement: await tokenFor(request, ACCOUNTS.procurement),
    };
    for (const [role, t] of Object.entries(tokens)) {
      expect((await request.post(`${API}/inventory/archive/preview`, { headers: auth(t), data: { ids: [item.id] } })).status(), `${role} preview`).toBe(403);
      expect((await request.post(`${API}/inventory/archive`, { headers: auth(t), data: { ids: [item.id], reason: 'e2e' } })).status(), `${role} archive`).toBe(403);
    }
    expect(sqlValue(`SELECT ("deletedAt" IS NULL)::text FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('true');

    sql(`UPDATE "InventoryItem" SET "deletedAt" = now() WHERE id = ${lit(item.id)}`);
    for (const [role, t] of Object.entries(tokens)) {
      expect((await request.post(`${API}/inventory/${item.id}/unarchive`, { headers: auth(t), data: {} })).status(), `${role} unarchive`).toBe(403);
      expect((await request.post(`${API}/inventory/bulk-restore`, { headers: auth(t), data: { ids: [item.id] } })).status(), `${role} restore`).toBe(403);
    }
    expect(sqlValue(`SELECT ("deletedAt" IS NOT NULL)::text FROM "InventoryItem" WHERE id = ${lit(item.id)}`)).toBe('true');

    const inv = await tokenFor(request, ACCOUNTS.inventory);
    const back = await request.post(`${API}/inventory/bulk-restore`, { headers: auth(inv), data: { ids: [item.id] } });
    expect(back.status(), await back.text()).toBe(201);
    expect((await data(back)).restoredCount).toBe(1);
  });

  test('on screen: the Super Admin inventory list has no Archive button', async ({ page }) => {
    const item = createInventoryItemFixture();
    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/inventory');
    await page.getByPlaceholder('Search inventory...').fill(item.name);
    await expect(page.locator('tbody tr').filter({ hasText: item.name })).toHaveCount(1);
    await page.getByRole('button', { name: 'S.No' }).click();
    await expect(page.getByRole('button', { name: /^Share/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Archive/ })).toHaveCount(0);
  });

  // ---------------------------------------------------------------- #8

  test('restoring two archived copies of one name together is refused with a clear message', async ({ request }) => {
    const a = createInventoryItemFixture();
    const b = createInventoryItemFixture();
    // Both archived before the rename: the live-name index only covers live rows.
    sql(`UPDATE "InventoryItem" SET "deletedAt" = now() WHERE id IN (${lit(a.id)}, ${lit(b.id)})`);
    sql(`UPDATE "InventoryItem" SET name = ${lit(a.name.toUpperCase())} WHERE id = ${lit(b.id)}`);
    const token = await tokenFor(request, ACCOUNTS.inventory);

    const res = await request.post(`${API}/inventory/bulk-restore`, { headers: auth(token), data: { ids: [a.id, b.id] } });
    expect(res.status(), await res.text()).toBe(409);
    expect((await res.json()).message).toContain('selected 2 times');
    expect(sqlValue(`SELECT count(*) FROM "InventoryItem" WHERE id IN (${lit(a.id)}, ${lit(b.id)}) AND "deletedAt" IS NOT NULL`)).toBe('2');
  });

  // ---------------------------------------------------------------- #9

  test('moving an allotment is one relative move, and a stale move is refused instead of overwriting', async ({ request }) => {
    const item = createInventoryItemFixture(); // stock 50
    const [p1, p2] = sql(`SELECT id FROM "Project" WHERE "isActive" ORDER BY name LIMIT 2`).map((r) => r[0]!);
    sql(`INSERT INTO "InventoryItemProject" ("inventoryItemId", "projectId", "allottedQty") VALUES (${lit(item.id)}, ${lit(p1)}, 5)`);
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const split = () => Object.fromEntries(
      sql(`SELECT "projectId", "allottedQty"::float8 FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(item.id)}`)
        .map((r) => [r[0], Number(r[1])]),
    );
    const move = (body: object) => request.post(`${API}/inventory/allotments/${item.id}/move`, { headers: auth(token), data: body });

    const ok = await move({ fromProjectId: p1, toProjectId: p2, qty: 3 });
    expect(ok.status(), await ok.text()).toBe(201);
    expect(split()).toEqual({ [p1]: 2, [p2]: 3 });

    // A second clerk's screen still thinks p1 holds 5: the move is refused, nothing changes.
    const stale = await move({ fromProjectId: p1, toProjectId: p2, qty: 3 });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).message).toContain('now holds 2');
    expect(split()).toEqual({ [p1]: 2, [p2]: 3 });

    // To the unallotted pool.
    const free = await move({ fromProjectId: p1, toProjectId: null, qty: 2 });
    expect(free.status(), await free.text()).toBe(201);
    expect(split()).toEqual({ [p1]: 0, [p2]: 3 });
  });
});
