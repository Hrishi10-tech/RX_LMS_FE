import { useCallback, useEffect, useState } from 'react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { fmtDateTime } from '@/utils/date';
import {
  CloudUpload, CheckCircle2, AlertTriangle, Power, ExternalLink, Settings, Trash2, Github,
  Database, Lock, DownloadCloud, RotateCcw, RefreshCw,
} from 'lucide-react';

import { extractErrorMessage } from '@/lib';
import { useAbortOnUnmount } from '@/hooks';

/**
 * S3 and GitHub run side by side, each on its own schedule (S3 hourly, GitHub
 * daily). There used to be ONE active destination; saving the second
 * provider silently switched the first off.
 */
type Destination = 'GITHUB' | 'S3';

/** One destination's own switch, schedule and outcome. */
interface DestinationStatus {
  configured: boolean;
  enabled: boolean;
  /** "every hour" / "once a day" — set by the server, shown as-is. */
  schedule: string;
  lastAttemptAt: string | null;
  lastSucceededAt: string | null;
  lastResult: string | null;
}

interface Status {
  /** At least one destination is switched on and configured. */
  configured: boolean;
  github: DestinationStatus & { repo: string | null; branch: string | null };
  s3: DestinationStatus & {
    bucket: string | null;
    region: string | null;
    prefix: string | null;
    endpoint: string | null;
  };
  lastBackupAt: string | null;
  /** Last time an upload actually SUCCEEDED. lastBackupAt is the last attempt. */
  lastBackupSucceededAt?: string | null;
  lastBackupResult: string | null;
  lastBackupFilename: string | null;
  lastBackupSizeBytes: number | null;
  lastBackupRef: string | null;
}

const formatBytes = (b: number | null | undefined) => {


  // null/undefined → no data → em-dash. 0 → real "empty file" signal,
  // shown as "0 B" so a corrupt zero-byte upload is visible instead of
  // disguised as missing data.
  if (b == null) return '—';
  if (b === 0) return '0 B';
  const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

/**
 * Super-admin panel for off-site backup configuration + manual upload.
 *
 * Supports two destinations:
 *   - GitHub (encrypted tar.gz pushed to a private repo via Contents API).
 *     Free option, good for personal accounts / pre-launch.
 *   - S3 (encrypted tar.gz PutObject'd to any S3-compatible bucket — AWS
 *     S3, Cloudflare R2, Backblaze B2, DO Spaces, MinIO). Production
 *     standard.
 *
 * Both can be on at once, each with its own switch on its card: S3 every
 * hour, GitHub once a day. Saving a destination's credentials switches THAT
 * one on and leaves the other alone. Credentials never come back over the
 * wire once saved.
 */
export const OffSiteBackupPanel = () => {
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();
  const { addToast } = useToast();
  const confirm = useConfirm();

  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [showGithubForm, setShowGithubForm] = useState(false);
  const [showS3Form, setShowS3Form] = useState(false);

  // GitHub form state
  const [githubToken, setGithubToken] = useState('');
  const [githubRepo, setGithubRepo] = useState('');
  const [githubBranch, setGithubBranch] = useState('');

  // S3 form state
  const [s3AccessKeyId, setS3AccessKeyId] = useState('');
  const [s3SecretKey, setS3SecretKey] = useState('');
  const [s3Bucket, setS3Bucket] = useState('');
  const [s3Region, setS3Region] = useState('');
  const [s3Prefix, setS3Prefix] = useState('');
  const [s3Endpoint, setS3Endpoint] = useState('');

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  // Which destination's switch is mid-request, so only that one greys out.
  const [toggling, setToggling] = useState<Destination | null>(null);
  // Which destination the restore list reads from. Matters only when both are
  // configured — the same filename can exist in both.
  const [restoreFrom, setRestoreFrom] = useState<Destination>('S3');

  // Off-site restore state — list of backups in the chosen destination
  // + which one (if any) is currently being restored. Lazy-loaded on
  // first expansion so we don't burn an API call on every page open.
  const [offsiteList, setOffsiteList] = useState<Array<{ key: string; sizeBytes: number; uploadedAt: string; label: string }> | null>(null);
  const [offsiteLoading, setOffsiteLoading] = useState(false);
  const [offsiteRestoring, setOffsiteRestoring] = useState<string | null>(null);
  const [showOffsiteList, setShowOffsiteList] = useState(false);
  // Two-step confirm for the destructive restore: clicking Restore on
  // a row enters "confirm mode" for that row's key; user must type
  // RESTORE to enable the final button. Avoids the `window.confirm`
  // one-click-and-it's-gone scenario where a sleepy admin nukes prod
  // on the wrong row. Same pattern as the Wipe Test Data panel.
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const fetchStatus = useCallback(async () => {
    try {
      const res = await client.get('/database-manager/backup/status', { signal: abortSignal() });
      setStatus(res.data?.data ?? res.data);
    } catch (e: any) { addToast(extractErrorMessage(e, 'Could not load backup status'), 'error'); } finally {
      setLoading(false);
    }
  }, [addToast]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // ---- GitHub actions ------------------------------------------------------

  const saveGithubConfig = async () => {
    if (!githubToken.trim() || !githubRepo.trim()) {
      addToast('GitHub token and repo are both required.', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await client.post('/database-manager/github/config', {
        token: githubToken.trim(),
        repo: githubRepo.trim(),
        branch: githubBranch.trim() || undefined,
        enabled: true,
      });
      const data = res.data?.data ?? res.data;
      addToast(`Connected → ${data.repo} (branch ${data.defaultBranch}). Daily encrypted backups to GitHub are on.`, 'success');
      setGithubToken('');
      setShowGithubForm(false);
      await fetchStatus();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to save GitHub config'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const testGithub = async () => {
    setTesting(true);
    try {
      const res = await client.post('/database-manager/github/test');
      const data = res.data?.data ?? res.data;
      addToast(`GitHub OK → ${data.repo} (branch ${data.defaultBranch}).`, 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Connection test failed'), 'error');
    } finally {
      setTesting(false);
    }
  };

  const clearGithub = async () => {
    if (!await confirm('Remove the saved GitHub credentials? Daily backups to GitHub will stop. S3 is unaffected.')) return;
    try {
      await client.delete('/database-manager/github/config');
      // Wipe local form state too so a previously-typed PAT doesn't
      // linger in React memory until the user navigates away. Secrets
      // shouldn't outlive the "clear" action.
      setGithubToken('');
      setGithubRepo('');
      setGithubBranch('');
      addToast('GitHub credentials cleared.', 'success');
      await fetchStatus();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to clear'), 'error');
    }
  };

  // ---- S3 actions ----------------------------------------------------------

  const saveS3Config = async () => {
    if (!s3AccessKeyId.trim() || !s3SecretKey.trim() || !s3Bucket.trim() || !s3Region.trim()) {
      addToast('Access key, secret, bucket, and region are all required.', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await client.post('/database-manager/s3/config', {
        accessKeyId: s3AccessKeyId.trim(),
        secretAccessKey: s3SecretKey.trim(),
        bucket: s3Bucket.trim(),
        region: s3Region.trim(),
        prefix: s3Prefix.trim() || undefined,
        endpoint: s3Endpoint.trim() || undefined,
        enabled: true,
      });
      const data = res.data?.data ?? res.data;
      addToast(`Connected → s3://${data.bucket} (${data.region}). Hourly encrypted backups to S3 are on.`, 'success');
      setS3SecretKey('');
      setS3AccessKeyId('');
      setShowS3Form(false);
      await fetchStatus();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to save S3 config'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const testS3 = async () => {
    setTesting(true);
    try {
      const res = await client.post('/database-manager/s3/test');
      const data = res.data?.data ?? res.data;
      addToast(`S3 OK → s3://${data.bucket} (${data.region}).`, 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Connection test failed'), 'error');
    } finally {
      setTesting(false);
    }
  };

  const clearS3 = async () => {
    if (!await confirm('Remove the saved S3 credentials? Hourly backups to S3 will stop. GitHub is unaffected.')) return;
    try {
      await client.delete('/database-manager/s3/config');
      // Wipe local form state — see clearGithub comment above.
      setS3AccessKeyId('');
      setS3SecretKey('');
      setS3Bucket('');
      setS3Region('');
      setS3Prefix('');
      setS3Endpoint('');
      addToast('S3 credentials cleared.', 'success');
      await fetchStatus();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to clear'), 'error');
    }
  };

  // ---- Shared actions ------------------------------------------------------

  // Restore reads from a CONFIGURED destination, not just a switched-on one:
  // restoring from copies you stopped sending to is what old copies are for.
  const restoreSource: Destination =
    status && status.s3.configured && status.github.configured
      ? restoreFrom
      : status?.github.configured && !status?.s3.configured ? 'GITHUB' : 'S3';

  const isOn = (d: Destination) => !!status && (d === 'S3' ? status.s3 : status.github).enabled;

  const runNow = async () => {
    if (!status) return;
    const on = (['S3', 'GITHUB'] as Destination[]).filter((d) => isOn(d));
    const names = on.map((d) => (d === 'S3' ? 'S3' : 'GitHub')).join(' and ');
    if (!await confirm(`Run a backup now and upload it to ${names}?`)) return;
    setRunning(true);
    try {
      const res = await client.post('/database-manager/backup/run');
      const data = res.data?.data ?? res.data;
      const results: Array<{ destination: Destination; ok: boolean; error?: string }> = data?.results ?? [];
      const failed = results.filter((r) => !r.ok);
      // Partial success is reported per destination rather than as one green
      // toast — "uploaded" while GitHub silently failed is the exact kind of
      // reassurance this screen must not give.
      if (failed.length === 0) {
        addToast(`Backup uploaded to ${names} — ${data.filename} (${formatBytes(data.sizeBytes)})`, 'success');
      } else {
        const okNames = results.filter((r) => r.ok).map((r) => (r.destination === 'S3' ? 'S3' : 'GitHub'));
        addToast(
          `Uploaded to ${okNames.join(' and ')}, but ` +
          failed.map((f) => `${f.destination === 'S3' ? 'S3' : 'GitHub'} failed: ${f.error}`).join('; '),
          'error',
        );
      }
      await fetchStatus();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Backup failed'), 'error');
      await fetchStatus();
    } finally {
      setRunning(false);
    }
  };

  const toggleEnabled = async (d: Destination) => {
    if (!status) return;
    const turningOn = !isOn(d);
    setToggling(d);
    try {
      await client.patch('/database-manager/backup/enabled', { destination: d, enabled: turningOn });
      const name = d === 'S3' ? 'S3' : 'GitHub';
      addToast(turningOn ? `${name} backups switched on` : `${name} backups paused`, 'success');
      await fetchStatus();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to toggle'), 'error');
    } finally {
      setToggling(null);
    }
  };

  // ---- Off-site restore handlers ------------------------------------------

  const loadOffsiteList = useCallback(async (from: Destination) => {
    setOffsiteLoading(true);
    try {
      const res = await client.get('/database-manager/backup/offsite/list', {
        params: { destination: from },
        signal: abortSignal(),
      });
      const items = res.data?.data ?? res.data ?? [];
      setOffsiteList(Array.isArray(items) ? items : []);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not load off-site backups'), 'error');
      setOffsiteList([]);
    } finally {
      setOffsiteLoading(false);
    }
  }, [addToast]);

  /**
   * Final restore action — only reachable after the user has typed
   * "RESTORE" into the confirm field for that row. The two-step UI
   * prevents the "I one-clicked the wrong row" disaster the previous
   * single-button confirm exposed us to.
   */
  const restoreFromOffsite = async (item: { key: string; label: string }) => {
    setOffsiteRestoring(item.key);
    try {
      const res = await client.post('/database-manager/backup/offsite/restore', { key: item.key, destination: restoreSource });
      const data = res.data?.data ?? res.data;
      // Nullish guards so a backend that returns partial data doesn't
      // surface as "undefined rows across undefined tables" in the
      // toast — show useful fallback strings instead.
      const fname = data?.filename || item.label;
      const rows = data?.rowCount != null ? `${data.rowCount} rows` : 'rows restored';
      const tables = data?.tableCount != null ? `${data.tableCount} tables` : 'tables';
      addToast(
        `Restored ${fname} — ${rows} across ${tables}.` +
        (data?.uploadsRestored ? ' Uploads restored too.' : ''),
        'success',
      );
      // Status panel may show stale "last backup" telemetry from before
      // the restore — reload it. Also reset confirm state for next time.
      setConfirmingKey(null);
      setConfirmText('');
      await fetchStatus();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Off-site restore failed'), 'error');
    } finally {
      setOffsiteRestoring(null);
    }
  };

  return (
    <div className="bg-card rounded-xl shadow-sm border border-line-soft overflow-hidden">
      <div className="px-4 md:px-6 py-3 md:py-4 border-b border-line-soft bg-gradient-to-r from-blue-50/50 to-indigo-50/40 dark:from-blue-400/10 dark:to-indigo-400/10 flex items-start gap-3">
        <CloudUpload size={20} className="text-blue-600 dark:text-blue-300 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <h3 className="text-sm md:text-base font-bold text-ink">Off-site Backup</h3>
          <p className="text-xs text-muted mt-0.5">
            A full DB + uploads snapshot goes to S3 every hour and to GitHub once a day, each
            AES-256-GCM encrypted with your VAULT_SECRET_KEY before it leaves the server. Keep
            both on and one provider failing never leaves you without a recent copy.
          </p>
        </div>
      </div>

      {loading && (
        <div className="text-center text-faint py-8 text-sm">Loading…</div>
      )}

      {!loading && status && (
        <div className="p-4 md:p-6 space-y-5">
          {/* One card per destination. They run side by side on their own
              schedules, so each shows its own switch, schedule and outcome —
              a single "Status" for both would let a healthy S3 hide a broken
              GitHub, which is the failure having two is meant to survive. */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(['S3', 'GITHUB'] as Destination[]).map((d) => {
              const st = d === 'S3' ? status.s3 : status.github;
              const name = d === 'S3' ? 'S3' : 'GitHub';
              const failed = !!st.lastResult && st.lastResult !== 'OK';
              const tone = d === 'S3'
                ? 'text-orange-600 dark:text-orange-300'
                : 'text-purple-700 dark:text-purple-300';
              return (
                <div key={d} className="border border-line rounded-lg p-3 bg-surface/40 space-y-2 text-xs">
                  <div className="flex items-center gap-1.5">
                    {d === 'S3' ? <Database size={13} className={tone} /> : <Github size={13} className={tone} />}
                    <span className="font-bold text-ink">{name}</span>
                    <Lock size={10} className={tone} />
                    <span className="text-[10px] text-faint">· {st.schedule}</span>
                    {st.configured ? (
                      <button
                        onClick={() => toggleEnabled(d)}
                        disabled={toggling !== null}
                        className={`ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold disabled:opacity-50 ${
                          st.enabled
                            ? 'bg-emerald-100 dark:bg-emerald-400/20 text-emerald-800 dark:text-emerald-200'
                            : 'bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200'
                        }`}
                        title={st.enabled ? `Pause ${name} backups` : `Switch ${name} backups on`}
                      >
                        <Power size={10} /> {toggling === d ? '…' : st.enabled ? 'On' : 'Paused'}
                      </button>
                    ) : (
                      <span className="ml-auto text-[10px] text-faint inline-flex items-center gap-1">
                        <AlertTriangle size={10} /> Not configured
                      </span>
                    )}
                  </div>

                  {st.configured && (
                    <>
                      <p className="text-[10px] text-faint truncate font-mono">
                        {d === 'S3'
                          ? `s3://${status.s3.bucket}${status.s3.prefix ? `/${status.s3.prefix}` : ''} · ${status.s3.region}`
                          : status.github.repo}
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          {/* Time of the last SUCCESS. A failed attempt used
                              to show here and read as a recent backup. */}
                          <p className="text-[10px] text-faint uppercase font-bold">Last successful</p>
                          <p className="font-medium text-ink mt-0.5">
                            {st.lastSucceededAt ? fmtDateTime(st.lastSucceededAt) : 'Never'}
                          </p>
                        </div>
                        <div className="min-w-0">
                          <p className="text-[10px] text-faint uppercase font-bold">Last result</p>
                          {!st.lastResult && <p className="text-faint mt-0.5">—</p>}
                          {st.lastResult === 'OK' && (
                            <p className="font-bold text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-1 mt-0.5">
                              <CheckCircle2 size={12} /> OK
                            </p>
                          )}
                          {failed && (
                            <>
                              <p className="font-bold text-red-700 dark:text-red-300 truncate mt-0.5" title={st.lastResult!}>
                                {st.lastResult}
                              </p>
                              {st.lastAttemptAt && (
                                <p className="text-[10px] text-faint mt-0.5">Failed {fmtDateTime(st.lastAttemptAt)}</p>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                      {d === 'GITHUB' && status.github.repo && (
                        <a
                          href={`https://github.com/${status.github.repo}/tree/${status.github.branch || 'main'}/backups`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[10px] font-bold text-purple-700 dark:text-purple-300 hover:underline">
                          <ExternalLink size={10} /> Browse repo backups
                        </a>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Last archive built — shared by every destination it was sent to. */}
          {status.lastBackupFilename && (
            <p className="text-[11px] text-muted">
              Last archive: <span className="font-mono">{status.lastBackupFilename}</span>
              {' '}· {formatBytes(status.lastBackupSizeBytes)}
            </p>
          )}

          {status.configured && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={runNow}
                disabled={running}
                className="inline-flex items-center gap-1.5 bg-blue-600 text-white px-3 py-1.5 rounded-md text-xs font-bold hover:bg-blue-700 disabled:opacity-50 shadow-sm">
                <CloudUpload size={12} />
                {running ? 'Uploading…' : 'Backup now'}
              </button>
              <span className="text-[11px] text-faint">Sends to every destination that is on, whatever its schedule.</span>
            </div>
          )}

          {/* ---- Restore from off-site (only when a destination is active) ---- */}
          {status.configured && (
            <div className="border border-line rounded-lg overflow-hidden">
              <button
                onClick={() => {
                  const next = !showOffsiteList;
                  setShowOffsiteList(next);
                  if (next && offsiteList === null) loadOffsiteList(restoreSource);
                }}
                className="w-full px-3 py-2 bg-emerald-50/40 dark:bg-emerald-400/15 border-b border-line flex items-center gap-2 hover:bg-emerald-50/60 dark:bg-emerald-400/15 transition-colors">
                <DownloadCloud size={14} className="text-emerald-700 dark:text-emerald-300" />
                <h4 className="text-xs font-bold text-ink">Restore from off-site</h4>
                <span className="ml-auto text-[10px] text-muted">
                  {showOffsiteList ? '▾ Hide' : '▸ Show available backups'}
                </span>
              </button>
              {showOffsiteList && (
                <div className="p-3 space-y-2">
                  {/* Only offered when both hold backups — the same filename
                      can exist in each, so restoring has to say which. */}
                  {status.s3.configured && status.github.configured && (
                    <div className="inline-flex rounded-md border border-line overflow-hidden text-[11px] font-bold">
                      {(['S3', 'GITHUB'] as Destination[]).map((d) => (
                        <button
                          key={d}
                          onClick={() => {
                            if (d === restoreSource) return;
                            setRestoreFrom(d);
                            setOffsiteList(null);
                            setConfirmingKey(null);
                            loadOffsiteList(d);
                          }}
                          className={`px-3 py-1 ${d === restoreSource ? 'bg-brand text-white' : 'bg-card text-muted hover:text-ink'}`}
                        >
                          {d === 'S3' ? 'S3' : 'GitHub'}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <p className="text-[11px] text-muted">
                      Pick a snapshot from {restoreSource === 'GITHUB' ? 'GitHub' : 'S3'}.
                      Restoring wipes the live DB and replaces it with the backup contents
                      (uploads too).
                    </p>
                    <button
                      onClick={() => loadOffsiteList(restoreSource)}
                      disabled={offsiteLoading}
                      title="Refresh list"
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-muted hover:text-ink px-2 py-0.5 rounded hover:bg-hover disabled:opacity-50">
                      <RefreshCw size={11} className={offsiteLoading ? 'animate-spin' : ''} />
                      Refresh
                    </button>
                  </div>

                  {offsiteLoading && offsiteList === null && (
                    <p className="text-[11px] text-faint text-center py-4">Loading…</p>
                  )}

                  {offsiteList !== null && offsiteList.length === 0 && (
                    <p className="text-[11px] text-faint text-center py-4">
                      No backups in this destination yet. Click "Backup now" to seed one.
                    </p>
                  )}

                  {offsiteList !== null && offsiteList.length > 0 && (
                    <div className="border border-line rounded-md divide-y divide-line-soft max-h-72 overflow-y-auto">
                      {offsiteList
                        .slice()
                        .sort((a, b) => new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime())
                        .map((item) => {
                          const inConfirm = confirmingKey === item.key;
                          const canConfirm = inConfirm && confirmText === 'RESTORE';
                          return (
                            <div key={item.key} className="px-2.5 py-1.5 text-[11px] hover:bg-surface">
                              <div className="flex items-center gap-2">
                                <div className="flex-1 min-w-0">
                                  <p className="font-mono truncate text-ink">{item.label}</p>
                                  <p className="text-[10px] text-faint">
                                    {fmtDateTime(item.uploadedAt)} · {formatBytes(item.sizeBytes)}
                                  </p>
                                </div>
                                {!inConfirm && (
                                  <button
                                    onClick={() => {
                                      setConfirmingKey(item.key);
                                      setConfirmText('');
                                    }}
                                    disabled={offsiteRestoring !== null}
                                    title="Begin restore — requires typing RESTORE to confirm"
                                    className="inline-flex items-center gap-1 bg-emerald-700 text-white px-2 py-1 rounded text-[10px] font-bold hover:bg-emerald-800 disabled:opacity-50">
                                    <RotateCcw size={10} />
                                    {offsiteRestoring === item.key ? 'Restoring…' : 'Restore'}
                                  </button>
                                )}
                              </div>
                              {/* Type-to-confirm sub-row. Mirrors the Wipe Test
                                  Data panel pattern — destructive ops should
                                  never be reachable with a single click. */}
                              {inConfirm && (
                                <div className="mt-2 p-2 bg-red-50/60 dark:bg-red-400/15 border border-red-200 dark:border-red-400/30 rounded space-y-1.5">
                                  <p className="text-[11px] text-red-800 dark:text-red-200 leading-snug">
                                    <span className="font-bold">⚠ This wipes the LIVE database</span> and replaces
                                    it with the contents of <span className="font-mono">{item.label}</span>.
                                    Uploaded files (receipts, vendor forms, asset photos) are also overwritten.
                                    <b> Cannot be undone.</b>
                                  </p>
                                  <p className="text-[10px] text-red-800 dark:text-red-200">
                                    Type <code className="font-mono bg-card px-1 rounded border border-red-200 dark:border-red-400/30">RESTORE</code> to enable:
                                  </p>
                                  <div className="flex items-center gap-2">
                                    <input
                                      type="text"
                                      autoFocus
                                      value={confirmText}
                                      onChange={(e) => setConfirmText(e.target.value)}
                                      placeholder="RESTORE"
                                      autoComplete="off"
                                      data-1p-ignore="true"
                                      data-lpignore="true"
                                      className="flex-1 border border-red-300 dark:border-red-400/30 bg-card rounded px-2 py-1 text-[11px] font-mono focus:border-red-500 outline-none"
                                    />
                                    <button
                                      onClick={() => {
                                        setConfirmingKey(null);
                                        setConfirmText('');
                                      }}
                                      disabled={offsiteRestoring !== null}
                                      className="px-2 py-1 text-[10px] font-bold text-muted border border-line rounded hover:bg-surface disabled:opacity-50">
                                      Cancel
                                    </button>
                                    <button
                                      onClick={() => restoreFromOffsite(item)}
                                      disabled={!canConfirm || offsiteRestoring !== null}
                                      className="inline-flex items-center gap-1 bg-red-600 text-white px-2 py-1 rounded text-[10px] font-bold hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed">
                                      <RotateCcw size={10} />
                                      {offsiteRestoring === item.key ? 'Restoring…' : 'Confirm restore'}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ---- GitHub configuration card ---- */}
          <div className="border border-line rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-purple-50/40 dark:bg-purple-400/15 border-b border-line flex items-center gap-2">
              <Github size={14} className="text-purple-700 dark:text-purple-300" />
              <h4 className="text-xs font-bold text-ink">GitHub (encrypted)</h4>
              <Lock size={11} className="text-purple-700 dark:text-purple-300" />
              {status.github.configured ? (
                <span className="ml-auto text-[10px] font-bold text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-0.5">
                  <CheckCircle2 size={11} /> Configured
                </span>
              ) : (
                <span className="ml-auto text-[10px] font-bold text-faint">Not configured</span>
              )}
            </div>
            <div className="p-3 space-y-2">
              <p className="text-[11px] text-muted">
                Each backup is encrypted with <code className="text-[10px] bg-hover px-1 rounded">VAULT_SECRET_KEY</code> before
                upload, then PUT to <code className="text-[10px] bg-hover px-1 rounded">backups/YYYY-MM/</code> in a private repo.
                Free, no infra to manage. Good for personal accounts / pre-launch.
              </p>

              {status.github.configured && !showGithubForm && (
                <div className="flex flex-wrap gap-2">
                  <button onClick={testGithub} disabled={testing}
                    className="inline-flex items-center gap-1.5 bg-card border border-line text-ink px-2.5 py-1 rounded text-[11px] font-bold hover:bg-surface disabled:opacity-50">
                    <CheckCircle2 size={11} />
                    {testing ? 'Testing…' : 'Test'}
                  </button>
                  <button onClick={() => setShowGithubForm(true)}
                    className="inline-flex items-center gap-1.5 text-[11px] font-bold text-muted hover:text-ink px-2.5 py-1 rounded hover:bg-hover">
                    <Settings size={11} /> Reconfigure
                  </button>
                  <button onClick={clearGithub}
                    className="inline-flex items-center gap-1.5 text-[11px] font-bold text-red-700 dark:text-red-300 hover:bg-red-50 dark:bg-red-400/15 px-2.5 py-1 rounded ml-auto">
                    <Trash2 size={11} /> Clear
                  </button>
                </div>
              )}

              {(!status.github.configured || showGithubForm) && (
                /* Wrapping in a <form noValidate autoComplete="off"> covers Chrome's
                   form-level autofill heuristics on top of the per-field
                   attributes. Belt + suspenders — Chrome occasionally
                   ignores per-field hints when the surrounding context
                   "looks like" a login form. preventDefault on submit
                   keeps the form from accidentally page-navigating if
                   the user hits Enter inside an input. */
                <form noValidate
                  autoComplete="off"
                  onSubmit={(e) => { e.preventDefault(); saveGithubConfig(); }}
                  className="space-y-2"
                >
                  <ol className="text-[11px] text-muted space-y-0.5 list-decimal pl-4">
                    <li>Create a <b>private</b> repo (e.g. <code className="text-[10px] bg-hover px-1 rounded">lab-management-data-backups</code>).</li>
                    <li>Generate a <b>fine-grained PAT</b> scoped to just that repo: <i>Contents: Read &amp; Write</i>.</li>
                    <li>Paste the PAT + <code className="text-[10px] bg-hover px-1 rounded">owner/repo</code> below.</li>
                  </ol>
                  <div>
                    <label className="block text-[10px] font-bold text-muted uppercase mb-1">Personal access token</label>
                    {/* `autoComplete="new-password"` is the one autocomplete value Chrome
                        actually respects on password fields. `"off"` is ignored by
                        Chrome for type=password. Pairing with `name` that doesn't look
                        like "password" + `data-1p-ignore` (1Password) + `data-lpignore`
                        (LastPass) covers the common managers. */}
                    <input
                      type="password"
                      name="lab-mgmt-github-pat"
                      autoComplete="new-password"
                      data-1p-ignore="true"
                      data-lpignore="true"
                      value={githubToken}
                      onChange={(e) => setGithubToken(e.target.value)}
                      placeholder="github_pat_..."
                      className="w-full border border-line rounded-md py-1.5 px-2 text-xs font-mono focus:border-purple-400 outline-none"
                    />
                    <p className="text-[10px] text-faint mt-0.5">
                      Stored encrypted. Never returned over the wire.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <div className="sm:col-span-2">
                      <label className="block text-[10px] font-bold text-muted uppercase mb-1">Repo (owner/name)</label>
                      <input
                        type="text"
                        name="lab-mgmt-github-repo"
                        autoComplete="off"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        value={githubRepo}
                        onChange={(e) => setGithubRepo(e.target.value)}
                        placeholder="vaibhavadarani-art/lab-management-data-backups"
                        className="w-full border border-line rounded-md py-1.5 px-2 text-xs font-mono focus:border-purple-400 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-1">Branch (optional)</label>
                      <input
                        type="text"
                        name="lab-mgmt-github-branch"
                        autoComplete="off"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        value={githubBranch}
                        onChange={(e) => setGithubBranch(e.target.value)}
                        placeholder="main"
                        className="w-full border border-line rounded-md py-1.5 px-2 text-xs font-mono focus:border-purple-400 outline-none"
                      />
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    {status.github.configured && (
                      <button type="button" onClick={() => setShowGithubForm(false)}
                        className="px-2.5 py-1 text-[11px] font-bold text-muted border border-line rounded hover:bg-surface">
                        Cancel
                      </button>
                    )}
                    <button type="submit" disabled={saving}
                      className="inline-flex items-center gap-1.5 bg-purple-600 text-white px-3 py-1 rounded text-[11px] font-bold hover:bg-purple-700 disabled:opacity-50">
                      <Github size={11} />
                      {saving ? 'Connecting…' : 'Save & connect'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>

          {/* ---- S3 configuration card ---- */}
          <div className="border border-line rounded-lg overflow-hidden">
            <div className="px-3 py-2 bg-orange-50/40 dark:bg-orange-400/15 border-b border-line flex items-center gap-2">
              <Database size={14} className="text-orange-600 dark:text-orange-300" />
              <h4 className="text-xs font-bold text-ink">S3 (encrypted)</h4>
              <Lock size={11} className="text-orange-600 dark:text-orange-300" />
              {status.s3.configured ? (
                <span className="ml-auto text-[10px] font-bold text-emerald-700 dark:text-emerald-300 inline-flex items-center gap-0.5">
                  <CheckCircle2 size={11} /> Configured
                </span>
              ) : (
                <span className="ml-auto text-[10px] font-bold text-faint">Not configured</span>
              )}
            </div>
            <div className="p-3 space-y-2">
              <p className="text-[11px] text-muted">
                Works with AWS S3, <b>Cloudflare R2</b>, <b>Backblaze B2</b>, DigitalOcean Spaces, MinIO —
                anything S3-compatible. Production standard. Each backup is encrypted
                with <code className="text-[10px] bg-hover px-1 rounded">VAULT_SECRET_KEY</code> before upload.
              </p>

              {status.s3.configured && !showS3Form && (
                <div className="flex flex-wrap gap-2">
                  <button onClick={testS3} disabled={testing}
                    className="inline-flex items-center gap-1.5 bg-card border border-line text-ink px-2.5 py-1 rounded text-[11px] font-bold hover:bg-surface disabled:opacity-50">
                    <CheckCircle2 size={11} />
                    {testing ? 'Testing…' : 'Test'}
                  </button>
                  <button onClick={() => setShowS3Form(true)}
                    className="inline-flex items-center gap-1.5 text-[11px] font-bold text-muted hover:text-ink px-2.5 py-1 rounded hover:bg-hover">
                    <Settings size={11} /> Reconfigure
                  </button>
                  <button onClick={clearS3}
                    className="inline-flex items-center gap-1.5 text-[11px] font-bold text-red-700 dark:text-red-300 hover:bg-red-50 dark:bg-red-400/15 px-2.5 py-1 rounded ml-auto">
                    <Trash2 size={11} /> Clear
                  </button>
                </div>
              )}

              {(!status.s3.configured || showS3Form) && (
                /* See GitHub form above for the rationale on wrapping the
                   inputs in a <form noValidate autoComplete="off"> — closes the
                   Chrome autofill loophole that per-field attrs alone
                   sometimes don't catch. */
                <form noValidate
                  autoComplete="off"
                  onSubmit={(e) => { e.preventDefault(); saveS3Config(); }}
                  className="space-y-2"
                >
                  <ol className="text-[11px] text-muted space-y-0.5 list-decimal pl-4">
                    <li>Create a private bucket on AWS S3 (or R2 / B2 / Spaces / MinIO).</li>
                    <li>Create an access key scoped to that bucket only, with: <code className="text-[10px] bg-hover px-1 rounded">s3:PutObject</code>, <code className="text-[10px] bg-hover px-1 rounded">s3:DeleteObject</code>, <code className="text-[10px] bg-hover px-1 rounded">s3:ListBucket</code>, <code className="text-[10px] bg-hover px-1 rounded">s3:GetBucketLocation</code>.</li>
                    <li>Paste access key + secret + bucket + region below. For R2/B2/Spaces/MinIO also set the endpoint URL.</li>
                  </ol>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-1">Access key ID</label>
                      <input
                        type="text"
                        name="lab-mgmt-s3-access-key-id"
                        autoComplete="off"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        value={s3AccessKeyId}
                        onChange={(e) => setS3AccessKeyId(e.target.value)}
                        placeholder="AKIA..."
                        className="w-full border border-line rounded-md py-1.5 px-2 text-xs font-mono focus:border-orange-400 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-1">Secret access key</label>
                      <input
                        type="password"
                        name="lab-mgmt-s3-secret"
                        autoComplete="new-password"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        value={s3SecretKey}
                        onChange={(e) => setS3SecretKey(e.target.value)}
                        placeholder="••••••••"
                        className="w-full border border-line rounded-md py-1.5 px-2 text-xs font-mono focus:border-orange-400 outline-none"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-1">Bucket</label>
                      <input
                        type="text"
                        name="lab-mgmt-s3-bucket"
                        autoComplete="off"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        value={s3Bucket}
                        onChange={(e) => setS3Bucket(e.target.value)}
                        placeholder="lab-management-backups"
                        className="w-full border border-line rounded-md py-1.5 px-2 text-xs font-mono focus:border-orange-400 outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-1">Region</label>
                      <input
                        type="text"
                        name="lab-mgmt-s3-region"
                        autoComplete="off"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        value={s3Region}
                        onChange={(e) => setS3Region(e.target.value)}
                        placeholder='AWS: "us-east-1" · R2: "auto"'
                        className="w-full border border-line rounded-md py-1.5 px-2 text-xs font-mono focus:border-orange-400 outline-none"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-1">
                        Prefix <span className="text-faint font-normal">(optional)</span>
                      </label>
                      <input
                        type="text"
                        name="lab-mgmt-s3-prefix"
                        autoComplete="off"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        value={s3Prefix}
                        onChange={(e) => setS3Prefix(e.target.value)}
                        placeholder="lab-prod"
                        className="w-full border border-line rounded-md py-1.5 px-2 text-xs font-mono focus:border-orange-400 outline-none"
                      />
                      <p className="text-[10px] text-faint mt-0.5">
                        Optional folder prefix inside the bucket.
                      </p>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase mb-1">
                        Endpoint URL <span className="text-faint font-normal">(optional)</span>
                      </label>
                      <input
                        type="text"
                        name="lab-mgmt-s3-endpoint"
                        autoComplete="off"
                        data-1p-ignore="true"
                        data-lpignore="true"
                        value={s3Endpoint}
                        onChange={(e) => setS3Endpoint(e.target.value)}
                        placeholder="https://<account>.r2.cloudflarestorage.com"
                        className="w-full border border-line rounded-md py-1.5 px-2 text-xs font-mono focus:border-orange-400 outline-none"
                      />
                      <p className="text-[10px] text-faint mt-0.5">
                        Leave empty for AWS S3. Required for R2/B2/Spaces/MinIO.
                      </p>
                    </div>
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    {status.s3.configured && (
                      <button type="button" onClick={() => setShowS3Form(false)}
                        className="px-2.5 py-1 text-[11px] font-bold text-muted border border-line rounded hover:bg-surface">
                        Cancel
                      </button>
                    )}
                    <button type="submit" disabled={saving}
                      className="inline-flex items-center gap-1.5 bg-orange-700 text-white px-3 py-1 rounded text-[11px] font-bold hover:bg-orange-800 disabled:opacity-50">
                      <Database size={11} />
                      {saving ? 'Connecting…' : 'Save & connect'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
