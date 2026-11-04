/**
 * Centralised query-key factories — one per feature. Using factories instead of
 * inline arrays keeps key shapes consistent so cache invalidation works correctly
 * across hooks. Pattern: `queryKeys.<feature>.list(params?)` for collections,
 * `queryKeys.<feature>.detail(id)` for single records.
 */
export const queryKeys = {
  inventory: {
    all: ['inventory'] as const,
    list: (params?: Record<string, any>) => ['inventory', 'list', params] as const,
    detail: (id: string) => ['inventory', 'detail', id] as const,
  },
  indents: {
    all: ['indents'] as const,
    list: (params?: Record<string, any>) => ['indents', 'list', params] as const,
    detail: (id: string) => ['indents', 'detail', id] as const,
    // Integer-only sidebar badge counts. MUST NOT reuse list() — see the note
    // on requests.badgeCounts below.
    badgeCounts: () => ['indents', 'badge-counts'] as const,
  },
  requests: {
    all: ['requests'] as const,
    list: (params?: Record<string, any>) => ['requests', 'list', params] as const,
    detail: (id: string) => ['requests', 'detail', id] as const,
    /**
     * Integer-only sidebar badge counts, on their own key.
     *
     * These used to be registered under `list()`, which with no argument is
     * `['requests','list',undefined]` — the SAME key `useRequests` uses while
     * its params are undefined. React Query keeps one Query object per key, and
     * every observer's `setOptions` re-stamps its own `queryFn` onto it, so the
     * landing page's (disabled) full-list observer overwrote the badge query's
     * queryFn. A `queryKey`-based invalidate then refetched the badge query
     * through `query.fetch(void 0)` — using the stamped full-list function.
     *
     * Two consequences, both reproduced in the browser: every navigation pulled
     * `GET /requests` (221,662 bytes, 187 rows) instead of
     * `GET /requests/badge-counts` (150 bytes), and the badge query's data
     * became an ARRAY of rows, so every count read `undefined` and every
     * request-derived badge silently showed 0.
     *
     * Same shape as bomApprovals.count() / fixedAssetApprovals.count(), which
     * were always on their own keys and never had the problem.
     */
    badgeCounts: () => ['requests', 'badge-counts'] as const,
  },
  users: {
    all: ['users'] as const,
    list: () => ['users', 'list'] as const,
    detail: (id: string) => ['users', 'detail', id] as const,
  },
  departments: {
    all: ['departments'] as const,
    list: () => ['departments', 'list'] as const,
  },
  messages: {
    all: ['messages'] as const,
    unreadCount: () => ['messages', 'unread-count'] as const,
  },
  notifications: {
    all: ['notifications'] as const,
    list: () => ['notifications', 'list'] as const,
    unreadCount: () => ['notifications', 'unread-count'] as const,
  },
  bomApprovals: {
    all: ['bomApprovals'] as const,
    // Integer count behind the Approvals sidebar dot (pending SUBMITTED BOMs).
    count: () => ['bomApprovals', 'count'] as const,
  },
  fixedAssetApprovals: {
    all: ['fixedAssetApprovals'] as const,
    // Integer count behind the Fixed Assets sidebar dot (PENDING proposals the
    // FINANCE reviewer can act on).
    count: () => ['fixedAssetApprovals', 'count'] as const,
  },
} as const;
