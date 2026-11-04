/**
 * Two things every `<input type="number">` in the app does by default that
 * nobody wants:
 *
 * - Scrolling the page with the pointer over a focused number box changes its
 *   value. On a payment or refund amount that is a silent edit of money.
 * - It accepts "e" ("1e3" is 1000) and "+".
 *
 * Handled once, for the whole document, so the ~35 raw number inputs and
 * NumberInput are all covered without touching each one.
 */
export function installNumberInputGuard(doc: Document = document): void {
  doc.addEventListener('wheel', () => {
    const el = doc.activeElement;
    if (el instanceof HTMLInputElement && el.type === 'number') el.blur();
  }, { passive: true });

  doc.addEventListener('keydown', (e) => {
    const el = e.target;
    if (el instanceof HTMLInputElement && el.type === 'number' && ['e', 'E', '+'].includes(e.key)) e.preventDefault();
  });
}
