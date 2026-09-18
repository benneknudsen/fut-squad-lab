/**
 * The one file that knows EA SPORTS FC 27 SBC class names, eligibility key
 * numbers, enum values and the raw `/club` item, `/chemistry/teamlinks` and
 * `/chemistry/profiles` payload shapes. Every other module imports EA-specific
 * naming from here, so that when EA renames something exactly one file changes.
 *
 * The `normalise*` exports at the bottom are the payload half of that boundary:
 * they translate raw payloads into the stable solver schema, and the solver
 * core may only ever see the translated form.
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
 * The eleven starting slot positions of every SBC formation the solver may
 * solve, keyed by the raw payload formation code. A formation is EA payload
 * vocabulary, so the table lives here and the solver asks for the resolved
 * shape instead of knowing any code.
 *
 * `f343` means the 4-3-3 shape: four defenders, three midfielders, three
 * forwards, read left to right as the payload orders them. The list is the
 * ordered XI in slot order; chemistry slots, the squad writer and the panel all
 * index it. Only formations confirmed from the captured payloads are listed —
 * an unknown code must fail loudly rather than fall back to a guessed shape.
 *
 * The position vocabulary is fixed to what the captured club payload uses:
 * `GK CB LB RB CDM CM CAM LM RM LW RW ST`.
 */
export const FORMATION_SLOTS = Object.freeze({
  f343: Object.freeze(['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'LW', 'ST', 'RW']),
  f442: Object.freeze(['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST']),
  f4141: Object.freeze(['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'LM', 'CM', 'CM', 'RM', 'ST']),
  f451: Object.freeze(['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'CM', 'RM', 'ST']),
  f532: Object.freeze(['GK', 'LB', 'CB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'ST', 'ST']),
  f5212: Object.freeze(['GK', 'LB', 'CB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'CAM', 'ST', 'ST']),
  f3142: Object.freeze(['GK', 'CB', 'CB', 'CB', 'CDM', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST']),
});

/** The fixed position vocabulary a formation slot may name. */
const FORMATION_POSITIONS = Object.freeze(
  new Set(['GK', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CAM', 'LM', 'RM', 'LW', 'RW', 'ST'])
);

/**
 * Resolves a raw formation code to its ordered eleven slot positions:
 * `{ formation, positions }`. The returned `positions` array is a fresh copy,
 * so the caller cannot mutate the frozen module table.
 *
 * An unknown code, a non-string input, or a table entry that is neither exactly
 * eleven slots nor drawn from the fixed position vocabulary throws: a guessed
 * formation would place players in the wrong slots and silently produce a squad
 * EA rejects, so this boundary never falls back to a default shape.
 *
 * @param {string} formation a raw payload formation code, e.g. `f343`
 * @returns {{ formation: string, positions: Array<string> }} ordered slot
 *   positions, left to right as the payload lists them
 * @throws {Error} when `formation` is not a known string code, or the table
 *   entry behind it is malformed
 */
export function normaliseFormation(formation) {
  if (typeof formation !== 'string') {
    throw new Error(
      `normaliseFormation: formation must be a string; the payload may have changed or a caller` +
        ` passed ${JSON.stringify(formation)}`
    );
  }
  if (!Object.hasOwn(FORMATION_SLOTS, formation)) {
    throw new Error(
      `normaliseFormation: unknown formation ${JSON.stringify(formation)}; refusing to guess a` +
        ' shape'
    );
  }
  const positions = FORMATION_SLOTS[formation];
  if (positions.length !== 11) {
    throw new Error(
      `normaliseFormation: formation ${formation} must carry exactly 11 slots, found` +
        ` ${positions.length}`
    );
  }
  for (const position of positions) {
    if (!FORMATION_POSITIONS.has(position)) {
      throw new Error(
        `normaliseFormation: formation ${formation} names the unsupported position` +
          ` ${JSON.stringify(position)}`
      );
    }
  }
  return { formation, positions: [...positions] };
}

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

/**
 * The dimensions a chemistry rule may measure, translated from EA's raw
 * `parameterType` enum to the stable internal vocabulary. The stable values are
 * lowercase and double as the `countLinks` result keys; a raw value outside this
 * table throws, because a dimension the solver cannot score must never be
 * silently dropped from the arithmetic.
 */
const CHEMISTRY_DIMENSIONS = Object.freeze({
  NATION: 'nation',
  LEAGUE: 'league',
  CLUB: 'club',
});

/**
 * The calculation types the captured payload shows, translated from EA's raw
 * `calculationType` enum. The solver accepts only these named values and treats
 * them identically (see `src/solver/chemistry.js`); anything else throws at this
 * boundary rather than reaching the solver unnamed.
 */
const CHEMISTRY_CALCULATIONS = Object.freeze({
  NORMAL: 'normal',
  UNIVERSAL: 'universal',
});

const normaliseChemistryRule = (rawRule, profileId, index) => {
  if (rawRule === null || typeof rawRule !== 'object' || Array.isArray(rawRule)) {
    throw new Error(
      `normaliseChemistryProfile: rule ${index} of profile ${profileId} must be an object; the` +
        ' /chemistry/profiles payload shape may have changed'
    );
  }
  if (
    typeof rawRule.parameterType !== 'string' ||
    !Object.hasOwn(CHEMISTRY_DIMENSIONS, rawRule.parameterType)
  ) {
    throw new Error(
      `normaliseChemistryProfile: rule ${index} of profile ${profileId} carries the unsupported` +
        ` parameterType ${JSON.stringify(rawRule.parameterType)}; the /chemistry/profiles payload` +
        ' carries a dimension this adapter cannot name'
    );
  }
  if (
    typeof rawRule.calculationType !== 'string' ||
    !Object.hasOwn(CHEMISTRY_CALCULATIONS, rawRule.calculationType)
  ) {
    throw new Error(
      `normaliseChemistryProfile: rule ${index} of profile ${profileId} carries the unsupported` +
        ` calculationType ${JSON.stringify(rawRule.calculationType)}; only the named calculation` +
        ' types may reach the solver'
    );
  }
  if (!Number.isFinite(rawRule.value) || rawRule.value <= 0) {
    throw new Error(
      `normaliseChemistryProfile: rule ${index} of profile ${profileId} must carry a positive` +
        ` finite value, got ${JSON.stringify(rawRule.value)}; a non-positive value would divide` +
        ' by zero'
    );
  }
  return {
    dimension: CHEMISTRY_DIMENSIONS[rawRule.parameterType],
    calculation: CHEMISTRY_CALCULATIONS[rawRule.calculationType],
    value: rawRule.value,
  };
};

/**
 * Reads a profile boolean that the payload may omit, because issue #5
 * guarantees only the fields EA actually displays and a normaliser must not
 * reject a valid payload over fields nothing measures.
 *
 * `undefined` and `null` both mean "not stated" and return the fallback; a
 * present value must still be a real boolean, so a retyped field fails loudly
 * instead of being coerced.
 *
 * The three override flags (`baseOverride`, `iconOverride`, `heroOverride`)
 * fall back to `false`: absence means "no override", and nothing reads them
 * yet. `fullChemistryOnPreferredPosition` — the field name in the captured
 * payload; the `fullPositionBonus` name in the issue text is only an example
 * and is not what the capture carries — falls back to `null`, because a
 * missing position flag means "unknown", never "EA said false". The solver
 * then marks the result with a missing-flag reason instead of silently
 * assuming the flag was false.
 */
const readOptionalProfileBoolean = (rawProfile, field, fallback) => {
  const value = rawProfile[field];
  if (value === undefined || value === null) return fallback;
  if (!isBoolean(value)) {
    throw new Error(
      `normaliseChemistryProfile: profile ${rawProfile.id} must carry ${field} as a boolean or` +
        ' null when present; the /chemistry/profiles payload shape may have changed'
    );
  }
  return value;
};

const normaliseChemistryProfileEntry = (rawProfile, index) => {
  if (rawProfile === null || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
    throw new Error(
      `normaliseChemistryProfile: profile ${index} must be an object; the /chemistry/profiles` +
        ' payload shape may have changed'
    );
  }
  if (!Number.isFinite(rawProfile.id)) {
    throw new Error(
      `normaliseChemistryProfile: profile ${index} must carry a finite id; the /chemistry/profiles` +
        ' payload shape may have changed'
    );
  }
  if (!Array.isArray(rawProfile.rules) || !isDenseArray(rawProfile.rules)) {
    throw new Error(
      `normaliseChemistryProfile: profile ${rawProfile.id} must carry rules as a dense array;` +
        ' the /chemistry/profiles payload shape may have changed'
    );
  }
  return {
    id: rawProfile.id,
    fullChemistryAtPreferredPosition: readOptionalProfileBoolean(
      rawProfile,
      'fullChemistryOnPreferredPosition',
      null
    ),
    overrides: {
      base: readOptionalProfileBoolean(rawProfile, 'baseOverride', false),
      icon: readOptionalProfileBoolean(rawProfile, 'iconOverride', false),
      hero: readOptionalProfileBoolean(rawProfile, 'heroOverride', false),
    },
    rules: rawProfile.rules.map((rule, ruleIndex) =>
      normaliseChemistryRule(rule, rawProfile.id, ruleIndex)
    ),
  };
};

const normaliseChemistryMapping = (rawMapping, index) => {
  if (rawMapping === null || typeof rawMapping !== 'object' || Array.isArray(rawMapping)) {
    throw new Error(
      `normaliseChemistryProfile: mapping ${index} must be an object; the /chemistry/profiles` +
        ' payload shape may have changed'
    );
  }
  if (!Number.isFinite(rawMapping.profileId)) {
    throw new Error(
      `normaliseChemistryProfile: mapping ${index} must carry a finite profileId; the` +
        ' /chemistry/profiles payload shape may have changed'
    );
  }
  if (!isFiniteNumberArray(rawMapping.rarityIds)) {
    throw new Error(
      `normaliseChemistryProfile: mapping ${index} must carry rarityIds as a dense array of` +
        ' finite numbers; the /chemistry/profiles payload shape may have changed'
    );
  }
  return { profile: rawMapping.profileId, rarities: [...rawMapping.rarityIds] };
};

/**
 * The one translation from a raw `/chemistry/profiles` payload to the stable
 * profile schema the solver core codes against:
 *
 *   { mappings: [{ profile, rarities }],
 *     profiles: [{ id, fullChemistryAtPreferredPosition,  // boolean|null
 *                  overrides: { base, icon, hero },
 *                  rules: [{ dimension, calculation, value }] }] }
 *
 * Raw name                        Stable name
 * mappings[].profileId            mappings[].profile
 * mappings[].rarityIds            mappings[].rarities
 * profiles[].id                   profiles[].id
 * profiles[].fullChemistryOnPreferredPosition
 *                                 profiles[].fullChemistryAtPreferredPosition
 * profiles[].baseOverride         profiles[].overrides.base
 * profiles[].iconOverride         profiles[].overrides.icon
 * profiles[].heroOverride         profiles[].overrides.hero
 * rules[].parameterType           rules[].dimension (nation | league | club)
 * rules[].calculationType         rules[].calculation (normal | universal)
 * rules[].value                   rules[].value
 *
 * The enum translations are closed sets: a raw `parameterType` outside
 * NATION/LEAGUE/CLUB or a raw `calculationType` outside NORMAL/UNIVERSAL
 * throws, because the captured payload cannot name any other value and a
 * guessed translation would change every score silently. The payload `version`
 * is not carried across: nothing reads it.
 *
 * Every profile must carry a dense rules array. The four boolean fields are
 * optional because issue #5 guarantees only the fields EA actually displays:
 * the three override flags default to `false` when absent, and a missing
 * `fullChemistryOnPreferredPosition` normalises to `null` ("unknown"), never
 * to `false`, so the solver can tell "EA said no" from "we do not know". A
 * boolean field that is present but not a boolean still throws.
 *
 * Every mapping must carry a finite profile id and a dense rarity list. A
 * profile id that appears twice throws, and so does a rarity that appears in
 * more than one mapping: resolution takes the first match, so duplicates and
 * overlaps would make the choice depend on payload order.
 *
 * @param {object} rawProfile the parsed `/chemistry/profiles` response
 * @returns {{ mappings: Array<{ profile: number, rarities: Array<number> }>,
 *   profiles: Array<object> }} the stable rule set for
 *   `resolveProfile` in `src/solver/chemistry.js`
 * @throws {Error} when the payload is not shaped like a profile rule set, names
 *   an unknown dimension or calculation, or carries a malformed profile,
 *   mapping or rule
 */
export function normaliseChemistryProfile(rawProfile) {
  if (rawProfile === null || typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
    throw new Error(
      'normaliseChemistryProfile: raw profile must be an object; the /chemistry/profiles payload' +
        ' shape may have changed'
    );
  }
  for (const field of ['mappings', 'profiles']) {
    if (!Array.isArray(rawProfile[field]) || !isDenseArray(rawProfile[field])) {
      throw new Error(
        `normaliseChemistryProfile: raw profile must carry ${field} as a dense array; the` +
          ' /chemistry/profiles payload shape may have changed'
      );
    }
  }

  const profiles = rawProfile.profiles.map(normaliseChemistryProfileEntry);
  const seenIds = new Set();
  for (const profile of profiles) {
    if (seenIds.has(profile.id)) {
      throw new Error(
        `normaliseChemistryProfile: profile id ${profile.id} appears twice; resolution takes the` +
          ' first match and duplicates would make it depend on payload order'
      );
    }
    seenIds.add(profile.id);
  }

  const mappings = rawProfile.mappings.map(normaliseChemistryMapping);
  const mappingOfRarity = new Map();
  for (const [index, mapping] of mappings.entries()) {
    for (const rarity of mapping.rarities) {
      const firstIndex = mappingOfRarity.get(rarity);
      if (firstIndex !== undefined && firstIndex !== index) {
        throw new Error(
          `normaliseChemistryProfile: rarity ${rarity} appears in more than one mapping;` +
            ' resolution takes the first match and overlapping mappings would make it depend on' +
            ' payload order'
        );
      }
      mappingOfRarity.set(rarity, index);
    }
  }

  return { mappings, profiles };
}
