/**
 * The login-password rule, the same one the server enforces (CreateUserDto,
 * UpdateUserDto, ResetPasswordDto): at least 8 characters with a letter and a
 * number, judged AFTER trimming — the server trims first. Checking the raw
 * value let " abc1234" pass here (8 characters with the space) and fail there
 * (7 without), with a server error the screen had promised would not happen.
 *
 * Returns the message to show, or null when the password is acceptable.
 */
export function passwordProblem(raw: string): string | null {
  const pw = (raw ?? '').trim();
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain at least one letter and one number.';
  return null;
}

/** A plain shape check for an email address — the server does the real one. */
export function emailProblem(raw: string): string | null {
  const e = (raw ?? '').trim();
  if (!e) return 'Enter an email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'Enter a valid email address.';
  return null;
}
