import { SearchInput } from '@/components/ui';
import { Settings } from 'lucide-react';

interface AssetFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  hasFilters: boolean;
  onClearAll: () => void;
  onOpenSettings: () => void;
}

export const AssetFilters = ({
  search,
  onSearchChange,
  hasFilters,
  onClearAll,
  onOpenSettings,
}: AssetFiltersProps) => {
  return (
    <div className="flex gap-3 items-center">
      <div className="flex-1">
        <SearchInput value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder="Search by name or asset tag..." />
      </div>
      <button onClick={onOpenSettings} className="p-2.5 rounded-lg border border-line text-muted hover:text-brand hover:border-brand transition-colors" title="Settings">
        <Settings size={18} />
      </button>
      {hasFilters && <button onClick={onClearAll} className="text-sm text-brand font-bold hover:underline whitespace-nowrap">Clear all</button>}
    </div>
  );
};
