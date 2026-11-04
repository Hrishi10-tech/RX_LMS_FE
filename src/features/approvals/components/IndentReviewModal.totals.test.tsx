import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

/**
 * The approver's total must be the number they are signing for.
 *
 * The backend stores an indent's grandTotal as each vendor's subtotal + GST +
 * shipping (shipping once per vendor), and the CEO check and Finance read that
 * figure. The review modal summed qty × price alone, so the approver saw
 * ₹1,500 on an indent the system held at ₹1,920.
 */
vi.mock('@/context', () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));
vi.mock('@/hooks', () => ({
  useClientPagination: (rows: any[], pageSize: number) => ({
    page: 1, pageSize, totalPages: 1, pageRows: rows, setPage: () => {},
  }),
}));

import { IndentReviewModal } from './IndentReviewModal';

const alloc = (over: Record<string, unknown>) => ({
  id: 'a', indentItemId: 'L1', vendorName: 'Robu', allocatedQty: 1, unitPrice: 1000, total: 1000,
  currency: 'INR', gstPercentage: 18, shippingCost: 150, isAlternative: false, isDiscarded: false,
  ...over,
});

const indent = (vendorAllocations: any[]) => ({
  id: 'i1', serialNo: 'IND-T', status: 'PENDING', currency: 'INR', grandTotal: 1920,
  items: [
    { id: 'L1', name: 'Line one', qty: 1, unitAmount: 1000, currency: 'INR' },
    { id: 'L2', name: 'Line two', qty: 1, unitAmount: 500, currency: 'INR' },
  ],
  quotations: [{ id: 'q1', version: 2, status: 'SUBMITTED', items: [
    { indentItemId: 'L1', qty: 1, unitAmount: 1000, total: 1000 },
    { indentItemId: 'L2', qty: 1, unitAmount: 500, total: 500 },
  ] }],
  vendorAllocations,
});

describe('IndentReviewModal firm total', () => {
  it('includes GST and shipping once per vendor, labelled so', () => {
    render(<IndentReviewModal indent={indent([
      alloc({ id: 'a1' }),
      // A second line from the same vendor, typed with a stray space.
      alloc({ id: 'a2', indentItemId: 'L2', vendorName: 'Robu ', unitPrice: 500, total: 500 }),
    ])} onClose={() => {}} />);
    // 1000 + 500 + 18% GST (270) + 150 shipping once = 1920.
    const total = screen.getByText('Firm quote total').parentElement!;
    expect(total).toHaveTextContent('INR 1,920');
    expect(total).toHaveTextContent('incl. GST & shipping');
    // Shipping figure appears on the vendor's first row only.
    expect(screen.getAllByText('₹150')).toHaveLength(1);
    expect(screen.getAllByText('once, above')).toHaveLength(1);
    // Per-vendor breakdown adds up by hand.
    const perVendor = screen.getByLabelText('Per-vendor totals');
    expect(within(perVendor).getByText(/\+ shipping ₹150/)).toBeInTheDocument();
  });

  it('leaves an unpicked option out of the total', () => {
    render(<IndentReviewModal indent={indent([
      alloc({ id: 'a1' }),
      alloc({ id: 'a2', indentItemId: 'L2', unitPrice: 500, total: 500 }),
      alloc({ id: 'opt', indentItemId: 'L2', vendorName: 'Alt', unitPrice: 400, total: 400, shippingCost: 999, isAlternative: true }),
    ])} onClose={() => {}} />);
    expect(screen.getByText('Firm quote total').parentElement!).toHaveTextContent('INR 1,920');
  });

  it('falls back to the quotation lines when no vendor is committed', () => {
    render(<IndentReviewModal indent={indent([])} onClose={() => {}} />);
    const total = screen.getByText('Firm quote total').parentElement!;
    expect(total).toHaveTextContent('INR 1,500');
    expect(total).not.toHaveTextContent('incl.');
  });
});
