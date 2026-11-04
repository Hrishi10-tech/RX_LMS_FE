import { describe, it, expect } from 'vitest';
import { csvTextCell } from './csv';

describe('csvTextCell', () => {
  it('quotes plain text and doubles embedded quotes', () => {
    expect(csvTextCell('Bench "A", shelf 2')).toBe('"Bench ""A"", shelf 2"');
  });

  it('neutralises text a spreadsheet would run as a formula', () => {
    expect(csvTextCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    for (const lead of ['+', '-', '@', '\t', '\r']) {
      expect(csvTextCell(`${lead}cmd`)).toBe(`"'${lead}cmd"`);
    }
  });

  it('renders null and undefined as an empty cell', () => {
    expect(csvTextCell(null)).toBe('""');
    expect(csvTextCell(undefined)).toBe('""');
  });
});
