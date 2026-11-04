import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ChevronDown, List as ListIcon } from 'lucide-react';
import { useAuth } from '@/hooks';
import { useActiveBomList } from '../hooks/useActiveBomList';
import { bomListsApi } from '../services/bom-lists.api';

interface Props {
  /** Open the create-list modal in the parent. */
  onCreateNew: () => void;
  /** Optional: open editor on a specific list id. */
  onOpenList?: (listId: string) => void;
  /** Reload counter — bump to force a fresh /bom-lists fetch (e.g. after add). */
  refreshKey?: number;
}

/**
 * "Lists ▾" header dropdown. Shows the 5 most-recent DRAFT lists with a
 * radio-style "active" marker, plus "+ New list" and "View all →".
 *
 * Picking a list flips the activeId in localStorage (read elsewhere via
 * useActiveBomList) so the BulkSelectionBar's "Add N to BOM-XXX" button
 * knows where to put items.
 */
export const ListsDropdown = ({ onCreateNew, onOpenList, refreshKey }: Props) => {
  const { activeId, setActiveId } = useActiveBomList();
  const { user } = useAuth();
  const navigate = useNavigate();
  const roleSlug = user?.role.toLowerCase().replace(/_/g, '-') || 'user';
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<any[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Lazy-load only when opened (saves a /bom-lists call on every inventory page render).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    bomListsApi.list({ status: 'DRAFT' })
      .then(d => { if (!cancelled) setDrafts((d?.items ?? d ?? []).slice(0, 5)); })
      .catch(() => { if (!cancelled) setDrafts([]); });
    return () => { cancelled = true; };
  }, [open, refreshKey]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 bg-card border border-line text-ink px-3 py-2 rounded-md font-bold text-sm hover:bg-surface shadow-sm"
      >
        <ListIcon size={14} />
        Lists
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-72 bg-card border border-line rounded-lg shadow-lg z-30 py-1.5">
          <button
            onClick={() => { onCreateNew(); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm font-bold text-ink hover:bg-surface flex items-center gap-2 border-b border-line-soft"
          >
            <Plus size={14} className="text-brand" />
            New list
          </button>
          <div className="max-h-60 overflow-y-auto">
            {drafts.length === 0 && (
              <div className="px-3 py-3 text-xs text-faint italic text-center">
                No draft lists yet
              </div>
            )}
            {drafts.map((d: any) => {
              const isActive = activeId === d.id;
              return (
                <div key={d.id} className={`flex items-stretch ${isActive ? 'bg-emerald-50 dark:bg-emerald-400/15' : 'hover:bg-surface'}`}>
                  <button
                    onClick={() => { setActiveId(d.id); setOpen(false); }}
                    title={isActive ? 'Already active' : 'Make this the active list'}
                    className="flex-1 text-left px-3 py-2 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full ${isActive ? 'bg-emerald-500' : 'bg-line'}`} />
                      <span className="font-mono font-bold text-ink">{d.serialNo}</span>
                      <span className="text-[10px] text-faint ml-auto">{d._count?.items ?? 0} items</span>
                    </div>
                    <p className="text-muted truncate mt-0.5 pl-4">{d.name}</p>
                  </button>
                  <button
                    onClick={() => { onOpenList?.(d.id); setOpen(false); }}
                    title="Open list"
                    className="px-2 text-[10px] font-bold text-brand hover:underline"
                  >
                    Open
                  </button>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => { navigate(`/${roleSlug}/lists`); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-xs font-bold text-brand hover:bg-surface border-t border-line-soft"
          >
            View all lists →
          </button>
        </div>
      )}
    </div>
  );
};
