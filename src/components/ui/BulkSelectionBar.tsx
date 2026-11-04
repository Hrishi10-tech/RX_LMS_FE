import { ReactNode } from 'react';
import { X } from 'lucide-react';

interface BulkSelectionBarProps {
  count: number;
  onClear: () => void;
  /** Optional page-specific action buttons (e.g. "Bulk Edit", "Delete", "Export"). */
  children?: ReactNode;
}

/**
 * Sticky toolbar that appears above a table when one or more rows are selected.
 * Pages provide context-specific action buttons via `children`; the bar handles the
 * shared count + clear UX so every table looks and behaves the same way.
 */
export function BulkSelectionBar({ count, onClear, children }: BulkSelectionBarProps) {
  if (count === 0) return null;
  return (
    <div className="flex items-center gap-2 bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 rounded-lg px-3 py-2 mb-3 shadow-sm">
      <span className="text-sm font-bold text-emerald-700 dark:text-emerald-300">
        {count} selected
      </span>
      <div className="flex-1" />
      {children}
      <button
        onClick={onClear}
        className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:text-emerald-200 hover:bg-emerald-100 dark:bg-emerald-400/20 px-2 py-1 rounded transition-colors"
        title="Clear selection"
      >
        <X size={12} />
        Clear
      </button>
    </div>
  );
}
