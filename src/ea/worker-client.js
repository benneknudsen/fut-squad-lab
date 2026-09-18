/**
 * The isolated-world owner of the solver Worker.
 *
 * `src/page-bridge-app.js` runs in the MAIN world and cannot call
 * `chrome.runtime.getURL`, so it cannot construct the worker itself. The
 * isolated relay constructs it here, once per page session, and brokers the
 * page's solve requests to it. The page never sees the Worker; it sends a
 * token-tagged request and receives token-tagged progress, response or error
 * messages, so one page could in principle run more than one solve without the
 * answers crossing.
 *
 * The request-id correlation, cancellation bookkeeping and message shape stay
 * in the pure `worker-protocol.js`; this module owns only what that module
 * cannot: the worker's lifecycle, the mapping from page token to request id,
 * and turning a worker-level failure (`onerror`, a throw from `postMessage`)
 * into a structured error for every in-flight token instead of leaving the
 * caller waiting forever.
 *
 * The worker is created lazily on the first solve and reused. `teardown` is for
 * navigation: it cancels every in-flight solve, terminates the worker and
 * refuses later requests. No browser global is touched at module scope; the
 * worker factory and the delivery callback are injected, so this module is
 * unit-testable against a fake Worker.
 */

import { createClient } from '../solver/worker-protocol.js';
import { CONTENT_TO_PAGE_KINDS } from '../ui/messages.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isToken = (token) => Number.isInteger(token) && token > 0;

const toError = (value) =>
  value instanceof Error ? value : new Error(String(value));

const failureFrom = (event) => {
  const detail = isRecord(event) && typeof event.message === 'string' ? event.message : null;
  return new Error(
    detail === null
      ? 'worker-client: the solver worker failed'
      : `worker-client: the solver worker failed (${detail})`
  );
};

const cancellationError = () => {
  const error = new Error('worker-client: the solve was cancelled before the worker answered');
  error.name = 'AbortError';
  return error;
};

const closedError = () =>
  new Error('worker-client: the client was torn down; no solver worker is available');

const serialiseError = (error) => ({ name: error.name, message: error.message });

/**
 * @param {{ createWorker: () => object, deliver: (message: object) => void }} deps
 *   `createWorker` constructs the real Worker (throw to report a construction
 *   failure); `deliver` receives one message per settled or progressed token
 * @returns {{ request: (token: number, operation: string, payload: object) => void,
 *   cancel: (token: number) => boolean, teardown: () => void }}
 * @throws {Error} when a dependency is missing or not a function
 */
export function createWorkerClient({ createWorker, deliver } = {}) {
  if (typeof createWorker !== 'function') {
    throw new Error('worker-client: createWorker must be a function');
  }
  if (typeof deliver !== 'function') {
    throw new Error('worker-client: deliver must be a function');
  }

  let worker = null;
  let failure = null;
  let closed = false;
  const tokenToRequestId = new Map();

  const client = createClient({
    send(message) {
      if (failure !== null) throw failure;
      worker.postMessage(message);
    },
  });

  const terminateWorker = () => {
    if (worker !== null && typeof worker.terminate === 'function') worker.terminate();
    worker = null;
  };

  const ensureWorker = () => {
    if (worker !== null) return worker;
    const created = createWorker();
    created.onmessage = (event) => client.handle(event.data);
    created.onerror = (event) => failAll(failureFrom(event));
    created.onmessageerror = () => failAll(failureFrom(null));
    worker = created;
    return created;
  };

  const deliverError = (token, error) =>
    deliver({
      kind: CONTENT_TO_PAGE_KINDS.SOLVE_ERROR,
      token,
      error: serialiseError(error),
    });

  /**
   * Rejects every in-flight token through the protocol client, so the pending
   * promises settle exactly once, then terminates the worker. The failure is
   * remembered: later requests get the same structured error instead of
   * spawning a worker that is known to fail.
   */
  const failAll = (error) => {
    failure = error;
    const ids = [...tokenToRequestId.values()];
    tokenToRequestId.clear();
    for (const id of ids) {
      client.handle({ kind: 'error', id, error: serialiseError(error) });
    }
    terminateWorker();
  };

  return {
    request(token, operation, payload) {
      if (!isToken(token)) return;
      if (closed) {
        deliverError(token, closedError());
        return;
      }
      if (failure !== null) {
        deliverError(token, failure);
        return;
      }
      let entry;
      try {
        ensureWorker();
        entry = client.request(operation, payload, {
          onProgress: (message) =>
            deliver({
              kind: CONTENT_TO_PAGE_KINDS.SOLVE_PROGRESS,
              token,
              stage: message.stage,
              counters: message.counters,
            }),
        });
      } catch (error) {
        deliverError(token, toError(error));
        return;
      }

      tokenToRequestId.set(token, entry.id);
      entry.promise.then(
        (result) => {
          tokenToRequestId.delete(token);
          deliver({ kind: CONTENT_TO_PAGE_KINDS.SOLVE_RESPONSE, token, result });
        },
        (error) => {
          tokenToRequestId.delete(token);
          deliverError(token, error);
        }
      );
    },

    cancel(token) {
      const id = tokenToRequestId.get(token);
      if (id === undefined) return false;
      tokenToRequestId.delete(token);
      client.cancel(id);
      deliverError(token, cancellationError());
      return true;
    },

    teardown() {
      closed = true;
      const entries = [...tokenToRequestId];
      tokenToRequestId.clear();
      for (const [token, id] of entries) {
        client.cancel(id);
        deliverError(token, cancellationError());
      }
      terminateWorker();
    },
  };
}
