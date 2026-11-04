import { describe, it, expect } from 'vitest';
import { serverKickRetryDelay, SERVER_KICK_MAX_RETRIES } from './socketRetry';

describe('serverKickRetryDelay', () => {
  it('backs off exponentially', () => {
    expect(serverKickRetryDelay(0)).toBe(2_000);
    expect(serverKickRetryDelay(1)).toBe(4_000);
    expect(serverKickRetryDelay(2)).toBe(8_000);
  });

  it('gives up after the last retry instead of looping forever', () => {
    expect(serverKickRetryDelay(SERVER_KICK_MAX_RETRIES)).toBeNull();
    expect(serverKickRetryDelay(99)).toBeNull();
  });
});
