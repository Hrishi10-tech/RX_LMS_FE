/**
 * Tidy what someone types into an allotment quantity box, per keystroke.
 *
 * The box is seeded with the current allotment, so the common way to change
 * it is to click into a field reading "0" and type the new number — which
 * leaves "050". The value still SAVES as 50, because the server parses it as
 * a number, but the operator sits looking at a figure that is not the one
 * they entered and cannot tell whether it will be read as fifty.
 *
 * Deliberately not `String(Number(raw))`: that turns a half-typed "5." into
 * "5" and takes the decimal point away as fast as it is typed, and turns an
 * emptied box into "0" so it can never be cleared and retyped. This only
 * removes what is never meaningful — surrounding spaces, and zeros that pad
 * the front of another digit.
 *
 *   "050"  -> "50"      "007"  -> "7"       "00"  -> "0"
 *   "0"    -> "0"       "0.5"  -> "0.5"     "5."  -> "5."
 *   " 50 " -> "50"      ""     -> ""        "."   -> "."
 *
 * An empty string stays empty: the box is mid-edit, not set to zero. The
 * caller treats it as "unchanged" rather than parsing it, and zero is still
 * reachable by typing 0, which is what releases the stock.
 */
export function normalizeQtyInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '';
  // Strip leading zeros only when a DIGIT follows, so "0" and "0.5" survive.
  return trimmed.replace(/^0+(?=\d)/, '');
}
