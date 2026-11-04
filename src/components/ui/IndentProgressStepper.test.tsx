import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IndentProgressStepper } from './IndentProgressStepper';

/**
 * The bar is drawn from `status` alone, and an indent does not always move
 * forwards. When a quote lands above the approved figure the service sends it
 * back to PENDING and clears the signatures, so a literal reading put a
 * twice-handled indent back on step 1.
 *
 * Reported from production on IND-067: raised 7 Oct, approved 13 Oct and
 * handed to procurement, quoted 14 Oct at ₹1,182, then back for approval at
 * the firm price. The bar said "Submitted" above a timeline listing all three.
 */
const stepState = (label: string) => {
  const caption = screen.getByText(label);
  // The bubble is the sibling above the caption; "✓" when the step is done,
  // its number otherwise.
  const bubble = caption.parentElement?.firstElementChild;
  return bubble?.textContent ?? '';
};

describe('IndentProgressStepper', () => {
  it('shows a plain pending indent at Submitted', () => {
    render(<IndentProgressStepper status="PENDING" />);
    expect(stepState('Submitted')).toBe('1');
    expect(stepState('Approved')).toBe('2');
  });

  it('puts a re-quoted indent back at Approved, not back at the start', () => {
    render(<IndentProgressStepper status="PENDING" quoted />);
    // Submitted genuinely happened and stays done.
    expect(stepState('Submitted')).toBe('✓');
    // It is waiting on the SECOND signature, so Approved is where it sits.
    expect(stepState('Approved')).toBe('2');
    // The quote exists; pretending otherwise is what the bug did.
    expect(stepState('Quoting')).toBe('✓');
    // Nothing beyond has happened.
    expect(stepState('Payment')).toBe('4');
  });

  it('leaves every forward status alone when a quote exists', () => {
    render(<IndentProgressStepper status="ORDERED" quoted />);
    expect(stepState('Submitted')).toBe('✓');
    expect(stepState('Quoting')).toBe('✓');
    expect(stepState('Payment')).toBe('✓');
    expect(stepState('Ordered')).toBe('5');
  });

  it('still marks a received indent complete', () => {
    render(<IndentProgressStepper status="RECEIVED" quoted />);
    expect(stepState('Received')).toBe('✓');
  });
});
