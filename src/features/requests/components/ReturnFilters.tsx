import { SearchInput } from '@/components/ui';

interface ReturnFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  activeTab: 'pending' | 'history';
  hasActiveFilters: boolean;
  onClearAll: () => void;
}

export const ReturnFilters = ({
  search,
  onSearchChange,
  activeTab,
  hasActiveFilters,
  onClearAll,
}: ReturnFiltersProps) => {
  return (
    <div className="flex gap-3 items-center mb-4">
      <div className="flex-1">
        <SearchInput
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={activeTab === 'pending' ? 'Search by item or request ID...' : 'Search by item or notes...'}
        />
      </div>
      {hasActiveFilters && (
        <button
          onClick={onClearAll}
          className="text-sm text-brand font-bold hover:underline whitespace-nowrap"
        >
          Clear
        </button>
      )}
    </div>
  );
};
