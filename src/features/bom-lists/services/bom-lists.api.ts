import { client } from '@/api';

/**
 * Edits a reviewer makes to a SUBMITTED BOM inside the approval slip before
 * committing an Approve or a Send-back — qty tweaks on existing lines plus
 * newly-added catalog/custom lines. Applied server-side inside the same
 * transaction; the requester is notified of the exact diff. All fields
 * optional (an empty object is a no-op).
 */
/**
 * Paging for the three history lists. The server pages them (default 50, max
 * 200) because they used to return every decided BOM in one response. The
 * history screens have no pager yet, so they ask for the largest page — the
 * 200 most recent — rather than silently dropping to 50.
 */
type HistoryPage = { take?: number; skip?: number };
const historyParams = ({ take = 200, skip }: HistoryPage) => (skip ? { take, skip } : { take });

export type ReviewerEdits = {
  qtyUpdates?: { itemId: string; qty: number }[];
  customQtyUpdates?: { customItemId: string; qty: number }[];
  newItems?: { inventoryItemId: string; qty: number }[];
  newCustomItems?: { name: string; qty: number; unit: string }[];
};

/**
 * Thin API layer for BOM Lists. All requests are auth-scoped automatically
 * via the existing axios interceptor.
 */
export const bomListsApi = {
  list: (params?: {
    status?: 'DRAFT' | 'SUBMITTED' | 'ROUTED' | 'COMPLETED' | 'REJECTED';
  }) => client.get('/bom-lists', { params }).then(r => r.data?.data ?? r.data),

  get: (id: string) =>
    client.get(`/bom-lists/${id}`).then(r => r.data?.data ?? r.data),

  create: (payload: {
    name: string;
    projectId?: string | null;
    departmentId: string;
    // List-level nature is optional — the per-row toggle on the BOM
    // editor is the source of truth. Omit to let the schema default
    // (TEMPORARY) apply; the value isn't user-visible after creation.
    nature?: 'TEMPORARY' | 'PERMANENT';
    durationValue: number;
    durationUnit: 'MINUTES' | 'HOURS' | 'DAYS' | 'WEEKS' | 'MONTHS';
    responsiblePersonIds: string[];
    // Shared procurement purpose — inherited by spawned indent lines whose
    // own per-line purpose is blank.
    purpose?: string | null;
  }) => client.post('/bom-lists', payload).then(r => r.data?.data ?? r.data),

  update: (id: string, payload: Partial<{
    name: string;
    projectId: string | null;
    nature: 'TEMPORARY' | 'PERMANENT';
    durationValue: number;
    durationUnit: 'MINUTES' | 'HOURS' | 'DAYS' | 'WEEKS' | 'MONTHS';
    responsiblePersonIds: string[];
    purpose: string | null;
  }>) => client.patch(`/bom-lists/${id}`, payload).then(r => r.data?.data ?? r.data),

  remove: (id: string) =>
    client.delete(`/bom-lists/${id}`).then(r => r.data?.data ?? r.data),

  addItems: (id: string, items: { inventoryItemId: string; qty: number; nature?: 'TEMPORARY' | 'PERMANENT'; durationValue?: number; durationUnit?: 'MINUTES' | 'HOURS' | 'DAYS' | 'WEEKS' | 'MONTHS'; notes?: string; purpose?: string; estimatedUnitAmount?: number; currency?: string; url?: string }[]) =>
    client.post(`/bom-lists/${id}/items`, { items }).then(r => r.data?.data ?? r.data),

  updateItem: (id: string, itemId: string, payload: { qty?: number; nature?: 'TEMPORARY' | 'PERMANENT'; durationValue?: number; durationUnit?: 'MINUTES' | 'HOURS' | 'DAYS' | 'WEEKS' | 'MONTHS'; notes?: string; purpose?: string; estimatedUnitAmount?: number; currency?: string; url?: string }) =>
    client.patch(`/bom-lists/${id}/items/${itemId}`, payload).then(r => r.data?.data ?? r.data),

  removeItem: (id: string, itemId: string) =>
    client.delete(`/bom-lists/${id}/items/${itemId}`).then(r => r.data?.data ?? r.data),

  // ---- Custom items (procurement-bound, user-typed) -----------------------

  addCustomItem: (id: string, payload: {
    name: string;
    qty: number;
    unit: string;
    estimatedUnitAmount?: number;
    currency?: string;
    category?: string;
    description?: string;
    partNumber?: string;
    url?: string;
    purpose?: string;
  }) => client.post(`/bom-lists/${id}/custom-items`, payload).then(r => r.data?.data ?? r.data),

  updateCustomItem: (id: string, customItemId: string, payload: Partial<{
    name: string;
    qty: number;
    unit: string;
    estimatedUnitAmount: number;
    currency: string;
    category: string;
    description: string;
    partNumber: string;
    url: string;
    purpose: string;
  }>) => client.patch(`/bom-lists/${id}/custom-items/${customItemId}`, payload).then(r => r.data?.data ?? r.data),

  removeCustomItem: (id: string, customItemId: string) =>
    client.delete(`/bom-lists/${id}/custom-items/${customItemId}`).then(r => r.data?.data ?? r.data),

  submit: (id: string) =>
    client.post(`/bom-lists/${id}/submit`).then(r => r.data?.data ?? r.data),

  // Pull a SUBMITTED BOM back to DRAFT so the requester can edit before any
  // reviewer has acted. Backend enforces the safety gate (all-pending only);
  // throws 400 if anyone has approved/rejected anything downstream.
  recall: (id: string) =>
    client.post(`/bom-lists/${id}/recall`).then(r => r.data?.data ?? r.data),

  // Pull a ROUTED BOM back to DRAFT for one more edit cycle (edit-after-route).
  // Allowed until procurement's quote is done — the backend `revisable` flag
  // gates the button; the service re-checks and 400s if the window closed.
  // Tears down the spawned indent + un-issued in-stock requests and bumps the
  // version. The prior approval is CLEARED — edits after approval always go
  // back through a fresh manager review (no auto-route).
  revise: (id: string) =>
    client.post(`/bom-lists/${id}/revise`).then(r => r.data?.data ?? r.data),

  // Re-raise a rejected (or closed) ComponentRequest that was spawned
  // from this BOM. Caller can override qty + supply a reason. New request
  // gets the same bomListId so it lands back on the BOM's status rollup.
  reraiseRequest: (id: string, reqId: string, body: { qty?: number; reason?: string }) =>
    client.post(`/bom-lists/${id}/requests/${reqId}/re-raise`, body).then(r => r.data?.data ?? r.data),

  // ---- BOM Batches (inventory clerk view) -----------------------------------

  listActiveBatches: () =>
    client.get('/bom-lists/batches/active').then(r => r.data?.data ?? r.data),

  listHistoryBatches: (page: HistoryPage = {}) =>
    client.get('/bom-lists/batches/history', { params: historyParams(page) }).then(r => r.data?.data ?? r.data),

  getBatch: (id: string) =>
    client.get(`/bom-lists/batches/${id}`).then(r => r.data?.data ?? r.data),

  /**
   * Bulk-issue every ticked line on a BOM. Atomic — any single failure
   * rolls the whole batch back.
   */
  bulkIssue: (items: { requestId: string; qtyToIssue?: number; autoRaiseBackorder?: boolean }[]) =>
    client.post('/requests/bulk-issue', { items }).then(r => r.data?.data ?? r.data),

  // bulkProcess removed — the v2 BomApprovalSlipModal approves the whole
  // BOM in one click via the new /approve/* endpoints. The legacy
  // /requests/bulk-process endpoint was removed too (it had no caller).

  // ---- Approval (single stage) -------------------------------------------
  // One manager/admin sign-off clears the whole BOM and routes it. The
  // endpoint keeps its `/approve/manager` path; there is no tech/CEO stage
  // at the BOM level (any spawned indent runs its own approval cycle).

  approveManager: (id: string, payload: { notes?: string; reviewerEdits?: ReviewerEdits } = {}) =>
    client.post(`/bom-lists/${id}/approve/manager`, payload).then(r => r.data?.data ?? r.data),

  /**
   * Per-line review: approve or reject a ticked subset of the BOM's lines.
   * `itemIds` are catalog BomListItem ids, `customItemIds` are custom-line
   * ids — send either or both. `reason` is required when decision is REJECT.
   * The BOM stays SUBMITTED; the final approveManager() routes it (skipping
   * any line left REJECTED). Returns the refreshed BOM.
   */
  reviewItems: (id: string, payload: {
    itemIds?: string[];
    customItemIds?: string[];
    decision: 'APPROVE' | 'REJECT';
    reason?: string;
  }) => client.post(`/bom-lists/${id}/items/review`, payload).then(r => r.data?.data ?? r.data),

  /**
   * Reject the BOM's single approval — terminally closes the whole BOM (status
   * REJECTED, reason on record). Use it for a BOM that shouldn't exist
   * (duplicate, mistaken submission, against policy), NOT for one that just
   * needs fixing — that's what returnForRevision() is for. Reason is required.
   * Only a SUBMITTED BOM can be rejected.
   */
  reject: (id: string, reason: string) =>
    client.post(`/bom-lists/${id}/reject`, { reason }).then(r => r.data?.data ?? r.data),

  /**
   * Send a SUBMITTED BOM back to the creator — the alternative to
   * approveManager (which routes the survivors on to procurement's tech/CEO
   * gates). A note, a rejected line, OR reviewer edits are each enough to send
   * it back; flips the BOM to DRAFT (verdicts preserved so the editor shows
   * what to fix) and notifies the creator. `reviewerEdits` (qty tweaks / added
   * lines the manager made in the slip) ride along onto the reopened version.
   */
  returnForRevision: (id: string, note?: string, reviewerEdits?: ReviewerEdits) => {
    const payload: { note?: string; reviewerEdits?: ReviewerEdits } = {};
    if (note) payload.note = note;
    if (reviewerEdits) payload.reviewerEdits = reviewerEdits;
    return client.post(`/bom-lists/${id}/return-for-revision`, payload).then(r => r.data?.data ?? r.data);
  },

  /**
   * Indent-layer "send the whole BOM back to the requester" — the GO-BACK fork
   * of the spawned indent's per-line review. Bounces a ROUTED BOM to DRAFT as a
   * new version (v+1), tears down the pending indent + un-issued in-stock
   * requests, and clears the manager sign-off so the resubmit re-enters FULL
   * approval (same approval semantics as revise(); the difference is this is
   * reviewer-initiated and requires ≥1 rejected indent line server-side).
   * Optional note rides the timeline + notice.
   */
  returnRoutedForRevision: (id: string, note?: string) =>
    client.post(`/bom-lists/${id}/return-routed-for-revision`, note ? { note } : {}).then(r => r.data?.data ?? r.data),

  /**
   * Revoke a routed BOM's approval — the approver's undo. Flips it back to
   * SUBMITTED (re-enters the approval queue), tearing down the spawned indent +
   * un-issued in-stock requests. Allowed only while still `revisable`
   * (procurement hasn't quoted, inventory hasn't issued); backend re-checks.
   */
  revokeApproval: (id: string) =>
    client.post(`/bom-lists/${id}/revoke-approval`).then(r => r.data?.data ?? r.data),

  /** The single approval queue for the approver-facing page. */
  approvalsManager: () =>
    client.get('/bom-lists/approvals/manager').then(r => r.data?.data ?? r.data),

  /** Integer-only count of that same queue — drives the sidebar red dot. */
  approvalsManagerCount: (): Promise<{ count: number }> =>
    client.get('/bom-lists/approvals/manager/count').then(r => r.data?.data ?? r.data),

  /**
   * Decided-BOM history (routed / completed / rejected) — the audit
   * counterpart of approvalsManager(), same role-scoping server-side. This is
   * the approver's *decision* audit, so ROUTED (approved, in flight) stays
   * alongside COMPLETED (fully issued) + REJECTED. Drives the "BOM History"
   * button on the approver console; each row opens the read-only slip + its
   * per-version Timeline. `{ items: [...], total }`, newest first, one page.
   */
  approvalsManagerHistory: (page: HistoryPage = {}) =>
    client.get('/bom-lists/approvals/manager/history', { params: historyParams(page) }).then(r => r.data?.data ?? r.data),

  /**
   * Creator-facing history — the caller's OWN *settled* BOMs: COMPLETED (every
   * component issued to them) or REJECTED. A ROUTED BOM is still in flight and
   * lives in the active BOM Lists table, not here. Drives the History button
   * on the BOM Lists page; each row opens the editor + its per-version
   * Timeline. `{ items: [], total }`, newest first, one page.
   */
  myHistory: (page: HistoryPage = {}) =>
    client.get('/bom-lists/history/mine', { params: historyParams(page) }).then(r => r.data?.data ?? r.data),

  /** Append-only audit timeline — every state transition + items edit. */
  timeline: (id: string) =>
    client.get(`/bom-lists/${id}/timeline`).then(r => r.data?.data ?? r.data),

  /**
   * Version list (v1..current) for the dropdown. Each row flags whether it's
   * the live current version (`isCurrent`), carries a sealed snapshot
   * (`hasSnapshot`), or predates snapshots but is rebuildable from the audit
   * log (`reconstructed`). All non-current rows are renderable inline.
   * `{ currentVersion, items: [...] }`.
   */
  versions: (id: string) =>
    client.get(`/bom-lists/${id}/versions`).then(r => r.data?.data ?? r.data),

  /**
   * Read-only row set of one PAST version. Returns the sealed snapshot when one
   * exists, else a best-effort reconstruction from the audit log (flagged
   * `reconstructed: true` — exact totals/verdicts, latest qty/price). 404s only
   * for the live current version or a version with no record. `{ version,
   * rows: [...], reconstructed, ... }`.
   */
  versionSnapshot: (id: string, version: number) =>
    client.get(`/bom-lists/${id}/versions/${version}`).then(r => r.data?.data ?? r.data),
};
