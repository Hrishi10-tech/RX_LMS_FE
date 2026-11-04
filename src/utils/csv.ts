/**
 * One quoted CSV cell for TEXT, safe to open in Excel or Sheets.
 *
 * Quoting alone does not stop formula injection: a spreadsheet still evaluates
 * `"=HYPERLINK(...)"` or `"@SUM(...)"` once the quotes are stripped. Any text
 * starting with = + - @ (or a tab / carriage return, which some apps skip
 * before looking) gets a leading apostrophe, which the spreadsheet treats as
 * "this is text" and hides.
 *
 * Text only — pass numbers through unquoted so `-3` stays a number rather than
 * becoming the string `'-3`.
 */
const FORMULA_TRIGGERS = ['=', '+', '-', '@', '\t', '\r'];

export function csvTextCell(value: unknown): string {
  let str = String(value ?? '');
  if (FORMULA_TRIGGERS.some((ch) => str.startsWith(ch))) str = `'${str}`;
  return `"${str.replace(/"/g, '""')}"`;
}
