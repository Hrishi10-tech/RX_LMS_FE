import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

/**
 * A vendor quoted ONLY as an option still needs its GST and shipping typed in
 * while procurement can edit: if the admin picks it at review, the backend
 * totals it from what is stored on that row, and by then nobody can change it.
 * The section listed committed vendors only, so such a vendor was bought at 0%
 * and ₹0 shipping. Options are shown (marked) but never summed.
 */
vi.mock('@/lib/fx', () => ({ useFxMeta: () => ({ source: 'static' }) }));
vi.mock('@/context/ToastContext', () => ({ useToast: () => ({ addToast: vi.fn() }) }));
vi.mock('@/lib', () => ({ extractErrorMessage: (e: any) => String(e) }));
vi.mock('@/features/vendors', () => ({ findSimilarVendor: () => null }));
vi.mock('@/components/ui', () => ({
  NumberInput: (p: any) => (
    <input type="number" aria-label={p['aria-label']} value={p.value ?? 0}
      onChange={(e) => p.onChange?.(Number(e.target.value))} />
  ),
}));

import { VendorAllocationPanel } from './VendorAllocationPanel';

const props = (onSetVendorShipping = vi.fn()) => ({
  selectedIndent: { id: 'i1', status: 'QUOTATION_IN_PROGRESS' },
  indentItems: [{ id: 'L1', name: 'Line one', qty: 1, unit: 'NOS', unitAmount: 1000, currency: 'INR' }],
  allocations: [
    { indentItemId: 'L1', vendorName: 'Robu', allocatedQty: 1, unitPrice: 1000, currency: 'INR', gstPercentage: 18, shippingCost: 150 },
    { indentItemId: 'L1', vendorName: 'Alt', allocatedQty: 1, unitPrice: 900, currency: 'INR', isAlternative: true, shippingCost: 400 },
  ],
  knownVendors: [],
  onAddAllocationRow: vi.fn(),
  onUpdateAllocation: vi.fn(),
  onSetVendorGst: vi.fn(),
  onSetVendorShipping,
  onRemoveAllocation: vi.fn(),
  onSaveAllocations: vi.fn(),
});

describe('VendorAllocationPanel — GST & shipping for option-only vendors', () => {
  it('offers the inputs for an option-only vendor, marked as an option', () => {
    const onShip = vi.fn();
    render(<VendorAllocationPanel {...(props(onShip) as any)} />);
    const altShipping = screen.getByLabelText('Shipping for Alt');
    expect(altShipping).toBeInTheDocument();
    expect(screen.getByText('option')).toBeInTheDocument();
    fireEvent.change(altShipping, { target: { value: '250' } });
    expect(onShip).toHaveBeenCalledWith('Alt', 'INR', 250);
  });

  it('keeps the total committed-only', () => {
    render(<VendorAllocationPanel {...(props() as any)} />);
    // Robu: 1000 + 180 + 150 = 1330. Alt's 900 + 400 shipping stays out.
    expect(screen.getByText('INR 1,330', { selector: '.text-brand-dark' })).toBeInTheDocument();
  });
});
