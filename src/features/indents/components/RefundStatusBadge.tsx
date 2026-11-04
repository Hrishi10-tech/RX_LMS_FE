// Color-coded chip for an indent's refundStatus. Used wherever procurement
// or finance scans a list/row and needs to know "is money still owed to us?"
// at a glance. Partial refunds (received < paid) flag an amber shortfall
// inline so the chip itself is enough — no drill-in required.

import { ReactNode } from 'react';

interface Props {
  status: 'NONE' | 'PENDING' | 'RECEIVED' | 'WRITE_OFF' | 'DISPUTED' | string | null | undefined;
  // Original paid amount + actually-received amount, both optional. When both
  // are present and the indent is RECEIVED but received < paid, the chip
  // appends a "(₹X short)" hint in amber so the shortfall doesn't hide.
  paidAmount?: number | string | null;
  receivedAmount?: number | string | null;
  currency?: string;
  size?: 'sm' | 'md';
}

const STYLES: Record<string, string> = {
  PENDING:   'bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-200 border-amber-200 dark:border-amber-400/30',
  RECEIVED:  'bg-emerald-100 dark:bg-emerald-400/20 text-emerald-800 dark:text-emerald-200 border-emerald-200 dark:border-emerald-400/30',
  WRITE_OFF: 'bg-line text-secondary border-line',
  DISPUTED:  'bg-red-100 dark:bg-red-400/20 text-red-800 dark:text-red-200 border-red-200 dark:border-red-400/30',
};

const LABELS: Record<string, string> = {
  PENDING:   'Refund pending',
  RECEIVED:  'Refund received',
  WRITE_OFF: 'Written off',
  DISPUTED:  'Refund disputed',
};

export function RefundStatusBadge({ status, paidAmount, receivedAmount, currency = 'INR', size = 'sm' }: Props): ReactNode {
  if (!status || status === 'NONE') return null;
  const cls = STYLES[status] || 'bg-hover text-secondary border-line';
  const label = LABELS[status] || status;
  const px = size === 'md' ? 'px-2 py-1 text-[11px]' : 'px-1.5 py-0.5 text-[10px]';

  // Partial-refund flag — only relevant on RECEIVED with both amounts known.
  const paid = Number(paidAmount ?? 0);
  const recv = Number(receivedAmount ?? 0);
  const isPartial = status === 'RECEIVED' && paid > 0 && recv > 0 && recv < paid;
  const short = paid - recv;

  return (
    <span className="inline-flex items-center gap-1 flex-wrap">
      <span className={`inline-block font-bold uppercase tracking-wide border rounded ${px} ${cls}`}>
        {label}
      </span>
      {isPartial && (
        <span className={`inline-block font-bold uppercase tracking-wide border rounded ${px} bg-amber-50 dark:bg-amber-400/15 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-400/30`}
              title={`Vendor kept ${currency} ${short.toLocaleString('en-IN')} of the original payment`}>
          {currency} {short.toLocaleString('en-IN')} short
        </span>
      )}
    </span>
  );
}
