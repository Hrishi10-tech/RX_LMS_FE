import { client } from './axios';

// Lightweight per-session cache + in-flight dedup for slow-changing GET endpoints
// (departments, users, projects, etc.). Backed by a Map of `{ value, expires }`
// keyed by path. Concurrent calls to the same path share one network request.
//
// Why this exists: pages and modals were each firing fresh GET /users and
// GET /departments on mount — sometimes 4–6 calls within a single second
// when a page mounts a few components. At 300 concurrent users that's a
// significant share of total API traffic for data that changes once a day.
//
// Eviction: TTL (default 5 min) + automatic invalidation on writes against
// the same resource (see installAutoInvalidate below).

type CacheEntry<T> = { value: T; expires: number };
const cache = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

// Root resources the cache cares about. A mutation against any nested path
// (POST /users, PATCH /users/:id, DELETE /projects/:id, …) invalidates every
// cached GET that starts with `/<resource>`. Add more here only when you
// start putting them through cachedGet().
// '/inventory' is cached (ReceiveIndentModal, dashboards) but its stock changes
// on writes, so it MUST auto-invalidate. Receiving (POST /inventory/receive-indent)
// and adjusting (POST /inventory/:id/adjust) both live under /inventory, so a
// receive now busts the cache and the next open shows post-receive stock instead
// of a stale 5-min snapshot. (Issue/return mutate stock via /requests; those
// pages refetch their own lists, so they don't rely on this cache.)
const CACHED_RESOURCES = ['/users', '/departments', '/projects', '/vendor-codes', '/inventory'];

function invalidateByPrefix(prefix: string) {
  for (const key of cache.keys()) {
    if (key === prefix || key.startsWith(prefix + '?') || key.startsWith(prefix + '/')) {
      cache.delete(key);
    }
  }
}

let installed = false;
function installAutoInvalidate() {
  if (installed) return;
  installed = true;
  client.interceptors.response.use((res) => {
    const method = (res.config.method || '').toLowerCase();
    if (method === 'get') return res;
    const url = res.config.url || '';
    // url may be `/users/abc` or `/users` or include query string. Strip query, then match prefix.
    const path = url.split('?')[0];
    for (const root of CACHED_RESOURCES) {
      if (path === root || path.startsWith(root + '/')) {
        invalidateByPrefix(root);
      }
    }
    return res;
  });
}
installAutoInvalidate();

export async function cachedGet<T = unknown>(path: string, ttlMs = 5 * 60_000): Promise<T> {
  const now = Date.now();
  const entry = cache.get(path) as CacheEntry<T> | undefined;
  if (entry && entry.expires > now) return entry.value;

  const pending = inflight.get(path) as Promise<T> | undefined;
  if (pending) return pending;

  const p = (async () => {
    const res = await client.get<T>(path);
    cache.set(path, { value: res.data, expires: Date.now() + ttlMs });
    return res.data;
  })();
  inflight.set(path, p);
  try {
    return await p;
  } finally {
    inflight.delete(path);
  }
}
