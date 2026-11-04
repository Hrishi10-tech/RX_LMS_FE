// Canonical status → tone / label maps + lookups. Kept in a NON-component
// module (no JSX exports) so the StatusBadge component file stays
// component-only — Vite/React fast-refresh only hot-reloads a file that
// exports components alone. Dense surfaces (e.g. the BOM slip's per-line
// status column) reuse the SAME colours + wording through the exported
// helpers, and <StatusBadge> itself renders off them — one source of truth.

const STATUS_STYLES: Record<string, string> = {
  // Positive / Complete
  APPROVED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30',
  COMPLETED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30',
  AVAILABLE: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30',
  RECEIVED: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30',
  RETURNED: 'bg-teal-50 text-teal-700 ring-teal-600/20 dark:bg-teal-400/15 dark:text-teal-300 dark:ring-teal-400/30',
  PAYMENT_DONE: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30',
  // Fixed-asset condition — WORKING reads as healthy (green). DAMAGED/DISPOSED
  // already map to red below; NEEDS_REPAIR sits between them as a warning.
  WORKING: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30',

  // Warning / Pending
  PENDING: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30',
  YET_TO_ISSUE: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30',
  LOW_STOCK: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30',
  'LOW STOCK': 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30',
  AWAITING_PAYMENT: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30',
  NEEDS_REPAIR: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30',
  // A routed indent still awaiting its admin(Tech)/CEO sign-off — more precise
  // than the raw indent status of PENDING on the BOM slip's procurement lines.
  AWAITING_TECH: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30',
  AWAITING_CEO: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30',

  // Danger / Error
  OVERDUE: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-400/15 dark:text-red-300 dark:ring-red-400/30',
  REJECTED: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-400/15 dark:text-red-300 dark:ring-red-400/30',
  OUT_OF_STOCK: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-400/15 dark:text-red-300 dark:ring-red-400/30',
  'OUT OF STOCK': 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-400/15 dark:text-red-300 dark:ring-red-400/30',
  CANCELLED: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-400/15 dark:text-red-300 dark:ring-red-400/30',
  DISPOSED: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-400/15 dark:text-red-300 dark:ring-red-400/30',
  DAMAGED: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-400/15 dark:text-red-300 dark:ring-red-400/30',

  // Return flow
  RETURN_REQUESTED: 'bg-orange-50 text-orange-700 ring-orange-600/20 dark:bg-orange-400/15 dark:text-orange-300 dark:ring-orange-400/30',

  // Active / In Progress
  IN_USE: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-400/15 dark:text-blue-300 dark:ring-blue-400/30',
  PROCESSED: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-400/15 dark:text-blue-300 dark:ring-blue-400/30',
  IN_PROGRESS: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-400/15 dark:text-blue-300 dark:ring-blue-400/30',
  QUOTATION_IN_PROGRESS: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-400/15 dark:text-blue-300 dark:ring-blue-400/30',
  READY_FOR_PAYMENT: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-400/15 dark:text-blue-300 dark:ring-blue-400/30',

  // BOM lifecycle — "routed" = manager-approved and now in fulfillment
  // (in-stock issued, procurement bundled to an indent that still needs the
  // admin/Tech sign-off). Sky = approved & active, distinct from terminal green.
  ROUTED: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-400/15 dark:text-sky-300 dark:ring-sky-400/30',

  // Procurement pipeline
  ORDERED: 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-400/15 dark:text-violet-300 dark:ring-violet-400/30',
  IN_TRANSIT: 'bg-cyan-50 text-cyan-700 ring-cyan-600/20 dark:bg-cyan-400/15 dark:text-cyan-300 dark:ring-cyan-400/30',
  // Some vendors delivered, others still in transit — partway to RECEIVED's
  // emerald, so lime reads as "nearly there but not done".
  PARTIALLY_RECEIVED: 'bg-lime-50 text-lime-700 ring-lime-600/20 dark:bg-lime-400/15 dark:text-lime-300 dark:ring-lime-400/30',
  // User-facing pseudo-status for any in-transit indent with open customs.
  CUSTOMS_CLEARANCE: 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-400/15 dark:text-violet-300 dark:ring-violet-400/30',

  // Dispositions
  EMBEDDED: 'bg-purple-50 text-purple-700 ring-purple-600/20 dark:bg-purple-400/15 dark:text-purple-300 dark:ring-purple-400/30',
  CONSUMED: 'bg-orange-50 text-orange-700 ring-orange-600/20 dark:bg-orange-400/15 dark:text-orange-300 dark:ring-orange-400/30',
  LONG_TERM_LOAN: 'bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-400/15 dark:text-sky-300 dark:ring-sky-400/30',

  // Roles
  SUPER_ADMIN: 'bg-red-50 text-red-700 ring-red-600/20 dark:bg-red-400/15 dark:text-red-300 dark:ring-red-400/30',
  ADMIN: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20 dark:bg-indigo-400/15 dark:text-indigo-300 dark:ring-indigo-400/30',
  MANAGER: 'bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-400/15 dark:text-violet-300 dark:ring-violet-400/30',
  USER: 'bg-blue-50 text-blue-700 ring-blue-600/20 dark:bg-blue-400/15 dark:text-blue-300 dark:ring-blue-400/30',
  LAB: 'bg-teal-50 text-teal-700 ring-teal-600/20 dark:bg-teal-400/15 dark:text-teal-300 dark:ring-teal-400/30',
  PROCUREMENT: 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-400/15 dark:text-amber-300 dark:ring-amber-400/30',
  INVENTORY: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-400/15 dark:text-emerald-300 dark:ring-emerald-400/30',
  FINANCE: 'bg-cyan-50 text-cyan-700 ring-cyan-600/20 dark:bg-cyan-400/15 dark:text-cyan-300 dark:ring-cyan-400/30',
};

const LABEL_MAP: Record<string, string> = {
  QUOTATION_IN_PROGRESS: 'Quoting',
  AWAITING_PAYMENT: 'Awaiting Payment',
  READY_FOR_PAYMENT: 'Ready for Payment',
  PAYMENT_DONE: 'Payment Done',
  IN_TRANSIT: 'In Transit',
  PARTIALLY_RECEIVED: 'Partly Received',
  CUSTOMS_CLEARANCE: 'Customs clearance',
  AWAITING_TECH: 'Awaiting Tech',
  AWAITING_CEO: 'Awaiting CEO',
  IN_USE: 'Issued',
  YET_TO_ISSUE: 'Yet to Issue',
  OUT_OF_STOCK: 'Out of Stock',
  LOW_STOCK: 'Low Stock',
  LONG_TERM_LOAN: 'Long-term Loan',
  RETURN_REQUESTED: 'Return Requested',
  NEEDS_REPAIR: 'Needs Repair',
  SUPER_ADMIN: 'Super Admin',
  // "ROUTED" is internal pipeline jargon — the user sees "Approved" (the BOM
  // cleared its approval; downstream procurement/admin steps surface elsewhere).
  ROUTED: 'Approved',
  // Terminal "fully fulfilled" — every BOM component issued to the requester.
  COMPLETED: 'Completed',
};

// Canonical status → tone / label lookups, exported so dense surfaces (e.g. the
// BOM slip's per-line status column) can render a compact chip in the SAME
// colours and wording as the standard badge without duplicating the maps.
export const statusClasses = (status: string) =>
  STATUS_STYLES[status.toUpperCase()] || 'bg-surface text-secondary ring-muted/20 dark:ring-muted/30';
export const statusLabel = (status: string) =>
  LABEL_MAP[status.toUpperCase()] || status.replace(/_/g, ' ');
