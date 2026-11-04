/**
 * Shared "why is this status" helpers, used everywhere an indent or request status
 * is shown. Each helper returns a short italic reason string when applicable, or
 * `null` when there's nothing to add to the bare status badge.
 *
 * A row can carry a reason in several states:
 *   - PENDING reason  → who/what we're waiting on (e.g. "Awaiting Tech approval").
 *   - APPROVED reason → (requests only) the physical step still left, so a
 *                       requester doesn't read "Approved" and wonder why the
 *                       part isn't in hand yet.
 *   - REJECTED reason → text entered by the approver when they declined.
 *
 * `statusReasonForIndent` / `statusReasonForRequest` are the convenience entry
 * points that callers should prefer — they auto-pick the right helper.
 */

import { CEO_APPROVAL_THRESHOLD, ceoApprovalRequiredFor } from '../config/thresholds';

export function pendingReasonForIndent(r: any): string | null {
  if (r?.status !== 'PENDING') return null;
  const techPending = r.techApprovalStatus === 'PENDING';
  // Blocking question, so use the fail-closed gate that mirrors the backend:
  // false whenever CEO approval is optional (nothing is waiting on the CEO, so
  // never say it is), and an unknown currency reads as "needs CEO" rather than
  // lenient toInr's 1:1 fallback under-counting it.
  const needsCeo    = ceoApprovalRequiredFor(r.grandTotal, r.currency);
  const ceoPending  = needsCeo && r.ceoApprovalStatus === 'PENDING';
  if (techPending && ceoPending) return 'Awaiting Tech + CEO approval';
  if (techPending)               return 'Awaiting Tech approval';
  if (ceoPending)                return `Awaiting CEO approval (≥₹${CEO_APPROVAL_THRESHOLD().toLocaleString()})`;
  return 'Awaiting approval';
}

export function pendingReasonForRequest(r: any): string | null {
  // PENDING → the manager hasn't signed off yet.
  if (r?.status === 'PENDING') return 'Awaiting Manager approval';
  // APPROVED reads as "done" but there's still one physical step left, which
  // is exactly what confused requesters looking at a component that's clearly
  // sitting in inventory. The manager signed off AND the stock is reserved for
  // them — the only thing left is inventory physically handing it over. Say
  // that plainly instead of a bare "Approved" pill.
  if (r?.status === 'APPROVED') return 'Approved — waiting for inventory to hand it over';
  // YET_TO_ISSUE → approved, but stock ran short, so it's queued to issue on
  // the next replenishment. Tells the requester it's a stock wait, not a
  // sign-off wait.
  if (r?.status === 'YET_TO_ISSUE') return 'Approved — queued for the next stock top-up';
  return null;
}

/**
 * Returns the rejection reason captured by the tech approver, the CEO, or both —
 * whichever fields are populated on the row. When both stages rejected (rare), the
 * tech reason wins because tech is the earlier blocker.
 */
export function rejectionReasonForIndent(r: any): string | null {
  if (r?.status !== 'REJECTED') return null;
  const tech = (r.techRejectionReason || '').trim();
  const ceo  = (r.ceoRejectionReason  || '').trim();
  if (tech && ceo) return `Tech: ${tech} · CEO: ${ceo}`;
  if (tech)        return `Tech: ${tech}`;
  if (ceo)         return `CEO: ${ceo}`;
  return null;
}

export function rejectionReasonForRequest(r: any): string | null {
  if (r?.status !== 'REJECTED') return null;
  const reason = (r.rejectionReason || '').trim();
  return reason || null;
}

/** Convenience: returns the pending OR rejection reason for an indent. */
export function statusReasonForIndent(r: any): string | null {
  return pendingReasonForIndent(r) ?? rejectionReasonForIndent(r);
}

/** Convenience: returns the pending OR rejection reason for a request. */
export function statusReasonForRequest(r: any): string | null {
  return pendingReasonForRequest(r) ?? rejectionReasonForRequest(r);
}
