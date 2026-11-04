import React, { useEffect, useState } from 'react';
import { Modal } from '@/components/ui';
import { sharedArchivedRows } from '../utils/unarchiveRows';

/** What the server says about the archived item a new one would duplicate. */
export type ArchivedMatch = {
  id: string;
  name: string;
  stock: number;
  unit: string;
  archivedAt: string | null;
  departmentName: string | null;
};

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'earlier';

/**
 * Adding an item whose name matches an archived one (owner, 27 Oct): offer the
 * archived row back — history, location and project links included — before
 * creating a second row with the same name. "Create new anyway" stays for a
 * genuinely different part.
 *
 * Only Inventory can unarchive (owner, 28 Oct). Anyone else who can add items
 * is still told the archived one exists — so they can ask Inventory instead —
 * but is offered only "Create new anyway".
 */
export const UnarchiveOfferDialog: React.FC<{
  offer: { match: ArchivedMatch; addStock: number } | null;
  canUnarchive: boolean;
  onChoose: (choice: 'unarchive' | 'new' | 'cancel') => void;
}> = ({ offer, canUnarchive, onChoose }) => {
  const [busy, setBusy] = useState(false);
  useEffect(() => { setBusy(false); }, [offer]);
  if (!offer) return null;
  const { match, addStock } = offer;
  const total = match.stock + addStock;
  const pick = (c: 'unarchive' | 'new') => { setBusy(true); onChoose(c); };
  return (
    <Modal isOpen onClose={() => onChoose('cancel')} title={`"${match.name}" is archived`}>
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          An item with this name{match.departmentName ? ` in ${match.departmentName}` : ''} was archived on {when(match.archivedAt)} with{' '}
          {fmt(match.stock)} {match.unit} in it.{' '}
          {canUnarchive
            ? <>Unarchiving brings it back with its history, location and projects, so the list
              keeps one row for this part{addStock > 0 ? ` — adding your ${fmt(addStock)} makes ${fmt(total)} ${match.unit}` : ''}.</>
            : <>Only the Inventory team can unarchive it. Ask them to, or create a new item if this is a different part.</>}
        </p>
        <div className="flex flex-col sm:flex-row sm:justify-end gap-2 pt-2 border-t border-line-soft">
          <button onClick={() => onChoose('cancel')} className="px-4 py-2 text-sm font-bold text-muted hover:bg-surface rounded">Cancel</button>
          <button onClick={() => pick('new')} disabled={busy}
            className="px-4 py-2 text-sm font-bold border border-line text-ink rounded-full hover:bg-surface disabled:opacity-50 whitespace-nowrap">
            Create new anyway
          </button>
          {canUnarchive && (
            <button onClick={() => pick('unarchive')} disabled={busy}
              className="px-5 py-2 text-sm font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50 whitespace-nowrap">
              {addStock > 0 ? `Unarchive and add ${fmt(addStock)}` : 'Unarchive it'}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
};

export type ArchivedRowMatch = { row: number; name: string; stock: number; unit: string; archived: ArchivedMatch };
export type RowChoice = 'unarchive' | 'new' | 'skip';

/**
 * The same offer for a spreadsheet: rows that matched an archived item were
 * held back by the upload, one choice per row, unarchive by default — or
 * "create new" for a role that cannot unarchive.
 */
export const UnarchiveRowsDialog: React.FC<{
  rows: ArchivedRowMatch[] | null;
  canUnarchive: boolean;
  onApply: (choices: Record<number, RowChoice>) => Promise<void>;
  onClose: () => void;
}> = ({ rows, canUnarchive, onApply, onClose }) => {
  const [choices, setChoices] = useState<Record<number, RowChoice>>({});
  const [busy, setBusy] = useState(false);
  const fallback: RowChoice = canUnarchive ? 'unarchive' : 'new';
  useEffect(() => {
    setBusy(false);
    setChoices(Object.fromEntries((rows ?? []).map((r) => [r.row, fallback])));
  }, [rows, fallback]);
  // Rows naming the same archived item: their quantities are added into one
  // unarchive, and the table says so rather than leaving it a surprise.
  const shared = sharedArchivedRows(rows ?? []);
  if (!rows || rows.length === 0) return null;
  const apply = async () => {
    setBusy(true);
    try { await onApply(choices); } finally { setBusy(false); }
  };
  return (
    <Modal isOpen onClose={onClose} title={rows.length === 1 ? '1 row matches an archived item' : `${rows.length} rows match archived items`} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          These were held back so the list doesn't get a second row with the same name.{' '}
          {canUnarchive
            ? 'Unarchive brings the old item back with its history and adds the sheet\'s quantity.'
            : 'Only the Inventory team can unarchive — create these as new items, or skip them and ask Inventory.'}
        </p>
        <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card">
              <tr className="text-left text-[10px] uppercase font-bold text-faint border-b border-line">
                <th className="py-2 pr-2">Row</th>
                <th className="py-2 pr-2">Item</th>
                <th className="py-2 pr-2 text-right">In sheet</th>
                <th className="py-2 pr-2 text-right">Archived with</th>
                <th className="py-2">Do</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.row} className="border-b border-line-soft last:border-0 align-middle">
                  <td className="py-2 pr-2 text-xs text-muted">{r.row}</td>
                  <td className="py-2 pr-2">
                    <span className="font-bold text-ink">{r.name}</span>
                    <span className="block text-[10px] text-faint">archived {when(r.archived.archivedAt)}</span>
                    {shared.has(r.row) && (
                      <span className="block text-[10px] text-faint">
                        same item as row {shared.get(r.row)!.join(', ')} — unarchived once, quantities added
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-2 text-right text-xs text-muted whitespace-nowrap">{fmt(r.stock)} {r.unit}</td>
                  <td className="py-2 pr-2 text-right text-xs text-muted whitespace-nowrap">{fmt(r.archived.stock)} {r.archived.unit}</td>
                  <td className="py-2">
                    <select
                      aria-label={`What to do with row ${r.row}`}
                      value={choices[r.row] ?? fallback}
                      onChange={(e) => setChoices((c) => ({ ...c, [r.row]: e.target.value as RowChoice }))}
                      className="border border-line rounded-md py-1 px-2 text-xs bg-card focus:border-brand outline-none"
                    >
                      {canUnarchive && <option value="unarchive">Unarchive + add</option>}
                      <option value="new">Create new</option>
                      <option value="skip">Skip</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
          <button onClick={onClose} className="px-4 py-2 text-sm font-bold text-muted hover:bg-surface rounded">Skip all</button>
          <button onClick={apply} disabled={busy}
            className="px-5 py-2 text-sm font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50">
            {busy ? 'Applying…' : 'Apply'}
          </button>
        </div>
      </div>
    </Modal>
  );
};
