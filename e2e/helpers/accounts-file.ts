import { join } from 'node:path';

/**
 * Where the resolved accounts live. Relative to the working directory rather
 * than the module: this package is ESM, so there is no `__dirname`, and
 * Playwright always runs from the frontend root.
 */
export const ACCOUNTS_FILE = join(process.cwd(), 'e2e', '.accounts.json');

/**
 * Where globalSetup parks the pre-run content hash for globalTeardown to
 * compare against. Same reasoning as above for the path; deleted by the
 * teardown so a stale baseline can never be compared with a later run.
 */
export const FINGERPRINT_FILE = join(process.cwd(), 'e2e', '.db-fingerprint.json');
