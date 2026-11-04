import { useState, FormEvent, useEffect, useMemo } from 'react';
import { Department } from '../../types';
import { useToast } from '../../context';

interface DepartmentFormProps {
  initialData?: Department;
  parentId?: string;
  departments: Department[];
  onSubmit: (data: { name: string; parentId?: string }) => void;
  isLoading: boolean;
}

/**
 * Name and placement only. The indent-approval chain is NOT here: it is a
 * toggle on the department's own row in the table, where the answer for every
 * department reads at a glance instead of being three clicks deep in a dialog.
 * A new department takes the database default (manager optional) and can be
 * switched from that row the moment it exists.
 */
export const DepartmentForm = ({ initialData, parentId, departments, onSubmit, isLoading }: DepartmentFormProps) => {
  const [name, setName] = useState(initialData?.name || '');
  const [selectedParentId, setSelectedParentId] = useState(initialData?.parentId || parentId || '');

  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setSelectedParentId(initialData.parentId || '');
    } else if (parentId) {
      setSelectedParentId(parentId);
    }
  }, [initialData, parentId]);

  const { addToast } = useToast();
  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { addToast('Enter a department name.', 'error'); return; }
    onSubmit({ name, parentId: selectedParentId || undefined });
  };

  // When editing, a department can't be re-parented under itself or any of its
  // own descendants (that would create a cycle). Exclude those from the picker;
  // the backend rejects it too as a safety net. Grows the set monotonically so
  // it always terminates, even on pre-existing malformed data.
  const disallowedIds = useMemo(() => {
    const set = new Set<string>();
    const selfId = initialData?.id;
    if (!selfId) return set;
    set.add(selfId);
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of departments) {
        if (d.parentId && set.has(d.parentId) && !set.has(d.id)) { set.add(d.id); grew = true; }
      }
    }
    return set;
  }, [departments, initialData?.id]);

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-ink">Department Name</label>
        <input
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="mt-1 block w-full border border-line rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
        />
      </div>
      <div>
        <label className="block text-sm font-medium text-ink">Parent Department (Optional)</label>
        <select
          value={selectedParentId}
          onChange={(e) => setSelectedParentId(e.target.value)}
          className="mt-1 block w-full border border-line rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
        >
          <option value="">None (Top Level)</option>
          {departments.filter((d) => !disallowedIds.has(d.id)).map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>
      <div className="flex justify-end pt-4">
        <button
          type="submit"
          disabled={isLoading}
          className="bg-brand text-white px-4 py-2 border border-transparent rounded-full shadow-sm text-sm font-medium hover:bg-brand-dark focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
        >
          {isLoading ? 'Saving...' : 'Save Department'}
        </button>
      </div>
    </form>
  );
};
