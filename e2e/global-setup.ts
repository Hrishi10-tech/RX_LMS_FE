import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNTS_FILE, FINGERPRINT_FILE } from './helpers/accounts-file';
import { fingerprintDatabase } from './helpers/fingerprint';

/**
 * Resolve one usable account per role, before any test runs.
 *
 * Two problems make this necessary, and neither is solvable by hard-coding.
 *
 * 1. The accounts differ by dataset. This sandbox holds restored demo data
 *    with @rhythmrx.ai users; `prisma db seed`, which is all a fresh CI
 *    database gets, creates entirely different @example.com ones. A suite
 *    pinned to either set passes in exactly one of the two worlds.
 *
 * 2. In restored data, only SOME accounts have the local password. A restore
 *    brings back the password hashes that were in the snapshot, so picking,
 *    say, the alphabetically first USER lands on a real person's hash and
 *    every sign-in times out at the login screen.
 *
 * So rather than guess, this asks: for each role, which account can actually
 * log in? The first that authenticates wins. Nothing is mutated — no
 * passwords are reset and no users are created — and the result is written
 * where the sync helpers can read it.
 *
 * Each candidate is tried at most once. The server locks an account after ten
 * failed attempts, so a single miss per candidate is well clear of it.
 */
const CONTAINER = 'lms-ui-db';
const DATABASE = 'lms_ui_lab';
const API = process.env.E2E_API_BASE ?? 'http://localhost:3001/api';
const PASSWORD = 'password123';

/** How many candidates to try per role before giving up. */
const MAX_CANDIDATES = 6;

const ROLES = {
  user: 'USER',
  manager: 'MANAGER',
  admin: 'ADMIN',
  procurement: 'PROCUREMENT',
  finance: 'FINANCE',
  inventory: 'INVENTORY',
  associateFinance: 'ASSOCIATE_FINANCE',
  superAdmin: 'SUPER_ADMIN',
} as const;

const candidates = (role: string): string[] =>
  execFileSync('docker', [
    'exec', '-i', CONTAINER, 'psql', '-U', 'user', '-d', DATABASE, '-t', '-A', '-c',
    `SELECT email FROM "User"
      WHERE role = '${role}' AND "isActive" IS NOT FALSE AND "deletedAt" IS NULL
      ORDER BY email LIMIT ${MAX_CANDIDATES}`,
  ], { encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);

const canSignIn = async (email: string): Promise<boolean> => {
  try {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    return res.ok;
  } catch {
    return false;
  }
};

export default async function globalSetup() {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];

  for (const [key, role] of Object.entries(ROLES)) {
    let found = '';
    for (const email of candidates(role)) {
      if (await canSignIn(email)) { found = email; break; }
    }
    if (found) resolved[key] = found;
    else { resolved[key] = ''; missing.push(role); }
  }

  writeFileSync(ACCOUNTS_FILE, JSON.stringify(resolved, null, 2));

  if (missing.length) {
    // A warning, not a throw: a suite that cannot sign in as FINANCE should
    // still run and fail the finance tests with a clear message, rather than
    // refusing to start and saying nothing about the other fifty.
    console.warn(
      `[e2e] no account with the local password for: ${missing.join(', ')}. ` +
      `Seed the database (npm run seed) or run scripts/reset-demo-logins.sql.`,
    );
  }
  console.log('[e2e] accounts:', Object.entries(resolved).map(([k, v]) => `${k}=${v || '—'}`).join(' '));

  // Baseline for globalTeardown. Captured AFTER account resolution so the
  // sign-in attempts above — which mint and revoke tokens — are already
  // reflected, and last so a setup failure never leaves a baseline that a
  // later run would be compared against.
  const fp = fingerprintDatabase();
  writeFileSync(FINGERPRINT_FILE, JSON.stringify(fp));
  console.log(`[e2e] fingerprinted ${Object.keys(fp).length} tables; the run must leave them unchanged`);
}
