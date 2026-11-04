import { client } from './axios';
import { setCeoApprovalRequired, setCeoApprovalThreshold } from '@/config/thresholds';

/**
 * Approval-policy bootstrap. The backend owns whether CEO sign-off is required
 * (CEO_APPROVAL_REQUIRED); the UI only mirrors it so columns and "why is this
 * pending?" copy match what the server will actually enforce.
 *
 * Same shape as lib/fx.ts:
 *   1. seed SYNCHRONOUSLY from localStorage before first render, so approval
 *      columns are right on the first paint after a reload,
 *   2. revalidate from the network and re-cache.
 * On any failure we keep whatever is already applied (cached → default false),
 * because a policy fetch must never be able to block the app from rendering.
 */

const CACHE_KEY = 'approval_policy_v1';

interface PolicyCache {
  ceoApprovalRequired: boolean;
  /** Optional: a cache written before the threshold was settable has none. */
  ceoApprovalThreshold?: number;
  cachedAt: number;
}

function readCache(): PolicyCache | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.ceoApprovalRequired === 'boolean') return parsed as PolicyCache;
  } catch {
    /* localStorage unavailable / corrupt → fall back to the default */
  }
  return null;
}

/**
 * Seed the policy from the last cached snapshot. Call ONCE, synchronously,
 * before React renders. Returns true if a cached value was found — main.tsx
 * uses that to decide whether it can render immediately or should wait for the
 * very first fetch (first-ever load has nothing to seed from).
 */
export function seedApprovalPolicyFromCache(): boolean {
  const cache = readCache();
  if (!cache) return false;
  setCeoApprovalRequired(cache.ceoApprovalRequired);
  // A cache written by an older build has no threshold; leaving the default in
  // place for the one render before the fetch lands is better than clearing it.
  if (typeof cache.ceoApprovalThreshold === 'number') setCeoApprovalThreshold(cache.ceoApprovalThreshold);
  return true;
}

/**
 * Fetch the live policy, apply it, and cache it. Fire-and-forget; never throws.
 *
 * No change event is emitted: main.tsx applies the policy BEFORE React mounts
 * (awaiting the fetch on a first-ever load), so nothing is rendered off a stale
 * value. A flag flipped server-side mid-session is picked up on the next reload.
 * An event nobody subscribed to was just dead weight.
 */
export async function bootstrapApprovalPolicy(): Promise<void> {
  try {
    const res = await client.get('/settings/approval-policy');
    const payload = res.data?.data ?? res.data;
    if (typeof payload?.ceoApprovalRequired !== 'boolean') return;
    applyApprovalPolicy(payload);
  } catch {
    /* backend down → keep the cached/default policy; the server still enforces */
  }
}

/**
 * Apply a policy to this tab AND write it to the seed cache.
 *
 * Both halves matter, and the Settings screen only ever did the first one: it
 * pushed the new values into memory, so the current page updated, and left the
 * cache holding the previous number. The cache is what seeds the very first
 * render after a reload — so saving ₹75,000 and refreshing showed ₹50,000
 * again until the bootstrap fetch landed and corrected it.
 *
 * That was survivable while the threshold only drove column visibility. Now
 * that the figure is printed in the copy that tells an approver what the rule
 * IS, a stale seed means the app states the wrong rule out loud for the first
 * paint of every reload. The bar is meant to be changed freely and be true
 * everywhere the moment it is, so the write and the cache belong together in
 * one call that both callers use.
 */
export function applyApprovalPolicy(payload: {
  ceoApprovalRequired: boolean;
  ceoApprovalThreshold?: number;
}): void {
  setCeoApprovalRequired(payload.ceoApprovalRequired);
  if (typeof payload.ceoApprovalThreshold === 'number') {
    setCeoApprovalThreshold(payload.ceoApprovalThreshold);
  }
  try {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        ceoApprovalRequired: payload.ceoApprovalRequired,
        ceoApprovalThreshold: payload.ceoApprovalThreshold,
        cachedAt: Date.now(),
      } as PolicyCache),
    );
  } catch {
    /* quota / unavailable — non-fatal, the in-memory value still applies */
  }
}

