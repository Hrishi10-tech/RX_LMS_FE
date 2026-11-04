import { test, expect } from '@playwright/test';
import { ACCOUNTS, signInAs } from './helpers/auth';
import { lit, sql, sqlValue } from './helpers/db';

/**
 * An item marked available to the whole organisation must stay visible when
 * somebody filters by a department.
 *
 * This is a production bug, reproduced. `isShared` means "this belongs to
 * everyone" — consumables, cables, tissues. Picking a department in the
 * inventory list ANDed `departmentId = X` on top of the visibility scope, so
 * every shared item owned by a DIFFERENT department disappeared. In production
 * 286 of 287 live items belonged to one department, so a user anywhere else
 * who filtered saw almost nothing — while the item sat there, correctly
 * flagged global, in the list they had just filtered out of.
 *
 * Exercised against the API through the signed-in session rather than the
 * table UI, because the bug is in the query, and a test that drives the filter
 * widget would prove this only for whichever control happens to set it today.
 */

const tag = () => `E2E-shared-${Date.now().toString(36)}`;

/** Call the API as the user the page is signed in as. */
const asUser = (page: import('@playwright/test').Page, path: string) =>
  page.evaluate(async (p) => {
    const token = sessionStorage.getItem('accessToken');
    const res = await fetch(`http://localhost:3001/api${p}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }, path);

const names = (payload: any): string[] => {
  const d = payload?.data ?? payload;
  const items = Array.isArray(d) ? d : (d?.items ?? []);
  return items.map((i: any) => i.name);
};

test.describe('org-wide stock stays visible under a department filter', () => {
  let itemName: string;
  let itemId: string;
  let otherDeptId: string;
  let viewerDeptId: string;

  test.beforeAll(() => {
    // The viewer's own department, and a DIFFERENT one to own the item —
    // which is the whole point: shared stock owned elsewhere.
    viewerDeptId = sqlValue(`SELECT "departmentId" FROM "User" WHERE email = ${lit(ACCOUNTS.user)}`)!;
    expect(viewerDeptId, 'the test user has no department').toBeTruthy();
    otherDeptId = sqlValue(
      `SELECT id FROM "Department" WHERE id <> ${lit(viewerDeptId)} LIMIT 1`,
    )!;
    test.skip(!otherDeptId, 'only one department exists — nothing to filter across');

    itemName = tag();
    [[itemId]] = sql(
      `INSERT INTO "InventoryItem"
         (id, name, category, unit, stock, status, "isShared", "departmentId", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(itemName)}, 'ELECTRONICS_GENERAL_ACCESSORIES', 'PCS', 12,
               'AVAILABLE', true, ${lit(otherDeptId)}, now(), now())
       RETURNING id`,
    ) as any;
  });

  test.afterAll(() => {
    if (itemId) {
      sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(itemId)}`);
      sql(`DELETE FROM "InventoryItem" WHERE id = ${lit(itemId)}`);
    }
  });

  test('a shared item owned by another department is visible unfiltered', async ({ page }) => {
    await signInAs(page, 'user');
    const res = await asUser(page, `/inventory?search=${encodeURIComponent(itemName)}&take=50`);
    expect(res.status).toBe(200);
    expect(names(res.body), 'shared stock was not visible even WITHOUT a filter').toContain(itemName);
  });

  // The regression. Same user, same item, one department filter applied.
  test('and stays visible once a department filter is applied', async ({ page }) => {
    await signInAs(page, 'user');
    const res = await asUser(
      page,
      `/inventory?search=${encodeURIComponent(itemName)}&departmentId=${viewerDeptId}&take=50`,
    );
    expect(res.status).toBe(200);
    expect(
      names(res.body),
      'an item marked available org-wide vanished the moment a department was picked — '
      + 'this is the production bug where "set it as global" did not make it visible',
    ).toContain(itemName);
  });

  // The filter must still DO something: picking a department has to keep
  // excluding another department's private stock, or the fix has simply
  // disabled the control.
  test('but a dept-only item from another department is still excluded', async ({ page }) => {
    const privateName = `${tag()}-private`;
    const [[privateId]] = sql(
      `INSERT INTO "InventoryItem"
         (id, name, category, unit, stock, status, "isShared", "departmentId", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(privateName)}, 'ELECTRONICS_GENERAL_ACCESSORIES', 'PCS', 3,
               'AVAILABLE', false, ${lit(otherDeptId)}, now(), now())
       RETURNING id`,
    ) as any;
    try {
      await signInAs(page, 'superAdmin'); // sees everything, so only the filter can exclude it
      const res = await asUser(
        page,
        `/inventory?search=${encodeURIComponent(privateName)}&departmentId=${viewerDeptId}&take=50`,
      );
      expect(res.status).toBe(200);
      expect(
        names(res.body),
        'the department filter no longer excludes other departments — the fix went too far',
      ).not.toContain(privateName);
    } finally {
      sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(privateId!)}`);
      sql(`DELETE FROM "InventoryItem" WHERE id = ${lit(privateId!)}`);
    }
  });
});
