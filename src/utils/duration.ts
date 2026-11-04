/** Every duration unit the API accepts — mirrors `DurationUnit` in schema.prisma. */
export const DURATION_UNITS = ['MINUTES', 'HOURS', 'DAYS', 'WEEKS', 'MONTHS'] as const;
/**
 * The unit as a person would say it next to a number: "1 day", "2 days".
 *
 * The selectors used to hard-code `<option>s` reading "days / weeks / months",
 * so every request said "return in 1 months". Deriving the word from the value
 * instead means the dropdown reads correctly at 1 and at 2, and the list of
 * units lives in one place rather than being retyped per form — which is how
 * one of them ended up missing minutes and hours while the API accepted both.
 *
 * Every unit here pluralises with a plain -s, so this stays a slice rather than
 * a lookup table. Add an irregular one and it needs a real map.
 */
export const durationUnitLabel = (
  unit: string,
  value: number,
  opts: { capitalise?: boolean } = {},
): string => {
  const singular = unit.toLowerCase().replace(/s$/, '');
  const word = Math.abs(Number(value)) === 1 ? singular : `${singular}s`;
  return opts.capitalise ? word.charAt(0).toUpperCase() + word.slice(1) : word;
};
