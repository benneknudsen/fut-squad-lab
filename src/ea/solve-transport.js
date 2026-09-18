/**
 * The MAIN-world side of the solve relay: a promise-returning `requestSolve`
 * for `src/ea/solve-runner.js`, backed by the isolated relay that owns the
 * solver Worker.
 *
 * The page bridge cannot construct the worker (`chrome.runtime` does not exist
 * in the MAIN world), so a solve is two messages: this module tags the request
 * with its own monotonically increasing token and posts it, the isolated world
 * runs the worker and posts progress, a response or a structured error back
 * with the same token. Tokens are validated and stale answers for a settled or
 * cancelled token are ignored, so a late worker result is never applied.
 *
 * The transport owns no browser global: `post` is injected, so the page bridge
 * supplies its own source-tagged `window.postMessage` and tests can supply a
 * recorder.
 */

import { CONTENT_TO_PAGE_KINDS, PAGE_TO_CONTENT_KINDS } from '../ui/messages.js';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isToken = (token) => Number.isInteger(token) && token > 0;

const abortError = () => {
  const error = new Error('solve-transport: the solve was cancelled');
  error.name = 'AbortError';
  return error;
};

const workerError = (payload) => {
  const message =
    isRecord(payload) && typeof payload.message === 'string' && payload.message.length > 0
      ? payload.message
      : 'solve-transport: the solver worker failed';
  const error = new Error(message);
  if (isRecord(payload) && typeof payload.name === 'string' && payload.name.length > 0) {
    error.name = payload.name;
  }
  return error;
};

/**
 * @param {{ post: (message: object) => void }} deps `post` sends one message to
 *   the isolated relay; the page bridge adds the source tag
 * @returns {{ requestSolve: (operation: string, payload: object) => Promise<object>,
 *   handle: (message: *) => void, cancel: () => void }}
 * @throws {Error} when `post` is not a function
 */
export function createSolveTransport({ post } = {}) {
  if (typeof post !== 'function') {
    throw new Error('solve-transport: post must be a function');
  }

  const pending = new Map();
  let nextToken = 1;

  return {
    requestSolve(operation, payload) {
      const token = nextToken++;
      return new Promise((resolve, reject) => {
        pending.set(token, { resolve, reject });
        post({ kind: PAGE_TO_CONTENT_KINDS.SOLVE_REQUEST, token, operation, payload });
      });
    },

    handle(message) {
      if (!isRecord(message) || !isToken(message.token)) return;
      if (
        message.kind !== CONTENT_TO_PAGE_KINDS.SOLVE_RESPONSE &&
        message.kind !== CONTENT_TO_PAGE_KINDS.SOLVE_ERROR
      ) {
        return;
      }
      const entry = pending.get(message.token);
      if (entry === undefined) return;
      pending.delete(message.token);
      if (message.kind === CONTENT_TO_PAGE_KINDS.SOLVE_RESPONSE) {
        entry.resolve(message.result);
        return;
      }
      entry.reject(workerError(message.error));
    },

    cancel() {
      for (const [token, entry] of pending) {
        entry.reject(abortError());
        post({ kind: PAGE_TO_CONTENT_KINDS.SOLVE_CANCEL, token });
      }
      pending.clear();
    },
  };
}
