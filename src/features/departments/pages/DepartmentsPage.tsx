import { useEffect, useState } from 'react';
import { useDepartments } from '@/hooks';
import { Modal, ConfirmDialog, BrandLoader } from '@/components/ui';
import { DepartmentForm } from '@/components/forms';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { IndentApprovalMode } from '@/types';
import { IndentApprovalToggle } from '../components/IndentApprovalToggle';
import { approvalModeLabel, DEFAULT_APPROVAL_MODE } from '../approval-modes';

// Total number of descendants under a tree node (children + their children …).
const countDescendants = (n: any): number =>
  (n?.children || []).reduce((sum: number, c: any) => sum + 1 + countDescendants(c), 0);

const DeptTreeNode = ({ node, onAddChild, onEdit, onDelete, onApprovalModeChange, savingModeId }: any) => {
  return (
    <div className="ml-6 space-y-2 relative border-l-2 border-line pl-4 py-2">
      {/* `gap-x-4 gap-y-2` with wrapping rather than a plain justify-between:
          the toggle is a third block in the row now, and on a narrow screen it
          drops to its own line instead of squeezing the name. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-card px-4 py-3 rounded-md shadow-sm border border-line-soft">
        {/* `sm:min-w-[13rem]` on the name: the toggle reads as part of the
            department, so it sits right after the name rather than floating
            off on its own — but a fixed column keeps every toggle on the same
            x, which is what makes the list scannable. Ragged would not be. */}
        <div className="flex items-center space-x-3 sm:min-w-[13rem]">
          <svg className="w-5 h-5 text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
          </svg>
          <span className="font-medium text-ink">{node.name}</span>
        </div>
        <IndentApprovalToggle
          departmentName={node.name}
          value={node.indentApprovalMode}
          isSaving={savingModeId === node.id}
          onChange={(mode: IndentApprovalMode) => onApprovalModeChange(node, mode)}
        />
        {/* `ml-auto` so the actions stay pinned right whatever the name and
            toggle take, and `flex-wrap` on the row handles phone width, where
            all three stack instead of the actions being clipped off the card. */}
        <div className="flex space-x-2 ml-auto">
          <button onClick={() => onAddChild(node.id)} className="text-sm text-brand hover:text-[#3B82F6] focus:outline-none">Add Sub</button>
          <button onClick={() => onEdit(node)} className="text-sm text-muted hover:text-ink focus:outline-none">Edit</button>
          <button onClick={() => onDelete(node)} className="text-sm text-red-700 dark:text-red-300 hover:text-red-700 dark:text-red-300 focus:outline-none">Delete</button>
        </div>
      </div>
      {node.children && node.children.length > 0 && (
        <div className="mt-2">
          {node.children.map((child: any) => (
            <DeptTreeNode
              key={child.id}
              node={child}
              onAddChild={onAddChild}
              onEdit={onEdit}
              onDelete={onDelete}
              onApprovalModeChange={onApprovalModeChange}
              savingModeId={savingModeId}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export const DepartmentsPage = () => {
  const { departments, tree, isLoading, fetchDepartments, createDepartment, updateDepartment, deleteDepartment } = useDepartments();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingDept, setEditingDept] = useState<any>(null);
  const [targetParentId, setTargetParentId] = useState<string | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<any>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // Which row's toggle is mid-save. One at a time, so the id is enough.
  const [savingModeId, setSavingModeId] = useState<string | null>(null);
  const { addToast } = useToast();

  useEffect(() => {
    // The hierarchy tree is derived from this one flat list in-memory, so a
    // single fetch covers both the tree view and the parent-picker dropdown.
    fetchDepartments();
  }, [fetchDepartments]);

  const handleAddTopLevel = () => {
    setEditingDept(null);
    setTargetParentId(undefined);
    setIsModalOpen(true);
  };

  const handleAddChild = (parentId: string) => {
    setEditingDept(null);
    setTargetParentId(parentId);
    setIsModalOpen(true);
  };

  const handleEdit = (dept: any) => {
    setEditingDept(dept);
    setTargetParentId(undefined);
    setIsModalOpen(true);
  };

  const handleDelete = (node: any) => setDeleteTarget(node);

  // The row toggle saves on click — there is no form around it and no Save
  // button, so a failure has to say so out loud. Nothing is written
  // optimistically: the row keeps showing the stored value until the PATCH
  // comes back, which means a failed save cannot leave the table claiming a
  // rule that is not in force.
  const handleApprovalModeChange = async (node: any, mode: IndentApprovalMode) => {
    if ((node.indentApprovalMode || DEFAULT_APPROVAL_MODE) === mode) return;
    setSavingModeId(node.id);
    try {
      // `node.parentId ?? null` preserves where the department sits; passing
      // undefined would drop it from the PATCH body, which is fine, but null
      // is what "top level" means and this keeps the two cases honest.
      await updateDepartment(node.id, node.name, node.parentId ?? null, mode);
      addToast(`${node.name} — ${approvalModeLabel(mode).toLowerCase()}`, 'success');
      fetchDepartments();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to change the approval rule'), 'error');
    } finally {
      setSavingModeId(null);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteDepartment(deleteTarget.id);
      addToast('Department deleted', 'success');
      setDeleteTarget(null);
      fetchDepartments();
    } catch (e: any) {
      // Backend blocks deletes that would orphan users / items and returns a
      // specific reason — surface it instead of a generic failure.
      addToast(extractErrorMessage(e, 'Failed to delete department'), 'error');
    } finally {
      setIsDeleting(false);
    }
  };

  // No indentApprovalMode here on purpose: the form no longer carries it, and
  // leaving it out of the PATCH body is what preserves whatever the row's
  // toggle last set. A create takes the database default.
  const handleSubmit = async (data: { name: string; parentId?: string }) => {
    setIsSubmitting(true);
    try {
      if (editingDept) {
        // Pass parentId so re-parenting saves; `?? null` makes "None (Top
        // Level)" an explicit clear (undefined would be dropped from the
        // PATCH body, leaving the old parent in place).
        await updateDepartment(editingDept.id, data.name, data.parentId ?? null);
      } else {
        await createDepartment(data.name, data.parentId);
      }
      setIsModalOpen(false);
      fetchDepartments(); // update flat list too
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to save department'), 'error');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading && tree.length === 0) {
    return <BrandLoader />;
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex justify-between items-center bg-card p-4 md:p-6 rounded-lg shadow-sm border border-line-soft">
        <div>
          <h2 className="text-2xl font-bold tracking-tight font-bold text-ink">Departments Hierarchy</h2>
          <p className="text-sm md:text-[15px] text-muted mt-1.5">Manage the organizational structure of the laboratory.</p>
        </div>
        <button
          onClick={handleAddTopLevel}
          className="bg-brand hover:bg-brand-dark text-white px-4 py-2 rounded-full font-medium text-sm transition-colors shadow-sm inline-flex items-center"
        >
          <svg className="-ml-1 mr-2 h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 5a1 1 0 011 1v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 110-2h3V6a1 1 0 011-1z" clipRule="evenodd" />
          </svg>
          Add Top Level
        </button>
      </div>

      <div className="bg-card p-4 md:p-6 rounded-lg shadow-sm border border-line-soft overflow-hidden">
        {tree.length === 0 ? (
          <div className="text-center p-8 text-muted">No departments found. Create one to get started.</div>
        ) : (
          <>
          {/* The toggle in each row carries no label of its own, so the one
              explanation of what it governs sits here, once, above them all. */}
          <div className="mb-4 border-b border-line-soft pb-3">
            <h3 className="text-sm font-bold text-ink">Manager approval</h3>
            <p className="mt-0.5 text-xs text-muted">
              Is a manager's signature required on indents raised in each department? The department
              admin signs either way. <strong className="font-bold text-ink">Optional</strong> — the manager is
              asked first, but an admin can go ahead without them and the manager is told.{' '}
              <strong className="font-bold text-ink">Required</strong> — the admin cannot approve until the
              manager has. It saves as soon as you pick. Component requests are not affected; those
              follow the per-category setting on Inventory.
            </p>
            {/* The question every admin asks the moment they pick the strict
                option, answered before they have to ask it. */}
            {departments.some((d) => d.indentApprovalMode === 'MANAGER_REQUIRED') && (
              <p className="mt-2 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs leading-relaxed text-ink">
                Where it is required and someone has no reporting manager, the step is skipped
                automatically — an indent can never get stuck waiting on a manager who does not exist.
              </p>
            )}
          </div>
          <div className="-ml-6">
            {tree.map(node => (
              <DeptTreeNode
                key={node.id}
                node={node}
                onAddChild={handleAddChild}
                onEdit={handleEdit}
                onDelete={handleDelete}
                onApprovalModeChange={handleApprovalModeChange}
                savingModeId={savingModeId}
              />
            ))}
          </div>
          </>
        )}
      </div>

      <Modal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        title={editingDept ? 'Edit Department' : (targetParentId ? 'Add Sub-Department' : 'Add Top-Level Department')}
      >
        <DepartmentForm
          initialData={editingDept}
          parentId={targetParentId}
          departments={departments}
          onSubmit={handleSubmit}
          isLoading={isSubmitting}
        />
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="Delete department"
        tone="danger"
        confirmLabel="Delete"
        isLoading={isDeleting}
        onClose={() => !isDeleting && setDeleteTarget(null)}
        onConfirm={confirmDelete}
        message={
          deleteTarget ? (
            <>
              Delete <span className="font-bold text-ink">{deleteTarget.name}</span>
              {countDescendants(deleteTarget) > 0 && (
                <>
                  {' '}and its{' '}
                  <span className="font-bold text-ink">{countDescendants(deleteTarget)}</span>{' '}
                  sub-department{countDescendants(deleteTarget) > 1 ? 's' : ''}
                </>
              )}
              ? This can't be undone.
              {countDescendants(deleteTarget) > 0 && ' Sub-departments are removed too.'}
              <span className="block mt-1 text-xs text-faint">
                Blocked if any of them still has users, inventory, or other records.
              </span>
            </>
          ) : null
        }
      />
    </div>
  );
};
