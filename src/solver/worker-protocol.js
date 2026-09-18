/**
 * The pure message protocol spoken between the solver Worker and its client.
 *
 * This module may be imported in Node with no Worker, no extension APIs, no DOM
 * and no browser global at module top level: the transport is injected. It owns the
 * three things that are easy to get wrong and worth testing directly —
 * request-id correlation, cancellation bookkeeping and the message shapes —
 * while the solver itself stays untouched next door.
 *
 * ## Message shapes
 *
 * Client to worker:
 *
 * ```js
 * { kind: 'request', id: 1, operation: 'solve', payload: { challenge, pool, options } }
 * { kind: 'request', id: 2, operation: 'reevaluate',
 *   payload: { squad, lockedSlots, pool, options } }
 * { kind: 'cancel', id: 1 }
 * ```
 *
 * Worker to client:
 *
 * ```js
 * { kind: 'progress', id: 1, stage: 'search-lineups', counters: { lineups: 3 } }
 * { kind: 'response', id: 1, result: { squad, cost, valid, failures, unverified } }
 * { kind: 'error', id: 1, error: { name: 'Error', message: 'solve: ...' } }
 * ```
 *
 * Every response, progress message and error echoes the id of the request it
 * belongs to. A response for an id that was never issued, was already answered
 * or was cancelled is ignored, not applied.
 *
 * ## Cancellation
 *
 * `cancel(id)` drops the pending entry before the worker's answer arrives, so a
 * late result is discarded on arrival even though the worker may already have
 * computed it. A best-effort `{ kind: 'cancel' }` message is also sent so the
 * worker can skip work it has not started; nothing relies on it.
 *
 * ## Progress is structured, never prose
 *
 * A progress message carries a stage id from the closed `PROGRESS_STAGES`
 * vocabulary and counters whose values are finite numbers. The stage ids are
 * the five steps the design contract renders (`design/copy.en.json` ->
 * `states.solving`), and the counters use that block's own keys: `lineups`,
 * `bestCost`, `depth` and `elapsedMs`. The UI owns every user-facing string, so
 * no progress message ever contains a sentence.
 */

/** The closed solving-stage vocabulary from `design/copy.en.json` step1..step5. */
export const PROGRESS_STAGES = Object.freeze({
  READ_CLUB: 'read-club',
  BUILD_POOL: 'build-pool',
  SEARCH_LINEUPS: 'search-lineups',
  CHECK_CHEMISTRY: 'check-chemistry',
  PRICE_CARDS: 'price-cards',
});

/** The two solver entry points the worker exposes. */
export const OPERATIONS = Object.freeze({
  SOLVE: 'solve',
  REEVALUATE: 'reevaluate',
});

const STAGE_SET = new Set(Object.values(PROGRESS_STAGES));

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isRequestId = (id) => Number.isInteger(id) && id > 0;

const normaliseError = (error) =>
  error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };

/**
 * Builds the worker-side message handler. Each request is dispatched to the
 * matching function in `operations`; the function receives the payload and a
 * `report(stage, counters)` callback, and its return value becomes the response
 * result. Anything the operation throws — including a progress-report typo
 * caught by this module — becomes a structured error response carrying the
 * request id, so the worker never throws unhandled.
 *
 * @param {{ [operation: string]: (payload: object,
 *   report: (stage: string, counters?: object) => void) => * }} operations the
 *   operation table, keyed by `OPERATIONS` value
 * @param {(message: object) => void} emit delivers one outgoing message
 * @returns {(message: *) => void} a handler that never throws
 * @throws {Error} when `operations` is not an object or `emit` is not a function
 */
export function createRequestHandler({ operations, emit } = {}) {
  if (!isRecord(operations)) {
    throw new Error('worker-protocol: operations must be an object');
  }
  if (typeof emit !== 'function') {
    throw new Error('worker-protocol: emit must be a function');
  }

  const emitError = (id, error) => emit({ kind: 'error', id, error: normaliseError(error) });

  const report = (id, stage, counters = {}) => {
    if (!STAGE_SET.has(stage)) {
      throw new Error(
        `worker-protocol: progress stage ${JSON.stringify(stage)} is not in the solving vocabulary`
      );
    }
    if (!isRecord(counters)) {
      throw new Error('worker-protocol: progress counters must be an object');
    }
    const normalised = {};
    for (const [key, value] of Object.entries(counters)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `worker-protocol: progress counter ${JSON.stringify(key)} must be a finite number`
        );
      }
      normalised[key] = value;
    }
    emit({ kind: 'progress', id, stage, counters: normalised });
  };

  return function handle(message) {
    if (!isRecord(message) || message.kind !== 'request') return;

    const { id, operation, payload } = message;
    if (!isRequestId(id)) return;
    if (!isRecord(payload)) {
      emitError(id, new Error('worker-protocol: request payload must be an object'));
      return;
    }

    const run = operations[operation];
    if (typeof run !== 'function') {
      emitError(id, new Error(`worker-protocol: unknown operation ${JSON.stringify(operation)}`));
      return;
    }

    try {
      const result = run(payload, (stage, counters) => report(id, stage, counters));
      emit({ kind: 'response', id, result });
    } catch (error) {
      emitError(id, error);
    }
  };
}

/**
 * Builds the client-side protocol state. The caller supplies `send` (usually
 * `(message) => worker.postMessage(message)`); incoming worker messages are
 * fed to `handle`.
 *
 * `request` returns `{ id, promise }` and an optional per-request `onProgress`
 * callback. `cancel(id)` removes the pending entry and sends a best-effort
 * cancel message; the promise then never settles and every later message for
 * that id is ignored. A completed id is removed as well, so a duplicate or
 * stale response cannot resolve a promise twice.
 *
 * @param {{ send: (message: object) => void }} transport the outgoing channel
 * @returns {{ request: (operation: string, payload: object,
 *   options?: { onProgress?: (message: object) => void }) => { id: number,
 *   promise: Promise<*> }, cancel: (id: number) => boolean,
 *   handle: (message: *) => void }}
 * @throws {Error} when `send` is not a function
 */
export function createClient({ send } = {}) {
  if (typeof send !== 'function') {
    throw new Error('worker-protocol: send must be a function');
  }

  const pending = new Map();
  let nextId = 1;

  return {
    request(operation, payload, { onProgress } = {}) {
      const id = nextId++;
      let resolveRequest;
      let rejectRequest;
      const promise = new Promise((resolve, reject) => {
        resolveRequest = resolve;
        rejectRequest = reject;
      });
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest, onProgress });
      send({ kind: 'request', id, operation, payload });
      return { id, promise };
    },

    cancel(id) {
      if (!pending.has(id)) return false;
      pending.delete(id);
      send({ kind: 'cancel', id });
      return true;
    },

    handle(message) {
      if (!isRecord(message) || !isRequestId(message.id)) return;
      const entry = pending.get(message.id);
      if (entry === undefined) return;

      if (message.kind === 'progress') {
        if (typeof entry.onProgress === 'function') entry.onProgress(message);
        return;
      }
      if (message.kind === 'response') {
        pending.delete(message.id);
        entry.resolve(message.result);
        return;
      }
      if (message.kind === 'error') {
        pending.delete(message.id);
        const error = new Error(message.error?.message ?? 'worker-protocol: the solver failed');
        if (typeof message.error?.name === 'string') error.name = message.error.name;
        entry.reject(error);
      }
    },
  };
}
