// Connect (chat) feature barrel.
//
// Voice, video and group calls were removed: they were WebRTC peer-to-peer, so
// they needed TURN to work between two different networks and capped a
// conference at 6 participants. Chat is server-relayed and has neither problem.

// Pages
export { MessagesPage } from './pages/MessagesPage';

// Components
export { ConversationList } from './components/ConversationList';
export { DispositionModal } from './components/DispositionModal';
export { GroupManagePanel, NewGroupModal, AddMemberModal } from './components/GroupManagePanel';
export { MessagePanel } from './components/MessagePanel';

// Hooks
export { useMessaging } from './hooks/useMessaging';
