/**
 * The pacing layer for every EA service call (#52).
 *
 * The extension runs inside the player's own authenticated FC27 session, so a
 * rate limit or an account flag is not a bug we can fix afterwards. This module
 * is the one place that decides *when* an EA call starts:
 *
 * - one serialised queue with concurrency 1: no two EA calls are ever in
 *   flight together;
 * - a minimum gap between call *starts*, jittered upward so calls do not land
 *   in lockstep;
 * - an explicit, narrow retry policy with bounded exponential backoff;
 * - cancellable waits, so a cancel never leaves a timer running and a solve
 *   never becomes unresponsive while waiting;
 * - counters (`calls`, `waits`, `retries`, `waitedMs`) a diagnostic can report.
 *
 * The constants are a defensive configuration adopted from another project's
 * experience; they are **not** a measurement of FC27's real limits. They live
 * here as named exports so no call site carries a magic number.
 *
 * This module changes *when* calls happen, never *what* is read or written. It
 * is pure of the page: no DOM, no `chrome.*`, no network. The only browser
 * primitives it uses are `setTimeout`/`clearTimeout` and `Date.now`.
 */

/** Minimum gap between two EA call starts. */
export const MIN_CALL_GAP_MS = 950;

/**
 * Gap before a submit. Strictly longer than `MIN_CALL_GAP_MS` because a submit
 * is the one irreversible call. Reserved: this build never submits, and adding
 * submission is explicitly out of scope (#52, AGENTS.md rule 6).
 */
export const SUBMIT_CALL_GAP_MS = 2200;

/**
 * Upward-only jitter on waits: a wait is `base * (1 + random * ratio)`. Upward
 * only so the documented minimum stays a floor instead of an average.
 */
export const JITTER_RATIO = 0.25;

/** First backoff delay; each retry doubles it until the cap. */
export const BACKOFF_BASE_MS = 2500;

/** Hard ceiling on any backoff delay, applied after jitter. */
export const BACKOFF_MAX_MS = 20000;

/**
 * Attempts for a call kind the budget table does not name. One attempt: an
 * unlisted call fails fast rather than retrying something we have not reasoned
 * about.
 */
export const DEFAULT_ATTEMPT_BUDGET = 1;

/**
 * Maximum attempts per call kind. `challengeLoad`, `save` and `submit` carry
 * the reference configuration's named budgets; `clubPage` and `squadRead` are
 * reads given the same two-attempt ceiling as a challenge load, because a read
 * writes nothing and the alternative is falling through to a less reliable
 * strategy. A budget is a total attempt count, not a retry count.
 */
export const ATTEMPT_BUDGETS = Object.freeze({
  challengeLoad: 2,
  clubPage: 2,
  squadRead: 2,
  save: 3,
  submit: 1,
});

/**
 * The call kinds the pacing layer distinguishes. A kind selects the gap before
 * the call and the attempt budget; `save` and `submit` additionally mark a
 * status 475 as EA's show-stopper rejection rather than a transient condition.
 */
export const CALL_KINDS = Object.freeze({
  READ: 'read',
  CHALLENGE_LOAD: 'challengeLoad',
  CLUB_PAGE: 'clubPage',
  SQUAD_READ: 'squadRead',
  SAVE: 'save',
  SUBMIT: 'submit',
});

/** Status EA returns when its service is asking the caller to slow down. */
export const RATE_LIMIT_STATUS = 429;

/**
 * The doubly meaningful status: in a read context it is the transient "slow
 * down" condition, and on a squad write it is EA's "Ineligible Squad" rejection.
 * `classifyFailure` interprets it from the call kind and the error message.
 */
export const DUAL_STATUS = 475;

/** Server errors (5xx) are transient and retried. */
export const SERVER_ERROR_FLOOR = 500;

/**
 * The error strings that are retried when no status decides. The reference
 * pattern is `rate|limit|thrott|timeout|busy|tempor`; `timed out` is added
 * because that is the wording the observable bridge's own timeout uses
 * (`src/ea/observable.js`), and a subscription that timed out is exactly the
 * transient condition this retries.
 */
export const RETRYABLE_MESSAGE_PATTERN = /rate|limit|thrott|timeout|timed out|busy|tempor/i;

/**
 * The message half of the status 475 dual meaning: when EA says "ineligible"
 * the rejection is final, whichever context reported it.
 */
export const INELIGIBLE_SQUAD_PATTERN = /ineligib/i;

/**
 * The call kinds for which status 475 is EA's squad rejection, never a
 * transient condition. Kept explicit so 475 is never treated as one thing.
 */
export const REJECTION_CALL_KINDS = Object.freeze([CALL_KINDS.SAVE, CALL_KINDS.SUBMIT]);

/**
 * The name a failure raised by the observable bridge carries, so a wrapped
 * budget-exhaustion error can keep the same description. Exported because the
 * adapter and the squad writer both build these errors (`src/ea/adapter.js`,
 * `src/ea/squad-writer.js`).
 */
export const EA_CALL_FAILURE_NAME = 'EaCallError';

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const describeError = (error) =>
  error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);

const resolveNumber = (value, fallback, floor = 0) =>
  Number.isFinite(value) && value >= floor ? value : fallback;

const resolveBudget = (kind, explicit, budgets) => {
  if (Number.isInteger(explicit) && explicit >= 1) return explicit;
  const fromTable = budgets[kind];
  return Number.isInteger(fromTable) && fromTable >= 1 ? fromTable : DEFAULT_ATTEMPT_BUDGET;
};

/**
 * The documented minimum gap for a call kind. The pacer instance has its own
 * `minGapMs`/`submitGapMs` so tests can run without real waiting; this pure
 * helper is the one the constants are stated in.
 *
 * @param {string} kind a value of `CALL_KINDS`
 * @returns {number} the minimum gap, in milliseconds, before that call starts
 */
export function gapMsFor(kind) {
  return kind === CALL_KINDS.SUBMIT ? SUBMIT_CALL_GAP_MS : MIN_CALL_GAP_MS;
}

/**
 * Applies the documented, upward-only jitter: the result is never below the
 * base and never above `base * (1 + ratio)`.
 *
 * @param {number} baseMs the base wait
 * @param {{ random?: () => number, ratio?: number }} [options] `random` is
 *   injectable so tests are deterministic
 * @returns {number} the jittered wait, rounded to whole milliseconds
 */
export function jitteredDelay(baseMs, options = {}) {
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const ratio = resolveNumber(options.ratio, JITTER_RATIO, 0);
  const sample = resolveNumber(random(), 0, 0);
  return Math.round(baseMs * (1 + Math.min(sample, 1) * ratio));
}

/**
 * The bounded exponential backoff for a zero-based retry index: `base * 2^n`,
 * jittered upward and hard-capped at `BACKOFF_MAX_MS`. Capping after jitter
 * keeps the maximum absolute.
 *
 * @param {number} attempt zero-based retry index
 * @param {{ random?: () => number, baseMs?: number, capMs?: number,
 *   jitterRatio?: number }} [options] injectable so tests are deterministic
 * @returns {number} the wait before the next attempt, in milliseconds
 */
export function backoffDelay(attempt, options = {}) {
  const baseMs = resolveNumber(options.baseMs, BACKOFF_BASE_MS, 0);
  const capMs = resolveNumber(options.capMs, BACKOFF_MAX_MS, 0);
  const exponent = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
  const exponential = Math.min(baseMs * 2 ** exponent, capMs);
  return Math.min(
    capMs,
    jitteredDelay(exponential, { random: options.random, ratio: options.jitterRatio })
  );
}

/**
 * Decides whether one failed EA call may be retried, and why. This is the
 * entire retry table: status 429, status 475 *when the context says it is
 * transient*, any 5xx, and a message matching `RETRYABLE_MESSAGE_PATTERN`.
 * Everything else fails fast with a reason.
 *
 * Status 475 is explicit here, never one thing: an ineligible-squad message is
 * final in every context, and a 475 from a save or submit is EA rejecting the
 * squad, while a 475 from a read is the transient "slow down" condition. The
 * two interpretations never share a branch.
 *
 * @param {{ status?: number, message?: string }|Error} error the failed call
 * @param {{ kind?: string }} [context] the call kind the failure happened in
 * @returns {{ retry: boolean, reason: string }} frozen decision; `reason` is
 *   always a non-empty sentence a diagnostic can print
 */
export function classifyFailure(error, context = {}) {
  const status = Number.isFinite(error?.status) ? error.status : null;
  const message = describeError(error);
  const kind = context.kind ?? CALL_KINDS.READ;

  if (status === DUAL_STATUS) {
    if (INELIGIBLE_SQUAD_PATTERN.test(message)) {
      return Object.freeze({
        retry: false,
        reason: `status ${DUAL_STATUS} with an ineligible-squad message: EA rejected the squad, not a transient condition`,
      });
    }
    if (REJECTION_CALL_KINDS.includes(kind)) {
      return Object.freeze({
        retry: false,
        reason: `status ${DUAL_STATUS} from a ${kind} call: EA rejected the squad as ineligible`,
      });
    }
    return Object.freeze({
      retry: true,
      reason: `status ${DUAL_STATUS} from a ${kind} call: a transient EA condition`,
    });
  }
  if (status === RATE_LIMIT_STATUS) {
    return Object.freeze({ retry: true, reason: `status ${RATE_LIMIT_STATUS}: rate limited` });
  }
  if (status !== null && status >= SERVER_ERROR_FLOOR) {
    return Object.freeze({ retry: true, reason: `status ${status}: transient server error` });
  }
  if (RETRYABLE_MESSAGE_PATTERN.test(message)) {
    return Object.freeze({
      retry: true,
      reason: `the error message matches the rate-limit pattern: ${message}`,
    });
  }
  return Object.freeze({ retry: false, reason: `not a documented retry condition: ${message}` });
}

const cancelledError = (label) => {
  const error = new Error(`pacing: the call was cancelled before it started (${label})`);
  error.name = 'AbortError';
  return error;
};

const exhaustedError = (error, attempts, budget, decision) => {
  const wrapped = new Error(
    `attempt budget of ${budget} exhausted after ${attempts} attempts: ${describeError(error)}`
  );
  if (typeof error?.name === 'string' && error.name.length > 0) wrapped.name = error.name;
  if (Number.isFinite(error?.status)) wrapped.status = error.status;
  wrapped.cause = error;
  wrapped.pacing = Object.freeze({ attempts, budget, reason: decision.reason });
  return wrapped;
};

let sharedPacer = null;

/**
 * The process-wide pacer used when a caller does not inject one. Every EA call
 * goes through *a* queue by default, so a pacing bypass is not constructible by
 * forgetting the option; tests inject their own zero-wait pacer instead.
 *
 * @returns {object} the shared pacer, created on first use
 */
export function defaultPacer() {
  if (sharedPacer === null) sharedPacer = createPacer();
  return sharedPacer;
}

/**
 * Creates one serialised pacer. All options are overrides for tests or for a
 * caller with a different configuration; production uses the defaults.
 *
 * @param {{ minGapMs?: number, submitGapMs?: number, jitterRatio?: number,
 *   backoffBaseMs?: number, backoffMaxMs?: number, random?: () => number,
 *   budgets?: object }} [options]
 * @returns {{ run: Function, cancel: Function, reset: Function,
 *   snapshot: Function }}
 *   `run(label, task, { kind, budget })` queues one call and resolves with the
 *   task's value; `cancel()` clears the active timer and rejects every queued
 *   call; `reset()` re-arms the pacer after a cancel; `snapshot()` returns a
 *   frozen counter report
 */
export function createPacer(options = {}) {
  const minGapMs = resolveNumber(options.minGapMs, MIN_CALL_GAP_MS, 0);
  const submitGapMs = resolveNumber(options.submitGapMs, SUBMIT_CALL_GAP_MS, 0);
  const jitterRatio = resolveNumber(options.jitterRatio, JITTER_RATIO, 0);
  const backoffBaseMs = resolveNumber(options.backoffBaseMs, BACKOFF_BASE_MS, 0);
  const backoffMaxMs = resolveNumber(options.backoffMaxMs, BACKOFF_MAX_MS, 0);
  const random = typeof options.random === 'function' ? options.random : Math.random;
  const budgets = isRecord(options.budgets) ? { ...ATTEMPT_BUDGETS, ...options.budgets } : ATTEMPT_BUDGETS;

  const counters = { calls: 0, waits: 0, retries: 0, waitedMs: 0 };
  const queue = [];
  let inFlight = false;
  let activeWait = null;
  let cancelled = false;
  let lastStartedAt = null;

  const gapForKind = (kind) =>
    kind === CALL_KINDS.SUBMIT ? Math.max(submitGapMs, minGapMs) : minGapMs;

  const snapshot = () =>
    Object.freeze({
      calls: counters.calls,
      waits: counters.waits,
      retries: counters.retries,
      waitedMs: counters.waitedMs,
    });

  const wait = (ms) => {
    counters.waits += 1;
    counters.waitedMs += ms;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        activeWait = null;
        resolve();
      }, ms);
      activeWait = { timer, reject };
    });
  };

  const execute = async (entry) => {
    const budget = resolveBudget(entry.kind, entry.budget, budgets);
    if (cancelled) throw cancelledError(entry.label);

    if (lastStartedAt !== null) {
      const remaining = Math.max(0, gapForKind(entry.kind) - (Date.now() - lastStartedAt));
      if (remaining > 0) {
        await wait(jitteredDelay(remaining, { random, ratio: jitterRatio }));
        if (cancelled) throw cancelledError(entry.label);
      }
    }

    let attempt = 0;
    while (true) {
      if (cancelled) throw cancelledError(entry.label);
      attempt += 1;
      counters.calls += 1;
      lastStartedAt = Date.now();
      try {
        return await entry.task(attempt);
      } catch (error) {
        const decision = classifyFailure(error, { kind: entry.kind });
        if (decision.retry !== true) throw error;
        if (attempt >= budget) throw exhaustedError(error, attempt, budget, decision);
        counters.retries += 1;
        await wait(
          backoffDelay(attempt - 1, {
            random,
            baseMs: backoffBaseMs,
            capMs: backoffMaxMs,
            jitterRatio,
          })
        );
      }
    }
  };

  const pump = () => {
    if (inFlight) return;
    const entry = queue.shift();
    if (entry === undefined) return;
    inFlight = true;
    execute(entry)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        inFlight = false;
        pump();
      });
  };

  return {
    run(label, task, options = {}) {
      return new Promise((resolve, reject) => {
        const name = typeof label === 'string' && label.length > 0 ? label : 'unnamed EA call';
        if (typeof task !== 'function') {
          reject(new Error('pacing: run requires a task function'));
          return;
        }
        if (cancelled) {
          reject(cancelledError(name));
          return;
        }
        queue.push({
          label: name,
          task,
          kind: options.kind ?? CALL_KINDS.READ,
          budget: options.budget,
          resolve,
          reject,
        });
        pump();
      });
    },

    cancel() {
      cancelled = true;
      if (activeWait !== null) {
        clearTimeout(activeWait.timer);
        const reject = activeWait.reject;
        activeWait = null;
        reject(cancelledError('a paced wait'));
      }
      while (queue.length > 0) {
        queue.shift().reject(cancelledError('a queued call'));
      }
    },

    reset() {
      cancelled = false;
    },

    snapshot,
  };
}