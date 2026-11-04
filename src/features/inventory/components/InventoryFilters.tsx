import React from 'react';
import { SearchInput } from '@/components/ui';
import { Settings, X, Archive, Download, Loader2, History } from 'lucide-react';

export interface InventoryFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  stockFilter: string;
  onStockFilterClear: () => void;
  hasActiveFilters: boolean;
  onClearAll: () => void;
  isReadOnly: boolean;
  onOpenSettings: () => void;
  onOpenBulkUpload: () => void;
  onOpenAddComponent: () => void;
  /** Show the "Archived items" entry point — only for roles allowed to unarchive. */
  canViewDeleted?: boolean;
  onOpenDeleted?: () => void;
  /** Download the table as .xlsx, with whatever filters are currently applied. */
  onExport?: () => void;
  exporting?: boolean;
  /** Restore from a download — Inventory only (see RestoreFromDownloadModal). */
  onOpenRestore?: () => void;
}

export const InventoryFilters: React.FC<InventoryFiltersProps> = ({
  search,
  onSearchChange,
  stockFilter,
  onStockFilterClear,
  hasActiveFilters,
  onClearAll,
  isReadOnly,
  onOpenSettings,
  onOpenBulkUpload,
  onOpenAddComponent,
  canViewDeleted = false,
  onOpenDeleted,
  onExport,
  exporting = false,
  onOpenRestore,
}) => {
  return (
    <div className="bg-card p-4 md:p-6 rounded-lg shadow-sm border border-line-soft">
      <div className="flex flex-col md:flex-row md:justify-between md:items-start gap-4">
        <div className="flex-1">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Component Database</h2>
              <p className="text-sm md:text-[15px] text-muted mt-1.5">Manage global inventory items directly</p>
            </div>
            <div className="flex flex-wrap gap-2 w-full md:w-auto">
              {!isReadOnly && (
                <>
                  <button onClick={onOpenBulkUpload} className="flex-1 md:flex-none px-4 py-2 border-2 border-faint text-ink font-bold rounded-md hover:border-brand hover:text-brand transition-colors whitespace-nowrap">
                    Bulk Upload
                  </button>
                  <button onClick={onOpenAddComponent} className="flex-1 md:flex-none bg-brand text-white px-4 py-2 font-bold rounded-full hover:bg-brand-dark transition-colors whitespace-nowrap">
                    + Add Component
                  </button>
                </>
              )}
              {onExport && (
                // Available to read-only roles too: looking at the shelf and
                // taking the list away with you is a read, not an edit.
                <button onClick={onExport} disabled={exporting}
                  title="Download these components as an Excel file — the filters you have applied are included"
                  className="flex-1 md:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 border-2 border-faint text-ink font-bold rounded-md hover:border-brand hover:text-brand transition-colors whitespace-nowrap disabled:opacity-50">
                  {exporting ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  {exporting ? 'Preparing…' : 'Download'}
                </button>
              )}
              {onOpenRestore && (
                <button onClick={onOpenRestore}
                  title="Put counts, locations and allotments back from a file made by Download"
                  className="flex-1 md:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2 border-2 border-faint text-ink font-bold rounded-md hover:border-brand hover:text-brand transition-colors whitespace-nowrap">
                  <History size={14} /> Restore
                </button>
              )}
              {canViewDeleted && onOpenDeleted && (
                // Recovery action, not a primary one — borderless muted text so it
                // sits behind Bulk Upload / Add Component instead of competing
                // with them. Still labelled (not icon-only) because the archive
                // confirmation tells people to come here by name.
                <button onClick={onOpenDeleted} title="Items taken off the list — unarchive anything you need again"
                  className="inline-flex items-center justify-center gap-1 px-2 py-2 text-xs text-faint hover:text-muted transition-colors whitespace-nowrap">
                  <Archive size={13} /> Archived items
                </button>
              )}
            </div>
          </div>
          <div className="flex flex-col md:flex-row gap-3 md:items-center w-full">
            <div className="flex-1 w-full flex items-center gap-2">
              <div className="flex-1">
                <SearchInput value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder="Search components..." />
              </div>
              {stockFilter && (
                <button onClick={onStockFilterClear} className={`flex items-center gap-1 px-3 py-2 text-xs font-bold rounded-lg border transition-colors ${
                  stockFilter === 'low' ? 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30' :
                  stockFilter === 'out' ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-200 dark:border-red-400/30' :
                  'bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300 border-green-200 dark:border-green-400/30'
                }`}>
                  {stockFilter === 'low' ? 'Low Stock' : stockFilter === 'out' ? 'Out of Stock' : 'Available'}
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-3">
              {!isReadOnly && (
                <button onClick={onOpenSettings} className="p-2.5 rounded-lg border border-line text-muted hover:text-brand hover:border-brand transition-colors shrink-0" title="Settings">
                  <Settings size={18} />
                </button>
              )}
              {hasActiveFilters && (
                <button onClick={onClearAll} className="text-sm text-brand font-bold hover:underline whitespace-nowrap">Clear all</button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
