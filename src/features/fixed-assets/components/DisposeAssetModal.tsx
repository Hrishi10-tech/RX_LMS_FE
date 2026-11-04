import { useState } from 'react';
import { extractErrorMessage } from '@/lib';
import { Modal } from '@/components/ui';
import { useToast } from '@/context/ToastContext';
import { useConfirm } from '@/context/ConfirmContext';
import { fmtINR } from '@/utils/number';
import { depreciationApi } from '../services/depreciation.api';
import { AlertTriangle } from 'lucide-react';

interface Props {
  asset: any | null;
  onClose: () => void;
  onDisposed: () => void;
}

/**
 * Dispose of an asset: sold, scrapped or written off.
 *
 * A dedicated action rather than editing the condition to DISPOSED, because
 * that did none of the things disposal actually means: depreciation kept
 * running on the asset for years afterwards, and the gain or loss against book
 * value — the number Finance has to report — was never computed at all.
 *
 * The server brings depreciation up to the disposal month before measuring, so
 * the gain is taken against a current book value rather than a stale one, and
 * it snapshots that value so the figure can't drift later.
 */
export const DisposeAssetModal = ({ asset, onClose, onDisposed }: Props) => {
  const { addToast } = useToast();
  const confirm = useConfirm();
  const [proceeds, setProceeds] = useState('');
  const [disposedOn, setDisposedOn] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!asset) return null;

  const bookValue = Number(asset.currentValue ?? asset.purchaseValue ?? 0);
  const proceedsNum = proceeds === '' ? 0 : Number(proceeds);
  // Indicative only — the server recomputes against the book value AFTER it
  // brings depreciation up to date, so the final figure can differ. Said so
  // below rather than showing a number that turns out to be wrong.
  const indicative = proceedsNum - bookValue;

  const submit = async () => {
    if (proceeds !== '' && (Number.isNaN(proceedsNum) || proceedsNum < 0)) {
      addToast('Proceeds must be zero or more. Use 0 if it was scrapped.', 'error');
      return;
    }
    if (!await confirm({
      title: `Dispose of ${asset.assetTag}?`,
      message: `${asset.name} stops depreciating from this date and leaves the active register. This is recorded, not deleted.`,
      confirmLabel: 'Dispose',
      tone: 'danger',
    })) return;
    setSubmitting(true);
    try {
      const r = await depreciationApi.dispose(asset.id, {
        proceeds: proceeds === '' ? 0 : proceedsNum,
        // Optional — the server uses today. An emptied box is not a date, and
        // sending "" came back as "disposedOn must be a date".
        disposedOn: disposedOn || undefined,
        note: note.trim() || null,
      });
      const verdict = r?.outcome === 'GAIN' ? 'gain' : r?.outcome === 'LOSS' ? 'loss' : 'no gain or loss';
      addToast(
        `${asset.assetTag} disposed — ${verdict} of ${fmtINR(Math.abs(r?.gainLoss ?? 0), { nullish: '₹0' })} ` +
        `against a book value of ${fmtINR(r?.bookValueAtDisposal ?? 0, { nullish: '₹0' })}.`,
        'success',
      );
      onDisposed();
      onClose();
    } catch (e: any) {
      addToast(extractErrorMessage(e, 'Could not dispose of this asset'), 'error');
    }
    setSubmitting(false);
  };

  return (
    <Modal isOpen={!!asset} onClose={onClose} title="Dispose of asset" size="md">
      <div className="space-y-4">
        <div className="rounded-lg bg-surface px-3 py-2">
          <p className="text-sm font-bold text-ink">{asset.assetTag} — {asset.name}</p>
          <p className="text-xs text-muted mt-0.5">
            Cost {fmtINR(Number(asset.purchaseValue ?? 0), { nullish: '₹0' })} ·
            Book value now {fmtINR(bookValue, { nullish: '₹0' })}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="dispose-proceeds" className="block text-[10px] font-bold uppercase text-muted mb-1">
              Sale proceeds
            </label>
            <input
              id="dispose-proceeds"
              type="number"
              min={0}
              step="0.01"
              value={proceeds}
              onChange={(e) => setProceeds(e.target.value)}
              placeholder="0 if scrapped"
              className="w-full rounded border border-line px-2 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="dispose-date" className="block text-[10px] font-bold uppercase text-muted mb-1">
              Disposed on
            </label>
            <input
              id="dispose-date"
              type="date"
              value={disposedOn}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setDisposedOn(e.target.value)}
              className="w-full rounded border border-line px-2 py-1.5 text-sm"
            />
          </div>
        </div>

        <div>
          <label htmlFor="dispose-note" className="block text-[10px] font-bold uppercase text-muted mb-1">
            Note
          </label>
          <input
            id="dispose-note"
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Sold to X / scrapped, beyond repair"
            maxLength={500}
            className="w-full rounded border border-line px-2 py-1.5 text-sm"
          />
        </div>

        <div className="rounded-lg border border-amber-200 dark:border-amber-400/30 bg-amber-50 dark:bg-amber-400/15 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          <p className="flex items-start gap-1.5">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>
              Indicatively a <b>{indicative >= 0 ? 'gain' : 'loss'} of {fmtINR(Math.abs(indicative), { nullish: '₹0' })}</b>.
              The final figure is computed after depreciation is brought up to the disposal month, so it may
              differ slightly — the exact number is recorded against the asset.
            </span>
          </p>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} disabled={submitting} className="rounded-md border border-line px-3 py-1.5 text-xs font-bold text-muted hover:bg-surface disabled:opacity-50">
            Cancel
          </button>
          <button onClick={submit} disabled={submitting} className="rounded-full bg-brand px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-dark disabled:opacity-50">
            {submitting ? 'Disposing…' : 'Dispose'}
          </button>
        </div>
      </div>
    </Modal>
  );
};
