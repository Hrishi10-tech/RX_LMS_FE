import { test, expect } from '@playwright/test';
import { signInAs } from './helpers/auth';
import { currentDatabase } from './helpers/db';

/**
 * The sandbox must talk to the sandbox.
 *
 * This is a regression test for a real incident: docker-compose.yml declared
 * VITE_API_BASE_URL under `environment:` instead of `build.args:`. Vite inlines
 * VITE_* vars at BUILD time, so a runtime variable on the nginx container never
 * reached the JavaScript — the bundle silently kept the Dockerfile's default of
 * http://localhost:3000/api and every request from this sandbox went to the
 * REAL backend and the REAL production database. Ports, volumes and database
 * names were all configured correctly; the browser simply never used them.
 *
 * It went unnoticed because the sandbox database is a snapshot of production,
 * so the screens looked exactly right. The only reliable signal is the request
 * origin, which is what this asserts.
 */
test.describe('sandbox isolation', () => {
  test('every API request goes to the sandbox backend, never :3000', async ({ page }) => {
    const origins = new Set<string>();
    page.on('request', (req) => {
      const url = req.url();
      if (url.includes('/api/')) origins.add(new URL(url).origin);
    });

    // Sign in and walk a few data-heavy screens so a good number of endpoints
    // are exercised, not just the auth call.
    await signInAs(page, 'superAdmin');
    for (const path of ['/super-admin', '/super-admin/inventory', '/super-admin/approvals']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }

    expect(origins.size, 'expected API traffic on exactly one origin').toBeGreaterThan(0);
    expect([...origins]).toEqual(['http://localhost:3001']);
    // Stated separately so a failure names the actual hazard.
    expect(
      [...origins].some((o) => o.includes(':3000')),
      'the sandbox UI is talking to the REAL backend on :3000',
    ).toBe(false);
  });

  test('the shipped bundle has the sandbox API base compiled in', async ({ page }) => {
    // Catches the misconfiguration at its source rather than by its symptom:
    // if the build arg is wrong again, the string is wrong in the asset.
    const bundleUrls: string[] = [];
    page.on('response', (res) => {
      const u = res.url();
      if (u.endsWith('.js') && u.includes('/assets/')) bundleUrls.push(u);
    });
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    expect(bundleUrls.length, 'no JS bundle was loaded').toBeGreaterThan(0);

    let sawSandbox = false;
    for (const url of bundleUrls) {
      const body = await (await page.request.get(url)).text();
      if (body.includes('localhost:3001/api')) sawSandbox = true;
      expect(
        body.includes('localhost:3000/api'),
        `${url} was built against the REAL backend (:3000)`,
      ).toBe(false);
    }
    expect(sawSandbox, 'no bundle mentions the sandbox API base').toBe(true);
  });

  test('the fixture helper is attached to the sandbox database', () => {
    // The specs below write to Postgres directly. If that ever points at the
    // real database, the damage is not recoverable — so assert it here, where
    // the failure is loud and nothing has been written yet.
    expect(currentDatabase()).toBe('lms_ui_lab');
  });
});
