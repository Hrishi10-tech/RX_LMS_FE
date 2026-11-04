import { test, expect, APIRequestContext } from '@playwright/test';
import { ACCOUNTS, signInAs } from './helpers/auth';
import { sql, sqlValue, lit, createIndentFixture, createInventoryItemFixture, createIssuedRequestFixture, dropFixtures, fixtureTag } from './helpers/db';

/**
 * Who sees what, in an organisation shaped like production.
 *
 * The demo data every other spec runs on is one tidy chain — Hardware, Cibi →
 * Sampath → Abdur, every user linked to a manager by hand, one manager per
 * department. Production is not shaped like that, and on 24–26 Oct that gap
 * hid a whole class of bugs: a Software manager's team showed empty, two
 * indents sat with nobody able to see them, a Hardware extension showed to a
 * Software manager, and an admin was warned about a manager who did not exist.
 *
 * So this spec builds production's shape itself, and tears it down after:
 *
 *   Software      MANAGER_REQUIRED  two managers (M1, M2); U1 linked to M1 by
 *                                   hand, U2 and U3 linked to nobody; admin ASW
 *     └ Firmware  (sub-department)  U4, linked to nobody
 *   Hardware      MANAGER_OPTIONAL  manager M3, user U5 (unlinked); admin AHW
 *   Docs          MANAGER_OPTIONAL  NO manager; user U6; admin ADOC
 *   Procurement user P, no department — raises indents like Harsha does
 *   Finance F1 and Associate Finance AF1, no department on their records;
 *     their team departments Finance / Procurement have admins AFIN / APROC
 *     (Finance is Associate Finance's manager; Finance, Procurement and
 *     Inventory themselves have none — 26 Oct)
 *
 * Expectations are written from the business rules, not read back from the
 * code: a manager's team is their department (and the ones under it) plus
 * anyone linked to them, never their fellow managers or admins; what a person
 * is shown matches what they may act on; and nothing waits with nobody able
 * to act on it.
 */

const API = 'http://localhost:3001/api';

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const data = async (res: any) => { const j = await res.json().catch(() => ({})); return j.data ?? j; };
const ids = (rows: any[]) => rows.map((r: any) => r.id);

test.describe('organisation shaped like production', () => {
  const T = fixtureTag();
  const dept: Record<string, string> = {};
  const user: Record<string, string> = {};
  const email: Record<string, string> = {};
  const token: Record<string, string> = {};
  const indent: Record<string, string> = {};
  const loan: Record<string, string> = {};
  const ext: Record<string, string> = {};
  const pendingRequests: string[] = [];

  const login = async (request: APIRequestContext, who: string) => {
    if (token[who]) return token[who];
    const res = await request.post(`${API}/auth/login`, { data: { email: email[who], password: 'password123' } });
    expect(res.ok(), `fixture ${who} could not sign in`).toBeTruthy();
    const body = await res.json();
    return (token[who] = (body.accessToken ?? body.data?.accessToken) as string);
  };
  const get = async (request: APIRequestContext, who: string, path: string) => {
    const res = await request.get(`${API}${path}`, { headers: auth(await login(request, who)) });
    expect(res.status(), `${who} GET ${path}`).toBe(200);
    return data(res);
  };
  const items = (body: any) => body.items ?? body;
  const fixtureIndents = () => new Set(Object.values(indent));

  test.beforeAll(async () => {
    const addDept = (key: string, name: string, mode: string, parent?: string) => {
      dept[key] = sqlValue(
        `INSERT INTO "Department" (id, name, "parentId", "indentApprovalMode", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), ${lit(`${T} ${name}`)}, ${parent ? lit(dept[parent]) : 'NULL'}, ${lit(mode)}::"IndentApprovalMode", now(), now())
         RETURNING id`,
      )!;
    };
    addDept('SW', 'Software', 'MANAGER_REQUIRED');
    addDept('FW', 'Firmware', 'MANAGER_OPTIONAL', 'SW');
    addDept('HW', 'Hardware', 'MANAGER_OPTIONAL');
    addDept('DOC', 'Docs', 'MANAGER_OPTIONAL');
    addDept('NOADM', 'No admin', 'MANAGER_OPTIONAL');

    // Every fixture account gets the local password by borrowing a hash that
    // already has it, so nothing here depends on bcrypt.
    const hash = sqlValue(`SELECT password FROM "User" WHERE email = ${lit(ACCOUNTS.admin)}`)!;
    const addUser = (key: string, role: string, d: string | null) => {
      email[key] = `${T.toLowerCase()}.${key.toLowerCase()}@example.com`;
      user[key] = sqlValue(
        `INSERT INTO "User" (id, email, password, name, role, "departmentId", "isActive", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), ${lit(email[key])}, ${lit(hash)}, ${lit(`${T} ${key}`)}, ${lit(role)},
                 ${d ? lit(dept[d]) : 'NULL'}, true, now(), now()) RETURNING id`,
      )!;
    };
    addUser('M1', 'MANAGER', 'SW'); addUser('M2', 'MANAGER', 'SW');
    addUser('U1', 'USER', 'SW'); addUser('U2', 'USER', 'SW'); addUser('U3', 'USER', 'SW');
    addUser('U4', 'USER', 'FW');
    addUser('M3', 'MANAGER', 'HW'); addUser('U5', 'USER', 'HW');
    addUser('U6', 'USER', 'DOC');
    addUser('U7', 'USER', 'NOADM');
    // Deactivated in the take-over test: X (Docs) and Y (no admin, no manager).
    addUser('X', 'USER', 'DOC'); addUser('Y', 'USER', 'NOADM');
    // Deactivated while their tab is open, then reactivated.
    addUser('Z', 'USER', 'DOC');
    // W: deactivated then reactivated with work on offer. V: moved and given a password in one save.
    addUser('W', 'USER', 'DOC'); addUser('V', 'USER', 'DOC');
    // Q: nobody to offer anything to; the teams cancel or hand on. INV: an Inventory fixture.
    addUser('Q', 'USER', 'NOADM'); addUser('INV', 'INVENTORY', null);
    // VO: a view-only login given a new role. PIN: an admin pinned to one department.
    addUser('VO', 'USER', 'DOC'); addUser('PIN', 'ADMIN', 'SW');
    addUser('ASW', 'ADMIN', 'SW'); addUser('AHW', 'ADMIN', 'HW'); addUser('ADOC', 'ADMIN', 'DOC');
    addUser('P', 'PROCUREMENT', null);
    addUser('F1', 'FINANCE', null); addUser('AF1', 'ASSOCIATE_FINANCE', null);
    // The departments that are also roles exist already (created at start-up).
    dept.FIN = sqlValue(`SELECT id FROM "Department" WHERE "roleHome" = 'FINANCE'`)!;
    dept.PROC = sqlValue(`SELECT id FROM "Department" WHERE "roleHome" = 'PROCUREMENT'`)!;
    addUser('AFIN', 'ADMIN', 'FIN'); addUser('APROC', 'ADMIN', 'PROC');
    for (const [a, d] of [['ASW', 'SW'], ['AHW', 'HW'], ['ADOC', 'DOC'], ['AFIN', 'FIN'], ['APROC', 'PROC']]) {
      sql(`INSERT INTO "AdminDepartment" ("userId", "departmentId", "includeSubDepartments") VALUES (${lit(user[a])}, ${lit(dept[d])}, true)`);
    }
    sql(`INSERT INTO "ManagerUser" ("managerId", "userId") VALUES (${lit(user.M1)}, ${lit(user.U1)})`);

    // Indents waiting at the start of the chain.
    const raise = (key: string, by: string, d: string) => {
      indent[key] = createIndentFixture({ createdById: user[by], departmentId: dept[d] }).id;
    };
    raise('U1', 'U1', 'SW'); raise('U2', 'U2', 'SW'); raise('M1', 'M1', 'SW'); raise('U4', 'U4', 'FW');
    raise('U5', 'U5', 'HW'); raise('U6', 'U6', 'DOC'); raise('P', 'P', 'DOC');
    // Their own needs, under their own team.
    raise('AF1', 'AF1', 'FIN'); raise('PPROC', 'P', 'PROC');

    // Loans out with an extension asked for, and one request waiting for approval.
    const item = createInventoryItemFixture();
    for (const [key, d] of [['U3', 'SW'], ['U5', 'HW']]) {
      loan[key] = createIssuedRequestFixture({ itemId: item.id, createdById: user[key], departmentId: dept[d], handoverConfirmed: true }).id;
      ext[key] = sqlValue(
        `INSERT INTO "ExtensionRequest" (id, "componentRequestId", "newNature", "newDurationValue", "newDurationUnit", reason, "updatedAt")
         VALUES (gen_random_uuid(), ${lit(loan[key])}, 'TEMPORARY', 3, 'DAYS', 'E2E', now()) RETURNING id`,
      )!;
    }
    pendingRequests.push(sqlValue(
      `INSERT INTO "ComponentRequest" (id, "serialNo", "inventoryItemId", "qtyRequested", "qtyIssued", nature,
                                       "durationValue", "durationUnit", status, "departmentId", "createdById", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(fixtureTag())}, ${lit(item.id)}, 1, 0, 'TEMPORARY', 7, 'DAYS', 'PENDING',
               ${lit(dept.SW)}, ${lit(user.U2)}, now(), now()) RETURNING id`,
    )!);
    pendingRequests.push(sqlValue(
      `INSERT INTO "ComponentRequest" (id, "serialNo", "inventoryItemId", "qtyRequested", "qtyIssued", nature,
                                       "durationValue", "durationUnit", status, "departmentId", "createdById", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(fixtureTag())}, ${lit(item.id)}, 1, 0, 'TEMPORARY', 7, 'DAYS', 'PENDING',
               ${lit(dept.FIN)}, ${lit(user.AF1)}, now(), now()) RETURNING id`,
    )!);

    // The server caches the department tree for 10 s (department-tree.util),
    // and these departments were written straight to the database. Wait it
    // out, as a department created in the app also takes up to 10 s to count.
    await new Promise((r) => setTimeout(r, 11_000));
  });

  test.afterAll(() => {
    const userList = Object.values(user).map(lit).join(', ');
    const indentList = Object.values(indent).map(lit).join(', ');
    const reqList = [...Object.values(loan), ...pendingRequests].map(lit).join(', ');
    if (indentList) {
      for (const t of ['CustomsDutyPayment', 'VendorAllocation', 'InventoryEvent', 'VendorOrder', 'IndentStatusLog']) {
        sql(`DELETE FROM "${t}" WHERE "indentId" IN (${indentList})`);
      }
      sql(`DELETE FROM "QuotationItem" WHERE "quotationId" IN (SELECT id FROM "Quotation" WHERE "indentId" IN (${indentList}))`);
      sql(`DELETE FROM "Quotation" WHERE "indentId" IN (${indentList})`);
      sql(`DELETE FROM "Notification" WHERE "relatedEntityId" IN (${indentList})`);
    }
    if (reqList) {
      sql(`DELETE FROM "RequestResponsiblePerson" WHERE "requestId" IN (${reqList})`);
      sql(`DELETE FROM "ApprovalHistory" WHERE "entityId" IN (SELECT id FROM "ExtensionRequest" WHERE "componentRequestId" IN (${reqList}))`);
      sql(`DELETE FROM "ExtensionRequest" WHERE "componentRequestId" IN (${reqList})`);
      sql(`DELETE FROM "Notification" WHERE "relatedEntityId" IN (${reqList})`);
      // Escalation marks are written by the system (no performer), so by entity.
      sql(`DELETE FROM "ApprovalHistory" WHERE "entityId" IN (${reqList})`);
    }
    if (pendingRequests.length) sql(`DELETE FROM "ComponentRequest" WHERE id IN (${pendingRequests.map(lit).join(', ')})`);
    dropFixtures();
    if (userList) {
      sql(`DELETE FROM "Notification" WHERE "userId" IN (${userList}) OR "relatedEntityId" IN (${userList})`);
      sql(`DELETE FROM "ApprovalHistory" WHERE "entityId" IN (${userList})`);
      sql(`DELETE FROM "ApprovalHistory" WHERE "performedById" IN (${userList})`);
      sql(`DELETE FROM "ManagerUser" WHERE "userId" IN (${userList}) OR "managerId" IN (${userList})`);
      sql(`DELETE FROM "AdminDepartment" WHERE "userId" IN (${userList})`);
      sql(`DELETE FROM "PushSubscription" WHERE "userId" IN (${userList})`);
      sql(`DELETE FROM "User" WHERE id IN (${userList})`);
    }
    // Children before parents.
    for (const k of ['FW', 'SW', 'HW', 'DOC', 'NOADM']) if (dept[k]) sql(`DELETE FROM "Department" WHERE id = ${lit(dept[k])}`);
  });

  test('My Team: department and sub-departments plus linked people — never fellow managers, admins or other departments', async ({ request }) => {
    const team = async (who: string) => new Set(ids(items(await get(request, who, '/users/paginated?take=100'))));
    const sw = new Set([user.U1, user.U2, user.U3, user.U4]);
    expect(await team('M1')).toEqual(sw);
    expect(await team('M2')).toEqual(sw);
    expect(await team('M3')).toEqual(new Set([user.U5]));
  });

  test('Team Approvals: each manager sees exactly their team\'s indents, and the red dot matches', async ({ request }) => {
    const seen = async (who: string) => {
      const rows = items(await get(request, who, '/indents?teamScope=true&take=500'));
      return new Set(ids(rows).filter((id: string) => fixtureIndents().has(id)));
    };
    // M2 covers M1's own indent (same department); nobody covers their own.
    expect(await seen('M1')).toEqual(new Set([indent.U1, indent.U2, indent.U4]));
    expect(await seen('M2')).toEqual(new Set([indent.U1, indent.U2, indent.M1, indent.U4]));
    expect(await seen('M3')).toEqual(new Set([indent.U5]));
    for (const [who, n] of [['M1', 3], ['M2', 4], ['M3', 1]] as const) {
      const badge = await get(request, who, '/requests/badge-counts');
      expect(badge.pendingTeamIndentApprovals, `${who}'s dot`).toBe(n);
    }
  });

  test('requests and extensions show only to the managers who can approve them', async ({ request }) => {
    const reqs = async (who: string) => new Set(ids(items(await get(request, who, '/requests/team-approvals'))));
    expect(await reqs('M1')).toContain(pendingRequests[0]);
    expect(await reqs('M3')).not.toContain(pendingRequests[0]);

    const exts = async (who: string) => new Set(ids(items(await get(request, who, '/extensions/pending?take=200'))));
    for (const who of ['M1', 'M2', 'ASW']) {
      const e = await exts(who);
      expect(e, `${who} should see the Software extension`).toContain(ext.U3);
      expect(e, `${who} must not see the Hardware extension`).not.toContain(ext.U5);
    }
    for (const who of ['M3', 'AHW']) {
      const e = await exts(who);
      expect(e).toContain(ext.U5);
      expect(e).not.toContain(ext.U3);
    }
  });

  test('admins: the dot counts only what Approve is live on; no warning about a manager who does not exist', async ({ request }) => {
    const adminView = async (who: string) => {
      const rows = items(await get(request, who, '/indents?status=PENDING&take=500'))
        .filter((r: any) => fixtureIndents().has(r.id));
      return new Map(rows.map((r: any) => [r.id, r.techApproveBlockedReason ?? null]));
    };
    // Software is Required and every Software indent still waits for a manager.
    const sw = await adminView('ASW');
    expect(new Set(sw.keys())).toEqual(new Set([indent.U1, indent.U2, indent.M1, indent.U4]));
    expect([indent.U1, indent.U2, indent.M1].every((id) => sw.get(id)), 'Software indents must wait for a manager').toBe(true);
    const dot = async (who: string) => (await get(request, who, '/indents/badge-counts')).techPendingIndents as number;
    const live = (m: Map<unknown, unknown>) => [...m.values()].filter((v) => !v).length;
    // Fixture admins administer only fixture departments, so their dots are exact.
    expect(await dot('ASW')).toBe(live(sw));
    expect(await dot('ADOC')).toBe(2);

    // Docs has no manager, and Procurement has no department: approving goes
    // straight through, recorded as "no manager", never as a bypass.
    for (const key of ['U6', 'P']) {
      const res = await request.patch(`${API}/indents/${indent[key]}/tech-approve`, {
        headers: auth(await login(request, 'ADOC')), data: { decision: 'APPROVED' },
      });
      expect(res.status(), `${key}: ${await res.text()}`).toBe(200);
      expect(sql(`SELECT "managerApprovalBypassedById" IS NULL, "managerApprovalSkipped" FROM "Indent" WHERE id = ${lit(indent[key])}`)[0]).toEqual(['t', 't']);
    }
    // Hardware has a manager who has not signed: the admin is asked first.
    const hw = await request.patch(`${API}/indents/${indent.U5}/tech-approve`, {
      headers: auth(await login(request, 'AHW')), data: { decision: 'APPROVED' },
    });
    expect(hw.status()).toBe(409);
    expect((await hw.json()).data?.managerName ?? (await hw.json()).details?.managerName).toContain('M3');
  });

  test('a manager signs for an unlinked teammate, and a linked one\'s second manager can too', async ({ request }) => {
    for (const [who, key] of [['M1', 'U2'], ['M2', 'U1']]) {
      const res = await request.patch(`${API}/indents/${indent[key]}/manager-approve`, {
        headers: auth(await login(request, who)), data: { decision: 'APPROVED' },
      });
      expect(res.status(), `${who} signing ${key}: ${await res.text()}`).toBe(200);
    }
    // Hardware's manager cannot sign for Software.
    const cross = await request.patch(`${API}/indents/${indent.U4}/manager-approve`, {
      headers: auth(await login(request, 'M3')), data: { decision: 'APPROVED' },
    });
    expect(cross.status()).toBe(403);
  });

  test('Finance approves as Associate Finance\'s manager; Finance, Procurement and Inventory have no manager stage', async ({ request }) => {
    // Finance's Team Approvals: Associate Finance's indent and request, nobody else's.
    const finIndents = new Set(ids(items(await get(request, 'F1', '/indents?teamScope=true&take=500'))).filter((id: string) => fixtureIndents().has(id)));
    expect(finIndents).toEqual(new Set([indent.AF1]));
    expect(ids(items(await get(request, 'F1', '/requests/team-approvals')))).toContain(pendingRequests[1]);
    const expectedDot = Number(sqlValue(`SELECT count(*) FROM "Indent" i JOIN "User" u ON u.id = i."createdById"
      WHERE u.role = 'ASSOCIATE_FINANCE' AND i.status = 'PENDING' AND i."managerApprovalStatus" = 'PENDING'
        AND NOT i."managerApprovalSkipped" AND i."deletedAt" IS NULL`));
    expect((await get(request, 'F1', '/requests/badge-counts')).pendingTeamIndentApprovals).toBe(expectedDot);

    // Before Finance signs, the Finance admin is asked first; a Software manager cannot sign.
    const asAdmin = (key: string, who: string) => request.patch(`${API}/indents/${indent[key]}/tech-approve`, {
      headers: auth(token[who]), data: { decision: 'APPROVED' } });
    await login(request, 'AFIN'); await login(request, 'APROC');
    expect((await asAdmin('AF1', 'AFIN')).status()).toBe(409);
    const notTheirs = await request.patch(`${API}/indents/${indent.AF1}/manager-approve`, {
      headers: auth(await login(request, 'M1')), data: { decision: 'APPROVED' } });
    expect(notTheirs.status()).toBe(403);
    const signed = await request.patch(`${API}/indents/${indent.AF1}/manager-approve`, {
      headers: auth(await login(request, 'F1')), data: { decision: 'APPROVED' } });
    expect(signed.status(), await signed.text()).toBe(200);
    const after = await asAdmin('AF1', 'AFIN');
    expect(after.status(), await after.text()).toBe(200);

    // Procurement's own indent: no manager to wait for — straight to its admin.
    const proc = await asAdmin('PPROC', 'APROC');
    expect(proc.status(), await proc.text()).toBe(200);
    expect(sql(`SELECT "managerApprovalBypassedById" IS NULL, "managerApprovalSkipped" FROM "Indent" WHERE id = ${lit(indent.PPROC)}`)[0]).toEqual(['t', 't']);

    // Finance approves Associate Finance's request too.
    const req = await request.patch(`${API}/requests/${pendingRequests[1]}/approve`, { headers: auth(token.F1), data: {} });
    expect(req.status(), await req.text()).toBe(200);
  });

  test('nothing is left waiting with nobody able to act on it', async ({ request }) => {
    // Every fixture indent still waiting must be actionable by someone: a
    // manager offered Approve on Team Approvals, or an admin whose Approve is live.
    const stillWaiting = sql(`SELECT id FROM "Indent" WHERE id IN (${Object.values(indent).map(lit).join(', ')}) AND status = 'PENDING'`).map((r) => r[0]!);
    const actionable = new Set<string>();
    for (const m of ['M1', 'M2', 'M3', 'F1']) {
      for (const r of items(await get(request, m, '/indents?teamScope=true&take=500'))) {
        if (r.status === 'PENDING' && r.managerApprovalStatus === 'PENDING' && !r.managerApprovalSkipped) actionable.add(r.id);
      }
    }
    for (const a of ['ASW', 'AHW', 'ADOC', 'AFIN', 'APROC']) {
      for (const r of items(await get(request, a, '/indents?status=PENDING&take=500'))) {
        if (r.techApprovalStatus === 'PENDING' && !r.techApproveBlockedReason) actionable.add(r.id);
      }
    }
    const stuck = stillWaiting.filter((id) => !actionable.has(id));
    expect(stuck, 'indents nobody can act on').toEqual([]);
  });

  test('on screen: an Associate Finance request starts on the Finance department, still changeable', async ({ page }) => {
    await signInAs(page, 'associateFinance');
    await page.goto('/associate-finance/inventory-items');
    await page.getByRole('button', { name: /Request Component/ }).first().click();
    const dialog = page.getByRole('dialog');
    const deptSelect = dialog.locator('select').filter({ has: page.locator('option', { hasText: 'Select Department' }) });
    await expect(deptSelect).toHaveValue(dept.FIN, { timeout: 15_000 });
    await expect(deptSelect).toBeEnabled();
    await expect(dialog.getByText(/Your team — change it if this is for another department/)).toBeVisible();
  });

  test('a password set by someone else is reported to the admin responsible for that department', async ({ request }) => {
    email.SA = ACCOUNTS.superAdmin;
    const setPassword = async (key: string) => {
      const res = await request.patch(`${API}/users/${user[key]}`, {
        headers: auth(await login(request, 'SA')), data: { password: `New-pass-${key}-2026` } });
      expect(res.status(), await res.text()).toBe(200);
    };
    const toldAbout = (key: string) => sql(
      `SELECT "userId" FROM "Notification" WHERE "relatedEntityId" = ${lit(user[key])} AND title LIKE 'Password changed%'`,
    ).map((r) => r[0]);
    const superAdmins = sql(`SELECT id FROM "User" WHERE role = 'SUPER_ADMIN' AND "isActive" AND "deletedAt" IS NULL
                               AND email <> ${lit(ACCOUNTS.superAdmin)}`).map((r) => r[0]);

    await setPassword('U6');   // Docs → its admin
    expect(toldAbout('U6')).toEqual([user.ADOC]);
    await setPassword('U4');   // Firmware has no admin of its own → Software's admin covers it
    expect(toldAbout('U4')).toEqual([user.ASW]);
    await setPassword('AF1');  // Associate Finance → the Finance department's admin
    expect(toldAbout('AF1')).toEqual([user.AFIN]);
    await setPassword('U7');   // nobody administers it → the other Super Admins, never dropped
    expect(new Set(toldAbout('U7'))).toEqual(new Set(superAdmins));
  });

  test('a deactivated person\'s open work is offered to who can carry it on; nobody → Procurement is told', async ({ request }) => {
    email.SA = ACCOUNTS.superAdmin;
    // X: an indent with a responsible person, and a request with none (their manager gets it).
    indent.XA = createIndentFixture({ createdById: user.X, departmentId: dept.DOC }).id;
    sql(`INSERT INTO "IndentResponsiblePerson" ("indentId", "userId") VALUES (${lit(indent.XA)}, ${lit(user.U3)})`);
    sql(`INSERT INTO "ManagerUser" ("managerId", "userId") VALUES (${lit(user.M3)}, ${lit(user.X)})`);
    const item = createInventoryItemFixture();
    const xReq = sqlValue(
      `INSERT INTO "ComponentRequest" (id, "serialNo", "inventoryItemId", "qtyRequested", "qtyIssued", nature,
                                       "durationValue", "durationUnit", status, "departmentId", "createdById", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(fixtureTag())}, ${lit(item.id)}, 1, 0, 'TEMPORARY', 7, 'DAYS', 'PENDING',
               ${lit(dept.DOC)}, ${lit(user.X)}, now(), now()) RETURNING id`,
    )!;
    pendingRequests.push(xReq);
    // Y: nobody to offer it to at all.
    indent.YA = createIndentFixture({ createdById: user.Y, departmentId: dept.NOADM }).id;

    for (const who of ['X', 'Y']) {
      const res = await request.post(`${API}/users/${user[who]}/deactivate`, { headers: auth(await login(request, 'SA')) });
      expect(res.status(), await res.text()).toBe(201);
    }
    const offeredTo = (id: string) => sql(
      `SELECT "userId" FROM "Notification" WHERE "relatedEntityId" = ${lit(id)} AND title LIKE 'Take over %'`,
    ).map((r) => r[0]).sort();
    expect(offeredTo(indent.XA), 'responsible person first').toEqual([user.U3]);
    expect(offeredTo(xReq), 'no responsible person → their manager').toEqual([user.M3]);
    const procurement = sql(`SELECT id FROM "User" WHERE role = 'PROCUREMENT' AND "isActive" AND "deletedAt" IS NULL`).map((r) => r[0]).sort();
    // One notice per deactivated person (not per item), and the item is marked escalated.
    const told = sql(`SELECT "userId" FROM "Notification" WHERE "relatedEntityId" = ${lit(user.Y)} AND "relatedEntityType" = 'TAKEOVER_ESCALATION'`).map((r) => r[0]).sort();
    expect(told, 'nobody to offer it to → Procurement').toEqual(procurement);
    expect(sqlValue(`SELECT count(*) FROM "ApprovalHistory" WHERE "entityId" = ${lit(indent.YA)} AND action = 'TAKEOVER_ESCALATED'`)).toBe('1');

    // Only those offered can take it; the first wins; the old owner stays on it.
    const mine = async (who: string) => ids(items(await get(request, who, '/takeovers/mine')));
    expect(await mine('U3')).toContain(indent.XA);
    expect(await mine('M1')).not.toContain(indent.XA);
    const take = async (who: string, kind: string, id: string) =>
      request.post(`${API}/takeovers/${kind}/${id}`, { headers: auth(await login(request, who)) });
    expect((await take('M1', 'indent', indent.XA)).status()).toBe(403);
    const ok = await take('U3', 'indent', indent.XA);
    expect(ok.status(), await ok.text()).toBe(201);
    expect(sqlValue(`SELECT "createdById" FROM "Indent" WHERE id = ${lit(indent.XA)}`)).toBe(user.U3);
    expect(sqlValue(`SELECT count(*) FROM "IndentResponsiblePerson" WHERE "indentId" = ${lit(indent.XA)} AND "userId" = ${lit(user.X)}`)).toBe('1');
    expect(offeredTo(indent.XA), 'the offer is withdrawn once taken').toEqual([]);
    expect((await take('U3', 'indent', indent.XA)).status(), 'already taken').toBe(409);

    const reqTaken = await take('M3', 'request', xReq);
    expect(reqTaken.status(), await reqTaken.text()).toBe(201);
    expect(sqlValue(`SELECT "createdById" FROM "ComponentRequest" WHERE id = ${lit(xReq)}`)).toBe(user.M3);
  });

  // Nobody could be offered Y's indent. Procurement — not the Super Admin
  // (owner, 28 Oct) — can take it or hand it to anyone active.
  test('nobody to offer it to: Procurement takes it or hands it to anyone active', async ({ request }) => {
    expect(indent.YA, 'runs after the take-over test, which deactivates Y').toBeTruthy();
    const listed = items(await get(request, 'P', '/takeovers/mine')).find((o: any) => o.id === indent.YA);
    expect(listed?.canAssign, 'Procurement sees it and may hand it on').toBe(true);
    const assign = async (who: string, to: string) =>
      request.post(`${API}/takeovers/indent/${indent.YA}/assign`, { headers: auth(await login(request, who)), data: { userId: user[to] } });
    expect((await assign('M1', 'U7')).status(), 'a manager cannot hand on what was not theirs to offer').toBe(403);
    expect((await assign('P', 'Y')).status(), 'not back to the deactivated person').toBe(400);
    const ok = await assign('P', 'U7');
    expect(ok.status(), await ok.text()).toBe(201);
    expect(sqlValue(`SELECT "createdById" FROM "Indent" WHERE id = ${lit(indent.YA)}`)).toBe(user.U7);
    expect(sqlValue(`SELECT count(*) FROM "IndentResponsiblePerson" WHERE "indentId" = ${lit(indent.YA)} AND "userId" = ${lit(user.Y)}`), 'Y stays on it').toBe('1');
    expect(sqlValue(`SELECT count(*) FROM "Notification" WHERE "userId" = ${lit(user.U7)} AND "relatedEntityId" = ${lit(indent.YA)} AND title LIKE '% is now yours'`)).toBe('1');
    expect(items(await get(request, 'P', '/takeovers/mine')).some((o: any) => o.id === indent.YA), 'gone once handed on').toBe(false);
  });

  test('reactivated, their work is theirs again: the take-over offers are withdrawn', async ({ request }) => {
    email.SA = ACCOUNTS.superAdmin;
    indent.WA = createIndentFixture({ createdById: user.W, departmentId: dept.DOC }).id;
    sql(`INSERT INTO "IndentResponsiblePerson" ("indentId", "userId") VALUES (${lit(indent.WA)}, ${lit(user.U6)})`);
    const sa = auth(await login(request, 'SA'));
    const offers = () => sqlValue(`SELECT count(*) FROM "Notification" WHERE "relatedEntityId" = ${lit(indent.WA)} AND title LIKE 'Take over %'`);
    expect((await request.post(`${API}/users/${user.W}/deactivate`, { headers: sa })).status()).toBe(201);
    expect(offers(), 'offered to the responsible person').toBe('1');
    expect((await request.post(`${API}/users/${user.W}/reactivate`, { headers: sa })).status()).toBe(201);
    expect(offers(), 'withdrawn on reactivation').toBe('0');
  });

  test('moved and given a password in one save: the NEW department\'s admin is told', async ({ request }) => {
    email.SA = ACCOUNTS.superAdmin;
    const res = await request.patch(`${API}/users/${user.V}`, {
      headers: auth(await login(request, 'SA')), data: { departmentId: dept.HW, password: 'New-pass-V-2026' } });
    expect(res.status(), await res.text()).toBe(200);
    const told = sql(`SELECT "userId" FROM "Notification" WHERE "relatedEntityId" = ${lit(user.V)} AND title LIKE 'Password changed%'`).map((r) => r[0]);
    expect(told).toEqual([user.AHW]);
  });

  // Procurement cancels an indent, Inventory a request — only while nothing has
  // moved (owner, 28 Oct). A paid indent can only be handed on.
  test('nobody to offer it to: the team may cancel what has not moved yet, with a reason', async ({ request }) => {
    email.SA = ACCOUNTS.superAdmin;
    indent.QA = createIndentFixture({ createdById: user.Q, departmentId: dept.NOADM }).id;
    indent.QB = createIndentFixture({ createdById: user.Q, departmentId: dept.NOADM, status: 'PAYMENT_DONE' }).id;
    const item = createInventoryItemFixture();
    const qReq = sqlValue(
      `INSERT INTO "ComponentRequest" (id, "serialNo", "inventoryItemId", "qtyRequested", "qtyIssued", nature,
                                       "durationValue", "durationUnit", status, "departmentId", "createdById", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(), ${lit(fixtureTag())}, ${lit(item.id)}, 1, NULL, 'TEMPORARY', 7, 'DAYS', 'APPROVED',
               ${lit(dept.NOADM)}, ${lit(user.Q)}, now(), now()) RETURNING id`,
    )!;
    pendingRequests.push(qReq);
    const off = await request.post(`${API}/users/${user.Q}/deactivate`, { headers: auth(await login(request, 'SA')) });
    expect(off.status(), await off.text()).toBe(201);

    const buyers = sql(`SELECT id FROM "User" WHERE role = 'PROCUREMENT' AND "isActive" AND "deletedAt" IS NULL`).map((r) => r[0]);
    const procNotices = sqlValue(`SELECT count(*) FROM "Notification" WHERE "relatedEntityId" = ${lit(user.Q)}
                                  AND "relatedEntityType" = 'TAKEOVER_ESCALATION' AND "userId" = ${lit(user.P)}`);
    expect(procNotices, 'two indents, still one notice for each buyer').toBe('1');
    expect(buyers).toContain(user.P);

    const offered = items(await get(request, 'P', '/takeovers/mine'));
    expect(offered.find((o: any) => o.id === indent.QA)?.canCancel).toBe(true);
    expect(offered.find((o: any) => o.id === indent.QB)?.canCancel, 'paid: hand on only').toBe(false);

    const cancel = async (who: string, kind: string, id: string, reason: string) =>
      request.post(`${API}/takeovers/${kind}/${id}/cancel`, { headers: auth(await login(request, who)), data: { reason } });
    expect((await cancel('P', 'indent', indent.QA, '  ')).status(), 'a reason is required').toBe(400);
    expect((await cancel('P', 'indent', indent.QB, 'not needed')).status(), 'money has moved').toBe(409);
    expect((await cancel('INV', 'indent', indent.QA, 'not needed')).status(), 'indents are Procurement\'s').toBe(403);
    const ok = await cancel('P', 'indent', indent.QA, 'project dropped');
    expect(ok.status(), await ok.text()).toBe(201);
    expect(sqlValue(`SELECT status::text FROM "Indent" WHERE id = ${lit(indent.QA)}`)).toBe('CANCELLED');

    expect((await cancel('P', 'request', qReq, 'not needed')).status(), 'requests are Inventory\'s').toBe(403);
    const okReq = await cancel('INV', 'request', qReq, 'nobody needs it now');
    expect(okReq.status(), await okReq.text()).toBe(201);
    expect(sqlValue(`SELECT status::text FROM "ComponentRequest" WHERE id = ${lit(qReq)}`)).toBe('REJECTED');
    expect(sqlValue(`SELECT "rejectionReason" FROM "ComponentRequest" WHERE id = ${lit(qReq)}`)).toContain('nobody needs it now');

    // QB is still waiting, so Procurement's notice stays until it is handed on.
    expect(sqlValue(`SELECT count(*) FROM "Notification" WHERE "relatedEntityId" = ${lit(user.Q)} AND "relatedEntityType" = 'TAKEOVER_ESCALATION' AND "userId" = ${lit(user.P)}`)).toBe('1');
    const handed = await request.post(`${API}/takeovers/indent/${indent.QB}/assign`, { headers: auth(await login(request, 'P')), data: { userId: user.U7 } });
    expect(handed.status(), await handed.text()).toBe(201);
    expect(sqlValue(`SELECT count(*) FROM "Notification" WHERE "relatedEntityId" = ${lit(user.Q)} AND "relatedEntityType" = 'TAKEOVER_ESCALATION'`), 'nothing left waiting: notices gone').toBe('0');
  });

  test('a new role starts without view-only, and keeps an admin\'s "this department only" pins', async ({ request }) => {
    email.SA = ACCOUNTS.superAdmin;
    const sa = auth(await login(request, 'SA'));
    sql(`UPDATE "User" SET "isViewOnly" = true WHERE id = ${lit(user.VO)}`);
    let res = await request.patch(`${API}/users/${user.VO}`, { headers: sa, data: { role: 'MANAGER' } });
    expect(res.status(), await res.text()).toBe(200);
    expect(sqlValue(`SELECT "isViewOnly"::text FROM "User" WHERE id = ${lit(user.VO)}`), 'a manager who cannot approve helps nobody').toBe('false');

    sql(`INSERT INTO "AdminDepartment" ("userId", "departmentId", "includeSubDepartments") VALUES (${lit(user.PIN)}, ${lit(dept.SW)}, false)`);
    res = await request.patch(`${API}/users/${user.PIN}`, { headers: sa, data: { role: 'LAB' } });
    expect(res.status(), await res.text()).toBe(200);
    expect(sqlValue(`SELECT "includeSubDepartments"::text FROM "AdminDepartment" WHERE "userId" = ${lit(user.PIN)} AND "departmentId" = ${lit(dept.SW)}`),
      'still this department only').toBe('false');
  });

  // 28 Oct: any manager or admin could chase any department's indent, the
  // approval reminder missed a parent department's admin, and the payment
  // reminder went to every Finance user even when one was assigned.
  test('reminders: only someone who can see the indent sends one, and only the people who act on it get it', async ({ request }) => {
    email.SA = ACCOUNTS.superAdmin;
    const remind = async (who: string, id: string, type: string) =>
      request.post(`${API}/indents/${id}/remind`, { headers: auth(await login(request, who)), data: { type } });
    const reminded = (id: string, title: string) => sql(
      `SELECT "userId" FROM "Notification" WHERE "relatedEntityId" = ${lit(id)} AND type = 'REMINDER' AND title = ${lit(title)}`,
    ).map((r) => r[0]).sort();

    // Firmware's indent: Hardware's manager has nothing to do with it.
    expect((await remind('M3', indent.U4, 'tech')).status(), 'another department\'s manager').toBe(404);
    const ok = await remind('M1', indent.U4, 'tech');
    expect(ok.status(), await ok.text()).toBe(201);
    expect(reminded(indent.U4, 'Approval reminder'), 'Firmware has no admin of its own; Software\'s covers it').toEqual([user.ASW]);

    // A payment assigned to one person reminds that person only.
    indent.PAY = createIndentFixture({ createdById: user.U1, departmentId: dept.SW, status: 'AWAITING_PAYMENT', paymentAssigneeId: user.AF1 }).id;
    const pay = await remind('P', indent.PAY, 'finance');
    expect(pay.status(), await pay.text()).toBe(201);
    expect(reminded(indent.PAY, 'Payment reminder')).toEqual([user.AF1]);
  });

  // Finance switching an Associate Finance off from its own page went round the
  // take-over offers entirely: nobody was told their work needed an owner.
  test('Finance deactivating an Associate Finance offers their open work too', async ({ request }) => {
    const patch = async (isActive: boolean) => request.patch(`${API}/users/associate-finance/${user.AF1}`, {
      headers: auth(await login(request, 'F1')), data: { isActive } });
    let res = await patch(false);
    expect(res.status(), await res.text()).toBe(200);
    const about = () => sql(`SELECT count(*) FROM "Notification" WHERE ("relatedEntityId" = ${lit(indent.AF1)} AND title LIKE 'Take over %')
                              OR ("relatedEntityId" = ${lit(user.AF1)} AND "relatedEntityType" = 'TAKEOVER_ESCALATION')`)[0][0];
    expect(Number(about()), 'their indent is offered (or escalated) to someone').toBeGreaterThan(0);
    res = await patch(true);
    expect(res.status(), await res.text()).toBe(200);
    expect(about(), 'withdrawn again on reactivation').toBe('0');
    delete token.AF1;
  });

  // The token check already refused a deactivated person's next request, but an
  // open tab kept its live connection and kept receiving live events until they
  // clicked something. Now the tab is signed out on its own, and reactivating
  // lets them straight back in.
  test('a deactivated person\'s open tab is signed out at once; reactivated, they sign in again', async ({ page, request }) => {
    email.SA = ACCOUNTS.superAdmin;
    const signIn = async () => {
      await page.goto('/login');
      await page.fill('#email-address', email.Z);
      await page.fill('#password', 'password123');
      await page.getByRole('button', { name: /^Sign in$/ }).click();
      await page.getByRole('main').first().waitFor({ state: 'visible', timeout: 30_000 });
    };
    await signIn();
    // Wait until the live connection is up, so the test proves it is cut.
    await expect.poll(() => sqlValue(`SELECT "isOnline"::text FROM "User" WHERE id = ${lit(user.Z)}`), { timeout: 15_000 }).toBe('true');

    const sa = auth(await login(request, 'SA'));
    const off = await request.post(`${API}/users/${user.Z}/deactivate`, { headers: sa });
    expect(off.status(), await off.text()).toBe(201);
    // No click, no navigation from the test: the tab has to leave by itself.
    await page.waitForURL(/\/login/, { timeout: 15_000 });

    const on = await request.post(`${API}/users/${user.Z}/reactivate`, { headers: sa });
    expect(on.status(), await on.text()).toBe(201);
    delete token.Z;
    await signIn();
    await expect(page).not.toHaveURL(/\/login/);
  });
});
