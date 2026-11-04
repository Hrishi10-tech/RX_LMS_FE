import { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';

// Roles that CANNOT be added as an accountable/responsible person. SUPER_ADMIN
// is a system account; LAB is a read-only viewer; the global operational roles
// (PROCUREMENT/INVENTORY/FINANCE/ASSOCIATE_FINANCE) run process steps rather
// than own items — so only USER / MANAGER / ADMIN remain assignable. Mirror of
// the backend's NON_ASSIGNABLE_RESPONSIBLE_ROLES (assignable-roles.util.ts);
// keep the two in sync. NOTE: the creator is still auto-added as "Me" by the
// form regardless of role — this only governs who you can ADD.
const NON_ASSIGNABLE_ROLES = ['SUPER_ADMIN', 'LAB', 'PROCUREMENT', 'INVENTORY', 'FINANCE', 'ASSOCIATE_FINANCE'];

interface UserMultiSelectProps {
    usersDirectory: any[];
    responsiblePersonIds: string[];
    setResponsiblePersonIds: (func: (prev: string[]) => string[]) => void;
    user: any;
    departmentId: string;
}

export const UserMultiSelect = ({ 
  usersDirectory, 
  responsiblePersonIds, 
  setResponsiblePersonIds, 
  user,
  departmentId
}: UserMultiSelectProps) => {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
          setOpen(false);
          setSearch('');
      }
    };
    if (open) document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  // Handle safe regex parsing
  const cleanSearch = search.replace(/[\W_]+/g, '').toLowerCase();
  
  const myManagerId = usersDirectory.find((u:any) => u.id === user?.id)?.managers?.[0]?.managerId;
  const myManagerUser = usersDirectory.find((u:any) => u.id === myManagerId);

  // Only USER / MANAGER / ADMIN can be held accountable — drop SUPER_ADMIN, LAB
  // and the global operational roles from every assignment group (see
  // NON_ASSIGNABLE_ROLES above).
  const assignable = usersDirectory.filter((u:any) => !NON_ASSIGNABLE_ROLES.includes(u.role));

  const myDeptUsers = assignable.filter((u:any) => u.departmentId === departmentId && u.id !== user?.id && u.id !== myManagerId);
  const otherUsers = assignable.filter((u:any) => u.departmentId !== departmentId && u.id !== user?.id && u.id !== myManagerId);

  const filterUsers = (users: any[]) => users.filter(u =>
    !responsiblePersonIds.includes(u.id) &&
    (u.name || '').replace(/[\W_]+/g, '').toLowerCase().includes(cleanSearch)
  );

  const showManager = myManagerUser && !NON_ASSIGNABLE_ROLES.includes(myManagerUser.role) && !responsiblePersonIds.includes(myManagerUser.id) && (myManagerUser.name || '').replace(/[\W_]+/g, '').toLowerCase().includes(cleanSearch);
  const fDeptUsers = filterUsers(myDeptUsers);
  const fOtherUsers = filterUsers(otherUsers);

  return (
    <div className="md:col-span-2 space-y-2 mt-4" ref={ref}>
        <label className="block text-sm font-bold text-muted mb-1">Responsible Persons</label>
        <div className="flex flex-wrap gap-2 mb-2">
          {responsiblePersonIds.map((id: string) => {
            const u = usersDirectory.find((x:any) => x.id === id);
            const isMe = id === user?.id;
            return (
              <span key={id} className={`inline-flex items-center px-2 py-1 rounded text-xs font-bold border ${isMe ? 'bg-brand/20 text-ink border-brand/30' : 'bg-blue-50 dark:bg-blue-400/15 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-400/30 shadow-sm'}`}>
                {isMe ? 'Me' : u?.name || 'Loading...'}
                {!isMe && <button type="button" onClick={() => setResponsiblePersonIds((prev:string[]) => prev.filter(pid => pid !== id))} className="ml-1.5 text-red-400 hover:text-red-700 dark:text-red-300 font-bold transition-colors"><X size={12} strokeWidth={3} /></button>}
              </span>
            );
          })}
        </div>
        
        <div className="relative">
          <input 
            type="text" 
            placeholder="+ Type to add responsible person..."
            value={search}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setSearch(e.target.value); setOpen(true); }}
            // Inside request / indent / BOM forms: Enter here means "search",
            // not "submit the whole form".
            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
            className="w-full border border-line rounded-md py-2 px-3 pr-10 text-sm focus:border-brand outline-none transition-colors"
          />
          {open && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                setSearch('');
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-faint hover:text-brand focus:outline-none transition-colors"
              title="Close"
            >
              <X size={16} strokeWidth={2} />
            </button>
          )}
          {open && (showManager || fDeptUsers.length > 0 || fOtherUsers.length > 0) && (
             <div className="absolute z-50 left-0 right-0 top-full mt-1 bg-card border border-line rounded-md shadow-lg max-h-56 overflow-y-auto">
                {showManager && (
                   <div className="mb-1 border-b border-line-soft pb-1">
                     <div className="px-3 py-1.5 text-[10px] font-bold text-muted uppercase bg-surface tracking-wider">Your Manager</div>
                     <button type="button" onClick={() => { setResponsiblePersonIds((p:string[])=>[...p, myManagerUser.id]); setSearch(''); setOpen(false); }} className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-surface hover:text-brand font-medium transition-colors">{myManagerUser.name}</button>
                   </div>
                )}
                {fDeptUsers.length > 0 && (
                   <div className="mb-1 border-b border-line-soft pb-1">
                     <div className="px-3 py-1.5 text-[10px] font-bold text-muted uppercase bg-surface tracking-wider">Your Department</div>
                     {fDeptUsers.map((u:any) => (
                       <button key={u.id} type="button" onClick={() => { setResponsiblePersonIds((p:string[])=>[...p, u.id]); setSearch(''); setOpen(false); }} className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-surface hover:text-brand font-medium transition-colors">{u.name}</button>
                     ))}
                   </div>
                )}
                {fOtherUsers.length > 0 && (
                   <div className="mb-1">
                     <div className="px-3 py-1.5 text-[10px] font-bold text-muted uppercase bg-surface tracking-wider">Other Departments</div>
                     {fOtherUsers.map((u:any) => (
                       <button key={u.id} type="button" onClick={() => { setResponsiblePersonIds((p:string[])=>[...p, u.id]); setSearch(''); setOpen(false); }} className="w-full text-left px-3 py-2 text-sm text-ink hover:bg-surface hover:text-brand flex justify-between items-center transition-colors">
                           <span className="font-medium">{u.name}</span>
                           <span className="text-xs text-faint font-normal">{u.department?.name || 'Unassigned'}</span>
                        </button>
                     ))}
                   </div>
                )}
             </div>
          )}
          {open && !showManager && fDeptUsers.length === 0 && fOtherUsers.length === 0 && (
              <div className="absolute z-50 left-0 right-0 top-full mt-1 bg-card border border-line rounded-md shadow-lg p-3 text-center text-xs text-muted">
                  No matches found.
              </div>
          )}
        </div>
        <p className="text-[10px] text-faint mt-1">Anyone added will receive a notification and be held jointly accountable for this item.</p>
    </div>
  );
};
