import { useMemo, useState } from 'react';

// Per-vendor lifecycle status — mirrors the backend VendorOrderStatus enum.
// Each row (one vendor = one website checkout) advances on its own clock.
const STATUS_META: Record<string, { label: string; cls: string }> = {
  AWAITING_PAYMENT: { label: 'Awaiting payment', cls: 'bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-400/30' },
  PAID:             { label: 'Paid',             cls: 'bg-blue-100 dark:bg-blue-400/20 text-blue-800 dark:text-blue-200 border-blue-200 dark:border-blue-400/30' },
  ORDERED:          { label: 'Ordered',          cls: 'bg-indigo-100 dark:bg-indigo-400/20 text-indigo-800 dark:text-indigo-200 border-indigo-200 dark:border-indigo-400/30' },
  IN_TRANSIT:       { label: 'In transit',       cls: 'bg-purple-100 dark:bg-purple-400/20 text-purple-800 dark:text-purple-200 border-purple-200 dark:border-purple-400/30' },
  RECEIVED:         { label: 'Received',         cls: 'bg-green-100 dark:bg-green-400/20 text-green-800 dark:text-green-200 border-green-200 dark:border-green-400/30' },
  CANCELLED:        { label: 'Cancelled',        cls: 'bg-red-100 dark:bg-red-400/20 text-red-800 dark:text-red-200 border-red-200 dark:border-red-400/30' },
};

// Allowed MONEY/placement moves from each status (mirror of the backend
// transition map) — drives the per-row dropdown. The physical shipment leg
// (IN_TRANSIT → RECEIVED) is NOT here: those are derived from the per-line
// shipment tracker now, so the dropdown can never drift out of sync. From
// ORDERED / IN_TRANSIT the only manual move is CANCELLED.
// Placement + cancellation only. PAID is NOT offered here: payment is recorded
// exclusively via Finance → Mark paid, which captures the transaction id +
// receipt and runs the approval gates. A bare status flip to PAID from this
// dropdown bypassed all of that (and the backend now rejects it), so an
// AWAITING_PAYMENT order can only be cancelled from here — it's paid in Finance.
const NEXT: Record<string, string[]> = {
  AWAITING_PAYMENT: ['CANCELLED'],
  PAID:             ['ORDERED', 'CANCELLED', 'AWAITING_PAYMENT'],
  ORDERED:          ['CANCELLED'],
  IN_TRANSIT:       ['CANCELLED'],
  RECEIVED:         [],
  CANCELLED:        [],
};

// Orders whose shipment is in progress — show the per-line "Track shipment"
// entry so procurement marks In transit / Customs / Reached on each line (this
// is where the old IN_TRANSIT/RECEIVED dropdown moves went).
const SHIPMENT_TRACKABLE = ['ORDERED', 'IN_TRANSIT'];

const StatusBadge = ({ status }: { status: string }) => {
  const m = STATUS_META[status] || { label: status, cls: 'bg-hover text-secondary border-line' };
  return <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-bold border ${m.cls}`}>{m.label}</span>;
};

interface VendorRow {
  key: string;
  vendorName: string;
  vendorContact: string | null;
  currency: string;
  amount: number;
  items: { name: string; qty: number; unit: string }[];
  order: any | null; // matched VendorOrder, when one has been materialised
}

interface BomVendorOrdersTableProps {
  allocations: any[];
  indentItems: any[];
  vendorOrders: any[];
  /** True for roles allowed to advance a vendor order's status (PROCUREMENT /
   *  FINANCE / SUPER_ADMIN). Others see read-only badges. */
  canUpdateStatus?: boolean;
  /** Patch a single vendor order's status. Resolves after the server confirms
   *  + the modal has been refreshed. */
  onUpdateStatus?: (orderId: string, status: string) => Promise<void>;
  /** Placing an order must capture an ETA + tracking notes, so the PAID→ORDERED
   *  hop is routed here (opens the per-vendor "Mark ordered" modal) instead of
   *  a bare status flip. Falls back to onUpdateStatus when not provided. */
  onMarkOrdered?: (orderId: string) => void;
  /** Open the per-line shipment tracker (In transit / Customs / Reached + ETA).
   *  Shown on ORDERED / IN_TRANSIT rows — that's where the retired manual
   *  IN_TRANSIT/RECEIVED dropdown moves now live. */
  onTrackShipment?: () => void;
}

/**
 * The BOM slip as a clean table — one row per vendor order (a separate website
 * checkout). Each row lists the items that vendor supplies, its order amount,
 * payment method, and a per-row Status that's updated independently of the
 * others. Before send-to-finance no VendorOrder exists yet, so the row shows a
 * read-only "Quoting" state; once handed to Finance the Status becomes an
 * editable dropdown.
 */
export const BomVendorOrdersTable = ({
  allocations,
  indentItems,
  vendorOrders,
  canUpdateStatus = false,
  onUpdateStatus,
  onMarkOrdered,
  onTrackShipment,
}: BomVendorOrdersTableProps) => {
  const [savingId, setSavingId] = useState<string | null>(null);

  const rows = useMemo<VendorRow[]>(() => {
    const itemsById: Record<string, any> = {};
    for (const it of indentItems || []) itemsById[it.id] = it;

    // A vendor can have MORE THAN ONE order once a subset of its lines is split
    // off (pay / order some now, the rest later), so match each allocation to
    // its OWN order by id — never collapse a vendor into one row. Lines not yet
    // handed to Finance (vendorOrderId = null) group by vendor + currency as the
    // read-only "Quoting" row.
    const orderById = new Map<string, any>();
    for (const o of vendorOrders || []) orderById.set(o.id, o);

    type Grp = Omit<VendorRow, 'items'> & { _items: Map<string, { name: string; qty: number; unit: string }> };
    const groups = new Map<string, Grp>();
    for (const a of allocations || []) {
      const allocCurrency = (a.currency || 'INR').toUpperCase();
      const ord = a.vendorOrderId ? orderById.get(a.vendorOrderId) ?? null : null;
      // Materialised lines → one group per ORDER (so split siblings stay
      // distinct even for the same vendor). Un-sent lines → per vendor+currency.
      const key = a.vendorOrderId ? `ord:${a.vendorOrderId}` : `qt:${a.vendorName}||${allocCurrency}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key,
          vendorName: ord?.vendorName ?? a.vendorName,
          vendorContact: ord?.vendorContact ?? a.vendorContact ?? null,
          currency: ord ? (ord.currency || 'INR').toUpperCase() : allocCurrency,
          amount: 0, order: ord,
          _items: new Map(),
        };
        groups.set(key, g);
      }
      const line = a.total != null ? Number(a.total) : (Number(a.allocatedQty) || 0) * (Number(a.unitPrice) || 0);
      g.amount += line;
      if (g.vendorContact == null && a.vendorContact) g.vendorContact = a.vendorContact;
      const it = itemsById[a.indentItemId];
      const name = it?.name || 'Item';
      const unit = a.unit || it?.unit || '';
      const ex = g._items.get(a.indentItemId) || { name, qty: 0, unit };
      ex.qty += Number(a.allocatedQty) || 0;
      g._items.set(a.indentItemId, ex);
    }

    return Array.from(groups.values()).map((g) => ({
      key: g.key, vendorName: g.vendorName, vendorContact: g.vendorContact,
      currency: g.currency,
      // A materialised order's own amount is the financial record of record;
      // fall back to the summed line total for un-sent (Quoting) groups.
      amount: g.order ? Number(g.order.amount ?? g.amount) : g.amount,
      order: g.order,
      items: Array.from(g._items.values()),
    }));
  }, [allocations, indentItems, vendorOrders]);

  if (rows.length === 0) {
    return <p className="text-xs text-faint italic">No vendor orders yet — assign vendors in the quote to populate this.</p>;
  }

  const handleChange = async (orderId: string, status: string) => {
    // Placing the order captures an ETA + tracking, so route PAID→ORDERED to
    // the per-vendor "Mark ordered" modal rather than a bare status flip.
    if (status === 'ORDERED' && onMarkOrdered) {
      onMarkOrdered(orderId);
      return;
    }
    if (!onUpdateStatus) return;
    setSavingId(orderId);
    try {
      await onUpdateStatus(orderId, status);
    } finally {
      setSavingId(null);
    }
  };

  const totalsByCurrency = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.currency] = (acc[r.currency] || 0) + r.amount;
    return acc;
  }, {});

  return (
    <div className="border border-line rounded-lg overflow-hidden">
      <table className="w-full text-left">
        <thead>
          <tr className="bg-surface border-b border-line text-[10px] uppercase tracking-wider text-muted font-bold">
            <th className="px-3 py-2">Vendor</th>
            <th className="px-3 py-2">Items in this order</th>
            <th className="px-3 py-2 text-right">Amount</th>
            <th className="px-3 py-2">Payment</th>
            <th className="px-3 py-2">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {rows.map((r) => {
            const order = r.order;
            const status = order?.status as string | undefined;
            const nexts = status ? NEXT[status] || [] : [];
            const interactive = !!order && canUpdateStatus && !!onUpdateStatus && nexts.length > 0;
            return (
              <tr key={r.key} className="text-xs align-top">
                <td className="px-3 py-2">
                  <p className="font-bold text-ink">{r.vendorName}</p>
                  {r.vendorContact && <p className="text-[10px] text-faint">{r.vendorContact}</p>}
                </td>
                <td className="px-3 py-2">
                  <ul className="space-y-0.5">
                    {r.items.map((it, i) => (
                      <li key={i} className="text-[11px] text-muted">
                        <span className="text-ink">{it.name}</span>
                        <span className="text-faint"> · {it.qty}{it.unit ? ` ${it.unit}` : ''}</span>
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap font-bold text-emerald-700 dark:text-emerald-300">
                  {r.currency} {r.amount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </td>
                <td className="px-3 py-2">
                  {order?.paymentMethod
                    ? <span className="text-[11px] text-ink">{String(order.paymentMethod).replace(/_/g, ' ')}</span>
                    : <span className="text-[11px] text-faint italic">—</span>}
                </td>
                <td className="px-3 py-2">
                  {!order ? (
                    <span className="inline-block px-2 py-0.5 rounded text-[11px] font-bold border bg-hover text-muted border-line"
                      title="No order yet — this vendor is still being quoted. Send the indent to Finance to start tracking its status.">
                      Quoting
                    </span>
                  ) : (
                    <div className="flex flex-col items-start gap-1">
                      {interactive ? (
                        <select
                          value={status}
                          disabled={savingId === order.id}
                          onChange={(e) => handleChange(order.id, e.target.value)}
                          className="px-1.5 py-1 border rounded text-[11px] font-bold bg-card focus:border-brand outline-none cursor-pointer disabled:opacity-50"
                          title="Update this vendor order's payment / placement status — independent of the other rows.">
                          <option value={status}>{STATUS_META[status!]?.label ?? status}</option>
                          {nexts.map((n) => (
                            <option key={n} value={n}>→ {STATUS_META[n]?.label ?? n}</option>
                          ))}
                        </select>
                      ) : (
                        <StatusBadge status={status!} />
                      )}
                      {/* Physical shipment is tracked per line, not via the status
                          dropdown — surface the tracker right where the old
                          IN_TRANSIT/RECEIVED moves used to be. */}
                      {canUpdateStatus && onTrackShipment && SHIPMENT_TRACKABLE.includes(status || '') && (
                        <button
                          type="button"
                          onClick={onTrackShipment}
                          className="text-[10px] font-bold text-teal-700 dark:text-teal-300 hover:underline"
                          title="Mark each line's stage (In transit / Customs / Reached) and ETA.">
                          Track shipment →
                        </button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-surface border-t border-line">
            <td className="px-3 py-2 text-[10px] uppercase tracking-wider text-muted font-bold" colSpan={2}>
              {rows.length} vendor order{rows.length === 1 ? '' : 's'}
            </td>
            <td className="px-3 py-2 text-right font-bold text-emerald-700 dark:text-emerald-300 whitespace-nowrap">
              {Object.entries(totalsByCurrency).map(([cur, amt], i) => (
                <div key={cur}>{i > 0 && <span className="text-faint text-[10px]">+ </span>}{cur} {amt.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
              ))}
            </td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
};
