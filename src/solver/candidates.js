/**
 * Turns the stable club records produced by the EA adapter into a trimmed
 * candidate pool for the solver.
 *
 * `normaliseClub` is the solver-facing entry point to the adapter's
 * `normaliseClubItem`: one stable record per raw club item, in input order,
 * with one addition — a `duplicate` boolean. `buildPool` is the trimmer.
 * Neither function reads a raw payload field name; the translation lives in
 * `src/ea/adapter.js`, the single boundary that knows the payload shape.
 *
 * ## Record shape
 *
 * Every record carries the adapter's stable fields —
 *
 *   id, assetId, rating, nationId, leagueId, clubId, rarity, cardSubtype,
 *   playStyles, preferredPosition, possiblePositions, rolePlus, rolePlusPlus,
 *   untradeable, pile, owners, collected, marketAverage, marketMin, marketMax,
 *   discardValue
 *
 * — plus `duplicate` (boolean). Only `normaliseClub` adds `duplicate`;
 * `buildPool` expects records that already carry it.
 *
 * ## Duplicate rule
 *
 * A duplicate is a repeat `assetId` within the club: the extra copies beyond
 * the first for a given card definition are flagged `duplicate: true` in input
 * order. `owners` and `collected` say whether a copy is owned, not how many
 * spare copies exist, so they cannot identify fodder duplicates on their own
 * and are not used for this. The cost model (#6) weighs an untradeable
 * duplicate at 0.20 against 0.40 for a non-duplicate, which is why the rule is
 * fixed and tested here instead of guessed at in the pricing layer.
 *
 * ## Rating bands
 *
 * The default band width is 1: one band per exact rating. A card rated 82
 * cannot substitute for one rated 84 when a challenge demands a rating, so
 * merging adjacent ratings in the pool could throw away the exact card the
 * solver needs. Widths above 1 are available through `options.ratingBandWidth`
 * but are an explicit caller trade-off, not the default.
 *
 * ## Slot positions
 *
 * A card can fill every slot in its `possiblePositions`, not only its preferred
 * one, and a squad must fill all 11 slots. Grouping by preferred position alone
 * would let a card that is the only option for an alternative slot be trimmed
 * away because it is expensive at its preferred one. Each record therefore
 * joins one group per (position in `possiblePositions`, rating band). When
 * `possiblePositions` is absent, null or empty, the record falls back to its
 * `preferredPosition`, so a minimal caller-supplied record still groups
 * deterministically. A record survives when it is among the cheapest
 * `options.groupSize` in at least one of its groups — the pool is the union
 * over all groups.
 *
 * A repeated position name cannot make one card occupy several of a group's
 * places: the positions are deduplicated per record before grouping, so a card
 * appears at most once in any group no matter how often a position is named. A
 * repeat is a payload EA may legally send, so it is removed here rather than
 * rejected at the adapter.
 *
 * `buildPool` is an exported API and does not rely on `normaliseClub` having
 * run first. A directly supplied `possiblePositions` list is therefore checked
 * for holes, non-string entries and empty strings, like the adapter checks the
 * raw one; an empty list is not an error and still falls back to
 * `preferredPosition`. This check runs for every record before the `scope`
 * filter, so a malformed list is rejected even when the record itself is out of
 * scope — the same unconditional treatment `requireRecord` gets.
 *
 * ## Group size
 *
 * The pool keeps at most `options.groupSize` records per (slot position,
 * rating band) group. `groupSize` therefore means "the cheapest N per (slot,
 * band)", not "per record": one record can compete in several groups. The
 * default is 5: a squad has 11 slots, so one group can never need more than a
 * handful of alternatives, and a swap search needs a few options per slot
 * rather than the whole long tail of a big club. Raising it trades pool size
 * for search freedom.
 *
 * ## Price model
 *
 * "Cheapest" uses EA's own offline price data when nothing better is supplied.
 * The default lookup reads `marketAverage`, falls back to `discardValue`, and
 * returns `null` when neither is known. A missing price means unknown, never
 * free: unknown sorts after every known price, and a group made only of
 * unknown prices keeps its earliest records in input order.
 *
 * EXTENSION POINT (live prices, #10): pass `options.priceLookup`, a
 * `(record) => number | null` function, to price records from the fut.gg
 * client. The trimmer itself does not change; #6 supplies the lookup.
 *
 * ## Determinism and input
 *
 * The pool keeps the surviving records in input order, so the same input
 * always yields the same output — the union over groups is collected as a set
 * of input indexes and re-emitted by filtering the input, so it cannot depend
 * on group iteration order. Within a group, records are ranked by price
 * ascending with unknown prices last; equal prices break by the record's
 * position in the input, earlier first. Input records are never mutated.
 *
 * EXTENSION POINT (concept players): concept players are not part of the club
 * payload and are out of scope here. When the milestone that reads them lands,
 * they must be normalised into this same stable record shape and merged into
 * the records before grouping — do not half-implement them in `buildPool`.
 *
 * This module is pure: plain data in, plain data out. No DOM, no chrome APIs,
 * no network.
 */

import { normaliseClubItem } from '../ea/adapter.js';

const DEFAULT_GROUP_SIZE = 5;
const DEFAULT_SCOPE = 'both';
const DEFAULT_RATING_BAND_WIDTH = 1;

const SCOPES = Object.freeze(['untradeable', 'tradeable', 'both']);

/**
 * EA's offline price signal: `marketAverage` when present, else
 * `discardValue`, else unknown (`null`). `??` is deliberate — a known 0 stays
 * 0, only `null`/absent becomes unknown.
 */
const defaultPriceLookup = (record) => record.marketAverage ?? record.discardValue ?? null;

const fail = (message) => {
  throw new Error(`candidates: ${message}`);
};

/**
 * Rejects holes so a sparse array cannot be silently skipped by `map`/`every`.
 * `normaliseClub` promises one record per input item, which a sparse input
 * would break by returning holes instead of records. `buildPool` shares the
 * guard so both exported entrances to this module reject sparse records.
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
 * One stable record per raw club item, in input order, each carrying a
 * `duplicate` boolean. The extra copies beyond the first for a given `assetId`
 * are the duplicates; see the header.
 *
 * @param {Array<object>} rawItems items from the `/club` response
 * @returns {Array<object>} stable records, plus `duplicate`
 */
export function normaliseClub(rawItems) {
  requireDenseArray(rawItems, 'normaliseClub: raw club items');
  const seenAssetIds = new Set();
  return rawItems.map((rawItem) => {
    const record = normaliseClubItem(rawItem);
    const duplicate = seenAssetIds.has(record.assetId);
    seenAssetIds.add(record.assetId);
    return { ...record, duplicate };
  });
}

const requirePositiveInteger = (value, name) => {
  if (!Number.isInteger(value) || value < 1) {
    fail(`buildPool: options.${name} must be a positive integer`);
  }
  return value;
};

const resolveOptions = (options) => {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('buildPool: options must be an object when supplied');
  }
  const groupSize = requirePositiveInteger(options.groupSize ?? DEFAULT_GROUP_SIZE, 'groupSize');
  const scope = options.scope ?? DEFAULT_SCOPE;
  if (!SCOPES.includes(scope)) {
    fail(`buildPool: options.scope must be one of ${SCOPES.join(', ')}`);
  }
  const ratingBandWidth = requirePositiveInteger(
    options.ratingBandWidth ?? DEFAULT_RATING_BAND_WIDTH,
    'ratingBandWidth'
  );
  const priceLookup = options.priceLookup ?? defaultPriceLookup;
  if (typeof priceLookup !== 'function') {
    fail('buildPool: options.priceLookup must be a function');
  }
  return { groupSize, scope, ratingBandWidth, priceLookup };
};

const requireRecord = (record, index) => {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    fail(`buildPool: records[${index}] must be a record object`);
  }
  if (!Number.isFinite(record.rating)) {
    fail(`buildPool: records[${index}].rating must be a finite number`);
  }
  if (typeof record.preferredPosition !== 'string' || record.preferredPosition.length === 0) {
    fail(`buildPool: records[${index}].preferredPosition must be a non-empty string`);
  }
  if (typeof record.untradeable !== 'boolean') {
    fail(`buildPool: records[${index}].untradeable must be a boolean`);
  }
};

const isInScope = (record, scope) => {
  if (scope === 'both') return true;
  return scope === 'untradeable' ? record.untradeable : !record.untradeable;
};

/**
 * Direct-input guard for a record's position list: dense, and every entry a
 * non-empty string. The adapter enforces the same shape on the raw payload, but
 * `buildPool` can be called with records that did not come from `normaliseClub`.
 */
const requirePositionList = (positions, index) => {
  requireDenseArray(positions, `buildPool: records[${index}].possiblePositions`);
  positions.forEach((position, positionIndex) => {
    if (typeof position !== 'string' || position.length === 0) {
      fail(
        `buildPool: records[${index}].possiblePositions[${positionIndex}] must be a non-empty` +
          ' string'
      );
    }
  });
};

/**
 * The slot positions a record competes for: every distinct entry of
 * `possiblePositions`, falling back to `preferredPosition` when the list is
 * absent, null or empty. Deduplication happens before grouping so a repeated
 * position cannot let one card take several places in the same group.
 */
const positionsFor = (record, index) => {
  const positions = record.possiblePositions;
  if (positions === undefined || positions === null) return [record.preferredPosition];
  if (!Array.isArray(positions)) {
    fail(
      `buildPool: records[${index}].possiblePositions must be an array when present;` +
        ' omit it to fall back to preferredPosition'
    );
  }
  requirePositionList(positions, index);
  if (positions.length === 0) return [record.preferredPosition];
  return [...new Set(positions)];
};

const resolvePrice = (record, priceLookup, index) => {
  const price = priceLookup(record);
  if (price === null) return null;
  if (!Number.isFinite(price) || price < 0) {
    fail(
      `buildPool: priceLookup returned ${String(price)} for records[${index}]; it must return` +
        ' null or a finite, non-negative number'
    );
  }
  return price;
};

const orderablePrice = (price) => (price === null ? Number.POSITIVE_INFINITY : price);

/**
 * Rank by known price ascending, unknown prices last; equal prices break by
 * input position, earlier first. The explicit comparison avoids the
 * `Infinity - Infinity` NaN trap that would skip the tie-break.
 */
const compareByPriceThenInputOrder = (left, right) => {
  const leftPrice = orderablePrice(left.price);
  const rightPrice = orderablePrice(right.price);
  if (leftPrice !== rightPrice) return leftPrice < rightPrice ? -1 : 1;
  return left.index - right.index;
};

/**
 * Trim stable records down to the candidate pool: at most `options.groupSize`
 * records per (slot position, rating band) group, cheapest first, with the rest
 * of the rules in the header.
 *
 * @param {Array<object>} records output of `normaliseClub`
 * @param {{ groupSize?: number, scope?: string, ratingBandWidth?: number,
 *   priceLookup?: Function }} [options]
 * @returns {Array<object>} the surviving records, in input order
 */
export function buildPool(records, options = {}) {
  requireDenseArray(records, 'buildPool: records');
  const { groupSize, scope, ratingBandWidth, priceLookup } = resolveOptions(options);

  const groups = new Map();
  records.forEach((record, index) => {
    requireRecord(record, index);
    const positions = positionsFor(record, index);
    if (!isInScope(record, scope)) return;

    const band = Math.floor(record.rating / ratingBandWidth);
    const entry = { index, price: resolvePrice(record, priceLookup, index) };
    for (const position of positions) {
      const key = `${position}\u0000${band}`;
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [entry]);
      else group.push(entry);
    }
  });

  const keptIndexes = new Set();
  for (const group of groups.values()) {
    group.sort(compareByPriceThenInputOrder);
    for (const entry of group.slice(0, groupSize)) {
      keptIndexes.add(entry.index);
    }
  }

  return records.filter((record, index) => keptIndexes.has(index));
}
