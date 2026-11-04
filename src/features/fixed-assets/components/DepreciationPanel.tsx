import { useEffect, useState } from 'react';
import { extractErrorMessage } from '@/lib';
import { useToast } from '@/context/ToastContext';
import { usePrompt } from '@/context/ConfirmContext';
import { useAuth } from '@/hooks';
import { fmtINR } from '@/utils/number';
import { depreciationApi } from '../services/depreciation.api';
import { TrendingDown, Download, Play, Power, Loader2 } from 'lucide-react';

interface Summary {
  financialYearStart?: string;
  fyDepreciation?: number;
  fyEntries?: number;
  allTimeDepreciation?: number;
  allTimeEntries?: number;
  currentBookValue?: number;
  purchaseValueTotal?: number;
}

interface Config {
  enabled: boolean;
  changedAt: string | null;
  changedByName: string | null;
  note: string | null;
}

/**
 * Depreciation on the Finance / Associate Finance dashboard.
 *
 * `GET /depreciation/dashboard` has always returned exactly these numbers —
 * charge for the financial year, charge all-time, book value and total cost —
 * and nothing displayed them. The book-value tile and the old depreciation
 * block were removed from this dashboard once before, at Finance's request,
 * because they sat there permanently whether or not anyone needed them. So
 * this is deliberately one compact strip rather than a wall of tiles, and it
 * says plainly when depreciation is switched off instead of showing zeroes
 * that look like a bookkeeping failure.
 *
 * Three actions live here because they belong to whoever reads the numbers:
 * turn posting on/off, post the current month by hand (the cron is monthly, so
 * a missed run otherwise waits four weeks), and export the schedule an
 * accountant asks for.
 */
export const DepreciationPanel = ({ canManage }: { canManage: boolean }) => {
  const { user } = useAuth();
  // "Post now" is Finance / Super Admin on the server; the on/off switch is
  // also open to Associate Finance (canManage).
  const canPost = user?.role === 'FINANCE' || user?.role === 'SUPER_ADMIN';
  const { addToast } = useToast();
  const prompt = usePrompt();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<'toggle' | 'post' | 'export' | null>(null);

  const load = async () => {
    setLoading(true);
    setFailed(false);
    // Independent so one failure doesn't blank the other half.
    const [s, c] = await Promise.all([
      depreciationApi.getDashboardTotals().catch(() => null),
      depreciationApi.getConfig().catch(() => null),
    ]);
    if (!s && !c) setFailed(true);
    setSummary(s);
    setConfig(c);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const toggle = async () => {
    if (!config) return;
    const turningOff = config.enabled;
    const note = await prompt({
      title: turningOff ? 'Turn depreciation off?' : 'Turn depreciation on?',
      message: turningOff
        ? 'No new depreciation will be posted. Everything already posted stays as it is.'
        : 'The next posting also fills in any months missed while it was off, which can create several entries at once.',
      label: turningOff ? 'Why? (optional — an auditor looking at a quarter with no charge will want a reason)' : 'Why? (optional)',
      multiline: true,
      maxLength: 500,
      confirmLabel: turningOff ? 'Turn off' : 'Turn on',
      tone: turningOff ? 'danger' : 'default',
    });
    // null on Cancel and '' on OK-with-nothing-typed, so this distinguishes
    // "changed my mind" from "no reason given".
    if (note === null) return;
    setBusy('toggle');
    try {
      const next = await depreciationApi.setConfig(!config.enabled, note || undefined);
      setConfig(next);
      addToast(`Depreciation posting turned ${next.enabled ? 'on' : 'off'}.`, 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not change the setting'), 'error');
    }
    setBusy(null);
  };

  const postNow = async () => {
    setBusy('post');
    try {
      const r = await depreciationApi.postPeriod();
      if (r?.disabled) {
        addToast(`Nothing posted for ${r.period} — depreciation is turned off.`, 'info');
      } else {
        addToast(
          `${r?.entriesPosted ?? 0} entr${(r?.entriesPosted ?? 0) === 1 ? 'y' : 'ies'} posted for ${r?.period ?? 'the period'}.`,
          'success',
        );
      }
      load();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not post depreciation'), 'error');
    }
    setBusy(null);
  };

  const exportCsv = async () => {
    setBusy('export');
    try {
      // Goes through the API client so the auth header is attached; a plain
      // <a href> would hit the endpoint unauthenticated.
      const res = await depreciationApi.exportSchedule();
      const blob = new Blob([res], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `depreciation-schedule-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not export the schedule'), 'error');
    }
    setBusy(null);
  };

  if (loading) {
    return <div className="h-24 animate-pulse rounded-xl bg-hover" aria-hidden="true" />;
  }
  if (failed) {
    return (
      <div role="alert" className="rounded-xl border border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 px-4 py-3 text-xs font-bold text-amber-900 dark:text-amber-200">
        Couldn't load depreciation. Reload to try again.
      </div>
    );
  }

  const off = config && !config.enabled;
  const fy = summary?.financialYearStart ? new Date(summary.financialYearStart) : null;
  const fyLabel = fy ? `FY ${fy.getFullYear()}-${String((fy.getFullYear() + 1) % 100).padStart(2, '0')}` : 'This year';

  return (
    <div className={`rounded-xl border p-4 ${off ? 'border-line bg-surface' : 'border-line-soft bg-card shadow-sm'}`}>
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-ink">
            <TrendingDown size={16} className="text-brand" />
            Depreciation
            {off && (
              <span className="rounded-full bg-line px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-muted">
                Off
              </span>
            )}
          </h3>
          {off ? (
            <p className="mt-1 max-w-xl text-xs text-muted">
              Posting is turned off, so no new depreciation is being recorded. Everything posted before
              it was switched off is unchanged.
              {config?.changedByName && (
                <> Turned off by <b>{config.changedByName}</b>
                  {config.changedAt && ` on ${new Date(config.changedAt).toLocaleDateString()}`}
                  {config.note && ` — "${config.note}"`}.
                </>
              )}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted">Posted automatically on the 1st of each month.</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={exportCsv}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-bold text-muted transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
          >
            {busy === 'export' ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />} Schedule
          </button>
          {canManage && (
            <>
              {canPost && <button
                onClick={postNow}
                disabled={busy !== null || !!off}
                title={off ? 'Depreciation is turned off' : 'Post any months not yet closed'}
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-bold text-muted transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
              >
                {busy === 'post' ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />} Post now
              </button>}
              <button
                onClick={toggle}
                disabled={busy !== null}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-bold transition-colors disabled:opacity-50 ${
                  off
                    ? 'bg-brand text-white hover:bg-brand-dark'
                    : 'border border-line text-muted hover:border-red-300 dark:border-red-400/30 hover:text-red-700 dark:text-red-300'
                }`}
              >
                {busy === 'toggle' ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
                {off ? 'Turn on' : 'Turn off'}
              </button>
            </>
          )}
        </div>
      </div>

      {!off && (
        <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line-soft pt-3 md:grid-cols-4">
          <Figure label={`${fyLabel} charge`} value={fmtINR(summary?.fyDepreciation ?? 0, { nullish: '₹0' })}
                  sub={`${summary?.fyEntries ?? 0} entr${(summary?.fyEntries ?? 0) === 1 ? 'y' : 'ies'}`} />
          <Figure label="Charged all time" value={fmtINR(summary?.allTimeDepreciation ?? 0, { nullish: '₹0' })}
                  sub={`${summary?.allTimeEntries ?? 0} entr${(summary?.allTimeEntries ?? 0) === 1 ? 'y' : 'ies'}`} />
          <Figure label="Book value now" value={fmtINR(summary?.currentBookValue ?? 0, { nullish: '₹0' })} />
          <Figure label="Original cost" value={fmtINR(summary?.purchaseValueTotal ?? 0, { nullish: '₹0' })} />
        </div>
      )}
    </div>
  );
};

const Figure = ({ label, value, sub }: { label: string; value: string; sub?: string }) => (
  <div>
    <p className="text-[10px] font-bold uppercase tracking-wider text-muted">{label}</p>
    <p className="mt-0.5 text-lg font-bold text-ink">{value}</p>
    {sub && <p className="text-[10px] text-faint">{sub}</p>}
  </div>
);
