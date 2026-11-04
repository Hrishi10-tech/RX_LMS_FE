import { Modal } from '@/components/ui';

const CONDITION_OPTIONS = [
  { value: 'RETURNED_GOOD', label: 'Good Condition' },
  { value: 'RETURNED_DAMAGED', label: 'Damaged' },
  { value: 'Tested', label: 'Tested / Working' },
  { value: 'Used', label: 'Used' },
];

interface ReturnDetailsModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedRequest: string;
  onSelectRequest: (id: string) => void;
  inUseRequests: any[];
  returnCondition: string;
  onSetReturnCondition: (condition: string) => void;
  returnNotes: string;
  onSetReturnNotes: (notes: string) => void;
  returnedById: string;
  onSetReturnedById: (id: string) => void;
  allUsers: any[];
  isSubmitting: boolean;
  onSubmit: () => void;
}

export const ReturnDetailsModal = ({
  isOpen,
  onClose,
  selectedRequest,
  onSelectRequest,
  inUseRequests,
  returnCondition,
  onSetReturnCondition,
  returnNotes,
  onSetReturnNotes,
  returnedById,
  onSetReturnedById,
  allUsers,
  isSubmitting,
  onSubmit,
}: ReturnDetailsModalProps) => {
  // What the HOLDER said about the item when they started the return. The
  // clerk standing at the desk is the one who decides what actually gets
  // recorded, but they were being asked to decide without ever being shown the
  // declaration — it was accepted by the form, dropped by the API, and never
  // reached this screen.
  const declared = inUseRequests.find((r: any) => r.id === selectedRequest)?.returnCondition;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="File a Return">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Select Request to Return</label>
          <select
            value={selectedRequest}
            onChange={(e) => onSelectRequest(e.target.value)}
            className="w-full px-3 py-2 border border-line rounded-md focus:border-brand focus:ring-brand"
          >
            <option value="">-- Select an active request --</option>
            {inUseRequests.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.serialNo} — {r.inventoryItem?.name} (x{r.qtyRequested}) — {r.createdBy?.name}
              </option>
            ))}
          </select>
          {inUseRequests.length === 0 && <p className="text-xs text-faint mt-1">No items are currently issued out.</p>}
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Returned By (Physical Handover)</label>
          <select
            value={returnedById}
            onChange={(e) => onSetReturnedById(e.target.value)}
            className="w-full px-3 py-2 border border-line rounded-md focus:border-brand focus:ring-brand"
          >
            <option value="">-- System Default --</option>
            {allUsers.map((u: any) => (
              <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
            ))}
          </select>
          <p className="text-xs text-faint mt-1">Leave empty to use the current user.</p>
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Condition</label>
          {declared && (
            <p className="mb-2 text-xs text-muted bg-brand-100 border border-brand-200 rounded-md px-2.5 py-1.5">
              The holder declared this as <span className="font-bold text-ink">{declared}</span> when they started the return. Record what you actually find.
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            {CONDITION_OPTIONS.map(opt => (
              <button key={opt.value} onClick={() => onSetReturnCondition(opt.value)}
                className={`p-3 text-sm font-bold rounded-lg border transition-colors text-left ${returnCondition === opt.value ? 'border-brand bg-brand/5 text-brand' : 'border-line text-muted hover:border-brand/50'}`}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="block text-sm font-bold text-muted mb-1">Notes (optional)</label>
          <textarea
            value={returnNotes}
            onChange={(e) => onSetReturnNotes(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 border border-line rounded-md focus:border-brand focus:ring-brand resize-none"
            placeholder="e.g. All components tested and working, display cracked..."
          />
        </div>
        <div className="flex justify-end gap-3 pt-4 border-t border-line-soft">
          <button onClick={onClose} className="px-4 py-2 text-muted font-bold rounded-md hover:bg-hover">Cancel</button>
          <button
            onClick={onSubmit}
            disabled={!selectedRequest || isSubmitting}
            className="px-5 py-2 bg-brand text-white font-bold rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50"
          >
            {isSubmitting ? 'Processing...' : 'Submit Return'}
          </button>
        </div>
      </div>
    </Modal>
  );
};
