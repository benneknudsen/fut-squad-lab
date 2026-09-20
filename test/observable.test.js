import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_OBSERVABLE_TIMEOUT_MS,
  isObservable,
  observeOnce,
} from '../src/ea/observable.js';
import { createTestPacer } from './helpers/pacing.js';

const testPacer = createTestPacer();

// A fake EA observable: `observe` stores the callback and hands back an
// observer whose `unobserve` counts calls, `emit` fires every stored callback.
// Real EA observables can fire more than once; these fakes can too.
const makeObservable = () => {
  const state = { callbacks: [], unsubscribed: 0, subscribed: 0 };
  return {
    state,
    observe(callback) {
      state.subscribed += 1;
      state.callbacks.push(callback);
      return {
        unobserve() {
          state.unsubscribed += 1;
        },
      };
    },
    emit(event) {
      for (const callback of [...state.callbacks]) callback(event);
    },
  };
};

const neverFires = () => {
  const state = { subscribed: 0, unsubscribed: 0 };
  return {
    state,
    observe() {
      state.subscribed += 1;
      return {
        unobserve() {
          state.unsubscribed += 1;
        },
      };
    },
  };
};

describe('isObservable', () => {
  it('accepts a value carrying an observe method and rejects everything else', () => {
    expect(isObservable(makeObservable())).toBe(true);
    expect(isObservable({ observe: () => {} })).toBe(true);
    expect(isObservable({})).toBe(false);
    expect(isObservable(null)).toBe(false);
    expect(isObservable({ observe: 'later' })).toBe(false);
  });
});

describe('observeOnce', () => {
  it('resolves with the payload an observable that fires once produced', async () => {
    const observable = makeObservable();
    const payload = { itemData: [{ id: 1 }] };
    const promise = observeOnce(observable, { timeoutMs: 100 });

    observable.emit({ data: payload, error: null, response: null, status: 200, success: true });
    const event = await promise;

    expect(event.payload).toBe(payload);
    expect(event.data).toBe(payload);
    expect(event.status).toBe(200);
    expect(event.success).toBe(true);
    expect(observable.state.unsubscribed).toBe(1);
  });

  it('unsubscribes after the first callback so a second emission cannot leak through', async () => {
    const observable = makeObservable();
    const first = { itemData: [{ id: 1 }] };
    const second = { itemData: [{ id: 2 }] };
    const promise = observeOnce(observable, { timeoutMs: 100 });

    observable.emit({ data: first });
    const event = await promise;
    observable.emit({ data: second });

    expect(event.payload).toBe(first);
    expect(event.payload).not.toBe(second);
    expect(observable.state.subscribed).toBe(1);
    expect(observable.state.unsubscribed).toBe(1);
  });

  it('timed out with an explicit reason and unsubscribes instead of hanging', async () => {
    const observable = neverFires();

    await expect(observeOnce(observable, { timeoutMs: 20 })).rejects.toThrow(
      /timed out after 20ms/
    );

    expect(observable.state.subscribed).toBe(1);
    expect(observable.state.unsubscribed).toBe(1);
  });

  it('carries error, status and success through faithfully', async () => {
    const observable = makeObservable();
    const error = new Error('EA refused the search');
    const promise = observeOnce(observable, { timeoutMs: 100 });

    observable.emit({ data: null, error, response: undefined, status: 403, success: false });
    const event = await promise;

    expect(event.error).toBe(error);
    expect(event.status).toBe(403);
    expect(event.success).toBe(false);
    expect(event.payload).toBeNull();
  });

  it('prefers response over data for the payload, as EA does', async () => {
    const observable = makeObservable();
    const data = { stale: true };
    const response = { fresh: true };
    const promise = observeOnce(observable, { timeoutMs: 100 });

    observable.emit({ data, response, status: 200, success: true });
    const event = await promise;

    expect(event.payload).toBe(response);
    expect(event.data).toBe(data);
    expect(event.response).toBe(response);
  });

  it('accepts a synchronous first callback fired inside observe', async () => {
    const state = { unsubscribed: 0 };
    const observable = {
      observe(callback) {
        callback({ data: { synced: true } });
        return {
          unobserve() {
            state.unsubscribed += 1;
          },
        };
      },
    };

    const event = await observeOnce(observable, { timeoutMs: 100 });

    expect(event.payload).toEqual({ synced: true });
    expect(state.unsubscribed).toBe(1);
  });

  it('rejects a value that is not an observable, naming what was missing', async () => {
    await expect(observeOnce({}, { timeoutMs: 100 })).rejects.toThrow(/observe/);
    await expect(observeOnce(null, { timeoutMs: 100 })).rejects.toThrow(/observe/);
    await expect(observeOnce(undefined, { timeoutMs: 100 })).rejects.toThrow(/observe/);
    await expect(observeOnce(() => {}, { timeoutMs: 100 })).rejects.toThrow(/observe/);
  });

  it('rejects when observe itself throws, with the thrown reason', async () => {
    const observable = {
      observe() {
        throw new Error('subscription refused');
      },
    };

    await expect(observeOnce(observable, { timeoutMs: 100 })).rejects.toThrow(
      /subscription refused/
    );
  });

  it('keeps its default timeout explicit and finite', () => {
    expect(Number.isFinite(DEFAULT_OBSERVABLE_TIMEOUT_MS)).toBe(true);
    expect(DEFAULT_OBSERVABLE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('settles once: a second callback after the timeout does not reject later', async () => {
    const observable = makeObservable();
    const promise = observeOnce(observable, { timeoutMs: 20 });

    await expect(promise).rejects.toThrow(/timed out/);
    observable.emit({ data: { late: true } });
    await expect(promise).rejects.toThrow(/timed out/);
  });
});

// Issue #51: the read path must never invent a request. This is asserted by
// source scan, not only by behaviour, because a fallback added later would
// otherwise only show up in the player's authenticated session.
describe('no real network primitive on the read path', () => {
  const sources = ['observable.js', 'adapter.js', 'challenge-reader.js', 'club-reader.js'];

  it('never mentions fetch, XMLHttpRequest or sendBeacon in the read modules', () => {
    for (const name of sources) {
      const source = readFileSync(fileURLToPath(new URL(`../src/ea/${name}`, import.meta.url)), 'utf8');
      expect(source, name).not.toMatch(/\bfetch\s*\(/);
      expect(source, name).not.toMatch(/\bnew\s+XMLHttpRequest\b/);
      expect(source, name).not.toMatch(/\bsendBeacon\s*\(/);
      expect(source, name).not.toMatch(/\bnew\s+WebSocket\b/);
    }
  });

  it('rejects a non-observable without reaching for a network primitive', async () => {
    const fetchSpy = vi.fn();
    const pageWindow = {
      fetch: fetchSpy,
      UTBucketedItemSearchViewModel: { searchCriteria: {} },
      services: {
        Club: {
          search() {
            return { not: 'an observable' };
          },
        },
      },
    };

    const club = await import('../src/ea/adapter.js');
    const result = await club.resolveClubItems(pageWindow, { pacer: testPacer });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.attempts[0].reason).toMatch(/itemData|observable|returned/i);
  });
});
