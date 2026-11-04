/**
 * Quantity helpers shared by the issue-slip / disposition views.
 *
 * Why this exists: a request row carries both `qtyRequested` (what was asked for)
 * and `qtyIssued` (what inventory actually handed over — it may edit the slip
 * down before marking it issued). The display/edit qty must prefer `qtyIssued`
 * and fall back to `qtyRequested` ONLY when `qtyIssued` is null/undefined.
 *
 * The bug this guards (F6): using `qtyIssued || qtyRequested` treats a *genuine*
 * issued-zero as falsy and silently shows the requested qty instead — hiding the
 * fact that nothing was issued. `??` keeps an explicit 0 as 0.
 */
export type QtyRow = {
  qtyIssued?: number | null;
  qtyRequested?: number | null;
};

/**
 * The qty to display/edit for an issued slip: the actual issued amount, or the
 * requested amount only when issued is null/undefined. A real 0 stays 0.
 */
export const resolveIssuedQty = (row: QtyRow | null | undefined): number =>
  row?.qtyIssued ?? row?.qtyRequested ?? 0;
