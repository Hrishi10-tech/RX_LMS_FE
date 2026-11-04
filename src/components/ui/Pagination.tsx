import { useEffect } from 'react';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export const Pagination = ({ currentPage, totalPages, onPageChange }: PaginationProps) => {
  // Self-heal when the underlying data shrinks (bulk-delete, filter applied,
  // search narrowed) and the user is sitting on a page that no longer exists.
  // Without this, the table renders empty and looks broken.
  useEffect(() => {
    if (totalPages > 0 && currentPage > totalPages) {
      onPageChange(totalPages);
    }
  }, [totalPages, currentPage, onPageChange]);

  if (totalPages <= 1) return null;

  return (
    <nav className="flex items-center justify-between border-t border-line bg-card px-4 py-3 sm:px-6 w-full" aria-label="Pagination">
      <div className="hidden sm:block">
        <p className="text-sm text-ink">
          Page <span className="font-medium">{currentPage}</span> of <span className="font-medium">{totalPages}</span>
        </p>
      </div>
      <div className="flex flex-1 justify-between sm:justify-end">
        <button
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage === 1}
          className="relative inline-flex items-center rounded-md border border-line bg-card px-4 py-2 text-sm font-medium text-ink hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <button
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage === totalPages}
          className="relative ml-3 inline-flex items-center rounded-md border border-line bg-card px-4 py-2 text-sm font-medium text-ink hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </nav>
  );
};
