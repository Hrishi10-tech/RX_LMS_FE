import { useEffect, useMemo, useState } from 'react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { useAbortOnUnmount } from '@/hooks';

/**
 * Allot from inside the Issue slip.
 *
 * One click per project first (owner, 27 Oct): "Move 1 from Watch to Ultra"
 * takes exactly what this request is short — or what that project holds, if
 * less — from that project into this request's project (into the unallotted
 * pool when the request has none). No sums to work out. The per-project
 * number boxes stay behind "Edit numbers" for anything unusual.
 *
 * The clerk used to see "183 on the shelf — 183 reserved for other projects",
 * queue a back-order indent, then go to Allot Items to free some and come
 * back. This is the same allotment, edited where the shortage is seen: one
 * quantity per project, saved through the same endpoint and rules as the
 * Allot page for "Edit numbers" (absolute values, ceilings checked on the
 * server, reductions saved first so a move between projects never trips the
 * ceiling); "Move N" is one relative move on the server. Rack /
 * container / tray stay on the Allot page — they are not this slip's business.
 */
type Row = { projectId: string; projectName: string; allottedQty: number };

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));

export const IssueAllotPanel = ({
  itemId, unit, requestProjectId, requestProjectName, stillNeeded, onSaved, purpose = 'issue',
}: {
  /**
   * 'adjust': used by Adjust Stock to free stock for a removal (owner, 4 Nov).
   * Same moves and numbers, worded for a write-off instead of a request.
   */
  purpose?: 'issue' | 'adjust';
  itemId: string;
  unit: string;
  /** The request's project; null for General / Others (draws on the unallotted pool only). */
  requestProjectId: string | null;
  requestProjectName: string;
  stillNeeded: number;
  onSaved: () => void;
}) => {
  const abortSignal = useAbortOnUnmount();
  const { addToast } = useToast();
  const [stock, setStock] = useState(0);
  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = async () => {
    try {
      const { data } = await client.get(`/inventory/allotments/${itemId}`, { signal: abortSignal() });
      const b = data?.data ?? data;
      const held: Row[] = (b.projects ?? [])
        .filter((p: any) => Number(p.allottedQty) > 0 || p.projectId === requestProjectId)
        .map((p: any) => ({ projectId: p.projectId, projectName: p.projectName, allottedQty: Number(p.allottedQty) }));
      // The request's own project is always offered, even with nothing allotted yet.
      if (requestProjectId && !held.some((r) => r.projectId === requestProjectId)) {
        held.push({ projectId: requestProjectId, projectName: requestProjectName, allottedQty: 0 });
      }
      // Its own project first, then the others.
      held.sort((a, b) => Number(b.projectId === requestProjectId) - Number(a.projectId === requestProjectId)
        || a.projectName.localeCompare(b.projectName));
      setStock(Number(b.stock ?? 0));
      setRows(held);
      setDraft(Object.fromEntries(held.map((r) => [r.projectId, fmt(r.allottedQty)])));
      setLoaded(true);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load the allotment'), 'error');
    }
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once per item
  useEffect(() => { load(); }, [itemId]);

  const value = (id: string) => Number(draft[id] ?? 0);
  const invalid = rows.some((r) => !Number.isFinite(value(r.projectId)) || value(r.projectId) < 0);
  const allotted = rows.reduce((s, r) => s + (Number.isFinite(value(r.projectId)) ? value(r.projectId) : 0), 0);
  const unallotted = stock - allotted;
  const forThisRequest = Math.max(unallotted, 0) + (requestProjectId ? value(requestProjectId) : 0);
  const changed = useMemo(() => rows.filter((r) => value(r.projectId) !== r.allottedQty),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- value reads draft
    [rows, draft]);

  // What the request can draw on right now (the server's figures, not drafts),
  // and how much it is short of what it still needs.
  const stored = (id: string | null) => (id ? rows.find((r) => r.projectId === id)?.allottedQty ?? 0 : 0);
  const storedUnallotted = stock - rows.reduce((s, r) => s + r.allottedQty, 0);
  const shortBy = Math.max(stillNeeded - (Math.max(storedUnallotted, 0) + stored(requestProjectId)), 0);
  const donors = rows.filter((r) => r.projectId !== requestProjectId && r.allottedQty > 0);
  const target = requestProjectId ? requestProjectName : 'unallotted';

  /**
   * Take `qty` from one project for this request, as ONE server-side move.
   * It used to be two absolute PATCHes built from the figures loaded when the
   * slip opened: another clerk's change in between was overwritten, and a
   * failed second PATCH left the donor's share given up to nobody. The move
   * endpoint takes `qty` off what the donor holds now, or refuses.
   */
  const move = async (from: Row, qty: number) => {
    setSaving(true);
    try {
      await client.post(`/inventory/allotments/${itemId}/move`, { fromProjectId: from.projectId, toProjectId: requestProjectId, qty });
      addToast(`Moved ${fmt(qty)} ${unit} from ${from.projectName} to ${target}.`, 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not move it'), 'error');
    } finally {
      setSaving(false);
      await load();
      onSaved();
    }
  };

  const save = async () => {
    if (invalid) { addToast('Enter zero or more for each project.', 'error'); return; }
    if (unallotted < 0) { addToast(`That allots ${fmt(allotted)} ${unit}, but only ${fmt(stock)} are in stock.`, 'error'); return; }
    setSaving(true);
    const failures: string[] = [];
    // Reductions first: freeing one project before raising another keeps every
    // single save under the server's ceiling.
    const ordered = [...changed].sort((a, b) => (value(a.projectId) - a.allottedQty) - (value(b.projectId) - b.allottedQty));
    for (const r of ordered) {
      try {
        await client.patch(`/inventory/allotments/${itemId}`, { projectId: r.projectId, allottedQty: value(r.projectId) });
      } catch (e: any) {
        failures.push(`${r.projectName}: ${extractErrorMessage(e, 'could not be saved')}`);
      }
    }
    setSaving(false);
    if (failures.length) addToast(failures.join('\n'), 'error');
    else addToast('Allotment updated.', 'success');
    await load();
    onSaved();
  };

  if (!loaded) return <p className="text-xs text-muted">Loading allotment…</p>;
  return (
    <div className="rounded-lg border border-line-soft p-3 space-y-2">
      {shortBy > 0 ? (
        donors.length ? (
          <>
            <p className="text-xs font-bold text-ink">
              {purpose === 'adjust'
                ? <>Unallotted is short by {fmt(shortBy)} {unit} — free it from a project:</>
                : <>Short by {fmt(shortBy)} {unit} — take it from a project holding this item:</>}
            </p>
            <ul className="space-y-1.5">
              {donors.map((d) => {
                const qty = Math.min(shortBy, d.allottedQty);
                return (
                  <li key={d.projectId} className="flex items-center gap-2">
                    <span className="flex-1 min-w-0 truncate text-xs text-ink">
                      {d.projectName} <span className="text-faint">· {fmt(d.allottedQty)} {unit}</span>
                    </span>
                    <button
                      onClick={() => move(d, qty)}
                      disabled={saving}
                      className="px-3 py-1.5 text-xs font-bold bg-brand text-white rounded-md hover:bg-brand-dark disabled:opacity-50"
                    >
                      Move {fmt(qty)} to {target}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="text-xs text-muted">
            {purpose === 'adjust'
              ? 'No project holds this item, so there is nothing to free.'
              : 'No other project holds this item, so there is nothing to move — the back-order indent covers it.'}
          </p>
        )
      ) : (
        <p className="text-xs text-muted">{purpose === 'adjust' ? 'Enough is unallotted for this removal.' : 'This request already has enough to issue.'}</p>
      )}

      <button type="button" onClick={() => setEditing((v) => !v)} className="text-[11px] font-bold text-muted hover:text-brand">
        {editing ? 'Hide numbers ▾' : 'Edit numbers ▸'}
      </button>

      {editing && (
        <div className="space-y-2 border-t border-line-soft pt-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-bold text-ink">Allotment of {fmt(stock)} {unit} in stock</p>
            <p className="text-[11px] text-muted">Unallotted: <span className={`font-bold ${unallotted < 0 ? 'text-red-700 dark:text-red-300' : 'text-ink'}`}>{fmt(unallotted)}</span></p>
          </div>
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li key={r.projectId} className="flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate text-xs text-ink">
                  {r.projectName}
                  {r.projectId === requestProjectId && <span className="text-faint"> · this request</span>}
                </span>
                <input
                  type="number" min={0} step="any" inputMode="decimal"
                  aria-label={`Allotted to ${r.projectName}`}
                  value={draft[r.projectId] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [r.projectId]: e.target.value }))}
                  className="w-24 border border-line rounded-md py-1 px-2 text-xs text-right bg-surface text-ink"
                />
                <span className="w-10 text-[11px] text-faint">{unit}</span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-2 pt-1">
            {/* Over stock is said plainly — never "can then get N" for numbers that cannot be saved. */}
            {unallotted < 0 ? (
              <p className="text-[11px] font-bold text-red-700 dark:text-red-300">
                That's {fmt(-unallotted)} {unit} more than the {fmt(stock)} in stock — lower a number.
              </p>
            ) : (
              <p className="text-[11px] text-muted">
                {purpose === 'adjust'
                  ? <>Unallotted after saving: <span className="font-bold text-ink">{fmt(unallotted)}</span> {unit}</>
                  : <>This request can then get <span className="font-bold text-ink">{fmt(Math.min(forThisRequest, stillNeeded))}</span> of the {fmt(stillNeeded)} it needs.</>}
              </p>
            )}
            <button
              onClick={save}
              disabled={saving || changed.length === 0 || invalid || unallotted < 0}
              className="shrink-0 px-3 py-1.5 text-xs font-bold bg-hover border border-line text-ink rounded-md hover:bg-line disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save allotment'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
