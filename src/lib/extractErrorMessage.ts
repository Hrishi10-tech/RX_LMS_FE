import { AppError, humanizeMessage } from './app-error';

const NETWORK_COPY = "Can't reach the server right now — check your connection and try again.";

// axios reports these when the request never got an HTTP response back.
function isNetworkError(e: any): boolean {
  return (
    e?.response == null &&
    (e?.code === 'ERR_NETWORK' ||
      e?.code === 'ECONNABORTED' ||
      e?.code === 'ETIMEDOUT' ||
      /network error|timeout|failed to fetch/i.test(String(e?.message || '')))
  );
}

/**
 * Pull a human-readable message out of any error shape the app produces.
 *
 * In order of preference:
 *   1. AppError instance (axios interceptor already mapped the backend's
 *      structured envelope) → use its `.message`
 *   2. Raw axios error with `response.data.message` (fallback if the
 *      interceptor was bypassed for some reason)
 *   3. Plain `Error` → `.message`
 *   4. Anything else → the supplied `fallback`
 *
 * Why this exists: 215+ catch blocks across the codebase were doing
 * `addToast('Failed to do X', 'error')` and losing the backend's actual
 * message ("Cannot raise issued qty by 1 — only 0 unit of 'OE/0402' in
 * stock"). Wrapping every catch with this turns a useless toast into an
 * actionable one without changing the call-site shape.
 *
 * Usage:
 *   try { ... } catch (e) {
 *     addToast(extractErrorMessage(e, 'Could not save'), 'error');
 *   }
 *
 * Pass a fallback that names the action — used only when we have nothing
 * better (e.g. complete network failure with no response payload).
 */
export function extractErrorMessage(error: unknown, fallback: string): string {
  if (!error) return fallback;

  // 1. AppError — the interceptor already extracted + humanized the message.
  if (error instanceof AppError) return error.message || fallback;

  const e = error as any;

  // 2. Network-level failure (request never reached the server) — give the
  //    user something actionable instead of the raw "Network Error".
  if (isNetworkError(e)) return NETWORK_COPY;

  // 3. Raw axios error — response.data.message is where Nest puts it
  //    via the global HttpExceptionFilter + TransformInterceptor. Humanize
  //    framework defaults ("Internal server error") using the status code.
  const status: number | undefined = e?.response?.status;
  const fromResponse =
    e?.response?.data?.message ??
    e?.response?.data?.error ??
    e?.data?.message;
  if (typeof fromResponse === 'string' && fromResponse.trim()) {
    return typeof status === 'number' ? humanizeMessage(status, fromResponse) : fromResponse;
  }
  // class-validator emits message as an array when multiple fields fail
  if (Array.isArray(fromResponse) && fromResponse.length > 0) {
    return fromResponse.filter(Boolean).join('; ');
  }

  // 4. Plain JS error
  if (typeof e?.message === 'string' && e.message.trim()) {
    // Skip the generic axios "Request failed with status code 400" —
    // that's noise, prefer the fallback the caller named the action.
    if (/request failed with status code/i.test(e.message)) return fallback;
    return e.message;
  }

  return fallback;
}
