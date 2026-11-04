import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { IndentProgressStepper } from './IndentProgressStepper';

/**
 * Every status, with and without a quotation, checked against rules instead
 * of pictures.
 *
 * The bug this exists for: a re-quoted indent goes BACKWARDS to PENDING, and
 * the bar drew it on step 1 with Quoting grey, under a timeline that listed
 * the quote. No scenario test covered that because nobody had thought of the
 * state — the pipeline was written assuming forward-only motion.
 *
 * Case-by-case tests only ever cover states someone imagined. These assert
 * properties that must hold for EVERY state, so a combination nobody thought
 * of still has to obey them. That is the only kind of test that could have
 * caught this one before a user did.
 */
const ALL_STATUSES = [
  'PENDING', 'APPROVED', 'REJECTED', 'QUOTATION_IN_PROGRESS', 'READY_FOR_PAYMENT',
  'AWAITING_PAYMENT', 'PAYMENT_DONE', 'ORDERED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED',
  'RECEIVED', 'CANCELLED',
] as const;

const TERMINAL = ['REJECTED', 'CANCELLED'];
const LABELS = ['Submitted', 'Approved', 'Quoting', 'Payment', 'Ordered', 'Shipped', 'Received'];

/** 'done' | 'current' | 'todo' for each bubble, in pipeline order. */
const readBar = (): string[] =>
  LABELS.map((label) => {
    const caption = screen.getByText(label);
    const bubble = caption.parentElement!.firstElementChild!;
    if (bubble.textContent === '✓') return 'done';
    // The current bubble is the filled one that is not a tick.
    return bubble.className.includes('ring-2') ? 'current' : 'todo';
  });

describe('IndentProgressStepper — invariants across every state', () => {
  for (const status of ALL_STATUSES) {
    for (const quoted of [false, true]) {
      const name = `${status}${quoted ? ' (quoted)' : ''}`;

      it(`${name}: nothing done after something not done`, () => {
        render(<IndentProgressStepper status={status} quoted={quoted} />);
        if (TERMINAL.includes(status)) { cleanup(); return; }
        const bar = readBar();
        // The one that broke: Quoting ✓ while Submitted was still 'todo' would
        // be incoherent, and so would any other gap. Everything done must form
        // an unbroken run from the start.
        const lastDone = bar.lastIndexOf('done');
        for (let i = 0; i < lastDone; i++) {
          expect(bar[i], `${name}: step ${LABELS[i]} is ${bar[i]} but ${LABELS[lastDone]} after it is done`)
            .not.toBe('todo');
        }
        cleanup();
      });

      it(`${name}: at most one step is current`, () => {
        render(<IndentProgressStepper status={status} quoted={quoted} />);
        if (TERMINAL.includes(status)) { cleanup(); return; }
        expect(readBar().filter((s) => s === 'current').length).toBeLessThanOrEqual(1);
        cleanup();
      });

      if (quoted && !TERMINAL.includes(status)) {
        it(`${name}: a quoted indent never shows Quoting as not-yet-reached`, () => {
          render(<IndentProgressStepper status={status} quoted />);
          const quoting = readBar()[LABELS.indexOf('Quoting')];
          // A quotation exists. Saying "not reached" denies recorded history —
          // exactly what production showed on IND-067.
          expect(quoting, `${name}: Quoting reads '${quoting}' though a quotation exists`).not.toBe('todo');
          cleanup();
        });
      }
    }
  }

  it('terminal states drop the pipeline entirely', () => {
    for (const status of TERMINAL) {
      render(<IndentProgressStepper status={status} quoted />);
      expect(screen.queryByText('Submitted')).toBeNull();
      cleanup();
    }
  });

  it('a received indent has no unfinished steps left', () => {
    render(<IndentProgressStepper status="RECEIVED" quoted />);
    expect(readBar().every((s) => s === 'done')).toBe(true);
  });
});
