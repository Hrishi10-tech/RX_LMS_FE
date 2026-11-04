/**
 * Mirrors the backend's validateUserName (users.service.ts). Kept in one place
 * so every form that creates an account applies the same rule — the room
 * terminal dialog previously had no check at all, so the only feedback was a
 * toast carrying the server's rejection after you'd already hit Create.
 *
 * Returns '' when valid, otherwise the message to show under the field.
 *
 * Digits and & are allowed AFTER the first character. The leading-letter rule
 * is what blocks the junk this guards against ("543534534", "^%$^$", blank,
 * leading whitespace); restricting the rest of the string was incidental and
 * rejected legitimate names like "Bay 3 Terminal" and "R & D Lab Terminal".
 */
export const validateName = (value: string, label = 'Name'): string => {
  const trimmed = value.trim();
  if (!trimmed) return `${label} is required.`;
  if (trimmed.length < 2) return `${label} must be at least 2 characters.`;
  if (trimmed.length > 120) return `${label} must be 120 characters or fewer.`;
  if (!/^\p{L}[\p{L}\p{N}\s.'&-]*$/u.test(trimmed)) {
    return 'Must start with a letter. Letters, numbers, spaces, hyphens, apostrophes, dots and & are allowed.';
  }
  return '';
};

/** Loose email shape check — the server is the authority, this is just early feedback. */
export const validateEmail = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return 'Email is required.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "That doesn't look like an email address.";
  return '';
};
