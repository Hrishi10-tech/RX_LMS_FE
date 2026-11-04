/* eslint-disable react-refresh/only-export-components --
   Co-locates the InventoryTable component with shared inventory constants/helpers
   (categories, units, columns, getUnitFull) imported across inventory pages.
   Dev-only Fast-Refresh hint; no runtime impact. */
import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { SlidersHorizontal, Archive } from 'lucide-react';
import { DataTable, ColumnFilter } from '@/components/ui';
import { EditableCell } from '@/components/ui/EditableCell';
import { stockColorClass } from '@/utils/stock';

// --- Shared types and constants ---

export interface UnitDef {
  short: string;
  full: string;
}

export interface CategoryDef {
  value: string;
  label: string;
}

export const ALL_CATEGORIES: CategoryDef[] = [
  { value: 'ELECTRONIC_PASSIVE', label: 'Electronic Passive' },
  { value: 'ELECTRONIC_ACTIVE', label: 'Electronic Active' },
  { value: 'MECHANICAL_TOOLS', label: 'Mechanical Tools & Machineries' },
  { value: 'ELECTRONICS_GENERAL_ACCESSORIES', label: 'Electronics General Accessories' },
  { value: 'ELECTRONICS_TOOLS', label: 'Electronics Tools & Machineries' },
  { value: 'MECHANICAL_3D_PRINTING', label: 'Mechanical & 3D Printing Accessories' },
  { value: 'PACKING_MATERIALS', label: 'Packing Materials' },
  { value: 'SAFETY_WEARABLE', label: 'Safety Wearable' },
  { value: 'STATIONARY_OFFICE', label: 'Stationary & Office Supplies' },
  { value: 'CLEANING_ITEMS', label: 'Cleaning Items' },
  { value: 'PCB_STENCILS', label: 'PCB & Stencils' },
];

export const DEFAULT_UNITS: UnitDef[] = [
  // Grouped by what is being measured, not alphabetically — someone picking a
  // unit knows whether they are counting, weighing or measuring length, and
  // scanning one group beats scanning 50 codes.
  //
  // Codes follow India's GST UQC list wherever it defines one, so an item's
  // unit can go onto an invoice or e-way bill unchanged. The handful UQC has
  // no code for (reels, sheets, feet, millimetres) are marked below; they are
  // here because electronics stock genuinely arrives that way.

  // --- count ---
  { short: 'PCS', full: 'Pieces' },
  { short: 'NOS', full: 'Numbers' },
  { short: 'EA',  full: 'Each' },
  { short: 'SET', full: 'Sets' },
  { short: 'PRS', full: 'Pairs' },
  { short: 'UNT', full: 'Units' },
  { short: 'DOZ', full: 'Dozens (12 items)' },
  { short: 'GRS', full: 'Gross (144 items)' },
  { short: 'GGK', full: 'Great Gross (1728 items)' },
  { short: 'TGM', full: 'Ten Gross (1440 items)' },
  { short: 'THD', full: 'Thousands' },
  { short: 'BOU', full: 'Billion of Units' },

  // --- packaging ---
  { short: 'BOX', full: 'Box' },
  { short: 'CTN', full: 'Cartons' },
  { short: 'PAC', full: 'Packs/Package' },
  { short: 'BAG', full: 'Bags' },
  { short: 'BAL', full: 'Bale' },
  { short: 'BDL', full: 'Bundles' },
  { short: 'BUN', full: 'Bunches' },
  { short: 'ROL', full: 'Rolls' },
  { short: 'REL', full: 'Reels (no UQC code — SMD tape-and-reel)' },
  { short: 'SHT', full: 'Sheets (no UQC code — PCB, stencils)' },
  { short: 'BTL', full: 'Bottles' },
  { short: 'CAN', full: 'Cans' },
  { short: 'DRM', full: 'Drums' },
  { short: 'TUB', full: 'Tubes' },
  { short: 'BKL', full: 'Buckles' },
  { short: 'TBS', full: 'Tablets' },

  // --- weight ---
  { short: 'GMS', full: 'Grams' },
  { short: 'KGS', full: 'Kilograms' },
  { short: 'QTL', full: 'Quintal (100 kg)' },
  { short: 'TON', full: 'Tonnes' },
  { short: 'MTS', full: 'Metric Tonnes' },

  // --- length ---
  { short: 'MMT', full: 'Millimetres (no UQC code)' },
  { short: 'CMS', full: 'Centimeters' },
  { short: 'MTR', full: 'Meters' },
  { short: 'KME', full: 'Kilometres' },
  { short: 'FTS', full: 'Feet (no UQC code)' },
  { short: 'YDS', full: 'Yards' },
  { short: 'GYD', full: 'Gross Yards' },

  // --- area ---
  { short: 'SQF', full: 'Square Feet' },
  { short: 'SQM', full: 'Square Meters' },
  { short: 'SQY', full: 'Square Yards' },

  // --- volume ---
  { short: 'MLT', full: 'Millilitres' },
  { short: 'LTR', full: 'Litres' },
  { short: 'KLR', full: 'Kilolitres' },
  { short: 'CCM', full: 'Cubic Centimeters' },
  { short: 'CBM', full: 'Cubic Meters' },
  { short: 'UGS', full: 'US Gallons' },

  // --- time ---
  { short: 'HRS', full: 'Hours' },
];

export const STOCK_FILTER_OPTIONS = [
  { value: 'available', label: 'Available (In Stock)' },
  { value: 'low', label: 'Low Stock' },
  { value: 'out', label: 'Out of Stock' },
];

export const ALL_COLUMNS = [
  { key: 'serial', label: 'S.No', removable: false },
  { key: 'name', label: 'Item Name', removable: false },
  { key: 'stock', label: 'Stock', removable: false },
  { key: 'unit', label: 'Unit', removable: false },
  { key: 'rack', label: 'Rack Address', removable: false },
  { key: 'container', label: 'Container', removable: false },
  { key: 'tray', label: 'Tray', removable: false },
  { key: 'category', label: 'Category', removable: false },
  { key: 'department', label: 'Department', removable: false },
  { key: 'project', label: 'Projects', removable: false },
  { key: 'updated', label: 'Last Edited', removable: false },
];

// "3 minutes ago" for anything recent, an actual date once it stops being
// news. Recency is the whole point of the column — "12-09-2026" does not tell
// you at a glance that somebody touched this item while you were reading.
//
// No timestamp means nobody has hand-edited this item since it was added. That
// is said plainly rather than shown as a dash, because a dash in a date column
// reads as missing data rather than as an answer.
const fmtEdited = (ts?: string) => {
  if (!ts) return { short: 'never edited', full: 'No hand edit recorded since this item was added' };
  const dt = new Date(ts);
  const mins = Math.round((Date.now() - dt.getTime()) / 60000);
  const full = `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}` +
               ` ${String(dt.getHours()).padStart(2, '0')}:${String(dt.getMinutes()).padStart(2, '0')}`;
  if (mins < 1) return { short: 'just now', full };
  if (mins < 60) return { short: `${mins} min ago`, full };
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return { short: `${hrs} hr${hrs === 1 ? '' : 's'} ago`, full };
  const days = Math.round(hrs / 24);
  if (days <= 7) return { short: `${days} day${days === 1 ? '' : 's'} ago`, full };
  return { short: full.split(' ')[0], full };
};

export const getUnitFull = (short: string, units: UnitDef[]) =>
  units.find(u => u.short === short?.toUpperCase())?.full || short;

// ColumnFilter is now imported from '@/components/ui'

// --- UnitAutocomplete sub-component ---

interface UnitAutocompleteProps {
  value: string;
  onSave: (val: string) => void;
  units: UnitDef[];
}

function UnitAutocomplete({ value, onSave, units }: UnitAutocompleteProps) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(value || '');
  const [suggestions, setSuggestions] = useState<UnitDef[]>([]);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);

  const handleChange = (v: string) => {
    setInput(v);
    if (v.length > 0) {
      const q = v.toUpperCase();
      setSuggestions(units.filter(u => u.short.includes(q) || u.full.toUpperCase().includes(q)).slice(0, 6));
    } else {
      setSuggestions([]);
    }
  };

  const handleSelect = (unit: UnitDef) => {
    setInput(unit.short);
    setSuggestions([]);
    setEditing(false);
    onSave(unit.short);
  };

  const handleBlur = () => {
    setTimeout(() => { if (input !== value) onSave(input); setEditing(false); setSuggestions([]); }, 150);
  };

  if (!editing) {
    return (
      <span onClick={() => { setEditing(true); setInput(value || ''); }} className="cursor-pointer hover:bg-surface px-1 py-0.5 rounded text-sm" title={getUnitFull(value, units)}>
        {value || '-'}
      </span>
    );
  }

  return (
    <div className="relative">
      <input ref={ref} value={input} onChange={(e) => handleChange(e.target.value)} onBlur={handleBlur}
        onKeyDown={(e) => { if (e.key === 'Enter') handleBlur(); if (e.key === 'Escape') setEditing(false); }}
        className="w-20 px-2 py-1 border border-line rounded text-sm focus:border-brand outline-none" />
      {suggestions.length > 0 && (
        <div className="absolute z-50 top-full left-0 mt-1 bg-card border border-line rounded-lg shadow-lg w-56 max-h-48 overflow-y-auto">
          {suggestions.map(u => (
            <button key={u.short} onMouseDown={(e) => { e.preventDefault(); handleSelect(u); }}
              className="w-full text-left px-3 py-2 hover:bg-brand/10 flex items-center justify-between text-sm">
              <span className="font-bold text-ink">{u.short}</span>
              <span className="text-muted text-xs">{u.full}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Project pill editor (multi-select) ---
// Read-only mode shows project tags; click Edit to open an inline toggle picker.
interface ProjectPillEditorProps {
  row: any;
  projects: any[];
  isReadOnly: boolean;
  onSave: (projectIds: string[]) => void;
}

const ProjectPillEditor: React.FC<ProjectPillEditorProps> = ({ row, projects, isReadOnly, onSave }) => {
  const linked: any[] = row?.projects || [];
  const linkedIds: string[] = linked.map((p: any) => p.id);
  const [editing, setEditing] = useState(false);
  const [draftIds, setDraftIds] = useState<string[]>(linkedIds);
  const navigate = useNavigate();

  const renderTags = () => (
    <div className="flex items-center gap-1 flex-wrap">
      {linked.length > 0
        ? linked.map((p: any) => (
            // The quantity is what makes this a reservation rather than a
            // label, so show it. A project carrying 0 is still a legitimate
            // state — tagged as relevant, nothing set aside yet — and reads as
            // "Gateway · none" so it isn't mistaken for a missing number.
            // A button, not a span: the tag opens Allot Items already
            // narrowed to this item and this project, which is where every
            // question the tag raises ("how much? where does it sit? change
            // it?") gets answered. Keyboard-reachable for the same reason.
            <button
              key={p.id}
              type="button"
              onClick={() => navigate(
                `/inventory/allot?tab=allotted&project=${encodeURIComponent(p.id)}&item=${encodeURIComponent(row?.name ?? '')}`,
              )}
              title={
                (p.allottedQty > 0
                  ? `${p.allottedQty} reserved for ${p.name} — cannot be issued to another project`
                  : `Tagged to ${p.name}, but none of the stock is reserved for it yet`)
                + '. Click to open this item on Allot Items.'
              }
              className={`text-[9px] px-1.5 py-0.5 rounded-full font-bold border transition-colors hover:brightness-95 focus:outline-none focus:ring-1 focus:ring-brand ${
                p.allottedQty > 0
                  ? 'bg-violet-50 dark:bg-violet-400/15 text-violet-700 dark:text-violet-300 border-violet-200 dark:border-violet-400/30'
                  : 'bg-surface text-faint border-line'
              }`}
            >
              {p.name} {p.allottedQty > 0 ? `· ${p.allottedQty}` : '· none'}
            </button>
          ))
        : <span className="text-[10px] text-faint italic">No projects</span>}
      {!isReadOnly && (
        <button onClick={() => { setEditing(true); setDraftIds(linkedIds); }} className="text-[10px] text-brand font-bold hover:underline ml-1">Edit</button>
      )}
    </div>
  );

  if (!editing) return renderTags();

  const toggle = (id: string) =>
    setDraftIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {projects.map((p: any) => (
          <button
            key={p.id}
            onClick={() => toggle(p.id)}
            className={`px-2 py-0.5 text-[10px] font-bold rounded-full border transition-colors ${draftIds.includes(p.id) ? 'bg-violet-500 text-ink border-violet-500' : 'bg-surface text-muted border-line hover:border-violet-400'}`}
          >
            {p.name}
          </button>
        ))}
        {projects.length === 0 && <span className="text-[10px] text-faint italic">No projects defined yet.</span>}
      </div>
      <div className="flex gap-1">
        <button onClick={() => { onSave(draftIds); setEditing(false); }} className="text-[10px] text-green-700 dark:text-green-300 font-bold bg-green-50 dark:bg-green-400/15 px-2 py-0.5 rounded">Save</button>
        <button onClick={() => setEditing(false)} className="text-[10px] text-faint font-bold bg-surface px-2 py-0.5 rounded">Cancel</button>
      </div>
    </div>
  );
};

// --- InventoryTable component ---

export interface InventoryTableProps {
  items: any[];
  allItems: any[];
  isLoading: boolean;
  isReadOnly: boolean;
  visibleCols: string[];
  /** "Last edited" range, as YYYY-MM-DD. Server-side, inclusive of both days. */
  updatedFrom?: string;
  updatedTo?: string;
  onUpdatedRangeChange?: (from: string, to: string) => void;
  /** null = default (by name); 'recent'/'oldest' sort by when it was touched. */
  editedSort?: 'recent' | 'oldest' | null;
  onEditedSortChange?: () => void;
  /** Open one item's full history. */
  onShowHistory?: (item: any) => void;
  stockSort: 'none' | 'asc' | 'desc';
  onStockSortChange: () => void;
  stockFilter: string;
  onStockFilterChange: (v: string) => void;
  filters: Record<string, string>;
  onFilterChange: (key: string, val: string) => void;
  lowStockThreshold: number;
  units: UnitDef[];
  customCategories: CategoryDef[];
  departments: any[];
  projects: any[];
  customColumns: any[];
  onUpdateField: (id: string, field: string, value: any) => void;
  onSaveCustomValue: (columnId: string, itemId: string, value: string) => void;
  tableRef: React.RefObject<HTMLDivElement>;
  // Server-provided distinct values for the column-filter dropdowns. When
  // supplied (server-paginated mode), the dropdowns use these instead of
  // deriving options from the loaded rows — so filters stay complete even
  // though only one page is in memory. Falls back to row-derived when absent.
  filterOptions?: {
    names?: string[];
    units: string[];
    racks: string[];
    containers: string[];
    trays: string[];
    projects: { id: string; name: string }[];
    customValues: Record<string, string[]>;
  } | null;
  // Bulk selection — wired by ComponentManagementPage. When omitted, the checkbox column is hidden.
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  onToggleSelectAllVisible?: (allVisibleIds: string[]) => void;
  // Audited stock adjustment. When provided (INVENTORY / SUPER_ADMIN only — the
  // roles the /adjust endpoint authorizes), the stock cell shows a small button
  // that opens the AdjustStockModal. Omitted ⇒ no button (e.g. ADMIN, who can
  // raw-edit stock but isn't authorized to post audited adjustments).
  onAdjustStock?: (row: any) => void;
  // Archive a single item. When provided AND not read-only, each row gets an
  // archive action. Omitted ⇒ no per-row archive.
  onArchiveItem?: (row: any) => void;
}

export const InventoryTable: React.FC<InventoryTableProps> = ({
  items,
  allItems,
  isLoading,
  isReadOnly,
  visibleCols,
  updatedFrom = '',
  updatedTo = '',
  onUpdatedRangeChange,
  editedSort = null,
  onEditedSortChange,
  onShowHistory,
  stockSort,
  onStockSortChange,
  stockFilter,
  onStockFilterChange,
  filters,
  onFilterChange,
  lowStockThreshold,
  units,
  customCategories,
  departments,
  projects,
  customColumns,
  onUpdateField,
  onSaveCustomValue,
  tableRef,
  filterOptions,
  selectedIds,
  onToggleSelect,
  onToggleSelectAllVisible,
  onAdjustStock,
  onArchiveItem,
}) => {
  // Prefer the server-provided distinct values (full scoped set) so the filter
  // dropdowns stay complete under pagination; fall back to deriving from the
  // loaded rows when not supplied (back-compat for any other caller).
  const fo = filterOptions;
  const uniqueUnits: string[] = fo ? fo.units : [...new Set(allItems.map(i => i.unit).filter(Boolean) as string[])];
  // Build a unique project filter list from every project linked to any item.
  const uniqueProjects: { value: string; label: string }[] = fo
    ? fo.projects.map(p => ({ value: p.id, label: p.name }))
    : [...new Map<string, { value: string; label: string }>(
        allItems.flatMap((i: any) => (i.projects || []).map((p: any) => [p.id, { value: p.id, label: p.name }] as [string, { value: string; label: string }]))
      ).values()];
  const uniqueNames = (fo?.names ?? [...new Set(allItems.map(i => i.name).filter(Boolean) as string[])]).map(v => ({ value: String(v), label: String(v) }));
  const uniqueRacks = (fo ? fo.racks : [...new Set(allItems.map(i => i.rackAddress).filter(Boolean) as string[])]).map(v => ({ value: String(v), label: String(v) }));
  const uniqueContainers = (fo ? fo.containers : [...new Set(allItems.map(i => i.containerName).filter(Boolean) as string[])]).map(v => ({ value: String(v), label: String(v) }));
  const uniqueTrays = (fo ? fo.trays : [...new Set(allItems.map(i => i.trayNumber).filter(Boolean) as string[])]).map(v => ({ value: String(v), label: String(v) }));

  // When selection is wired AND we're not in read-only, DataTable will prepend its own
  // built-in S.No selector column. In that mode, omit our plain S.No column to avoid duplication.
  const selectable = !!(selectedIds && onToggleSelect && onToggleSelectAllVisible && !isReadOnly);

  const buildColumns = () => {
    const cols: any[] = [];
    const vis = new Set(visibleCols);

    if (vis.has('serial') && !selectable) {
      cols.push({
        header: 'S.No',
        accessor: (row: any) => <span data-serial={row._serial} className="text-xs text-faint font-mono">{row._serial}</span>,
      });
    }
    if (vis.has('name')) cols.push({
      filterActive: !!filters.name,
      header: <span className="inline-flex items-center">Item Name<ColumnFilter searchable options={uniqueNames} value={filters.name || ''} onChange={(v) => onFilterChange('name', v)} /></span>,
      accessor: (row: any) => (
        <div className="flex flex-col items-start gap-0.5">
          {isReadOnly
            ? <span className="font-medium text-ink">{row.name}</span>
            : <EditableCell value={row.name} onSave={(val) => onUpdateField(row.id, 'name', val)} />}
          <button
            type="button"
            disabled={isReadOnly}
            onClick={() => !isReadOnly && onUpdateField(row.id, 'isShared', !row.isShared)}
            title={row.isShared
              ? 'Shared org-wide — click to make dept-only'
              : 'Currently dept-only — click to mark as shared org-wide'}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold rounded-full border transition-colors ${
              row.isShared
                ? 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30 hover:bg-emerald-100 dark:bg-emerald-400/20'
                : 'bg-surface text-muted border-line hover:bg-hover'
            } ${isReadOnly ? 'cursor-default opacity-80' : 'cursor-pointer'}`}
          >
            {row.isShared ? '🌐 Shared' : '🔒 Dept-only'}
          </button>
        </div>
      )
    });
    if (vis.has('stock')) cols.push({
      filterActive: !!stockFilter,
      header: <span className="inline-flex items-center gap-1">
        <button onClick={onStockSortChange} className="inline-flex items-center gap-1 hover:text-brand transition-colors">
          Stock
          <span className="text-[10px]">{stockSort === 'asc' ? '\u2191' : stockSort === 'desc' ? '\u2193' : '\u2195'}</span>
        </button>
        <ColumnFilter options={STOCK_FILTER_OPTIONS} value={stockFilter} onChange={onStockFilterChange} />
      </span>,
      accessor: (row: any) => {
        const s = row.stock || 0;
        const color = stockColorClass(s, lowStockThreshold);
        if (isReadOnly) return <span className={`font-bold ${color}`}>{s}</span>;
        // One way to change stock: Adjust Stock (add or remove, with a reason
        // kept in Item History). The count used to be typeable in place too,
        // a second way to do the same thing (owner, 29 Oct).
        if (onAdjustStock) {
          return (
            <button
              type="button"
              onClick={() => onAdjustStock(row)}
              title="Adjust stock — add or remove, with a reason"
              aria-label={`Adjust stock of ${row.name}: ${s}`}
              className="group inline-flex items-center gap-1 rounded px-1 -mx-1 hover:bg-brand/10 transition-colors"
            >
              <span className={`font-bold ${color}`}>{s}</span>
              <SlidersHorizontal className="w-3.5 h-3.5 text-faint group-hover:text-brand transition-colors" />
            </button>
          );
        }
        return <span className={`font-bold ${color}`}>{s}</span>;
      }
    });
    if (vis.has('unit')) cols.push({
      filterActive: !!filters.unit,
      header: <span className="inline-flex items-center">Unit<ColumnFilter searchable options={uniqueUnits.map(u => ({ value: u, label: u }))} value={filters.unit || ''} onChange={(v) => onFilterChange('unit', v)} /></span>,
      accessor: (row: any) => isReadOnly ? <span className="text-muted">{row.unit}</span> : <UnitAutocomplete value={row.unit} onSave={(val) => onUpdateField(row.id, 'unit', val)} units={units} />
    });
    if (vis.has('rack')) cols.push({
      filterActive: !!filters.rack,
      header: <span className="inline-flex items-center">Rack Address<ColumnFilter searchable options={uniqueRacks} value={filters.rack || ''} onChange={(v) => onFilterChange('rack', v)} /></span>,
      accessor: (row: any) => isReadOnly ? <span className="text-muted">{row.rackAddress || '-'}</span> : <EditableCell value={row.rackAddress || '-'} onSave={(val) => onUpdateField(row.id, 'rackAddress', val)} />
    });
    if (vis.has('container')) cols.push({
      filterActive: !!filters.container,
      header: <span className="inline-flex items-center">Container<ColumnFilter searchable options={uniqueContainers} value={filters.container || ''} onChange={(v) => onFilterChange('container', v)} /></span>,
      accessor: (row: any) => isReadOnly ? <span className="text-muted">{row.containerName || '-'}</span> : <EditableCell value={row.containerName || '-'} onSave={(val) => onUpdateField(row.id, 'containerName', val)} />
    });
    if (vis.has('tray')) cols.push({
      filterActive: !!filters.tray,
      header: <span className="inline-flex items-center">Tray<ColumnFilter searchable options={uniqueTrays} value={filters.tray || ''} onChange={(v) => onFilterChange('tray', v)} /></span>,
      accessor: (row: any) => isReadOnly ? <span className="text-muted">{row.trayNumber || '-'}</span> : <EditableCell value={row.trayNumber || '-'} onSave={(val) => onUpdateField(row.id, 'trayNumber', val)} />
    });
    if (vis.has('category')) cols.push({
      filterActive: !!filters.category,
      header: <span className="inline-flex items-center">Category<ColumnFilter options={customCategories} value={filters.category || ''} onChange={(v) => onFilterChange('category', v)} /></span>,
      accessor: (row: any) => isReadOnly ? <span className="text-muted">{customCategories.find(c => c.value === row.category)?.label || row.category}</span> : <EditableCell type="select" options={customCategories} value={row.category} onSave={(val) => onUpdateField(row.id, 'category', val)} />
    });
    if (vis.has('department')) cols.push({
      filterActive: !!filters.department,
      header: <span className="inline-flex items-center">Department<ColumnFilter options={departments.map((d: any) => ({ value: d.id, label: d.name }))} value={filters.department || ''} onChange={(v) => onFilterChange('department', v)} /></span>,
      accessor: (row: any) => isReadOnly ? <span className="text-muted">{departments.find(d => d.id === row.departmentId)?.name || 'N/A'}</span> : <EditableCell type="select" options={departments.map((d: any) => ({ value: d.id, label: d.name }))} value={row.departmentId || ''} onSave={(val) => onUpdateField(row.id, 'departmentId', val)} />
    });
    if (vis.has('project')) cols.push({
      filterActive: !!filters.project,
      header: <span className="inline-flex items-center">Projects<ColumnFilter options={[...uniqueProjects]} value={filters.project || ''} onChange={(v) => onFilterChange('project', v)} /></span>,
      accessor: (row: any) => <ProjectPillEditor row={row} projects={projects} isReadOnly={isReadOnly} onSave={(ids) => onUpdateField(row.id, 'projectIds', ids)} />
    });

    // When a PERSON last changed this item, and a way into its full story.
    //
    // Reads `lastEditedAt`, not `updatedAt`. `updatedAt` moves on any write to
    // the row, so an item that merely had stock issued against it looked
    // freshly edited — which made the column useless for its actual purpose,
    // finding what people have been changing. Hovering names who made the
    // change; the full movement history is one click away.
    if (vis.has('updated')) cols.push({
      filterActive: !!(updatedFrom || updatedTo),
      header: (
        <span className="inline-flex items-center">
          <button
            type="button"
            onClick={onEditedSortChange}
            className="inline-flex items-center gap-0.5 hover:text-brand"
            title={
              editedSort === 'recent' ? 'Newest first — click for oldest first'
              : editedSort === 'oldest' ? 'Oldest first — click to sort by name again'
              : 'Sort by when it was last touched'
            }
          >
            Last Edited
            {editedSort === 'recent' ? ' ↓' : editedSort === 'oldest' ? ' ↑' : ''}
          </button>
          <ColumnFilter
            options={[]}
            value=""
            onChange={() => {}}
            allLabel="Any time"
            range={{
              from: updatedFrom,
              to: updatedTo,
              onChange: (f, t) => onUpdatedRangeChange?.(f, t),
            }}
          />
        </span>
      ),
      accessor: (row: any) => {
        const { short, full } = fmtEdited(row.lastEditedAt);
        const who = row.lastEditedBy?.name;
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span
              className={`text-xs ${row.lastEditedAt ? 'text-muted' : 'text-faint italic'}`}
              title={who ? `${full} — by ${who}` : full}
            >{short}</span>
            {onShowHistory && (
              <button
                type="button"
                onClick={() => onShowHistory(row)}
                className="text-[10px] font-bold text-brand underline decoration-dotted underline-offset-2 hover:text-brand-700"
                title={`Show everything that has happened to ${row.name}`}
              >history</button>
            )}
          </span>
        );
      },
    });

    // Append custom columns
    for (const col of customColumns) {
      const colId = col.id;
      const fk = `custom_${colId}`;
      const hasOptions = col.filterOptions && col.filterOptions.length > 0;
      const existingVals: string[] = fo
        ? (fo.customValues[colId] || [])
        : [...new Set(allItems.map((i: any) => i.customValues?.[colId]).filter(Boolean) as string[])];
      const allOptions = hasOptions
        ? [...new Set([...col.filterOptions, ...existingVals])].map((v: string) => ({ value: v, label: v }))
        : existingVals.map((v: string) => ({ value: v, label: v }));
      cols.push({
        filterActive: !!filters[fk],
        header: <span className="inline-flex items-center">{col.name}<ColumnFilter searchable options={allOptions} value={filters[fk] || ''} onChange={(v) => onFilterChange(fk, v)} /></span>,
        accessor: (row: any) => {
          const val = row.customValues?.[colId] || '';
          if (isReadOnly) return <span className="text-muted">{val || '-'}</span>;
          if (hasOptions) {
            const selectOpts = [{ value: '', label: '-' }, ...col.filterOptions.map((o: string) => ({ value: o, label: o }))];
            return <EditableCell type="select" options={selectOpts} value={val} onSave={(v) => onSaveCustomValue(colId, row.id, String(v))} />;
          }
          return <EditableCell type={col.fieldType === 'number' ? 'number' : 'text'} value={val || '-'} onSave={(v) => onSaveCustomValue(colId, row.id, String(v))} />;
        },
      });
    }

    // Per-row archive. Shown only when editing is allowed and a handler is
    // wired. The dialog it opens says what happens to open requests first.
    if (onArchiveItem && !isReadOnly) {
      cols.push({
        header: <span className="sr-only">Archive</span>,
        // Understated on purpose — archiving an item is rare. Muted icon that
        // only reddens on hover, no label.
        accessor: (row: any) => (
          <button
            onClick={() => onArchiveItem(row)}
            title="Archive this item"
            aria-label="Archive this item"
            className="text-faint hover:text-red-700 dark:text-red-300 p-1 rounded hover:bg-red-50 dark:bg-red-400/15 transition-colors"
          >
            <Archive size={14} />
          </button>
        ),
      });
    }

    return cols;
  };

  return (
    <div ref={tableRef} className="bg-card rounded-lg shadow-sm border border-zebra overflow-hidden">
      <DataTable
        columns={buildColumns()}
        data={items}
        isLoading={isLoading}
        keyExtractor={r => r.id}
        emptyStateMessage="No inventory components found."
        maxHeight="60vh"
        selectedIds={selectable ? selectedIds : undefined}
        onToggleSelect={selectable ? onToggleSelect : undefined}
        onToggleSelectAllVisible={selectable ? onToggleSelectAllVisible : undefined}
      />
    </div>
  );
};
