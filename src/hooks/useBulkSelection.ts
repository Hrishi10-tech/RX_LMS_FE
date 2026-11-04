import { useState, useCallback } from 'react';

/**
 * Shared bulk-selection state used by every table that wants to support multi-row actions.
 * Pair the returned handlers with `<DataTable selectedIds onToggleSelect onToggleSelectAllVisible />`,
 * and render `<BulkSelectionBar />` to show the live count + a "Clear" button.
 *
 * `toggleSelectAllVisible` takes the currently-rendered (i.e. filter-aware) row IDs — if every
 * one of them is already selected, the call clears them; otherwise it adds the missing ones.
 * So pages don't need to know about filtering — they just hand over what they're rendering.
 */
export function useBulkSelection() {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAllVisible = useCallback((visibleIds: string[]) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allSelected = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
      if (allSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  return { selectedIds, toggleSelect, toggleSelectAllVisible, clearSelection };
}
