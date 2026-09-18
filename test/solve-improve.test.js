import { describe, expect, it } from 'vitest';

import {
  EFFORT_LEVELS,
  improve,
  resolveEffort,
  solve,
} from '../src/solver/solve.js';
import {
  normaliseChemistryProfile,
  normaliseTeamChemLinks,
} from '../src/ea/adapter.js';
import { buildPool, normaliseClub } from '../src/solver/candidates.js';
import { buildClubIndex } from '../src/solver/chemistry.js';
import { normaliseRequirements } from '../src/solver/requirements.js';
import { validateSquad } from '../src/solver/validate.js';
import { PINNED_ELIGIBILITY_KEYS, SCOPE_VALUES, withEligibility } from './helpers/eligibility.js';
import clubFixture from './fixtures/club-items.json';
import linksFixture from './fixtures/chemistry-teamlinks.json';
import profilesFixture from './fixtures/chemistry-profiles.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import set16 from './fixtures/sbs-set-16-challenges.json';

const decode = (challenge) =>
  normaliseRequirements(challenge.elgReq, {
    operation: challenge.elgOperation,
    keys: PINNED_ELIGIBILITY_KEYS,
    scopes: SCOPE_VALUES,
  }).constraints;

const POOL = buildPool(normaliseClub(clubFixture.itemData));

const CLUB_INDEX = buildClubIndex(normaliseTeamChemLinks(linksFixture.teamChemLinks));

const VALIDATOR_OPTIONS = { clubLinks: (clubId) => CLUB_INDEX.groupOf(clubId) };

const CHEMISTRY_RULE_SET = normaliseChemistryProfile({
  ...profilesFixture,
  mappings: [{ profileId: 4, rarityIds: [0, 69] }],
});

const fixtureOptions = (overrides = {}) =>
  withEligibility({
    seed: 1,
    chemistryRuleSet: CHEMISTRY_RULE_SET,
    clubLinks: linksFixture.teamChemLinks,
    ...overrides,
  });

const F442 = ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'];

const rawItem = ({
  id,
  position,
  rating,
  price,
  nation = 1,
  league = 1,
  club = 100,
  untradeable = false,
}) => ({
  id,
  assetId: id,
  rating,
  nation,
  leagueId: league,
  teamid: club,
  rareflag: 0,
  cardsubtypeid: 0,
  playStyle: 0,
  preferredPosition: position,
  possiblePositions: [position],
  untradeable,
  pile: 7,
  owners: 1,
  isCollected: true,
  marketAverage: price,
  marketDataMinPrice: null,
  marketDataMaxPrice: null,
  discardValue: null,
});

const TEAM_RATING_80 = {
  formation: 'f442',
  elgOperation: 'AND',
  elgReq: [
    { eligibilityKey: 19, eligibilitySlot: 1, eligibilityValue: 80, type: 'TEAM_RATING_1_TO_100' },
    { eligibilityKey: 13, eligibilitySlot: 1, eligibilityValue: 0, type: 'SCOPE' },
  ],
};

const NO_REQUIREMENTS = { formation: 'f442', elgOperation: 'AND', elgReq: [] };

/*
 * The headroom pool. Nine slots have exactly one card (rating 80, price 1).
 * Slot 1 (LB) offers six cheap rating-60 cards and one rating-99 card at 50.
 * Slot 10 (ST) offers six cheap rating-60 cards and one rating-99 card at 1000.
 *
 * The greedy fills the nine single-card slots first, then slot 1. At slot 1
 * the rating-60 card keeps the {TEAM_RATING >= 80} bound reachable only because
 * the unused 99 at slot 10 could still be played, so the greedy takes it, and
 * slot 10 is then forced into the 99 at 1000. Total 9 + 1 + 1000 = 1010.
 *
 * The cheapest valid squad is the 99 at slot 1 (50) plus a 60 at slot 10 (1):
 * 9 + 50 + 1 = 60. Only a swap of two players at once reaches it, and the
 * rating-99 alternative at slot 1 is deliberately outside the restart window
 * (five cheaper candidates ahead of it), so the greedy seed cannot stumble
 * into it.
 */
const headroomItems = () => {
  const items = [];
  let id = 800000;
  const singleSlots = [0, 2, 3, 4, 5, 6, 7, 8, 9];
  for (const slot of singleSlots) {
    items.push(rawItem({ id: id++, position: F442[slot], rating: 80, price: 1 }));
  }
  for (let copy = 0; copy < 6; copy++) {
    items.push(rawItem({ id: id++, position: 'LB', rating: 60, price: 1 }));
  }
  items.push(rawItem({ id: id++, position: 'LB', rating: 99, price: 50 }));
  for (let copy = 0; copy < 6; copy++) {
    items.push(rawItem({ id: id++, position: 'ST', rating: 60, price: 1 }));
  }
  items.push(rawItem({ id: id++, position: 'ST', rating: 99, price: 1000 }));
  return items;
};

const headroomPool = () => buildPool(normaliseClub(headroomItems()), { groupSize: 6 });

// One card per slot, three rating bands each; a hand-built expensive squad and
// cheaper candidates for every slot.
const plainItems = () => {
  const items = [];
  let id = 810000;
  for (const position of F442) {
    items.push(rawItem({ id: id++, position, rating: 72, price: 30 }));
    items.push(rawItem({ id: id++, position, rating: 71, price: 20 }));
    items.push(rawItem({ id: id++, position, rating: 70, price: 10 }));
  }
  return items;
};

const squadAtPrice = (records, rating) => {
  const used = new Set();
  return F442.map((position) => {
    const record = records.find(
      (candidate) =>
        candidate.preferredPosition === position &&
        candidate.rating === rating &&
        !used.has(candidate.id)
    );
    used.add(record.id);
    return record;
  });
};

describe('resolveEffort and EFFORT_LEVELS', () => {
  it('maps the named tiers to levels 1, 3 and 5 and defaults to balanced', () => {
    expect(resolveEffort('fast').level).toBe(1);
    expect(resolveEffort('balanced').level).toBe(3);
    expect(resolveEffort('thorough').level).toBe(5);
    expect(resolveEffort(undefined).level).toBe(3);
    expect(resolveEffort(1)).toBe(EFFORT_LEVELS[1]);
    expect(resolveEffort(5)).toBe(EFFORT_LEVELS[5]);
  });

  it('exposes an increasing lineups/iterations/time budget ladder', () => {
    for (let level = 1; level < 5; level++) {
      expect(EFFORT_LEVELS[level + 1].maxLineups).toBeGreaterThan(
        EFFORT_LEVELS[level].maxLineups
      );
      expect(EFFORT_LEVELS[level + 1].maxIterations).toBeGreaterThanOrEqual(
        EFFORT_LEVELS[level].maxIterations
      );
      expect(EFFORT_LEVELS[level + 1].timeBudgetMs).toBeGreaterThanOrEqual(
        EFFORT_LEVELS[level].timeBudgetMs
      );
    }
    expect(EFFORT_LEVELS[5].maxLineups).toBeGreaterThan(EFFORT_LEVELS[1].maxLineups);
  });

  it('rejects a level outside 1..5 and an unknown tier name', () => {
    expect(() => resolveEffort(0)).toThrow(/effort/);
    expect(() => resolveEffort(6)).toThrow(/effort/);
    expect(() => resolveEffort(2.5)).toThrow(/effort/);
    expect(() => resolveEffort('quick')).toThrow(/effort/);
    expect(() => resolveEffort(null)).toThrow(/effort/);
  });
});

describe('improve', () => {
  it('finds the cheaper squad a cheapest-first greedy cannot reach', () => {
    const pool = headroomPool();
    const greedy = solve(TEAM_RATING_80, pool, withEligibility({ seed: 1 }));

    expect(greedy.valid).toBe(true);
    expect(greedy.cost).toBe(1010);

    const improved = improve(greedy.squad, pool, {
      challenge: TEAM_RATING_80,
      effort: 3,
      improvementTimeBudgetMs: 60000,
      ...withEligibility(),
    });

    expect(improved.valid).toBe(true);
    expect(improved.cost).toBe(60);
    expect(improved.cost).toBeLessThan(greedy.cost);
    expect(improved.improvements.acceptedMoves).toBeGreaterThanOrEqual(1);
    expect(new Set(improved.squad.players.map(({ id }) => id)).size).toBe(11);
    expect(validateSquad(improved.squad, decode(TEAM_RATING_80), {}).valid).toBe(true);
  });

  it('keeps the squad valid after every accepted move, checked with the real validator', () => {
    const items = plainItems();
    const records = normaliseClub(items);
    const pool = buildPool(records);

    let current = { players: squadAtPrice(records, 72) };
    let accepted = 0;

    for (let call = 0; call < 20; call++) {
      const improved = improve(current, pool, {
        challenge: NO_REQUIREMENTS,
        effort: 1,
        improvementTimeBudgetMs: 60000,
        ...withEligibility(),
      });

      // Effort 1 allows one improvement round, so at most one accepted move
      // per call; every accepted move is observed through the real validator.
      expect(improved.improvements.acceptedMoves).toBeLessThanOrEqual(1);
      expect(validateSquad(improved.squad, decode(NO_REQUIREMENTS), VALIDATOR_OPTIONS).valid).toBe(
        true
      );
      expect(new Set(improved.squad.players.map(({ id }) => id)).size).toBe(11);

      accepted += improved.improvements.acceptedMoves;
      if (improved.improvements.acceptedMoves === 0) {
        expect(improved.cost).toBe(110);
        break;
      }
      current = improved.squad;
    }

    expect(accepted).toBeGreaterThanOrEqual(2);
  });

  it('never raises the cost and never upgrades an invalid squad for the fixture challenges', () => {
    const challenges = [...set10.challenges, ...set16.challenges];

    for (const challenge of challenges) {
      const before = solve(challenge, POOL, fixtureOptions());
      const after = improve(before.squad, POOL, fixtureOptions({ challenge }));

      expect(validateSquad(after.squad, decode(challenge), VALIDATOR_OPTIONS).valid).toBe(
        after.valid
      );

      if (before.valid) {
        expect(after.valid, `challenge ${challenge.challengeId}`).toBe(true);
        expect(after.cost).toBeLessThanOrEqual(before.cost);
      } else {
        expect(after.valid, `challenge ${challenge.challengeId}`).toBe(false);
        expect(after.improvements.acceptedMoves).toBe(0);
        expect(after.squad.players.map(({ id }) => id)).toEqual(
          before.squad.players.map(({ id }) => id)
        );
      }
    }
  });

  it('returns an invalid input squad unchanged with its real failures', () => {
    const challenge = set10.challenges[0];
    const solved = solve(challenge, POOL, fixtureOptions());
    expect(solved.valid).toBe(false);

    const result = improve(solved.squad, POOL, fixtureOptions({ challenge }));

    expect(result.valid).toBe(false);
    expect(result.improvements.acceptedMoves).toBe(0);
    expect(result.squad.players.map(({ id }) => id)).toEqual(
      solved.squad.players.map(({ id }) => id)
    );
    expect(result.failures.length).toBeGreaterThan(0);
    for (const failure of result.failures) {
      expect(failure.diagnostic.id).toEqual(expect.any(String));
    }
  });

  it('never treats an unknown contribution as free', () => {
    // Every club card is priced; the only cheaper-looking GK is unpriced.
    const items = [];
    let id = 820000;
    for (const position of F442) {
      items.push(rawItem({ id: id++, position, rating: 70, price: 10 }));
    }
    items.push(rawItem({ id: id++, position: 'GK', rating: 80, price: null }));
    const records = normaliseClub(items);
    const pool = buildPool(records);

    const result = improve(
      { players: squadAtPrice(records, 70) },
      pool,
      {
        challenge: NO_REQUIREMENTS,
        effort: 5,
        improvementTimeBudgetMs: 60000,
        ...withEligibility(),
      }
    );

    expect(result.cost).toBe(110);
    expect(result.improvements.acceptedMoves).toBe(0);
    expect(result.squad.players.map(({ id }) => id)).toEqual(
      squadAtPrice(records, 70).map(({ id }) => id)
    );
  });

  it('returns an unpriced input squad unchanged instead of guessing a saving', () => {
    const items = [];
    let id = 830000;
    for (const position of F442) {
      items.push(rawItem({ id: id++, position, rating: 70, price: 10 }));
    }
    items.push(rawItem({ id: id++, position: 'GK', rating: 60, price: null }));
    const records = normaliseClub(items);
    const pool = buildPool(records);

    const unpriced = squadAtPrice(records, 70).map((player) =>
      player.preferredPosition === 'GK' ? records.find(({ rating }) => rating === 60) : player
    );

    const result = improve({ players: unpriced }, pool, {
      challenge: NO_REQUIREMENTS,
      effort: 5,
      improvementTimeBudgetMs: 60000,
      ...withEligibility(),
    });

    expect(result.cost).toBeNull();
    expect(result.improvements.acceptedMoves).toBe(0);
    expect(result.squad.players.map(({ id }) => id)).toEqual(unpriced.map(({ id }) => id));
  });

  it('does less work at effort 1 than at effort 5 and terminates inside the budget', () => {
    const pool = headroomPool();
    const greedy = solve(TEAM_RATING_80, pool, withEligibility({ seed: 1 }));

    const fast = improve(greedy.squad, pool, {
      challenge: TEAM_RATING_80,
      effort: 1,
      improvementTimeBudgetMs: 60000,
      ...withEligibility(),
    });
    const thorough = improve(greedy.squad, pool, {
      challenge: TEAM_RATING_80,
      effort: 5,
      improvementTimeBudgetMs: 60000,
      ...withEligibility(),
    });

    expect(fast.improvements.lineups).toBeLessThanOrEqual(EFFORT_LEVELS[1].maxLineups);
    expect(fast.improvements.acceptedMoves).toBe(0);
    expect(fast.improvements.elapsedMs).toBeLessThan(2000);

    expect(thorough.improvements.lineups).toBeGreaterThan(fast.improvements.lineups);
    expect(thorough.improvements.iterations).toBeGreaterThan(fast.improvements.iterations);
    expect(thorough.improvements.acceptedMoves).toBeGreaterThanOrEqual(1);
    expect(thorough.cost).toBeLessThan(fast.cost);
  });

  it('is deterministic for the same seed and effort with a generous budget', () => {
    // #39 is the fixture challenge where the pass actually accepts moves, so
    // determinism is exercised over a real search, not a no-op.
    const challenge = set16.challenges[3];
    const before = solve(challenge, POOL, fixtureOptions());
    const options = fixtureOptions({
      challenge,
      seed: 42,
      effort: 5,
      improvementTimeBudgetMs: 60000,
    });

    const first = improve(before.squad, POOL, options);
    const second = improve(before.squad, POOL, options);

    expect(second.squad).toEqual(first.squad);
    expect(second.improvements.acceptedMoves).toBe(first.improvements.acceptedMoves);
    expect(second.improvements.lineups).toBe(first.improvements.lineups);
    expect(second.improvements.iterations).toBe(first.improvements.iterations);
  });

  it('requires the challenge to decode constraints', () => {
    const before = solve(set16.challenges[0], POOL, fixtureOptions());

    expect(() => improve(before.squad, POOL, {})).toThrow(/challenge/);
  });
});

describe('solve with effort', () => {
  it('returns the improved winner and wires the pass into the solve result', () => {
    const pool = headroomPool();

    const plain = solve(TEAM_RATING_80, pool, withEligibility({ seed: 1 }));
    expect(plain.cost).toBe(1010);
    expect(plain.improvements.acceptedMoves).toBe(0);

    const wired = solve(TEAM_RATING_80, pool, {
      seed: 1,
      effort: 5,
      improvementTimeBudgetMs: 60000,
      ...withEligibility(),
    });

    expect(wired.valid).toBe(true);
    expect(wired.cost).toBe(60);
    expect(wired.cost).toBeLessThan(plain.cost);
    expect(wired.improvements.acceptedMoves).toBeGreaterThanOrEqual(1);
    expect(validateSquad(wired.squad, decode(TEAM_RATING_80), {}).valid).toBe(true);
  });

  it('is deterministic across two solve runs with the same effort and seed', () => {
    const challenge = set16.challenges[3];
    const options = fixtureOptions({ effort: 3, seed: 7, improvementTimeBudgetMs: 60000 });

    const first = solve(challenge, POOL, options);
    const second = solve(challenge, POOL, options);

    expect(second.squad).toEqual(first.squad);
  });
});
