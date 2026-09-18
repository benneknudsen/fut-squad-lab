/**
 * Fodder cost model: resolves the price of every candidate record from the best
 * available source and weights that price by the card state the solver would
 * spend. The solver minimises the sum of these contributions, not raw market
 * value, so that consuming an untradeable duplicate costs the user less than
 * spending a tradeable card or buying a concept player.
 *
 * ## Price sources and precedence
 *
 * Two sources exist, and both are always offline-safe:
 *
 *   1. an external price table (fut.gg, fetched by issue #10) passed in by the
 *      caller. Never fetched here — this module is pure.
 *   2. EA's own values already inside every club item payload. The stable names
 *      `marketAverage` and `discardValue` are read directly; the raw payload
 *      names they translate from live only in `src/ea/adapter.js` and must
 *      never appear in `src/solver/`.
 *
 * Precedence: a usable external price always wins; otherwise `marketAverage`;
 * otherwise `discardValue`; otherwise the price is unknown. `marketMin` and
 * `marketMax` are deliberately not used: they are a listing range, not a
 * resolved value.
 *
 * A concept card is a card the user does not own, so EA has no price data for
 * it and it has no club record at all. `mergePrices` therefore never applies
 * the EA fallback to a concept card: it can only be priced externally, or be
 * left unknown. Without the external table, a concept card sorts and costs as
 * unknown, which is honest — the solver must not pretend a card it cannot price
 * is free.
 *
 * ## `null` means unknown, never zero
 *
 * The adapter normalises an absent price field to `null` precisely so a missing
 * price cannot quietly become free. This module honours that: a `null` price
 * resolves to `priceSource: 'none'`, and a known `0` (for example a zero
 * `discardValue`) stays a known price of 0 with its source recorded. A price
 * source is attached to every record so the panel can show where a number came
 * from, including `'none'`.
 *
 * ## Card state is explicit, never guessed
 *
 * Only some of the four states are properties of an item. `untradeable` is on
 * the record; `duplicate` is a property of the club (a repeat `assetId` beyond
 * the first copy, marked by `normaliseClub` in `src/solver/candidates.js`);
 * `concept` is a card the user does not own and cannot be inferred from any
 * club item. `classifyCardState` therefore reads explicit flags — a caller
 * marks a concept card with `concept: true` — and throws rather than defaulting
 * a missing `untradeable` to `false`, which would silently apply the most
 * expensive state (tradeable). Storage location and price presence are never
 * used to infer a state.
 *
 * `mergePrices` attaches the classified state to each output record as
 * `cardState`, and `itemCost` refuses to score a record without one.
 *
 * ## Weights
 *
 * `DEFAULT_WEIGHTS` carries the design contract's defaults
 * (`design/README.md` §12): duplicate 0.20, untradeable 0.40, tradeable 1.00,
 * concept 1.00. They are plausible defaults, not tuned values, and the design
 * exposes all four as options sliders — so they are a plain exported object,
 * overridable per call, never constants baked into the arithmetic.
 *
 * ## Unknown prices are never the cheaper choice, and never `Infinity`
 *
 * The issue requires that a record with no price fields at all yields a usable
 * cost rather than `NaN`. Returning 0 would make an unpriced card look free and
 * let the solver prefer it over priced fodder, which is the opposite of
 * guarding fodder prices. This module instead represents an unknown price as
 * `UNKNOWN_CONTRIBUTION`, which is `null`: it survives `JSON.stringify`
 * unchanged, so a future worker or message boundary cannot turn it into a
 * known contribution, and `compareContributions` sorts it after every known
 * contribution. A known contribution is always a finite number, so "unknown"
 * and "cheap" can never be confused. The resolved `price` stays `null` and
 * `priceSource` stays `'none'`, so the UI can render "—" from the price fields
 * while the solver compares the contribution. The sentinel is applied even
 * when the state weight is 0: an unknown price cannot be weighted away.
 *
 * A known price times a heavy weight could overflow to `Infinity`, which an
 * `Infinity` sentinel could not be told apart from. `contributionFor` therefore
 * rejects a non-finite product instead of returning it: a known price must
 * never look unknown.
 *
 * Summing contributions has the same hazard in two forms. `null + 300` is
 * `300`, so adding the contributions with `+` would drop an unpriced card from
 * the total and make it free, and a sum of finite contributions can still
 * overflow to `Infinity`, which JSON turns into `null` — the unknown marker.
 * `totalCost` is therefore the only sanctioned way to build a squad total: it
 * propagates the unknown marker instead of adding it, and it throws when the
 * sum of the known contributions is not finite. A total is always either a
 * finite number (the whole cost is known) or `UNKNOWN_CONTRIBUTION` (at least
 * one card is unpriced); a partial sum is never returned.
 *
 * ## External table contract
 *
 * `mergePrices(records, externalPrices)` accepts a `Map` (keyed by `assetId`,
 * as a number or its numeric string) or a plain object keyed by `assetId`, with
 * a finite, non-negative number per entry. Entry values that are absent,
 * `null`, non-numeric, `NaN`, infinite or negative are ignored and the EA
 * fallback applies: the table is remote data and one bad entry must not fail a
 * whole solve. A supplied table that is neither a `Map` nor a plain object is a
 * caller bug and throws, matching how `candidates.js` treats a malformed
 * `priceLookup`.
 *
 * ## Purity
 *
 * Plain data in, plain data out. No DOM, no chrome APIs, no network, no
 * mutation of the input records.
 */

export const CARD_STATES = Object.freeze([
  'untradeableDuplicate',
  'untradeable',
  'tradeable',
  'concept',
]);

/**
 * The design contract's default weights, keyed by card state. Exported so a
 * caller can seed its sliders from them, and frozen because callers override
 * through `itemCost`'s second argument rather than by mutating this object.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  untradeableDuplicate: 0.2,
  untradeable: 0.4,
  tradeable: 1,
  concept: 1,
});

/** Where a resolved price came from, for display and for debugging. */
export const PRICE_SOURCES = Object.freeze({
  external: 'external',
  marketAverage: 'ea-market-average',
  discardValue: 'ea-discard-value',
  none: 'none',
});

/**
 * The cost contribution of a record whose price is unknown: `null`, not
 * `Infinity` and not 0. `null` survives JSON serialization unchanged, cannot be
 * mistaken for a known (finite) contribution, and `compareContributions` sorts
 * it after every known one. See the header for the reasoning.
 *
 * `null` is a marker for one card and a value for comparisons — it is never an
 * addend. `null + 300` is `300` in JavaScript, so summing contributions with
 * `+` would silently drop an unpriced card from a total and make it look free,
 * the exact mispricing this model exists to prevent. Use `totalCost` for
 * totals: it propagates this marker instead of adding it.
 */
export const UNKNOWN_CONTRIBUTION = null;

/**
 * Orders contributions the way the solver minimises them: known contributions
 * ascending, an unknown contribution (`UNKNOWN_CONTRIBUTION`, i.e. `null`)
 * after every known one, and equal contributions tied at 0 so the caller can
 * apply its own tie-break. Both arguments must be `null` or finite,
 * non-negative numbers; `itemCost` and `contributionFor` guarantee that for the
 * values they return.
 */
export function compareContributions(left, right) {
  if (left === right) return 0;
  if (left === UNKNOWN_CONTRIBUTION) return 1;
  if (right === UNKNOWN_CONTRIBUTION) return -1;
  return left < right ? -1 : 1;
}

const fail = (message) => {
  throw new Error(`prices: ${message}`);
};

/**
 * A weights table must be a genuinely plain object, not a `Map` or any other
 * exotic object: `Object.entries` on a `Map` is empty, so the overrides would
 * be silently ignored and the defaults used instead. External price tables are
 * the one place a `Map` is accepted, and `resolveExternalTable` checks that
 * before reaching here.
 */
const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * Rejects holes so a sparse array cannot be silently skipped by `map`. The
 * record lists come from `normaliseClub`, which promises one record per input
 * item; a sparse list would break that promise.
 */
const requireDenseArray = (values, label) => {
  if (!Array.isArray(values)) fail(`${label} must be an array`);
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index)) {
      fail(`${label} must not contain holes (index ${index} is missing)`);
    }
  }
};

/**
 * Classifies a record into one of `CARD_STATES` from its explicit flags.
 *
 * A concept card is classified from `concept === true` alone, because a card
 * the user does not own has no club record and cannot carry meaningful
 * `untradeable`/`duplicate` values. Every other record must carry boolean
 * `untradeable` and boolean `duplicate` flags (a missing value throws instead
 * of defaulting), because the state decides the weight and a guessed flag would
 * silently misprice the card: assuming `untradeable` missing means `tradeable`
 * applies the most expensive state, and assuming a missing `duplicate` on a
 * tradeable card guesses that the caller's duplicate marking never ran. A
 * repeated `assetId` on a tradeable card is not a duplicate for pricing
 * purposes: the duplicate state exists to spend spare fodder first, and a
 * tradeable repeat is still a tradeable card.
 *
 * @param {object} record a stable record from `normaliseClub`, plus an optional
 *   `concept: true` flag
 * @returns {'untradeableDuplicate'|'untradeable'|'tradeable'|'concept'}
 * @throws {Error} when the record is not an object, a flag has the wrong type,
 *   or `untradeable`/`duplicate` is missing where the state needs it
 */
export function classifyCardState(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    fail('classifyCardState: record must be an object');
  }
  if (record.concept !== undefined && typeof record.concept !== 'boolean') {
    fail('classifyCardState: record.concept must be a boolean when present');
  }
  if (record.concept === true) return 'concept';
  if (typeof record.untradeable !== 'boolean') {
    fail(
      'classifyCardState: record must carry a boolean untradeable; a missing card state' +
        ' must not default to tradeable'
    );
  }
  if (typeof record.duplicate !== 'boolean') {
    fail(
      'classifyCardState: record must carry a boolean duplicate; without it an untradeable' +
        ' card cannot be told from a duplicate and a tradeable one must not be assumed'
    );
  }
  if (!record.untradeable) return 'tradeable';
  return record.duplicate ? 'untradeableDuplicate' : 'untradeable';
}

/**
 * `undefined`/`null` mean "no external prices" (the offline path). A `Map` or
 * a plain object is used as supplied. Anything else is a caller error: silently
 * ignoring it would make a solve fall back to stale EA values without saying
 * so.
 */
const resolveExternalTable = (externalPrices) => {
  if (externalPrices === undefined || externalPrices === null) return null;
  if (externalPrices instanceof Map || isPlainObject(externalPrices)) return externalPrices;
  fail('mergePrices: externalPrices must be a Map or a plain object when supplied');
};

/**
 * Reads one external price. Remote data is untrusted, so a malformed entry is
 * ignored rather than thrown: `undefined`/`null`, a non-number, `NaN`,
 * `Infinity` and a negative number all mean "no usable external price", and the
 * EA fallback applies. A missing `assetId` cannot be looked up and is treated
 * the same way.
 */
const readExternalPrice = (table, record) => {
  if (table === null) return null;
  if (!Number.isFinite(record.assetId)) return null;
  const value =
    table instanceof Map
      ? table.has(record.assetId)
        ? table.get(record.assetId)
        : table.get(String(record.assetId))
      : Object.hasOwn(table, record.assetId)
        ? table[record.assetId]
        : undefined;
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
};

/**
 * Reads an EA price field. The adapter already guarantees `null` or a finite
 * number, so anything else here is a caller bypassing the adapter; it throws
 * rather than silently discarding the field, which could turn a malformed
 * market value into a "no price" fallthrough.
 */
const readEaPrice = (record, field, index) => {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    fail(
      `mergePrices: records[${index}].${field} must be null or a finite, non-negative number`
    );
  }
  return value;
};

const resolvePrice = (record, table, cardState, index) => {
  const externalPrice = readExternalPrice(table, record);
  if (externalPrice !== null) {
    return { price: externalPrice, priceSource: PRICE_SOURCES.external };
  }
  if (cardState === 'concept') {
    return { price: null, priceSource: PRICE_SOURCES.none };
  }
  const marketAverage = readEaPrice(record, 'marketAverage', index);
  if (marketAverage !== null) {
    return { price: marketAverage, priceSource: PRICE_SOURCES.marketAverage };
  }
  const discardValue = readEaPrice(record, 'discardValue', index);
  if (discardValue !== null) {
    return { price: discardValue, priceSource: PRICE_SOURCES.discardValue };
  }
  return { price: null, priceSource: PRICE_SOURCES.none };
};

/**
 * Resolves a price and its source for every record, and attaches the classified
 * `cardState`. Returns new records in input order; the input is never mutated.
 * Passing no external table at all is valid and is the offline path.
 *
 * @param {Array<object>} records stable records, e.g. from `normaliseClub`
 * @param {Map|object|null} [externalPrices] `assetId` -> finite, non-negative
 *   price; malformed entries are ignored
 * @returns {Array<object>} each input record plus `{ cardState, price,
 *   priceSource }`
 * @throws {Error} when the record list is sparse, a record is not an object,
 *   `classifyCardState` rejects it, an EA price field is malformed, or
 *   `externalPrices` is neither a `Map` nor a plain object
 */
export function mergePrices(records, externalPrices) {
  requireDenseArray(records, 'mergePrices: records');
  const table = resolveExternalTable(externalPrices);
  return records.map((record, index) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      fail(`mergePrices: records[${index}] must be a record object`);
    }
    const cardState = classifyCardState(record);
    const { price, priceSource } = resolvePrice(record, table, cardState, index);
    return { ...record, cardState, price, priceSource };
  });
}

/**
 * Merges a caller-supplied partial weight set over `DEFAULT_WEIGHTS`. A caller
 * may override one state without repeating the others, which is what the
 * options sliders need. Every supplied value must be a finite, non-negative
 * number: a negative weight would produce a negative contribution, and a
 * non-finite one would poison comparisons.
 *
 * Exported because callers that price records outside `mergePrices` (the pool
 * trimmer in `src/solver/candidates.js`) resolve the table once and weight each
 * contribution themselves.
 *
 * @param {object} [weights] partial overrides for `DEFAULT_WEIGHTS`
 * @returns {object} the resolved, complete weight table
 * @throws {Error} when `weights` is not a plain object or a value is not a
 *   finite, non-negative number
 */
export const resolveWeights = (weights) => {
  if (weights === undefined) return DEFAULT_WEIGHTS;
  if (!isPlainObject(weights)) fail('weights must be a plain object when supplied');
  const resolved = { ...DEFAULT_WEIGHTS };
  for (const [state, weight] of Object.entries(weights)) {
    if (!CARD_STATES.includes(state)) {
      fail(`weights.${state} names no card state; expected one of ${CARD_STATES.join(', ')}`);
    }
    if (!Number.isFinite(weight) || weight < 0) {
      fail(`weights.${state} must be a finite, non-negative number`);
    }
    resolved[state] = weight;
  }
  return resolved;
};

/**
 * The weighted contribution of one resolved price: `UNKNOWN_CONTRIBUTION` when
 * the price is `null`, otherwise `price * weight`.
 *
 * A finite price times a finite weight can still overflow to `Infinity` when
 * the price is near `Number.MAX_VALUE`, and an `Infinity` result would be
 * indistinguishable from the unknown sentinel this module used to use. It
 * throws instead, so a known price can never silently become an unknown one.
 *
 * `price` must be `null` or a finite, non-negative number and `weight` must be
 * a finite, non-negative number. Both are validated rather than trusted,
 * because this is exported for callers that cost records outside `itemCost`.
 *
 * @param {number|null} price a resolved price, or `null` for unknown
 * @param {number} weight the resolved weight for the card's state
 * @returns {number|null} the finite contribution, or `UNKNOWN_CONTRIBUTION`
 * @throws {Error} when `price` or `weight` is malformed, or the product is not
 *   finite
 */
export function contributionFor(price, weight) {
  if (price !== null && (!Number.isFinite(price) || price < 0)) {
    fail('contributionFor: price must be null or a finite, non-negative number');
  }
  if (!Number.isFinite(weight) || weight < 0) {
    fail('contributionFor: weight must be a finite, non-negative number');
  }
  if (price === null) return UNKNOWN_CONTRIBUTION;
  const contribution = price * weight;
  if (!Number.isFinite(contribution)) {
    fail(
      `contributionFor: price ${price} * weight ${weight} is not a finite contribution;` +
        ' a known price must never become indistinguishable from an unknown one'
    );
  }
  return contribution;
}

/**
 * Sums per-card contributions into one squad total.
 *
 * A total is only meaningful when it covers every card, so an unknown
 * contribution is propagated rather than added: if any entry is
 * `UNKNOWN_CONTRIBUTION` (`null`) the total is `UNKNOWN_CONTRIBUTION` too. The
 * known contributions are not summed in that case, because a partial sum must
 * never be returned as if it were the whole cost. `null` survives
 * `JSON.stringify` unchanged, so a caller can always tell a known total (a
 * finite number) from an unknown one (`null`), even across a message boundary.
 *
 * A sum of individually valid contributions can still overflow to `Infinity`
 * even though each product passed `contributionFor`, and JSON turns `Infinity`
 * into `null` — the unknown marker. Every addend is non-negative, so the sum
 * only grows: one final finite check is enough, and a non-finite sum throws, so
 * a known total can never quietly become unknown.
 *
 * @param {Array<number|null>} contributions contributions from `itemCost`,
 *   each `null` (unknown) or a finite, non-negative number
 * @returns {number|null} the finite total, or `UNKNOWN_CONTRIBUTION` when any
 *   contribution is unknown
 * @throws {Error} when the list is not a dense array, an entry is neither
 *   `null` nor a finite, non-negative number, or the sum of the known entries
 *   is not finite
 */
export function totalCost(contributions) {
  requireDenseArray(contributions, 'totalCost: contributions');
  let total = 0;
  let hasUnknown = false;
  for (let index = 0; index < contributions.length; index++) {
    const contribution = contributions[index];
    if (contribution === UNKNOWN_CONTRIBUTION) {
      hasUnknown = true;
      continue;
    }
    if (!Number.isFinite(contribution) || contribution < 0) {
      fail(
        `totalCost: contributions[${index}] must be null or a finite, non-negative number;` +
          ` got ${String(contribution)}`
      );
    }
    total += contribution;
  }
  if (hasUnknown) return UNKNOWN_CONTRIBUTION;
  if (!Number.isFinite(total)) {
    fail(
      'totalCost: the sum of the known contributions is not finite; a known total must never' +
        ' become Infinity, which JSON would turn into null, the unknown marker'
    );
  }
  return total;
}

/**
 * The cost of one card to the solver: the resolved price weighted by the card
 * state, with the price and the weight kept as separate fields.
 *
 * The four fields are deliberately distinct, because the design contract has
 * the panel show the weighted contribution, not the market value
 * (`design/README.md` §12): `price` is the resolved market/discard value,
 * `priceSource` says where it came from, `weight` is the state's multiplier
 * actually used (from `weights` or `DEFAULT_WEIGHTS`), and `contribution` is
 * `price * weight` — the number the solver sums. An unknown price has
 * `price: null` and a `contribution` of `UNKNOWN_CONTRIBUTION`, never 0.
 *
 * The record must be one that `mergePrices` produced; a record without a
 * `cardState`, `price` or `priceSource` throws rather than being guessed at.
 * The price and its source must also agree: `'none'` is the unknown source and
 * requires `price: null`, while every named source requires a finite,
 * non-negative price. A concept card may only be priced externally or left
 * unknown, because it has no club record for EA to price. `{ price: 0,
 * priceSource: 'none' }` is therefore rejected rather than scored as a free
 * card.
 *
 * @param {object} record a record returned by `mergePrices`
 * @param {object} [weights] partial overrides for `DEFAULT_WEIGHTS`
 * @returns {{ price: number|null, priceSource: string, weight: number,
 *   contribution: number|null }} `contribution` is `UNKNOWN_CONTRIBUTION`
 *   (`null`) when the price is unknown
 * @throws {Error} when the record lacks a known card state, price or price
 *   source, the price and source disagree, or a supplied weight is not a
 *   finite, non-negative number
 */
export function itemCost(record, weights) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    fail('itemCost: record must be an object');
  }
  if (!CARD_STATES.includes(record.cardState)) {
    fail(
      `itemCost: record.cardState must be one of ${CARD_STATES.join(', ')};` +
        ' a missing state must not default to tradeable'
    );
  }
  if (record.price !== null && (!Number.isFinite(record.price) || record.price < 0)) {
    fail(
      'itemCost: record.price must be null or a finite, non-negative number; only a record' +
        ' returned by mergePrices may be scored'
    );
  }
  if (
    typeof record.priceSource !== 'string' ||
    !Object.values(PRICE_SOURCES).includes(record.priceSource)
  ) {
    fail(
      `itemCost: record.priceSource must be one of ${Object.values(PRICE_SOURCES).join(', ')};` +
        ' only a record returned by mergePrices may be scored'
    );
  }
  if (record.priceSource === PRICE_SOURCES.none && record.price !== null) {
    fail(
      `itemCost: record.price (${String(record.price)}) and record.priceSource ('none') must` +
        ' agree; the none source requires record.price to be null'
    );
  }
  if (record.priceSource !== PRICE_SOURCES.none && record.price === null) {
    fail(
      `itemCost: record.price and record.priceSource ('${record.priceSource}') must agree; a` +
        ' named source requires a finite, non-negative record.price'
    );
  }
  if (
    record.cardState === 'concept' &&
    record.priceSource !== PRICE_SOURCES.external &&
    record.priceSource !== PRICE_SOURCES.none
  ) {
    fail(
      `itemCost: record.price and record.priceSource ('${record.priceSource}') cannot price a` +
        ' concept card; only an external price or no price at all, because the user does not' +
        ' own the card'
    );
  }
  const weight = resolveWeights(weights)[record.cardState];
  return {
    price: record.price,
    priceSource: record.priceSource,
    weight,
    contribution: contributionFor(record.price, weight),
  };
}
