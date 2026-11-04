/**
 * Should merging these duplicate rows ADD their stock together, or keep only
 * the row you are keeping?
 *
 * Getting this wrong is expensive and quiet. Merging 14 duplicate rows on
 * "Sum" multiplies that item's stock by 14, and nothing about the result looks
 * wrong afterwards — the number is simply too big, for ever, until somebody
 * counts the shelf. Production carries exactly that damage: a sheet uploaded
 * ~14 times in July created 14 copies of each row, and merging them on the
 * default summed stock that only ever existed once.
 *
 * Two different ways duplicates get made, and they want opposite answers:
 *
 *   - Real separate batches. Two people each created the item and each
 *     stocked it. Both rows describe stock that genuinely exists. → Sum.
 *   - Phantoms. One physical pile, recorded N times — a re-uploaded sheet, or
 *     the old double-receive bug. Only one of them is real. → Keep canonical.
 *
 * Nothing here can be certain, so this does not decide: it reports the
 * fingerprint, and the UI starts the operator on the safe answer. The bias is
 * deliberate. Summing when you should have kept invents stock that nobody can
 * find; keeping when you should have summed understates it, and the next stock
 * count corrects it.
 */

export interface MergeCandidate {
  stock?: number | string | null;
  totalReceived?: number | string | null;
}

const n = (v: unknown): number => Number(v || 0);
const allEqual = (rows: MergeCandidate[], pick: (r: MergeCandidate) => number) =>
  rows.every((r) => pick(r) === pick(rows[0]));

export type PhantomSignal =
  | { suspected: false }
  | { suspected: true; reason: 'same-receive' | 'never-received'; detail: string };

/**
 * Does this group look like one pile recorded several times?
 */
export function detectPhantomDuplicates(rows: MergeCandidate[]): PhantomSignal {
  if (!rows || rows.length < 2) return { suspected: false };

  // Fingerprint 1: every row shows the same lifetime received quantity.
  // Independent batches almost never land on identical numbers, so this
  // usually means one receive event fed them all.
  if (n(rows[0].totalReceived) > 0 && allEqual(rows, (r) => n(r.totalReceived))) {
    return {
      suspected: true,
      reason: 'same-receive',
      detail: `All ${rows.length} rows show the same lifetime received quantity (${n(rows[0].totalReceived)}), which usually means one receive event fed every one of them.`,
    };
  }

  // Fingerprint 2: nothing was ever received against ANY of them, and they all
  // carry the same stock figure.
  //
  // This is the one that was missing, and it is the one that mattered. The
  // older check required totalReceived > 0, so it stayed silent on exactly the
  // rows it needed to catch: a bulk-uploaded item has no receive history at
  // all — its stock is an opening balance typed into a spreadsheet — so every
  // duplicate of it has totalReceived = 0. The warning never appeared, the
  // radio stayed on Sum, and the stock multiplied by the number of times the
  // sheet had been uploaded.
  //
  // If no goods were ever received against any row, there is no "separate
  // batch" story that could justify summing them: the identical figures came
  // from the same cell of the same sheet.
  if (rows.every((r) => n(r.totalReceived) === 0) && allEqual(rows, (r) => n(r.stock))) {
    return {
      suspected: true,
      reason: 'never-received',
      detail: `Nothing was ever received against any of these ${rows.length} rows and they all carry the same stock (${n(rows[0].stock)}) — the fingerprint of one sheet imported more than once.`,
    };
  }

  return { suspected: false };
}

/**
 * Which option the merge dialog should start on.
 *
 * Only ever a starting point — the operator can always override it, and the
 * dialog shows the arithmetic either way.
 */
export function defaultStockMode(rows: MergeCandidate[]): 'sum' | 'keep' {
  return detectPhantomDuplicates(rows).suspected ? 'keep' : 'sum';
}
