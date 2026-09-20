import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ATTEMPT_BUDGETS,
  BACKOFF_BASE_MS,
  BACKOFF_MAX_MS,
  CALL_KINDS,
  DEFAULT_TASK_TIMEOUT_MS,
  JITTER_RATIO,
  MIN_CALL_GAP_MS,
  SUBMIT_CALL_GAP_MS,
  backoffDelay,
  classifyFailure,
  createPacer,
  gapMsFor,
  jitteredDelay,
} from '../src/ea/pacing.js';
import { DEFAULT_OBSERVABLE_TIMEOUT_MS } from '../src/ea/observable.js';

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

  it('never retries a call the pacer abandoned for not settling', () => {
    const timeout = new Error('pacing: the save call did not settle within 30000ms');
    timeout.pacingTimedOut = true;
    const decision = classifyFailure(timeout, { kind: CALL_KINDS.SAVE });
    expect(decision.retry).toBe(false);
    expect(decision.reason).toMatch(/pacing timeout/);
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

describe('a bounded in-flight call', () => {
  const neverSettles = () => new Promise(() => {});

  it('leaves the read path its own observable timeout to fire first', () => {
    expect(DEFAULT_TASK_TIMEOUT_MS).toBeGreaterThan(DEFAULT_OBSERVABLE_TIMEOUT_MS);
  });

  it('does not wedge the queue when a task never settles', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0, taskTimeoutMs: 1000 });
    const starts = [];
    const hung = pacer.run('hung save', neverSettles, { kind: CALL_KINDS.SAVE });
    const after = pacer.run('after the hung call', async () => {
      starts.push(Date.now());
      return 'after';
    });
    const hungRejection = expect(hung).rejects.toThrow(/did not settle within 1000ms/);

    await vi.advanceTimersByTimeAsync(1000);
    // Without the bound this stays empty: the hung task keeps `inFlight` true
    // and `pump` refuses the second entry forever.
    expect(starts).toEqual([1000]);

    await hungRejection;
    await expect(after).resolves.toBe('after');
    expect(pacer.snapshot().calls).toBe(2);
  });

  it('rejects a hung call with a reason naming the timeout, never a silent drop', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0, taskTimeoutMs: 1000 });
    const call = pacer.run('hung save', neverSettles, { kind: CALL_KINDS.SAVE });
    const rejection = expect(call).rejects.toThrow(/did not settle within 1000ms/);

    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a call with the documented default when no override is given', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0 });
    const call = pacer.run('hung save', neverSettles, { kind: CALL_KINDS.SAVE });
    const rejection = expect(call).rejects.toThrow(
      new RegExp(`did not settle within ${DEFAULT_TASK_TIMEOUT_MS}ms`)
    );

    await vi.advanceTimersByTimeAsync(DEFAULT_TASK_TIMEOUT_MS);
    await rejection;
  });

  it('stays usable when reset() lands while a hung call is in flight', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0, taskTimeoutMs: 1000 });
    const hung = pacer.run('hung save', neverSettles, { kind: CALL_KINDS.SAVE });
    const hungRejection = expect(hung).rejects.toThrow(/did not settle/);

    pacer.cancel();
    pacer.reset();
    const next = pacer.run('next solve', async () => 'next');

    await vi.advanceTimersByTimeAsync(1000);
    await hungRejection;
    await expect(next).resolves.toBe('next');
    expect(pacer.snapshot().calls).toBe(2);
  });

  it('starts the following call only after the hung call is abandoned', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0, taskTimeoutMs: 1000 });
    const starts = [];
    const hung = pacer.run('hung save', neverSettles, { kind: CALL_KINDS.SAVE });
    const after = pacer.run('after the hung call', async () => {
      starts.push(Date.now());
    });
    const hungRejection = expect(hung).rejects.toThrow(/did not settle/);

    await vi.advanceTimersByTimeAsync(999);
    expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([1000]);

    await hungRejection;
    await after;
    expect(pacer.snapshot().calls).toBe(2);
  });
});

describe('a cancel that races an in-flight failure', () => {
  const retryableFailure = () => {
    const error = new Error('rate limited');
    error.status = 429;
    return error;
  };

  it('arms no further wait when the in-flight call fails retryably after the cancel', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0 });
    let failFirst = null;
    const call = pacer.run(
      'save',
      () =>
        new Promise((resolve, reject) => {
          failFirst = reject;
        }),
      { kind: CALL_KINDS.SAVE }
    );
    const rejection = expect(call).rejects.toThrow(/cancel/i);
    await vi.advanceTimersByTimeAsync(0);
    const before = pacer.snapshot();

    pacer.cancel();
    failFirst(retryableFailure());
    await vi.advanceTimersByTimeAsync(0);

    // Without the cancel guard a backoff timer is armed here and counted.
    expect(vi.getTimerCount()).toBe(0);
    expect(pacer.snapshot()).toEqual(before);

    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);
    await rejection;
  });

  it('counts no wait that served nothing after a cancel', async () => {
    startClock();
    const pacer = createPacer({ random: () => 0 });
    let attempts = 0;
    let failFirst = null;
    const task = () => {
      attempts += 1;
      return attempts === 1
        ? new Promise((resolve, reject) => {
            failFirst = reject;
          })
        : new Promise(() => {});
    };
    const call = pacer.run('save', task, { kind: CALL_KINDS.SAVE });
    const rejection = expect(call).rejects.toThrow(/cancel/i);
    await vi.advanceTimersByTimeAsync(0);
    const before = pacer.snapshot();

    pacer.cancel();
    failFirst(retryableFailure());
    await vi.advanceTimersByTimeAsync(0);
    pacer.reset();

    await vi.advanceTimersByTimeAsync(BACKOFF_MAX_MS);

    // Without the guard the backoff is armed after the cancel, the reset lands
    // inside it, and the remaining retry fires as extra paced work.
    expect(attempts).toBe(1);
    expect(pacer.snapshot()).toEqual(before);
    expect(vi.getTimerCount()).toBe(0);
    await rejection;
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