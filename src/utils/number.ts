/**
 * Number/currency formatters shared across dashboards.
 *
 * Why this exists: several dashboards rendered `Math.round(stats.x).toLocaleString()`
 * directly. When a stat field is missing on a partial/empty API payload, that
 * produces the literal string "NaN" (or "Infinity" for a divide-by-zero) in a
 * KPI card. These helpers guard the input and fall back gracefully, matching the
 * pattern FinanceDashboardPage already used locally.
 */

/**
 * Format a value as a rounded integer with locale grouping.
 * Non-finite or nullish input (an undefined stat on a partial payload) returns
 * `fallback` instead of "NaN".
 */
export const fmtInt = (v: unknown, fallback = '0'): string => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n).toLocaleString() : fallback;
};

/**
 * Format an INR currency amount (en-IN grouping, no paise).
 * `null`/`undefined` render as `opts.nullish` (default "-", the dashboards'
 * "no data" convention); non-finite → "₹0"; zero and finite numbers format
 * normally.
 */
export const fmtINR = (
  v: unknown,
  opts: { compact?: boolean; nullish?: string } = {},
): string => {
  if (v == null) return opts.nullish ?? '-';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '₹0';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
    notation: opts.compact ? 'compact' : 'standard',
  }).format(n);
};
