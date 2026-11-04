import { lazy, type ComponentType } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import {
  Atom, BadgeCheck, Beaker, Bell, Boxes, Building2, CalendarClock, CircleDollarSign,
  ClipboardCheck, ClipboardList, CreditCard, FileClock, FileText,
  FlaskConical, Gauge, History as HistoryIcon, KeyRound, Layers, LayoutDashboard,
  ListOrdered, ListTree, Megaphone, MessageSquare, Microscope, Network, NotebookPen, Package,
  PackagePlus, PackageSearch, PlusCircle, Receipt, Recycle, ScrollText, Settings as SettingsIcon,
  Undo2, UserCheck, UserCog, Users, Wallet, Warehouse,
} from 'lucide-react';
import { ProtectedRoute, RoleRoute } from '@/guards';
import { UserRole } from '@/types';
import { DashboardLayout } from '@/components/layout';
import type { MenuItem } from '@/components/ui';

// LoginPage stays eager: it's the landing view and there is no <Suspense>
// boundary above the top-level routes. Every other page renders inside
// DashboardLayout, whose <Suspense> wraps the content area — so they're
// code-split into per-page chunks loaded on demand. This shrinks the initial
// bundle (prod) and, in dev, means only the routes you actually visit get
// fetched instead of every page module up front.
import { LoginPage, ForgotPasswordPage, ResetPasswordPage } from '@/features/auth';
import { OpenNotificationPage } from '@/features/notifications/pages/OpenNotificationPage';

// Adapt a named page export to the { default } shape React.lazy expects, while
// keeping the import specifier a static string literal so the bundler can split
// each page into its own chunk.
/**
 * Reload once when a route chunk fails to load.
 *
 * Pages are code-split, so an open tab holds an index.html that names specific
 * hashed chunk files. Deploy a new build and those files are gone: the next
 * navigation dynamic-imports a 404 and the whole app falls into the error
 * boundary — "Something went wrong" — on a tab that was working seconds ago.
 * "Try again" cannot fix it either, because retrying re-requests the same dead
 * URL. The only cure is fetching the new index.html, i.e. a reload.
 *
 * Guarded by sessionStorage so a chunk that is genuinely broken (rather than
 * merely stale) shows the error boundary instead of reload-looping the browser.
 * The flag is cleared on any successful load, so the next deploy gets its own
 * single reload.
 */
const RELOAD_FLAG = 'chunk_reload_attempted';

const retryChunkOnce = async <T,>(loader: () => Promise<T>): Promise<T> => {
  try {
    const mod = await loader();
    try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* storage blocked */ }
    return mod;
  } catch (err) {
    let alreadyTried = false;
    try { alreadyTried = sessionStorage.getItem(RELOAD_FLAG) === '1'; } catch { /* storage blocked */ }
    if (!alreadyTried) {
      try { sessionStorage.setItem(RELOAD_FLAG, '1'); } catch { /* storage blocked */ }
      window.location.reload();
      // Never resolves — the reload replaces this document.
      return new Promise<T>(() => {});
    }
    throw err;
  }
};

const named = <M extends Record<string, unknown>, K extends keyof M>(
  loader: () => Promise<M>,
  key: K,
) => lazy(() => retryChunkOnce(loader).then((m) => ({ default: m[key] as ComponentType })));

// Dashboards
const AdminDashboardPage = named(() => import('@/features/dashboard/pages/AdminDashboardPage'), 'AdminDashboardPage');
const SuperAdminDashboardPage = named(() => import('@/features/dashboard/pages/SuperAdminDashboardPage'), 'SuperAdminDashboardPage');
const ProcurementDashboardPage = named(() => import('@/features/dashboard/pages/ProcurementDashboardPage'), 'ProcurementDashboardPage');
const InventoryDashboardPage = named(() => import('@/features/dashboard/pages/InventoryDashboardPage'), 'InventoryDashboardPage');
const FinanceDashboardPage = named(() => import('@/features/dashboard/pages/FinanceDashboardPage'), 'FinanceDashboardPage');
const LabDashboardPage = named(() => import('@/features/dashboard/pages/LabDashboardPage'), 'LabDashboardPage');
const StandardDashboardPage = named(() => import('@/features/dashboard/pages/StandardDashboardPage'), 'StandardDashboardPage');

// Inventory
const AdminComponentsPage = named(() => import('@/features/inventory/pages/AdminComponentsPage'), 'AdminComponentsPage');
const ComponentManagementPage = named(() => import('@/features/inventory/pages/ComponentManagementPage'), 'ComponentManagementPage');
const SuperAdminInventoryPage = named(() => import('@/features/inventory/pages/SuperAdminInventoryPage'), 'SuperAdminInventoryPage');
const LabComponentsPage = named(() => import('@/features/inventory/pages/LabComponentsPage'), 'LabComponentsPage');
const ItemHistoryPage = named(() => import('@/features/inventory/pages/ItemHistoryPage'), 'ItemHistoryPage');
const StandardMyComponentsPage = named(() => import('@/features/inventory/pages/StandardMyComponentsPage'), 'StandardMyComponentsPage');

// BOM lists
const BomListsPage = named(() => import('@/features/bom-lists/pages/BomListsPage'), 'BomListsPage');
const BomBatchesPage = named(() => import('@/features/bom-lists/pages/BomBatchesPage'), 'BomBatchesPage');

// Fixed assets
const FixedAssetsPage = named(() => import('@/features/fixed-assets/pages/FixedAssetsPage'), 'FixedAssetsPage');

// Indents
const IndentsManagementPage = named(() => import('@/features/indents/pages/IndentsManagementPage'), 'IndentsManagementPage');
const FinanceIndentsPage = named(() => import('@/features/indents/pages/FinanceIndentsPage'), 'FinanceIndentsPage');
const RefundsPage = named(() => import('@/features/indents/pages/RefundsPage'), 'RefundsPage');
const AllotItemsPage = named(() => import('@/features/inventory/pages/AllotItemsPage'), 'AllotItemsPage');
const AssociateFinancePage = named(() => import('@/features/users/pages/AssociateFinancePage'), 'AssociateFinancePage');
const StandardIPRequestsPage = named(() => import('@/features/indents/pages/StandardIPRequestsPage'), 'StandardIPRequestsPage');
const SuperAdminFinancesPage = named(() => import('@/features/indents/pages/SuperAdminFinancesPage'), 'SuperAdminFinancesPage');

// Requests
const InventoryRequestsPage = named(() => import('@/features/requests/pages/InventoryRequestsPage'), 'InventoryRequestsPage');
const IssueSlipsPage = named(() => import('@/features/requests/pages/IssueSlipsPage'), 'IssueSlipsPage');
const ReturnsPage = named(() => import('@/features/requests/pages/ReturnsPage'), 'ReturnsPage');
const DispositionPage = named(() => import('@/features/requests/pages/DispositionPage'), 'DispositionPage');

// Vendors
const VendorCodeListPage = named(() => import('@/features/vendors/pages/VendorCodeListPage'), 'VendorCodeListPage');
const NotesPage = named(() => import('@/features/notes/pages/NotesPage'), 'NotesPage');

// Vault
const VaultPage = named(() => import('@/features/vault/pages/VaultPage'), 'VaultPage');

// Users
const AdminUserManagementPage = named(() => import('@/features/users/pages/AdminUserManagementPage'), 'AdminUserManagementPage');
const SAUserManagementPage = named(() => import('@/features/users/pages/SuperAdminUserManagementPage'), 'SAUserManagementPage');
const AdminManagementPage = named(() => import('@/features/users/pages/AdminManagementPage'), 'AdminManagementPage');
const ManagerTeamPage = named(() => import('@/features/users/pages/ManagerTeamPage'), 'ManagerTeamPage');

// Single-page features
const NotificationsPage = named(() => import('@/features/notifications/pages/NotificationsPage'), 'NotificationsPage');
const ProjectsPage = named(() => import('@/features/projects/pages/ProjectsPage'), 'ProjectsPage');
const DepartmentsPage = named(() => import('@/features/departments/pages/DepartmentsPage'), 'DepartmentsPage');
const LabsPage = named(() => import('@/features/labs/pages/LabsPage'), 'LabsPage');
const DatabaseManagerPage = named(() => import('@/features/database-admin/pages/DatabaseManagerPage'), 'DatabaseManagerPage');
const ApprovalsPage = named(() => import('@/features/approvals/pages/ApprovalsPage'), 'ApprovalsPage');
const TeamApprovalsPage = named(() => import('@/features/approvals/pages/TeamApprovalsPage'), 'TeamApprovalsPage');
const MessagesPage = named(() => import('@/features/communication/pages/MessagesPage'), 'MessagesPage');
const HistoryPage = named(() => import('@/features/history/pages/HistoryPage'), 'HistoryPage');
const FeedbackInboxPage = named(() => import('@/features/feedback/pages/FeedbackInboxPage'), 'FeedbackInboxPage');
const CompaniesPage = named(() => import('@/features/companies/pages/CompaniesPage'), 'CompaniesPage');
const SubscriptionsPage = named(() => import('@/features/subscriptions/pages/SubscriptionsPage'), 'SubscriptionsPage');
const SettingsPage = named(() => import('@/features/settings/pages/SettingsPage'), 'SettingsPage');

/**
 * One icon per distinct nav label, keyed by the label itself so the same
 * feature carries the same glyph in every role's menu.
 *
 * The collapsed sidebar rail has room for nothing but the icon, and no menu
 * used to supply one: every tile rendered an identical blank square, so the
 * only way to tell them apart was hovering each in turn. Sidebar's initials
 * fallback made the rail scannable but still collides on labels sharing a
 * first letter — Dashboard/Departments both read "D", Finances/Feedback both
 * "F". Hence real glyphs, picked to be visually distinct from one another and
 * not merely semantically apt. 16px is the box the collapsed rail reserves.
 */
const NAV_ICON = {
  'Active Indents': <ClipboardCheck className="h-4 w-4" />,
  'Add Items': <PackagePlus className="h-4 w-4" />,
  'Allot Items': <Boxes className="h-4 w-4" />,
  'Associate Finance': <Users className="h-4 w-4" />,
  'All Lab Items': <FlaskConical className="h-4 w-4" />,
  'Approvals': <BadgeCheck className="h-4 w-4" />,
  'BOM Batches': <Layers className="h-4 w-4" />,
  'BOM Lists': <ListTree className="h-4 w-4" />,
  'Command Center': <Gauge className="h-4 w-4" />,
  'Companies': <Building2 className="h-4 w-4" />,
  'Connect': <MessageSquare className="h-4 w-4" />,
  'Dashboard': <LayoutDashboard className="h-4 w-4" />,
  'Departments': <Network className="h-4 w-4" />,
  'Dispositions': <Recycle className="h-4 w-4" />,
  'Feedback': <Megaphone className="h-4 w-4" />,
  'Finances': <Wallet className="h-4 w-4" />,
  'Fixed Assets': <Warehouse className="h-4 w-4" />,
  'History': <HistoryIcon className="h-4 w-4" />,
  'History Logs': <ScrollText className="h-4 w-4" />,
  'I/P Requests': <FileText className="h-4 w-4" />,
  'Indents': <ClipboardList className="h-4 w-4" />,
  'Inventory Items': <Package className="h-4 w-4" />,
  'Inventory Requests': <PackageSearch className="h-4 w-4" />,
  'Issue Slips': <Receipt className="h-4 w-4" />,
  'Item History': <FileClock className="h-4 w-4" />,
  'Lab Components': <Microscope className="h-4 w-4" />,
  'Lab Items': <Beaker className="h-4 w-4" />,
  'Labs': <Atom className="h-4 w-4" />,
  'My Components': <Boxes className="h-4 w-4" />,
  'My Team': <Users className="h-4 w-4" />,
  'Notifications': <Bell className="h-4 w-4" />,
  'Password Vault': <KeyRound className="h-4 w-4" />,
  'Payments & Spend': <CreditCard className="h-4 w-4" />,
  'Refunds': <CircleDollarSign className="h-4 w-4" />,
  'Request Component': <PlusCircle className="h-4 w-4" />,
  'Returns': <Undo2 className="h-4 w-4" />,
  'Settings': <SettingsIcon className="h-4 w-4" />,
  'Subscriptions': <CalendarClock className="h-4 w-4" />,
  'Team Approvals': <UserCheck className="h-4 w-4" />,
  'User Management': <UserCog className="h-4 w-4" />,
  'Vendor Code List': <ListOrdered className="h-4 w-4" />,
  'Notes': <NotebookPen className="h-4 w-4" />,
};

/**
 * Attaches the icons to a menu literal, so each menu below stays a plain list
 * of name/path pairs. Typing `name` as a key of NAV_ICON means a menu item
 * whose label has no icon is a compile error rather than a blank rail tile.
 */
const withIcons = (items: Array<{ name: keyof typeof NAV_ICON; path: string }>): MenuItem[] =>
  items.map((item) => ({ ...item, icon: NAV_ICON[item.name] }));

export const AppRoutes = () => {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/" element={<Navigate to="/login" replace />} />

      <Route element={<ProtectedRoute />}>
        {/* Desktop alert clicks — sends each role to its own page for the record. */}
        <Route path="/open-notification" element={<OpenNotificationPage />} />

        {/* Super Admin */}
        <Route element={<RoleRoute allowedRoles={[UserRole.SUPER_ADMIN]} />}>
          <Route path="/super-admin/*" element={
            <DashboardLayout menuItems={withIcons([
              { name: 'Dashboard', path: '/super-admin' },
              { name: 'User Management', path: '/super-admin/users' },
              { name: 'Approvals', path: '/super-admin/approvals' },
              { name: 'Team Approvals', path: '/super-admin/team-approvals' },
              { name: 'Departments', path: '/super-admin/departments' },
              { name: 'Labs', path: '/super-admin/labs' },
              { name: 'Lab Components', path: '/super-admin/lab' },
              { name: 'Inventory Items', path: '/super-admin/inventory' },
              { name: 'Finances', path: '/super-admin/finances' },
              { name: 'Notifications', path: '/super-admin/notifications' },
              { name: 'History Logs', path: '/super-admin/history' },
              { name: 'Feedback', path: '/super-admin/feedback' },
              // Companies, Projects + Database Manager now live under Settings.
              { name: 'Settings', path: '/super-admin/settings' },
              { name: 'Connect', path: '/super-admin/messages' }
            ])}>
              <Routes>
                <Route index element={<SuperAdminDashboardPage />} />
                <Route path="approvals" element={<ApprovalsPage />} />
                <Route path="team-approvals" element={<TeamApprovalsPage />} />
                <Route path="users" element={<SAUserManagementPage />} />
                <Route path="departments" element={<DepartmentsPage />} />
                <Route path="labs" element={<LabsPage />} />
                <Route path="projects" element={<ProjectsPage />} />
                <Route path="companies" element={<CompaniesPage />} />
                <Route path="admins" element={<AdminManagementPage />} />
                <Route path="lab" element={<LabComponentsPage />} />
                <Route path="inventory" element={<SuperAdminInventoryPage />} />
                <Route path="finances" element={<SuperAdminFinancesPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="database" element={<DatabaseManagerPage />} />
                <Route path="feedback" element={<FeedbackInboxPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="messages" element={<MessagesPage />} />
                {/* Unknown path under this role: send them to their own dashboard.
                    The top-level `path="*"` never sees these — `/super-admin/*` matches
                    first, so a URL like /super-admin/indents entered this subtree, matched
                    no child, and rendered an EMPTY page with nothing to explain it. */}
                <Route path="*" element={<Navigate to="/super-admin" replace />} />
              </Routes>
            </DashboardLayout>
          } />
        </Route>

        {/* Admin */}
        <Route element={<RoleRoute allowedRoles={[UserRole.ADMIN]} />}>
          <Route path="/admin/*" element={
            <DashboardLayout menuItems={withIcons([
              { name: 'Dashboard', path: '/admin' },
              { name: 'Approvals', path: '/admin/approvals' },
              { name: 'Team Approvals', path: '/admin/team-approvals' },
              { name: 'Inventory Items', path: '/admin/components' },
              { name: 'BOM Lists', path: '/admin/lists' },
              { name: 'User Management', path: '/admin/users' },
              { name: 'Notifications', path: '/admin/notifications' },
              { name: 'History', path: '/admin/history' },
              { name: 'Connect', path: '/admin/messages' }
            ])}>
              <Routes>
                <Route index element={<AdminDashboardPage />} />
                <Route path="approvals" element={<ApprovalsPage />} />
                <Route path="team-approvals" element={<TeamApprovalsPage />} />
                <Route path="components" element={<AdminComponentsPage />} />
                <Route path="lists" element={<BomListsPage />} />
                <Route path="users" element={<AdminUserManagementPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="history" element={<HistoryPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="*" element={<Navigate to="/admin" replace />} />
              </Routes>
            </DashboardLayout>
          } />
        </Route>

        {/* Manager */}
        <Route element={<RoleRoute allowedRoles={[UserRole.MANAGER]} />}>
          <Route path="/manager/*" element={
            <DashboardLayout menuItems={withIcons([
              { name: 'Inventory Items', path: '/manager' },
              { name: 'Approvals', path: '/manager/approvals' },
              { name: 'Team Approvals', path: '/manager/team-approvals' },
              { name: 'My Components', path: '/manager/my-components' },
              { name: 'BOM Lists', path: '/manager/lists' },
              { name: 'I/P Requests', path: '/manager/ip-requests' },
              { name: 'My Team', path: '/manager/team' },
              { name: 'Notifications', path: '/manager/notifications' },
              { name: 'Connect', path: '/manager/messages' }
            ])}>
              <Routes>
                <Route index element={<StandardDashboardPage />} />
                <Route path="approvals" element={<ApprovalsPage />} />
                <Route path="team-approvals" element={<TeamApprovalsPage />} />
                <Route path="my-components" element={<StandardMyComponentsPage />} />
                <Route path="lists" element={<BomListsPage />} />
                <Route path="ip-requests" element={<StandardIPRequestsPage />} />
                <Route path="team" element={<ManagerTeamPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="*" element={<Navigate to="/manager" replace />} />
              </Routes>
            </DashboardLayout>
          } />
        </Route>

        {/* User */}
        <Route element={<RoleRoute allowedRoles={[UserRole.USER]} />}>
          <Route path="/user/*" element={
            <DashboardLayout menuItems={withIcons([
              { name: 'Inventory Items', path: '/user' },
              { name: 'My Components', path: '/user/my-components' },
              { name: 'BOM Lists', path: '/user/lists' },
              { name: 'I/P Requests', path: '/user/ip-requests' },
              { name: 'Notifications', path: '/user/notifications' },
              { name: 'Connect', path: '/user/messages' }
            ])}>
              <Routes>
                <Route index element={<StandardDashboardPage />} />
                <Route path="my-components" element={<StandardMyComponentsPage />} />
                <Route path="lists" element={<BomListsPage />} />
                <Route path="ip-requests" element={<StandardIPRequestsPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="*" element={<Navigate to="/user" replace />} />
              </Routes>
            </DashboardLayout>
          } />
        </Route>

        {/* Lab */}
        <Route element={<RoleRoute allowedRoles={[UserRole.LAB]} />}>
          <Route path="/lab/*" element={
            <DashboardLayout menuItems={withIcons([
              { name: 'Command Center', path: '/lab' },
              { name: 'All Lab Items', path: '/lab/items' },
              { name: 'Inventory Items', path: '/lab/inventory' },
              { name: 'BOM Lists', path: '/lab/lists' },
              { name: 'Active Indents', path: '/lab/indents' },
              { name: 'Notifications', path: '/lab/notifications' },
              { name: 'Connect', path: '/lab/messages' }
            ])}>
              <Routes>
                <Route index element={<LabDashboardPage />} />
                <Route path="items" element={<LabComponentsPage />} />
                <Route path="inventory" element={<StandardDashboardPage />} />
                <Route path="lists" element={<BomListsPage />} />
                <Route path="indents" element={<StandardIPRequestsPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="*" element={<Navigate to="/lab" replace />} />
              </Routes>
            </DashboardLayout>
          } />
        </Route>

        {/* Procurement */}
        <Route element={<RoleRoute allowedRoles={[UserRole.PROCUREMENT]} />}>
          <Route path="/procurement/*" element={
            <DashboardLayout menuItems={withIcons([
              { name: 'Dashboard', path: '/procurement' },
              { name: 'Indents', path: '/procurement/indents' },
              { name: 'I/P Requests', path: '/procurement/ip-requests' },
              { name: 'Request Component', path: '/procurement/request-item' },
              { name: 'Refunds', path: '/procurement/refunds' },
              { name: 'Vendor Code List', path: '/procurement/vendor-codes' },
              { name: 'Notes', path: '/procurement/notes' },
              { name: 'Inventory Items', path: '/procurement/components' },
              { name: 'Lab Items', path: '/procurement/lab-items' },
              { name: 'Password Vault', path: '/procurement/vault' },
              { name: 'Notifications', path: '/procurement/notifications' },
              { name: 'Connect', path: '/procurement/messages' }
            ])}>
              <Routes>
                <Route index element={<ProcurementDashboardPage />} />
                <Route path="indents" element={<IndentsManagementPage />} />
                <Route path="ip-requests" element={<StandardIPRequestsPage />} />
                <Route path="request-item" element={<StandardDashboardPage />} />
                <Route path="refunds" element={<RefundsPage />} />
                <Route path="vendor-codes" element={<VendorCodeListPage />} />
                <Route path="notes" element={<NotesPage />} />
                {/* `planning` was a non-persisted mock that duplicated the real
                    Indents flow. Redirect to the single source of truth so any
                    bookmarked link still lands somewhere useful. */}
                <Route path="planning" element={<Navigate to="/procurement/indents" replace />} />
                <Route path="components" element={<ComponentManagementPage />} />
                <Route path="lab-items" element={<LabComponentsPage />} />
                <Route path="vault" element={<VaultPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="*" element={<Navigate to="/procurement" replace />} />
              </Routes>
            </DashboardLayout>
          } />
        </Route>

        {/* Inventory */}
        <Route element={<RoleRoute allowedRoles={[UserRole.INVENTORY]} />}>
          <Route path="/inventory/*" element={
            <DashboardLayout menuItems={withIcons([
              { name: 'Dashboard', path: '/inventory' },
              { name: 'Add Items', path: '/inventory/components' },
              // Splitting stock across projects sits next to the page where
              // stock is added, because it is the same job continued.
              { name: 'Allot Items', path: '/inventory/allot' },
              { name: 'I/P Requests', path: '/inventory/ip-requests' },
              { name: 'Request Component', path: '/inventory/request-item' },
              { name: 'Inventory Requests', path: '/inventory/requests' },
              { name: 'BOM Batches', path: '/inventory/bom-batches' },
              { name: 'Issue Slips', path: '/inventory/issue-slips' },
              { name: 'Dispositions', path: '/inventory/dispositions' },
              { name: 'Returns', path: '/inventory/returns' },
              { name: 'Lab Items', path: '/inventory/lab-items' },
              { name: 'Fixed Assets', path: '/inventory/fixed-assets' },
              { name: 'Item History', path: '/inventory/history' },
              { name: 'Notifications', path: '/inventory/notifications' },
              { name: 'Connect', path: '/inventory/messages' }
            ])}>
              <Routes>
                <Route index element={<InventoryDashboardPage />} />
                <Route path="components" element={<ComponentManagementPage />} />
                <Route path="allot" element={<AllotItemsPage />} />
                <Route path="ip-requests" element={<StandardIPRequestsPage />} />
                <Route path="request-item" element={<StandardDashboardPage />} />
                <Route path="requests" element={<InventoryRequestsPage />} />
                <Route path="bom-batches" element={<BomBatchesPage />} />
                <Route path="issue-slips" element={<IssueSlipsPage />} />
                <Route path="dispositions" element={<DispositionPage />} />
                <Route path="returns" element={<ReturnsPage />} />
                <Route path="lab-items" element={<LabComponentsPage />} />
                <Route path="fixed-assets" element={<FixedAssetsPage />} />
                <Route path="history" element={<ItemHistoryPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="*" element={<Navigate to="/inventory" replace />} />
              </Routes>
            </DashboardLayout>
          } />
        </Route>

        {/* Finance */}
        <Route element={<RoleRoute allowedRoles={[UserRole.FINANCE]} />}>
          <Route path="/finance/*" element={
            <DashboardLayout menuItems={withIcons([
              { name: 'Dashboard', path: '/finance' },
              { name: 'Inventory Items', path: '/finance/inventory-items' },
              { name: 'I/P Requests', path: '/finance/ip-requests' },
              { name: 'Payments & Spend', path: '/finance/indents' },
              { name: 'Refunds', path: '/finance/refunds' },
              // Finance owns the Associate Finance relationship end to end —
              // creating the login, resetting it, retiring it — so the roster
              // sits right under the queue it delegates from.
              { name: 'Associate Finance', path: '/finance/associate-finance' },
              // Finance is Associate Finance's manager: their requests and
              // indents wait here for Finance's manager approval.
              { name: 'Team Approvals', path: '/finance/team-approvals' },
              { name: 'Fixed Assets', path: '/finance/fixed-assets' },
              { name: 'Companies', path: '/finance/companies' },
              { name: 'Subscriptions', path: '/finance/subscriptions' },
              // Vault is shared with procurement — finance needs vendor
              // portal + payment-gateway credentials to actually pay.
              { name: 'Password Vault', path: '/finance/vault' },
              { name: 'Notifications', path: '/finance/notifications' },
              { name: 'Connect', path: '/finance/messages' }
            ])}>
              <Routes>
                <Route index element={<FinanceDashboardPage />} />
                <Route path="inventory-items" element={<StandardDashboardPage />} />
                <Route path="ip-requests" element={<StandardIPRequestsPage />} />
                <Route path="indents" element={<FinanceIndentsPage />} />
                <Route path="refunds" element={<RefundsPage />} />
                <Route path="associate-finance" element={<AssociateFinancePage />} />
                <Route path="team-approvals" element={<TeamApprovalsPage />} />
                <Route path="fixed-assets" element={<FixedAssetsPage />} />
                <Route path="companies" element={<CompaniesPage />} />
                <Route path="subscriptions" element={<SubscriptionsPage />} />
                <Route path="vault" element={<VaultPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="*" element={<Navigate to="/finance" replace />} />
              </Routes>
            </DashboardLayout>
          } />
        </Route>

        {/* Associate Finance — finance assistant, read-only on the MONEY lane
            (no mark-paid / refund / customs-pay). Like FINANCE it can raise and
            track its own indents/component requests (I/P Requests + Inventory
            Items). Fixed Assets shows here too so they can audit the register
            without touching it. */}
        <Route element={<RoleRoute allowedRoles={[UserRole.ASSOCIATE_FINANCE]} />}>
          <Route path="/associate-finance/*" element={
            <DashboardLayout menuItems={withIcons([
              { name: 'Dashboard', path: '/associate-finance' },
              { name: 'Inventory Items', path: '/associate-finance/inventory-items' },
              { name: 'I/P Requests', path: '/associate-finance/ip-requests' },
              { name: 'Payments & Spend', path: '/associate-finance/indents' },
              { name: 'Refunds', path: '/associate-finance/refunds' },
              { name: 'Fixed Assets', path: '/associate-finance/fixed-assets' },
              { name: 'Notifications', path: '/associate-finance/notifications' },
              { name: 'Connect', path: '/associate-finance/messages' }
            ])}>
              <Routes>
                <Route index element={<FinanceDashboardPage />} />
                <Route path="inventory-items" element={<StandardDashboardPage />} />
                <Route path="ip-requests" element={<StandardIPRequestsPage />} />
                <Route path="indents" element={<FinanceIndentsPage />} />
                <Route path="refunds" element={<RefundsPage />} />
                <Route path="fixed-assets" element={<FixedAssetsPage />} />
                <Route path="notifications" element={<NotificationsPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="*" element={<Navigate to="/associate-finance" replace />} />
              </Routes>
            </DashboardLayout>
          } />
        </Route>

      </Route>

      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
};
