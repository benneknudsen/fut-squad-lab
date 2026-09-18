import { describe, expect, it, vi } from 'vitest';

import { createSolveTransport } from '../src/ea/solve-transport.js';
import { CONTENT_TO_PAGE_KINDS, PAGE_TO_CONTENT_KINDS } from '../src/ui/messages.js';

const createHarness = () => {
  const posted = [];
  const transport = createSolveTransport({ post: (message) => posted.push(message) });
  return { posted, transport };
};

const requestsOf = (posted) => posted.filter((message) => message.kind === PAGE_TO_CONTENT_KINDS.SOLVE_REQUEST);

describe('createSolveTransport', () => {
  it('posts one solve request per solve and resolves it with the matching result', async () => {
    const { posted, transport } = createHarness();

    const promise = transport.requestSolve('solve', { challenge: 'a' });
    const promise2 = transport.requestSolve('reevaluate', { squad: 'b' });

    expect(requestsOf(posted)).toHaveLength(2);
    expect(requestsOf(posted)[0]).toMatchObject({
      kind: PAGE_TO_CONTENT_KINDS.SOLVE_REQUEST,
      operation: 'solve',
      payload: { challenge: 'a' },
    });

    const [first, second] = requestsOf(posted);
    transport.handle({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_RESPONSE,
      token: second.token,
      result: { squad: 'second' },
    });
    transport.handle({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_RESPONSE,
      token: first.token,
      result: { squad: 'first' },
    });

    await expect(promise).resolves.toEqual({ squad: 'first' });
    await expect(promise2).resolves.toEqual({ squad: 'second' });
  });

  it('rejects with the worker error name and message', async () => {
    const { posted, transport } = createHarness();

    const promise = transport.requestSolve('solve', {});
    const [request] = requestsOf(posted);
    transport.handle({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_ERROR,
      token: request.token,
      error: { name: 'RangeError', message: 'solve: unknown formation' },
    });

    const error = await promise.catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RangeError');
    expect(error.message).toBe('solve: unknown formation');
  });

  it('does not let progress settle a solve', async () => {
    const { posted, transport } = createHarness();
    let settled = false;

    const promise = transport.requestSolve('solve', {});
    promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const [request] = requestsOf(posted);
    transport.handle({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_PROGRESS,
      token: request.token,
      stage: 'search-lineups',
      counters: { lineups: 1 },
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    transport.handle({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_RESPONSE,
      token: request.token,
      result: 'done',
    });
    await expect(promise).resolves.toBe('done');
  });

  it('ignores a response for a token it never issued', async () => {
    const { transport } = createHarness();

    expect(() =>
      transport.handle({
        kind: CONTENT_TO_PAGE_KINDS.SOLVE_RESPONSE,
        token: 4242,
        result: 'foreign',
      })
    ).not.toThrow();
  });

  it('cancels every pending solve: rejects it and tells the relay to stop the worker', async () => {
    const { posted, transport } = createHarness();

    const first = transport.requestSolve('solve', {});
    const second = transport.requestSolve('reevaluate', {});
    const tokens = requestsOf(posted).map((message) => message.token);

    transport.cancel();

    const cancelKinds = posted.filter(
      (message) => message.kind === PAGE_TO_CONTENT_KINDS.SOLVE_CANCEL
    );
    expect(cancelKinds.map((message) => message.token)).toEqual(tokens);
    for (const promise of [first, second]) {
      const error = await promise.catch((caught) => caught);
      expect(error.name).toBe('AbortError');
    }

    const late = transport.handle({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_RESPONSE,
      token: tokens[0],
      result: 'late',
    });
    expect(late).toBeUndefined();
  });

  it('requires the post callback', () => {
    expect(() => createSolveTransport({})).toThrow(/post/);
  });
});
