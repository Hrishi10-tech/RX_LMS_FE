import { AxiosError } from 'axios';

/**
 * Frontend mirror of the backend AppError hierarchy. The axios response interceptor
 * maps backend `{ statusCode, message, code }` payloads to one of these typed errors
 * so callers can `instanceof`-check instead of inspecting status codes.
 */
export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly code: string;
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly code = 'NOT_FOUND';
}

export class ValidationError extends AppError {
  readonly statusCode = 400;
  readonly code = 'VALIDATION_FAILED';
}

export class ForbiddenError extends AppError {
  readonly statusCode = 403;
  readonly code = 'FORBIDDEN';
}

export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly code = 'CONFLICT';
}

export class UnauthorizedError extends AppError {
  readonly statusCode = 401;
  readonly code = 'UNAUTHORIZED';
}

// Rate-limit / throttler hits. The default Nest message ("ThrottlerException:
// Too Many Requests") is technical jargon — we rewrite it to something the
// inventory clerk can actually act on.
export class RateLimitedError extends AppError {
  readonly statusCode = 429;
  readonly code = 'RATE_LIMITED';
}

/**
 * Generic catch-all when the backend returned a structured error envelope but
 * the `code` doesn't match a known subclass. Preserves the message + code + details
 * without losing them.
 */
export class GenericAppError extends AppError {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    details?: unknown,
  ) {
    super(message, details);
  }
}

// Framework / HTTP boilerplate messages that mean nothing to an end user.
// We ONLY substitute these exact defaults — any specific, human-written
// backend message (e.g. "Can't delete X — still linked to 1 user(s)") falls
// through untouched, because those are already user-facing copy.
const GENERIC_MESSAGES = new Set([
  '',
  'internal server error',
  'forbidden',
  'forbidden resource',
  'unauthorized',
  'bad request',
  'not found',
  'conflict',
  'request failed',
]);

/**
 * Turn a raw backend/HTTP message into plain language a non-engineer can act
 * on. Keeps any specific message the backend authored; only rewrites the
 * generic framework defaults (matched case-insensitively above).
 */
export function humanizeMessage(statusCode: number, message?: string): string {
  const raw = (message || '').trim();
  if (!GENERIC_MESSAGES.has(raw.toLowerCase())) return raw; // specific copy — keep it

  if (statusCode >= 500) return 'Something went wrong on our end. Please try again in a moment.';
  switch (statusCode) {
    case 400:
      return "Some of the details don't look right — please review and try again.";
    case 401:
      return 'Your session has expired. Please sign in again.';
    case 403:
      return "You don't have permission to do that.";
    case 404:
      return "We couldn't find that — it may have been moved or removed.";
    case 409:
      return "That conflicts with something that already exists — refresh and try again.";
    default:
      return 'Something went wrong. Please try again.';
  }
}

/**
 * Maps a backend response (or any axios error) into a concrete AppError instance
 * when possible. Preserves the original AxiosError shape for callers that need
 * network-level details (no response, timeout, etc.) — extractErrorMessage()
 * turns those into friendly "can't reach the server" copy.
 */
export function mapResponseToAppError(error: AxiosError): Error {
  // Network failures (no response) — return axios error as-is
  if (!error.response) return error;

  const body = error.response.data as { message?: string; code?: string; statusCode?: number; data?: unknown } | undefined;
  const statusCode = error.response.status;
  // class-validator sends an array of field errors; join them into one line.
  const rawMessage = Array.isArray(body?.message) ? body!.message.filter(Boolean).join('; ') : body?.message || error.message;
  const message = humanizeMessage(statusCode, rawMessage);
  const code = body?.code;

  // Carry the server's own `code` and payload onto the error.
  //
  // Everything below collapses a response into one of a handful of classes
  // whose `code` is a fixed constant, so a caller could tell "this was a 409"
  // but never WHICH 409. That is fine for failures — one red toast looks like
  // another — and wrong for a 409 that is really a question, like
  // MANAGER_APPROVAL_PENDING, where the UI has to open a confirm dialog and
  // name the manager being bypassed. `details` already existed on AppError
  // and was unused; this fills it rather than inventing a parallel channel.
  const details = code || body?.data != null ? { code, data: body?.data } : undefined;

  // Match on the explicit `code` first (typed AppError from backend), then fall back
  // to status code for legacy HttpException responses without a code field.
  switch (code) {
    case 'NOT_FOUND':
      return new NotFoundError(message, details);
    case 'VALIDATION_FAILED':
      return new ValidationError(message, details);
    case 'FORBIDDEN':
      return new ForbiddenError(message, details);
    case 'CONFLICT':
      return new ConflictError(message, details);
    case 'UNAUTHORIZED':
      return new UnauthorizedError(message, details);
  }

  switch (statusCode) {
    case 404:
      return new NotFoundError(message, details);
    case 400:
      return new ValidationError(message, details);
    case 403:
      return new ForbiddenError(message, details);
    case 409:
      return new ConflictError(message, details);
    case 401:
      return new UnauthorizedError(message, details);
    case 429:
      // Rewrite the technical "ThrottlerException: Too Many Requests"
      // into something a non-engineer can read + act on. The user
      // previously got a tiny red dot with no useful info.
      return new RateLimitedError(
        'Too many requests in a short window — give it a few seconds and try again.',
      );
  }

  return new GenericAppError(message, statusCode, code || 'UNKNOWN', details);
}
