// CEO approval kicks in at ₹20,000 — but ONLY while the CEO lane is switched on
// (see isCeoApprovalRequired below). The threshold is denominated in INR, so any
// non-INR indent MUST be converted before comparison — otherwise a USD 3,000
// indent (≈ ₹2.5L) sneaks under the bar as the bare number 3000 < 20000.
let ceoApprovalThreshold = 20000;

/**
 * The bar, in INR. A function, not a constant: a Super Admin sets it in
 * Settings, so it arrives with the approval-policy bootstrap exactly like the
 * on/off flag below. The 20000 is the value used before that bootstrap lands,
 * and must match the backend's column default or the first paint after a
 * first-ever load would disagree with the server.
 */
export const CEO_APPROVAL_THRESHOLD = (): number => ceoApprovalThreshold;

/**
 * The CEO bar as a phrase to drop into a sentence — "≥ ₹50,000", or "of any
 * value" when the bar is 0 and every indent needs the CEO.
 *
 * Lives here because the two pages that describe the rule to an approver both
 * had the literal "₹20,000" written into their copy. The bar is editable in
 * Settings, so the moment Finance moved it, both pages started stating a rule
 * the system no longer enforced — and an approver reads that sentence AS the
 * rule. One source, so the next change cannot leave half the app lying.
 *
 * Formatted here rather than through fmtINR to keep this module free of UI
 * imports; en-IN grouping with no paise matches fmtINR's output.
 */
export const ceoThresholdLabel = (): string =>
  ceoApprovalThreshold > 0 ? `≥ ${ceoThresholdMoney()}` : 'of any value';

/**
 * Just the formatted amount — "₹50,000" — for sentences that supply their own
 * comparison word ("above …", "… or more", "the … gate"). Those read wrong
 * with the "≥" that ceoThresholdLabel prepends.
 */
export const ceoThresholdMoney = (): string =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(ceoApprovalThreshold);

/**
 * True when the bar is 0 — every indent goes to the CEO regardless of value.
 *
 * Sentences that name the amount ("above …", "… or more", "the … gate") turn
 * into nonsense at zero: "CEO sign-off above ₹0" is technically true and reads
 * like a bug. Callers branch on this and say "every indent" instead.
 *
 * Distinct from the lane being OFF (`isCeoApprovalRequired() === false`),
 * which is the opposite policy and a separate switch.
 */
export const ceoGateCoversEverything = (): boolean => ceoApprovalThreshold === 0;

/** Applied by the approval-policy bootstrap. Ignores a nonsensical value
 *  rather than letting a bad response make every indent look CEO-gated. */
export function setCeoApprovalThreshold(value: number): boolean {
  // `< 0`, not `<= 0`. Zero is a real policy — the CEO approves every indent —
  // and rejecting it here made the UI keep quoting and enforcing the PREVIOUS
  // bar while the server and the Settings screen both said 0.
  if (!Number.isFinite(value) || value < 0) return false;
  const changed = ceoApprovalThreshold !== value;
  ceoApprovalThreshold = value;
  return changed;
}

// Is CEO sign-off required at all? Set from the backend at app start (see
// lib/approvalPolicy.ts → GET /settings/approval-policy), NOT from a build-time
// constant: the backend is the only enforcer, so mirroring its env var here by
// hand is how the UI ends up promising an approval the server doesn't want (or
// hiding one it does). Defaults to false — CEO approval optional, tech approval
// alone advances an indent — which matches the backend default.
let ceoApprovalRequired = false;

/** Current policy, as reported by the backend. */
export const isCeoApprovalRequired = (): boolean => ceoApprovalRequired;

/** Applied by the approval-policy bootstrap. Returns true if the value changed. */
export function setCeoApprovalRequired(value: boolean): boolean {
  const changed = ceoApprovalRequired !== value;
  ceoApprovalRequired = value;
  return changed;
}

// Static currency → INR reference table. Mirrors backend thresholds.ts. This is
// the SEED + FALLBACK: the working table below starts here, and live rates from
// GET /fx/rates (see lib/fx.ts) overwrite it in place. Frozen so the fallback
// baseline can't be mutated by the live refresh.
export const STATIC_CURRENCY_TO_INR: Readonly<Record<string, number>> = Object.freeze({
  INR: 1,
  USD: 83,
  EUR: 90,
  GBP: 105,
  JPY: 0.56,
  CNY: 11.5,
  AED: 22.6,
  SGD: 62,
  AUD: 55,
  CAD: 61,
});

// The LIVE working table. Seeded from the static baseline; applyLiveRates()
// mutates these values in place (never adds/removes keys) so every call site —
// toInr, rollupTotals — reads live rates with no code change. INR per 1 unit.
export const CURRENCY_TO_INR: Record<string, number> = { ...STATIC_CURRENCY_TO_INR };

/**
 * Overwrite live rates in place from a fetched { CODE: inrPerUnit } map.
 * Mirrors backend applyLiveRates — defensive so a bad feed can't corrupt totals:
 * only known keys, INR pinned at 1, each rate finite/>0 and within [0.2×, 5×]
 * of its static baseline. Returns the codes actually applied.
 */
export function applyLiveRates(rates: Record<string, number> | null | undefined): string[] {
  if (!rates) return [];
  const applied: string[] = [];
  for (const [code, value] of Object.entries(rates)) {
    const key = code.toUpperCase().trim();
    if (key === 'INR') continue;
    if (!(key in STATIC_CURRENCY_TO_INR)) continue;
    const v = Number(value);
    if (!Number.isFinite(v) || v <= 0) continue;
    const base = STATIC_CURRENCY_TO_INR[key];
    if (v < base * 0.2 || v > base * 5) continue;
    CURRENCY_TO_INR[key] = v;
    applied.push(key);
  }
  return applied;
}

/**
 * Convert an amount in the given currency to INR using the static table above.
 * Unknown / missing currency falls back to 1:1 (treat as INR).
 */
export function toInr(amount: number | string | null | undefined, currency?: string | null): number {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return 0;
  const rate = CURRENCY_TO_INR[(currency || 'INR').toUpperCase().trim()] ?? 1;
  return n * rate;
}

/**
 * FAIL-CLOSED conversion for the CEO-approval gate — mirrors backend
 * toInrForApprovalGate. Unlike `toInr` (which falls back to a lenient 1:1 rate
 * for an unknown currency, fine for display), an unknown/dirty currency here
 * returns +Infinity so the ≥₹20k gate treats it as "needs CEO", matching the
 * backend which refuses to let an unrecognised currency slip under the gate.
 * Use this ONLY for the approval-required decision, never for display totals.
 */
export function toInrForApprovalGate(amount: number | string | null | undefined, currency?: string | null): number {
  const n = Number(amount || 0);
  if (!Number.isFinite(n)) return Infinity;
  const code = (currency || 'INR').toUpperCase().trim();
  const rate = CURRENCY_TO_INR[code];
  if (rate === undefined) return Infinity; // unknown currency → fail closed
  return n * rate;
}

/** The currencies the indent UI allows — exactly the keys of the rate table.
 *  Mirrors backend thresholds.ts ALLOWED_CURRENCIES. */
export const ALLOWED_CURRENCIES = Object.keys(CURRENCY_TO_INR);

/**
 * Display-side CEO sign-off gate: true only when the CEO lane is switched on AND
 * the row's grand total (converted to INR) is at or above the ₹20k threshold.
 * While CEO approval is optional this is always false, so every column that
 * keys off it collapses to "N/A" on its own. Uses the lenient
 * `toInr` (for UI display / filtering); the fail-closed *decision* gate uses
 * `toInrForApprovalGate`. Replaces the many inline
 * `toInr(row.grandTotal, row.currency) >= CEO_APPROVAL_THRESHOLD` copies.
 */
export const needsCeoSignoff = (row: { grandTotal?: number | string | null; currency?: string | null }): boolean =>
  ceoApprovalRequired && toInr(row.grandTotal, row.currency) >= ceoApprovalThreshold;

/**
 * Should the CEO lane be SHOWN for this row (a cell, and Approve/Reject buttons
 * for a Super Admin)?
 *
 * This is the ₹20k amount test ALONE — deliberately independent of whether CEO
 * approval is required. The two questions are different and conflating them is
 * the bug waiting to happen here:
 *   - needsCeoSignoff → does a missing CEO signature BLOCK this indent?
 *   - ceoLaneVisible  → may the CEO still weigh in on it?
 * With CEO approval optional the answers are "no" and "yes": nothing waits on
 * the CEO, but they keep the ability to review, approve, or reject high-value
 * spend. Gating the buttons on needsCeoSignoff would silently take that away.
 */
export const ceoLaneVisible = (row: { grandTotal?: number | string | null; currency?: string | null }): boolean =>
  toInr(row.grandTotal, row.currency) >= ceoApprovalThreshold;

/**
 * What a CEO cell says when the lane is not shown, and why. "Under ₹20k" was
 * hard-coded and wrong twice over: the bar is set in Settings, and while CEO
 * approval is switched off the amount is not the reason at all.
 */
export const ceoNotApplicableLabel = (): string =>
  ceoApprovalRequired ? `N/A (under ${ceoThresholdMoney()})` : 'N/A';
export const ceoNotApplicableTitle = (): string =>
  ceoApprovalRequired
    ? `Below the ${ceoThresholdMoney()} CEO-approval threshold set in Settings.`
    : 'CEO approval is switched off in Settings → Indent Approval Policy.';

/**
 * Fail-closed twin of `needsCeoSignoff`, mirroring backend
 * `ceoApprovalRequiredFor`. Use this where the UI is reproducing the server's
 * *decision* (e.g. "why is this still pending?", "will the CEO be re-asked at
 * the firm price?") rather than just labelling a column. Same short-circuit:
 * while CEO approval is optional this is always false, so no screen invents a
 * CEO step the backend won't enforce.
 */
export const ceoApprovalRequiredFor = (
  amount: number | string | null | undefined,
  currency?: string | null,
): boolean => ceoApprovalRequired && toInrForApprovalGate(amount, currency) >= ceoApprovalThreshold;

/** Roles whose approval queue is org-wide (everyone else sees only their own scope). */
export const APPROVER_ROLES = ['ADMIN', 'SUPER_ADMIN', 'PROCUREMENT', 'FINANCE', 'INVENTORY', 'LAB'];
/** Roles allowed to approve / reject a BOM list. */
export const BOM_APPROVER_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'];
/** Roles allowed to advance a vendor order's fulfillment/payment status. */
export const VENDOR_ORDER_ROLES = ['PROCUREMENT', 'FINANCE', 'SUPER_ADMIN'];

/** Payment-method code → human label, shown on finance payment receipts. */
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  ONLINE: 'Online (vendor portal / gateway)',
  WIRE_TRANSFER: 'Wire / NEFT / RTGS',
  CHEQUE: 'Cheque',
  CASH: 'Cash',
  OTHER: 'Other',
};

/** Indent statuses that are terminal — no longer in the active fulfillment pipeline. */
export const TERMINAL_INDENT_STATUSES = ['RECEIVED', 'REJECTED', 'CANCELLED'];
/** Component-request statuses that mean the item has been issued to the requester. */
export const ISSUED_STATUSES = ['IN_USE', 'OVERDUE', 'RETURN_REQUESTED', 'RETURNED', 'CONSUMED', 'EMBEDDED', 'DISPOSED'];

/** A line that contributes to a grand total: a precomputed `total`, or
 *  `qty`×`unitAmount`, plus the line's own currency. */
export interface RollupLine {
  qty?: number | string | null;
  unitAmount?: number | string | null;
  total?: number | string | null;
  currency?: string | null;
}

/**
 * Roll up lines into one { grandTotal, currency }. Mirrors backend
 * rollupTotals: uniform currency → native sum kept in that currency; mixed
 * currencies → each line converted to INR and summed, currency becomes 'INR'.
 * Used by the quote modal so the displayed grand total matches what the
 * backend will persist once per-line currencies differ.
 */
/**
 * Round to the paisa the way the DATABASE will — the mirror of
 * `roundToPaisa` in backend/src/common/config/thresholds.ts.
 *
 * `Math.round(n * 100) / 100` is not the same rule. A value that is exactly
 * half a paisa in decimal — 1.005 — is held in binary as
 * 1.0049999999999998934, so JavaScript rounds it DOWN to 1.00 while Postgres
 * rounds half away from zero and stores 1.01. This file exists so the total
 * on screen matches the one the backend persists; rounding differently here
 * would quietly break that promise, which is the whole reason it is
 * duplicated.
 */
export function roundToPaisa(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const negative = n < 0;
  const text = Math.abs(n).toFixed(10);
  const [whole, frac] = text.split('.');
  const kept = Number(`${whole}.${frac.slice(0, 2)}`);
  const nextDigit = frac.charCodeAt(2) - 48;
  const rounded = nextDigit >= 5 ? (Math.round(kept * 100) + 1) / 100 : kept;
  return negative ? -rounded : rounded;
}

export function rollupTotals(lines: RollupLine[]): { grandTotal: number; currency: string } {
  if (!lines || lines.length === 0) return { grandTotal: 0, currency: 'INR' };
  const round2 = roundToPaisa;
  const norm = (c?: string | null) => (c || 'INR').toUpperCase().trim();
  const lineTotal = (l: RollupLine) =>
    l.total != null ? Number(l.total) : Number(l.qty || 0) * Number(l.unitAmount || 0);
  const currencies = new Set(lines.map((l) => norm(l.currency)));
  if (currencies.size <= 1) {
    return {
      // Per line, then the sum — the same order the backend uses, because
      // each line is stored rounded and the total has to equal their sum.
      grandTotal: round2(lines.reduce((s, l) => s + round2(lineTotal(l)), 0)),
      currency: norm(lines[0]?.currency),
    };
  }
  return {
    grandTotal: round2(lines.reduce((s, l) => s + round2(toInr(round2(lineTotal(l)), l.currency)), 0)),
    currency: 'INR',
  };
}

/** A vendor allocation line for GST rollup. Mirrors backend VendorGstLine. */
export interface VendorGstLine {
  vendorName: string;
  total?: number | string | null;
  currency?: string | null;
  gstPercentage?: number | string | null;
  /** That vendor's shipping (same on every row of the group). Added after GST. */
  shippingCost?: number | string | null;
}

/**
 * Roll vendor allocations up to a GST-INCLUSIVE grand total. Mirrors backend
 * `rollupWithVendorGst`: group by (vendorName, currency) — one VendorOrder —
 * apply each vendor's GST rate to its subtotal, then roll the inclusive group
 * totals currency-aware. Returns the pre-GST `subtotal`, rolled `gstTotal`,
 * GST-inclusive `grandTotal`, and per-vendor `groups` for display.
 */
export function rollupWithVendorGst(lines: VendorGstLine[]): {
  subtotal: number;
  gstTotal: number;
  shippingTotal: number;
  grandTotal: number;
  currency: string;
  groups: { key: string; vendorName: string; currency: string; subtotal: number; gstPercentage: number; gstAmount: number; shippingAmount: number; total: number }[];
} {
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const norm = (c?: string | null) => (c || 'INR').toUpperCase().trim();
  const byKey = new Map<string, { key: string; vendorName: string; currency: string; subtotal: number; gstPercentage: number; gstAmount: number; shippingAmount: number; total: number }>();
  for (const l of lines) {
    const currency = norm(l.currency);
    const key = `${l.vendorName}||${currency}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, vendorName: l.vendorName, currency, subtotal: 0, gstPercentage: 0, gstAmount: 0, shippingAmount: 0, total: 0 };
      byKey.set(key, g);
    }
    g.subtotal += Number(l.total || 0);
    g.gstPercentage = Math.max(g.gstPercentage, Number(l.gstPercentage || 0));
    g.shippingAmount = Math.max(g.shippingAmount, Number(l.shippingCost || 0));
  }
  const groups = [...byKey.values()].map((g) => {
    g.subtotal = round2(g.subtotal);
    g.gstAmount = round2((g.subtotal * g.gstPercentage) / 100);
    g.shippingAmount = round2(g.shippingAmount);
    // Shipping goes on after GST and is never taxed (owner, 27 Oct).
    g.total = round2(g.subtotal + g.gstAmount + g.shippingAmount);
    return g;
  });
  const subRoll = rollupTotals(groups.map((g) => ({ total: g.subtotal, currency: g.currency })));
  const taxedRoll = rollupTotals(groups.map((g) => ({ total: g.subtotal + g.gstAmount, currency: g.currency })));
  const grandRoll = rollupTotals(groups.map((g) => ({ total: g.total, currency: g.currency })));
  return {
    subtotal: subRoll.grandTotal,
    grandTotal: grandRoll.grandTotal,
    gstTotal: round2(taxedRoll.grandTotal - subRoll.grandTotal),
    shippingTotal: round2(grandRoll.grandTotal - taxedRoll.grandTotal),
    currency: grandRoll.currency,
    groups,
  };
}
