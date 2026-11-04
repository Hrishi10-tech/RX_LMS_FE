import { describe, expect, it } from 'vitest';
import { normalizeQtyInput } from './normalizeQtyInput';

describe('normalizeQtyInput', () => {
  it('drops the zero left in front when you type into a field reading 0', () => {
    expect(normalizeQtyInput('050')).toBe('50');
    expect(normalizeQtyInput('007')).toBe('7');
    expect(normalizeQtyInput('0100')).toBe('100');
  });

  it('keeps a real zero, which is what releases the stock', () => {
    expect(normalizeQtyInput('0')).toBe('0');
    expect(normalizeQtyInput('00')).toBe('0');
  });

  it('leaves the zero before a decimal point alone', () => {
    expect(normalizeQtyInput('0.5')).toBe('0.5');
    expect(normalizeQtyInput('0.25')).toBe('0.25');
    expect(normalizeQtyInput('00.5')).toBe('0.5');
  });

  it('does not eat a half-typed number', () => {
    // Running String(Number(v)) here would delete the point the instant it is
    // typed, making a decimal impossible to enter.
    expect(normalizeQtyInput('5.')).toBe('5.');
    expect(normalizeQtyInput('.')).toBe('.');
  });

  it('removes surrounding spaces', () => {
    expect(normalizeQtyInput(' 50 ')).toBe('50');
    expect(normalizeQtyInput('  050')).toBe('50');
  });

  it('leaves an emptied box empty so it can be retyped', () => {
    expect(normalizeQtyInput('')).toBe('');
    expect(normalizeQtyInput('   ')).toBe('');
  });
});
