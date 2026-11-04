import { extractErrorMessage } from '@/lib';

export interface BulkResult {
  /** How many items the action succeeded on. */
  succeeded: number;
  /** Per-item failures with a human-readable reason (first one drives the toast). */
  failed: { id: string; message: string }[];
}

/**
 * Fire one async call per id (in parallel) and tally the outcomes. Best-effort:
 * one id failing never blocks the rest — used to batch a per-row action (e.g.
 * DELETE /projects/:id) from a bulk-selection toolbar when there is no dedicated
 * bulk backend endpoint. Reuses the EXACT same per-row endpoint the single-row
 * button already calls, so it inherits every server-side guard (link checks,
 * self-delete protection, draft-only checks) for free.
 */
/** Requests in flight at once. All-at-once tripped the server's rate limit on large selections. */
const BULK_CONCURRENCY = 5;

export async function runPerId(
  ids: string[],
  fn: (id: string) => Promise<unknown>,
): Promise<BulkResult> {
  // A few at a time rather than every id at once: the server allows a burst
  // of about 60 requests per 10 seconds per user, and a large selection fired
  // in parallel came back partly as "Too many requests".
  const results: PromiseSettledResult<string>[] = new Array(ids.length);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const i = next++;
      try {
        await fn(ids[i]);
        results[i] = { status: 'fulfilled', value: ids[i] };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(BULK_CONCURRENCY, ids.length) }, worker));
  const failed: { id: string; message: string }[] = [];
  let succeeded = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') succeeded += 1;
    else failed.push({ id: ids[i], message: extractErrorMessage(r.reason, 'Failed') });
  });
  return { succeeded, failed };
}
