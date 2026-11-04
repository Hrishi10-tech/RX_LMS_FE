import { useState, FormEvent } from 'react';
import { useToast } from '../../context';
import { extractErrorMessage } from '@/lib';
import { fmtDateTime } from '../../utils/date';
import { NumberInput } from '../ui';
import { DURATION_UNITS, durationUnitLabel } from '@/utils/duration';

interface ExtensionFormProps {
  requestDetails: any;
  onSubmit: (data: any) => Promise<void>;
  isLoading: boolean;
}

export const ExtensionForm = ({ requestDetails, onSubmit, isLoading }: ExtensionFormProps) => {
  const { addToast } = useToast();
  const [durationValue, setDurationValue] = useState<number>(1);
  const [durationUnit, setDurationUnit] = useState<string>('DAYS');
  const [reason, setReason] = useState<string>('');

  // Its own busy flag: both callers pass isLoading={false}, so a double-click
  // posted two extension requests.
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!Number.isInteger(Number(durationValue)) || Number(durationValue) < 1) { addToast('Extend by at least 1.', 'error'); return; }
    if (!reason.trim()) { addToast('Say why you need the extension.', 'error'); return; }
    setSubmitting(true);
    try {
      // Map the form's internal field names onto the CreateExtensionDto shape the
      // backend expects ({ newNature, newDurationValue, newDurationUnit, reason }).
      // Extensions only ever adjust the duration — the backend forbids converting
      // TEMPORARY → PERMANENT here — so we carry the request's existing nature
      // through (defaulting to TEMPORARY for the overdue/in-use items this serves).
      await onSubmit({
        newNature: requestDetails?.nature ?? 'TEMPORARY',
        newDurationValue: durationValue,
        newDurationUnit: durationUnit,
        reason,
      });
      addToast('Extension requested successfully!', 'success');
    } catch (error: any) {
      addToast(extractErrorMessage(error, 'Failed to request extension'), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form noValidate onSubmit={handleSubmit} className="space-y-4">
      <div className="bg-blue-50 dark:bg-blue-400/15 p-4 rounded-md border border-blue-100 dark:border-blue-400/25 text-sm mb-4">
         <p className="font-semibold text-blue-900 dark:text-blue-200 mb-1">Extending: {requestDetails?.inventoryItem?.name} ({requestDetails?.serialNo})</p>
         <p className="text-[#3B82F6]">Current Due Date: {fmtDateTime(requestDetails?.dueDate)}</p>
      </div>

      <div className="flex space-x-2">
        <div className="w-1/2">
          <label className="block text-sm font-medium text-ink">Extend By (Duration)</label>
          <NumberInput
            min={1}
            required
            value={durationValue}
            onChange={setDurationValue}
            integer
            className="mt-1 block w-full border border-line rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
          />
        </div>
        <div className="w-1/2">
          <label className="block text-sm font-medium text-ink">Unit</label>
          <select value={durationUnit} onChange={(e) => setDurationUnit(e.target.value)}
            className="mt-1 block w-full border border-line rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 sm:text-sm">
            {DURATION_UNITS.map((u) => (
              <option key={u} value={u}>{durationUnitLabel(u, Number(durationValue), { capitalise: true })}</option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-ink">Reason for Extension</label>
        <textarea required value={reason} onChange={(e) => setReason(e.target.value)} rows={3}
           className="mt-1 block w-full border border-line rounded-md py-2 px-3 focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
           placeholder="Explain why you need this extension..." />
      </div>

      <div className="flex justify-end pt-4">
        <button type="submit" disabled={isLoading || submitting}
          className="bg-brand text-white px-4 py-2 rounded-full shadow-sm text-sm font-medium hover:bg-brand-dark disabled:opacity-50">
          {isLoading || submitting ? 'Submitting...' : 'Request Extension'}
        </button>
      </div>
    </form>
  );
};
