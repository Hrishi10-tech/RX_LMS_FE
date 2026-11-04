/**
 * Backoff for reconnecting after the SERVER closed the socket.
 *
 * socket.io retries a dropped transport on its own, but never an
 * `io server disconnect` — that is the server kicking us, usually because the
 * token it was handed had expired. One fresh token normally fixes it, so we
 * retry a few times with growing gaps and then stop: if the server keeps
 * refusing (revoked session, deactivated account) hammering it helps nobody.
 *
 * Returns the delay before retry number `attempt` (0-based), or null once the
 * retries are used up.
 */
export const SERVER_KICK_MAX_RETRIES = 3;

export function serverKickRetryDelay(attempt: number, baseMs = 2_000): number | null {
  if (attempt < 0 || attempt >= SERVER_KICK_MAX_RETRIES) return null;
  return baseMs * 2 ** attempt;
}
