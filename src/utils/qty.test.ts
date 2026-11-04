import { describe, it, expect } from 'vitest';
import { resolveIssuedQty } from './qty';

/**
 * Locks the issued-qty resolver (Part C F6). A request row prefers `qtyIssued`
 * (what was actually handed over) and falls back to `qtyRequested` ONLY when
 * issued is null/undefined. The bug was `qtyIssued || qtyRequested`: a genuine
 * issued-zero is falsy, so it silently showed the requested qty — hiding that
 * nothing was issued. `??` keeps an explicit 0 as 0.
 */
describe('resolveIssuedQty (F6)', () => {
  it('prefers a present qtyIssued over qtyRequested', () => {
    expect(resolveIssuedQty({ qtyIssued: 3, qtyRequested: 5 })).toBe(3);
  });

  it('treats an explicit issued-0 as 0 (the exact F6 regression guard)', () => {
    // `|| ` would have returned 5 here; `??` must return 0.
    expect(resolveIssuedQty({ qtyIssued: 0, qtyRequested: 5 })).toBe(0);
  });

  it('falls back to qtyRequested when qtyIssued is null/undefined/absent', () => {
    expect(resolveIssuedQty({ qtyIssued: null, qtyRequested: 5 })).toBe(5);
    expect(resolveIssuedQty({ qtyIssued: undefined, qtyRequested: 5 })).toBe(5);
    expect(resolveIssuedQty({ qtyRequested: 5 })).toBe(5);
  });

  it('falls back to 0 when neither qty is present', () => {
    expect(resolveIssuedQty({ qtyIssued: null, qtyRequested: null })).toBe(0);
    expect(resolveIssuedQty({})).toBe(0);
  });

  it('is null/undefined-row safe', () => {
    expect(resolveIssuedQty(null)).toBe(0);
    expect(resolveIssuedQty(undefined)).toBe(0);
  });
});
