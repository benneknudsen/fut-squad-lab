/**
 * The observable bridge for EA's read path (#51).
 *
 * EA's service methods that read data do not return the data: they return an
 * observable. The caller subscribes with `.observe(callback)`, reads the
 * payload inside the callback and unsubscribes through the observer's
 * `.unobserve()`. The callback receives
 * `{ data, error, response, status, success }` and the payload is
 * `response ?? data`.
 *
 * This module is the one place that knows that calling convention. It turns
 * one observable into one promise:
 *
 * - resolve on the first callback and unsubscribe immediately, because an EA
 *   observable can fire more than once and a subscription left open across
 *   solves is a leak;
 * - always time out, because a subscription that never fires must fail with an
 *   explicit reason instead of hanging (the item carried since #13);
 * - carry every callback field through unchanged, so a diagnostic can report
 *   `error`, `status` and `success` faithfully.
 *
 * It never issues a request of its own: a value without an `observe` method is
 * rejected with a reason, never sent to `fetch` or `XMLHttpRequest`. The read
 * path therefore has no network primitive to fall back to.
 *
 * This module is pure of the page: no DOM, no `chrome.*`, no EA names.
 */

/** The timeout applied to a subscription that never fires. */
export const DEFAULT_OBSERVABLE_TIMEOUT_MS = 5_000;

/**
 * True when a value can be subscribed to. A function is accepted because an EA
 * class can carry `observe` on its prototype.
 *
 * @param {*} value any value
 * @returns {boolean}
 */
export const isObservable = (value) =>
  value !== null &&
  (typeof value === 'object' || typeof value === 'function') &&
  typeof value.observe === 'function';

const field = (event, name) =>
  event !== null && typeof event === 'object' ? event[name] : undefined;

/**
 * Keeps every field the callback delivered and adds the payload EA computes as
 * `response ?? data`. Nothing is dropped or renamed.
 */
const normaliseEvent = (event) => {
  const data = field(event, 'data');
  const response = field(event, 'response');
  return {
    data,
    error: field(event, 'error') ?? null,
    response,
    status: field(event, 'status') ?? null,
    success: field(event, 'success') ?? null,
    payload: response ?? data,
  };
};

const describeCause = (error) =>
  error !== null && typeof error === 'object' && typeof error.message === 'string'
    ? error.message
    : String(error);

/**
 * Subscribes to one EA observable and resolves with the first callback it
 * fires. The observer is unsubscribed before the promise settles, on every
 * path: first callback, synchronous callback, timeout, and a throwing
 * `observe`.
 *
 * @param {object} observable a value carrying an `observe` method
 * @param {{ timeoutMs?: number, label?: string }} [options] `timeoutMs`
 *   defaults to `DEFAULT_OBSERVABLE_TIMEOUT_MS`; `label` names the source in
 *   the rejection reason
 * @returns {Promise<{ data: *, error: *, response: *, status: *,
 *   success: *, payload: * }>} the first callback's fields plus `payload`
 * @throws {Error} rejects when the value is not observable, when `observe`
 *   throws, or when no callback arrives before the timeout; every rejection
 *   names the reason
 */
export function observeOnce(observable, options = {}) {
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_OBSERVABLE_TIMEOUT_MS;
  const label =
    typeof options.label === 'string' && options.label.length > 0
      ? options.label
      : 'the EA observable';

  return new Promise((resolve, reject) => {
    if (!isObservable(observable)) {
      reject(
        new Error(
          `observeOnce: ${label} is not an EA observable: it has no observe method; a read cannot` +
            ' fall back to a network request'
        )
      );
      return;
    }

    let observer = null;
    let settled = false;
    let timer = null;

    const unsubscribe = () => {
      const subscription = observer;
      observer = null;
      if (subscription === null || typeof subscription.unobserve !== 'function') return;
      try {
        subscription.unobserve();
      } catch {
        // A failed unsubscribe must not unmake a payload that already arrived.
      }
    };

    const settle = (outcome, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      outcome(value);
    };

    const onNext = (event) => settle(resolve, normaliseEvent(event));

    try {
      observer = observable.observe(onNext);
    } catch (error) {
      settle(
        reject,
        new Error(`observeOnce: ${label}.observe threw: ${describeCause(error)}`)
      );
      return;
    }
    // A synchronous callback settled the promise before `observe` returned, so
    // the observer that just arrived is already unused and must be released.
    if (settled) {
      unsubscribe();
      return;
    }

    timer = setTimeout(() => {
      settle(
        reject,
        new Error(
          `observeOnce: ${label} timed out after ${timeoutMs}ms waiting for its first callback;` +
            ' the EA observable may expect a different subscription'
        )
      );
    }, timeoutMs);
  });
}
