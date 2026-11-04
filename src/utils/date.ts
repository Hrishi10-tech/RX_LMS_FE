// Shared date/time formatters. Use these everywhere so timestamps render
// consistently across the app.

const DATETIME_OPTS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
};

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
};

/**
 * Returns a date-and-time string like "13 Oct 2026, 3:45 PM".
 * Falls back to a dash when the input is null/undefined/invalid.
 */
export const fmtDateTime = (input: string | number | Date | null | undefined, fallback = '-'): string => {
  if (input === null || input === undefined || input === '') return fallback;
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return fallback;
  return d.toLocaleString('en-IN', DATETIME_OPTS);
};

/**
 * Date-only formatter for cases where time would be misleading (e.g. dueDate
 * stored as midnight, or filter-grouping keys where time would over-split).
 */
export const fmtDate = (input: string | number | Date | null | undefined, fallback = '-'): string => {
  if (input === null || input === undefined || input === '') return fallback;
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString('en-IN', DATE_OPTS);
};

/**
 * Locale-independent YYYY-MM-DD key for grouping rows by calendar day (uses
 * 'en-CA', which formats as YYYY-MM-DD). Nullish/empty input → null so callers
 * can skip un-dated rows. Replaces the ~12 identical local `dateKey` copies.
 */
export const dateOnlyKey = (input?: string | number | Date | null): string | null =>
  input ? new Date(input).toLocaleDateString('en-CA') : null;

/**
 * Numeric day: "16-09-2026".
 *
 * The format the tables use where a date sits next to a from/to date picker —
 * the picker renders in the browser's own locale (dd/mm/yyyy here) and cannot
 * be restyled, so "16 Sept 2026" in the rows would not line up with what the
 * filter above them shows. Built off dateOnlyKey so it is the same LOCAL day
 * the filter compares against, not a UTC one.
 */
export const fmtDayNumeric = (input?: string | number | Date | null, fallback = '-'): string => {
  const key = dateOnlyKey(input);
  if (!key) return fallback;
  const [y, m, d] = key.split('-');
  return `${d}-${m}-${y}`;
};

/**
 * Relative "time ago" label for dashboard activity feeds: "5m ago", "3h ago",
 * else the short date. Invalid/empty input → "-". Opts preserve the per-feed
 * variants that existed before consolidation:
 *  - justNow: show "Just now" under a minute (else it rounds to "0m ago")
 *  - days:    show "Nd ago" up to a week (else it jumps straight to the date)
 */
export const fmtRelativeTime = (
  input: string | number | Date | null | undefined,
  opts: { justNow?: boolean; days?: boolean } = {},
): string => {
  if (input === null || input === undefined || input === '') return '-';
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '-';
  const diff = (Date.now() - d.getTime()) / 1000;
  if (opts.justNow && diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (opts.days && diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Smart-unit countdown for a due date relative to now. Picks the coarsest
 * sensible unit so both short (minute/hour) and long (day/week) durations read
 * naturally: "45m left", "3h overdue", "2d left". Recomputed at render from the
 * dueDate — there is NO ticking timer, so it's cheap and re-renders only when
 * the row's data changes. Needed because durations can now be MINUTES/HOURS, so
 * the old day-only `Math.ceil(diff/day)` rendered "0d" (and a negative-zero bug
 * mislabelled just-overdue items as not-overdue).
 *
 * Returns:
 *  - text:      signed + suffixed label, e.g. "45m left" / "3h overdue"
 *  - magnitude: unit only, no sign/suffix, e.g. "45m" / "3h" / "2d" — for
 *               columns whose header already says "Overdue"
 *  - overdue:   the due date is in the past
 *  - dueSoon:   not overdue and within `soonMs` (default 3 days)
 */
export const formatDueDelta = (
  input: string | number | Date | null | undefined,
  soonMs: number = 3 * MS_PER_DAY,
  fallback = '-',
): { text: string; magnitude: string; overdue: boolean; dueSoon: boolean } => {
  const empty = { text: fallback, magnitude: fallback, overdue: false, dueSoon: false };
  if (input === null || input === undefined || input === '') return empty;
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return empty;

  const diffMs = d.getTime() - Date.now();
  const overdue = diffMs < 0;
  const absMs = Math.abs(diffMs);

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  let magnitude: string;
  if (absMs < HOUR) magnitude = `${Math.max(1, Math.round(absMs / MIN))}m`;
  else if (absMs < MS_PER_DAY) magnitude = `${Math.round(absMs / HOUR)}h`;
  else magnitude = `${Math.round(absMs / MS_PER_DAY)}d`;

  return {
    text: overdue ? `${magnitude} overdue` : `${magnitude} left`,
    magnitude,
    overdue,
    dueSoon: !overdue && diffMs <= soonMs,
  };
};
