/**
 * The observable bridge for EA's read path (#51).
 *
 * EA's service methods that read data do not return the data: they return an
 * observable. The caller subscribes with `.observe(subscriber, callback)` — the
 * subscriber is an object the caller owns — reads the payload inside the
 * callback and unsubscribes with `observer.unobserve(subscriber)`, where
 * `observer` is the callback's **first** argument. The callback also receives
 * the event, which carries `{ data, error, response, status, success }`, and the
 * payload is `response ?? data`. That two-argument form is the contract #70
 * established; a single-argument `observe(callback)` never fires and burns the
 * whole timeout (fsl-build/8).
 *
 * This module is the one place that knows that calling convention. It turns
 * one observable into one promise:
 *
 * - resolve on the first callback and unsubscribe immediately, because an EA
 *   observable can fire more than once and a subscription left open across
 *   solves is a leak;
 * - prefer the callback's observer for the unsubscribe, fall back to the
 *   returned subscription and then to `observable.unobserve(subscriber)`; the
 *   subscriber is always the one this call created;
 * - always time out, because a subscription that never fires must fail with an
 *   explicit reason instead of hanging (the item carried since #13); the
 *   timeout names the subscription form used and the returned object's own
 *   `observe`/`unobserve` shape, so a value that is not a real observable is
 *   visible in the reason (#61);
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
 * Names what the timed-out call returned, so a subscription that never fires
 * says whether it looked like a real EA observable at all: the observable's own
 * `observe`/`unobserve` types and what `observe` handed back. A real EA
 * observable carries an `unobserve` on the subscription object; a value that
 * only borrowed the name is visible here instead of being waited on again
 * (#61). No value and no callback payload is read.
 */
const describeSubscription = (observable, subscription) => {
  const observe = typeof observable.observe;
  const unobserve = observable.unobserve === undefined ? 'absent' : typeof observable.unobserve;
  let subscriptionUnobserve;
  if (subscription === null || subscription === undefined) {
    subscriptionUnobserve = `absent (the subscription is ${
      subscription === null ? 'null' : 'undefined'
    })`;
  } else {
    subscriptionUnobserve =
      typeof subscription.unobserve === 'function' ? 'function' : 'absent';
  }
  return `observe=${observe}, unobserve=${unobserve}; subscription unobserve=${subscriptionUnobserve}`;
};

/**
 * Releases a subscription without letting a failed unsubscribe unmake a
 * payload that already arrived.
 */
const unobserveQuietly = (target, subscriber) => {
  try {
    target.unobserve(subscriber);
  } catch {
    // A failed unsubscribe must not unmake a payload that already arrived.
  }
};

/**
 * Subscribes to one EA observable with `observe(subscriber, callback)` and
 * resolves with the first callback it fires. The subscription is released
 * before the promise settles, on every path: first callback, synchronous
 * callback, timeout, and a throwing `observe`. The unsubscribe goes through the
 * callback's observer when it carries one, then through the object `observe`
 * returned, and finally through `observable.unobserve(subscriber)`; every form
 * receives the subscriber this call created.
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

    // The subscriber belongs to this call. EA's observable receives it before
    // the callback and hands it back to `unobserve`, so the same object is used
    // for both.
    const subscriber = {};
    let unsubscribeTarget = null;
    let observeReturned = false;
    let unsubscribed = false;
    let settled = false;
    let timer = null;

    const remember = (candidate) => {
      if (unsubscribed) return;
      if (
        candidate !== null &&
        typeof candidate === 'object' &&
        typeof candidate.unobserve === 'function'
      ) {
        unsubscribeTarget = candidate;
      }
    };

    const unsubscribe = () => {
      if (unsubscribed) return;
      const target = unsubscribeTarget;
      unsubscribeTarget = null;
      if (target !== null) {
        unsubscribed = true;
        unobserveQuietly(target, subscriber);
        return;
      }
      // A synchronous callback can arrive before `observe` hands its
      // subscription back. Wait for that value before falling back, so the
      // returned observer is still preferred over the observable's own method.
      if (!observeReturned) return;
      unsubscribed = true;
      if (typeof observable.unobserve === 'function') {
        unobserveQuietly(observable, subscriber);
      }
    };

    const settle = (outcome, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      outcome(value);
    };

    const onEvent = (observer, event) => {
      remember(observer);
      settle(resolve, normaliseEvent(event));
    };

    let subscription;
    try {
      subscription = observable.observe(subscriber, onEvent);
    } catch (error) {
      settle(
        reject,
        new Error(`observeOnce: ${label}.observe threw: ${describeCause(error)}`)
      );
      return;
    }
    observeReturned = true;
    remember(subscription);
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
            ' the EA observable may expect a different subscription' +
            ` (subscribed with observe(subscriber, callback); returned ${describeSubscription(observable, subscription)})`
        )
      );
    }, timeoutMs);
  });
}
