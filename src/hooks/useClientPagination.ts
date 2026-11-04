import { useEffect, useState } from 'react';

/**
 * Client-side pagination for already-loaded, *computed* row sets that can't be
 * cleanly server-paginated — aggregate ledgers whose summary tiles need the
 * whole dataset, flatMapped sub-rows (1 parent → N rows), or grouped queues.
 * The full set stays in memory (so tiles/aggregates stay correct) but only
 * `pageSize` rows render at a time, which keeps the DOM bounded — the actual
 * crash vector on huge tables.
 *
 * Pair with the shared <Pagination> (currentPage=page, onPageChange=setPage).
 * Page resets to 1 whenever `resetKey` changes (e.g. a filter signature) and
 * clamps down if a background refetch shrinks the set so `page` is never out
 * of range.
 */
export function useClientPagination<T>(rows: T[], pageSize = 10, resetKey?: string) {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [resetKey]);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
  return {
    /** The ≤pageSize slice to render. */
    pageRows,
    /** Clamped current page (1-based). */
    page: safePage,
    setPage,
    totalPages,
    total: rows.length,
    pageSize,
  };
}
