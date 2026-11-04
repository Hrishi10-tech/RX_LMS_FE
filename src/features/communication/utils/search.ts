/**
 * Case-insensitive substring match for the messaging search filters.
 *
 * Why this exists: the user/starred/message search lists filter on fields that
 * can legitimately be null — a contact with no display name, a missed-call row
 * whose `text` is null. Calling `.toLowerCase()` on those directly throws and
 * crashes the whole panel (the F-series messaging null-crash). This coalesces
 * the value to '' first, so a null field simply never matches (and an empty
 * query matches everything, preserving "show all when not searching").
 */
export const matchesQuery = (
  value: string | null | undefined,
  query: string | null | undefined,
): boolean => (value ?? '').toLowerCase().includes((query ?? '').toLowerCase());
