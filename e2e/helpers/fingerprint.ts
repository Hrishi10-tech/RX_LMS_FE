import { execFileSync } from 'node:child_process';

/**
 * A content hash of every business table, so "the suite leaves no trace" can
 * be checked rather than asserted.
 *
 * UI-SANDBOX.md sells this as the regression signal for the suite: "two
 * consecutive runs leave the database byte-identical". It was being verified
 * by comparing ROW COUNTS, which is a strictly weaker claim and silently
 * misses the most common kind of pollution: a row whose VALUES changed.
 * A spec that flips `Department.indentApprovalMode` and forgets to put it
 * back, or settles an indent and restores every column but one, passes a
 * count check every time.
 *
 * So: md5 over every row of every table, ordered by the row's own text so the
 * hash does not depend on physical row order (which VACUUM and plain UPDATEs
 * both change without changing the data).
 */
const CONTAINER = 'lms-ui-db';
const DATABASE = 'lms_ui_lab';
const DB_USER = 'user';

const FORBIDDEN = ['lab-management-db', 'lab_management_restructure'];

/**
 * Tables whose churn is the suite doing its job, not pollution.
 *
 * Every spec signs in, and signing in mints and revokes tokens. Excluding
 * these is not a loophole — it is the difference between "the suite changed
 * business data" and "the suite logged in", and only the first is a bug.
 * `Subscription` is deliberately NOT here: despite the name it is a business
 * model (vendor subscriptions), and a spec leaving one behind is exactly what
 * this should catch.
 */
export const CHURN_TABLES = new Set([
  '_prisma_migrations',
  'RevokedToken',        // one row per sign-out, by design
  'PasswordResetToken',  // the reset specs mint these
  'PushSubscription',    // the desktop-alerts toggle subscribes/unsubscribes
]);

// scripts/test-on-prod-backup.py only. On production data the app's own
// every-minute overdue check writes real Notification rows while the suite
// runs, so that run tolerates the table and the script prints what was added
// instead — a human reads it rather than the guard failing on cron output.
for (const t of (process.env.E2E_EXTRA_CHURN_TABLES ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
  CHURN_TABLES.add(t);
}

/**
 * Columns skipped everywhere they appear.
 *
 * `updatedAt` is derived, and signing in bumps it on the User row without
 * changing anything anyone cares about — which made a clean run look dirty.
 * `lastSeen` is presence tracking, written on request, so it moves whenever
 * anyone — or any test — so much as loads a page. `isOnline` and `lastReadAt`
 * are the same kind of thing: who has a socket open and how far they have
 * read. All four are state the app rewrites constantly on its own; none of
 * them is data a spec could corrupt without also changing something real.
 * Skipping it costs almost nothing: a spec that genuinely modifies a row also
 * changes the column it modified, and that still moves the hash. The only
 * thing now invisible is a write that changed *nothing else*, which is a
 * no-op by definition.
 */
const CHURN_COLUMNS = new Set(['updatedAt', 'lastSeen', 'isOnline', 'lastReadAt']);

/**
 * Columns one specific table rewrites on a timer, not because of a test.
 *
 * The hourly off-site backup stamps BackupConfig with when it last ran and how
 * it went. A run that straddles the top of the hour saw that as "the suite
 * changed BackupConfig" — a real write, but the cron's, not a spec's. Only the
 * run-status columns are skipped; the settings themselves (destinations, on/off
 * switches) are still checked.
 */
const TABLE_CHURN_COLUMNS: Record<string, (col: string) => boolean> = {
  BackupConfig: (col) => /^(s3|github)?(Last|last)(Backup|Attempt|Succeeded|Result|Alert)/.test(col),
};

const assertSandbox = () => {
  for (const name of FORBIDDEN) {
    if (CONTAINER.includes(name) || DATABASE.includes(name)) {
      throw new Error(`fingerprint.ts is pointed at the REAL stack (${name}). Refusing to run.`);
    }
  }
};

const psql = (statement: string): string => {
  assertSandbox();
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'psql', '-U', DB_USER, '-d', DATABASE,
     '-t', '-A', '-F', '\t', '-c', statement],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
};

export type Fingerprint = Record<string, { hash: string; rows: number }>;

/**
 * One md5 + row count per table.
 *
 * `t::text` renders the whole row, so every column is covered without naming
 * any of them — no maintenance when a migration adds one, and no way for a
 * new column to quietly fall outside the check. Ordering by that same text
 * makes the hash independent of row order.
 */
export const fingerprintDatabase = (): Fingerprint => {
  const tables = psql(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`,
  )
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !CHURN_TABLES.has(l));

  // Column lists, so CHURN_COLUMNS can be left out of the row text. `t::text`
  // would be simpler but takes every column, including the derived ones.
  const columns = new Map<string, string[]>();
  for (const line of psql(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
  ).split('\n')) {
    if (!line.trim()) continue;
    const [tbl, col] = line.split('\t');
    if (!tbl || !col || CHURN_COLUMNS.has(col) || TABLE_CHURN_COLUMNS[tbl]?.(col)) continue;
    if (!columns.has(tbl)) columns.set(tbl, []);
    columns.get(tbl)!.push(col);
  }

  // One statement for all of them: a docker exec per table turned a check
  // into a visible pause at the end of every run.
  const union = tables
    .map((t) => {
      const cols = columns.get(t) ?? [];
      // ROW(...)::text over the surviving columns. A table with nothing left
      // is counted but not hashed, rather than producing invalid SQL.
      const rowText = cols.length > 0
        ? `ROW(${cols.map((c) => `t."${c}"`).join(', ')})::text`
        : `''`;
      return (
        `SELECT '${t}' AS tbl, count(*) AS n, ` +
        `coalesce(md5(string_agg(x.row_text, '' ORDER BY x.row_text)), '') AS h ` +
        `FROM (SELECT ${rowText} AS row_text FROM "${t}" t) x`
      );
    })
    .join(' UNION ALL ');

  const out: Fingerprint = {};
  for (const line of psql(union).split('\n')) {
    if (!line.trim()) continue;
    const [tbl, n, h] = line.split('\t');
    out[tbl!] = { hash: h ?? '', rows: Number(n) };
  }
  return out;
};

/** Human-readable differences between two fingerprints. */
export const diffFingerprints = (before: Fingerprint, after: Fingerprint): string[] => {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: string[] = [];
  for (const name of [...names].sort()) {
    const b = before[name];
    const a = after[name];
    if (!b) { diffs.push(`${name}: table appeared during the run`); continue; }
    if (!a) { diffs.push(`${name}: table disappeared during the run`); continue; }
    if (b.hash === a.hash) continue;
    diffs.push(
      b.rows === a.rows
        // The case a count check cannot see.
        ? `${name}: ${a.rows} rows before and after, but the CONTENTS changed — a column was left modified`
        : `${name}: ${b.rows} rows -> ${a.rows} rows (${a.rows > b.rows ? '+' : ''}${a.rows - b.rows})`,
    );
  }
  return diffs;
};
