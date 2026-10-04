/**
 * Turns a live `/club` read into the stable record shape the solver consumes.
 *
 * The live page hands back the item envelope or a bare item array, depending on
 * which of `CLUB_ITEM_STRATEGIES` answered (#72). This reader accepts both,
 * then maps every raw item through the solver's `normaliseClub`, which is the
 * single translation to the stable record schema.
 *
 * The raw field name lives in `CLUB_ITEM_ARRAY_FIELD` in `src/ea/adapter.js`;
 * this module never spells an EA payload name itself. A response that carries
 * neither shape throws naming that field and any known alternative the payload
 * carried instead, never returning a guessed empty club — an empty club and a
 * failed read are different facts.
 *
 * An item the adapter rejects is located before the error leaves this module
 * (#74): the caller may pass the page sizes the walk recorded, and the failure
 * then reports the array field, the page, that page's item count and the
 * offending index inside it. The structured location rides on the error as
 * `clubRead`, and the message carries no value — only names, indexes and sizes.
 *
 * `clubRead` also carries the item's layer, the locations the observable-layer
 * rejection probed and the shape of the sub-objects those probes read (#115), so
 * a pasted report shows both what EA sent and what this build tried to read it
 * from. An absent probe list means the wire layer, which reads fixed names.
 *
 * This module is pure: plain data in, plain data out. No DOM, no chrome APIs,
 * no network.
 */

import {
  CLUB_ITEM_ARRAY_ALTERNATIVES,
  CLUB_ITEM_ARRAY_FIELD,
  CLUB_ITEM_LAYERS,
  normaliseClubItem,
} from './adapter.js';
import { normaliseClub } from '../solver/candidates.js';

const describeCarriedAlternatives = (response) => {
  const carried = CLUB_ITEM_ARRAY_ALTERNATIVES.filter((field) =>
    Array.isArray(response?.[field])
  );
  return carried.length === 0
    ? ''
    : `; the payload carried ${carried.join(', ')}, which this build does not read`;
};

/**
 * The index of the first item `normaliseClubItem` rejects, or -1 when every
 * item passes. Re-running the adapter's own check is what makes the location
 * trustworthy: the item that threw during `normaliseClub` is the item this scan
 * finds, because both call the same function.
 */
const findOffendingIndex = (items) => {
  for (let index = 0; index < items.length; index++) {
    try {
      normaliseClubItem(items[index]);
    } catch {
      return index;
    }
  }
  return -1;
};

/**
 * Locates one aggregate item index inside the per-page counts the walk
 * recorded. `pageIndex` is 1-based for a human reading the report;
 * `itemIndexInPage` is the index inside that page. Returns null when the caller
 * reported no page sizes, so a direct call still produces a usable message.
 */
const locateInPages = (pageItems, index) => {
  if (!Array.isArray(pageItems) || pageItems.length === 0) return null;
  let start = 0;
  for (const [page, count] of pageItems.entries()) {
    if (!Number.isFinite(count) || count < 0) return null;
    if (index < start + count) {
      return { pageIndex: page + 1, pageItems: count, itemIndexInPage: index - start };
    }
    start += count;
  }
  return null;
};

/**
 * Wraps an adapter item rejection with where the club walk saw it. Only an item
 * rejection is located: an array-level failure (a sparse list) has no offending
 * item and is rethrown unchanged. The original error stays as `cause`.
 */
const enrichNormalisationError = (error, items, pageItems) => {
  if (error?.rawItemShape === undefined) return error;
  const index = findOffendingIndex(items);
  if (index === -1) return error;
  const location = locateInPages(pageItems, index);
  const where =
    location === null
      ? `readClubItems: club item index ${index} (array field ${CLUB_ITEM_ARRAY_FIELD})`
      : `readClubItems: club item index ${index} of page ${location.pageIndex}, which returned` +
        ` ${location.pageItems} item${location.pageItems === 1 ? '' : 's'}` +
        ` (item ${location.itemIndexInPage} of that page; array field ${CLUB_ITEM_ARRAY_FIELD})`;
  const enriched = new Error(`${where} failed; ${error.message}`);
  enriched.clubRead = {
    field: CLUB_ITEM_ARRAY_FIELD,
    index,
    pageIndex: location?.pageIndex ?? null,
    pageItems: location?.pageItems ?? null,
    itemIndexInPage: location?.itemIndexInPage ?? null,
    keys: [...error.rawItemShape.keys],
    // The observable layer rejects an item by naming every location it probed and
    // the shape of the sub-objects those probes read (#115). Both ride on the
    // same record, so one paste shows what EA sent and what this build tried.
    layer: error.rawItemShape.layer ?? CLUB_ITEM_LAYERS.WIRE,
    probes: error.rawItemShape.probes ?? [],
    subLayers: error.rawItemShape.subLayers ?? {},
  };
  enriched.cause = error;
  return enriched;
};

/**
 * @param {object|Array<object>} response the resolved club payload
 * @param {{ pageItems?: Array<number> }} [options] the item count of each page
 *   the walk read, in order, so a rejected item can be located; omitted by a
 *   direct call
 * @returns {Array<object>} stable records with a `duplicate` flag, in input order
 * @throws {Error} when the response is neither an item array nor an envelope
 *   carrying one under the field named by `CLUB_ITEM_ARRAY_FIELD`, or when an
 *   item cannot be translated; an item rejection carries `clubRead` with its
 *   location and message
 */
export function readClubItems(response, options = {}) {
  const items = Array.isArray(response) ? response : response?.[CLUB_ITEM_ARRAY_FIELD];
  if (!Array.isArray(items)) {
    throw new Error(
      `readClubItems: club response must be an item array or carry ${CLUB_ITEM_ARRAY_FIELD} as` +
        ` an array${describeCarriedAlternatives(response)}; the /club payload shape may have` +
        ' changed'
    );
  }
  try {
    return normaliseClub(items);
  } catch (error) {
    throw enrichNormalisationError(error, items, options?.pageItems ?? null);
  }
}
