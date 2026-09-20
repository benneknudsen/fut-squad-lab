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
 *   1. an external price table supplied by the caller. Nothing fetches it
 *      today — there is no reachable automated source — and this module never
 *      fetches it either: it is pure.
 *   2. EA's own values already inside every club item payload. The stable names
 *      `marketAverage` and `discardValue` are read directly; the raw payload
 *      names they translate from live only in `src/ea/adapter.js` and must
 *      never appear in `src/solver/`.
 *
 * Precedence: a usable external price always wins; otherwise `marketAverage`;
 * otherwise `discardValue`; otherwise the rating estimate below; otherwise the
 * price is unknown. `marketMin` and `marketMax` are deliberately not used: they
 * are a listing range, not a resolved value.
 *
 * A concept card is a card the user does not own, so EA has no price data for
 * it and it has no club record at all. `mergePrices` therefore never applies
 * the EA fallback or the rating estimate to a concept card: it can only be
 * priced externally, or be left unknown. Without the external table, a concept
 * card sorts and costs as unknown, which is honest — the solver must not
 * pretend a card it cannot price is free.
 *
 * ## Rating estimate for a card with no price at all
 *
 * An owned card whose payload carries neither `marketAverage` nor
 * `discardValue` has no value from any source. Rather than leave it unknown,
 * `mergePrices` estimates one from the market values of the other records in
 * the same call, at the same rating:
 *
 *   - the estimate is the `P60_PERCENTILE` (0.6, nearest rank) of the
 *     `marketAverage`/external prices of records with an exactly equal rating
 *     (`SIMILAR_RATING_RADIUS` is 0; see the constant's comment for why);
 *   - the population is *quoted* prices only — an estimated or
 *     `discardValue`-only price never feeds another estimate, so estimates
 *     cannot chain;
 *   - at least `MIN_ESTIMATE_SAMPLES` (3) same-rating quotes must exist. With
 *     fewer, no estimate is made and the price stays unknown (`'none'`, never
 *     a silent zero). A record without a finite rating can never be placed in
 *     the population and is treated the same way.
 *
 * An estimate is recorded with its own `PRICE_SOURCES.ratingEstimate`, so a
 * caller can always tell an estimated price from a quoted one. The rule is a
 * borrowed published heuristic (see `DEFAULT_WEIGHTS` below), and the constant
 * names make it one reviewable decision rather than an inline formula.
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
 * `DEFAULT_WEIGHTS` is a **borrowed published heuristic**: the percentages SBC
 * Monkey describes in its public documentation for how it values fodder
 * (duplicate 0.10, untradeable 0.70, tradeable 1.00, concept 2.00). SBC Monkey
 * is third-party software this project is not affiliated with; the numbers are
 * quoted as facts about a published rule, not as measurements, and they are
 * not claimed to be tuned or correct. They replaced values we had invented,
 * which makes them more defensible, not proven. The concept weight exists
 * because using a concept card means manually buying it from the market, so a
 * solution that prefers one over fodder the user already holds cannot be
 * actioned as-is.
 *
 * The design contract (`design/README.md` §12.1) names these as its defaults
 * and exposes all four as options sliders — so they are a plain exported
 * object, overridable per call, never constants baked into the arithmetic.
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
 * one card is unpriced); a partial sum is never returned. `costCoverage`
 * reports the same fact as data — how many cards are priced, how many are not,
 * and which slots — and the solver carries it beside the total as
 * `costComplete`, so a caller never has to infer completeness from `cost`
 * alone.
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
 * The design contract's default weights, keyed by card state. A borrowed
 * published heuristic from SBC Monkey's public documentation (facts only; no
 * affiliation, and no claim that the numbers are tuned or correct); see the
 * header. Exported so a caller can seed its sliders from them, and frozen
 * because callers override through `itemCost`'s second argument rather than by
 * mutating this object.
 */
export const DEFAULT_WEIGHTS = Object.freeze({
  untradeableDuplicate: 0.1,
  untradeable: 0.7,
  tradeable: 1,
  concept: 2,
});

/** Where a resolved price came from, for display and for debugging. */
export const PRICE_SOURCES = Object.freeze({
  external: 'external',
  marketAverage: 'ea-market-average',
  discardValue: 'ea-discard-value',
  ratingEstimate: 'rating-p60-estimate',
  none: 'none',
});

/**
 * The percentile of same-rated market values used to estimate a card with no
 * price at all, using the nearest-rank definition: the sorted population's
 * element at `ceil(P60_PERCENTILE * count) - 1`.
 */
export const P60_PERCENTILE = 0.6;

/**
 * How far a reference card's rating may differ from the card being estimated
 * and still count as "similarly rated". Fixed at 0 — an exact rating match —
 * because rating is the dominant price driver and a band would blend the price
 * of a cheaper rating into the estimate. Named rather than inlined so the rule
 * is one decision with one test.
 */
export const SIMILAR_RATING_RADIUS = 0;

/**
 * The minimum number of same-rating quoted market values needed to compute an
 * estimate. Three is the smallest population that has a middle; with one or
 * two values the P60 nearest rank is effectively the maximum, which is not an
 * estimate worth reporting. Below this count the price stays unknown, never 0.
 */
export const MIN_ESTIMATE_SAMPLES = 3;

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

/**
 * First-pass price resolution for one record: a quoted source only. The
 * rating estimate is deliberately not here — it needs every record's resolved
 * price, so `mergePrices` applies it in a second pass.
 */
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

const isQuotedSource = (priceSource) =>
  priceSource === PRICE_SOURCES.marketAverage || priceSource === PRICE_SOURCES.external;

/**
 * Buckets the quoted market values of the batch by rating, in input order.
 * Only `marketAverage` and external prices count: they are the market values
 * the P60 rule is defined over, while a `discardValue` is a quick-sell price
 * and an estimate must never feed another estimate. `similarValues` sorts the
 * values it returns, so the buckets themselves need no order.
 */
const buildRatingIndex = (records, resolved) => {
  const byRating = new Map();
  records.forEach((record, index) => {
    const { price, priceSource } = resolved[index];
    if (!isQuotedSource(priceSource) || !Number.isFinite(record.rating)) return;
    const values = byRating.get(record.rating);
    if (values === undefined) byRating.set(record.rating, [price]);
    else values.push(price);
  });
  return byRating;
};

/**
 * The market values of the ratings within `SIMILAR_RATING_RADIUS` of `rating`,
 * ascending. With the radius at its documented 0 this is one exact-rating
 * bucket; wider radii merge neighbouring buckets, so the constant is the only
 * place the "similarly rated" rule lives.
 */
const similarValues = (byRating, rating) => {
  const values = [];
  const lowest = rating - SIMILAR_RATING_RADIUS;
  const highest = rating + SIMILAR_RATING_RADIUS;
  for (let candidate = lowest; candidate <= highest; candidate++) {
    const bucket = byRating.get(candidate);
    if (bucket !== undefined) values.push(...bucket);
  }
  values.sort((left, right) => left - right);
  return values;
};

/** Nearest rank: the sorted population's element at `ceil(fraction * count) - 1`. */
const nearestRankPercentile = (sortedValues, fraction) =>
  sortedValues[Math.ceil(fraction * sortedValues.length) - 1];

/**
 * Resolves a price and its source for every record, attaches the classified
 * `cardState`, and estimates a price from the batch's same-rating market
 * values for an owned record no source could price (see the header). Returns
 * new records in input order; the input is never mutated. Passing no external
 * table at all is valid and is the offline path.
 *
 * @param {Array<object>} records stable records, e.g. from `normaliseClub`
 * @param {Map|object|null} [externalPrices] `assetId` -> finite, non-negative
 *   price; malformed entries are ignored
 * @returns {Array<object>} each input record plus `{ cardState, price,
 *   priceSource }`; `priceSource` is `PRICE_SOURCES.ratingEstimate` when the
 *   price is an estimate rather than a quote, and `PRICE_SOURCES.none` when no
 *   estimate was possible either
 * @throws {Error} when the record list is sparse, a record is not an object,
 *   `classifyCardState` rejects it, an EA price field is malformed, or
 *   `externalPrices` is neither a `Map` nor a plain object
 */
export function mergePrices(records, externalPrices) {
  requireDenseArray(records, 'mergePrices: records');
  const table = resolveExternalTable(externalPrices);
  const resolved = records.map((record, index) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      fail(`mergePrices: records[${index}] must be a record object`);
    }
    const cardState = classifyCardState(record);
    return { cardState, ...resolvePrice(record, table, cardState, index) };
  });
  const byRating = buildRatingIndex(records, resolved);
  return records.map((record, index) => {
    const { cardState, price, priceSource } = resolved[index];
    if (
      priceSource === PRICE_SOURCES.none &&
      cardState !== 'concept' &&
      Number.isFinite(record.rating)
    ) {
      const values = similarValues(byRating, record.rating);
      if (values.length >= MIN_ESTIMATE_SAMPLES) {
        return {
          ...record,
          cardState,
          price: nearestRankPercentile(values, P60_PERCENTILE),
          priceSource: PRICE_SOURCES.ratingEstimate,
        };
      }
    }
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
 * The coverage of a set of priced records: how many carry a known price, how
 * many do not, and which ones do not.
 *
 * A cost total is only complete when every card in the squad resolved a price.
 * `totalCost` propagates `UNKNOWN_CONTRIBUTION` (`null`) as soon as one card is
 * unpriced, but that marker is silent about cause: a caller holding a total
 * cannot tell "nothing was priced" from "one card was missing a price", and so
 * cannot tell a real total from a lower bound. This function makes the missing
 * cards addressable — each one by the identity the solver already exposes: its
 * index in the record list (the squad slot, for a solved squad) plus its `id`
 * and `assetId`.
 *
 * Coverage follows the same cost model as `itemCost`, so it can never disagree
 * with the contributions a total was built from. A known `0` counts as priced;
 * absence counts as unknown; a concept card has no EA price data, so without
 * an external table it is always unknown.
 *
 * @param {Array<object>} records priced records, e.g. a solved squad's
 *   `players` array or the output of `mergePrices`
 * @returns {{ known: number, unknown: number, complete: boolean,
 *   unknownCards: Array<{ slot: number, id: number, assetId: number }> }}
 *   `complete` is true exactly when every record carries a known price;
 *   `unknownCards` lists the others in input order, `slot` being the index in
 *   this list
 * @throws {Error} when the list is not a dense array, or a record is not one
 *   `itemCost` can score
 */
export function costCoverage(records) {
  requireDenseArray(records, 'costCoverage: records');
  const unknownCards = [];
  for (let slot = 0; slot < records.length; slot++) {
    const record = records[slot];
    if (itemCost(record).contribution === UNKNOWN_CONTRIBUTION) {
      unknownCards.push({ slot, id: record.id, assetId: record.assetId });
    }
  }
  const unknown = unknownCards.length;
  return {
    known: records.length - unknown,
    unknown,
    complete: unknown === 0,
    unknownCards,
  };
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
