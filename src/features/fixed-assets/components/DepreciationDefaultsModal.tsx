import { useEffect, useState } from 'react';
import { extractErrorMessage } from '@/lib';
import { Modal } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { usePrompt } from '@/context/ConfirmContext';
import { depreciationApi } from '../services/depreciation.api';
import { Percent, Save, RotateCcw, Power, Loader2, Wand2 } from 'lucide-react';

const CATEGORY_LABEL: Record<string, string> = {
  MACHINERIES: 'Machineries',
  RND_EQUIPMENT: 'R&D Equipment',
  FURNITURE_FIXTURES: 'Furniture & Fixtures',
  COMPUTERS_IT: 'Computers & IT Assets',
  TOOLS_SMALL_INSTRUMENTS: 'Tools (Small Instruments)',
  SAFETY_EQUIPMENT: 'Safety Equipment',
  INVENTORY_COMPONENTS: 'Inventory Components',
};

const METHODS = [
  { value: 'STRAIGHT_LINE', label: 'Straight line' },
  { value: 'WRITTEN_DOWN_VALUE', label: 'Written down value' },
  { value: 'DECLINING_BALANCE', label: 'Declining balance' },
  { value: 'DOUBLE_DECLINING', label: 'Double declining' },
  { value: 'NONE', label: "Don't depreciate" },
];

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Whether this viewer may flip the posting switch. Same role set the
   * dashboard panel uses (FINANCE / SUPER_ADMIN / ASSOCIATE_FINANCE); the
   * server is the authority either way.
   */
  canManage?: boolean;
}

interface Row {
  category: string;
  usefulLifeMonths: number;
  salvageValuePercent: number | string;
  depreciationMethod: string;
  legalReference: string | null;
}

/**
 * The per-category depreciation rates every new asset inherits.
 *
 * `depreciation.api.ts` has had `listCategoryDefaults` / `upsertCategoryDefault`
 * since it was written — its own comment says they "populate the Finance
 * settings page" — but that page never existed, so the only way to see or
 * change these numbers was a raw API call. Since the defaults decide how every
 * asset in the register depreciates, and the shipped values are a legal
 * default somebody's accountant has to sign off, "you can change them" needs
 * to mean something a person can actually do.
 *
 * Editing is FINANCE / SUPER_ADMIN only (the PUT is role-gated server-side);
 * Associate Finance can read the table, which is why it's a plain read for
 * everyone and the Save buttons simply fail with the server's message if the
 * viewer isn't allowed.
 */
export const DepreciationDefaultsModal = ({ isOpen, onClose, canManage = false }: Props) => {
  const { addToast } = useToast();
  const prompt = usePrompt();
  const [rows, setRows] = useState<Row[]>([]);
  const [original, setOriginal] = useState<Record<string, Row>>({});
  const [loading, setLoading] = useState(false);
  const [savingCategory, setSavingCategory] = useState<string | null>(null);
  // The on/off switch also lives on the Finance dashboard. It is repeated here
  // because this is the page people open when they think about depreciation at
  // all — going looking for the switch on the rates screen and not finding it
  // is exactly the wrong kind of surprise. Both read the same endpoint, so
  // flipping it in one place shows up in the other on next open.
  const [config, setConfigState] = useState<{ enabled: boolean; changedByName: string | null; changedAt: string | null; note: string | null } | null>(null);
  const [togglingSwitch, setTogglingSwitch] = useState(false);
  // Backfill: apply these defaults to assets registered before the default was
  // set or changed. The endpoint existed but nothing in the app called it, so
  // editing a default here silently left every already-registered asset on the
  // old figure — visible only by opening assets one at a time.
  const [backfilling, setBackfilling] = useState(false);
  const [backfillPreview, setBackfillPreview] = useState<{ updated: number; skippedNoDefault: number } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [data, cfg] = await Promise.all([
        depreciationApi.listCategoryDefaults(),
        depreciationApi.getConfig().catch(() => null),
      ]);
      setConfigState(cfg);
      const list: Row[] = Array.isArray(data) ? data : [];
      // Sort by the label the user reads, not by enum order.
      list.sort((a, b) =>
        (CATEGORY_LABEL[a.category] ?? a.category).localeCompare(CATEGORY_LABEL[b.category] ?? b.category),
      );
      setRows(list);
      setOriginal(Object.fromEntries(list.map((r) => [r.category, { ...r }])));
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load depreciation defaults'), 'error');
    }
    setLoading(false);
  };

  useEffect(() => {
    // Gated on `isOpen` so a closed modal costs nothing — the same mistake
    // CreateBomListModal and BomListEditorModal were fixed for.
    if (isOpen) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const togglePosting = async () => {
    if (!config) return;
    const turningOff = config.enabled;
    const note = await prompt({
      title: turningOff ? 'Turn depreciation off?' : 'Turn depreciation on?',
      message: turningOff
        ? 'No new depreciation will be posted. Everything already posted stays as it is.\n\nThese rates still apply to newly created assets — they just will not be charged until posting is back on.'
        : 'The next run also fills in any months missed while it was off, which can create several entries at once.',
      label: 'Why? (optional)',
      multiline: true,
      maxLength: 500,
      confirmLabel: turningOff ? 'Turn off' : 'Turn on',
      tone: turningOff ? 'danger' : 'default',
    });
    if (note === null) return;   // Cancel, as opposed to OK with nothing typed
    setTogglingSwitch(true);
    try {
      const next = await depreciationApi.setConfig(!config.enabled, note || undefined);
      setConfigState(next);
      addToast(`Depreciation posting turned ${next.enabled ? 'on' : 'off'}.`, 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not change the setting'), 'error');
    }
    setTogglingSwitch(false);
  };

  const edit = (category: string, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r) => (r.category === category ? { ...r, ...patch } : r)));

  const isDirty = (r: Row) => {
    const o = original[r.category];
    if (!o) return true;
    return (
      Number(r.usefulLifeMonths) !== Number(o.usefulLifeMonths) ||
      Number(r.salvageValuePercent) !== Number(o.salvageValuePercent) ||
      r.depreciationMethod !== o.depreciationMethod
    );
  };

  const save = async (r: Row) => {
    const months = Number(r.usefulLifeMonths);
    const salvage = Number(r.salvageValuePercent);
    if (!Number.isInteger(months) || months < 1) {
      addToast('Useful life must be a whole number of months, at least 1.', 'error');
      return;
    }
    if (!(salvage >= 0 && salvage <= 100)) {
      addToast('Salvage must be between 0 and 100 percent.', 'error');
      return;
    }
    setSavingCategory(r.category);
    try {
      await depreciationApi.upsertCategoryDefault(r.category, {
        usefulLifeMonths: months,
        salvageValuePercent: salvage,
        depreciationMethod: r.depreciationMethod,
        legalReference: r.legalReference,
      });
      addToast(`${CATEGORY_LABEL[r.category] ?? r.category} updated.`, 'success');
      setOriginal((prev) => ({ ...prev, [r.category]: { ...r, usefulLifeMonths: months, salvageValuePercent: salvage } }));
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not save'), 'error');
    }
    setSavingCategory(null);
  };

  // Dry run first, always. The button asks the server how many assets it WOULD
  // touch and shows that before anything is written, because "apply defaults to
  // everything" is not a click anyone should make blind.
  const previewBackfill = async () => {
    setBackfilling(true);
    try {
      const res = await depreciationApi.backfillDefaults(false);
      setBackfillPreview({ updated: res?.updated ?? 0, skippedNoDefault: res?.skippedNoDefault ?? 0 });
      if (!res?.updated) addToast('Every asset already has its depreciation set. Nothing to apply.', 'info');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not check which assets need defaults'), 'error');
    } finally {
      setBackfilling(false);
    }
  };

  const applyBackfill = async () => {
    setBackfilling(true);
    try {
      const res = await depreciationApi.backfillDefaults(true);
      const n = res?.updated ?? 0;
      addToast(
        n === 0
          ? 'No assets needed changing.'
          : `Applied the category defaults to ${n} asset${n === 1 ? '' : 's'}.`,
        'success',
      );
      setBackfillPreview(null);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not apply the defaults'), 'error');
    } finally {
      setBackfilling(false);
    }
  };

  const revert = (category: string) => {
    const o = original[category];
    if (o) setRows((prev) => prev.map((r) => (r.category === category ? { ...o } : r)));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Depreciation rates by category" size="xl">
      <div className="space-y-4">
        <p className="text-xs text-muted">
          Every new asset inherits these when Finance leaves its depreciation fields blank. The shipped
          values are Companies Act 2013 Schedule II useful lives with the standard 5% residual —
          <b> a sensible default, not accounting advice</b>. Changing one here affects assets created from
          then on; assets already in the register keep whatever they were given, and can be edited
          individually.
        </p>

        {config && (
          <div
            className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5 ${
              config.enabled ? 'border-line bg-brand-50' : 'border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15'
            }`}
          >
            <div className="min-w-0">
              <p className="text-xs font-bold text-ink">
                Monthly posting is {config.enabled ? 'on' : 'off'}
              </p>
              <p className="mt-0.5 text-xs text-muted">
                {config.enabled ? (
                  'Depreciation is charged automatically on the 1st of each month.'
                ) : (
                  <>
                    These rates are still saved and still copied onto new assets, but nothing is being
                    charged. Anything posted before it was switched off is unchanged.
                    {config.changedByName && (
                      <>
                        {' '}Turned off by <b>{config.changedByName}</b>
                        {config.changedAt && ` on ${new Date(config.changedAt).toLocaleDateString()}`}
                        {config.note && ` — "${config.note}"`}.
                      </>
                    )}
                  </>
                )}
              </p>
            </div>
            {canManage && (
              <button
                type="button"
                onClick={togglePosting}
                disabled={togglingSwitch}
                aria-label={config.enabled ? 'Turn depreciation posting off' : 'Turn depreciation posting on'}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-50 ${
                  config.enabled
                    ? 'border border-line text-muted hover:border-red-300 dark:border-red-400/30 hover:text-red-700 dark:text-red-300'
                    : 'bg-brand text-white hover:bg-brand-dark'
                }`}
              >
                {togglingSwitch ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                {config.enabled ? 'Turn off' : 'Turn on'}
              </button>
            )}
          </div>
        )}

        {loading ? (
          <p className="text-sm text-faint py-6 text-center">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-faint py-6 text-center">No categories configured.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-muted font-bold">
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3">Useful life</th>
                  <th className="py-2 pr-3">Salvage</th>
                  <th className="py-2 pr-3">Method</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const dirty = isDirty(r);
                  return (
                    <tr key={r.category} className="border-b border-line-soft align-top">
                      <td className="py-2.5 pr-3 min-w-[11rem]">
                        <p className="font-bold text-ink">{CATEGORY_LABEL[r.category] ?? r.category}</p>
                        {/* The legal basis is reference text nobody sorts or
                            edits. As its own column it clipped at the panel
                            edge; under the name it has room to read. */}
                        {r.legalReference && (
                          <p className="text-[10px] text-faint mt-0.5 leading-snug">{r.legalReference}</p>
                        )}
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min={1}
                            max={600}
                            step={1}
                            aria-label={`Useful life in months for ${CATEGORY_LABEL[r.category] ?? r.category}`}
                            value={r.usefulLifeMonths}
                            onChange={(e) => edit(r.category, { usefulLifeMonths: Math.min(600, Math.round(Number(e.target.value))) })}
                            className="w-20 border border-line rounded px-2 py-1 text-sm"
                          />
                          <span className="text-[10px] text-faint whitespace-nowrap">
                            mo
                            {Number(r.usefulLifeMonths) % 12 === 0 && Number(r.usefulLifeMonths) >= 12
                              ? ` · ${Number(r.usefulLifeMonths) / 12}y`
                              : ''}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <div className="flex items-center gap-1">
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            aria-label={`Salvage percent for ${CATEGORY_LABEL[r.category] ?? r.category}`}
                            value={r.salvageValuePercent}
                            onChange={(e) => edit(r.category, { salvageValuePercent: e.target.value })}
                            className="w-16 border border-line rounded px-2 py-1 text-sm"
                          />
                          <Percent size={11} className="text-faint" />
                        </div>
                      </td>
                      <td className="py-2.5 pr-3">
                        <select
                          aria-label={`Depreciation method for ${CATEGORY_LABEL[r.category] ?? r.category}`}
                          value={r.depreciationMethod}
                          onChange={(e) => edit(r.category, { depreciationMethod: e.target.value })}
                          className="border border-line rounded px-2 py-1 text-sm"
                        >
                          {METHODS.map((m) => (
                            <option key={m.value} value={m.value}>{m.label}</option>
                          ))}
                        </select>
                      </td>
                      <td className="py-2.5">
                        {dirty && (
                          <div className="flex items-center gap-1.5">
                            <button
                              onClick={() => save(r)}
                              disabled={savingCategory === r.category}
                              className="inline-flex items-center gap-1 text-[11px] font-bold bg-brand text-white px-2 py-1 rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50"
                            >
                              <Save size={11} /> {savingCategory === r.category ? 'Saving…' : 'Save'}
                            </button>
                            <button
                              onClick={() => revert(r.category)}
                              title="Discard changes to this row"
                              aria-label={`Discard changes to ${CATEGORY_LABEL[r.category] ?? r.category}`}
                              className="inline-flex items-center text-faint hover:text-ink p-1"
                            >
                              <RotateCcw size={12} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Only fills fields that are empty — an asset Finance has already
            configured by hand is never overwritten, so this is safe to re-run. */}
        <div className="mt-4 rounded-lg border border-line-soft bg-surface px-4 py-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-bold text-ink">Apply to existing assets</p>
              <p className="text-xs text-muted mt-0.5 max-w-prose">
                Assets registered before a default was set keep their own figures.
                This fills in only the ones left blank — anything set by hand stays as it is.
              </p>
              {backfillPreview && backfillPreview.updated > 0 && (
                <p className="text-xs text-ink mt-2">
                  <span className="font-bold">{backfillPreview.updated}</span> asset
                  {backfillPreview.updated === 1 ? '' : 's'} would be updated
                  {backfillPreview.skippedNoDefault > 0
                    ? `, ${backfillPreview.skippedNoDefault} skipped (no default for their category)`
                    : ''}.
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {backfillPreview && backfillPreview.updated > 0 ? (
                <>
                  <button
                    onClick={applyBackfill}
                    disabled={backfilling}
                    className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-md bg-ink text-card hover:bg-black disabled:opacity-50"
                  >
                    {backfilling ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                    {backfilling ? 'Applying…' : `Apply to ${backfillPreview.updated}`}
                  </button>
                  <button
                    onClick={() => setBackfillPreview(null)}
                    className="text-xs font-bold px-3 py-1.5 rounded-md border border-line-soft text-secondary hover:text-ink"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  onClick={previewBackfill}
                  disabled={backfilling}
                  title="Check how many assets are missing a depreciation setting"
                  className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-md border border-line-soft text-secondary hover:text-ink disabled:opacity-50"
                >
                  {backfilling ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
                  {backfilling ? 'Checking…' : 'Check what needs it'}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
};
