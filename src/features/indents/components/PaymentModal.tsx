import type { Dispatch, SetStateAction, MutableRefObject, RefObject } from 'react';
import { Modal } from '@/components/ui';
import { client } from '@/api';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '@/utils/date';
import { PAYMENT_METHOD_LABELS } from '@/config/thresholds';
import { ViewReceiptLink } from './ViewReceiptLink';
import { RECEIPT_ACCEPT } from '@/lib/fileAccept';

type VoForm = { txnId: string; notes: string; receipt: File | null };
type VaultMatch = { vendorName: string; matched: boolean; credential: { id: string; platform: string; loginId: string; password: string; notes?: string } | null };

interface PaymentModalProps {
    /** The indent being paid; null closes the modal. */
    row: any | null;
    onClose: () => void;
    vendorDisplay: (row: any) => string;
    // Vendor allocation breakdown (fetched on open by the parent).
    payAllocations: any[];
    payItems: any[];
    allocLoading: boolean;
    // Per-vendor-order payment forms.
    voForms: Record<string, VoForm>;
    setVoForm: (orderId: string, patch: Partial<VoForm>) => void;
    voSubmitting: string | null;
    onSubmitVendorPayment: (vo: any) => void;
    voSelected: Record<string, Set<string>>;
    setVoSelected: Dispatch<SetStateAction<Record<string, Set<string>>>>;
    voFileRefs: MutableRefObject<Record<string, HTMLInputElement | null>>;
    // Legacy indent-level mark-paid form.
    txnId: string;
    setTxnId: (v: string) => void;
    receipts: File[];
    setReceipts: (f: File[]) => void;
    fileRef: RefObject<HTMLInputElement>;
    notes: string;
    setNotes: (v: string) => void;
    onSubmitPayment: () => void;
    submitting: boolean;
    // Vault credential lookup.
    vaultPassword: string;
    setVaultPassword: (v: string) => void;
    vaultUnlocking: boolean;
    setVaultUnlocking: (v: boolean) => void;
    vaultMatches: VaultMatch[];
    setVaultMatches: Dispatch<SetStateAction<VaultMatch[]>>;
    vaultRevealed: Record<string, boolean>;
    setVaultRevealed: Dispatch<SetStateAction<Record<string, boolean>>>;
    vaultError: string | null;
    setVaultError: (v: string | null) => void;
    onLockVault: () => void;
    onBumpVaultIdle: () => void;
    addToast: (message: string, type?: 'success' | 'error' | 'info') => void;
}

/**
 * Mark as Paid Modal — per-vendor checkout + mark-paid, legacy single-payment
 * fallback, and the inline vendor-credential vault lookup.
 */
export const PaymentModal = ({
    row: payRow,
    onClose: closePayModal,
    vendorDisplay,
    payAllocations,
    payItems,
    allocLoading,
    voForms,
    setVoForm,
    voSubmitting,
    onSubmitVendorPayment: submitVendorPayment,
    voSelected,
    setVoSelected,
    voFileRefs,
    txnId,
    setTxnId,
    receipts,
    setReceipts,
    fileRef,
    notes,
    setNotes,
    onSubmitPayment: submitPayment,
    submitting,
    vaultPassword,
    setVaultPassword,
    vaultUnlocking,
    setVaultUnlocking,
    vaultMatches,
    setVaultMatches,
    vaultRevealed,
    setVaultRevealed,
    vaultError,
    setVaultError,
    onLockVault: lockVault,
    onBumpVaultIdle: bumpVaultIdle,
    addToast,
}: PaymentModalProps) => {
    // The copy used to report nothing when the write failed (no focus, no
    // clipboard permission, or an insecure context where navigator.clipboard
    // is undefined) — the user pasted whatever was there before.
    const copyText = async (text: string, okMessage: string) => {
        try {
            await navigator.clipboard.writeText(text);
            addToast(okMessage, 'success');
        } catch {
            addToast('Could not copy — your browser blocked clipboard access', 'error');
        }
    };
    return (
        <Modal isOpen={!!payRow} onClose={closePayModal} title={payRow ? `Mark ${payRow.serialNo} as Paid` : 'Mark as Paid'}>
            {payRow && (
                <div className="space-y-4">
                    <div className="bg-surface rounded-lg p-3 border border-line-soft text-xs">
                        <p><span className="font-bold">Vendor:</span> {vendorDisplay(payRow) || <span className="italic text-faint">not set</span>}</p>
                        <p><span className="font-bold">Amount:</span> {payRow.currency} {payRow.grandTotal?.toLocaleString()}</p>
                        <p><span className="font-bold">Department:</span> {payRow.department?.name}</p>
                        {payRow.emergency && payRow.emergencyReason && (
                            <p className="mt-2 text-red-700 dark:text-red-300"><span className="font-bold">⚡ Emergency:</span> {payRow.emergencyReason}</p>
                        )}
                    </div>

                    {/* Per-vendor checkout + mark-paid. Each vendor order is
                        ONE website checkout: its own currency, payment method,
                        transaction id, receipt and "Mark as Paid" button — one
                        payment can't cover 200 vendors. The indent rolls up to
                        Payment Done automatically once the last vendor clears.
                        Legacy indents (no vendor orders) fall back to the old
                        read-only breakdown + single mark-paid form below. */}
                    {(() => {
                        const orders: any[] = Array.isArray(payRow.vendorOrders) ? payRow.vendorOrders : [];
                        // Map allocation lines for line detail. linesByVendor (by
                        // name) feeds the legacy no-orders breakdown; linesByOrderId
                        // matches each line to its OWN order so split siblings of the
                        // same vendor show the correct lines (never collapse a vendor).
                        const itemMap: Record<string, any> = {};
                        for (const it of payItems) itemMap[it.id] = it;
                        const mkLine = (a: any) => ({
                            id: a.id,
                            itemName: itemMap[a.indentItemId]?.name || '(item removed)',
                            unit: a.unit || itemMap[a.indentItemId]?.unit || '',
                            qty: Number(a.allocatedQty || 0),
                            unitPrice: Number(a.unitPrice || 0),
                            currency: (a.currency || payRow.currency || 'INR').toUpperCase(),
                        });
                        const linesByVendor: Record<string, any[]> = {};
                        const linesByOrderId: Record<string, any[]> = {};
                        for (const a of payAllocations) {
                            const v = (a.vendorName || '').trim() || 'Unassigned';
                            (linesByVendor[v] ||= []).push(mkLine(a));
                            if (a.vendorOrderId) (linesByOrderId[a.vendorOrderId] ||= []).push(mkLine(a));
                        }

                        // ── Legacy path: no vendor orders → old indent-level flow ──
                        if (orders.length === 0) {
                            return (
                                <>
                                    {payRow.paymentMethod && (
                                        <div className="bg-sky-50/60 dark:bg-sky-400/15 rounded-lg p-3 border border-sky-200 dark:border-sky-400/30 text-xs">
                                            <p className="font-bold text-sky-900 dark:text-sky-200 uppercase tracking-wider text-[10px] mb-1">
                                                Payment method (from procurement)
                                            </p>
                                            <p className="text-ink">
                                                <span className="font-bold">{PAYMENT_METHOD_LABELS[payRow.paymentMethod] || payRow.paymentMethod}</span>
                                            </p>
                                            {payRow.paymentMethodNotes && (
                                                <p className="mt-1 text-muted whitespace-pre-wrap">{payRow.paymentMethodNotes}</p>
                                            )}
                                            {payRow.paymentHandoffAt && (
                                                <p className="mt-1 text-[10px] text-faint">Handed off {fmtDateTime(payRow.paymentHandoffAt)}</p>
                                            )}
                                        </div>
                                    )}
                                    <div className="bg-emerald-50/40 dark:bg-emerald-400/15 rounded-lg p-3 border border-emerald-100 dark:border-emerald-400/25 text-xs mt-4">
                                        <p className="font-bold text-emerald-900 dark:text-emerald-200 uppercase tracking-wider text-[10px] mb-2">Vendor breakdown</p>
                                        {allocLoading ? (
                                            <p className="text-[11px] text-faint italic">Loading breakdown…</p>
                                        ) : payAllocations.length === 0 ? (
                                            <p className="text-[11px] text-faint italic">
                                                No per-vendor allocation set — paying the whole amount to {vendorDisplay(payRow) || 'the listed vendor'}.
                                            </p>
                                        ) : (
                                            <div className="space-y-2">
                                                {Object.entries(linesByVendor).map(([vendor, lines]) => (
                                                    <div key={vendor} className="bg-card rounded border border-emerald-100 dark:border-emerald-400/25 p-2">
                                                        <p className="font-bold text-ink mb-1">{vendor}</p>
                                                        <ul className="space-y-0.5">
                                                            {lines.map((ln, i) => (
                                                                <li key={i} className="text-[10px] text-muted flex items-baseline justify-between gap-2">
                                                                    <span className="truncate flex-1">{ln.itemName}</span>
                                                                    <span className="font-mono whitespace-nowrap">{ln.qty} {ln.unit} × {ln.currency} {ln.unitPrice.toLocaleString('en-IN')}</span>
                                                                </li>
                                                            ))}
                                                        </ul>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </>
                            );
                        }

                        // ── Per-vendor path ──
                        const payable = orders.filter(o => o.status !== 'CANCELLED');
                        const paidCount = payable.filter(o => o.status !== 'AWAITING_PAYMENT').length;
                        return (
                            <div className="bg-emerald-50/40 dark:bg-emerald-400/15 rounded-lg p-3 border border-emerald-100 dark:border-emerald-400/25 text-xs space-y-2">
                                <div className="flex items-baseline justify-between gap-2">
                                    <p className="font-bold text-emerald-900 dark:text-emerald-200 uppercase tracking-wider text-[10px]">Pay each vendor · one checkout each</p>
                                    <span className="text-[10px] font-bold text-emerald-800 dark:text-emerald-200">{paidCount}/{payable.length} paid</span>
                                </div>
                                {orders.map((vo: any) => {
                                    const cur = (vo.currency || 'INR').toUpperCase();
                                    const lines = linesByOrderId[vo.id] || [];
                                    const cancelled = vo.status === 'CANCELLED';
                                    const paid = vo.status !== 'AWAITING_PAYMENT' && !cancelled;
                                    const form = voForms[vo.id] || { txnId: '', notes: '', receipt: null };
                                    const lineIds: string[] = lines.map((l: any) => l.id).filter(Boolean);
                                    const selectable = !paid && !cancelled && lineIds.length > 1;
                                    const sel = voSelected[vo.id];
                                    const isLineSel = (id: string) => (sel ? sel.has(id) : true);
                                    const selCount = sel ? lineIds.filter(id => sel.has(id)).length : lineIds.length;
                                    const allSel = selCount === lineIds.length;
                                    const noneSel = selCount === 0;
                                    const selAmount = lines.reduce((s: number, l: any) => s + (isLineSel(l.id) ? (Number(l.qty) || 0) * (Number(l.unitPrice) || 0) : 0), 0);
                                    const toggleLine = (id: string) => setVoSelected(prev => { const c = prev[vo.id] ? new Set(prev[vo.id]) : new Set(lineIds); c.has(id) ? c.delete(id) : c.add(id); return { ...prev, [vo.id]: c }; });
                                    const setAllLines = (on: boolean) => setVoSelected(prev => ({ ...prev, [vo.id]: on ? new Set(lineIds) : new Set<string>() }));
                                    return (
                                        <div key={vo.id} className={`rounded-lg border p-3 ${paid ? 'bg-emerald-50/70 dark:bg-emerald-400/15 border-emerald-200 dark:border-emerald-400/30' : cancelled ? 'bg-surface border-line opacity-70' : 'bg-card border-line'}`}>
                                            <div className="flex items-baseline justify-between gap-2 mb-1">
                                                <span className="font-bold text-ink text-sm">{vo.vendorName}</span>
                                                <span className="font-mono font-bold text-emerald-700 dark:text-emerald-300 text-sm">{cur} {Number(vo.amount || 0).toLocaleString('en-IN')}</span>
                                            </div>
                                            <div className="flex items-center justify-between gap-2 mb-1">
                                                <span className="text-[10px] text-muted">{PAYMENT_METHOD_LABELS[vo.paymentMethod] || vo.paymentMethod || '—'}</span>
                                                <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${paid ? 'bg-emerald-100 dark:bg-emerald-400/20 text-emerald-800 dark:text-emerald-200' : cancelled ? 'bg-line text-secondary' : 'bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200'}`}>{vo.status}</span>
                                            </div>
                                            {vo.paymentMethodNotes && (
                                                <p className="text-[10px] text-muted whitespace-pre-wrap mb-1">{vo.paymentMethodNotes}</p>
                                            )}
                                            {lines.length > 0 && (
                                                <div className="mb-2 border-t border-dashed border-line pt-1">
                                                    {selectable && (
                                                        <div className="flex items-center justify-between gap-2 mb-1">
                                                            <label className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-800 dark:text-emerald-200 cursor-pointer select-none">
                                                                <input type="checkbox" checked={allSel} ref={el => { if (el) el.indeterminate = !allSel && !noneSel; }}
                                                                    onChange={e => setAllLines(e.target.checked)}
                                                                    className="accent-emerald-600 cursor-pointer" />
                                                                Select all
                                                            </label>
                                                            <span className="text-[10px] text-muted">{selCount} of {lineIds.length} selected · rest stay unpaid</span>
                                                        </div>
                                                    )}
                                                    <ul className="space-y-0.5">
                                                        {lines.map((ln: any) => {
                                                            const checked = isLineSel(ln.id);
                                                            return (
                                                                <li key={ln.id} className={`text-[10px] flex items-baseline gap-2 ${selectable && !checked ? 'opacity-40' : 'text-muted'}`}>
                                                                    {selectable && (
                                                                        <input type="checkbox" checked={checked} onChange={() => toggleLine(ln.id)}
                                                                            className="accent-emerald-600 cursor-pointer mt-0.5" />
                                                                    )}
                                                                    <span className="truncate flex-1">{ln.itemName}</span>
                                                                    <span className="font-mono whitespace-nowrap">{ln.qty} {ln.unit} × {ln.currency} {ln.unitPrice.toLocaleString('en-IN')}</span>
                                                                </li>
                                                            );
                                                        })}
                                                    </ul>
                                                    {selectable && !allSel && (
                                                        <p className="text-[10px] text-emerald-800 dark:text-emerald-200 font-bold mt-1 text-right">Paying {cur} {selAmount.toLocaleString('en-IN')}</p>
                                                    )}
                                                </div>
                                            )}
                                            {cancelled ? (
                                                <p className="text-[10px] text-muted italic">Cancelled — no payment due.</p>
                                            ) : paid ? (
                                                <div className="text-[10px] text-emerald-800 dark:text-emerald-200 space-y-0.5 border-t border-emerald-100 dark:border-emerald-400/25 pt-1">
                                                    <p><span className="font-bold">Paid</span>{vo.paidBy?.name ? ` by ${vo.paidBy.name}` : ''}{vo.paidAt ? ` · ${fmtDateTime(vo.paidAt)}` : ''}</p>
                                                    {vo.paymentTransactionId && <p>txn <span className="font-mono">{vo.paymentTransactionId}</span></p>}
                                                    {vo.paymentReceiptPath && <ViewReceiptLink indentId={payRow.id} kind="vendor-order" orderId={vo.id} />}
                                                </div>
                                            ) : (
                                                <div className="space-y-2 border-t border-line-soft pt-2">
                                                    <label className="block text-[10px] font-bold text-muted">Transaction ID <span className="text-red-700 dark:text-red-300">*</span> <span className="font-normal text-faint">(required — UTR / cheque no. / order ref)</span></label>
                                                    <input type="text" value={form.txnId}
                                                        onChange={e => setVoForm(vo.id, { txnId: e.target.value })}
                                                        placeholder="e.g. NEFT-2026051501234"
                                                        className="w-full border border-line rounded py-1.5 px-2 text-xs font-mono focus:border-brand outline-none" />
                                                    <label className="block text-[10px] font-bold text-muted">Payment receipt <span className="font-normal text-faint">(optional — PDF or image)</span></label>
                                                    <input ref={el => { voFileRefs.current[vo.id] = el; }} type="file" accept={RECEIPT_ACCEPT}
                                                        onChange={e => setVoForm(vo.id, { receipt: e.target.files?.[0] || null })}
                                                        className="w-full text-[10px] file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-brand file:text-white file:font-bold file:cursor-pointer" />
                                                    {form.receipt && <p className="text-[10px] text-muted">📎 {form.receipt.name} ({Math.round(form.receipt.size / 1024)} KB)</p>}
                                                    <input type="text" value={form.notes}
                                                        onChange={e => setVoForm(vo.id, { notes: e.target.value })}
                                                        placeholder="Notes (optional)"
                                                        className="w-full border border-line rounded py-1.5 px-2 text-xs focus:border-brand outline-none" />
                                                    <div className="flex justify-end">
                                                        <button onClick={() => submitVendorPayment(vo)} disabled={voSubmitting === vo.id || !form.txnId.trim() || (selectable && noneSel)}
                                                            className="px-3 py-1.5 text-xs font-bold bg-emerald-700 text-white rounded hover:bg-emerald-800 disabled:opacity-50">
                                                            {voSubmitting === vo.id ? 'Saving…' : (selectable && !allSel ? `Pay ${selCount} item(s)` : 'Mark as Paid')}
                                                        </button>
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    );
                                })}
                                <p className="text-[10px] text-faint italic">Pay each vendor as you complete its checkout. {payRow.serialNo} advances to Payment Done automatically once every vendor is paid.</p>
                            </div>
                        );
                    })()}

                    {/* Vendor portal logins — fetched from the Password
                        Vault when finance enters the master password.
                        Eliminates the page-switch dance to look up
                        credentials mid-payment. Decrypted creds live
                        in this modal's state ONLY and get wiped on
                        close (see closePayModal). */}
                    {payAllocations.length > 0 && (() => {
                        const uniqueVendors = Array.from(new Set(
                            payAllocations.map((a: any) => (a.vendorName || '').trim()).filter(Boolean),
                        ));
                        if (uniqueVendors.length === 0) return null;
                        const unlocked = vaultMatches.length > 0;
                        return (
                            <div
                                className="bg-brand-100/40 rounded-lg p-3 border border-brand-200 text-xs space-y-2"
                                onMouseMove={() => { if (unlocked) bumpVaultIdle(); }}
                            >
                                <div className="flex items-baseline justify-between flex-wrap gap-1">
                                    <p className="font-bold text-brand-700 uppercase tracking-wider text-[10px]">
                                        Vendor portal logins
                                    </p>
                                    {unlocked ? (
                                        <button
                                            type="button"
                                            onClick={lockVault}
                                            className="text-[10px] font-bold text-brand-700 hover:text-ink px-2 py-0.5 border border-brand rounded bg-card"
                                            title="Wipe credentials from screen now"
                                        >
                                            🔒 Lock now
                                        </button>
                                    ) : (
                                        <p className="text-[10px] text-faint">
                                            From the Password Vault · auto-matched to vendor names
                                        </p>
                                    )}
                                </div>
                                {!unlocked && (
                                    <form noValidate
                                        onSubmit={async (e) => {
                                            e.preventDefault();
                                            if (!vaultPassword) return;
                                            setVaultUnlocking(true);
                                            setVaultError(null);
                                            try {
                                                const { data } = await client.post('/platform-credentials/match', {
                                                    masterPassword: vaultPassword,
                                                    vendorNames: uniqueVendors,
                                                });
                                                const payload = data?.data ?? data;
                                                setVaultMatches(payload?.matches || []);
                                                bumpVaultIdle();
                                            } catch (e: any) {
                                                setVaultError(extractErrorMessage(e, 'Could not unlock vault'));
                                            } finally {
                                                setVaultUnlocking(false);
                                            }
                                        }}
                                        className="flex items-center gap-2"
                                    >
                                        <input
                                            type="password"
                                            value={vaultPassword}
                                            onChange={(e) => setVaultPassword(e.target.value)}
                                            placeholder="Vault master password"
                                            autoComplete="off"
                                            className="flex-1 border border-line rounded py-1.5 px-2 text-sm focus:border-brand outline-none"
                                        />
                                        <button
                                            type="submit"
                                            disabled={!vaultPassword || vaultUnlocking}
                                            className="px-3 py-1.5 text-xs font-bold bg-brand text-white rounded-full hover:bg-brand-dark disabled:opacity-50"
                                        >
                                            {vaultUnlocking ? 'Unlocking…' : 'Unlock'}
                                        </button>
                                    </form>
                                )}
                                {vaultError && (
                                    <p className="text-[11px] text-red-700 dark:text-red-300 italic">{vaultError}</p>
                                )}
                                {unlocked && (
                                    <div className="space-y-2">
                                        {vaultMatches.map((m) => (
                                            <div key={m.vendorName} className="bg-card rounded border border-brand-200 p-2">
                                                <div className="flex items-baseline justify-between gap-2 mb-1">
                                                    <span className="font-bold text-ink">{m.vendorName}</span>
                                                    {!m.matched && (
                                                        <span className="text-[10px] text-faint italic">
                                                            no vault entry — add it in Password Vault
                                                        </span>
                                                    )}
                                                    {m.matched && m.credential!.platform.toLowerCase() !== m.vendorName.toLowerCase() && (
                                                        <span className="text-[10px] text-faint">
                                                            matched: {m.credential!.platform}
                                                        </span>
                                                    )}
                                                </div>
                                                {m.matched && m.credential && (
                                                    <div className="space-y-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-[10px] font-bold text-faint uppercase w-20 shrink-0">Login</span>
                                                            <span className="font-mono text-[11px] text-ink flex-1 truncate">{m.credential.loginId}</span>
                                                            <button
                                                                type="button"
                                                                onClick={() => copyText(m.credential!.loginId, 'Login copied')}
                                                                className="text-[10px] font-bold text-brand hover:text-brand-dark px-2 py-0.5 border border-brand-200 rounded"
                                                            >
                                                                Copy
                                                            </button>
                                                        </div>
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-[10px] font-bold text-faint uppercase w-20 shrink-0">Password</span>
                                                            <span className="font-mono text-[11px] text-ink flex-1 min-w-0 truncate">
                                                                {vaultRevealed[m.credential.id]
                                                                    ? (m.credential.password
                                                                        ? m.credential.password
                                                                        : <span className="italic text-faint">empty — set in Vault</span>)
                                                                    : '••••••••••'}
                                                            </span>
                                                            <button
                                                                type="button"
                                                                onClick={() => setVaultRevealed(prev => ({ ...prev, [m.credential!.id]: !prev[m.credential!.id] }))}
                                                                className="text-[10px] font-bold text-muted hover:text-ink px-2 py-0.5 border border-brand-200 rounded"
                                                            >
                                                                {vaultRevealed[m.credential.id] ? 'Hide' : 'Show'}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                disabled={!m.credential.password}
                                                                onClick={() => copyText(m.credential!.password, 'Password copied')}
                                                                className="text-[10px] font-bold text-brand hover:text-brand-dark disabled:opacity-40 disabled:cursor-not-allowed px-2 py-0.5 border border-brand-200 rounded"
                                                            >
                                                                Copy
                                                            </button>
                                                        </div>
                                                        {m.credential.notes && (
                                                            <p className="text-[10px] text-muted italic mt-1 whitespace-pre-wrap">
                                                                {m.credential.notes}
                                                            </p>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                        <p className="text-[10px] text-faint italic">
                                            Auto-locks after 90s of inactivity · clears when you close this modal.
                                        </p>
                                    </div>
                                )}
                            </div>
                        );
                    })()}

                    {/* Indent-level mark-paid form — legacy single-payment
                        path, shown ONLY for old indents with no per-vendor
                        orders. Per-vendor indents pay through each card above. */}
                    {(!payRow.vendorOrders || payRow.vendorOrders.length === 0) && (
                        <>
                            <div>
                                <label className="block text-xs font-bold text-muted mb-1">Transaction ID <span className="text-red-700 dark:text-red-300">*</span></label>
                                <input type="text" value={txnId} onChange={(e) => setTxnId(e.target.value)}
                                  placeholder="e.g. NEFT-2026051501234 / UTR / cheque no."
                                  className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none font-mono" />
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-muted mb-1">
                                    Receipts / screenshots{' '}
                                    <span className="font-normal text-faint">(optional — PDF or image, several allowed)</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    {/* A payment is often proved by more than one document — two
                                        tranches, or a bank confirmation plus the vendor's invoice. */}
                                    <input ref={fileRef} type="file" multiple accept={RECEIPT_ACCEPT}
                                      onChange={(e) => setReceipts([...(e.target.files ? Array.from(e.target.files) : [])])}
                                      className="flex-1 text-xs file:mr-3 file:py-1.5 file:px-3 file:rounded file:border-0 file:bg-brand file:text-white file:font-bold file:cursor-pointer" />
                                    {/* Whatever has already been filed against this indent, so
                                        somebody re-opening a part-paid indent can see what is
                                        there before adding to it. */}
                                    <ViewReceiptLink indentId={payRow.id} label="View uploaded"
                                      className="shrink-0 px-2 py-1 border border-brand-200 rounded hover:bg-brand-100/60" />
                                </div>
                                {receipts.length > 0 && (
                                    <ul className="mt-1.5 space-y-0.5">
                                        {receipts.map((f, i) => (
                                            <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-[10px] text-muted">
                                                <span className="truncate">📎 {f.name} ({Math.round(f.size / 1024)} KB)</span>
                                                <button type="button" onClick={() => setReceipts(receipts.filter((_, j) => j !== i))}
                                                  className="text-faint hover:text-red-700 shrink-0" title="Remove from this upload">✕</button>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-muted mb-1">Notes (optional)</label>
                                <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
                                  placeholder="e.g. Paid in two tranches via HDFC NEFT…"
                                  className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none" />
                            </div>
                        </>
                    )}
                    <div className="flex justify-end gap-2 pt-2 border-t border-line-soft">
                        <button onClick={closePayModal} className="px-4 py-2 text-sm font-bold text-muted hover:bg-surface rounded">
                            {(payRow.vendorOrders && payRow.vendorOrders.length > 0) ? 'Done' : 'Cancel'}
                        </button>
                        {(!payRow.vendorOrders || payRow.vendorOrders.length === 0) && (
                            <button onClick={submitPayment} disabled={submitting || !txnId.trim()}
                              className="px-5 py-2 text-sm font-bold bg-emerald-700 text-white rounded hover:bg-emerald-800 disabled:opacity-50">
                                {submitting ? 'Saving…' : 'Mark as Paid'}
                            </button>
                        )}
                    </div>
                </div>
            )}
        </Modal>
    );
};
