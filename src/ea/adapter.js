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
 * rather than hardcoding numbers. Production calls `readEligibilityKeys()`; the
 * pinned observation table this used to ship with now lives in
 * `test/fixtures/eligibility-observation.js`, where `src/solver/` cannot reach
 * it. There is no fallback table in `src/`.
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
 * the numbers, so 0/1/2 is a model this project owns and pins. The capture
 * cross-check that supports it lives beside the pinned key observation in
 * `test/fixtures/eligibility-observation.js`.
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
 * The production entry point for the eligibility key table: reads EA's live
 * `SBCEligibilityKey` enum off the page's `window` and builds the descriptor
 * table from it plus `ELIGIBILITY_KEY_MODEL`. There is no fallback: a missing
 * or malformed global throws naming the EA symbol, and a live member the model
 * cannot name is left out of the table and reported in `unmodelled`.
 *
 * No live scope enum is verified in FC27, so `scopes` is `null`: the 0/1/2
 * scope mapping is an inference and the caller supplies it. Inventing a live
 * source for it would be a guess.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @returns {{ keys: object, scopes: null, members: Array<{eligibilityKey: number,
 *   type: string}>, unmodelled: Array<{eligibilityKey: number, type: string}> }}
 *   `keys` maps a live `eligibilityKey` number to the same descriptor shape the
 *   decoder consumes ({ type, kind, role, field? }); `members` is every enum
 *   member as read, for support reports
 * @throws {Error} when the global is missing, the enum is empty, or a member
 *   is malformed or ambiguous
 */
export function readEligibilityKeys(pageWindow) {
  const enumTable = requireEaGlobal(pageWindow, 'eligibilityKeys');
  const members = readEnumMembers(enumTable);

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
    keys[number] = Object.freeze(descriptor);
  }

  return Object.freeze({
    keys: Object.freeze(keys),
    scopes: null,
    members: Object.freeze(
      members.map(({ name, number }) => Object.freeze({ eligibilityKey: number, type: name }))
    ),
    unmodelled: Object.freeze(unmodelled),
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
    `FUT Squad Lab: ${EA_GLOBALS.eligibilityKeys}: ${keys.length} resolved [${keys.join(', ')}]`,
    resolved.unmodelled.length === 0
      ? 'unmodelled: none'
      : `unmodelled [${resolved.unmodelled.map(describeEligibilityEntry).join(', ')}]`,
  ];
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
 */
export const CHALLENGE_FIELDS = Object.freeze({
  challengeId: 'challengeId',
  name: 'name',
  formation: 'formation',
  operation: 'elgOperation',
  requirements: 'elgReq',
  setId: 'setId',
});

/** The raw `/club` response field that carries the item array. */
export const CLUB_ITEM_ARRAY_FIELD = 'itemData';

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

const readPageWindow = (pageWindow, name) => {
  if (pageWindow === null || pageWindow === undefined) return undefined;
  return pageWindow[name];
};

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
  const value = readPageWindow(pageWindow, EA_GLOBALS[key]);
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
 * True when a value is one of the two shapes a club read may return: the
 * documented `{ itemData: [...] }` envelope, or a bare item array.
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

/**
 * The ordered club-read strategies this bridge tries, most likely first.
 *
 * The #44 live shape report proved the instances live under `services.<Domain>`
 * (`services.Club.clubDao`, `services.Item.itemDao`, `services.SBC.repository`
 * and so on), never at `services.<ClassName>`. The chain therefore reaches the
 * proven instance paths first, then the repository search names the report
 * proved, then the legacy `services.UTSBCRepository` entry as a late fallback
 * for a page build that still exposes it, and finally the window classes, which
 * are refused as constructors because a class is not an instance.
 *
 * A `services` target that is not a key of `EA_GLOBALS` is read as a dot path
 * of raw EA names inside the service locator. Every attempt keeps its
 * `{id, ok, reason}` record rather than being silently dropped, and nothing
 * here invents a club size or an argument payload.
 */
export const CLUB_ITEM_STRATEGIES = Object.freeze([
  Object.freeze({ id: 'services.Club.clubDao.getClubItems', container: 'services', target: 'Club.clubDao', method: 'getClubItems' }),
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
 * Tries every club-read strategy in order and returns the first payload that
 * looks like club items.
 *
 * The result carries the winning strategy id and an attempt record for every
 * candidate tried, in order: `{ id, ok, reason }`. When nothing succeeds,
 * `items` is an empty array — never a guessed count — and every attempt's
 * reason names what was missing or wrong.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @returns {Promise<{ ok: boolean, items: Array<object>, strategy: string|null,
 *   attempts: Array<{id: string, ok: boolean, reason: string|null}> }>}
 */
export async function resolveClubItems(pageWindow) {
  const attempts = [];
  for (const strategy of CLUB_ITEM_STRATEGIES) {
    const attempt = { id: strategy.id, ok: false, reason: null };
    attempts.push(attempt);
    const base = resolveStrategyBase(pageWindow, strategy);
    if (!base.ok) {
      attempt.reason = base.reason;
      continue;
    }
    const method = base.value[strategy.method];
    if (typeof method !== 'function') {
      attempt.reason = `${base.name} has no ${strategy.method} method`;
      continue;
    }
    let result;
    try {
      result = await method.call(base.value);
    } catch (error) {
      const message = error !== null && typeof error === 'object' ? error.message : String(error);
      attempt.reason = `threw: ${message}`;
      continue;
    }
    if (!isClubPayload(result)) {
      attempt.reason = `returned no ${CLUB_ITEM_ARRAY_FIELD} array (got ${describeValue(result)})`;
      continue;
    }
    attempt.ok = true;
    return {
      ok: true,
      items: Array.isArray(result) ? result : result[CLUB_ITEM_ARRAY_FIELD],
      strategy: strategy.id,
      attempts,
    };
  }
  return { ok: false, items: [], strategy: null, attempts };
}

/**
 * Ordered strategies for reading the challenge payload out of the argument the
 * SBC detail panel receives and, when the argument carries none, out of the
 * live service containers the #44 shape report proved exist.
 *
 * The entry point is `initWithSBCSet`, but whether the argument is the
 * challenge itself, an entity wrapping `.data`, or a set carrying `.challenge`
 * is not documented, so the bridge feature-detects each shape and records which
 * one carried an `elgReq` array. The subject may be a `UTSBCSetEntity` whose
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
 * Reads the challenge payload out of the SBC detail panel argument, then out
 * of the live service containers.
 *
 * @param {*} subject the argument passed to `initWithSBCSet`
 * @param {object|undefined} [pageWindow] the page's `window`, needed for the
 *   `services.<Domain>` strategies
 * @returns {{ ok: boolean, payload: object|null, strategy: string|null,
 *   attempts: Array<{id: string, ok: boolean, reason: string|null}> }}
 */
export function resolveChallengeSubject(subject, pageWindow) {
  return resolveFirstStrategy(CHALLENGE_SUBJECT_STRATEGIES, subject, pageWindow, (value, label) => {
    if (typeof value !== 'object' || Array.isArray(value)) {
      return `${label} is not an object (got ${describeSubject(value)})`;
    }
    if (!Array.isArray(value[CHALLENGE_FIELDS.requirements])) {
      return `${label} has no ${CHALLENGE_FIELDS.requirements} array`;
    }
    return null;
  });
}

/**
 * Ordered strategies for reading the challenge *squad* payload out of the
 * argument the SBC detail panel receives and, when it carries none, out of the
 * `services.Squad` and `services.SBC` containers. The challenge definition and
 * the squad state may arrive on the same subject (the challenge read already
 * feature-detects `elgReq`), so this reader independently looks for the
 * `{ challengeId, squad: { players: [...] } }` wrapper the writer consumes. The
 * captured fixture `test/fixtures/sbs-challenge-25-squad.json` is that shape.
 */
export const CHALLENGE_SQUAD_STRATEGIES = Object.freeze([
  Object.freeze({ id: 'panel-argument', path: [] }),
  Object.freeze({ id: 'panel-argument.data', path: ['data'] }),
  Object.freeze({ id: 'panel-argument.challenge', path: ['challenge'] }),
  Object.freeze({ id: 'panel-argument.sbcChallenge', path: ['sbcChallenge'] }),
  Object.freeze({ id: 'services.Squad.activeSquad', container: 'services', target: 'Squad.activeSquad', path: [] }),
  Object.freeze({ id: 'services.Squad.activeSquad.data', container: 'services', target: 'Squad.activeSquad', path: ['data'] }),
  Object.freeze({ id: 'services.Squad.squadDao.activeSquad', container: 'services', target: 'Squad.squadDao', path: ['activeSquad'] }),
  Object.freeze({ id: 'services.SBC.repository.activeSquad', container: 'services', target: 'SBC.repository', path: ['activeSquad'] }),
  Object.freeze({ id: 'services.SBC.repository.challengeSquad', container: 'services', target: 'SBC.repository', path: ['challengeSquad'] }),
]);

const carriesChallengeSquad = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const squad = value[CHALLENGE_SQUAD_FIELDS.squad];
  return (
    squad !== null &&
    typeof squad === 'object' &&
    Array.isArray(squad[CHALLENGE_SQUAD_FIELDS.players])
  );
};

/**
 * Reads the challenge squad out of the SBC detail panel argument and the live
 * service containers. Mirrors `resolveChallengeSubject`: it never guesses,
 * returns the winning strategy id and an attempt record with a reason for every
 * candidate tried, and returns a null payload when no candidate carries a
 * `squad.players` array.
 *
 * @param {*} subject the argument passed to `initWithSBCSet`
 * @param {object|undefined} [pageWindow] the page's `window`, needed for the
 *   `services.<Domain>` strategies
 * @returns {{ ok: boolean, payload: object|null, strategy: string|null,
 *   attempts: Array<{id: string, ok: boolean, reason: string|null}> }}
 */
export function resolveChallengeSquad(subject, pageWindow) {
  return resolveFirstStrategy(CHALLENGE_SQUAD_STRATEGIES, subject, pageWindow, (value, label) => {
    if (carriesChallengeSquad(value)) return null;
    return `${label} has no ${CHALLENGE_SQUAD_FIELDS.squad}.${CHALLENGE_SQUAD_FIELDS.players} array`;
  });
}
