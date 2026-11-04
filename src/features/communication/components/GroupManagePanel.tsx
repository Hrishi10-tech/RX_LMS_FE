import React from 'react';
import { usePrompt } from '@/context/ConfirmContext';
import { Users as UsersIcon, Search, Check, X, UserPlus, Edit2, Trash2, Camera, UserMinus, Award, CheckCheck } from 'lucide-react';
export { NewGroupModal, AddMemberModal } from './GroupModals';
export type { NewGroupModalProps, AddMemberModalProps } from './GroupModals';

/* --- Right Info Sidebar Panel --- */

export interface GroupManagePanelProps {
  selectedConv: any;
  currentUser: any;
  isGroupAdmin: boolean;
  showGroupInfo: boolean;
  onCloseGroupInfo: () => void;
  infoTab: 'members' | 'media' | 'search';
  onSetInfoTab: (tab: 'members' | 'media' | 'search') => void;
  chatSearch: string;
  onChatSearchChange: (value: string) => void;
  isEditingName: boolean;
  editNameValue: string;
  onEditNameValueChange: (value: string) => void;
  onStartEditingName: () => void;
  onCancelEditingName: () => void;
  onUpdateGroup: (payload: { name?: string; profilePicture?: string }) => void;
  onDeleteGroup: () => void;
  onAddMemberClick: () => void;
  onRemoveGroupMember: (userId: string) => void;
  onMakeGroupAdmin: (userId: string) => void;
  getOtherUser: (conv: any) => any;
}

export const GroupManagePanel: React.FC<GroupManagePanelProps> = ({
  selectedConv,
  currentUser,
  isGroupAdmin,
  showGroupInfo,
  onCloseGroupInfo,
  infoTab,
  onSetInfoTab,
  chatSearch,
  onChatSearchChange,
  isEditingName,
  editNameValue,
  onEditNameValueChange,
  onStartEditingName,
  onCancelEditingName,
  onUpdateGroup,
  onDeleteGroup,
  onAddMemberClick,
  onRemoveGroupMember,
  onMakeGroupAdmin,
  getOtherUser,
}) => {
  return (
    <div className={`absolute lg:relative inset-y-0 right-0 z-30 w-full sm:w-80 lg:w-80 xl:w-96 border-l border-faint/40 flex flex-col bg-zebra shrink-0 transition-all duration-300 transform ${showGroupInfo ? 'translate-x-0' : 'translate-x-full lg:hidden lg:w-0 lg:border-none opacity-0 lg:opacity-100 hidden'}`}>
      <div className="h-16 md:h-[72px] border-b border-faint/40 flex items-center px-2 md:px-4 bg-card/90 backdrop-blur-sm shrink-0 shadow-sm z-10">
        <button onClick={onCloseGroupInfo} className="p-2.5 mr-2 text-muted hover:bg-hover rounded-full transition-colors active:scale-95">
          <X size={20} />
        </button>
        <h3 className="font-bold text-ink text-lg tracking-tight">Contact Info</h3>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Profile Header Card */}
        <ProfileHeader
          selectedConv={selectedConv}
          isEditingName={isEditingName}
          editNameValue={editNameValue}
          onEditNameValueChange={onEditNameValueChange}
          onStartEditingName={onStartEditingName}
          onCancelEditingName={onCancelEditingName}
          onUpdateGroup={onUpdateGroup}
          canEditGroup={selectedConv.type === 'group' && isGroupAdmin}
          infoTab={infoTab}
          onSetInfoTab={onSetInfoTab}
          getOtherUser={getOtherUser}
        />

        <div className="mt-2 animate-in fade-in duration-300 bg-card shadow-sm border-t border-b border-faint/30">
          {infoTab === 'search' && (
            <SearchTab chatSearch={chatSearch} onChatSearchChange={onChatSearchChange} />
          )}
          {infoTab === 'media' && <MediaTab />}
          {infoTab === 'members' && (
            <MembersTab
              selectedConv={selectedConv}
              currentUser={currentUser}
              isGroupAdmin={isGroupAdmin}
              onAddMemberClick={onAddMemberClick}
              onRemoveGroupMember={onRemoveGroupMember}
              onMakeGroupAdmin={onMakeGroupAdmin}
              onDeleteGroup={onDeleteGroup}
              getOtherUser={getOtherUser}
            />
          )}
        </div>
      </div>
    </div>
  );
};

/* --- Sub-components --- */

interface ProfileHeaderProps {
  selectedConv: any;
  isEditingName: boolean;
  editNameValue: string;
  onEditNameValueChange: (value: string) => void;
  onStartEditingName: () => void;
  onCancelEditingName: () => void;
  onUpdateGroup: (payload: { name?: string; profilePicture?: string }) => void;
  // Only a group's admins may rename it or change its picture (the server
  // refuses everyone else), so the edit affordances are hidden otherwise.
  canEditGroup: boolean;
  infoTab: 'members' | 'media' | 'search';
  onSetInfoTab: (tab: 'members' | 'media' | 'search') => void;
  getOtherUser: (conv: any) => any;
}

const ProfileHeader: React.FC<ProfileHeaderProps> = ({
  selectedConv,
  isEditingName,
  editNameValue,
  onEditNameValueChange,
  onStartEditingName,
  onCancelEditingName,
  onUpdateGroup,
  canEditGroup,
  infoTab,
  onSetInfoTab,
  getOtherUser,
}) => {
  const prompt = usePrompt();
  return (
  <div className="p-6 md:p-8 text-center bg-card shadow-sm border-b border-faint/30">
    <div
      className={`w-28 h-28 md:w-32 md:h-32 mx-auto rounded-full bg-gradient-to-tr from-ink to-gray-700 flex items-center justify-center text-white text-4xl md:text-5xl font-bold shadow-lg shadow-black/10 mb-4 relative group overflow-hidden ${canEditGroup ? 'cursor-pointer hover:scale-105 transition-transform' : ''}`}
      onClick={async () => {
        if (canEditGroup) {
          const url = await prompt({
            title: 'Team picture',
            label: 'Image link',
            placeholder: 'https://…/picture.jpg',
            required: true,
            confirmLabel: 'Use this picture',
          });
          if (url?.trim()) onUpdateGroup({ profilePicture: url.trim() });
        }
      }}
    >
      {selectedConv.type === 'group' && selectedConv.description ? (
        <img src={selectedConv.description} alt="Team" className="w-full h-full object-cover" />
      ) : selectedConv.type === 'group' ? (
        <UsersIcon size={48} />
      ) : (
        getOtherUser(selectedConv)?.name?.charAt(0) || 'U'
      )}

      {canEditGroup && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <Camera className="text-white" size={28} />
        </div>
      )}
    </div>

    {isEditingName && canEditGroup ? (
      <div className="flex items-center justify-center gap-2 mb-1.5">
        <input
          autoFocus
          type="text"
          value={editNameValue}
          onChange={e => onEditNameValueChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onUpdateGroup({ name: editNameValue })}
          className="text-xl md:text-2xl font-bold text-ink text-center border-b-2 border-brand focus:outline-none bg-transparent w-48"
          placeholder="Team Name"
        />
        <button onClick={() => onUpdateGroup({ name: editNameValue })} className="p-1.5 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:bg-emerald-400/15 rounded-md transition-colors" title="Save">
          <Check size={18} />
        </button>
        <button onClick={onCancelEditingName} className="p-1.5 text-faint hover:bg-hover rounded-md transition-colors" title="Cancel">
          <X size={18} />
        </button>
      </div>
    ) : (
      <h2 className="text-xl md:text-2xl font-bold text-ink mb-1.5 tracking-tight flex items-center justify-center gap-2 group">
        <span className="truncate max-w-[200px]">{selectedConv.type === 'group' ? selectedConv.name : getOtherUser(selectedConv)?.name}</span>
        {canEditGroup && (
          <button onClick={onStartEditingName} className="opacity-0 group-hover:opacity-100 text-faint hover:text-brand transition-all p-1" title="Edit Name">
            <Edit2 size={16} />
          </button>
        )}
      </h2>
    )}

    {selectedConv.type === 'group' ? (
      <p className="text-[13px] md:text-sm font-medium text-muted">{selectedConv.members?.length || 0} participants</p>
    ) : (
      <p className="text-[13px] md:text-sm font-medium text-muted">{getOtherUser(selectedConv)?.role}</p>
    )}

    {/* Horizontal Action Menu */}
    <div className="flex justify-center gap-6 mt-6">
      <button onClick={() => onSetInfoTab('search')} className="flex flex-col items-center gap-1.5 group">
        <div className={`w-12 h-12 flex items-center justify-center rounded-2xl transition-all ${infoTab === 'search' ? 'bg-brand/10 text-brand' : 'bg-surface text-muted group-hover:bg-hover group-hover:text-ink'}`}>
          <Search size={22} className={infoTab === 'search' ? 'text-brand' : ''} />
        </div>
        <span className={`text-[11px] font-bold ${infoTab === 'search' ? 'text-brand' : 'text-muted'}`}>Search</span>
      </button>
      <button onClick={() => onSetInfoTab('members')} className="flex flex-col items-center gap-1.5 group">
        <div className={`w-12 h-12 flex items-center justify-center rounded-2xl transition-all ${infoTab === 'members' ? 'bg-brand/10 text-brand' : 'bg-surface text-muted group-hover:bg-hover group-hover:text-ink'}`}>
          <UsersIcon size={22} className={infoTab === 'members' ? 'text-brand' : ''} />
        </div>
        <span className={`text-[11px] font-bold ${infoTab === 'members' ? 'text-brand' : 'text-muted'}`}>Members</span>
      </button>
      <button onClick={() => onSetInfoTab('media')} className="flex flex-col items-center gap-1.5 group">
        <div className={`w-12 h-12 flex items-center justify-center rounded-2xl transition-all ${infoTab === 'media' ? 'bg-brand/10 text-brand' : 'bg-surface text-muted group-hover:bg-hover group-hover:text-ink'}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={infoTab === 'media' ? 'text-brand' : ''}><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
        </div>
        <span className={`text-[11px] font-bold ${infoTab === 'media' ? 'text-brand' : 'text-muted'}`}>Media</span>
      </button>
    </div>
  </div>
);
};

interface SearchTabProps {
  chatSearch: string;
  onChatSearchChange: (value: string) => void;
}

const SearchTab: React.FC<SearchTabProps> = ({ chatSearch, onChatSearchChange }) => (
  <div className="p-5 md:p-6 animate-in slide-in-from-right-4 duration-300">
    <h4 className="text-[11px] font-bold text-muted uppercase tracking-widest mb-3">Search Conversation</h4>
    <div className="relative">
      <Search className="absolute left-3.5 top-3 text-brand" size={16} />
      <input
        type="text"
        placeholder="Enter keyword..."
        autoFocus
        value={chatSearch}
        onChange={(e) => onChatSearchChange(e.target.value)}
        className="w-full pl-10 pr-8 py-2.5 bg-zebra border-2 border-brand/20 focus:ring-0 focus:border-brand rounded-lg text-sm transition-all text-ink font-medium outline-none shadow-[0_0_15px_rgba(212,170,123,0.1)]"
      />
      {chatSearch && (
        <button onClick={() => onChatSearchChange('')} className="absolute right-3 top-3 text-faint hover:text-ink transition-colors bg-hover rounded-full p-0.5">
          <X size={14} />
        </button>
      )}
    </div>
    <p className="mt-4 text-xs font-medium text-faint bg-surface p-3 rounded-lg border border-dashed border-line">
      Result highlighting is active. Type keywords to actively filter the chat feed on the left.
    </p>
  </div>
);

const MediaTab: React.FC = () => (
  <div className="p-5 md:p-6 animate-in slide-in-from-right-4 duration-300">
    <div className="flex justify-between items-center mb-4">
      <h4 className="text-[11px] font-bold text-muted uppercase tracking-widest">Media, Links, and Docs</h4>
      <span className="text-xs bg-hover text-muted font-bold px-2 py-0.5 rounded-md cursor-pointer hover:bg-line transition-colors">0 items</span>
    </div>
    <div className="bg-surface/80 rounded-xl p-8 text-center border-2 border-dashed border-faint">
      <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-faint mb-2"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/></svg>
      <p className="text-[13px] text-faint font-medium tracking-wide">No media shared yet</p>
    </div>
  </div>
);

interface MembersTabProps {
  selectedConv: any;
  currentUser: any;
  isGroupAdmin: boolean;
  onAddMemberClick: () => void;
  onRemoveGroupMember: (userId: string) => void;
  onMakeGroupAdmin: (userId: string) => void;
  onDeleteGroup: () => void;
  getOtherUser: (conv: any) => any;
}

const MembersTab: React.FC<MembersTabProps> = ({
  selectedConv,
  currentUser,
  isGroupAdmin,
  onAddMemberClick,
  onRemoveGroupMember,
  onMakeGroupAdmin,
  onDeleteGroup,
  getOtherUser,
}) => (
  <div className="p-5 md:p-6 animate-in slide-in-from-right-4 duration-300">
    {selectedConv.type === 'group' ? (
      <>
        <div className="flex items-center justify-between mb-4 text-[11px] font-bold text-muted uppercase tracking-widest">
          <h4>{selectedConv.members?.length} Participants</h4>
          {isGroupAdmin && (
            <button onClick={onAddMemberClick} className="text-brand hover:text-brand-dark flex items-center gap-1 transition-colors">
              <UserPlus size={14}/> Add New
            </button>
          )}
        </div>
        <div className="space-y-1">
          {selectedConv.members?.map((m: any) => (
            <div key={m.userId} className="flex items-center gap-3 p-2.5 hover:bg-surface rounded-xl transition-all cursor-pointer group active:bg-hover">
              <div className="w-11 h-11 rounded-full bg-gradient-to-tr from-faint/80 to-gray-300 flex items-center justify-center text-ink font-bold shrink-0 shadow-sm transition-transform group-hover:scale-105">
                {m.user?.name?.charAt(0) || 'U'}
              </div>
              <div className="flex-1 min-w-0 pr-1 border-b border-faint/40 pb-2 group-last:border-0">
                <div className="font-bold text-ink text-[15px] truncate flex justify-between items-center gap-2 tracking-tight">
                  <span className="truncate">{m.user?.name} {m.userId === currentUser?.id && <span className="text-muted font-medium ml-1 bg-hover px-1.5 py-0.5 rounded-sm text-[10px] uppercase tracking-wider">You</span>}</span>
                  <div className="flex gap-1">
                    {isGroupAdmin && m.userId !== currentUser?.id && m.role !== 'ADMIN' && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onMakeGroupAdmin(m.userId); }}
                        className="opacity-0 group-hover:opacity-100 p-1.5 text-brand hover:bg-brand/10 rounded-md transition-all ml-2"
                        title="Make Admin"
                      >
                        <Award size={14} />
                      </button>
                    )}
                    {isGroupAdmin && m.userId !== currentUser?.id && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onRemoveGroupMember(m.userId); }}
                        className="opacity-0 group-hover:opacity-100 p-1.5 text-red-400 hover:bg-red-50 dark:bg-red-400/15 hover:text-red-700 dark:text-red-300 rounded-md transition-all"
                        title="Remove member"
                      >
                        <UserMinus size={14} />
                      </button>
                    )}
                  </div>
                </div>
                <div className="text-xs text-muted font-medium mt-0.5 truncate flex items-center justify-between">
                  <span>{m.user?.role || 'Member'}</span>
                  {m.role === 'ADMIN' && <span className="text-[9px] text-emerald-700 dark:text-emerald-300 bg-emerald-100/50 dark:bg-emerald-400/15 px-1.5 py-0.5 rounded uppercase tracking-wider shrink-0 font-bold">Group Admin</span>}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-8 pt-6 border-t border-red-100/50 dark:border-red-400/30 flex justify-center">
          <button onClick={onDeleteGroup} className="flex items-center justify-center gap-2 w-full py-3.5 bg-red-50 dark:bg-red-400/15 hover:bg-red-100 dark:bg-red-400/20 text-red-700 dark:text-red-300 font-bold rounded-xl transition-all shadow-sm active:scale-[0.98] group">
            <Trash2 size={18} className="group-hover:rotate-[15deg] transition-transform duration-300" /> Delete Team permanently
          </button>
        </div>
      </>
    ) : (
      <div className="text-center py-6">
        <p className="text-[13px] text-muted font-medium">{getOtherUser(selectedConv)?.email || 'No email provided'}</p>
        <div className="flex justify-center mt-3 text-xs bg-hover px-3 py-1.5 rounded-full inline-flex font-bold text-muted uppercase tracking-widest gap-2">
          <CheckCheck size={14} className="text-brand" /> Direct Message
        </div>
      </div>
    )}
  </div>
);
