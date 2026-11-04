import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { FINGERPRINT_FILE } from './helpers/accounts-file';
import { fingerprintDatabase, diffFingerprints, type Fingerprint } from './helpers/fingerprint';

/**
 * Enforce the property UI-SANDBOX.md advertises: a run leaves the database
 * exactly as it found it.
 *
 * This existed only as a claim, re-checked by hand and — as it turned out —
 * re-checked wrongly, by comparing row counts. Counts cannot see a row whose
 * values changed, which is the most common way a spec pollutes: restoring
 * nine columns of ten, or flipping a setting and forgetting to flip it back.
 *
 * A spec cannot check this itself (it would have to run before and after every
 * other spec), so it lives here. Fails the run, loudly, naming the tables.
 */
export default function globalTeardown(): void {
  if (!existsSync(FINGERPRINT_FILE)) return;   // setup didn't get far enough

  let before: Fingerprint;
  try {
    before = JSON.parse(readFileSync(FINGERPRINT_FILE, 'utf8')) as Fingerprint;
  } finally {
    // Never leave a stale baseline behind to be compared against a later run.
    try { unlinkSync(FINGERPRINT_FILE); } catch { /* already gone */ }
  }

  const after = fingerprintDatabase();
  const diffs = diffFingerprints(before, after);
  if (diffs.length === 0) {
    console.log(`\n✓ database unchanged by this run (${Object.keys(after).length} tables content-hashed)`);
    return;
  }

  // Thrown, not logged: a suite that passes while leaving rows behind is how
  // 225 orphans accumulated unnoticed.
  throw new Error(
    `The suite changed ${diffs.length} table(s) and did not put them back:\n  `
      + diffs.join('\n  ')
      + '\n\nEvery spec must restore what it touches (see e2e/helpers/db.ts). '
      + 'If a table legitimately churns on every run — tokens minted by signing in, say — '
      + 'add it to CHURN_TABLES in e2e/helpers/fingerprint.ts with a reason.'
      + '\n\nOne false positive to rule out first: the app\'s own cron jobs write while '
      + 'the suite runs. OverdueCheckerService fires EVERY MINUTE and the off-site backup '
      + 'hourly, so a `Notification` or `IndentStatusLog` row that appears mid-run may be '
      + 'the application doing its job rather than a spec failing to tidy up. Check the '
      + 'row\'s content before hunting for the spec that left it.',
  );
}
