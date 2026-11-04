import { useState, useEffect } from 'react';
import { Plus, Minus } from 'lucide-react';
import { Modal } from '@/components/ui';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

interface AdjustStockItem {
  id: string;
  name: string;
  stock: number;
  unit?: string;
}

interface AdjustStockModalProps {
  isOpen: boolean;
  onClose: () => void;
  item: AdjustStockItem | null;
  onSuccess: () => void;
}

// Audited stock change: unlike the inline stock cell (a raw overwrite), this
// posts a signed delta + reason to /inventory/:id/adjust, which logs an
// ADJUSTMENT event. Use it for counted corrections, breakage, found stock, etc.
export const AdjustStockModal = ({ isOpen, onClose, item, onSuccess }: AdjustStockModalProps) => {
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const { addToast } = useToast();

  useEffect(() => {
    if (isOpen) {
      setDirection('add');
      setQty('');
      setReason('');
      setError('');
    }
  }, [isOpen]);

  const current = item?.stock ?? 0;
  // parseFloat, not parseInt — stock is Decimal(14,2), so fractional corrections
  // (0.5 m of wire, 0.25 kg) are valid. parseInt silently truncated "2.75" → 2.
  const n = Math.abs(parseFloat(qty)) || 0;
  const quantityChange = direction === 'add' ? n : -n;
  const newStock = current + quantityChange;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!item) return;
    if (n <= 0) { setError('Enter a quantity greater than zero.'); return; }
    if (newStock < 0) { setError(`Can't remove ${n} — only ${current} in stock.`); return; }
    if (!reason.trim()) { setError('A reason is required for an audited adjustment.'); return; }

    setLoading(true);
    try {
      await client.post(`/inventory/${item.id}/adjust`, { quantityChange, reason: reason.trim() });
      addToast(`Stock adjusted: ${current} → ${newStock}.`, 'success');
      onSuccess();
      onClose();
    } catch (err: any) {
      setError(extractErrorMessage(err, 'Failed to adjust stock.'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Adjust Stock">
      <form noValidate onSubmit={handleSubmit} className="space-y-4">
        <div className="bg-surface border border-line rounded-lg p-3">
          <p className="text-sm font-semibold text-ink">{item?.name || '-'}</p>
          <p className="text-xs text-muted mt-0.5">
            Current stock: <span className="font-bold text-ink">{current}</span>{item?.unit ? ` ${item.unit}` : ''}
          </p>
        </div>

        {/* Direction toggle */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDirection('add')}
            className={`flex items-center justify-center gap-2 py-2 text-sm font-semibold rounded-lg border transition-colors ${
              direction === 'add'
                ? 'bg-green-50 dark:bg-green-400/15 text-green-700 dark:text-green-300 border-green-300 dark:border-green-400/30'
                : 'bg-card text-muted border-line hover:bg-surface'
            }`}
          >
            <Plus className="w-4 h-4" /> Add
          </button>
          <button
            type="button"
            onClick={() => setDirection('remove')}
            className={`flex items-center justify-center gap-2 py-2 text-sm font-semibold rounded-lg border transition-colors ${
              direction === 'remove'
                ? 'bg-red-50 dark:bg-red-400/15 text-red-700 dark:text-red-300 border-red-300 dark:border-red-400/30'
                : 'bg-card text-muted border-line hover:bg-surface'
            }`}
          >
            <Minus className="w-4 h-4" /> Remove
          </button>
        </div>

        <div>
          <label className="block text-sm font-medium text-ink mb-1">Quantity</label>
          <input
            type="number"
            min={0}
            step="any"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="0"
            className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand"
            autoFocus
          />
        </div>

        {n > 0 && (
          <p className="text-xs text-muted">
            New stock:{' '}
            <span className={`font-bold ${newStock < 0 ? 'text-red-700 dark:text-red-300' : 'text-ink'}`}>{newStock}</span>
            {' '}<span className="text-faint">({direction === 'add' ? '+' : '-'}{n})</span>
          </p>
        )}

        <div>
          <label className="block text-sm font-medium text-ink mb-1">Reason <span className="text-red-700 dark:text-red-300">*</span></label>
          <textarea
            maxLength={500}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. physical count correction, breakage, found stock"
            rows={2}
            className="w-full px-3 py-2 border border-line rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/50 focus:border-brand resize-none"
          />
        </div>

        {error && <p className="text-sm text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-400/15 px-3 py-2 rounded-lg">{error}</p>}

        <div className="flex justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted border border-line rounded-lg hover:bg-surface transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-sm font-semibold text-white bg-brand rounded-full hover:bg-brand-600 transition-colors disabled:opacity-50"
          >
            {loading ? 'Saving...' : 'Save Adjustment'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
