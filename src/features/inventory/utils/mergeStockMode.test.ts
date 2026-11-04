import { describe, it, expect } from 'vitest';
import { defaultStockMode, detectPhantomDuplicates } from './mergeStockMode';

/**
 * The case that actually happened is the first one below. Everything else is
 * there to make sure catching it did not make the check fire on merges that
 * genuinely should sum.
 */
describe('detectPhantomDuplicates', () => {
  it('catches a sheet imported more than once — no receives, identical stock', () => {
    const rows = Array.from({ length: 14 }, () => ({ stock: 300, totalReceived: 0 }));
    const signal = detectPhantomDuplicates(rows);
    expect(signal.suspected).toBe(true);
    expect(signal.suspected && signal.reason).toBe('never-received');
    expect(signal.suspected && signal.detail).toMatch(/imported more than once/i);
  });

  // The regression this whole file exists for. The old check was
  // `allSameReceived && totalReceived > 0`, which skipped every bulk-uploaded
  // row — the exact rows that then got summed into a 14x stock figure.
  it('does not go quiet just because nothing was ever received', () => {
    const rows = [
      { stock: 300, totalReceived: 0 },
      { stock: 300, totalReceived: 0 },
    ];
    expect(detectPhantomDuplicates(rows).suspected).toBe(true);
    expect(defaultStockMode(rows)).toBe('keep');
  });

  it('still catches the original double-receive fingerprint', () => {
    const rows = [
      { stock: 50, totalReceived: 120 },
      { stock: 70, totalReceived: 120 },
    ];
    const signal = detectPhantomDuplicates(rows);
    expect(signal.suspected).toBe(true);
    expect(signal.suspected && signal.reason).toBe('same-receive');
  });

  describe('leaves genuine separate batches alone', () => {
    it('different receive histories are different batches', () => {
      const rows = [
        { stock: 10, totalReceived: 10 },
        { stock: 25, totalReceived: 40 },
      ];
      expect(detectPhantomDuplicates(rows).suspected).toBe(false);
      expect(defaultStockMode(rows)).toBe('sum');
    });

    // Both never received, but holding different amounts — two people each
    // typed in what was on their own shelf. Summing is right.
    it('never-received rows with different stock are not phantoms', () => {
      const rows = [
        { stock: 10, totalReceived: 0 },
        { stock: 25, totalReceived: 0 },
      ];
      expect(detectPhantomDuplicates(rows).suspected).toBe(false);
      expect(defaultStockMode(rows)).toBe('sum');
    });

    it('says nothing about a single row', () => {
      expect(detectPhantomDuplicates([{ stock: 5, totalReceived: 0 }]).suspected).toBe(false);
      expect(detectPhantomDuplicates([]).suspected).toBe(false);
    });
  });

  it('treats missing and zero alike, rather than counting undefined as a value', () => {
    const rows = [{ stock: 12 }, { stock: 12, totalReceived: null }];
    expect(detectPhantomDuplicates(rows).suspected).toBe(true);
  });

  // Zero stock everywhere is still one pile recorded twice — it is just an
  // empty one. Summing nothing does no harm, but the fingerprint is real and
  // the operator should still be told what they are looking at.
  it('recognises the fingerprint even when the stock is zero', () => {
    const rows = [{ stock: 0, totalReceived: 0 }, { stock: 0, totalReceived: 0 }];
    expect(detectPhantomDuplicates(rows).suspected).toBe(true);
  });
});
