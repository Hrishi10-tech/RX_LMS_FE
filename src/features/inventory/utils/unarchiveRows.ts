/**
 * Spreadsheet rows held back because they match archived items, turned into
 * the calls that bring them back.
 *
 * One call per archived item, not per row. A sheet can name the same part on
 * two rows (two bins, two suppliers), and both rows match the one archived
 * item. Sent separately, the first unarchive made it live, the second was
 * refused as "not archived any more", and the second row's quantity simply
 * did not land. Added together, both quantities arrive in one unarchive.
 */
export type HeldRow = { row: number; stock: number; archived: { id: string } };

export function groupUnarchiveRows(
  rows: HeldRow[],
  choices: Record<number, string>,
): { id: string; addStock: number; rows: number[] }[] {
  const byId = new Map<string, { id: string; addStock: number; rows: number[] }>();
  for (const r of rows) {
    if (choices[r.row] !== 'unarchive') continue;
    const g = byId.get(r.archived.id) ?? { id: r.archived.id, addStock: 0, rows: [] };
    g.addStock += Number(r.stock) || 0;
    g.rows.push(r.row);
    byId.set(r.archived.id, g);
  }
  return [...byId.values()];
}

/** Row numbers, per archived item, that share it with another row in the sheet. */
export function sharedArchivedRows(rows: HeldRow[]): Map<number, number[]> {
  const byId = new Map<string, number[]>();
  for (const r of rows) byId.set(r.archived.id, [...(byId.get(r.archived.id) ?? []), r.row]);
  const out = new Map<number, number[]>();
  for (const list of byId.values()) {
    if (list.length < 2) continue;
    for (const n of list) out.set(n, list.filter((m) => m !== n));
  }
  return out;
}

/**
 * Every failure in one toast. Only the first used to be shown, so with three
 * rows refused the clerk fixed one and believed the sheet was done. Long
 * lists are cut with a count rather than filling the screen.
 */
export function summariseFailures(failures: string[], max = 5): string {
  if (failures.length <= max) return failures.join('\n');
  return [...failures.slice(0, max), `…and ${failures.length - max} more.`].join('\n');
}
