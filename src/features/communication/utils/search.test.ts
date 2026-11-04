import { describe, it, expect } from 'vitest';
import { matchesQuery } from './search';

/**
 * Locks the messaging search predicate (Part C F-series messaging null-crash).
 * The user/starred/message filters run over fields that can be null — a contact
 * with no name, a missed-call row whose `text` is null. The old code called
 * `.toLowerCase()` on the raw field, which threw on null and crashed the panel.
 * This predicate must (a) never throw on null, (b) match case-insensitively,
 * (c) treat an empty/whitespace-free empty query as "match everything".
 */
describe('matchesQuery (messaging null-safety)', () => {
  it('matches case-insensitively', () => {
    expect(matchesQuery('Alice', 'ali')).toBe(true);
    expect(matchesQuery('HELLO world', 'hello')).toBe(true);
  });

  it('returns false when there is no substring match', () => {
    expect(matchesQuery('Alice', 'xyz')).toBe(false);
  });

  it('never throws on a null/undefined value (the crash this fixes)', () => {
    expect(() => matchesQuery(null, 'ali')).not.toThrow();
    expect(matchesQuery(null, 'ali')).toBe(false);
    expect(matchesQuery(undefined, 'ali')).toBe(false);
  });

  it('treats an empty query as "match everything" (show all when not searching)', () => {
    expect(matchesQuery('Alice', '')).toBe(true);
    expect(matchesQuery('Alice', null)).toBe(true);
    expect(matchesQuery(null, '')).toBe(true); // null row still listed when not searching
  });
});
