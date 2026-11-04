import React from 'react';
import { MessageSquare, Search, Users as UsersIcon, Star, Pin, X } from 'lucide-react';

export interface ConversationListProps {
  conversations: any[];
  sortedConversations: any[];
  selectedConv: any;
  users: any[];
  currentUserId: string | undefined;
  search: string;
  onSearchChange: (value: string) => void;
  onSelectConversation: (conv: any) => void;
  onStartConversation: (user: any) => void;
  onCreateNewGroup: () => void;
  showStarredView: boolean;
  onToggleStarredView: () => void;
  starredMessages: any[];
  filteredStarred: any[];
  filteredUsers: any[];
  filteredTeams: any[];
  onToggleStarMessage: (msg: any) => void;
  getOtherUser: (conv: any) => any;
}

export const ConversationList: React.FC<ConversationListProps> = ({
  conversations,
  sortedConversations,
  selectedConv,
  currentUserId,
  search,
  onSearchChange,
  onSelectConversation,
  onStartConversation,
  onCreateNewGroup,
  showStarredView,
  onToggleStarredView,
  starredMessages,
  filteredStarred,
  filteredUsers,
  filteredTeams,
  onToggleStarMessage,
  getOtherUser,
}) => {
  return (
    <div className={`w-full md:w-80 xl:w-96 border-r-0 md:border-r border-faint/30 flex flex-col bg-zebra shrink-0 transition-transform ${selectedConv ? 'hidden md:flex' : 'flex'}`}>
      <div className="p-4 border-b border-faint/30 shrink-0">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl md:text-2xl font-bold text-ink flex items-center gap-2 tracking-tight">
            <MessageSquare size={20} className="text-brand" /> Connect
          </h2>
          <div className="flex gap-1">
            <button onClick={onToggleStarredView} className={`p-2.5 rounded-full transition-colors active:scale-95 ${showStarredView ? 'bg-brand text-white shadow-sm' : 'bg-brand/10 hover:bg-brand/20 text-brand-700'}`} title="Starred Messages">
              <Star size={18} fill={showStarredView ? 'currentColor' : 'none'} />
            </button>
            <button onClick={onCreateNewGroup} className="p-2.5 bg-brand/10 hover:bg-brand/20 text-brand-700 rounded-full transition-colors active:scale-95" title="New Group">
              <UsersIcon size={18} />
            </button>
          </div>
        </div>
        <div className="relative">
          <Search className="absolute left-3.5 top-3 text-faint" size={18} />
          <input
            type="text"
            placeholder={showStarredView ? "Search starred view..." : "Search messages & teams..."}
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-9 pr-4 py-2.5 bg-card border border-faint focus:ring-brand focus:border-brand rounded-lg text-sm transition-all shadow-sm outline-none placeholder:text-faint text-ink"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto overflow-x-hidden w-full">
        <div className="p-3">
          {search && showStarredView ? (
            <StarredSearchResults
              filteredStarred={filteredStarred}
              conversations={conversations}
              onSelectConversation={onSelectConversation}
              onToggleStarMessage={onToggleStarMessage}
            />
          ) : search ? (
            <SearchResults
              filteredTeams={filteredTeams}
              filteredUsers={filteredUsers}
              onSelectConversation={onSelectConversation}
              onStartConversation={onStartConversation}
            />
          ) : (
            <div className="animate-in fade-in duration-300">
              {showStarredView ? (
                <StarredView
                  starredMessages={starredMessages}
                  conversations={conversations}
                  onSelectConversation={onSelectConversation}
                  onToggleStarMessage={onToggleStarMessage}
                />
              ) : (
                <RecentChats
                  sortedConversations={sortedConversations}
                  selectedConv={selectedConv}
                  currentUserId={currentUserId}
                  getOtherUser={getOtherUser}
                  onSelectConversation={onSelectConversation}
                  conversationsLength={conversations.length}
                />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* --- Sub-components for readability --- */

interface StarredSearchResultsProps {
  filteredStarred: any[];
  conversations: any[];
  onSelectConversation: (conv: any) => void;
  onToggleStarMessage: (msg: any) => void;
}

const StarredSearchResults: React.FC<StarredSearchResultsProps> = ({ filteredStarred, conversations, onSelectConversation, onToggleStarMessage }) => (
  <div className="animate-in fade-in duration-200 space-y-3">
    <h3 className="text-[11px] font-bold text-muted uppercase tracking-wider mb-2 px-1">Starred Links</h3>
    {filteredStarred.length === 0 && <p className="text-center text-sm text-muted mt-10 font-medium">No matches found.</p>}
    {filteredStarred.map(sm => (
      <div key={sm.id} onClick={() => onSelectConversation(conversations.find(c => c.id === sm.conversationId))} className="bg-card p-3 rounded-xl border border-line-soft shadow-sm relative group cursor-pointer hover:border-brand/40 transition-colors mb-1">
        <div className="text-xs text-muted font-bold mb-1.5 flex justify-between items-center gap-1">
          <div className="flex items-center gap-1.5 line-clamp-1">{sm.conversation?.name || sm.sender?.name}</div>
        </div>
        <p className="text-[13px] text-ink line-clamp-3 font-medium">{sm.text}</p>
        <button onClick={(e) => { e.stopPropagation(); onToggleStarMessage(sm); }} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-faint hover:text-red-700 dark:text-red-300 transition-colors bg-card rounded-full p-1 shadow-sm border border-line-soft mt-1 mr-1">
          <X size={12} />
        </button>
      </div>
    ))}
  </div>
);

interface SearchResultsProps {
  filteredTeams: any[];
  filteredUsers: any[];
  onSelectConversation: (conv: any) => void;
  onStartConversation: (user: any) => void;
}

const SearchResults: React.FC<SearchResultsProps> = ({ filteredTeams, filteredUsers, onSelectConversation, onStartConversation }) => (
  <div className="animate-in fade-in duration-200">
    {filteredTeams.length > 0 && (
      <>
        <h3 className="text-[11px] font-bold text-muted uppercase tracking-wider mb-2 px-1 mt-1">Teams</h3>
        {filteredTeams.map(conv => (
          <button
            key={conv.id}
            onClick={() => onSelectConversation(conv)}
            className="w-full flex items-center gap-3 p-2.5 rounded-xl mb-1.5 transition-all text-left bg-card border border-brand/20 hover:border-brand/50 hover:shadow-sm group"
          >
            <div className="w-10 h-10 md:w-12 md:h-12 rounded-full bg-zebra border border-brand/20 flex items-center justify-center text-brand shrink-0 shadow-sm">
              <UsersIcon size={18} />
            </div>
            <div className="overflow-hidden flex-1">
              <div className="font-semibold text-ink truncate text-[15px] group-hover:text-brand transition-colors">{conv.name}</div>
              <div className="text-xs text-muted truncate mt-0.5">{conv.members?.length || 0} participants</div>
            </div>
          </button>
        ))}
      </>
    )}

    {filteredUsers.length > 0 && (
      <>
        <h3 className="text-[11px] font-bold text-muted uppercase tracking-wider mb-2 px-1 mt-3">Directory</h3>
        {filteredUsers.map(u => (
          <button key={u.id} onClick={() => onStartConversation(u)} className="w-full flex items-center gap-3 p-2.5 hover:bg-brand/10 active:bg-brand/20 rounded-xl transition-all text-left group mb-1">
            <div className="w-10 h-10 md:w-12 md:h-12 rounded-full bg-gradient-to-tr from-faint to-gray-300 flex items-center justify-center text-ink font-bold shrink-0 relative shadow-sm">
              {u.name?.charAt(0) || 'U'}
              {u.isOnline && <div className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 rounded-full border-2 border-card shadow-sm"></div>}
            </div>
            <div className="overflow-hidden flex-1">
              <div className="font-semibold text-ink truncate text-[15px]">{u.name || 'Unknown'}</div>
              <div className="text-xs text-muted truncate mt-0.5">{u.role}</div>
            </div>
          </button>
        ))}
      </>
    )}

    {filteredUsers.length === 0 && filteredTeams.length === 0 && (
      <div className="text-sm text-muted text-center py-6 px-4">No users or teams found. Try a different name.</div>
    )}
  </div>
);

interface StarredViewProps {
  starredMessages: any[];
  conversations: any[];
  onSelectConversation: (conv: any) => void;
  onToggleStarMessage: (msg: any) => void;
}

const StarredView: React.FC<StarredViewProps> = ({ starredMessages, conversations, onSelectConversation, onToggleStarMessage }) => (
  <div className="space-y-3">
    <div className="flex items-center gap-2 text-brand font-bold text-sm uppercase tracking-widest mb-4 px-1"><Star size={16} fill="currentColor"/> Starred Archive</div>
    {starredMessages.length === 0 && <p className="text-center text-sm text-muted mt-10 font-medium">No starred messages yet.</p>}
    {starredMessages.map(sm => (
      <div key={sm.id} onClick={() => onSelectConversation(conversations.find(c => c.id === sm.conversationId))} className="bg-card p-3 rounded-xl border border-line-soft shadow-sm relative group cursor-pointer hover:border-brand/40 transition-colors">
        <div className="text-xs text-muted font-bold mb-1.5 flex justify-between items-center gap-1">
          <div className="flex items-center gap-1.5 line-clamp-1">{sm.conversation?.name || sm.sender?.name}</div>
        </div>
        <p className="text-[13px] text-ink line-clamp-3 font-medium">{sm.text}</p>
        <button onClick={(e) => { e.stopPropagation(); onToggleStarMessage(sm); }} className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-faint hover:text-red-700 dark:text-red-300 transition-colors bg-card rounded-full p-1 shadow-sm border border-line-soft mt-1 mr-1">
          <X size={12} />
        </button>
      </div>
    ))}
  </div>
);

interface RecentChatsProps {
  sortedConversations: any[];
  selectedConv: any;
  currentUserId: string | undefined;
  getOtherUser: (conv: any) => any;
  onSelectConversation: (conv: any) => void;
  conversationsLength: number;
}

const RecentChats: React.FC<RecentChatsProps> = ({ sortedConversations, selectedConv, currentUserId, getOtherUser, onSelectConversation, conversationsLength }) => (
  <>
    <h3 className="text-[11px] font-bold text-muted uppercase tracking-wider mb-2 px-1">Recent Chats</h3>
    {sortedConversations.map(conv => {
      const isSelected = selectedConv?.id === conv.id;
      const isGroup = conv.type === 'group';
      const other = isGroup ? null : getOtherUser(conv);
      const title = isGroup ? conv.name : other?.name;
      const online = isGroup ? false : other?.isOnline;
      const lastMsg = conv.lastMessage || 'No messages yet';
      const isPinned = conv.members?.find((m: any) => m.userId === currentUserId)?.isPinned;

      return (
        <button
          key={conv.id}
          onClick={() => onSelectConversation(conv)}
          className={`w-full flex items-center gap-3 p-2.5 rounded-xl mb-1.5 transition-all text-left border ${isSelected ? 'bg-brand/5 border-brand shadow-sm' : 'border-transparent hover:bg-card hover:border-faint hover:shadow-sm'}`}
        >
          <div className="w-10 h-10 md:w-12 md:h-12 rounded-full bg-zebra border border-faint flex items-center justify-center text-ink font-bold shrink-0 relative shadow-sm">
            {isGroup ? <UsersIcon size={18} className="text-muted"/> : (title?.charAt(0) || 'U')}
            {online && <div className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 rounded-full border-2 border-card shadow-sm"></div>}
          </div>
          <div className="overflow-hidden flex-1">
            <div className="flex justify-between items-center mb-0.5 gap-2">
              <div className={`font-semibold shrink-1 flex items-center gap-1.5 ${isSelected ? 'text-brand' : 'text-ink'} truncate text-[15px]`}>
                {isPinned && <Pin size={12} className="text-brand shrink-0" fill="currentColor" />}
                <span className="truncate">{title || 'Unknown User'}</span>
              </div>
              <span className="text-[10px] text-faint font-bold shrink-0">{new Date(conv.updatedAt).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
            </div>
            <div className="text-xs text-muted truncate flex items-center justify-between">
              <span>{lastMsg}</span>
              {conv.unreadCount > 0 && <span className="bg-brand w-4 h-4 rounded-full flex items-center justify-center text-[9px] text-white font-bold ml-1">{conv.unreadCount}</span>}
            </div>
          </div>
        </button>
      );
    })}
    {conversationsLength === 0 && (
      <div className="text-center py-10 px-4">
        <MessageSquare size={32} className="mx-auto text-faint mb-3" />
        <p className="text-sm text-muted font-medium">No recent conversations.</p>
        <p className="text-xs text-faint mt-1">Search the directory to start a chat.</p>
      </div>
    )}
  </>
);
