import React, { useRef, useEffect } from 'react';
import { MessageSquare, Users as UsersIcon, Send, Check, CheckCheck, AlertCircle, MoreVertical, Pin, Star, Heart, ThumbsUp, ThumbsDown, Forward, Copy, UserMinus } from 'lucide-react';

// Escape user-typed text before embedding in a RegExp — a stray '(' or '['
// otherwise throws and white-screens the panel.
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface MessagePanelProps {
  selectedConv: any;
  messages: any[];
  filteredMessages: any[];
  text: string;
  onTextChange: (value: string) => void;
  onSendMessage: (e: React.FormEvent) => void;
  currentUser: any;
  chatSearch: string;
  showChatMenu: boolean;
  onToggleChatMenu: () => void;
  onShowGroupInfo: () => void;
  onDeselectConv: () => void;
  onTogglePinGroup: () => void;
  onMarkAsRead: () => void;
  onLeaveGroup: () => void;
  onCopyMessage: (text: string) => void;
  onToggleStarMessage: (msg: any) => void;
  onReactToMessage: (msgId: string, reaction: string) => void;
  onForwardMessage: () => void;
  onTogglePinMessage: (msg: any) => void;
  getOtherUser: (conv: any) => any;
  /** More history exists before the oldest message shown. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
}

export const MessagePanel: React.FC<MessagePanelProps> = ({
  selectedConv,
  messages,
  filteredMessages,
  text,
  onTextChange,
  onSendMessage,
  currentUser,
  chatSearch,
  showChatMenu,
  onToggleChatMenu,
  onShowGroupInfo,
  onDeselectConv,
  onTogglePinGroup,
  onMarkAsRead,
  onLeaveGroup,
  onCopyMessage,
  onToggleStarMessage,
  onReactToMessage,
  onForwardMessage,
  onTogglePinMessage,
  getOtherUser,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Follow the NEWEST message only — loading earlier history prepends, and
  // jumping to the bottom then would throw the reader away from what they
  // just asked to see.
  const newestId = messages[messages.length - 1]?.id;
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [newestId]);

  return (
    <div className="flex-1 flex flex-col bg-card min-w-0 relative">
      {/* Header */}
      <ChatHeader
        selectedConv={selectedConv}
        currentUser={currentUser}
        showChatMenu={showChatMenu}
        onToggleChatMenu={onToggleChatMenu}
        onShowGroupInfo={onShowGroupInfo}
        onDeselectConv={onDeselectConv}
        onTogglePinGroup={onTogglePinGroup}
        onMarkAsRead={onMarkAsRead}
        onLeaveGroup={onLeaveGroup}
        getOtherUser={getOtherUser}
      />

      {/* Messages Body */}
      <div className="flex-1 overflow-y-auto p-4 md:p-6 bg-[#FCFCFC] flex flex-col gap-3 md:gap-4 relative" style={{ backgroundImage: "radial-gradient(circle at 50% 50%, #f0f0f0 1.5px, transparent 1.5px)", backgroundSize: "24px 24px" }}>
        <div className="w-full flex-1 flex flex-col justify-end min-h-full pb-2">
          {chatSearch && (
            <div className="sticky top-0 z-20 mx-auto bg-amber-50/90 dark:bg-amber-400/15 backdrop-blur-sm text-amber-800 dark:text-amber-200 text-[11px] md:text-xs px-4 py-2 rounded-full font-bold mb-4 shadow-[0_2px_10px_rgb(251,191,36,0.2)] border border-amber-200/50 dark:border-amber-400/30 animate-in slide-in-from-top-4 flex items-center justify-center gap-2 max-w-fit">
              Searching: "{chatSearch}" <span className="bg-amber-200 px-1.5 md:px-2 rounded-full text-amber-900 dark:text-amber-200">{filteredMessages.length}</span>
            </div>
          )}
          {filteredMessages.length === 0 && !chatSearch && (
            <div className="flex-1 flex items-center justify-center text-faint mt-auto m-auto">
              <div className="text-center p-6 md:p-8 bg-card/80 rounded-2xl shadow-sm border border-faint/50 backdrop-blur-sm w-full max-w-[280px]">
                <MessageSquare size={36} className="mx-auto mb-4 opacity-20" />
                <p className="font-bold text-ink text-lg tracking-tight mb-1">It's quiet here...</p>
                <p className="text-sm">Send a message to start.</p>
              </div>
            </div>
          )}
          {filteredMessages.length === 0 && chatSearch && (
            <div className="flex-1 flex items-center justify-center text-muted font-medium m-auto">No messages containing '{chatSearch}'</div>
          )}

          {hasOlder && !chatSearch && onLoadOlder && (
            <button
              type="button"
              onClick={onLoadOlder}
              disabled={loadingOlder}
              className="mx-auto mb-3 rounded-full border border-line bg-card px-3 py-1 text-xs font-bold text-muted hover:text-ink disabled:opacity-50"
            >
              {loadingOlder ? 'Loading…' : 'Load earlier messages'}
            </button>
          )}

          {filteredMessages.map((m, i) => (
            <MessageBubble
              key={m.id || i}
              message={m}
              previousMessage={filteredMessages[i - 1]}
              currentUser={currentUser}
              selectedConv={selectedConv}
              chatSearch={chatSearch}
              onCopyMessage={onCopyMessage}
              onToggleStarMessage={onToggleStarMessage}
              onReactToMessage={onReactToMessage}
              onForwardMessage={onForwardMessage}
              onTogglePinMessage={onTogglePinMessage}
            />
          ))}
          <div ref={messagesEndRef} className="h-1" />
        </div>
      </div>

      {/* Composer */}
      <div className="p-3 md:p-4 bg-card/90 backdrop-blur-md border-t border-faint/40 shrink-0">
        <form noValidate onSubmit={onSendMessage} className="flex gap-2 md:gap-3 max-w-4xl mx-auto">
          <input
            type="text"
            value={text}
            onChange={(e) => onTextChange(e.target.value)}
            placeholder="Type a message..."
            /* The server rejects anything over 10,000 characters. Stop it at the
               keyboard rather than letting a long paste be silently dropped. */
            maxLength={10000}
            className="flex-1 rounded-full pl-5 md:pl-6 pr-4 py-2.5 md:py-3.5 bg-zebra border border-faint focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand text-ink shadow-sm transition-all text-sm md:text-base font-medium placeholder:font-normal placeholder:text-faint"
          />
          <button
            type="submit"
            disabled={!text.trim()}
            className="bg-brand hover:bg-brand-dark disabled:opacity-50 text-white rounded-full w-10 h-10 md:w-12 md:h-12 shrink-0 transition-all active:scale-95 flex items-center justify-center shadow-md shadow-brand/30"
          >
            <Send size={18} className="ml-0.5 md:w-5 md:h-5" />
          </button>
        </form>
      </div>
    </div>
  );
};

/* --- Sub-components --- */

interface ChatHeaderProps {
  selectedConv: any;
  currentUser: any;
  showChatMenu: boolean;
  onToggleChatMenu: () => void;
  onShowGroupInfo: () => void;
  onDeselectConv: () => void;
  onTogglePinGroup: () => void;
  onMarkAsRead: () => void;
  onLeaveGroup: () => void;
  getOtherUser: (conv: any) => any;
}

const ChatHeader: React.FC<ChatHeaderProps> = ({
  selectedConv,
  currentUser,
  showChatMenu,
  onToggleChatMenu,
  onShowGroupInfo,
  onDeselectConv,
  onTogglePinGroup,
  onMarkAsRead,
  onLeaveGroup,
  getOtherUser,
}) => (
  <div
    className="h-16 md:h-[72px] border-b border-faint/40 flex items-center justify-between px-3 md:px-6 bg-card/90 backdrop-blur-md shrink-0 shadow-sm z-10 transition-colors hover:bg-surface/80 cursor-pointer"
    onClick={() => onShowGroupInfo()}
  >
    <div className="flex items-center gap-2 md:gap-3 min-w-0 flex-1">
      <button onClick={(e) => { e.stopPropagation(); onDeselectConv(); }} className="md:hidden p-2 -ml-1 text-muted hover:bg-hover rounded-full shrink-0">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
      </button>
      <div className="w-10 h-10 md:w-11 md:h-11 rounded-full bg-gradient-to-tr from-ink to-gray-600 flex items-center justify-center text-white font-bold shrink-0 shadow-sm relative overflow-hidden">
        {selectedConv.type === 'group' && selectedConv.description ? (
          <img src={selectedConv.description} className="w-full h-full object-cover" alt="" />
        ) : (
          selectedConv.type === 'group' ? <UsersIcon size={20} /> : (getOtherUser(selectedConv)?.name?.charAt(0) || 'U')
        )}
      </div>
      <div className="min-w-0 flex-1 ml-1 md:ml-0 pr-2">
        <h3 className="font-bold text-ink text-[15px] md:text-lg truncate tracking-tight">
          {selectedConv.type === 'group' ? selectedConv.name : getOtherUser(selectedConv)?.name}
        </h3>
        {selectedConv.type !== 'group' && getOtherUser(selectedConv)?.isOnline && <p className="text-[11px] md:text-xs text-emerald-500 dark:text-emerald-300 font-semibold tracking-wide flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block animate-pulse"></span> Online</p>}
        {selectedConv.type === 'group' && <p className="text-[11px] md:text-xs text-brand font-medium tracking-wide truncate hover:underline">{selectedConv.members?.length || 0} participants</p>}
      </div>
    </div>
    <div className="flex gap-0.5 md:gap-1 shrink-0 items-center justify-center relative" onClick={(e) => e.stopPropagation()}>
      <div className="relative">
        <button onClick={onToggleChatMenu} className={`p-2 md:p-2.5 rounded-full transition-all active:scale-95 ${showChatMenu ? 'bg-hover text-ink' : 'text-faint hover:text-brand hover:bg-brand/10'}`} title="More Options">
          <MoreVertical size={18} className="md:w-5 md:h-5" />
        </button>
        {showChatMenu && (
          <div className="absolute top-12 right-0 w-48 bg-card border border-line-soft rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.08)] z-[100] animate-in slide-in-from-top-2 p-1">
            <button onClick={() => { onTogglePinGroup(); }} className="w-full text-left px-3 py-2.5 text-[13px] font-bold text-ink hover:bg-surface rounded-lg flex items-center gap-2.5 transition-colors">
              <Pin size={14} className="text-faint" fill={selectedConv.members?.find((m: any) => m.userId === currentUser?.id)?.isPinned ? "currentColor" : "none"}/> {selectedConv.members?.find((m: any) => m.userId === currentUser?.id)?.isPinned ? 'Unpin Team' : 'Pin Team'}
            </button>
            <button onClick={() => { onMarkAsRead(); }} className="w-full text-left px-3 py-2.5 text-[13px] font-bold text-ink hover:bg-surface rounded-lg flex items-center gap-2.5 transition-colors">
              <CheckCheck size={14} className="text-faint"/> Mark as Read
            </button>
            <div className="h-px bg-hover my-1 mx-2"></div>
            <button onClick={() => { onLeaveGroup(); }} className="w-full text-left px-3 py-2.5 text-[13px] font-bold text-red-700 dark:text-red-300 hover:bg-red-50 dark:bg-red-400/15 rounded-lg flex items-center gap-2.5 transition-colors">
              <UserMinus size={14}/> Leave Group
            </button>
          </div>
        )}
      </div>
    </div>
  </div>
);

interface MessageBubbleProps {
  message: any;
  previousMessage: any;
  currentUser: any;
  selectedConv: any;
  chatSearch: string;
  onCopyMessage: (text: string) => void;
  onToggleStarMessage: (msg: any) => void;
  onReactToMessage: (msgId: string, reaction: string) => void;
  onForwardMessage: () => void;
  onTogglePinMessage: (msg: any) => void;
}

const MessageBubble: React.FC<MessageBubbleProps> = ({
  message: m,
  previousMessage,
  currentUser,
  selectedConv,
  chatSearch,
  onCopyMessage,
  onToggleStarMessage,
  onReactToMessage,
  onForwardMessage,
  onTogglePinMessage,
}) => {
  const isMe = m.senderId === currentUser?.id;
  const showName = !isMe && selectedConv.type !== 'direct' && previousMessage?.senderId !== m.senderId;
  const isStarred = m.starredBy?.includes(currentUser?.id);

  return (
    <div className={`max-w-[100%] md:max-w-[85%] xl:max-w-[70%] flex flex-col ${isMe ? 'self-end items-end' : 'self-start items-start'} group animate-in fade-in slide-in-from-bottom-2 duration-300 relative`}>
      {showName && <span className="text-[10px] md:text-xs text-muted mb-1 ml-1.5 font-bold tracking-wide uppercase">{m.sender?.name}</span>}

      <div className={`flex items-center gap-2 ${isMe ? 'flex-row-reverse' : 'flex-row'} ${m.reactions && Object.keys(m.reactions).length > 0 ? 'mb-2' : ''}`}>
        {/* Chat Bubble Container */}
        <div className={`px-4 xl:px-5 py-2.5 xl:py-3 rounded-2xl shadow-sm transition-all relative group-hover:shadow-[0_4px_15px_rgba(0,0,0,0.05)] ${isMe ? 'bg-ink text-card rounded-br-[4px]' : 'bg-card border text-ink border-faint/60 rounded-bl-[4px] hover:border-faint'}`}>

          {m.isPinned && (
            <div className="flex items-center gap-1 text-[9px] uppercase tracking-widest font-bold text-brand mb-1">
              <Pin size={10} fill="currentColor" /> Pinned
            </div>
          )}

          <p className="text-[14px] md:text-[15px] leading-relaxed break-words font-medium">
            {chatSearch ? (
              (m.text || '').split(new RegExp(`(${escapeRegExp(chatSearch)})`, 'gi')).map((part: string, idx: number) =>
                part.toLowerCase() === chatSearch.toLowerCase() ? <span key={idx} className="bg-amber-300 text-amber-950 dark:text-amber-200 px-0.5 rounded-[3px] font-bold shadow-sm">{part}</span> : part
              )
            ) : m.text}
          </p>
          <div className={`text-[9px] md:text-[10px] mt-1.5 flex items-center justify-end gap-1 font-semibold ${isMe ? 'text-white/60' : 'text-faint'}`}>
            {isStarred && <Star fill="currentColor" size={10} className="text-brand" />}
            {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {isMe && (
              <span className="ml-1">
                {m.status === 'failed' ? <AlertCircle size={12} className="text-red-200" aria-label="Not sent" /> :
                 m.status === 'read' ? <CheckCheck size={12} className="text-brand" /> :
                 m.status === 'delivered' ? <CheckCheck size={12} /> :
                 <Check size={12} />}
              </span>
            )}
          </div>

          {/* Reactions Display Inline Badge */}
          {m.reactions && Object.keys(m.reactions).length > 0 && (
            <div className={`absolute -bottom-3 ${isMe ? 'right-2' : 'left-2'} flex gap-1 z-10`}>
              {Object.entries(m.reactions).map(([emoji, ids]: [string, any]) => (
                <button key={emoji} onClick={() => onReactToMessage(m.id, emoji)} className={`bg-card drop-shadow-sm flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-bold border ${ids.includes(currentUser?.id) ? 'border-brand bg-amber-50 dark:bg-amber-400/15 text-brand' : 'border-line/60 text-ink hover:border-line'} transition-all hover:scale-110 active:scale-95`}>
                  <span>{emoji}</span> {ids.length > 1 && <span className="text-muted">{ids.length}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Hover Action Menu */}
        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1.5 bg-card border border-line-soft rounded-full px-2 py-1.5 shadow-sm md:flex-row flex-col">
          <button onClick={() => onReactToMessage(m.id, '\u2764\ufe0f')} className="text-faint hover:text-red-700 dark:text-red-300 hover:scale-125 transition-transform" title="Heart"><Heart size={14} /></button>
          <button onClick={() => onReactToMessage(m.id, '\ud83d\udc4d')} className="text-faint hover:text-brand hover:scale-125 transition-transform" title="Thumbs Up"><ThumbsUp size={14} /></button>
          <button onClick={() => onReactToMessage(m.id, '\ud83d\udc4e')} className="text-faint hover:text-brand hover:scale-125 transition-transform" title="Thumbs Down"><ThumbsDown size={14} /></button>
          <button onClick={() => onReactToMessage(m.id, '\u2705')} className="text-faint hover:text-emerald-700 dark:text-emerald-300 hover:scale-125 transition-transform" title="Tick"><span className="text-[13px] leading-none mb-[1px] inline-block">{'\u2705'}</span></button>
          <div className="md:w-px md:h-3 w-3 h-px bg-line mx-0.5"></div>
          <button onClick={() => onCopyMessage(m.text)} className="text-faint hover:text-brand transition-colors" title="Copy"><Copy size={14} /></button>
          <button onClick={onForwardMessage} className="text-faint hover:text-brand transition-colors" title="Forward"><Forward size={14} /></button>
          <button onClick={() => onToggleStarMessage(m)} className={`transition-colors ${isStarred ? 'text-brand' : 'text-faint hover:text-brand'}`} title="Star"><Star size={14} fill={isStarred ? 'currentColor' : 'none'} /></button>
          <button onClick={() => onTogglePinMessage(m)} className={`transition-colors ${m.isPinned ? 'text-brand' : 'text-faint hover:text-brand'}`} title="Pin Message"><Pin size={14} fill={m.isPinned ? 'currentColor' : 'none'} /></button>
        </div>
      </div>
    </div>
  );
};
