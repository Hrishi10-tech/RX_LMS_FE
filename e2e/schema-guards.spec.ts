import { test, expect } from '@playwright/test';
import { sql } from './helpers/db';

/**
 * The partial unique indexes exist, and keep existing.
 *
 * This is a regression test for a real incident, and for the shape of it as
 * much as the instance. `20260525130703_bom_lists_feedback_quotations_backup_config`
 * — an auto-generated migration about BOM lists — carried three unrelated
 * statements:
 *
 *     DROP INDEX "ComponentRequest_serialNo_key";
 *     DROP INDEX "Indent_serialNo_key";
 *     DROP INDEX "User_email_key";
 *
 * `@unique` had been taken off those fields so uniqueness could be narrowed to
 * live rows; Prisma emitted the DROPs; the partial indexes meant to replace
 * them were never written. Nothing failed, no test went red, and for five
 * months the only thing preventing duplicate indent serials was the advisory
 * lock in generateSerial — whose failure is swallowed by a bare `catch {}`.
 * Six simultaneous POST /users with one address created six accounts.
 *
 * Prisma cannot express a partial index, so `prisma migrate dev` will keep
 * offering to drop these. That offer is how it happened the first time. This
 * spec is the thing that notices.
 */

type IndexCheck = {
  index: string;
  table: string;
  /** Fragments that must appear in the index definition, quotes stripped. */
  expects: string[];
  why: string;
};

const REQUIRED: IndexCheck[] = [
  {
    index: 'User_email_live_key',
    table: 'User',
    // lower(btrim(email)) because that is how auth.service identifies someone
    // at sign-in (`mode: 'insensitive'`). A case-sensitive index would let
    // Foo@x.com and foo@x.com coexist and both answer the same login.
    expects: ['UNIQUE', 'lower(btrim(email))', 'deletedAt IS NULL'],
    why: 'two live accounts could share one email, and login picks between them by row order',
  },
  {
    index: 'Indent_serialNo_live_key',
    table: 'Indent',
    expects: ['UNIQUE', 'serialNo', 'deletedAt IS NULL'],
    why: 'duplicate IND-xxx serials become possible whenever the advisory lock does not take',
  },
  {
    index: 'ComponentRequest_serialNo_live_key',
    table: 'ComponentRequest',
    expects: ['UNIQUE', 'serialNo', 'deletedAt IS NULL'],
    why: 'duplicate REQ-xxx serials',
  },
  {
    index: 'BomList_serialNo_live_key',
    table: 'BomList',
    expects: ['UNIQUE', 'serialNo', 'deletedAt IS NULL'],
    why: 'duplicate BOM-xxx serials',
  },
];

test.describe('schema guards', () => {
  for (const check of REQUIRED) {
    test(`${check.index} exists on ${check.table}`, () => {
      const [row] = sql(
        `SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = '${check.table}'
            AND indexname = '${check.index}'`,
      );
      expect(
        row,
        `${check.index} is missing. Without it, ${check.why}. `
          + 'If a Prisma migration offered to drop it, that offer was wrong — see '
          + '20261016120000_restore_dropped_unique_indexes.',
      ).toBeTruthy();

      // Postgres renders identifiers quoted — `WHERE ("deletedAt" IS NULL)` —
      // and the quoting is its choice, not the rule. Strip it so this asserts
      // the rule rather than the formatting.
      const def = row![0]!.replace(/"/g, '');
      for (const fragment of check.expects) {
        expect(def, `${check.index} exists but no longer matches its intended rule`).toContain(fragment);
      }
    });
  }

  /**
   * The index is the floor; this asserts the floor actually holds, rather than
   * trusting that a definition string implies enforcement.
   */
  test('the database itself refuses a duplicate live email', () => {
    const victim = sql(`SELECT id, email FROM "User" WHERE "deletedAt" IS NULL LIMIT 1`)[0];
    expect(victim, 'no live user to test against').toBeTruthy();
    const email = victim![1]!;

    let rejected = false;
    try {
      // Upper-cased on purpose: the index keys on lower(btrim(email)), so this
      // also proves a case variant cannot slip past it.
      sql(
        `INSERT INTO "User" (id, email, password, name, role, "isActive", "createdAt", "updatedAt")
         VALUES ('schema-guard-probe', upper('${email}'), 'x', 'Schema Guard Probe', 'USER', true, now(), now())`,
      );
    } catch {
      rejected = true;
    }
    // Clean up in case a future change lets it through — the assertion below
    // reports the failure, this keeps it from poisoning the next run.
    sql(`DELETE FROM "User" WHERE id = 'schema-guard-probe'`);

    expect(
      rejected,
      'the database accepted a second live user with an existing email (differing only in case)',
    ).toBe(true);
  });
});
