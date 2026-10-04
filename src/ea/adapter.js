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
 * ## Production entry point vs. observation data
 *
 * M2 of `docs/PLAN.md` requires the eligibility key table to be built by reading
 * EA's live `SBCEligibilityKey` enum at runtime (`window.SBCEligibilityKey`)
 * rather than hardcoding numbers. Production calls `readEligibilityKeys()`. The
 * live enum is the source of truth; when it is missing, `readEligibilityKeys`
 * resolves the clearly-labelled `ELIGIBILITY_KEY_FALLBACK` number table and says
 * so in its result. When the live enum is present, any disagreement with that
 * fallback is reported, and the live meaning always wins. The old pinned
 * observation table lives in `test/fixtures/eligibility-observation.js`, where
 * `src/solver/` cannot reach it.
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
 * The table `readEligibilityKeys()` builds maps `eligibilityKey` to a
 * descriptor:
 *
 *   type   the payload's `type` string for that key (input side), which is also
 *          EA's enum member name. The decoder only cross-checks the payload
 *          against it; it is never emitted.
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
 * `ELIGIBILITY_KEY_MODEL` is the name-keyed half of that descriptor, the part
 * that is our model rather than EA's data: member name to `kind`/`role`/`field`.
 * The numbers are read live. The observed number ↔ name pairs and the scope
 * mapping's provenance are test data, documented beside the pinned table in
 * `test/fixtures/eligibility-observation.js`.
 *
 * `PLAYER_QUALITY` (key 3) is an opaque integer. The fixtures only ever observe
 * values 1, 2 and 3, but that is an observation, not a verified complete enum,
 * so the decoder does not treat the domain as closed. Which card tier each
 * number names, and how EA aggregates tiers across a squad, is NOT verified
 * here. See `src/solver/requirements.js` and issues #2 and #16.
 *
 * This file is pure data and pure functions. No DOM, no chrome APIs, no network.
 */

import { describeMethodShape, describeOwnPropertyTypes, redactName } from '../shape.js';
import { DEFAULT_OBSERVABLE_TIMEOUT_MS, isObservable, observeOnce } from './observable.js';
import { CALL_KINDS, EA_CALL_FAILURE_NAME, defaultPacer } from './pacing.js';

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
 * The meanings key 25 `PLAYER_RARITY_GROUP` can carry. The same EA key stands
 * for a geographic region, for TOTS, or for TOTW-or-TOTS; which one it is
 * depends on the requirement's label and on the value. `decodeRarityGroup`
 * resolves it.
 */
export const RARITY_GROUP_MEANINGS = Object.freeze({
  REGION: 'REGION',
  TOTS: 'TOTS',
  TOTW_OR_TOTS: 'TOTW_OR_TOTS',
});

/** The classifier tag a descriptor carries when its values need decoding. */
export const RARITY_GROUP_CLASSIFIER = 'PLAYER_RARITY_GROUP';

/**
 * The geographic-region phrases a key 25 label can carry, with the stable
 * region key each resolves to. Labels are matched case-insensitively on their
 * text; the region key is our own lowercase vocabulary, not an EA enum value.
 */
const GEO_REGION_LABELS = Object.freeze([
  Object.freeze(['players from africa', 'africa']),
  Object.freeze(['players from europe', 'europe']),
  Object.freeze(['players from asia', 'asia']),
  Object.freeze(['players from south america', 'south_america']),
  Object.freeze(['players from north america', 'north_america']),
  Object.freeze(['players from oceania', 'oceania']),
]);

/**
 * Resolves a key 25 `PLAYER_RARITY_GROUP` meaning from the requirement's label
 * and value. The label wins when it names a geographic region; TOTS is named by
 * the label (TOTS or "Team of the Season") unless the label names TOTW as well,
 * which means TOTW-or-TOTS. A value of 44 means TOTW-or-TOTS when the label
 * does not say TOTS. Anything else returns a null meaning, and the decoder
 * refuses rather than guessing.
 *
 * @param {string|null|undefined} label the requirement label, when the payload
 *   carries one
 * @param {number} value the entry's `eligibilityValue`
 * @returns {{ meaning: string|null, region: string|null }}
 */
export function decodeRarityGroup(label, value) {
  const text = typeof label === 'string' ? label.toLowerCase() : '';
  const region = GEO_REGION_LABELS.find(([phrase]) => text.includes(phrase))?.[1] ?? null;
  if (region !== null) return { meaning: RARITY_GROUP_MEANINGS.REGION, region };

  const saysTots = text.includes('tots') || text.includes('team of the season');
  const saysTotw =
    text.includes('totw') || text.includes('team of the week') || text.includes('inform');
  if (saysTots && saysTotw) return { meaning: RARITY_GROUP_MEANINGS.TOTW_OR_TOTS, region: null };
  if (saysTots) return { meaning: RARITY_GROUP_MEANINGS.TOTS, region: null };
  if (value === 44) return { meaning: RARITY_GROUP_MEANINGS.TOTW_OR_TOTS, region: null };
  return { meaning: null, region: null };
}

/**
 * Canonicalises a comparison-operator name. Names are matched loosely on their
 * text: a name carrying MIN or GREATER is a minimum, one carrying MAX, LOWER or
 * LESS is a maximum, EXACT is equality and RANGE is a range. Returns `null` for
 * a name this model cannot classify, so a caller can keep its own vocabulary
 * instead of having it forced into one of the four.
 *
 * @param {*} name
 * @returns {string|null} `GREATER` | `LOWER` | `EXACT` | `RANGE` | null
 */
export function decodeScopeName(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const upper = name.toUpperCase();
  if (upper.includes('MIN')) return 'GREATER';
  if (upper.includes('MAX')) return 'LOWER';
  if (upper.includes('GREATER')) return 'GREATER';
  if (upper.includes('LOWER') || upper.includes('LESS')) return 'LOWER';
  if (upper.includes('EXACT')) return 'EXACT';
  if (upper.includes('RANGE')) return 'RANGE';
  return null;
}

/**
 * The stable solver semantics for every eligibility enum member we model,
 * keyed by EA's enum member name — which is also the payload `type` string the
 * decoder cross-checks. The key numbers are deliberately absent: they are EA's
 * volatile part and come from the live `SBCEligibilityKey` enum at runtime. A
 * live member with no entry here is reported as unmodelled and left out of the
 * decode table, so a challenge that uses it raises instead of decoding into a
 * guessed constraint.
 */
export const ELIGIBILITY_KEY_MODEL = Object.freeze({
  PLAYER_COUNT: Object.freeze({ kind: 'PLAYER_COUNT_MATCH', role: 'count' }),
  PLAYER_QUALITY: Object.freeze({ kind: 'PLAYER_QUALITY', role: 'scalar' }),
  SAME_NATION_COUNT: Object.freeze({ kind: 'SAME_NATION_COUNT', role: 'scalar' }),
  SAME_LEAGUE_COUNT: Object.freeze({ kind: 'SAME_LEAGUE_COUNT', role: 'scalar' }),
  SAME_CLUB_COUNT: Object.freeze({ kind: 'SAME_CLUB_COUNT', role: 'scalar' }),
  NATION_COUNT: Object.freeze({ kind: 'NATION_COUNT', role: 'scalar' }),
  LEAGUE_COUNT: Object.freeze({ kind: 'LEAGUE_COUNT', role: 'scalar' }),
  CLUB_COUNT: Object.freeze({ kind: 'CLUB_COUNT', role: 'scalar' }),
  NATION_ID: Object.freeze({ kind: 'NATION_MATCH', role: 'match', field: 'nationIds' }),
  LEAGUE_ID: Object.freeze({ kind: 'LEAGUE_MATCH', role: 'match', field: 'leagueIds' }),
  CLUB_ID: Object.freeze({ kind: 'CLUB_MATCH', role: 'match', field: 'clubIds' }),
  SCOPE: Object.freeze({ kind: 'SCOPE', role: 'scope' }),
  PLAYER_LEVEL: Object.freeze({ kind: 'PLAYER_LEVEL_MATCH', role: 'match', field: 'playerLevels' }),
  TEAM_RATING_1_TO_100: Object.freeze({ kind: 'TEAM_RATING', role: 'scalar' }),
  CHEMISTRY_POINTS: Object.freeze({ kind: 'CHEMISTRY_POINTS', role: 'scalar' }),
  PLAYER_RARITY_GROUP: Object.freeze({
    kind: 'PLAYER_RARITY_GROUP',
    role: 'match',
    field: 'rarityGroups',
    classify: RARITY_GROUP_CLASSIFIER,
  }),
  PLAYER_MIN_OVR: Object.freeze({ kind: 'PLAYER_MIN_OVR', role: 'match', field: 'minRatings' }),
  PLAYER_EXACT_OVR: Object.freeze({
    kind: 'PLAYER_EXACT_OVR',
    role: 'match',
    field: 'exactRatings',
  }),
  PLAYER_MAX_OVR: Object.freeze({ kind: 'PLAYER_MAX_OVR', role: 'match', field: 'maxRatings' }),
  PLAYER_TRADABILITY: Object.freeze({
    kind: 'PLAYER_TRADABILITY',
    role: 'match',
    field: 'tradabilities',
  }),
  ALL_PLAYERS_CHEMISTRY_POINTS: Object.freeze({
    kind: 'ALL_PLAYERS_CHEMISTRY_POINTS',
    role: 'scalar',
  }),
});

/**
 * The pinned model of EA's scope enum: the `eligibilityValue` of a `SCOPE`
 * entry mapped to the comparison operator it means for the requirement sharing
 * its slot.
 *
 * This is deliberately *not* an observation table read off the fixtures, and it
 * is *not* a fallback in the sense issue #16 removed: FC27 exposes no live scope
 * enum, so there is no live read this could be masking. The comparison semantics
 * (`GREATER` means the measured quantity must be >= the required value, `LOWER`
 * <=, `EXACT` ===) are documented by EA's client bundle, but EA does not expose
 * the numbers, so 0/1/2/3 is a model this project owns and pins. Value 3 is a
 * range comparison (`RANGE`), which is decoded but not yet measured by
 * `validateSquad`. The capture cross-check that supports 0/1/2 lives beside the
 * pinned key observation in `test/fixtures/eligibility-observation.js`.
 *
 * The browser half supplies this table as `options.scopes`; the solver has no
 * fallback and refuses to run without a caller-supplied table. It sits here
 * rather than in the fixtures because it is EA semantics, and EA semantics
 * belong in this one file.
 */
export const SCOPE_VALUES = Object.freeze({
  0: 'GREATER',
  1: 'LOWER',
  2: 'EXACT',
  3: 'RANGE',
});

/** A canonical non-negative integer enum key, without leading zeros. */
const ENUM_NUMBER_KEY = /^(0|[1-9]\d*)$/;

const malformedEnum = (detail) =>
  new Error(
    `readEligibilityKeys: ${EA_GLOBALS.eligibilityKeys} is malformed (${detail}); refusing to` +
      ' build a partial eligibility key table'
  );

const recordEnumMember = (byName, byNumber, name, number) => {
  const seenNumber = byName.get(name);
  if (seenNumber !== undefined && seenNumber !== number) {
    throw malformedEnum(`member ${JSON.stringify(name)} maps to both ${seenNumber} and ${number}`);
  }
  const seenName = byNumber.get(number);
  if (seenName !== undefined && seenName !== name) {
    throw malformedEnum(
      `key ${number} maps to both ${JSON.stringify(seenName)} and ${JSON.stringify(name)}`
    );
  }
  byName.set(name, number);
  byNumber.set(number, name);
};

/**
 * Reads the member pairs off an EA enum object. `SBCEligibilityKey` is a
 * TypeScript-compiled numeric enum, so it carries each member in both
 * directions (`{ PLAYER_COUNT: 2, 2: 'PLAYER_COUNT' }`); a one-directional
 * `name -> number` object is accepted too. Every member must resolve to one
 * unique number and every number to one unique name, and the table must carry
 * at least one member. Anything else throws instead of yielding a half-table.
 */
const readEnumMembers = (enumTable) => {
  if (enumTable === null || typeof enumTable !== 'object' || Array.isArray(enumTable)) {
    throw malformedEnum(`expected an enum object, got ${describeValue(enumTable)}`);
  }

  const byName = new Map();
  const byNumber = new Map();
  for (const [key, value] of Object.entries(enumTable)) {
    if (ENUM_NUMBER_KEY.test(key)) {
      if (typeof value !== 'string' || value.length === 0) {
        throw malformedEnum(`member ${JSON.stringify(key)} maps to ${describeValue(value)}`);
      }
      recordEnumMember(byName, byNumber, value, Number(key));
      continue;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      recordEnumMember(byName, byNumber, key, value);
      continue;
    }
    throw malformedEnum(`member ${JSON.stringify(key)} maps to ${describeValue(value)}`);
  }

  if (byName.size === 0) {
    throw new Error(
      `readEligibilityKeys: ${EA_GLOBALS.eligibilityKeys} carries no members; refusing to` +
        ' resolve an empty eligibility key table'
    );
  }

  return [...byName.entries()]
    .map(([name, number]) => ({ name, number }))
    .sort((left, right) => left.number - right.number);
};

/**
 * The number-to-member-name fallback for `SBCEligibilityKey`, used only when
 * the live enum cannot be read. It is a *fallback*, never the source of truth:
 * when the live enum is present it wins, and `readEligibilityKeys` reports any
 * disagreement between the two instead of reconciling it.
 *
 * Provenance: the numbers and names are facts about EA's shipped FC27 client
 * enum. Most entries were confirmed by a capture of the live `SBCEligibilityKey`
 * table; the rest are pinned here so a broken live read still fails loudly on
 * the first key the model cannot name, rather than silently decoding nothing.
 * Key 19 keeps the name the live FC27 enum observed (`TEAM_RATING_1_TO_100`),
 * not a shortened variant. This table carries numbers only; the stable solver
 * semantics stay in `ELIGIBILITY_KEY_MODEL` above.
 */
export const ELIGIBILITY_KEY_FALLBACK = Object.freeze({
  0: 'TEAM_STAR_RATING',
  2: 'PLAYER_COUNT',
  3: 'PLAYER_QUALITY',
  4: 'SAME_NATION_COUNT',
  5: 'SAME_LEAGUE_COUNT',
  6: 'SAME_CLUB_COUNT',
  7: 'NATION_COUNT',
  8: 'LEAGUE_COUNT',
  9: 'CLUB_COUNT',
  10: 'NATION_ID',
  11: 'LEAGUE_ID',
  12: 'CLUB_ID',
  13: 'SCOPE',
  15: 'LEGEND_COUNT',
  16: 'NUM_TROPHY_REQUIRED',
  17: 'PLAYER_LEVEL',
  18: 'PLAYER_RARITY',
  19: 'TEAM_RATING_1_TO_100',
  21: 'PLAYER_COUNT_COMBINED',
  25: 'PLAYER_RARITY_GROUP',
  26: 'PLAYER_MIN_OVR',
  27: 'PLAYER_EXACT_OVR',
  28: 'PLAYER_MAX_OVR',
  30: 'FIRST_OWNER_PLAYERS_COUNT',
  33: 'PLAYER_TRADABILITY',
  35: 'CHEMISTRY_POINTS',
  36: 'ALL_PLAYERS_CHEMISTRY_POINTS',
});

const fallbackMembers = () =>
  Object.entries(ELIGIBILITY_KEY_FALLBACK)
    .map(([number, name]) => ({ name, number: Number(number) }))
    .sort((left, right) => left.number - right.number);

const fallbackDescriptors = () => {
  const descriptors = {};
  for (const [number, name] of Object.entries(ELIGIBILITY_KEY_FALLBACK)) {
    descriptors[number] = { type: name };
  }
  return descriptors;
};

/**
 * The production entry point for the eligibility key table: reads EA's live
 * `SBCEligibilityKey` enum off the page's `window` and builds the descriptor
 * table from it plus `ELIGIBILITY_KEY_MODEL`.
 *
 * The live enum is the source of truth. When it is present but malformed or
 * empty this throws naming the EA symbol: a present-but-broken table is a
 * problem to fix, not a reason to substitute stale numbers. Only a *missing*
 * global falls back to `ELIGIBILITY_KEY_FALLBACK`, and the result then says so
 * in `source` and `liveError`. A live member the model cannot name is left out
 * of the table and reported in `unmodelled`, so a challenge that uses it raises
 * with the key named instead of decoding a guessed constraint.
 *
 * `drift` is the live table compared against the fallback, in
 * `crossCheckEligibilityKeys` form: `added` (live only), `missing` (fallback
 * only) and `renamed` (same number, different name). A disagreement is always
 * reported; the live meaning always wins. When the fallback itself supplied the
 * table, `drift` is empty by construction.
 *
 * No live scope enum is verified in FC27, so `scopes` is `null`: the 0/1/2/3
 * scope mapping is an inference and the caller supplies it. Inventing a live
 * source for it would be a guess.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @returns {{ keys: object, scopes: null, members: Array<{eligibilityKey: number,
 *   type: string}>, unmodelled: Array<{eligibilityKey: number, type: string}>,
 *   source: 'live'|'fallback', liveError: string|null,
 *   drift: { added: Array<object>, missing: Array<object>, renamed: Array<object> } }}
 *   `keys` maps an `eligibilityKey` number to the same descriptor shape the
 *   decoder consumes (`{ type, kind, role, field?, classify? }`); `members` is
 *   every enum member as read, for support reports
 * @throws {Error} when the global is present but empty, or a member is
 *   malformed or ambiguous
 */
export function readEligibilityKeys(pageWindow) {
  const enumTable = resolveEaGlobal(pageWindow, 'eligibilityKeys');
  const source = enumTable === null ? 'fallback' : 'live';
  const liveError =
    source === 'fallback'
      ? `${EA_GLOBALS.eligibilityKeys} is missing from the page window; resolving the pinned` +
        ' fallback key table instead (see ELIGIBILITY_KEY_FALLBACK in src/ea/adapter.js)'
      : null;
  const members = source === 'live' ? readEnumMembers(enumTable) : fallbackMembers();

  const keys = {};
  const unmodelled = [];
  for (const { name, number } of members) {
    const model = ELIGIBILITY_KEY_MODEL[name];
    if (model === undefined) {
      unmodelled.push(Object.freeze({ eligibilityKey: number, type: name }));
      continue;
    }
    const descriptor = { type: name, kind: model.kind, role: model.role };
    if (model.field !== undefined) descriptor.field = model.field;
    if (model.classify !== undefined) descriptor.classify = model.classify;
    keys[number] = Object.freeze(descriptor);
  }

  // The drift report compares what the live enum read — including members our
  // model cannot name — against the fallback numbers, so a renumbered or
  // renamed member is surfaced even when the model has no descriptor for it.
  // A fallback-sourced table cannot disagree with itself, so its drift is empty.
  const liveDescriptors = {};
  for (const { name, number } of members) liveDescriptors[number] = { type: name };
  const drift =
    source === 'live'
      ? crossCheckEligibilityKeys(liveDescriptors, fallbackDescriptors())
      : { added: [], missing: [], renamed: [] };

  return Object.freeze({
    keys: Object.freeze(keys),
    scopes: null,
    members: Object.freeze(
      members.map(({ name, number }) => Object.freeze({ eligibilityKey: number, type: name }))
    ),
    unmodelled: Object.freeze(unmodelled),
    source,
    liveError,
    drift: Object.freeze(drift),
  });
}

/**
 * Compares the table built from the live enum against the pinned observation
 * set and reports both directions, plus the same number wearing a different
 * name:
 *
 *   added    live has it, our observed table does not. The table
 *            `readEligibilityKeys` built already carries the descriptor when
 *            our model names the member, so a new EA key does not have to
 *            become an unknown eligibilityKey.
 *   missing  our table models it, the live enum does not. Our model is wrong
 *            and must be investigated, never silently reconciled.
 *   renamed  the same number maps to a different name live. That is a
 *            renumbering or a rename and is surfaced, not reconciled.
 *
 * Pure: two plain tables in, plain report out. The pinned table is test data,
 * so this runs offline without a page.
 *
 * @param {object} liveKeys number -> descriptor built from the live enum
 * @param {object} observedKeys number -> descriptor from the pinned observation
 *   set
 * @returns {{ added: Array<{eligibilityKey: number, type: string}>,
 *   missing: Array<{eligibilityKey: number, type: string}>,
 *   renamed: Array<{eligibilityKey: number, liveType: string,
 *   observedType: string}> }} every entry names the number and the EA member
 *   name(s), so a caller can act on it
 */
export function crossCheckEligibilityKeys(liveKeys, observedKeys) {
  const added = [];
  const missing = [];
  const renamed = [];

  for (const [rawKey, live] of Object.entries(liveKeys)) {
    const eligibilityKey = Number(rawKey);
    if (!Object.hasOwn(observedKeys, eligibilityKey)) {
      added.push({ eligibilityKey, type: live.type });
      continue;
    }
    const observed = observedKeys[eligibilityKey];
    if (observed.type !== live.type) {
      renamed.push({ eligibilityKey, liveType: live.type, observedType: observed.type });
    }
  }

  for (const [rawKey, observed] of Object.entries(observedKeys)) {
    const eligibilityKey = Number(rawKey);
    if (!Object.hasOwn(liveKeys, eligibilityKey)) {
      missing.push({ eligibilityKey, type: observed.type });
    }
  }

  return { added, missing, renamed };
}

/**
 * The live-enum half of the #16 cross-check, built for the one-session
 * diagnostic report (#40). It answers three questions a pinned offline
 * cross-check cannot answer on its own:
 *
 *   pinned   how many names `ELIGIBILITY_KEY_MODEL` pins are present in the
 *            live enum (`presentNames`), and which of them are missing live.
 *            Only the names are pinned in `src/`; the numbers are live, so a
 *            renamed member cannot be detected from the model alone.
 *   unknown  live members our model cannot name, already collected as
 *            `unmodelled` by `readEligibilityKeys`.
 *   renamed  the live enum's number wearing a different name than the
 *            challenge payload uses for it. The payload's `(eligibilityKey,
 *            type)` pairs are EA's own live assertion for that number — the
 *            captured observation model, expressed live — so this detects the
 *            renumbering the decoder would otherwise only report as a stage-5
 *            failure. `undecodable` lists payload keys the live-built table
 *            cannot decode at all.
 *
 * Pure: plain data in, plain report out. Never substitutes the pinned table
 * for the live one; a caller with no live enum must report the read failure.
 *
 * @param {{ keys: object, members: Array<object>, unmodelled: Array<object> }}
 *   resolved the `readEligibilityKeys` result
 * @param {Array<object>} [elgReq] the challenge payload's requirement entries
 * @returns {{ pinned: { present: number, presentNames: Array<string>,
 *   missing: Array<string> }, unknown: Array<object>,
 *   renamed: Array<object>, undecodable: Array<object> }}
 */
export function crossCheckEligibilityModel(resolved, elgReq = []) {
  const members = Array.isArray(resolved?.members) ? resolved.members : [];
  const rawKeys = resolved !== null && typeof resolved === 'object' ? resolved.keys : null;
  const keys =
    rawKeys !== null && typeof rawKeys === 'object' && !Array.isArray(rawKeys) ? rawKeys : {};
  const liveNames = new Set(members.map((member) => member.type));
  const modelNames = Object.keys(ELIGIBILITY_KEY_MODEL);
  const presentNames = modelNames.filter((name) => liveNames.has(name));

  const payloadKeys = {};
  if (Array.isArray(elgReq)) {
    for (const entry of elgReq) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        Number.isInteger(entry.eligibilityKey) &&
        typeof entry.type === 'string' &&
        entry.type.length > 0
      ) {
        payloadKeys[entry.eligibilityKey] = { type: entry.type };
      }
    }
  }
  const drift = crossCheckEligibilityKeys(keys, payloadKeys);

  return {
    pinned: {
      present: presentNames.length,
      presentNames,
      missing: modelNames.filter((name) => !liveNames.has(name)),
    },
    unknown: members
      .filter((member) => ELIGIBILITY_KEY_MODEL[member.type] === undefined)
      .map((member) => ({ eligibilityKey: member.eligibilityKey, type: member.type })),
    renamed: drift.renamed,
    undecodable: drift.missing,
  };
}

const describeEligibilityEntry = (entry) =>
  entry.liveType === undefined
    ? `${entry.eligibilityKey}=${entry.type}`
    : `${entry.eligibilityKey}=${entry.liveType}/${entry.observedType}`;

/**
 * Renders a `readEligibilityKeys` result as one diagnostic line a support
 * report can paste: every resolved key, the live members our model cannot
 * name, the cross-check report when supplied, and the explicit statement that
 * scopes have no live source. The result never contains a newline.
 *
 * @param {{ keys: object, unmodelled: Array<object>, report?: object }} resolved
 *   the `readEligibilityKeys` result, optionally carrying a `report` from
 *   `crossCheckEligibilityKeys`
 * @param {object|null} [report] an explicit report, overriding `resolved.report`
 * @returns {string}
 */
export function formatEligibilityKeysLine(resolved, report = resolved.report ?? null) {
  const keys = Object.entries(resolved.keys)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([key, descriptor]) => `${Number(key)}=${descriptor.type}`);

  const parts = [
    `FUT Squad Lab: ${EA_GLOBALS.eligibilityKeys}: ${keys.length} resolved [${keys.join(
      ', '
    )}] (source=${resolved.source ?? 'unknown'})`,
    resolved.unmodelled.length === 0
      ? 'unmodelled: none'
      : `unmodelled [${resolved.unmodelled.map(describeEligibilityEntry).join(', ')}]`,
  ];
  if (typeof resolved.liveError === 'string') {
    parts.push(`live read failed: ${resolved.liveError}`);
  }
  if (report !== null) {
    parts.push(
      `cross-check added [${report.added.map(describeEligibilityEntry).join(', ')}],` +
        ` missing [${report.missing.map(describeEligibilityEntry).join(', ')}],` +
        ` renamed [${report.renamed.map(describeEligibilityEntry).join(', ')}]`
    );
  }
  parts.push('scopes: no live scope enum, supplied by the caller');
  return parts.join('; ');
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

/**
 * The key names a rejected raw item carries, sorted and renamed through the
 * shared paste-safety list (#74): a live report must say what EA actually sent
 * without ever carrying a value, and sorting the names makes two runs diffable.
 * A name the redaction list marks sensitive stays visible as `<redacted>`.
 */
const carriedKeys = (rawItem) =>
  Object.keys(rawItem)
    .map((name) => redactName(name))
    .sort();

const rejectedItemError = (rawItem, field, message) => {
  const keys = carriedKeys(rawItem);
  const error = new Error(
    `${message}; rejected field ${field}; it carries keys [${keys.join(', ')}]; the /club` +
      ' payload shape may have changed'
  );
  error.rawItemShape = { field, keys };
  return error;
};

const requireRawField = (rawItem, field, isValid, expected) => {
  if (!isValid(rawItem[field])) {
    throw rejectedItemError(rawItem, field, `normaliseClubItem: raw item must carry ${expected}`);
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
    throw rejectedItemError(
      rawItem,
      field,
      `normaliseClubItem: raw item must carry ${field} as a dense array of finite numbers when` +
        ' present'
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
 * `undefined` that only surfaces later as a confusing solver error. A rejected
 * item additionally reports the field that failed and the key names it does
 * carry, sorted and renamed through the shared paste-safety list, so the next
 * live log states what EA actually sent without carrying any value (#74).
 * The four price fields are the exception: `marketAverage`, `marketDataMinPrice`,
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

/**
 * The verified FC27 page globals from `docs/PLAN.md` section 1.1, keyed by a
 * stable internal name. `src/page-bridge.js` and the readers never spell an EA
 * class name themselves; they ask this table for it.
 */
export const EA_GLOBALS = Object.freeze({
  sbcService: 'UTSBCService',
  sbcRepository: 'UTSBCRepository',
  challengeEntity: 'UTSBCChallengeEntity',
  setEntity: 'UTSBCSetEntity',
  factory: 'UTSBCFactory',
  challengeDao: 'UTSquadBuildingChallengeDAO',
  squadDetailPanel: 'UTSBCSquadDetailPanelViewController',
  squadDetailPanelView: 'UTSBCSquadDetailPanelView',
  squadOverview: 'UTSBCSquadOverviewViewController',
  sbcHub: 'UTSBCHubViewController',
  challengesView: 'UTSBCChallengesViewController',
  confirmSubmissionPopup: 'UTSBCConfirmSubmissionPopupViewController',
  squadStatsView: 'UTSBCSquadStatsView',
  squadEntity: 'UTSquadEntity',
  searchViewModel: 'UTBucketedItemSearchViewModel',
  eligibilityKeys: 'SBCEligibilityKey',
  services: 'services',
});

/**
 * The one method on `UTSBCSquadDetailPanelViewController` the M1 bridge patches,
 * per `docs/PLAN.md` section 1.1. It is the entry point through which the panel
 * receives its challenge, so patching it is how the button learns which
 * challenge is on screen.
 */
export const EA_PANEL_HOOK = Object.freeze({
  entry: 'initWithSBCSet',
});

/** The verified endpoint paths from `docs/PLAN.md` section 1.2. */
export const EA_ENDPOINTS = Object.freeze({
  sets: '/sbs/sets',
  setChallenges: '/sbs/setId/{setId}/challenges',
  challengeSquad: '/sbs/challenge/{challengeId}',
  challengeSquadRead: '/sbs/challenge/{challengeId}/squad',
  club: '/club',
  purchasedItems: '/purchased/items',
  squadActive: '/squad/active',
  squadList: '/squad/list',
  squad: '/squad/{squadId}',
  chemistryProfiles: '/chemistry/profiles',
  chemistryTeamLinks: '/chemistry/teamlinks',
  userMassInfo: '/usermassinfo',
});

/**
 * Raw field names on a challenge payload that the challenge reader consumes.
 * The live entity classes wrap this same payload; the readers see it through
 * `resolveChallengeSubject`.
 *
 * `requirements` is the field our own fixtures carry. The #51 finding showed
 * the loaded payload may name the same array `eligibilityRequirements`,
 * `requirements` or `requirementsList`, may expose it through a
 * `getRequirements()` method, and may bury it one level down inside
 * `challenge`, `sbcChallenge`, `data.challenge` or `data.sbcChallenge`.
 * `resolveChallengeRequirements` is the one place that knows that search.
 */
export const CHALLENGE_FIELDS = Object.freeze({
  challengeId: 'challengeId',
  name: 'name',
  formation: 'formation',
  operation: 'elgOperation',
  requirements: 'elgReq',
  eligibilityRequirements: 'eligibilityRequirements',
  requirementsList: 'requirementsList',
  getRequirements: 'getRequirements',
  setId: 'setId',
  squad: 'squad',
});

/**
 * The property names a requirements array may live under, in the documented
 * order. Our own observed field is appended after the issue's three, so the
 * documented order is preserved and the legacy shape still decodes.
 */
export const CHALLENGE_REQUIREMENT_PROPERTIES = Object.freeze([
  'eligibilityRequirements',
  'requirements',
  'requirementsList',
  'elgReq',
]);

/**
 * The containers a requirements array may live inside, one level down, in the
 * documented order. Each entry is a path of raw payload segment names.
 */
export const CHALLENGE_REQUIREMENT_CONTAINERS = Object.freeze([
  Object.freeze(['challenge']),
  Object.freeze(['sbcChallenge']),
  Object.freeze(['data', 'challenge']),
  Object.freeze(['data', 'sbcChallenge']),
]);

/**
 * The raw `/club` response field that carries the item array. The `fsl-build/9`
 * live run read `{ items, retrievedAll }` from `services.Club.search` and
 * `{ items, endOfList }` from `services.Item.searchStorageItems`, so the live
 * payload names it `items`. The older `/club` recon named the same array
 * `itemData`; that name is kept in `CLUB_ITEM_ARRAY_ALTERNATIVES` so diagnostics
 * can report a payload carrying it, never so the reader can silently fall back
 * to it. This build reads `items` only.
 */
export const CLUB_ITEM_ARRAY_FIELD = 'items';

/**
 * Field names a club payload was seen to carry that this build does NOT read.
 * Diagnostics name them explicitly when a payload carries one instead of
 * `CLUB_ITEM_ARRAY_FIELD`, so a future capture shows what EA returned rather
 * than a guessed empty club (#72).
 */
export const CLUB_ITEM_ARRAY_ALTERNATIVES = Object.freeze(['itemData']);

/**
 * The end-of-list flags a club page may carry, in the reference's precedence:
 * when `endOfList` is present it decides, otherwise `retrievedAll` does. A
 * truthy flag means the walk is finished. A page carrying neither keeps the
 * walk going until an empty page or the page cap ends it.
 */
export const CLUB_ITEM_END_OF_LIST_FIELDS = Object.freeze(['endOfList', 'retrievedAll']);

/**
 * The raw `/club` item field that identifies one owned card. It is the same
 * `id` the solver's stable records carry and the one a solved player is looked
 * up by when the squad writer places real item records.
 */
export const CLUB_ITEM_ID_FIELD = 'id';

/**
 * Raw field names on the challenge-squad payload (`POST /sbs/challenge/{id}`,
 * the shape captured in `test/fixtures/sbs-challenge-25-squad.json`) that the
 * squad writer consumes and produces. The payload wraps a `squad` object whose
 * `players` array carries one entry per formation slot, each entry holding its
 * formation slot index and the real `itemData` record. `index` is the formation
 * slot index, not the entry's position in the array; the two happen to agree in
 * the captured empty template and must not be conflated.
 */
export const CHALLENGE_SQUAD_FIELDS = Object.freeze({
  challengeId: 'challengeId',
  squad: 'squad',
  id: 'id',
  formation: 'formation',
  rating: 'rating',
  chemistry: 'chemistry',
  manager: 'manager',
  players: 'players',
  index: 'index',
  itemData: 'itemData',
});

/**
 * The `id` every captured empty challenge-squad slot carries: the template item
 * for a formation slot is a zero-id `itemState: 'invalid'` placeholder. The
 * writer treats only this observed marker as "empty"; any other entry shape is
 * left alone rather than guessed at, because overwriting a player is not
 * recoverable.
 */
export const EMPTY_SLOT_ITEM_ID = 0;

/**
 * Candidate method names on a squad *slot* object, in the order the writer tries
 * them for the slot-level fallback. The recon captured `UTSquadEntity`'s
 * `getSlot`/`getSlots` readers but no slot-object methods at all, so this list
 * is the set of names worth probing, not verified vocabulary. The writer reports
 * which one answered, or why none did.
 */
export const SQUAD_SLOT_WRITE_METHODS = Object.freeze(['setItemData', 'setItem', 'setPlayer']);

/**
 * The ordered squad-write candidates, most likely first. `saveChallenge` on the
 * challenge DAO is EA's own save path for a challenge squad and comes first;
 * the squad entity's `save` is the next named path; the `getSlots+save` entries
 * are the slot-level fallback, which requires one of
 * `SQUAD_SLOT_WRITE_METHODS` on every slot object.
 *
 * Every entry is a candidate to *feature-detect*, not a verified signature. The
 * writer calls each in order, records the outcome, and never forges an HTTP
 * request: if none answers, it reports that plainly. `submitChallenge` is
 * deliberately absent and must never be added here.
 *
 * `requireArgument` marks a candidate whose named method must declare at least
 * one parameter before the writer will hand it a payload. A bare `save()` that
 * declares none persists whatever state its entity already holds, which is not
 * the solution; the writer records that reason and falls through to the
 * slot-level candidates, which apply the solution to the entity's own slot
 * objects first.
 */
export const SQUAD_WRITE_STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'services.UTSquadBuildingChallengeDAO.saveChallenge',
    container: 'services',
    target: 'challengeDao',
    method: 'saveChallenge',
  }),
  Object.freeze({
    id: 'window.UTSquadBuildingChallengeDAO.saveChallenge',
    container: 'window',
    target: 'challengeDao',
    method: 'saveChallenge',
  }),
  Object.freeze({
    id: 'services.UTSquadEntity.save',
    container: 'services',
    target: 'squadEntity',
    method: 'save',
    requireArgument: true,
  }),
  Object.freeze({
    id: 'window.UTSquadEntity.save',
    container: 'window',
    target: 'squadEntity',
    method: 'save',
    requireArgument: true,
  }),
  Object.freeze({
    id: 'services.UTSquadEntity.getSlots+save',
    container: 'services',
    target: 'squadEntity',
    method: 'save',
    slotMethods: SQUAD_SLOT_WRITE_METHODS,
  }),
  Object.freeze({
    id: 'window.UTSquadEntity.getSlots+save',
    container: 'window',
    target: 'squadEntity',
    method: 'save',
    slotMethods: SQUAD_SLOT_WRITE_METHODS,
  }),
]);

/**
 * Reads a named global off the page's `window`.
 *
 * This never touches a global `window`: the caller passes the page window in,
 * because the adapter is imported by the pure solver and must stay importable
 * in Node. A missing global returns `null` so the caller can decide between a
 * feature-detect and a hard requirement.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @param {string} key a key of `EA_GLOBALS`
 * @returns {*} the global's value, or `null` when absent
 * @throws {Error} when `key` is not in `EA_GLOBALS` (a caller bug, not a
 *   renamed EA global)
 */
export function resolveEaGlobal(pageWindow, key) {
  if (!Object.hasOwn(EA_GLOBALS, key)) {
    throw new Error(
      `resolveEaGlobal: ${JSON.stringify(key)} is not an EA global name; add it to EA_GLOBALS` +
        ' in src/ea/adapter.js instead of spelling it at the call site'
    );
  }
  const value = pageWindow?.[EA_GLOBALS[key]];
  return value === undefined ? null : value;
}

/**
 * The hard requirement variant of `resolveEaGlobal`: a missing global throws an
 * `Error` that names the expected EA symbol, so a rename between game versions
 * reports `UTSBCSquadDetailPanelViewController`, not a bare `TypeError` from a
 * call on `undefined`.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @param {string} key a key of `EA_GLOBALS`
 * @returns {*} the global's value
 * @throws {Error} when the global is missing, naming the expected symbol
 */
export function requireEaGlobal(pageWindow, key) {
  const value = resolveEaGlobal(pageWindow, key);
  if (value === null) {
    throw new Error(
      `EA global ${EA_GLOBALS[key]} is missing from the page window; the FC27 web app may have` +
        ' renamed it (see EA_GLOBALS in src/ea/adapter.js)'
    );
  }
  return value;
}

/**
 * Feature-detects a set of globals without throwing: the caller gets both the
 * resolved values and the names that were missing, which is what the page
 * bridge reports when the app has changed.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @param {Array<string>} [keys] keys of `EA_GLOBALS`; defaults to all of them
 * @returns {{ resolved: object, missing: Array<string> }} `missing` holds the
 *   expected EA symbol names, not the internal keys
 */
export function resolveEaGlobals(pageWindow, keys = Object.keys(EA_GLOBALS)) {
  const resolved = {};
  const missing = [];
  for (const key of keys) {
    const value = resolveEaGlobal(pageWindow, key);
    if (value === null) missing.push(EA_GLOBALS[key]);
    else resolved[key] = value;
  }
  return { resolved, missing };
}

/**
 * True when a value is one of the two shapes a club read may return: the live
 * `{ items: [...] }` envelope, or a bare item array. Only
 * `CLUB_ITEM_ARRAY_FIELD` is accepted; a payload naming the array anything else
 * is reported by `describeClubPayload`, never read as a fallback guess.
 */
export function isClubPayload(value) {
  if (Array.isArray(value)) return true;
  return (
    value !== null &&
    typeof value === 'object' &&
    Array.isArray(value[CLUB_ITEM_ARRAY_FIELD])
  );
}

const describeValue = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return `an object (${Object.keys(value).join(', ') || 'no keys'})`;
  return typeof value;
};

const describeCause = (error) =>
  error !== null && typeof error === 'object' ? error.message : String(error);

const resolveTimeoutMs = (value) =>
  Number.isFinite(value) && value > 0 ? value : DEFAULT_OBSERVABLE_TIMEOUT_MS;

/**
 * The pacer a call runs through (#52): the caller's injected one, or the shared
 * default so a direct call is paced too. There is no unpaced branch here.
 */
const resolvePacer = (options) =>
  options !== null && typeof options === 'object' && options.pacer !== undefined
    ? options.pacer
    : defaultPacer();

/**
 * A failed EA call in the shape the pacer classifies: the observable bridge's
 * own message plus the status it reported. The name marks it so a
 * budget-exhaustion wrapper keeps the message printable without a `threw:`
 * prefix.
 */
const callFailure = (message, status) => {
  const error = new Error(message);
  error.name = EA_CALL_FAILURE_NAME;
  if (Number.isFinite(status)) error.status = status;
  return error;
};

/**
 * The attempt reason for a failed paced call. An observable failure keeps the
 * message `describeEventError` produced; anything thrown keeps the pre-#52
 * `threw: ...` form, so a budget-exhaustion wrapper still names which part
 * failed.
 */
const failureReason = (error) =>
  error?.name === EA_CALL_FAILURE_NAME ? error.message : `threw: ${describeCause(error)}`;

/**
 * The name a failure carries when EA's own method threw while being called with
 * our argument (#61). The message is kept byte for byte so the pacer's retry
 * table classifies the same failure the same way; only the name records that
 * the throw came from inside EA rather than from the observable bridge. The
 * search path then reports it as "EA threw while calling this method with our
 * criteria", which no reader can mistake for a missing method.
 */
const EA_METHOD_THREW_NAME = 'EaMethodThrew';

const methodThrew = (error) => {
  const message = describeCause(error);
  const wrapped = new Error(message === undefined ? 'undefined' : message);
  wrapped.name = EA_METHOD_THREW_NAME;
  if (Number.isFinite(error?.status)) wrapped.status = error.status;
  wrapped.cause = error;
  return wrapped;
};

/**
 * The ordered club-read strategies this bridge tries, most likely first.
 *
 * The #51 finding showed the read is a **search**, not a `getClubItems` call:
 * EA's service methods return observables, and the club is read by taking
 * `searchCriteria` off the `UTBucketedItemSearchViewModel`, preferring an
 * instance this project constructs itself, setting the page size and offset on
 * that criteria object, and subscribing to `services.Club.search(criteria)`.
 * The criteria object is handed over as it is, never copied: its public fields
 * live on the prototype (#70). That search path is the entry of the
 * chain; `services.Item.searchStorageItems` is the same call shape for the
 * unassigned/storage pile and is tried next.
 *
 * Everything below those two entries is the map of where the club read has
 * already failed: the #44 shape report proved the instances live under
 * `services.<Domain>` (`services.Club.clubDao`, `services.Item.itemDao`,
 * `services.SBC.repository` and so on), never at `services.<ClassName>`, so
 * the chain reaches the proven instance paths next, then the repository search
 * names the report proved, then the legacy `services.UTSBCRepository` entry as
 * a late fallback for a page build that still exposes it, and finally the
 * window classes, which are refused as constructors because a class is not an
 * instance. Nothing is deleted on failure: every candidate keeps its
 * `{id, ok, reason}` record so the next live report can see the whole map.
 *
 * The #50 live session proved `services.Club.clubDao.getClubItems` exists and
 * runs: it threw reading `.cacheable` off `undefined`, which points at its
 * first argument. Its minimal call shapes are therefore both tried, under
 * their own ids: no arguments, then a single empty object. `{}` is the empty
 * argument, not an invented payload — no field value, no count and no offset
 * is guessed, and a strategy's `argument` property is the only payload this
 * chain ever passes. An attempt whose method resolved carries that method's
 * `{arity, constructor, excerpt, truncated}` shape, so the next live run can
 * read the real call shape instead of guessing another name.
 *
 * Every method is called through the observable bridge: a returned observable
 * is subscribed and unsubscribed with a timeout, while a returned value or
 * promise is accepted as-is for the page builds that still hand one back.
 */
export const CLUB_ITEM_STRATEGIES = Object.freeze([
  Object.freeze({ id: 'services.Club.search+searchCriteria', container: 'services', target: 'Club', method: 'search', searchCriteria: true }),
  Object.freeze({ id: 'services.Item.searchStorageItems+searchCriteria', container: 'services', target: 'Item', method: 'searchStorageItems', searchCriteria: true }),
  Object.freeze({ id: 'services.Club.clubDao.getClubItems', container: 'services', target: 'Club.clubDao', method: 'getClubItems' }),
  Object.freeze({ id: 'services.Club.clubDao.getClubItems+{}', container: 'services', target: 'Club.clubDao', method: 'getClubItems', argument: Object.freeze({}) }),
  Object.freeze({ id: 'services.Club.clubDao.search', container: 'services', target: 'Club.clubDao', method: 'search' }),
  Object.freeze({ id: 'services.Club.clubRepository.search', container: 'services', target: 'Club.clubRepository', method: 'search' }),
  Object.freeze({ id: 'services.Club.clubService.search', container: 'services', target: 'Club.clubService', method: 'search' }),
  Object.freeze({ id: 'services.Item.itemDao.getClubItems', container: 'services', target: 'Item.itemDao', method: 'getClubItems' }),
  Object.freeze({ id: 'services.Item.itemDao.search', container: 'services', target: 'Item.itemDao', method: 'search' }),
  Object.freeze({ id: 'services.SBC.itemRepository.getClubItems', container: 'services', target: 'SBC.itemRepository', method: 'getClubItems' }),
  Object.freeze({ id: 'services.SBC.itemRepository.search', container: 'services', target: 'SBC.itemRepository', method: 'search' }),
  Object.freeze({ id: 'services.SBC.repository.getClubItems', container: 'services', target: 'SBC.repository', method: 'getClubItems' }),
  Object.freeze({ id: 'services.SBC.repository.search', container: 'services', target: 'SBC.repository', method: 'search' }),
  Object.freeze({ id: 'services.SBC.sbcDAO.getClubItems', container: 'services', target: 'SBC.sbcDAO', method: 'getClubItems' }),
  Object.freeze({ id: 'services.SBC.sbcDAO.search', container: 'services', target: 'SBC.sbcDAO', method: 'search' }),
  Object.freeze({ id: 'services.Item.marketRepository.getClubItems', container: 'services', target: 'Item.marketRepository', method: 'getClubItems' }),
  Object.freeze({ id: 'services.Item.marketRepository.search', container: 'services', target: 'Item.marketRepository', method: 'search' }),
  Object.freeze({ id: 'services.UTSBCRepository.getClubItems', container: 'services', target: 'sbcRepository', method: 'getClubItems' }),
  Object.freeze({ id: 'window.UTSBCRepository.getClubItems', container: 'window', target: 'sbcRepository', method: 'getClubItems', requireInstance: true }),
  Object.freeze({ id: 'window.UTSBCRepository.getClub', container: 'window', target: 'sbcRepository', method: 'getClub', requireInstance: true }),
  Object.freeze({ id: 'window.UTSBCService.getClubItems', container: 'window', target: 'sbcService', method: 'getClubItems', requireInstance: true }),
  Object.freeze({ id: 'window.UTSBCService.getClub', container: 'window', target: 'sbcService', method: 'getClub', requireInstance: true }),
]);

const isConstructor = (value) => typeof value === 'function';

/**
 * Resolves the container and instance a read or write strategy entry names:
 * for a `window` container the named EA global itself, for a `services`
 * container the instance inside the page's service locator. Shared with
 * `src/ea/squad-writer.js`, which feature-detects write candidates the same way
 * the club reader detects read candidates.
 *
 * A `services` target that is a key of `EA_GLOBALS` resolves to the legacy
 * single-name lookup (`services.UTSBCRepository`). Any other target is read as
 * a dot path of raw EA names inside `services` (`Club.clubDao`), so the
 * instances the #44 shape report proved are reached directly. A strategy
 * marked `requireInstance` refuses a constructor: a window class exposes its
 * instance methods on the prototype and is not an instance to call.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @param {{ container: string, target: string, requireInstance?: boolean }} strategy
 *   a strategy entry
 * @returns {{ ok: boolean, value?: object, name?: string, reason?: string }}
 */
export const resolveStrategyBase = (pageWindow, strategy) => {
  if (strategy.container !== 'services') {
    const name = EA_GLOBALS[strategy.target];
    if (name === undefined) {
      return { ok: false, reason: `unknown EA global key ${JSON.stringify(strategy.target)}` };
    }
    const value = resolveEaGlobal(pageWindow, strategy.target);
    if (value === null) {
      return { ok: false, reason: `page window has no ${name}` };
    }
    if (strategy.requireInstance === true && isConstructor(value)) {
      return {
        ok: false,
        reason:
          `${name} is a constructor, not an instance; window classes expose their methods on` +
          ' the prototype and cannot be read as instances',
      };
    }
    return { ok: true, value, name };
  }

  const services = resolveEaGlobal(pageWindow, 'services');
  if (services === null || typeof services !== 'object') {
    return { ok: false, reason: 'page window has no services object' };
  }
  if (strategy.target === 'services') {
    return { ok: true, value: services, name: EA_GLOBALS.services };
  }
  if (Object.hasOwn(EA_GLOBALS, strategy.target)) {
    const name = EA_GLOBALS[strategy.target];
    const value = services[name];
    if (value === null || value === undefined) {
      return { ok: false, reason: `services has no ${name} instance` };
    }
    if (strategy.requireInstance === true && isConstructor(value)) {
      return { ok: false, reason: `services.${name} is a constructor, not an instance` };
    }
    return { ok: true, value, name };
  }

  const segments = strategy.target.split('.');
  const traversed = [];
  let value = services;
  for (const segment of segments) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
      return { ok: false, reason: `services has no ${traversed.join('.')}` };
    }
    value = value[segment];
    traversed.push(segment);
  }
  if (value === null || value === undefined) {
    return { ok: false, reason: `services has no ${traversed.join('.')}` };
  }
  if (strategy.requireInstance === true && isConstructor(value)) {
    return { ok: false, reason: `services.${strategy.target} is a constructor, not an instance` };
  }
  return { ok: true, value, name: strategy.target };
};

/**
 * The EA methods the #64 observer wraps, in the order it wants them. A wrapper
 * records how each method was called, calls through unchanged and returns the
 * original result; the user's own club browsing therefore answers how EA
 * itself calls its club methods, without this project guessing.
 *
 * The three service entries are the read path #51/#61 reached: the club search,
 * its item DAO fallback and the storage search. The panel entry wraps
 * `initWithSBCSet` so the payload EA hands the SBC detail panel — and thereby
 * the shape that carries the challenge — is recorded by property name and type.
 *
 * `prototype: true` means the holder is the class prototype, not the class
 * itself, because EA calls the hook on an instance.
 */
export const OBSERVED_METHOD_TARGETS = Object.freeze([
  Object.freeze({ id: 'services.Club.search', container: 'services', target: 'Club', method: 'search' }),
  Object.freeze({
    id: 'services.Club.clubDao.getClubItems',
    container: 'services',
    target: 'Club.clubDao',
    method: 'getClubItems',
  }),
  Object.freeze({
    id: 'services.Item.searchStorageItems',
    container: 'services',
    target: 'Item',
    method: 'searchStorageItems',
  }),
  Object.freeze({
    id: `${EA_GLOBALS.squadDetailPanel}.prototype.${EA_PANEL_HOOK.entry}`,
    container: 'window',
    target: 'squadDetailPanel',
    method: EA_PANEL_HOOK.entry,
    prototype: true,
  }),
]);

/**
 * The only criteria fields whose **values** the #64 observer may record. These
 * are request-shaping numbers and enum-like strings, not account-scoped data.
 * Every other argument field contributes its name and type only, and a name on
 * the shared paste-safety list is redacted. A club search criteria object
 * carries identifiers, so the allowlist is deliberately small.
 *
 * #76 added the fields EA's own captured `/club` request carries (`type`,
 * `ovrMin`, `ovrMax`, `sort`, `sortBy`, `searchAltPositions`, `start`,
 * `untradeables`) plus the `_`-prefixed backing names EA's criteria class uses
 * for its public fields (#70), so the observed-criteria diff can report EA's
 * own values (`"player"`, `45`, `true`) next to ours. The values stay
 * request-shaping primitives; no item, player, price or account field is
 * allowlisted.
 */
export const OBSERVED_CRITERIA_VALUE_FIELDS = Object.freeze([
  'count',
  'offset',
  'start',
  'ovrMin',
  'ovrMax',
  'searchAltPositions',
  'sort',
  'sortBy',
  'type',
  'untradeables',
  '_count',
  '_offset',
  '_start',
  '_ovrMin',
  '_ovrMax',
  '_searchAltPositions',
  '_sort',
  '_sortBy',
  '_type',
  '_untradeables',
  '_category',
  '_position',
  '_zone',
  'isExactSearch',
  'preferredPositionOnly',
]);

/**
 * Resolves every `OBSERVED_METHOD_TARGETS` entry to the live holder the
 * observer wraps: the instance behind a `services.<Domain>` path, or the
 * prototype of a named window class. A missing holder keeps its entry with a
 * reason, so the observer report can name what was absent instead of only what
 * was wrapped.
 *
 * Reads only: it resolves property paths and never calls a method or invokes an
 * accessor.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @returns {{ targets: Array<{ id: string, holder: object|null, method: string,
 *   reason?: string }> }}
 */
export function resolveObservationTargets(pageWindow) {
  return {
    targets: OBSERVED_METHOD_TARGETS.map((strategy) => {
      const base = resolveStrategyBase(pageWindow, strategy);
      if (!base.ok) {
        return { id: strategy.id, holder: null, method: strategy.method, reason: base.reason };
      }
      if (strategy.prototype !== true) {
        return { id: strategy.id, holder: base.value, method: strategy.method };
      }
      if (
        typeof base.value !== 'function' ||
        base.value.prototype === null ||
        typeof base.value.prototype !== 'object'
      ) {
        return {
          id: strategy.id,
          holder: null,
          method: strategy.method,
          reason: `${base.name} is not a constructor with a prototype`,
        };
      }
      return { id: strategy.id, holder: base.value.prototype, method: strategy.method };
    }),
  };
}

/**
 * Reads a method off a resolved container without invoking an accessor. The
 * descriptor chain is consulted first at every prototype level, so a live
 * getter is refused with a reason instead of being run inside the player's
 * authenticated session; a data method is returned.
 *
 * @param {object} target the resolved strategy base
 * @param {string} name the method name to read
 * @returns {{ ok: true, value: Function }|{ ok: false, reason: string|null }}
 *   `reason` is null when the property is absent or not a function; otherwise
 *   it names why the value could not be called
 */
const findMethod = (target, name) => {
  let current = target;
  while (current !== null && current !== undefined) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, name);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (descriptor !== undefined) {
      if (typeof descriptor.get === 'function') {
        return { ok: false, reason: 'an accessor(get); refusing to invoke it' };
      }
      return typeof descriptor.value === 'function'
        ? { ok: true, value: descriptor.value }
        : { ok: false, reason: null };
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }
  return { ok: false, reason: null };
};

const describeMissingMethod = (owner, method, reason) =>
  reason === null
    ? `${owner} has no ${method} method`
    : `${owner} exposes ${method} as ${reason}`;

/**
 * The page size and the page cap for a paged club search (#76).
 *
 * The size is EA's own: the captured EA request
 * (`test/fixtures/club-search-request.json`) asks for 91 items, so a
 * whole-club read asks for the same page size EA itself uses. It is still this
 * project's request, not a verified server limit: the search advances by the
 * requested page size, so a clamped or smaller page is still walked correctly,
 * and a server that rejects the size fails the search attempt loudly with its
 * own reason. The cap is the "never loop forever" bound: reaching it is
 * reported as a cap, never as an exhausted club.
 */
export const CLUB_SEARCH_PAGE_SIZE = 91;
export const CLUB_SEARCH_PAGE_CAP = 50;

/**
 * The request-shaping criteria a whole-club search adopts from EA's own
 * captured request body (#76). Every entry is a field EA's own `/club` request
 * carried, with EA's own value: `type` `"player"`, an OVR window of 45–99, the
 * `ovr` descending sort and alternate positions included. Nothing here is
 * invented — `test/fixtures/club-search-request.json` is the capture, and a
 * test pins this table to it field by field.
 */
export const CLUB_SEARCH_WHOLE_CLUB_FIELDS = Object.freeze([
  Object.freeze({ name: 'type', value: 'player' }),
  Object.freeze({ name: 'ovrMin', value: 45 }),
  Object.freeze({ name: 'ovrMax', value: 99 }),
  Object.freeze({ name: 'sortBy', value: 'ovr' }),
  Object.freeze({ name: 'sort', value: 'desc' }),
  Object.freeze({ name: 'searchAltPositions', value: true }),
]);

/**
 * The paging field EA's own captured request carries (#76). The captured
 * request body names `start`, while a known-working third-party implementation
 * drives the same search through `criteria.offset`, so whether EA's criteria
 * object reads `offset` and maps it onto the wire's `start`, or reads `start`
 * directly, cannot be settled from the capture alone. `resolveClubSearchPaging`
 * therefore resolves the name per criteria object and reports this captured
 * field as the fallback with its reason — never a silent guess between the
 * two.
 */
export const CLUB_SEARCH_OBSERVED_PAGE_FIELD = 'start';

/**
 * The paging field names a criteria object may expose, in the order this
 * project resolves them. `offset` is the field a known-working implementation
 * sets on its criteria; `start` is the field EA's own captured request body
 * names.
 */
export const CLUB_SEARCH_PAGING_FIELDS = Object.freeze(['offset', 'start']);

/**
 * The field names this project may set or clear on a club search criteria in
 * any mode, so a criteria object owned by the live page can be snapshotted and
 * put back exactly as it was (#70): the whole-club fields, the page count,
 * both paging candidates and the untradeables filter.
 */
export const CLUB_SEARCH_SET_FIELDS = Object.freeze([
  'type',
  'ovrMin',
  'ovrMax',
  'sortBy',
  'sort',
  'searchAltPositions',
  'count',
  'offset',
  'start',
  'untradeables',
]);

/**
 * The one value EA's `untradeables` criteria field carries when this project
 * asks for untradeables-only. It is a **string**, deliberately: the reference
 * implementation passes `"true"` as text, and EA lower-cases the value itself.
 * The whole-club mode sets no `untradeables` field at all, because EA's own
 * captured request does not carry one (#76); a boolean would silently look
 * right to a careless test and a `"false"` value would be a field EA would not
 * have sent itself.
 */
export const CLUB_SEARCH_UNTRADEABLES_VALUES = Object.freeze({
  ONLY: 'true',
});

/**
 * True when a property descriptor with this name exists anywhere along the
 * object's prototype chain. Accessors count as present and are never invoked.
 */
const hasProperty = (target, name) => {
  let current = target;
  while (current !== null && current !== undefined) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, name);
    } catch {
      return false;
    }
    if (descriptor !== undefined) return true;
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return false;
    }
  }
  return false;
};

const hasOwnPropertyDescriptor = (target, name) => {
  try {
    return Object.getOwnPropertyDescriptor(target, name) !== undefined;
  } catch {
    return false;
  }
};

/**
 * Resolves which paging field the criteria object itself exposes, by reading
 * property descriptors along the prototype chain and never invoking an
 * accessor. A criteria class stores its public fields on the prototype backed
 * by own `_`-prefixed fields (#70), so an own `_offset` or `_start` counts as
 * the public field being present.
 *
 * The answer is the observation: exactly one candidate present means that is
 * the field EA's consumer reads, and it is used with `source: 'criteria'`.
 * When none is present, the field EA's own captured request carries is used
 * and `source: 'capture'` says so. When both are present the captured field is
 * used and `present` plus the reason record the ambiguity, so a live log can
 * settle it rather than a silent choice.
 *
 * @param {object} criteria the criteria object EA will be handed
 * @returns {{ field: string, source: 'criteria'|'capture',
 *   present: Array<string>, reason: string|null }}
 */
export const resolveClubSearchPaging = (criteria) => {
  const present = CLUB_SEARCH_PAGING_FIELDS.filter(
    (field) => hasProperty(criteria, field) || hasOwnPropertyDescriptor(criteria, `_${field}`)
  );
  if (present.length === 1) {
    return { field: present[0], source: 'criteria', present, reason: null };
  }
  const reason =
    present.length === 0
      ? `the criteria exposes neither ${CLUB_SEARCH_PAGING_FIELDS.join(' nor ')}; using the field` +
        ` EA's own captured /club request carries (${CLUB_SEARCH_OBSERVED_PAGE_FIELD})`
      : `the criteria exposes both ${present.join(' and ')}; using the captured field` +
        ` ${CLUB_SEARCH_OBSERVED_PAGE_FIELD} and reporting the ambiguity`;
  return {
    field: CLUB_SEARCH_OBSERVED_PAGE_FIELD,
    source: 'capture',
    present,
    reason,
  };
};

/**
 * The club DAO method that clears EA's cached club statistics before a search.
 * The reference implementation calls it before searching. Our shape reports
 * proved the `services.Club.clubDao` path exists but never proved this method
 * is on it, so absence is normal and reported, never an error. A reset that
 * throws is reported too: a stats-cache failure must not lose the club read.
 */
const CLUB_STATS_CACHE_TARGET = Object.freeze({
  container: 'services',
  target: 'Club.clubDao',
  method: 'resetStatsCache',
});

const resetClubStatsCache = (pageWindow) => {
  const base = resolveStrategyBase(pageWindow, CLUB_STATS_CACHE_TARGET);
  if (!base.ok) return 'absent';
  const found = findMethod(base.value, CLUB_STATS_CACHE_TARGET.method);
  if (!found.ok) return 'absent';
  try {
    found.value.call(base.value);
    return 'reset';
  } catch (error) {
    return `threw: ${describeCause(error)}`;
  }
};

/**
 * Sets one whole-club search page's fields on the criteria object itself: the
 * request-shaping fields EA's own captured request carries (#76), the page
 * count EA asks for, the resolved paging field, and — only when asked for —
 * the untradeables filter. The object is never copied: EA's criteria are a
 * class instance whose public fields live on the prototype, and a spread copy
 * keeps only the own backing fields, so EA's own search threw reading
 * `.toLowerCase()` off a field the copy no longer carried (`fsl-build/8`,
 * #70). The fields go on exactly the object handed to EA, and the walk
 * restores them afterwards when the object belongs to the live page.
 *
 * The whole-club mode clears the `untradeables` own field and its `_` backing
 * instead of setting one, so a criteria carried over from the player's own
 * browsing cannot filter the read: EA's own request sends no such field. A
 * live page's object is snapshotted and restored around the walk (#70).
 *
 * Returns what was set, in application order, so the diagnostic names the
 * criteria that were actually handed over.
 *
 * @param {object} criteria the criteria object EA will be handed
 * @param {{ offset: number, onlyUntradeables?: boolean, pagingField: string }} page
 * @returns {Array<{ name: string, type: string, value: * }>}
 */
const applyClubSearchPage = (criteria, { offset, onlyUntradeables, pagingField }) => {
  const fields = [];
  const set = (name, value) => {
    criteria[name] = value;
    fields.push({ name, type: typeof criteria[name], value: criteria[name] });
  };
  for (const field of CLUB_SEARCH_WHOLE_CLUB_FIELDS) set(field.name, field.value);
  set('count', CLUB_SEARCH_PAGE_SIZE);
  // `offset` is the paging field EA's own live criteria carries (`fsl-build/13`
  // observed `offset: 0` on the club UI's `searchCriteria`), so it is set on
  // every page. When the criteria object first answers on the other candidate
  // field, that field advances too, so a consumer reading either name pages
  // correctly; the observed field is never dropped.
  set('offset', offset);
  if (pagingField !== 'offset') set(pagingField, offset);
  if (onlyUntradeables === true) {
    set('untradeables', CLUB_SEARCH_UNTRADEABLES_VALUES.ONLY);
  } else {
    delete criteria.untradeables;
    delete criteria._untradeables;
  }
  return fields;
};

/**
 * Records the own state of every field `applyClubSearchPage` sets, so a
 * criteria object owned by the live page can be put back exactly as it was. A
 * field that was absent must end up absent again, not set to `undefined`: the
 * live search must not keep this project's page size or offset.
 *
 * The class pattern EA uses exposes a public field as an accessor backed by an
 * own `_`-prefixed field (the #70 log listed `_untradeables`), so a backing
 * field is snapshotted too; a value set through the accessor is then restored
 * even though the public property has no own descriptor.
 */
const BACKING_FIELD_PREFIX = '_';

const snapshotSetFields = (criteria) => {
  const names = CLUB_SEARCH_SET_FIELDS.flatMap((name) => [
    name,
    `${BACKING_FIELD_PREFIX}${name}`,
  ]);
  return names.map((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(criteria, name);
    return { name, present: descriptor !== undefined, value: descriptor?.value };
  });
};

const restoreSetFields = (criteria, snapshot) => {
  for (const { name, present, value } of snapshot) {
    if (present) criteria[name] = value;
    else delete criteria[name];
  }
};

const renderSetField = (field) => `${field.name}: ${field.type}`;

/** The view model property that carries the club search criteria. */
const SEARCH_CRITERIA_PROPERTY = 'searchCriteria';

/**
 * How the search criteria are looked for, in order (#61). The instance probe is
 * primary: when the global is a class this project constructs **its own**
 * instance and reads `searchCriteria` from that, so EA's live club-UI criteria
 * are never mutated (#70); when the global is already a live instance its
 * criteria are used instead and restored after the read. The prototype probe
 * stays as a reported fallback, so a page that only carries the field on the
 * prototype still has a path; the diagnostic names which source answered and
 * whether this project created the instance (`owned`).
 */
export const CLUB_SEARCH_CRITERIA_STRATEGIES = Object.freeze([
  Object.freeze({ id: `${EA_GLOBALS.searchViewModel}.searchCriteria`, source: 'instance' }),
  Object.freeze({ id: `${EA_GLOBALS.searchViewModel}.prototype.searchCriteria`, source: 'prototype' }),
]);

const describeAttempts = (attempts) =>
  attempts.length === 0
    ? 'no candidate was tried'
    : attempts.map((attempt) => `${attempt.id}: ${attempt.reason}`).join('; ');

/**
 * Reads a data property along an object's prototype chain without ever
 * invoking an accessor. `{ ok: false, reason: null }` means absent or not a
 * value; a present accessor is refused with a reason, because running a live
 * getter inside the player's authenticated session is a side effect the read
 * layer must not have.
 */
const readDataProperty = (target, name) => {
  let current = target;
  while (current !== null && current !== undefined) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(current, name);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
    if (descriptor !== undefined) {
      if (typeof descriptor.get === 'function') {
        return { ok: false, reason: 'an accessor(get); refusing to invoke it' };
      }
      return descriptor.value === undefined
        ? { ok: false, reason: null }
        : { ok: true, value: descriptor.value };
    }
    try {
      current = Object.getPrototypeOf(current);
    } catch {
      return { ok: false, reason: 'unreadable' };
    }
  }
  return { ok: false, reason: null };
};

const isRecordObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Renders one typed key entry the way the live reason strings print it: a
 * string carries whether it is empty, every other type stands alone. Values are
 * never rendered; only the name (already redacted) and the type are.
 */
const renderCriteriaEntry = (entry) =>
  entry.type === 'string'
    ? `${entry.name}: string(${entry.empty ? 'empty' : 'non-empty'})`
    : `${entry.name}: ${entry.type}`;

const describeCriteriaKeys = (shape) =>
  shape === null || shape === undefined || shape.keys.length === 0
    ? 'no own enumerable keys'
    : shape.keys.map(renderCriteriaEntry).join(', ');

/**
 * Reports the criteria object's own enumerable keys by name and type — never by
 * value — plus the keys that are `undefined`, `null` or an empty string, and
 * where the object came from. `own` is false when the value was inherited along
 * the instance's prototype chain, which keeps prototype defaults visible even
 * when the instance probe answered.
 *
 * A criteria object is `usable` when at least one own enumerable value is
 * actually set: a descriptor getter is never invoked to find out, and an
 * `undefined`, `null`, accessor or unreadable entry never counts. An object
 * with nothing set is half-built — it cannot be a real EA search — so it is
 * refused instead of being handed to EA (#61).
 */
const describeCriteriaShape = (criteria, source, target) => {
  const keys = describeOwnPropertyTypes(criteria);
  const namesOfType = (type) =>
    keys.filter((entry) => entry.type === type).map((entry) => entry.name);
  const isSet = (entry) =>
    entry.type !== 'undefined' &&
    entry.type !== 'null' &&
    entry.type !== 'accessor(get)' &&
    entry.type !== 'unreadable';
  let own = false;
  try {
    own = Object.hasOwn(target, SEARCH_CRITERIA_PROPERTY);
  } catch {
    own = false;
  }
  return {
    source,
    prototype: source === 'prototype',
    own,
    usable: keys.some(isSet),
    keys,
    undefinedKeys: namesOfType('undefined'),
    nullKeys: namesOfType('null'),
    emptyStringKeys: keys
      .filter((entry) => entry.type === 'string' && entry.empty === true)
      .map((entry) => entry.name),
  };
};

const tryReadCriteria = (target, attempt, source) => {
  const read = readDataProperty(target, SEARCH_CRITERIA_PROPERTY);
  if (!read.ok) {
    attempt.reason =
      read.reason === null
        ? `has no ${SEARCH_CRITERIA_PROPERTY} property`
        : `exposes ${SEARCH_CRITERIA_PROPERTY} as ${read.reason}`;
    return null;
  }
  if (!isRecordObject(read.value)) {
    attempt.reason = `${SEARCH_CRITERIA_PROPERTY} is ${describeValue(read.value)}, not an object`;
    return null;
  }
  const shape = describeCriteriaShape(read.value, source, target);
  attempt.source = source;
  attempt.shape = shape;
  if (!shape.usable) {
    attempt.reason =
      `${SEARCH_CRITERIA_PROPERTY} is not usable: none of its own enumerable values is set` +
      ` (${describeCriteriaKeys(shape)})`;
    return null;
  }
  attempt.ok = true;
  return read.value;
};

/**
 * Resolves EA's search view model to an instance: the global itself when it is
 * already an instance, or a no-argument construction when it is a class. An
 * unknown argument list is never invented, and a class that refuses
 * construction is a named reason rather than a thrown solve. `constructed`
 * records whether this call ran a constructor in the player's session, so the
 * criteria report can name what was invoked (#61).
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @returns {{ ok: boolean, value?: object, name?: string,
 *   constructed?: boolean, reason?: string }}
 */
const resolveSearchViewModelInstance = (pageWindow) => {
  const name = EA_GLOBALS.searchViewModel;
  const global = resolveEaGlobal(pageWindow, 'searchViewModel');
  if (global === null) return { ok: false, reason: `page window has no ${name}` };
  if (typeof global === 'function') {
    try {
      return { ok: true, value: new global(), name: `${name} instance`, constructed: true };
    } catch (error) {
      return { ok: false, reason: `new ${name}() threw: ${describeCause(error)}` };
    }
  }
  if (typeof global === 'object') {
    return { ok: true, value: global, name, constructed: false };
  }
  return { ok: false, reason: `${name} is ${typeof global}, not a class or an instance` };
};

/**
 * Reads the club search criteria off EA's search view model, instance first and
 * prototype as a reported fallback, recording every probe as
 * `{ id, ok, reason, source, constructed?, shape? }`.
 *
 * The shape report names every own enumerable key with its type and explicitly
 * marks the keys that are `undefined` or `null` and the strings that are empty,
 * so a live report shows what EA was handed without ever printing a value. A
 * criteria object with no own enumerable value set is refused as not usable
 * rather than passed to EA as a half-built search (#61).
 *
 * An absent global, a class that refuses construction without arguments, an
 * accessor property, a non-object value and unusable criteria are each a named
 * reason, never a guessed criteria object.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @returns {{ ok: boolean, criteria: object|null, strategy: string|null,
 *   source: 'instance'|'prototype'|null, owned: boolean, shape: object|null,
 *   attempts: Array<{id: string, ok: boolean, reason: string|null,
 *   source?: string, constructed?: boolean, shape?: object}> }}
 */
export const readSearchCriteria = (pageWindow) => {
  const attempts = [];
  const globalName = EA_GLOBALS.searchViewModel;
  const global = resolveEaGlobal(pageWindow, 'searchViewModel');
  const missingGlobal = `page window has no ${globalName}`;

  for (const strategy of CLUB_SEARCH_CRITERIA_STRATEGIES) {
    const attempt = { id: strategy.id, ok: false, reason: null };
    attempts.push(attempt);

    if (global === null) {
      attempt.reason = missingGlobal;
      continue;
    }

    let target;
    if (strategy.source === 'instance') {
      const instance = resolveSearchViewModelInstance(pageWindow);
      if (!instance.ok) {
        attempt.reason = instance.reason;
        continue;
      }
      attempt.constructed = instance.constructed === true;
      target = instance.value;
    } else {
      target = typeof global === 'function' ? global.prototype : Object.getPrototypeOf(global);
      if (target === null || target === undefined) {
        attempt.reason = `${globalName} has no prototype to read`;
        continue;
      }
    }

    const criteria = tryReadCriteria(target, attempt, strategy.source);
    if (criteria !== null) {
      return {
        ok: true,
        criteria,
        strategy: attempt.id,
        source: strategy.source,
        // `owned` is true only when the criteria live in an instance this call
        // constructed itself; the live page's own criteria must be restored
        // after a read (#70).
        owned: attempt.constructed === true,
        shape: attempt.shape,
        attempts,
      };
    }
  }

  return {
    ok: false,
    criteria: null,
    strategy: null,
    source: null,
    owned: false,
    shape: null,
    attempts,
  };
};

const summarizeCriteria = (resolution, applied = null) =>
  resolution === null
    ? null
    : {
        ok: resolution.ok,
        strategy: resolution.strategy,
        source: resolution.source ?? null,
        owned: resolution.owned === true,
        shape: resolution.shape ?? null,
        attempts: resolution.attempts,
        ...(applied ?? {}),
      };

/**
 * Calls one resolved method and normalises whatever convention it answered
 * with: an observable goes through the bridge, a promise is awaited under the
 * same timeout, and a plain value is carried as-is. Every path produces the
 * same `{ data, error, response, status, success, payload, via }` shape, so an
 * attempt can record which convention answered.
 */
const resolveReadReturn = async (returned, label, timeoutMs) => {
  if (isObservable(returned)) {
    const event = await observeOnce(returned, { timeoutMs, label });
    return { ...event, via: 'observable' };
  }
  if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
    const value = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${label} did not resolve within ${timeoutMs}ms`)),
        timeoutMs
      );
      returned.then(
        (resolved) => {
          clearTimeout(timer);
          resolve(resolved);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
    return {
      data: value,
      error: null,
      response: value,
      status: null,
      success: null,
      payload: value,
      via: 'promise',
    };
  }
  return {
    data: returned,
    error: null,
    response: returned,
    status: null,
    success: null,
    payload: returned,
    via: 'value',
  };
};

const describeEventError = (event) =>
  event.error !== null && event.error !== undefined
    ? `the observable reported an error: ${
        typeof event.error === 'object' && typeof event.error.message === 'string'
          ? event.error.message
          : String(event.error)
      }`
    : null;

/**
 * Calls one resolved method and normalises its answer. A reported event error
 * becomes a named failure, so the pacer's retry policy sees the same `status`
 * and message a reader would.
 *
 * The two wait systems compose: the pacer owns the gap and backoff *before* a
 * call starts, while `observeOnce` keeps owning the subscription's own timeout
 * afterwards. A cancel rejects a pending paced wait and never clears the
 * subscription's timer, so an in-flight observable still unsubscribes cleanly.
 */
const callMethodOnce = async (found, base, callArguments, label, timeoutMs) => {
  let returned;
  try {
    returned = await found.value.apply(base, callArguments);
  } catch (error) {
    throw methodThrew(error);
  }
  const resolved = await resolveReadReturn(returned, label, timeoutMs);
  const eventError = describeEventError(resolved);
  if (eventError !== null) throw callFailure(eventError, resolved.status);
  return resolved;
};

/**
 * Calls one resolved method through the paced queue, so a retryable failure is
 * retried under the pacer's policy.
 */
const callReadMethod = async (found, base, callArguments, label, timeoutMs, pacing) => {
  try {
    const event = await pacing.pacer.run(
      label,
      () => callMethodOnce(found, base, callArguments, label, timeoutMs),
      { kind: pacing.kind }
    );
    return { ok: true, event };
  } catch (error) {
    return {
      ok: false,
      reason: failureReason(error),
      // The HTTP status the observable reported, kept beside the reason so a
      // caller can label EA's refusal (#74): a status 426 is EA saying no, not
      // an opaque throw, and the status is a number, never personal data.
      status: Number.isFinite(error?.status) ? error.status : null,
    };
  }
};

const clubItemsOf = (payload) =>
  Array.isArray(payload) ? payload : payload[CLUB_ITEM_ARRAY_FIELD];

/**
 * True when a club page says the walk is finished. `endOfList` decides when it
 * is present, otherwise `retrievedAll` does; a page carrying neither keeps the
 * walk going. The flags are read from the payload object, never from a bare
 * item array.
 */
const isClubEndOfList = (payload) => {
  if (!isRecordObject(payload)) return false;
  for (const field of CLUB_ITEM_END_OF_LIST_FIELDS) {
    if (field in payload) return payload[field] === true;
  }
  return false;
};

/**
 * Names what a club page carried when it is not the expected `items` envelope:
 * the payload's own keys plus any known alternative field name it carries, so
 * the live log shows what EA returned instead of only that the read failed
 * (#72). No value is read.
 */
const describeClubPayload = (payload) => {
  const described = describeValue(payload);
  if (!isRecordObject(payload)) return described;
  const carried = CLUB_ITEM_ARRAY_ALTERNATIVES.filter((field) => Array.isArray(payload[field]));
  return carried.length === 0
    ? described
    : `${described}; it carries ${carried.join(', ')}, which this build does not read`;
};

const describeCriteriaSource = (resolution) =>
  resolution.source === null || resolution.source === undefined
    ? resolution.strategy
    : `${resolution.strategy} (${resolution.source})`;

/**
 * Names what one page call was handed: the criteria strategy that produced the
 * object, the page count and the resolved paging field with their values, the
 * fields this project set with their types, and every criteria key by name and
 * type. Only request-shaping numbers, enum-like strings and booleans appear as
 * values; every other criteria value stays out of the report (#61, #65, #76).
 */
const describeCalledWith = (resolution, pageCriteria, setFields, pagingField) =>
  `called with criteria from ${describeCriteriaSource(resolution)}:` +
  ` count=${pageCriteria.count}, ${pagingField}=${pageCriteria[pagingField]},` +
  ` set [${setFields.map(renderSetField).join(', ')}],` +
  ` keys [${describeCriteriaKeys(resolution.shape)}]`;

/**
 * The reason for one failed search page. A throw from EA's own method is
 * labelled as that — "EA threw while calling this method with our criteria" —
 * and names the criteria strategy alongside, so it cannot be read as a missing
 * method. Every other failure (an observable that timed out, an exhausted
 * attempt budget, a pacer abort) keeps its own message and gains the
 * called-with report.
 */
const describeSearchCallFailure = (error, resolution, pageCriteria, setFields, pagingField) => {
  const calledWith = describeCalledWith(resolution, pageCriteria, setFields, pagingField);
  return error?.name === EA_METHOD_THREW_NAME
    ? `EA threw while calling this method with our criteria (${calledWith}): ${describeCause(error)}`
    : `${describeCause(error)}; ${calledWith}`;
};

/**
 * Subscribes to one page of a club search per offset until a page yields no
 * items, then reports how many pages ran and whether the cap, not exhaustion,
 * stopped the walk. Every page is one paced call. The fields this project sets
 * go on the criteria object itself (#70); a criteria object owned by the live
 * page is put back exactly as it was in a `finally`, so success, a failed page
 * and a timeout all restore it. EA's club stats cache is reset first when the
 * page provides `resetStatsCache`; absence and a throwing reset are reported,
 * never fatal.
 *
 * A failed page throws with `describeSearchCallFailure`'s report, so the
 * attempt reason distinguishes an EA-side throw from a missing method and
 * carries the criteria fields and shape the page was called with (#61, #65).
 */
const runPagedSearch = async ({
  pageWindow,
  base,
  found,
  resolution,
  strategy,
  timeoutMs,
  pacer,
  onlyUntradeables,
}) => {
  const criteria = resolution.criteria;
  const snapshot = resolution.owned === true ? null : snapshotSetFields(criteria);
  const statsCache = resetClubStatsCache(pageWindow);
  // The paging field is resolved once, from the criteria object itself, with
  // the captured EA field as the reported fallback (#76). Every page sets the
  // same resolved field.
  const paging = resolveClubSearchPaging(criteria);
  const items = [];
  const pageItemCounts = [];
  let offset = 0;
  let pages = 0;
  let setFields = [];
  try {
    while (pages < CLUB_SEARCH_PAGE_CAP) {
      pages += 1;
      const pageFields = applyClubSearchPage(criteria, {
        offset,
        onlyUntradeables,
        pagingField: paging.field,
      });
      // The first page's fields name the criteria handed over; later pages
      // only move the paging value, so the diagnostic reports the template.
      if (pages === 1) setFields = pageFields;
      const label = `${strategy.id} page ${pages}`;
      let event;
      try {
        event = await pacer.run(
          label,
          () => callMethodOnce(found, base, [criteria], label, timeoutMs),
          { kind: CALL_KINDS.CLUB_PAGE }
        );
      } catch (error) {
        throw new Error(
          describeSearchCallFailure(error, resolution, criteria, pageFields, paging.field)
        );
      }
      if (!isClubPayload(event.payload)) {
        throw new Error(
          `page ${pages} returned no ${CLUB_ITEM_ARRAY_FIELD} array (got ${describeClubPayload(
            event.payload
          )})`
        );
      }
      const pageItems = clubItemsOf(event.payload);
      pageItemCounts.push(pageItems.length);
      items.push(...pageItems);
      // A page that returns nothing ends the walk, whatever its end-of-list
      // flag says: there is no next item to ask for.
      if (pageItems.length === 0) {
        return {
          items,
          pages,
          pageItems: pageItemCounts,
          capped: false,
          capReason: null,
          endOfList: false,
          setFields,
          paging,
          statsCache,
        };
      }
      if (isClubEndOfList(event.payload)) {
        return {
          items,
          pages,
          pageItems: pageItemCounts,
          capped: false,
          capReason: null,
          endOfList: true,
          setFields,
          paging,
          statsCache,
        };
      }
      // The offset advances by the page size this project asked EA for, never
      // by how many items the page happened to yield: EA may clamp or trim a
      // page, and the live `fsl-build/9` payloads carried their own
      // `retrievedAll`/`endOfList` flag instead of implying the end.
      offset += CLUB_SEARCH_PAGE_SIZE;
    }
    return {
      items,
      pages,
      pageItems: pageItemCounts,
      capped: true,
      capReason:
        `the page cap of ${CLUB_SEARCH_PAGE_CAP} was reached before the search stopped yielding` +
        ` items; the club may be larger than the ${pages} pages read`,
      endOfList: false,
      setFields,
      paging,
      statsCache,
    };
  } finally {
    // A live page's criteria must not keep this project's page size or offset
    // after the walk, whatever ended it (#70). Criteria this project
    // constructed are ours and stay as the read left them.
    if (snapshot !== null) restoreSetFields(criteria, snapshot);
  }
};

/**
 * Tries every club-read strategy in order and returns the first payload that
 * looks like club items.
 *
 * The first two entries are the #51 search path: the criteria are read once
 * from EA's search view model, the whole-club fields EA's own captured request
 * carries and the page count are set on that same object, the paging field is
 * resolved from the criteria itself (#76), and the subscription is walked page
 * by page. The object is never copied (#70): its public fields live on the
 * prototype. Criteria this project constructed are kept; criteria owned by the
 * live page are restored after the walk, on success, a failed page and a
 * timeout alike. Every subsequent entry is the recorded map of earlier
 * attempts, each called through the same bridge.
 *
 * The result carries the winning strategy id and an attempt record for every
 * candidate tried, in order: `{ id, ok, reason }`, plus `method` — the
 * resolved method's `{arity, constructor, excerpt, truncated}` shape — whenever
 * the strategy reached a callable method, including one that then threw. The
 * pagination report carries `pages`, `capped` and `capReason`; the criteria
 * report carries the view-model probes, the producing strategy, whether it came
 * from an instance or the prototype, whether this project created that instance
 * (`owned`), the criteria' key names and types — never a value — and the names
 * and types of the fields this project sets on the criteria it hands EA (#61,
 * #65, #70). A criteria object with nothing set is refused before EA is called,
 * and a search page's failure reason distinguishes EA throwing on our criteria
 * from the method being missing.
 *
 * When nothing succeeds, `items` is an empty array — never a guessed count —
 * and every attempt's reason names what was missing or wrong.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @param {{ observableTimeoutMs?: number, pacer?: object,
 *   onlyUntradeables?: boolean }} [options]
 *   `observableTimeoutMs` is injectable so tests need not wait out the default;
 *   `pacer` is the queue every EA call runs through, defaulting to the shared
 *   paced queue (#52); `onlyUntradeables` asks EA for untradeables-only
 *   (`"true"`); the whole-club mode sends no `untradeables` field at all,
 *   because EA's own captured request carries none (#76)
 * @returns {Promise<{ ok: boolean, items: Array<object>, strategy: string|null,
 *   attempts: Array<{id: string, ok: boolean, reason: string|null,
 *   method?: object}>, pages: number, pageItems: Array<number>, capped: boolean,
 *   capReason: string|null, paging: object|null, criteria: object|null }>}
 *   `pageItems` is the item count of every page the walk read, in order, so a
 *   rejected item can be located in its page (#74); `paging` names the field
 *   the criteria exposed and the source it was resolved from (#76)
 */
export async function resolveClubItems(pageWindow, options = {}) {
  const timeoutMs = resolveTimeoutMs(options.observableTimeoutMs);
  const pacer = resolvePacer(options);
  const onlyUntradeables = options.onlyUntradeables === true;
  const attempts = [];
  let criteriaResolution = null;
  const resolveCriteriaOnce = () => {
    if (criteriaResolution === null) criteriaResolution = readSearchCriteria(pageWindow);
    return criteriaResolution;
  };

  for (const strategy of CLUB_ITEM_STRATEGIES) {
    const attempt = { id: strategy.id, ok: false, reason: null };
    attempts.push(attempt);
    const base = resolveStrategyBase(pageWindow, strategy);
    if (!base.ok) {
      attempt.reason = base.reason;
      continue;
    }
    const found = findMethod(base.value, strategy.method);
    if (!found.ok) {
      attempt.reason = describeMissingMethod(base.name, strategy.method, found.reason);
      continue;
    }
    attempt.method = describeMethodShape(found.value);

    if (strategy.searchCriteria === true) {
      const resolution = resolveCriteriaOnce();
      if (!resolution.ok) {
        attempt.reason = `the search criteria could not be read; tried ${describeAttempts(
          resolution.attempts
        )}`;
        continue;
      }
      try {
        const search = await runPagedSearch({
          pageWindow,
          base: base.value,
          found,
          resolution,
          strategy,
          timeoutMs,
          pacer,
          onlyUntradeables,
        });
        attempt.ok = true;
        return {
          ok: true,
          items: search.items,
          strategy: strategy.id,
          attempts,
          pages: search.pages,
          pageItems: search.pageItems,
          capped: search.capped,
          capReason: search.capReason,
          field: CLUB_ITEM_ARRAY_FIELD,
          endOfList: search.endOfList,
          paging: search.paging,
          criteria: summarizeCriteria(resolution, {
            setFields: search.setFields,
            paging: search.paging,
            statsCache: search.statsCache,
          }),
        };
      } catch (error) {
        attempt.reason = describeCause(error);
        continue;
      }
    }

    const callArguments = Object.hasOwn(strategy, 'argument') ? [strategy.argument] : [];
    const call = await callReadMethod(found, base.value, callArguments, strategy.id, timeoutMs, {
      pacer,
      kind: CALL_KINDS.CLUB_PAGE,
    });
    if (!call.ok) {
      attempt.reason = call.reason;
      continue;
    }
    const event = call.event;
    if (!isClubPayload(event.payload)) {
      attempt.reason = `returned no ${CLUB_ITEM_ARRAY_FIELD} array (got ${describeClubPayload(
        event.payload
      )})`;
      continue;
    }
    attempt.ok = true;
    const items = clubItemsOf(event.payload);
    return {
      ok: true,
      items,
      strategy: strategy.id,
      attempts,
      pages: 1,
      pageItems: [items.length],
      capped: false,
      capReason: null,
      field: CLUB_ITEM_ARRAY_FIELD,
      endOfList: isClubEndOfList(event.payload),
      criteria: summarizeCriteria(criteriaResolution),
    };
  }
  return {
    ok: false,
    items: [],
    strategy: null,
    attempts,
    pages: 0,
    pageItems: [],
    capped: false,
    capReason: null,
    field: null,
    endOfList: false,
    criteria: summarizeCriteria(criteriaResolution),
  };
}

/** The observer method id whose criteria the #76 diff compares. */
const OBSERVED_CLUB_SEARCH_METHOD_ID = 'services.Club.search';

/** The paging names the #76 diff recognises on an observed call. */
const DIFF_PAGING_FIELDS = Object.freeze(['offset', 'start']);

const isPrimitiveCriteriaValue = (value) =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

/**
 * Normalises one observed field name to the public criteria name it backs: an
 * own `_count` is how EA's criteria class stores the public `count` (#70).
 * Redacted names and the bare backing prefix carry no name and are dropped.
 * An observed name outside the observer's value allowlist still contributes a
 * name (and a type), never a value.
 */
const normalizeCriteriaFieldName = (name) => {
  if (typeof name !== 'string') return null;
  const stripped = name.startsWith('_') ? name.slice(1) : name;
  return stripped.length === 0 || stripped === '<redacted>' ? null : stripped;
};

/**
 * Finds the most recent observed call of EA's own club search: a
 * `services.Club.search` call the observer attributed to EA (#64) whose first
 * argument is a criteria object. Later calls win because a later page of EA's
 * own walk carries the most recent state.
 */
const findObservedClubSearchCall = (report) => {
  const calls = Array.isArray(report?.calls) ? report.calls : [];
  let found = null;
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    if (call?.method !== OBSERVED_CLUB_SEARCH_METHOD_ID) continue;
    if (call.origin !== 'ea') continue;
    if (call.args?.[0]?.type !== 'object') continue;
    found = { callIndex: index, call };
  }
  return found;
};

/**
 * Reads the field names, types and allowlisted primitive values off one
 * observed criteria argument, keyed by the public field name. Values are only
 * taken for names the observer's own allowlist permits, so a malformed or
 * tampered report cannot smuggle a non-allowlisted value through the diff.
 * Keys contribute names and types only; the values object contributes the
 * primitives the observer was allowed to record.
 */
const observedCriteriaFields = (argument) => {
  const fields = new Map();
  const values = isRecordObject(argument.values) ? argument.values : {};
  const allowlist = new Set(OBSERVED_CRITERIA_VALUE_FIELDS);
  const record = (rawName, name, value) => {
    if (!allowlist.has(rawName) || !isPrimitiveCriteriaValue(value) || value === undefined) return;
    const entry = fields.get(name) ?? {};
    entry.value = value;
    if (entry.type === undefined) entry.type = typeof value;
    fields.set(name, entry);
  };
  for (const key of Array.isArray(argument.keys) ? argument.keys : []) {
    const name = normalizeCriteriaFieldName(key?.name);
    if (name === null) continue;
    const entry = fields.get(name) ?? {};
    if (typeof key.type === 'string') entry.type = key.type;
    fields.set(name, entry);
    if (typeof key.name === 'string' && Object.hasOwn(values, key.name)) {
      record(key.name, name, values[key.name]);
    }
  }
  for (const [rawName, value] of Object.entries(values)) {
    const name = normalizeCriteriaFieldName(rawName);
    if (name === null) continue;
    record(rawName, name, value);
  }
  return fields;
};

/**
 * The comparison verdict for one criteria field: `ours-only` when this build
 * handed over a field EA's own call did not show, `observed-only` when EA
 * showed one this build did not hand over, `uncompared` when the observation
 * carried no allowlisted value to compare, and otherwise `same` or `different`
 * by value.
 */
const criteriaFieldStatus = (observed, our, hasObservedValue) => {
  if (our === undefined) return 'observed-only';
  if (observed === undefined) return 'ours-only';
  if (!hasObservedValue) return 'uncompared';
  return observed.value === our ? 'same' : 'different';
};

/**
 * The field-by-field diff between how EA's own UI called
 * `services.Club.search` in this session and the criteria fields this project
 * handed over (#76). It reports, per public field name, EA's observed type and
 * allowlisted primitive value next to ours, a `status` (`same`, `different`,
 * `uncompared`, `ours-only`, `observed-only`), and a dedicated `paging` verdict
 * naming the field EA carried for paging and the field this build used. The
 * report carries field names and request-shaping primitives only — never an
 * item, a player, a price or an account identifier.
 *
 * The observer's captures are content-controlled by construction (see
 * `OBSERVED_CRITERIA_VALUE_FIELDS`), and this function re-applies that same
 * allowlist, so a report built from anything else still cannot carry a value
 * outside it. A session in which EA's own club search never ran has no
 * observed side: `observed` is null and `note` names the screen to open so the
 * next Solve has the measurement.
 *
 * @param {{ calls: Array<object> }|null} observerReport the `#64` observer
 *   report carried by the diagnostics
 * @param {Array<{ name: string, value: * }>} [ourFields] the criteria fields
 *   this build handed over, from the club stage's `setFields`
 * @returns {{ observed: { callIndex: number }|null,
 *   ours: Array<{ name: string, value: * }>,
 *   fields: Array<{ name: string,
 *     observed: { present: boolean, type?: string, value?: * },
 *     ours: { value: * }|null,
 *     status: 'same'|'different'|'uncompared'|'ours-only'|'observed-only' }>,
 *   paging: { observedField: string|null, ourField: string|null, same: boolean },
 *   note: string|null }}
 */
export function diffClubSearchCriteria(observerReport, ourFields = []) {
  const found = findObservedClubSearchCall(observerReport);
  const observedFields = found === null ? new Map() : observedCriteriaFields(found.call.args[0]);
  const ours = (Array.isArray(ourFields) ? ourFields : [])
    .filter((entry) => typeof entry?.name === 'string' && entry.name.length > 0)
    .map((entry) => ({ name: entry.name, value: entry.value }));

  const fields = [];
  const pushed = new Set();
  const push = (name, observed, our) => {
    pushed.add(name);
    const hasObservedValue = observed !== undefined && Object.hasOwn(observed, 'value');
    fields.push({
      name,
      observed:
        observed === undefined
          ? { present: false }
          : {
              present: true,
              ...(observed.type === undefined ? {} : { type: observed.type }),
              ...(hasObservedValue ? { value: observed.value } : {}),
            },
      ours: our === undefined ? null : { value: our },
      status: criteriaFieldStatus(observed, our, hasObservedValue),
    });
  };
  for (const entry of ours) push(entry.name, observedFields.get(entry.name), entry.value);
  for (const [name, observed] of observedFields) {
    if (!pushed.has(name)) push(name, observed, undefined);
  }

  const observedPaging = DIFF_PAGING_FIELDS.filter((name) => observedFields.has(name));
  const ourPaging = DIFF_PAGING_FIELDS.filter((name) => ours.some((entry) => entry.name === name));
  const observedField = observedPaging.length === 1 ? observedPaging[0] : null;
  const ourField = ourPaging.length === 1 ? ourPaging[0] : null;
  const paging = { observedField, ourField, same: observedField !== null && observedField === ourField };

  let note = null;
  if (found === null) {
    note =
      "EA's own services.Club.search was not observed in this session, so there is no observed" +
      ' criteria to compare against; open the Club screen and let its player list load once' +
      ' before pressing Solve, so the next diagnostic carries EA\u2019s own criteria.';
  } else if (observedPaging.length === 0) {
    note =
      'the observed criteria carried no own paging field, so the paging field stays unresolved;' +
      ` this build handed over ${ourPaging.join('/') || 'no paging field'}, decided by the` +
      " criteria object's own shape or the capture.";
  } else if (!paging.same) {
    note =
      `the observed criteria carried ${observedPaging.join('/')} while this build handed over` +
      ` ${ourPaging.join('/') || 'no paging field'}; the paging field is not resolved from the` +
      ' observation and the next build must follow it.';
  }
  return {
    observed: found === null ? null : { callIndex: found.callIndex },
    ours,
    fields,
    paging,
    note,
  };
}

/**
 * Ordered strategies for reading the challenge payload out of the argument the
 * SBC detail panel receives and, when the argument carries none, out of the
 * live service containers the #44 shape report proved exist.
 *
 * The entry point is `initWithSBCSet`, but whether the argument is the
 * challenge itself, an entity wrapping `.data`, or a set carrying `.challenge`
 * is not documented, so the bridge feature-detects each shape and records which
 * one carried a requirements array in a documented location. The subject may
 * be a `UTSBCSetEntity` whose
 * challenges live behind the service locator, so the `services.<Domain>` paths
 * are the hypothesis the shape report is expected to confirm: each one is a
 * property read, never a method call, and a missing path keeps its reason.
 */
export const CHALLENGE_SUBJECT_STRATEGIES = Object.freeze([
  Object.freeze({ id: 'panel-argument.data', path: ['data'] }),
  Object.freeze({ id: 'panel-argument', path: [] }),
  Object.freeze({ id: 'panel-argument.challenge', path: ['challenge'] }),
  Object.freeze({ id: 'panel-argument.sbcChallenge', path: ['sbcChallenge'] }),
  Object.freeze({ id: 'services.SBC.repository.challenge', container: 'services', target: 'SBC.repository', path: ['challenge'] }),
  Object.freeze({ id: 'services.SBC.repository.activeChallenge', container: 'services', target: 'SBC.repository', path: ['activeChallenge'] }),
  Object.freeze({ id: 'services.SBC.sbcDAO.challenge', container: 'services', target: 'SBC.sbcDAO', path: ['challenge'] }),
  Object.freeze({ id: 'services.SBC.sbcDAO.activeChallenge', container: 'services', target: 'SBC.sbcDAO', path: ['activeChallenge'] }),
  Object.freeze({ id: 'services.Squad.activeSquad.challenge', container: 'services', target: 'Squad.activeSquad', path: ['challenge'] }),
  Object.freeze({ id: 'services.Squad.squadDao.challenge', container: 'services', target: 'Squad.squadDao', path: ['challenge'] }),
]);

const readPath = (subject, path) => {
  let value = subject;
  for (const segment of path) {
    if (value === null || value === undefined) return undefined;
    value = value[segment];
  }
  return value;
};

/**
 * Finds the requirements array on a loaded challenge payload, in the #51
 * documented order: the properties `eligibilityRequirements`, `requirements`,
 * `requirementsList` and our own observed `elgReq`, then a `getRequirements()`
 * method, each at the top level and again one level down inside `challenge`,
 * `sbcChallenge`, `data.challenge` and `data.sbcChallenge`.
 *
 * Every location probed keeps an `{id, ok, reason}` record, and the winning
 * one names itself in `source`, so a live report says which location answered
 * instead of only that something did. A property read never invokes an
 * accessor; the method is called with no arguments.
 *
 * @param {object} payload the loaded challenge payload
 * @returns {{ ok: boolean, requirements: Array<object>|null, source: string|null,
 *   attempts: Array<{id: string, ok: boolean, reason: string|null,
 *   method?: object}> }}
 */
export function resolveChallengeRequirements(payload) {
  const attempts = [];
  const scopes = [
    { prefix: 'payload', container: payload },
    ...CHALLENGE_REQUIREMENT_CONTAINERS.map((path) => ({
      prefix: `payload.${path.join('.')}`,
      container: readPath(payload, path),
    })),
  ];

  for (const scope of scopes) {
    const readable =
      scope.container !== null &&
      (typeof scope.container === 'object' || typeof scope.container === 'function');
    if (!readable) {
      const reason = `${scope.prefix} is ${describeValue(scope.container)}, not an object`;
      for (const property of CHALLENGE_REQUIREMENT_PROPERTIES) {
        attempts.push({ id: `${scope.prefix}.${property}`, ok: false, reason });
      }
      attempts.push({
        id: `${scope.prefix}.${CHALLENGE_FIELDS.getRequirements}()`,
        ok: false,
        reason,
      });
      continue;
    }

    for (const property of CHALLENGE_REQUIREMENT_PROPERTIES) {
      const attempt = { id: `${scope.prefix}.${property}`, ok: false, reason: null };
      attempts.push(attempt);
      const read = readDataProperty(scope.container, property);
      if (!read.ok) {
        attempt.reason = read.reason ?? `${scope.prefix} carries no ${property}`;
        continue;
      }
      if (!Array.isArray(read.value)) {
        attempt.reason = `${scope.prefix}.${property} is ${describeValue(read.value)}, not an array`;
        continue;
      }
      attempt.ok = true;
      return { ok: true, requirements: read.value, source: attempt.id, attempts };
    }

    const methodName = CHALLENGE_FIELDS.getRequirements;
    const attempt = { id: `${scope.prefix}.${methodName}()`, ok: false, reason: null };
    attempts.push(attempt);
    const found = findMethod(scope.container, methodName);
    if (!found.ok) {
      attempt.reason = describeMissingMethod(scope.prefix, methodName, found.reason);
      continue;
    }
    attempt.method = describeMethodShape(found.value);
    let returned;
    try {
      returned = found.value.call(scope.container);
    } catch (error) {
      attempt.reason = `threw: ${describeCause(error)}`;
      continue;
    }
    if (!Array.isArray(returned)) {
      attempt.reason = `${methodName}() returned ${describeValue(returned)}, not an array`;
      continue;
    }
    attempt.ok = true;
    return { ok: true, requirements: returned, source: attempt.id, attempts };
  }

  return { ok: false, requirements: null, source: null, attempts };
}

const REQUIREMENT_LOOKUP_SUMMARY =
  'eligibilityRequirements, requirements, requirementsList, elgReq, getRequirements(), and one level' +
  ' down in challenge, sbcChallenge, data.challenge, data.sbcChallenge';

const carriesChallengeRequirements = (value) =>
  isRecordObject(value) && resolveChallengeRequirements(value).ok;

/**
 * The subject-resolution half of the requirements check: a candidate is the
 * challenge only when it carries requirements itself, not one level down. The
 * nested locations stay the job of `readChallenge`/`loadChallengePayload`; if
 * this accepted a nested location, `panel-argument` would swallow every
 * `{ challenge }` wrapper and the chain's specific strategies could never
 * answer, which would hide which shape the panel really used.
 */
const carriesTopLevelRequirements = (value) => {
  if (!isRecordObject(value)) return false;
  for (const property of CHALLENGE_REQUIREMENT_PROPERTIES) {
    const read = readDataProperty(value, property);
    if (read.ok && Array.isArray(read.value)) return true;
  }
  const found = findMethod(value, CHALLENGE_FIELDS.getRequirements);
  if (!found.ok) return false;
  try {
    return Array.isArray(found.value.call(value));
  } catch {
    return false;
  }
};

/**
 * The raw EA names of the SBC set API the challenge read walks (#72). The
 * `fsl-build/9` live run proved the panel hook carries no requirements, so the
 * challenge is read the way the reference reads it:
 *
 *   services.SBC.requestSets()                     -> a `sets` array
 *   services.SBC.requestChallengesForSet(set)      -> per set
 *   set.getChallenges()                            -> the entities of that set
 *   services.SBC.sbcDAO.loadChallenge(id, inProgress)
 *   services.SBC.loadChallenge(challengeEntity)    when the DAO is absent
 *
 * An entity carries `id`, `name`/`title`, `isCompleted()`, `isInProgress()` and
 * `squad`; the set-challenges payload's own entries also carry `elgReq`,
 * `elgOperation` and `status` (the shape of
 * `test/fixtures/sbs-set-10-challenges.json`). The loaded payload carries the
 * requirements when the entity does not, and its `squad` is written back onto
 * the entity when the entity has none. Every name here is EA vocabulary, which
 * is why it lives in this one file.
 */
export const SBC_SET_API = Object.freeze({
  requestSets: 'requestSets',
  requestChallengesForSet: 'requestChallengesForSet',
  getChallenges: 'getChallenges',
  loadChallenge: 'loadChallenge',
  sets: 'sets',
  id: 'id',
  name: 'name',
  title: 'title',
  isCompleted: 'isCompleted',
  isInProgress: 'isInProgress',
  squad: 'squad',
  elgReq: 'elgReq',
  elgOperation: 'elgOperation',
  status: 'status',
  data: 'data',
  challengeData: 'challengeData',
  challenges: 'challenges',
  challengesCount: 'challengesCount',
});

/** The service-locator targets the set API and its DAO live on. */
const SBC_SERVICE_TARGET = Object.freeze({ container: 'services', target: 'SBC' });
const SBC_DAO_TARGET = Object.freeze({ container: 'services', target: 'SBC.sbcDAO' });

/**
 * Calls a no-argument predicate method on an entity and answers whether it
 * returned true. A missing method and a throw both mean false: the reference
 * treats a throwing `isCompleted()` as "open", which is the safe direction for
 * a read that must never claim a challenge is finished on a broken call.
 */
const entityFlag = (entity, method) => {
  const found = findMethod(entity, method);
  if (!found.ok) return false;
  try {
    return found.value.call(entity) === true;
  } catch {
    return false;
  }
};

const readEntityId = (entity) => {
  const read = readDataProperty(entity, SBC_SET_API.id);
  return read.ok && Number.isFinite(read.value) ? read.value : null;
};

/** The raw identity fields a challenge may carry, in probe order. */
const CHALLENGE_IDENTITY_FIELDS = Object.freeze([SBC_SET_API.id, CHALLENGE_FIELDS.challengeId]);

/** The first finite identity field on one object level, or null. */
const readIdentityField = (challenge) => {
  for (const field of CHALLENGE_IDENTITY_FIELDS) {
    const read = readDataProperty(challenge, field);
    if (read.ok && Number.isFinite(read.value)) return read.value;
  }
  return null;
};

/**
 * The identity of a challenge the panel named, across the shapes the live page
 * and the set-challenges payload use. A raw set-challenges entry carries
 * `challengeId`; a `UTSBCChallengeEntity` wrapper carries `id`, and its payload
 * may live one level down inside a `data` wrapper. Every shape is a property
 * read; a value that is not a finite number never counts.
 */
const readChallengeIdentity = (challenge) => {
  if (!isRecordObject(challenge)) return null;
  const direct = readIdentityField(challenge);
  if (direct !== null) return direct;
  const data = readDataProperty(challenge, SBC_SET_API.data);
  return data.ok && isRecordObject(data.value) ? readIdentityField(data.value) : null;
};

/**
 * Picks the challenge the player's panel named, by identity, out of every
 * challenge entity the set API listed. Unlike `selectOpenChallenge`, this rule
 * never re-ranks: the panel's second argument is the challenge the player
 * opened, so a matching entity wins even when another is in progress. A named
 * id that matches nothing fails with the counts and refuses to select another
 * challenge, so the blind preference can never override the player's choice.
 *
 * @param {Array<object>} entities the challenge entities, in payload order
 * @param {number} challengeId the id the panel's second argument named
 * @returns {{ ok: boolean, challenge: object|null, index: number, seen: number,
 *   open: number, inProgress: boolean, chosenId: number|null, reason: string }}
 */
export function selectChallengeByIdentity(entities, challengeId) {
  const list = Array.isArray(entities) ? entities : [];
  const seen = list.length;
  let open = 0;
  for (const entity of list) {
    if (!entityFlag(entity, SBC_SET_API.isCompleted)) open += 1;
  }
  const chosen = list.find((entity) => readChallengeIdentity(entity) === challengeId) ?? null;
  if (chosen === null) {
    return {
      ok: false,
      challenge: null,
      index: -1,
      seen,
      open,
      inProgress: false,
      chosenId: challengeId,
      reason:
        `the panel argument named challenge ${challengeId}, but the ${seen} challenges listed carry` +
        ' no challenge with that id; refusing to select another',
    };
  }
  return {
    ok: true,
    challenge: chosen,
    index: list.indexOf(chosen),
    seen,
    open,
    inProgress: entityFlag(chosen, SBC_SET_API.isInProgress),
    chosenId: challengeId,
    reason:
      `the panel argument named challenge ${challengeId}; selected the matching challenge` +
      ` (saw ${seen} challenges, ${open} open)`,
  };
}

/**
 * Picks one challenge to solve out of every challenge entity the set API
 * listed. The rule is deterministic and stated once, here:
 *
 * - a challenge whose `isCompleted()` is truthy is never picked — it is already
 *   solved; a throwing `isCompleted()` is treated as open (see `entityFlag`);
 * - when several are open, an in-progress one is preferred, because that is the
 *   one the player has on screen;
 * - otherwise the first open one in payload order is picked.
 *
 * The result always carries the counts — how many challenges were seen and how
 * many were open — and the chosen id, so the diagnostic can state what this
 * build selected instead of silently picking. When nothing is open the result
 * is `ok: false` with `challenge: null` and a reason naming the counts; the
 * caller must not fall back to a guessed challenge.
 *
 * @param {Array<object>} entities the challenge entities, in payload order
 * @returns {{ ok: boolean, challenge: object|null, index: number, seen: number,
 *   open: number, inProgress: boolean, chosenId: number|null, reason: string }}
 */
export function selectOpenChallenge(entities) {
  const list = Array.isArray(entities) ? entities : [];
  const seen = list.length;
  const open = [];
  for (const entity of list) {
    if (!entityFlag(entity, SBC_SET_API.isCompleted)) open.push(entity);
  }
  if (open.length === 0) {
    return {
      ok: false,
      challenge: null,
      index: -1,
      seen,
      open: 0,
      inProgress: false,
      chosenId: null,
      reason:
        `saw ${seen} challenges but none is open; refusing to pick one (isCompleted() was` +
        ' truthy for every one)',
    };
  }
  const inProgressEntity = open.find((entity) => entityFlag(entity, SBC_SET_API.isInProgress));
  const chosen = inProgressEntity ?? open[0];
  const chosenId = readEntityId(chosen);
  const isInProgress = inProgressEntity !== undefined;
  return {
    ok: true,
    challenge: chosen,
    index: list.indexOf(chosen),
    seen,
    open: open.length,
    inProgress: isInProgress,
    chosenId,
    reason:
      `saw ${seen} challenges, ${open.length} open; chose challenge ${
        chosenId === null ? 'without an id' : chosenId
      }${isInProgress ? ' (in progress)' : ''}`,
  };
}

/**
 * Reads the entity list off one set entity by calling `set.getChallenges()`.
 * The method is called on the entity, never read as a property, because that is
 * how the reference obtains the challenges. A missing method, a throw and a
 * non-array result each keep their own reason.
 */
const readSetChallenges = (set) => {
  const found = findMethod(set, SBC_SET_API.getChallenges);
  if (!found.ok) {
    return {
      ok: false,
      reason: describeMissingMethod('the set entity', SBC_SET_API.getChallenges, found.reason),
    };
  }
  let returned;
  try {
    returned = found.value.call(set);
  } catch (error) {
    return { ok: false, reason: `${SBC_SET_API.getChallenges}() threw: ${describeCause(error)}` };
  }
  if (!Array.isArray(returned)) {
    return {
      ok: false,
      reason: `${SBC_SET_API.getChallenges}() returned ${describeValue(returned)}, not an array`,
    };
  }
  return { ok: true, value: returned };
};

/** The loaded squad the backfill writes onto the entity, or null when absent. */
const readLoadedSquad = (payload) => {
  const direct = readDataProperty(payload, SBC_SET_API.squad);
  if (direct.ok && isRecordObject(direct.value)) return direct.value;
  const data = readDataProperty(payload, SBC_SET_API.data);
  if (!data.ok || !isRecordObject(data.value)) return null;
  const nested = readDataProperty(data.value, SBC_SET_API.squad);
  return nested.ok && isRecordObject(nested.value) ? nested.value : null;
};

/**
 * Writes the loaded payload's squad back onto the challenge entity when the
 * entity has none, so the later squad read sees the same state the reference
 * does. This is an in-memory write to the entity EA already handed us, not a
 * squad write: nothing here can submit or save anything. An entity that
 * already carries a squad is left untouched.
 */
const backfillLoadedSquad = (challenge, payload) => {
  if (!isRecordObject(challenge)) return false;
  const existing = readDataProperty(challenge, SBC_SET_API.squad);
  const hasSquad = existing.ok ? existing.value !== null : existing.reason !== null;
  if (hasSquad) return false;
  const squad = readLoadedSquad(payload);
  if (squad === null) return false;
  try {
    challenge[SBC_SET_API.squad] = squad;
    return true;
  } catch {
    return false;
  }
};

/**
 * The own key names a load result carried, sorted and renamed through the one
 * paste-safety list, so a failed load reports what EA sent without a value
 * (#77). A payload that is not an object is described by its shape instead.
 */
const carriedKeyNames = (payload) =>
  isRecordObject(payload) ? carriedKeys(payload).join(', ') : describeValue(payload);

/**
 * Reads a non-empty `elgReq` array off one entity level. Only a non-empty
 * array counts as carried; a missing, non-array or empty value keeps its own
 * reason so the caller loads and the report can say which shape was missing.
 */
const readEntityElgReq = (challenge) => {
  const read = readDataProperty(challenge, SBC_SET_API.elgReq);
  if (!read.ok) {
    return {
      carried: false,
      count: 0,
      reason:
        read.reason === null
          ? `the selected challenge carries no ${SBC_SET_API.elgReq}`
          : `${SBC_SET_API.elgReq} is ${read.reason}`,
    };
  }
  if (!Array.isArray(read.value)) {
    return {
      carried: false,
      count: 0,
      reason: `${SBC_SET_API.elgReq} is ${describeValue(read.value)}, not an array`,
    };
  }
  if (read.value.length === 0) {
    return { carried: false, count: 0, reason: `${SBC_SET_API.elgReq} is an empty array` };
  }
  return { carried: true, count: read.value.length, reason: null };
};

/**
 * Reads the requirements the set-challenges payload itself carries. The
 * `fsl-build/11` live run demanded them off the entity and found only `squad`
 * because the requirements are the set-challenges entry's own `elgReq` array:
 * the capture in `test/fixtures/sbs-set-10-challenges.json` proves the shape.
 *
 * The live `UTSBCChallengeEntity` wraps that payload one level down, so the
 * entity's own `elgReq` is probed first and then its `data` and `challengeData`
 * wrappers — the same descent `resolveChallengeRequirements` performs for a
 * loaded payload. The winner's `{source, via, payload}` name the exact wrapper,
 * so a report says whether the entity or one of its wrappers answered. A
 * payload that is not a record makes the direct probe fail with its reason.
 */
const readChallengeEntityRequirements = (challenge) => {
  const direct = readEntityElgReq(challenge);
  // Both miss paths return the same shape: the direct probe's own reason, the
  // payload it probed, and no requirements source.
  const unresolved = { ...direct, payload: challenge, source: null, via: null };
  if (direct.carried) {
    return {
      ...direct,
      payload: challenge,
      source: SBC_SET_API.elgReq,
      via: `set-payload.${SBC_SET_API.elgReq}`,
    };
  }
  if (!isRecordObject(challenge)) return unresolved;
  for (const wrapper of [SBC_SET_API.data, SBC_SET_API.challengeData]) {
    const read = readDataProperty(challenge, wrapper);
    if (!read.ok || !isRecordObject(read.value)) continue;
    const nested = readEntityElgReq(read.value);
    if (nested.carried) {
      return {
        ...nested,
        payload: read.value,
        source: `${wrapper}.${SBC_SET_API.elgReq}`,
        via: `set-payload.${wrapper}.${SBC_SET_API.elgReq}`,
      };
    }
  }
  return unresolved;
};

/**
 * Summarizes one load attempt for the reason string: the call that ran, whether
 * its payload carried a requirements array, and, when it did not, the payload's
 * own key names (never a value, names already renamed through the shared
 * paste-safety list). The caller reads `usable` to decide on the next fallback.
 */
const describeLoadAttempt = (via, call) => {
  if (!call.ok) return { usable: false, reason: `${via} failed: ${call.reason}` };
  if (carriesChallengeRequirements(call.event.payload)) {
    return { usable: true, reason: `${via} returned the requirements` };
  }
  return {
    usable: false,
    reason:
      `${via} returned an object carrying [${carriedKeyNames(call.event.payload)}] with no` +
      ' requirements array',
  };
};

/**
 * Walks the SBC set API to a challenge payload with requirements: request the
 * sets, list each set's challenges through `requestChallengesForSet` and
 * `set.getChallenges()`, and select the open challenge. A selected challenge
 * whose own `elgReq` array is non-empty answers directly (#77); otherwise the
 * challenge is loaded by id through the DAO — with the entity's own
 * `isInProgress()`, a throw meaning false — and then, when that yields no
 * requirements, by the entity itself. The set entities may already carry their
 * challenges for the live page; the request is still made first because the
 * reference makes it and that is the only verified way the entities are
 * populated.
 *
 * A set whose listing fails is recorded and skipped; a load that yields no
 * requirements keeps every attempt and the payload's own key names so the
 * failure says which shape was missing. Every reason names the call and the
 * argument it used, never a guessed one.
 */
const loadChallengeFromSetApi = async ({
  pageWindow,
  strategy,
  timeoutMs,
  pacer,
  selectedChallengeId = null,
}) => {
  const base = resolveStrategyBase(pageWindow, SBC_SERVICE_TARGET);
  if (!base.ok) return { ok: false, reason: base.reason, selection: null };

  const requestSets = findMethod(base.value, SBC_SET_API.requestSets);
  if (!requestSets.ok) {
    return {
      ok: false,
      reason: describeMissingMethod(base.name, SBC_SET_API.requestSets, requestSets.reason),
      selection: null,
    };
  }
  const setsCall = await callReadMethod(
    requestSets,
    base.value,
    [],
    `${strategy.id} ${SBC_SET_API.requestSets}`,
    timeoutMs,
    { pacer, kind: CALL_KINDS.CHALLENGE_LOAD }
  );
  if (!setsCall.ok) return { ok: false, reason: setsCall.reason, selection: null };

  const setsPayload = setsCall.event.payload;
  const sets = isRecordObject(setsPayload) ? setsPayload[SBC_SET_API.sets] : undefined;
  if (!Array.isArray(sets)) {
    return {
      ok: false,
      reason: `${SBC_SET_API.requestSets} returned no ${SBC_SET_API.sets} array (got ${describeValue(
        setsPayload
      )})`,
      selection: null,
    };
  }

  const requestChallenges = findMethod(base.value, SBC_SET_API.requestChallengesForSet);
  if (!requestChallenges.ok) {
    return {
      ok: false,
      reason: describeMissingMethod(
        base.name,
        SBC_SET_API.requestChallengesForSet,
        requestChallenges.reason
      ),
      selection: null,
    };
  }

  const entities = [];
  const failures = [];
  for (const [index, set] of sets.entries()) {
    const label = `${strategy.id} set ${index + 1}`;
    const listing = await callReadMethod(
      requestChallenges,
      base.value,
      [set],
      label,
      timeoutMs,
      { pacer, kind: CALL_KINDS.CHALLENGE_LOAD }
    );
    if (!listing.ok) {
      const setId = readEntityId(set);
      const idPart = setId === null ? '' : ` (set id ${setId})`;
      const statusPart = listing.status === null ? '' : ` [HTTP ${listing.status}]`;
      failures.push(`${label}${idPart}${statusPart}: ${listing.reason}`);
      continue;
    }
    const challenges = readSetChallenges(set);
    if (!challenges.ok) {
      failures.push(`${label}: ${challenges.reason}`);
      continue;
    }
    entities.push(...challenges.value);
  }

  const selection =
    selectedChallengeId === null
      ? selectOpenChallenge(entities)
      : selectChallengeByIdentity(entities, selectedChallengeId);
  // The reason is pasted into a support report, so a page where every set
  // failed listing must not produce one line per set: the count plus the first
  // few reasons is enough to act on.
  const failureNote =
    failures.length === 0
      ? ''
      : `; ${failures.length} of ${sets.length} sets could not be listed [${failures
          .slice(0, 3)
          .join('; ')}${failures.length > 3 ? '; …' : ''}]`;
  if (!selection.ok) {
    return {
      ok: false,
      reason: `${selection.reason}${failureNote}`,
      sets: sets.length,
      selection,
    };
  }

  const chosen = selection.challenge;
  const entityRequirements = readChallengeEntityRequirements(chosen);
  if (entityRequirements.carried) {
    return {
      ok: true,
      payload: entityRequirements.payload,
      challenge: chosen,
      via: entityRequirements.via,
      requirementsFrom: `payload.${entityRequirements.source}`,
      requirementsReason:
        `requirements came from the set-challenges payload (${entityRequirements.source}[` +
        `${entityRequirements.count}]); no challenge load was needed`,
      sets: sets.length,
      selection,
    };
  }

  // The entity carries no requirements, so the challenge is loaded by identity:
  // the DAO first when it exists and the entity has an id, then the entity
  // itself. The entity's own `isInProgress()` decides the DAO's second argument
  // and a throw there means "not in progress".
  const inProgress = entityFlag(chosen, SBC_SET_API.isInProgress);
  const entityId = readEntityId(chosen);
  const loadAttempts = [];
  let payload = null;
  let via = null;

  const daoBase = resolveStrategyBase(pageWindow, SBC_DAO_TARGET);
  const daoLoad = daoBase.ok ? findMethod(daoBase.value, SBC_SET_API.loadChallenge) : { ok: false };
  if (daoLoad.ok && entityId !== null) {
    const daoVia = `${SBC_DAO_TARGET.target}.${SBC_SET_API.loadChallenge}`;
    const call = await callReadMethod(
      daoLoad,
      daoBase.value,
      [entityId, inProgress],
      `${strategy.id} ${daoVia}`,
      timeoutMs,
      { pacer, kind: CALL_KINDS.CHALLENGE_LOAD }
    );
    const attempt = describeLoadAttempt(daoVia, call);
    loadAttempts.push(attempt);
    if (attempt.usable) {
      payload = call.event.payload;
      via = daoVia;
    }
  }

  if (payload === null) {
    const found = findMethod(base.value, SBC_SET_API.loadChallenge);
    if (found.ok) {
      const entityVia = `${SBC_SERVICE_TARGET.target}.${SBC_SET_API.loadChallenge}`;
      const call = await callReadMethod(
        found,
        base.value,
        [chosen],
        `${strategy.id} ${entityVia}`,
        timeoutMs,
        { pacer, kind: CALL_KINDS.CHALLENGE_LOAD }
      );
      const attempt = describeLoadAttempt(entityVia, call);
      loadAttempts.push(attempt);
      if (attempt.usable) {
        payload = call.event.payload;
        via = entityVia;
      }
    }
  }

  if (payload === null) {
    const attempts =
      loadAttempts.length === 0
        ? `no load method was available (${SBC_DAO_TARGET.target}.${SBC_SET_API.loadChallenge} and` +
          ` ${SBC_SERVICE_TARGET.target}.${SBC_SET_API.loadChallenge})`
        : `${loadAttempts
            .map((attempt) => attempt.reason)
            .join('; ')}; none of them carried a requirements array`;
    return {
      ok: false,
      reason:
        `the set-challenges payload carried no ${SBC_SET_API.elgReq} ` +
        `(${entityRequirements.reason}); saw ${selection.seen} challenges in ${sets.length} sets;` +
        ` ${attempts}`,
      sets: sets.length,
      selection,
    };
  }

  const requirements = resolveChallengeRequirements(payload);
  const squadBackfilled = backfillLoadedSquad(chosen, payload);
  return {
    ok: true,
    payload,
    challenge: chosen,
    via,
    requirementsFrom: requirements.ok ? requirements.source : null,
    requirementsReason:
      `the set-challenges payload carried no ${SBC_SET_API.elgReq}; requirements came from the` +
      ` load result (${requirements.source})`,
    sets: sets.length,
    selection,
    squadBackfilled,
  };
};

/**
 * The ordered challenge-load strategies, most likely first. The `fsl-build/9`
 * live run proved the panel hook carries no requirements, so the primary entry
 * is the SBC set API walk (#72): `requestSets` -> `requestChallengesForSet` ->
 * `set.getChallenges()` -> the open challenge -> `sbcDAO.loadChallenge(id,
 * inProgress)` when available, else `services.SBC.loadChallenge(entity)`. The
 * #51 panel-argument calls stay behind it as reported fallbacks: the panel
 * argument is known empty live, so a future EA build that starts filling it
 * stays visible in the diagnostic. The payload the panel argument already
 * carried is the last resort, so the fixture path keeps working when no service
 * answers.
 *
 * Every entry is a candidate to feature-detect, not a verified signature; each
 * one keeps its `{id, ok, reason}` record and, where a callable method was
 * reached, the method's `{arity, constructor, excerpt, truncated}` shape.
 */
export const CHALLENGE_LOAD_STRATEGIES = Object.freeze([
  Object.freeze({
    id: 'services.SBC.requestSets+requestChallengesForSet+getChallenges',
    setApi: true,
  }),
  Object.freeze({ id: 'services.SBC.loadChallenge+subject', container: 'services', target: 'SBC', method: 'loadChallenge', argument: 'subject' }),
  Object.freeze({ id: 'services.SBC.loadChallenge', container: 'services', target: 'SBC', method: 'loadChallenge' }),
  Object.freeze({ id: 'services.SBC.sbcDAO.loadChallenge+id', container: 'services', target: 'SBC.sbcDAO', method: 'loadChallenge', argument: 'challengeId' }),
  Object.freeze({ id: 'subject.payload', source: 'subject' }),
]);

/**
 * The diagnostic form of a selection: the counts and the chosen id only, never
 * the live challenge entity, so a pasted attempt can carry what was selected
 * without carrying an EA object. The counts are what the next live log needs to
 * say whether this build picked the challenge the player meant.
 */
const summarizeSelection = (selection, sets) =>
  selection === null || selection === undefined
    ? null
    : {
        ok: selection.ok === true,
        seen: selection.seen,
        open: selection.open,
        inProgress: selection.inProgress === true,
        chosenId: selection.chosenId ?? null,
        sets: sets ?? 0,
        reason: selection.reason,
      };

const describeArgumentFailure = (strategy, subjectResult) => {
  if (strategy.argument === 'subject') {
    return 'the panel argument carried no challenge payload to pass to loadChallenge';
  }
  if (subjectResult?.ok === true) {
    return 'the panel argument payload carries no finite challengeId';
  }
  return 'the panel argument carried no challenge payload to take a challengeId from';
};

/**
 * Loads the full challenge payload for the challenge the player is looking at.
 *
 * The primary strategy is the #72 SBC set API walk: request the sets, list each
 * set's challenges, select the open one (deterministic rule in
 * `selectOpenChallenge`), and read the requirements the set-challenges payload
 * itself carries (#77): a selected challenge with a non-empty `elgReq` array is
 * usable as it stands, with no load at all. Only a challenge whose `elgReq` is
 * missing, not an array or empty is loaded — by identity through the DAO with
 * the entity's own `isInProgress()` (a throw means false) first, then the
 * entity itself — and the loaded `squad` is written back onto the entity. The
 * attempt carries a reason naming which of the two shapes answered, so a live
 * report can tell "the payload had no elgReq" from "the load returned no
 * data". The #51 panel-argument strategies stay behind it as reported
 * fallbacks. Every strategy goes through the observable bridge: a returned
 * observable is subscribed and unsubscribed with a timeout, a promise is
 * awaited under the same timeout, and a plain value is carried as-is. A loaded
 * payload is accepted when any documented requirements location carries an
 * array, so the loaded shape is reported by the same lookup as the panel shape.
 *
 * `selectedChallengeId` gates the whole panel-argument half of this table. When
 * the subject stage named a challenge it could not verify, every strategy that
 * answers from the panel argument is refused with that id in its reason: those
 * strategies carry the argument's payload, or a challenge id read out of it, and
 * the identity probe already refused them. Only the identity-gated set walk may
 * answer, so the run either loads the challenge the player opened or fails.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @param {{ ok: boolean, payload: object|null }} subjectResult the
 *   `resolveChallengeSubject` result
 * @param {{ observableTimeoutMs?: number, pacer?: object }} [options]
 *   `observableTimeoutMs` is injectable for tests; `pacer` is the queue every
 *   EA call runs through, defaulting to the shared paced queue (#52)
 * @returns {Promise<{ ok: boolean, payload: object|null, strategy: string|null,
 *   attempts: Array<{id: string, ok: boolean, reason: string|null,
 *   method?: object, selection?: object}>, selection?: object,
 *   loadVia?: string, squadBackfilled?: boolean }>} the set-API selection
 *   counts and the load path ride on the result when that strategy answered
 */
export async function loadChallengePayload(pageWindow, subjectResult, options = {}) {
  const timeoutMs = resolveTimeoutMs(options.observableTimeoutMs);
  const pacer = resolvePacer(options);
  const attempts = [];
  const subjectPayload =
    subjectResult?.ok === true &&
    subjectResult.payload !== null &&
    typeof subjectResult.payload === 'object'
      ? subjectResult.payload
      : null;
  // The identity the panel's second argument named, when the subject stage
  // recorded one. It is an input to the set walk, never a selector of its own:
  // the walk loads that challenge by id instead of re-ranking the open ones.
  const selectedChallengeId = Number.isFinite(subjectResult?.selectedChallengeId)
    ? subjectResult.selectedChallengeId
    : null;

  // The panel named the challenge and its requirements resolved, so the answer
  // is already in hand. The blind set-API walk must not override the identity
  // the player chose, so it never runs on this path.
  if (
    subjectResult?.strategy === PANEL_SET_CHALLENGE_STRATEGY_ID &&
    subjectPayload !== null &&
    carriesChallengeRequirements(subjectPayload)
  ) {
    attempts.push({
      id: PANEL_SET_CHALLENGE_STRATEGY_ID,
      ok: true,
      reason:
        'the panel argument carried the selected challenge with requirements; no set-API walk' +
        ' was needed',
    });
    return {
      ok: true,
      payload: subjectPayload,
      strategy: PANEL_SET_CHALLENGE_STRATEGY_ID,
      attempts,
      selection: subjectResult.selection ?? null,
      loadVia: subjectResult.via ?? PANEL_SET_CHALLENGE_STRATEGY_ID,
      requirementsFrom: subjectResult.requirementsFrom ?? null,
      squadBackfilled: false,
    };
  }

  for (const strategy of CHALLENGE_LOAD_STRATEGIES) {
    const attempt = { id: strategy.id, ok: false, reason: null };
    attempts.push(attempt);

    if (strategy.setApi === true) {
      const outcome = await loadChallengeFromSetApi({
        pageWindow,
        strategy,
        timeoutMs,
        pacer,
        selectedChallengeId,
      });
      attempt.sets = outcome.sets ?? 0;
      attempt.selection = summarizeSelection(outcome.selection, outcome.sets);
      if (!outcome.ok) {
        attempt.reason = outcome.reason;
        continue;
      }
      if (!carriesChallengeRequirements(outcome.payload)) {
        attempt.reason = `returned no challenge payload carrying requirements (got ${describeValue(
          outcome.payload
        )})`;
        continue;
      }
      attempt.ok = true;
      attempt.reason = outcome.requirementsReason ?? null;
      return {
        ok: true,
        payload: outcome.payload,
        strategy: strategy.id,
        attempts,
        selection: outcome.selection,
        loadVia: outcome.via,
        requirementsFrom: outcome.requirementsFrom ?? null,
        squadBackfilled: outcome.squadBackfilled === true,
      };
    }

    // The panel named a challenge and this build could not verify it. Every strategy
    // below this gate answers from the panel argument — as the payload itself, as
    // an argument to a load call, or as an id read out of it — so none of them is
    // the challenge the player opened: the subject probe refused that identity,
    // and the probe's own reason promises the run must not fall back to another
    // challenge. The identity-gated set walk above already ran and had its say, so
    // the run stops here rather than write a squad into a challenge nobody
    // picked. Refusing loudly is the correct outcome here, not a fallback.
    if (selectedChallengeId !== null) {
      attempt.reason =
        `the panel named challenge ${selectedChallengeId} but it could not be verified, so ${strategy.id}` +
        ' may not answer from the unverified panel argument; the run must not fall back to another challenge';
      continue;
    }

    if (strategy.source === 'subject') {
      if (subjectPayload !== null && carriesChallengeRequirements(subjectPayload)) {
        attempt.ok = true;
        return { ok: true, payload: subjectPayload, strategy: strategy.id, attempts };
      }
      attempt.reason =
        subjectPayload === null
          ? 'the panel argument carried no challenge payload'
          : 'the panel argument payload carries no requirements array in a documented location';
      continue;
    }

    const base = resolveStrategyBase(pageWindow, strategy);
    if (!base.ok) {
      attempt.reason = base.reason;
      continue;
    }
    const found = findMethod(base.value, strategy.method);
    if (!found.ok) {
      attempt.reason = describeMissingMethod(base.name, strategy.method, found.reason);
      continue;
    }
    attempt.method = describeMethodShape(found.value);

    let callArguments;
    if (strategy.argument === 'subject') {
      if (subjectPayload === null) {
        attempt.reason = describeArgumentFailure(strategy, subjectResult);
        continue;
      }
      callArguments = [subjectPayload];
    } else if (strategy.argument === 'challengeId') {
      const challengeId = subjectPayload?.[CHALLENGE_FIELDS.challengeId];
      if (!Number.isFinite(challengeId)) {
        attempt.reason = describeArgumentFailure(strategy, subjectResult);
        continue;
      }
      callArguments = [challengeId];
    } else {
      callArguments = [];
    }

    const call = await callReadMethod(found, base.value, callArguments, strategy.id, timeoutMs, {
      pacer,
      kind: CALL_KINDS.CHALLENGE_LOAD,
    });
    if (!call.ok) {
      attempt.reason = call.reason;
      continue;
    }
    const event = call.event;
    if (!carriesChallengeRequirements(event.payload)) {
      attempt.reason = `returned no challenge payload carrying requirements (got ${describeValue(
        event.payload
      )})`;
      continue;
    }
    attempt.ok = true;
    return { ok: true, payload: event.payload, strategy: strategy.id, attempts };
  }

  return { ok: false, payload: null, strategy: null, attempts };
}

const describeSubject = (subject) =>
  subject === null ? 'null' : Array.isArray(subject) ? 'an array' : typeof subject;

/**
 * Resolves one strategy entry to the value it names: a path inside the panel
 * argument for a plain entry, or a property path inside a `services.<Domain>`
 * container for a service entry. This reads properties only; it never calls a
 * method, so an unknown service shape fails with a reason instead of an
 * invented argument list.
 */
const readStrategyValue = (subject, pageWindow, strategy) => {
  if (strategy.container === 'services') {
    const base = resolveStrategyBase(pageWindow, strategy);
    if (!base.ok) return { ok: false, reason: base.reason };
    const value = readPath(base.value, strategy.path ?? []);
    if (value === null || value === undefined) {
      return { ok: false, reason: `${base.name} carries no ${strategy.path.at(-1) ?? 'value'}` };
    }
    return { ok: true, value };
  }
  const value = readPath(subject, strategy.path);
  if (value === null || value === undefined) {
    const label = strategy.id.replace('panel-argument', 'panel argument');
    return {
      ok: false,
      reason: `${label} carries no ${strategy.path.at(-1) ?? 'value'} (got ${describeSubject(subject)})`,
    };
  }
  return { ok: true, value };
};

const resolveFirstStrategy = (strategies, subject, pageWindow, accept) => {
  const attempts = [];
  for (const strategy of strategies) {
    const attempt = { id: strategy.id, ok: false, reason: null };
    attempts.push(attempt);
    const label = strategy.id.replace('panel-argument', 'panel argument');
    const resolved = readStrategyValue(subject, pageWindow, strategy);
    if (!resolved.ok) {
      attempt.reason = resolved.reason;
      continue;
    }
    const reason = accept(resolved.value, label);
    if (reason !== null) {
      attempt.reason = reason;
      continue;
    }
    attempt.ok = true;
    return { ok: true, payload: resolved.value, strategy: strategy.id, attempts };
  }
  return { ok: false, payload: null, strategy: null, attempts };
};

/**
 * The identity the panel's two arguments carry, from the `fsl-build/13` live
 * report: `args[0]` is the `UTSBCSetEntity` and `args[1]` is the number of the
 * challenge the player opened. The strategy id names that pair, so a bridge
 * stage can say which path answered.
 */
const PANEL_SET_CHALLENGE_STRATEGY_ID = 'panel-argument.challenges+id';

/**
 * The panel-identity strategy table, frozen and exported so `buildMarker()`
 * reads it. The four pre-existing reader tables were unchanged by the identity
 * work, so a stale `adapter.js` beside a fresh `build.js` would report this build
 * id with matching tables while lacking the identity path entirely — the
 * mismatched-module report #50 exists to make diagnosable.
 */
export const PANEL_CHALLENGE_STRATEGIES = Object.freeze([
  Object.freeze({ id: PANEL_SET_CHALLENGE_STRATEGY_ID }),
]);

/** The two locations the named challenge is looked for in, each recorded. */
const PANEL_CHALLENGES_KEY_LOCATION = 'panel-argument.challenges[key]';
const PANEL_CHALLENGES_IDENTITY_LOCATION = 'panel-argument.challenges[identity]';

/**
 * Reads the own `challenges` entry for `challengeId`, never a prototype key and
 * never through an accessor. A plain `collection[challengeId]` is neither: it
 * walks the prototype chain, so an index-keyed map, a colliding numeric key or
 * an inherited key would all hand back *a* challenge — just not the one the
 * player opened, which is the silent wrong-solve this read exists to prevent.
 * The own property is still only a candidate: `probeKeyedChallenge` verifies its
 * identity before it is used.
 */
const readOwnKeyedChallenge = (collection, challengeId) => {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(collection, challengeId);
  } catch {
    return { ok: false, reason: 'an unreadable key' };
  }
  if (descriptor === undefined) return { ok: false, reason: null };
  if (typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
    return { ok: false, reason: 'an accessor(get/set); refusing to invoke it' };
  }
  if (descriptor.value === undefined) return { ok: false, reason: null };
  return { ok: true, value: descriptor.value };
};

/**
 * Probes the keyed location and records it: the entry is only a candidate, so it
 * counts only when its own identity is the id the panel named. A key EA does not
 * use for challenge ids, a stale key and a prototype key all land here as a
 * refusal with the id that was there instead, so a live report says why the
 * keyed path lost rather than that it lost. The verified entry rides on
 * `challenge`; the record itself stays plain `{id, ok, reason}` data so no live
 * EA object can reach a pasted report.
 */
const probeKeyedChallenge = (collection, challengeId) => {
  const id = PANEL_CHALLENGES_KEY_LOCATION;
  if (!isRecordObject(collection)) {
    return { id, ok: false, reason: `the ${SBC_SET_API.challenges} collection is not keyed, so there is no keyed location` };
  }
  const read = readOwnKeyedChallenge(collection, challengeId);
  if (!read.ok) {
    return {
      id,
      ok: false,
      reason:
        read.reason === null
          ? `the collection has no own entry for key ${challengeId}`
          : `the collection's own entry for key ${challengeId} is ${read.reason}`,
    };
  }
  const identity = readChallengeIdentity(read.value);
  if (identity !== challengeId) {
    return {
      id,
      ok: false,
      reason:
        `the entry at own key ${challengeId} carries challenge ${identity ?? 'no id'}, not ${challengeId};` +
        ' a key EA does not use for challenge ids cannot select a challenge',
    };
  }
  return { id, ok: true, reason: null, challenge: read.value };
};

/**
 * Locates the challenge the panel's second argument named inside the set
 * argument's `challenges` collection. The collection is an array in the
 * captured payload and an object on the live page, but the build-13 evidence
 * says only that it is an object: nothing proved it is keyed by challenge id,
 * so the key is never trusted on its own. Both locations are probed and each
 * keeps its own `{id, ok, reason}` record — the own key (only when the entry's
 * own `readChallengeIdentity` is the id the panel named) and the identity match
 * over every candidate, which answers for a raw `challengeId` entry and an `id`
 * entity wrapper alike. An entry whose id does not match is refused, never used,
 * because that is a challenge the player did not open. When neither location
 * verifies the identity the result is a loud miss: a missing collection, a
 * non-collection and a named id with no verified entry each keep their own
 * reason, the refused locations ride on that reason, and the candidate count is
 * on every outcome.
 */
const locatePanelChallenge = (set, challengeId) => {
  const read = readDataProperty(set, SBC_SET_API.challenges);
  if (!read.ok) {
    return {
      ok: false,
      seen: 0,
      locations: [],
      reason:
        read.reason === null
          ? `the panel argument carries no ${SBC_SET_API.challenges} collection`
          : `the panel argument ${SBC_SET_API.challenges} is ${read.reason}`,
    };
  }
  const collection = read.value;
  let candidates;
  if (Array.isArray(collection)) candidates = collection;
  else if (isRecordObject(collection)) candidates = Object.values(collection);
  else {
    return {
      ok: false,
      seen: 0,
      locations: [],
      reason:
        `the panel argument ${SBC_SET_API.challenges} is ${describeValue(collection)},` +
        ' not a collection',
    };
  }
  const seen = candidates.length;
  const keyed = probeKeyedChallenge(collection, challengeId);
  const match = candidates.find((entry) => readChallengeIdentity(entry) === challengeId) ?? null;
  // The record carries no challenge payload; the verified entry rides beside it.
  const locations = [
    { id: PANEL_CHALLENGES_KEY_LOCATION, ok: keyed.ok, reason: keyed.reason },
    {
      id: PANEL_CHALLENGES_IDENTITY_LOCATION,
      ok: match !== null,
      reason: match === null ? `none of the ${seen} entries carries challenge ${challengeId}` : null,
    },
  ];
  // A verified entry is the answer either way; the two locations are recorded
  // side by side so a report says which one answered and why the other did not.
  const located = keyed.ok === true ? keyed.challenge : match;
  if (located === null) {
    return {
      ok: false,
      seen,
      locations,
      reason:
        `the panel argument carries ${seen} challenges but none with id ${challengeId}` +
        ` (${locations.map((location) => `${location.id}: ${location.reason}`).join('; ')})`,
    };
  }
  return { ok: true, seen, locations, challenge: located };
};

/**
 * Resolves the requirements of the challenge the panel named: the located
 * payload itself first, then its `data` and `challengeData` wrappers, one level
 * down, for the `UTSBCChallengeEntity` shape the live page uses. The winner's
 * `source` and the payload that actually carries the array are returned, so the
 * caller hands a payload `readChallenge` can read. Nothing is guessed: when no
 * location carries an array, the resolver's own probed locations are named.
 */
const resolveLocatedChallengeRequirements = (challenge) => {
  const direct = resolveChallengeRequirements(challenge);
  if (direct.ok) {
    return { ok: true, source: direct.source, payload: challenge };
  }
  for (const wrapper of [SBC_SET_API.data, SBC_SET_API.challengeData]) {
    const read = readDataProperty(challenge, wrapper);
    if (!read.ok || !isRecordObject(read.value)) continue;
    const nested = resolveChallengeRequirements(read.value);
    if (nested.ok) {
      const source = nested.source.startsWith('payload.')
        ? nested.source.slice('payload.'.length)
        : nested.source;
      return { ok: true, source: `${wrapper}.${source}`, payload: read.value };
    }
  }
  return {
    ok: false,
    reason:
      `no requirements array in any documented location (probed ${direct.attempts
        .map((attempt) => attempt.id)
        .join(', ')}, and the ${SBC_SET_API.data}/${SBC_SET_API.challengeData} wrappers)`,
  };
};

/**
 * The panel-identity probe: when a second panel argument names a challenge and
 * the first argument carries a `challenges` collection, the named challenge is
 * the one the player opened, so its requirements are read first and the blind
 * open-challenge walk never runs for it. Returns null when no second argument
 * was handed over, so the legacy panel strategies stay the whole answer and
 * their recorded attempts are unchanged.
 *
 * The recorded attempt carries `locations`: each location the named challenge
 * was looked for in, and why the ones that did not answer did not. Every one is
 * plain data — an id, a flag and a reason — so it rides on a pasted report.
 */
const probePanelSetChallenge = (subject, panelContext) => {
  const challengeId = Number.isFinite(panelContext?.challengeId)
    ? panelContext.challengeId
    : null;
  if (challengeId === null) return null;
  const attempt = { id: PANEL_SET_CHALLENGE_STRATEGY_ID, ok: false, reason: null };
  if (!isRecordObject(subject)) {
    attempt.reason =
      `the panel argument is ${describeSubject(subject)}, not a set carrying a` +
      ` ${SBC_SET_API.challenges} collection`;
    return { attempt, challengeId };
  }
  const located = locatePanelChallenge(subject, challengeId);
  attempt.locations = located.locations;
  if (!located.ok) {
    attempt.reason = `the second panel argument named challenge ${challengeId}; ${located.reason}`;
    return { attempt, challengeId, seen: located.seen };
  }
  const resolved = resolveLocatedChallengeRequirements(located.challenge);
  if (!resolved.ok) {
    attempt.reason =
      `the panel argument's challenge ${challengeId} ${resolved.reason}; the run must not fall` +
      ' back to another challenge';
    return { attempt, challengeId, seen: located.seen };
  }
  attempt.ok = true;
  return {
    attempt,
    challengeId,
    seen: located.seen,
    payload: resolved.payload,
    requirementsFrom: resolved.source,
  };
};

/**
 * Reads the challenge payload out of the SBC detail panel argument, then out
 * of the live service containers. A value is accepted when any documented
 * requirements location carries an array (`resolveChallengeRequirements`); the
 * reason for a rejected candidate names that lookup, so a live report says
 * what was missing rather than only that the candidate failed.
 *
 * The panel's second argument is consumed first (#77 follow-up): when it names
 * a challenge and the first argument is the set the player opened, that
 * challenge's own requirements are the answer. When the named challenge carries
 * no readable requirements, the result is still not-ok but carries
 * `selectedChallengeId`, so the load stage follows that identity instead of
 * selecting a challenge blindly.
 *
 * @param {*} subject the first argument passed to `initWithSBCSet`
 * @param {object|undefined} [pageWindow] the page's `window`, needed for the
 *   `services.<Domain>` strategies
 * @param {{ challengeId?: number }} [panelContext] the second argument's
 *   numeric challenge id, when the bridge saw one
 * @returns {{ ok: boolean, payload: object|null, strategy: string|null,
 *   attempts: Array<{id: string, ok: boolean, reason: string|null}>,
 *   selectedChallengeId?: number|null, requirementsFrom?: string|null,
 *   via?: string|null, selection?: object }}
 */
export function resolveChallengeSubject(subject, pageWindow, panelContext = {}) {
  const panelProbe = probePanelSetChallenge(subject, panelContext);
  const fallback = resolveFirstStrategy(
    CHALLENGE_SUBJECT_STRATEGIES,
    subject,
    pageWindow,
    (value, label) => {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return `${label} is not an object (got ${describeSubject(value)})`;
      }
      if (!carriesTopLevelRequirements(value)) {
        return `${label} carries no requirements array (looked for ${REQUIREMENT_LOOKUP_SUMMARY})`;
      }
      return null;
    }
  );
  if (panelProbe === null) return fallback;
  const attempts = [panelProbe.attempt, ...fallback.attempts];
  if (panelProbe.attempt.ok !== true) {
    return { ...fallback, attempts, selectedChallengeId: panelProbe.challengeId };
  }
  return {
    ok: true,
    payload: panelProbe.payload,
    strategy: PANEL_SET_CHALLENGE_STRATEGY_ID,
    attempts,
    selectedChallengeId: panelProbe.challengeId,
    requirementsFrom: panelProbe.requirementsFrom,
    via: PANEL_SET_CHALLENGE_STRATEGY_ID,
    selection: {
      ok: true,
      seen: panelProbe.seen,
      open: null,
      inProgress: false,
      chosenId: panelProbe.challengeId,
      sets: 0,
      source: PANEL_SET_CHALLENGE_STRATEGY_ID,
      reason:
        `the panel argument carried the selected challenge ${panelProbe.challengeId} with` +
        ' requirements',
    },
  };
}

/**
 * Candidate methods on EA's search view model that request the active squad's
 * definition ids. The #51 finding documented the request as a method on
 * `UTBucketedItemSearchViewModel`; the exact name is not verified, so both the
 * `request` and `get` spellings are feature-detected, each recorded with its
 * reason. Whichever answers through the observable bridge supplies the active
 * squad payload.
 */
export const ACTIVE_SQUAD_METHODS = Object.freeze([
  'requestActiveSquadDefinitionIds',
  'getActiveSquadDefinitionIds',
]);

/**
 * Ordered strategies for reading the challenge *squad* payload out of the
 * argument the SBC detail panel receives and, when it carries none, out of the
 * `services.Squad` and `services.SBC` containers. The challenge definition and
 * the squad state may arrive on the same subject (the challenge read already
 * feature-detects requirements), so this reader independently looks for the
 * `{ challengeId, squad: { players: [...] } }` wrapper the writer consumes. The
 * captured fixture `test/fixtures/sbs-challenge-25-squad.json` is that shape.
 *
 * The first entry is the squad carried by the loaded challenge payload (#51);
 * the last two entries are the search view model's active-squad definition-id
 * request, called with no arguments through the observable bridge. Every entry
 * keeps its `{id, ok, reason}` record and, when a callable method was reached,
 * its method shape.
 */
export const CHALLENGE_SQUAD_STRATEGIES = Object.freeze([
  Object.freeze({ id: 'challenge-load.squad', source: 'loaded' }),
  Object.freeze({ id: 'panel-argument', path: [] }),
  Object.freeze({ id: 'panel-argument.data', path: ['data'] }),
  Object.freeze({ id: 'panel-argument.challenge', path: ['challenge'] }),
  Object.freeze({ id: 'panel-argument.sbcChallenge', path: ['sbcChallenge'] }),
  Object.freeze({ id: 'services.Squad.activeSquad', container: 'services', target: 'Squad.activeSquad', path: [] }),
  Object.freeze({ id: 'services.Squad.activeSquad.data', container: 'services', target: 'Squad.activeSquad', path: ['data'] }),
  Object.freeze({ id: 'services.Squad.squadDao.activeSquad', container: 'services', target: 'Squad.squadDao', path: ['activeSquad'] }),
  Object.freeze({ id: 'services.SBC.repository.activeSquad', container: 'services', target: 'SBC.repository', path: ['activeSquad'] }),
  Object.freeze({ id: 'services.SBC.repository.challengeSquad', container: 'services', target: 'SBC.repository', path: ['challengeSquad'] }),
  ...ACTIVE_SQUAD_METHODS.map((method) =>
    Object.freeze({
      id: `${EA_GLOBALS.searchViewModel}.${method}+observable`,
      container: 'window',
      target: 'searchViewModel',
      method,
    })
  ),
]);

const carriesChallengeSquad = (value) => {
  if (!isRecordObject(value)) return false;
  const squad = value[CHALLENGE_SQUAD_FIELDS.squad];
  return (
    squad !== null &&
    typeof squad === 'object' &&
    Array.isArray(squad[CHALLENGE_SQUAD_FIELDS.players])
  );
};

/**
 * Reads the challenge squad out of the loaded challenge payload, the SBC detail
 * panel argument and the live service containers.
 *
 * Property strategies mirror `resolveChallengeSubject`: they never guess, keep
 * an attempt record with a reason for every candidate tried, and return a null
 * payload when no candidate carries a `squad.players` array. The final
 * candidates call the search view model's active-squad definition-id request
 * through the observable bridge, because #51 showed EA's read methods return
 * observables rather than values.
 *
 * @param {*} subject the argument passed to `initWithSBCSet`
 * @param {object|undefined} [pageWindow] the page's `window`, needed for the
 *   `services.<Domain>` strategies
 * @param {object|null} [loadedPayload] the `loadChallengePayload` payload,
 *   whose `squad` is the first documented source
 * @param {{ observableTimeoutMs?: number, pacer?: object }} [options]
 *   `observableTimeoutMs` is injectable for tests; `pacer` is the queue every
 *   EA call runs through, defaulting to the shared paced queue (#52)
 * @returns {Promise<{ ok: boolean, payload: object|null, strategy: string|null,
 *   attempts: Array<{id: string, ok: boolean, reason: string|null,
 *   method?: object}> }>}
 */
export async function resolveChallengeSquad(
  subject,
  pageWindow,
  loadedPayload = null,
  options = {}
) {
  const timeoutMs = resolveTimeoutMs(options.observableTimeoutMs);
  const pacer = resolvePacer(options);
  const attempts = [];

  for (const strategy of CHALLENGE_SQUAD_STRATEGIES) {
    const attempt = { id: strategy.id, ok: false, reason: null };
    attempts.push(attempt);

    if (strategy.source === 'loaded') {
      if (carriesChallengeSquad(loadedPayload)) {
        attempt.ok = true;
        return { ok: true, payload: loadedPayload, strategy: strategy.id, attempts };
      }
      attempt.reason = 'the loaded challenge payload carries no squad.players array';
      continue;
    }

    if (strategy.method !== undefined) {
      const instance = resolveSearchViewModelInstance(pageWindow);
      if (!instance.ok) {
        attempt.reason = instance.reason;
        continue;
      }
      const found = findMethod(instance.value, strategy.method);
      if (!found.ok) {
        attempt.reason = describeMissingMethod(instance.name, strategy.method, found.reason);
        continue;
      }
      attempt.method = describeMethodShape(found.value);
      const call = await callReadMethod(found, instance.value, [], strategy.id, timeoutMs, {
        pacer,
        kind: CALL_KINDS.SQUAD_READ,
      });
      if (!call.ok) {
        attempt.reason = call.reason;
        continue;
      }
      const event = call.event;
      if (!carriesChallengeSquad(event.payload)) {
        attempt.reason = `returned no ${CHALLENGE_SQUAD_FIELDS.squad}.${CHALLENGE_SQUAD_FIELDS.players} array (got ${describeValue(
          event.payload
        )})`;
        continue;
      }
      attempt.ok = true;
      return { ok: true, payload: event.payload, strategy: strategy.id, attempts };
    }

    const resolved = readStrategyValue(subject, pageWindow, strategy);
    if (!resolved.ok) {
      attempt.reason = resolved.reason;
      continue;
    }
    if (!carriesChallengeSquad(resolved.value)) {
      attempt.reason = `${strategy.id.replace('panel-argument', 'panel argument')} has no ${
        CHALLENGE_SQUAD_FIELDS.squad
      }.${CHALLENGE_SQUAD_FIELDS.players} array`;
      continue;
    }
    attempt.ok = true;
    return { ok: true, payload: resolved.value, strategy: strategy.id, attempts };
  }

  return { ok: false, payload: null, strategy: null, attempts };
}
