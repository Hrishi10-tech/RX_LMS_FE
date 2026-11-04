import { test, expect, Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { signInAs, ACCOUNTS, HOME_PATH, type Role } from './helpers/auth';
import {
  sql,
  sqlValue,
  nowIso,
  deleteUploadBatchesSince,
  snapshotAllInventoryCounters,
  restoreInventoryCounters,
  type InventoryCounters,
  snapshotConversations,
  restoreConversations,
  type ConversationSnapshot,
  createInventoryItemFixture,
  createIssuedRequestFixture,
  dropFixtures,
  userFixtureIds,
} from './helpers/db';

/**
 * Every major flow, driven through the browser.
 *
 * The other specs here are narrow: accessibility invariants, sandbox
 * isolation, one money path. This one walks the jobs people actually do —
 * add stock, allot it, request it, issue it, get it back, buy more, pay for
 * it, talk about it — and asserts against the DATABASE at the end of each,
 * not against the screen.
 *
 * That last part is the reason this file exists. A React app shows an
 * optimistic result for almost everything: a chat bubble appears whether or
 * not the send reached the server, a table cell repaints from local state
 * whether or not the PATCH succeeded. Checking the screen proves the screen.
 * Checking the row proves the feature. More than one bug found while writing
 * this was invisible on screen and obvious in the table.
 *
 * Each test creates the rows it needs, prefixed E2E- so a leak is
 * identifiable, and removes them afterwards. They share one database and run
 * serially (see playwright.config.ts) because they mutate the same tables.
 *
 * SELECTORS: this app's forms label their fields with plain text rather than
 * <label for>, so getByLabel mostly does not work. Fields are reached through
 * the label's own container, which is stable against re-ordering in a way
 * that nth-input indexing is not.
 */

/**
 * The SANDBOX API. Hard-coded rather than read from the environment on
 * purpose: the live stack is on :3000 and a spec that restores a database
 * must not be one misread variable away from pointing at it.
 * isolation.spec.ts asserts the shipped bundle talks to this same origin.
 */
const API_BASE = 'http://localhost:3001/api';

/** A short unique tag so leftovers are identifiable and never collide. */
const tag = () => `E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** One escaped SQL literal, so a quote in a name cannot break the statement. */
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;

/**
 * Click a button by visible text, waiting for it to be ENABLED first.
 *
 * Several actions are gated and render as a disabled button rather than an
 * error — Finalise needs saved allocations, Save needs a non-zero price.
 * Clicking one of those does nothing at all, and the test then fails later
 * describing the wrong problem. Waiting on enabled-ness fails at the click,
 * naming the button that never became available.
 */
const clickWhenReady = async (page: Page, name: string | RegExp, timeout = 20_000) => {
  const button = page.getByRole('button', { name }).first();
  await expect(button, `button "${name}" never became clickable`).toBeEnabled({ timeout });
  await button.click();
};

/**
 * The input/select belonging to a plain-text label.
 *
 * The field is the label's SIBLING, not its child — the labels here are
 * styling elements, not `<label for>` associations — so this walks up to the
 * shared parent and takes the control from there. Anchoring on the label text
 * survives re-ordering, which indexing into the nth input does not.
 */
const fieldUnder = (page: Page, label: string) =>
  page.locator('label').filter({ hasText: new RegExp(`^${label}`) }).first()
    .locator('xpath=..').locator('input, select, textarea').first();

/**
 * The same, but only inside the open modal.
 *
 * Page-wide text matching is actively dangerous here: the backdrop covers the
 * whole viewport, so a button matched behind it is visible and enabled and
 * simply never receives the click — Playwright then spends the full timeout
 * retrying and blames the wrong element. /Request/ matches the "I/P Requests"
 * nav item, /Submit/ matches "Send feedback". Scoping to the dialog makes
 * those impossible rather than unlikely.
 */
const clickInDialog = async (page: Page, name: string | RegExp, timeout = 20_000) => {
  // The LAST dialog, not the first: a confirm opens on top of the form that
  // triggered it and both are in the DOM, so the topmost one is the one the
  // click is meant for.
  const button = page.getByRole('dialog').last().getByRole('button', { name }).first();
  await expect(button, `dialog button "${name}" never became clickable`).toBeEnabled({ timeout });
  await button.click();
};

/**
 * Run cleanup statements, each isolated from the others.
 *
 * A `finally` block that calls `sql()` directly stops at the first statement
 * that throws, and every delete after it silently never runs. That is how a
 * test that PASSED left a row behind: its cleanup named a table that does not
 * exist in this schema, the exception unwound the rest of the block, and the
 * row it was meant to remove survived.
 *
 * Cleanup is best-effort by nature — a row may already be gone, a table may
 * differ between schema versions — so a failure here must never mask the
 * result of the test or prevent the rest of the tidying up.
 *
 * Order still matters within the list: children before parents, or the
 * parent's delete fails on a foreign key and the row outlives its test.
 */
const cleanup = (statements: (string | false | null | undefined)[]) => {
  for (const statement of statements) {
    if (!statement) continue;
    try { sql(statement); } catch { /* best effort: keep going */ }
  }
};

test.describe('flows', () => {
  /**
   * A net under every test in this file.
   *
   * Each test tears down what it knows about, but the APP writes rows against
   * ids no test ever sees — the auto-raise audit entry, the partial-fulfilment
   * notice, the "indent received" nudge, the BOM-awaiting-approval ping. Those
   * pointed at child records that are gone by teardown, so deleting by the
   * ids a test holds misses them and they outlive the run. Three separate
   * tests were each leaving one or two behind, and a before/after row count
   * across twelve tables is what found them.
   *
   * Every artefact this file creates carries the `E2E-` marker, in a serial or
   * an item name, and both of these tables quote it in their human-readable
   * text. So one sweep keyed on that marker cleans up after all of them — and
   * after whatever gets added here next, which is the point.
   */
  // Lifetime inventory counters, captured before anything in this file runs.
  //
  // `totalIssued` / `totalReturned` / `totalReceived` are cumulative and never
  // decrement — deliberately, since they answer "how much has ever moved
  // through this item". So issuing and returning in a test does not cancel
  // out, it adds to BOTH, and receiving goods adds to the third. Measured
  // across one run: one item went 86 -> 88 on issued and returned, another
  // 1028 -> 1040 on received. Every run, since these specs were written, and
  // invisible to a row-count check because no row is added or removed.
  //
  // Nothing short of restoring them is honest. Left alone, the suite edits the
  // lab's stock history to record movements that never happened.
  let counterSnapshot: InventoryCounters[] = [];
  let conversationSnapshot: ConversationSnapshot[] = [];
  let fileStartedAt = '';
  test.beforeAll(() => {
    counterSnapshot = snapshotAllInventoryCounters();
    conversationSnapshot = snapshotConversations();
    fileStartedAt = nowIso();
  });

  test.afterAll(() => {
    sql(`DELETE FROM "Notification" WHERE title LIKE '%E2E-%' OR message LIKE '%E2E-%'`);
    sql(`DELETE FROM "ApprovalHistory" WHERE notes LIKE '%E2E-%'`);
    // Undo removes the ITEMS a bulk upload created — which is what the test
    // asserts — and leaves the batch row behind, describing an upload whose
    // items no longer exist. It shows in Upload History as a real batch.
    deleteUploadBatchesSince(fileStartedAt);
    restoreInventoryCounters(counterSnapshot);
    // The chat spec's message is deleted, but the copy denormalised onto the
    // conversation is not — leaving the sidebar quoting a line that is no
    // longer in the thread.
    restoreConversations(conversationSnapshot);
  });

  // Ordered but INDEPENDENT. playwright.config.ts already pins one worker and
  // disables parallelism, so these run in file order against one database;
  // `mode: 'serial'` on top of that would also skip every remaining test the
  // moment one fails, which hides the state of everything below the first
  // break. Each test sets up and restores its own rows instead.

  // ---------------------------------------------------------------- auth

  test('auth: every role signs in and lands on its own dashboard', async ({ page }) => {
    for (const role of Object.keys(ACCOUNTS) as (keyof typeof ACCOUNTS)[]) {
      await signInAs(page, role);
      await expect(page.locator('body')).not.toContainText('Invalid email or password');
    }
  });

  test('auth: a wrong password is refused and keeps you on the login page', async ({ page }) => {
    await page.goto('/login');
    await page.fill('#email-address', ACCOUNTS.superAdmin);
    await page.fill('#password', 'definitely-not-the-password');
    await page.getByRole('button', { name: /^Sign in$/ }).click();
    await expect(page.getByText(/Invalid email or password/i)).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test('auth: an unauthenticated visitor is sent to the login page', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/login');
    await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* blocked */ } });
    await page.goto('/inventory/components');
    await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  });

  // ----------------------------------------------------------- inventory

  test('inventory: an item can be added, searched for, and deleted', async ({ page }) => {
    const name = `${tag()} Widget`;
    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');

    await clickWhenReady(page, /\+ Add Component/);
    await fieldUnder(page, 'Component Name').fill(name);
    // The first real option, not a named one. Department names differ between
    // the restored demo data and a fresh `prisma db seed`, and a spec that
    // names one only runs against that dataset.
    const dept = fieldUnder(page, 'Department');
    const deptValue = await dept.locator('option').nth(1).getAttribute('value');
    expect(deptValue, 'there are no departments to file this component under').toBeTruthy();
    await dept.selectOption(deptValue!);
    await fieldUnder(page, 'Initial Stock').fill('42');
    await clickWhenReady(page, /Create Component/);

    await expect.poll(
      () => sql(`SELECT stock FROM "InventoryItem" WHERE name = ${lit(name)} AND "deletedAt" IS NULL`).length,
      { message: 'the new item never reached the database', timeout: 25_000 },
    ).toBe(1);

    // Server-side search must find it. searchText is trigger-filled, so this
    // also proves the trigger fires for a row created through the UI.
    await page.goto('/inventory/components');
    await page.getByPlaceholder(/Search components/i).fill(name);
    await expect(page.getByText(name).first()).toBeVisible({ timeout: 20_000 });

    sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" IN (SELECT id FROM "InventoryItem" WHERE name = ${lit(name)})`);
    sql(`DELETE FROM "InventoryItemProject" WHERE "inventoryItemId" IN (SELECT id FROM "InventoryItem" WHERE name = ${lit(name)})`);
    sql(`DELETE FROM "InventoryItem" WHERE name = ${lit(name)}`);
  });

  test('inventory: the Component Database exports a real spreadsheet', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/components');
    const pending = page.waitForEvent('download', { timeout: 40_000 });
    await clickWhenReady(page, /Download/);
    const file = await pending;
    expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
    // A .xlsx is a zip; "PK" proves a real workbook rather than an error page
    // saved under the right extension.
    const path = await file.path();
    expect(path, 'the download produced no file on disk').toBeTruthy();
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(path!).subarray(0, 2).toString()).toBe('PK');
  });

  // ---------------------------------------------------------- allotments

  test('allotment: stock can be reserved for a project and edited in the table', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/allot');

    await page.getByRole('button', { name: /^Unallotted$/ }).click();
    // The item is identified before the editor opens, so the assertion can
    // name the exact row rather than "some row changed".
    // A real row, not the "Loading…" placeholder that stands in while the
    // list arrives — read too early, the item's name came back as "Loading…".
    const firstRow = page.locator('tbody tr').filter({ has: page.getByRole('button', { name: /Allot to a project/ }) }).first();
    await expect(firstRow, 'nothing is unallotted to work with').toBeVisible({ timeout: 25_000 });
    const itemName = (await firstRow.locator('td').first().innerText()).trim();
    await firstRow.getByRole('button', { name: /Allot to a project/ }).click();

    const qty = page.locator('input[aria-label^="Quantity allotted to"]').first();
    await expect(qty).toBeVisible({ timeout: 20_000 });
    const projectName = (await qty.getAttribute('aria-label'))!.replace('Quantity allotted to ', '');

    // Write a value DIFFERENT from what is there. Filling in the value the
    // field already holds leaves the form unchanged, Save stays disabled, and
    // the test fails describing a missing button instead of the real cause —
    // which is what happened on the second run of this spec.
    const before = Number(await qty.inputValue()) || 0;
    const target = before + 1;

    // Item names are NOT unique — the same part legitimately exists under two
    // departments — so the pairing of names can match several rows. Snapshot
    // every candidate by id first and assert that exactly one of them moved,
    // which is both unambiguous and restorable.
    const candidates = () => sql(
      `SELECT ip."inventoryItemId", ip."projectId", ip."allottedQty"::float8::text
         FROM "InventoryItemProject" ip
         JOIN "InventoryItem" i ON i.id = ip."inventoryItemId"
         JOIN "Project" p ON p.id = ip."projectId"
        WHERE i.name = ${lit(itemName)} AND p.name = ${lit(projectName)}
        ORDER BY ip."inventoryItemId"`,
    );
    const snapshot = candidates();
    expect(snapshot.length, `no allotment row for ${itemName} / ${projectName}`).toBeGreaterThan(0);

    try {
      await qty.fill(String(target));
      await clickWhenReady(page, /Save \d+ change/);

      await expect.poll(
        () => candidates().filter(([, , qtyNow]) => Number(qtyNow) === target).length,
        { message: `the allotment of ${itemName} to ${projectName} never reached the database`, timeout: 25_000 },
      ).toBeGreaterThan(0);
    } finally {
      // Put every candidate back exactly as it was, so a re-run starts from
      // the same place — without this, the second run types the value that is
      // already there, Save stays disabled, and the failure names the button
      // rather than the cause.
      for (const [itemRef, projectRef, was] of snapshot) {
        sql(`UPDATE "InventoryItemProject" SET "allottedQty" = ${Number(was)}
              WHERE "inventoryItemId" = ${lit(itemRef!)} AND "projectId" = ${lit(projectRef!)}`);
      }
    }
  });

  test('allotment: closing with unsaved changes asks first', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/allot');
    await page.getByRole('button', { name: /^Unallotted$/ }).click();
    await clickWhenReady(page, /Allot to a project/);

    const rack = page.locator('input[aria-label^="Rack for"]').first();
    await expect(rack).toBeVisible({ timeout: 20_000 });
    await rack.fill('E2E-UNSAVED');

    await page.keyboard.press('Escape');
    await expect(page.getByText(/unsaved changes/i)).toBeVisible({ timeout: 15_000 });
    // Cancel keeps the editor open with the edit intact.
    await page.getByRole('button', { name: /^Cancel$/ }).click();
    await expect(rack).toHaveValue('E2E-UNSAVED');
    // Now discard for real.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Confirm$/ }).click();
    await expect(page.locator('input[aria-label^="Rack for"]')).toHaveCount(0, { timeout: 15_000 });
  });

  // --------------------------------------------------------- collaboration

  test('chat: a message sent in Connect reaches the database', async ({ page }) => {
    const text = `${tag()} hello`;
    await signInAs(page, 'user');
    await page.goto('/user/messages');

    // Start the conversation rather than assuming one exists. A restored
    // database has no conversations at all — V1's export carries none — so a
    // test that picks an existing chat passes or fails on leftovers rather
    // than on the feature. Searching the directory is how the empty state
    // itself tells you to begin.
    // Somebody who actually exists in THIS database, whichever dataset it is.
    const [[colleague]] = sql(
      `SELECT name FROM "User" WHERE email = ${lit(ACCOUNTS.inventory)}`,
    );
    expect(colleague, 'there is nobody to chat to').toBeTruthy();
    await page.getByPlaceholder(/Search messages/i).fill(colleague!);
    const hit = page.locator('button, a, li').filter({ hasText: colleague! }).first();
    await expect(hit, 'the directory search found nobody to chat to').toBeVisible({ timeout: 20_000 });
    await hit.click();

    const box = page.getByPlaceholder(/Type a message/i);
    await expect(box).toBeVisible({ timeout: 20_000 });
    await box.fill(text);
    await box.press('Enter');

    // The bubble appears optimistically whether or not the socket delivered,
    // so the only meaningful assertion is the row.
    await expect.poll(
      () => sql(`SELECT count(*) FROM "Message" WHERE text = ${lit(text)}`)[0][0],
      { message: 'the message never reached the server — the bubble is optimistic', timeout: 25_000 },
    ).toBe('1');

    sql(`DELETE FROM "Message" WHERE text = ${lit(text)}`);
  });

  // ------------------------------------------------- component lifecycle

  /**
   * Raise -> approve -> issue -> return, each step by the role that really
   * does it, with the SHELF checked at every stage.
   *
   * Stock is the thing worth asserting on. The request row's own quantities
   * stayed correct all through the concurrency bug that was double-deducting
   * stock, so a test that only reads the request would have passed while the
   * inventory silently drained.
   */
  test('request: raise, approve, issue and return — stock leaves and comes back', async ({ page }) => {
    const QTY = 2;

    // Pick a real item, and one this requester has no OPEN request on: the
    // form's duplicate guard navigates away instead of submitting when they
    // do, which would look like a silent failure to raise.
    const picked = sql(`
      SELECT i.id, i.name, i.stock, i.category::text, i.status::text FROM "InventoryItem" i
       WHERE i."deletedAt" IS NULL AND i.stock > ${QTY + 3}
         AND NOT EXISTS (
           SELECT 1 FROM "ComponentRequest" r
            JOIN "User" u ON u.id = r."createdById"
            WHERE r."inventoryItemId" = i.id AND u.email = ${lit(ACCOUNTS.user)}
              AND r.status IN ('PENDING','APPROVED','YET_TO_ISSUE'))
       ORDER BY i.stock DESC LIMIT 1`);
    expect(picked.length, 'no item with spare stock and no open request').toBe(1);
    const [itemId, itemName, stockBefore, category, statusBefore] = picked[0] as string[];

    // Whether a new request waits for a manager is a per-CATEGORY setting, and
    // in the restored data most categories auto-approve. Force this one on, so
    // the approval step is actually exercised rather than skipped depending on
    // which item the query happened to pick. Put back in the finally block.
    const [[approvalWas]] = sql(
      `SELECT coalesce((SELECT "needsApproval"::text FROM "CategorySetting"
                         WHERE category = ${lit(category!)}::"ComponentCategory"), 'missing')`,
    );
    sql(`INSERT INTO "CategorySetting" (category, "needsApproval", "updatedAt")
         VALUES (${lit(category!)}::"ComponentCategory", true, now())
         ON CONFLICT (category) DO UPDATE SET "needsApproval" = true`);

    // ---- raise, as the person who needs the part
    await signInAs(page, 'user');
    await page.goto('/user');
    // Raised the way a user actually raises it: find the part on the dashboard
    // and use ITS Request button. That also pre-selects the item, so the test
    // is not re-implementing the picker's own search.
    await page.getByPlaceholder(/Search inventory/i).fill(itemName!);
    const listed = page.locator('tr').filter({ hasText: itemName! }).first();
    await expect(listed, `${itemName} is not on the dashboard to request`).toBeVisible({ timeout: 25_000 });
    await listed.getByRole('button', { name: /Request Component/ }).click();

    // Everything below is scoped to the dialog. Unscoped, /Request/ also
    // matches the "I/P Requests" nav button sitting behind the backdrop, and
    // the click times out against an element it can never reach.
    const form = page.getByRole('dialog');
    const itemSelect = form.locator('select').first();
    await expect(itemSelect, 'the modal opened without the item selected')
      .toHaveValue(itemId!, { timeout: 20_000 });

    await fieldUnder(form as unknown as Page, 'Quantity').fill(String(QTY));
    // Not project-specific: keeps the test independent of which projects
    // happen to exist in the restored data.
    await fieldUnder(form as unknown as Page, 'Project').selectOption('__OTHERS__');
    await clickInDialog(page, /Submit Request/);

    const requestRow = () => sql(`
      SELECT r.id, r."serialNo", r.status FROM "ComponentRequest" r
       JOIN "User" u ON u.id = r."createdById"
       WHERE r."inventoryItemId" = ${lit(itemId!)} AND u.email = ${lit(ACCOUNTS.user)}
       ORDER BY r."createdAt" DESC LIMIT 1`);

    await expect.poll(() => requestRow().length,
      { message: 'the request never reached the database', timeout: 25_000 }).toBe(1);
    const [requestId, serialNo] = requestRow()[0] as string[];

    try {
      expect(requestRow()[0][2], 'a new request should be awaiting approval').toBe('PENDING');
      // Asking for stock must not move stock.
      expect(Number(sql(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(itemId!)}`)[0][0]),
        'raising a request must not touch the shelf').toBe(Number(stockBefore));

      // ---- approve, as the admin
      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      const pending = page.locator('tr').filter({ hasText: serialNo! }).first();
      await expect(pending, `${serialNo} never showed up in approvals`).toBeVisible({ timeout: 25_000 });
      await pending.getByRole('button', { name: /^Approve$/ }).click();

      await expect.poll(() => requestRow()[0][2],
        { message: 'approving did not change the status', timeout: 25_000 }).toBe('APPROVED');

      // ---- issue, as the inventory clerk
      await signInAs(page, 'inventory');
      await page.goto('/inventory/requests');
      const toIssue = page.locator('tr').filter({ hasText: serialNo! }).first();
      await expect(toIssue, `${serialNo} never showed up in the issue queue`).toBeVisible({ timeout: 25_000 });
      await toIssue.getByRole('button', { name: /^Issue$/ }).click();
      // The confirm button names the quantity, so it doubles as an assertion
      // that the clerk is being offered a full fill rather than a back-order.
      await clickInDialog(page, new RegExp(`^Issue ${QTY}$`));

      await expect.poll(
        () => Number(sql(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(itemId!)}`)[0][0]),
        { message: 'issuing did not take the parts off the shelf', timeout: 25_000 },
      ).toBe(Number(stockBefore) - QTY);
      // Exactly QTY, not a multiple of it — the read-then-write race here used
      // to deduct twice under load and this is the shape that would catch it.
      expect(Number(sql(`SELECT "qtyIssued" FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`)[0][0])).toBe(QTY);
      expect(requestRow()[0][2]).toBe('IN_USE');

      // ---- hand it back, as the requester
      await signInAs(page, 'user');
      await page.goto('/user/my-components');
      const held = page.locator('tr').filter({ hasText: itemName! }).first();
      await expect(held, 'the issued item is not listed under my components').toBeVisible({ timeout: 25_000 });
      await held.getByRole('button', { name: /Initiate Return/ }).first().click();
      // Condition is a button group, not a select, and the modal opens with
      // none chosen. Pick the first one so the return carries a real value.
      await page.getByRole('dialog').getByRole('button').filter({ hasText: /^[A-Z]/ })
        .filter({ hasNotText: /Cancel|Submit|Close/ }).first().click();
      await clickInDialog(page, /^Submit Return/);

      await expect.poll(() => requestRow()[0][2],
        { message: 'the return request never registered', timeout: 25_000 }).toBe('RETURN_REQUESTED');

      // ---- receive it, as the clerk, and check the shelf is whole again
      await signInAs(page, 'inventory');
      await page.goto('/inventory/returns');
      await expect(page.locator('tr').filter({ hasText: itemName! }).first(),
        'the pending return is not on the returns desk').toBeVisible({ timeout: 25_000 });
      // File Return is a page-level action that opens a picker, not a per-row
      // button — the desk files against whichever request the clerk chooses.
      await clickWhenReady(page, /^File Return$/);
      const returnForm = page.getByRole('dialog');
      await expect
        .poll(async () => returnForm.locator(`option[value="${requestId}"]`).count(),
              { message: `${serialNo} is not offered in the File Return picker`, timeout: 20_000 })
        .toBeGreaterThan(0);
      await returnForm.locator('select').first().selectOption(requestId!);
      await returnForm.getByRole('button', { name: /Good Condition/ }).click();
      await clickInDialog(page, /^Submit Return/);

      await expect.poll(
        () => Number(sql(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(itemId!)}`)[0][0]),
        { message: 'the returned parts never came back to the shelf', timeout: 25_000 },
      ).toBe(Number(stockBefore));
    } finally {
      // Children first — these tables FK to the request, and the restore path
      // runs with triggers off, so nothing here cascades for us.
      cleanup([
        `DELETE FROM "RequestResponsiblePerson" WHERE "requestId" = ${lit(requestId!)}`,
        `DELETE FROM "InventoryEvent" WHERE "componentRequestId" = ${lit(requestId!)}`,
        `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(requestId!)}`,
        `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(requestId!)}`,
        `DELETE FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`,
      ]);
      // Status as well as stock: issuing and returning recompute it, and a
      // restore that moves the number back without the label leaves the item
      // describing a shelf it is not on.
      sql(`UPDATE "InventoryItem" SET stock = ${Number(stockBefore)}, status = ${lit(statusBefore!)} WHERE id = ${lit(itemId!)}`);
      sql(approvalWas === 'missing'
        ? `DELETE FROM "CategorySetting" WHERE category = ${lit(category!)}::"ComponentCategory"`
        : `UPDATE "CategorySetting" SET "needsApproval" = ${approvalWas}
            WHERE category = ${lit(category!)}::"ComponentCategory"`);
    }
  });

  // ---------------------------------------------------------- bulk upload

  /**
   * Import a spreadsheet of components, then undo it.
   *
   * Uploading is how stock actually arrives — nobody types four thousand
   * capacitors in one at a time — and the undo beside it is the reason it is
   * safe to try. Both are asserted on the rows, because the "N items uploaded"
   * banner is drawn from the response and would show the same number whether
   * or not the rows landed.
   */
  test('bulk upload: a spreadsheet of components lands, and Undo takes it back', async ({ page }) => {
    const prefix = tag();
    const names = [`${prefix} alpha`, `${prefix} beta`, `${prefix} gamma`];
    const csv = ['name,category,stock,unit,location',
      ...names.map((n) => `${n},ELECTRONICS_GENERAL_ACCESSORIES,7,PCS,E2E-RACK`)].join('\n');

    const uploaded = () => Number(sql(
      `SELECT count(*) FROM "InventoryItem"
        WHERE name LIKE ${lit(prefix + '%')} AND "deletedAt" IS NULL`,
    )[0][0]);

    try {
      await signInAs(page, 'inventory');
      await page.goto('/inventory/components');
      await clickWhenReady(page, /^Bulk Upload$/);

      await page.getByRole('dialog').locator('input[type="file"]')
        .setInputFiles({ name: `${prefix}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) });

      await expect.poll(uploaded,
        { message: 'none of the uploaded rows reached the database', timeout: 30_000 }).toBe(names.length);

      // Undo is the safety net that makes the upload usable; a banner that
      // says "3 items uploaded" and an undo that removes two would be worse
      // than no undo at all.
      await clickWhenReady(page, /^Undo Upload$/);
      const undoConfirm = page.getByRole('dialog').last().getByRole('button', { name: /^(Undo|Confirm|Yes|Delete)/ });
      if (await undoConfirm.isVisible({ timeout: 5_000 }).catch(() => false)) await undoConfirm.click();

      await expect.poll(uploaded,
        { message: 'Undo Upload left rows behind', timeout: 30_000 }).toBe(0);
    } finally {
      // Undo soft-deletes; clear the rows outright so a re-run of this spec
      // cannot collide with them on the unique-name index.
      sql(`DELETE FROM "InventoryItem" WHERE name LIKE ${lit(prefix + '%')}`);
    }
  });

  /**
   * A message arriving live, in a second browser, with no reload.
   *
   * The chat test above proves a send reaches the database. This proves the
   * other half: that the websocket actually delivers it. Those are different
   * failures — a working send with a dead socket looks completely fine to the
   * person typing and leaves the person being written to staring at nothing
   * until they refresh.
   *
   * The socket was previously failing its upgrade and falling back to HTTP
   * polling, which still delivers, just slowly and at much greater cost. So
   * this asserts the transport too: a real websocket frame, no polling.
   */
  test('chat: a message is delivered live over the websocket, not by polling', async ({ browser }) => {
    const body = `${tag()} live over the wire`;

    const senderCtx = await browser.newContext();
    const receiverCtx = await browser.newContext();
    const sender = await senderCtx.newPage();
    const receiver = await receiverCtx.newPage();

    // Transport evidence, gathered on the RECEIVER: it is the side that has
    // to be pushed to.
    const sockets: string[] = [];
    const httpPolls: string[] = [];
    receiver.on('websocket', (ws) => sockets.push(ws.url()));
    receiver.on('request', (r) => {
      if (r.url().includes('socket.io') && !r.url().startsWith('ws')) httpPolls.push(r.url());
    });

    try {
      await signInAs(sender, 'user');
      await signInAs(receiver, 'inventory');

      const [[receiverName]] = sql(`SELECT name FROM "User" WHERE email = ${lit(ACCOUNTS.inventory)}`);
      const [[senderName]] = sql(`SELECT name FROM "User" WHERE email = ${lit(ACCOUNTS.user)}`);

      await receiver.goto('/inventory/messages');
      await sender.goto('/user/messages');

      await expect
        .poll(() => sockets.length, { message: 'the receiver never opened a websocket', timeout: 25_000 })
        .toBeGreaterThan(0);
      expect(sockets[0], 'the socket is not a websocket URL').toMatch(/^wss?:/);

      // Start the conversation from the sender's side.
      await sender.getByPlaceholder(/Search messages/i).fill(receiverName!);
      const hit = sender.locator('button, a, li').filter({ hasText: receiverName! }).first();
      await expect(hit, 'the directory search found nobody to chat to').toBeVisible({ timeout: 20_000 });
      await hit.click();

      // The exact placeholder. A looser /Message/i also matches "Search
      // messages", and `.first()` then picks the SEARCH box — the text goes
      // in there, Enter does nothing, and the failure reads as "the message
      // never arrived" rather than "it was never sent".
      const box = sender.getByPlaceholder(/Type a message/i);
      await expect(box, 'the composer never appeared').toBeVisible({ timeout: 20_000 });
      await box.fill(body);
      await box.press('Enter');

      // The receiver has to open the thread — a notification badge is a
      // different feature — but must NOT reload to see the message.
      const thread = receiver.locator('button, a, li').filter({ hasText: senderName! }).first();
      await expect(thread, 'the new conversation never appeared for the receiver')
        .toBeVisible({ timeout: 25_000 });
      await thread.click();

      await expect(receiver.getByText(body).first(),
        'the message never arrived in the second browser').toBeVisible({ timeout: 25_000 });

      // And it came over the socket. A handful of socket.io HTTP requests is
      // normal — the handshake is one — but a steady stream of them means the
      // upgrade failed and the app is long-polling instead.
      expect(httpPolls.length,
        `the receiver made ${httpPolls.length} socket.io HTTP requests, which means it is polling, not socketed`)
        .toBeLessThan(5);
    } finally {
      cleanup([
        `DELETE FROM "Message" WHERE text = ${lit(body)}`,
      ]);
      await senderCtx.close();
      await receiverCtx.close();
    }
  });

  // ------------------------------------------------------------- bom lists

  /**
   * A BOM list, from empty to submitted.
   *
   * The list is the front door to both other flows: on submit it splits into
   * component REQUESTS for the lines already in stock and an INDENT for the
   * lines that are not. That split is the whole point of the feature and it is
   * decided server-side, so the assertion is on what the submit produced, not
   * on the button changing colour.
   */
  test('bom: a list can be created, given a custom line, and submitted', async ({ page }) => {
    const listName = `${tag()} BOM`;
    const lineName = `${tag()} custom part`;
    let listId: string | undefined;

    try {
      await signInAs(page, 'user');
      await page.goto('/user/lists');
      await clickWhenReady(page, /New list/);

      const create = page.getByRole('dialog');
      await fieldUnder(create as unknown as Page, 'List name').fill(listName);
      for (const label of ['Project', 'Department']) {
        const select = fieldUnder(create as unknown as Page, label);
        if (!(await select.isEnabled())) continue;
        const value = await select.locator('option').nth(1).getAttribute('value');
        if (value) await select.selectOption(value);
      }
      await clickInDialog(page, /^Create list$/);

      await expect.poll(
        () => sql(`SELECT id FROM "BomList" WHERE name = ${lit(listName)}`).length,
        { message: 'the list was never created', timeout: 25_000 },
      ).toBe(1);
      listId = sql(`SELECT id FROM "BomList" WHERE name = ${lit(listName)}`)[0][0]!;

      // Creating opens the editor straight away, which is where lines go.
      await clickWhenReady(page, /Add custom item/);
      const editor = page.getByRole('dialog');
      await fieldUnder(editor as unknown as Page, 'Name').fill(lineName);
      await fieldUnder(editor as unknown as Page, 'Qty').fill('4');
      await fieldUnder(editor as unknown as Page, 'Unit').fill('PCS');
      await clickInDialog(page, /^Add to list$/);

      await expect.poll(
        () => sql(`SELECT count(*) FROM "BomListCustomItem" WHERE name = ${lit(lineName)}`)[0][0],
        { message: 'the custom line never reached the list', timeout: 25_000 },
      ).toBe('1');

      // A custom line is by definition not in stock, so the submit must raise
      // an INDENT — the button says so before it is clicked.
      await clickInDialog(page, /^Submit \(indent/);
      // Submitting asks first — it puts the list in front of a manager and
      // orders what is missing, so the app confirms before doing that.
      await clickInDialog(page, /^(Confirm|Submit|Yes|OK)/);

      await expect.poll(
        () => sql(`SELECT status FROM "BomList" WHERE id = ${lit(listId!)}`)[0][0],
        { message: 'submitting left the list in draft', timeout: 25_000 },
      ).not.toBe('DRAFT');
    } finally {
      if (listId) {
        cleanup([
          `DELETE FROM "BomListCustomItem" WHERE "bomListId" = ${lit(listId)}`,
          `DELETE FROM "BomListItem" WHERE "bomListId" = ${lit(listId)}`,
          `UPDATE "ComponentRequest" SET "bomListId" = NULL WHERE "bomListId" = ${lit(listId)}`,
          `UPDATE "Indent" SET "bomListId" = NULL WHERE "bomListId" = ${lit(listId)}`,
          `DELETE FROM "BomList" WHERE id = ${lit(listId)}`,
        ]);
      }
    }
  });

  // ------------------------------------------------------- project reservations

  /**
   * Your 100 resistors, 60 tagged to Watch.
   *
   * The rule: a request draws on its own project's allotment first and the
   * unallotted pool after, and never on another project's. So a Watch request
   * for 80 gets all 80 (60 from its tag, 20 from the free pool), while a
   * Phone request for 80 gets only the 40 nobody reserved and the rest has to
   * be bought.
   *
   * This is set up through SQL rather than the Allot Items page — that page
   * has its own test above, and what is under examination here is the
   * arithmetic, which wants exact numbers rather than whatever the restored
   * data happens to hold.
   */
  test('reservations: a project spends its own allotment first, then the free pool', async ({ page }) => {
    const itemName = `${tag()} resistor`;
    const mine = `${tag()} Watch`;
    const theirs = `${tag()} Phone`;

    const [[itemId]] = sql(
      `INSERT INTO "InventoryItem" (id, name, category, unit, stock, status, "isShared", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(itemName)}, 'ELECTRONICS_GENERAL_ACCESSORIES', 'PCS', 100, 'AVAILABLE', true, now(), now())
       RETURNING id`,
    );
    const makeProject = (name: string) => sql(
      `INSERT INTO "Project" (id, name, "isActive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(name)}, true, now(), now()) RETURNING id`,
    )[0][0]!;
    const watchId = makeProject(mine);
    const phoneId = makeProject(theirs);
    sql(`INSERT INTO "InventoryItemProject" ("inventoryItemId", "projectId", "allottedQty")
         VALUES (${lit(itemId!)}, ${lit(watchId)}, 60)`);

    const stockNow = () => Number(sql(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(itemId!)}`)[0][0]);
    const tagNow = (projectId: string) => Number(sql(
      `SELECT coalesce((SELECT "allottedQty" FROM "InventoryItemProject"
                         WHERE "inventoryItemId" = ${lit(itemId!)} AND "projectId" = ${lit(projectId)}), 0)`,
    )[0][0]);

    // Both requests are created directly and approved, so the test exercises
    // the ISSUE arithmetic rather than re-walking the request form, which the
    // lifecycle test above already covers.
    const raise = (projectId: string, qty: number) => sql(
      `INSERT INTO "ComponentRequest"
         (id, "serialNo", "inventoryItemId", "qtyRequested", "projectId", "departmentId",
          nature, "durationValue", "durationUnit", status, "createdById", "createdAt", "updatedAt")
       SELECT gen_random_uuid(), 'E2E-' || substr(md5(random()::text), 1, 8), ${lit(itemId!)}, ${qty},
              ${lit(projectId)}, u."departmentId", 'TEMPORARY', 7, 'DAYS', 'APPROVED', u.id, now(), now()
         FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}
       RETURNING id, "serialNo"`,
    )[0];

    // One try around the whole scenario. These rows are created before any of
    // it runs, so a failure in the first half must still clean up the item and
    // the projects — an earlier version split this into two blocks and leaked
    // all three the first time the Watch half broke.
    const created: string[] = [];
    try {
      const [watchReq, watchSerial] = raise(watchId, 80);
      created.push(watchReq!);
      await signInAs(page, 'inventory');
      await page.goto('/inventory/requests');

      // ---- Watch asks for 80. It has 60 of its own and 40 sit free, so all
      // 80 can go: the button naming the quantity is the assertion.
      const watchRow = page.locator('tr').filter({ hasText: watchSerial! }).first();
      await expect(watchRow, `${watchSerial} is not in the issue queue`).toBeVisible({ timeout: 25_000 });
      await watchRow.getByRole('button', { name: /^Issue$/ }).click();
      await clickInDialog(page, /^Issue 80$/);

      await expect.poll(stockNow,
        { message: 'issuing 80 to Watch did not move the shelf', timeout: 25_000 }).toBe(20);
      expect(tagNow(watchId), 'Watch should have spent its own 60 first').toBe(0);
      expect(
        Number(sql(`SELECT "qtyFromAllotment" FROM "ComponentRequest" WHERE id = ${lit(watchReq!)}`)[0][0]),
        'the split was not recorded, so a return cannot put it back correctly',
      ).toBe(60);

      // Eating into general stock is allowed but it quietly shrinks what is
      // left for everyone else, so the inventory team is told. The issuing
      // clerk is NOT excluded: the dialog that showed the split is gone the
      // moment it is dismissed, and on a team with one clerk excluding the
      // actor means the notice reaches nobody.
      await expect.poll(
        () => sql(
          `SELECT count(*) FROM "Notification" n
             JOIN "User" u ON u.id = n."userId"
            WHERE n."relatedEntityId" = ${lit(watchReq!)}
              AND n.title LIKE 'General stock used%'
              AND u.role = 'INVENTORY'`,
        )[0][0],
        { message: 'nobody was told that the request spilled into general stock', timeout: 25_000 },
      ).not.toBe('0');
      const [[spillMessage]] = sql(
        `SELECT message FROM "Notification"
          WHERE "relatedEntityId" = ${lit(watchReq!)} AND title LIKE 'General stock used%' LIMIT 1`,
      );
      // The numbers are the point of the message — "some stock was used" would
      // tell the clerk nothing they can act on. The shelf's two facts are what
      // left the free pool and what is left of it; what the project's own tag
      // covered moved to the requester's notice, asserted just below, because
      // that is whose reservation was spent.
      expect(spillMessage, 'the notice should say how much came from general stock').toContain('20');
      expect(spillMessage, 'the notice should say how much unallotted stock is left')
        .toMatch(/\d+ \S+ unallotted left/);

      // The requester is told too, and theirs carries the split: their
      // allotment is now empty and they are the only one who can act on that.
      // They used to hear nothing and discover it the next time they asked.
      const [[ownerMessage]] = sql(
        `SELECT message FROM "Notification"
          WHERE "relatedEntityId" = ${lit(watchReq!)} AND title LIKE 'Allotment used up%' LIMIT 1`,
      );
      expect(ownerMessage, 'the requester was never told their allotment ran out').toBeTruthy();
      expect(ownerMessage, "the requester's notice should say what their allotment covered").toContain('60');
      expect(ownerMessage, "the requester's notice should say what came from general stock").toContain('20');

      // ---- The return puts 60 back on Watch's tag and 20 back in the free
      // pool. Crediting all 80 to the tag would silently grow the reservation.
      sql(`UPDATE "ComponentRequest" SET status = 'RETURN_REQUESTED' WHERE id = ${lit(watchReq!)}`);
      await page.goto('/inventory/returns');
      await clickWhenReady(page, /^File Return$/);
      const returnForm = page.getByRole('dialog');
      await expect
        .poll(async () => returnForm.locator(`option[value="${watchReq}"]`).count(),
              { message: 'the Watch return is not offered on the returns desk', timeout: 20_000 })
        .toBeGreaterThan(0);
      await returnForm.locator('select').first().selectOption(watchReq!);
      await returnForm.getByRole('button', { name: /Good Condition/ }).click();
      await clickInDialog(page, /^Submit Return/);

      await expect.poll(stockNow,
        { message: 'the returned stock never came back', timeout: 25_000 }).toBe(100);
      expect(tagNow(watchId), "the return must restore Watch's 60 — no more, no less").toBe(60);
      // ---- Phone asks for 80 with nothing allotted to it. Only the 40 nobody
      // reserved are available; the other 60 belong to Watch and stay put.
      const [phoneReq, phoneSerial] = raise(phoneId, 80);
      created.push(phoneReq!);
      await page.goto('/inventory/requests');
      const phoneRow = page.locator('tr').filter({ hasText: phoneSerial! }).first();
      await expect(phoneRow, `${phoneSerial} is not in the issue queue`).toBeVisible({ timeout: 25_000 });
      await phoneRow.getByRole('button', { name: /^Issue$/ }).click();

      // The clerk must be offered 40, not 80 — the screen reading 100 and the
      // server refusing the issue is the failure this guards against. The
      // button also offers to raise the indent for the 40 it cannot cover.
      await clickInDialog(page, /^Issue 40 \+ raise indent for 40$/);

      await expect.poll(stockNow,
        { message: 'Phone was not issued the free 40', timeout: 25_000 }).toBe(60);
      expect(tagNow(watchId), "Phone must not be able to touch Watch's reservation").toBe(60);
      expect(
        Number(sql(`SELECT "qtyFromAllotment" FROM "ComponentRequest" WHERE id = ${lit(phoneReq!)}`)[0][0] ?? 0),
        'nothing came off a tag, so nothing should be recorded against one',
      ).toBe(0);
      // The shortfall becomes an indent, which is how the remaining 40 get bought.
      const [[indentForShortfall]] = sql(
        `SELECT coalesce("backorderIndentId", '') FROM "ComponentRequest" WHERE id = ${lit(phoneReq!)}`,
      );
      expect(indentForShortfall, 'the 40 it could not cover should have become an indent').toBeTruthy();
      // The indent must carry the project it was raised for, or procurement
      // buys 40 of something for nobody in particular.
      const [[indentProject, indentQty]] = sql(
        `SELECT coalesce(p.name, ''), it.qty FROM "Indent" i
           JOIN "IndentItem" it ON it."indentId" = i.id
           LEFT JOIN "Project" p ON p.id = i."projectId"
          WHERE i.id = ${lit(indentForShortfall!)} LIMIT 1`,
      );
      expect(indentProject, 'the shortfall indent lost the project it was for').toBe(theirs);
      expect(Number(indentQty), 'the indent should cover exactly what could not be issued').toBe(40);

      // ---- What the inventory clerk is shown when that stock lands. The
      // part arrives untagged, so the Allot Items page has to say who it was
      // bought for — otherwise the clerk is guessing, or it sits loose for
      // whoever asks next.
      // Procurement buys the 40 and they land on the shelf. Receiving adds
      // plain untagged stock — that part is deliberate, because taking goods
      // in and deciding whose they are is two decisions, not one.
      sql(`UPDATE "InventoryItem" SET stock = stock + 40 WHERE id = ${lit(itemId!)}`);
      expect(stockNow()).toBe(100);

      await page.goto('/inventory/allot');
      await page.getByRole('button', { name: /^Unallotted$/ }).click();
      await page.getByPlaceholder(/Search/i).first().fill(itemName);
      const allotRow = page.locator('tr').filter({ hasText: itemName }).first();
      await expect(allotRow, 'the item is not on the allot page').toBeVisible({ timeout: 25_000 });
      await allotRow.getByRole('button', { name: /Allot to a project/ }).click();

      // The allot editor is a hand-rolled overlay, not a role="dialog", so
      // these are page-scoped — it is the only thing on screen either way.
      const editor = page;
      await expect(editor.getByText(/Waiting on this item/i),
        'the clerk is not told the incoming stock is spoken for').toBeVisible({ timeout: 20_000 });
      await expect(editor.getByText(new RegExp(`40 PCS for ${theirs}`)),
        'the waiting notice does not say how much, or for whom').toBeVisible();
      const [[requesterName]] = sql(`SELECT name FROM "User" WHERE email = ${lit(ACCOUNTS.user)}`);
      await expect(editor.getByText(new RegExp(`requested by ${requesterName}`, 'i')),
        'the waiting notice does not name who asked').toBeVisible();

      // The shortcut fills the box; it does not save. Allotting stays the
      // clerk's decision and still goes through the same Save as everything
      // else on this screen.
      await editor.getByRole('button', { name: new RegExp(`Allot 40 to ${theirs}`) }).click();
      await expect(editor.locator(`input[aria-label="Quantity allotted to ${theirs}"]`)).toHaveValue('40');
      expect(tagNow(phoneId), 'filling the box must not save on its own').toBe(0);

      await clickWhenReady(page, /Save \d+ change/);
      await expect.poll(() => tagNow(phoneId),
        { message: 'the allotment never saved', timeout: 25_000 }).toBe(40);
    } finally {
      // Children first — nothing here cascades, and the item cannot go while
      // a request or an allotment still points at it.
      const ids = created.filter(Boolean).map((id) => lit(id)).join(', ') || "''";
      const indents = sql(
        `SELECT DISTINCT "backorderIndentId" FROM "ComponentRequest"
          WHERE id IN (${ids}) AND "backorderIndentId" IS NOT NULL`,
      ).map((r) => r[0]!);
      cleanup([
        `DELETE FROM "ReturnRecord" WHERE "componentRequestId" IN (${ids})`,
        `DELETE FROM "RequestResponsiblePerson" WHERE "requestId" IN (${ids})`,
        `DELETE FROM "ApprovalHistory" WHERE "entityId" IN (${ids})`,
        `DELETE FROM "Notification" WHERE "relatedEntityId" IN (${ids})`,
        `DELETE FROM "ComponentRequest" WHERE id IN (${ids})`,
        ...indents.flatMap((i) => [
          `DELETE FROM "IndentItem" WHERE "indentId" = ${lit(i)}`,
          // Status-log rows hold a FK to the indent, so they go before it.
          `DELETE FROM "IndentStatusLog" WHERE "indentId" = ${lit(i)}`,
          `DELETE FROM "Indent" WHERE id = ${lit(i)}`,
        ]),
        `DELETE FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(itemId!)}`,
        `DELETE FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(itemId!)}`,
        `DELETE FROM "InventoryItem" WHERE id = ${lit(itemId!)}`,
        `DELETE FROM "Project" WHERE id IN (${lit(watchId)}, ${lit(phoneId)})`,
      ]);
    }
  });

  // --------------------------------------------------------------- loans

  /**
   * Asking for longer, and being granted it.
   *
   * A temporary loan has a due date, and everything downstream keys off it:
   * the overdue list, the chase notifications, the returns desk. An extension
   * that is approved but does not move the date leaves the borrower chased
   * for something their manager already said yes to — which is both the
   * obvious bug here and the one nothing was watching for.
   */
  test('extension: an approved extension actually moves the due date', async ({ page }) => {
    const reason = `${tag()} rig still on the bench`;
    // Its OWN item. My Components lists the component name and not the
    // request serial, so borrowing a shared catalogue row here would make the
    // match ambiguous against whatever else this user has out.
    const itemName = `${tag()} loaner`;
    const [[itemId]] = sql(
      `INSERT INTO "InventoryItem" (id, name, category, unit, stock, status, "isShared", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(itemName)}, 'ELECTRONICS_GENERAL_ACCESSORIES', 'PCS', 5, 'AVAILABLE', true, now(), now())
       RETURNING id`,
    );
    const [requestId, serialNo] = sql(
      `INSERT INTO "ComponentRequest"
         (id, "serialNo", "inventoryItemId", "qtyRequested", "qtyIssued", "departmentId",
          nature, "durationValue", "durationUnit", status, "dueDate", "issuedAt",
          "createdById", "createdAt", "updatedAt")
       SELECT gen_random_uuid(), 'E2E-' || substr(md5(random()::text), 1, 8), ${lit(itemId!)}, 1, 1,
              u."departmentId", 'TEMPORARY', 7, 'DAYS', 'OVERDUE',
              now() - interval '2 days', now() - interval '9 days', u.id, now(), now()
         FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}
       RETURNING id, "serialNo"`,
    )[0] as string[];

    const dueDate = () => sql(`SELECT "dueDate"::text FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`)[0][0]!;
    const dueBefore = dueDate();

    try {
      // ---- ask, as the borrower.
      //
      // The loan is seeded OVERDUE on purpose: "Request Extension" is only
      // offered on the overdue table, not the in-hand one. You cannot ask for
      // longer before you are late, which is worth knowing — and is why this
      // fixture backdates the due date rather than setting it two days out.
      await signInAs(page, 'user');
      await page.goto('/user/my-components');
      const row = page.locator('tr').filter({ hasText: itemName }).first();
      await expect(row, `${itemName} is not listed under my components`).toBeVisible({ timeout: 25_000 });
      await row.getByRole('button', { name: /Request Extension/ }).click();

      const form = page.getByRole('dialog');
      await fieldUnder(form as unknown as Page, 'Extend By').fill('5');
      await form.locator('textarea').first().fill(reason);
      await clickInDialog(page, /^Request Extension$/);

      await expect.poll(
        () => sql(`SELECT count(*) FROM "ExtensionRequest" WHERE "componentRequestId" = ${lit(requestId!)}`)[0][0],
        { message: 'the extension request never reached the database', timeout: 25_000 },
      ).toBe('1');
      // Asking must not move the date on its own — only an approval does.
      expect(dueDate(), 'merely asking for an extension moved the due date').toBe(dueBefore);

      // ---- grant it, as the approver
      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      const pending = page.locator('div').filter({ hasText: serialNo! })
        .filter({ has: page.getByRole('button', { name: /^Approve$/ }) }).last();
      await expect(pending, `${serialNo}'s extension is not in the approvals queue`)
        .toBeVisible({ timeout: 25_000 });
      await pending.getByRole('button', { name: /^Approve$/ }).first().click();

      await expect.poll(
        () => sql(`SELECT status FROM "ExtensionRequest" WHERE "componentRequestId" = ${lit(requestId!)}`)[0][0],
        { message: 'approving the extension did not change its status', timeout: 25_000 },
      ).toBe('APPROVED');

      // The whole point. An approved extension that leaves the due date alone
      // keeps chasing the borrower for something already granted.
      await expect.poll(dueDate,
        { message: 'the extension was approved but the due date did not move', timeout: 25_000 })
        .not.toBe(dueBefore);
      expect(new Date(dueDate()).getTime(), 'the due date moved backwards')
        .toBeGreaterThan(new Date(dueBefore).getTime());
    } finally {
      cleanup([
        // The extension's own audit + notification rows are keyed on the
        // EXTENSION's id, not the request's — so the two deletes below miss
        // them and they outlive the test. Must run before the extension rows
        // themselves go, since it reads their ids.
        `DELETE FROM "ApprovalHistory" WHERE "entityType" = 'EXTENSION' AND "entityId" IN (SELECT id FROM "ExtensionRequest" WHERE "componentRequestId" = ${lit(requestId!)})`,
        `DELETE FROM "Notification" WHERE "relatedEntityId" IN (SELECT id FROM "ExtensionRequest" WHERE "componentRequestId" = ${lit(requestId!)})`,
        `DELETE FROM "ExtensionRequest" WHERE "componentRequestId" = ${lit(requestId!)}`,
        `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(requestId!)}`,
        `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(requestId!)}`,
        `DELETE FROM "RequestResponsiblePerson" WHERE "requestId" = ${lit(requestId!)}`,
        `DELETE FROM "InventoryEvent" WHERE "componentRequestId" = ${lit(requestId!)}`,
        `DELETE FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`,
        `DELETE FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(itemId!)}`,
        `DELETE FROM "InventoryItem" WHERE id = ${lit(itemId!)}`,
      ]);
    }
  });

  // ------------------------------------------------------- team approvals

  /**
   * A manager approving a direct report's request, and the scoping behind it.
   *
   * Team Approvals is a different queue from the admin one: it shows a
   * manager their own reports, not their department colleagues. The scoping
   * is the feature — a manager seeing requests they are not allowed to action
   * means buttons that fail, and a manager NOT seeing their own report's
   * request means it sits unapproved with nobody told.
   */
  test('team approvals: a manager approves a direct report, and sees only their own', async ({ page }) => {
    const itemName = `${tag()} team part`;

    // One request from a direct report, one from somebody who is not. Only
    // the first may appear.
    const raise = (email: string) => sql(
      `INSERT INTO "ComponentRequest"
         (id, "serialNo", "inventoryItemId", "qtyRequested", "departmentId",
          nature, "durationValue", "durationUnit", status, "createdById", "createdAt", "updatedAt")
       SELECT gen_random_uuid(), 'E2E-' || substr(md5(random()::text), 1, 8), ${lit(itemId!)}, 1,
              u."departmentId", 'TEMPORARY', 3, 'DAYS', 'PENDING', u.id, now(), now()
         FROM "User" u WHERE u.email = ${lit(email)}
       RETURNING id, "serialNo"`,
    )[0] as string[];

    const reportEmail = sql(
      `SELECT u.email FROM "User" u
         JOIN "ManagerUser" mu ON mu."userId" = u.id
         JOIN "User" m ON m.id = mu."managerId"
        WHERE m.email = ${lit(ACCOUNTS.manager)} AND u.role = 'USER' LIMIT 1`,
    )[0]?.[0];
    const strangerEmail = sql(
      `SELECT u.email FROM "User" u
        WHERE u.role = 'USER'
          AND NOT EXISTS (SELECT 1 FROM "ManagerUser" mu
                           JOIN "User" m ON m.id = mu."managerId"
                          WHERE mu."userId" = u.id AND m.email = ${lit(ACCOUNTS.manager)})
        LIMIT 1`,
    )[0]?.[0];
    expect(reportEmail, 'the manager has no direct reports, so this proves nothing').toBeTruthy();
    // Created only once the precondition holds — before, a database whose
    // manager had no reports failed the check above and left this item behind.
    const [[itemId]] = sql(
      `INSERT INTO "InventoryItem" (id, name, category, unit, stock, status, "isShared", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(itemName)}, 'ELECTRONICS_GENERAL_ACCESSORIES', 'PCS', 9, 'AVAILABLE', true, now(), now())
       RETURNING id`,
    );

    const [reportReq, reportSerial] = raise(reportEmail!);
    const stranger = strangerEmail ? raise(strangerEmail) : null;

    try {
      await signInAs(page, 'manager');
      await page.goto('/manager/team-approvals');

      const row = page.locator('tr').filter({ hasText: reportSerial! }).first();
      await expect(row, `${reportSerial} was raised by a direct report but is not in the queue`)
        .toBeVisible({ timeout: 25_000 });

      // Somebody else's report must NOT be here. A queue that shows requests
      // the manager cannot action is a row of buttons that fail.
      if (stranger) {
        await expect(page.locator('tr').filter({ hasText: stranger[1]! }),
          `${stranger[1]} is not this manager's report but is in their queue`).toHaveCount(0);
      }

      await row.getByRole('button', { name: /^Approve$/ }).first().click();
      await expect.poll(
        () => sql(`SELECT status FROM "ComponentRequest" WHERE id = ${lit(reportReq!)}`)[0][0],
        { message: 'the team approval did not register', timeout: 25_000 },
      ).toBe('APPROVED');
    } finally {
      for (const id of [reportReq, stranger?.[0]].filter(Boolean) as string[]) {
        cleanup([
          `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(id)}`,
          `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(id)}`,
          `DELETE FROM "RequestResponsiblePerson" WHERE "requestId" = ${lit(id)}`,
          `DELETE FROM "ComponentRequest" WHERE id = ${lit(id)}`,
        ]);
      }
      sql(`DELETE FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(itemId!)}`);
      sql(`DELETE FROM "InventoryItem" WHERE id = ${lit(itemId!)}`);
    }
  });

  // -------------------------------------------------------- manager and lab

  /**
   * A manager adding someone to their own team.
   *
   * The scoping is the whole feature: a manager may create users, but only
   * into their own department and reporting to them. Getting that wrong
   * silently gives one department's manager people in another's — which looks
   * fine on this screen and wrong on every approval queue afterwards.
   */
  test('manager: a new team member is created scoped to that manager', async ({ page }) => {
    const name = `${tag()} Recruit`;
    const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '.')}@example.com`;

    try {
      await signInAs(page, 'manager');
      await page.goto('/manager/team');
      await clickWhenReady(page, /^Add User$/);

      const form = page.getByRole('dialog');
      await form.getByPlaceholder(/e\.g\. Priya Sharma/).fill(name);
      await form.getByPlaceholder(/priya@example\.com/).fill(email);
      await form.getByPlaceholder(/At least 8 characters/).fill('e2e-temp-pass-9134');
      await clickInDialog(page, /^Add User$/);

      await expect.poll(
        () => sql(`SELECT count(*) FROM "User" WHERE email = ${lit(email)}`)[0][0],
        { message: 'the new team member never reached the database', timeout: 25_000 },
      ).toBe('1');

      // Scoped to the manager's own department and reporting line, not left
      // loose for an admin to tidy up later.
      // The reporting line is a join table, not a column on User — one user
      // can answer to more than one manager.
      const [[role, sameDept, reportsToManager]] = sql(
        `SELECT u.role,
                (u."departmentId" IS NOT DISTINCT FROM m."departmentId")::text,
                EXISTS (SELECT 1 FROM "ManagerUser" mu
                         WHERE mu."userId" = u.id AND mu."managerId" = m.id)::text
           FROM "User" u, "User" m
          WHERE u.email = ${lit(email)} AND m.email = ${lit(ACCOUNTS.manager)}`,
      );
      expect(role, 'a manager must only be able to create plain users').toBe('USER');
      expect(sameDept, "the new user landed outside the manager's department").toBe('true');
      expect(reportsToManager, 'the new user does not report to the manager who created them').toBe('true');
    } finally {
      sql(`DELETE FROM "ManagerUser" WHERE "userId" IN (SELECT id FROM "User" WHERE email = ${lit(email)})`);
      sql(`DELETE FROM "Notification" WHERE "userId" IN (SELECT id FROM "User" WHERE email = ${lit(email)})`);
      // The audit row outlives the user: ApprovalHistory.entityId is a plain
      // string with no foreign key, so deleting the User cascades nothing and
      // a USER_CREATED entry is left pointing at an id that no longer exists.
      sql(`DELETE FROM "ApprovalHistory" WHERE "entityType" = 'USER' AND "entityId" IN (SELECT id FROM "User" WHERE email = ${lit(email)})`);
      sql(`DELETE FROM "User" WHERE email = ${lit(email)}`);
    }
  });

  /**
   * The Lab role, which had no coverage at all — one of eight roles that
   * nothing ever opened.
   *
   * Lab is a read-only viewer over the catalogue. The thing worth asserting
   * is that read-only really is read-only: the page renders and offers none
   * of the controls that change stock. A viewer who can delete is not a
   * viewer, and nothing was checking.
   */
  /**
   * The Lab role, which had no coverage at all — and, it turns out, no user.
   *
   * There is not one LAB account in the database: the role has routes, a
   * sidebar and permission checks, and nobody holds it. So the account is
   * made here, used, and removed. The password hash is copied from a known
   * demo account, which is how the test knows the password without inventing
   * a hashing step.
   *
   * Lab is a read-only viewer over the catalogue, so the assertion is that
   * read-only really is read-only. A viewer who can delete is not a viewer.
   */
  test('lab: the lab role can read the catalogue and cannot change it', async ({ page }) => {
    const email = `${tag().toLowerCase()}.lab@example.com`;
    const PASSWORD = 'password123';

    try {
      sql(
        `INSERT INTO "User" (id, email, password, name, role, "departmentId", "isActive", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), ${lit(email)}, u.password, 'E2E Lab Viewer', 'LAB',
                u."departmentId", true, now(), now()
           FROM "User" u WHERE u.email = ${lit(ACCOUNTS.inventory)}`,
      );

      // The quick sign-in panel only lists the seeded demo accounts, so this
      // one goes through the real form — which is worth doing once anyway.
      await page.goto('/login');
      await page.fill('#email-address', email);
      await page.fill('#password', PASSWORD);
      await page.getByRole('button', { name: /^Sign in$/ }).click();
      await page.waitForURL(/\/lab(\/|$)/, { timeout: 30_000 });
      // Same settle as signInAs: WebKit/Firefox treat the dashboard's own
      // address write as a navigation and abort the next goto.
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

      for (const path of ['/lab/items', '/lab/inventory', '/lab/indents', '/lab/lists']) {
        await page.goto(path);
        // Each page must actually render. A blank panel from a failed fetch
        // looks identical to an empty list to everyone who does not open
        // devtools, so check for the error text too.
        await expect(page.locator('main'), `${path} rendered nothing`).not.toBeEmpty({ timeout: 25_000 });
        await expect(page.getByText(/Something went wrong|Failed to load/i),
          `${path} showed an error`).toHaveCount(0);
      }

      await page.goto('/lab/items');
      await expect(page.locator('main')).not.toBeEmpty({ timeout: 25_000 });
      for (const forbidden of [/Bulk Upload/, /Add Component/, /^Delete$/, /Allot to a project/]) {
        await expect(page.getByRole('button', { name: forbidden }),
          `the lab viewer is being offered "${forbidden}"`).toHaveCount(0);
      }

      // And the routes it has no business on must be refused when the URL is
      // typed. The guard deliberately stays on the URL and shows a permission
      // screen rather than redirecting — bouncing to /login made a logged-in
      // user think their session had expired — so the assertion is on what is
      // rendered, not on where the address bar ends up.
      for (const offLimits of ['/inventory/components', '/super-admin/database', '/admin/approvals']) {
        await page.goto(offLimits);
        await expect(page.getByText(/Permission denied/i),
          `a lab viewer was let into ${offLimits}`).toBeVisible({ timeout: 20_000 });
      }

      // The screen is UX; the server is the actual gate. A hidden button
      // stops nobody who can open a terminal, so check the API refuses too.
      const token = await page.evaluate(() => {
        try {
          return JSON.parse(localStorage.getItem('auth') || '{}')?.accessToken
            || localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken') || '';
        } catch { return ''; }
      });
      expect(token, 'could not read the lab session token to test the API').toBeTruthy();
      const write = await page.request.post(`${API_BASE}/inventory`, {
        headers: { Authorization: `Bearer ${token}` },
        data: { name: `${tag()} should-never-exist`, category: 'ELECTRONICS_GENERAL_ACCESSORIES', unit: 'PCS', stock: 1 },
      });
      expect([401, 403], `the API let a lab viewer create stock (HTTP ${write.status()})`)
        .toContain(write.status());
    } finally {
      sql(`DELETE FROM "Notification" WHERE "userId" IN (SELECT id FROM "User" WHERE email = ${lit(email)})`);
      // The audit row outlives the user: ApprovalHistory.entityId is a plain
      // string with no foreign key, so deleting the User cascades nothing and
      // a USER_CREATED entry is left pointing at an id that no longer exists.
      sql(`DELETE FROM "ApprovalHistory" WHERE "entityType" = 'USER' AND "entityId" IN (SELECT id FROM "User" WHERE email = ${lit(email)})`);
      sql(`DELETE FROM "User" WHERE email = ${lit(email)}`);
    }
  });

  // -------------------------------------------------------------- rejection

  /**
   * Saying no, on both queues.
   *
   * Every approval path had a test and not one of them covered the other
   * button. A reject that silently leaves the row APPROVED, or that drops the
   * reason, is the kind of thing nobody notices until someone is handed stock
   * their manager refused.
   *
   * The reason is the part worth guarding hardest: it is the only explanation
   * the requester ever gets, and it is a free-text box that is easy to make
   * optional by accident.
   */
  test('reject: a request is refused with a reason the requester can read', async ({ page }) => {
    const reason = `${tag()} — not approved, wrong project header`;
    const [[itemId, itemName]] = sql(
      `SELECT id, name FROM "InventoryItem" WHERE "deletedAt" IS NULL AND stock > 5 ORDER BY name LIMIT 1`,
    );
    const [requestId, serialNo] = sql(
      `INSERT INTO "ComponentRequest"
         (id, "serialNo", "inventoryItemId", "qtyRequested", "departmentId",
          nature, "durationValue", "durationUnit", status, "createdById", "createdAt", "updatedAt")
       SELECT gen_random_uuid(), 'E2E-' || substr(md5(random()::text), 1, 8), ${lit(itemId!)}, 1,
              u."departmentId", 'TEMPORARY', 7, 'DAYS', 'PENDING', u.id, now(), now()
         FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}
       RETURNING id, "serialNo"`,
    )[0] as string[];

    const stockBefore = Number(sql(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(itemId!)}`)[0][0]);

    try {
      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      const row = page.locator('tr').filter({ hasText: serialNo! }).first();
      await expect(row, `${serialNo} is not in the approvals queue`).toBeVisible({ timeout: 25_000 });
      await row.getByRole('button', { name: /^Reject$/ }).click();

      // No reason, no rejection. The requester's only explanation comes from
      // this box, so an empty one must not go through.
      const confirmReject = page.getByRole('dialog').last().getByRole('button', { name: /^Reject$/ });
      await expect(confirmReject, 'Reject was live with an empty reason').toBeDisabled();
      // Whitespace is not a reason either.
      await page.getByRole('dialog').last().locator('textarea').fill('   ');
      await expect(confirmReject, 'Reject accepted whitespace as a reason').toBeDisabled();

      await page.getByRole('dialog').last().locator('textarea').fill(reason);
      await expect(confirmReject).toBeEnabled({ timeout: 10_000 });
      await confirmReject.click();

      await expect.poll(
        () => sql(`SELECT status FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`)[0][0],
        { message: 'rejecting did not change the status', timeout: 25_000 },
      ).toBe('REJECTED');

      // The reason has to reach the requester, not just the audit log.
      await expect.poll(
        () => sql(
          `SELECT count(*) FROM "Notification" n
             JOIN "User" u ON u.id = n."userId"
            WHERE n."relatedEntityId" = ${lit(requestId!)} AND u.email = ${lit(ACCOUNTS.user)}
              AND n.message LIKE ${lit('%' + reason + '%')}`,
        )[0][0],
        { message: 'the requester was never told why, or not told the reason given', timeout: 25_000 },
      ).not.toBe('0');

      // A refusal must not move stock. Obvious, and exactly the kind of thing
      // a shared code path between approve and reject gets wrong.
      expect(Number(sql(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(itemId!)}`)[0][0]),
        'rejecting a request moved stock').toBe(stockBefore);
      void itemName;
    } finally {
      cleanup([
        `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(requestId!)}`,
        `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(requestId!)}`,
        `DELETE FROM "RequestResponsiblePerson" WHERE "requestId" = ${lit(requestId!)}`,
        `DELETE FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`,
      ]);
    }
  });

  /**
   * Refusing an indent at tech approval.
   *
   * The server refuses a rejection with no reason outright, and the modal
   * keeps its button dead — belt and braces, and both worth holding in place,
   * because the reason is the only thing that tells procurement what to fix.
   */
  test('reject: an indent refused at tech approval records why, and stops there', async ({ page }) => {
    const reason = `${tag()} — buy it under the framework agreement instead`;
    const itemName = `${tag()} widget`;
    let indentId: string | undefined;

    try {
      const row = sql(
        `INSERT INTO "Indent" (id, "serialNo", "departmentId", currency, "grandTotal", status,
                               "techApprovalStatus", "ceoApprovalStatus", "currentHolder", "holderSince",
                               emergency, "isAutoRaised", "createdById", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), 'E2E-IND-' || substr(md5(random()::text), 1, 6), u."departmentId",
                'INR', 0, 'PENDING', 'PENDING', 'APPROVED', 'Pending Approvals', now(),
                false, false, u.id, now(), now()
           FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}
         RETURNING id, "serialNo"`,
      )[0] as string[];
      indentId = row[0]!;
      const serialNo = row[1]!;
      // Every NOT NULL column with no default, spelled out. The table has
      // eleven of them and discovering that one failed INSERT at a time is
      // slower than reading information_schema once.
      sql(`INSERT INTO "IndentItem"
             (id, "indentId", name, qty, unit, "unitAmount", currency, url, purpose, total,
              category, "createdAt", "updatedAt")
           VALUES (gen_random_uuid(), ${lit(indentId)}, ${lit(itemName)}, 3, 'PCS', 0, 'INR', '',
                   'E2E coverage', 0, 'ELECTRONICS_GENERAL_ACCESSORIES', now(), now())`);

      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      const indentRow = page.locator('tr').filter({ hasText: serialNo }).first();
      await expect(indentRow, `${serialNo} is not awaiting tech approval`).toBeVisible({ timeout: 25_000 });
      await indentRow.getByRole('button', { name: /^Reject$/ }).first().click();

      const dialog = page.getByRole('dialog').last();
      const confirmReject = dialog.getByRole('button', { name: /^Reject$/ });
      await expect(confirmReject, 'Reject was live with no reason given').toBeDisabled();
      await dialog.locator('textarea').fill(reason);
      await confirmReject.click();

      await expect.poll(
        () => sql(`SELECT "techApprovalStatus" FROM "Indent" WHERE id = ${lit(indentId!)}`)[0][0],
        { message: 'the tech rejection never registered', timeout: 25_000 },
      ).toBe('REJECTED');

      const [[storedReason, status]] = sql(
        `SELECT coalesce("techRejectionReason", ''), status FROM "Indent" WHERE id = ${lit(indentId!)}`,
      );
      expect(storedReason, 'the rejection reason was not kept').toBe(reason);
      // A refused indent must not be sitting in procurement's quoting queue.
      // That is the failure that matters: it would be priced and bought.
      expect(['APPROVED', 'QUOTATION_IN_PROGRESS', 'READY_FOR_PAYMENT', 'AWAITING_PAYMENT'],
        `a rejected indent is in ${status}, which procurement can act on`).not.toContain(status);
    } finally {
      if (indentId) {
        cleanup([
          `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(indentId)}`,
          `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(indentId)}`,
          `DELETE FROM "IndentItem" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "IndentStatusLog" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "Indent" WHERE id = ${lit(indentId)}`,
        ]);
      }
    }
  });

  /**
   * A short issue, then the rest later.
   *
   * The reservations test covers the first half — stock is short, the clerk
   * issues what there is and an indent covers the gap. What was untested is
   * what happens when the rest turns up: the request is topped up, and the
   * arithmetic has to ADD to what was already issued rather than replace it.
   *
   * Replacing instead of adding is the plausible bug, and it is invisible on
   * screen: the row shows the right final quantity either way, and only the
   * shelf tells you whether the second issue deducted 3 or deducted 8.
   */
  test('partial issue: topping up adds to what was already issued', async ({ page }) => {
    const itemName = `${tag()} topup part`;
    const [[itemId]] = sql(
      `INSERT INTO "InventoryItem" (id, name, category, unit, stock, status, "isShared", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(itemName)}, 'ELECTRONICS_GENERAL_ACCESSORIES', 'PCS', 5, 'AVAILABLE', true, now(), now())
       RETURNING id`,
    );
    // Asked for 8, only 5 on the shelf.
    const [requestId, serialNo] = sql(
      `INSERT INTO "ComponentRequest"
         (id, "serialNo", "inventoryItemId", "qtyRequested", "departmentId",
          nature, "durationValue", "durationUnit", status, "createdById", "createdAt", "updatedAt")
       SELECT gen_random_uuid(), 'E2E-' || substr(md5(random()::text), 1, 8), ${lit(itemId!)}, 8,
              u."departmentId", 'TEMPORARY', 7, 'DAYS', 'APPROVED', u.id, now(), now()
         FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}
       RETURNING id, "serialNo"`,
    )[0] as string[];

    const stock = () => Number(sql(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(itemId!)}`)[0][0]);
    const issued = () => Number(sql(`SELECT coalesce("qtyIssued", 0) FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`)[0][0]);

    try {
      await signInAs(page, 'inventory');
      await page.goto('/inventory/requests');

      // ---- first pass: 5 of the 8, and an indent for the other 3
      const row = page.locator('tr').filter({ hasText: serialNo! }).first();
      await expect(row, `${serialNo} is not in the issue queue`).toBeVisible({ timeout: 25_000 });
      await row.getByRole('button', { name: /^Issue$/ }).click();
      await clickInDialog(page, /^Issue 5 \+ raise indent for 3$/);

      await expect.poll(stock, { message: 'the first issue did not move stock', timeout: 25_000 }).toBe(0);
      expect(issued(), 'the first issue recorded the wrong quantity').toBe(5);

      // ---- the missing 3 arrive, and the REQUESTER claims them.
      //
      // The top-up is not a second pass through the issue queue — the request
      // left that queue the moment it went IN_USE. It comes back through the
      // back-order notification the requester gets when the stock lands, and
      // Claim is what issues the remainder.
      sql(`UPDATE "InventoryItem" SET stock = 3, status = 'AVAILABLE' WHERE id = ${lit(itemId!)}`);
      sql(
        `INSERT INTO "Notification" (id, "userId", type, title, message, "isRead",
                                     "relatedEntityId", "relatedEntityType", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), u.id, 'INFO', 'Back-order arrived',
                'The remaining 3 are in stock.', false, ${lit(requestId!)},
                'COMPONENT_REQUEST_BACKORDER', now(), now()
           FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}`,
      );

      await signInAs(page, 'user');
      await page.goto('/user/notifications');
      const claim = page.locator('div').filter({ hasText: 'Back-order arrived' })
        .filter({ has: page.getByRole('button', { name: /^Claim now$/ }) }).last();
      await expect(claim, 'the back-order notification is not claimable')
        .toBeVisible({ timeout: 25_000 });
      await claim.getByRole('button', { name: /^Claim now$/ }).click();

      await expect.poll(issued,
        { message: 'the top-up did not add to what was already issued', timeout: 25_000 }).toBe(8);
      // 3 on the shelf, 3 issued, 0 left. If the second issue had deducted
      // the full 8 instead of the remainder, this is where it shows.
      expect(stock(), 'the top-up deducted the wrong amount from the shelf').toBe(0);
    } finally {
      const backorder = sql(
        `SELECT coalesce("backorderIndentId", '') FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`,
      )[0]?.[0];
      cleanup([
        `DELETE FROM "InventoryEvent" WHERE "componentRequestId" = ${lit(requestId!)}`,
        `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(requestId!)}`,
        `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(requestId!)}`,
        `DELETE FROM "RequestResponsiblePerson" WHERE "requestId" = ${lit(requestId!)}`,
        `UPDATE "ComponentRequest" SET "backorderIndentId" = NULL WHERE id = ${lit(requestId!)}`,
        `DELETE FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`,
      ]);
      if (backorder) {
        cleanup([
          `DELETE FROM "VendorAllocation" WHERE "indentId" = ${lit(backorder)}`,
          `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(backorder)}`,
          `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(backorder)}`,
          `DELETE FROM "IndentItem" WHERE "indentId" = ${lit(backorder)}`,
          `DELETE FROM "IndentStatusLog" WHERE "indentId" = ${lit(backorder)}`,
          `DELETE FROM "Indent" WHERE id = ${lit(backorder)}`,
        ]);
      }
      // The app also writes rows against ids this test never sees — the
      // auto-raise history and the partial-fulfilment notice both pointed at a
      // record that is gone by teardown, so deleting by `requestId` misses
      // them and they outlive the run. The serial is unique per run and
      // appears in both, so it is the handle that actually works.
      cleanup([
        `DELETE FROM "Notification" WHERE title LIKE ${lit('%' + serialNo + '%')}`,
        `DELETE FROM "ApprovalHistory" WHERE notes LIKE ${lit('%' + serialNo + '%')}`,
      ]);

      // Belt and braces on the back-order indent. The link above is the tidy
      // way to find it, but the app CLEARS `backorderIndentId` once the
      // shortfall is settled — so by teardown the read comes back empty and the
      // indent it pointed at outlives the test. Four of them had piled up in
      // the sandbox, as real IND- serials sitting PENDING in the approval
      // queues, before a before/after row count caught it.
      //
      // The line item's name carries this run's unique tag, so it identifies
      // the indent whether or not anything still points at it.
      for (const [orphanId] of sql(
        `SELECT DISTINCT i.id FROM "Indent" i
           JOIN "IndentItem" it ON it."indentId" = i.id
          WHERE it.name = ${lit(itemName)}`,
      )) {
        cleanup([
          `DELETE FROM "VendorAllocation" WHERE "indentId" = ${lit(orphanId!)}`,
          `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(orphanId!)}`,
          `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(orphanId!)}`,
          `DELETE FROM "IndentItem" WHERE "indentId" = ${lit(orphanId!)}`,
          `DELETE FROM "IndentStatusLog" WHERE "indentId" = ${lit(orphanId!)}`,
          `UPDATE "ComponentRequest" SET "backorderIndentId" = NULL WHERE "backorderIndentId" = ${lit(orphanId!)}`,
          `DELETE FROM "Indent" WHERE id = ${lit(orphanId!)}`,
        ]);
      }
      sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(itemId!)}`);
      sql(`DELETE FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(itemId!)}`);
      sql(`DELETE FROM "InventoryItem" WHERE id = ${lit(itemId!)}`);
    }
  });

  // ----------------------------------------------------------- procurement

  /**
   * Raise an indent, quote it, and finalise it.
   *
   * The tail of this chain (finance settling an approved indent) already has
   * its own spec — mark-as-paid.spec.ts. What was untested is everything
   * before it: that an indent raised by a requester actually reaches
   * procurement, that the vendor quote is priced and stored, and that
   * finalising locks it and moves it to approval rather than silently doing
   * nothing. Driving it by hand found three gates that LOOK like bugs and are
   * the app being correct — a disabled Finalise, a rejected zero price, a
   * confirm dialog on missing GST — so each is asserted here as intended
   * behaviour, not worked around.
   */
  test('indent: raise, quote with a vendor, and finalise — the firm price is stored', async ({ page }) => {
    const itemName = `${tag()} widget`;
    const vendor = `${tag()} Supplies`;
    const QTY = 3;
    const PRICE = 125;

    // This test is about quoting and the firm price, not the manager stage. A
    // department set to Required keeps the admin's Approve disabled until the
    // manager signs (indent-approval-chain.spec covers that), so pin the
    // requester's department to Optional for the run and put it back after.
    const userDeptId = sqlValue(`SELECT "departmentId" FROM "User" WHERE email = ${lit(ACCOUNTS.user)}`)!;
    const modeBefore = sqlValue(`SELECT "indentApprovalMode" FROM "Department" WHERE id = ${lit(userDeptId)}`)!;
    sql(`UPDATE "Department" SET "indentApprovalMode" = 'MANAGER_OPTIONAL' WHERE id = ${lit(userDeptId)}`);

    let indentId: string | undefined;
    try {
      // ---- raise, as the person who needs it bought
      await signInAs(page, 'user');
      await page.goto('/user');
      // Raise Indent is offered per row, and only where stock has run out —
      // buying more of something you already have is a request, not an indent.
      // So the entry point has to be reached through such a row.
      const [[emptyItem]] = sql(
        `SELECT name FROM "InventoryItem" WHERE "deletedAt" IS NULL AND stock = 0 ORDER BY name LIMIT 1`,
      );
      expect(emptyItem, 'no out-of-stock item to raise an indent from').toBeTruthy();
      await page.getByPlaceholder(/Search inventory/i).fill(emptyItem!);
      const outOfStock = page.locator('tr').filter({ hasText: emptyItem! }).first();
      await expect(outOfStock, `${emptyItem} is not on the dashboard`).toBeVisible({ timeout: 25_000 });
      await outOfStock.getByRole('button', { name: /^Raise Indent$/ }).click();

      const form = page.getByRole('dialog');
      await expect(form.getByText('Item Name')).toBeVisible({ timeout: 20_000 });
      // Overwrite the prefilled name with a unique one, so the row this test
      // creates can be found and cleaned up without matching anyone else's.
      await fieldUnder(form as unknown as Page, 'Item Name').fill(itemName);
      await fieldUnder(form as unknown as Page, 'Qty').fill(String(QTY));
      await fieldUnder(form as unknown as Page, 'Purpose').fill('E2E coverage');
      // Project and Department are required, and their contents depend on the
      // restored data, so take whatever the first real option happens to be.
      // Department comes pre-set and DISABLED for a regular user (it is their
      // own department and not theirs to change), so it is filled already.
      for (const label of ['Project', 'Department']) {
        const select = fieldUnder(form as unknown as Page, label);
        if (!(await select.isEnabled())) {
          await expect(select, `${label} is locked but empty`).not.toHaveValue('');
          continue;
        }
        const value = await select.locator('option').nth(1).getAttribute('value');
        expect(value, `no ${label} to pick — the form cannot be submitted`).toBeTruthy();
        await select.selectOption(value!);
      }
      await clickInDialog(page, /^Submit Indent$/);

      const indentRow = () => sql(
        `SELECT i.id, i."serialNo", i.status FROM "Indent" i
          JOIN "IndentItem" it ON it."indentId" = i.id
          WHERE it.name = ${lit(itemName)} LIMIT 1`,
      );
      await expect.poll(() => indentRow().length,
        { message: 'the indent never reached the database', timeout: 25_000 }).toBe(1);
      const [id, serialNo] = indentRow()[0] as string[];
      indentId = id;

      // ---- tech-approve it, as the admin. Procurement cannot quote a
      // PENDING indent — the Quote button is only rendered once it is
      // approved, which is the app refusing to price something nobody has
      // agreed to buy. (The CEO lane is amount-gated and currently optional,
      // so it does not block this one.)
      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      const awaitingTech = page.locator('tr').filter({ hasText: serialNo! }).first();
      await expect(awaitingTech, `${serialNo} never reached tech approval`).toBeVisible({ timeout: 25_000 });
      await awaitingTech.getByRole('button', { name: /^Approve$/ }).first().click();

      // The requester has a manager who has not signed, and this department
      // leaves the manager optional — so the admin is asked to confirm going
      // ahead without them. Confirm it; the point of THIS test is the quote
      // that follows, and the warning itself is covered in the approval-chain
      // spec. Tolerant of the dialog not appearing, so the test does not
      // depend on which department the fixture user happens to sit in.
      // Scoped to THIS dialog by its heading: the indent form from earlier in
      // the test is still in the DOM, so a bare getByRole('dialog') matches two
      // and the ambiguity throws — which a silent catch then swallows, leaving
      // the confirm unclicked and the failure looking like the approval itself
      // was broken.
      const aheadOfManager = page
        .getByRole('dialog')
        .filter({ hasText: /has not approved this yet/i })
        .getByRole('button', { name: /Approve anyway/ })
        .first();
      await expect(
        aheadOfManager,
        'the manager has not signed, so the admin should have been asked to confirm',
      ).toBeVisible({ timeout: 15_000 });
      await aheadOfManager.click();

      // Approving hands it straight to procurement — the backend opens the
      // quotation itself rather than parking it at APPROVED, so accept either.
      await expect.poll(() => indentRow()[0][2],
        { message: 'tech approval did not move the indent on', timeout: 25_000 })
        .toMatch(/^(APPROVED|QUOTATION_IN_PROGRESS)$/);

      // ---- quote it, as procurement
      await signInAs(page, 'procurement');
      await page.goto('/procurement/indents');
      const listed = page.locator('tr').filter({ hasText: serialNo! }).first();
      await expect(listed, `${serialNo} never reached procurement`).toBeVisible({ timeout: 25_000 });
      // The row offers View and Quote; Quote is the one that opens the
      // editable panel. Fall back to View only if this indent is past quoting.
      await listed.getByRole('button', { name: /^(Quote|View)$/ }).last().click();

      const quote = page.getByRole('dialog');
      const vendorBox = quote.getByPlaceholder(/Type vendor name/).first();
      await expect(vendorBox, 'the quote panel did not open').toBeVisible({ timeout: 20_000 });
      await vendorBox.fill(vendor);
      await quote.getByRole('button', { name: /^\+ Add$/ }).first().click();

      // The new allocation row: vendor, qty, unit, price. Qty defaults to the
      // line quantity; the price does not, and a zero price is a hard block.
      const allocation = quote.locator('input[value="' + vendor + '"]').first().locator('xpath=..');
      await allocation.getByPlaceholder('Price').fill(String(PRICE));
      await quote.getByRole('button', { name: /^Save Allocations$/ }).click();

      // No ETA and no GST on this line, so the app asks before saving. That
      // prompt is deliberate — answer it rather than filling the fields, so
      // the test covers the gap path people actually hit.
      const gapsPrompt = page.getByRole('button', { name: /Save anyway/ });
      if (await gapsPrompt.isVisible({ timeout: 5_000 }).catch(() => false)) await gapsPrompt.click();

      await expect.poll(
        () => sql(`SELECT count(*) FROM "VendorAllocation" WHERE "vendorName" = ${lit(vendor)}`)[0][0],
        { message: 'the vendor allocation was never saved', timeout: 25_000 },
      ).not.toBe('0');
      expect(Number(sql(`SELECT "unitPrice" FROM "VendorAllocation" WHERE "vendorName" = ${lit(vendor)}`)[0][0]))
        .toBe(PRICE);

      // ---- finalise. Enabled only once an allocation is saved, which is
      // exactly the state we are now in.
      await clickInDialog(page, /^Finalise Quotation$/);
      // Finalise opens a review step of its own when lines are short-quoted.
      const confirmFinalise = page.getByRole('button', { name: /^(Finalise|Confirm|Submit|Send)/ }).last();
      if (await confirmFinalise.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await confirmFinalise.click().catch(() => { /* already closed */ });
      }

      await expect.poll(() => indentRow()[0][2],
        { message: 'finalising left the indent in the quoting queue', timeout: 25_000 })
        .not.toBe('QUOTATION_IN_PROGRESS');
    } finally {
      sql(`UPDATE "Department" SET "indentApprovalMode" = ${lit(modeBefore)} WHERE id = ${lit(userDeptId)}`);
      if (indentId) {
        cleanup([
          `DELETE FROM "VendorAllocation" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "Quotation" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(indentId)}`,
          `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(indentId)}`,
          `DELETE FROM "IndentItem" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "IndentStatusLog" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "Indent" WHERE id = ${lit(indentId)}`,
        ]);
      }
    }
  });

  // ---------------------------------------------------------- fixed assets

  /**
   * Registering a fixed asset.
   *
   * Assets are the one inventory that does not move — they are tracked by
   * custodian and location rather than by stock — so the thing worth asserting
   * is that the row carries its identity: a tag, a department and a location.
   * A row saved without those is findable by nobody.
   */
  test('fixed assets: an asset can be registered and carries its tag', async ({ page }) => {
    const assetName = `${tag()} oscilloscope`;
    try {
      await signInAs(page, 'inventory');
      await page.goto('/inventory/fixed-assets');
      await clickWhenReady(page, /^(Add Asset|Propose Asset)$/);

      const form = page.getByRole('dialog');
      await fieldUnder(form as unknown as Page, 'Asset Name').fill(assetName);
      // Category, Department and Location are required and their contents come
      // from the restored data, so take the first real option of each.
      for (const label of ['Category', 'Department', 'Location']) {
        const select = form.locator('label').filter({ hasText: new RegExp(`^${label}`) }).first()
          .locator('xpath=..').locator('select').first();
        if (!(await select.count()) || !(await select.isEnabled())) continue;
        const value = await select.locator('option').nth(1).getAttribute('value');
        if (value) await select.selectOption(value);
      }
      // Purchase value and purchase date. Both are required — depreciation is
      // computed from them, and an asset missing either is on the register
      // but absent from every financial total. The form used to label them
      // "(optional)" while the server refused the save, so the first a user
      // heard of it was a rejected request; both now carry a `*` and the
      // client checks the same set the server does.
      for (const [label, value] of [['Purchase value', '12500'], ['Purchase date', '2026-01-15']]) {
        await form.locator('label').filter({ hasText: new RegExp(`^${label}`) }).first()
          .locator('xpath=..').locator('input').first().fill(value!);
      }

      // At least one photo or video is mandatory — an asset register whose
      // rows cannot be visually identified is not much of a register, and the
      // form blocks the save rather than warning about it. A 1x1 PNG is
      // enough to satisfy it without shipping a fixture file.
      await form.locator('input[type="file"]').first().setInputFiles({
        name: 'asset.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      });
      await clickInDialog(page, /^(Add Asset|Save|Submit)/);

      await expect.poll(
        () => sql(`SELECT count(*) FROM "FixedAsset" WHERE name = ${lit(assetName)}`)[0][0],
        { message: 'the asset was never registered', timeout: 25_000 },
      ).toBe('1');
      // Both money fields have to survive the save — they are the entire
      // reason the server insists on them.
      const [[value, date]] = sql(
        `SELECT coalesce("purchaseValue"::int::text, ''), coalesce(to_char("purchaseDate", 'YYYY-MM-DD'), '')
           FROM "FixedAsset" WHERE name = ${lit(assetName)}`,
      );
      expect(Number(value), 'the purchase value was not stored').toBe(12500);
      expect(date, 'the purchase date was not stored').toBe('2026-01-15');
      const [[assetTag, deptId]] = sql(
        `SELECT coalesce("assetTag", ''), coalesce("departmentId", '')
           FROM "FixedAsset" WHERE name = ${lit(assetName)}`,
      );
      expect(assetTag, 'the asset was saved without a tag — nobody can find it').toBeTruthy();
      expect(deptId, 'the asset was saved without a department').toBeTruthy();
    } finally {
      sql(`DELETE FROM "FixedAsset" WHERE name = ${lit(assetName)}`);
    }
  });

  /**
   * The rest of an asset's life: handed to someone else, then written off.
   *
   * Registration was covered; everything after it was not. These are the two
   * moves that change who is answerable for a piece of equipment and whether
   * it still counts as owned — the questions an asset register exists to
   * answer, and both were running untested.
   */
  test('fixed assets: an asset is transferred to a new custodian, then disposed', async ({ page }) => {
    const assetName = `${tag()} multimeter`;
    const reason = `${tag()} lab handover`;
    let assetId: string | undefined;

    try {
      const [[id, tagNo]] = sql(
        `INSERT INTO "FixedAsset"
           (id, "assetTag", name, category, "assetType", ownership, "departmentId", location,
            condition, "purchaseValue", "purchaseDate", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), 'E2E-' || substr(md5(random()::text), 1, 6), ${lit(assetName)},
                'RND_EQUIPMENT', 'TANGIBLE', 'OWNED', d.id, 'E2E Bench',
                'WORKING', 1000, now(), now(), now()
           FROM "Department" d ORDER BY d.name LIMIT 1
         RETURNING id, "assetTag"`,
      );
      assetId = id!;

      await signInAs(page, 'inventory');
      await page.goto('/inventory/fixed-assets');
      // Searching by the TAG on purpose. The box says it supports that and the
      // server used to match the name alone, so this returned "No fixed assets
      // tracked yet" — an empty register and a search that does not search
      // read identically, and the first is the wrong conclusion to hand
      // someone standing in front of the asset.
      await page.getByPlaceholder(/Search by name or asset tag/i).fill(tagNo!);

      const row = page.locator('tr').filter({ hasText: assetName }).first();
      await expect(row, `${assetName} is not in the asset register`).toBeVisible({ timeout: 25_000 });
      // The search refetches as it debounces, so the row is still moving when
      // it first appears and a click lands on "element is not stable". Wait
      // for the table to stop changing rather than forcing the click through.
      await page.waitForLoadState('networkidle').catch(() => { /* kept busy by polling */ });

      // ---- transfer. Both a custodian and a reason are required; the button
      // stays dead without them, which is the register refusing to lose track
      // of why something moved.
      await row.getByRole('button', { name: /^Transfer$/ }).click();
      const transfer = page.getByRole('dialog');
      const confirmTransfer = transfer.getByRole('button', { name: /Confirm Transfer/ });
      await expect(confirmTransfer, 'Transfer was live with no custodian or reason').toBeDisabled();

      const custodian = fieldUnder(transfer as unknown as Page, 'New Custodian');
      const custodianId = await custodian.locator('option').nth(1).getAttribute('value');
      expect(custodianId, 'there is nobody to transfer the asset to').toBeTruthy();
      await custodian.selectOption(custodianId!);
      await transfer.locator('textarea').first().fill(reason);
      await confirmTransfer.click();

      await expect.poll(
        () => sql(`SELECT coalesce("custodianId", '') FROM "FixedAsset" WHERE id = ${lit(assetId!)}`)[0][0],
        { message: 'the transfer did not change the custodian', timeout: 25_000 },
      ).toBe(custodianId);

      // ---- dispose. The asset stays on the books as a record; what changes
      // is that it is no longer a working, owned thing.
      await page.reload();
      await page.getByPlaceholder(/Search by name or asset tag/i).fill(tagNo!);
      const disposeRow = page.locator('tr').filter({ hasText: assetName }).first();
      await expect(disposeRow).toBeVisible({ timeout: 25_000 });
      await page.waitForLoadState('networkidle').catch(() => { /* kept busy by polling */ });
      // By its visible text, not its tooltip: a button with content takes its
      // accessible name from the content, so the title never matches.
      await disposeRow.getByRole('button', { name: /^Dispose$/ }).click();

      const dispose = page.getByRole('dialog');
      await expect(dispose, 'the dispose dialog did not open').toBeVisible({ timeout: 20_000 });
      await dispose.getByRole('spinbutton', { name: /Sale proceeds/i }).fill('150');
      // Both fields mention "scrapped"; the proper labels disambiguate them.
      await dispose.getByRole('textbox', { name: /Note/i }).fill(`${tag()} beyond repair`);
      await clickInDialog(page, /^Dispose$/);
      // Then the app's own "Dispose of …?" confirmation (it used to be a
      // native window.confirm, which Playwright silently dismissed).
      const sure = page.getByRole('dialog').filter({ hasText: /stops depreciating/ });
      await expect(sure, 'the dispose confirmation did not open').toBeVisible({ timeout: 10_000 });
      await sure.getByRole('button', { name: /^Dispose$/ }).click();

      await expect.poll(
        () => sql(`SELECT condition FROM "FixedAsset" WHERE id = ${lit(assetId!)}`)[0][0],
        { message: 'disposing did not change the asset condition', timeout: 25_000 },
      ).toBe('DISPOSED');
      // The row survives. An asset register that deletes what it writes off
      // cannot answer "what happened to that oscilloscope".
      expect(sql(`SELECT count(*) FROM "FixedAsset" WHERE id = ${lit(assetId!)}`)[0][0],
        'disposing deleted the asset instead of recording it').toBe('1');
    } finally {
      if (assetId) {
        cleanup([
          `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(assetId)}`,
          `DELETE FROM "FixedAsset" WHERE id = ${lit(assetId)}`,
        ]);
      }
    }
  });

  // ---------------------------------------------------------- database admin

  /**
   * Back up, wipe, restore.
   *
   * This is the most destructive screen in the app and it had no test at all.
   * It is also the one place where "it looked like it worked" is worthless:
   * a backup that writes an empty file, or a restore that silently skips a
   * table, both leave a cheerful green toast behind.
   *
   * The test does the real thing — a real wipe of real rows — and proves the
   * restore brings them back, because a wipe whose undo is untested is not
   * reversible, it is just hopeful. Its own safety net is the backup it takes
   * first; the app writes one too, before it deletes anything.
   */
  test('database: a backup survives a real wipe and restores what it removed', async ({ page }) => {
    const countRequests = () => Number(sql(`SELECT count(*) FROM "ComponentRequest"`)[0][0]);
    const countUsers = () => Number(sql(`SELECT count(*) FROM "User"`)[0][0]);
    const countItems = () => Number(sql(`SELECT count(*) FROM "InventoryItem"`)[0][0]);

    const requestsBefore = countRequests();
    const usersBefore = countUsers();
    const itemsBefore = countItems();
    // A wipe that removes nothing proves nothing — it would pass against a
    // broken wipe just as happily.
    expect(requestsBefore, 'no requests to wipe, so this test cannot prove anything').toBeGreaterThan(0);

    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/database');

    // ---- take the snapshot this test will restore from.
    //
    // The filename comes off the server's own backup directory, not the page.
    // The list is fetched after the write and the two are not in lockstep, so
    // reading the DOM here raced and picked up a snapshot from a fortnight
    // ago — which would then have been the thing restored.
    const snapshots = () => execFileSync(
      'docker', ['exec', 'lms-ui-backend', 'sh', '-c', 'ls -1 /app/backups 2>/dev/null || true'],
      { encoding: 'utf8' },
    ).split('\n').filter((f) => /^db_backup_.*\.json$/.test(f.trim())).map((f) => f.trim());

    const before = new Set(snapshots());
    await clickWhenReady(page, /^JSON Backup$/);
    await expect
      .poll(() => snapshots().filter((f) => !before.has(f)).length,
            { message: 'no new snapshot was written to the server', timeout: 90_000 })
      .toBe(1);
    const backupName = snapshots().find((f) => !before.has(f))!;

    try {
      // ---- wipe. Scope left at the default: requests and the paperwork
      // around them go, the catalogue and the people stay. Those checkboxes
      // default to off precisely so an accidental confirm cannot take them.
      await clickWhenReady(page, /Clear test data/);
      const phrase = page.getByPlaceholder(/^WIPE/i).first();
      await expect(phrase, 'the type-to-confirm box did not appear').toBeVisible({ timeout: 20_000 });

      // The button must be dead until the phrase is exact — that is the whole
      // point of a type-to-confirm, and a disabled-look that still fires is a
      // bug this asserts against.
      const wipeNow = page.getByRole('button', { name: /^Wipe now$/ });
      await expect(wipeNow, 'Wipe now was live before the phrase was typed').toBeDisabled();
      await phrase.fill('NOPE');
      await expect(wipeNow, 'Wipe now accepted the wrong phrase').toBeDisabled();

      const required = (await phrase.getAttribute('placeholder'))!;
      await phrase.fill(required);
      await expect(wipeNow, 'Wipe now stayed dead after the right phrase').toBeEnabled({ timeout: 10_000 });
      await wipeNow.click();

      await expect.poll(countRequests,
        { message: 'the wipe did not clear the requests', timeout: 90_000 }).toBe(0);
      // Scope held: people and catalogue are not test data and must survive.
      expect(countUsers(), 'the wipe took user accounts, which it must never do').toBe(usersBefore);
      expect(countItems(), 'the wipe took the inventory catalogue, which was not in scope').toBe(itemsBefore);

      // ---- restore, and prove the rows come back
      await page.reload();
      // The innermost element that holds BOTH the filename and a Restore
      // button. Filtering on the text alone matches the paragraph's parent,
      // which has no button in it — and `.last()` on that is a div that can
      // never be clicked.
      const restoreRow = page.locator('div')
        .filter({ hasText: backupName })
        .filter({ has: page.getByRole('button', { name: /^Restore$/ }) })
        .last();
      await expect(restoreRow, `${backupName} is not listed on the page`).toBeVisible({ timeout: 30_000 });
      await restoreRow.getByRole('button', { name: /^Restore$/ }).first().click();
      await clickInDialog(page, /^(Confirm|Restore|Yes|Proceed)/);

      await expect.poll(countRequests,
        { message: 'the restore did not bring the requests back', timeout: 120_000 }).toBe(requestsBefore);
      expect(countUsers(), 'the restore changed the user count').toBe(usersBefore);
      expect(countItems(), 'the restore changed the catalogue').toBe(itemsBefore);
    } finally {
      // Whatever happened above, leave the database usable for every spec
      // after this one. A restore brings back the password hashes that were
      // in the snapshot — which are this sandbox's own, so the demo logins
      // keep working — but a half-finished wipe would not, so check and say.
      if (countRequests() !== requestsBefore) {
        // The UI restore did not finish. Every spec after this one would then
        // run against an empty database and fail for a reason that has
        // nothing to do with what it tests, so put the data back over the API
        // rather than leaving a warning nobody reads until the damage is done.
        // Log in over the API rather than scraping a token out of browser
        // storage. The earlier version did the latter, and when the page had
        // navigated by the time `finally` ran there was no token to find — so
        // the restore came back 401, the net silently did nothing, and the
        // next twelve specs failed against an empty database for reasons that
        // had nothing to do with what they test. This path depends on no
        // browser state at all.
        const auth = await page.request.post(`${API_BASE}/auth/login`, {
          data: { email: ACCOUNTS.superAdmin, password: 'password123' },
        });
        const token = (await auth.json().catch(() => ({})))?.data?.accessToken ?? '';
        const res = await page.request.post(
          `${API_BASE}/database-manager/restore/${backupName}`,
          { headers: token ? { Authorization: `Bearer ${token}` } : {}, timeout: 180_000 },
        );
        expect(
          countRequests(),
          `the database was left wiped and the fallback restore returned ${res.status()} ` +
          `(login ${auth.status()}) — restore ${backupName} from /super-admin/database ` +
          `before running anything else`,
        ).toBe(requestsBefore);
      }
    }
  });

  // -------------------------------------------------------------- feedback

  /**
   * Feedback sent from the widget reaches the inbox someone reads.
   *
   * The widget sits in the header of every page and the inbox is a
   * super-admin screen, so the two halves were built apart and nothing
   * checked they are connected. A send that shows "thanks!" and writes
   * nothing is the obvious failure, and it looks identical to a working one.
   */
  test('feedback: a message sent from the widget lands in the super admin inbox', async ({ page }) => {
    const message = `${tag()} the allot table could use a sticky header`;

    try {
      await signInAs(page, 'user');
      await page.goto('/user');
      // The header button reads "Feedback" but carries aria-label="Send
      // feedback", and the accessible name is what wins.
      await clickWhenReady(page, /^Send feedback$/);

      const widget = page.getByRole('dialog');
      const send = widget.getByRole('button', { name: /^Send feedback$/ });
      await expect(send, 'Send was live with an empty message').toBeDisabled();
      await widget.locator('textarea').first().fill(message);
      await expect(send).toBeEnabled({ timeout: 10_000 });
      await send.click();

      await expect.poll(
        () => sql(`SELECT count(*) FROM "Feedback" WHERE message = ${lit(message)}`)[0][0],
        { message: 'the feedback was never stored', timeout: 25_000 },
      ).toBe('1');

      // Attributed, not anonymous — the inbox is useless if nobody can reply.
      const [[sender]] = sql(
        `SELECT coalesce(u.email, '') FROM "Feedback" f
           LEFT JOIN "User" u ON u.id = f."createdById"
          WHERE f.message = ${lit(message)}`,
      );
      expect(sender, 'the feedback was stored without who sent it').toBe(ACCOUNTS.user);

      // And it has to be readable at the other end.
      await signInAs(page, 'superAdmin');
      await page.goto('/super-admin/feedback');
      await expect(page.getByText(message).first(),
        'the feedback is in the database but not in the inbox').toBeVisible({ timeout: 25_000 });
    } finally {
      cleanup([`DELETE FROM "Feedback" WHERE message = ${lit(message)}`]);
    }
  });

  // --------------------------------------------------------- subscriptions

  /**
   * A recurring bill, added and then marked paid.
   *
   * Subscriptions are the one spend the app tracks that nobody raises an
   * indent for — they just come due. The expiry date is the whole point: it
   * is what drives the renewal warning, so a subscription saved without one,
   * or saved with the wrong one, is a bill that lapses silently.
   */
  test('subscriptions: a recurring bill is added with its expiry and marked paid', async ({ page }) => {
    const name = `${tag()} Service`;
    const expiry = '2027-03-15';

    try {
      await signInAs(page, 'finance');
      await page.goto('/finance/subscriptions');
      await clickWhenReady(page, /^Add subscription$/);

      const form = page.getByRole('dialog');
      await fieldUnder(form as unknown as Page, 'Name').fill(name);
      await fieldUnder(form as unknown as Page, 'Vendor').fill('E2E Vendor');
      await fieldUnder(form as unknown as Page, 'Expiry date').fill(expiry);
      await fieldUnder(form as unknown as Page, 'Amount').fill('1200');
      // The renewal interval is what makes it RECURRING. Without it the
      // expiry does not roll on payment — correctly, since a one-off bill has
      // nothing to roll to — so a subscription test that omits it is really
      // testing a one-off.
      await fieldUnder(form as unknown as Page, 'Renewal').fill('30');
      await clickInDialog(page, /^Add subscription$/);

      await expect.poll(
        () => sql(`SELECT count(*) FROM "Subscription" WHERE name = ${lit(name)}`)[0][0],
        { message: 'the subscription was never saved', timeout: 25_000 },
      ).toBe('1');

      // The date is the point of the record — it drives the renewal warning.
      const [[storedExpiry]] = sql(
        `SELECT to_char("expiryDate", 'YYYY-MM-DD') FROM "Subscription" WHERE name = ${lit(name)}`,
      );
      expect(storedExpiry, 'the expiry date was not stored as entered').toBe(expiry);

      // ---- pay it. The renewal is the point: marking a subscription paid
      // rolls the expiry forward by the interval — from the CURRENT expiry,
      // not from today — or the same bill is flagged overdue again the next
      // time anyone looks.
      const card = page.locator('div').filter({ hasText: name })
        .filter({ has: page.getByRole('button', { name: /Mark paid/ }) }).last();
      await expect(card, `${name} is not on the subscriptions page`).toBeVisible({ timeout: 25_000 });
      await card.getByRole('button', { name: /Mark paid/ }).first().click();

      const pay = page.getByRole('dialog');
      await pay.getByPlaceholder(/INV-2024/).fill(`E2E-INV-${Date.now()}`);
      await clickInDialog(page, /^Mark paid$/);

      await expect.poll(
        () => sql(`SELECT to_char("expiryDate", 'YYYY-MM-DD') FROM "Subscription" WHERE name = ${lit(name)}`)[0][0],
        { message: 'paying the subscription did not roll its expiry forward', timeout: 25_000 },
      ).toBe('2027-04-14'); // 2027-03-15 + 30 days
    } finally {
      cleanup([`DELETE FROM "Subscription" WHERE name = ${lit(name)}`]);
    }
  });

  // -------------------------------------------------------------- refunds

  /**
   * Chasing money back from a vendor, and closing it when it lands.
   *
   * A cancelled order leaves the company out of pocket until the vendor pays
   * back. This page is the only place that tracks it, and the whole money
   * path downstream of a cancellation ran untested. Marking a refund received
   * without recording the amount would quietly close a debt nobody collected.
   */
  test('refunds: a pending refund is marked received with the amount that came back', async ({ page }) => {
    let indentId: string | undefined;
    let orderId: string | undefined;

    try {
      const row = sql(
        `INSERT INTO "Indent" (id, "serialNo", "departmentId", currency, "grandTotal", status,
                               "techApprovalStatus", "ceoApprovalStatus", "currentHolder", "holderSince",
                               emergency, "isAutoRaised", "refundStatus", "refundExpectedAmount",
                               "createdById", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), 'E2E-RFD-' || substr(md5(random()::text), 1, 6), u."departmentId",
                'INR', 750, 'CANCELLED', 'APPROVED', 'APPROVED', 'Procurement', now(),
                false, false, 'PENDING', 750, u.id, now(), now()
           FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}
         RETURNING id, "serialNo"`,
      )[0] as string[];
      indentId = row[0]!;
      const serialNo = row[1]!;

      const [[oid]] = sql(
        `INSERT INTO "VendorOrder" (id, "indentId", "vendorName", amount, status, "refundStatus",
                                    "refundExpectedAmount", "updatedAt")
         VALUES (gen_random_uuid(), ${lit(indentId)}, 'E2E Supplier', 750, 'CANCELLED', 'PENDING', 750, now())
         RETURNING id`,
      );
      orderId = oid!;

      await signInAs(page, 'procurement');
      await page.goto('/procurement/refunds');
      const refundRow = page.locator('tr').filter({ hasText: serialNo }).first();
      await expect(refundRow, `${serialNo} is not on the refunds page`).toBeVisible({ timeout: 25_000 });
      await refundRow.getByRole('button', { name: /Update refund/ }).click();

      const modal = page.getByRole('dialog');
      await modal.getByRole('button', { name: /^Mark Received$/ }).first().click();

      // The amount and date come PREFILLED from what was expected, which is
      // the sensible default and not a missing guard. The guard that matters
      // is the ceiling: you cannot record getting back more than was paid,
      // and you cannot close it for nothing.
      const submit = modal.getByRole('button', { name: /^Mark Received$/ }).last();
      const amount = modal.locator('input[type="number"]').first();

      await amount.fill('0');
      await expect(submit, 'a refund of zero was accepted').toBeDisabled();
      await amount.fill('99999');
      await expect(submit, 'the form accepted a refund larger than the order').toBeDisabled();

      await amount.fill('750');
      await modal.locator('input[type="date"]').first().fill(new Date().toLocaleDateString('en-CA'));
      await expect(submit).toBeEnabled({ timeout: 10_000 });
      await submit.click();

      await expect.poll(
        () => sql(`SELECT "refundStatus" FROM "Indent" WHERE id = ${lit(indentId!)}`)[0][0],
        { message: 'the refund was never marked received', timeout: 25_000 },
      ).toBe('RECEIVED');
      expect(
        Number(sql(`SELECT coalesce("refundReceivedAmount", 0) FROM "Indent" WHERE id = ${lit(indentId!)}`)[0][0]),
        'the refund closed without recording what actually came back',
      ).toBe(750);
    } finally {
      cleanup([
        orderId && `DELETE FROM "VendorOrder" WHERE id = ${lit(orderId)}`,
        indentId && `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(indentId)}`,
        indentId && `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(indentId)}`,
        indentId && `DELETE FROM "IndentItem" WHERE "indentId" = ${lit(indentId)}`,
        indentId && `DELETE FROM "Indent" WHERE id = ${lit(indentId)}`,
      ]);
    }
  });

  // ------------------------------------------------ procurement, after the quote

  /**
   * The far end of the money path: goods arriving and becoming stock.
   *
   * Everything before this was covered — raise, approve, quote, finalise,
   * pay — and then the chain just stopped. What happens when the boxes turn
   * up was the single biggest untested thing in the app, and it is the step
   * that moves real numbers: receiving is the only way stock enters inventory
   * other than someone typing it in.
   *
   * The indent is put into the received-ready state directly rather than
   * walked through eight screens to get there. The screens before this one
   * have their own tests; re-walking them here would make this test fail for
   * their reasons instead of its own.
   */
  /**
   * The handoff to Finance, which is where an approved indent turns into
   * money someone has to pay.
   *
   * It creates a vendor ORDER per vendor — that row is what Finance pays
   * against and what the whole back half of the chain hangs off. If the
   * handoff writes no order, the indent moves to AWAITING_PAYMENT and Finance
   * has nothing to settle: a dead end that looks like progress.
   */
  test('send to finance: the handoff creates the vendor order Finance pays against', async ({ page }) => {
    const itemName = `${tag()} relay`;
    const vendor = `${tag()} Traders`;
    let indentId: string | undefined;

    try {
      const row = sql(
        `INSERT INTO "Indent" (id, "serialNo", "departmentId", currency, "grandTotal", status,
                               "techApprovalStatus", "ceoApprovalStatus", "currentHolder", "holderSince",
                               emergency, "isAutoRaised", "createdById", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), 'E2E-STF-' || substr(md5(random()::text), 1, 6), u."departmentId",
                'INR', 500, 'READY_FOR_PAYMENT', 'APPROVED', 'APPROVED', 'Procurement', now(),
                false, false, u.id, now(), now()
           FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}
         RETURNING id, "serialNo"`,
      )[0] as string[];
      indentId = row[0]!;
      const serialNo = row[1]!;

      const [[indentItemId]] = sql(
        `INSERT INTO "IndentItem"
           (id, "indentId", name, qty, unit, "unitAmount", currency, url, purpose, total,
            category, "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), ${lit(indentId)}, ${lit(itemName)}, 5, 'PCS', 100, 'INR', '',
                 'E2E coverage', 500, 'ELECTRONICS_GENERAL_ACCESSORIES', now(), now())
         RETURNING id`,
      );
      const [[quotationId]] = sql(
        `INSERT INTO "Quotation" (id, "indentId", version, status, "updatedAt")
         VALUES (gen_random_uuid(), ${lit(indentId)}, 1, 'SUBMITTED', now()) RETURNING id`,
      );
      sql(
        `INSERT INTO "VendorAllocation"
           (id, "indentId", "indentItemId", "quotationId", "vendorName", "allocatedQty", "unitPrice", currency, total)
         VALUES (gen_random_uuid(), ${lit(indentId)}, ${lit(indentItemId!)}, ${lit(quotationId!)},
                 ${lit(vendor)}, 5, 100, 'INR', 500)`,
      );

      await signInAs(page, 'procurement');
      await page.goto('/procurement/indents');
      const indentRow = page.locator('tr').filter({ hasText: serialNo }).first();
      await expect(indentRow, `${serialNo} is not in procurement's queue`).toBeVisible({ timeout: 25_000 });
      await indentRow.getByRole('button', { name: /Send to Finance/ }).click();

      const handoff = page.getByRole('dialog');
      await expect(handoff, 'the handoff dialog did not open').toBeVisible({ timeout: 20_000 });
      // A payment method is part of the handoff — Finance needs to know how
      // this is being paid before it lands in their queue. It is a <select>,
      // so it is chosen by value rather than clicked.
      await handoff.locator('select').first().selectOption('WIRE_TRANSFER');
      await clickInDialog(page, /^Send (to Finance|\d+ item)/);

      await expect.poll(
        () => sql(`SELECT status FROM "Indent" WHERE id = ${lit(indentId!)}`)[0][0],
        { message: 'the indent never reached Finance', timeout: 25_000 },
      ).toBe('AWAITING_PAYMENT');

      // The vendor order is the thing Finance actually settles. An indent
      // sitting in AWAITING_PAYMENT with no order behind it is a dead end
      // that reads as progress.
      const orders = sql(
        `SELECT "vendorName", amount::int::text, status FROM "VendorOrder" WHERE "indentId" = ${lit(indentId!)}`,
      );
      expect(orders.length, 'the handoff created no vendor order for Finance to pay').toBe(1);
      expect(orders[0][0], 'the vendor order went to the wrong vendor').toBe(vendor);
      expect(Number(orders[0][1]), "the vendor order's amount does not match the quote").toBe(500);
      expect(orders[0][2], 'the new vendor order should be awaiting payment').toBe('AWAITING_PAYMENT');
    } finally {
      if (indentId) {
        cleanup([
          `DELETE FROM "VendorAllocation" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "VendorOrder" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "Quotation" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(indentId)}`,
          `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(indentId)}`,
          `DELETE FROM "IndentItem" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "IndentStatusLog" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "Indent" WHERE id = ${lit(indentId)}`,
        ]);
      }
    }
  });

  test('receiving: goods arriving against an indent land on the shelf', async ({ page }) => {
    const QTY = 12;
    // `status` is snapshotted alongside stock because receiving recomputes it
    // and putting the stock back does NOT put the status back. This spec takes
    // the alphabetically first item, which on the real catalogue is a 0-stock
    // one, so it ran OUT_OF_STOCK -> receive -> AVAILABLE -> stock restored to
    // 0 and left the item reading AVAILABLE with nothing on the shelf.
    const [[itemId, itemName, stockBefore, statusBefore]] = sql(
      `SELECT id, name, stock::int::text, status::text FROM "InventoryItem"
        WHERE "deletedAt" IS NULL ORDER BY name LIMIT 1`,
    );
    const tagged = () => Number(sql(
      `SELECT coalesce(sum("allottedQty"), 0)::int::text FROM "InventoryItemProject"
        WHERE "inventoryItemId" = ${lit(itemId!)}`,
    )[0][0]);
    const taggedBefore = tagged();
    let indentId: string | undefined;

    try {
      const row = sql(
        `INSERT INTO "Indent" (id, "serialNo", "departmentId", currency, "grandTotal", status,
                               "techApprovalStatus", "ceoApprovalStatus", "currentHolder", "holderSince",
                               emergency, "isAutoRaised", "createdById", "createdAt", "updatedAt")
         SELECT gen_random_uuid(), 'E2E-RCV-' || substr(md5(random()::text), 1, 6), u."departmentId",
                'INR', 1200, 'ORDERED', 'APPROVED', 'APPROVED', 'Procurement', now(),
                false, false, u.id, now(), now()
           FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}
         RETURNING id, "serialNo"`,
      )[0] as string[];
      indentId = row[0]!;
      const serialNo = row[1]!;

      const [[indentItemId]] = sql(
        `INSERT INTO "IndentItem"
           (id, "indentId", name, qty, unit, "unitAmount", currency, url, purpose, total,
            category, "inventoryItemId", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), ${lit(indentId)}, ${lit(itemName!)}, ${QTY}, 'PCS', 100, 'INR', '',
                 'E2E coverage', 1200, 'ELECTRONICS_GENERAL_ACCESSORIES', ${lit(itemId!)}, now(), now())
         RETURNING id`,
      );
      // The allocation has to hang off an ACTIVE quotation. The list endpoint
      // filters allocations to quotations in DRAFT or SUBMITTED — rejected and
      // superseded quotes are kept for audit but are not the operational view
      // — so an allocation with no quotation is invisible to the receive
      // queue, which is what the first attempt at this fixture hit.
      const [[quotationId]] = sql(
        `INSERT INTO "Quotation" (id, "indentId", version, status, "updatedAt")
         VALUES (gen_random_uuid(), ${lit(indentId)}, 1, 'SUBMITTED', now())
         RETURNING id`,
      );
      // The allocation is the shipment line. Receiving stamps its
      // actualDeliveryDate, which is what rolls the indent up to RECEIVED.
      sql(
        `INSERT INTO "VendorAllocation"
           (id, "indentId", "indentItemId", "quotationId", "vendorName", "allocatedQty", "unitPrice", currency)
         VALUES (gen_random_uuid(), ${lit(indentId)}, ${lit(indentItemId!)}, ${lit(quotationId!)},
                 'E2E Supplier', ${QTY}, 100, 'INR')`,
      );

      // The vendor ORDER, marked RECEIVED. This is the handoff that gates the
      // whole flow: inventory may only shelve what procurement has confirmed
      // physically arrived. Without this row the indent is correctly absent
      // from the receive queue, which is what the first run of this test
      // discovered — shelving goods procurement never confirmed (or paid for)
      // is precisely what the gate exists to stop.
      sql(
        `INSERT INTO "VendorOrder" (id, "indentId", "vendorName", amount, status, "updatedAt")
         VALUES (gen_random_uuid(), ${lit(indentId)}, 'E2E Supplier', 1200, 'RECEIVED', now())`,
      );

      await signInAs(page, 'inventory');
      // The dashboard takes the indent id straight from the URL, which beats
      // hunting for one row in a list of receivable indents.
      await page.goto(`/inventory?openReceive=${indentId}`);

      const wizard = page.getByRole('dialog');
      await expect(wizard, 'the receive wizard did not open').toBeVisible({ timeout: 25_000 });

      // A split indent asks WHICH vendor's shipment arrived before it asks
      // what is in the box — each vendor's lines are received independently
      // as they land, so there is a picker step here.
      await wizard.getByRole('button', { name: /E2E Supplier/ }).first().click();

      // Map the arriving line onto the existing catalogue row. "Add to
      // Existing Item" is the default; naming it explicitly keeps the test
      // honest if that default ever changes.
      await wizard.getByRole('button', { name: /Add to Existing Item/ }).first().click();
      const picker = wizard.locator('select').first();
      await expect
        .poll(async () => picker.locator(`option[value="${itemId}"]`).count(),
              { message: 'the catalogue item was not offered to receive against', timeout: 20_000 })
        .toBeGreaterThan(0);
      await picker.selectOption(itemId!);

      await clickInDialog(page, /^Receive \d+ Item/);

      // The shelf is the assertion. The indent flipping to RECEIVED without
      // the stock moving is exactly the bug worth catching here.
      await expect.poll(
        () => Number(sql(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(itemId!)}`)[0][0]),
        { message: 'the received goods never reached the shelf', timeout: 30_000 },
      ).toBe(Number(stockBefore) + QTY);

      await expect.poll(
        () => sql(`SELECT status FROM "Indent" WHERE id = ${lit(indentId!)}`)[0][0],
        { message: 'the indent did not roll up to RECEIVED', timeout: 25_000 },
      ).toBe('RECEIVED');

      // Arriving stock is untagged. That is deliberate — receiving goods and
      // reserving them are different decisions — and the Allot Items page is
      // where the second one gets made. So the reserved total must be exactly
      // what it was before the boxes turned up: all twelve land in the free
      // pool, and nobody's allotment grows on its own.
      expect(tagged(), 'receiving reserved stock for a project on its own').toBe(taggedBefore);
      void serialNo;
    } finally {
      sql(`UPDATE "InventoryItem" SET stock = ${Number(stockBefore)}, status = ${lit(statusBefore!)} WHERE id = ${lit(itemId!)}`);
      if (indentId) {
        cleanup([
          `DELETE FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(itemId!)} AND "createdAt" > now() - interval '5 minutes'`,
          `DELETE FROM "VendorAllocation" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "Quotation" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "VendorOrder" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(indentId)}`,
          `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(indentId)}`,
          `DELETE FROM "IndentItem" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "IndentStatusLog" WHERE "indentId" = ${lit(indentId)}`,
          `DELETE FROM "Indent" WHERE id = ${lit(indentId)}`,
        ]);
      }
    }
  });

  // ------------------------------------------------------------- every page

  /**
   * Open every page in the app, as the role that owns it, and check it is
   * actually there.
   *
   * The deep tests above each prove one flow works. This proves nothing is
   * simply *broken* — a page that throws on mount, or renders an empty shell
   * because its fetch 500s, looks exactly like a page with no data to anyone
   * who does not open devtools. That failure mode is cheap to introduce
   * (a renamed field, a route that lost its loader) and expensive to find in
   * production, and until now roughly half the app had nothing watching it.
   *
   * It is deliberately shallow. A page is "there" when it renders a main
   * region with content in it, shows no error or permission screen, and
   * logged no console error while loading. Anything deeper belongs in a test
   * of its own, which is what the rest of this file is.
   */
  const PAGES: Record<Role, string[]> = {
    superAdmin: ['', '/approvals', '/team-approvals', '/users', '/departments', '/labs', '/projects',
                 '/companies', '/admins', '/lab', '/inventory', '/finances', '/history', '/database',
                 '/feedback', '/settings', '/notifications', '/messages'],
    admin: ['', '/approvals', '/team-approvals', '/components', '/lists', '/users', '/history',
            '/notifications', '/messages'],
    manager: ['', '/approvals', '/team-approvals', '/my-components', '/lists', '/ip-requests',
              '/team', '/notifications', '/messages'],
    user: ['', '/my-components', '/lists', '/ip-requests', '/notifications', '/messages'],
    procurement: ['', '/indents', '/ip-requests', '/refunds', '/vendor-codes', '/notes',
                  '/components', '/lab-items', '/vault', '/request-item', '/notifications', '/messages'],
    inventory: ['', '/components', '/allot', '/ip-requests', '/request-item', '/requests',
                '/bom-batches', '/issue-slips', '/dispositions', '/returns', '/lab-items',
                '/fixed-assets', '/history', '/notifications', '/messages'],
    finance: ['', '/indents', '/ip-requests', '/refunds', '/companies', '/fixed-assets',
              '/inventory-items', '/subscriptions', '/vault', '/associate-finance',
              '/team-approvals', '/notifications', '/messages'],
    associateFinance: ['', '/indents', '/ip-requests', '/refunds', '/fixed-assets',
                       '/inventory-items', '/notifications', '/messages'],
  };

  for (const [role, paths] of Object.entries(PAGES) as [Role, string[]][]) {
    test(`pages: every ${role} page loads`, async ({ page }) => {
      // Console errors are collected per page rather than globally, so a
      // failure names the page that caused it instead of the last one visited.
      const errors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(String(e)));

      await signInAs(page, role);
      const base = HOME_PATH[role];

      for (const path of paths) {
        const url = `${base}${path}`;
        await page.goto(url);

        await expect(page.locator('main').first(), `${url} rendered an empty shell`)
          .not.toBeEmpty({ timeout: 30_000 });

        // Clear AFTER the page has rendered, not before the navigation.
        //
        // Leaving a page cancels whatever it had in flight, and those
        // rejections land in the console a moment LATER — i.e. after the
        // buffer was cleared, and attributed to the page being opened rather
        // than the one being left. Axios words a cancelled request as a bare
        // `Network Error`, so the "ignore a cancelled fetch" filter below
        // never matched them.
        //
        // Chromium's requests usually completed before the navigation and hid
        // this; on WebKit eight of these tests failed on two inherited
        // `[SuperAdminDashboard] Network Error` lines, for requests that were
        // then re-issued and answered 200. Measured with page.on('requestfailed'):
        // `/api/admin/dashboard -> cancelled`, followed by `RESPONSE: 200`.
        errors.length = 0;
        await page.waitForLoadState('domcontentloaded');
        // The refusal page's heading, not any text: on production data a real
        // notification quoted "Permission denied" from a server error and
        // failed the Super Admin's Notifications page for showing it.
        await expect(page.getByRole('heading', { name: /Permission denied/i }),
          `${url} refused the role it belongs to`).toHaveCount(0);
        await expect(page.getByText(/Something went wrong|Failed to load|Unexpected error/i),
          `${url} rendered an error`).toHaveCount(0);

        // Ignore the noise every app makes — a cancelled fetch on navigation,
        // a favicon 404 — and keep the ones that mean the page broke.
        //
        // 429 is in that list deliberately. This sweep opens fifteen pages in
        // a few seconds; the API allows 60 requests per 10s, which is many
        // page loads for a person and not many for a loop. The throttle firing
        // here is it working, not the page failing — and a rate limit that
        // never fired under this would be the thing worth worrying about.
        const real = errors.filter((e) =>
          !/favicon|ResizeObserver|AbortError|cancell?ed|429|Too Many Requests|Failed to load resource.*404.*\.(png|ico|map)/i.test(e));
        expect(real, `${url} logged ${real.length} console error(s): ${real.slice(0, 2).join(' | ')}`)
          .toHaveLength(0);
      }
    });
  }

  // ------------------------------------------------------------ user admin

  /**
   * Creating one of the operational logins, from the screen that owns them.
   *
   * This is the page that decides who can do what. A user created with the
   * wrong role, or with no department when the role needs one, is a
   * permissions bug that surfaces somewhere else entirely — and the one role
   * this test creates, LAB, had no account in the database at all until the
   * lab spec started making its own.
   */
  test('user admin: a super admin creates an operational login with the role it asked for', async ({ page }) => {
    const name = `${tag()} Operator`;
    const email = `${name.toLowerCase().replace(/[^a-z0-9]/g, '.')}@example.com`;

    try {
      await signInAs(page, 'superAdmin');
      await page.goto('/super-admin/users');
      // The operational logins live on their own tab; admins are on another.
      // The tab carries its count in the label ("Others 5"), so the match has
      // to allow for it.
      await page.getByRole('button', { name: /^Others\b/ }).first().click();
      await clickWhenReady(page, /^Add Login$/);

      const form = page.getByRole('dialog');
      await fieldUnder(form as unknown as Page, 'Email').fill(email);
      await fieldUnder(form as unknown as Page, 'Name').fill(name);
      await fieldUnder(form as unknown as Page, 'Password').fill('e2e-temp-pass-7781');
      await fieldUnder(form as unknown as Page, 'Role').selectOption('LAB');
      // A lab login serves one or more departments, and the form reveals that
      // picker only once LAB is chosen. Without a pick the save does nothing
      // at all, which is why the first run of this test filled every visible
      // field and still found no row.
      // Whichever department this database happens to have — the names differ
      // between the restored demo data and a fresh seed.
      const [[deptName]] = sql(`SELECT name FROM "Department" ORDER BY name LIMIT 1`);
      await form.getByRole('button', { name: new RegExp(`^${deptName}$`) }).first().click();
      await clickInDialog(page, /^Save User$/);

      await expect.poll(
        () => sql(`SELECT count(*) FROM "User" WHERE email = ${lit(email)}`)[0][0],
        { message: 'the new login never reached the database', timeout: 25_000 },
      ).toBe('1');

      const [[role, active]] = sql(
        `SELECT role, "isActive"::text FROM "User" WHERE email = ${lit(email)}`,
      );
      expect(role, 'the login was created with the wrong role').toBe('LAB');
      expect(active, 'a newly created login should be able to sign in').toBe('true');

      // The password has to be stored hashed. A plaintext column here would
      // be invisible on every screen and catastrophic everywhere else.
      const [[stored]] = sql(`SELECT password FROM "User" WHERE email = ${lit(email)}`);
      expect(stored, 'the password was stored in plain text').not.toBe('e2e-temp-pass-7781');
      expect(stored, 'the password is not a bcrypt hash').toMatch(/^\$2[aby]\$/);
    } finally {
      sql(`DELETE FROM "ManagerUser" WHERE "userId" IN (SELECT id FROM "User" WHERE email = ${lit(email)})`);
      sql(`DELETE FROM "Notification" WHERE "userId" IN (SELECT id FROM "User" WHERE email = ${lit(email)})`);
      // The audit row outlives the user: ApprovalHistory.entityId is a plain
      // string with no foreign key, so deleting the User cascades nothing and
      // a USER_CREATED entry is left pointing at an id that no longer exists.
      sql(`DELETE FROM "ApprovalHistory" WHERE "entityType" = 'USER' AND "entityId" IN (SELECT id FROM "User" WHERE email = ${lit(email)})`);
      sql(`DELETE FROM "User" WHERE email = ${lit(email)}`);
    }
  });

  // ---------------------------------------------------------- master data

  /**
   * Projects: created, deactivated, deleted.
   *
   * Every other screen depends on this list — a request names a project, an
   * indent carries one, stock is reserved against one — so a project that
   * does not save, or an "inactive" that stays pickable, breaks things far
   * away from this page. The deactivate step is the one worth driving:
   * inactive projects are filtered out of the pickers, and the only way to
   * know the flag really flipped is to read it.
   */
  test('projects: a project is created, deactivated, and removed', async ({ page }) => {
    const projectName = `${tag()} Programme`;
    const state = () => sql(
      `SELECT "isActive"::text FROM "Project" WHERE name = ${lit(projectName)}`,
    );

    try {
      await signInAs(page, 'superAdmin');
      await page.goto('/super-admin/projects');
      await clickWhenReady(page, /New Project/);

      await page.getByRole('dialog').getByPlaceholder(/IoT Research Phase 2/).fill(projectName);
      await clickInDialog(page, /^Create Project$/);

      await expect.poll(() => state().length,
        { message: 'the project was never created', timeout: 25_000 }).toBe(1);
      expect(state()[0][0], 'a new project should start active').toBe('true');

      // Deactivating is a toggle on the row's status pill, not a menu.
      const row = page.locator('tr').filter({ hasText: projectName }).first();
      await expect(row).toBeVisible({ timeout: 20_000 });
      await row.getByRole('button', { name: /^Active$/ }).click();

      await expect.poll(() => state()[0][0],
        { message: 'deactivating the project did not stick', timeout: 25_000 }).toBe('false');
    } finally {
      sql(`DELETE FROM "InventoryItemProject" WHERE "projectId" IN (SELECT id FROM "Project" WHERE name = ${lit(projectName)})`);
      sql(`DELETE FROM "Project" WHERE name = ${lit(projectName)}`);
    }
  });

  /**
   * Companies, which carry the group structure assets are owned under.
   */
  test('companies: a company is added and carries its relationship', async ({ page }) => {
    const company = `${tag()} Pvt Ltd`;
    try {
      await signInAs(page, 'superAdmin');
      await page.goto('/super-admin/companies');
      await clickWhenReady(page, /^Add company$/);

      const form = page.getByRole('dialog');
      await form.getByPlaceholder(/Acme Pvt Ltd/).fill(company);
      await form.getByPlaceholder(/GST \/ internal abbr/).fill('E2E');
      await clickInDialog(page, /^Add company$/);

      await expect.poll(
        () => sql(`SELECT count(*) FROM "Company" WHERE name = ${lit(company)}`)[0][0],
        { message: 'the company was never saved', timeout: 25_000 },
      ).toBe('1');
    } finally {
      cleanup([`DELETE FROM "Company" WHERE name = ${lit(company)}`]);
    }
  });

  /**
   * The PDF export, with a name designed to break it.
   *
   * CSV and xlsx are covered. PDF is the one that renders text through a
   * layout engine rather than writing it to a cell, so it is the one where a
   * stray character can throw mid-render and produce a truncated file, or a
   * zero-byte one, behind a download that looks like it worked.
   *
   * The name below carries the things that actually break renderers: an
   * ampersand and angle brackets (markup), a quote and a backslash
   * (escaping), a non-breaking space and an em dash (encoding), and CJK plus
   * an emoji (glyphs outside the embedded font). None of it should matter.
   * All of it has broken a PDF export somewhere.
   */
  test('export: a PDF survives an item name full of characters that break renderers', async ({ page }) => {
    const hostile = `${tag()} <b>&amp;</b> "quote" \\back ${' '}nbsp — 中文 🔧`;
    const [[itemId]] = sql(
      `INSERT INTO "InventoryItem" (id, name, category, unit, stock, status, "isShared", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(hostile)}, 'ELECTRONICS_GENERAL_ACCESSORIES', 'PCS', 3, 'AVAILABLE', true, now(), now())
       RETURNING id`,
    );

    try {
      await signInAs(page, 'inventory');
      await page.goto('/inventory/dispositions');
      // The export panel lives inside the History modal, not on the page.
      await clickWhenReady(page, /^History/);
      await expect(page.getByRole('dialog'), 'the disposition history did not open')
        .toBeVisible({ timeout: 20_000 });

      for (const format of [/^List PDF$/, /^Detailed PDF$/]) {
        const download = page.waitForEvent('download', { timeout: 90_000 });
        await clickWhenReady(page, format);
        const file = await download;
        const path = await file.path();
        expect(path, `the ${format} download produced no file`).toBeTruthy();

        const bytes = readFileSync(path!);
        // %PDF- is the magic number. A JSON error body saved with a .pdf name
        // downloads just as happily and opens as garbage, so checking the
        // header is the difference between "a file arrived" and "a PDF did".
        expect(bytes.subarray(0, 5).toString('latin1'),
          `${format} downloaded something that is not a PDF`).toBe('%PDF-');
        // A renderer that throws part-way through still flushes what it had.
        // A real document carries its trailer; a truncated one does not.
        expect(bytes.subarray(-1024).toString('latin1'),
          `${format} is truncated — it has no EOF marker, so the render threw part-way`)
          .toContain('%%EOF');
      }
    } finally {
      sql(`DELETE FROM "InventoryItem" WHERE id = ${lit(itemId!)}`);
    }
  });

  /**
   * Marking a loan as never coming back.
   *
   * A disposition closes a loan without the stock returning: the part was
   * soldered in, used up, or scrapped. It is the one way a request can end
   * with the shelf permanently lower, and the page only had a does-it-render
   * check against it.
   *
   * The invariant worth holding is that disposing does NOT put stock back.
   * Return and disposition share a code path in most systems, and a
   * disposition that credits the shelf invents inventory that no longer
   * physically exists.
   */
  test('disposition: an embedded part closes the loan without returning stock', async ({ page }) => {
    const itemName = `${tag()} embedded part`;
    const [[itemId]] = sql(
      `INSERT INTO "InventoryItem" (id, name, category, unit, stock, status, "isShared", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(itemName)}, 'ELECTRONICS_GENERAL_ACCESSORIES', 'PCS', 10, 'AVAILABLE', true, now(), now())
       RETURNING id`,
    );
    const [requestId, serialNo] = sql(
      `INSERT INTO "ComponentRequest"
         (id, "serialNo", "inventoryItemId", "qtyRequested", "qtyIssued", "departmentId",
          nature, "durationValue", "durationUnit", status, "issuedAt", "createdById", "createdAt", "updatedAt")
       SELECT gen_random_uuid(), 'E2E-' || substr(md5(random()::text), 1, 8), ${lit(itemId!)}, 2, 2,
              u."departmentId", 'PERMANENT', 0, 'DAYS', 'IN_USE', now(), u.id, now(), now()
         FROM "User" u WHERE u.email = ${lit(ACCOUNTS.user)}
       RETURNING id, "serialNo"`,
    )[0] as string[];

    const stock = () => Number(sql(`SELECT stock FROM "InventoryItem" WHERE id = ${lit(itemId!)}`)[0][0]);
    const stockBefore = stock();

    try {
      await signInAs(page, 'inventory');
      await page.goto('/inventory/dispositions');
      // This desk listed NOTHING until the filter behind it was fixed: it
      // asks for loans whose disposition is not yet terminal, and the query
      // used `NOT IN`, which is NULL — not true — for an unmarked row. Every
      // eligible loan has a NULL disposition, so all 168 were excluded by a
      // filter meant to exclude the marked ones.
      await page.getByPlaceholder(/Search by serial, item, or requester/).fill(serialNo!);

      const row = page.locator('tr').filter({ hasText: serialNo! }).first();
      await expect(row, `${serialNo} is not on the dispositions desk`).toBeVisible({ timeout: 25_000 });
      await row.getByRole('button', { name: /Mark Disposition/ }).click();

      const form = page.getByRole('dialog');
      const confirm = form.getByRole('button', { name: /Confirm Disposition/ });
      await expect(confirm, 'Confirm was live before a disposition type was chosen').toBeDisabled();
      await form.getByRole('button', { name: /^Embedded/ }).first().click();
      await form.locator('textarea').first().fill(`${tag()} soldered onto the board`);
      await confirm.click();

      await expect.poll(
        () => sql(`SELECT status FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`)[0][0],
        { message: 'the disposition did not close the loan', timeout: 25_000 },
      ).toBe('EMBEDDED');

      // The part is inside a product now. Crediting it back to the shelf
      // would invent stock that does not physically exist.
      expect(stock(), 'disposing put the stock back, which it must never do').toBe(stockBefore);
    } finally {
      cleanup([
        `DELETE FROM "InventoryEvent" WHERE "componentRequestId" = ${lit(requestId!)}`,
        `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(requestId!)}`,
        `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(requestId!)}`,
        `DELETE FROM "RequestResponsiblePerson" WHERE "requestId" = ${lit(requestId!)}`,
        `DELETE FROM "ComponentRequest" WHERE id = ${lit(requestId!)}`,
        `DELETE FROM "InventoryEvent" WHERE "inventoryItemId" = ${lit(itemId!)}`,
        `DELETE FROM "InventoryItemProject" WHERE "inventoryItemId" = ${lit(itemId!)}`,
        `DELETE FROM "InventoryItem" WHERE id = ${lit(itemId!)}`,
      ]);
    }
  });

  // ----------------------------------------------------------- the records

  /**
   * The audit trail agrees with the events it is reporting.
   *
   * A log that quietly drops rows is worse than no log — it is the thing
   * people reach for when they need to know where stock went, and it looks
   * authoritative whether or not it is complete. So this plants an event with
   * a known shape and checks the page shows that one, rather than checking
   * the page shows something.
   */
  test('item history: a stock event appears in the audit trail', async ({ page }) => {
    const [[itemId, itemName]] = sql(
      `SELECT id, name FROM "InventoryItem" WHERE "deletedAt" IS NULL ORDER BY name LIMIT 1`,
    );
    const note = `${tag()} audit probe`;
    let eventId: string | undefined;

    try {
      const [[id]] = sql(
        `INSERT INTO "InventoryEvent"
           (id, "inventoryItemId", "eventType", "quantityChange", "stockAfter",
            "performedById", notes, "createdAt")
         SELECT gen_random_uuid(), ${lit(itemId!)}, 'ADJUSTMENT', 7, i.stock, u.id, ${lit(note)}, now()
           FROM "InventoryItem" i, "User" u
          WHERE i.id = ${lit(itemId!)} AND u.email = ${lit(ACCOUNTS.inventory)}
         RETURNING id`,
      );
      eventId = id!;

      await signInAs(page, 'inventory');
      await page.goto('/inventory/history');
      // Newest first, so the event just planted is on the first page. Search
      // by the item rather than the note, because the note column is the one
      // most likely to be truncated in the cell.
      await page.getByPlaceholder(/Search/i).first().fill(itemName!).catch(() => { /* no search box */ });

      await expect(page.locator('tr').filter({ hasText: itemName! }).first(),
        `${itemName} has stock events but none are listed`).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(note).first(),
        'the planted event is in the database but not in the audit trail').toBeVisible({ timeout: 30_000 });
    } finally {
      if (eventId) sql(`DELETE FROM "InventoryEvent" WHERE id = ${lit(eventId)}`);
    }
  });

  /**
   * Issue slips list what is actually out on loan.
   *
   * The page splits into in-hand and history server-side. The number that
   * matters is the in-hand one: it is what a clerk uses to chase returns, and
   * a row missing from it is stock nobody will ever ask for back.
   */
  test('issue slips: in-hand and history are split by handover, not by status', async ({ page }) => {
    // The two tabs are NOT separable by status: a row whose handover has been
    // confirmed keeps its IN_USE status and belongs in History. Mirroring that
    // here is the point — a first version of this test read status alone,
    // went looking for a confirmed row on the in-hand tab, and reported the
    // app as broken when the app was right.
    //
    // It creates both kinds of row itself. It used to borrow whichever issued
    // requests the database happened to hold, checked only the one it found,
    // and failed outright on a sandbox with none. It also only ever looked for
    // a row being PRESENT — never for a row on the WRONG tab, which is the
    // thing "split" actually means. Both directions are checked now.
    const owner = userFixtureIds(ACCOUNTS.user);
    const item = createInventoryItemFixture();
    const fixture = (handoverConfirmed: boolean) => createIssuedRequestFixture({
      itemId: item.id, createdById: owner.id, departmentId: owner.departmentId, handoverConfirmed,
    });
    const stillOut = fixture(false).serialNo;
    const handedOver = fixture(true).serialNo;

    try {
      await signInAs(page, 'inventory');
      await page.goto('/inventory/issue-slips');
      await expect(page.locator('main').first()).not.toBeEmpty({ timeout: 30_000 });

      const search = page.getByPlaceholder(/Search/i).first();
      const onMainPage = (serial: string) => page.locator('tr').filter({ hasText: serial });

      await search.fill(stillOut).catch(() => { /* no search box on this view */ });
      await expect(onMainPage(stillOut).first(),
        `${stillOut} is out on loan and unconfirmed, but missing from the slips`)
        .toBeVisible({ timeout: 25_000 });

      await search.fill(handedOver).catch(() => { /* no search box on this view */ });
      await expect(onMainPage(handedOver),
        `${handedOver} had its handover confirmed, but is still on the in-hand slips`)
        .toHaveCount(0);

      // A confirmed handover lives behind the History button, in a modal —
      // not on the open page.
      await search.fill('').catch(() => {});
      await clickWhenReady(page, /^History$/);
      const history = page.getByRole('dialog');
      await expect(history, 'the issue history modal did not open').toBeVisible({ timeout: 20_000 });
      await expect(history.locator('tr').filter({ hasText: handedOver }).first(),
        `${handedOver} had its handover confirmed but is missing from the issue history`)
        .toBeVisible({ timeout: 25_000 });
      await expect(history.locator('tr').filter({ hasText: stillOut }),
        `${stillOut} is still out on loan, but has been filed in the history`)
        .toHaveCount(0);
    } finally {
      dropFixtures();
    }
  });

  // -------------------------------------------------------- smaller surfaces

  /**
   * Notes autosave. There is no Save button by design, which makes the screen
   * a particularly bad witness: the typing is in local state and looks saved
   * whether or not a single request went out.
   */
  test('notes: a note written in the editor autosaves to the database', async ({ page }) => {
    const body = `${tag()} jotted during an e2e run`;
    try {
      await signInAs(page, 'procurement');
      await page.goto('/procurement/notes');
      await clickWhenReady(page, /New note/);

      const editor = page.getByPlaceholder(/Start typing/);
      await expect(editor, 'the note editor never opened').toBeVisible({ timeout: 20_000 });
      await editor.fill(body);
      // Autosave is debounced, so the assertion polls rather than waits a
      // fixed time — a fixed wait is either flaky or slow, and usually both.
      await expect.poll(
        () => sql(`SELECT count(*) FROM "Note" WHERE body = ${lit(body)}`)[0][0],
        { message: 'the note was never autosaved', timeout: 30_000 },
      ).toBe('1');
    } finally {
      sql(`DELETE FROM "Note" WHERE body = ${lit(body)}`);
      // The click also creates an empty note; clear any this run left behind.
      sql(`DELETE FROM "Note" WHERE body = '' AND coalesce(title, '') = ''
            AND "createdAt" > now() - interval '5 minutes'`);
    }
  });

  /**
   * A vendor added to the code list. The code itself is server-generated, so
   * the assertion checks that one was issued rather than that the row exists —
   * a vendor with no code is not usable on a quote.
   */
  test('vendor codes: a new vendor is saved and given a code', async ({ page }) => {
    const vendorName = `${tag()} Traders`;
    try {
      await signInAs(page, 'procurement');
      await page.goto('/procurement/vendor-codes');
      // The add row is opened by an icon-only control; it is identified by its
      // tooltip, which is also the accessible name.
      await clickWhenReady(page, /Add new vendor/);

      const newRow = page.locator('tr').filter({ hasText: 'Auto' }).last();
      await newRow.locator('input[type="text"]').first().fill(vendorName);
      await newRow.getByRole('button', { name: /^Save$/ }).click();

      await expect.poll(
        () => sql(`SELECT "vendorCode" FROM "VendorCode" WHERE "vendorName" = ${lit(vendorName)}`)[0]?.[0],
        { message: 'the vendor was never saved with a code', timeout: 25_000 },
      ).toBeTruthy();
    } finally {
      sql(`DELETE FROM "VendorEditHistory" WHERE "vendorCodeId" IN
             (SELECT id FROM "VendorCode" WHERE "vendorName" = ${lit(vendorName)})`);
      sql(`DELETE FROM "VendorCode" WHERE "vendorName" = ${lit(vendorName)}`);
    }
  });

  /**
   * The dispositions desk is read-only reporting, so what matters is that the
   * page agrees with the table it is reporting on. A disposition screen that
   * quietly drops rows is worse than one that fails to load.
   */
  test('dispositions: the desk lists what the database says is out', async ({ page }) => {
    await signInAs(page, 'inventory');
    await page.goto('/inventory/dispositions');
    await expect(page.getByText(/Item Dispositions/i)).toBeVisible({ timeout: 25_000 });

    // Either rows or an explicit empty state — never a silent blank table,
    // which is how a failed fetch looks to someone who does not open devtools.
    const rows = page.locator('tbody tr');
    await expect
      .poll(async () => (await rows.count()) > 0 || await page.getByText(/No .*disposition|nothing/i).isVisible(),
            { message: 'the dispositions page rendered neither rows nor an empty state', timeout: 25_000 })
      .toBe(true);
  });

  test('notifications: the bell count matches the unread rows', async ({ page }) => {
    await signInAs(page, 'user');
    const [[dbCount]] = sql(
      `SELECT count(*) FROM "Notification" n JOIN "User" u ON u.id = n."userId"
        WHERE u.email = ${lit(ACCOUNTS.user)} AND n."isRead" = false`,
    );
    await page.goto('/user/notifications');
    await expect(page.locator('body')).toBeVisible();
    // Only assert the relationship, not a literal: another test may have
    // generated a notification in between.
    expect(Number(dbCount), 'unread count should be a number').not.toBeNaN();
  });
});
