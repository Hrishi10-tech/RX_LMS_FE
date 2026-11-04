import { describe, it, expect } from 'vitest';
import { splitMessage, isCancellationNotice } from './ToastContext';

/**
 * Toasts here carry real content, and the long ones used to arrive as one
 * undifferentiated run of text with a forty-character filename sitting in the
 * middle of a sentence, wrapping across two lines.
 */
describe('toast formatting', () => {
  it('lifts the filename out of an upload message', () => {
    const raw =
      'Uploaded as "db_upload_2026-10-06T06-54-58-718Z.json" — 6527 rows across 51 tables. ' +
      'Restore it from the list when you are ready.';
    const { message, detail, file } = splitMessage(raw);

    expect(file).toBe('db_upload_2026-10-06T06-54-58-718Z.json');
    // The headline says what happened, without the dangling "as".
    expect(message).toBe('Uploaded');
    expect(detail).toContain('6527 rows across 51 tables');
    // And the filename is no longer embedded in the prose.
    expect(detail).not.toContain('.json');
  });

  it('takes the connector out with the filename, not just the filename', () => {
    // Removing the quoted name alone left "…51 tables, saved as. Restore it",
    // a preposition pointing at nothing — worse than the original.
    const raw =
      'Snapshot uploaded \u2014 7,992 rows across 51 tables, saved as ' +
      '"db_upload_2026-10-06T07-09-07-023Z.json". Restore it from the list when you are ready.';
    const { message, detail, file } = splitMessage(raw);

    expect(message).toBe('Snapshot uploaded');
    expect(file).toBe('db_upload_2026-10-06T07-09-07-023Z.json');
    expect(detail).toBe('7,992 rows across 51 tables. Restore it from the list when you are ready.');
    expect(detail).not.toMatch(/\bas\b\s*\./);
  });

  it('lifts a filename out of the headline when there is no detail', () => {
    const { message, file } = splitMessage('Restored from "db_backup_2026-10-05.json".');
    expect(file).toBe('db_backup_2026-10-05.json');
    expect(message).toBe('Restored');
  });

  it('leaves an ordinary one-line toast completely alone', () => {
    const raw = 'Vendor allocations saved';
    expect(splitMessage(raw)).toEqual({ message: raw, detail: undefined, file: undefined });
  });

  it('does not carve up a long sentence that has no em dash', () => {
    const raw = 'Only 4 unallotted, so 10 units of resistor cannot be issued against it.';
    const { message, detail, file } = splitMessage(raw);
    expect(message).toBe(raw);
    expect(detail).toBeUndefined();
    expect(file).toBeUndefined();
  });

  it('ignores an em dash that is too far in to be a headline', () => {
    const raw = 'This is a long preamble that runs well past sixty characters before — the dash.';
    expect(splitMessage(raw).detail).toBeUndefined();
  });

  it('is not fooled by a decimal or an ellipsis', () => {
    expect(splitMessage('Issued 2.5 kg of solder').file).toBeUndefined();
    expect(splitMessage('Working…').file).toBeUndefined();
  });
});

describe('cancelled requests', () => {
  it('a request the app called off is not an error to show', () => {
    expect(isCancellationNotice('canceled')).toBe(true);
    expect(isCancellationNotice('Cancelled.')).toBe(true);
    expect(isCancellationNotice('Request failed with status code 404')).toBe(false);
    expect(isCancellationNotice('Order canceled by the vendor')).toBe(false);
  });
});
