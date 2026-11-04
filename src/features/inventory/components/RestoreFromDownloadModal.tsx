import React, { useMemo, useState } from 'react';
import { AlertTriangle, Loader2, Upload } from 'lucide-react';
import { client } from '@/api';
import { Modal } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { extractErrorMessage } from '@/lib';
import { RESTORE_ACCEPT } from '@/lib/fileAccept';

/**
 * Restore from download — put the shelf back from a Component Database
 * download (counts, locations, details, projects and reservations).
 *
 * Nothing changes until Confirm. The preview lists only what differs; for each
 * item the person picks the count (the file's, the current one, or both added)
 * and which other details to take from the file. The server re-reads the same
 * file on confirm and writes only what was ticked, all or nothing.
 */

type StockChoice = 'file' | 'keep' | 'add';
interface FieldDiff { field: string; label: string; app: string; file: string }
interface PreviewItem {
  itemId: string; v: string; row: number; name: string; department: string; unit: string;
  count: number;
  stock: { app: number; file: number } | null;
  fields: FieldDiff[];
  reserved: { app: number; file: number };
  warnings: string[];
}
interface Preview {
  fileName: string;
  info: { downloadedAt?: string; filters?: string };
  hasAllotments: boolean;
  filtered: boolean;
  summary: { inFile: number; same: number; different: number; notInApp: number; notInFile: number };
  different: PreviewItem[];
  notInApp: Array<{ row: number; name: string; department: string; stock: number; unit: string; category: string; inDeletedItems: boolean; problems: string[] }>;
  notInFile: Array<{ itemId: string; v: string; name: string; department: string; stock: number; unit: string; reserved: number }>;
  duplicates: Array<{ name: string; rows: number[] }>;
  missingProjects: string[];
  problems: string[];
}
interface Choice { include: boolean; stock: StockChoice; fields: Set<string> }

const round2 = (n: number) => Math.round(n * 100) / 100;
const finalCount = (c: Choice, s: PreviewItem['stock']) =>
  !s ? null : c.stock === 'keep' ? s.app : c.stock === 'add' ? round2(s.app + s.file) : s.file;

// One column layout for an item's detail lines — tick box, what, then the
// change — so "Count" and every field label line up under each other.
const DETAIL_GRID = 'grid grid-cols-[1rem_5.5rem_minmax(0,1fr)] sm:grid-cols-[1rem_9rem_minmax(0,1fr)] gap-x-2 text-xs';

const STOCK_LABEL: Record<StockChoice, string> = { file: "File's count", keep: 'Keep current', add: 'Add both' };

export interface RestoreFromDownloadModalProps {
  isOpen: boolean;
  onClose: () => void;
  onRestored: () => void;
}

export const RestoreFromDownloadModal: React.FC<RestoreFromDownloadModalProps> = ({ isOpen, onClose, onRestored }) => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [create, setCreate] = useState<Set<number>>(new Set());
  const [createProjects, setCreateProjects] = useState(false);
  const [notInFileChoice, setNotInFileChoice] = useState<'leave' | 'zero' | ''>('');
  const [reason, setReason] = useState('');

  const reset = () => {
    setFile(null); setPreview(null); setError(''); setChoices({}); setCreate(new Set());
    setCreateProjects(false); setNotInFileChoice(''); setReason('');
  };
  const close = () => { if (!applying) { reset(); onClose(); } };

  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    reset();
    setFile(f);
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('file', f);
      const res = await client.post('/inventory/restore/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const p: Preview = res.data?.data ?? res.data;
      setPreview(p);
      // Default: take everything from the file — that is what a restore is
      // for. The person narrows it from there.
      setChoices(Object.fromEntries(p.different.map((d) => [d.itemId, { include: true, stock: 'file' as StockChoice, fields: new Set(d.fields.map((x) => x.field)) }])));
    } catch (err) {
      setError(extractErrorMessage(err, 'Could not read this file'));
      setFile(null);
    }
    setLoading(false);
  };

  const setChoice = (id: string, patch: Partial<Choice>) => setChoices((c) => ({ ...c, [id]: { ...c[id], ...patch } }));
  const setAllStock = (s: StockChoice) => setChoices((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v, stock: s }])));
  const setAllIncluded = (on: boolean) => setChoices((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, { ...v, include: on }])));
  const toggleField = (id: string, field: string) => setChoices((c) => {
    const fields = new Set(c[id].fields);
    if (fields.has(field)) fields.delete(field); else fields.add(field);
    return { ...c, [id]: { ...c[id], fields } };
  });

  // Same rule the server enforces: reserved stock can never exceed the count.
  const clashes = useMemo(() => {
    if (!preview) return new Map<string, string>();
    const out = new Map<string, string>();
    for (const d of preview.different) {
      const c = choices[d.itemId];
      if (!c?.include) continue;
      const count = finalCount(c, d.stock) ?? d.count;
      const reserved = c.fields.has('projects') ? d.reserved.file : d.reserved.app;
      if (reserved > count) {
        out.set(d.itemId, `${reserved} reserved for projects but the count would be ${count}. Also restore its projects, keep the current count, or free the reservation on Allot Items first.`);
      }
    }
    return out;
  }, [preview, choices]);

  const included = preview ? preview.different.filter((d) => choices[d.itemId]?.include && (d.stock || choices[d.itemId].fields.size > 0)) : [];
  const zeroCount = notInFileChoice === 'zero' ? (preview?.notInFile.filter((n) => n.stock > 0).length ?? 0) : 0;
  const needsProjects = (preview?.missingProjects.length ?? 0) > 0;
  const total = included.length + create.size + zeroCount;
  const blockers = [
    ...(preview && preview.notInFile.length > 0 && !notInFileChoice ? ['Choose what to do with the items that are not in the file.'] : []),
    ...(clashes.size > 0 ? [`${clashes.size} item${clashes.size === 1 ? '' : 's'} would have more reserved than in stock — see the red notes.`] : []),
    ...(needsProjects && !createProjects ? ['Some projects in the file do not exist — tick "Create missing projects" or untick those items.'] : []),
    ...(!reason.trim() ? ['Type a reason.'] : []),
    ...(total === 0 ? ['Nothing is selected to restore.'] : []),
  ];

  const apply = async () => {
    if (!preview || !file || blockers.length > 0) return;
    const ok = await confirm({
      title: 'Restore from download?',
      message: (
        <div className="space-y-1 text-sm">
          <p>{included.length} item{included.length === 1 ? '' : 's'} updated{create.size > 0 ? `, ${create.size} brought back` : ''}{zeroCount > 0 ? `, ${zeroCount} set to 0` : ''}.</p>
          <p className="text-muted">Every change is saved in each item's history with your name and reason.</p>
        </div>
      ),
      confirmLabel: 'Restore',
    });
    if (!ok) return;
    setApplying(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('decisions', JSON.stringify({
        reason: reason.trim(),
        items: included.map((d) => ({ itemId: d.itemId, v: d.v, stock: d.stock ? choices[d.itemId].stock : undefined, fields: [...choices[d.itemId].fields] })),
        zeroOut: notInFileChoice === 'zero' ? preview.notInFile.filter((n) => n.stock > 0).map((n) => ({ itemId: n.itemId, v: n.v })) : [],
        create: [...create],
        createProjects,
      }));
      const res = await client.post('/inventory/restore/apply', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const r = res.data?.data ?? res.data;
      addToast(`Restored: ${r.changed} updated${r.created ? `, ${r.created} brought back` : ''}${r.zeroed ? `, ${r.zeroed} set to 0` : ''}`, 'success');
      reset();
      onRestored();
      onClose();
    } catch (err) {
      setError(extractErrorMessage(err, 'Nothing was changed — the restore failed'));
    }
    setApplying(false);
  };

  const downloaded = preview?.info.downloadedAt
    ? new Date(preview.info.downloadedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <Modal isOpen={isOpen} onClose={close} title="Restore from download" size={preview ? '2xl' : 'md'}>
      <div className="space-y-4 text-sm">
        {!preview && (
          <>
            <p className="text-muted">
              Pick a file made by the <strong>Download</strong> button on this page. You'll see what's different before anything changes.
            </p>
            <label className="flex flex-col items-center justify-center gap-2 border-2 border-dashed border-line rounded-lg p-8 text-center hover:bg-surface transition-colors cursor-pointer">
              {loading ? <Loader2 size={22} className="animate-spin text-brand" /> : <Upload size={22} className="text-muted" />}
              <span className="font-bold text-ink">{loading ? `Reading ${file?.name ?? 'file'}…` : 'Choose the .xlsx file'}</span>
              <input type="file" accept={RESTORE_ACCEPT} onChange={pick} disabled={loading} className="sr-only" />
            </label>
          </>
        )}

        {error && (
          <div className="bg-red-50 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 rounded-md p-3 text-xs text-red-900 dark:text-red-200 whitespace-pre-line">{error}</div>
        )}

        {preview && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              <span className="font-bold text-ink truncate max-w-full">{preview.fileName}</span>
              <span>{downloaded ? `Downloaded ${downloaded}` : 'Older download — no date inside'}</span>
              <button onClick={reset} disabled={applying} className="text-brand font-bold hover:underline">Pick another file</button>
            </div>

            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {([
                ['In file', preview.summary.inFile],
                ['Same', preview.summary.same],
                ['Different', preview.summary.different],
                ['New', preview.summary.notInApp],
                ['Not in file', preview.summary.notInFile],
              ] as const).map(([label, n]) => (
                <div key={label} className="bg-surface border border-line-soft rounded-md px-3 py-2">
                  <p className="text-[11px] text-muted">{label}</p>
                  <p className="text-lg font-bold text-ink tabular-nums">{n}</p>
                </div>
              ))}
            </div>

            <div className="bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-md p-3 text-xs text-amber-900 dark:text-amber-200 flex gap-2">
              <AlertTriangle size={14} className="shrink-0 mt-0.5" />
              <div className="space-y-1">
                <p>The file is a snapshot. If items were issued or received after it was taken, "File's count" undoes those too — choose "Keep current" for them.</p>
                {preview.filtered && (
                  <p className="font-bold">This download was filtered ({preview.info.filters}), so it doesn't cover the whole shelf. Only counts and item details can be restored from it — not locations, projects, or items missing from it.</p>
                )}
                {!preview.hasAllotments && (
                  <p>This older download has no reservations in it. Projects are restored as tags; reservations already in the app are kept.</p>
                )}
              </div>
            </div>

            {(preview.problems.length > 0 || preview.duplicates.length > 0) && (
              <details className="bg-surface border border-line-soft rounded-md p-3 text-xs">
                <summary className="font-bold text-ink cursor-pointer">
                  {preview.problems.length + preview.duplicates.length} row{preview.problems.length + preview.duplicates.length === 1 ? '' : 's'} in the file skipped
                </summary>
                <ul className="mt-2 space-y-1 text-muted list-disc pl-4">
                  {preview.duplicates.map((d) => <li key={d.name}>"{d.name}" is in the file {d.rows.length} times (rows {d.rows.join(', ')}) — only row {d.rows[0]} is used.</li>)}
                  {preview.problems.map((p) => <li key={p}>{p}</li>)}
                </ul>
              </details>
            )}

            {preview.different.length > 0 && (
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-bold text-ink">Different ({preview.different.length})</h3>
                  <div className="flex items-center gap-3 text-xs">
                    <button onClick={() => setAllIncluded(true)} className="text-brand font-bold hover:underline">Tick all</button>
                    <button onClick={() => setAllIncluded(false)} className="text-brand font-bold hover:underline">Untick all</button>
                  </div>
                </div>
                {preview.different.some((d) => d.stock) && (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className="text-muted">Count for all:</span>
                    {(['file', 'keep', 'add'] as StockChoice[]).map((s) => (
                      <button key={s} onClick={() => setAllStock(s)} className="px-2 py-1 border border-line rounded hover:border-brand hover:text-brand font-bold text-ink">{STOCK_LABEL[s]}</button>
                    ))}
                  </div>
                )}
                <div className="max-h-[45vh] overflow-y-auto border border-line-soft rounded-md divide-y divide-line-soft">
                  {preview.different.map((d) => {
                    const c = choices[d.itemId];
                    if (!c) return null;
                    const count = finalCount(c, d.stock);
                    const clash = clashes.get(d.itemId);
                    return (
                      <div key={d.itemId} className={`p-3 space-y-2 ${c.include ? '' : 'opacity-50'}`}>
                        <label className="flex items-start gap-2 cursor-pointer">
                          <input type="checkbox" checked={c.include} onChange={(e) => setChoice(d.itemId, { include: e.target.checked })} className="mt-1" />
                          <span className="min-w-0">
                            <span className="font-bold text-ink break-words">{d.name}</span>
                            <span className="text-xs text-muted"> · {d.department || 'No department'} · row {d.row}</span>
                          </span>
                        </label>
                        {c.include && (
                          <div className="pl-6 space-y-1.5">
                            {d.stock && (
                              <div className={`${DETAIL_GRID} items-start gap-y-1`}>
                                <span />
                                <span className="text-muted">Count</span>
                                <span className="tabular-nums text-ink">
                                  now <strong>{d.stock.app}</strong> · file <strong>{d.stock.file}</strong> {d.unit}
                                  <span className="text-muted"> → </span><strong>{count}</strong>
                                </span>
                                {/* Own line, from the label column on a phone, so the three choices never squeeze. */}
                                <span className="col-start-2 col-span-2 sm:col-start-3 sm:col-span-1 inline-flex w-max max-w-full rounded-md border border-line overflow-hidden">
                                  {(['file', 'keep', 'add'] as StockChoice[]).map((s) => (
                                    <button key={s} onClick={() => setChoice(d.itemId, { stock: s })}
                                      className={`px-2 py-0.5 font-bold whitespace-nowrap ${c.stock === s ? 'bg-brand text-white' : 'text-muted hover:bg-surface'}`}>
                                      {STOCK_LABEL[s]}
                                    </button>
                                  ))}
                                </span>
                              </div>
                            )}
                            {d.fields.map((x) => (
                              <label key={x.field} className={`${DETAIL_GRID} items-start cursor-pointer`}>
                                <input type="checkbox" checked={c.fields.has(x.field)} onChange={() => toggleField(d.itemId, x.field)} className="mt-0.5" />
                                <span className="text-muted">{x.label}</span>
                                <span className="min-w-0 break-words text-ink">
                                  <span className="text-muted line-through decoration-faint">{x.app}</span> → {x.file}
                                </span>
                              </label>
                            ))}
                            {d.warnings.map((w) => <p key={w} className="text-xs text-amber-700 dark:text-amber-300">{w}</p>)}
                            {clash && <p className="text-xs font-bold text-red-700 dark:text-red-300">{clash}</p>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {preview.notInApp.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-bold text-ink">In the file, not in the app ({preview.notInApp.length})</h3>
                <p className="text-xs text-muted">Archived or renamed since the download. Tick to bring them back — from Archived items when they are there, otherwise as new items.</p>
                <div className="max-h-48 overflow-y-auto border border-line-soft rounded-md divide-y divide-line-soft">
                  {preview.notInApp.map((n) => (
                    <label key={n.row} className={`flex items-start gap-2 p-2.5 text-xs ${n.problems.length ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                      <input type="checkbox" disabled={n.problems.length > 0} checked={create.has(n.row)}
                        onChange={(e) => setCreate((s) => { const x = new Set(s); if (e.target.checked) x.add(n.row); else x.delete(n.row); return x; })} className="mt-0.5" />
                      <span className="min-w-0">
                        <span className="font-bold text-ink break-words">{n.name}</span>
                        <span className="text-muted"> · {n.department || 'No department'} · {n.stock} {n.unit} · {n.inDeletedItems ? 'in Archived items' : 'new item'}</span>
                        {n.problems.length > 0 && <span className="block text-red-700 dark:text-red-300">Can't create: {n.problems.join('; ')}</span>}
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            )}

            {needsProjects && (
              <label className="flex items-start gap-2 text-xs cursor-pointer bg-surface border border-line-soft rounded-md p-3">
                <input type="checkbox" checked={createProjects} onChange={(e) => setCreateProjects(e.target.checked)} className="mt-0.5" />
                <span><strong className="text-ink">Create missing projects:</strong> <span className="text-muted">{preview.missingProjects.join(', ')}</span></span>
              </label>
            )}

            {preview.notInFile.length > 0 && (
              <section className="space-y-2">
                <h3 className="font-bold text-ink">In the app, not in the file ({preview.notInFile.length})</h3>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="notInFile" checked={notInFileChoice === 'leave'} onChange={() => setNotInFileChoice('leave')} />
                    <span className="text-ink font-bold">Leave them as they are</span>
                  </label>
                  <label className="inline-flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="notInFile" checked={notInFileChoice === 'zero'} onChange={() => setNotInFileChoice('zero')} />
                    <span className="text-ink font-bold">Set their count to 0</span>
                  </label>
                </div>
                <details className="text-xs">
                  <summary className="text-brand font-bold cursor-pointer">Show the {preview.notInFile.length} item{preview.notInFile.length === 1 ? '' : 's'}</summary>
                  <ul className="mt-1 max-h-40 overflow-y-auto border border-line-soft rounded-md divide-y divide-line-soft">
                    {preview.notInFile.map((n) => (
                      <li key={n.itemId} className="px-2.5 py-1.5">
                        <span className="text-ink">{n.name}</span>
                        <span className="text-muted"> · {n.department || 'No department'} · {n.stock} {n.unit}{n.reserved > 0 ? ` · ${n.reserved} reserved` : ''}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </section>
            )}

            {preview.different.length === 0 && preview.notInApp.length === 0 && preview.notInFile.length === 0 && (
              <p className="text-center text-muted py-4">Everything in the file already matches the app. Nothing to restore.</p>
            )}

            <div>
              <label className="block text-xs font-bold text-muted mb-1">Reason *</label>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={2}
                placeholder="e.g. Counts changed after the upgrade — restoring the 20 Oct download"
                className="w-full border border-line rounded-md py-2 px-3 text-sm bg-card text-ink focus:border-brand outline-none" />
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-3 border-t border-line-soft">
              <p className="text-xs text-muted">{blockers[0] ?? `${total} change${total === 1 ? '' : 's'} ready.`}</p>
              <div className="flex justify-end gap-2">
                <button onClick={close} disabled={applying} className="px-4 py-2 text-sm font-bold text-muted border border-line rounded-md hover:bg-surface disabled:opacity-50">Cancel</button>
                <button onClick={apply} disabled={applying || blockers.length > 0}
                  className="px-4 py-2 text-sm font-bold bg-brand text-white rounded-md hover:bg-brand-dark disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center gap-1.5">
                  {applying && <Loader2 size={14} className="animate-spin" />}
                  {applying ? 'Restoring…' : 'Restore'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};
