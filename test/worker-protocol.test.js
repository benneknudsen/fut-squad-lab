import { describe, expect, it, vi } from 'vitest';

import {
  OPERATIONS,
  PROGRESS_STAGES,
  createClient,
  createRequestHandler,
} from '../src/solver/worker-protocol.js';

// The independent copy of the vocabulary from design/copy.en.json ->
// states.solving (step1..step5). The module's constant must match this list, so
// a rename or typo in the module cannot ship.
const STAGE_IDS = ['read-club', 'build-pool', 'search-lineups', 'check-chemistry', 'price-cards'];

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const handlerHarness = (operations) => {
  const emitted = [];
  return {
    emitted,
    handle: createRequestHandler({ operations, emit: (message) => emitted.push(message) }),
  };
};

const clientHarness = () => {
  const sent = [];
  return { sent, client: createClient({ send: (message) => sent.push(message) }) };
};

describe('message vocabulary', () => {
  it('names exactly the five solving stages from the design copy', () => {
    expect(Object.values(PROGRESS_STAGES).sort()).toEqual([...STAGE_IDS].sort());
  });

  it('names exactly the two solver operations', () => {
    expect(Object.values(OPERATIONS).sort()).toEqual(['reevaluate', 'solve']);
  });
});

describe('createRequestHandler', () => {
  it('answers a request with the operation result and the same id', () => {
    const { emitted, handle } = handlerHarness({
      solve: (payload) => ({ doubled: payload.value * 2 }),
    });

    handle({ kind: 'request', id: 7, operation: 'solve', payload: { value: 21 } });

    expect(emitted).toEqual([{ kind: 'response', id: 7, result: { doubled: 42 } }]);
  });

  it('routes solve and reevaluate to their own operations', () => {
    const calls = [];
    const { emitted, handle } = handlerHarness({
      solve: (payload) => {
        calls.push(['solve', payload]);
        return 'solve-result';
      },
      reevaluate: (payload) => {
        calls.push(['reevaluate', payload]);
        return 'reevaluate-result';
      },
    });

    handle({ kind: 'request', id: 1, operation: 'solve', payload: { a: 1 } });
    handle({ kind: 'request', id: 2, operation: 'reevaluate', payload: { b: 2 } });

    expect(calls).toEqual([
      ['solve', { a: 1 }],
      ['reevaluate', { b: 2 }],
    ]);
    expect(emitted).toEqual([
      { kind: 'response', id: 1, result: 'solve-result' },
      { kind: 'response', id: 2, result: 'reevaluate-result' },
    ]);
  });

  it('reports progress with the request id, a known stage and numeric counters', () => {
    const { emitted, handle } = handlerHarness({
      solve: (payload, report) => {
        report(PROGRESS_STAGES.BUILD_POOL, { lineups: 0 });
        report(PROGRESS_STAGES.SEARCH_LINEUPS, { lineups: 3, bestCost: 9100, elapsedMs: 12 });
        report(PROGRESS_STAGES.CHECK_CHEMISTRY);
        return 'done';
      },
    });

    handle({ kind: 'request', id: 4, operation: 'solve', payload: {} });

    expect(emitted.slice(0, 3)).toEqual([
      { kind: 'progress', id: 4, stage: 'build-pool', counters: { lineups: 0 } },
      {
        kind: 'progress',
        id: 4,
        stage: 'search-lineups',
        counters: { lineups: 3, bestCost: 9100, elapsedMs: 12 },
      },
      { kind: 'progress', id: 4, stage: 'check-chemistry', counters: {} },
    ]);
    for (const message of emitted.filter(({ kind }) => kind === 'progress')) {
      expect(STAGE_IDS).toContain(message.stage);
      for (const counter of Object.values(message.counters)) {
        expect(Number.isFinite(counter)).toBe(true);
      }
    }
    expect(emitted.at(-1)).toEqual({ kind: 'response', id: 4, result: 'done' });
  });

  it('turns a stage id outside the vocabulary into an error response, not progress', () => {
    const { emitted, handle } = handlerHarness({
      solve: (payload, report) => {
        report('search-lineup');
        return 'never reached';
      },
    });

    expect(() => handle({ kind: 'request', id: 5, operation: 'solve', payload: {} })).not.toThrow();

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('error');
    expect(emitted[0].id).toBe(5);
    expect(emitted[0].error.message).toMatch(/search-lineup/);
  });

  it('rejects a non-numeric counter instead of emitting it', () => {
    const { emitted, handle } = handlerHarness({
      solve: (payload, report) => {
        report(PROGRESS_STAGES.SEARCH_LINEUPS, { lineups: 'three' });
        return 'never reached';
      },
    });

    handle({ kind: 'request', id: 6, operation: 'solve', payload: {} });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('error');
    expect(emitted[0].error.message).toMatch(/lineups/);
  });

  it('converts a solver throw into a structured error response and never throws', () => {
    const { emitted, handle } = handlerHarness({
      solve: () => {
        throw new Error('solve: unknown formation "f999"');
      },
    });

    expect(() => handle({ kind: 'request', id: 8, operation: 'solve', payload: {} })).not.toThrow();
    expect(emitted).toEqual([
      {
        kind: 'error',
        id: 8,
        error: { name: 'Error', message: 'solve: unknown formation "f999"' },
      },
    ]);
  });

  it('normalises a non-Error throw into the same structured shape', () => {
    const { emitted, handle } = handlerHarness({
      solve: () => {
        throw 'plain string failure';
      },
    });

    handle({ kind: 'request', id: 9, operation: 'solve', payload: {} });

    expect(emitted[0]).toEqual({
      kind: 'error',
      id: 9,
      error: { name: 'Error', message: 'plain string failure' },
    });
  });

  it('answers an unknown operation with an error carrying the request id', () => {
    const { emitted, handle } = handlerHarness({});

    handle({ kind: 'request', id: 10, operation: 'explode', payload: {} });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('error');
    expect(emitted[0].id).toBe(10);
    expect(emitted[0].error.message).toContain('explode');
  });

  it('answers a request without an object payload with an error instead of running it', () => {
    const { emitted, handle } = handlerHarness({ solve: () => 'ran anyway' });

    handle({ kind: 'request', id: 11, operation: 'solve' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].kind).toBe('error');
    expect(emitted[0].id).toBe(11);
    expect(emitted[0].error.message).toMatch(/payload/);
  });

  it('ignores malformed messages without throwing or emitting', () => {
    const { emitted, handle } = handlerHarness({ solve: () => 's' });

    for (const malformed of [
      null,
      undefined,
      'solve',
      [],
      {},
      { kind: 'response', id: 1 },
      { kind: 'cancel', id: 1 },
      { kind: 'request', id: 0, operation: 'solve', payload: {} },
      { kind: 'request', id: -1, operation: 'solve', payload: {} },
      { kind: 'request', id: 1.5, operation: 'solve', payload: {} },
      { kind: 'request', id: '1', operation: 'solve', payload: {} },
      { kind: 'request', operation: 'solve', payload: {} },
    ]) {
      expect(() => handle(malformed)).not.toThrow();
    }
    expect(emitted).toEqual([]);
  });
});

describe('createClient', () => {
  it('correlates a response with the request that asked for it', async () => {
    const { client, sent } = clientHarness();
    const { id, promise } = client.request('solve', { challenge: 'c' });

    expect(id).toBe(1);
    expect(sent).toEqual([
      { kind: 'request', id: 1, operation: 'solve', payload: { challenge: 'c' } },
    ]);

    client.handle({ kind: 'response', id: 1, result: { cost: 1200 } });

    await expect(promise).resolves.toEqual({ cost: 1200 });
  });

  it('keeps two concurrent requests apart when their responses arrive out of order', async () => {
    const { client, sent } = clientHarness();
    const seenA = [];
    const seenB = [];
    const first = client.request('solve', { tag: 'a' }, { onProgress: (m) => seenA.push(m.stage) });
    const second = client.request('reevaluate', { tag: 'b' }, {
      onProgress: (m) => seenB.push(m.stage),
    });

    expect(sent.map(({ id }) => id)).toEqual([1, 2]);

    // The second request answers first, and each message lands only on it.
    client.handle({ kind: 'progress', id: 2, stage: 'search-lineups', counters: {} });
    client.handle({ kind: 'response', id: 2, result: 'second-result' });
    client.handle({ kind: 'progress', id: 1, stage: 'search-lineups', counters: {} });
    client.handle({ kind: 'response', id: 1, result: 'first-result' });

    await expect(second.promise).resolves.toBe('second-result');
    await expect(first.promise).resolves.toBe('first-result');
    expect(seenA).toEqual(['search-lineups']);
    expect(seenB).toEqual(['search-lineups']);
  });

  it('discards a cancelled request result on arrival and never settles it', async () => {
    const { client, sent } = clientHarness();
    const applied = vi.fn();
    const onProgress = vi.fn();
    const { id, promise } = client.request('solve', {}, { onProgress });
    promise.then(applied, applied);

    expect(client.cancel(id)).toBe(true);
    expect(sent).toEqual([
      { kind: 'request', id, operation: 'solve', payload: {} },
      { kind: 'cancel', id },
    ]);

    // The worker may already have computed the result; it must not be applied.
    client.handle({ kind: 'progress', id, stage: 'search-lineups', counters: {} });
    client.handle({ kind: 'response', id, result: 'late result' });
    await flush();

    expect(applied).not.toHaveBeenCalled();
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('ignores responses and progress for unknown or stale ids without throwing', async () => {
    const { client } = clientHarness();
    const applied = vi.fn();
    const { id, promise } = client.request('solve', {});
    promise.then(applied);

    expect(() => client.handle({ kind: 'response', id: 999, result: 'never asked' })).not.toThrow();
    expect(() =>
      client.handle({ kind: 'progress', id: 999, stage: 'search-lineups', counters: {} })
    ).not.toThrow();

    client.handle({ kind: 'response', id, result: 'first' });
    await promise;
    client.handle({ kind: 'response', id, result: 'second' });
    client.handle({ kind: 'error', id, error: { name: 'Error', message: 'late' } });
    await flush();

    await expect(promise).resolves.toBe('first');
    expect(applied).toHaveBeenCalledTimes(1);
  });

  it('ignores a response for a cancelled id without throwing', async () => {
    const { client } = clientHarness();
    const { id, promise } = client.request('solve', {});
    promise.catch(() => {});
    client.cancel(id);

    expect(() => client.handle({ kind: 'response', id, result: 'late' })).not.toThrow();
    expect(() =>
      client.handle({ kind: 'error', id, error: { name: 'Error', message: 'late' } })
    ).not.toThrow();
    await flush();
  });

  it('rejects the correlated promise with the structured error', async () => {
    const { client } = clientHarness();
    const { id, promise } = client.request('solve', {});

    client.handle({ kind: 'error', id, error: { name: 'SolveError', message: 'no formation' } });

    await expect(promise).rejects.toThrow('no formation');
    await expect(promise).rejects.toHaveProperty('name', 'SolveError');
  });

  it('returns false and sends nothing when cancelling an unknown id', () => {
    const { client, sent } = clientHarness();

    expect(client.cancel(404)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('issues a fresh positive id per request', () => {
    const { client, sent } = clientHarness();

    client.request('solve', {});
    client.request('solve', {});

    expect(sent.map(({ id }) => id)).toEqual([1, 2]);
  });
});
