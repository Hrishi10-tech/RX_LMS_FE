import { useEffect, useState } from 'react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { useAbortOnUnmount } from '@/hooks';
import { RejectionReasonModal } from '@/components/ui';

/**
 * A deactivated person's open work, offered to this person to carry on
 * (responsible person → manager → admin, server-side). The first to take an
 * item becomes its owner; the previous owner stays on it as responsible.
 * Renders nothing when there is nothing on offer.
 */
type Offer = { kind: 'INDENT' | 'REQUEST' | 'BOM'; id: string; serialNo: string; label: string; status: string; ownerName: string; ownerId: string; canAssign?: boolean; canCancel?: boolean };
type Person = { id: string; name: string; role: string; department?: { name: string } | null };

const KIND_LABEL: Record<Offer['kind'], string> = { INDENT: 'Indent', REQUEST: 'Request', BOM: 'BOM' };

export const TakeoverOffers = () => {
  const abortSignal = useAbortOnUnmount();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Procurement / Inventory may hand an item nobody took to anyone active.
  const [people, setPeople] = useState<Person[]>([]);
  const [handTo, setHandTo] = useState<Record<string, string>>({});
  // Only offered while nothing has moved (no payment, nothing issued).
  const [cancelling, setCancelling] = useState<Offer | null>(null);
  const { addToast } = useToast();

  const load = () =>
    client.get('/takeovers/mine', { signal: abortSignal() })
      .then((res) => setOffers((res.data?.data ?? res.data)?.items ?? []))
      .catch(() => setOffers([]));

  // eslint-disable-next-line react-hooks/exhaustive-deps -- load once on mount
  useEffect(() => { load(); }, []);

  const anyAssignable = offers.some((o) => o.canAssign);
  useEffect(() => {
    if (!anyAssignable || people.length) return;
    client.get('/users/directory', { signal: abortSignal() })
      .then((res) => {
        const rows: Person[] = (res.data?.data ?? res.data) ?? [];
        setPeople([...rows].sort((a, b) => a.name.localeCompare(b.name)));
      })
      .catch(() => setPeople([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the first assignable offer shows up
  }, [anyAssignable]);

  const handOver = async (o: Offer) => {
    const userId = handTo[o.id];
    const who = people.find((p) => p.id === userId);
    if (!who) return;
    setBusyId(o.id);
    try {
      await client.post(`/takeovers/${o.kind.toLowerCase()}/${o.id}/assign`, { userId });
      addToast(`${o.serialNo} handed to ${who.name}`, 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not hand it over'), 'error');
    } finally {
      setBusyId(null);
      load();
    }
  };

  const take = async (o: Offer) => {
    setBusyId(o.id);
    try {
      await client.post(`/takeovers/${o.kind.toLowerCase()}/${o.id}`);
      addToast(`${o.serialNo} is now yours`, 'success');
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not take it over'), 'error');
    } finally {
      setBusyId(null);
      load();
    }
  };

  const cancel = async (reason: string) => {
    const o = cancelling;
    if (!o) return;
    setBusyId(o.id);
    try {
      await client.post(`/takeovers/${o.kind.toLowerCase()}/${o.id}/cancel`, { reason });
      addToast(`${o.serialNo} cancelled`, 'success');
      setCancelling(null);
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not cancel it'), 'error');
    } finally {
      setBusyId(null);
      load();
    }
  };

  if (!offers.length) return null;
  return (
    <div className="bg-card rounded-lg border border-amber-200 dark:border-amber-400/30 shadow-sm">
      <div className="px-4 py-3 border-b border-line-soft">
        <h3 className="text-sm font-bold text-ink">Waiting for someone to take over ({offers.length})</h3>
        <p className="text-xs text-muted mt-0.5">
          The person who raised these was deactivated. Take one over and it becomes yours to carry on; they stay on it as responsible.
          {anyAssignable && ' Ones nobody else could take, you can also hand to anyone active, or cancel if nothing has moved yet.'}
        </p>
      </div>
      <ul className="divide-y divide-line-soft">
        {offers.map((o) => (
          <li key={o.id} className="px-4 py-2.5 flex flex-wrap sm:flex-nowrap items-center gap-2 sm:gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink truncate">
                <span className="font-bold">{o.serialNo}</span> · {o.label}
              </p>
              <p className="text-[11px] text-muted">
                {KIND_LABEL[o.kind]} raised by {o.ownerName} · {o.status.replace(/_/g, ' ').toLowerCase()}
              </p>
            </div>
            {o.canAssign && (
              <div className="flex items-center gap-2 shrink-0">
                <select
                  aria-label={`Hand ${o.serialNo} to`}
                  value={handTo[o.id] ?? ''}
                  onChange={(e) => setHandTo((m) => ({ ...m, [o.id]: e.target.value }))}
                  disabled={busyId === o.id}
                  className="h-8 max-w-[11rem] rounded-md border border-line bg-card px-2 text-xs text-ink"
                >
                  <option value="">Hand to…</option>
                  {people.filter((p) => p.id !== o.ownerId).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}{p.department?.name ? ` · ${p.department.name}` : ''}</option>
                  ))}
                </select>
                <button
                  onClick={() => handOver(o)}
                  disabled={busyId === o.id || !handTo[o.id]}
                  className="h-8 px-3 text-xs font-bold rounded-md border border-brand text-brand hover:bg-brand/10 disabled:opacity-50"
                >
                  Hand over
                </button>
              </div>
            )}
            {o.canCancel && (
              <button
                onClick={() => setCancelling(o)}
                disabled={busyId === o.id}
                className="shrink-0 h-8 px-3 text-xs font-bold rounded-md border border-red-300 text-red-600 hover:bg-red-50 dark:border-red-400/40 dark:text-red-300 dark:hover:bg-red-400/10 disabled:opacity-50"
              >
                Cancel it
              </button>
            )}
            <button
              onClick={() => take(o)}
              disabled={busyId === o.id}
              className="shrink-0 h-8 bg-brand text-white hover:bg-brand-dark px-3 text-xs font-bold rounded-md disabled:opacity-50"
            >
              {busyId === o.id ? 'Working…' : 'Take it over'}
            </button>
          </li>
        ))}
      </ul>
      <RejectionReasonModal
        isOpen={!!cancelling}
        onClose={() => setCancelling(null)}
        onSubmit={cancel}
        entityLabel={cancelling ? `${KIND_LABEL[cancelling.kind]} ${cancelling.serialNo}` : ''}
        audienceLabel="anyone who opens it later"
        submitting={!!cancelling && busyId === cancelling.id}
      />
    </div>
  );
};
