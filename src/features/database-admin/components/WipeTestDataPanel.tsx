import { useState, useEffect } from 'react';
import { AlertTriangle, Trash2 } from 'lucide-react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

interface Props {
  /** Fired after a successful wipe so the parent page can refetch lists
   * (e.g. snapshots, dashboard counters) and reflect the empty state. */
  onWipeComplete?: () => void;
}

/**
 * SUPER_ADMIN-only "Danger Zone" — wipes transactional data so the system
 * can flip cleanly from demo / pilot to production.
 *
 * Why a separate component (vs inline on DatabaseManagerPage): the wipe flow
 * has its own state machine (scope checkboxes + type-to-confirm + spinner +
 * result toast), and keeping it isolated stops the parent file from growing
 * past 250 lines of unrelated UI. The parent passes a refetch callback so
 * the snapshot list stays in sync if e.g. a snapshot referenced wiped rows.
 *
 * Safety design:
 *   - Wrapped in a red border so it visually screams "destructive."
 *   - Always-wiped scopes are listed explicitly so the admin sees the
 *     blast radius BEFORE clicking.
 *   - Optional scopes (inventory, fixed assets, projects) opt-in via
 *     checkboxes — defaults are all OFF so an accidental confirm doesn't
 *     also nuke the catalog.
 *   - Type-to-confirm phrase is required. The backend publishes it via
 *     wipe-test-data/info rather than the UI keeping its own copy. Same
 *     pattern GitHub uses for repo deletion; stops "I'll just click yes".
 *     There is ONE token ('WIPE').
 *
 *     The endpoint's `production` flag is deliberately NOT used here. It is
 *     just NODE_ENV, and the runtime image sets NODE_ENV=production, so it is
 *     true on a laptop too — the panel used it to announce "You are on the
 *     live production site" on every instance, which is false nearly
 *     everywhere it appeared and is the one sentence on this screen that must
 *     not cry wolf. The address bar is the honest signal, so the confirm copy
 *     shows window.location.host instead and lets the operator read it.
 *   - NOT auto-backed-up: this clears disposable test data, so snapshotting it
 *     would waste disk. Protecting real data is a separate manual act (JSON
 *     backup before, restore after) — the confirm copy says so.
 *   - Backend gates to SUPER_ADMIN at the route level; UI gate is a
 *     defence-in-depth + UX hint only.
 */
export const WipeTestDataPanel = ({ onWipeComplete }: Props) => {
  const { addToast } = useToast();
  const [showConfirm, setShowConfirm] = useState(false);
  const [wipeInventory, setWipeInventory] = useState(false);
  const [wipeAssets, setWipeAssets] = useState(false);
  const [wipeProjects, setWipeProjects] = useState(false);
  const [confirmPhrase, setConfirmPhrase] = useState('');
  const [isWiping, setIsWiping] = useState(false);

  // The exact phrase the admin must type to enable the Wipe button, read from
  // the backend so the UI never keeps its own copy of the string.
  //
  // There is no per-environment escalation: an earlier design had a
  // 'WIPE-PRODUCTION' variant for the live site, and this comment kept
  // describing it long after the backend settled on a single
  // WIPE_CONFIRM_TOKEN. On a production build the wipe is a flat 403 before
  // the token is checked at all, so the phrase never changes. Default to
  // 'WIPE' until the info call resolves.
  const [requiredPhrase, setRequiredPhrase] = useState('WIPE');
  // Whether ALLOW_TEST_DATA_WIPE is set on the API. Unset is the normal state,
  // so the panel says what to do about it up front rather than letting the
  // operator type WIPE and collect a 403.
  const [enabled, setEnabled] = useState(true);
  // Null until the API answers. The panel stays hidden in the meantime rather
  // than flashing a destructive control for a moment on every page load.
  const [known, setKnown] = useState(false);

  useEffect(() => {
    let alive = true;
    client
      .get('/database-manager/wipe-test-data/info')
      .then((res) => {
        if (!alive) return;
        const info = res.data?.data || res.data || {};
        if (info.confirmToken) setRequiredPhrase(info.confirmToken);
        if (typeof info.enabled === 'boolean') setEnabled(info.enabled);
        setKnown(true);
      })
      .catch(() => {/* keep the safe 'WIPE' default if the probe fails */});
    return () => { alive = false; };
  }, []);

  const canSubmit = confirmPhrase.trim() === requiredPhrase && !isWiping && enabled;
  /** Why the button is dead, in the order the operator hits the obstacles. */
  const blockedReason = isWiping
    ? null
    : !enabled
      ? 'Switched off on the API — see the note above.'
      : confirmPhrase.trim() === ''
        ? `Type ${requiredPhrase} above to enable this.`
        : confirmPhrase.trim() !== requiredPhrase
          ? `That does not match — type ${requiredPhrase} exactly (capitals).`
          : null;

  const reset = () => {
    setShowConfirm(false);
    setWipeInventory(false);
    setWipeAssets(false);
    setWipeProjects(false);
    setConfirmPhrase('');
  };

  const handleWipe = async () => {
    if (!canSubmit) return;
    setIsWiping(true);
    try {
      const res = await client.post('/database-manager/wipe-test-data', {
        confirm: requiredPhrase,
        inventoryItems: wipeInventory,
        fixedAssets: wipeAssets,
        projects: wipeProjects,
      });
      const payload = res.data?.data || res.data || {};
      const wiped = payload.wiped || {};
      // Build a single-line summary of the biggest hits so the success
      // toast actually tells the admin what happened.
      const summary = Object.entries(wiped)
        .filter(([, n]) => (n as number) > 0)
        .sort((a, b) => (b[1] as number) - (a[1] as number))
        .slice(0, 4)
        .map(([t, n]) => `${n} ${t}`)
        .join(' · ');
      addToast(`Wipe complete${summary ? ' — ' + summary : ''}.`, 'success');
      reset();
      onWipeComplete?.();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to wipe test data'), 'error');
    } finally {
      setIsWiping(false);
    }
  };

  // Not rendered at all unless the API has been switched on for this
  // environment.
  //
  // It used to render permanently and merely disable its button, explaining
  // how to switch the wipe on. That is right for a sandbox and wrong for
  // production, where "Clear test data" should not be on the page: the people
  // who open this page there are not looking for it, the blast radius is the
  // whole transactional database, and an explanation of how to enable it reads
  // as an invitation. ALLOW_TEST_DATA_WIPE is unset in production, so the panel
  // simply is not there; set it on a sandbox and the panel returns, still with
  // its typed-confirmation flow intact.
  //
  // The capability is unchanged — the API already refuses the wipe with a 403
  // when the flag is unset, and that remains the actual enforcement. This only
  // stops the UI advertising it.
  if (!known || !enabled) return null;

  return (
    <div className="bg-card rounded-xl shadow-sm border-2 border-red-200 dark:border-red-400/30 overflow-hidden">
      {/* Section header — red theme + warning icon screams "destructive". */}
      <div className="px-4 md:px-6 py-3 md:py-4 border-b border-red-100 dark:border-red-400/25 bg-red-50/40 dark:bg-red-400/15 flex items-center gap-2">
        <AlertTriangle size={16} className="text-red-700 dark:text-red-300 shrink-0" />
        <h3 className="text-xs md:text-sm font-bold text-red-900 dark:text-red-200">Danger Zone — Clear test data</h3>
      </div>

      <div className="p-4 md:p-6 space-y-4">
        {/* Shown before anything else when the API has not been switched on.
            Being told the button is inert, and exactly what to set, beats
            filling in the form and collecting a 403 at the end of it. */}
        {!enabled && (
          <div className="rounded-md border border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 px-3 py-2.5">
            <p className="text-xs font-bold text-amber-900 dark:text-amber-200">This wipe is switched off.</p>
            <p className="text-[11px] text-amber-800 dark:text-amber-200 mt-1 leading-relaxed">
              Set <code className="font-mono bg-amber-100 dark:bg-amber-400/20 px-1 rounded">ALLOW_TEST_DATA_WIPE=true</code> on
              the API and restart it. Run the wipe, then remove the variable and restart again — it is
              meant to be on for the few minutes you need it, not left on.
            </p>
          </div>
        )}

        {/* Always-on description so the admin understands the baseline
            blast radius even before they expand the confirm UI. */}
        <div>
          <p className="text-sm text-ink font-medium mb-2">
            Wipe demo / pilot transactional data so the system can move to production.
          </p>
          <p className="text-xs text-muted leading-relaxed">
            <span className="font-bold text-ink">Always wiped:</span> component requests,
            indents (incl. items + quotations + vendor allocations), BOM lists, notifications,
            conversations, audit / activity logs, custom-column values.
          </p>
          <p className="text-xs text-muted mt-2 leading-relaxed">
            <span className="font-bold text-ink">Always kept:</span> user accounts,
            departments, vendor codes, category settings, vault config, off-site backup
            credentials (GitHub PAT / S3 keys), custom column / asset field <em>definitions</em>.
          </p>
        </div>

        {!showConfirm ? (
          <button
            onClick={() => setShowConfirm(true)}
            className="inline-flex items-center gap-2 bg-red-600 text-white px-4 py-2.5 text-sm font-bold rounded-lg hover:bg-red-700 transition-colors shadow-sm"
          >
            <Trash2 size={16} /> Clear test data…
          </button>
        ) : (
          <div className="rounded-lg border border-red-200 dark:border-red-400/30 bg-red-50/30 dark:bg-red-400/15 p-4 space-y-4">
            <div>
              <p className="text-xs font-bold text-red-900 dark:text-red-200 uppercase tracking-wider mb-2">
                Also wipe (optional):
              </p>
              <div className="space-y-2 text-sm">
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wipeInventory}
                    onChange={(e) => setWipeInventory(e.target.checked)}
                    className="mt-0.5 accent-red-600"
                  />
                  <span className="text-ink">
                    <span className="font-bold">Inventory catalog</span>
                    <span className="text-muted ml-2 text-xs">
                      — wipes every inventory item + their project links. Start with an empty catalog.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wipeAssets}
                    onChange={(e) => setWipeAssets(e.target.checked)}
                    className="mt-0.5 accent-red-600"
                  />
                  <span className="text-ink">
                    <span className="font-bold">Fixed assets register</span>
                    <span className="text-muted ml-2 text-xs">
                      — wipes every asset, their custom-field values, maintenance log, events.
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={wipeProjects}
                    onChange={(e) => setWipeProjects(e.target.checked)}
                    className="mt-0.5 accent-red-600"
                  />
                  <span className="text-ink">
                    <span className="font-bold">Projects</span>
                    <span className="text-muted ml-2 text-xs">
                      — wipes every project so they can be re-created with real names.
                    </span>
                  </span>
                </label>
              </div>
            </div>

            <div className="border-t border-red-200 dark:border-red-400/30 pt-4">
              <label className="block text-xs font-bold text-red-900 dark:text-red-200 uppercase tracking-wider mb-1.5">
                Type <span className="font-mono">{requiredPhrase}</span> to confirm
              </label>
              <input
                type="text"
                value={confirmPhrase}
                onChange={(e) => setConfirmPhrase(e.target.value)}
                placeholder={requiredPhrase}
                autoFocus
                className="w-full px-3 py-2 text-sm border border-red-300 dark:border-red-400/30 rounded-md bg-card focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500 font-mono"
              />
              <p className="text-[10px] text-red-700 dark:text-red-300 mt-1.5">
                A restorable JSON snapshot and an Excel export are written before anything is
                deleted, and the wipe is abandoned if either fails. To undo it, restore that
                snapshot from Server Snapshots above.
                {' '}You are on <span className="font-bold font-mono">{window.location.host}</span>.
                {/* The old line here read "You are on the live production site."
                    whenever the API reported production:true — which it does on
                    every instance, because the runtime image sets
                    NODE_ENV=production. A laptop therefore told its operator it
                    was about to wipe live production, which is the single most
                    alarming sentence on this panel and was false everywhere it
                    appeared. The honest signal is the address the operator is
                    actually pointed at, so show that and let them read it. */}
              </p>
            </div>

            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={reset}
                disabled={isWiping}
                className="px-3 py-2 text-sm font-bold text-muted hover:bg-hover rounded-md transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              {/* Say WHY the button is dead, next to the button.
                  The reasons were only ever stated in a banner at the top of
                  the panel, so someone who typed WIPE, reached for the button
                  and found it disabled had no explanation where they were
                  looking — they had to scroll back up or go and ask. */}
              {blockedReason && (
                <span className="text-[11px] text-red-700 dark:text-red-300 mr-1 text-right max-w-xs">{blockedReason}</span>
              )}
              <button
                onClick={handleWipe}
                disabled={!canSubmit}
                title={blockedReason || 'Wipe the transactional data listed above'}
                className="inline-flex items-center gap-2 bg-red-600 text-white px-4 py-2 text-sm font-bold rounded-md hover:bg-red-700 transition-colors shadow-sm disabled:bg-red-300 disabled:cursor-not-allowed"
              >
                <Trash2 size={14} />
                {isWiping ? 'Wiping…' : 'Wipe now'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
