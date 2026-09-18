import { describe, expect, it, vi } from 'vitest';

import { createWorkerClient } from '../src/ea/worker-client.js';
import { CONTENT_TO_PAGE_KINDS } from '../src/ui/messages.js';

// A fake Worker: records what the client posts, lets the test fire the two
// failure events a real Worker can raise, and records termination. No jsdom,
// no real Worker, no timing.
const createFakeWorker = () => {
  const posted = [];
  return {
    posted,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    terminated: 0,
    postMessage(message) {
      posted.push(message);
    },
    terminate() {
      this.terminated += 1;
    },
  };
};

const createHarness = () => {
  const worker = createFakeWorker();
  const createWorker = vi.fn(() => worker);
  const delivered = [];
  const client = createWorkerClient({
    createWorker,
    deliver: (message) => delivered.push(message),
  });
  return { worker, createWorker, delivered, client };
};

const responseFor = (worker, index, result) => {
  const request = worker.posted.filter((message) => message.kind === 'request')[index];
  worker.onmessage({ data: { kind: 'response', id: request.id, result } });
  return request;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createWorkerClient', () => {
  it('sends exactly one worker request per solve and reuses one worker', () => {
    const { worker, createWorker, client } = createHarness();

    client.request(11, 'solve', { challenge: 'a' });
    client.request(12, 'solve', { challenge: 'b' });

    expect(createWorker).toHaveBeenCalledTimes(1);
    const requests = worker.posted.filter((message) => message.kind === 'request');
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      kind: 'request',
      operation: 'solve',
      payload: { challenge: 'a' },
    });
    expect(requests[1]).toMatchObject({
      kind: 'request',
      operation: 'solve',
      payload: { challenge: 'b' },
    });
    expect(requests[0].id).not.toBe(requests[1].id);
  });

  it('delivers a response against the page token that asked for it', async () => {
    const { worker, delivered, client } = createHarness();

    client.request(7, 'solve', {});
    client.request(8, 'reevaluate', {});
    responseFor(worker, 1, { squad: { players: [] } });
    await flush();

    expect(delivered).toEqual([
      {
        kind: CONTENT_TO_PAGE_KINDS.SOLVE_RESPONSE,
        token: 8,
        result: { squad: { players: [] } },
      },
    ]);
  });

  it('forwards structured progress for the asking token', () => {
    const { worker, delivered, client } = createHarness();

    client.request(3, 'solve', {});
    const request = worker.posted[0];
    worker.onmessage({
      data: {
        kind: 'progress',
        id: request.id,
        stage: 'search-lineups',
        counters: { lineups: 4 },
      },
    });

    expect(delivered).toEqual([
      {
        kind: CONTENT_TO_PAGE_KINDS.SOLVE_PROGRESS,
        token: 3,
        stage: 'search-lineups',
        counters: { lineups: 4 },
      },
    ]);
  });

  it('fails a pending solve with a structured error when the worker fails, never a hang', async () => {
    const { worker, delivered, client } = createHarness();

    client.request(4, 'solve', {});
    worker.onerror({ message: 'Failed to load worker script' });
    await flush();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_ERROR,
      token: 4,
      error: { name: 'Error' },
    });
    expect(delivered[0].error.message).toContain('Failed to load worker script');

    client.request(5, 'solve', {});
    expect(delivered).toHaveLength(2);
    expect(delivered[1]).toMatchObject({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_ERROR,
      token: 5,
    });
    expect(worker.posted.filter((message) => message.kind === 'request')).toHaveLength(1);
  });

  it('cancels a page token: forwards a cancel to the worker and fails the token', () => {
    const { worker, delivered, client } = createHarness();

    client.request(6, 'solve', {});
    const request = worker.posted[0];

    expect(client.cancel(6)).toBe(true);

    expect(worker.posted).toContainEqual({ kind: 'cancel', id: request.id });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_ERROR,
      token: 6,
      error: { name: 'AbortError' },
    });
    expect(client.cancel(6)).toBe(false);
  });

  it('tears the worker down: cancels every in-flight solve and terminates once', () => {
    const { worker, delivered, client } = createHarness();

    client.request(21, 'solve', {});
    client.request(22, 'reevaluate', {});
    client.teardown();

    expect(worker.terminated).toBe(1);
    expect(worker.posted.filter((message) => message.kind === 'cancel')).toHaveLength(2);
    expect(delivered.map((message) => message.kind)).toEqual([
      CONTENT_TO_PAGE_KINDS.SOLVE_ERROR,
      CONTENT_TO_PAGE_KINDS.SOLVE_ERROR,
    ]);

    client.request(23, 'solve', {});
    expect(delivered.at(-1)).toMatchObject({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_ERROR,
      token: 23,
    });
  });

  it('ignores a late response for a cancelled or unknown token', () => {
    const { worker, delivered, client } = createHarness();

    client.request(31, 'solve', {});
    const request = worker.posted[0];
    client.cancel(31);
    delivered.length = 0;

    worker.onmessage({ data: { kind: 'response', id: request.id, result: 'late' } });
    worker.onmessage({ data: { kind: 'response', id: 999, result: 'unknown' } });

    expect(delivered).toEqual([]);
  });

  it('rejects a client without a worker factory or a delivery callback', () => {
    expect(() => createWorkerClient({ deliver: () => {} })).toThrow(/createWorker/);
    expect(() => createWorkerClient({ createWorker: () => {} })).toThrow(/deliver/);
  });

  it('ignores a request whose token is not a positive integer', () => {
    const { worker, client } = createHarness();

    client.request(0, 'solve', {});
    client.request('one', 'solve', {});
    client.request(-2, 'solve', {});

    expect(worker.posted).toEqual([]);
  });
});
