import { describe, expect, it } from 'vitest';

import {
  FORMATION_SLOTS,
  PINNED_ELIGIBILITY_KEYS,
  SCOPE_VALUES,
  normaliseChemistryProfile,
  normaliseFormation,
  normaliseTeamChemLinks,
} from '../src/ea/adapter.js';
import { buildPool, normaliseClub } from '../src/solver/candidates.js';
import { buildClubIndex } from '../src/solver/chemistry.js';
import { orderConstraints, reevaluate, solve } from '../src/solver/solve.js';
import { validateSquad } from '../src/solver/validate.js';
import { normaliseRequirements } from '../src/solver/requirements.js';
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

// The fixture pool is the real entry-point composition named by the issue:
// trim the normalised club through `buildPool` with its defaults.
const POOL = buildPool(normaliseClub(clubFixture.itemData));

const CLUB_INDEX = buildClubIndex(normaliseTeamChemLinks(linksFixture.teamChemLinks));

// `validateSquad` must see the same linked-club identity the chemistry layer
// uses, or SAME_CLUB_COUNT would measure a different squad than the solver
// built.
const VALIDATOR_OPTIONS = { clubLinks: (clubId) => CLUB_INDEX.groupOf(clubId) };

// The captured profile maps only rarity 69 while every captured club item is
// rarity 0, so the fixture rule set as captured cannot score the fixture club.
// Remapping rarity 0 onto the same profile keeps every real profile rule and
// exercises `squadChemistry`; the number is still marked unverified, because
// CHEMISTRY_FORMULA_VERIFIED is false.
const CHEMISTRY_RULE_SET = normaliseChemistryProfile({
  ...profilesFixture,
  mappings: [{ profileId: 4, rarityIds: [0, 69] }],
});

const options = (overrides = {}) => ({
  seed: 1,
  chemistryRuleSet: CHEMISTRY_RULE_SET,
  clubLinks: linksFixture.teamChemLinks,
  ...overrides,
});

const validate = (result, challenge) =>
  validateSquad(result.squad, decode(challenge), VALIDATOR_OPTIONS);

const positionsFor = (player) =>
  Array.isArray(player.possiblePositions) && player.possiblePositions.length > 0
    ? player.possiblePositions
    : [player.preferredPosition];

const challenges = [...set10.challenges, ...set16.challenges];

// Hand-derived from the issue's formation table. The table is EA payload
// vocabulary, so it belongs in the adapter, and every code is pinned to the
// exact ordered XI rather than merely "eleven valid position strings".
const EXPECTED_FORMATIONS = Object.freeze({
  f343: ['GK', 'LB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'LW', 'ST', 'RW'],
  f442: ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'],
  f4141: ['GK', 'LB', 'CB', 'CB', 'RB', 'CDM', 'LM', 'CM', 'CM', 'RM', 'ST'],
  f451: ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'CM', 'RM', 'ST'],
  f532: ['GK', 'LB', 'CB', 'CB', 'CB', 'RB', 'CM', 'CM', 'CM', 'ST', 'ST'],
  f5212: ['GK', 'LB', 'CB', 'CB', 'CB', 'RB', 'CDM', 'CDM', 'CAM', 'ST', 'ST'],
  f3142: ['GK', 'CB', 'CB', 'CB', 'CDM', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'],
});

const POSITION_VOCABULARY = new Set([
  'GK',
  'CB',
  'LB',
  'RB',
  'CDM',
  'CM',
  'CAM',
  'LM',
  'RM',
  'LW',
  'RW',
  'ST',
]);

const codes = Object.keys(EXPECTED_FORMATIONS);

describe('normaliseFormation', () => {
  it('pins exactly the seven justified codes and no others', () => {
    expect(Object.keys(FORMATION_SLOTS).sort()).toEqual([...codes].sort());
  });

  it('returns the hand-derived ordered XI for every supported code', () => {
    for (const [code, positions] of Object.entries(EXPECTED_FORMATIONS)) {
      expect(normaliseFormation(code)).toEqual({ formation: code, positions });
      expect(FORMATION_SLOTS[code]).toHaveLength(11);
    }
  });

  it('draws every slot from the fixed position vocabulary', () => {
    for (const code of codes) {
      for (const position of normaliseFormation(code).positions) {
        expect(POSITION_VOCABULARY.has(position)).toBe(true);
      }
    }
  });

  it('throws on an unknown formation instead of guessing a shape', () => {
    expect(() => normaliseFormation('f999')).toThrow(/unknown formation/);
    expect(() => normaliseFormation('')).toThrow(/unknown formation/);
    expect(() => normaliseFormation('F343')).toThrow(/unknown formation/);
  });

  it('throws on a non-string formation', () => {
    expect(() => normaliseFormation(343)).toThrow(/must be a string/);
    expect(() => normaliseFormation(null)).toThrow(/must be a string/);
    expect(() => normaliseFormation(undefined)).toThrow(/must be a string/);
  });

  it('hands out a fresh array so a caller cannot mutate module state', () => {
    const first = normaliseFormation('f343');
    first.positions[0] = 'ST';
    first.positions.push('CB');

    expect(first.positions).not.toEqual(EXPECTED_FORMATIONS.f343);
    expect(normaliseFormation('f343').positions).toEqual(EXPECTED_FORMATIONS.f343);
    expect(FORMATION_SLOTS.f343).toEqual(EXPECTED_FORMATIONS.f343);
  });
});

describe('orderConstraints', () => {
  it('orders the restrictive same-league/nation requirements before the softer counts', () => {
    const [challenge25] = set10.challenges;

    // Hand-derived priority: group caps first, then distinct-count exactness,
    // then the unverified chemistry and quality markers.
    expect(orderConstraints(decode(challenge25)).map(({ kind }) => kind)).toEqual([
      'SAME_NATION_COUNT',
      'SAME_LEAGUE_COUNT',
      'NATION_COUNT',
      'LEAGUE_COUNT',
      'CHEMISTRY_POINTS',
      'PLAYER_QUALITY',
    ]);
  });

  it('keeps ties in the decoder order and does not mutate the input', () => {
    const [challenge35] = set16.challenges;
    const constraints = decode(challenge35);
    const before = constraints.slice();

    const ordered = orderConstraints(constraints);

    // Two PLAYER_COUNT_MATCH constraints share a priority; the nation match is
    // decoded before the player-level match and must stay ahead.
    expect(ordered.map(({ kind }) => kind)).toEqual([
      'PLAYER_COUNT_MATCH',
      'PLAYER_COUNT_MATCH',
      'CLUB_COUNT',
      'CHEMISTRY_POINTS',
      'PLAYER_QUALITY',
    ]);
    expect(ordered[0].match).toEqual({ nationIds: [42] });
    expect(ordered[1].match).toEqual({ playerLevels: [2] });
    expect(constraints).toEqual(before);
  });

  it('orders a rating floor after the composition requirements', () => {
    const challenge26 = set10.challenges[1];

    const kinds = orderConstraints(decode(challenge26)).map(({ kind }) => kind);

    expect(kinds.indexOf('TEAM_RATING')).toBeGreaterThan(kinds.indexOf('SAME_NATION_COUNT'));
    expect(kinds.indexOf('TEAM_RATING')).toBeGreaterThan(kinds.indexOf('SAME_LEAGUE_COUNT'));
  });
});

describe('solve', () => {
  it('returns eleven unique, slot-fitting records for every captured challenge', () => {
    for (const challenge of challenges) {
      const { positions } = normaliseFormation(challenge.formation);
      const result = solve(challenge, POOL, options());

      expect(result.squad.players).toHaveLength(11);
      expect(new Set(result.squad.players.map(({ id }) => id)).size).toBe(11);
      expect(new Set(result.squad.players.map(({ assetId }) => assetId)).size).toBe(11);
      result.squad.players.forEach((player, slot) => {
        expect(positionsFor(player)).toContain(positions[slot]);
      });
      expect(Array.isArray(result.failures)).toBe(true);
      expect(Array.isArray(result.unverified)).toBe(true);
    }
  });

  it('never reports valid unless validateSquad agrees', () => {
    for (const challenge of challenges) {
      const result = solve(challenge, POOL, options());

      expect(validate(result, challenge).valid, `challenge ${challenge.challengeId}`).toBe(
        result.valid
      );
    }
  });

  it('reports exactly the failures validateSquad reports', () => {
    for (const challenge of challenges) {
      const result = solve(challenge, POOL, options());
      const revalidated = validate(result, challenge);

      if (revalidated.valid) {
        expect(result.valid).toBe(true);
        expect(result.failures).toEqual([]);
      } else {
        // The solver validates its own hardest-first constraint order, so the
        // failures are the same entries in a different sequence; compare the
        // content, not the iteration order.
        expect(result.valid).toBe(false);
        expect(result.failures.length).toBe(revalidated.failures.length);
        for (const failure of revalidated.failures) {
          expect(result.failures).toContainEqual(failure);
        }
      }
    }
  });

  it('is deterministic for the same seed', () => {
    const first = solve(set16.challenges[3], POOL, options({ seed: 42 }));
    const second = solve(set16.challenges[3], POOL, options({ seed: 42 }));

    expect(second).toEqual(first);
  });

  it('accepts lockedSlots but leaves them to the interactive re-solve', () => {
    const withLocks = solve(set16.challenges[0], POOL, options({ lockedSlots: [0, 5] }));
    const without = solve(set16.challenges[0], POOL, options());

    expect(withLocks).toEqual(without);
  });

  it('returns within the time budget instead of hanging on an unsolvable challenge', () => {
    const started = Date.now();
    const result = solve(set10.challenges[0], POOL, options({ timeBudgetMs: 1 }));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(result.squad.players).toHaveLength(11);
    expect(result.valid).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it('propagates an unknown price as an unknown total, never as free', () => {
    // Every record is unpriced and unfillable from EA's fallback: if the cost
    // model dropped `null` on the floor, this squad would report 0.
    const rawItems = ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'].map(
      (position, index) => ({
        id: 900000 + index,
        assetId: 700000 + index,
        rating: 70,
        nation: 1,
        leagueId: 1,
        teamid: 100 + index,
        rareflag: 0,
        cardsubtypeid: 0,
        playStyle: 0,
        preferredPosition: position,
        possiblePositions: [position],
        untradeable: true,
        pile: 7,
        owners: 1,
        isCollected: true,
        marketAverage: null,
        marketDataMinPrice: null,
        marketDataMaxPrice: null,
        discardValue: null,
      })
    );
    const challenge = { formation: 'f442', elgReq: [], elgOperation: 'AND' };

    const result = solve(challenge, buildPool(normaliseClub(rawItems)), { seed: 1 });

    expect(result.valid).toBe(true);
    expect(result.cost).toBeNull();
  });

  it('surfaces the validator unverified entries instead of swallowing them', () => {
    const result = solve(set10.challenges[0], POOL, options());

    expect(result.squad.chemistry).toMatchObject({
      verified: false,
      reason: 'chemistry-formula-unverified',
    });
    expect(result.unverified).toContainEqual(
      expect.objectContaining({ kind: 'CHEMISTRY_POINTS', required: 30, scope: 'GREATER' })
    );
    expect(result.unverified).toContainEqual(
      expect.objectContaining({ kind: 'PLAYER_QUALITY', required: 3, scope: 'EXACT' })
    );
  });

  // The fixture club genuinely cannot satisfy these; the assertions name the
  // exact requirement that is out of reach, observed through the real
  // validator, so the solver cannot report a failure it did not measure.
  it('cannot satisfy challenge 25: the two largest nations hold ten players', () => {
    const result = solve(set10.challenges[0], POOL, options());

    expect(result.valid).toBe(false);
    const nationCount = result.failures.find(({ kind }) => kind === 'NATION_COUNT');
    expect(nationCount).toMatchObject({ required: 2, scope: 'EXACT' });
    expect(nationCount.actual).toBeGreaterThan(2);
  });

  it('cannot satisfy challenge 37: league 308 carries one item and nation 38 none', () => {
    const result = solve(set16.challenges[1], POOL, options());

    expect(result.valid).toBe(false);
    const leagueMatch = result.failures.find(
      ({ kind, match }) => kind === 'PLAYER_COUNT_MATCH' && match.leagueIds !== undefined
    );
    expect(leagueMatch).toMatchObject({ required: 2, scope: 'GREATER' });
    expect(leagueMatch.actual).toBeLessThan(2);

    const nationMatch = result.failures.find(
      ({ kind, match }) => kind === 'PLAYER_COUNT_MATCH' && match.nationIds !== undefined
    );
    expect(nationMatch).toMatchObject({ required: 2, scope: 'GREATER' });
    expect(nationMatch.actual).toBe(0);
  });

  it('cannot satisfy challenge 38: no item is from PSG or Marseille', () => {
    const result = solve(set16.challenges[2], POOL, options());

    expect(result.valid).toBe(false);
    const clubMatch = result.failures.find(
      ({ kind, match }) => kind === 'PLAYER_COUNT_MATCH' && match.clubIds !== undefined
    );
    expect(clubMatch).toMatchObject({ required: 1, scope: 'GREATER' });
    expect(clubMatch.actual).toBe(0);
  });

  it('cannot satisfy challenges 26 and 27, and reports the requirements it misses', () => {
    // Exhaustive search over the 42 fixture items (slot positions, distinct
    // nation/league counts, the same-group caps and the rating floor together)
    // finds no valid eleven for either challenge, so the club genuinely cannot
    // satisfy them. The observed best efforts fail these exact requirements:
    // 26: TEAM_RATING 78, LEAGUE_COUNT 4, NATION_COUNT 5.
    // 27: TEAM_RATING 81, LEAGUE_COUNT 5, NATION_COUNT 6.
    const expected = [
      { challenge: set10.challenges[1], rating: 78, leagues: 4, nations: 5 },
      { challenge: set10.challenges[2], rating: 81, leagues: 5, nations: 6 },
    ];

    for (const { challenge, rating, leagues, nations } of expected) {
      const result = solve(challenge, POOL, options());

      expect(result.valid, `challenge ${challenge.challengeId}`).toBe(false);
      expect(new Set(result.failures.map(({ kind }) => kind))).toEqual(
        new Set(['TEAM_RATING', 'LEAGUE_COUNT', 'NATION_COUNT'])
      );
      expect(result.failures.find(({ kind }) => kind === 'TEAM_RATING')).toMatchObject({
        required: rating,
        scope: 'GREATER',
      });
      expect(result.failures.find(({ kind }) => kind === 'LEAGUE_COUNT')).toMatchObject({
        required: leagues,
        scope: 'EXACT',
      });
      expect(result.failures.find(({ kind }) => kind === 'NATION_COUNT')).toMatchObject({
        required: nations,
        scope: 'EXACT',
      });
      for (const failure of result.failures) {
        expect(failure.shortfall).toBeGreaterThan(0);
        expect(failure.diagnostic.id).toEqual(expect.any(String));
        expect(failure.diagnostic.params).toEqual(expect.any(Object));
      }
    }
  });

  it('satisfies the two challenges the fixture club can fill', () => {
    for (const challenge of [set16.challenges[0], set16.challenges[3]]) {
      const result = solve(challenge, POOL, options());

      expect(result.valid, `challenge ${challenge.challengeId}`).toBe(true);
      expect(result.failures).toEqual([]);
      expect(Number.isFinite(result.cost)).toBe(true);
    }
  });
});

describe('unfillable pools degrade honestly', () => {
  const challenge = { formation: 'f442', elgReq: [], elgOperation: 'AND' };

  const rawItem = (index, position) => ({
    id: 910000 + index,
    assetId: 710000 + index,
    rating: 70,
    nation: 1,
    leagueId: 1,
    teamid: 100 + index,
    rareflag: 0,
    cardsubtypeid: 0,
    playStyle: 0,
    preferredPosition: position,
    possiblePositions: [position],
    untradeable: true,
    pile: 7,
    owners: 1,
    isCollected: true,
    marketAverage: null,
    marketDataMinPrice: null,
    marketDataMaxPrice: null,
    discardValue: null,
  });

  const poolFrom = (positions) =>
    buildPool(normaliseClub(positions.map((position, index) => rawItem(index, position))));

  // f442 needs GK; this pool has no record that can play it, so the position
  // has no candidate list at all.
  const poolWithoutGoalkeeper = () =>
    poolFrom(['LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST']);

  // f442 needs two CBs; this pool has exactly one, so the CB list is exhausted
  // after the first centre-back slot is filled.
  const poolWithOneCentreBack = () =>
    poolFrom(['GK', 'LB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST']);

  it('solve returns invalid for a pool with no goalkeeper instead of throwing', () => {
    const result = solve(challenge, poolWithoutGoalkeeper(), { seed: 1 });

    expect(result.valid).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.squad.players.length).toBeLessThan(11);
  });

  it('solve returns invalid when a slot list is exhausted mid-run instead of throwing', () => {
    const result = solve(challenge, poolWithOneCentreBack(), { seed: 1 });

    expect(result.valid).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.squad.players.length).toBeLessThan(11);
  });

  it('reevaluate returns invalid for a pool with no goalkeeper instead of throwing', () => {
    const result = reevaluate({ players: [] }, [], poolWithoutGoalkeeper(), {
      challenge,
      seed: 1,
    });

    expect(result.valid).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.squad.players.length).toBeLessThan(11);
  });

  it('reevaluate returns invalid when a slot list is exhausted mid-run instead of throwing', () => {
    const result = reevaluate({ players: [] }, [], poolWithOneCentreBack(), {
      challenge,
      seed: 1,
    });

    expect(result.valid).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.squad.players.length).toBeLessThan(11);
  });
});

describe('reevaluate', () => {
  const challenge = set16.challenges[3];
  const context = () => options({ challenge });

  it('keeps every locked slot player and refills the rest validly', () => {
    const first = solve(challenge, POOL, options());
    const lockedSlots = [0, 5];
    const lockedIds = lockedSlots.map((slot) => first.squad.players[slot].id);

    const result = reevaluate(first.squad, lockedSlots, POOL, context());

    expect(result.squad.players).toHaveLength(11);
    expect(lockedSlots.map((slot) => result.squad.players[slot].id)).toEqual(lockedIds);
    expect(new Set(result.squad.players.map(({ id }) => id)).size).toBe(11);
    expect(validate(result, challenge).valid).toBe(result.valid);
  });

  it('does not throw on an incomplete squad and still fills eleven slots', () => {
    const first = solve(challenge, POOL, options());
    const incomplete = {
      players: first.squad.players.slice(0, 6),
      chemistry: first.squad.chemistry,
    };

    const result = reevaluate(incomplete, [0, 3], POOL, context());

    expect(result.squad.players).toHaveLength(11);
    expect(result.squad.players[0].id).toBe(incomplete.players[0].id);
    expect(result.squad.players[3].id).toBe(incomplete.players[3].id);
    expect(new Set(result.squad.players.map(({ id }) => id)).size).toBe(11);
  });

  it('rejects a locked slot outside the formation', () => {
    const first = solve(challenge, POOL, options());

    expect(() => reevaluate(first.squad, [11], POOL, context())).toThrow(/locked slot/);
    expect(() => reevaluate(first.squad, [1.5], POOL, context())).toThrow(/locked slot/);
    expect(() => reevaluate(first.squad, [1, 1], POOL, context())).toThrow(/locked slot/);
  });

  it('degrades honestly without a usable pool instead of inventing a verdict', () => {
    const first = solve(challenge, POOL, options());
    const incomplete = { players: first.squad.players.slice(0, 4) };

    const result = reevaluate(incomplete, [0, 1, 2, 3], [], { challenge });

    expect(result.squad.players).toHaveLength(4);
    expect(result.valid).toBe(false);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([]);
  });
});
