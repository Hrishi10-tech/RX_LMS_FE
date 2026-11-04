import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';
import { FileText, Ship, Receipt, Plus, Pencil } from 'lucide-react';
import { ViewReceiptLink } from './ViewReceiptLink';
import { useAbortOnUnmount } from '@/hooks';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** The indent row — id, serialNo, currency, customs* fields, customsDutyPayments. */
  row: any | null;
  /** Refetch the parent list/badges after a mutation. */
  onSaved?: () => void;
}

const DUTY_KINDS: { kind: 'INTERNAL' | 'INTERNATIONAL'; label: string; hint: string }[] = [
  { kind: 'INTERNAL', label: 'Other payments', hint: 'Local charges — CHA fees, handling' },
  { kind: 'INTERNATIONAL', label: 'Customs duty', hint: 'Foreign customs duty' },
];

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'JPY', 'CNY', 'AED', 'SGD', 'AUD', 'CAD'];

/**
 * Procurement-only customs-clearance panel for any indent that's
 * IN_TRANSIT (currency-agnostic). Three independent sub-tasks: Documentation, the
 * Delivery-Order CHA slip (a nested modal), and Duty (shipment detail + raising
 * the two duty payments Finance settles). No status change — the indent stays
 * IN_TRANSIT; the requester only ever sees a "Customs clearance" label.
 */
export const CustomsClearanceModal = ({ isOpen, onClose, row, onSaved }: Props) => {
  const { addToast } = useToast();
  // Abandon in-flight reads when this unmounts — see useAbortOnUnmount.
  const abortSignal = useAbortOnUnmount();

  const [detail, setDetail] = useState<any>(row);
  const [chaOpen, setChaOpen] = useState(false);
  const [savingKey, setSavingKey] = useState<string | null>(null);

  const [documentation, setDocumentation] = useState('');
  const [cha, setCha] = useState('');
  const [awb, setAwb] = useState('');
  const [agent, setAgent] = useState('');
  const [bill, setBill] = useState('');
  const [dutyAmount, setDutyAmount] = useState<Record<string, string>>({ INTERNAL: '', INTERNATIONAL: '' });
  const [dutyCurrency, setDutyCurrency] = useState<Record<string, string>>({ INTERNAL: 'INR', INTERNATIONAL: 'INR' });
  // Inline edit of a PENDING duty row (locked once Finance settles it).
  const [editingDutyId, setEditingDutyId] = useState<string | null>(null);
  const [editDutyAmount, setEditDutyAmount] = useState('');
  const [editDutyCurrency, setEditDutyCurrency] = useState('INR');

  const indentCurrency = detail?.currency || row?.currency || 'INR';

  const syncFrom = (d: any) => {
    if (!d) return;
    setDetail(d);
    setDocumentation(d.customsDocumentationNotes || '');
    setCha(d.customsDeliveryOrderChaNotes || '');
    setAwb(d.customsDutyAwb || '');
    setAgent(d.customsDutyShippingAgent || '');
    setBill(d.customsDutyShippingBill || '');
  };

  // Seed from the row on open, then pull a fresh single-indent copy so the
  // duty-payment list reflects any payments Finance made meanwhile.
  useEffect(() => {
    if (!isOpen || !row?.id) return;
    setEditingDutyId(null);
    syncFrom(row);
    client.get(`/indents/${row.id}`, { signal: abortSignal() }).then(res => syncFrom(res.data?.data || res.data)).catch(() => { /* keep snapshot */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, row?.id]);

  const refresh = async () => {
    if (!row?.id) return;
    try {
      const res = await client.get(`/indents/${row.id}`, { signal: abortSignal() });
      setDetail(res.data?.data || res.data);
    } catch { /* noop */ }
    onSaved?.();
    // Tell other open views (Finance queue, sidebar badges) to refetch — a
    // customs/duty change here must reflect on the Finance page too.
    window.dispatchEvent(new Event('indents-updated'));
  };

  const saveCustoms = async (key: string, payload: any, okMsg: string) => {
    if (!row?.id) return;
    setSavingKey(key);
    try {
      await client.patch(`/indents/${row.id}/customs`, payload);
      addToast(okMsg, 'success');
      if (key === 'cha') setChaOpen(false);
      await refresh();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Save failed'), 'error');
    } finally {
      setSavingKey(null);
    }
  };

  const addDuty = async (kind: 'INTERNAL' | 'INTERNATIONAL') => {
    const amt = Number(dutyAmount[kind]);
    if (!Number.isFinite(amt) || amt <= 0) { addToast('Enter a positive duty amount', 'error'); return; }
    setSavingKey(`duty-${kind}`);
    try {
      await client.post(`/indents/${row.id}/customs-duty`, { kind, amount: amt, currency: dutyCurrency[kind] || 'INR' });
      addToast(`${kind === 'INTERNAL' ? 'Other payments' : 'Customs duty'} raised — sent to Finance.`, 'success');
      setDutyAmount(s => ({ ...s, [kind]: '' }));
      await refresh();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to raise duty'), 'error');
    } finally {
      setSavingKey(null);
    }
  };

  const saveDutyEdit = async (p: any) => {
    const amt = Number(editDutyAmount);
    if (!Number.isFinite(amt) || amt <= 0) { addToast('Enter a positive amount', 'error'); return; }
    setSavingKey(`edit-${p.id}`);
    try {
      await client.patch(`/indents/${row.id}/customs-duty/${p.id}`, { amount: amt, currency: editDutyCurrency });
      addToast('Duty updated', 'success');
      setEditingDutyId(null);
      await refresh();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to update duty'), 'error');
    } finally {
      setSavingKey(null);
    }
  };

  if (!row) return null;
  const dutyPayments: any[] = detail?.customsDutyPayments || [];

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="2xl" title={`Customs clearance — ${row.serialNo}`}>
      <div className="space-y-5">
        <p className="text-xs text-muted">
          Indent in transit ({indentCurrency}). Record customs clearance below — the requester only sees a "Customs clearance" status, no detail.
        </p>

        {/* Documentation */}
        <section className="border border-line rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2"><FileText size={14} className="text-brand" /><h4 className="text-sm font-bold text-ink">Documentation</h4></div>
          <textarea value={documentation} onChange={e => setDocumentation(e.target.value)} rows={3}
            placeholder="Import documentation notes…"
            className="w-full border border-line rounded-md py-1.5 px-3 text-sm focus:border-brand outline-none" />
          <div className="flex justify-end mt-2">
            <button onClick={() => saveCustoms('doc', { documentationNotes: documentation }, 'Documentation saved')} disabled={savingKey === 'doc'}
              className="text-xs font-bold bg-ink text-card px-3 py-1.5 rounded-md hover:bg-black disabled:opacity-50">{savingKey === 'doc' ? 'Saving…' : 'Save'}</button>
          </div>
        </section>

        {/* Delivery Order → CHA slip (nested) */}
        <section className="border border-line rounded-lg p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2"><Ship size={14} className="text-brand" /><h4 className="text-sm font-bold text-ink">Delivery Order</h4></div>
            <button onClick={() => setChaOpen(true)} className="text-xs font-bold border border-brand text-brand-dark px-3 py-1.5 rounded-md hover:bg-brand/10">Open CHA slip</button>
          </div>
          {cha ? <p className="text-xs text-muted mt-2 whitespace-pre-wrap">{cha}</p> : <p className="text-[11px] italic text-faint mt-2">No CHA slip yet.</p>}
        </section>

        {/* Duty */}
        <section className="border border-line rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2"><Receipt size={14} className="text-brand" /><h4 className="text-sm font-bold text-ink">Duty</h4></div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            <label className="text-xs"><span className="block font-bold text-muted mb-1">Airway bill (AWB)</span><input value={awb} onChange={e => setAwb(e.target.value)} className="w-full border border-line rounded-md py-1.5 px-2 text-sm outline-none focus:border-brand" /></label>
            <label className="text-xs"><span className="block font-bold text-muted mb-1">Shipping agent</span><input value={agent} onChange={e => setAgent(e.target.value)} className="w-full border border-line rounded-md py-1.5 px-2 text-sm outline-none focus:border-brand" /></label>
            <label className="text-xs"><span className="block font-bold text-muted mb-1">Shipping bill</span><input value={bill} onChange={e => setBill(e.target.value)} className="w-full border border-line rounded-md py-1.5 px-2 text-sm outline-none focus:border-brand" /></label>
          </div>
          <div className="flex justify-end mt-2">
            <button onClick={() => saveCustoms('duty-detail', { dutyAwb: awb, dutyShippingAgent: agent, dutyShippingBill: bill }, 'Duty shipment detail saved')} disabled={savingKey === 'duty-detail'}
              className="text-xs font-bold bg-ink text-card px-3 py-1.5 rounded-md hover:bg-black disabled:opacity-50">{savingKey === 'duty-detail' ? 'Saving…' : 'Save detail'}</button>
          </div>

          <div className="mt-3 border-t border-line-soft pt-3 space-y-2">
            <p className="text-[11px] font-bold text-muted uppercase tracking-wider">Duty payments (Finance settles)</p>
            {dutyPayments.length === 0 && <p className="text-[11px] italic text-faint">No duty raised yet.</p>}
            {dutyPayments.map((p: any) => {
              const isEditing = editingDutyId === p.id;
              return (
                <div key={p.id} className="text-xs bg-surface border border-line rounded px-2 py-1.5 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    {isEditing ? (
                      <div className="flex items-center gap-1 flex-1 flex-wrap">
                        <span className="font-bold">{p.kind === 'INTERNAL' ? 'Other payments' : 'Customs duty'}</span>
                        <select value={editDutyCurrency} onChange={e => setEditDutyCurrency(e.target.value)} className="border border-line rounded py-0.5 px-1 text-xs bg-card">
                          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                        </select>
                        <input type="number" min={0} value={editDutyAmount} onChange={e => setEditDutyAmount(e.target.value)} className="w-28 border border-line rounded py-0.5 px-1 text-xs" />
                        <button onClick={() => saveDutyEdit(p)} disabled={savingKey === `edit-${p.id}`} className="font-bold text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded hover:bg-emerald-50 dark:bg-emerald-400/15 disabled:opacity-50">Save</button>
                        <button onClick={() => setEditingDutyId(null)} className="text-faint px-1.5 py-0.5 rounded hover:bg-hover">Cancel</button>
                      </div>
                    ) : (
                      <span><span className="font-bold">{p.kind === 'INTERNAL' ? 'Other payments' : 'Customs duty'}</span> · {p.currency} {Number(p.amount).toLocaleString('en-IN')}</span>
                    )}
                    {!isEditing && (
                      <div className="flex items-center gap-1.5 shrink-0">
                        {p.status !== 'PAID' && (
                          <button onClick={() => { setEditingDutyId(p.id); setEditDutyAmount(String(p.amount)); setEditDutyCurrency(p.currency || 'INR'); }}
                            title="Edit amount (until Finance settles)" className="text-muted hover:text-ink p-0.5 rounded hover:bg-hover"><Pencil size={12} /></button>
                        )}
                        <span className={`font-bold px-1.5 py-0.5 rounded ${p.status === 'PAID' ? 'bg-emerald-100 dark:bg-emerald-400/20 text-emerald-700 dark:text-emerald-300' : 'bg-amber-100 dark:bg-amber-400/20 text-amber-700 dark:text-amber-300'}`}>{p.status === 'PAID' ? 'Paid' : 'Pending'}</span>
                      </div>
                    )}
                  </div>
                  {/* Paid-row audit line — txn / payer / when / receipt. Hidden while editing. */}
                  {p.status === 'PAID' && !isEditing && (
                    <div className="text-[10px] text-muted flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-1">
                      {p.transactionId && <span>txn <span className="font-mono text-ink">{p.transactionId}</span></span>}
                      {p.paidBy?.name && <span>· by {p.paidBy.name}</span>}
                      {p.paidAt && <span>· {new Date(p.paidAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>}
                      {p.receiptPath && <ViewReceiptLink indentId={row.id} kind="customs-duty" paymentId={p.id} />}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
              {DUTY_KINDS.map(dk => (
                <div key={dk.kind} className="border border-line rounded p-2">
                  <p className="text-xs font-bold text-ink">{dk.label}</p>
                  <p className="text-[10px] text-faint mb-1">{dk.hint}</p>
                  <div className="flex gap-1">
                    <select value={dutyCurrency[dk.kind]} onChange={e => setDutyCurrency(s => ({ ...s, [dk.kind]: e.target.value }))}
                      title="Currency" className="border border-line rounded-md py-1 px-1 text-xs outline-none focus:border-brand bg-card">
                      {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <input type="number" min={0} value={dutyAmount[dk.kind]} onChange={e => setDutyAmount(s => ({ ...s, [dk.kind]: e.target.value }))}
                      placeholder="Amount" className="flex-1 border border-line rounded-md py-1 px-2 text-xs outline-none focus:border-brand" />
                    <button onClick={() => addDuty(dk.kind)} disabled={savingKey === `duty-${dk.kind}`}
                      className="text-xs font-bold bg-brand text-white px-2 py-1 rounded-full hover:bg-brand-dark disabled:opacity-50 inline-flex items-center gap-1"><Plus size={11} /> Raise</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </div>

      {/* CHA slip — nested modal opened from Delivery Order. */}
      <Modal isOpen={chaOpen} onClose={() => setChaOpen(false)} title={`Custom House Agent (CHA) — ${row.serialNo}`}>
        <div className="space-y-3">
          <p className="text-xs text-muted">CHA slip description — clearing-agent instructions / delivery-order detail.</p>
          <textarea value={cha} onChange={e => setCha(e.target.value)} rows={5}
            placeholder="Description…"
            className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setChaOpen(false)} className="text-xs font-bold text-muted px-3 py-1.5 rounded-md hover:bg-hover">Cancel</button>
            <button onClick={() => saveCustoms('cha', { deliveryOrderChaNotes: cha }, 'CHA slip saved')} disabled={savingKey === 'cha'}
              className="text-xs font-bold bg-ink text-card px-3 py-1.5 rounded-md hover:bg-black disabled:opacity-50">{savingKey === 'cha' ? 'Saving…' : 'Save CHA slip'}</button>
          </div>
        </div>
      </Modal>
    </Modal>
  );
};
