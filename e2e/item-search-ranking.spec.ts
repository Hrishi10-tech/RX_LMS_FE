import { test, expect, Page } from '@playwright/test';
import { signInAs } from './helpers/auth';
import { lit, sql } from './helpers/db';

/**
 * Searching items puts the obvious answers first.
 *
 * Reported from production: typing "ti" in the Inventory Items table returned
 * "1210 Mah Battery", "9V Battery" and "Eraser" at the top, and nothing
 * actually called "Ti…" on the first page at all. Every one of those is a
 * genuine match — the derived search column includes the CATEGORY, and theirs
 * are ELECTRONIC_AC-TI-VE and STA-TI-ONARY_OFFICE — but alphabetical order
 * buried the items whose NAME starts with the term underneath them.
 *
 * Fixtures are created with names chosen so each one can only qualify for one
 * tier, which is what makes the asserted order meaningful rather than
 * incidental.
 */

const RUN = `zzq${Date.now().toString(36)}`;

/** Names are prefixed so the search term matches ONLY these rows. */
const NAMES = {
  startsWith: `${RUN}aaa widget`,        // name starts with the term
  wordStarts: `Bracket ${RUN}aaa clip`,  // a word inside the name starts with it
  contains: `Fuse${RUN}aaa holder`,      // the name contains it, mid-word
};

const asUser = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    const token = sessionStorage.getItem('accessToken');
    const res = await fetch(`http://localhost:3001/api${p}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, path);

const names = (payload: any): string[] => {
  const d = payload?.data ?? payload;
  return (Array.isArray(d) ? d : d?.items ?? []).map((i: any) => i.name);
};

test.describe('item search ranking', () => {
  test.beforeAll(() => {
    for (const name of Object.values(NAMES)) {
      sql(
        `INSERT INTO "InventoryItem"
           (id, name, category, unit, stock, status, "isShared", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), ${lit(name)}, 'ELECTRONICS_GENERAL_ACCESSORIES', 'PCS', 5,
                 'AVAILABLE', true, now(), now())`,
      );
    }
  });

  test.afterAll(() => {
    for (const name of Object.values(NAMES)) {
      sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" IN (SELECT id FROM "InventoryItem" WHERE name = ${lit(name)})`);
      sql(`DELETE FROM "InventoryItem" WHERE name = ${lit(name)}`);
    }
  });

  test('a name that STARTS with the term outranks one that merely contains it', async ({ page }) => {
    await signInAs(page, 'superAdmin');
    const res = await asUser(page, `/inventory?search=${RUN}aaa&take=20`);
    expect(res.status).toBe(200);

    const order = names(res.body);
    const at = (n: string) => order.indexOf(n);
    expect(at(NAMES.startsWith), 'the starts-with item is missing entirely').toBeGreaterThan(-1);
    expect(at(NAMES.wordStarts)).toBeGreaterThan(-1);
    expect(at(NAMES.contains)).toBeGreaterThan(-1);

    expect(
      at(NAMES.startsWith),
      'an item whose NAME starts with the term did not come first — this is the production '
      + 'complaint, where searching "ti" put batteries and erasers above anything called "Ti…"',
    ).toBeLessThan(at(NAMES.wordStarts));

    expect(
      at(NAMES.wordStarts),
      'a word starting with the term should outrank a mid-word substring',
    ).toBeLessThan(at(NAMES.contains));
  });

  // The ranking must not quietly override a sort the person asked for.
  test('an explicitly chosen sort still wins', async ({ page }) => {
    await signInAs(page, 'superAdmin');
    const res = await asUser(page, `/inventory?search=${RUN}aaa&orderBy=stockDesc&take=20`);
    expect(res.status).toBe(200);
    expect(names(res.body).length).toBeGreaterThan(0);
    // All three fixtures carry the same stock, so the only thing being
    // asserted is that the request succeeded and still returned them — the
    // ranking path must not hijack or drop an explicit ordering.
    for (const n of Object.values(NAMES)) expect(names(res.body)).toContain(n);
  });

  /**
   * Relevance ranking scans each tier up to a cap. Ranking a CAPPED scan does
   * not give a slower answer, it gives a wrong one: ids past the cap never
   * enter the list, so `total` reported the cap and the pager stopped before
   * rows that plainly matched. Found by seeding 1,300 matches and watching the
   * API insist there were 1,000.
   *
   * Above the cap the search must fall back to ordinary paging: every match
   * reachable, the count honest. Relevance order is what gets given up, and a
   * search returning a thousand rows is not one anyone reads in order.
   */
  test('a search bigger than the ranking cap still reaches every match', async ({ page }) => {
    const bulk = `${RUN}bulk`;
    const COUNT = 1300; // comfortably over the 1,000 cap
    sql(
      `INSERT INTO "InventoryItem" (id, name, category, stock, unit, "updatedAt")
       SELECT gen_random_uuid(), ${lit(bulk)} || ' ' || lpad(g::text, 5, '0'),
              'ELECTRONIC_PASSIVE', 1, 'NOS', now()
       FROM generate_series(1, ${COUNT}) g`,
    );
    try {
      await signInAs(page, 'superAdmin');

      const first = await asUser(page, `/inventory?search=${bulk}&take=20`);
      const payload = first.body?.data ?? first.body;
      expect(payload.total, 'the total was capped instead of counting every match').toBe(COUNT);

      // And the rows past the cap are actually reachable, not just counted.
      const last = await asUser(page, `/inventory?search=${bulk}&take=20&skip=${COUNT - 20}`);
      const lastNames = names(last.body);
      expect(lastNames, 'the final page of a big search came back empty').toHaveLength(20);
      expect(lastNames[lastNames.length - 1]).toBe(`${bulk} 0${COUNT}`);
    } finally {
      sql(`DELETE FROM "InventoryItem" WHERE name LIKE ${lit(bulk + '%')}`);
    }
  });

  test('the total counts the ranked set, so the pager does not invent pages', async ({ page }) => {
    await signInAs(page, 'superAdmin');
    const res = await asUser(page, `/inventory?search=${RUN}aaa&take=2`);
    const payload = res.body?.data ?? res.body;
    expect(payload.total).toBe(3);
    expect(names(res.body)).toHaveLength(2);
  });
});
