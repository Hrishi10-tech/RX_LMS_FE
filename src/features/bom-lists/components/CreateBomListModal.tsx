import { useState, FormEvent, useEffect, useMemo, useRef } from 'react';
import { Modal, UserMultiSelect } from '@/components/ui';
import { useAuth } from '@/hooks';
import { useToast } from '@/context/ToastContext';
import { cachedGet, extractErrorMessage } from '@/lib';
import { UserRole, DurationUnit } from '@/types';
import { bomListsApi } from '../services/bom-lists.api';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  // Called with the newly-created list — caller decides what to do with it
  // (typically: navigate to /user/lists/<id> OR set it active and close).
  onCreated: (list: any) => void;
}

/**
 * Modal for creating a fresh DRAFT BomList. Captures list-level defaults
 * once; every spawned ComponentRequest inherits these.
 *
 * Field set is a deliberate subset of RequestForm — same project /
 * duration / responsible-person inputs the requester is already used to, so
 * there's no new mental model.
 *
 * Nature was deliberately removed from this modal — the BOM editor has a
 * per-row Nature toggle, which makes a list-level setting redundant (and
 * confusing if the two disagreed). Items default to PERMANENT (schema
 * default); the requester flips individual rows to TEMPORARY as needed.
 */
export const CreateBomListModal = ({ isOpen, onClose, onCreated }: Props) => {
  const { user } = useAuth();
  const { addToast } = useToast();

  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [responsiblePersonIds, setResponsiblePersonIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const [projects, setProjects] = useState<any[]>([]);
  const [departments, setDepartments] = useState<any[]>([]);
  const [usersDirectory, setUsersDirectory] = useState<any[]>([]);

  // Reset to defaults whenever the modal opens. Without this, a user who
  // closes mid-form and reopens carries stale state.
  useEffect(() => {
    if (!isOpen) return;
    setName('');
    setProjectId('');
    setDepartmentId(user?.departmentId || '');
    setResponsiblePersonIds(user?.id && user.role !== UserRole.SUPER_ADMIN ? [user.id] : []);
    setSubmitting(false);
  }, [isOpen, user]);

  // The pickers below were left silently empty when this load failed. Say so
  // once — not again every time the modal is reopened — until a load works.
  const loadFailureShown = useRef(false);

  useEffect(() => {
    // Don't pull reference data for a modal nobody has opened. This ran on
    // MOUNT, and the modal is mounted with the page — so every cold load paid
    // for three GETs (plus three CORS preflights) that most visits never use.
    // Matches the reset effect above, which is already isOpen-gated.
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const [p, d, u] = await Promise.all([
          cachedGet<any>('/projects'),
          cachedGet<any>('/departments'),
          cachedGet<any>('/users/directory'),
        ]);
        if (cancelled) return;
        setProjects(p?.data || p || []);
        setDepartments(d?.data || d || []);
        setUsersDirectory(u?.data || u || []);
        loadFailureShown.current = false;
      } catch (e) {
        if (cancelled || loadFailureShown.current) return;
        loadFailureShown.current = true;
        addToast(extractErrorMessage(e, 'Could not load projects, departments or people'), 'error');
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- addToast is render-scope; load only when the modal opens
  }, [isOpen]);

  const isRegularUser = useMemo(
    () => user?.role === UserRole.USER || user?.role === UserRole.MANAGER || user?.role === UserRole.LAB,
    [user],
  );

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { addToast('Give the list a name', 'error'); return; }
    if (!projectId) { addToast('Pick a project, or General / Others', 'error'); return; }
    if (!departmentId) { addToast('Pick a department', 'error'); return; }
    setSubmitting(true);
    try {
      const list = await bomListsApi.create({
        name: name.trim(),
        projectId: projectId === '__OTHERS__' || !projectId ? null : projectId,
        departmentId,
        // `nature` deliberately omitted — schema default (TEMPORARY) applies
        // and per-row Nature toggles on the editor are the source of truth.
        // Duration falls back to the schema default (1 DAY) at the list
        // level — meaningless unless the requester later marks an item
        // Temporary without setting a per-row duration. Per-row duration
        // is collected on the editor when a line is flipped Temporary.
        durationValue: 1,
        durationUnit: DurationUnit.DAYS,
        responsiblePersonIds,
      });
      addToast(`Created ${list.serialNo}`, 'success');
      onCreated(list);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to create list'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create BOM List">
      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-bold text-muted mb-1">List name *</label>
          <input
            maxLength={120}
            type="text"
            required
            placeholder="e.g. IoT Prototype v2 BOM"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none"
          />
          <p className="text-[10px] text-faint mt-0.5">A short name for this batch. Shows in your Lists dropdown.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Project *</label>
            <select required value={projectId} onChange={(e) => setProjectId(e.target.value)}
              className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none">
              <option value="">-- Select Project --</option>
              {projects.filter((p: any) => p.isActive !== false).map((p: any) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
              <option value="__OTHERS__">General / Others (not project-specific)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-bold text-muted mb-1">Department *</label>
            <select required value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}
              disabled={isRegularUser && !!departmentId}
              className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none disabled:bg-surface disabled:text-ink">
              <option value="">-- Select Department --</option>
              {departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            {isRegularUser && departmentId && <p className="text-[10px] text-faint mt-0.5">Auto-set from your profile</p>}
          </div>
        </div>

        {/* Loan duration deliberately NOT collected here — items typically
            have genuinely different loan windows (solder station for 5d,
            test jig for 3w) so duration is set per-row on the BOM editor
            when the requester marks a line Temporary. The list-level
            default stays at 1 DAY (the schema default) as a fallback. */}

        <UserMultiSelect
          usersDirectory={usersDirectory}
          responsiblePersonIds={responsiblePersonIds}
          setResponsiblePersonIds={setResponsiblePersonIds}
          user={user}
          departmentId={departmentId}
        />

        <div className="flex justify-end gap-2 pt-3 border-t border-line-soft">
          <button type="button" onClick={onClose}
            className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface">
            Cancel
          </button>
          <button type="submit" disabled={submitting}
            className="bg-brand text-white px-6 py-2 rounded-full font-bold text-sm hover:bg-brand-dark disabled:opacity-50">
            {submitting ? 'Creating…' : 'Create list'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
