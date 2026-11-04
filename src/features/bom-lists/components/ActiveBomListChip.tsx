import { useEffect, useState } from 'react';
import { X, ChevronRight } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks';
import { useActiveBomList } from '../hooks/useActiveBomList';
import { bomListsApi } from '../services/bom-lists.api';

/**
 * Sticky chip near the inventory items page header — when a list is active,
 * tells the user "selected items will be added to <list>" so they don't get
 * blindsided when the BulkSelectionBar action mentions a list they forgot
 * they had picked.
 *
 * Auto-clears itself if the active list has been SUBMITTED or deleted (the
 * id in localStorage outlives the list).
 */
export const ActiveBomListChip = () => {
  const { activeId, setActiveId } = useActiveBomList();
  const { user } = useAuth();
  const navigate = useNavigate();
  const roleSlug = user?.role.toLowerCase().replace(/_/g, '-') || 'user';
  const [list, setList] = useState<any | null>(null);

  useEffect(() => {
    if (!activeId) { setList(null); return; }
    let cancelled = false;
    bomListsApi.get(activeId)
      .then(d => {
        if (cancelled) return;
        // If the picked list isn't editable anymore, silently drop it —
        // the user can pick another from the Lists dropdown.
        if (d.status !== 'DRAFT') { setList(null); setActiveId(null); return; }
        setList(d);
      })
      .catch(() => { if (!cancelled) { setList(null); setActiveId(null); } });
    return () => { cancelled = true; };
  }, [activeId, setActiveId]);

  if (!list) return null;

  const itemCount = list._count?.items ?? list.items?.length ?? 0;

  return (
    <div className="bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 rounded-md flex items-center text-xs overflow-hidden">
      {/* The whole banner is clickable → opens this BOM's editor slip (review + submit). */}
      <button
        onClick={() => navigate(`/${roleSlug}/lists?openList=${list.id}`)}
        title="Open this BOM to review + submit"
        className="flex items-center gap-2 pl-3 pr-2 py-1.5 hover:bg-emerald-100 dark:bg-emerald-400/20 transition-colors cursor-pointer"
      >
        <span className="text-emerald-700 dark:text-emerald-300 font-medium">Adding to</span>
        <span className="font-mono font-bold text-emerald-900 dark:text-emerald-200">{list.serialNo}</span>
        <span className="text-emerald-800 dark:text-emerald-200 truncate max-w-[200px]">{list.name}</span>
        <span className="text-emerald-700 dark:text-emerald-300">·</span>
        <span className="text-emerald-700 dark:text-emerald-300">{itemCount} item{itemCount === 1 ? '' : 's'}</span>
        <ChevronRight size={14} className="text-emerald-700 dark:text-emerald-300" />
      </button>
      <button
        onClick={() => setActiveId(null)}
        title="Stop adding to this list"
        className="text-emerald-700 dark:text-emerald-300 hover:text-emerald-900 dark:text-emerald-200 border-l border-emerald-200 dark:border-emerald-400/30 px-2 py-1.5 self-stretch flex items-center"
      >
        <X size={14} />
      </button>
    </div>
  );
};
