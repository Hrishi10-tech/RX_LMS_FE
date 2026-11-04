import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The screenshot capture pass — deliberately NOT part of `npm run test:e2e`.
 *
 * These "tests" assert nothing; they drive the app and write PNGs. Left under
 * the default testMatch they inflated the suite from 11 tests to 19, which
 * makes a green run look like more coverage than it is. So the capture file is
 * named `.capture.ts` — outside the suite's spec-only testMatch — and reached
 * only through this config:
 *
 *   npm run test:shots
 *
 * Everything else — no webServer, one worker, the sandbox baseURL — is
 * inherited, because the captures need exactly the same running stack as the
 * real specs.
 */
export default defineConfig({
  ...base,
  testMatch: '**/screens.capture.ts',
  // A failed capture is a broken screen, not a flake; don't paper over it.
  retries: 0,
  // The suite's `screenshot: 'only-on-failure'` would drop an extra PNG beside
  // the intended ones on failure. Here the spec owns every file it writes.
  use: { ...base.use, screenshot: 'off' },
});
