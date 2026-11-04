// Per-vendor "Mark as Ordered" + ETA revision.
//
// Each vendor order is a separate website checkout placed on its own clock, so
// ordering is PER VENDOR — every paid vendor gets its own card with its own
// expected delivery date + carrier/tracking notes (mirrors the per-vendor
// payment + refund flows). The card self-determines its action from the vendor
// order's status:
//   PAID                → "Mark ordered" (transitions that order to ORDERED)
//   ORDERED / IN_TRANSIT → "Update ETA"  (pure date revision)
//   AWAITING_PAYMENT     → read-only ("pay before ordering")
//   RECEIVED / CANCELLED → read-only (terminal)
// Each card POSTs to PATCH /indents/:id/vendor-orders/:orderId/ordering and the
// modal re-fetches the indent so the cards refresh in place. The indent rolls
// up to ORDERED on the backend once every vendor order is ordered.
//
// Legacy indents with NO vendor orders fall back to the original indent-level
// form, which submits via the `onSubmit` prop (PATCH /indents/:id/status for
// mark_ordered, or PATCH /indents/:id/eta for update_eta).

import { useEffect, useMemo, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { fmtDate, fmtDateTime } from '@/utils/date';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { useAbortOnUnmount } from '@/hooks';

export type OrderedOutcome =
  | { kind: 'MARK_ORDERED'; expectedDeliveryDate: string; expectedDeliveryHasTime: boolean; notes?: string }
  | { kind: 'UPDATE_ETA';   expectedDeliveryDate: string; expectedDeliveryHasTime: boolean; notes?: string };

interface Props {
  isOpen: boolean;
  onClose: () => void;
  row: any | null;
  mode: 'mark_ordered' | 'update_eta';
  submitting?: boolean;                         // legacy (indent-level) submit in-flight
  onSubmit: (outcome: OrderedOutcome) => void | Promise<void>;
  // Called after any successful per-vendor update so the parent re-fetches its
  // list. The modal also re-fetches the single indent internally to refresh
  // the cards, so this is purely to keep the surrounding table in sync.
  onUpdated?: () => void | Promise<void>;
}

// Per-vendor status chrome — mirrors the BOM table + backend enum.
const VO_STATUS_META: Record<string, { label: string; cls: string }> = {
  AWAITING_PAYMENT: { label: 'Awaiting payment', cls: 'bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-400/30' },
  PAID:             { label: 'Paid',             cls: 'bg-blue-100 dark:bg-blue-400/20 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-400/30' },
  ORDERED:          { label: 'Ordered',          cls: 'bg-indigo-100 dark:bg-indigo-400/20 text-indigo-800 dark:text-indigo-200 border-indigo-200 dark:border-indigo-400/30' },
  IN_TRANSIT:       { label: 'In transit',       cls: 'bg-purple-100 dark:bg-purple-400/20 text-purple-800 dark:text-purple-200 border-purple-200 dark:border-purple-400/30' },
  RECEIVED:         { label: 'Received',         cls: 'bg-green-100 dark:bg-green-400/20 text-green-800 dark:text-green-200 border-green-200 dark:border-green-400/30' },
  CANCELLED:        { label: 'Cancelled',        cls: 'bg-red-100 dark:bg-red-400/20 text-red-800 dark:text-red-200 border-red-200 dark:border-red-400/30' },
};

// Build an ISO datetime from a date string + optional canonical "HH:MM".
// Without a time: send the date at noon local — dodges both the midnight-UTC →
// +5:30 IST display drift AND the "rolls back a day" trap in negative offsets.
function buildIso(date: string, time: string, includeTime: boolean): string {
  return includeTime && time
    ? new Date(`${date}T${time}:00`).toISOString()
    : new Date(`${date}T12:00:00`).toISOString();
}

const startOfTodayMs = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

// ---------------------------------------------------------------------------
// Trendy hour / minute / AM-PM trio. Native <input type="time"> dropped — it
// renders a slot-machine scroll picker on Chrome. Shared by every card + the
// legacy form.
// ---------------------------------------------------------------------------
function TimePicker({ time, setTime }: { time: string; setTime: (t: string) => void }) {
  const [hStr, mStr] = (time || '00:00').split(':');
  const h24 = parseInt(hStr || '0', 10);
  const meridiem: 'AM' | 'PM' = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  const minute = parseInt(mStr || '0', 10);

  const set12 = (h: number, m: number, p: 'AM' | 'PM') => {


    const hClamped = Math.max(1, Math.min(12, h));
    const mClamped = Math.max(0, Math.min(59, m));
    const h24New = p === 'AM' ? (hClamped === 12 ? 0 : hClamped) : (hClamped === 12 ? 12 : hClamped + 12);
    setTime(`${String(h24New).padStart(2, '0')}:${String(mClamped).padStart(2, '0')}`);
  };

  return (
    <div className="mt-2 flex items-center gap-2">
      <svg className="w-4 h-4 text-faint shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
      <div className="flex items-center border border-line rounded focus-within:border-brand bg-card">
        <input type="number" min={1} max={12} value={String(h12)}
          onChange={(e) => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) set12(v, minute, meridiem); }}
          className="w-12 text-center py-1.5 text-base font-mono outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
        <div className="flex flex-col border-l border-line-soft">
          <button type="button" onClick={() => set12((h12 % 12) + 1, minute, meridiem)} className="px-1.5 hover:bg-surface text-muted hover:text-ink" aria-label="Hour up">▲</button>
          <button type="button" onClick={() => set12(h12 === 1 ? 12 : h12 - 1, minute, meridiem)} className="px-1.5 hover:bg-surface text-muted hover:text-ink border-t border-line-soft" aria-label="Hour down">▼</button>
        </div>
      </div>
      <span className="text-faint font-bold">:</span>
      <div className="flex items-center border border-line rounded focus-within:border-brand bg-card">
        <input type="number" min={0} max={59} value={String(minute).padStart(2, '0')}
          onChange={(e) => { const v = parseInt(e.target.value, 10); if (Number.isFinite(v)) set12(h12, v, meridiem); }}
          className="w-12 text-center py-1.5 text-base font-mono outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" />
        <div className="flex flex-col border-l border-line-soft">
          <button type="button" onClick={() => set12(h12, (minute + 5) % 60, meridiem)} className="px-1.5 hover:bg-surface text-muted hover:text-ink" aria-label="Minute up +5">▲</button>
          <button type="button" onClick={() => set12(h12, minute === 0 ? 55 : minute - 5, meridiem)} className="px-1.5 hover:bg-surface text-muted hover:text-ink border-t border-line-soft" aria-label="Minute down -5">▼</button>
        </div>
      </div>
      <div className="flex border border-line rounded overflow-hidden">
        {(['AM', 'PM'] as const).map((p) => (
          <button key={p} type="button" onClick={() => set12(h12, minute, p)}
            className={`px-2.5 py-1.5 text-[11px] font-bold transition-colors ${meridiem === p ? 'bg-brand text-white' : 'bg-card text-faint hover:bg-surface'}`}>
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One vendor order — fully self-contained (own state, own PATCH, own toast).
// ---------------------------------------------------------------------------
function VendorOrderCard({ indentId, vo, allocations, itemMap, onDone }: { indentId: string; vo: any; allocations: any[]; itemMap: Record<string, any>; onDone: () => void | Promise<void> }) {
  const { addToast } = useToast();
  const cur = (vo.currency || 'INR').toUpperCase();
  const status = String(vo.status || 'AWAITING_PAYMENT');
  const meta = VO_STATUS_META[status] || { label: status, cls: 'bg-hover text-secondary border-line' };
  const orderAmount = Number(vo.amount ?? 0);

  // What can this card do?
  const canPlace = status === 'PAID';                                   // PAID → ORDERED
  const canRevise = status === 'ORDERED' || status === 'IN_TRANSIT';    // pure ETA revision
  const interactive = canPlace || canRevise;

  // Defaults: placing → today + 7; revising → the order's existing ETA.
  const plusWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const existingDate = vo.expectedDeliveryDate ? new Date(vo.expectedDeliveryDate).toISOString().slice(0, 10) : '';
  const existingTime = vo.expectedDeliveryDate && vo.expectedDeliveryHasTime
    ? new Date(vo.expectedDeliveryDate).toTimeString().slice(0, 5) : '';


  const [date, setDate] = useState<string>(existingDate || (canPlace ? plusWeek : ''));
  const [includeTime, setIncludeTime] = useState<boolean>(!!vo.expectedDeliveryHasTime);
  const [time, setTime] = useState<string>(existingTime || '');
  const [notes, setNotes] = useState<string>('');
  const [busy, setBusy] = useState(false);

  // This order's line items — for "order some now, rest later". Allocations
  // carry no `unit`, so fall back to the indent item's. Only a PAID card with
  // >1 line exposes checkboxes; a single-line or ETA-revision card has nothing
  // meaningful to pick (and the backend only honors a subset on PAID→ORDERED).
  const lines = useMemo(
    () => (allocations || [])
      .filter((a: any) => a.vendorOrderId === vo.id)
      .map((a: any) => ({
        id: a.id as string,
        name: itemMap[a.indentItemId]?.name || '(item removed)',
        unit: a.unit || itemMap[a.indentItemId]?.unit || '',
        qty: Number(a.allocatedQty || 0),
        unitPrice: Number(a.unitPrice || 0),
        currency: (a.currency || vo.currency || 'INR').toUpperCase(),
      })),
    [allocations, itemMap, vo.id, vo.currency],
  );
  const lineIds = lines.map((l) => l.id);
  const lineKey = lineIds.join(',');
  // Default = all selected, so an untouched card sends NO allocationIds →
  // today's whole-order placement, byte-for-byte.
  const [selectedLineIds, setSelectedLineIds] = useState<Set<string>>(new Set(lineIds));
  useEffect(() => { setSelectedLineIds(new Set(lineKey ? lineKey.split(',') : [])); }, [lineKey]);

  const selectable = canPlace && lineIds.length > 1;
  const isSel = (id: string) => selectedLineIds.has(id);
  const selCount = lineIds.filter((id) => selectedLineIds.has(id)).length;
  const allSel = lineIds.length > 0 && selCount === lineIds.length;
  const noneSel = selCount === 0;
  const selAmount = lines.reduce((s, l) => s + (isSel(l.id) ? l.qty * l.unitPrice : 0), 0);
  const toggleLine = (id: string) => setSelectedLineIds((prev) => { const c = new Set(prev); c.has(id) ? c.delete(id) : c.add(id); return c; });
  const setAllLines = (on: boolean) => setSelectedLineIds(on ? new Set(lineIds) : new Set<string>());

  // Re-seed when the order's status / ETA changes underneath us (after a
  // successful update + the parent re-fetches a fresh `vo`).
  useEffect(() => {
    setDate(existingDate || (status === 'PAID' ? plusWeek : ''));
    setIncludeTime(!!vo.expectedDeliveryHasTime);
    setTime(existingTime || '');
    setNotes('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vo.id, vo.status, vo.expectedDeliveryDate]);

  const valid = useMemo(() => {
    if (!date) return false;
    if (new Date(date).getTime() < startOfTodayMs()) return false;
    if (includeTime && !time) return false;
    return true;
  }, [date, includeTime, time]);

  const submit = async () => {
    if (!valid || busy) return;
    if (selectable && noneSel) { addToast('Select at least one item to order', 'error'); return; }
    // Strict subset of a PAID order → send the ticked ids; the backend peels
    // them into a sibling order and places just those, leaving the rest PAID.
    // Whole/none selected → omit allocationIds = today's whole-order placement.
    const isSubset = canPlace && lineIds.length > 0 && selCount < lineIds.length;
    setBusy(true);
    try {
      const body: any = {
        expectedDeliveryDate: buildIso(date, time, includeTime),
        expectedDeliveryHasTime: includeTime,
        trackingNotes: notes.trim() || undefined,
      };
      if (isSubset) body.allocationIds = lineIds.filter((id) => selectedLineIds.has(id));
      await client.patch(`/indents/${indentId}/vendor-orders/${vo.id}/ordering`, body);
      addToast(`${vo.vendorName}: ${canPlace ? (isSubset ? `${selCount} item(s) ordered` : 'order placed') : 'ETA updated'}`, 'success');
      await onDone();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to update'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-line bg-card p-3 space-y-2">
      {/* Header — vendor, amount, current status */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-bold text-[13px] text-ink">{vo.vendorName}</p>
          <p className="text-[11px] text-muted">
            {cur} {orderAmount.toLocaleString()}
            {vo.paymentTransactionId && <> · txn <span className="font-mono">{vo.paymentTransactionId}</span></>}
          </p>
        </div>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${meta.cls}`}>
          {meta.label}
        </span>
      </div>

      {/* Current ETA / arrival readout */}
      {(vo.expectedDeliveryDate || vo.actualDeliveryDate) && (
        <div className="text-[11px] text-muted space-y-0.5">
          {vo.actualDeliveryDate ? (
            <p><span className="text-faint">Arrived:</span> {fmtDate(vo.actualDeliveryDate)}</p>
          ) : vo.expectedDeliveryDate && (
            <p>
              <span className="text-faint">Current ETA:</span>{' '}
              {vo.expectedDeliveryHasTime ? fmtDateTime(vo.expectedDeliveryDate) : fmtDate(vo.expectedDeliveryDate)}
            </p>
          )}
          {vo.trackingNotes && <p className="italic text-faint">{vo.trackingNotes}</p>}
        </div>
      )}

      {/* Line items — read-only context for every order; checkboxes to pick
          which to place when a PAID order has more than one line. */}
      {interactive && lines.length > 0 && (
        <div className="border-t border-line-soft pt-2">
          {selectable && (
            <div className="flex items-center justify-between gap-2 mb-1">
              <label className="flex items-center gap-1.5 text-[10px] font-bold text-muted uppercase cursor-pointer select-none">
                <input type="checkbox" checked={allSel} ref={(el) => { if (el) el.indeterminate = !allSel && !noneSel; }}
                  onChange={(e) => setAllLines(e.target.checked)} className="accent-brand cursor-pointer" />
                Select items to order
              </label>
              <span className="text-[10px] text-faint">{selCount} of {lineIds.length} · rest stay paid</span>
            </div>
          )}
          <ul className="space-y-0.5">
            {lines.map((ln) => {
              const checked = !selectable || isSel(ln.id);
              return (
                <li key={ln.id} className={`text-[10px] flex items-baseline gap-2 ${selectable && !checked ? 'opacity-40' : 'text-muted'}`}>
                  {selectable && (
                    <input type="checkbox" checked={isSel(ln.id)} onChange={() => toggleLine(ln.id)} className="accent-brand cursor-pointer mt-0.5" />
                  )}
                  <span className="truncate flex-1">{ln.name}</span>
                  <span className="font-mono whitespace-nowrap">{ln.qty} {ln.unit} × {ln.currency} {ln.unitPrice.toLocaleString('en-IN')}</span>
                </li>
              );
            })}
          </ul>
          {selectable && !allSel && (
            <p className="text-[10px] text-muted font-bold mt-1 text-right">
              Ordering {cur} {selAmount.toLocaleString('en-IN')} · {lineIds.length - selCount} item(s) stay paid
            </p>
          )}
        </div>
      )}

      {!interactive ? (
        <p className="text-[11px] italic text-faint border-t border-line-soft pt-2">
          {status === 'AWAITING_PAYMENT' && 'Pay this vendor before placing the order.'}
          {status === 'RECEIVED' && 'Delivered — nothing more to do here.'}
          {status === 'CANCELLED' && 'This order was cancelled.'}
        </p>
      ) : (
        <div className={`space-y-2 pt-2 ${lines.length > 0 ? '' : 'border-t border-line-soft'}`}>
          <div>
            <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">
              Expected delivery date <span className="text-red-700 dark:text-red-300">*</span>
            </label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              min={new Date().toISOString().slice(0, 10)}
              className="w-full border border-line rounded px-2 py-1.5 text-sm outline-none focus:border-brand" />
            {date && new Date(date).getTime() < startOfTodayMs() && (
              <p className="text-[10px] text-red-700 dark:text-red-300 italic mt-1">Date cannot be in the past.</p>
            )}

            <label className="flex items-center gap-2 mt-2 cursor-pointer">
              <input type="checkbox" checked={includeTime} onChange={(e) => setIncludeTime(e.target.checked)} className="rounded border-line" />
              <span className="text-[11px] text-muted">Vendor gave a specific time of day (optional)</span>
            </label>
            {includeTime && <TimePicker time={time} setTime={setTime} />}
          </div>

          <div>
            <label className="block text-[10px] font-bold text-faint uppercase mb-0.5">
              Tracking notes <span className="text-faint font-normal normal-case">— optional: carrier, AWB, vendor note</span>
            </label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              placeholder={canPlace ? 'e.g. DTDC, AWB 9876543210; shipped Mon' : 'e.g. Vendor delayed — new ETA per their email'}
              className="w-full bg-card border border-line rounded px-2 py-1.5 text-sm outline-none focus:border-brand resize-none" />
          </div>

          <div className="flex justify-end">
            <button onClick={submit} disabled={!valid || busy || (selectable && noneSel)}
              className="px-3 py-1.5 text-[11px] font-bold text-white bg-brand hover:bg-brand-dark rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {busy ? 'Saving…' : canPlace ? (selectable && !allSel ? `Mark ${selCount} ordered` : 'Mark ordered') : 'Update ETA'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function OrderedConfirmModal({ isOpen, onClose, row, mode, submitting = false, onSubmit, onUpdated }: Props) {
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();
  // Internal live copy so per-vendor updates refresh the cards without the
  // parent having to push a new `row` snapshot.
  const [liveRow, setLiveRow] = useState<any | null>(row);
  useEffect(() => { setLiveRow(row); }, [row]);

  // On open, pull fresh detail so each card's lines + vendor-order statuses
  // reflect server truth — a list row can be a beat stale after another
  // surface (Finance) paid / split an order. Self-heals the line list before
  // anyone clicks. Harmless for the legacy (no-vendor-orders) path.
  useEffect(() => {
    if (!isOpen || !row?.id) return;
    let alive = true;
    client.get(`/indents/${row.id}`, { signal: abortSignal() })
      .then((res) => { if (alive) setLiveRow(res.data?.data ?? res.data); })
      .catch(() => { /* keep the passed row; refresh() after any action still corrects it */ });
    return () => { alive = false; };
  }, [isOpen, row?.id]);

  const r = liveRow || row;
  const vendorOrders: any[] = r?.vendorOrders || [];
  const perVendor = vendorOrders.length > 0;
  // Sort so the actionable ones (paid / ordered / in-transit) float to the top.
  const ORDER_RANK: Record<string, number> = { PAID: 0, ORDERED: 1, IN_TRANSIT: 2, AWAITING_PAYMENT: 3, RECEIVED: 4, CANCELLED: 5 };
  const sortedOrders = [...vendorOrders].sort((a, b) => (ORDER_RANK[a.status] ?? 9) - (ORDER_RANK[b.status] ?? 9));
  const anyActionable = vendorOrders.some((vo) => ['PAID', 'ORDERED', 'IN_TRANSIT'].includes(vo.status));
  // Line items + an id→item lookup, so each card can list (and let you pick)
  // its own allocations. Both ride on the indent detail payload.
  const allocations: any[] = Array.isArray(r?.vendorAllocations) ? r.vendorAllocations : [];
  const itemMap = useMemo(() => {
    const m: Record<string, any> = {};
    for (const it of (r?.items || [])) m[it.id] = it;
    return m;
  }, [r]);

  const refresh = async () => {
    if (r?.id) {
      try {
        const res = await client.get(`/indents/${r.id}`, { signal: abortSignal() });
        setLiveRow(res.data?.data ?? res.data);
      } catch { /* keep current copy; the list re-fetch below still runs */ }
    }
    await onUpdated?.();
  };

  // --- Legacy (indent-level) state — only rendered when !perVendor, but the
  // hooks must run unconditionally (rules of hooks). ---
  const today = new Date();
  const defaultPlusWeek = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const existingDate = r?.expectedDeliveryDate ? new Date(r.expectedDeliveryDate).toISOString().slice(0, 10) : '';
  const existingTime = r?.expectedDeliveryDate && r.expectedDeliveryHasTime
    ? new Date(r.expectedDeliveryDate).toTimeString().slice(0, 5) : '';

  const [date, setDate] = useState<string>('');
  const [time, setTime] = useState<string>('');
  const [includeTime, setIncludeTime] = useState<boolean>(false);
  const [notes, setNotes] = useState<string>('');

  useEffect(() => {
    if (!isOpen) return;
    setDate(existingDate || (mode === 'mark_ordered' ? defaultPlusWeek : ''));
    setIncludeTime(!!r?.expectedDeliveryHasTime);
    setTime(existingTime || '');
    setNotes('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, r?.id, mode, existingDate, existingTime, r?.expectedDeliveryHasTime]);

  const legacyValid = useMemo(() => {
    if (!date) return false;
    if (new Date(date).getTime() < startOfTodayMs()) return false;
    if (includeTime && !time) return false;
    return true;
  }, [date, includeTime, time]);

  const handleLegacySubmit = async () => {
    if (!legacyValid || submitting) return;
    const isoDate = buildIso(date, time, includeTime);
    const outcome: OrderedOutcome = mode === 'mark_ordered'
      ? { kind: 'MARK_ORDERED', expectedDeliveryDate: isoDate, expectedDeliveryHasTime: includeTime, notes: notes.trim() || undefined }
      : { kind: 'UPDATE_ETA',   expectedDeliveryDate: isoDate, expectedDeliveryHasTime: includeTime, notes: notes.trim() || undefined };
    await onSubmit(outcome);
  };

  if (!row) return null;

  const title = mode === 'mark_ordered'
    ? `Mark ${r?.serialNo || 'indent'} as Ordered`
    : `Update delivery ETA — ${r?.serialNo || 'indent'}`;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      {perVendor ? (
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border border-sky-200 dark:border-sky-400/30 bg-sky-50/60 dark:bg-sky-400/15 px-3 py-2">
            <p className="text-[12px] text-sky-900 dark:text-sky-200">
              Each vendor was a separate checkout, so place + track each order on its own clock.
              {' '}<span className="font-bold">Mark each as ordered with its own ETA.</span> The requester sees the
              latest (slowest) date on their dashboard.
            </p>
          </div>
          {!anyActionable && (
            <p className="text-[12px] italic text-faint">
              No vendor orders are ready to order yet — they need to be paid first.
            </p>
          )}
          <div className="space-y-2.5 max-h-[60vh] overflow-y-auto pr-0.5">
            {sortedOrders.map((vo) => (
              <VendorOrderCard key={vo.id} indentId={r.id} vo={vo} allocations={allocations} itemMap={itemMap} onDone={refresh} />
            ))}
          </div>
          <div className="flex justify-end pt-2 border-t border-line-soft">
            <button onClick={onClose}
              className="px-3 py-1.5 text-xs font-bold text-muted hover:bg-hover rounded transition-colors">
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="rounded-lg border border-sky-200 dark:border-sky-400/30 bg-sky-50/60 dark:bg-sky-400/15 px-3 py-2">
            <p className="text-[12px] text-sky-900 dark:text-sky-200">
              {mode === 'mark_ordered'
                ? <>You've placed the order with the vendor. <span className="font-bold">When are they delivering it?</span> The requester sees this date on their dashboard so they can plan their work.</>
                : <>Vendor pushed the date around? Update the ETA so the requester sees the latest expected delivery.</>}
            </p>
            {mode === 'update_eta' && r.expectedDeliveryDate && (
              <p className="text-[11px] text-sky-900 dark:text-sky-200 mt-1">
                <span className="font-bold">Current ETA:</span> {r.expectedDeliveryHasTime ? fmtDateTime(r.expectedDeliveryDate) : fmtDate(r.expectedDeliveryDate)}
              </p>
            )}
          </div>

          <div>
            <label className="block text-xs font-bold text-muted mb-1">
              Expected delivery date <span className="text-red-700 dark:text-red-300">*</span>
            </label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              min={new Date().toISOString().slice(0, 10)}
              className="w-full border border-line rounded px-2 py-1.5 text-sm outline-none focus:border-brand" />
            {date && new Date(date).getTime() < startOfTodayMs() && (
              <p className="text-[11px] text-red-700 dark:text-red-300 italic mt-1">Date cannot be in the past.</p>
            )}

            <label className="flex items-center gap-2 mt-2 cursor-pointer">
              <input type="checkbox" checked={includeTime} onChange={(e) => setIncludeTime(e.target.checked)} className="rounded border-line" />
              <span className="text-[11px] text-muted">Vendor gave a specific time of day (optional)</span>
            </label>
            {includeTime && <TimePicker time={time} setTime={setTime} />}
          </div>

          <div>
            <label className="block text-xs font-bold text-muted mb-1">
              Notes <span className="text-faint font-normal">— optional, e.g. carrier name, tracking ref, vendor's note</span>
            </label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder={mode === 'mark_ordered'
                ? 'e.g. DTDC, AWB 9876543210; vendor confirmed shipment Mon'
                : 'e.g. Vendor delayed due to GST recheck; new ETA per their email'}
              rows={3}
              className="w-full bg-card border border-line rounded px-3 py-2 text-sm outline-none focus:border-brand resize-none" />
            <p className="text-[10px] text-faint mt-1">
              Travels with the notification to the requester + appears in the indent timeline.
            </p>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
            <button onClick={onClose} disabled={submitting}
              className="px-3 py-1.5 text-xs font-bold text-muted hover:bg-hover rounded transition-colors disabled:opacity-50">
              Cancel
            </button>
            <button onClick={handleLegacySubmit} disabled={!legacyValid || submitting}
              className="px-4 py-1.5 text-xs font-bold text-white bg-brand hover:bg-brand-dark rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
              {submitting ? 'Saving…' : mode === 'mark_ordered' ? 'Mark as Ordered' : 'Update ETA'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
