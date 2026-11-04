import { useEffect, useState } from 'react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import { applyApprovalPolicy } from '@/lib/approvalPolicy';
import { Gavel, Save, Loader2 } from 'lucide-react';
import { useAbortOnUnmount } from '@/hooks';

/**
 * Who has to sign off on a high-value indent, and above what amount.
 *
 * Both used to be compile-time constants — the bar was `20000` in two source
 * files, and the on/off switch was an environment variable — so Finance
 * deciding the bar should be ₹50,000 meant a code change and a redeploy. This
 * is the screen that replaces that.
 *
 * Saving also applies the new values to this tab immediately. The backend is
 * the only enforcer, but a Super Admin who raises the bar and then sees the old
 * "Awaiting CEO approval (≥₹20,000)" copy on the next screen reasonably
 * concludes the save did not work.
 */
export function ApprovalPolicyCard() {
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();
  const { addToast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [required, setRequired] = useState(false);
  const [threshold, setThreshold] = useState('20000');
  const [saved, setSaved] = useState<{ required: boolean; threshold: string }>({ required: false, threshold: '20000' });
  const [meta, setMeta] = useState<{ updatedAt?: string; updatedByName?: string | null }>({});

  const load = async () => {
    setLoading(true);
    try {
      const res = await client.get('/settings/approval-policy/detail', { signal: abortSignal() });
      const d = res.data?.data ?? res.data;
      const t = String(d.ceoApprovalThreshold ?? 20000);
      setRequired(!!d.ceoApprovalRequired);
      setThreshold(t);
      setSaved({ required: !!d.ceoApprovalRequired, threshold: t });
      setMeta({ updatedAt: d.updatedAt, updatedByName: d.updatedByName });
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load the approval policy'), 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []); // load once, on mount

  const dirty = required !== saved.required || threshold.trim() !== saved.threshold;
  const parsed = Number(threshold);
  // >= 0: zero is a real policy (every indent goes to the CEO), not an error.
  // "No CEO gate at all" is the `required` switch above, not a number.
  // An EMPTY box is not zero: Number('') is 0, so clearing the field used to
  // save a ₹0 bar and silently send every indent to the CEO. Whole paise only
  // — the server takes at most 2 decimals.
  const valid = threshold.trim() !== '' && Number.isFinite(parsed) && parsed >= 0 && parsed <= 100_000_000
    && Math.round(parsed * 100) === parsed * 100;

  const save = async () => {
    if (!valid) { addToast('Enter an amount between ₹0 and ₹10,00,00,000 (at most 2 decimals).', 'error'); return; }
    setSaving(true);
    try {
      const res = await client.patch('/settings/approval-policy', {
        ceoApprovalRequired: required,
        ceoApprovalThreshold: parsed,
      });
      const d = res.data?.data ?? res.data;
      // Apply to this tab AND re-seed the cache, so the rest of the UI stops
      // quoting the old bar immediately and a reload does not resurrect it.
      // Setting the two in-memory values alone left the cached seed stale.
      applyApprovalPolicy({
        ceoApprovalRequired: !!d.ceoApprovalRequired,
        ceoApprovalThreshold: Number(d.ceoApprovalThreshold),
      });
      setSaved({ required: !!d.ceoApprovalRequired, threshold: String(d.ceoApprovalThreshold) });
      setThreshold(String(d.ceoApprovalThreshold));
      setMeta({ updatedAt: d.updatedAt, updatedByName: d.updatedByName });
      addToast('Approval policy updated', 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not save the approval policy'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
      <div className="px-6 py-4 border-b border-line-soft flex items-center gap-3">
        <div className="w-8 h-8 rounded-full bg-amber-50 dark:bg-amber-400/15 flex items-center justify-center">
          <Gavel className="w-4 h-4 text-amber-700 dark:text-amber-300" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-ink">Indent Approval Policy</h3>
          <p className="text-xs text-muted">Who has to sign off, and above what amount.</p>
        </div>
      </div>

      <div className="p-6 space-y-5">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted">
            <Loader2 size={15} className="animate-spin" /> Loading…
          </div>
        ) : (
          <>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
                className="mt-0.5 w-4 h-4 accent-brand"
              />
              <span>
                <span className="block text-sm font-bold text-ink">Require CEO approval on high-value indents</span>
                <span className="block text-xs text-muted mt-0.5">
                  Off means tech approval alone moves an indent forward, at any amount. The CEO lane still
                  exists either way, and a CEO rejection is always honoured — this only controls whether a
                  missing CEO signature <span className="font-bold">blocks</span> progress.
                </span>
              </span>
            </label>

            <div className={required ? '' : 'opacity-50'}>
              <label className="block text-xs font-bold text-muted mb-1">
                Threshold <span className="font-normal">(INR)</span>
              </label>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted">₹</span>
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={threshold}
                  onChange={(e) => setThreshold(e.target.value)}
                  disabled={!required}
                  className="w-48 px-3 py-2 text-sm border border-line rounded-md focus:outline-none focus:ring-1 focus:ring-brand disabled:bg-surface"
                />
                {valid && (
                  <span className="text-xs text-muted">
                    {parsed === 0
                      ? '= every indent needs the CEO, whatever it costs'
                      : `= indents of ₹${parsed.toLocaleString('en-IN')} or more need the CEO`}
                  </span>
                )}
              </div>
              {!valid && (
                <p className="text-[11px] text-red-700 dark:text-red-300 mt-1">
                  Enter an amount between ₹0 and ₹10,00,00,000. Zero sends every indent to the CEO.
                </p>
              )}
              <p className="text-[11px] text-faint mt-2">
                Applies to the indent total converted to INR, so a foreign-currency indent cannot slip under
                the bar on its face value. Changing this affects indents raised from now on; ones already
                waiting on a signature keep the decision they were given.
              </p>
            </div>

            <div className="flex items-center justify-between gap-3 pt-1 border-t border-line-soft">
              <p className="text-[11px] text-faint">
                {meta.updatedAt
                  ? <>Last changed {fmtDateTime(meta.updatedAt)}{meta.updatedByName ? ` by ${meta.updatedByName}` : ''}.</>
                  : 'Never changed — using the shipped default.'}
              </p>
              <button
                onClick={save}
                disabled={!dirty || saving || !valid}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-brand rounded-md hover:bg-brand-dark disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {saving ? 'Saving…' : 'Save policy'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
