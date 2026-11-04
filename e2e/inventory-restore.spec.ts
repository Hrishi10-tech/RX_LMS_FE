import { test, expect, APIRequestContext } from '@playwright/test';
import { ACCOUNTS, signInAs } from './helpers/auth';
import { sql, sqlValue, lit, fixtureTag } from './helpers/db';
import * as XLSX from 'xlsx';

/**
 * Restore from download (Component Database → Restore).
 *
 * The inventory team downloads the shelf before an upgrade; if counts come out
 * wrong they upload that file and put them back. Each test here downloads the
 * real file the Download button makes, breaks something, and restores it —
 * only ever touching items this file created, which are removed at the end.
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

/** Names of the items this file made — see afterEach. */
const made: string[] = [];
const deptId = () => sqlValue(`SELECT id FROM "Department" ORDER BY name LIMIT 1`)!;
const deptName = () => sqlValue(`SELECT name FROM "Department" ORDER BY name LIMIT 1`)!;
const projectId = () => sqlValue(`SELECT id FROM "Project" WHERE "isActive" ORDER BY name LIMIT 1`)!;

const makeItem = (stock: number, rack: string | null = null) => {
  const name = `${fixtureTag()} restore`;
  const id = sqlValue(
    `INSERT INTO "InventoryItem" (id, name, category, unit, stock, status, "isShared", "departmentId", "rackAddress", "totalReceived", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(name)}, 'ELECTRONIC_PASSIVE', 'PCS', ${stock}, 'AVAILABLE', true, ${lit(deptId())}, ${rack === null ? 'NULL' : lit(rack)}, ${stock}, now(), now())
     RETURNING id`,
  )!;
  made.push(name);
  return { id, name };
};
const item = (id: string) => {
  const [row] = sql(`SELECT stock::float8::text, coalesce("rackAddress", ''), "deletedAt" IS NOT NULL FROM "InventoryItem" WHERE id = ${lit(id)}`);
  return { stock: Number(row[0]), rack: row[1], deleted: row[2] === 't' };
};
const link = (id: string) => sql(
  `SELECT "allottedQty"::float8::text, coalesce("rackAddress", '') FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(id)}`,
).map((r) => ({ qty: Number(r[0]), rack: r[1] }));

const download = async (request: APIRequestContext, token: string) => {
  const res = await request.get(`${API}/inventory/export`, { headers: auth(token) });
  expect(res.status()).toBe(200);
  return res.body();
};
const file = (buffer: Buffer) => ({ name: 'component_database_test.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
const preview = async (request: APIRequestContext, token: string, buffer: Buffer) => {
  const res = await request.post(`${API}/inventory/restore/preview`, { headers: auth(token), multipart: { file: file(buffer) } });
  expect(res.status(), await res.text()).toBe(201);
  return data(res);
};
const apply = (request: APIRequestContext, token: string, buffer: Buffer, decisions: object) =>
  request.post(`${API}/inventory/restore/apply`, { headers: auth(token), multipart: { file: file(buffer), decisions: JSON.stringify(decisions) } });

test.describe('restore from download', () => {
  test.afterEach(() => {
    const names = made.splice(0);
    if (!names.length) return;
    // By name, not id: a broken restore can make a second copy of an item,
    // and that copy has to go too.
    const items = `SELECT id FROM "InventoryItem" WHERE name IN (${names.map(lit).join(', ')})`;
    sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" IN (${items})`);
    sql(`DELETE FROM "InventoryItem" WHERE id IN (${items})`); // links cascade
  });

  test('counts, location, reservations and a deleted item come back exactly', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const a = makeItem(50, 'E2E-R1');
    const b = makeItem(40);
    const c = makeItem(9);
    sql(`INSERT INTO "InventoryItemProject" ("inventoryItemId", "projectId", "allottedQty", "rackAddress") VALUES (${lit(b.id)}, ${lit(projectId())}, 10, 'E2E-BENCH')`);
    const buffer = await download(request, token);

    // What a bad upgrade might do.
    sql(`UPDATE "InventoryItem" SET stock = 7, "rackAddress" = 'WRONG' WHERE id = ${lit(a.id)}`);
    sql(`UPDATE "InventoryItem" SET stock = 60 WHERE id = ${lit(b.id)}`);
    sql(`UPDATE "InventoryItemProject" SET "allottedQty" = 0, "rackAddress" = NULL WHERE "inventoryItemId" = ${lit(b.id)}`);
    sql(`UPDATE "InventoryItem" SET "deletedAt" = now() WHERE id = ${lit(c.id)}`);

    const p = await preview(request, token, buffer);
    expect(p.hasAllotments).toBe(true);
    const da = p.different.find((d: any) => d.itemId === a.id);
    const db = p.different.find((d: any) => d.itemId === b.id);
    expect(da?.stock).toEqual({ app: 7, file: 50 });
    expect(da?.fields.map((f: any) => f.field)).toContain('rack');
    expect(db?.stock).toEqual({ app: 60, file: 40 });
    expect(db?.fields.map((f: any) => f.field)).toContain('projects');
    const nc = p.notInApp.find((n: any) => n.name === c.name);
    expect(nc, 'the deleted item is not offered back').toBeTruthy();
    expect(nc.inDeletedItems).toBe(true);

    const res = await apply(request, token, buffer, {
      reason: 'e2e: counts wrong after upgrade',
      items: [da, db].map((d: any) => ({ itemId: d.itemId, v: d.v, stock: 'file', fields: d.fields.map((f: any) => f.field) })),
      create: [nc.row],
    });
    expect(res.status(), await res.text()).toBe(201);
    expect(await data(res)).toMatchObject({ changed: 2, created: 1 });

    expect(item(a.id)).toEqual({ stock: 50, rack: 'E2E-R1', deleted: false });
    expect(item(b.id).stock).toBe(40);
    expect(link(b.id)).toEqual([{ qty: 10, rack: 'E2E-BENCH' }]);
    // Brought back from Deleted items, not created a second time.
    expect(item(c.id)).toEqual({ stock: 9, rack: '', deleted: false });
    expect(Number(sqlValue(`SELECT count(*) FROM "InventoryItem" WHERE name = ${lit(c.name)}`))).toBe(1);

    // Logged like Adjust Stock: who, how much, and why.
    const ev = sql(`SELECT "quantityChange"::float8::text, notes FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(a.id)} ORDER BY "createdAt" DESC LIMIT 1`)[0];
    expect(Number(ev[0])).toBe(43);
    expect(ev[1]).toContain('e2e: counts wrong after upgrade');
  });

  test('"keep current" and "add both" do what they say', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const keep = makeItem(20);
    const add = makeItem(20);
    const buffer = await download(request, token);
    sql(`UPDATE "InventoryItem" SET stock = 5 WHERE id IN (${lit(keep.id)}, ${lit(add.id)})`);
    const p = await preview(request, token, buffer);
    const pick = (id: string) => p.different.find((d: any) => d.itemId === id);
    const res = await apply(request, token, buffer, {
      reason: 'e2e',
      items: [
        { itemId: keep.id, v: pick(keep.id).v, stock: 'keep', fields: [] },
        { itemId: add.id, v: pick(add.id).v, stock: 'add', fields: [] },
      ],
    });
    expect(res.status(), await res.text()).toBe(201);
    expect(item(keep.id).stock).toBe(5);
    expect(item(add.id).stock).toBe(25);
  });

  test('an item that moved after the preview is refused, and nothing changes', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const x = makeItem(30);
    const y = makeItem(30);
    const buffer = await download(request, token);
    sql(`UPDATE "InventoryItem" SET stock = 1 WHERE id IN (${lit(x.id)}, ${lit(y.id)})`);
    const p = await preview(request, token, buffer);
    // Someone adjusts X between the preview and Confirm.
    const adj = await request.post(`${API}/inventory/${x.id}/adjust`, { headers: auth(token), data: { quantityChange: 1, reason: 'e2e: moved meanwhile' } });
    expect(adj.status(), await adj.text()).toBe(201);

    const res = await apply(request, token, buffer, {
      reason: 'e2e',
      items: [x.id, y.id].map((id) => ({ itemId: id, v: p.different.find((d: any) => d.itemId === id).v, stock: 'file', fields: [] })),
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).message).toContain(x.name);
    // All or nothing: Y was fine but must not have been written either.
    expect(item(y.id).stock).toBe(1);
    expect(item(x.id).stock).toBe(2);
  });

  test('a count below what is reserved is refused unless the reservations are restored with it', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const r = makeItem(5);
    const buffer = await download(request, token);
    sql(`UPDATE "InventoryItem" SET stock = 12 WHERE id = ${lit(r.id)}`);
    sql(`INSERT INTO "InventoryItemProject" ("inventoryItemId", "projectId", "allottedQty") VALUES (${lit(r.id)}, ${lit(projectId())}, 8)`);
    const p = await preview(request, token, buffer);
    const d = p.different.find((x: any) => x.itemId === r.id);
    expect(d.warnings.join(' ') + JSON.stringify(d.fields)).toMatch(/reserv/i);

    const countOnly = await apply(request, token, buffer, { reason: 'e2e', items: [{ itemId: r.id, v: d.v, stock: 'file', fields: [] }] });
    expect(countOnly.status()).toBe(400);
    expect((await countOnly.json()).message).toContain('8 reserved');
    expect(item(r.id).stock).toBe(12);

    const withProjects = await apply(request, token, buffer, { reason: 'e2e', items: [{ itemId: r.id, v: d.v, stock: 'file', fields: ['projects'] }] });
    expect(withProjects.status(), await withProjects.text()).toBe(201);
    expect(item(r.id).stock).toBe(5);
    expect(link(r.id)).toEqual([]);
  });

  test('an older download (no Info sheet) never wipes Issued / Returned / Disposed', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const it = makeItem(50);
    sql(`UPDATE "InventoryItem" SET "totalIssued" = 7, "totalReturned" = 2, "totalDisposed" = 1 WHERE id = ${lit(it.id)}`);
    // Make it look like the live app's download: no Info sheet, and the three
    // totals written as 0 — exactly what that version produces.
    const wb = XLSX.read(await download(request, token), { type: 'buffer' });
    const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets.Components, { header: 1 });
    const h = rows[0];
    for (const r of rows.slice(1)) for (const col of ['Total Issued', 'Total Returned', 'Total Disposed']) r[h.indexOf(col)] = 0;
    const old = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(old, XLSX.utils.aoa_to_sheet(rows), 'Components');
    const buffer: Buffer = XLSX.write(old, { type: 'buffer', bookType: 'xlsx' });
    sql(`UPDATE "InventoryItem" SET "totalReceived" = 40 WHERE id = ${lit(it.id)}`);

    const p = await preview(request, token, buffer);
    const d = p.different.find((x: any) => x.itemId === it.id);
    expect(d.fields.map((f: any) => f.field)).toEqual(['totals']);
    const res = await apply(request, token, buffer, { reason: 'e2e', items: [{ itemId: it.id, v: d.v, fields: ['totals'] }] });
    expect(res.status(), await res.text()).toBe(201);
    const [row] = sql(`SELECT "totalReceived"::float8, "totalIssued"::float8, "totalReturned"::float8, "totalDisposed"::float8 FROM "InventoryItem" WHERE id = ${lit(it.id)}`);
    expect(row.map(Number)).toEqual([50, 7, 2, 1]);
  });

  test('a filtered download restores counts only — not locations, projects, or "set to 0"', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const it = makeItem(30, 'E2E-RACK');
    const res0 = await request.get(`${API}/inventory/export?search=${encodeURIComponent(it.name)}`, { headers: auth(token) });
    const buffer = await res0.body();
    sql(`UPDATE "InventoryItem" SET stock = 3, "rackAddress" = 'MOVED' WHERE id = ${lit(it.id)}`);

    const p = await preview(request, token, buffer);
    expect(p.filtered).toBe(true);
    expect(p.notInFile).toEqual([]);
    const d = p.different.find((x: any) => x.itemId === it.id);
    expect(d.stock).toEqual({ app: 3, file: 30 });
    expect(d.fields.map((f: any) => f.field)).not.toContain('rack');

    const someone = sqlValue(`SELECT id FROM "InventoryItem" WHERE "deletedAt" IS NULL AND id <> ${lit(it.id)} LIMIT 1`)!;
    const zero = await apply(request, token, buffer, { reason: 'e2e', zeroOut: [{ itemId: someone, v: 'x' }] });
    expect(zero.status()).toBe(400);
    expect((await zero.json()).message).toContain('filtered');
  });

  test('only Inventory can restore — the Super Admin restores the whole database elsewhere', async ({ request }) => {
    const token = await tokenFor(request, ACCOUNTS.superAdmin);
    const res = await request.post(`${API}/inventory/restore/preview`, { headers: auth(token), multipart: { file: file(Buffer.from('PK')) } });
    expect(res.status()).toBe(403);
  });

  test('on screen: upload the download, see the difference, restore it', async ({ page, request }) => {
    const token = await tokenFor(request, ACCOUNTS.inventory);
    const it = makeItem(42);
    const buffer = await download(request, token);
    sql(`UPDATE "InventoryItem" SET stock = 3 WHERE id = ${lit(it.id)}`);

    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    await page.getByRole('button', { name: /^Restore$/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Restore from download' });
    await expect(dialog).toBeVisible();
    await dialog.locator('input[type="file"]').setInputFiles(file(buffer));

    const row = dialog.locator('div.p-3', { hasText: it.name });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('now 3');
    await expect(row).toContainText('file 42');
    await expect(row).toContainText(deptName());

    // Untick everything else the sandbox might differ on, keep only ours.
    await dialog.getByRole('button', { name: 'Untick all' }).click();
    await row.locator('input[type="checkbox"]').first().check();
    // Items another spec added meanwhile would be "not in the file"; the
    // screen insists on an answer for those before it will restore.
    const leave = dialog.getByLabel('Leave them as they are');
    if (await leave.count()) await leave.check();
    await dialog.getByPlaceholder(/Counts changed/).fill('e2e: on-screen restore');
    await dialog.getByRole('button', { name: /^Restore$/ }).click();
    await page.getByRole('button', { name: /^Restore$/ }).last().click(); // the confirm dialog
    await expect(page.getByText(/Restored: 1 updated/)).toBeVisible({ timeout: 30_000 });
    expect(item(it.id).stock).toBe(42);
  });
});
