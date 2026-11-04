import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * The full-app walkthrough — every screen, both themes, kept as a dated run.
 *
 * Separate from both `test:e2e` (which asserts) and `test:shots` (the small
 * committed baseline) so that none of the three can quietly become the others.
 */
export default defineConfig({
  ...base,
  testMatch: '**/walkthrough.capture.ts',
  retries: 0,
  use: { ...base.use, screenshot: 'off' },
});
