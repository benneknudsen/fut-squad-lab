/**
 * The one file that knows EA SPORTS FC 27 SBC class names, eligibility key
 * numbers, enum values and the raw `/club` item and `/chemistry/teamlinks`
 * payload shapes. Every other module imports EA-specific naming from here, so
 * that when EA renames something exactly one file changes.
 *
 * `normaliseClubItem` at the bottom is the club-payload half of that boundary:
 * it translates raw items into the stable solver schema, and the solver core
 * may only ever see the translated form.
 *
 * ## Production entry point vs. pinned observation data
 *
 * M2 of `docs/PLAN.md` requires the eligibility key table to be built by reading
 * EA's live `SBCEligibilityKey` enum at runtime (`window.SBCEligibilityKey`)
 * rather than hardcoding numbers. That page-side read needs the M1 page bridge,
 * which does not exist yet (issue #16). Production code must therefore call
 * `readEligibilityKeys()`, which throws a clear error until the bridge lands: a
 * silent fallback to pinned numbers could decode requirements into the wrong
 * constraints without anyone noticing.
 *
 * `PINNED_ELIGIBILITY_KEYS` and `SCOPE_VALUES` below are observation-based
 * development and test data, read off the captured fixtures in `test/fixtures/`.
 * Tests import them directly; production code must not.
 *
 * ## Optional role-id lists
 *
 * `normaliseClubItem` exposes `plusRoles` as `rolePlus` and `plusPlusRoles` as
 * `rolePlusPlus`: lists of role-id numbers for later rarity and special-card
 * rules (#6 and beyond). `plusRoles` is present on every captured fixture item
 * and `plusPlusRoles` on only a few, but neither list feeds any measurement
 * yet, so a missing list is not evidence that the payload shape changed and
 * normalises to `[]` rather than throwing. A list that is present must still be
 * dense and numeric; see `normaliseClubItem`.
 *
 * ## Stable solver vocabulary
 *
 * `PINNED_ELIGIBILITY_KEYS` maps `eligibilityKey` to a descriptor:
 *
 *   type   the payload's `type` string for that key (input side). The decoder
 *          only cross-checks the payload against it; it is never emitted.
 *   kind   the stable internal kind emitted on a decoded constraint (output
 *          side). This is the vocabulary the rest of the solver codes against.
 *          EA's `type` strings are volatile between game versions; `kind` is
 *          owned by this adapter and must stay stable across such renames.
 *   role   what the entry means inside its `eligibilitySlot`:
 *            'count'  the squad-size quantity of a scoped player match
 *            'match'  a nation/league/club/level a 'count' applies to
 *            'scalar' a standalone quantity requirement
 *            'scope'  the comparison operator for the whole slot
 *   field  for role 'match': the internal field the values are grouped under
 *
 * A decoded constraint carries the comparison operator separately as `scope`,
 * so `kind` names the measured dimension only: a LOWER-scoped same-league count
 * is not a "min" requirement, it is a cap.
 *
 * `SCOPE_VALUES` maps `eligibilityValue` to a comparison operator name.
 *
 * Provenance of `SCOPE_VALUES`: EA's client bundle documents the comparison
 * semantics (`GREATER ? n<=r : LOWER ? r<=n : r===n`) but does not expose the
 * enum numbers. The 0/1/2 mapping below is an inference supported by the
 * captured fixtures and their challenge descriptions, not a direct reading of an
 * EA enum. Fixture cross-check: set 10 challenge 25 is titled
 * "3 Leagues & 2 Nations" and its payload carries key 8 value 3 with scope 2,
 * key 7 value 2 with scope 2, key 5 value 6 with scope 1 and key 4 value 6 with
 * scope 1 — that title is only reachable if 2 is EXACT and 1 is LOWER.
 *
 * `PLAYER_QUALITY` (key 3) is an opaque integer. The fixtures only ever observe
 * values 1, 2 and 3, but that is an observation, not a verified complete enum,
 * so the decoder does not treat the domain as closed. Which card tier each
 * number names, and how EA aggregates tiers across a squad, is NOT verified
 * here. See `src/solver/requirements.js` and issues #2 and #16.
 *
 * This file is pure data and pure functions. No DOM, no chrome APIs, no network.
 */

export const SCOPE_VALUES = Object.freeze({
  0: 'GREATER',
  1: 'LOWER',
  2: 'EXACT',
});

/**
 * Observation-based development and test data. Only tests may import this; the
 * production path is `readEligibilityKeys()`. The key numbers and kinds come
 * from the captured fixtures and may be incomplete or stale.
 */
export const PINNED_ELIGIBILITY_KEYS = Object.freeze({
  2: Object.freeze({ type: 'PLAYER_COUNT', kind: 'PLAYER_COUNT_MATCH', role: 'count' }),
  3: Object.freeze({ type: 'PLAYER_QUALITY', kind: 'PLAYER_QUALITY', role: 'scalar' }),
  4: Object.freeze({ type: 'SAME_NATION_COUNT', kind: 'SAME_NATION_COUNT', role: 'scalar' }),
  5: Object.freeze({ type: 'SAME_LEAGUE_COUNT', kind: 'SAME_LEAGUE_COUNT', role: 'scalar' }),
  6: Object.freeze({ type: 'SAME_CLUB_COUNT', kind: 'SAME_CLUB_COUNT', role: 'scalar' }),
  7: Object.freeze({ type: 'NATION_COUNT', kind: 'NATION_COUNT', role: 'scalar' }),
  8: Object.freeze({ type: 'LEAGUE_COUNT', kind: 'LEAGUE_COUNT', role: 'scalar' }),
  9: Object.freeze({ type: 'CLUB_COUNT', kind: 'CLUB_COUNT', role: 'scalar' }),
  10: Object.freeze({ type: 'NATION_ID', kind: 'NATION_MATCH', role: 'match', field: 'nationIds' }),
  11: Object.freeze({ type: 'LEAGUE_ID', kind: 'LEAGUE_MATCH', role: 'match', field: 'leagueIds' }),
  12: Object.freeze({ type: 'CLUB_ID', kind: 'CLUB_MATCH', role: 'match', field: 'clubIds' }),
  13: Object.freeze({ type: 'SCOPE', kind: 'SCOPE', role: 'scope' }),
  17: Object.freeze({
    type: 'PLAYER_LEVEL',
    kind: 'PLAYER_LEVEL_MATCH',
    role: 'match',
    field: 'playerLevels',
  }),
  19: Object.freeze({ type: 'TEAM_RATING_1_TO_100', kind: 'TEAM_RATING', role: 'scalar' }),
  35: Object.freeze({ type: 'CHEMISTRY_POINTS', kind: 'CHEMISTRY_POINTS', role: 'scalar' }),
});

/**
 * The production entry point for the eligibility key table.
 *
 * The table must be read from EA's live `SBCEligibilityKey` enum on the page
 * through the M1 page bridge. Neither the bridge nor a logged-in FC27 session is
 * available yet, so this throws instead of falling back to the pinned
 * observation table, whose numbers may be incomplete or stale.
 *
 * @returns {object} eligibilityKey -> descriptor, read from the live page enum
 * @throws {Error} always, until the M1 page bridge lands (issue #16)
 */
export function readEligibilityKeys() {
  throw new Error(
    'readEligibilityKeys: the live SBCEligibilityKey enum can only be read from the page ' +
      'through the M1 page bridge, which does not exist yet (issue #16). Production must ' +
      'not fall back to the pinned observation table; tests import PINNED_ELIGIBILITY_KEYS ' +
      'directly.'
  );
}

/**
 * Raw `/club` fields the stable schema cannot be built without, by the kind of
 * value the payload must carry. Most keep their name across the boundary;
 * `nation` becomes `nationId`, `teamid` becomes `clubId` and `rareflag` becomes
 * `rarity` (see `normaliseClubItem`).
 */
const RAW_ITEM_NUMBER_FIELDS = Object.freeze([
  'id',
  'assetId',
  'rating',
  'nation',
  'leagueId',
  'teamid',
  'rareflag',
  'cardsubtypeid',
  'playStyle',
  'pile',
  'owners',
]);

const RAW_ITEM_STRING_FIELDS = Object.freeze(['preferredPosition']);

const RAW_ITEM_BOOLEAN_FIELDS = Object.freeze(['untradeable', 'isCollected']);

const RAW_ITEM_POSITION_LIST_FIELD = 'possiblePositions';

/**
 * Optional role-id lists for later rarity/special-card rules, keyed by their raw
 * payload names. Both are read through `readRoleList`, which tolerates absence.
 */
const RAW_ITEM_ROLE_PLUS_FIELD = 'plusRoles';
const RAW_ITEM_ROLE_PLUS_PLUS_FIELD = 'plusPlusRoles';

/**
 * Price fields are nullable in the real payload: a club item can carry no
 * market average at all. `null` and an absent key both normalise to `null` —
 * unknown, not free — so a missing price can never quietly become 0. A present
 * value that is not a finite number is rejected instead of coerced.
 */
const RAW_ITEM_PRICE_FIELDS = Object.freeze([
  'marketAverage',
  'marketDataMinPrice',
  'marketDataMaxPrice',
  'discardValue',
]);

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

const isBoolean = (value) => typeof value === 'boolean';

/**
 * `Array.prototype.every` skips holes, so a sparse list like
 * `['ST', , 'CAM']` would pass an element check vacuously and spread an
 * `undefined` into the stable record. Reject holes before checking elements.
 */
const findHoleIndex = (value) => {
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return index;
  }
  return -1;
};

const isDenseArray = (value) => findHoleIndex(value) === -1;

const isStringArray = (value) =>
  Array.isArray(value) && isDenseArray(value) && value.every(isNonEmptyString);

const isFiniteNumberArray = (value) =>
  Array.isArray(value) && isDenseArray(value) && value.every(Number.isFinite);

const isNullablePrice = (value) => value === null || value === undefined || Number.isFinite(value);

const requireRawField = (rawItem, field, isValid, expected) => {
  if (!isValid(rawItem[field])) {
    throw new Error(
      `normaliseClubItem: raw item must carry ${expected}; the /club payload shape may have` +
        ' changed'
    );
  }
};

/**
 * Reads an optional role-id list. Absence (`undefined`) and `null` both mean
 * "no roles", never an error: the field is informational for later rules and is
 * not measured yet, so its absence is not evidence of a payload change. When
 * the field is present it must be a dense list of finite numbers; a wrong shape
 * throws with the raw field name, the only place such names may appear.
 */
const readRoleList = (rawItem, field) => {
  const value = rawItem[field];
  if (value === undefined || value === null) return [];
  if (!isFiniteNumberArray(value)) {
    throw new Error(
      `normaliseClubItem: raw item must carry ${field} as a dense array of finite numbers` +
        ' when present; the /club payload shape may have changed'
    );
  }
  return [...value];
};

/**
 * The one translation from a raw `/club` payload item to the stable item schema
 * the solver core codes against:
 *
 *   { id, assetId, rating, nationId, leagueId, clubId, rarity, cardSubtype,
 *     playStyles, preferredPosition, possiblePositions, rolePlus,
 *     rolePlusPlus, untradeable, pile, owners, collected, marketAverage,
 *     marketMin, marketMax, discardValue }
 *
 * `nation` becomes `nationId`, `teamid` becomes `clubId`, `rareflag` becomes
 * `rarity`, `cardsubtypeid` becomes `cardSubtype`, `playStyle` becomes
 * `playStyles` and `isCollected` becomes `collected`; `id`, `assetId`,
 * `rating`, `leagueId`, `preferredPosition`, `possiblePositions`,
 * `untradeable`, `pile`, `owners`, `marketAverage`, `discardValue` keep their
 * names. This is the only place that may know the raw `/club` field names —
 * `src/solver/validate.js` reads the stable schema only, and rejects an
 * un-normalised item.
 *
 * The raw payload must carry every non-price field as its declared type
 * (finite number, non-empty string, array of position strings, or boolean).
 * This boundary is the only point where the raw shape is known, so a missing
 * field throws here with that context instead of silently producing an
 * `undefined` that only surfaces later as a confusing solver error. The four
 * price fields are the exception: `marketAverage`, `marketDataMinPrice`,
 * `marketDataMaxPrice` and `discardValue` normalise a `null` or absent value
 * to `null`, meaning "price unknown", never to 0.
 *
 * `plusRoles` and `plusPlusRoles` are a second deliberate exception, both
 * optional lists of role-id numbers for later rarity rules that no measurement
 * reads yet: absence (or `null`) normalises to `[]` because it carries no
 * signal about the payload shape. A list that is present is still validated as
 * dense and numeric.
 *
 * @param {object} rawItem one item from the `/club` response
 * @returns {{ id: number, assetId: number, rating: number, nationId: number,
 *   leagueId: number, clubId: number, rarity: number, cardSubtype: number,
 *   playStyles: number, preferredPosition: string,
 *   possiblePositions: Array<string>, rolePlus: Array<number>,
 *   rolePlusPlus: Array<number>, untradeable: boolean, pile: number,
 *   owners: number, collected: boolean, marketAverage: number|null,
 *   marketMin: number|null, marketMax: number|null,
 *   discardValue: number|null }}
 * @throws {Error} when the raw item lacks a required field or carries one of
 *   the wrong type
 */
export function normaliseClubItem(rawItem) {
  if (rawItem === null || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    throw new Error(
      'normaliseClubItem: raw item must be an object; the /club payload shape may have changed'
    );
  }
  for (const field of RAW_ITEM_NUMBER_FIELDS) {
    requireRawField(rawItem, field, Number.isFinite, `a finite ${field}`);
  }
  for (const field of RAW_ITEM_STRING_FIELDS) {
    requireRawField(rawItem, field, isNonEmptyString, `a non-empty string ${field}`);
  }
  for (const field of RAW_ITEM_BOOLEAN_FIELDS) {
    requireRawField(rawItem, field, isBoolean, `a boolean ${field}`);
  }
  requireRawField(
    rawItem,
    RAW_ITEM_POSITION_LIST_FIELD,
    isStringArray,
    `an array of non-empty strings ${RAW_ITEM_POSITION_LIST_FIELD}`
  );
  for (const field of RAW_ITEM_PRICE_FIELDS) {
    requireRawField(rawItem, field, isNullablePrice, `a finite ${field} or null`);
  }
  return {
    id: rawItem.id,
    assetId: rawItem.assetId,
    rating: rawItem.rating,
    nationId: rawItem.nation,
    leagueId: rawItem.leagueId,
    clubId: rawItem.teamid,
    rarity: rawItem.rareflag,
    cardSubtype: rawItem.cardsubtypeid,
    playStyles: rawItem.playStyle,
    preferredPosition: rawItem.preferredPosition,
    possiblePositions: [...rawItem.possiblePositions],
    rolePlus: readRoleList(rawItem, RAW_ITEM_ROLE_PLUS_FIELD),
    rolePlusPlus: readRoleList(rawItem, RAW_ITEM_ROLE_PLUS_PLUS_FIELD),
    untradeable: rawItem.untradeable,
    pile: rawItem.pile,
    owners: rawItem.owners,
    collected: rawItem.isCollected,
    marketAverage: rawItem.marketAverage ?? null,
    marketMin: rawItem.marketDataMinPrice ?? null,
    marketMax: rawItem.marketDataMaxPrice ?? null,
    discardValue: rawItem.discardValue ?? null,
  };
}

/**
 * The one translation from a raw `/chemistry/teamlinks` entry list to the
 * stable link schema the solver core codes against:
 *
 *   { clubId, linkedClubIds }
 *
 * The raw payload names the same two numbers `teamId` and `linkedTeams`; this
 * is the only place that may know that. Each entry must carry a finite club id
 * and a dense list of finite linked club ids, so a malformed entry throws with
 * the raw field name instead of emitting an `undefined` that would silently
 * split an equivalence group. A repeated linked club id is passed through
 * unchanged: deduplication is not part of the translation, and the solver's
 * index ignores duplicates anyway. The input is never mutated.
 *
 * @param {Array<object>} rawLinks the `teamChemLinks` array from the payload
 * @returns {Array<{ clubId: number, linkedClubIds: Array<number> }>}
 * @throws {Error} when the raw links are not a dense array, or an entry lacks
 *   one of the fields or carries the wrong type
 */
export function normaliseTeamChemLinks(rawLinks) {
  if (!Array.isArray(rawLinks)) {
    throw new Error(
      'normaliseTeamChemLinks: raw links must be an array; the /chemistry/teamlinks payload' +
        ' shape may have changed'
    );
  }
  const holeIndex = findHoleIndex(rawLinks);
  if (holeIndex !== -1) {
    throw new Error(
      `normaliseTeamChemLinks: raw links must not contain holes (index ${holeIndex} is missing)`
    );
  }
  return rawLinks.map((rawLink, index) => {
    if (rawLink === null || typeof rawLink !== 'object' || Array.isArray(rawLink)) {
      throw new Error(
        `normaliseTeamChemLinks: raw link at index ${index} must be an object; the` +
          ' /chemistry/teamlinks payload shape may have changed'
      );
    }
    if (!Number.isFinite(rawLink.teamId)) {
      throw new Error(
        `normaliseTeamChemLinks: raw link at index ${index} must carry a finite teamId; the` +
          ' /chemistry/teamlinks payload shape may have changed'
      );
    }
    if (!isFiniteNumberArray(rawLink.linkedTeams)) {
      throw new Error(
        `normaliseTeamChemLinks: raw link at index ${index} must carry linkedTeams as a dense` +
          ' array of finite numbers; the /chemistry/teamlinks payload shape may have changed'
      );
    }
    return { clubId: rawLink.teamId, linkedClubIds: [...rawLink.linkedTeams] };
  });
}
