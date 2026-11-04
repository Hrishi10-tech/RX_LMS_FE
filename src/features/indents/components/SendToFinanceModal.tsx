// Send-to-Finance modal — captures payment method + optional
// banking notes, then transitions READY_FOR_PAYMENT → AWAITING_PAYMENT.
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { rollupWithVendorGst } from '@/config/thresholds';
import { extractErrorMessage } from '@/lib';

interface Props {
    row: any;
    onClose: () => void;
    onSent: () => void;
}

export const SendToFinanceModal = ({ row: sendToFinanceRow, onClose, onSent }: Props) => {
    const { addToast } = useToast();
    // Payment method is chosen PER VENDOR at send-to-finance (each vendor order
    // is a separate website checkout). Keyed by vendor name; unset vendors
    // default to ONLINE. Reset whenever the modal closes.
    const [vendorPayments, setVendorPayments] = useState<Record<string, { method: string; notes: string }>>({});
    const [sendingToFinance, setSendingToFinance] = useState(false);
    // Per-item send: which UN-SENT allocation lines to hand to Finance now.
    // Defaults to ALL un-sent lines whenever the modal opens. Un-ticking some
    // triggers a subset send; the rest stay un-sent and hold the indent at
    // AWAITING_PAYMENT until they're sent too.
    //
    // `allocationIds` is ALWAYS sent now — see the payload comment below.
    // These comments used to say "all selected → omit allocationIds", which was
    // the bug: on a follow-up send the leftover line is the only un-sent one, so
    // "all selected" was true, the ids were omitted, and the backend read it as
    // a full send and 400'd. That line could then never reach Finance at all.
    const [sendSelectedIds, setSendSelectedIds] = useState<Set<string>>(new Set());
    useEffect(() => {
        if (!sendToFinanceRow) { setSendSelectedIds(new Set()); return; }
        const unsent = (sendToFinanceRow.vendorAllocations || [])
            .filter((a: any) => !a.vendorOrderId)
            .map((a: any) => a.id);
        setSendSelectedIds(new Set(unsent));
    }, [sendToFinanceRow]);

    return (
            <Modal
                isOpen={!!sendToFinanceRow}
                onClose={() => {
                    if (sendingToFinance) return;
                    onClose();
                    setVendorPayments({});
                }}
                title={sendToFinanceRow ? `Send ${sendToFinanceRow.serialNo} to Finance` : 'Send to Finance'}
            >
                {sendToFinanceRow && (() => {
                    // Derive the per-vendor breakdown from allocations.
                    // The Indent.vendorName field is legacy ("master vendor",
                    // rarely populated under the new multi-vendor flow). The
                    // real list-of-vendors-being-paid lives on the active
                    // quotation's VendorAllocation rows (already filtered to
                    // active-quotation scope by indent-query.service).
                    // Only lines NOT yet handed to Finance (no vendor order yet)
                    // are sendable. On a fresh READY_FOR_PAYMENT indent that's all
                    // of them; on a follow-up send it's just the leftovers.
                    // Committed rows only: an option the admin did not pick is
                    // never bought, and the backend refuses to send one.
                    const allocs: any[] = (sendToFinanceRow.vendorAllocations || []).filter((a: any) => !a.vendorOrderId && !a.isAlternative);
                    const itemsById: Record<string, any> = {};
                    for (const it of (sendToFinanceRow.items || [])) itemsById[it.id] = it;
                    const byVendor: Record<string, { vendor: string; lines: any[] }> = {};
                    for (const a of allocs) {
                        // Trimmed, as the backend groups them — "Robu " and
                        // "Robu" are one vendor and one order.
                        const v = String(a.vendorName || '').trim() || 'Unassigned';
                        if (!byVendor[v]) byVendor[v] = { vendor: v, lines: [] };
                        byVendor[v].lines.push({
                            id: a.id,                          // allocationId — the unit of selection
                            itemName: itemsById[a.indentItemId]?.name || '(item)',
                            unit: a.unit || itemsById[a.indentItemId]?.unit || '',
                            qty: Number(a.allocatedQty || 0),
                            unitPrice: Number(a.unitPrice || 0),
                            total: Number(a.allocatedQty || 0) * Number(a.unitPrice || 0),
                            // Each allocation carries its OWN currency (a vendor's
                            // checkout may be EUR while another's is USD). Never
                            // assume the indent-level currency here.
                            currency: (a.currency || 'INR').toUpperCase(),
                            // The vendor's rate and shipping ride on every row of
                            // the vendor; the roll-up below takes them once.
                            gstPercentage: a.gstPercentage,
                            shippingCost: a.shippingCost,
                        });
                    }
                    // Shipping is charged once per vendor. A vendor whose earlier
                    // batch already went to Finance carries it on THAT order, and
                    // the backend adds none to this one — so neither does this
                    // screen. Same rule as shippingAlreadyCharged: any order of the
                    // vendor that is not cancelled and has shipping on it.
                    const shippedAlready = new Set(
                        (sendToFinanceRow.vendorOrders || [])
                            .filter((o: any) => o.status !== 'CANCELLED' && Number(o.shippingAmount) > 0)
                            .map((o: any) => `${String(o.vendorName || '').trim()}||${String(o.currency || 'INR').toUpperCase().trim()}`),
                    );
                    // What Finance will be asked to pay for the ticked lines of
                    // one vendor: subtotal + GST + shipping (once), per currency
                    // group, rolled like the indent total. This is the figure the
                    // vendor order gets, not qty × price.
                    const vendorAmount = (vendor: string, lines: any[]) => rollupWithVendorGst(lines.map((l: any) => ({
                        vendorName: vendor,
                        total: l.total,
                        currency: l.currency,
                        gstPercentage: l.gstPercentage,
                        shippingCost: shippedAlready.has(`${vendor}||${l.currency}`) ? 0 : l.shippingCost,
                    })));
                    // The headline: everything ticked, every vendor, inclusive.
                    const sendRoll = rollupWithVendorGst(Object.values(byVendor).flatMap((v) => v.lines
                        .filter((l: any) => sendSelectedIds.has(l.id))
                        .map((l: any) => ({
                            vendorName: v.vendor,
                            total: l.total,
                            currency: l.currency,
                            gstPercentage: l.gstPercentage,
                            shippingCost: shippedAlready.has(`${v.vendor}||${l.currency}`) ? 0 : l.shippingCost,
                        }))));
                    const inclLabel = (r: { gstTotal: number; shippingTotal: number }) => {
                        const parts = [r.gstTotal > 0.005 ? 'GST' : '', r.shippingTotal > 0.005 ? 'shipping' : ''].filter(Boolean);
                        return parts.length ? `incl. ${parts.join(' & ')}` : '';
                    };
                    const vendorList = Object.values(byVendor);
                    const vendorSummary = vendorList.length === 0
                        ? <span className="italic text-faint">no allocations yet</span>
                        : vendorList.length === 1
                            ? vendorList[0].vendor
                            : `${vendorList.length} vendors`;
                    // ── Per-item selection ──────────────────────────────────
                    // sendSelectedIds defaults to every un-sent line (set on open),
                    // so leaving it untouched means "send everything still un-sent".
                    // The ticked ids are always transmitted, whether that's all of
                    // them or a subset.
                    const allUnsentIds: string[] = allocs.map((a: any) => a.id);
                    const isSel = (id: string) => sendSelectedIds.has(id);
                    const toggleLine = (id: string) => setSendSelectedIds(prev => {
                        const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
                    });
                    const setMany = (ids: string[], on: boolean) => setSendSelectedIds(prev => {
                        const n = new Set(prev); ids.forEach(i => on ? n.add(i) : n.delete(i)); return n;
                    });
                    const selectedIds = allUnsentIds.filter(isSel);
                    const selectedSet = new Set(selectedIds);
                    const allSelected = allUnsentIds.length > 0 && selectedIds.length === allUnsentIds.length;
                    const noneSelected = selectedIds.length === 0;
                    // Per-vendor payment-method state helpers (default ONLINE).
                    const getVP = (vendor: string) => vendorPayments[vendor] || { method: 'ONLINE', notes: '' };
                    const setVP = (vendor: string, patch: Partial<{ method: string; notes: string }>) =>
                        setVendorPayments(prev => ({ ...prev, [vendor]: { ...(prev[vendor] || { method: 'ONLINE', notes: '' }), ...patch } }));
                    const placeholderFor = (m: string) =>
                        m === 'WIRE_TRANSFER' ? 'Bank: HDFC · A/C: 12345678 · IFSC: HDFC0001234 · Beneficiary: Vendor Inc.'
                            : m === 'ONLINE' ? 'Portal: vendor.com/billing · Vendor invoice: INV-12345'
                                : m === 'CHEQUE' ? 'Pay to: Vendor Inc. · Courier address: 123 Main St'
                                    : 'Anything Finance should know before paying this vendor';
                    // Everything on this indent has already been handed off —
                    // distinguish from "no allocations were ever set".
                    const everythingSent = (sendToFinanceRow.vendorAllocations || []).length > 0 && allocs.length === 0;
                    return (
                    <div className="space-y-4">
                        <div className="bg-surface rounded-md p-3 border border-line-soft text-xs">
                            <p><span className="font-bold">Vendor{vendorList.length > 1 ? 's' : ''}:</span> {vendorSummary}</p>
                            {/* The ticked lines, inclusive — what this hand-off asks
                                Finance to pay. The indent's saved grandTotal is the
                                fallback when there are no vendor lines to roll. */}
                            <p><span className="font-bold">Amount:</span>{' '}
                                {vendorList.length > 0
                                    ? <>{sendRoll.currency} {sendRoll.grandTotal.toLocaleString('en-IN')}{inclLabel(sendRoll) && <span className="ml-1 text-[10px] text-muted">{inclLabel(sendRoll)}</span>}</>
                                    : <>{sendToFinanceRow.currency} {Number(sendToFinanceRow.grandTotal || 0).toLocaleString('en-IN')}</>}
                            </p>
                            <p><span className="font-bold">Department:</span> {sendToFinanceRow.department?.name}</p>
                        </div>

                        {/* Per-item selection toolbar — tick which lines go to
                            Finance now. All ticked (the default) = send everything;
                            a strict subset = send those, the rest wait. */}
                        {allUnsentIds.length > 0 && (
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                                <span className="font-bold text-muted">
                                    {selectedIds.length} of {allUnsentIds.length} item{allUnsentIds.length === 1 ? '' : 's'} selected
                                    {!allSelected && selectedIds.length > 0 && (
                                        <span className="ml-1 font-normal text-amber-700 dark:text-amber-300">· the rest stay un-sent</span>
                                    )}
                                </span>
                                <div className="flex gap-3">
                                    <button type="button" onClick={() => setMany(allUnsentIds, true)} disabled={allSelected}
                                        className="font-bold text-emerald-700 dark:text-emerald-300 hover:underline disabled:opacity-40 disabled:no-underline">Select all</button>
                                    <button type="button" onClick={() => setMany(allUnsentIds, false)} disabled={noneSelected}
                                        className="font-bold text-faint hover:underline disabled:opacity-40 disabled:no-underline">Clear</button>
                                </div>
                            </div>
                        )}

                        {/* Per-vendor breakdown — confirms who'll get paid
                            what BEFORE handing off to Finance. Procurement
                            already saw this on the Quote modal but a quick
                            sanity-check here catches any drift before the
                            file leaves their hands. */}
                        {vendorList.length > 0 && (
                            <div className="bg-emerald-50/40 dark:bg-emerald-400/15 rounded-md p-3 border border-emerald-100 dark:border-emerald-400/25 text-xs space-y-2">
                                <div>
                                    <p className="font-bold text-emerald-900 dark:text-emerald-200 uppercase tracking-wider text-[10px]">
                                        Vendor breakdown
                                    </p>
                                    <p className="text-[10px] text-emerald-700/80 dark:text-emerald-300 normal-case font-normal tracking-normal">
                                        Tick the items to send now — each vendor is a separate checkout, so pick how Finance pays each one.
                                    </p>
                                </div>
                                {vendorList.map(v => {
                                    // Per-vendor selection + total (in the vendor's OWN
                                    // currency; mixed lines → INR, mirroring the backend
                                    // roll-up). Amount reflects only the SELECTED lines.
                                    const vIds = v.lines.map((l: any) => l.id);
                                    const vSelCount = vIds.filter(isSel).length;
                                    const vAll = vSelCount === vIds.length;
                                    const vNone = vSelCount === 0;
                                    const roll = vendorAmount(v.vendor, v.lines.filter((l: any) => selectedSet.has(l.id)));
                                    return (
                                    <div key={v.vendor} className={`bg-card rounded border border-emerald-100 dark:border-emerald-400/25 p-2 ${vNone ? 'opacity-60' : ''}`}>
                                        <div className="flex items-center justify-between mb-1 gap-2">
                                            <label className="flex items-center gap-2 cursor-pointer min-w-0">
                                                <input type="checkbox" checked={vAll}
                                                    ref={el => { if (el) el.indeterminate = !vAll && !vNone; }}
                                                    onChange={() => setMany(vIds, !vAll)}
                                                    className="rounded border-line shrink-0" />
                                                <span className="font-bold text-ink truncate">{v.vendor}</span>
                                            </label>
                                            <span className="font-mono font-bold text-emerald-700 dark:text-emerald-300 shrink-0">
                                                {vNone
                                                    ? <span className="font-normal italic text-faint">not selected</span>
                                                    : <>{roll.currency} {roll.grandTotal.toLocaleString('en-IN')}{inclLabel(roll) && <span className="ml-1 text-[10px] font-normal text-muted">{inclLabel(roll)}</span>}</>}
                                            </span>
                                        </div>
                                        <ul className="space-y-0.5">
                                            {v.lines.map((ln: any) => (
                                                <li key={ln.id} className={`text-[10px] flex items-center gap-2 ${isSel(ln.id) ? 'text-muted' : 'text-faint'}`}>
                                                    <input type="checkbox" checked={isSel(ln.id)} onChange={() => toggleLine(ln.id)}
                                                        className="rounded border-line shrink-0" />
                                                    <span className="truncate flex-1">{ln.itemName}</span>
                                                    <span className="font-mono whitespace-nowrap">
                                                        {ln.qty} {ln.unit} × {ln.currency} {ln.unitPrice.toLocaleString('en-IN')}
                                                    </span>
                                                </li>
                                            ))}
                                        </ul>
                                        <div className="mt-2 pt-2 border-t border-emerald-50 dark:border-emerald-400/25 space-y-1.5">
                                            <label className="block text-[10px] font-bold text-muted">
                                                Payment method <span className="text-red-700 dark:text-red-300">*</span>
                                            </label>
                                            <select
                                                value={getVP(v.vendor).method}
                                                onChange={(e) => setVP(v.vendor, { method: e.target.value })}
                                                disabled={vNone}
                                                className="w-full border border-line rounded py-1.5 px-2 text-xs bg-card focus:border-brand outline-none disabled:bg-surface"
                                            >
                                                <option value="ONLINE">Online (vendor portal / payment gateway)</option>
                                                <option value="WIRE_TRANSFER">Wire transfer / NEFT / RTGS</option>
                                                <option value="CHEQUE">Cheque</option>
                                                <option value="CASH">Cash</option>
                                                <option value="OTHER">Other</option>
                                            </select>
                                            <textarea
                                                maxLength={500}
                                                value={getVP(v.vendor).notes}
                                                onChange={(e) => setVP(v.vendor, { notes: e.target.value })}
                                                rows={2}
                                                disabled={vNone}
                                                placeholder={placeholderFor(getVP(v.vendor).method)}
                                                className="w-full border border-line rounded py-1.5 px-2 text-[11px] focus:border-brand outline-none resize-none disabled:bg-surface"
                                            />
                                        </div>
                                    </div>
                                    );
                                })}
                            </div>
                        )}
                        {vendorList.length === 0 && (
                            <p className="text-xs text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border border-amber-100 dark:border-amber-400/25 rounded-md p-2">
                                {everythingSent
                                    ? 'All lines on this indent have already been sent to Finance — nothing left to hand off.'
                                    : 'No vendor allocations on the active quote yet — add them in the Quote panel before sending to Finance.'}
                            </p>
                        )}
                        <p className="text-[10px] text-faint">
                            Notes per vendor carry banking details, vendor invoice refs, portal links — whatever Finance needs to actually execute that payment.
                        </p>
                        <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
                            <button
                                type="button"
                                onClick={() => { onClose(); setVendorPayments({}); }}
                                disabled={sendingToFinance}
                                className="px-4 py-2 text-sm font-bold text-muted border border-line rounded hover:bg-surface disabled:opacity-50"
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                onClick={async () => {
                                    if (!sendToFinanceRow || noneSelected) return;
                                    setSendingToFinance(true);
                                    try {
                                        // Only vendors with ≥1 selected line carry a
                                        // payment method. The ticked ids go on the payload
                                        // unconditionally — omitting them when everything
                                        // was selected is what made a follow-up send
                                        // unfulfillable (see the state comment above).
                                        const vendorsPayload = vendorList
                                            .filter(v => v.lines.some((l: any) => selectedSet.has(l.id)))
                                            .map(v => ({
                                                vendorName: v.vendor,
                                                paymentMethod: getVP(v.vendor).method,
                                                paymentMethodNotes: getVP(v.vendor).notes.trim() || undefined,
                                            }));
                                        const payload: any = { vendors: vendorsPayload };
                                        // ALWAYS send the ticked ids.
                                        //
                                        // This used to omit them when the whole
                                        // un-sent set was ticked, which is the
                                        // default state on open — and the backend
                                        // reads an allocationIds-less body as a
                                        // FULL send, legal only from
                                        // READY_FOR_PAYMENT. So a FOLLOW-UP send
                                        // (indent already AWAITING_PAYMENT, some
                                        // lines still un-sent) always 400'd, and
                                        // the Send button is disabled when nothing
                                        // is ticked, so there was no way to force
                                        // a subset once one line remained. The
                                        // un-sent line then pinned every rollup
                                        // (hasUnsentLinesTx), so the indent could
                                        // not progress either.
                                        //
                                        // Being explicit is right regardless: the
                                        // server should act on what was ticked,
                                        // not infer intent from an absent field.
                                        // A full send from READY_FOR_PAYMENT is
                                        // still accepted — the subset branch
                                        // permits both READY_FOR_PAYMENT and
                                        // AWAITING_PAYMENT.
                                        payload.allocationIds = selectedIds;
                                        await client.post(`/indents/${sendToFinanceRow.id}/send-to-finance`, payload);
                                        addToast(
                                            allSelected
                                                ? `${sendToFinanceRow.serialNo} sent to Finance.`
                                                : `${selectedIds.length} item${selectedIds.length === 1 ? '' : 's'} of ${sendToFinanceRow.serialNo} sent to Finance.`,
                                            'success',
                                        );
                                        onClose();
                                        setVendorPayments({});
                                        onSent();
                                    } catch (e: any) {
                                        addToast(extractErrorMessage(e, 'Failed to send to Finance'), 'error');
                                    } finally {
                                        setSendingToFinance(false);
                                    }
                                }}
                                disabled={sendingToFinance || vendorList.length === 0 || noneSelected}
                                className="px-5 py-2 text-sm font-bold bg-emerald-700 text-white rounded hover:bg-emerald-800 disabled:opacity-50"
                            >
                                {sendingToFinance
                                    ? 'Sending…'
                                    : allSelected
                                        ? 'Send to Finance'
                                        : `Send ${selectedIds.length} item${selectedIds.length === 1 ? '' : 's'}`}
                            </button>
                        </div>
                    </div>
                    );
                })()}
            </Modal>
    );
};
