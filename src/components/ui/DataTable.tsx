import { ReactNode } from 'react';

// Cycled per (row + column) so the bars vary in length but stay stable
// across re-renders.
const SKELETON_WIDTHS = ['72%', '45%', '60%', '38%', '84%', '52%'];

interface Column<T> {
  header: string | ReactNode;
  accessor: keyof T | ((row: T, rowIndex: number) => ReactNode);
  /** When true, the header cell and every body cell in this column gets a soft amber tint
   * so users can spot at-a-glance which columns currently have a filter applied. */
  filterActive?: boolean;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  isLoading?: boolean;
  emptyStateMessage?: string;
  keyExtractor: (row: T) => string;
  maxHeight?: string;
  /** Bulk-select opt-in. When all three are provided, DataTable prepends an S.No column
   * that doubles as a row selector (click row index → toggle; click "S.No" header → toggle
   * all visible). Do NOT also include your own S.No column in `columns` when using this. */
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAllVisible?: (visibleIds: string[]) => void;
  /** Optional bulk-actions toolbar shown above the table when at least one row is selected. */
  bulkActions?: ReactNode;
  /**
   * Optional row click handler. When provided, the entire row becomes a
   * click target (cursor + hover bg). Clicks on interactive descendants
   * (buttons, inputs, links) are ignored automatically so per-row action
   * buttons keep working as expected.
   */
  onRowClick?: (row: T) => void;
  /**
   * Optional per-row class string, merged onto the <tr> after the base/
   * selected classes — e.g. to flash-highlight a row the user was deep-linked
   * to. Every row also carries `data-row-id` so callers can scrollIntoView by id.
   */
  rowClassName?: (row: T, rowIndex: number) => string;
  /**
   * Let cell text wrap so the table narrows with the screen instead of
   * scrolling sideways. Off by default: most tables are short enough, and
   * a wrapped serial or amount reads worse than a scroll. On for wide
   * working lists (Returns) where Actions otherwise sat off a laptop screen.
   */
  fit?: boolean;
}

/**
 * Cell padding is `px-4 md:px-6` to match the card convention used across the
 * app (`p-4 md:p-6`, 15 cards and counting). The two have to agree: a table
 * sits flush inside an unpadded card, so the CELL padding is what puts the
 * first column's text on the card's content line. When they disagreed, every
 * column sat 6px out of step with the search box and filters above it.
 *
 * Change one and you must change the other.
 */
/**
 * Horizontal padding of one column. In `fit` mode every column after the first
 * tightens below very wide screens — padding was 48 px a column, the largest
 * single cost of a wide table on a laptop. The first column keeps the card
 * padding so its text still lines up with the search box above (see above).
 */
const padX = (fit: boolean, first: boolean) =>
  !fit || first ? 'px-4 md:px-6' : 'px-2 xl:px-3 2xl:px-6';

export function DataTable<T extends { id?: string }>({
  columns,
  data,
  isLoading,
  emptyStateMessage = 'No data found',
  keyExtractor,
  maxHeight,
  fit = false,
  selectedIds,
  onToggleSelect,
  onToggleSelectAllVisible,
  bulkActions,
  onRowClick,
  rowClassName,
}: DataTableProps<T>) {
  // NOT an early return any more. The skeleton's whole point is that the
  // real <thead> is already on screen with the real column widths, so the
  // layout doesn't snap when the rows land — which means the loading state
  // has to render inside the same table, not instead of it.
  const isEmpty = !isLoading && (!data || data.length === 0);

  const selectable = !!(selectedIds && onToggleSelect && onToggleSelectAllVisible);
  // Column count, for the skeleton and the empty-state colSpan.
  const colCount = columns.length + (selectable ? 1 : 0);
  const visibleIds = selectable ? data.map((r: any) => keyExtractor(r)) : [];
  const allSelected = selectable && visibleIds.length > 0 && visibleIds.every((id) => selectedIds!.has(id));
  const someSelected = selectable && !allSelected && visibleIds.some((id) => selectedIds!.has(id));
  const hasSelection = selectable && (selectedIds?.size ?? 0) > 0;

  return (
    <div className="w-full">
      {/* The skeleton is decorative (aria-hidden), so the loading state needs
          saying out loud exactly once for anyone not looking at it. */}
      {isLoading && <span role="status" className="sr-only">Loading table data</span>}
      {selectable && hasSelection && bulkActions && (
        <div className="sticky top-0 z-20 mb-2">{bulkActions}</div>
      )}
      <div className="relative">
        <div className="w-full overflow-x-auto" style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}>
          <table className="min-w-full" aria-busy={isLoading || undefined}>
            <thead className={maxHeight ? 'sticky top-0 z-10' : ''}>
              <tr className="border-b border-line bg-surface">
                {selectable && (
                  <th
                    scope="col"
                    className="px-4 md:px-6 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider bg-surface"
                  >
                    <button
                      onClick={() => onToggleSelectAllVisible!(visibleIds)}
                      // "S.No" is also the select-all-visible control, and at
                      // 27x17 it was too small to hit reliably on a phone. The
                      // label keeps its size so the header row does not shift;
                      // the tap area is extended by a transparent
                      // pseudo-element, which costs no layout.
                      className={`relative text-[11px] font-bold transition-colors
                        after:absolute after:-inset-2.5 after:content-[''] ${
                        allSelected
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : someSelected
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-muted hover:text-brand'
                      }`}
                      title={allSelected ? 'Clear selection' : 'Select all visible'}
                    >
                      S.No
                    </button>
                  </th>
                )}
                {columns.map((col, idx) => (
                  <th
                    key={idx}
                    scope="col"
                    // One line per header: a filter icon beside a two-word label used
                    // to wrap it ("REQUEST / ID") while its neighbours stayed on one
                    // line. The table already scrolls sideways when it runs out of room.
                    className={`${padX(fit, idx === 0 && !selectable)} py-2.5 text-left text-[11px] font-semibold text-muted uppercase tracking-wider whitespace-nowrap ${
                      col.filterActive ? 'bg-brand-100' : 'bg-surface'
                    }`}
                  >
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                // Eight placeholder rows: enough to fill the eye without
                // pretending to know how many rows are actually coming.
                Array.from({ length: 8 }).map((_, rowIndex) => (
                  <tr key={`skeleton-${rowIndex}`} className="border-b border-line-soft" aria-hidden="true">
                    {Array.from({ length: colCount }).map((__, colIndex) => (
                      <td key={colIndex} className="px-4 md:px-6 py-3">
                        {/* Widths cycle through a fixed pattern rather than
                            being random, so the bars don't reflow on every
                            re-render — and so the block reads as text of
                            varying length instead of a uniform grid. */}
                        <div
                          className="shimmer h-3 rounded-full"
                          style={{
                            width: SKELETON_WIDTHS[(rowIndex + colIndex) % SKELETON_WIDTHS.length],
                            // A small per-row offset makes the sweep cascade
                            // down the table instead of every row flashing
                            // in unison.
                            animationDelay: `${rowIndex * 0.06}s`,
                          }}
                        />
                      </td>
                    ))}
                  </tr>
                ))
              ) : isEmpty ? (
                <tr>
                  <td colSpan={colCount} className="text-center py-10 text-sm text-faint">
                    {emptyStateMessage}
                  </td>
                </tr>
              ) : (
                data.map((row, rowIndex) => {
                  const id = keyExtractor(row);
                  const isSel = selectable && selectedIds!.has(id);
                  // Only fire onRowClick when the click landed on the row
                  // background — NOT on per-row buttons / inputs / links.
                  // Without this, action buttons inside the row would fire
                  // both their own onClick and the row-level one.
                  const handleRowClick = onRowClick ? (e: React.MouseEvent) => {
                    if ((e.target as HTMLElement).closest('button, input, a, select, textarea')) return;
                    onRowClick(row);
                  } : undefined;
                  return (
                    <tr key={id}
                        data-row-id={id}
                        onClick={handleRowClick}
                        // `--i` drives the staggered entrance (see .row-enter).
                        // Capped at 12 so a 200-row page finishes animating in
                        // half a second instead of trickling in for eight.
                        style={{ '--i': Math.min(rowIndex, 12) } as React.CSSProperties}
                        className={`row-enter border-b border-line-soft ${isSel ? 'bg-emerald-50/40 dark:bg-emerald-400/15' : rowIndex % 2 === 1 ? 'bg-zebra' : ''} ${onRowClick ? 'cursor-pointer hover:bg-brand-50 transition-colors' : ''} ${rowClassName ? rowClassName(row, rowIndex) : ''}`}>
                      {selectable && (
                        <td className="px-4 md:px-6 py-2.5 whitespace-nowrap text-sm">
                          <button
                            onClick={() => onToggleSelect!(id)}
                            className={`text-xs font-mono font-bold w-10 h-7 rounded transition-colors flex items-center justify-center ${
                              isSel
                                ? 'bg-emerald-500 text-white'
                                : 'text-faint hover:bg-hover hover:text-ink'
                            }`}
                          >
                            {isSel ? '✓' : rowIndex + 1}
                          </button>
                        </td>
                      )}
                      {columns.map((col, idx) => (
                        <td
                          key={idx}
                          className={`${padX(fit, idx === 0 && !selectable)} py-2.5 ${fit ? '' : 'whitespace-nowrap'} text-sm text-secondary ${
                            col.filterActive ? 'bg-brand-50' : ''
                          }`}
                        >
                          {typeof col.accessor === 'function' ? col.accessor(row, rowIndex) : (row[col.accessor] as ReactNode)}
                        </td>
                      ))}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
