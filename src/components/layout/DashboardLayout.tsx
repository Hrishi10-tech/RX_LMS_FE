import { ReactNode, Suspense, useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Sidebar, TopBar, MenuItem, BrandLoader } from '../ui';
import { ErrorBoundary } from '../ErrorBoundary';
import { DesktopAlertsPrompt } from './DesktopAlertsPrompt';
import { useAuth, useUnreadNotifications, useUnreadMessages, useSidebarBadgeCounts, useDesktopNotifications } from '../../hooks';

interface DashboardLayoutProps {
  children: ReactNode;
  menuItems: MenuItem[];
}

export const DashboardLayout = ({ children, menuItems }: DashboardLayoutProps) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();

  // localStorage THROWS (not returns null) when site data is blocked — a locked
  // down private window, or "block third-party cookies and site data". This read
  // runs inside a useState initializer during render, so an unguarded throw took
  // out the entire authenticated app shell: every page, white screen. Every
  // other localStorage site in the app is already wrapped (lib/fx.ts,
  // lib/approvalPolicy.ts, useActiveBomList) — this one was the outlier.
  const [isCollapsed, setIsCollapsed] = useState(() => {
    try {
      return localStorage.getItem('sidebar_collapsed') === 'true';
    } catch {
      return false; // sidebar expanded — a cosmetic default, never a crash
    }
  });
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  // The mobile drawer is a modal overlay but behaved like static markup: no
  // Escape key, no focus movement, and — because it only slid out of view with
  // `-translate-x-full` — every nav link stayed in the tab order off-screen, so
  // a keyboard user on a phone tabbed through the whole hidden menu before
  // reaching the page. `drawerRef`/`triggerRef` fix focus; see the `invisible`
  // class on the drawer for the tab-order half.
  const drawerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Unread-notifications count comes from the shared `useUnreadNotifications`
  // hook — TopBar uses the same hook. One fetch, two consumers.
  const { unreadCount: unreadNotificationsCount } = useUnreadNotifications();
  const { unreadConversations } = useUnreadMessages();

  // Live desktop popups (OS-level) for new notifications, mounted once here for
  // the whole authenticated session. Fires a laptop popup whenever a
  // `notification:new` push arrives over the socket. Permission is NOT requested
  // here — that happens on the Notifications page, from a real click.
  useDesktopNotifications();

  const hasInventoryRequests = menuItems.some(i => i.path === '/inventory/requests');
  const hasIssueSlips = menuItems.some(i => i.path === '/inventory/issue-slips');
  const hasProcurementIndents = menuItems.some(i => i.path === '/procurement/indents');
  // Finance + Associate Finance both surface the Payments & Spend item
  // (paths /finance/indents and /associate-finance/indents). Either path
  // gets the badge — the count is the same backend list anyway.
  const financeIndentsItem = menuItems.find(i => i.path === '/finance/indents' || i.path === '/associate-finance/indents');
  // The "Approvals" item (path ends in '/approvals', NOT '/team-approvals').
  const approvalsItem = menuItems.find(i => /\/approvals$/.test(i.path));
  // The "Team Approvals" item. MANAGERs approve EVERYTHING their direct reports
  // raise here — component requests, indents, AND BOMs. The BOM approval queue
  // (SUBMITTED BOMs from managed users) lives on this page, not the personal
  // Approvals page: a BOM raised by a report is team work. So this item's dot
  // counts both pending team component-requests and pending direct-report BOMs;
  // the personal Approvals item carries only the manager's own / responsible-
  // person work (which, for a manager, is never their action → no dot).
  const teamApprovalsItem = menuItems.find(i => /\/team-approvals$/.test(i.path));
  // Same pattern for the "Notifications" item (every role-specific path ends
  // with /notifications) so a red dot/count appears whenever there's anything
  // unread, no matter which role the viewer is.
  const notificationsItem = menuItems.find(i => /\/notifications$/.test(i.path));
  // Connect lives at /<role>/messages for every role, same as the pattern
  // above. It was the one nav item that could have something waiting and no
  // way to say so.
  const messagesItem = menuItems.find(i => /\/messages$/.test(i.path));
  // FINANCE's "Fixed Assets" item — the only fixed-assets nav whose owner can
  // ACT on the approval queue (approve/reject). INVENTORY + ASSOCIATE_FINANCE
  // also have a fixed-assets page but can't review, so they get no dot.
  const financeFixedAssetsItem = menuItems.find(i => i.path === '/finance/fixed-assets');

  // ---- Sidebar badge counts (one shared fetch per endpoint) ----
  // Previously FIVE separate useEffects each re-fetched a full list on mount +
  // focus (4× /indents + 1× /requests) just to compute a `.filter().length`.
  // They're collapsed into one React Query hook that fetches each endpoint at
  // most once and dedupes focus/event refreshes. We only enable the fetches a
  // given role actually shows a badge for — see useSidebarBadgeCounts.
  const role = user?.role;
  const countsApprovalsIndents = role === 'ADMIN' || role === 'SUPER_ADMIN';
  const needsIndents =
    (!!approvalsItem && countsApprovalsIndents) || hasProcurementIndents || !!financeIndentsItem;
  // Only ADMIN's approvals badge reads a request count (pendingRequestApprovals).
  // SUPER_ADMIN now uses ceoPendingIndents (CEO lane only) and MANAGER pulls its
  // team-approvals count via needsTeamApprovals below — so neither needs this fetch.
  const needsRequests =
    hasInventoryRequests || hasIssueSlips || (!!approvalsItem && role === 'ADMIN');
  // FINANCE too: it approves Associate Finance's requests and indents as their manager.
  const needsTeamApprovals = !!teamApprovalsItem && (role === 'MANAGER' || role === 'FINANCE');
  // BOM approval queue feeds the Approvals dot for MANAGER (via Team Approvals)
  // and ADMIN (their Approvals page). SUPER_ADMIN is excluded — the CEO console
  // is indents ≥ ₹20k only; BOMs don't render there, so they mustn't badge it.
  const needsBomApprovals =
    !!approvalsItem && (role === 'MANAGER' || role === 'ADMIN');
  // Fixed-assets pending-review count — FINANCE only (sole reviewer with the nav).
  const needsAssetApprovals = !!financeFixedAssetsItem && role === 'FINANCE';

  const badgeCounts = useSidebarBadgeCounts({ needsIndents, needsRequests, needsTeamApprovals, needsBomApprovals, needsAssetApprovals });

  // Re-expose under the names the render block below already uses. The Approvals
  // dot is role-specific so it counts EXACTLY what that role's Approvals page
  // surfaces as actionable — otherwise the red dot points to a dead end:
  //   MANAGER     → pending BOM approvals only. Their indents/component-requests
  //                 on this page are personal-scope (their OWN, awaiting someone
  //                 else) — not their action. Their team approval work is a
  //                 SEPARATE dot on the Team Approvals item below.
  //   SUPER_ADMIN → CEO-lane indents (tech-approved, CEO-pending, ≥₹20k) + pending
  //                 BOM approvals. They can't tech-approve and the Component
  //                 Requests section is hidden for them, so PENDING indents below
  //                 the CEO threshold are excluded; BOMs (all SUBMITTED) are added.
  //   ADMIN       → tech-lane indents (PENDING + tech gate still open — the ones
  //                 they can actually tech-approve) + PENDING component requests
  //                 in scope + pending BOM approvals. Indents they've already
  //                 tech-approved sit at status PENDING awaiting the CEO, so they
  //                 stay off this dot (no action left for the admin).
  //   any other role → no dot (no role other than these three has an Approvals route).
  const pendingRequestsCount = badgeCounts.pendingInventoryRequests;
  const openIssueSlipsCount = badgeCounts.openIssueSlips;
  // Returns desk dot — count of items a borrower asked to hand back that
  // inventory must still confirm (RETURN_REQUESTED). Rides on the same
  // /requests/badge-counts fetch the inventory role already makes.
  const pendingReturnsCount = badgeCounts.pendingReturns;
  const procurementQueueCount = badgeCounts.procurementQueue;
  const financePaymentsCount = badgeCounts.financePayments;
  const financeCustomsDutyCount = badgeCounts.financeCustomsDuty;
  const refundsPendingCount = badgeCounts.refundsPending;
  const approvalsPageCount = !approvalsItem
    ? 0
    : role === 'MANAGER'
      // MANAGER's personal Approvals page carries only their OWN / responsible-
      // person work — indents & component requests are personal-scope (their
      // own, awaiting someone else), so nothing on it is the manager's action.
      // Their BOM approval queue is entirely their direct reports' BOMs (team
      // work) — it badges the Team Approvals item below, not this one.
      ? 0
      : role === 'SUPER_ADMIN'
        // CEO console is indents ≥ ₹20k only — BOMs are a manager/admin job and
        // no longer render on the CEO's Approvals page, so they don't badge it.
        ? badgeCounts.ceoPendingIndents
        : role === 'ADMIN'
          ? badgeCounts.techPendingIndents + badgeCounts.pendingRequestApprovals + badgeCounts.pendingBomApprovals
          : 0;
  // Team Approvals is MANAGER-only. It badges ALL of a manager's team approval
  // work: pending team component-requests, team indents waiting for their
  // signature, and pending BOMs — all actioned from this page. One dot, one
  // destination for "my team needs my sign-off". Indents were missing, so a
  // manager with indents waiting on them saw no dot at all.
  const teamApprovalsCount =
    teamApprovalsItem && role === 'MANAGER'
      ? badgeCounts.pendingTeamApprovals + badgeCounts.pendingTeamIndentApprovals + badgeCounts.pendingBomApprovals
      : teamApprovalsItem && role === 'FINANCE'
        ? badgeCounts.pendingTeamApprovals + badgeCounts.pendingTeamIndentApprovals
        : 0;
  // FINANCE Fixed Assets dot — pending asset proposals awaiting their review.
  const pendingAssetApprovalsCount =
    financeFixedAssetsItem && role === 'FINANCE' ? badgeCounts.pendingAssetApprovals : 0;

  useEffect(() => {
    try {
      localStorage.setItem('sidebar_collapsed', isCollapsed.toString());
    } catch { /* site data blocked — the preference just won't persist */ }
  }, [isCollapsed]);

  // Close mobile sidebar when navigating
  useEffect(() => {
    setIsMobileOpen(false);
  }, [location.pathname]);

  // Escape closes the drawer, and Tab is kept inside it while it is open —
  // otherwise focus walks straight past the backdrop into the page underneath,
  // which is exactly what the overlay is there to block.
  useEffect(() => {
    if (!isMobileOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setIsMobileOpen(false);
        return;
      }
      if (e.key !== 'Tab') return;
      const root = drawerRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    // Move focus in so the first Tab lands on a menu item rather than
    // somewhere behind the backdrop.
    //
    // Deferred by a frame or two on purpose: the drawer is `invisible` while
    // closed, and `focus()` on an element inside a `visibility: hidden`
    // subtree is silently dropped, so focusing in the same tick the class
    // changes is a coin flip. Confirmed working with real key events (first
    // Tab lands on Close menu, second on Dashboard).
    const focusTimer = window.setTimeout(() => {
      drawerRef.current
        ?.querySelector<HTMLElement>('a[href], button:not([disabled])')
        ?.focus();
    }, 50);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      // Hand focus back to the hamburger that opened it, so closing the menu
      // doesn't dump the caret at the top of the document.
      triggerRef.current?.focus();
    };
  }, [isMobileOpen]);

  const displayMenuItems = menuItems.map(item => {
    if (item.path === '/inventory/requests') {
      return { ...item, badge: pendingRequestsCount };
    }
    if (item.path === '/inventory/issue-slips') {
      return { ...item, badge: openIssueSlipsCount };
    }
    if (item.path === '/inventory/returns') {
      return { ...item, badge: pendingReturnsCount };
    }
    if (item.path === '/procurement/indents') {
      // Procurement queue badge AND refunds-pending badge share the same
      // sidebar item — sum them so a single dot represents "things you
      // need to look at on the Indents page". refundsPendingCount may be
      // 0 for non-procurement-role users; safe to always add.
      return { ...item, badge: procurementQueueCount + refundsPendingCount };
    }
    if (financeIndentsItem && item.path === financeIndentsItem.path) {
      // Same merge for Finance: AWAITING_PAYMENT (to act on) + REFUNDS_PENDING
      // (to chase) + pending CUSTOMS DUTY (to settle). All demand finance's
      // attention; one number summarises the Payments & Spend queue.
      return { ...item, badge: financePaymentsCount + refundsPendingCount + financeCustomsDutyCount };
    }
    if (approvalsItem && item.path === approvalsItem.path) {
      return { ...item, badge: approvalsPageCount };
    }
    if (teamApprovalsItem && item.path === teamApprovalsItem.path) {
      return { ...item, badge: teamApprovalsCount };
    }
    if (notificationsItem && item.path === notificationsItem.path) {
      return { ...item, badge: unreadNotificationsCount };
    }
    if (messagesItem && item.path === messagesItem.path) {
      // Conversations, not messages: "3" should mean three people are waiting
      // on you, not that one of them sent three lines.
      return { ...item, badge: unreadConversations };
    }
    if (financeFixedAssetsItem && item.path === financeFixedAssetsItem.path) {
      return { ...item, badge: pendingAssetApprovalsCount };
    }
    return item;
  });

  return (
    <div className="flex h-screen h-[100dvh] bg-page text-ink overflow-hidden font-sans relative">
      {/* Mobile Backdrop */}
      {isMobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-40 md:hidden fade-in"
          onClick={() => setIsMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        ref={drawerRef}
        role="navigation"
        aria-label="Main menu"
        // `invisible` is what actually takes the off-screen drawer out of the
        // tab order below md — a `-translate-x-full` element is still focusable.
        // `transition-all` transitions visibility discretely, so the slide-out
        // animation is preserved on the way closed. From md up it is always
        // visible, so this only affects the mobile drawer.
        className={`fixed md:static inset-y-0 left-0 z-50 flex-shrink-0 transition-all duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] transform
          ${isMobileOpen ? 'translate-x-0' : '-translate-x-full invisible md:visible md:translate-x-0'}
          ${isCollapsed ? 'md:w-16' : 'md:w-64'} w-64
        `}
      >
        <Sidebar
          menuItems={displayMenuItems}
          activePath={location.pathname}
          onNavigate={(path) => navigate(path)}
          isCollapsed={isCollapsed}
          onToggleCollapse={() => setIsCollapsed(!isCollapsed)}
          onMobileClose={() => setIsMobileOpen(false)}
        />
      </div>

      {/* Main Container */}
      <div className="flex-1 flex flex-col items-stretch overflow-hidden min-w-0">
        <TopBar onMobileMenuClick={() => setIsMobileOpen(true)} mobileMenuButtonRef={triggerRef} />

        {/* Main Content scrollable area */}
        <main className="flex-1 overflow-x-hidden overflow-y-auto p-4 md:p-6">
          {/* Offered to every role, on whatever page they are already on —
              desktop alerts used to depend on finding a button on the
              Notifications page, which is why only Procurement ever had them. */}
          <DesktopAlertsPrompt />
          <ErrorBoundary>
            {/* Keyed on the path so the entrance replays on every navigation
                rather than only on first mount. */}
            {/* Page chunks are lazy-loaded (see AppRoutes). This boundary keeps
                the sidebar/topbar mounted while a route's chunk streams in. */}
            <Suspense
              fallback={<BrandLoader variant="page" message="Preparing your workspace…" />}
            >
              <div key={location.pathname} className="enter-up-sm">{children}</div>
            </Suspense>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
};
