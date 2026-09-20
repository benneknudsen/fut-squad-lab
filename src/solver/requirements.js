/**
 * Decodes the raw `elgReq[]` entries of an FC27 SBC challenge into a normalised
 * constraint set that the rest of the solver can consume.
 *
 * The payload is the classic SBC requirement model: every entry is
 * `{ type, eligibilitySlot, eligibilityKey, eligibilityValue }`. Entries that
 * share an `eligibilitySlot` describe one requirement; the numeric
 * `eligibilityKey` is authoritative and `type` is only cross-checked against it,
 * because EA renamed type strings between game versions while the numbers stayed
 * stable. One slot describes exactly one requirement.
 *
 * This module knows no EA key numbers or type names. The caller supplies two
 * lookup tables that carry all EA-specific knowledge. In production the browser
 * half resolves them from the live page (`readEligibilityKeys` in
 * `src/ea/adapter.js`, the one file that owns EA naming); tests supply the
 * pinned observation tables that ship as test data beside the captured
 * fixtures.
 *
 *   keys    eligibilityKey -> { type, kind, role, field? }
 *             type           the payload's `type` string for that key. Used only
 *                            to cross-check the payload; never emitted.
 *             kind           the stable internal solver kind emitted on the
 *                            constraint. The vocabulary is owned by the adapter;
 *                            this module never emits EA's volatile type strings.
 *             role 'count'   the squad-size quantity of a scoped player match
 *             role 'match'   a nation/league/club/level a 'count' applies to
 *             role 'scalar'  a standalone quantity requirement
 *             role 'scope'   the comparison operator for the slot
 *   scopes  eligibilityValue -> comparison operator name, e.g. 2 -> 'EXACT'
 *
 * Both tables are required; there is no built-in fallback. Without them the
 * decoder cannot know what a key means, so it fails instead of guessing. A
 * mapped scope must be a non-empty operator string: a malformed mapping is a
 * caller bug and is rejected, not passed through as an undefined scope.
 *
 * A scope entry is not a constraint of its own: it is the comparison operator
 * for whichever requirement shares its slot. The comparison semantics
 * (`GREATER` means the measured quantity must be >= the value, `LOWER` <=,
 * `EXACT` ===) and the provenance of the scope numbers are documented beside
 * the pinned scope table in the test data. A name the caller's table supplies
 * is matched loosely (`minimum`, `MIN` and `GREATER` all mean a minimum;
 * `maximum`, `MAX`, `LOWER` and `LESS` all mean a maximum) and canonicalised
 * when it is one of the four known operators; an unknown name is passed through
 * unchanged. A slot with **no** scope entry takes `DEFAULT_SCOPE`, the minimum
 * operator: EA treats a count with no scope as "at least N", never "exactly N".
 *
 * A raw entry may carry EA's own `count` field. A `count` of `-1` is a sentinel,
 * not a requirement of minus one: it marks the target as living in the entry's
 * `eligibilityValue`, and a bare `-1` (as count or as value) fails naming the
 * sentinel rather than decoding. A count of `0` or more is validated but does
 * not replace the value, because the flattened `elgReq` entry's
 * `eligibilityValue` is the target the rest of this module emits.
 *
 * A descriptor may carry a `classify` tag; `PLAYER_RARITY_GROUP` values are
 * resolved through the adapter's `decodeRarityGroup` because the same key can
 * mean a geographic region, TOTS or TOTW-or-TOTS. An undecodable value fails
 * loudly with the key named.
 *
 * `PLAYER_QUALITY` is passed through as opaque scoped data: the constraint
 * carries `kind`, `value` and `scope` faithfully, and this module assumes no
 * tier domain, because the fixtures only ever observe values 1, 2 and 3 and that
 * enum is not verified complete. How EA aggregates tiers across a squad is also
 * UNVERIFIED — the GREATER/LOWER/EXACT tiers may combine into a floor, a
 * ceiling, a single-tier rule or something else — and must be settled against
 * EA's own challenge display before `validate.js` (issue #2) implements it.
 *
 * Only keys present in the supplied mapping are accepted. EA's client enum
 * contains more keys (rarity, minimum rating, team star rating, ...); any key
 * outside the table raises instead of being silently dropped, so a missed
 * requirement can never produce a squad the game rejects.
 *
 * This module is pure: plain data in, plain data out. No DOM, no chrome APIs,
 * no network, no knowledge of HTTP or EA class names.
 */

import {
  RARITY_GROUP_CLASSIFIER,
  RARITY_GROUP_MEANINGS,
  decodeRarityGroup,
  decodeScopeName,
} from '../ea/adapter.js';

const ROLES = Object.freeze({
  COUNT: 'count',
  MATCH: 'match',
  SCALAR: 'scalar',
  SCOPE: 'scope',
});

const KNOWN_ROLES = new Set(Object.values(ROLES));

const DEFAULT_OPERATION = 'AND';

/**
 * The comparison a requirement takes when its slot carries no SCOPE entry. EA's
 * model treats a count with no scope as "at least N", so the default is the
 * minimum operator, never "exactly N". Exported so callers and tests can name
 * the default instead of re-spelling it.
 */
export const DEFAULT_SCOPE = 'GREATER';

const fail = (message) => {
  throw new Error(`normaliseRequirements: ${message}`);
};

const isMapping = (value) => value !== null && typeof value === 'object';

const requireEntries = (elgReq) => {
  if (!Array.isArray(elgReq)) {
    fail(`elgReq must be an array, received ${elgReq === null ? 'null' : typeof elgReq}`);
  }
  for (const entry of elgReq) {
    if (entry === null || typeof entry !== 'object') {
      fail('elgReq entries must be objects');
    }
  }
};

const requireOptions = (options) => {
  if (!isMapping(options)) {
    fail('an options object with the keys and scopes mappings is required');
  }
  if (!isMapping(options.keys)) {
    fail('the keys mapping is required and must be an object');
  }
  if (!isMapping(options.scopes)) {
    fail('the scopes mapping is required and must be an object');
  }
  return { keys: options.keys, scopes: options.scopes };
};

const decodeEntry = (entry, index, keys) => {
  const { type, eligibilitySlot, eligibilityKey, eligibilityValue } = entry;

  if (!Number.isInteger(eligibilitySlot) || eligibilitySlot < 1) {
    fail(`entry ${index} has an invalid eligibilitySlot: ${eligibilitySlot}`);
  }
  if (!Number.isInteger(eligibilityKey) || !Object.hasOwn(keys, eligibilityKey)) {
    fail(
      `Unknown eligibilityKey ${JSON.stringify(eligibilityKey)} in eligibilitySlot` +
        ` ${eligibilitySlot} (type ${JSON.stringify(type)})`
    );
  }

  const descriptor = keys[eligibilityKey];
  if (!KNOWN_ROLES.has(descriptor.role)) {
    fail(
      `eligibilityKey ${eligibilityKey} has unsupported role "${descriptor.role}" in the keys mapping`
    );
  }
  if (descriptor.role === ROLES.MATCH && typeof descriptor.field !== 'string') {
    fail(`eligibilityKey ${eligibilityKey} is a match key without a field in the keys mapping`);
  }
  if (typeof descriptor.kind !== 'string' || descriptor.kind.length === 0) {
    fail(`eligibilityKey ${eligibilityKey} has no stable kind in the keys mapping`);
  }
  if (typeof type !== 'string' || type.length === 0) {
    fail(`entry ${index} in eligibilitySlot ${eligibilitySlot} has no type string`);
  }
  if (type !== descriptor.type) {
    fail(
      `eligibilityKey ${eligibilityKey} is ${descriptor.type}, but the payload claims "${type}"`
    );
  }
  if (!Number.isInteger(eligibilityValue)) {
    fail(
      `eligibilityValue for ${descriptor.kind} in eligibilitySlot ${eligibilitySlot}` +
        ` must be an integer, received ${eligibilityValue}`
    );
  }
  if (entry.count !== undefined && (!Number.isInteger(entry.count) || entry.count < -1)) {
    fail(
      `entry ${index} in eligibilitySlot ${eligibilitySlot} carries an invalid count` +
        ` ${JSON.stringify(entry.count)}`
    );
  }
  // EA's -1 sentinel: a count of -1 means "the target lives in the value, not in
  // the count", so a positive eligibilityValue supplies it. A bare -1 anywhere
  // (count or value) is never a requirement of minus one, and fails naming the
  // sentinel instead of being emitted.
  if ((entry.count === -1 || eligibilityValue === -1) && eligibilityValue <= 0) {
    fail(
      `entry ${index} in eligibilitySlot ${eligibilitySlot} carries the -1 sentinel` +
        ` (count ${JSON.stringify(entry.count)}, eligibilityValue ${JSON.stringify(
          eligibilityValue
        )}); the target must come from a positive eligibilityValue, and -1 is never a requirement`
    );
  }

  return {
    key: eligibilityKey,
    kind: descriptor.kind,
    role: descriptor.role,
    field: descriptor.field,
    value: resolveClassifiedValue(entry, descriptor, eligibilityKey, eligibilitySlot, eligibilityValue),
    slot: eligibilitySlot,
  };
};

/**
 * Resolves an entry's emitted value. A descriptor may carry a `classify` tag
 * telling the decoder the values need a second decode before they can become a
 * match value; the only such classifier is `PLAYER_RARITY_GROUP`, whose
 * `decodeRarityGroup` turns the label and value into a region key, `TOTS` or
 * `TOTW_OR_TOTS`. An unknown classifier, or a value the classifier cannot
 * resolve, fails with the key named — never a guessed group.
 */
const resolveClassifiedValue = (entry, descriptor, eligibilityKey, eligibilitySlot, value) => {
  if (descriptor.classify === undefined) return value;
  if (descriptor.classify !== RARITY_GROUP_CLASSIFIER) {
    fail(
      `eligibilityKey ${eligibilityKey} names the unsupported classifier` +
        ` ${JSON.stringify(descriptor.classify)} in the keys mapping`
    );
  }
  const label = typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : null;
  const group = decodeRarityGroup(label, value);
  if (group.meaning === null) {
    fail(
      `eligibilityKey ${eligibilityKey} (${descriptor.type}) in eligibilitySlot` +
        ` ${eligibilitySlot} cannot be decoded: value ${value} and label` +
        ` ${JSON.stringify(label)} name neither a geographic region, TOTS nor TOTW-or-TOTS`
    );
  }
  return group.meaning === RARITY_GROUP_MEANINGS.REGION ? group.region : group.meaning;
};

const groupBySlot = (entries) => {
  const slots = new Map();
  for (const entry of entries) {
    if (!slots.has(entry.slot)) slots.set(entry.slot, []);
    slots.get(entry.slot).push(entry);
  }
  return [...slots.entries()].sort(([left], [right]) => left - right);
};

const readScope = (slot, entries, scopes) => {
  const scopeEntries = entries.filter((entry) => entry.role === ROLES.SCOPE);
  // No scope entry means "at least N": EA's default is the minimum operator,
  // never "exactly N". The default is explicit and exported as DEFAULT_SCOPE.
  if (scopeEntries.length === 0) return DEFAULT_SCOPE;
  if (scopeEntries.length > 1) {
    fail(`Multiple scope entries in eligibilitySlot ${slot}`);
  }

  const value = scopeEntries[0].value;
  if (!Object.hasOwn(scopes, value)) {
    fail(`Unknown scope value ${value} in eligibilitySlot ${slot}`);
  }

  const operator = scopes[value];
  if (typeof operator !== 'string' || operator.length === 0) {
    fail(
      `Malformed scopes mapping for value ${value}: expected a non-empty operator string,` +
        ` received ${JSON.stringify(operator) ?? 'undefined'}`
    );
  }
  // Known names are matched loosely and canonicalised (MIN/GREATER -> GREATER,
  // MAX/LOWER/LESS -> LOWER, ...); an unknown name keeps the caller's own
  // vocabulary instead of being forced into one of the four operators.
  return decodeScopeName(operator) ?? operator;
};

const buildPlayerCountConstraint = (slot, scope, counts, matches, scalars) => {
  if (counts.length > 1) {
    fail(`Duplicate ${counts[0].kind} in eligibilitySlot ${slot}`);
  }
  if (counts.length === 0) {
    fail(`${matches[0].kind} in eligibilitySlot ${slot} has no count requirement`);
  }
  if (scalars.length > 0) {
    fail(`eligibilitySlot ${slot} combines ${counts[0].kind} with ${scalars[0].kind}`);
  }
  if (matches.length === 0) {
    fail(
      `${counts[0].kind} in eligibilitySlot ${slot} has no nation/league/club/level discriminator`
    );
  }

  const field = matches[0].field;
  const mixed = matches.find((entry) => entry.field !== field);
  if (mixed !== undefined) {
    fail(
      `eligibilitySlot ${slot} mixes ${matches[0].kind} and ${mixed.kind} in one requirement`
    );
  }

  return {
    kind: counts[0].kind,
    value: counts[0].value,
    scope,
    match: { [field]: matches.map((entry) => entry.value) },
  };
};

const buildScalarConstraint = (slot, scope, scalars) => {
  if (scalars.length > 1) {
    const mixed = scalars.some((entry) => entry.key !== scalars[0].key);
    if (mixed) {
      fail(
        `eligibilitySlot ${slot} combines ${scalars[0].kind} with ${scalars[1].kind};` +
          ' one slot describes one requirement'
      );
    }
    fail(`Duplicate ${scalars[0].kind} in eligibilitySlot ${slot}`);
  }

  return [{ kind: scalars[0].kind, value: scalars[0].value, scope }];
};

const decodeSlot = (slot, entries, scopes) => {
  const scope = readScope(slot, entries, scopes);

  const primary = entries.filter((entry) => entry.role !== ROLES.SCOPE);
  if (primary.length === 0) {
    fail(`scope modifier in eligibilitySlot ${slot} has no requirement to modify`);
  }

  const counts = primary.filter((entry) => entry.role === ROLES.COUNT);
  const matches = primary.filter((entry) => entry.role === ROLES.MATCH);
  const scalars = primary.filter((entry) => entry.role === ROLES.SCALAR);

  if (counts.length > 0 || matches.length > 0) {
    return [buildPlayerCountConstraint(slot, scope, counts, matches, scalars)];
  }
  return buildScalarConstraint(slot, scope, scalars);
};

/**
 * @param {Array<{type: string, eligibilitySlot: number, eligibilityKey: number, eligibilityValue: number}>} elgReq
 * @param {{ operation?: string, keys: object, scopes: object }} options
 *   `keys` and `scopes` are required lookup tables supplied by the caller (the
 *   live-resolved tables in production); `operation` defaults to 'AND' and any
 *   other `elgOperation` is rejected.
 *   Constraint `kind`s are the adapter's stable internal vocabulary, never the
 *   payload's `type` strings.
 * @returns {{ constraints: Array<object>, operation: string }}
 */
export function normaliseRequirements(elgReq, options) {
  requireEntries(elgReq);
  const { keys, scopes } = requireOptions(options);

  const operation = options.operation ?? DEFAULT_OPERATION;
  if (operation !== DEFAULT_OPERATION) {
    fail(`Unsupported elgOperation: ${JSON.stringify(operation)}`);
  }

  const entries = elgReq.map((entry, index) => decodeEntry(entry, index, keys));
  const constraints = groupBySlot(entries).flatMap(([slot, slotEntries]) =>
    decodeSlot(slot, slotEntries, scopes)
  );

  return { constraints, operation };
}
