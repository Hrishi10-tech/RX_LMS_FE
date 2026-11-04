import { describe, it, expect } from 'vitest';
import { groupUnarchiveRows, sharedArchivedRows, summariseFailures } from './unarchiveRows';

describe('groupUnarchiveRows', () => {
  const rows = [
    { row: 2, stock: 4, archived: { id: 'a' } },
    { row: 5, stock: 6, archived: { id: 'a' } },
    { row: 7, stock: 1, archived: { id: 'b' } },
  ];

  it('sends one unarchive per archived item, with every row\'s quantity added together', () => {
    expect(groupUnarchiveRows(rows, { 2: 'unarchive', 5: 'unarchive', 7: 'unarchive' })).toEqual([
      { id: 'a', addStock: 10, rows: [2, 5] },
      { id: 'b', addStock: 1, rows: [7] },
    ]);
  });

  it('leaves out rows the clerk chose to create new or skip', () => {
    expect(groupUnarchiveRows(rows, { 2: 'unarchive', 5: 'skip', 7: 'new' })).toEqual([
      { id: 'a', addStock: 4, rows: [2] },
    ]);
  });
});

describe('sharedArchivedRows', () => {
  it('points each row at the other rows naming the same archived item', () => {
    const m = sharedArchivedRows([
      { row: 2, stock: 1, archived: { id: 'a' } },
      { row: 5, stock: 1, archived: { id: 'a' } },
      { row: 7, stock: 1, archived: { id: 'b' } },
    ]);
    expect(m.get(2)).toEqual([5]);
    expect(m.get(5)).toEqual([2]);
    expect(m.has(7)).toBe(false);
  });
});

describe('summariseFailures', () => {
  it('shows every failure, and counts the rest past the limit', () => {
    expect(summariseFailures(['a', 'b'])).toBe('a\nb');
    expect(summariseFailures(['1', '2', '3', '4'], 2)).toBe('1\n2\n…and 2 more.');
  });
});
