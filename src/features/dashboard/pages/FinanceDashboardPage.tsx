import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { client } from '@/api';
import { logError } from '@/lib';
import { useAuth, useAbortOnUnmount } from '@/hooks';
import { fmtINR } from '@/utils/number';
import { DepreciationPanel } from '@/features/fixed-assets';
import { Boxes, Cpu, Briefcase, Building2, Repeat, Wrench, ChevronRight } from 'lucide-react';

export const FinanceDashboardPage = () => {


  const abortSignal = useAbortOnUnmount();
    const navigate = useNavigate();
    const { user } = useAuth();
    // The subscription ledger is FINANCE-only by design — the backend comment
    // on SubscriptionsController is explicit that ASSOCIATE_FINANCE is
    // "deliberately excluded ... the finance head's book, not the assistant's".
    // This page is shared by /finance and /associate-finance, so it was asking
    // for a tile AF is not allowed to have and taking a 403 on every visit.
    // Don't offer the tile to a role that can't read it, rather than widening
    // access to a financial ledger nobody asked to widen. If that ever changes,
    // the backend comment says exactly what to do: add ASSOCIATE_FINANCE to the
    // @Roles on the GET routes only, then drop this flag.
    const canReadSubscriptions = user?.role === 'FINANCE' || user?.role === 'SUPER_ADMIN';
    // Who can operate the depreciation switch. FINANCE and SUPER_ADMIN
    // obviously; ASSOCIATE_FINANCE because the toggle was asked for on the
    // Associate Finance dashboard too, and this page serves both routes.
    // Worth flagging: AF is deliberately read-only for money elsewhere in this
    // app, so this is the one financial control it operates — narrow it here
    // and in the controller's @Roles if that turns out to be wrong.
    const canManageDepreciation =
      user?.role === 'FINANCE' || user?.role === 'SUPER_ADMIN' || user?.role === 'ASSOCIATE_FINANCE';

    const [stats, setStats] = useState<any>(null);
    // Fixed-asset stats are a separate, independent fetch — the indent
    // and asset systems are decoupled so each can fail without breaking
    // the other.
    const [assetStats, setAssetStats] = useState<any>(null);
    // The "expiring soon" subscription tile reads two integers from a
    // dedicated aggregate endpoint (no full-list pull). The maintenance
    // tile reads its counts off `assetStats` (see maintSummary below).
    const [subSummary, setSubSummary] = useState<{ due14: number; overdue: number }>({ due14: 0, overdue: 0 });
    // Every tile on this page rendered a literal "-" until data arrived, and
    // kept rendering "-" forever if the fetch failed. A finance user hitting a
    // 403 (AF roles do get 403 on some of these) or a dropped backend saw a
    // dashboard of dashes with no way to tell "still loading", "genuinely
    // zero" and "broken" apart. Track load state per fetch and say which part
    // failed.
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState<string[]>([]);
    const noteFailure = (label: string) => setFailed((prev) => (prev.includes(label) ? prev : [...prev, label]));

    useEffect(() => {
        let alive = true;
        const settle = Promise.all([
          client.get('/indents/dashboard/stats', { signal: abortSignal() })
            .then(({ data }) => { if (alive) setStats(data.data); })
            .catch(err => { logError('FinanceDashboard.stats', err); if (alive) noteFailure('procurement stats'); }),

          client.get('/fixed-assets/stats', { signal: abortSignal() })
            .then(({ data }) => { if (alive) setAssetStats(data.data ?? data); })
            .catch(err => { logError('FinanceDashboard.assetStats', err); if (alive) noteFailure('fixed-asset stats'); }),

          // Subscription expiry tile — two integers (overdue + due-within-14),
          // computed server-side over UNPAID rows. Replaces pulling every
          // UNPAID row just to bucket it client-side. Skipped entirely for
          // roles without ledger access (see canReadSubscriptions above).
          canReadSubscriptions
            ? client.get('/subscriptions/expiry-summary', { signal: abortSignal() })
                .then(({ data }) => { if (alive) setSubSummary(data.data ?? data); })
                .catch(err => { logError('FinanceDashboard.subSummary', err); if (alive) noteFailure('subscription expiry'); })
            : Promise.resolve(),
        ]);
        settle.finally(() => { if (alive) setLoading(false); });
        // The three fetches are independent and each already swallows its own
        // rejection, so this only guards against setState after unmount.
        return () => { alive = false; };
        // One fetch per
        // mount; re-runs only if the viewer's ledger access changes, which is a
        // different user and therefore a different dashboard.
    }, [canReadSubscriptions]);

    // Asset maintenance counters — read off the asset stats aggregate
    // (maintenanceDue7 = due within 7 days, maintenanceOverdue = past due).
    const maintSummary = { due7: assetStats?.maintenanceDue7 ?? 0, overdue: assetStats?.maintenanceOverdue ?? 0 };

    return (
        <div className="space-y-6">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-ink">Finance Dashboard</h2>

            {failed.length > 0 && (
                <div role="alert" className="rounded-xl border border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 px-4 py-3 text-xs font-bold text-amber-900 dark:text-amber-200">
                    Couldn't load {failed.join(', ')}. Those tiles are showing no data rather than a real figure — reload to try again.
                </div>
            )}

            {/* Upcoming attention — surface time-sensitive things up top so the
                finance head sees them without clicking through to the feature
                pages. Notifications already cover this in the bell, but tiles
                make the picture scannable at a glance. */}
            {(subSummary.due14 > 0 || subSummary.overdue > 0 || maintSummary.due7 > 0 || maintSummary.overdue > 0) && (
                <div>
                    <h3 className="text-base font-bold text-ink mb-3">Needs your attention</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <AttentionTile
                            icon={<Repeat size={18} className="text-amber-700 dark:text-amber-300" />}
                            label="Subscriptions expiring"
                            primary={subSummary.due14}
                            primarySuffix="within 14 days"
                            secondary={subSummary.overdue > 0 ? `${subSummary.overdue} already overdue` : undefined}
                            accent={subSummary.overdue > 0 ? 'red' : 'amber'}
                            onClick={() => navigate('/finance/subscriptions')}
                            cta="Open Subscriptions"
                        />
                        <AttentionTile
                            icon={<Wrench size={18} className="text-amber-700 dark:text-amber-300" />}
                            label="Assets due maintenance"
                            primary={maintSummary.due7}
                            primarySuffix="within 7 days"
                            secondary={maintSummary.overdue > 0 ? `${maintSummary.overdue} already overdue` : undefined}
                            accent={maintSummary.overdue > 0 ? 'red' : 'amber'}
                            // Associate Finance shares this dashboard but cannot
                            // open /finance/*; their Fixed Assets page lives under
                            // their own prefix.
                            onClick={() => navigate(
                                user?.role === 'ASSOCIATE_FINANCE'
                                    ? '/associate-finance/fixed-assets'
                                    : '/finance/fixed-assets',
                            )}
                            cta="Open Fixed Assets"
                        />
                    </div>
                </div>
            )}

            {/* Procurement / spend tiles (existing) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-card rounded-xl shadow-sm border border-line-soft p-6">
                    <p className="text-xs text-muted uppercase font-bold tracking-wider">Awaiting Payment</p>
                    <StatValue loading={loading} value={stats?.awaitingPayment} />
                </div>
                <div className="bg-card rounded-xl shadow-sm border border-line-soft p-6">
                    <p className="text-xs text-muted uppercase font-bold tracking-wider">Total Approved Spend</p>
                    <StatValue
                        loading={loading}
                        value={stats?.totalSpendApproved}
                        format={(n) => `INR ${n.toLocaleString()}`}
                    />
                </div>
                <div className="bg-card rounded-xl shadow-sm border border-line-soft p-6">
                    <p className="text-xs text-muted uppercase font-bold tracking-wider">Total Active Indents</p>
                    <StatValue loading={loading} value={stats?.totalActive} />
                </div>
            </div>

            {/* Depreciation — summary, the on/off switch, manual posting and the
                schedule export. One strip rather than a wall of tiles: the old
                depreciation block was removed from this dashboard at Finance's
                request because it took up space whether or not it was wanted. */}
            <DepreciationPanel canManage={canManageDepreciation} />

            {/* Fixed-asset section — total + tangible/intangible split +
                by-company. Book-value tile + the full Depreciation block
                were removed per Finance request — depreciation still runs
                on the backend cron, but the dashboard surface kept those
                numbers up at all times even when Finance didn't need them.
                Re-add via the Depreciation page when an auditor view is
                needed. */}
            <div>
                <h3 className="text-base font-bold text-ink mb-3 flex items-center gap-2">
                    <Briefcase size={16} className="text-brand" /> Fixed Assets
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <DashTile
                        icon={<Boxes size={18} className="text-brand" />}
                        label="Total assets"
                        value={assetStats?.total ?? '-'}
                        sub={assetStats?.byType
                            ? `${assetStats.byType.tangible} tangible · ${assetStats.byType.intangible} intangible`
                            : undefined}
                    />
                    <DashTile
                        icon={<Briefcase size={18} className="text-violet-600 dark:text-violet-300" />}
                        label="Tangible"
                        value={assetStats?.byType?.tangible ?? '-'}
                        sub="Physical assets"
                        accent="violet"
                    />
                    <DashTile
                        icon={<Cpu size={18} className="text-sky-600 dark:text-sky-300" />}
                        label="Intangible"
                        value={assetStats?.byType?.intangible ?? '-'}
                        sub="Software, IP, licenses"
                        accent="sky"
                    />
                </div>
            </div>

            {/* By-company breakdown — drives the "ours vs partner" view. */}
            {assetStats?.byCompany && assetStats.byCompany.length > 0 && (
                <div className="bg-card rounded-xl shadow-sm border border-line-soft p-5">
                    <h3 className="text-sm font-bold text-ink mb-3 flex items-center gap-2">
                        <Building2 size={16} className="text-brand" /> By company
                    </h3>
                    <div className="space-y-2">
                        {assetStats.byCompany.map((c: any) => (
                            <div key={c.companyId} className="flex items-center justify-between py-1.5 border-b border-line-soft last:border-b-0">
                                <div className="flex items-center gap-2 min-w-0">
                                    <span className="font-bold text-ink truncate">{c.name}</span>
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${
                                        c.isOwn
                                            ? 'bg-emerald-50 dark:bg-emerald-400/15 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-400/30'
                                            : 'bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30'
                                    }`}>
                                        {c.isOwn ? 'OWN' : 'PARTNER'}
                                    </span>
                                </div>
                                <div className="text-right shrink-0">
                                    <p className="text-sm font-bold text-ink">{c.count} assets</p>
                                    {c.currentValue != null && (
                                        <p className="text-[10px] text-faint">{fmtINR(c.currentValue, { compact: true })}</p>
                                    )}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

// Reusable tile — keeps the per-card markup identical across the page.
const ACCENTS: Record<string, string> = {
    default: 'border-line-soft',
    violet: 'border-violet-100 dark:border-violet-400/25 bg-violet-50/30 dark:bg-violet-400/15',
    sky: 'border-sky-100 dark:border-sky-400/25 bg-sky-50/30 dark:bg-sky-400/15',
    emerald: 'border-emerald-100 dark:border-emerald-400/25 bg-emerald-50/30 dark:bg-emerald-400/15',
};

const DashTile = ({ icon, label, value, sub, accent }: { icon: React.ReactNode; label: string; value: any; sub?: string; accent?: string }) => (
    <div className={`bg-card rounded-xl shadow-sm border ${ACCENTS[accent || 'default'] || ACCENTS.default} p-5`}>
        <div className="flex items-center gap-2">
            {icon}
            <p className="text-[10px] text-muted uppercase font-bold tracking-wider">{label}</p>
        </div>
        <p className="text-2xl font-bold text-ink mt-2">{value}</p>
        {sub && <p className="text-[10px] text-muted mt-1">{sub}</p>}
    </div>
);

// Clickable attention tile — drives the finance head to the relevant
// feature page when something needs handling. Red border when there's
// overdue items, amber when only "coming up". Keyboard-friendly via
// button semantics.
const ATTENTION_ACCENTS: Record<string, string> = {
    amber: 'border-amber-200 dark:border-amber-400/30 bg-amber-50/40 dark:bg-amber-400/15 hover:bg-amber-50/70 dark:bg-amber-400/15',
    red: 'border-red-200 dark:border-red-400/30 bg-red-50/40 dark:bg-red-400/15 hover:bg-red-50/70 dark:bg-red-400/15',
};

/**
 * One procurement tile's number. Distinguishes the three states the page used
 * to collapse into a single "-": still loading (skeleton bar), loaded and
 * genuinely zero/absent (an em dash), loaded with a value.
 */
const StatValue = ({
  loading,
  value,
  format,
}: {
  loading: boolean;
  value?: number | null;
  format?: (n: number) => string;
}) => {
  if (loading) {
    return <div className="mt-2 h-9 w-24 animate-pulse rounded bg-hover" aria-hidden="true" />;
  }
  const has = typeof value === 'number';
  return (
    <p className="text-3xl font-bold text-ink mt-2">
      {has ? (format ? format(value as number) : value) : '\u2014'}
    </p>
  );
};

const AttentionTile = ({
    icon, label, primary, primarySuffix, secondary, accent, onClick, cta,
}: {
    icon: React.ReactNode;
    label: string;
    primary: number;
    primarySuffix: string;
    secondary?: string;
    accent: 'amber' | 'red';
    onClick: () => void;
    cta: string;
}) => (
    <button
        onClick={onClick}
        className={`w-full text-left bg-card rounded-xl shadow-sm border ${ATTENTION_ACCENTS[accent]} p-5 transition-colors group`}
    >
        <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                    {icon}
                    <p className="text-[10px] text-muted uppercase font-bold tracking-wider">{label}</p>
                </div>
                <p className="text-2xl font-bold text-ink mt-2">
                    {primary} <span className="text-sm font-normal text-muted">{primarySuffix}</span>
                </p>
                {secondary && <p className="text-[11px] text-red-700 dark:text-red-300 font-bold mt-1">⚠ {secondary}</p>}
                <p className="text-[10px] text-faint mt-2 inline-flex items-center gap-0.5 group-hover:text-brand group-hover:underline">
                    {cta} <ChevronRight size={11} />
                </p>
            </div>
        </div>
    </button>
);
