import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui';
import { AlertTriangle, Users, ArrowRightLeft, UserX } from 'lucide-react';

interface ManagerLike {
  id: string;
  name?: string;
  departmentId?: string | null;
  department?: { name?: string } | null;
}

interface Props {
  /** Manager row being demoted to USER — null when closed. Reads
   *  `_count.managedUsers` for the report count. */
  manager: (ManagerLike & { _count?: { managedUsers?: number } }) | null;
  /** Candidate replacement managers (the full MANAGER directory). The one being
   *  demoted is filtered out internally. */
  managers: ManagerLike[];
  onClose: () => void;
  /** Resolves with the chosen target id, or null to leave reports unassigned. */
  onConfirm: (reassignToManagerId: string | null) => void | Promise<void>;
  isSubmitting?: boolean;
}

/**
 * MANAGER → USER demote dialog with mandatory report-handling.
 *
 * The old flow silently orphaned a demoted manager's reports — they kept
 * working but dropped out of every "my team" view and manager-routed approval
 * with no reassignment and no warning. This modal makes the fate of the team an
 * explicit, visible decision: reassign every report to a replacement manager
 * (default), or knowingly leave them unassigned. The report count is shown up
 * front so the admin can see exactly who's affected before acting.
 *
 * Shared by the Admin and Super Admin user-management pages so both honour the
 * same reassignment guarantee (the backend `demoteUser` does the re-pointing).
 */
export const DemoteManagerModal = ({ manager, managers, onClose, onConfirm, isSubmitting }: Props) => {
  const reportCount = manager?._count?.managedUsers ?? 0;

  // Candidate targets: every other manager, same-department ones first (the
  // most likely correct inheritor), then alphabetical.
  const candidates = useMemo(() => {
    if (!manager) return [];
    return managers
      .filter((m) => m.id !== manager.id)
      .sort((a, b) => {
        const aSame = a.departmentId && a.departmentId === manager.departmentId ? 0 : 1;
        const bSame = b.departmentId && b.departmentId === manager.departmentId ? 0 : 1;
        if (aSame !== bSame) return aSame - bSame;
        return (a.name || '').localeCompare(b.name || '');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the memo reads only manager.id and manager.departmentId, both already listed; depending on the whole manager object would recompute on unrelated field changes
  }, [managers, manager?.id, manager?.departmentId]);

  const [mode, setMode] = useState<'reassign' | 'unassign'>('reassign');
  const [targetId, setTargetId] = useState('');

  // Reset the form each time a different manager is opened. Default to
  // reassign when there's somewhere to send the team, else unassign.
  useEffect(() => {
    if (!manager) return;
    setMode(candidates.length > 0 ? 'reassign' : 'unassign');
    setTargetId('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager?.id]);

  const name = manager?.name || 'this manager';
  const noTargetPicked = reportCount > 0 && mode === 'reassign' && !targetId;
  const confirmDisabled = !!isSubmitting || noTargetPicked;

  const handleConfirm = () => {
    if (confirmDisabled) return;
    if (reportCount === 0) return onConfirm(null);
    onConfirm(mode === 'reassign' ? targetId || null : null);
  };

  return (
    <Modal isOpen={!!manager} onClose={onClose} title="Demote manager to user" size="sm">
      <div className="space-y-4">
        <p className="text-sm text-ink">
          Demote <span className="font-bold">{name}</span> from <span className="font-bold">MANAGER</span> to{' '}
          <span className="font-bold">USER</span>? They keep their department, but lose the ability to approve their
          team's requests.
        </p>

        {reportCount === 0 ? (
          <div className="flex items-start gap-2 text-sm text-muted bg-surface border border-line rounded-lg px-3 py-2.5">
            <Users size={16} className="mt-0.5 shrink-0 text-faint" />
            <span>No one currently reports to {name}, so there's no team to move. Safe to demote.</span>
          </div>
        ) : (
          <>
            <div className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-lg px-3 py-2.5">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-700 dark:text-amber-300" />
              <span>
                <span className="font-bold">{reportCount}</span> {reportCount === 1 ? 'person reports' : 'people report'}{' '}
                to {name}. Choose what happens to {reportCount === 1 ? 'them' : 'their reporting line'}:
              </span>
            </div>

            <div className="space-y-2">
              {/* Reassign — the safe default. */}
              <label
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                  mode === 'reassign' ? 'border-brand bg-brand/5' : 'border-line hover:bg-surface'
                }`}
              >
                <input
                  type="radio"
                  name="demote-report-mode"
                  className="mt-0.5 accent-brand"
                  checked={mode === 'reassign'}
                  disabled={candidates.length === 0}
                  onChange={() => setMode('reassign')}
                />
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-bold text-ink">
                    <ArrowRightLeft size={14} /> Reassign to another manager
                  </div>
                  {candidates.length === 0 ? (
                    <p className="text-xs text-faint mt-1 italic">No other managers available to reassign to.</p>
                  ) : (
                    <select
                      value={targetId}
                      onChange={(e) => setTargetId(e.target.value)}
                      disabled={mode !== 'reassign'}
                      className="mt-2 w-full text-sm border border-line rounded-md px-2 py-1.5 bg-card focus:outline-none focus:ring-2 focus:ring-brand/40 disabled:bg-surface"
                    >
                      <option value="">Select a manager…</option>
                      {candidates.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                          {m.department?.name ? ` · ${m.department.name}` : ''}
                          {m.departmentId && m.departmentId === manager?.departmentId ? ' (same dept)' : ''}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              </label>

              {/* Leave unassigned — explicit opt-out, no longer silent. */}
              <label
                className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 cursor-pointer transition-colors ${
                  mode === 'unassign' ? 'border-amber-400 bg-amber-50 dark:bg-amber-400/15' : 'border-line hover:bg-surface'
                }`}
              >
                <input
                  type="radio"
                  name="demote-report-mode"
                  className="mt-0.5 accent-amber-600"
                  checked={mode === 'unassign'}
                  onChange={() => setMode('unassign')}
                />
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 text-sm font-bold text-ink">
                    <UserX size={14} /> Leave unassigned
                  </div>
                  <p className="text-xs text-faint mt-1">
                    They'll have no manager and drop out of team views and manager approvals until someone
                    reassigns them.
                  </p>
                </div>
              </label>
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className="px-3 py-1.5 text-sm font-bold text-muted rounded-md hover:bg-hover disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={confirmDisabled}
            className="px-3 py-1.5 text-sm font-bold text-white bg-amber-700 hover:bg-amber-800 rounded-md shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSubmitting ? 'Demoting…' : 'Demote'}
          </button>
        </div>
      </div>
    </Modal>
  );
};
