/**
 * The referee for a candidate squad: given the 11 items and the normalised
 * constraint set produced by `requirements.js`, decide whether the squad
 * satisfies the challenge. A bare `valid: false` is never the answer; every
 * failing constraint is reported as structured data, and a panel translates
 * that data into its own copy.
 *
 * ## Result contract
 *
 *   validateSquad(squad, constraints, options) -> {
 *     valid: boolean,    // true only when `failures` is empty
 *     failures: [{
 *       kind,        // stable solver kind, as emitted by requirements.js
 *       required,    // the constraint's value
 *       actual,      // the measured quantity
 *       shortfall,   // how far it must move; 0 when satisfied
 *       scope,       // GREATER | LOWER | EXACT
 *       match,       // the constraint's match object when present
 *       unverified,  // true when the measure behind the number is inferred
 *       diagnostic,  // { id, params } — see the vocabulary below
 *     }],
 *     unverified: [{
 *       kind,        // the kind whose requirement could not be checked
 *       required,    // the constraint's value
 *       scope,       // GREATER | LOWER | EXACT
 *       reason,      // machine-readable code explaining why, see below
 *       match,       // the constraint's match object when present
 *       diagnostic,  // { id, params } — see the vocabulary below
 *     }],
 *   }
 *
 * `shortfall` is `max(0, required - actual)` for GREATER, `max(0, actual -
 * required)` for LOWER and `Math.abs(actual - required)` for EXACT. A satisfied
 * constraint produces no `failures` entry.
 *
 * `valid: true` together with a non-empty `unverified` means "passes
 * everything we can check", NOT "guaranteed valid". The caveat is carried in
 * the result rather than hidden.
 *
 * ## Diagnostics are solver vocabulary, never panel copy
 *
 * Solver output is data. Every entry in `failures` and `unverified` carries a
 * machine-readable `diagnostic: { id, params }`. The `id` is the solver's own
 * stable vocabulary — not a copy key — and `params` holds the numbers a panel
 * inserts into its translated template. The UI layer owns the mapping from
 * `id` to panel copy; no sentence ever leaves this module.
 *
 * The complete, stable id set, with the kinds that emit it:
 *
 *   missing-leagues            { count }   LEAGUE_COUNT, SAME_LEAGUE_COUNT
 *   missing-nations            { count }   NATION_COUNT, SAME_NATION_COUNT
 *   missing-chemistry          { points }  CHEMISTRY_POINTS
 *   missing-rating             { points }  TEAM_RATING
 *   missing-clubs              { count }   CLUB_COUNT, SAME_CLUB_COUNT
 *   missing-players            { count }   PLAYER_COUNT_MATCH
 *   quality-not-checked        {}          PLAYER_QUALITY
 *   rating-formula-unverified  {}          TEAM_RATING (unverified)
 *   player-level-not-checked   {}          playerLevels match (unverified)
 *   chemistry-formula-unverified {}        CHEMISTRY_POINTS (unverified; also
 *                                          used when the payload did not state
 *                                          the position rule, whose distinct
 *                                          reason stays on the entry)
 *
 * `count` and `points` are the shortfall in the constraint's own unit. A new
 * measurable kind must be given an id here; `checkConstraint` throws instead
 * of emitting an entry without one.
 *
 * ## Chemistry is an input, never computed here
 *
 * `CHEMISTRY_POINTS` reads `squad.chemistry`, which has two accepted forms:
 *
 *   a finite number                  an already-verified chemistry total
 *                                    (issue #13 supplies EA's own number this
 *                                    way)
 *   { chemistry, verified, reason }  the result object from `squadChemistry` in
 *                                    `chemistry.js`
 *
 * The chemistry model lives in issue #5 and this module must not import it; it
 * only reads the status the caller passes. When the object says
 * `verified: false`, the CHEMISTRY_POINTS requirement is reported in
 * `unverified` with the object's own reason and is never measured: a computed
 * formula must not approve a constraint. Two reason codes are accepted:
 * `chemistry-formula-unverified` for the computed formula and
 * `chemistry-position-flag-missing` for a payload that did not state whether
 * full chemistry needs the preferred position. Both map to the same diagnostic
 * id; the reason stays on the entry, so the two remain distinguishable. The
 * established exception is a caller-supplied
 * `options.measures.CHEMISTRY_POINTS`, which counts as verified by the caller
 * exactly like a TEAM_RATING override, since the caller takes responsibility
 * for what it measures.
 *
 * The object form is validated strictly, from its own fields only: a missing
 * or inherited `chemistry`, `verified` or `reason`, a non-finite `chemistry`,
 * a non-boolean `verified`, a verified object whose `reason` is not `null`, an
 * unverified object whose `reason` is not one of the known reason codes, or a
 * chemistry value that is neither a finite number nor a plain object throws. A
 * missing chemistry input is a caller bug, and a plausible-looking wrong
 * answer is worse than a loud failure.
 *
 * `squad.chemistry` is read at most once per `validateSquad` call. One
 * snapshot taken at the first read feeds both the reason decision and the
 * measured value, so a chemistry object whose fields change between reads
 * (a Proxy, for example) cannot let a failing total satisfy the constraint.
 * This is the same TOCTOU class `snapshotMeasureEntries` removes for
 * `options.measures`.
 *
 * ## Unverified semantics are flagged, never invented
 *
 * `PLAYER_QUALITY` is an opaque integer; how EA aggregates card tiers across a
 * squad is UNVERIFIED, so it is never measured, never appears in `failures`,
 * and is always reported in `unverified`. Supplying
 * `options.measures.PLAYER_QUALITY` throws: a custom aggregation function would
 * silently turn an unverified assumption into a gate (decision recorded on
 * issue #2, tracked by issue #16).
 *
 * `PLAYER_COUNT_MATCH` with a `playerLevels` match is treated the same way.
 * The match was once wired to an item rarity flag, but `docs/PLAN.md`
 * documents that flag as rarity data, not player level, and no fixture proves
 * which item field the player level requirement reads. A guessed gate can
 * produce both a false valid and a false invalid, so the match is never
 * measured — even when the caller overrides `PLAYER_COUNT_MATCH` — and is
 * reported in `unverified` instead. The remaining match fields read verified
 * item fields: `nationIds` -> `nationId`, `leagueIds` -> `leagueId`,
 * `clubIds` -> `clubId`.
 *
 * `TEAM_RATING` is measured as the rounded mean of the 11 item ratings by
 * `meanRating` below. EA's real formula is not provably a plain mean, so every
 * default TEAM_RATING result is flagged `unverified: true`. `meanRating` is one
 * isolated function so the formula is one line to swap once issue #13 can
 * compare against EA's own display. A caller-supplied measure counts as
 * verified — the caller takes responsibility for the formula — and the kind
 * leaves `unverified`.
 *
 * A measure — default or override — must return a finite number. `Infinity`
 * could satisfy a GREATER constraint and turn a broken measurement into a false
 * `valid`, so a non-finite result throws instead.
 *
 * ## Club links are optional input
 *
 * `options.clubLinks` is either a `(clubId) => canonicalClubId` function or a
 * `Map` of clubId to canonical id. It is used only by `SAME_CLUB_COUNT`: when
 * supplied, linked clubs count as one club. When it is not supplied, clubId is
 * used literally. That links affect EA's "same club" count is an inference (see
 * `test/fixtures/chemistry-teamlinks.json`), and `CLUB_COUNT` plus the
 * `clubIds` match deliberately stay on the literal clubId because no evidence
 * says links apply there. Never hardcode a link table in the solver.
 *
 * ## Item field contract
 *
 * Players carry the stable item schema owned by `src/ea/adapter.js`:
 * `{ id, rating, nationId, leagueId, clubId, rarity, untradeable }`. The
 * adapter's `normaliseClubItem` is the only code that knows the raw `/club`
 * payload shape; this module reads `id`, `rating`, `nationId`, `leagueId` and
 * `clubId`, never a raw EA field name. Every player must carry those five
 * fields as finite numbers, and the eleven `id` values must be distinct:
 * anything else throws at the entry, so an un-normalised raw item — or a squad
 * that repeats one item eleven times — is rejected instead of silently
 * validated.
 *
 * The squad must contain exactly 11 players: EA's SBC squads are 11-slot
 * squads, and a partial squad would let a single player satisfy a count
 * requirement that the real challenge could never accept.
 *
 * This module is pure: plain data in, plain data out. No DOM, no chrome APIs,
 * no network, no knowledge of HTTP or EA class names.
 */

const SCOPE_OPERATORS = Object.freeze(['GREATER', 'LOWER', 'EXACT']);

/** Kinds that are never measured because what EA means by them is unverified. */
const UNVERIFIED_ONLY_KINDS = new Set(['PLAYER_QUALITY']);

/** Machine-readable reasons a requirement lands in `unverified`. */
const UNVERIFIED_REASONS = Object.freeze({
  PLAYER_QUALITY: 'player-quality-aggregation-unverified',
  TEAM_RATING: 'team-rating-formula-unverified',
  PLAYER_LEVELS: 'player-level-field-unverified',
  CHEMISTRY_FORMULA: 'chemistry-formula-unverified',
  CHEMISTRY_POSITION_FLAG: 'chemistry-position-flag-missing',
});

/**
 * Match field -> the verified item field the values are matched against.
 * A decoded constraint may also carry `playerLevels`, listed in
 * UNMEASURED_MATCH_FIELDS below: the item field behind the player level
 * requirement is unverified, so a match on it is reported in `unverified`
 * instead of becoming a guessed gate. See the header.
 */
const MATCH_FIELDS = Object.freeze({
  nationIds: (player) => player.nationId,
  leagueIds: (player) => player.leagueId,
  clubIds: (player) => player.clubId,
});

/**
 * Match fields a decoded constraint may carry even though no verified measure
 * exists for them; the default PLAYER_COUNT_MATCH measure rejects them.
 */
const UNMEASURED_MATCH_FIELDS = new Set(['playerLevels']);

/**
 * Failure kind -> the stable diagnostic id a panel maps to its own copy.
 * Every measurable kind must be listed; `checkConstraint` throws for a kind
 * that is not, so a new requirement cannot silently lose its diagnostic.
 */
const FAILURE_DIAGNOSTIC_IDS = Object.freeze({
  CHEMISTRY_POINTS: 'missing-chemistry',
  CLUB_COUNT: 'missing-clubs',
  SAME_CLUB_COUNT: 'missing-clubs',
  LEAGUE_COUNT: 'missing-leagues',
  SAME_LEAGUE_COUNT: 'missing-leagues',
  NATION_COUNT: 'missing-nations',
  SAME_NATION_COUNT: 'missing-nations',
  PLAYER_COUNT_MATCH: 'missing-players',
  TEAM_RATING: 'missing-rating',
});

/**
 * Kinds whose diagnostic number is a quantity in its own unit (`points`)
 * rather than a countable shortfall (`count`).
 */
const QUANTITY_DIAGNOSTIC_PARAMS = Object.freeze({
  CHEMISTRY_POINTS: 'points',
  TEAM_RATING: 'points',
});

/** Unverified reason -> the stable diagnostic id a panel maps to its own copy. */
const UNVERIFIED_DIAGNOSTIC_IDS = Object.freeze({
  [UNVERIFIED_REASONS.PLAYER_QUALITY]: 'quality-not-checked',
  [UNVERIFIED_REASONS.TEAM_RATING]: 'rating-formula-unverified',
  [UNVERIFIED_REASONS.PLAYER_LEVELS]: 'player-level-not-checked',
  [UNVERIFIED_REASONS.CHEMISTRY_FORMULA]: 'chemistry-formula-unverified',
  [UNVERIFIED_REASONS.CHEMISTRY_POSITION_FLAG]: 'chemistry-formula-unverified',
});

/**
 * Every reason code this validator knows. A chemistry object that reports
 * `verified: false` must carry one of these: a free-form string cannot be
 * translated to a diagnostic, and a plausible-looking wrong reason must not
 * pass. The chemistry reasons are then filtered further below, because a known
 * reason from another domain still cannot describe a chemistry result.
 */
const KNOWN_UNVERIFIED_REASONS = new Set(Object.values(UNVERIFIED_REASONS));

const fail = (message) => {
  throw new Error(`validateSquad: ${message}`);
};

/** True for a non-null, non-array object; the shape every plain-data argument must have. */
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const distinctCount = (players, read) => new Set(players.map(read)).size;

const largestGroup = (players, read) => {
  const counts = new Map();
  for (const player of players) {
    const key = read(player);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let largest = 0;
  for (const count of counts.values()) {
    if (count > largest) largest = count;
  }
  return largest;
};

/**
 * Default TEAM_RATING measure: the rounded arithmetic mean of the player
 * ratings. EA's real formula is not verified to be a plain mean, so results
 * computed with this function are reported as unverified. Isolated so the swap
 * is one line.
 */
const meanRating = (squad) =>
  Math.round(squad.players.reduce((sum, player) => sum + player.rating, 0) / squad.players.length);

/**
 * Reads `squad.chemistry` in either supported form and returns `{ value }` for
 * a verified total or `{ reason }` for an explicit unverified result.
 *
 * The object form is read from one snapshot of its own fields taken at entry:
 * only own string-named properties are consulted, never an inherited field, so
 * an object that merely inherits `chemistry` or `verified` cannot be approved.
 * The shape is strict: own finite `chemistry`, own boolean `verified`, own
 * `reason`. A verified object must carry `reason: null` — a reason next to
 * `verified: true` is a contradiction — and an unverified object must carry
 * one of the known reason codes, not a free-form string. Anything else throws:
 * see the chemistry section of the header.
 */
const readChemistryStatus = (chemistry) => {
  if (Number.isFinite(chemistry)) return { value: chemistry };
  if (!isPlainObject(chemistry)) {
    fail(
      'squad.chemistry must be a finite number to check CHEMISTRY_POINTS, received' +
        ` ${String(chemistry)}`
    );
  }

  const ownFields = new Map(
    Object.getOwnPropertyNames(chemistry).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(chemistry, key).value,
    ])
  );

  if (!ownFields.has('chemistry')) {
    fail(
      'squad.chemistry must carry its own finite chemistry field; an inherited or prototype value' +
        ' is not accepted'
    );
  }
  const value = ownFields.get('chemistry');
  if (!Number.isFinite(value)) {
    fail(
      'squad.chemistry.chemistry must be a finite number to check CHEMISTRY_POINTS, received' +
        ` ${String(value)}`
    );
  }

  if (!ownFields.has('verified')) {
    fail(
      'squad.chemistry must carry its own verified boolean; an inherited or prototype value is' +
        ' not accepted'
    );
  }
  const verified = ownFields.get('verified');
  if (typeof verified !== 'boolean') {
    fail(
      'squad.chemistry.verified must be a boolean so a computed result states whether it is' +
        ' verified'
    );
  }

  const reason = ownFields.get('reason');
  if (verified === true) {
    if (reason !== null) {
      fail(
        'squad.chemistry.reason must be null when verified is true, received' +
          ` ${JSON.stringify(reason)}`
      );
    }
    return { value };
  }

  if (typeof reason !== 'string' || reason.length === 0) {
    fail('squad.chemistry.reason must be a non-empty string when verified is false');
  }
  if (!KNOWN_UNVERIFIED_REASONS.has(reason)) {
    fail(
      `squad.chemistry.reason ${JSON.stringify(
        reason
      )} is not a known unverified reason and cannot map for CHEMISTRY_POINTS`
    );
  }
  return { reason };
};

/**
 * Pure measure functions, `(squad, constraint, context) => number`. `context`
 * carries `clubIdentity(clubId)`, which is the literal clubId unless the caller
 * supplied `options.clubLinks`. Override any entry through `options.measures`;
 * `PLAYER_QUALITY` is rejected there because it has no verified measure.
 *
 * This is a low-level primitive: every measure assumes an already-validated
 * squad. Calling one directly bypasses the schema checks, the 11-player
 * contract and the unique-id check, so it can return a number for a squad that
 * `validateSquad` would reject. Production code must go through
 * `validateSquad`; this export exists for tests and tools.
 */
export const MEASURES = Object.freeze({
  CHEMISTRY_POINTS: (squad) => {
    const status = readChemistryStatus(squad.chemistry);
    if (status.reason !== undefined) {
      fail(
        `squad.chemistry is computed and unverified (reason ${JSON.stringify(status.reason)});` +
          ' validateSquad reports it in `unverified` and never measures it as a satisfied' +
          ' requirement'
      );
    }
    return status.value;
  },

  CLUB_COUNT: (squad) => distinctCount(squad.players, (player) => player.clubId),

  LEAGUE_COUNT: (squad) => distinctCount(squad.players, (player) => player.leagueId),

  NATION_COUNT: (squad) => distinctCount(squad.players, (player) => player.nationId),

  SAME_CLUB_COUNT: (squad, constraint, context) =>
    largestGroup(squad.players, (player) => context.clubIdentity(player.clubId)),

  SAME_LEAGUE_COUNT: (squad) => largestGroup(squad.players, (player) => player.leagueId),

  SAME_NATION_COUNT: (squad) => largestGroup(squad.players, (player) => player.nationId),

  PLAYER_COUNT_MATCH: (squad, constraint) => {
    const { field, values } = readMatch(constraint.match, '-');
    const read = MATCH_FIELDS[field];
    if (read === undefined) {
      fail(
        `the match field ${JSON.stringify(field)} cannot be measured: no verified item field` +
          ' exists for it'
      );
    }
    const wanted = new Set(values);
    return squad.players.filter((player) => wanted.has(read(player))).length;
  },

  TEAM_RATING: meanRating,
});

/**
 * Every own string key of `object`, including non-enumerable own properties.
 * Match validation uses this set, so a non-enumerable field cannot pass
 * validation and then be lost from the match object the result carries.
 */
const ownStringKeys = (object) => Object.getOwnPropertyNames(object);

/**
 * Reads `options.measures` exactly once: every own string key — enumerable or
 * not — with the value it held at snapshot time. The same snapshot feeds
 * validation, merge and the caller-verified decision in `validateSquad`, so a
 * measure table whose own keys change between reads (a Proxy, for example)
 * cannot produce a result that depends on how many times it was read.
 */
const snapshotMeasureEntries = (measures) => {
  if (measures === undefined) return [];
  if (!isPlainObject(measures)) {
    fail('options.measures must be an object mapping kind to a measure function');
  }
  return ownStringKeys(measures).map((kind) => [
    kind,
    Object.getOwnPropertyDescriptor(measures, kind).value,
  ]);
};

/** Rejects holes so a sparse array cannot be silently skipped by `every`/`forEach`. */
const requireDense = (values, label) => {
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index)) {
      fail(`${label} must not contain holes (index ${index} is missing)`);
    }
  }
};

const ITEM_NUMERIC_FIELDS = Object.freeze(['id', 'rating', 'nationId', 'leagueId', 'clubId']);

const requirePlayer = (player, index) => {
  if (!isPlainObject(player)) {
    fail(`squad.players[${index}] must be an item object`);
  }
  for (const field of ITEM_NUMERIC_FIELDS) {
    if (!Number.isFinite(player[field])) {
      fail(
        `squad.players[${index}].${field} must be a finite number; normalise raw club items` +
          ' through normaliseClubItem first'
      );
    }
  }
};

/**
 * The same item may appear at most once. Eleven copies of one item satisfy
 * every count numerically, so without this check a duplicate squad would pass
 * validation even though the real challenge could never accept it.
 */
const requireUniqueIds = (players) => {
  const seen = new Set();
  const duplicates = new Set();
  for (const player of players) {
    if (seen.has(player.id)) duplicates.add(player.id);
    seen.add(player.id);
  }
  if (duplicates.size > 0) {
    fail(
      'squad.players item ids must be unique; duplicated: ' +
        [...duplicates].sort((left, right) => left - right).join(', ')
    );
  }
};

const requireSquad = (squad) => {
  if (!isPlainObject(squad)) {
    fail('squad must be an object with a players array');
  }
  if (!Array.isArray(squad.players)) {
    fail('squad.players must be an array of item objects');
  }
  if (squad.players.length !== 11) {
    fail(
      `squad.players must contain exactly 11 players, received ${squad.players.length}`
    );
  }
  requireDense(squad.players, 'squad.players');
  squad.players.forEach(requirePlayer);
  requireUniqueIds(squad.players);
};

const requireOptions = (options) => {
  if (!isPlainObject(options)) {
    fail('options must be an object when supplied');
  }
};

const resolveMeasures = (measureEntries) => {
  // The snapshot was read once at the entry to `validateSquad`; validation and
  // merge below walk the same entries, so the override applied is the same one
  // that was validated.
  const measures = { ...MEASURES };
  for (const [kind, measure] of measureEntries) {
    if (typeof measure !== 'function') {
      fail(`options.measures.${kind} must be a function`);
    }
    if (kind === 'PLAYER_QUALITY') {
      fail(
        'options.measures.PLAYER_QUALITY is not allowed: how EA aggregates card tiers across a' +
          ' squad is unverified (issues #2 and #16), so PLAYER_QUALITY is always reported in' +
          ' `unverified` and never measured'
      );
    }
    if (!Object.hasOwn(MEASURES, kind)) {
      fail(`options.measures.${kind} does not name a known measure kind`);
    }
    measures[kind] = measure;
  }
  return measures;
};

const createClubIdentity = (clubLinks) => {
  if (clubLinks === undefined) return (clubId) => clubId;
  if (typeof clubLinks === 'function') return (clubId) => clubLinks(clubId) ?? clubId;
  if (clubLinks instanceof Map) return (clubId) => clubLinks.get(clubId) ?? clubId;
  return fail('options.clubLinks must be a function or a Map when supplied');
};

/**
 * Validates a constraint's match object and returns the single field it names.
 * The constraints emitted by `requirements.js` always carry exactly one field
 * (see `buildPlayerCountConstraint`); anything else is malformed input and is
 * rejected rather than guessed at.
 */
const readMatch = (match, index) => {
  if (!isPlainObject(match)) {
    fail(`constraint ${index} match must be an object`);
  }

  const fields = ownStringKeys(match);
  if (fields.length !== 1) {
    fail(`constraint ${index} match must name exactly one field, received ${fields.length}`);
  }

  const [field] = fields;
  if (!Object.hasOwn(MATCH_FIELDS, field) && !UNMEASURED_MATCH_FIELDS.has(field)) {
    fail(`constraint ${index} has an unsupported match field ${JSON.stringify(field)}`);
  }

  const values = match[field];
  if (!Array.isArray(values) || values.length === 0) {
    fail(`constraint ${index} match.${field} must be a non-empty array of numbers`);
  }
  requireDense(values, `constraint ${index} match.${field}`);
  for (const value of values) {
    if (!Number.isFinite(value)) {
      fail(`constraint ${index} match.${field} must contain only finite numbers`);
    }
  }

  return { field, values };
};

const requireConstraint = (constraint, index) => {
  if (!isPlainObject(constraint)) {
    fail(`constraint ${index} must be an object`);
  }
  if (typeof constraint.kind !== 'string' || constraint.kind.length === 0) {
    fail(`constraint ${index} must carry a string kind`);
  }
  if (!SCOPE_OPERATORS.includes(constraint.scope)) {
    fail(`Unknown scope ${JSON.stringify(constraint.scope)} on constraint ${index}`);
  }
  if (!Number.isFinite(constraint.value)) {
    fail(`constraint ${index} required value must be a finite number`);
  }
  if (constraint.kind === 'PLAYER_COUNT_MATCH' && constraint.match === undefined) {
    fail(`constraint ${index} is PLAYER_COUNT_MATCH and must carry a match object`);
  }
  if (constraint.match !== undefined) {
    if (constraint.kind !== 'PLAYER_COUNT_MATCH') {
      fail(
        `constraint ${index} (${constraint.kind}) must not carry a match object; only` +
          ' PLAYER_COUNT_MATCH supports a match'
      );
    }
    readMatch(constraint.match, index);
  }
};

const isPlayerLevelMatch = (constraint) =>
  constraint.kind === 'PLAYER_COUNT_MATCH' && Object.hasOwn(constraint.match, 'playerLevels');

const unverifiedEntry = (constraint, reason) => {
  const entry = {
    kind: constraint.kind,
    required: constraint.value,
    scope: constraint.scope,
    reason,
    diagnostic: { id: UNVERIFIED_DIAGNOSTIC_IDS[reason], params: {} },
  };
  if (constraint.match !== undefined) entry.match = constraint.match;
  return entry;
};

/**
 * Compares one measured quantity against its constraint. Returns a failure
 * object, or null when the constraint is satisfied — including the boundary
 * where the measured value equals the required value, which passes under all
 * three scopes.
 */
const checkConstraint = (constraint, actual, unverified) => {
  const { kind, value: required, scope } = constraint;

  let shortfall;
  if (scope === 'GREATER') {
    if (actual >= required) return null;
    shortfall = required - actual;
  } else if (scope === 'LOWER') {
    if (actual <= required) return null;
    shortfall = actual - required;
  } else {
    if (actual === required) return null;
    shortfall = Math.abs(actual - required);
  }

  const diagnosticId = FAILURE_DIAGNOSTIC_IDS[kind];
  if (diagnosticId === undefined) {
    fail(`no diagnostic id for failure kind ${JSON.stringify(kind)}`);
  }
  const param = QUANTITY_DIAGNOSTIC_PARAMS[kind] ?? 'count';

  return {
    kind,
    required,
    actual,
    shortfall,
    scope,
    match: constraint.match,
    unverified,
    diagnostic: { id: diagnosticId, params: { [param]: shortfall } },
  };
};

/**
 * @param {{ players: Array<object>, chemistry: number|{ chemistry: number,
 *   verified: boolean, reason: string|null } }} squad
 * @param {Array<object>} constraints normalised constraints from `requirements.js`
 * @param {{ measures?: object, clubLinks?: Function|Map }} [options]
 * @returns {{ valid: boolean, failures: Array<object>, unverified: Array<object> }}
 */
export function validateSquad(squad, constraints, options = {}) {
  requireSquad(squad);
  requireOptions(options);

  // `options.measures` is read exactly once, here at the entry, before any
  // step can consume it. Validation of forbidden and unknown kinds, the merge
  // of overrides and the `callerVerified` decision all use this snapshot, so a
  // measure table whose own keys change between reads (a Proxy, for example)
  // cannot yield a result that depends on how many times it was read.
  const measureEntries = snapshotMeasureEntries(options.measures);

  if (!Array.isArray(constraints)) {
    fail('constraints must be an array');
  }
  requireDense(constraints, 'constraints');

  // The constraint vocabulary is checked before the captured overrides are
  // merged in: an unknown kind must throw no matter which overrides the caller
  // supplied, so a misspelled requirement can never be measured by accident.
  constraints.forEach((constraint, index) => {
    requireConstraint(constraint, index);
    if (!Object.hasOwn(MEASURES, constraint.kind) && !UNVERIFIED_ONLY_KINDS.has(constraint.kind)) {
      fail(
        `Unknown constraint kind ${JSON.stringify(constraint.kind)} on constraint ${index}; a` +
          ' requirement must never be silently dropped'
      );
    }
  });

  const measures = resolveMeasures(measureEntries);
  const callerKeys = new Set(measureEntries.map(([kind]) => kind));
  const context = { clubIdentity: createClubIdentity(options.clubLinks) };
  const failures = [];
  const unverified = [];

  // `squad.chemistry` is read at most once, lazily, the first time a
  // CHEMISTRY_POINTS constraint without a caller override needs it. The same
  // snapshot decides both the unverified reason below and the measured value,
  // so a chemistry object whose fields change between reads (a Proxy, for
  // example) cannot let a failing total satisfy the constraint. This is the
  // same TOCTOU class that `snapshotMeasureEntries` removes for
  // `options.measures`.
  let chemistryStatus;

  constraints.forEach((constraint, index) => {
    const { kind } = constraint;

    if (UNVERIFIED_ONLY_KINDS.has(kind)) {
      // No verified measure exists for PLAYER_QUALITY, and resolveMeasures
      // rejects any caller attempt to supply one.
      unverified.push(unverifiedEntry(constraint, UNVERIFIED_REASONS.PLAYER_QUALITY));
      return;
    }
    if (isPlayerLevelMatch(constraint)) {
      // Never measured, even when the caller overrides PLAYER_COUNT_MATCH:
      // the item field behind the player level requirement is unverified. See
      // the header.
      unverified.push(unverifiedEntry(constraint, UNVERIFIED_REASONS.PLAYER_LEVELS));
      return;
    }

    // A caller-supplied measure counts as verified by the caller; the default
    // table's inferred kinds stay flagged. The same snapshot used for
    // validation and merge decides this, so the steps cannot diverge.
    const callerVerified = callerKeys.has(kind);

    const inferredMeasure = kind === 'TEAM_RATING' && !callerVerified;
    if (inferredMeasure) {
      unverified.push(unverifiedEntry(constraint, UNVERIFIED_REASONS.TEAM_RATING));
    }

    let actual;
    if (kind === 'CHEMISTRY_POINTS' && !callerVerified) {
      chemistryStatus ??= readChemistryStatus(squad.chemistry);
      const { reason, value } = chemistryStatus;
      if (reason !== undefined) {
        if (
          reason !== UNVERIFIED_REASONS.CHEMISTRY_FORMULA &&
          reason !== UNVERIFIED_REASONS.CHEMISTRY_POSITION_FLAG
        ) {
          fail(
            `squad.chemistry carries the unverified reason ${JSON.stringify(
              reason
            )}, which this module cannot map for CHEMISTRY_POINTS`
          );
        }
        // A computed formula must never approve the constraint: report it and
        // skip the measure entirely, so the unverified number cannot pass.
        // The entry keeps the producer's specific reason, so a missing
        // position flag stays distinguishable from the formula marker.
        unverified.push(unverifiedEntry(constraint, reason));
        return;
      }
      actual = value;
    } else {
      actual = measures[kind](squad, constraint, context);
    }
    if (!Number.isFinite(actual)) {
      fail(
        `measure for ${kind} on constraint ${index} must return a finite number, received` +
          ` ${actual}`
      );
    }

    const failure = checkConstraint(constraint, actual, inferredMeasure);
    if (failure !== null) failures.push(failure);
  });

  return { valid: failures.length === 0, failures, unverified };
}
