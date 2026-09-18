/**
 * The Worker entry point for the pure solver.
 *
 * This is the only file under `src/solver/` allowed to touch a browser global,
 * and it touches exactly one: `self`. It owns the worker's message channel,
 * imports the pure solver entry points and dispatches. No solver logic of any
 * kind lives here, and no other solver module may import this file. Everything
 * that is testable without a Worker — request-id correlation, cancellation
 * bookkeeping, the message shapes — lives in `worker-protocol.js`.
 *
 * Progress is honest. One start message marks the search beginning, and one
 * completion message carries only the counters the solver actually returned:
 * `improvements.lineups`, `improvements.elapsedMs` and `cost` when it is a
 * known number. A `null` cost (an unpriced card) is omitted rather than
 * reported as zero, and `reevaluate` reports no lineup counters because it does
 * not return any. Nothing here invents a number the solver did not produce.
 *
 * The UI translates stage ids and counter keys to copy; this file emits no
 * user-facing strings.
 */

import { OPERATIONS, PROGRESS_STAGES, createRequestHandler } from './worker-protocol.js';
import { reevaluate, solve } from './solve.js';

const completionCounters = (result) => {
  const counters = {};
  if (typeof result.cost === 'number') counters.bestCost = result.cost;
  const improvements = result.improvements;
  if (improvements !== undefined) {
    counters.lineups = improvements.lineups;
    counters.elapsedMs = improvements.elapsedMs;
  }
  return counters;
};

const withSearchProgress = (run) => (payload, report) => {
  report(PROGRESS_STAGES.SEARCH_LINEUPS);
  const result = run(payload);
  report(PROGRESS_STAGES.SEARCH_LINEUPS, completionCounters(result));
  return result;
};

const handle = createRequestHandler({
  operations: {
    [OPERATIONS.SOLVE]: withSearchProgress(({ challenge, pool, options }) =>
      solve(challenge, pool, options)
    ),
    [OPERATIONS.REEVALUATE]: withSearchProgress(({ squad, lockedSlots, pool, options }) =>
      reevaluate(squad, lockedSlots, pool, options)
    ),
  },
  emit: (message) => self.postMessage(message),
});

self.onmessage = (event) => handle(event.data);
