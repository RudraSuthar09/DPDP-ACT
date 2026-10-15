import { withRetry } from './retry';

describe('withRetry — bounded exponential backoff with jitter (Phase 1)', () => {
  it('returns the result immediately on first success — no sleep, no retry', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, isRetryable: () => true, sleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a retryable failure up to maxAttempts, then succeeds', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, isRetryable: () => true, sleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('exhausts maxAttempts and re-throws the LAST error — never silently swallowed', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const err1 = new Error('first');
    const err2 = new Error('second');
    const fn = jest.fn().mockRejectedValueOnce(err1).mockRejectedValueOnce(err2);
    await expect(
      withRetry(fn, { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 1000, isRetryable: () => true, sleep }),
    ).rejects.toBe(err2);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a non-retryable error fails immediately, without consuming the attempt budget on sleeps', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const terminal = new Error('INVALID_ENROLLMENT_CODE');
    const fn = jest.fn().mockRejectedValue(terminal);
    await expect(
      withRetry(fn, { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000, isRetryable: (err) => err !== terminal, sleep }),
    ).rejects.toBe(terminal);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('calls onRetry with the attempt number, the error, and a bounded delay', async () => {
    const sleep = jest.fn().mockResolvedValue(undefined);
    const onRetry = jest.fn();
    const err = new Error('network blip');
    const fn = jest.fn().mockRejectedValueOnce(err).mockResolvedValueOnce('ok');
    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200, isRetryable: () => true, sleep, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    const [attempt, passedErr, delayMs] = onRetry.mock.calls[0];
    expect(attempt).toBe(1);
    expect(passedErr).toBe(err);
    expect(delayMs).toBeGreaterThanOrEqual(0);
    expect(delayMs).toBeLessThanOrEqual(200);
  });

  it('delay never exceeds maxDelayMs even after many attempts (exponential growth is capped)', async () => {
    const delays: number[] = [];
    const sleep = jest.fn().mockImplementation(async () => {});
    const onRetry = jest.fn((_attempt: number, _err: unknown, delayMs: number) => {
      delays.push(delayMs);
    });
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    await expect(
      withRetry(fn, { maxAttempts: 8, baseDelayMs: 10, maxDelayMs: 100, isRetryable: () => true, sleep, onRetry }),
    ).rejects.toThrow('always fails');
    expect(delays.length).toBe(7); // maxAttempts - 1 retries before the final throw
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(100);
    }
  });
});
