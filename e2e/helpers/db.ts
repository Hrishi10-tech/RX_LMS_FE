import { execFileSync } from 'node:child_process';

/**
 * Direct Postgres access for e2e fixtures.
 *
 * Why this exists: some preconditions cannot be reached through the UI, and
 * some mutations cannot be undone through the API. `DELETE /indents/:id` is
 * rejected once an indent leaves PENDING/APPROVED, so a spec that marks one
 * paid has no API route back. The pattern throughout is therefore
 * snapshot -> mutate through the UI -> restore, with the snapshot and the
 * restore both happening here.
 *
 * Why `docker exec psql` rather than a pg client: it adds no dependency, and
 * it uses the same credentials the stack already has, so there is no second
 * place to keep a password.
 *
 * SAFETY: the container and database names below are the SANDBOX ones. The
 * real stack is `lab-management-db` / `lab_management_restructure` and must
 * never appear here. `assertSandbox()` is called before every statement and
 * throws if either name drifts.
 */
const CONTAINER = 'lms-ui-db';
const DATABASE = 'lms_ui_lab';
const DB_USER = 'user';

const FORBIDDEN = ['lab-management-db', 'lab_management_restructure'];

const assertSandbox = () => {
  for (const name of FORBIDDEN) {
    if (CONTAINER.includes(name) || DATABASE.includes(name)) {
      throw new Error(
        `e2e/helpers/db.ts is pointed at the REAL stack (${name}). Refusing to run.`,
      );
    }
  }
};

/**
 * Marker psql prints for NULL.
 *
 * This matters more than it looks. By default psql renders NULL as an empty
 * string, which makes NULL indistinguishable from '' — and worse, when the
 * TRAILING columns of a row are all NULL, `split('\t')` yields fewer elements
 * than there are columns, so reading by index returns `undefined`. That is
 * exactly how the first version of this helper produced
 * `"paidAt" = 'undefined'` and left a fixture row un-restored. `-P null=` puts
 * an explicit token in every NULL cell so the arity is always right.
 */
export const NULL_TOKEN = '\\N';

/** Runs one SQL statement and returns raw rows (tab-separated, unaligned). */
export const sql = (statement: string): (string | null)[][] => {
  assertSandbox();
  const out = execFileSync(
    'docker',
    [
      'exec', '-i', CONTAINER, 'psql', '-U', DB_USER, '-d', DATABASE,
      '-t', '-A', '-F', '\t', '-P', `null=${NULL_TOKEN}`, '-c', statement,
    ],
    { encoding: 'utf8' },
  );
  return out
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '')
    .map((line) => line.split('\t').map((cell) => (cell === NULL_TOKEN ? null : cell)));
};

/** Convenience for a statement expected to return exactly one value. */
export const sqlValue = (statement: string): string | null | undefined => sql(statement)[0]?.[0];

/** Escapes a value for inlining into SQL. Fixtures only — not user input. */
export const lit = (v: string | number | null): string =>
  v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

export const nowIso = (): string => sqlValue(`SELECT now()::text`) ?? new Date().toISOString();

/** Guard used by the isolation spec: proves which database we are attached to. */
export const currentDatabase = (): string | null | undefined => sqlValue('SELECT current_database()');

/**
 * Where the backend keeps uploads. With STORAGE_PROVIDER=s3 the files are in
 * the bucket, not /app/uploads, so the helpers below ask the backend container
 * (which holds the S3 settings) to list or delete them there.
 */
const backendStorage = (): string => {
  try {
    return execFileSync('docker', ['exec', 'lms-ui-backend', 'printenv', 'STORAGE_PROVIDER'], { encoding: 'utf8' }).trim().toLowerCase() || 'local';
  } catch {
    return 'local';
  }
};

/** Run a small S3 script inside the backend container; prints a number. */
const s3InBackend = (filenameSuffix: string, del: boolean): number => {
  const script = `
    const s3 = require('@aws-sdk/client-s3');
    const c = new s3.S3Client({ region: process.env.S3_REGION || 'us-east-1',
      ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
      ...(process.env.S3_ACCESS_KEY_ID ? { credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } } : {}) });
    (async () => {
      let n = 0, token;
      do {
        const out = await c.send(new s3.ListObjectsV2Command({ Bucket: process.env.S3_BUCKET, Prefix: process.env.S3_PREFIX ? process.env.S3_PREFIX.replace(/^\\/+|\\/+$/g, '') + '/' : undefined, ContinuationToken: token }));
        for (const o of out.Contents || []) if (o.Key.endsWith(${JSON.stringify(filenameSuffix)})) {
          n++; if (${del}) await c.send(new s3.DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: o.Key }));
        }
        token = out.NextContinuationToken;
      } while (token);
      console.log(n);
    })().catch(() => console.log(0));`;
  try {
    return Number(execFileSync('docker', ['exec', 'lms-ui-backend', 'node', '-e', script], { encoding: 'utf8' }).trim()) || 0;
  } catch {
    return 0;
  }
};

/**
 * Deletes upload artefacts a spec created.
 *
 * Restoring `paymentReceiptPath` to NULL drops the *reference* but leaves the
 * FILE on the backend's uploads volume — three runs of the payment spec left
 * three orphaned PDFs behind before this existed. Matched on the fixture's
 * filename so it can only ever remove files these tests uploaded.
 */
export const deleteUploadedFixtures = (filenameSuffix: string) => {
  assertSandbox();
  if (backendStorage() === 's3') { s3InBackend(filenameSuffix, true); return; }
  try {
    execFileSync(
      'docker',
      [
        'exec', 'lms-ui-backend', 'sh', '-c',
        // -name pattern, not a path, so a moved upload directory still matches.
        `find /app/uploads -type f -name '*${filenameSuffix}' -delete 2>/dev/null || true`,
      ],
      { encoding: 'utf8' },
    );
  } catch {
    // Best-effort: an orphaned fixture file is untidy, not a test failure.
  }
};

/** Counts matching upload artefacts — used to assert the cleanup worked. */
export const countUploadedFixtures = (filenameSuffix: string): number => {
  assertSandbox();
  if (backendStorage() === 's3') return s3InBackend(filenameSuffix, false);
  try {
    const out = execFileSync(
      'docker',
      ['exec', 'lms-ui-backend', 'sh', '-c',
       `find /app/uploads -type f -name '*${filenameSuffix}' 2>/dev/null | wc -l`],
      { encoding: 'utf8' },
    );
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
};

// ---------------------------------------------------------------------------
// Cleanups the content fingerprint found
// ---------------------------------------------------------------------------
//
// These were all invisible to a row-count check and are the reason
// `global-teardown.ts` now content-hashes instead. Two of them are orphan
// rows; the third is worse — lifetime inventory counters that the suite was
// inflating on every single run.


/**
 * The batch row a bulk upload writes.
 *
 * Undo removes the ITEMS it created — which is what the test asserts — and
 * leaves the UploadBatch row describing an upload whose items no longer
 * exist. It shows up in Upload History as a real batch.
 */
export const deleteUploadBatchesSince = (since: string) => {
  sql(`DELETE FROM "UploadBatch" WHERE "createdAt" >= ${lit(since)}`);
};

/** The lifetime counters on an item, which are business figures, not state. */
const INVENTORY_COUNTERS = ['totalIssued', 'totalReturned', 'totalReceived'] as const;

export type InventoryCounters = { id: string; values: Record<string, string | null> };

/**
 * Snapshot the lifetime counters before a spec moves stock.
 *
 * `totalIssued`, `totalReturned` and `totalReceived` are cumulative — they are
 * never decremented, by design, because they answer "how much has ever moved
 * through this item". Issuing and returning in a test therefore does NOT
 * cancel out: it adds to both. Measured across one run, the issue/return spec
 * pushed one item's totals 86 -> 88 and the receiving spec pushed another's
 * totalReceived 1028 -> 1040. Every run, for as long as the suite has existed.
 *
 * Restoring them is the only honest option. Leaving them is quietly editing
 * the lab's stock history to record movements that never happened.
 */
export const snapshotInventoryCounters = (itemIds: string[]): InventoryCounters[] => {
  if (itemIds.length === 0) return [];
  const cols = INVENTORY_COUNTERS.map((c) => `"${c}"`).join(', ');
  const ids = itemIds.map((id) => lit(id)).join(', ');
  return sql(`SELECT id, ${cols} FROM "InventoryItem" WHERE id IN (${ids})`).map((row) => {
    const values: Record<string, string | null> = {};
    INVENTORY_COUNTERS.forEach((c, i) => { values[c] = row[i + 1]; });
    return { id: row[0]!, values };
  });
};

export const restoreInventoryCounters = (snaps: InventoryCounters[]) => {
  for (const snap of snaps) {
    const assignments = INVENTORY_COUNTERS
      .map((c) => `"${c}" = ${snap.values[c] === null ? 'NULL' : lit(snap.values[c]!)}`)
      .join(', ');
    sql(`UPDATE "InventoryItem" SET ${assignments} WHERE id = ${lit(snap.id)}`);
  }
};

/** Every live item's counters — for specs that touch an item chosen at runtime. */
export const snapshotAllInventoryCounters = (): InventoryCounters[] => {
  const cols = INVENTORY_COUNTERS.map((c) => `"${c}"`).join(', ');
  return sql(`SELECT id, ${cols} FROM "InventoryItem" WHERE "deletedAt" IS NULL`).map((row) => {
    const values: Record<string, string | null> = {};
    INVENTORY_COUNTERS.forEach((c, i) => { values[c] = row[i + 1]; });
    return { id: row[0]!, values };
  });
};

/**
 * The conversation row a chat message updates.
 *
 * `lastMessage` is denormalised onto the conversation so the list can render
 * without joining. The chat spec deletes its message, but
 * the copy on the conversation stays — leaving the sidebar quoting an
 * `E2E-...` line that no longer exists in the thread.
 */
export type ConversationSnapshot = { id: string; values: Record<string, string | null> };

// Checked against the table, not assumed: there is no `lastMessageAt` — the
// timestamp is the row's own `updatedAt`, which the fingerprint already treats
// as churn. Guessing the name cost a run: the snapshot query threw inside
// `beforeAll` and took 47 tests with it.
const CONVERSATION_COLUMNS = ['lastMessage'] as const;

export const snapshotConversations = (): ConversationSnapshot[] => {
  const cols = CONVERSATION_COLUMNS.map((c) => `"${c}"`).join(', ');
  return sql(`SELECT id, ${cols} FROM "Conversation"`).map((row) => {
    const values: Record<string, string | null> = {};
    CONVERSATION_COLUMNS.forEach((c, i) => { values[c] = row[i + 1]; });
    return { id: row[0]!, values };
  });
};

export const restoreConversations = (snaps: ConversationSnapshot[]) => {
  // Conversations CREATED during the run have to go, not just be reset. This
  // only ever UPDATEd the snapshotted ids, so a thread a spec started was
  // never in the snapshot and nothing removed it — on a database that begins
  // with no conversations at all, the loop below ran zero times and the new
  // row simply stayed. The chat specs start their own thread precisely because
  // a restored database carries none, so that was the normal case, not an edge
  // one.
  //
  // ConversationMember and Message are both ON DELETE CASCADE, so removing the
  // conversation takes its members and messages with it.
  const keep = snaps.map((s) => lit(s.id)).join(', ');
  sql(
    keep
      ? `DELETE FROM "Conversation" WHERE id NOT IN (${keep})`
      // No snapshot means there were none to begin with, so every row present
      // now arrived during the run. Guarded as a separate statement because
      // `NOT IN ()` is a syntax error rather than "match everything".
      : `DELETE FROM "Conversation"`,
  );

  for (const snap of snaps) {
    const assignments = CONVERSATION_COLUMNS
      .map((c) => `"${c}" = ${snap.values[c] === null ? 'NULL' : lit(snap.values[c]!)}`)
      .join(', ');
    sql(`UPDATE "Conversation" SET ${assignments} WHERE id = ${lit(snap.id)}`);
  }
};

// ---------------------------------------------------------------------------
// Self-contained fixtures
// ---------------------------------------------------------------------------
//
// For specs that need a particular kind of row to exist. They used to borrow
// whatever the database happened to hold — "the first in-progress indent",
// "any issued request" — and so passed or failed according to someone's
// manual testing that morning. Three specs did exactly that: they went red
// whenever the sandbox was wiped, and one went GREEN for a run only because a
// different spec had leaked a row they could borrow. A test whose result
// depends on unrelated data is not testing the app.
//
// Ids are recorded the INSTANT each row is inserted, before anything else can
// throw, and dropFixtures() removes everything recorded. An earlier spec
// returned its id at the end of its helper, threw halfway through on one run,
// and left an orphan the row-count guard could not see.

const madeIndents: string[] = [];
const madeRequests: string[] = [];
const madeItems: string[] = [];

export const fixtureTag = () =>
  `E2E-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** The account's own id and department — fixtures belong to real fixture users. */
export const userFixtureIds = (email: string): { id: string; departmentId: string } => {
  const row = sql(`SELECT id, "departmentId" FROM "User" WHERE email = ${lit(email)} AND "deletedAt" IS NULL`)[0];
  if (!row?.[0] || !row?.[1]) throw new Error(`fixture user ${email} is missing or has no department`);
  return { id: row[0], departmentId: row[1] };
};

/**
 * Statuses an indent can only reach AFTER its approvals. A fixture in one of
 * these has to carry the approvals too, or it is a state the app can never
 * produce — and the app is right to refuse it. The first fixture for
 * mark-as-paid sat in AWAITING_PAYMENT with tech approval still PENDING, and
 * the payment endpoint correctly answered 400 "Tech approval is PENDING".
 */
const PAST_APPROVAL = [
  'APPROVED', 'QUOTATION_IN_PROGRESS', 'READY_FOR_PAYMENT', 'AWAITING_PAYMENT',
  'PAYMENT_DONE', 'ORDERED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED',
];

/**
 * An indent with one line, in a state the app could actually have produced.
 * The default amount stays under the CEO-approval threshold so no fixture
 * needs a CEO signature it would otherwise have to fake.
 */
export const createIndentFixture = (o: {
  createdById: string;
  departmentId: string;
  status?: string;
  grandTotal?: number;
  paymentAssigneeId?: string | null;
}): { id: string; serialNo: string } => {
  const serialNo = fixtureTag();
  const total = o.grandTotal ?? 4200;
  const status = o.status ?? 'PENDING';
  const approved = PAST_APPROVAL.includes(status);
  const sig = approved ? `'APPROVED'::"ApprovalStatus"` : `'PENDING'::"ApprovalStatus"`;
  const id = sqlValue(
    `INSERT INTO "Indent" (id, "serialNo", "grandTotal", currency, status, "departmentId", "createdById",
                           "paymentAssigneeId", "managerApprovalStatus", "managerApprovedAt",
                           "techApprovalStatus", "techApprovedAt", "techApprovedAtAmount",
                           "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(serialNo)}, ${total}, 'INR', ${lit(status)}::"IndentStatus",
             ${lit(o.departmentId)}, ${lit(o.createdById)},
             ${o.paymentAssigneeId ? lit(o.paymentAssigneeId) : 'NULL'},
             ${sig}, ${approved ? 'now()' : 'NULL'},
             ${sig}, ${approved ? 'now()' : 'NULL'}, ${approved ? total : 'NULL'},
             now(), now())
     RETURNING id`,
  );
  if (!id) throw new Error('indent fixture was not created');
  madeIndents.push(id);
  sql(
    // `url` is NOT NULL with no default — a blank string is what the app
    // stores for a line nobody pasted a link for.
    `INSERT INTO "IndentItem" (id, "indentId", name, qty, unit, "unitAmount", currency, url, purpose, total, "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(id)}, 'E2E fixture part', 1, 'NOS', ${total}, 'INR', '', 'e2e fixture', ${total}, now(), now())`,
  );
  return { id, serialNo };
};

/** A plain shared item with stock, to hang requests off. */
export const createInventoryItemFixture = (): { id: string; name: string } => {
  const name = `${fixtureTag()} part`;
  const id = sqlValue(
    `INSERT INTO "InventoryItem" (id, name, category, unit, stock, status, "isShared", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(name)}, 'ELECTRONICS_GENERAL_ACCESSORIES', 'PCS', 50, 'AVAILABLE', true, now(), now())
     RETURNING id`,
  );
  if (!id) throw new Error('inventory item fixture was not created');
  madeItems.push(id);
  return { id, name };
};

/**
 * A request already issued to someone — out on loan, or with the handover
 * confirmed. The two Issue Slips tabs split on exactly this: `issuedConfirmedAt`,
 * not status, which stays IN_USE either way.
 */
export const createIssuedRequestFixture = (o: {
  itemId: string;
  createdById: string;
  departmentId: string;
  handoverConfirmed: boolean;
}): { id: string; serialNo: string } => {
  const serialNo = fixtureTag();
  const id = sqlValue(
    `INSERT INTO "ComponentRequest" (id, "serialNo", "inventoryItemId", "qtyRequested", "qtyIssued", nature,
                                     "durationValue", "durationUnit", status, "departmentId", "createdById",
                                     "issuedAt", "issuedConfirmedAt", "dueDate", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(serialNo)}, ${lit(o.itemId)}, 1, 1, 'TEMPORARY',
             7, 'DAYS', 'IN_USE', ${lit(o.departmentId)}, ${lit(o.createdById)},
             now(), ${o.handoverConfirmed ? 'now()' : 'NULL'}, now() + interval '7 days', now(), now())
     RETURNING id`,
  );
  if (!id) throw new Error('issued request fixture was not created');
  madeRequests.push(id);
  return { id, serialNo };
};

/**
 * A request nothing has been issued against yet — waiting for approval, or
 * approved and waiting to be issued. APPROVED carries its approver, as the
 * app would have recorded one.
 */
export const createOpenRequestFixture = (o: {
  itemId: string;
  createdById: string;
  departmentId: string;
  status: 'PENDING' | 'APPROVED';
  approvedById?: string;
}): { id: string; serialNo: string } => {
  const serialNo = fixtureTag();
  const approved = o.status === 'APPROVED';
  // qtyIssued NULL, not 0: that is what both create paths store, and every
  // real open request in production has it. A 0 here hid an archive bug.
  const id = sqlValue(
    `INSERT INTO "ComponentRequest" (id, "serialNo", "inventoryItemId", "qtyRequested", "qtyIssued", nature,
                                     "durationValue", "durationUnit", status, "departmentId", "createdById",
                                     "approvedById", "approvedAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), ${lit(serialNo)}, ${lit(o.itemId)}, 2, NULL, 'TEMPORARY',
             7, 'DAYS', ${lit(o.status)}::"RequestStatus", ${lit(o.departmentId)}, ${lit(o.createdById)},
             ${approved && o.approvedById ? lit(o.approvedById) : 'NULL'}, ${approved ? 'now()' : 'NULL'}, now(), now())
     RETURNING id`,
  );
  if (!id) throw new Error('open request fixture was not created');
  madeRequests.push(id);
  return { id, serialNo };
};

/**
 * Remove every fixture this worker made, children first.
 *
 * Most children cascade off Indent and ComponentRequest. Three do not and are
 * removed explicitly: ApprovalHistory and Notification point at an entity id
 * with no foreign key, and InventoryEvent is SET NULL — left alone it would
 * survive as an orphan event the fingerprint guard flags.
 */
export const dropFixtures = () => {
  const list = (ids: string[]) => ids.map((i) => lit(i)).join(', ');
  const reqs = madeRequests.splice(0);
  if (reqs.length) {
    sql(`DELETE FROM "InventoryEvent" WHERE "componentRequestId" IN (${list(reqs)})`);
    sql(`DELETE FROM "Notification" WHERE "relatedEntityId" IN (${list(reqs)})`);
    sql(`DELETE FROM "ApprovalHistory" WHERE "entityId" IN (${list(reqs)})`);
    sql(`DELETE FROM "ComponentRequest" WHERE id IN (${list(reqs)})`);
  }
  const items = madeItems.splice(0);
  if (items.length) {
    sql(`DELETE FROM "InventoryEvent" WHERE "inventoryItemId" IN (${list(items)})`);
    sql(`DELETE FROM "InventoryItem" WHERE id IN (${list(items)})`);
  }
  const indents = madeIndents.splice(0);
  if (indents.length) {
    sql(`DELETE FROM "Notification" WHERE "relatedEntityId" IN (${list(indents)})`);
    sql(`DELETE FROM "ApprovalHistory" WHERE "entityId" IN (${list(indents)})`);
    sql(`DELETE FROM "Indent" WHERE id IN (${list(indents)})`);
  }
};
