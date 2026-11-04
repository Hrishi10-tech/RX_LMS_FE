import { describe, it, expect } from 'vitest';
import { durationUnitLabel, DURATION_UNITS } from './duration';

describe('durationUnitLabel', () => {
  it('is singular at exactly 1 and plural otherwise', () => {
    expect(durationUnitLabel('MONTHS', 1)).toBe('month');
    expect(durationUnitLabel('MONTHS', 2)).toBe('months');
    expect(durationUnitLabel('MINUTES', 1)).toBe('minute');
    expect(durationUnitLabel('DAYS', 0)).toBe('days');
  });

  it('handles every unit the API accepts', () => {
    expect(DURATION_UNITS.map((u) => durationUnitLabel(u, 1)))
      .toEqual(['minute', 'hour', 'day', 'week', 'month']);
    expect(DURATION_UNITS.map((u) => durationUnitLabel(u, 3)))
      .toEqual(['minutes', 'hours', 'days', 'weeks', 'months']);
  });

  it('capitalises on request, for the forms that use Title Case', () => {
    expect(durationUnitLabel('WEEKS', 1, { capitalise: true })).toBe('Week');
    expect(durationUnitLabel('WEEKS', 4, { capitalise: true })).toBe('Weeks');
  });

  it('copes with a typed value arriving as a string', () => {
    expect(durationUnitLabel('DAYS', '1' as unknown as number)).toBe('day');
  });
});
