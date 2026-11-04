import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the UI sandbox.
 *
 * PRECONDITION: the Docker stack must already be up —
 *   cd ~/Desktop/lms-ui-lab && docker compose up -d
 *
 * There is deliberately no `webServer` block. The app under test is a static
 * bundle served by nginx with a NestJS backend and Postgres behind it; a Vite
 * dev server would be a *different* build talking to a different API base, so
 * spinning one up here would test something the user never runs. The trade-off
 * is that a code change needs a rebuild before these tests see it:
 *   docker compose build frontend && docker compose up -d --no-deps --force-recreate frontend
 *
 * Several specs read and write Postgres directly (see e2e/helpers/db.ts) to set
 * up preconditions the UI cannot reach and to restore state afterwards. That is
 * safe *only* because this is the sandbox: its database is a disposable
 * snapshot on its own volume. Never point these at the real stack.
 */
export default defineConfig({
  testDir: './e2e',
  // Resolves one signable-in account per role before anything runs — the
  // accounts differ between a seeded database and restored demo data, and
  // in the latter only some of them have the local password.
  globalSetup: './e2e/global-setup.ts',
  // Content-hashes every business table after the run and fails if anything
  // moved. UI-SANDBOX.md advertises that a run leaves the database untouched;
  // until this existed that was checked by hand, by comparing row counts,
  // which cannot see a row whose values changed.
  globalTeardown: './e2e/global-teardown.ts',
  // Vitest owns src/**; Playwright owns e2e/**. They don't overlap.
  testMatch: '**/*.spec.ts',

  // These specs mutate shared rows in one shared database, so they cannot run
  // in parallel — two workers marking the same indent paid would race.
  fullyParallel: false,
  workers: 1,

  // A flaky retry would hide a real race here, and every spec restores its own
  // state in teardown, so a rerun of a half-finished test starts from a dirty
  // fixture. Fail loudly instead.
  retries: 0,

  reporter: [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: 'http://localhost:5174',
    // The stack is local; these are generous because the first hit on a route
    // also downloads its lazy chunk.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  // Chromium by default; `E2E_ALL_BROWSERS=1` adds the other two engines.
  //
  // Not on by default because these specs are serialised (workers: 1, shared
  // database) so each extra engine is another full pass in wall-clock, and
  // most changes here are logic rather than rendering. But Chromium alone was
  // the whole of this suite's coverage while the people using the app are on
  // Macs and iPhones — i.e. WebKit — so the other engines need to be one
  // command away, not a config rewrite.
  //
  //   E2E_ALL_BROWSERS=1 npx playwright test
  //   npx playwright test --project=webkit
  projects: [
    // The phone-shaped specs belong to the `iphone` project; running them
    // under a desktop project adds noise rather than coverage.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] }, testIgnore: /mobile\.spec\.ts/ },
    ...(process.env.E2E_ALL_BROWSERS
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] }, testIgnore: /mobile\.spec\.ts/ },
          { name: 'webkit', use: { ...devices['Desktop Safari'] }, testIgnore: /mobile\.spec\.ts/ },
          // Real WebKit at phone size, with touch. Not a real handset — the
          // iOS Simulator needs a full Xcode install, which this machine does
          // not have — but it is the same engine Safari runs, which is what
          // catches layout and engine differences rather than hardware ones.
          // Only the phone-shaped specs. Pointing this at the whole suite
          // was tried: 31 of 92 failed on a navigation drawer that is closed
          // by design at this width, which tells you about the tests rather
          // than the app.
          { name: 'iphone', use: { ...devices['iPhone 13'] }, testMatch: /mobile\.spec\.ts/ },
        ]
      : []),
  ],
});
