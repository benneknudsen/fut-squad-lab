/**
 * Turns a live `/club` read into the stable record shape the solver consumes.
 *
 * The live page may hand back the documented `{ itemData: [...] }` envelope or a
 * bare item array, depending on which of `CLUB_ITEM_STRATEGIES` answered. This
 * reader accepts both, then maps every raw item through the solver's
 * `normaliseClub`, which is the single translation to the stable record schema.
 *
 * The raw field name lives in `CLUB_ITEM_ARRAY_FIELD` in `src/ea/adapter.js`;
 * this module never spells an EA payload name itself. A response that carries
 * neither shape throws naming that field, never returning a guessed empty club —
 * an empty club and a failed read are different facts.
 *
 * This module is pure: plain data in, plain data out. No DOM, no chrome APIs,
 * no network.
 */

import { CLUB_ITEM_ARRAY_FIELD } from './adapter.js';
import { normaliseClub } from '../solver/candidates.js';

/**
 * @param {object|Array<object>} response the resolved club payload
 * @returns {Array<object>} stable records with a `duplicate` flag, in input order
 * @throws {Error} when the response is neither an item array nor an envelope
 *   carrying one
 */
export function readClubItems(response) {
  const items = Array.isArray(response) ? response : response?.[CLUB_ITEM_ARRAY_FIELD];
  if (!Array.isArray(items)) {
    throw new Error(
      `readClubItems: club response must be an item array or carry ${CLUB_ITEM_ARRAY_FIELD} as` +
        ' an array; the /club payload shape may have changed'
    );
  }
  return normaliseClub(items);
}
