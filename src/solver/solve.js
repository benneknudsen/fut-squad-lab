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
 *
 * ## The interactive re-solve
 *
 * `reevaluate(squad, lockedSlots, pool, options)` re-runs the greedy attempt
 * with the locked slots pre-filled, then derives the ranked `alternatives` for
 * every unlocked slot. It is not local search; that is a later milestone.
 * Locked players are ordinary inputs to every feasibility and validation step,
 * and a lock is never silently undone. `options.challenge` is required.
 *
 * ## Alternatives are structured data
 *
 * Every alternative carries the pool record, a signed `costDelta` (`null` when
 * either side is unpriced) and `reasons` — key/params entries from the closed
 * vocabulary in the design contract. The solver never emits English; the UI
 * owns the copy. Only swaps that `validateSquad` approves are emitted, so
 * every clickable alternative keeps the squad valid.
 */

import {
  PINNED_ELIGIBILITY_KEYS,
  SCOPE_VALUES,
  normaliseFormation,
  normaliseTeamChemLinks,
} from '../ea/adapter.js';
import { buildClubIndex, countLinks, resolveProfile, squadChemistry } from './chemistry.js';
import {
  UNKNOWN_CONTRIBUTION,
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

const DEFAULT_EFFORT_LEVEL = 3;

/**
 * The one effort table: every search cap the UI's "Solver effort" control
 * implies, keyed by integer level 1..5. It is exported so the panel can render
 * the `options.effort.hint` copy ("up to {lineups} lineups") from the same
 * numbers the search enforces, and so the mapping is testable without running
 * a search.
 *
 * `maxLineups` caps the number of complete candidate squads that passed through
 * `validateSquad`; `maxIterations` caps the improvement rounds (one accepted
 * move per round); `timeBudgetMs` is the wall-clock stop the level implies,
 * overridable per call with `options.improvementTimeBudgetMs`. The caps rise
 * with the level so `thorough` provably does at least as much work as `fast`.
 */
export const EFFORT_LEVELS = Object.freeze({
  1: Object.freeze({ level: 1, maxLineups: 32, maxIterations: 1, timeBudgetMs: 250 }),
  2: Object.freeze({ level: 2, maxLineups: 96, maxIterations: 2, timeBudgetMs: 500 }),
  3: Object.freeze({ level: 3, maxLineups: 256, maxIterations: 4, timeBudgetMs: 1000 }),
  4: Object.freeze({ level: 4, maxLineups: 640, maxIterations: 8, timeBudgetMs: 2000 }),
  5: Object.freeze({ level: 5, maxLineups: 1536, maxIterations: 16, timeBudgetMs: 4000 }),
});

/** The named tiers from `design/copy.en.json` -> `options.effort`. */
const EFFORT_TIERS = Object.freeze({ fast: 1, balanced: 3, thorough: 5 });

/**
 * Resolves the effort control to its cap table entry. `undefined` is the
 * documented default, level 3 (balanced). Named tiers map to 1, 3 and 5. Any
 * other string, a non-integer or a level outside 1..5 throws: a silently
 * clamped effort would make the panel's copy lie about the search that ran.
 *
 * @param {number|'fast'|'balanced'|'thorough'} [effort]
 * @returns {{ level: number, maxLineups: number, maxIterations: number,
 *   timeBudgetMs: number }}
 * @throws {Error} when the level is not an integer 1..5 or an unknown tier name
 */
export function resolveEffort(effort) {
  if (effort === undefined) return EFFORT_LEVELS[DEFAULT_EFFORT_LEVEL];
  if (typeof effort === 'string') {
    if (!Object.hasOwn(EFFORT_TIERS, effort)) {
      fail(
        `options.effort ${JSON.stringify(effort)} names no tier; expected one of` +
          ` ${Object.keys(EFFORT_TIERS).join(', ')}`
      );
    }
    return EFFORT_LEVELS[EFFORT_TIERS[effort]];
  }
  if (!Number.isInteger(effort) || !Object.hasOwn(EFFORT_LEVELS, effort)) {
    fail(`options.effort must be an integer 1..5 when supplied; got ${JSON.stringify(effort)}`);
  }
  return EFFORT_LEVELS[effort];
}

const noImprovements = () => ({ acceptedMoves: 0, lineups: 0, iterations: 0, elapsedMs: 0 });

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
  // use it; `reevaluate` is the entry point that does. `reevaluate` also
  // requires options.challenge, which it validates itself.
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
 * Resolves the single chemistry profile that applies to every player, or
 * `null` when no one profile can score the squad. Isolated from `scoreSquad`
 * so `reevaluate` can tell a real computed number from the zero placeholder
 * without re-implementing the resolution rules.
 */
const resolveSquadProfile = (players, chemistryRuleSet) => {
  if (chemistryRuleSet === undefined || chemistryRuleSet === null || players.length === 0) {
    return null;
  }

  const profiles = players.map((player) => resolveProfile(player.rarity, chemistryRuleSet));
  if (profiles.some((profile) => profile === null)) return null;

  const [first] = profiles;
  if (profiles.some((profile) => profile.id !== first.id)) return null;
  return first;
};

/**
 * The chemistry result object for the eleven starters. When the rule set cannot
 * resolve a profile for every starter, or when starters resolve to different
 * profiles, no single profile can score the squad; the result then carries the
 * formula-unverified marker with a `0` placeholder. `validateSquad` never
 * measures that placeholder while `verified` is false, so the marker is
 * honest rather than a claimed score.
 */
const computeChemistry = (players, chemistryRuleSet, clubIndex) =>
  scoreSquad(players, chemistryRuleSet, clubIndex).chemistry;

/**
 * The chemistry object and the computed total for one arrangement. `score` is
 * `null` when no single profile resolves, exactly when the object is the
 * unverified placeholder; `reevaluate` compares scores only when both sides are
 * real numbers, so a placeholder `0` is never mistaken for a chemistry tier.
 */
const scoreSquad = (players, chemistryRuleSet, clubIndex) => {
  const profile = resolveSquadProfile(players, chemistryRuleSet);
  if (profile === null) return { chemistry: unverifiedChemistry(), score: null };
  const chemistry = squadChemistry(players, profile, clubIndex);
  return { chemistry, score: chemistry.chemistry };
};

const finalise = (players, { constraints, clubIndex, chemistryRuleSet, weights }) => {
  const squad = {
    players,
    chemistry: computeChemistry(players, chemistryRuleSet, clubIndex),
  };
  const validation = validateSquad(squad, constraints, {
    clubLinks: (clubId) => clubIndex.groupOf(clubId),
  });
  const contributions = players.map((player) => itemCost(player, weights).contribution);
  const cost = totalCost(contributions);
  return {
    squad,
    cost,
    // Explicit beside the total, so a caller can tell a real total from a
    // lower bound without walking the card list.
    costComplete: cost !== UNKNOWN_CONTRIBUTION,
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
      costComplete: false,
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
 *   weights?: object, clubLinks?: Array<object>, chemistryRuleSet?: object,
 *   effort?: number|'fast'|'balanced'|'thorough', improvementTimeBudgetMs?: number }} [options]
 *   `timeBudgetMs` bounds the shuffled restarts (attempt 0 always runs);
 *   `seed` seeds the restarts; `weights` overrides the cost-model weights;
 *   `clubLinks` is the raw `/chemistry/teamlinks` payload, normalised through
 *   the adapter; `chemistryRuleSet` is the adapter's normalised profile rule
 *   set. `lockedSlots` is accepted from day one per docs/PLAN.md §2.6 but is
 *   unused in the greedy seed — `reevaluate` is the entry point that honours it.
 *   `effort` opts into the swap-based improvement pass on the winning squad
 *   (see `improve`) and names the search caps; `improvementTimeBudgetMs`
 *   overrides the level's wall-clock budget. Omitting `effort` keeps the
 *   pre-local-search behaviour and reports a zeroed `improvements`.
 * @returns {{ squad: { players: Array<object>, chemistry: object },
 *   cost: number|null, costComplete: boolean, valid: boolean,
 *   failures: Array<object>, unverified: Array<object>,
 *   improvements: { acceptedMoves: number, lineups: number, iterations: number,
 *   elapsedMs: number } }} `failures` and `unverified` are the validator's own
 *   structured arrays; `cost` is `null` when any card's price is unknown, never
 *   `0` for an unknown card; `costComplete` is false exactly then, so a caller
 *   can tell a real total from a lower bound without walking the card list;
 *   `improvements` reports the local-search runtime, and is all zeros when no
 *   improvement pass ran
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

  const best = buildBestAttempt({
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

  if (resolved.effort === undefined || !best.valid) {
    return { ...best, improvements: noImprovements() };
  }
  return improve(best.squad, pricedPool, { ...resolved, challenge });
}

const requireImproveSquad = (squad) => {
  if (squad === null || typeof squad !== 'object' || !Array.isArray(squad.players)) {
    fail('improve: squad must be an object carrying a players array');
  }
  return squad.players;
};

const hasUniqueIds = (players) => new Set(players.map(({ id }) => id)).size === players.length;

/**
 * How a targeted repair must move one failing measure. This is a search
 * direction only — `validateSquad` remains the gate — so an unverified or
 * unrecognised kind is allowed through rather than guessed at. The kind
 * readers are shared with the greedy feasibility bounds.
 */
const targetsFailure = (record, failure, currentRecord, players, clubIndex) => {
  if (failure.kind === 'PLAYER_COUNT_MATCH') {
    const [field] = Object.keys(failure.match);
    const read = MATCH_FIELD_READERS[field];
    return read !== undefined && failure.match[field].includes(read(record));
  }
  if (Object.hasOwn(COUNT_READERS, failure.kind)) {
    const read = COUNT_READERS[failure.kind];
    const alreadyPresent = players.map(read).includes(read(record));
    // Too many distinct values: reuse one that is already there. Too few: add
    // one that is not.
    return failure.actual > failure.required ? alreadyPresent : !alreadyPresent;
  }
  if (Object.hasOwn(GROUP_READERS, failure.kind)) {
    const read = (player) => GROUP_READERS[failure.kind](player, clubIndex);
    const group = read(record);
    const count = players.filter((player) => read(player) === group).length;
    return count < failure.required;
  }
  if (failure.kind === 'TEAM_RATING') {
    return failure.actual < failure.required
      ? record.rating > currentRecord.rating
      : record.rating < currentRecord.rating;
  }
  return true;
};

/**
 * The swap-based local search behind `improve`. It takes a valid squad and
 * descends to a no-more-expensive one, or returns the input unchanged.
 *
 * ## Move types, in order
 *
 * 1. k-for-k with k = 1, 2, 3: replace k starters with k unused records that
 *    play the same slot positions. The issue text asks for "2-for-1 swaps —
 *    replace two expensive players with three cheap ones (or the reverse)",
 *    and that cannot be implemented literally: a squad is exactly eleven
 *    formation slots, so replacing two players with three produces twelve.
 *    The intent is that rating constraints are sometimes satisfied more
 *    cheaply by several mid-rated cards than by fewer high-rated ones, which
 *    needs several players exchanged at once; k-for-k with k up to 3 is that
 *    exchange. No variable-size squad is invented to force the literal
 *    wording.
 * 2. Targeted repair: a candidate k-for-k swap that leaves exactly one
 *    requirement failing is remembered, and when no k-for-k swap works the
 *    pass spends its remaining budget on one more swap that specifically
 *    moves that failing measure in the needed direction (`targetsFailure`)
 *    instead of continuing the cost-ordered enumeration. The combined move
 *    still goes through `validateSquad` before acceptance.
 *
 * Within every move type the enumeration is cheapest-first: per-slot candidate
 * lists are sorted by weighted contribution with unknown contributions last,
 * nested candidate loops are pruned as soon as the partial sum cannot beat the
 * replaced contribution, and slot combinations are visited in formation order.
 *
 * ## Acceptance is strict
 *
 * A move is applied only when all of these hold: every replaced and added
 * contribution is a known finite number (`UNKNOWN_CONTRIBUTION` is never
 * treated as free or as a saving), the added contributions are strictly below
 * the replaced ones (ties never improve and would break termination), the
 * resulting eleven players carry unique ids, and the full squad passes
 * `validateSquad` with its real chemistry. Moving the unknown-total case is
 * therefore impossible by construction: a `null` total has no comparable
 * saving and the pass returns the input unchanged. The returned result is what
 * the pass observed — it can never be more expensive than the input.
 *
 * ## Stop conditions and determinism
 *
 * The pass stops when no improving move exists, when the effort level's
 * lineups or iteration cap is reached, or when the time budget is exhausted.
 * The lineups/iteration caps are deterministic; the time budget is wall clock,
 * so a result produced with a binding budget may vary between runs. With a
 * generous budget (or `options.improvementTimeBudgetMs`) the search depends
 * only on the input data: no `Math.random`, no clock reads in any decision.
 * `improvements.elapsedMs` is measured and reported, but never compared.
 *
 * @param {{ players: Array<object> }} squad a valid squad, players in slot
 *   order
 * @param {Array<object>} pool the candidate pool `solve` takes
 * @param {{ challenge: object, effort?: number|'fast'|'balanced'|'thorough',
 *   improvementTimeBudgetMs?: number, weights?: object, clubLinks?: Array<object>,
 *   chemistryRuleSet?: object, seed?: number|string }} options `challenge` is
 *   required, exactly as for `reevaluate`; `effort` defaults to level 3
 *   (balanced); `improvementTimeBudgetMs` overrides the level's budget
 * @returns {{ squad: { players: Array<object>, chemistry: object },
 *   cost: number|null, costComplete: boolean, valid: boolean,
 *   failures: Array<object>, unverified: Array<object>,
 *   improvements: { acceptedMoves: number, lineups: number, iterations: number,
 *   elapsedMs: number } }} an invalid input squad is returned unchanged with
 *   `acceptedMoves: 0` and the validator's real failures; `costComplete` is
 *   false when any player's price is unknown; `elapsedMs` is wall clock and
 *   never feeds a search decision
 * @throws {Error} when `squad` is not a squad object, `pool` is not an array,
 *   `options.challenge` is missing or malformed, or `options.effort`/
 *   `options.improvementTimeBudgetMs` is malformed
 */
export function improve(squad, pool, options) {
  const inputPlayers = requireImproveSquad(squad);
  const resolved = resolveSolveOptions(options);
  requireChallenge(resolved.challenge);
  requirePool(pool);

  const { positions } = normaliseFormation(resolved.challenge.formation);
  const constraints = decodeConstraints(resolved.challenge);
  const clubIndex = buildClubIndexFor(resolved);
  const weights = resolveWeights(resolved.weights);
  const chemistryRuleSet = resolved.chemistryRuleSet ?? null;
  const pricedPool = pricePool(pool);

  if (inputPlayers.length !== positions.length || !hasUniqueIds(inputPlayers)) {
    // Not a squad any swap search can reason about. There is nothing to
    // validate and no honest failure to report, but the input must be handed
    // back untouched rather than patched into looking acceptable.
    return {
      squad,
      cost: null,
      costComplete: false,
      valid: false,
      failures: [],
      unverified: [],
      improvements: noImprovements(),
    };
  }

  const finalisePlayers = (candidatePlayers) =>
    finalise(candidatePlayers, { constraints, clubIndex, chemistryRuleSet, weights });

  const pricedInput = inputPlayers.map(priceRecord);
  const base = finalisePlayers(pricedInput);

  if (!base.valid) {
    return {
      squad,
      cost: base.cost,
      costComplete: base.costComplete,
      valid: false,
      failures: base.failures,
      unverified: base.unverified,
      improvements: noImprovements(),
    };
  }

  if (base.cost === UNKNOWN_CONTRIBUTION) {
    // An unknown total is never a free squad, and there is no saving to prove
    // against it, so the pass declines to touch it.
    return { ...base, improvements: noImprovements() };
  }

  const effort = resolveEffort(resolved.effort);
  const { improvementTimeBudgetMs } = resolved;
  if (
    improvementTimeBudgetMs !== undefined &&
    (!Number.isFinite(improvementTimeBudgetMs) || improvementTimeBudgetMs <= 0)
  ) {
    fail('options.improvementTimeBudgetMs must be a positive finite number when supplied');
  }
  const timeBudgetMs = improvementTimeBudgetMs ?? effort.timeBudgetMs;
  const startedAt = Date.now();

  let players = pricedInput;
  let bestResult = base;
  let lineups = 0;
  let iterations = 0;
  let acceptedMoves = 0;

  const deadlineExceeded = () => Date.now() - startedAt >= timeBudgetMs;
  const budgetExhausted = () => lineups >= effort.maxLineups || deadlineExceeded();

  /**
   * Candidate lists and current contributions for the observed squad. The
   * lists come from the same builder the greedy pass uses, filtered to the
   * records the squad has not already used.
   */
  const buildView = () => {
    const used = new Set(players.map(({ id }) => id));
    const lists = new Map();
    for (const [position, candidates] of buildCandidateLists(pricedPool, positions, weights)) {
      lists.set(
        position,
        candidates.filter(({ record }) => !used.has(record.id))
      );
    }
    return {
      contributions: players.map((player) => itemCost(player, weights).contribution),
      lists,
    };
  };

  /**
   * Full evaluation of one candidate move. Cost is checked before validation,
   * and an unknown contribution on either side rejects the move outright.
   * `lineups` counts only complete squads that reach `validateSquad`.
   */
  const evaluateMove = (view, slots, records) => {
    if (budgetExhausted()) return null;
    let removed = 0;
    let added = 0;
    for (let index = 0; index < slots.length; index++) {
      const currentContribution = view.contributions[slots[index]];
      const candidateContribution = records[index].contribution;
      if (
        currentContribution === UNKNOWN_CONTRIBUTION ||
        candidateContribution === UNKNOWN_CONTRIBUTION
      ) {
        return null;
      }
      removed += currentContribution;
      added += candidateContribution;
    }
    if (!(added < removed)) return null;
    const candidatePlayers = players.slice();
    slots.forEach((slot, index) => {
      candidatePlayers[slot] = records[index].record;
    });
    lineups += 1;
    const result = finalisePlayers(candidatePlayers);
    return { result, saving: removed - added, players: candidatePlayers };
  };

  const slotCombinations = new Map();
  for (const size of [1, 2, 3]) {
    const combinations = [];
    const chosen = [];
    const walk = (start) => {
      if (chosen.length === size) {
        combinations.push(chosen.slice());
        return;
      }
      for (let slot = start; slot < positions.length; slot++) {
        chosen.push(slot);
        walk(slot + 1);
        chosen.pop();
      }
    };
    walk(0);
    slotCombinations.set(size, combinations);
  }

  const rememberFailure = (failures, slots, records, evaluation) => {
    const failure = evaluation.result.failures[0];
    const key = `${failure.kind}:${JSON.stringify(failure.match ?? failure.scope)}`;
    const previous = failures.get(key);
    if (previous === undefined || evaluation.saving > previous.saving) {
      failures.set(key, { slots: slots.slice(), records, failure, saving: evaluation.saving });
    }
  };

  /** Cheapest-first enumeration of every k-for-k move over one slot combo. */
  const searchSize = (view, slots, lists, size, failures) => {
    let best = null;
    let stopped = false;
    const chosen = [];
    const removedTotal = slots.reduce((sum, slot) => sum + view.contributions[slot], 0);

    const walk = (depth, added) => {
      if (stopped) return;
      if (depth === size) {
        const evaluation = evaluateMove(view, slots, chosen);
        if (evaluation !== null) {
          if (evaluation.result.valid) {
            if (best === null || evaluation.saving > best.saving) best = evaluation;
          } else if (evaluation.result.failures.length === 1) {
            rememberFailure(failures, slots, chosen.slice(), evaluation);
          }
        }
        if (budgetExhausted()) stopped = true;
        return;
      }
      for (const candidate of lists[depth]) {
        if (stopped) return;
        if (candidate.contribution === UNKNOWN_CONTRIBUTION) break;
        if (added + candidate.contribution >= removedTotal) break;
        if (chosen.some((other) => other.record.id === candidate.record.id)) continue;
        chosen.push(candidate);
        walk(depth + 1, added + candidate.contribution);
        chosen.pop();
      }
    };

    walk(0, 0);
    return best;
  };

  /** Move type 4: one directed companion swap for a single-failure candidate. */
  const searchRepair = (view, failures) => {
    let best = null;
    const ranked = [...failures.values()].sort((left, right) => right.saving - left.saving);

    for (const failed of ranked) {
      if (budgetExhausted()) break;
      for (let slot = 0; slot < positions.length; slot++) {
        if (failed.slots.includes(slot)) continue;
        for (const candidate of view.lists.get(positions[slot])) {
          if (budgetExhausted()) return best;
          if (candidate.contribution === UNKNOWN_CONTRIBUTION) break;
          if (failed.records.some(({ record }) => record.id === candidate.record.id)) continue;
          if (
            !targetsFailure(candidate.record, failed.failure, players[slot], players, clubIndex)
          ) {
            continue;
          }
          const evaluation = evaluateMove(
            view,
            [...failed.slots, slot],
            [...failed.records, candidate]
          );
          if (evaluation !== null && evaluation.result.valid) {
            if (best === null || evaluation.saving > best.saving) best = evaluation;
          }
        }
      }
    }

    return best;
  };

  while (iterations < effort.maxIterations && !deadlineExceeded()) {
    iterations += 1;
    const view = buildView();
    const failures = new Map();
    let best = null;

    for (const [size, combinations] of slotCombinations) {
      if (budgetExhausted()) break;
      for (const slots of combinations) {
        if (budgetExhausted()) break;
        if (slots.some((slot) => view.contributions[slot] === UNKNOWN_CONTRIBUTION)) continue;
        const lists = slots.map((slot) => view.lists.get(positions[slot]));
        if (lists.some((list) => list.length === 0)) continue;
        const candidate = searchSize(view, slots, lists, size, failures);
        if (candidate !== null) {
          best = candidate;
          break;
        }
      }
      if (best !== null) break;
    }

    if (best === null) best = searchRepair(view, failures);
    if (best === null) break;

    players = best.players;
    bestResult = best.result;
    acceptedMoves += 1;
  }

  return {
    ...bestResult,
    improvements: {
      acceptedMoves,
      lineups,
      iterations,
      elapsedMs: Date.now() - startedAt,
    },
  };
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
 * The closed reason vocabulary fixed by the design contract
 * (`design/copy.en.json` -> `alts.reason`, and its Danish twin). The solver
 * emits these structured keys — never English sentences — and the UI joins
 * them to translated copy. A key outside this list has no copy to render, so
 * the list is closed and the tests assert membership against it.
 *
 * This deliberately replaces the "short reason string" wording in the issue
 * text: the project's design contract requires structured diagnostics and the
 * UI owns the copy.
 */
const ALTERNATIVE_REASON_KEYS = Object.freeze([
  'sameLeague',
  'sameNation',
  'sameClub',
  'keepsChemistry',
  'oneRatingDown',
  'twoRatingDown',
  'breaksLink',
  'keepsLinks',
  'fromClubPool',
  'positionMatch',
  'outOfPosition',
]);

const REASON_KEY_SET = new Set(ALTERNATIVE_REASON_KEYS);

/**
 * How many nation/league/club links the current pick has to the rest of the
 * squad that the candidate would not have: a partner counts one per dimension,
 * the same unit `countLinks` reports for chemistry.
 */
const brokenLinkCount = (current, candidate, others, clubIndex) => {
  let broken = 0;
  for (const other of others) {
    if (current.nationId === other.nationId && candidate.nationId !== other.nationId) broken += 1;
    if (current.leagueId === other.leagueId && candidate.leagueId !== other.leagueId) broken += 1;
    if (
      clubIndex.sameClub(current.clubId, other.clubId) &&
      !clubIndex.sameClub(candidate.clubId, other.clubId)
    ) {
      broken += 1;
    }
  }
  return broken;
};

const totalLinks = (player, others, clubIndex) => {
  const links = countLinks(player, others, clubIndex);
  return links.nation + links.league + links.club;
};

/**
 * Builds one alternative's structured reasons from the actual swap. Every
 * reason must be true of that candidate in that squad: a guessed reason is a
 * lie the panel would render. `baseScore` and `candidateScore` are the computed
 * chemistry totals; `keepsChemistry` is only emitted when both are real
 * computed numbers and the swap does not lower the total, so the placeholder
 * `0` of an unresolved profile is never compared.
 */
const buildAlternativeReasons = ({
  candidate,
  current,
  others,
  slotPosition,
  formation,
  clubIndex,
  baseScore,
  candidateScore,
  keptLinks,
}) => {
  const reasons = [];
  const push = (key, params) => reasons.push(params === undefined ? { key } : { key, params });

  if (others.some((player) => player.leagueId === candidate.leagueId)) push('sameLeague');
  if (others.some((player) => player.nationId === candidate.nationId)) push('sameNation');
  if (others.some((player) => clubIndex.sameClub(player.clubId, candidate.clubId))) {
    push('sameClub');
  }

  if (baseScore !== null && candidateScore !== null && candidateScore >= baseScore) {
    push('keepsChemistry');
  }

  const ratingDrop = current.rating - candidate.rating;
  if (ratingDrop === 1) push('oneRatingDown');
  else if (ratingDrop === 2) push('twoRatingDown');

  const broken = brokenLinkCount(current, candidate, others, clubIndex);
  if (broken > 0) push('breaksLink', { count: broken });
  else if (keptLinks > 0) push('keepsLinks');

  if (candidate.cardState !== 'concept') push('fromClubPool');

  if (candidate.preferredPosition === slotPosition) {
    push('positionMatch', { formation });
  } else {
    push('outOfPosition');
  }

  for (const reason of reasons) {
    if (!REASON_KEY_SET.has(reason.key)) {
      fail(`alternative reason ${JSON.stringify(reason.key)} is not in the design vocabulary`);
    }
  }
  return reasons;
};

/**
 * The interactive feature: for every unlocked slot, the candidates that can
 * play it and keep the whole squad valid when swapped in, ranked by fodder
 * contribution ascending with unknown contributions last, the current pick
 * excluded. Locked slots get an empty array; an incomplete squad (a fill that
 * could not complete) gets empty arrays everywhere, because no swap can be
 * validated.
 *
 * `record` is the solver-priced pool record itself — the same stable shape
 * `solve` returns, carrying `cardState`, `price`, `priceSource` — so the UI can
 * render identity, rating and position. `costDelta` is the `itemCost`
 * contribution difference versus the pick currently in the slot: negative when
 * the candidate is cheaper, and `UNKNOWN_CONTRIBUTION` (`null`) when either
 * side is unpriced, because an unknown price is never treated as 0. `reasons`
 * is structured key/params data, never prose (see the vocabulary above).
 *
 * A candidate must fit the slot position, the same rule the greedy placement
 * uses, so every alternative is placeable; `positionMatch` and
 * `outOfPosition` describe whether it fits at its natural position. Only swaps
 * that `validateSquad` approves are emitted, so a returned alternative can
 * never invalidate the squad.
 *
 * Bounded by construction: one pass over the pool builds the per-position
 * candidate lists, each unlocked slot then filters its own list, and there are
 * no clock reads, so the result stays deterministic. The interactive latency
 * therefore comes from the pool size, and `options.timeBudgetMs` keeps bounding
 * the restart search rather than this pass.
 */
const buildAlternatives = ({
  squad,
  positions,
  pool,
  constraints,
  clubIndex,
  chemistryRuleSet,
  weights,
  lockedSet,
  formation,
}) => {
  const alternatives = positions.map(() => []);
  const players = squad.players;
  if (players.length !== positions.length) return alternatives;

  // The same position-fit filter and cost sort the greedy pass uses, built once
  // here instead of once per unlocked slot.
  const candidateLists = buildCandidateLists(pool, positions, weights);
  const usedIds = new Set(players.map(({ id }) => id));
  const baseScore = scoreSquad(players, chemistryRuleSet, clubIndex).score;

  for (let slot = 0; slot < positions.length; slot++) {
    if (lockedSet.has(slot)) continue;

    const current = players[slot];
    const currentContribution = itemCost(current, weights).contribution;
    const position = positions[slot];
    const others = players.filter((_, index) => index !== slot);
    const keptLinks = totalLinks(current, others, clubIndex);

    const candidates = candidateLists
      .get(position)
      .filter(({ record }) => !usedIds.has(record.id));

    for (const candidate of candidates) {
      const swapped = players.slice();
      swapped[slot] = candidate.record;
      const scored = scoreSquad(swapped, chemistryRuleSet, clubIndex);
      const validation = validateSquad(
        { players: swapped, chemistry: scored.chemistry },
        constraints,
        { clubLinks: (clubId) => clubIndex.groupOf(clubId) }
      );
      if (!validation.valid) continue;

      const costDelta =
        candidate.contribution === UNKNOWN_CONTRIBUTION ||
        currentContribution === UNKNOWN_CONTRIBUTION
          ? UNKNOWN_CONTRIBUTION
          : candidate.contribution - currentContribution;

      alternatives[slot].push({
        record: candidate.record,
        costDelta,
        reasons: buildAlternativeReasons({
          candidate: candidate.record,
          current,
          others,
          slotPosition: position,
          formation,
          clubIndex,
          baseScore,
          candidateScore: scored.score,
          keptLinks,
        }),
      });
    }
  }

  return alternatives;
};

/**
 * The interactive re-solve entry point from `docs/PLAN.md` §2.6: keep every
 * player whose slot is locked, re-run the greedy seed and the seeded restarts
 * over the unlocked slots only, and return the ranked `alternatives` for every
 * unlocked slot alongside the solve result.
 *
 * This is not local search. Full local search — swapping players in and out
 * until cost stops improving — is a later milestone; this function re-runs the
 * greedy seed around the locked players and does not pretend otherwise.
 *
 * Locked players are ordinary inputs to every constraint calculation: they
 * count towards league/nation/club and chemistry exactly as any other starter.
 * A lock is never silently undone: when the locked players make the challenge
 * infeasible, the result is `valid: false` with the validator's real failures.
 * An incomplete squad is normal here (it is an in-progress squad), so this
 * function never throws merely because fewer than eleven players are present:
 * locked slots without a player are simply not pinned and get filled. A locked
 * record that does not fit its slot position is kept anyway — the lock is the
 * user's instruction — and the validator reports the resulting failures.
 *
 * `pool` is the same candidate pool `solve` takes and `options.challenge` is
 * required so the constraints are decoded by the same path `solve` uses;
 * `options` accepts everything `solve` accepts (`seed`, `timeBudgetMs`,
 * `weights`, `clubLinks`, `chemistryRuleSet`).
 *
 * @param {{ players: Array<object>, chemistry?: object }} squad the current
 *   squad, players in slot order; may be incomplete
 * @param {Array<number>} lockedSlots slot indexes to keep, 0..10
 * @param {Array<object>} pool the candidate pool `solve` takes
 * @param {{ challenge: object, seed?: number|string, timeBudgetMs?: number,
 *   weights?: object, clubLinks?: Array<object>, chemistryRuleSet?: object }} options
 * @returns {{ squad: { players: Array<object>, chemistry: object },
 *   cost: number|null, costComplete: boolean, valid: boolean,
 *   failures: Array<object>, unverified: Array<object>,
 *   alternatives: Array<Array<{ record: object, costDelta: number|null,
 *   reasons: Array<{ key: string, params?: object }> }>> }}
 *   `alternatives[slot]` is empty for locked slots and for an incomplete squad;
 *   `costDelta` is `null` when either contribution is unknown; `costComplete`
 *   is false when any starter's price is unknown
 * @throws {Error} when `lockedSlots` names a slot outside the formation, a
 *   duplicate slot, `squad` is not a squad object, `options.challenge` is
 *   missing or malformed, or `pool` is not an array
 */
export function reevaluate(squad, lockedSlots, pool, options) {
  const players = suppliedPlayers(squad);
  const resolved = resolveSolveOptions(options);
  requireChallenge(resolved.challenge);
  const { positions } = normaliseFormation(resolved.challenge.formation);
  const locked = requireLockedSlots(lockedSlots, positions.length);
  requirePool(pool);

  const constraints = decodeConstraints(resolved.challenge);
  const clubIndex = buildClubIndexFor(resolved);
  const weights = resolveWeights(resolved.weights);
  const pricedPool = pricePool(pool);

  const initialPlayers = new Array(positions.length).fill(null);
  for (const slot of locked) {
    if (slot >= players.length) continue;
    initialPlayers[slot] = priceRecord(players[slot]);
  }

  const best = buildBestAttempt({
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

  return {
    ...best,
    alternatives: buildAlternatives({
      squad: best.squad,
      positions,
      pool: pricedPool,
      constraints,
      clubIndex,
      chemistryRuleSet: resolved.chemistryRuleSet ?? null,
      weights,
      lockedSet: new Set(locked),
      formation: resolved.challenge.formation,
    }),
  };
}
