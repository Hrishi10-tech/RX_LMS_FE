import React, { useState } from 'react';
import { Modal, NumberInput } from '@/components/ui';
import { Plus, Trash2 } from 'lucide-react';
import { useToast } from '@/context/ToastContext';
import { useAuth } from '@/hooks';
import { ALL_COLUMNS } from './InventoryTable';
import type { CategoryDef, UnitDef } from './InventoryTable';

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string | undefined;
  visibleCols: string[];
  onToggleColumn: (key: string) => void;
  uploadHistory: any[];
  onUndoBatch: (batchId: string) => void;
  customColumns: any[];
  onCreateCustomColumn: (data: {
    name: string; fieldType: string; visibility: string;
    visibleToRoles: string[]; visibleToDepts: string[];
    filterOptions: string[];
  }) => void;
  onUpdateColumn: (colId: string, data: any) => void;
  onDeleteCustomColumn: (colId: string) => void;
  lowStockThreshold: number;
  onLowStockThresholdChange: (val: number) => void;
  customCategories: CategoryDef[];
  /** Per-category needsApproval flag (drives whether indents in that category need tech approval). */
  categoryApproval: Record<string, boolean>;
  onToggleCategoryApproval: (category: string, needsApproval: boolean) => void;
  units: UnitDef[];
  onAddUnit: (short: string, full: string) => void;
  onRemoveUnit: (short: string) => void;
  projects: any[];
  departments: any[];
  onAddProject: (name: string) => void;
  onEditProject: (id: string, name: string) => void;
  onDeleteProject: (id: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen, onClose, userId, visibleCols, onToggleColumn,
  uploadHistory, onUndoBatch, customColumns,
  onCreateCustomColumn, onUpdateColumn, onDeleteCustomColumn,
  lowStockThreshold, onLowStockThresholdChange,
  customCategories,
  categoryApproval, onToggleCategoryApproval,
  units, onAddUnit, onRemoveUnit,
  projects, departments, onAddProject, onEditProject, onDeleteProject,
}) => {
  const { user } = useAuth();
  // Deleting a project is org-wide and Super Admin / Admin only on the server.
  const canDeleteProject = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN';
  const { addToast } = useToast();

  // Local state for settings form inputs
  const [newUnitShort, setNewUnitShort] = useState('');
  const [newUnitFull, setNewUnitFull] = useState('');
  const [newProjectName, setNewProjectName] = useState('');
  const [editingProject, setEditingProject] = useState<string | null>(null);
  const [editingProjectName, setEditingProjectName] = useState('');

  // Custom column form state
  const [newColName, setNewColName] = useState('');
  const [newColType, setNewColType] = useState('text');
  const [newColVisibility, setNewColVisibility] = useState('private');
  const [newColRoles, setNewColRoles] = useState<string[]>([]);
  const [newColDepts, setNewColDepts] = useState<string[]>([]);
  const [editingColOptions, setEditingColOptions] = useState<string | null>(null);
  const [editOptionInput, setEditOptionInput] = useState('');

  const handleAddUnit = () => {
    if (!newUnitShort.trim()) { addToast('Enter a unit code first.', 'error'); return; }
    onAddUnit(newUnitShort.trim().toUpperCase(), newUnitFull.trim() || newUnitShort.trim().toUpperCase());
    setNewUnitShort(''); setNewUnitFull('');
  };

  const handleAddProject = () => {
    if (!newProjectName.trim()) { addToast('Enter a project name first.', 'error'); return; }
    onAddProject(newProjectName.trim());
    setNewProjectName('');
  };

  const handleSaveEditProject = (id: string) => {
    if (!editingProjectName.trim()) return;
    onEditProject(id, editingProjectName.trim());
    setEditingProject(null);
  };

  const handleCreateColumn = () => {
    if (!newColName.trim()) return;
    onCreateCustomColumn({
      name: newColName, fieldType: newColType, visibility: newColVisibility,
      visibleToRoles: newColVisibility === 'roles' ? newColRoles : [],
      visibleToDepts: newColVisibility === 'departments' ? newColDepts : [],
      filterOptions: [],
    });
    setNewColName(''); setNewColType('text'); setNewColVisibility('private'); setNewColRoles([]); setNewColDepts([]);
  };

  const myColumns = customColumns.filter((c: any) => c.createdById === userId);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Table Settings">
      <div className="space-y-6 max-h-[70vh] overflow-y-auto p-1">
        {/* Visible Columns */}
        <div>
          <h3 className="text-sm font-bold text-ink mb-2">Visible Columns</h3>
          <div className="flex flex-wrap gap-2">
            {ALL_COLUMNS.map(col => (
              <button key={col.key} onClick={() => col.removable && onToggleColumn(col.key)}
                className={`px-3 py-1.5 text-xs font-bold rounded-full border transition-colors ${visibleCols.includes(col.key) ? 'bg-brand text-white border-brand' : 'bg-surface text-muted border-line hover:border-brand'} ${!col.removable ? 'opacity-70 cursor-not-allowed' : ''}`}>
                {col.label}
              </button>
            ))}
          </div>
        </div>

        {/* Custom Columns */}
        <div>
          <h3 className="text-sm font-bold text-ink mb-2">Custom Columns ({myColumns.length})</h3>
          {myColumns.length > 0 && (
            <div className="max-h-80 overflow-y-auto border border-line-soft rounded-lg mb-3">
              {myColumns.map((col: any) => (
                <div key={col.id} className="px-3 py-2 hover:bg-surface text-sm border-b border-line-soft last:border-0">
                  {editingColOptions === col.id ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-brand">Editing: {col.name}</span>
                        <div className="flex gap-1">
                          <button onClick={() => setEditingColOptions(null)} className="text-xs font-bold text-emerald-700 dark:text-emerald-300 hover:underline">Done</button>
                          <button onClick={() => onDeleteCustomColumn(col.id)} className="text-red-400 hover:text-red-700 dark:text-red-300"><Trash2 size={14} /></button>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <input type="text" defaultValue={col.name} onBlur={e => { if (e.target.value.trim() && e.target.value !== col.name) onUpdateColumn(col.id, { name: e.target.value.trim() }); }}
                          className="flex-1 px-2 py-1 border rounded text-sm focus:border-brand outline-none" />
                        <select defaultValue={col.fieldType} onChange={e => onUpdateColumn(col.id, { fieldType: e.target.value })}
                          className="px-2 py-1 border rounded text-xs focus:border-brand outline-none">
                          <option value="text">Text</option><option value="number">Number</option>
                        </select>
                      </div>
                      <select defaultValue={col.visibility} onChange={e => onUpdateColumn(col.id, { visibility: e.target.value, visibleToRoles: [], visibleToDepts: [] })}
                        className="w-full px-2 py-1 border rounded text-xs focus:border-brand outline-none">
                        <option value="private">Private (only me)</option>
                        <option value="roles">Visible to Roles</option>
                        <option value="departments">Visible to Departments</option>
                        <option value="all">Everyone</option>
                      </select>
                      {col.visibility === 'roles' && (
                        <div className="flex flex-wrap gap-1">
                          {['SUPER_ADMIN','ADMIN','MANAGER','USER','LAB','PROCUREMENT','INVENTORY','FINANCE','ASSOCIATE_FINANCE'].map(r => (
                            <button key={r} onClick={() => { const has = col.visibleToRoles?.includes(r); onUpdateColumn(col.id, { visibleToRoles: has ? col.visibleToRoles.filter((x: string) => x !== r) : [...(col.visibleToRoles || []), r] }); }}
                              className={`px-2 py-0.5 text-[10px] font-bold rounded-full border transition-colors ${col.visibleToRoles?.includes(r) ? 'bg-brand text-white border-brand' : 'bg-card text-muted border-line'}`}>{r.replace(/_/g, ' ')}</button>
                          ))}
                        </div>
                      )}
                      <div className="pl-2 border-l-2 border-brand/30">
                        <label className="text-[10px] font-bold text-muted">Dropdown Options (suggested when filling data)</label>
                        <div className="flex flex-wrap gap-1 mt-1 mb-1">
                          {(col.filterOptions || []).map((opt: string, i: number) => (
                            <span key={i} className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold bg-hover text-ink rounded-full">
                              {opt}
                              <button onClick={() => onUpdateColumn(col.id, { filterOptions: col.filterOptions.filter((_: any, j: number) => j !== i) })} className="text-red-400 hover:text-red-700 dark:text-red-300"><Trash2 size={9} /></button>
                            </span>
                          ))}
                          {(!col.filterOptions || col.filterOptions.length === 0) && <span className="text-[10px] text-faint">No options {'\u2014'} free text input</span>}
                        </div>
                        <div className="flex gap-1">
                          <input type="text" value={editOptionInput} onChange={ev => setEditOptionInput(ev.target.value)}
                            onKeyDown={ev => { if (ev.key === 'Enter' && editOptionInput.trim()) { onUpdateColumn(col.id, { filterOptions: [...(col.filterOptions || []), editOptionInput.trim()] }); setEditOptionInput(''); } }}
                            placeholder="Add option..." className="flex-1 px-2 py-1 border rounded text-[11px] focus:border-brand outline-none" />
                          <button onClick={() => { if (editOptionInput.trim()) { onUpdateColumn(col.id, { filterOptions: [...(col.filterOptions || []), editOptionInput.trim()] }); setEditOptionInput(''); } }}
                            className="px-2 py-1 bg-brand text-white text-[10px] font-bold rounded-full hover:bg-brand-dark"><Plus size={10} /></button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="font-bold text-ink">{col.name}</span>
                        <span className="text-[10px] text-faint ml-2">{col.fieldType}{col.filterOptions?.length > 0 ? ` ${'\u00B7'} ${col.filterOptions.length} options` : ''}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <button onClick={() => setEditingColOptions(col.id)} className="text-brand hover:text-brand-dark text-xs font-bold">Edit</button>
                        <button onClick={() => onDeleteCustomColumn(col.id)} className="text-red-400 hover:text-red-700 dark:text-red-300"><Trash2 size={14} /></button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className="space-y-2 border border-line-soft rounded-lg p-3 bg-surface/50">
            <input type="text" value={newColName} onChange={(e) => setNewColName(e.target.value)} placeholder="Column name..." className="w-full px-2 py-1.5 border rounded text-sm focus:border-brand outline-none bg-card" />
            <div className="flex gap-2">
              <select value={newColType} onChange={(e) => setNewColType(e.target.value)} className="px-2 py-1.5 border rounded text-xs bg-card focus:border-brand outline-none">
                <option value="text">Text</option><option value="number">Number</option>
              </select>
              <select value={newColVisibility} onChange={(e) => { setNewColVisibility(e.target.value); setNewColRoles([]); setNewColDepts([]); }} className="flex-1 px-2 py-1.5 border rounded text-xs bg-card focus:border-brand outline-none">
                <option value="private">Private (only me)</option>
                <option value="roles">Visible to Roles</option>
                <option value="departments">Visible to Departments</option>
                <option value="all">Everyone</option>
              </select>
            </div>
            {newColVisibility === 'roles' && (
              <div className="flex flex-wrap gap-1">
                {['SUPER_ADMIN','ADMIN','MANAGER','USER','LAB','PROCUREMENT','INVENTORY','FINANCE','ASSOCIATE_FINANCE'].map(r => (
                  <button key={r} onClick={() => setNewColRoles(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r])}
                    className={`px-2 py-0.5 text-[10px] font-bold rounded-full border transition-colors ${newColRoles.includes(r) ? 'bg-brand text-white border-brand' : 'bg-card text-muted border-line'}`}>{r.replace(/_/g, ' ')}</button>
                ))}
              </div>
            )}
            {newColVisibility === 'departments' && (
              <div className="flex flex-wrap gap-1">
                {departments.map((d: any) => (
                  <button key={d.id} onClick={() => setNewColDepts(prev => prev.includes(d.id) ? prev.filter(x => x !== d.id) : [...prev, d.id])}
                    className={`px-2 py-0.5 text-[10px] font-bold rounded-full border transition-colors ${newColDepts.includes(d.id) ? 'bg-brand text-white border-brand' : 'bg-card text-muted border-line'}`}>{d.name}</button>
                ))}
              </div>
            )}
            <button onClick={handleCreateColumn} disabled={!newColName.trim()} className="w-full px-3 py-1.5 bg-brand text-white text-xs font-bold rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50 flex items-center justify-center gap-1"><Plus size={14} /> Add Column</button>
          </div>
        </div>

        {/* Low Stock Threshold */}
        <div>
          <h3 className="text-sm font-bold text-ink mb-2">Low Stock Threshold</h3>
          <p className="text-xs text-muted mb-2">Stock below this number shows as yellow. Zero shows as red.</p>
          <div className="flex items-center gap-3">
            <NumberInput min={1} value={lowStockThreshold} onChange={onLowStockThresholdChange}
              className="w-24 px-3 py-1.5 border rounded text-sm focus:border-brand outline-none" />
            <div className="flex items-center gap-2 text-xs">
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-green-500"></span> {'\u2265'} {lowStockThreshold}</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span> 1{'\u2013'}{lowStockThreshold - 1}</span>
              <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full bg-red-500"></span> 0</span>
            </div>
          </div>
        </div>

        {/* Manage Categories */}
        <div>
          <h3 className="text-sm font-bold text-ink mb-1">Categories ({customCategories.length})</h3>
          <p className="text-[11px] text-muted mb-2">
            Tick <span className="font-bold">Needs Approval</span> for categories that should require Tech approval when used on an indent.
            Unticked categories (low-value consumables) fast-track to procurement.
          </p>
          {/* Add / Edit / Delete used to sit here and did NOT work: the list was
              component state seeded from a hardcoded array, so every change was
              lost on close while the UI reported success. Worse, a made-up
              category was then offered in the item form AND the bulk-edit
              category picker — and `InventoryItem.category` is a Prisma ENUM,
              so applying one could only ever fail validation.
              The Needs-Approval toggle below is the real, persisted control
              (PATCH /inventory/category-settings), so it stays. */}
          <p className="text-[11px] text-faint mb-2 italic">
            The category set itself is fixed in this build — adding one needs a code change, because a
            category is a database enum value that items are validated against.
          </p>
          <div className="max-h-56 overflow-y-auto border border-line-soft rounded-lg mb-1">
            <div className="grid grid-cols-[1fr_110px] gap-2 px-3 py-1.5 bg-surface text-[10px] font-bold text-muted uppercase tracking-wider border-b border-line-soft">
              <span>Category</span>
              <span className="text-center">Needs Approval</span>
            </div>
            {customCategories.map(c => (
              <div key={c.value} className="grid grid-cols-[1fr_110px] gap-2 items-center px-3 py-1.5 hover:bg-surface text-sm border-b border-line-soft last:border-0">
                <span className="font-bold text-ink truncate" title={c.label}>{c.label}</span>
                <label className="inline-flex items-center justify-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!!categoryApproval[c.value]}
                    onChange={(e) => onToggleCategoryApproval(c.value, e.target.checked)}
                    className="h-4 w-4 rounded border-line text-brand focus:ring-brand cursor-pointer"
                  />
                </label>
              </div>
            ))}
          </div>
        </div>

        {/* Manage Units */}
        <div>
          <h3 className="text-sm font-bold text-ink mb-2">Units ({units.length})</h3>
          <div className="max-h-40 overflow-y-auto border border-line-soft rounded-lg mb-3">
            {units.map(u => (
              <div key={u.short} className="flex items-center justify-between px-3 py-1.5 hover:bg-surface text-sm">
                <div><span className="font-bold text-ink">{u.short}</span> <span className="text-muted text-xs">{'\u2014'} {u.full}</span></div>
                <button onClick={() => onRemoveUnit(u.short)} className="text-red-400 hover:text-red-700 dark:text-red-300"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" value={newUnitShort} onChange={(e) => setNewUnitShort(e.target.value)} placeholder="Code (e.g. FT)" className="w-20 px-2 py-1.5 border rounded text-sm focus:border-brand outline-none" />
            <input type="text" value={newUnitFull} onChange={(e) => setNewUnitFull(e.target.value)} placeholder="Full name (e.g. Feet)" className="flex-1 px-2 py-1.5 border rounded text-sm focus:border-brand outline-none" />
            <button onClick={handleAddUnit} className="px-3 py-1.5 bg-brand text-white text-xs font-bold rounded-full hover:bg-brand-dark transition-colors"><Plus size={14} /></button>
          </div>
        </div>

        {/* Manage Projects */}
        <div>
          <h3 className="text-sm font-bold text-ink mb-2">Projects ({projects.length})</h3>
          <div className="max-h-40 overflow-y-auto border border-line-soft rounded-lg mb-3">
            {projects.map(p => (
              <div key={p.id} className="flex items-center justify-between px-3 py-1.5 hover:bg-surface text-sm">
                {editingProject === p.id ? (
                  <div className="flex items-center gap-2 flex-1">
                    <input type="text" value={editingProjectName} onChange={(e) => setEditingProjectName(e.target.value)}
                      className="flex-1 px-2 py-1 border rounded text-sm focus:border-brand outline-none" />
                    <button onClick={() => handleSaveEditProject(p.id)} className="text-green-700 dark:text-green-300 text-xs font-bold">Save</button>
                    <button onClick={() => setEditingProject(null)} className="text-faint text-xs font-bold">Cancel</button>
                  </div>
                ) : (
                  <>
                    <div><span className="font-bold text-ink">{p.name}</span></div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => { setEditingProject(p.id); setEditingProjectName(p.name); }} className="text-brand hover:text-brand-dark text-xs font-bold">Edit</button>
                      {canDeleteProject && <button onClick={() => onDeleteProject(p.id)} className="text-red-400 hover:text-red-700 dark:text-red-300" title="Delete project"><Trash2 size={14} /></button>}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input type="text" value={newProjectName} onChange={(e) => setNewProjectName(e.target.value)} placeholder="Add new project..." className="flex-1 px-2 py-1.5 border rounded text-sm focus:border-brand outline-none" />
            <button onClick={handleAddProject} className="px-3 py-1.5 bg-brand text-white text-xs font-bold rounded-full hover:bg-brand-dark transition-colors"><Plus size={14} /></button>
          </div>
        </div>

        {/* Upload History */}
        <div>
          <h3 className="text-sm font-bold text-ink mb-2">Upload History</h3>
          {uploadHistory.length === 0 ? (
            <p className="text-xs text-faint">No uploads yet.</p>
          ) : (
            <div className="max-h-48 overflow-y-auto border border-line-soft rounded-lg">
              {uploadHistory.map((batch: any) => (
                <div key={batch.id} className="flex items-center justify-between px-3 py-2 hover:bg-surface text-sm border-b border-line-soft last:border-0">
                  <div>
                    <span className="font-bold text-ink">{batch.itemCount} items</span>
                    <span className="text-faint text-xs ml-2">{new Date(batch.createdAt).toLocaleString()}</span>
                    {batch.uploadedBy && <span className="text-xs text-muted ml-2">by {batch.uploadedBy.name}</span>}
                  </div>
                  <button onClick={() => onUndoBatch(batch.id)} className="px-2 py-1 text-xs font-bold text-red-700 dark:text-red-300 border border-red-200 dark:border-red-400/30 rounded hover:bg-red-50 dark:bg-red-400/15 transition-colors">Undo</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
