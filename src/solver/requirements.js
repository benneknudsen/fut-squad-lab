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
 * the pinned scope table in the test data.
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

const ROLES = Object.freeze({
  COUNT: 'count',
  MATCH: 'match',
  SCALAR: 'scalar',
  SCOPE: 'scope',
});

const KNOWN_ROLES = new Set(Object.values(ROLES));

const DEFAULT_OPERATION = 'AND';

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

  return {
    key: eligibilityKey,
    kind: descriptor.kind,
    role: descriptor.role,
    field: descriptor.field,
    value: eligibilityValue,
    slot: eligibilitySlot,
  };
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
  if (scopeEntries.length === 0) {
    fail(`requirement in eligibilitySlot ${slot} has no scope modifier`);
  }
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
  return operator;
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
