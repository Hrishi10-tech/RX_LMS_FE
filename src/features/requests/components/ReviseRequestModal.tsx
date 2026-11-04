import { useEffect, useState } from 'react';
import { Modal, NumberInput } from '@/components/ui';
import { client } from '@/api';
import { cachedGet, extractErrorMessage } from '@/lib';
import { useToast } from '@/context/ToastContext';
import { Nature, DurationUnit } from '@/types';
import { RequestAttachment } from './RequestAttachment';

interface Props {
  /** Request id to edit. null closes the modal. */
  requestId: string | null;
  /** Current on-hand stock for the item (from the list row) — drives the qty
   *  cap hint. Optional: the server re-checks stock regardless. */
  stock?: number;
  onClose: () => void;
  /** Called after a successful save so the caller can refetch its list. */
  onSaved: () => void;
}

/**
 * Requester-facing edit of a not-yet-issued component request (PENDING /
 * APPROVED). Quantity is the headline edit (the duplicate-guard routes users
 * here instead of letting them re-raise), but project / nature / duration are
 * editable too — item + department stay locked to the original. We send only
 * the fields that actually changed so the server leaves the due-date untouched
 * on a qty-only edit (see RequestsService.reviseRequest). A gated category
 * drops the request back to PENDING for manager re-approval; inventory + the
 * requester are notified server-side.
 */
export const ReviseRequestModal = ({ requestId, stock, onClose, onSaved }: Props) => {
  const { addToast } = useToast();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // The fetched authoritative snapshot we diff against on save.
  const [orig, setOrig] = useState<any>(null);
  const [projects, setProjects] = useState<any[]>([]);

  const [qty, setQty] = useState<number>(1);
  const [projectId, setProjectId] = useState<string>('__OTHERS__');
  const [nature, setNature] = useState<Nature>(Nature.TEMPORARY);
  const [durationValue, setDurationValue] = useState<number>(1);
  const [durationUnit, setDurationUnit] = useState<DurationUnit>(DurationUnit.DAYS);

  // Pull the authoritative current values on open. The list row is trimmed
  // (no projectId), so we read the detail endpoint — it also future-proofs the
  // pre-fill if more editable fields get added.
  useEffect(() => {
    if (!requestId) { setOrig(null); return; }
    let cancelled = false;
    setLoading(true);
    Promise.all([
      client.get(`/requests/${requestId}`),
      cachedGet<any>('/projects').catch(() => []),
    ])
      .then(([detailRes, projRes]) => {
        if (cancelled) return;
        const d = detailRes.data?.data ?? detailRes.data;
        setOrig(d);
        setProjects((projRes as any)?.data || projRes || []);
        setQty(Number(d?.qtyRequested ?? 1));
        setNature((d?.nature as Nature) ?? Nature.TEMPORARY);
        setDurationValue(Number(d?.durationValue) > 0 ? Number(d.durationValue) : 1);
        setDurationUnit((d?.durationUnit as DurationUnit) ?? DurationUnit.DAYS);
        // Adopt the stored project only if it's still in the active list,
        // otherwise fall back to "Others" so the <select> isn't broken.
        const pid = d?.project?.id ?? null;
        if (pid && ((projRes as any)?.data || projRes || []).some((p: any) => p.id === pid)) {
          setProjectId(pid);
        } else {
          setProjectId('__OTHERS__');
        }
      })
      .catch((e) => { if (!cancelled) addToast(extractErrorMessage(e, 'Could not load this request.'), 'error'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loads the request only when requestId changes; addToast (toast context) is used only in the error branch and must not retrigger the fetch
  }, [requestId]);

  const handleSave = async () => {
    if (!orig || !requestId) return;

    // Diff against the snapshot — only changed fields go up, so a qty-only
    // edit doesn't slide the due date (the server recomputes it solely when
    // nature/duration are present in the body).
    const payload: any = {};
    if (qty !== Number(orig.qtyRequested)) payload.qtyRequested = qty;

    const finalProjectId = projectId === '__OTHERS__' ? null : projectId;
    const origProjectId = orig.project?.id ?? null;
    if (finalProjectId !== origProjectId) payload.projectId = finalProjectId;

    const natureChanged = nature !== orig.nature;
    if (natureChanged) payload.nature = nature;
    if (nature === Nature.TEMPORARY) {
      // Carry duration when it changed OR when nature just flipped to
      // TEMPORARY (the server needs a value+unit to compute the new due date).
      if (natureChanged || durationValue !== Number(orig.durationValue)) payload.durationValue = durationValue;
      if (natureChanged || durationUnit !== orig.durationUnit) payload.durationUnit = durationUnit;
    }

    if (Object.keys(payload).length === 0) {
      addToast('Nothing changed.', 'info');
      onClose();
      return;
    }

    setSaving(true);
    try {
      await client.patch(`/requests/${requestId}/revise`, payload);
      addToast('Request updated.', 'success');
      onSaved();
      onClose();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Failed to update request'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const unit = orig?.inventoryItem?.unit || '';

  return (
    <Modal isOpen={!!requestId} onClose={onClose} title={`Edit Request — ${orig?.serialNo || ''}`}>
      {loading || !orig ? (
        <div className="py-10 text-center text-faint">Loading…</div>
      ) : (
        <div className="space-y-4">
          {/* Locked context — item + department aren't editable here. */}
          <div className="bg-surface border border-line-soft rounded-md p-3 text-sm">
            <p className="font-bold text-ink">{orig.inventoryItem?.name || 'Component'}</p>
            <p className="text-xs text-faint mt-0.5">
              {orig.department?.name || '—'}
              {typeof stock === 'number' && <> · {stock} {unit} in stock</>}
            </p>
          </div>

          {orig.status === 'APPROVED' && (
            <p className="text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-400/15 border border-amber-200 dark:border-amber-400/30 rounded-md px-3 py-2">
              This request was already approved. Editing it sends it back to your manager for re-approval (if the category needs it).
            </p>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-muted mb-1">Quantity *</label>
              <NumberInput
                min={1}
                max={typeof stock === 'number' ? stock : undefined}
                value={qty}
                onChange={setQty}
                className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-bold text-muted mb-1">Project</label>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}
                className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none">
                {projects.filter((p: any) => p.isActive !== false).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
                <option value="__OTHERS__">General / Others (not project-specific)</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-bold text-muted mb-1">Nature</label>
              <select value={nature} onChange={(e) => setNature(e.target.value as Nature)}
                className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none">
                <option value={Nature.TEMPORARY}>Temporary</option>
                <option value={Nature.PERMANENT}>Permanent</option>
              </select>
            </div>
            {nature === Nature.TEMPORARY && (
              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="block text-sm font-bold text-muted mb-1">Duration *</label>
                  <NumberInput
                    min={1}
                    value={durationValue}
                    onChange={setDurationValue}
                    integer
                    className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-sm font-bold text-muted mb-1">Unit</label>
                  <select value={durationUnit} onChange={(e) => setDurationUnit(e.target.value as DurationUnit)}
                    className="w-full border border-line rounded-md py-2 px-3 text-sm focus:border-brand outline-none">
                    <option value={DurationUnit.MINUTES}>Minutes</option>
                    <option value={DurationUnit.HOURS}>Hours</option>
                    <option value={DurationUnit.DAYS}>Days</option>
                    <option value={DurationUnit.WEEKS}>Weeks</option>
                    <option value={DurationUnit.MONTHS}>Months</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          {/* The requester's own photo of what they mean — a damaged part, the
              label on the component, the empty shelf. Uploaded immediately
              rather than on Save, because it's a file, not a form field. */}
          {requestId && (
            <div className="pt-3 border-t border-line-soft">
              <RequestAttachment
                requestId={requestId}
                hasAttachment={!!orig?.attachmentMime}
                canAttach
              />
            </div>
          )}

          <div className="flex justify-end gap-2 pt-4 border-t border-line-soft">
            <button type="button" onClick={onClose}
              className="px-4 py-2 rounded-md font-bold text-sm text-muted hover:bg-hover">
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={saving}
              className="bg-brand text-white px-6 py-2 rounded-full font-bold text-sm hover:bg-brand-dark disabled:opacity-50">
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};
