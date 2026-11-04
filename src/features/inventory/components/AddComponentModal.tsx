import React, { useState, useMemo } from 'react';
import { Modal, NumberInput } from '@/components/ui';
import type { CategoryDef, UnitDef } from './InventoryTable';
import { AlertTriangle } from 'lucide-react';

export interface AddComponentModalProps {
  isOpen: boolean;
  onClose: () => void;
  onAdd: (item: {
    name: string; category: string; stock: number; unit: string;
    departmentId: string; rackAddress?: string; containerName?: string;
    trayNumber?: string; projectIds?: string[]; isShared?: boolean;
  }) => void | Promise<void>;
  departments: any[];
  projects: any[];
  customCategories: CategoryDef[];
  units: UnitDef[];
  /** Existing inventory items — used to warn about near-duplicates when typing
   *  the name, so people don't accidentally create a second "3D Printer
   *  Filament PLA 1kg" row alongside the one that already exists. */
  existingItems?: any[];
}

// Name match for the at-create duplicate warning. We deliberately do NOT
// strip punctuation — the dot in "4.7K" was being eaten by `[^a-z0-9]+`,
// which conflated 47K and 4.7K resistors (and any other dotted/slashed
// part numbers). Decimal points and slashes carry meaning in part names;
// preserving them avoids false-positive duplicate warnings on genuinely
// different items. The trade-off: "PLA-1kg" no longer matches "PLA 1kg".
// That's an acceptable miss — punctuation drift on consumables is rare,
// while value drift on resistors / capacitors is constant.
const normaliseName = (s: string) => (s || '').toLowerCase().replace(/\s+/g, ' ').trim();

export const AddComponentModal: React.FC<AddComponentModalProps> = ({
  isOpen, onClose, onAdd, departments, projects, customCategories, units, existingItems = [],
}) => {
  const [newItem, setNewItem] = useState({
    name: '', category: 'ELECTRONIC_PASSIVE', stock: 0, unit: 'PCS',
    departmentId: '', rackAddress: '', containerName: '', trayNumber: '',
    projectIds: [] as string[], isShared: true,
  });
  const [unitInput, setUnitInput] = useState('PCS');
  const [unitSuggestions, setUnitSuggestions] = useState<UnitDef[]>([]);

  const handleUnitChange = (v: string) => {
    setUnitInput(v);
    setNewItem({ ...newItem, unit: v });
    const q = v.toUpperCase();
    setUnitSuggestions(v.length > 0 ? units.filter(u => u.short.includes(q) || u.full.toUpperCase().includes(q)).slice(0, 6) : []);
  };

  // Duplicate detection — runs as the name + department fields change. Returns
  // the small list of items that share the typed name (case/punctuation-insensitive).
  // We don't block submission — we just surface them so the user can decide
  // whether to top up the existing row or proceed with a new one.
  const duplicates = useMemo(() => {
    const typed = normaliseName(newItem.name);
    if (typed.length < 3) return [] as any[];
    return existingItems.filter(it => normaliseName(it.name || '') === typed);
  }, [newItem.name, existingItems]);

  const toggleProject = (id: string) => {
    setNewItem(prev => ({
      ...prev,
      projectIds: prev.projectIds.includes(id) ? prev.projectIds.filter(x => x !== id) : [...prev.projectIds, id],
    }));
  };

  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const payload = {
      name: newItem.name,
      category: newItem.category,
      stock: Number(newItem.stock),
      unit: newItem.unit,
      departmentId: newItem.departmentId,
      rackAddress: newItem.rackAddress || undefined,
      containerName: newItem.containerName || undefined,
      trayNumber: newItem.trayNumber || undefined,
      projectIds: newItem.projectIds.length > 0 ? newItem.projectIds : undefined,
      isShared: newItem.isShared,
    };
    // Only clear the form once the save has actually resolved.
    //
    // This used to blank every field immediately after calling onAdd, before
    // the outcome was known — so a rejected create (duplicate name, a
    // validation error, a dropped connection) left an empty form plus an error
    // toast and the clerk had to retype the whole component from memory.
    setSubmitting(true);
    try {
      await onAdd(payload);
      setNewItem({ name: '', category: 'ELECTRONIC_PASSIVE', stock: 0, unit: 'PCS', departmentId: '', rackAddress: '', containerName: '', trayNumber: '', projectIds: [], isShared: true });
      setUnitInput('PCS');
    } catch {
      // The caller surfaces the reason; keep what was typed so it can be retried.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add New Component">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto p-1">
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Component Name</label>
          <input type="text" value={newItem.name} onChange={(e) => setNewItem({...newItem, name: e.target.value})} className="w-full px-3 py-2 border rounded-md focus:border-brand focus:ring-brand" placeholder="e.g. Raspberry Pi 4" />
          {duplicates.length > 0 && (
            <div className="mt-2 bg-amber-50 dark:bg-amber-400/15 border border-amber-300 dark:border-amber-400/30 rounded-md p-3">
              <div className="flex items-start gap-2">
                <AlertTriangle size={16} className="text-amber-700 dark:text-amber-300 mt-0.5 shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-bold text-amber-900 dark:text-amber-200">
                    {duplicates.length === 1 ? 'An item with this name already exists' : `${duplicates.length} items with this name already exist`}
                  </p>
                  <p className="text-[11px] text-amber-800 dark:text-amber-200 mt-0.5">
                    Consider topping up the existing row instead of creating another. If they really are different items, change the name to make the distinction explicit (e.g. include the brand, spec, or part number).
                  </p>
                  <ul className="mt-2 space-y-1">
                    {duplicates.slice(0, 4).map((d: any) => (
                      <li key={d.id} className="text-[11px] text-amber-900 dark:text-amber-200 bg-card/60 border border-amber-200 dark:border-amber-400/30 rounded px-2 py-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="font-bold">{d.name}</span>
                        <span className="text-amber-700 dark:text-amber-300">·</span>
                        <span>{d.category?.replace(/_/g, ' ') || 'Uncategorised'}</span>
                        <span className="text-amber-700 dark:text-amber-300">·</span>
                        <span>{d.department?.name || 'No dept'}</span>
                        <span className="text-amber-700 dark:text-amber-300">·</span>
                        <span>{d.isShared ? 'Shared' : 'Dept-only'}</span>
                        <span className="text-amber-700 dark:text-amber-300">·</span>
                        <span>Stock {d.stock ?? 0} {d.unit || ''}</span>
                      </li>
                    ))}
                    {duplicates.length > 4 && (
                      <li className="text-[10px] text-amber-700 dark:text-amber-300 italic">…and {duplicates.length - 4} more</li>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Department</label>
          <select value={newItem.departmentId} onChange={(e) => setNewItem({...newItem, departmentId: e.target.value})} className="w-full px-3 py-2 border rounded-md focus:border-brand focus:ring-brand">
            <option value="">-- Choose Department --</option>
            {departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Category</label>
            <select value={newItem.category} onChange={(e) => setNewItem({...newItem, category: e.target.value})} className="w-full px-3 py-2 border rounded-md focus:border-brand focus:ring-brand">
              {customCategories.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
          <div className="relative">
            <label className="block text-sm font-bold text-muted mb-1">Unit</label>
            <input type="text" value={unitInput}
              onChange={(e) => handleUnitChange(e.target.value)}
              onBlur={() => setTimeout(() => setUnitSuggestions([]), 150)}
              className="w-full px-3 py-2 border rounded-md focus:border-brand focus:ring-brand" placeholder="Type to search units..." />
            {unitSuggestions.length > 0 && (
              <div className="absolute z-50 top-full left-0 mt-1 bg-card border border-line rounded-lg shadow-lg w-full max-h-48 overflow-y-auto">
                {unitSuggestions.map(u => (
                  <button key={u.short} type="button"
                    onMouseDown={(e) => { e.preventDefault(); setUnitInput(u.short); setNewItem({...newItem, unit: u.short}); setUnitSuggestions([]); }}
                    className="w-full text-left px-3 py-2 hover:bg-brand/10 flex items-center justify-between text-sm">
                    <span className="font-bold text-ink">{u.short}</span>
                    <span className="text-muted text-xs">{u.full}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Rack Address</label>
            <input type="text" value={newItem.rackAddress} onChange={(e) => setNewItem({...newItem, rackAddress: e.target.value})} className="w-full px-3 py-2 border rounded-md focus:border-brand focus:ring-brand" />
          </div>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Container</label>
            <input type="text" value={newItem.containerName} onChange={(e) => setNewItem({...newItem, containerName: e.target.value})} className="w-full px-3 py-2 border rounded-md focus:border-brand focus:ring-brand" />
          </div>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Tray</label>
            <input type="text" value={newItem.trayNumber} onChange={(e) => setNewItem({...newItem, trayNumber: e.target.value})} className="w-full px-3 py-2 border rounded-md focus:border-brand focus:ring-brand" />
          </div>
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Initial Stock</label>
          <NumberInput min={0} value={newItem.stock} onChange={(v) => setNewItem({...newItem, stock: v})} className="w-full px-3 py-2 border rounded-md focus:border-brand focus:ring-brand" />
        </div>
        <div className="bg-emerald-50 dark:bg-emerald-400/15 border border-emerald-200 dark:border-emerald-400/30 rounded-md p-3">
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="checkbox" checked={newItem.isShared}
              onChange={(e) => setNewItem({...newItem, isShared: e.target.checked})}
              className="mt-0.5 h-4 w-4 rounded border-line text-emerald-700 dark:text-emerald-300 focus:ring-emerald-500" />
            <div className="flex-1">
              <span className="text-sm font-bold text-ink">Shared / available org-wide <span className="text-emerald-700 dark:text-emerald-300 text-[10px] font-bold ml-1">DEFAULT</span></span>
              <p className="text-[11px] text-muted mt-0.5">
                By default, items are visible to everyone. <span className="font-bold">Uncheck only for dept-specific hardware</span> (dev boards, lab tools, specialised kit) that should stay restricted to the owning department.
              </p>
            </div>
          </label>
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Projects (optional, multi-select)</label>
          <p className="text-[11px] text-muted mb-2">Tag this component with the projects it's used in. You can leave blank if it's general stock.</p>
          <div className="flex flex-wrap gap-1.5">
            {projects.map((p: any) => {
              const on = newItem.projectIds.includes(p.id);
              return (
                <button key={p.id} type="button" onClick={() => toggleProject(p.id)}
                  className={`px-2.5 py-1 text-xs font-bold rounded-full border transition-colors ${on ? 'bg-violet-500 text-ink border-violet-500' : 'bg-surface text-muted border-line hover:border-violet-400'}`}>
                  {p.name}
                </button>
              );
            })}
            {projects.length === 0 && <span className="text-xs text-faint italic">No projects available.</span>}
          </div>
        </div>
        <div className="flex justify-end pt-4 border-t border-line-soft">
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="bg-brand text-white px-6 py-2 font-bold rounded-full hover:bg-brand-dark disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Creating…' : 'Create Component'}
          </button>
        </div>
      </div>
    </Modal>
  );
};
