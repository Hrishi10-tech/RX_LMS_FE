import { describe, it, expect } from 'vitest';
import { rollupTotals, roundToPaisa } from './thresholds';

/**
 * This file is a DUPLICATE of backend/src/common/config/thresholds.ts, on
 * purpose: the quote modal shows a grand total before anything is saved, and
 * it has to be the number the backend will persist.
 *
 * Nothing enforces that the two copies agree, so these cases are the same
 * ones asserted in backend/src/common/config/rollup-totals.spec.ts, with the
 * same expected values. If either side is changed alone, one suite goes red.
 *
 * The values are not arbitrary — each was a real mismatch found by creating
 * indents against the database and comparing the stored line sum to the
 * stored grand total:
 *   three lines of 0.335   stored 1.02, the rollup claimed 1.01
 *   3 x 33.333 + 7 x 1.015 stored 107.11, claimed 107.10
 *   two lines of 1.005     stored 2.02, claimed 2.00
 */
describe('money rounding matches the backend (and the database)', () => {
  it('rounds the exact half away from zero, as Postgres does', () => {
    expect(roundToPaisa(1.005)).toBe(1.01);
    expect(roundToPaisa(-1.005)).toBe(-1.01);
    expect(roundToPaisa(2.005)).toBe(2.01);
  });

  it('leaves everything else where it was', () => {
    expect(roundToPaisa(1.014)).toBe(1.01);
    expect(roundToPaisa(1.015)).toBe(1.02);
    expect(roundToPaisa(33.333)).toBe(33.33);
    expect(roundToPaisa(0.1)).toBe(0.1);
    expect(roundToPaisa(999999.99)).toBe(999999.99);
    expect(roundToPaisa(0)).toBe(0);
  });

  it('a total equals the sum of its lines, rounded as stored', () => {
    expect(rollupTotals([
      { qty: 1, unitAmount: 0.335 }, { qty: 1, unitAmount: 0.335 }, { qty: 1, unitAmount: 0.335 },
    ]).grandTotal).toBe(1.02);

    expect(rollupTotals([
      { qty: 3, unitAmount: 33.333 }, { qty: 7, unitAmount: 1.015 },
    ]).grandTotal).toBe(107.11);

    expect(rollupTotals([
      { total: 1.005 } as never, { total: 1.005 } as never,
    ]).grandTotal).toBe(2.02);
  });

  it('the ordinary cases are unchanged', () => {
    expect(rollupTotals([{ qty: 1, unitAmount: 0.1 }, { qty: 1, unitAmount: 0.2 }]).grandTotal).toBe(0.3);
    expect(rollupTotals([{ qty: 7, unitAmount: 1.11 }, { qty: 13, unitAmount: 2.22 }]).grandTotal).toBe(36.63);
    expect(rollupTotals([]).grandTotal).toBe(0);
  });
});
