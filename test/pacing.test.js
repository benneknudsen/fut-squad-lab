import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ATTEMPT_BUDGETS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CALL_KINDS,
  JITTER_RATIO,
  MIN_CALL_GAP_MS,
  SUBMIT_CALL_GAP_MS,
  backoffDelay,
  classifyFailure,
  createPacer,
  gapMsFor,
  jitteredDelay,
} from '../src/ea/pacing.js';

// Issue #52: every EA call goes through one serialised queue. These tests run
// with fake timers only — no test here waits on a real clock.

afterEach(() => {
  vi.useRealTimers();
});

const startClock = () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
};

describe('the serialised queue', () => {
  it('separates two back-to-back calls by at least the minimum gap', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0 });
    const starts = [];
    const first = pacer.run('first', async () => {
      starts.push(Date.now());
    });
    const second = pacer.run('second', async () => {
      starts.push(Date.now());
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0]);

    await vi.advanceTimersByTimeAsync(MIN_CALL_GAP_MS - 1);
    expect(starts).toEqual([0]);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([first, second]);

    expect(starts).toEqual([0, MIN_CALL_GAP_MS]);
  });

  it('never lets two calls run at the same time', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0 });
    let active = 0;
    const observed = [];
    const task = async () => {
      active += 1;
      observed.push(active);
      await new Promise((resolve) => setTimeout(resolve, 500));
      active -= 1;
    };

    const both = Promise.all([pacer.run('first', task), pacer.run('second', task)]);
    await vi.runAllTimersAsync();
    await both;

    expect(observed).toEqual([1, 1]);
    expect(pacer.snapshot().calls).toBe(2);
  });

  it('rejects a queued call once the pacer is cancelled, and runs it again after a reset', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0 });
    let started = false;
    const first = pacer.run('first', async () => 'first');
    const second = pacer.run('second', async () => {
      started = true;
      return 'second';
    });

    pacer.cancel();
    await expect(second).rejects.toThrow(/cancel/i);
    expect(started).toBe(false);

    pacer.reset();
    const third = pacer.run('third', async () => 'third');
    await vi.advanceTimersByTimeAsync(MIN_CALL_GAP_MS);
    await expect(first).resolves.toBe('first');
    await expect(third).resolves.toBe('third');
    expect(started).toBe(false);
  });
});

describe('wait timing', () => {
  it('keeps jitter inside its documented bounds and varies between waits', () => {
    const floor = 1000;
    expect(jitteredDelay(floor, { random: () => 0 })).toBe(floor);
    expect(jitteredDelay(floor, { random: () => 1 })).toBe(floor * (1 + JITTER_RATIO));

    const low = jitteredDelay(floor, { random: () => 0.1 });
    const high = jitteredDelay(floor, { random: () => 0.9 });
    expect(low).toBeGreaterThanOrEqual(floor);
    expect(high).toBeLessThanOrEqual(floor * (1 + JITTER_RATIO));
    expect(low).not.toBe(high);
  });

  it('applies jitter above the minimum gap, never below it', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0.999 });
    const starts = [];
    const first = pacer.run('first', async () => {
      starts.push(Date.now());
    });
    const second = pacer.run('second', async () => {
      starts.push(Date.now());
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0]);

    await vi.advanceTimersByTimeAsync(Math.ceil(MIN_CALL_GAP_MS * (1 + JITTER_RATIO)));
    await Promise.all([first, second]);

    expect(starts).toHaveLength(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(MIN_CALL_GAP_MS);
    expect(starts[1] - starts[0]).toBeLessThanOrEqual(MIN_CALL_GAP_MS * (1 + JITTER_RATIO));
  });

  it('grows backoff exponentially and caps it at the documented maximum', () => {
    const random = () => 0;
    expect(backoffDelay(0, { random })).toBe(BACKOFF_BASE_MS);
    expect(backoffDelay(1, { random })).toBe(BACKOFF_BASE_MS * 2);
    expect(backoffDelay(2, { random })).toBe(BACKOFF_BASE_MS * 4);
    expect(backoffDelay(3, { random })).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(9, { random })).toBe(BACKOFF_MAX_MS);
    expect(backoffDelay(9, { random: () => 0.9 })).toBeLessThanOrEqual(BACKOFF_MAX_MS);
  });

  it('reserves the longer gap before a submit', () => {
    expect(gapMsFor(CALL_KINDS.SUBMIT)).toBe(SUBMIT_CALL_GAP_MS);
    expect(gapMsFor(CALL_KINDS.SAVE)).toBe(MIN_CALL_GAP_MS);
    expect(SUBMIT_CALL_GAP_MS).toBeGreaterThan(MIN_CALL_GAP_MS);
  });
});

describe('the retry policy', () => {
  const failure = (status, message) => ({ status, message });

  it('retries only the documented statuses and fails the rest by status alone', () => {
    expect(classifyFailure(failure(429, 'too many requests')).retry).toBe(true);
    expect(
      classifyFailure(failure(475, 'service busy'), { kind: CALL_KINDS.CHALLENGE_LOAD }).retry
    ).toBe(true);
    expect(classifyFailure(failure(500, 'server error')).retry).toBe(true);
    expect(classifyFailure(failure(503, 'unavailable')).retry).toBe(true);
    expect(classifyFailure(failure(400, 'bad request')).retry).toBe(false);
    expect(classifyFailure(failure(403, 'forbidden')).retry).toBe(false);
  });

  it('retries a rate-limit-shaped error string and fails fast on an unrelated one', () => {
    expect(classifyFailure(new Error('rate limited, slow down')).retry).toBe(true);
    expect(classifyFailure(new Error('request timed out')).retry).toBe(true);
    expect(classifyFailure(new Error('temporarily unavailable')).retry).toBe(true);
    expect(classifyFailure(new Error('market item no longer exists')).retry).toBe(false);
  });

  it('reads status 475 by context: transient for a read, EA rejection for a save', () => {
    const transient = classifyFailure(failure(475, 'try again later'), {
      kind: CALL_KINDS.CLUB_PAGE,
    });
    expect(transient.retry).toBe(true);
    expect(transient.reason).toMatch(/475/);

    const rejection = classifyFailure(failure(475, 'the squad is ineligible'), {
      kind: CALL_KINDS.SAVE,
    });
    expect(rejection.retry).toBe(false);
    expect(rejection.reason).toMatch(/ineligible|reject/i);
  });
});

describe('attempt budgets', () => {
  it('honours the configured budget exactly and names it when exhausted', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0 });
    let attempts = 0;
    const promise = pacer.run(
      'always failing',
      async () => {
        attempts += 1;
        const error = new Error('rate limited');
        error.status = 429;
        throw error;
      },
      { kind: CALL_KINDS.CHALLENGE_LOAD }
    );
    const rejection = expect(promise).rejects.toThrow(
      new RegExp(`budget of ${ATTEMPT_BUDGETS.challengeLoad}`)
    );

    await vi.runAllTimersAsync();
    await rejection;
    expect(attempts).toBe(ATTEMPT_BUDGETS.challengeLoad);
  });

  it('fails immediately on a non-retryable error without spending the budget', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0 });
    let attempts = 0;

    await expect(
      pacer.run(
        'fatal',
        async () => {
          attempts += 1;
          throw new Error('bad request');
        },
        { kind: CALL_KINDS.SAVE }
      )
    ).rejects.toThrow(/bad request/);
    expect(attempts).toBe(1);
  });
});

describe('cancellable waits', () => {
  it('resolves a cancelled wait promptly instead of running to completion', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0 });
    const first = pacer.run('first', async () => 'first');
    const second = pacer.run('second', async () => 'second');

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    pacer.cancel();
    await expect(second).rejects.toThrow(/cancel/i);
    expect(vi.getTimerCount()).toBe(0);
    await expect(first).resolves.toBe('first');
  });
});

describe('pacing statistics', () => {
  it('counts calls, waits and retries for the diagnostic report', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0 });
    let attempts = 0;
    const task = () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('rate limited');
        error.status = 429;
        return Promise.reject(error);
      }
      return Promise.resolve('ok');
    };

    const call = pacer.run('retry once', task, { kind: CALL_KINDS.CHALLENGE_LOAD });
    await vi.runAllTimersAsync();
    await expect(call).resolves.toBe('ok');

    const snapshot = pacer.snapshot();
    expect(snapshot).toMatchObject({ calls: 2, retries: 1, waits: 1 });
    expect(snapshot.waitedMs).toBeGreaterThanOrEqual(BACKOFF_BASE_MS);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });
});