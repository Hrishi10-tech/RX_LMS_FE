import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { client } from '../api';
import { queryKeys } from '../lib/queryKeys';
import { bomListsApi } from '../features/bom-lists/services/bom-lists.api';

/**
 * Single source of truth for every sidebar badge that derives from the indents
 * or requests lists.
 *
 * Each badge is a small integer. Rather than download the FULL `/indents` +
 * `/requests` + `/requests/team-approvals` lists (up to 200 rows each) on mount,
 * window-focus, every 30s, and every mutation event just to compute a handful of
 * `.filter().length` values, we hit two integer-only endpoints:
 *
 *   GET /indents/badge-counts   → { techPendingIndents, ceoPendingIndents,
 *                                   procurementQueue, financePayments,
 *                                   financeCustomsDuty, refundsPending }
 *   GET /requests/badge-counts  → { pendingInventoryRequests, openIssueSlips,
 *                                   pendingRequestApprovals, pendingTeamApprovals,
 *                                   pendingReturns }
 *   GET /bom-lists/approvals/manager/count → { count }  // pending SUBMITTED BOMs
 *
 * Both endpoints scope each count with the SAME buildDepartmentScope the
 * matching findAll uses, so every badge equals the count of rows the caller
 * could actually page to — the numbers are identical to the old client-side
 * computation, but no row payload crosses the wire.
 *
 * The React Query wiring (one query per endpoint shared across badges, 30s
 * staleTime + refetchOnWindowFocus, domain-event → cache invalidation) is
 * unchanged, so refresh cadence and the 9 returned keys are exactly as before.
 */

// Register the domain-event → cache-invalidation listeners exactly once for the
// page lifetime (same singleton trick as useUnreadNotifications — per-instance
// registration would fire N invalidations per event with multiple subscribers).
let listenersInstalled = false;
const installGlobalListeners = (queryClient: QueryClient) => {
  if (listenersInstalled || typeof window === 'undefined') return;
  listenersInstalled = true;
  // Prefix key (['indents']) so this reaches BOTH the badge-counts query and any
  // mounted indent list — it used to be `indents.list()`, which only worked for
  // the badges because they were (wrongly) sharing the list's key.
  const invalidateIndents = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.indents.all });
  const invalidateRequests = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.requests.all });
  const invalidateBomApprovals = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.bomApprovals.all });
  const invalidateAssetApprovals = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.fixedAssetApprovals.all });
  // `indents-updated` (raised/approved/paid/customs/refund actions) → indent badges.
  window.addEventListener('indents-updated', invalidateIndents);
  // `requests-updated` (issue/return/BOM batch issue) → request badges.
  window.addEventListener('requests-updated', invalidateRequests);
  // `approvals-updated` (an approval action landed) feeds the approvals dot's
  // indent part, its request part, AND the BOM-approval part, so refresh all
  // three. A BOM submit/approve/reject dispatches this event, so the BOM dot
  // clears the moment a manager acts (or a new BOM lands in their queue).
  window.addEventListener('approvals-updated', () => {
    invalidateIndents();
    invalidateRequests();
    invalidateBomApprovals();
    // FINANCE's Fixed Assets dot — a proposal approved/rejected/submitted shifts
    // the PENDING queue. No-op fetch for roles whose query is disabled.
    invalidateAssetApprovals();
  });
};

// TransformInterceptor wraps OK responses as { statusCode, message, data }.
// The badge-counts endpoints return a plain object, so the counts live at
// `.data.data`. Fall back to {} so a disabled/in-flight query reads as zeroes.
const toCounts = (data: any): Record<string, number> => data?.data ?? {};

// Shared freshness policy for every badge query. These counts mostly change
// from OTHER users' actions (a teammate raising an indent, submitting a BOM,
// etc.), so window-focus refetch is what keeps a returning tab honest — the
// acting client is already covered instantly by the domain-event invalidation
// above. A 60s staleTime stops rapid alt-tabbing from re-firing all of them on
// every focus while still refreshing within a minute. One object so the five
// queries can't drift apart.
const BADGE_QUERY_OPTS = {
  refetchOnWindowFocus: true,
  staleTime: 60 * 1000,
} as const;

interface BadgeCountOptions {
  /** Fetch `/indents/badge-counts` (approvals-indent / procurement / finance / refunds badges). */
  needsIndents: boolean;
  /** Fetch `/requests/badge-counts` (inventory badges + ADMIN/SA approvals count). */
  needsRequests: boolean;
  /** Also requires `/requests/badge-counts` (MANAGER team-approvals count). */
  needsTeamApprovals: boolean;
  /** Fetch `/bom-lists/approvals/manager/count` (MANAGER/ADMIN/SUPER_ADMIN Approvals dot). */
  needsBomApprovals: boolean;
  /** Fetch `/fixed-assets/approvals/pending-count` (FINANCE Fixed Assets dot). */
  needsAssetApprovals: boolean;
}

export const useSidebarBadgeCounts = ({
  needsIndents,
  needsRequests,
  needsTeamApprovals,
  needsBomApprovals,
  needsAssetApprovals,
}: BadgeCountOptions) => {
  const queryClient = useQueryClient();

  useEffect(() => {
    installGlobalListeners(queryClient);
  }, [queryClient]);

  // ---- Refresh badge counts on in-app navigation ----
  // The badge queries fetch once when DashboardLayout mounts (the layout
  // persists across every `/role/*` page, so it never remounts on inner
  // navigation) and then lean on refetchOnWindowFocus to stay fresh. But
  // window-focus only fires on a REAL browser focus event — switching tabs,
  // returning from another app. It does NOT fire on client-side route changes.
  // So a user who stays in the app, clicking page to page without ever blurring
  // the window, keeps whatever counts were cached at mount. When a queue fills
  // from ANOTHER user's action (e.g. an admin routing a BOM, which spawns the
  // inventory issue-requests), no in-tab domain event reaches this user's tab
  // and no focus event ever happens — so the sidebar dot stays absent even as
  // the page itself lists the new rows. That's the "3 requests, no red dot" gap.
  //
  // Treat each navigation as the in-app analog of returning to the tab: refetch
  // the badge queries the moment the user's attention moves to a new page —
  // but only the ones older than the 60s staleTime, the same rule a real
  // window focus follows. This used to invalidate unconditionally, so clicking
  // through five pages in ten seconds cost five rounds of every badge request
  // for counts fetched seconds earlier. The acting user's own changes do not
  // depend on this: every mutation dispatches a domain event that invalidates
  // its badges at once (see installGlobalListeners). `type: 'active'` skips
  // queries a given role doesn't show. Event-driven, no idle polling.
  const { pathname } = useLocation();
  const didMount = useRef(false);
  useEffect(() => {
    // Skip the first run: the queries already fetch fresh when they mount, so
    // only *subsequent* navigations need the nudge.
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    // The badge keys are what this effect is for. Two list() invalidations
    // used to sit here too, but list() with no params is the key
    // ['indents','list',undefined], which matches only the idle useIndents /
    // useRequests queries — they refreshed nothing and were removed.
    const onlyStale = { type: 'active', stale: true } as const;
    queryClient.refetchQueries({ queryKey: queryKeys.indents.badgeCounts(), ...onlyStale });
    queryClient.refetchQueries({ queryKey: queryKeys.requests.badgeCounts(), ...onlyStale });
    queryClient.refetchQueries({ queryKey: queryKeys.bomApprovals.count(), ...onlyStale });
    queryClient.refetchQueries({ queryKey: queryKeys.fixedAssetApprovals.count(), ...onlyStale });
  }, [pathname, queryClient]);

  // These MUST NOT share a key with useRequests / useIndents. Both of those
  // register ['requests','list',undefined] / ['indents','list',undefined] while
  // their params are undefined, which is exactly what `list()` returns with no
  // argument — so the badge queries and the full-list queries were the same
  // Query object with two different queryFns, and the last observer to render
  // won. See queryKeys.requests.badgeCounts for the full mechanism. The
  // domain-event listeners above invalidate by prefix (`indents.all` /
  // `requests.all`), so these still refresh on every event that used to reach
  // them.
  const indentCountsQuery = useQuery({
    queryKey: queryKeys.indents.badgeCounts(),
    queryFn: async () => toCounts((await client.get('/indents/badge-counts')).data),
    enabled: needsIndents,
    ...BADGE_QUERY_OPTS,
  });

  // One call covers BOTH the inventory/approvals badges AND the manager
  // team-approvals badge — the endpoint returns all four request counts, each
  // scoped server-side (team-approvals naturally 0 for anyone with no reports).
  const requestCountsQuery = useQuery({
    queryKey: queryKeys.requests.badgeCounts(),
    queryFn: async () => toCounts((await client.get('/requests/badge-counts')).data),
    enabled: needsRequests || needsTeamApprovals,
    ...BADGE_QUERY_OPTS,
  });

  // BOM approval queue count — its own integer-only endpoint (server scopes the
  // queue to what the caller may approve, identical to the Approvals page list).
  // Keyed under bomApprovals so the `approvals-updated` listener above refreshes
  // it the moment a BOM is submitted, approved, or rejected.
  const bomApprovalsQuery = useQuery({
    queryKey: queryKeys.bomApprovals.count(),
    queryFn: async () => (await bomListsApi.approvalsManagerCount()).count ?? 0,
    enabled: needsBomApprovals,
    ...BADGE_QUERY_OPTS,
  });

  // Pending asset-approval queue count — its own integer-only endpoint, scoped
  // server-side to what the caller may review (FINANCE sees the org-wide PENDING
  // queue). Keyed under fixedAssetApprovals so the `approvals-updated` listener
  // refreshes it when a proposal is approved/rejected/submitted.
  const assetApprovalsQuery = useQuery({
    queryKey: queryKeys.fixedAssetApprovals.count(),
    queryFn: async () => toCounts((await client.get('/fixed-assets/approvals/pending-count')).data).count ?? 0,
    enabled: needsAssetApprovals,
    ...BADGE_QUERY_OPTS,
  });

  const indentCounts = indentCountsQuery.data ?? {};
  const requestCounts = requestCountsQuery.data ?? {};

  return {
    // ---- indent-derived ----
    // Tech-lane queue (PENDING + tech gate open) — what ADMIN's Approvals badge
    // uses. A raw all-PENDING count over-counted them: indents they'd already
    // tech-approved sit at status PENDING awaiting the CEO, so the badge lingered
    // with nothing for the admin to do.
    techPendingIndents: indentCounts.techPendingIndents ?? 0,
    // CEO-lane subset (tech-approved, CEO-pending, ≥₹20k) — what SUPER_ADMIN's
    // Approvals badge uses. Same over-count reasoning, one gate later.
    ceoPendingIndents: indentCounts.ceoPendingIndents ?? 0,
    procurementQueue: indentCounts.procurementQueue ?? 0,
    financePayments: indentCounts.financePayments ?? 0,
    financeCustomsDuty: indentCounts.financeCustomsDuty ?? 0,
    refundsPending: indentCounts.refundsPending ?? 0,
    // ---- request-derived ----
    pendingInventoryRequests: requestCounts.pendingInventoryRequests ?? 0,
    openIssueSlips: requestCounts.openIssueSlips ?? 0,
    pendingRequestApprovals: requestCounts.pendingRequestApprovals ?? 0,
    pendingTeamApprovals: requestCounts.pendingTeamApprovals ?? 0,
    // Team indents waiting for the manager's signature. Rides on the same
    // /requests/badge-counts call the Team Approvals dot already makes.
    pendingTeamIndentApprovals: requestCounts.pendingTeamIndentApprovals ?? 0,
    // RETURN_REQUESTED count — badges the inventory Returns desk. Rides on the
    // same /requests/badge-counts call (no extra fetch).
    pendingReturns: requestCounts.pendingReturns ?? 0,
    // ---- BOM-approval-derived ----
    pendingBomApprovals: bomApprovalsQuery.data ?? 0,
    // ---- fixed-asset-approval-derived ----
    pendingAssetApprovals: assetApprovalsQuery.data ?? 0,
  };
};
