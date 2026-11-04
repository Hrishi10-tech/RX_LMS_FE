import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { ConversationList } from '../components/ConversationList';
import { MessagePanel } from '../components/MessagePanel';
import { GroupManagePanel, NewGroupModal, AddMemberModal } from '../components/GroupManagePanel';
import { useMessaging } from '../hooks/useMessaging';

export const MessagesPage = () => {
  const m = useMessaging();

  const [showNewGroup, setShowNewGroup] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [infoTab, setInfoTab] = useState<'members' | 'media' | 'search'>('members');
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [showChatMenu, setShowChatMenu] = useState(false);

  const handleCreateGroup = async () => {
    await m.createGroup(groupName, selectedUsers);
    setShowNewGroup(false);
    setGroupName('');
    setSelectedUsers([]);
  };

  return (
    <div className="flex relative bg-card h-[calc(100dvh-110px)] md:h-[calc(100dvh-120px)] rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] border border-faint/20 overflow-hidden w-full max-w-[2000px] mx-auto">

      <ConversationList
        conversations={m.conversations}
        sortedConversations={m.sortedConversations}
        selectedConv={m.selectedConv}
        users={m.users}
        currentUserId={m.user?.id}
        search={m.search}
        onSearchChange={m.setSearch}
        onSelectConversation={m.selectConversation}
        onStartConversation={m.startConversation}
        onCreateNewGroup={() => setShowNewGroup(true)}
        showStarredView={m.showStarredView}
        onToggleStarredView={() => { m.setShowStarredView(!m.showStarredView); }}
        starredMessages={m.starredMessages}
        filteredStarred={m.filteredStarred}
        filteredUsers={m.filteredUsers}
        filteredTeams={m.filteredTeams}
        onToggleStarMessage={m.toggleStarMessage}
        getOtherUser={m.getOtherUser}
      />

      <div className={`flex-1 flex flex-row overflow-hidden bg-card w-full transition-all ${!m.selectedConv ? 'hidden md:flex' : 'flex'}`}>
        {m.selectedConv ? (
          <>
            <MessagePanel
              selectedConv={m.selectedConv}
              messages={m.messages}
              hasOlder={m.hasOlder}
              loadingOlder={m.loadingOlder}
              onLoadOlder={m.loadOlder}
              filteredMessages={m.filteredMessages}
              text={m.text}
              onTextChange={m.setText}
              onSendMessage={m.sendMessage}
              currentUser={m.user}
              chatSearch={m.chatSearch}
              showChatMenu={showChatMenu}
              onToggleChatMenu={() => setShowChatMenu(!showChatMenu)}
              onShowGroupInfo={() => setShowGroupInfo(true)}
              onDeselectConv={() => m.setSelectedConv(null)}
              onTogglePinGroup={() => { m.togglePinGroup(); setShowChatMenu(false); }}
              onMarkAsRead={() => { m.markAsRead(); setShowChatMenu(false); }}
              onLeaveGroup={() => { m.leaveGroup(); setShowChatMenu(false); }}
              onCopyMessage={m.copyMessage}
              onToggleStarMessage={m.toggleStarMessage}
              onReactToMessage={m.reactToMessage}
              onForwardMessage={m.forwardMessage}
              onTogglePinMessage={m.togglePinMessage}
              getOtherUser={m.getOtherUser}
            />

            <GroupManagePanel
              selectedConv={m.selectedConv}
              currentUser={m.user}
              isGroupAdmin={m.isGroupAdmin}
              showGroupInfo={showGroupInfo}
              onCloseGroupInfo={() => setShowGroupInfo(false)}
              infoTab={infoTab}
              onSetInfoTab={setInfoTab}
              chatSearch={m.chatSearch}
              onChatSearchChange={m.setChatSearch}
              isEditingName={isEditingName}
              editNameValue={editNameValue}
              onEditNameValueChange={setEditNameValue}
              onStartEditingName={() => { setEditNameValue(m.selectedConv.name || ''); setIsEditingName(true); }}
              onCancelEditingName={() => setIsEditingName(false)}
              onUpdateGroup={(payload) => { m.updateGroup(payload); setIsEditingName(false); }}
              onDeleteGroup={m.deleteGroup}
              onAddMemberClick={() => setShowAddMember(true)}
              onRemoveGroupMember={m.removeGroupMember}
              onMakeGroupAdmin={m.makeGroupAdmin}
              getOtherUser={m.getOtherUser}
            />
          </>
        ) : (
          <div className="flex-1 hidden md:flex flex-col items-center justify-center text-faint bg-zebra" style={{ backgroundImage: "radial-gradient(circle at 50% 50%, rgb(var(--c-line)) 1px, transparent 1px)", backgroundSize: "24px 24px" }}>
            <div className="bg-card/80 p-10 rounded-3xl shadow-xl shadow-black/5 border border-faint backdrop-blur-md text-center max-w-[320px] animate-in zoom-in-95 duration-500">
              <div className="w-24 h-24 bg-gradient-to-br from-brand/10 to-brand/20 rounded-full flex items-center justify-center mx-auto mb-6 relative group overflow-hidden border border-brand/20">
                <div className="absolute inset-0 bg-brand/10 animate-ping opacity-50"></div>
                <MessageSquare size={36} className="text-brand relative z-10 transition-transform group-hover:scale-110 duration-500" />
              </div>
              <h3 className="text-2xl font-bold text-ink mb-3 tracking-tight">Stay Connected</h3>
              <p className="text-[15px] font-medium text-muted mb-8 leading-relaxed">Message your team in real time — pick a chat to get started.</p>
            </div>
          </div>
        )}
      </div>

      {showNewGroup && (
        <NewGroupModal
          users={m.selectableUsers}
          groupName={groupName}
          onGroupNameChange={setGroupName}
          selectedUsers={selectedUsers}
          onToggleUser={(userId, checked) => {
            if (checked) setSelectedUsers([...selectedUsers, userId]);
            else setSelectedUsers(selectedUsers.filter(id => id !== userId));
          }}
          onCreateGroup={handleCreateGroup}
          onClose={() => setShowNewGroup(false)}
        />
      )}

      {showAddMember && m.selectedConv && (
        <AddMemberModal
          users={m.users}
          selectedConv={m.selectedConv}
          onAddGroupMember={(userId) => { m.addGroupMember(userId); setShowAddMember(false); }}
          onClose={() => setShowAddMember(false)}
        />
      )}
    </div>
  );
};
