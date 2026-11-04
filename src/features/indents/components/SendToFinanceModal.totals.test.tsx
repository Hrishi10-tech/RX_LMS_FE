import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/**
 * Send to Finance shows, per vendor, what Finance will be asked to pay. The
 * vendor order the backend opens is subtotal + GST + shipping (once per
 * vendor), so qty × price alone under-stated every vendor with either.
 */
vi.mock('@/api', () => ({ client: { post: vi.fn() } }));
vi.mock('@/context/ToastContext', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/lib', () => ({ extractErrorMessage: (e: any) => String(e) }));

import { SendToFinanceModal } from './SendToFinanceModal';

const row = (vendorOrders: any[] = []) => ({
  id: 'i1', serialNo: 'IND-T', currency: 'INR', grandTotal: 1920, department: { name: 'Lab' },
  items: [{ id: 'L1', name: 'Line one', unit: 'NOS' }, { id: 'L2', name: 'Line two', unit: 'NOS' }],
  vendorAllocations: [
    { id: 'a1', indentItemId: 'L1', vendorName: 'Robu', allocatedQty: 1, unitPrice: 1000, currency: 'INR', gstPercentage: 18, shippingCost: 150, vendorOrderId: null },
    { id: 'a2', indentItemId: 'L2', vendorName: 'Robu ', allocatedQty: 1, unitPrice: 500, currency: 'INR', gstPercentage: 18, shippingCost: 150, vendorOrderId: null },
  ],
  vendorOrders,
});

describe('SendToFinanceModal amounts', () => {
  it('shows each vendor GST- and shipping-inclusive, one vendor for trimmed names', () => {
    render(<SendToFinanceModal row={row()} onClose={() => {}} onSent={() => {}} />);
    // One vendor block, not "Robu" and "Robu ".
    expect(screen.getAllByText('Robu')).toHaveLength(2); // summary + vendor block
    expect(screen.getAllByText(/INR 1,920/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('incl. GST & shipping').length).toBeGreaterThanOrEqual(1);
  });

  it('adds no shipping when a live order of the vendor already carries it', () => {
    render(<SendToFinanceModal row={row([{ vendorName: 'Robu', currency: 'INR', status: 'PAID', shippingAmount: 150 }])} onClose={() => {}} onSent={() => {}} />);
    // 1500 + 270 GST, no second shipping.
    expect(screen.getAllByText(/INR 1,770/).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/INR 1,920/)).toBeNull();
  });
});
