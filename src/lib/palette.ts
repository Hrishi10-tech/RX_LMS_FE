/**
 * The palette's raw values, for the handful of places that cannot use a
 * Tailwind class.
 *
 * Everything else in the app colours itself with tokens from
 * tailwind.config.js (`text-ink`, `bg-brand`, …). But a <canvas>-drawn
 * favicon and an inline `style={{ backgroundColor }}` need a string at
 * runtime, and those were the last four hardcoded hex literals in the tree.
 *
 * Keep these in step with tailwind.config.js — same names, same values.
 * They are the only duplication of a token value in the codebase, and they
 * exist because a data URI cannot read a utility class.
 */
export const palette = {
  brand: '#7c3aed',
  brandDark: '#6d28d9',
  ink: '#111827',
  /** The dark rounded square behind the favicon / app icon glyphs. */
  mark: '#1a1a2e',
  /** Neutral used for an empty/zero bar, where `brand` would imply data. */
  empty: '#E5E7EB',
} as const;
