/**
 * The greedy seed solver: produces a first *valid* squad for one challenge.
 * Valid, not good — a later milestone adds swap-based local search on top, and
 * this module deliberately stops at "the cheapest candidate that keeps the
 * partial squad feasible".
 *
 * ## Purity and determinism
 *
 * Plain data in, plain data out. No DOM, no chrome APIs, no network. Given the
 * same challenge, pool, options and seed, it returns the same result. All
 * randomness comes from an internal seeded PRNG (`options.seed`); `Math.random`
 * is never called. The one clock read is `options.timeBudgetMs`, and it only
 * decides how many shuffled restarts run.
 *
 * ## Where the EA knowledge lives
 *
 * The formation table, the eligibility key numbers and the scope numbers are EA
 * payload vocabulary and live in `src/ea/adapter.js`; this module imports
 * `normaliseFormation` and the pinned lookup tables and never sees a raw field
 * name. The pinned tables are the observation-based development data recorded
 * there: production must eventually read EA's live `SBCEligibilityKey` enum
 * through the page bridge (issue #16), and until that lands the solver uses the
 * pinned snapshot the same way the tests do.
 *
 * ## The greedy pass
 *
 * 1. Resolve the formation into eleven ordered slot positions.
 * 2. Decode `elgReq` into normalised constraints and order them hardest-first
 *    with `orderConstraints`.
 * 3. Fill the scarcest slot first with the cheapest record that (a) fits the
 *    slot position, (b) is not already used (identity by `id`), and (c) leaves
 *    the partial squad feasible against every still-open requirement.
 * 4. If the pass cannot complete, retry with a bounded number of seeded
 *    restarts that choose randomly among the cheapest few feasible candidates
 *    at each slot, and return the best *valid* attempt.
 *
 * "Cheapest" is the weighted contribution from the cost model (#6), read
 * through `itemCost` on records the canonical `mergePrices` path has priced. A
 * record that has already been merged keeps its resolved price and state; an
 * unmerged record is merged with EA's own fallback. An unknown price is
 * `UNKNOWN_CONTRIBUTION` and sorts after every known one, so an unpriced card
 * is never treated as free.
 *
 * ## Feasibility is a bound, not a guarantee
 *
 * The per-placement check is a set of necessary conditions: reachable distinct
 * counts, reachable group sizes, reachable match counts, reachable rating sums,
 * and an exact bipartite match of the remaining records to the remaining slot
 * positions. A pass that satisfies every bound can still dead-end later, which
 * is why the restarts exist. If none of the attempts is valid, the solver
 * returns the best attempt with the validator's real failures instead of
 * throwing: a club that genuinely cannot satisfy a challenge is a normal
 * outcome, not an error.
 *
 * ## Unverified requirements are never gates
 *
 * `PLAYER_QUALITY`, player-level matches and `CHEMISTRY_POINTS` are reported by
 * `validateSquad` in `unverified` and never measured, because the model behind
 * them is not verified. The greedy pass does not gate on them either, and the
 * result carries the validator's `unverified` array so the caller sees them.
 * `CHEMISTRY_FORMULA_VERIFIED` is `false`, so even a computed chemistry number
 * stays unverified; when the rule set cannot resolve a profile for every
 * starter at all, the result carries the same marker with a `0` placeholder
 * that `validateSquad` never measures while `verified` is false.
 *
 * This module is pure: no DOM, no chrome APIs, no network.
 */

import {
  PINNED_ELIGIBILITY_KEYS,
  SCOPE_VALUES,
  normaliseFormation,
  normaliseTeamChemLinks,
} from '../ea/adapter.js';
import { buildClubIndex, resolveProfile, squadChemistry } from './chemistry.js';
import {
  compareContributions,
  itemCost,
  mergePrices,
  resolveWeights,
  totalCost,
} from './prices.js';
import { normaliseRequirements } from './requirements.js';
import { validateSquad } from './validate.js';

const MAX_ATTEMPTS = 32;
const RESTART_WINDOW = 3;

/**
 * Priority classes for the greedy pass, lowest first. The restrictive
 * group-composition requirements come before the softer distinct-count and
 * scalar ones, so the greedy gate treats them as the hard constraints they are:
 * a SAME_CLUB cap is far easier to violate by accident than a loose nation
 * count.
 *
 * Within a class, the decoder order is preserved, so the ordering is stable and
 * reproduces exactly.
 */
const CONSTRAINT_PRIORITY = Object.freeze({
  SAME_CLUB_COUNT: 0,
  SAME_NATION_COUNT: 1,
  SAME_LEAGUE_COUNT: 2,
  PLAYER_COUNT_MATCH: 3,
  CLUB_COUNT: 4,
  NATION_COUNT: 5,
  LEAGUE_COUNT: 6,
  TEAM_RATING: 7,
  CHEMISTRY_POINTS: 8,
  PLAYER_QUALITY: 9,
});

const MATCH_FIELD_READERS = Object.freeze({
  nationIds: (record) => record.nationId,
  leagueIds: (record) => record.leagueId,
  clubIds: (record) => record.clubId,
});

const COUNT_READERS = Object.freeze({
  NATION_COUNT: (record) => record.nationId,
  LEAGUE_COUNT: (record) => record.leagueId,
  CLUB_COUNT: (record) => record.clubId,
});

const GROUP_READERS = Object.freeze({
  SAME_NATION_COUNT: (record) => record.nationId,
  SAME_LEAGUE_COUNT: (record) => record.leagueId,
  SAME_CLUB_COUNT: (record, clubIndex) => clubIndex.groupOf(record.clubId),
});

const UNVERIFIED_CHEMISTRY_REASON = 'chemistry-formula-unverified';

const fail = (message) => {
  throw new Error(`solve: ${message}`);
};

/**
 * Orders a decoded constraint set hardest-first for the greedy pass. This is
 * deliberately a named, exported function rather than an inline sort: the order
 * is part of the solver's documented policy, it is unit-tested directly, and
 * the local-search milestone reuses it.
 *
 * The input array is not mutated; a new array of the same constraint objects is
 * returned.
 *
 * @param {Array<object>} constraints normalised constraints from
 *   `normaliseRequirements`
 * @returns {Array<object>} the same constraints, hardest first, stable within a
 *   priority class
 * @throws {Error} when an entry is not an object or names no known kind
 */
export function orderConstraints(constraints) {
  if (!Array.isArray(constraints)) {
    throw new Error('orderConstraints: constraints must be an array');
  }
  return constraints
    .map((constraint, index) => {
      if (constraint === null || typeof constraint !== 'object' || Array.isArray(constraint)) {
        throw new Error(`orderConstraints: constraint ${index} must be an object`);
      }
      if (!Object.hasOwn(CONSTRAINT_PRIORITY, constraint.kind)) {
        throw new Error(
          `orderConstraints: constraint ${index} has the unknown kind` +
            ` ${JSON.stringify(constraint.kind)}`
        );
      }
      return { constraint, priority: CONSTRAINT_PRIORITY[constraint.kind], index };
    })
    .sort((left, right) =>
      left.priority !== right.priority ? left.priority - right.priority : left.index - right.index
    )
    .map((entry) => entry.constraint);
}

/** FNV-1a over a string seed, so callers may name a run instead of numbering it. */
const hashSeed = (seed) => {
  if (seed === undefined) return 0x9e3779b9;
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    return Math.trunc(seed) >>> 0 || 0x9e3779b9;
  }
  if (typeof seed === 'string') {
    let hash = 0x811c9dc5;
    for (let index = 0; index < seed.length; index++) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash || 0x9e3779b9;
  }
  fail('options.seed must be a finite number or a string when supplied');
};

/**
 * xorshift32: a tiny seeded PRNG with no dependency. It is not cryptographic,
 * it does not need to be, and it must never be replaced by `Math.random`,
 * which would break determinism.
 */
const createRandom = (seed) => {
  let state = hashSeed(seed);
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
};

const requireChallenge = (challenge) => {
  if (challenge === null || typeof challenge !== 'object' || Array.isArray(challenge)) {
    fail('challenge must be an object carrying formation and elgReq');
  }
};

const requirePool = (pool) => {
  if (!Array.isArray(pool)) {
    fail('pool must be an array of candidate records from buildPool');
  }
};

const resolveSolveOptions = (options) => {
  if (options === undefined) return {};
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    fail('options must be an object when supplied');
  }
  const { timeBudgetMs } = options;
  if (timeBudgetMs !== undefined && (!Number.isFinite(timeBudgetMs) || timeBudgetMs <= 0)) {
    fail('options.timeBudgetMs must be a positive finite number when supplied');
  }
  // options.lockedSlots is accepted from day one because docs/PLAN.md §2.6
  // requires the interactive re-solve API to carry it. The greedy seed does not
  // use it; `reevaluate` is the entry point that does.
  return options;
};

const decodeConstraints = (challenge) =>
  orderConstraints(
    normaliseRequirements(challenge.elgReq, {
      operation: challenge.elgOperation,
      keys: PINNED_ELIGIBILITY_KEYS,
      scopes: SCOPE_VALUES,
    }).constraints
  );

/**
 * Builds the club equivalence index from a solve options object. Only an absent
 * `clubLinks` means "no links"; any other non-array value still reaches
 * `normaliseTeamChemLinks` and throws there.
 */
const buildClubIndexFor = (options) =>
  buildClubIndex(
    normaliseTeamChemLinks(options?.clubLinks === undefined ? [] : options.clubLinks)
  );

const MERGED_COST_FIELDS = Object.freeze(['cardState', 'price', 'priceSource']);

const hasMergedCost = (record) => MERGED_COST_FIELDS.some((field) => Object.hasOwn(record, field));

/** `mergePrices` is the canonical price path; only unmerged records need it. */
const priceRecord = (record) => (hasMergedCost(record) ? record : mergePrices([record])[0]);

const pricePool = (pool) => pool.map(priceRecord);

const fitsPosition = (record, position) => {
  const positions =
    Array.isArray(record.possiblePositions) && record.possiblePositions.length > 0
      ? record.possiblePositions
      : [record.preferredPosition];
  return positions.includes(position);
};

/**
 * Requirements `validateSquad` never measures are never gates here either:
 * `PLAYER_QUALITY`, player-level matches and `CHEMISTRY_POINTS` are reported in
 * `unverified`, so gating on a guessed measure would both reject real squads
 * and accept wrong ones.
 */
const isMeasured = (constraint) => {
  if (constraint.kind === 'PLAYER_QUALITY' || constraint.kind === 'CHEMISTRY_POINTS') return false;
  if (
    constraint.kind === 'PLAYER_COUNT_MATCH' &&
    Object.hasOwn(constraint.match, 'playerLevels')
  ) {
    return false;
  }
  return true;
};

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
  return { counts, largest };
};

/**
 * Necessary conditions for a partial squad to still reach one constraint.
 * `unused` may contain records that no remaining slot can fit; the slot
 * coverage check handles that, so constraints may use it as a loose upper bound.
 */
const isStillSatisfiable = (constraint, players, remainingSlots, unused, squadSize, clubIndex) => {
  if (!isMeasured(constraint)) return true;

  const { kind, value, scope } = constraint;

  if (kind === 'PLAYER_COUNT_MATCH') {
    const [field] = Object.keys(constraint.match);
    const read = MATCH_FIELD_READERS[field];
    const wanted = new Set(constraint.match[field]);
    const matched = players.filter((player) => wanted.has(read(player))).length;
    const reachable = unused.filter((player) => wanted.has(read(player))).length;
    const maximum = matched + Math.min(reachable, remainingSlots);

    if (scope === 'LOWER') return matched <= value;
    if (scope === 'GREATER') return maximum >= value;
    return matched <= value && maximum >= value;
  }

  if (Object.hasOwn(COUNT_READERS, kind)) {
    const read = COUNT_READERS[kind];
    const distinct = new Set(players.map(read)).size;
    if (scope === 'GREATER') return distinct + remainingSlots >= value;
    if (scope === 'LOWER') return distinct <= value;
    return distinct <= value && distinct + remainingSlots >= value;
  }

  if (Object.hasOwn(GROUP_READERS, kind)) {
    const read = (player) => GROUP_READERS[kind](player, clubIndex);
    const { counts, largest } = largestGroup(players, read);

    if (scope !== 'GREATER') {
      if (largest > value) return false;
      // A remaining slot can only take a record whose group has room left; when
      // the total remaining room is below the slots left, completion is
      // impossible.
      let room = 0;
      for (const group of new Set(unused.map(read))) {
        room += Math.max(0, value - (counts.get(group) ?? 0));
      }
      if (room < remainingSlots) return false;
    }

    if (scope !== 'LOWER') {
      let reachable = largest;
      for (const group of new Set([...counts.keys(), ...unused.map(read)])) {
        const available = (counts.get(group) ?? 0) + unused.filter((p) => read(p) === group).length;
        if (available > reachable) reachable = available;
      }
      if (reachable < value) return false;
    }

    return true;
  }

  if (kind === 'TEAM_RATING') {
    const current = players.reduce((sum, player) => sum + player.rating, 0);
    const ratings = unused.map((player) => player.rating).sort((left, right) => left - right);
    const top = ratings.slice(Math.max(0, ratings.length - remainingSlots));
    const bottom = ratings.slice(0, remainingSlots);
    const maximum = current + top.reduce((sum, rating) => sum + rating, 0);
    const minimum = current + bottom.reduce((sum, rating) => sum + rating, 0);

    if (scope === 'GREATER') return Math.round(maximum / squadSize) >= value;
    if (scope === 'LOWER') return Math.round(minimum / squadSize) <= value;
    return (
      Math.round(maximum / squadSize) >= value && Math.round(minimum / squadSize) <= value
    );
  }

  return true;
};

/**
 * Exact bipartite matching between the still-empty slots and the unused
 * records: Kuhn's augmenting-path algorithm over eleven slots. A slot that
 * cannot be covered returns false, so the greedy never opens a slot it cannot
 * close.
 */
const canCoverRemainingSlots = (positions, filled, unused) => {
  const remaining = [];
  for (let slot = 0; slot < positions.length; slot++) {
    if (filled[slot] === null) remaining.push(slot);
  }
  if (remaining.length === 0) return true;
  if (unused.length < remaining.length) return false;

  const candidatesBySlot = remaining.map((slot) => {
    const candidates = [];
    for (let index = 0; index < unused.length; index++) {
      if (fitsPosition(unused[index], positions[slot])) candidates.push(index);
    }
    return candidates;
  });

  const ownerOf = new Map();
  const assign = (slotIndex, visited) => {
    for (const recordIndex of candidatesBySlot[slotIndex]) {
      if (visited.has(recordIndex)) continue;
      visited.add(recordIndex);
      const owner = ownerOf.get(recordIndex);
      if (owner === undefined || assign(owner, visited)) {
        ownerOf.set(recordIndex, slotIndex);
        return true;
      }
    }
    return false;
  };

  for (let slotIndex = 0; slotIndex < remaining.length; slotIndex++) {
    if (!assign(slotIndex, new Set())) return false;
  }
  return true;
};

/**
 * Classifies one tentative placement for the greedy gate:
 *
 *   2  every open requirement is still reachable and every slot still coverable
 *   1  the slots are coverable but at least one requirement is already out of
 *      reach; the placement is only a best-effort fallback
 *   0  the placement strands a remaining slot position
 *
 * The greedy consumes tier 2 first. Tiers 1 and 0 exist so a challenge the club
 * genuinely cannot satisfy still produces a complete eleven for the validator
 * to report on, instead of stopping at a dead end with no squad.
 */
const classifyPlacement = (orderedConstraints, filled, usedIds, pool, positions, clubIndex) => {
  const remainingSlots = filled.filter((player) => player === null).length;
  const players = filled.filter((player) => player !== null);
  const unused = pool.filter((record) => !usedIds.has(record.id));

  if (!canCoverRemainingSlots(positions, filled, unused)) return 0;
  if (
    orderedConstraints.every((constraint) =>
      isStillSatisfiable(constraint, players, remainingSlots, unused, positions.length, clubIndex)
    )
  ) {
    return 2;
  }
  return 1;
};

/** Scarcest slot position first; ties by formation order, so the order is stable. */
const computeFillOrder = (positions, candidateLists) =>
  positions
    .map((position, slot) => ({ slot, fit: candidateLists.get(position).length }))
    .sort((left, right) => (left.fit !== right.fit ? left.fit - right.fit : left.slot - right.slot))
    .map(({ slot }) => slot);

const compareCandidates = (left, right) => {
  const byContribution = compareContributions(left.contribution, right.contribution);
  return byContribution !== 0 ? byContribution : left.index - right.index;
};

/**
 * The position-fitting records for every slot position, each sorted cheapest
 * first with unknown contributions last. Built once per solve; the attempts
 * only filter out already-used ids, so the sort is paid for once instead of
 * once per attempt.
 */
const buildCandidateLists = (pool, positions, weights) => {
  const slotPositions = [...new Set(positions)];
  const byPosition = new Map(slotPositions.map((position) => [position, []]));
  pool.forEach((record, index) => {
    const contribution = itemCost(record, weights).contribution;
    for (const position of slotPositions) {
      if (!fitsPosition(record, position)) continue;
      const list = byPosition.get(position) ?? [];
      list.push({ record, index, contribution });
      byPosition.set(position, list);
    }
  });
  for (const list of byPosition.values()) list.sort(compareCandidates);
  return byPosition;
};

/**
 * One greedy pass. `windowSize` 1 is the deterministic cheapest-feasible pass;
 * larger values pick uniformly among that many cheapest feasible candidates,
 * which is how the seeded restarts explore different squads. A slot with no
 * fully feasible candidate falls back to a merely coverable one, and then to
 * any candidate at all, so a run only returns `null` when the pool cannot
 * physically fill a remaining slot position.
 *
 * `shouldStop` is `null` for the deterministic seed pass, which must complete
 * so there is always one full attempt to report, and a budget predicate for the
 * restarts, checked between slots.
 */
const runAttempt = ({
  pool,
  positions,
  candidateLists,
  orderedConstraints,
  clubIndex,
  random,
  windowSize,
  initialPlayers,
  shouldStop,
}) => {
  const filled = initialPlayers.slice();
  const usedIds = new Set(filled.filter((player) => player !== null).map(({ id }) => id));
  const fillOrder = computeFillOrder(positions, candidateLists);

  for (const slot of fillOrder) {
    if (filled[slot] !== null) continue;
    if (shouldStop !== null && shouldStop()) return null;

    const candidatesInCostOrder = candidateLists
      .get(positions[slot])
      .filter(({ record }) => !usedIds.has(record.id));

    // Only the cheapest `windowSize` fully feasible candidates can be chosen,
    // so the scan stops as soon as that many exist. Coverable and blocked
    // fallbacks are kept until the scan ends without enough feasible options.
    const viable = [];
    const coverable = [];
    let blocked = null;
    for (const candidate of candidatesInCostOrder) {
      filled[slot] = candidate.record;
      usedIds.add(candidate.record.id);
      const tier = classifyPlacement(
        orderedConstraints,
        filled,
        usedIds,
        pool,
        positions,
        clubIndex
      );
      filled[slot] = null;
      usedIds.delete(candidate.record.id);

      if (tier === 2) {
        viable.push(candidate);
        if (viable.length >= windowSize) break;
      } else if (tier === 1) {
        coverable.push(candidate);
      } else if (blocked === null) {
        blocked = candidate;
      }
    }

    const ranked = viable.length > 0 ? viable : coverable.length > 0 ? coverable : [blocked];
    if (ranked[0] == null) return null;

    const window = Math.min(windowSize, ranked.length);
    const pick = window === 1 ? 0 : Math.floor(random() * window);
    filled[slot] = ranked[pick].record;
    usedIds.add(ranked[pick].record.id);
  }

  return filled;
};

const compareCosts = (left, right) => {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left - right;
};

/** Valid beats invalid; then fewer failures; then the cheaper known cost. */
const betterAttempt = (candidate, best) => {
  if (best === null) return candidate;
  if (candidate.valid !== best.valid) return candidate.valid ? candidate : best;
  if (candidate.valid) return compareCosts(candidate.cost, best.cost) < 0 ? candidate : best;
  if (candidate.failures.length !== best.failures.length) {
    return candidate.failures.length < best.failures.length ? candidate : best;
  }
  return compareCosts(candidate.cost, best.cost) < 0 ? candidate : best;
};

/** The formula-unverified result carried whenever chemistry cannot be scored. */
const unverifiedChemistry = () => ({
  chemistry: 0,
  verified: false,
  reason: UNVERIFIED_CHEMISTRY_REASON,
});

/**
 * The chemistry result object for the eleven starters. When the rule set cannot
 * resolve a profile for every starter, or when starters resolve to different
 * profiles, no single profile can score the squad; the result then carries the
 * formula-unverified marker with a `0` placeholder. `validateSquad` never
 * measures that placeholder while `verified` is false, so the marker is
 * honest rather than a claimed score.
 */
const computeChemistry = (players, chemistryRuleSet, clubIndex) => {
  if (chemistryRuleSet === undefined || chemistryRuleSet === null || players.length === 0) {
    return unverifiedChemistry();
  }

  const profiles = players.map((player) => resolveProfile(player.rarity, chemistryRuleSet));
  if (profiles.some((profile) => profile === null)) return unverifiedChemistry();

  const [first] = profiles;
  if (profiles.some((profile) => profile.id !== first.id)) return unverifiedChemistry();
  return squadChemistry(players, first, clubIndex);
};

const finalise = (players, { constraints, clubIndex, chemistryRuleSet, weights }) => {
  const squad = {
    players,
    chemistry: computeChemistry(players, chemistryRuleSet, clubIndex),
  };
  const validation = validateSquad(squad, constraints, {
    clubLinks: (clubId) => clubIndex.groupOf(clubId),
  });
  const cost = totalCost(players.map((player) => itemCost(player, weights).contribution));
  return {
    squad,
    cost,
    valid: validation.valid,
    failures: validation.failures,
    unverified: validation.unverified,
  };
};

/**
 * Runs the greedy seed and the seeded restarts and returns the best attempt.
 * `initialPlayers` lets `reevaluate` pin locked slots before the fill starts.
 */
const buildBestAttempt = ({
  pool,
  positions,
  orderedConstraints,
  clubIndex,
  chemistryRuleSet,
  weights,
  random,
  timeBudgetMs,
  initialPlayers,
}) => {
  const startedAt = Date.now();
  const withinBudget = () => timeBudgetMs === undefined || Date.now() - startedAt < timeBudgetMs;
  const candidateLists = buildCandidateLists(pool, positions, weights);
  const base = {
    pool,
    positions,
    candidateLists,
    orderedConstraints,
    clubIndex,
    random,
    initialPlayers,
  };

  // Attempt 0 is the deterministic cheapest-feasible pass and always runs to
  // completion: it is what guarantees a full eleven whenever the pool can fill
  // the formation at all. The time budget only limits the restarts, and their
  // fills may stop between slots.
  let best = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0 && !withinBudget()) break;

    const windowSize = attempt === 0 ? 1 : 2 + ((attempt - 1) % RESTART_WINDOW);
    const filled = runAttempt({
      ...base,
      windowSize,
      shouldStop: attempt === 0 ? null : () => !withinBudget(),
    });

    if (filled === null) continue;

    const attemptResult = finalise(
      filled.filter((player) => player !== null),
      { constraints: orderedConstraints, clubIndex, chemistryRuleSet, weights }
    );
    best = betterAttempt(attemptResult, best);
  }

  if (best === null) {
    // The pool cannot fill all eleven slots. There is no squad to validate, so
    // the result is honestly invalid with no validator failures to report.
    const players = initialPlayers.filter((player) => player !== null);
    return {
      squad: {
        players,
        chemistry: computeChemistry(players, chemistryRuleSet, clubIndex),
      },
      cost: null,
      valid: false,
      failures: [],
      unverified: [],
    };
  }

  return best;
};

/**
 * Solves one challenge from the caller's own club pool.
 *
 * @param {object} challenge a raw challenge payload; only `formation`,
 *   `elgReq` and `elgOperation` are read
 * @param {Array<object>} pool output of `buildPool`
 * @param {{ timeBudgetMs?: number, seed?: number|string, lockedSlots?: Array<number>,
 *   weights?: object, clubLinks?: Array<object>, chemistryRuleSet?: object }} [options]
 *   `timeBudgetMs` bounds the shuffled restarts (attempt 0 always runs);
 *   `seed` seeds the restarts; `weights` overrides the cost-model weights;
 *   `clubLinks` is the raw `/chemistry/teamlinks` payload, normalised through
 *   the adapter; `chemistryRuleSet` is the adapter's normalised profile rule
 *   set. `lockedSlots` is accepted from day one per docs/PLAN.md §2.6 but is
 *   unused in the greedy seed — `reevaluate` is the entry point that honours it.
 * @returns {{ squad: { players: Array<object>, chemistry: object },
 *   cost: number|null, valid: boolean, failures: Array<object>,
 *   unverified: Array<object> }} `failures` and `unverified` are the
 *   validator's own structured arrays; `cost` is `null` when any card's price
 *   is unknown, never `0` for an unknown card
 * @throws {Error} when the challenge has no known formation, or a requirement
 *   cannot be decoded
 */
export function solve(challenge, pool, options) {
  requireChallenge(challenge);
  requirePool(pool);
  const resolved = resolveSolveOptions(options);

  const { positions } = normaliseFormation(challenge.formation);
  const constraints = decodeConstraints(challenge);
  const clubIndex = buildClubIndexFor(resolved);
  const weights = resolveWeights(resolved.weights);
  const pricedPool = pricePool(pool);

  return buildBestAttempt({
    pool: pricedPool,
    positions,
    orderedConstraints: constraints,
    clubIndex,
    chemistryRuleSet: resolved.chemistryRuleSet ?? null,
    weights,
    random: createRandom(resolved.seed),
    timeBudgetMs: resolved.timeBudgetMs,
    initialPlayers: new Array(positions.length).fill(null),
  });
}

const requireLockedSlots = (lockedSlots, squadSize) => {
  if (lockedSlots === undefined) return [];
  if (!Array.isArray(lockedSlots)) fail('reevaluate: lockedSlots must be an array of slot indexes');
  const seen = new Set();
  for (const slot of lockedSlots) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= squadSize) {
      fail(
        `reevaluate: locked slot ${JSON.stringify(slot)} is not a formation slot index (0..${
          squadSize - 1
        })`
      );
    }
    if (seen.has(slot)) fail(`reevaluate: locked slot ${slot} appears twice`);
    seen.add(slot);
  }
  return [...seen].sort((left, right) => left - right);
};

const suppliedPlayers = (squad) => {
  if (squad === null || typeof squad !== 'object' || !Array.isArray(squad.players)) {
    fail('reevaluate: squad must be an object carrying a players array');
  }
  return squad.players;
};

/**
 * The interactive re-solve entry point from `docs/PLAN.md` §2.6: keep every
 * player whose slot is locked and fill the remaining slots greedily, returning
 * the same shape as `solve`.
 *
 * This is not local search. Full local search — swapping players in and out
 * until cost stops improving — is a later milestone; this function only
 * re-validates and re-runs the greedy seed around the locked players. It does
 * not pretend otherwise.
 *
 * `context` carries the solver state the UI keeps between solves:
 *
 *   { challenge, pool, options }
 *
 * `challenge` is the raw challenge payload and `options` is the same object
 * `solve` accepts. An incomplete squad is normal here (it is an in-progress
 * squad), so this function never throws merely because fewer than eleven
 * players are present: locked slots without a player are simply not pinned and
 * get filled. A locked record that does not fit its slot position is kept
 * anyway — the lock is the user's instruction — and the validator reports the
 * resulting requirement failures.
 *
 * Without a pool there is nothing to fill from. The function then re-validates
 * a complete eleven when it has `context.constraints` (or `context.challenge`)
 * and otherwise returns the supplied squad unchanged with `valid: false` and an
 * empty `failures` array: no verdict, because none can be computed.
 *
 * @param {{ players: Array<object>, chemistry?: object }} squad the current
 *   squad, players in slot order; may be incomplete
 * @param {Array<number>} lockedSlots slot indexes to keep, 0..10
 * @param {{ challenge?: object, constraints?: Array<object>, pool?: Array<object>,
 *   options?: object }} [context]
 * @returns {{ squad: { players: Array<object>, chemistry: object },
 *   cost: number|null, valid: boolean, failures: Array<object>,
 *   unverified: Array<object> }}
 * @throws {Error} when `lockedSlots` names a slot outside the formation, a
 *   duplicate slot, or `squad` is not a squad object
 */
export function reevaluate(squad, lockedSlots, context = {}) {
  if (context === null || typeof context !== 'object' || Array.isArray(context)) {
    fail('reevaluate: context must be an object when supplied');
  }
  const players = suppliedPlayers(squad);
  const positions = context.challenge
    ? normaliseFormation(context.challenge.formation).positions
    : new Array(11).fill(null);
  const locked = requireLockedSlots(lockedSlots, positions.length);

  if (context.pool === undefined || context.challenge === undefined) {
    const constraints = context.challenge
      ? decodeConstraints(context.challenge)
      : context.constraints;
    const clubIndex = buildClubIndexFor(context.options);
    if (players.length === positions.length && Array.isArray(constraints)) {
      const result = finalise(pricePool(players), {
        constraints,
        clubIndex,
        chemistryRuleSet: context.options?.chemistryRuleSet ?? null,
        weights: resolveWeights(context.options?.weights),
      });
      return result;
    }
    return {
      squad: {
        players: [...players],
        chemistry: computeChemistry(players, context.options?.chemistryRuleSet ?? null, clubIndex),
      },
      cost: null,
      valid: false,
      failures: [],
      unverified: [],
    };
  }

  const resolved = resolveSolveOptions(context.options);
  const constraints = decodeConstraints(context.challenge);
  const clubIndex = buildClubIndexFor(resolved);
  const weights = resolveWeights(resolved.weights);
  const pricedPool = pricePool(context.pool);

  const initialPlayers = new Array(positions.length).fill(null);
  for (const slot of locked) {
    if (slot >= players.length) continue;
    initialPlayers[slot] = priceRecord(players[slot]);
  }

  return buildBestAttempt({
    pool: pricedPool,
    positions,
    orderedConstraints: constraints,
    clubIndex,
    chemistryRuleSet: resolved.chemistryRuleSet ?? null,
    weights,
    random: createRandom(resolved.seed),
    timeBudgetMs: resolved.timeBudgetMs,
    initialPlayers,
  });
}
