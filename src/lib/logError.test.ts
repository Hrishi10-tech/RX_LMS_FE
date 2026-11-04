import { describe, it, expect, vi, beforeEach } from 'vitest';

const patch = vi.fn(() => Promise.resolve());
vi.mock('./axios', () => ({ client: { patch } }));

describe('logError', () => {
  beforeEach(() => {
    patch.mockClear();
    window.sessionStorage.setItem('accessToken', 'x');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('does not report a request the browser itself dropped (Firefox, leaving a page)', async () => {
    const { logError } = await import('./logError');
    logError('Dashboard.stats', Object.assign(new Error('Request aborted'), { code: 'ECONNABORTED' }));
    expect(patch).not.toHaveBeenCalled();
  });

  it('still reports a timeout, which shares the code', async () => {
    const { logError } = await import('./logError');
    logError('Dashboard.stats', Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }));
    expect(patch).toHaveBeenCalledTimes(1);
  });
});
