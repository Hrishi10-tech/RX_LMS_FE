interface LoadAllCapNoteProps {
  /** `truncated` from useServerPagination. Renders nothing when false. */
  truncated: boolean;
  /** Rows actually loaded (the hook's `items.length`, i.e. LOAD_ALL_CAP). */
  shown: number;
  /** `serverTotal` from useServerPagination. */
  total: number;
  /**
   * Which rows were kept: 'newest' (the default) for a list ordered newest
   * first, 'first' for one ordered some other way (by code, by name) where
   * "newest" would be untrue.
   */
  kept?: 'newest' | 'first';
  /**
   * What the reader can do about it. Defaults to the dates-or-search advice;
   * pass something else on a list that has neither.
   */
  hint?: string;
}

/**
 * The line under a loadAll list that reached LOAD_ALL_CAP.
 *
 * Without it the list simply ends at the cap, its count reads as the full
 * total, and an older record looks like it was never there. Saying how many
 * exist, and what to do about it, turns a silent gap into an instruction.
 */
export function LoadAllCapNote({ truncated, shown, total, kept = 'newest', hint = 'narrow the dates or search to see older ones.' }: LoadAllCapNoteProps) {
  if (!truncated) return null;
  return (
    <p role="status" className="px-1 py-2 text-xs text-amber-700 dark:text-amber-300">
      Showing the {kept} {shown.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} — {hint}
    </p>
  );
}
