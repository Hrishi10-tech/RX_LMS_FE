import { test, expect, Page } from '@playwright/test';
import { ACCOUNTS, signInAs } from './helpers/auth';
import { lit, sql, sqlValue } from './helpers/db';

/**
 * The per-department indent sign-off chain.
 *
 * Departments differ: some want the manager's signature AND then the
 * department admin's, some want either. The mode lives on the department, the
 * manager stage lives on the indent, and the interesting cases are the ones
 * where the chain cannot simply run to completion:
 *
 *   - the admin signs before the manager (warned, and may go ahead),
 *   - the requester has no manager at all (the stage is passed over),
 *   - the manager signs alone in an OR department (that is the whole approval).
 *
 * The first and second are why this feature exists — production stalled on an
 * indent waiting for a manager who did not exist, with nothing in the UI
 * saying why.
 */

const tag = () => `E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** The department's mode, restored by the caller when the test ends. */
const setMode = (deptId: string, mode: 'MANAGER_REQUIRED' | 'MANAGER_OPTIONAL') => {
  sql(`UPDATE "Department" SET "indentApprovalMode" = ${lit(mode)} WHERE id = ${lit(deptId)}`);
};
const readMode = (deptId: string) =>
  sqlValue(`SELECT "indentApprovalMode" FROM "Department" WHERE id = ${lit(deptId)}`)!;

/**
 * A PENDING indent raised by `createdById`, with one line so the approval
 * screens have something to render. Returns its id + serial.
 */
const raiseIndent = (createdById: string, departmentId: string): { id: string; serialNo: string } => {
  const serialNo = tag();
  const [[id]] = sql(
    `INSERT INTO "Indent" (id, "serialNo", "grandTotal", currency, status, "departmentId", "createdById", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(serialNo)}, 4200, 'INR', 'PENDING', ${lit(departmentId)}, ${lit(createdById)}, now(), now())
     RETURNING id`,
  );
  sql(
    // `url` is NOT NULL with no default — a blank string is what the app
    // itself stores for a line nobody pasted a link for.
    `INSERT INTO "IndentItem" (id, "indentId", name, qty, "unitAmount", currency, unit, url, purpose, total, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(id!)}, 'E2E approval-chain part', 1, 4200, 'INR', 'NOS', '', 'Exercising the approval chain', 4200, now(), now())`,
  );
  return { id: id!, serialNo };
};

const dropIndent = (id: string) => {
  // Children first — every one of these has a FK onto Indent, and a half-torn
  // fixture poisons the next run rather than failing this one.
  for (const stmt of [
    `DELETE FROM "IndentStatusLog" WHERE "indentId" = ${lit(id)}`,
    `DELETE FROM "IndentResponsiblePerson" WHERE "indentId" = ${lit(id)}`,
    `DELETE FROM "QuotationItem" WHERE "quotationId" IN (SELECT id FROM "Quotation" WHERE "indentId" = ${lit(id)})`,
    `DELETE FROM "VendorAllocation" WHERE "indentId" = ${lit(id)}`,
    `DELETE FROM "Quotation" WHERE "indentId" = ${lit(id)}`,
    `DELETE FROM "IndentItem" WHERE "indentId" = ${lit(id)}`,
    `DELETE FROM "ApprovalHistory" WHERE "entityId" = ${lit(id)}`,
    `DELETE FROM "Notification" WHERE "relatedEntityId" = ${lit(id)}`,
    `DELETE FROM "Indent" WHERE id = ${lit(id)}`,
  ]) sql(stmt);
};

/** What the indent itself says the rule was. */
const appliedMode = (id: string) =>
  sqlValue(`SELECT "approvalModeApplied" FROM "Indent" WHERE id = ${lit(id)}`);
/**
 * The rule is a column, not a timeline entry. It is the department's standing
 * policy rather than something anyone did, and written as an entry it had to
 * name a performer — crediting whoever approved with applying a rule they had
 * no part in setting.
 */
const ruleTimelineEntries = (id: string) =>
  sqlValue(
    `SELECT count(*) FROM "ApprovalHistory"
      WHERE "entityType" = 'INDENT' AND "entityId" = ${lit(id)}
        AND action = 'APPROVAL_RULE_APPLIED'`,
  );

/** The revoke the admin screen issues — same endpoint, same session. */
const revokeTechApproval = async (page: Page, indentId: string) => {
  const status = await page.evaluate(async (id) => {
    // sessionStorage, not localStorage — see lib/axios.ts.
    const token = sessionStorage.getItem('accessToken') || '';
    const res = await fetch(`http://localhost:3001/api/indents/${id}/tech-approve`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ decision: 'PENDING', reason: 'E2E revoke' }),
    });
    return res.status;
  }, indentId);
  expect(status, 'the revoke call was rejected').toBeLessThan(400);
};

const approvalRow = (id: string) => {
  const [row] = sql(
    `SELECT "managerApprovalStatus", "techApprovalStatus", "managerApprovalSkipped",
            "managerApprovalBypassedById", status
       FROM "Indent" WHERE id = ${lit(id)}`,
  );
  return {
    manager: row[0],
    tech: row[1],
    skipped: row[2] === 't',
    bypassedById: row[3],
    status: row[4],
  };
};

/** Click Approve on the indent row carrying this serial, on whichever page. */
const approveIndentRow = async (page: Page, serialNo: string) => {
  const row = page.locator('tr', { hasText: serialNo }).first();
  await expect(row, `no row for ${serialNo} — is it in this lens's queue?`).toBeVisible({ timeout: 30_000 });
  await row.getByRole('button', { name: /^Approve$/ }).click();
};

test.describe('indent approval chain', () => {
  // Resolved once: the suite runs against whatever dataset is loaded, so the
  // accounts and departments are looked up rather than hard-coded.
  let managerId: string;
  let reportId: string;
  let reportDeptId: string;

  test.beforeAll(() => {
    managerId = sqlValue(`SELECT id FROM "User" WHERE email = ${lit(ACCOUNTS.manager)}`)!;
    expect(managerId, 'no manager account in this database').toBeTruthy();

    const [report] = sql(
      `SELECT u.id, u."departmentId" FROM "User" u
         JOIN "ManagerUser" mu ON mu."userId" = u.id
        WHERE mu."managerId" = ${lit(managerId)} AND u.role = 'USER' AND u."departmentId" IS NOT NULL
        LIMIT 1`,
    );
    expect(report, 'the manager has no direct report, so none of this proves anything').toBeTruthy();
    reportId = report[0]!;
    reportDeptId = report[1]!;
  });

  test('REQUIRED: the manager signs first, then the admin, and the indent advances', async ({ page }) => {
    const before = readMode(reportDeptId);
    setMode(reportDeptId, 'MANAGER_REQUIRED');
    const indent = raiseIndent(reportId, reportDeptId);
    try {
      await signInAs(page, 'manager');
      await page.goto('/manager/team-approvals');
      await approveIndentRow(page, indent.serialNo);
      await expect.poll(() => approvalRow(indent.id).manager, { timeout: 20_000 }).toBe('APPROVED');

      // The manager's signature is half of it — the indent must NOT have
      // advanced on its own.
      expect(approvalRow(indent.id).status, 'a department requiring a manager advanced on one signature').toBe('PENDING');

      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      await approveIndentRow(page, indent.serialNo);

      // No dialog this time: the manager has signed, so there is nothing to warn about.
      await expect(page.getByRole('button', { name: /Approve anyway/ }))
        .toBeHidden({ timeout: 5_000 });
      await expect.poll(() => approvalRow(indent.id).tech, { timeout: 20_000 }).toBe('APPROVED');
      expect(approvalRow(indent.id).status, 'both signatures in, but the indent did not move').not.toBe('PENDING');
    } finally {
      dropIndent(indent.id);
      setMode(reportDeptId, before as any);
    }
  });

  // Required means refused, not "warned harder". There is no way past it from
  // the admin's screen — the indent moves when the manager signs, or when the
  // automatic skip decides there is nobody to wait for.
  test('REQUIRED: the admin cannot approve before the manager', async ({ page }) => {
    const before = readMode(reportDeptId);
    setMode(reportDeptId, 'MANAGER_REQUIRED');
    const indent = raiseIndent(reportId, reportDeptId);
    try {
      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      // The button is there but disabled — the admin sees the indent and why
      // it is waiting, and has no way past the manager.
      const row = page.locator('tr', { hasText: indent.serialNo }).first();
      await expect(row, `no row for ${indent.serialNo}`).toBeVisible({ timeout: 30_000 });
      await expect(
        row.getByRole('button', { name: /^Approve$/ }),
        'the admin could click Approve past a required manager',
      ).toBeDisabled();
      // No "approve anyway" — the way past does not exist in this mode.
      await expect(
        page.getByRole('button', { name: /Approve anyway/ }),
        'a required manager was offered as a bypass',
      ).toBeHidden({ timeout: 8_000 });

      // And nothing happened: not approved, not bypassed, still waiting.
      await page.waitForTimeout(2_000);
      const after = approvalRow(indent.id);
      expect(after.tech, 'the admin approved past a required manager').toBe('PENDING');
      expect(after.bypassedById, 'a bypass was recorded in a mode that has none').toBeNull();
      expect(after.status, 'the indent advanced without the manager').toBe('PENDING');
    } finally {
      dropIndent(indent.id);
      setMode(reportDeptId, before as any);
    }
  });

  // Optional is where the bypass lives: a warning, a named record, and the
  // manager is told it happened.
  test('OPTIONAL: the admin signing first is warned, goes ahead on the record, and the manager is told', async ({ page }) => {
    const before = readMode(reportDeptId);
    setMode(reportDeptId, 'MANAGER_OPTIONAL');
    const indent = raiseIndent(reportId, reportDeptId);
    try {
      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      await approveIndentRow(page, indent.serialNo);

      // A question, not a refusal — and it must name the manager being gone
      // over the head of, not say "the manager" in the abstract.
      const dialog = page.getByRole('dialog').filter({ hasText: /has not approved this yet/i });
      await expect(dialog, 'the admin was blocked or silently approved instead of being asked')
        .toBeVisible({ timeout: 20_000 });
      const managerName = sqlValue(`SELECT name FROM "User" WHERE id = ${lit(managerId)}`)!;
      await expect(dialog).toContainText(managerName);

      // Nothing may have happened yet — the question must not have approved it.
      expect(approvalRow(indent.id).tech, 'the indent was approved before the admin confirmed').toBe('PENDING');

      await dialog.getByRole('button', { name: /Approve anyway/ }).click();
      await expect.poll(() => approvalRow(indent.id).tech, { timeout: 20_000 }).toBe('APPROVED');

      const after = approvalRow(indent.id);
      // The bypass is a named decision. `managerApprovalSkipped` means
      // something else entirely (nobody COULD have signed) and must stay false.
      expect(after.bypassedById, 'the bypass was not recorded against anyone').toBeTruthy();
      expect(after.skipped, 'a deliberate bypass was recorded as an absent manager').toBe(false);
      expect(after.manager, 'the bypass forged a manager approval').toBe('PENDING');
      expect(after.status, 'the bypassed indent did not advance').not.toBe('PENDING');

      // And it is in the audit trail under the admin's name, not just in a column.
      const logged = sqlValue(
        `SELECT count(*) FROM "ApprovalHistory"
          WHERE "entityId" = ${lit(indent.id)} AND action = 'MANAGER_BYPASSED'`,
      );
      expect(logged, 'the bypass left no approval-history entry').toBe('1');

      // The manager whose step was skipped is told — their queue is about to
      // drop the indent, and without this it just vanishes.
      const told = sqlValue(
        `SELECT count(*) FROM "Notification"
          WHERE "relatedEntityId" = ${lit(indent.id)} AND "userId" = ${lit(managerId)}
            AND title LIKE 'Approved without your sign-off%'`,
      );
      expect(told, 'the manager was not told their sign-off had been skipped').toBe('1');
    } finally {
      dropIndent(indent.id);
      setMode(reportDeptId, before as any);
    }
  });

  // The rule that changed. A manager's signature endorses an indent; the
  // admin's is what finishes it, in BOTH modes.
  test('OPTIONAL: the manager signing alone still waits for the admin', async ({ page }) => {
    const before = readMode(reportDeptId);
    setMode(reportDeptId, 'MANAGER_OPTIONAL');
    const indent = raiseIndent(reportId, reportDeptId);
    try {
      await signInAs(page, 'manager');
      await page.goto('/manager/team-approvals');
      await approveIndentRow(page, indent.serialNo);

      await expect.poll(() => approvalRow(indent.id).manager, { timeout: 20_000 }).toBe('APPROVED');
      await page.waitForTimeout(2_000);
      const mid = approvalRow(indent.id);
      expect(mid.status, 'the manager alone advanced the indent').toBe('PENDING');
      expect(mid.tech, "the manager's signature was recorded as the admin's").toBe('PENDING');

      // And the admin finishes it, with no warning to confirm past.
      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      await approveIndentRow(page, indent.serialNo);
      await expect(page.getByRole('button', { name: /Approve anyway/ }))
        .toBeHidden({ timeout: 5_000 });
      await expect.poll(() => approvalRow(indent.id).tech, { timeout: 20_000 }).toBe('APPROVED');
      expect(approvalRow(indent.id).status, 'both signatures in, but the indent did not move').not.toBe('PENDING');
    } finally {
      dropIndent(indent.id);
      setMode(reportDeptId, before as any);
    }
  });

  test('REQUIRED: an indent from someone with no manager is not left stranded', async ({ page }) => {
    // The production failure, as a test. Find a USER nobody manages — no
    // reporting line, and no MANAGER at or above their department.
    const [orphan] = sql(
      `SELECT u.id, u."departmentId" FROM "User" u
        WHERE u.role = 'USER'
          AND u."departmentId" IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM "ManagerUser" mu WHERE mu."userId" = u.id)
          AND NOT EXISTS (
            SELECT 1 FROM "User" m
             WHERE m.role = 'MANAGER' AND m."isActive" AND m."departmentId" = u."departmentId")
        LIMIT 1`,
    );
    test.skip(!orphan, 'every user in this dataset has a manager — nothing to prove');

    const [orphanId, orphanDeptId] = orphan as string[];
    const before = readMode(orphanDeptId);
    setMode(orphanDeptId, 'MANAGER_REQUIRED');
    const indent = raiseIndent(orphanId, orphanDeptId);
    try {
      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      await approveIndentRow(page, indent.serialNo);

      // No warning: there is no manager whose signature is being skipped, so
      // there is nothing to ask the admin about.
      await expect(
        page.getByRole('button', { name: /Approve anyway/ }),
        'the admin was asked to bypass a manager who does not exist',
      ).toBeHidden({ timeout: 5_000 });

      await expect.poll(() => approvalRow(indent.id).tech, { timeout: 20_000 }).toBe('APPROVED');
      const after = approvalRow(indent.id);
      expect(after.skipped, 'the absent manager was not recorded as skipped').toBe(true);
      expect(after.bypassedById, 'an absent manager was recorded as a deliberate bypass').toBeNull();
      expect(after.status, 'the indent stalled on a manager who does not exist').not.toBe('PENDING');
    } finally {
      dropIndent(indent.id);
      setMode(orphanDeptId, before as any);
    }
  });

  // The toggle is in the department's ROW, not behind Edit — no dialog, no
  // Save button. Mutation-checked: pointing this at the old dialog fails.
  // The mode is read live from the department at every signature, so the
  // department's setting TODAY is not evidence of what was asked of an indent
  // that went through months ago. The indent has to carry its own record.
  test('the indent records which rule applied, and a later switch does not rewrite it', async ({ page }) => {
    const before = readMode(reportDeptId);
    setMode(reportDeptId, 'MANAGER_REQUIRED');
    const indent = raiseIndent(reportId, reportDeptId);
    try {
      expect(appliedMode(indent.id), 'a rule was recorded before anyone signed').toBeFalsy();

      await signInAs(page, 'manager');
      await page.goto('/manager/team-approvals');
      await approveIndentRow(page, indent.serialNo);
      await expect.poll(() => approvalRow(indent.id).manager, { timeout: 20_000 }).toBe('APPROVED');

      // Half-signed in an AND department: the rule has not decided anything yet.
      expect(appliedMode(indent.id), 'the rule was recorded on a half-signed indent').toBeFalsy();

      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      await approveIndentRow(page, indent.serialNo);

      await expect
        .poll(() => appliedMode(indent.id), { message: 'no rule was recorded', timeout: 20_000 })
        .toBe('MANAGER_REQUIRED');
      expect(ruleTimelineEntries(indent.id), 'the rule was written into the user-facing timeline')
        .toBe('0');

      // The whole point: switch the department now and the indent must still
      // say what was actually required of it.
      setMode(reportDeptId, 'MANAGER_OPTIONAL');
      expect(appliedMode(indent.id), 'the record followed the department instead of staying put')
        .toBe('MANAGER_REQUIRED');
    } finally {
      dropIndent(indent.id);
      setMode(reportDeptId, before as any);
    }
  });

  // Approve under the strict rule, take the signature back, and the recorded
  // rule has to go with it — otherwise switching the department and
  // re-approving leaves the indent claiming a rule it was never held to.
  // Exactly the hazard the bypass columns are already cleared for.
  test('revoking the admin signature drops the recorded rule', async ({ page }) => {
    const before = readMode(reportDeptId);
    setMode(reportDeptId, 'MANAGER_REQUIRED');
    const indent = raiseIndent(reportId, reportDeptId);
    try {
      await signInAs(page, 'manager');
      await page.goto('/manager/team-approvals');
      await approveIndentRow(page, indent.serialNo);
      await expect.poll(() => approvalRow(indent.id).manager, { timeout: 20_000 }).toBe('APPROVED');

      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      await approveIndentRow(page, indent.serialNo);
      await expect
        .poll(() => appliedMode(indent.id), { timeout: 20_000 })
        .toBe('MANAGER_REQUIRED');

      // Revoke straight through the API the UI uses.
      await revokeTechApproval(page, indent.id);

      await expect
        .poll(() => appliedMode(indent.id), {
          message: 'the revoked indent still claims it was judged under the strict rule',
          timeout: 20_000,
        })
        .toBeFalsy();
    } finally {
      dropIndent(indent.id);
      setMode(reportDeptId, before as any);
    }
  });

  test('an OPTIONAL department records OPTIONAL, not the stricter rule', async ({ page }) => {
    const before = readMode(reportDeptId);
    setMode(reportDeptId, 'MANAGER_OPTIONAL');
    const indent = raiseIndent(reportId, reportDeptId);
    try {
      await signInAs(page, 'manager');
      await page.goto('/manager/team-approvals');
      await approveIndentRow(page, indent.serialNo);
      await expect.poll(() => approvalRow(indent.id).manager, { timeout: 20_000 }).toBe('APPROVED');

      // The manager alone does not settle the department stage any more, so
      // there is nothing to record yet — the rule is stamped when the admin
      // finishes it, which is the moment it actually decides anything.
      expect(appliedMode(indent.id), 'a rule was recorded before the stage was settled').toBeFalsy();

      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      await approveIndentRow(page, indent.serialNo);

      await expect
        .poll(() => appliedMode(indent.id), { message: 'no rule was recorded', timeout: 20_000 })
        .toBe('MANAGER_OPTIONAL');
      expect(ruleTimelineEntries(indent.id), 'the rule was written into the user-facing timeline')
        .toBe('0');
    } finally {
      dropIndent(indent.id);
      setMode(reportDeptId, before as any);
    }
  });

  test('the department toggle round-trips through the UI', async ({ page }) => {
    const before = readMode(reportDeptId);
    const deptName = sqlValue(`SELECT name FROM "Department" WHERE id = ${lit(reportDeptId)}`)!;
    setMode(reportDeptId, 'MANAGER_OPTIONAL');
    try {
      await signInAs(page, 'superAdmin');
      await page.goto('/super-admin/departments');

      const group = page.getByRole('group', { name: `Manager approval for ${deptName}` });
      await expect(group, 'the approval toggle is not in the department row').toBeVisible({ timeout: 30_000 });

      // Reflects what is stored, rather than defaulting on every render.
      await expect(group.getByRole('button', { name: 'Optional' }))
        .toHaveAttribute('aria-pressed', 'true');

      await group.getByRole('button', { name: 'Required' }).click();

      await expect
        .poll(() => readMode(reportDeptId), { message: 'the toggle did not save', timeout: 20_000 })
        .toBe('MANAGER_REQUIRED');

      // And the row shows the new rule without a reload.
      await expect(group.getByRole('button', { name: 'Required' }))
        .toHaveAttribute('aria-pressed', 'true');
    } finally {
      setMode(reportDeptId, before as any);
    }
  });

  // Postgres returns rows in physical order unless told otherwise, and an
  // UPDATE rewrites the row at the end of the heap — so changing one
  // department's mode reshuffled the whole list under the user's cursor.
  test('the list does not reshuffle when a toggle is saved', async ({ page }) => {
    const before = readMode(reportDeptId);
    const deptName = sqlValue(`SELECT name FROM "Department" WHERE id = ${lit(reportDeptId)}`)!;
    setMode(reportDeptId, 'MANAGER_OPTIONAL');
    try {
      await signInAs(page, 'superAdmin');
      await page.goto('/super-admin/departments');

      const names = () =>
        page.locator('[role="group"]').evaluateAll((gs) =>
          gs.map((g) => (g.getAttribute('aria-label') || '').replace('Manager approval for ', '')),
        );

      await expect.poll(() => names().then((n) => n.length), { timeout: 30_000 }).toBeGreaterThan(1);
      const order = await names();

      const group = page.getByRole('group', { name: `Manager approval for ${deptName}` });
      await group.getByRole('button', { name: 'Required' }).click();
      await expect
        .poll(() => readMode(reportDeptId), { message: 'the toggle did not save', timeout: 20_000 })
        .toBe('MANAGER_REQUIRED');

      expect(await names(), 'the rows jumped around after a save').toEqual(order);

      // And still in that order after a fresh load, not just in the live list.
      await page.reload();
      await expect.poll(() => names().then((n) => n.length), { timeout: 30_000 }).toBe(order.length);
      expect(await names(), 'the order is not stable across a reload').toEqual(order);
    } finally {
      setMode(reportDeptId, before as any);
    }
  });

  test('the edit dialog no longer carries the approval choice', async ({ page }) => {
    const deptName = sqlValue(`SELECT name FROM "Department" WHERE id = ${lit(reportDeptId)}`)!;
    await signInAs(page, 'superAdmin');
    await page.goto('/super-admin/departments');

    const group = page.getByRole('group', { name: `Manager approval for ${deptName}` });
    await expect(group).toBeVisible({ timeout: 30_000 });

    await page.locator('div', { hasText: new RegExp(`^${deptName}`) }).first()
      .getByRole('button', { name: /^Edit$/ }).click();

    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: /Save Department/ })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: /^Optional$|^Required$/ }),
      'the approval choice is still duplicated inside the dialog',
    ).toHaveCount(0);
  });

  test("an admin's own indent is approved the moment it is raised, even where the manager is REQUIRED", async ({ page }) => {
    const [admin] = sql(
      `SELECT u.id, ad."departmentId" FROM "User" u
         JOIN "AdminDepartment" ad ON ad."userId" = u.id
        WHERE u.email = ${lit(ACCOUNTS.admin)} LIMIT 1`,
    );
    expect(admin, 'the admin account administers no department').toBeTruthy();
    const [adminId, deptId] = [admin[0]!, admin[1]!];
    const before = readMode(deptId);
    setMode(deptId, 'MANAGER_REQUIRED');
    let indentId: string | undefined;
    try {
      await signInAs(page, 'admin');
      // Raised through the API the form uses, so creation runs end to end.
      const created = await page.evaluate(async ({ deptId, adminId, name }) => {
        const token = sessionStorage.getItem('accessToken') || '';
        const res = await fetch('http://localhost:3001/api/indents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            emergency: false, departmentId: deptId, currency: 'INR', responsiblePersonIds: [adminId],
            items: [{ name, qty: 1, unit: 'NOS', unitAmount: 500, currency: 'INR', purpose: 'E2E raiser auto-approval' }],
          }),
        });
        const body = await res.json().catch(() => ({}));
        return { status: res.status, id: (body.data ?? body).id as string | undefined };
      }, { deptId, adminId, name: `${tag()} raiser part` });
      indentId = created.id;
      expect(created.status, 'raising the indent failed').toBeLessThan(400);

      const row = approvalRow(indentId!);
      expect(row.tech, 'the admin had to approve their own indent').toBe('APPROVED');
      expect(row.status, 'the indent did not move on to Procurement').toBe('QUOTATION_IN_PROGRESS');
      expect(row.skipped, 'the manager stage was left waiting').toBe(true);
      expect(
        sqlValue(`SELECT count(*) FROM "ApprovalHistory" WHERE "entityId" = ${lit(indentId!)} AND action = 'AUTO_APPROVED'`),
        'the timeline does not say it was approved automatically',
      ).toBe('1');
    } finally {
      if (indentId) dropIndent(indentId);
      setMode(deptId, before as 'MANAGER_REQUIRED' | 'MANAGER_OPTIONAL');
    }
  });

  test('a manager can revoke after the admin signed, and the indent starts over instead of sticking', async ({ page }) => {
    const before = readMode(reportDeptId);
    setMode(reportDeptId, 'MANAGER_REQUIRED');
    const indent = raiseIndent(reportId, reportDeptId);
    try {
      await signInAs(page, 'manager');
      await page.goto('/manager/team-approvals');
      await approveIndentRow(page, indent.serialNo);
      await expect.poll(() => approvalRow(indent.id).manager, { timeout: 20_000 }).toBe('APPROVED');

      await signInAs(page, 'admin');
      await page.goto('/admin/approvals');
      await approveIndentRow(page, indent.serialNo);
      await expect.poll(() => approvalRow(indent.id).status, { timeout: 20_000 }).not.toBe('PENDING');

      // The manager takes it back from Procurement.
      await signInAs(page, 'manager');
      await page.goto('/manager/team-approvals');
      const row = page.locator('tr', { hasText: indent.serialNo }).first();
      await expect(row, `no row for ${indent.serialNo}`).toBeVisible({ timeout: 30_000 });
      await row.getByRole('button', { name: /^Revoke Approval$/ }).click();
      await page.getByRole('dialog').getByRole('button', { name: /^Revoke$/ }).click();

      // Both signatures gone, back with the approvers — not PENDING with the
      // admin's approval still on it, which nobody could clear.
      await expect.poll(() => approvalRow(indent.id).manager, { timeout: 20_000 }).toBe('PENDING');
      const after = approvalRow(indent.id);
      expect(after.tech, "the admin's approval survived the manager's revoke").toBe('PENDING');
      expect(after.status, 'the indent was not pulled back to approvals').toBe('PENDING');
      expect(
        sqlValue(
          `SELECT count(*) FROM "Notification" n JOIN "User" u ON u.id = n."userId"
            WHERE n."relatedEntityId" = ${lit(indent.id)} AND u.email = ${lit(ACCOUNTS.admin)}
              AND n.title LIKE 'Needs approval again%'`,
        ),
        'the admin was not told their approval was cleared',
      ).toBe('1');
    } finally {
      dropIndent(indent.id);
      setMode(reportDeptId, before as any);
    }
  });
});
