import React from 'react';
import { createPortal } from 'react-dom';
import { Users as UsersIcon, UserPlus, X } from 'lucide-react';

/* These two roll their own overlay rather than using the shared `Modal`, so
 * they need the same portal `Modal` got. Without it a `position: sticky`
 * element on the page underneath paints straight through the backdrop — the
 * bug reported on the Inventory Audit Trail, where a table's column headings
 * sat across an open dialog and stayed clickable through it. z-index does not
 * save you (a modal at z-index 9999 still lost to a sticky header at 10); what
 * fixes it is being a child of <body> rather than of the page that is trying
 * to paint over you. Messages has no sticky headers today, so this is
 * pre-emptive — but the next table added to that page shouldn't reintroduce a
 * bug we already fixed everywhere else.
 *
 * Still missing here, and deliberately out of scope for that fix: Escape to
 * close, a focus trap, focus restore on close, and role="dialog". The shared
 * Modal has all four. The real cure is to move these onto it, which is a
 * visual change to a working screen and wants its own pass.
 */

/* --- New Group Modal --- */

export interface NewGroupModalProps {
  users: any[];
  groupName: string;
  onGroupNameChange: (value: string) => void;
  selectedUsers: any[];
  onToggleUser: (userId: string, checked: boolean) => void;
  onCreateGroup: () => void;
  onClose: () => void;
}

export const NewGroupModal: React.FC<NewGroupModalProps> = ({
  users,
  groupName,
  onGroupNameChange,
  selectedUsers,
  onToggleUser,
  onCreateGroup,
  onClose,
}) => createPortal(
  <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4 animate-in fade-in">
    <div className="bg-card rounded-xl shadow-xl w-full max-w-md overflow-hidden animate-in zoom-in-95">
      <div className="p-4 border-b flex justify-between items-center bg-surface">
        <h3 className="font-bold text-ink text-lg flex items-center gap-2"><UsersIcon size={20} className="text-brand" /> Create New Group</h3>
        <button onClick={onClose} className="p-1 hover:bg-line rounded-full transition-colors"><X size={20} className="text-muted" /></button>
      </div>
      <div className="p-6 space-y-5">
        <div>
          <label className="text-xs font-bold text-muted uppercase tracking-wider mb-2 block">Group Name</label>
          <input type="text" value={groupName} onChange={e => onGroupNameChange(e.target.value)} placeholder="e.g. Lab Team Alpha" className="w-full border border-line focus:border-brand focus:ring-1 focus:ring-brand px-3 py-2.5 rounded-lg transition-all outline-none text-ink" />
        </div>
        <div>
          <label className="text-xs font-bold text-muted uppercase tracking-wider mb-2 block">Select Members ({selectedUsers.length})</label>
          <div className="h-48 overflow-y-auto border border-line rounded-lg p-2 space-y-1 bg-surface/50">
            {users.map(u => (
              <label key={u.id} className={`flex items-center gap-3 p-2.5 rounded-md cursor-pointer transition-colors ${selectedUsers.includes(u.id) ? 'bg-brand/10' : 'hover:bg-hover'}`}>
                <input type="checkbox" checked={selectedUsers.includes(u.id)} onChange={(e) => onToggleUser(u.id, e.target.checked)} className="rounded text-brand focus:ring-brand w-4 h-4 border-line" />
                <span className="text-sm font-medium text-ink">{u.name} <span className="text-xs text-muted font-normal ml-1">({u.role})</span></span>
              </label>
            ))}
            {users.length === 0 && <div className="p-4 text-center text-muted text-sm">No other users found.</div>}
          </div>
        </div>
      </div>
      <div className="p-4 border-t bg-card flex justify-end gap-3">
        <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-secondary hover:bg-hover rounded-lg transition-colors">Cancel</button>
        <button onClick={onCreateGroup} disabled={!groupName.trim() || selectedUsers.length === 0} className="px-5 py-2.5 text-sm font-bold bg-brand hover:bg-brand-dark text-white rounded-full disabled:opacity-50 transition-colors shadow-sm">Create Group</button>
      </div>
    </div>
  </div>,
  document.body,
);

/* --- Add Member Modal --- */

export interface AddMemberModalProps {
  users: any[];
  selectedConv: any;
  onAddGroupMember: (userId: string) => void;
  onClose: () => void;
}

export const AddMemberModal: React.FC<AddMemberModalProps> = ({
  users,
  selectedConv,
  onAddGroupMember,
  onClose,
}) => createPortal(
  <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4 animate-in fade-in">
    <div className="bg-card rounded-xl shadow-xl w-full max-w-sm overflow-hidden animate-in zoom-in-95">
      <div className="p-4 border-b flex justify-between items-center bg-surface">
        <h3 className="font-bold text-ink text-lg flex items-center gap-2"><UserPlus size={20} className="text-brand" /> Add Members</h3>
        <button onClick={onClose} className="p-1 hover:bg-line rounded-full transition-colors"><X size={20} className="text-muted" /></button>
      </div>
      <div className="p-4 h-64 overflow-y-auto space-y-1 bg-zebra">
        {users.filter(u => !selectedConv.members?.find((m: any) => m.userId === u.id)).map(u => (
          <button key={u.id} onClick={() => onAddGroupMember(u.id)} className="w-full flex items-center justify-between p-2.5 hover:bg-card bg-transparent rounded-lg transition-all text-left group border border-transparent hover:border-line hover:shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-faint/80 to-gray-300 flex items-center justify-center text-ink font-bold shadow-sm">
                {u.name?.charAt(0) || 'U'}
              </div>
              <div className="leading-tight">
                <div className="font-bold text-ink text-[13px]">{u.name}</div>
                <div className="text-[11px] text-muted font-medium">{u.role}</div>
              </div>
            </div>
            <span className="text-brand bg-brand/10 px-2.5 py-1 rounded-md opacity-0 group-hover:opacity-100 font-bold text-[10px] uppercase transition-all tracking-wider">Add</span>
          </button>
        ))}
        {users.filter(u => !selectedConv.members?.find((m: any) => m.userId === u.id)).length === 0 && (
          <div className="text-center text-sm text-faint py-10 font-medium">No available colleagues to add.</div>
        )}
      </div>
    </div>
  </div>,
  document.body,
);
