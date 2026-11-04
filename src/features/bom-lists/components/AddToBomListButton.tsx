import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { useActiveBomList } from '../hooks/useActiveBomList';
import { bomListsApi } from '../services/bom-lists.api';

interface Props {
  /** Inventory item IDs to add. */
  selectedIds: string[];
  /** Called on success — typically clears the bulk selection. */
  onAdded: () => void;
  /** Open the Create New List modal (parent owns it). */
  onCreateNew: () => void;
}

/**
 * Smart "Add N to list" button. Replaces the original "disabled when no
 * active list" version that confused users who hadn't picked a list yet
 * (which is most users on first use).
 *
 * Behaviour:
 *   - If an active list is already picked → adds straight in.
 *   - If not, the button opens an inline picker showing all DRAFT lists +
 *     a "Create new list" option at the top. Picking a list both makes it
 *     active AND adds the items in one click. No-drafts state surfaces the
 *     Create option prominently with an explanatory line so the user knows
 *     why the picker has no entries to pick.
 */
export const AddToBomListButton = ({ selectedIds, onAdded, onCreateNew }: Props) => {
  const { activeId, setActiveId } = useActiveBomList();
  const { addToast } = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);

  // Close picker on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    if (open) document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  // Pre-fetch drafts when picker opens so we don't show a flash of
  // "loading" before the list of options appears.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    bomListsApi.list({ status: 'DRAFT' })
      .then(d => { if (!cancelled) setDrafts((d?.items ?? d ?? [])); })
      .catch(() => { if (!cancelled) setDrafts([]); });
    return () => { cancelled = true; };
  }, [open]);

  const addToList = async (listId: string) => {
    if (selectedIds.length === 0) return;
    // Adding never touches quantity — selection just picks the item; qty is
    // edited inside the slip. So items ALREADY on the list are left untouched
    // (no increment): we add only the new ones and just tell the user which were
    // already there. Compute the split against the target list.
    let newIds = selectedIds;
    let dupNames: string[] = [];
    let serial = 'the list';
    try {
      const target: any = await bomListsApi.get(listId);
      serial = target?.serialNo || serial;
      const existing = new Map((target.items || []).map((it: any) => [it.inventoryItemId, it]));
      newIds = selectedIds.filter(id => !existing.has(id));
      dupNames = selectedIds
        .filter(id => existing.has(id))
        .map(id => (existing.get(id) as any)?.inventoryItem?.name || 'item');
    } catch {
      // Pre-check failed — fall back to adding everything (server upserts).
      newIds = selectedIds;
      dupNames = [];
    }

    const dupBlurb = dupNames.length
      ? `Already on ${serial} (left unchanged): ${dupNames.slice(0, 8).join(', ')}${dupNames.length > 8 ? ` +${dupNames.length - 8} more` : ''}`
      : '';

    // Everything was already on the list → nothing to add, just inform.
    if (newIds.length === 0) {
      setActiveId(listId);
      addToast(dupBlurb || 'All selected items are already on the list.', 'info');
      onAdded();
      setOpen(false);
      return;
    }

    setAdding(true);
    try {
      await bomListsApi.addItems(listId, newIds.map(id => ({ inventoryItemId: id, qty: 1 })));
      setActiveId(listId); // remember the pick for next time
      addToast(
        dupNames.length
          ? `Added ${newIds.length} · ${dupBlurb}`
          : `Added ${newIds.length} item${newIds.length === 1 ? '' : 's'}`,
        'success',
      );
      onAdded();
      setOpen(false);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to add'), 'error');
    } finally {
      setAdding(false);
    }
  };

  const handleDirectClick = () => {
    if (activeId) {
      // Already have an active list — straight to add. Fastest path for the
      // user who already picked a list earlier in the session.
      addToList(activeId);
    } else {
      // Open the picker.
      setOpen(o => !o);
    }
  };

  return (
    <div ref={ref} className="relative inline-block">
      <div className="inline-flex">
        <button
          type="button"
          onClick={handleDirectClick}
          disabled={adding}
          className="bg-emerald-700 text-white px-3 py-1.5 rounded-l-md font-bold text-xs hover:bg-emerald-800 disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
        >
          {adding ? 'Adding…' : `Add ${selectedIds.length} to list`}
        </button>
        <button
          type="button"
          onClick={() => setOpen(o => !o)}
          disabled={adding}
          title="Pick a different list"
          aria-label="Pick a list"
          className="bg-emerald-700 text-white px-2 py-1.5 rounded-r-md border-l border-emerald-700 hover:bg-emerald-800 disabled:opacity-50"
        >
          <ChevronDown size={14} />
        </button>
      </div>
      {open && (
        <div className="absolute right-0 mt-2 w-72 bg-card border border-line rounded-lg shadow-lg z-30 py-1.5">
          <button
            type="button"
            onClick={() => { onCreateNew(); setOpen(false); }}
            className="w-full text-left px-3 py-2 text-sm font-bold text-ink hover:bg-surface flex items-center gap-2 border-b border-line-soft"
          >
            <Plus size={14} className="text-brand" />
            New list
          </button>
          <div className="max-h-60 overflow-y-auto">
            {drafts.length === 0 && (
              <div className="px-3 py-3 text-xs text-faint italic text-center">
                No draft lists yet — create one above.
              </div>
            )}
            {drafts.map((d: any) => (
              <button
                key={d.id}
                type="button"
                onClick={() => addToList(d.id)}
                title={`Add ${selectedIds.length} item(s) to ${d.serialNo}`}
                className={`w-full text-left px-3 py-2 text-xs ${activeId === d.id ? 'bg-emerald-50 dark:bg-emerald-400/15' : 'hover:bg-surface'}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${activeId === d.id ? 'bg-emerald-500' : 'bg-line'}`} />
                  <span className="font-mono font-bold text-ink">{d.serialNo}</span>
                  <span className="text-[10px] text-faint ml-auto">{d._count?.items ?? 0} items</span>
                </div>
                <p className="text-muted truncate mt-0.5 pl-4">{d.name}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
