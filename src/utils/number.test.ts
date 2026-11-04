import { describe, it, expect } from 'vitest';
import { fmtInt, fmtINR } from './number';

/**
 * Locks the dashboard number-guard util (Part C P1). Four dashboards
 * (SuperAdmin / Procurement / Inventory / Finance) render KPI cards straight
 * from a stats payload that can be partial or empty. Before the fix they did
 * `Math.round(stats.x).toLocaleString()` directly, so a missing field printed
 * the literal "NaN" — and a divide-by-zero (received/total with total=0)
 * printed "Infinity". These helpers must always degrade to a clean fallback.
 *
 * Grouping separators are locale-dependent, so digit assertions strip all
 * non-digits rather than hard-coding "1,235".
 */
const digits = (s: string) => s.replace(/[^0-9]/g, '');

describe('fmtInt (dashboard count guard)', () => {
  it('formats a finite number (rounded)', () => {
    expect(fmtInt(42)).toBe('42');
    expect(digits(fmtInt(1234.6))).toBe('1235'); // rounds; locale-tolerant
  });

  it('reads a genuine zero as "0"', () => {
    expect(fmtInt(0)).toBe('0');
  });

  it('falls back to "0" for nullish / NaN (a missing stat field)', () => {
    expect(fmtInt(undefined)).toBe('0');
    expect(fmtInt(NaN)).toBe('0');
    expect(fmtInt('not-a-number')).toBe('0');
  });

  it('falls back to "0" for Infinity (the divide-by-zero KPI case)', () => {
    // e.g. received / total when total is 0 → Infinity → must not render "Infinity".
    const total = 0;
    expect(fmtInt(500 / total)).toBe('0');
  });

  it('honours a custom fallback', () => {
    expect(fmtInt(undefined, '-')).toBe('-');
  });

  it('never returns the literal "NaN"/"Infinity"', () => {
    for (const v of [undefined, null, NaN, Infinity, -Infinity, 'x']) {
      const out = fmtInt(v);
      expect(out).not.toContain('NaN');
      expect(out).not.toContain('Infinity');
    }
  });
});

describe('fmtINR (dashboard currency guard)', () => {
  it('formats a finite amount with the ₹ symbol', () => {
    const out = fmtINR(1000);
    expect(out.startsWith('₹')).toBe(true);
    expect(digits(out)).toBe('1000');
  });

  it('renders zero as "₹0"', () => {
    expect(fmtINR(0)).toBe('₹0');
  });

  it('renders nullish as the "no data" placeholder (default "-")', () => {
    expect(fmtINR(null)).toBe('-');
    expect(fmtINR(undefined)).toBe('-');
  });

  it('honours a custom nullish placeholder (dashboards pass "₹0")', () => {
    expect(fmtINR(null, { nullish: '₹0' })).toBe('₹0');
  });

  it('renders non-finite amounts as "₹0" (never "₹NaN")', () => {
    expect(fmtINR(NaN)).toBe('₹0');
    expect(fmtINR('abc')).toBe('₹0');
    expect(fmtINR(Infinity)).toBe('₹0');
  });

  it('compact notation still produces a ₹ string, never "NaN"', () => {
    const out = fmtINR(100000, { compact: true });
    expect(out.startsWith('₹')).toBe(true);
    expect(out).not.toContain('NaN');
  });
});
