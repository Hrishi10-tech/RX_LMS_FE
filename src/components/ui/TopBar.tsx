import { RefObject } from 'react';
import { useAuth, useUnreadNotifications, useTheme } from '../../hooks';
import { Menu, Bell, LogOut, Moon, Sun } from 'lucide-react';
// Import the component directly (not via the feedback barrel) so the always-mounted
// TopBar doesn't transitively pull FeedbackInboxPage into the eager app shell.
import { FeedbackButton } from '@/features/feedback/components/FeedbackButton';

interface TopBarProps {
  onMobileMenuClick?: () => void;
  /**
   * Lets DashboardLayout return focus to this button when the mobile drawer
   * closes, instead of dropping the caret at the top of the document.
   */
  mobileMenuButtonRef?: RefObject<HTMLButtonElement>;
}

import { useNavigate } from 'react-router-dom';

export const TopBar = ({ onMobileMenuClick, mobileMenuButtonRef }: TopBarProps) => {
    const { user, logout } = useAuth();
    const navigate = useNavigate();
    // Shared with DashboardLayout — one React Query subscription, two
    // consumers. Replaces the manual fetch + focus/visibility/event
    // listener stack that used to double every notifications poll.
    const { hasUnread } = useUnreadNotifications();
    const { resolved: theme, toggle: toggleTheme } = useTheme();

    return (
      <div className="h-14 bg-card border-b border-line-soft flex items-center justify-between px-4 md:px-6 z-10 w-full">
        {/* Left */}
        <div className="flex items-center gap-3">
          <button
            ref={mobileMenuButtonRef}
            onClick={onMobileMenuClick}
            aria-label="Open navigation menu"
            className="md:hidden p-1.5 text-muted hover:bg-hover rounded-lg transition-colors"
          >
            <Menu className="w-5 h-5" />
          </button>
          <span className="hidden md:block text-sm font-semibold text-ink tracking-tight">
            {user?.role?.replace(/_/g, ' ')} Dashboard
          </span>
        </div>

        {/* Right */}
        <div className="flex items-center gap-3">
          {/* Cross-role Feedback button — modal opens on click. Visible on
              every breakpoint (icon-only on mobile, icon+label on ≥sm).
              SUPER_ADMIN reads the inbox via the sidebar; everyone else
              just submits. */}
          <FeedbackButton />

          {/* Icon-only, so it carries its own name — and the name says what a
              press will DO ("Switch to dark theme"), not what the icon depicts.
              `aria-pressed` reports the current state, so a screen reader user
              doesn't have to infer it from a moon-versus-sun glyph. */}
          <button
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            aria-pressed={theme === 'dark'}
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="p-1.5 text-faint hover:text-brand hover:bg-hover rounded-lg transition-colors"
          >
            {theme === 'dark' ? <Sun className="w-[18px] h-[18px]" /> : <Moon className="w-[18px] h-[18px]" />}
          </button>

          <button
             onClick={() => navigate(`/${user?.role?.toLowerCase().replace(/_/g, '-')}/notifications`)}
             aria-label={hasUnread ? 'Notifications, unread' : 'Notifications'}
             className="relative p-1.5 text-faint hover:text-secondary hover:bg-hover rounded-lg transition-colors hidden md:block"
          >
            <Bell className="w-[18px] h-[18px]" />
            {/* The dot is decorative — the unread state is carried in the
                button's accessible name above, since a colour dot alone tells a
                screen reader (or anyone who can't distinguish it) nothing. */}
            {/* `dot-ping` adds the expanding ring the design language specifies
                for a live/unread indicator. `text-brand` because the ring is
                drawn in currentColor, and the button's own text colour is the
                muted icon grey. */}
            {hasUnread && <span aria-hidden="true" className="dot-ping absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-brand text-brand"></span>}
          </button>

          <div className="h-5 w-px bg-line hidden md:block" />

          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-full bg-brand/15 flex items-center justify-center">
              <span className="text-[11px] font-bold text-brand-dark">{user?.name?.charAt(0)}</span>
            </div>
            <div className="text-right hidden sm:block">
              <p className="text-xs font-semibold text-ink leading-tight">{user?.name}</p>
              <p className="text-[10px] text-faint leading-tight">{user?.department?.name || 'All Departments'}</p>
            </div>
          </div>

          <button
            onClick={logout}
            className="p-1.5 text-faint hover:text-red-700 dark:text-red-300 hover:bg-red-50 dark:bg-red-400/15 rounded-lg transition-colors"
            title="Sign out"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
};
