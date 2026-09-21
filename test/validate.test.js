import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import club from './fixtures/club-items.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import set16 from './fixtures/sbs-set-16-challenges.json';
import teamlinks from './fixtures/chemistry-teamlinks.json';
import { PINNED_ELIGIBILITY_KEYS, SCOPE_VALUES } from './helpers/eligibility.js';
import { normaliseClubItem } from '../src/ea/adapter.js';
import { normaliseRequirements } from '../src/solver/requirements.js';
import { buildClubIndex, squadChemistry } from '../src/solver/chemistry.js';
import { MEASURES, validateSquad } from '../src/solver/validate.js';

// These tests exercise the referee over the sanitised club fixture. The squad
// is a hand-picked 11-subset of the captured items, normalised through the EA
// adapter first, not a squad that satisfies any captured challenge; the
// expectations are the measurements of that subset (7 nations, 7 leagues,
// 11 clubs, max 3 same league, max 4 same nation, rounded mean rating 83) plus
// constraint sets written to probe each rule. Tests marked [inference] pin OUR
// assumptions (the rating measure, the club link assumption); they are not EA
// semantics and must be revisited when issue #16 can compare against EA's own
// display. A PLAYER_COUNT_MATCH on playerLevels is never measured at all — the
// removed rareflag mapping was an unverified guess, so the match is reported in
// `unverified` instead (decision recorded on issue #2).

const QUALITY_REASON = 'player-quality-aggregation-unverified';
const RATING_REASON = 'team-rating-formula-unverified';
const LEVEL_REASON = 'player-level-field-unverified';
const CHEMISTRY_REASON = 'chemistry-formula-unverified';

const BASE_ASSETS = [
  277846, 262093, 250959, 244669, 236403, 267212, 205452, 227236, 212194, 265849, 262330,
];

const byAsset = new Map(club.items.map((rawItem) => [rawItem.assetId, normaliseClubItem(rawItem)]));

const item = (assetId) => byAsset.get(assetId);

const squadOf = (assetIds, chemistry = 31) => ({
  players: assetIds.map(item),
  chemistry,
});

const baseSquad = (chemistry = 31) => squadOf(BASE_ASSETS, chemistry);

// A squad whose chemistry came from the real `squadChemistry`: the result
// object, not a bare number, so the validator can see the formula is
// unverified. The object shape matches `src/solver/chemistry.js` exactly.
const computedSquad = (chemistry) => ({
  ...baseSquad(chemistry),
  chemistry: { chemistry, verified: false, reason: CHEMISTRY_REASON },
});

// A hand-built stable profile in the adapter's schema, so the real
// `squadChemistry` can run without the chemistry fixtures.
const STABLE_PROFILE = Object.freeze({
  id: 4,
  fullChemistryAtPreferredPosition: false,
  overrides: { base: true, icon: false, hero: false },
  rules: [{ dimension: 'nation', calculation: 'normal', value: 1 }],
});

// Two fixture items whose clubIds are a linked pair in the captured
// teamChemLinks payload (5 and 116010), with the rest of the base squad
// unchanged. The copies are crafted here so the fixture itself stays untouched.
const linkedSquad = () => ({
  players: [
    { ...item(262093), clubId: 116010 },
    { ...item(277846), clubId: 5 },
    ...BASE_ASSETS.slice(2).map(item),
  ],
  chemistry: 31,
});

// [inference] The lookup a caller would build from EA's teamChemLinks payload.
// Fixture pairs are reciprocal; the lower teamid in the raw payload is the
// canonical identity. The solver never sees the payload shape, only the
// resulting function over the stable clubId.
const clubLinks = (() => {
  const canonical = new Map();
  for (const { teamId, linkedTeams } of teamlinks.teamChemLinks) {
    for (const linked of linkedTeams ?? []) {
      const id = Math.min(teamId, linked);
      canonical.set(teamId, id);
      canonical.set(linked, id);
    }
  }
  return (clubId) => canonical.get(clubId) ?? clubId;
})();

const challenge = (fixture, challengeId) =>
  fixture.challenges.find((entry) => entry.challengeId === challengeId);

const normalise = (entry) =>
  normaliseRequirements(entry.elgReq, {
    operation: entry.elgOperation,
    keys: PINNED_ELIGIBILITY_KEYS,
    scopes: SCOPE_VALUES,
  }).constraints;

const GREATER = (kind, value = 1, extra = {}) => ({ kind, value, scope: 'GREATER', ...extra });

const without = (object, key) => {
  const copy = { ...object };
  delete copy[key];
  return copy;
};

// Raw `/club`-shaped items with known teamid, nation and leagueId values, used
// to prove the validator only ever sees the adapter's stable schema. The first
// two items share teamid 700; every other teamid is distinct.
const rawClubItems = () =>
  Array.from({ length: 11 }, (_, index) => ({
    id: 9000 + index,
    assetId: 5000 + index,
    rating: 80,
    nation: 10 + index,
    leagueId: 100 + index,
    teamid: index < 2 ? 700 : 700 + index,
    rareflag: 0,
    cardsubtypeid: 0,
    playStyle: 0,
    preferredPosition: 'ST',
    possiblePositions: ['ST'],
    untradeable: false,
    pile: 7,
    owners: 1,
    isCollected: true,
  }));

const rawClubSquad = () => ({
  players: rawClubItems().map(normaliseClubItem),
  chemistry: 31,
});

// The full normalised constraint set of set 16 challenge 35, in slot order.
const CHALLENGE_35 = [
  { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { nationIds: [42] } },
  { kind: 'CLUB_COUNT', value: 2, scope: 'GREATER' },
  { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { playerLevels: [2] } },
  { kind: 'PLAYER_QUALITY', value: 1, scope: 'GREATER' },
  { kind: 'CHEMISTRY_POINTS', value: 14, scope: 'GREATER' },
];

describe('validateSquad over the captured club fixture', () => {
  it('accepts a squad that satisfies every checkable constraint', () => {
    const constraints = [
      { kind: 'LEAGUE_COUNT', value: 7, scope: 'EXACT' },
      { kind: 'NATION_COUNT', value: 7, scope: 'EXACT' },
      { kind: 'CLUB_COUNT', value: 11, scope: 'EXACT' },
      { kind: 'SAME_LEAGUE_COUNT', value: 3, scope: 'LOWER' },
      { kind: 'SAME_NATION_COUNT', value: 4, scope: 'LOWER' },
      { kind: 'PLAYER_COUNT_MATCH', value: 4, scope: 'GREATER', match: { nationIds: [21] } },
      { kind: 'PLAYER_QUALITY', value: 3, scope: 'EXACT' },
      { kind: 'CHEMISTRY_POINTS', value: 31, scope: 'GREATER' },
    ];

    const result = validateSquad(baseSquad(31), constraints);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([
      {
        kind: 'PLAYER_QUALITY',
        required: 3,
        scope: 'EXACT',
        reason: QUALITY_REASON,
        diagnostic: { id: 'quality-not-checked', params: {} },
      },
    ]);
  });

  it('reports exactly the chemistry failure when one point short', () => {
    const result = validateSquad(baseSquad(29), [
      { kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' },
    ]);

    expect(result.valid).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      kind: 'CHEMISTRY_POINTS',
      required: 30,
      actual: 29,
      shortfall: 1,
      scope: 'GREATER',
      unverified: false,
      diagnostic: { id: 'missing-chemistry', params: { points: 1 } },
    });
    expect(result.failures[0].match).toBeUndefined();
  });

  it('keeps a bare squad.chemistry number on the verified path', () => {
    // Issue #13 supplies EA's own number as a bare number; it must behave
    // exactly as before the computed-chemistry marker existed.
    const result = validateSquad(baseSquad(29), [
      { kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' },
    ]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ actual: 29, unverified: false });
    expect(result.unverified).toEqual([]);
  });

  it('reports computed chemistry as unverified instead of approving or failing the requirement', () => {
    const result = validateSquad(computedSquad(29), [
      { kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' },
    ]);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([
      {
        kind: 'CHEMISTRY_POINTS',
        required: 30,
        scope: 'GREATER',
        reason: CHEMISTRY_REASON,
        diagnostic: { id: 'chemistry-formula-unverified', params: {} },
      },
    ]);
  });

  it('ignores the computed number entirely: 0 and 29 land in the same unverified entry', () => {
    const constraint = [{ kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' }];
    const zero = validateSquad(computedSquad(0), constraint);
    const almost = validateSquad(computedSquad(29), constraint);

    expect(zero.failures).toEqual([]);
    expect(almost.failures).toEqual([]);
    expect(zero.unverified.map((entry) => entry.diagnostic.id)).toEqual([
      'chemistry-formula-unverified',
    ]);
    expect(almost.unverified.map((entry) => entry.diagnostic.id)).toEqual([
      'chemistry-formula-unverified',
    ]);
  });

  it('treats an explicitly verified chemistry object as a verified number', () => {
    const result = validateSquad(
      { ...baseSquad(), chemistry: { chemistry: 31, verified: true, reason: null } },
      [{ kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' }]
    );

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([]);
  });

  it('lets a caller-supplied measure take responsibility for computed chemistry', () => {
    const result = validateSquad(
      computedSquad(29),
      [{ kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' }],
      { measures: { CHEMISTRY_POINTS: (squad) => squad.chemistry.chemistry } }
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ actual: 29, unverified: false });
    expect(result.unverified).toEqual([]);
  });

  it('refuses to measure an unverified chemistry object through the raw measure table', () => {
    expect(() =>
      MEASURES.CHEMISTRY_POINTS(computedSquad(29), {
        kind: 'CHEMISTRY_POINTS',
        value: 30,
        scope: 'GREATER',
      })
    ).toThrow(/computed and unverified/);
  });

  it('binds the real squadChemistry reason to the chemistry unverified diagnostic', () => {
    // End-to-end bind of producer and consumer: if chemistry.js ever renames
    // its reason, the validator throws on it and this test fails, so the two
    // modules cannot drift apart silently.
    const players = baseSquad().players.map((player) => ({ ...player, nationId: 55 }));
    const chemistry = squadChemistry(players, STABLE_PROFILE, buildClubIndex([]));
    const result = validateSquad({ ...baseSquad(), players, chemistry }, [
      { kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' },
    ]);

    expect(chemistry.verified).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([
      {
        kind: 'CHEMISTRY_POINTS',
        required: 30,
        scope: 'GREATER',
        reason: chemistry.reason,
        diagnostic: { id: 'chemistry-formula-unverified', params: {} },
      },
    ]);
  });

  it('binds the missing-position-flag reason to the chemistry unverified diagnostic', () => {
    const players = baseSquad().players.map((player) => ({ ...player, nationId: 55 }));
    const chemistry = squadChemistry(
      players,
      { ...STABLE_PROFILE, fullChemistryAtPreferredPosition: null },
      buildClubIndex([])
    );
    const result = validateSquad({ ...baseSquad(), players, chemistry }, [
      { kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' },
    ]);

    expect(chemistry.reason).toBe('chemistry-position-flag-missing');
    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([
      {
        kind: 'CHEMISTRY_POINTS',
        required: 30,
        scope: 'GREATER',
        reason: 'chemistry-position-flag-missing',
        diagnostic: { id: 'chemistry-formula-unverified', params: {} },
      },
    ]);
  });

  it('reads the computed chemistry status once, so a proxy cannot answer differently for the reason check and the measure', () => {
    // `squad.chemistry` has the same TOCTOU shape as the `options.measures`
    // proxy fixed for issue #2: `readChemistryStatus` runs for the reason
    // decision and `MEASURES.CHEMISTRY_POINTS` reads the value again for the
    // measurement. A proxy that answers 0 on the first read and 100 on the
    // second would let a failing total satisfy the constraint. One snapshot
    // must feed both steps.
    let statusReads = 0;
    const descriptor = (value) => ({
      value,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    const chemistry = new Proxy(
      {},
      {
        ownKeys() {
          statusReads += 1;
          return ['chemistry', 'verified', 'reason'];
        },
        getOwnPropertyDescriptor(target, key) {
          if (key === 'chemistry') return descriptor(statusReads === 1 ? 0 : 100);
          if (key === 'verified') return descriptor(true);
          return descriptor(null);
        },
      }
    );

    const result = validateSquad({ ...baseSquad(), chemistry }, [
      { kind: 'CHEMISTRY_POINTS', value: 50, scope: 'GREATER' },
    ]);

    expect(statusReads).toBe(1);
    expect(result.valid).toBe(false);
    expect(result.unverified).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      kind: 'CHEMISTRY_POINTS',
      required: 50,
      actual: 0,
      shortfall: 50,
      scope: 'GREATER',
      unverified: false,
      diagnostic: { id: 'missing-chemistry', params: { points: 50 } },
    });
  });

  it('reports only the league failure when the squad has too few leagues', () => {
    const result = validateSquad(baseSquad(), [{ kind: 'LEAGUE_COUNT', value: 8, scope: 'GREATER' }]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      kind: 'LEAGUE_COUNT',
      required: 8,
      actual: 7,
      shortfall: 1,
      diagnostic: { id: 'missing-leagues', params: { count: 1 } },
    });
  });

  it('reports every simultaneous failure, not only the first', () => {
    const result = validateSquad(baseSquad(31), [
      { kind: 'LEAGUE_COUNT', value: 9, scope: 'GREATER' },
      { kind: 'NATION_COUNT', value: 8, scope: 'GREATER' },
      { kind: 'CHEMISTRY_POINTS', value: 40, scope: 'GREATER' },
    ]);

    expect(result.valid).toBe(false);
    expect(result.failures.map((failure) => failure.kind)).toEqual([
      'LEAGUE_COUNT',
      'NATION_COUNT',
      'CHEMISTRY_POINTS',
    ]);
    expect(result.failures.map((failure) => failure.shortfall)).toEqual([2, 1, 9]);
  });

  it('passes the boundary where the measured value equals the required value under all three scopes', () => {
    const result = validateSquad(baseSquad(31), [
      { kind: 'CHEMISTRY_POINTS', value: 31, scope: 'GREATER' },
      { kind: 'SAME_LEAGUE_COUNT', value: 3, scope: 'LOWER' },
      { kind: 'LEAGUE_COUNT', value: 7, scope: 'EXACT' },
    ]);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('reports the shortfall for an EXACT miss on either side', () => {
    const below = validateSquad(baseSquad(), [{ kind: 'LEAGUE_COUNT', value: 8, scope: 'EXACT' }]);
    expect(below.failures[0]).toMatchObject({
      required: 8,
      actual: 7,
      shortfall: 1,
      scope: 'EXACT',
    });

    const above = validateSquad(baseSquad(), [{ kind: 'LEAGUE_COUNT', value: 6, scope: 'EXACT' }]);
    expect(above.failures[0]).toMatchObject({
      required: 6,
      actual: 7,
      shortfall: 1,
      scope: 'EXACT',
    });
  });

  it('reports the shortfall for a LOWER breach and for a GREATER miss', () => {
    const tooMany = validateSquad(baseSquad(), [
      { kind: 'SAME_NATION_COUNT', value: 3, scope: 'LOWER' },
    ]);
    expect(tooMany.failures[0]).toMatchObject({
      required: 3,
      actual: 4,
      shortfall: 1,
    });

    const tooFew = validateSquad(baseSquad(), [
      { kind: 'SAME_NATION_COUNT', value: 5, scope: 'GREATER' },
    ]);
    expect(tooFew.failures[0]).toMatchObject({
      required: 5,
      actual: 4,
      shortfall: 1,
    });
  });

  it('keeps PLAYER_QUALITY out of failures and lists every requirement as unverified', () => {
    const result = validateSquad(baseSquad(), [
      { kind: 'PLAYER_QUALITY', value: 99, scope: 'EXACT' },
      { kind: 'PLAYER_QUALITY', value: 0, scope: 'LOWER' },
    ]);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([
      {
        kind: 'PLAYER_QUALITY',
        required: 99,
        scope: 'EXACT',
        reason: QUALITY_REASON,
        diagnostic: { id: 'quality-not-checked', params: {} },
      },
      {
        kind: 'PLAYER_QUALITY',
        required: 0,
        scope: 'LOWER',
        reason: QUALITY_REASON,
        diagnostic: { id: 'quality-not-checked', params: {} },
      },
    ]);
  });

  it('carries the match object through to the failure', () => {
    const result = validateSquad(baseSquad(), [
      { kind: 'PLAYER_COUNT_MATCH', value: 5, scope: 'GREATER', match: { nationIds: [21] } },
    ]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      kind: 'PLAYER_COUNT_MATCH',
      required: 5,
      actual: 4,
      shortfall: 1,
      match: { nationIds: [21] },
      unverified: false,
      diagnostic: { id: 'missing-players', params: { count: 1 } },
    });
  });

  it('accepts a squad when there is nothing to check', () => {
    const result = validateSquad({ players: baseSquad().players }, []);

    expect(result).toEqual({ valid: true, failures: [], unverified: [] });
  });

  it("[inference] measures TEAM_RATING with EA's adjusted-mean formula (base squad 83)", () => {
    const result = validateSquad(baseSquad(), [{ kind: 'TEAM_RATING', value: 84, scope: 'GREATER' }]);

    expect(result.valid).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      kind: 'TEAM_RATING',
      required: 84,
      actual: 83,
      shortfall: 1,
      unverified: true,
      diagnostic: { id: 'missing-rating', params: { points: 1 } },
    });
    expect(result.unverified).toEqual([
      {
        kind: 'TEAM_RATING',
        required: 84,
        scope: 'GREATER',
        reason: RATING_REASON,
        diagnostic: { id: 'rating-formula-unverified', params: {} },
      },
    ]);
  });

  it('[inference] still flags TEAM_RATING as unverified when the check passes', () => {
    const result = validateSquad(baseSquad(), [{ kind: 'TEAM_RATING', value: 80, scope: 'GREATER' }]);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([
      {
        kind: 'TEAM_RATING',
        required: 80,
        scope: 'GREATER',
        reason: RATING_REASON,
        diagnostic: { id: 'rating-formula-unverified', params: {} },
      },
    ]);
  });

  it('[inference] tracks the actual rating when the ratings change instead of returning a constant', () => {
    const flat = baseSquad().players.map((player) => ({ ...player, rating: 80 }));
    const flatResult = validateSquad(
      { players: flat, chemistry: 31 },
      [{ kind: 'TEAM_RATING', value: 80, scope: 'EXACT' }]
    );
    expect(flatResult.valid).toBe(true);

    const raised = flat.map((player, index) => (index < 2 ? { ...player, rating: 90 } : player));
    const raisedResult = validateSquad(
      { players: raised, chemistry: 31 },
      [{ kind: 'TEAM_RATING', value: 80, scope: 'EXACT' }]
    );
    expect(raisedResult.failures).toHaveLength(1);
    expect(raisedResult.failures[0]).toMatchObject({
      required: 80,
      actual: 83,
      shortfall: 3,
      unverified: true,
      diagnostic: { id: 'missing-rating', params: { points: 3 } },
    });
  });

  it('[inference] lets the caller replace a measure through options.measures', () => {
    const sumRatings = (squad) =>
      squad.players.reduce((sum, player) => sum + player.rating, 0);
    const constraints = [{ kind: 'TEAM_RATING', value: 900, scope: 'GREATER' }];

    const overridden = validateSquad(baseSquad(), constraints, {
      measures: { TEAM_RATING: sumRatings },
    });
    expect(overridden.valid).toBe(true);
    expect(overridden.unverified).toEqual([]);

    const fallback = validateSquad(baseSquad(), constraints);
    expect(fallback.failures).toHaveLength(1);
    expect(fallback.failures[0]).toMatchObject({ actual: 83, unverified: true });
    expect(fallback.unverified).toEqual([
      {
        kind: 'TEAM_RATING',
        required: 900,
        scope: 'GREATER',
        reason: RATING_REASON,
        diagnostic: { id: 'rating-formula-unverified', params: {} },
      },
    ]);
  });

  it('exports the default measure table', () => {
    expect(Object.isFrozen(MEASURES)).toBe(true);
    expect(typeof MEASURES.TEAM_RATING).toBe('function');
    expect(typeof MEASURES.SAME_CLUB_COUNT).toBe('function');
  });

  it('refuses to run the default PLAYER_COUNT_MATCH measure on an unmeasured match field', () => {
    expect(() =>
      MEASURES.PLAYER_COUNT_MATCH(baseSquad(), {
        kind: 'PLAYER_COUNT_MATCH',
        value: 1,
        scope: 'GREATER',
        match: { playerLevels: [2] },
      })
    ).toThrow(/cannot be measured: no verified item field/);
  });

  it('[inference] treats linked clubs as one club for SAME_CLUB_COUNT when a lookup is supplied', () => {
    const constraints = [{ kind: 'SAME_CLUB_COUNT', value: 2, scope: 'GREATER' }];

    const literal = validateSquad(linkedSquad(), constraints);
    expect(literal.failures).toHaveLength(1);
    expect(literal.failures[0]).toMatchObject({
      kind: 'SAME_CLUB_COUNT',
      required: 2,
      actual: 1,
      shortfall: 1,
    });

    const linked = validateSquad(linkedSquad(), constraints, { clubLinks });
    expect(linked.valid).toBe(true);
    expect(linked.failures).toEqual([]);
  });

  it('[inference] leaves CLUB_COUNT on the literal clubId even when a club lookup is supplied', () => {
    const result = validateSquad(
      linkedSquad(),
      [{ kind: 'CLUB_COUNT', value: 2, scope: 'EXACT' }],
      { clubLinks }
    );

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ required: 2, actual: 11 });
  });

  it('never measures a playerLevels match: unverified, never a failure', () => {
    const result = validateSquad(baseSquad(), [
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { playerLevels: [2] } },
      { kind: 'PLAYER_COUNT_MATCH', value: 11, scope: 'GREATER', match: { playerLevels: [0] } },
    ]);

    // Every base item carries rarity 0, so the removed rarity mapping would
    // have failed the first requirement and passed the second. Neither may be
    // measured: the item field behind PLAYER_LEVEL is unverified.
    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([
      {
        kind: 'PLAYER_COUNT_MATCH',
        required: 1,
        scope: 'GREATER',
        reason: LEVEL_REASON,
        match: { playerLevels: [2] },
        diagnostic: { id: 'player-level-not-checked', params: {} },
      },
      {
        kind: 'PLAYER_COUNT_MATCH',
        required: 11,
        scope: 'GREATER',
        reason: LEVEL_REASON,
        match: { playerLevels: [0] },
        diagnostic: { id: 'player-level-not-checked', params: {} },
      },
    ]);
  });

  it('still refuses to measure a playerLevels match when the caller overrides PLAYER_COUNT_MATCH', () => {
    const constraints = [
      { kind: 'PLAYER_COUNT_MATCH', value: 5, scope: 'GREATER', match: { nationIds: [21] } },
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { playerLevels: [2] } },
    ];

    const result = validateSquad(baseSquad(), constraints, {
      measures: {
        PLAYER_COUNT_MATCH: (squad, constraint) =>
          Object.hasOwn(constraint.match, 'playerLevels') ? 0 : squad.players.length,
      },
    });

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.unverified).toEqual([
      {
        kind: 'PLAYER_COUNT_MATCH',
        required: 1,
        scope: 'GREATER',
        reason: LEVEL_REASON,
        match: { playerLevels: [2] },
        diagnostic: { id: 'player-level-not-checked', params: {} },
      },
    ]);
  });

  it('decodes and validates challenge #35 with exact constraint, failure and unverified sets', () => {
    const constraints = normalise(challenge(set16, 35));
    expect(constraints).toEqual(CHALLENGE_35);

    expect(validateSquad(baseSquad(31), constraints)).toEqual({
      valid: false,
      failures: [
        {
          kind: 'PLAYER_COUNT_MATCH',
          required: 1,
          actual: 0,
          shortfall: 1,
          scope: 'GREATER',
          match: { nationIds: [42] },
          unverified: false,
          diagnostic: { id: 'missing-players', params: { count: 1 } },
        },
      ],
      unverified: [
        {
          kind: 'PLAYER_COUNT_MATCH',
          required: 1,
          scope: 'GREATER',
          reason: LEVEL_REASON,
          match: { playerLevels: [2] },
          diagnostic: { id: 'player-level-not-checked', params: {} },
        },
        {
          kind: 'PLAYER_QUALITY',
          required: 1,
          scope: 'GREATER',
          reason: QUALITY_REASON,
          diagnostic: { id: 'quality-not-checked', params: {} },
        },
      ],
    });
  });
});

describe('TEAM_RATING through adapter key 19', () => {
  it.each([
    ['set 16 challenge 39', set16, 39, 75],
    ['set 10 challenge 26', set10, 26, 78],
  ])('decodes %s into a TEAM_RATING minimum', (_label, fixture, challengeId, value) => {
    const constraints = normalise(challenge(fixture, challengeId));

    expect(constraints).toContainEqual({ kind: 'TEAM_RATING', value, scope: 'GREATER' });
  });

  it('measures the default rating for challenge #39 and reports it only in unverified', () => {
    const result = validateSquad(baseSquad(31), normalise(challenge(set16, 39)));

    expect(result).toEqual({
      valid: true,
      failures: [],
      unverified: [
        {
          kind: 'TEAM_RATING',
          required: 75,
          scope: 'GREATER',
          reason: RATING_REASON,
          diagnostic: { id: 'rating-formula-unverified', params: {} },
        },
      ],
    });
  });
});

describe("TEAM_RATING follows EA's adjusted-mean formula", () => {
  // Hand-computed from the documented formula: the mean of the eleven ratings,
  // every rating above the mean contributing `2 * rating - mean`, the result
  // rounded to two decimals, and one added when the fractional part reaches
  // 0.96. Each expectation below is arithmetic, not a re-run of the code.
  const ratedSquad = (ratings) => ({
    players: baseSquad().players.map((player, index) => ({ ...player, rating: ratings[index] })),
    chemistry: 31,
  });

  it('doubles the contribution of every player above the mean', () => {
    // [80 x5, 90 x6]: mean 85.4545..., every 90 contributes
    // 2 * 90 - 85.4545... = 94.5454...; adjusted average 87.9338... -> 87.93
    // -> 87. A plain average of 85.4545... would round to 85.
    const squad = ratedSquad([80, 80, 80, 80, 80, 90, 90, 90, 90, 90, 90]);

    expect(MEASURES.TEAM_RATING(squad)).toBe(87);
  });

  it('adds one when the two-decimal adjusted average reaches the 0.96 threshold', () => {
    // [50 x5, 55 x6]: mean 52.7272..., every 55 contributes
    // 2 * 55 - 52.7272... = 57.2727...; adjusted average 53.9669... -> 53.97,
    // whose fractional part 0.97 >= 0.96, so the rating is 54. A plain average
    // would round to 53, and flooring the adjusted average without the bump
    // would also give 53.
    const squad = ratedSquad([50, 50, 50, 50, 50, 55, 55, 55, 55, 55, 55]);

    expect(MEASURES.TEAM_RATING(squad)).toBe(54);
  });

  it('does not double a player sitting exactly at the mean', () => {
    // [70, 80 x9, 90]: the mean is exactly 80, so the nine 80s contribute 80
    // each (not 2 * 80); only the 90 is above the mean, contributing 100.
    // Adjusted average 890 / 11 = 80.9090... -> 80.91, decimal 0.91 < 0.96,
    // so the rating is 80.
    const squad = ratedSquad([70, 80, 80, 80, 80, 80, 80, 80, 80, 80, 90]);

    expect(MEASURES.TEAM_RATING(squad)).toBe(80);
  });

  it("satisfies a TEAM_RATING requirement by EA's number, not the plain average", () => {
    // The same [80 x5, 90 x6] squad: EA's rating is 87, the plain average 85.
    const squad = ratedSquad([80, 80, 80, 80, 80, 90, 90, 90, 90, 90, 90]);

    const passes = validateSquad(squad, [{ kind: 'TEAM_RATING', value: 86, scope: 'GREATER' }]);
    expect(passes.valid).toBe(true);
    expect(passes.failures).toEqual([]);

    const fails = validateSquad(squad, [{ kind: 'TEAM_RATING', value: 88, scope: 'GREATER' }]);
    expect(fails.valid).toBe(false);
    expect(fails.failures).toHaveLength(1);
    expect(fails.failures[0]).toMatchObject({ actual: 87, shortfall: 1 });
  });
});

describe('validateSquad never mutates its input', () => {
  it('leaves the squad and the constraint array untouched', () => {
    const squad = baseSquad();
    const constraints = [
      { kind: 'CHEMISTRY_POINTS', value: 40, scope: 'GREATER' },
      { kind: 'PLAYER_COUNT_MATCH', value: 6, scope: 'GREATER', match: { nationIds: [21] } },
      { kind: 'SAME_CLUB_COUNT', value: 3, scope: 'GREATER' },
    ];
    const before = structuredClone({ squad, constraints });

    validateSquad(squad, constraints, { clubLinks });

    expect({ squad, constraints }).toEqual(before);
  });
});

describe('validateSquad fails loud on malformed input', () => {
  const constraint = (kind, extra = {}) => ({ kind, value: 1, scope: 'GREATER', ...extra });

  it('throws when the squad is not an object', () => {
    expect(() => validateSquad(null, [])).toThrow(/squad must be an object/);
  });

  it('throws when squad.players is not an array', () => {
    expect(() => validateSquad({ players: {}, chemistry: 1 }, [])).toThrow(
      /squad.players must be an array/
    );
  });

  it('throws when a player entry is not an item object', () => {
    const players = [null, ...baseSquad().players.slice(1)];

    expect(() => validateSquad({ players, chemistry: 1 }, [])).toThrow(
      /squad.players\[0\] must be an item object/
    );
  });

  it('throws when constraints is not an array', () => {
    expect(() => validateSquad(baseSquad(), null)).toThrow(/constraints must be an array/);
  });

  it('refuses a RANGE scope instead of degrading it to an exact or a minimum', () => {
    expect(() =>
      validateSquad(baseSquad(), [{ kind: 'CHEMISTRY_POINTS', value: 31, scope: 'RANGE' }])
    ).toThrow(/RANGE.*not measured|not measured.*RANGE/);
  });

  it('throws when options is not an object', () => {
    expect(() => validateSquad(baseSquad(), [], 42)).toThrow(/options must be an object/);
  });

  it('throws when options.measures is not an object', () => {
    expect(() => validateSquad(baseSquad(), [], { measures: [] })).toThrow(
      /options.measures must be an object/
    );
  });

  it('throws when an options.measures value is not a function', () => {
    expect(() => validateSquad(baseSquad(), [], { measures: { TEAM_RATING: 42 } })).toThrow(
      /options.measures.TEAM_RATING must be a function/
    );
  });

  it('throws when options.measures names a kind that is not a known measure', () => {
    expect(() => validateSquad(baseSquad(), [], { measures: { GALAXY_COUNT: () => 0 } })).toThrow(
      /options\.measures\.GALAXY_COUNT does not name a known measure kind/
    );
  });

  it('throws when options.measures supplies a measure for PLAYER_QUALITY', () => {
    expect(() =>
      validateSquad(baseSquad(), [constraint('PLAYER_QUALITY')], {
        measures: { PLAYER_QUALITY: () => 0 },
      })
    ).toThrow(/options\.measures\.PLAYER_QUALITY is not allowed/);
  });

  it('throws when options.clubLinks is neither a function nor a Map', () => {
    expect(() => validateSquad(baseSquad(), [], { clubLinks: 42 })).toThrow(
      /options.clubLinks must be a function or a Map/
    );
  });

  it('throws when a constraint is not an object', () => {
    expect(() => validateSquad(baseSquad(), [null])).toThrow(/constraint 0 must be an object/);
  });

  it('throws when a constraint has no kind string', () => {
    expect(() => validateSquad(baseSquad(), [{ value: 1, scope: 'GREATER' }])).toThrow(
      /constraint 0 must carry a string kind/
    );
  });

  it('throws on an unknown constraint kind', () => {
    expect(() => validateSquad(baseSquad(), [constraint('GALAXY_COUNT')])).toThrow(
      /Unknown constraint kind "GALAXY_COUNT"/
    );
    expect(() => validateSquad(baseSquad(), [constraint('SCOPE')])).toThrow(
      /Unknown constraint kind "SCOPE"/
    );
  });

  it('throws on an unknown constraint kind even when options.measures supplies a function for it', () => {
    expect(() =>
      validateSquad(baseSquad(), [constraint('GALAXY_COUNT')], {
        measures: { GALAXY_COUNT: () => 0 },
      })
    ).toThrow(/Unknown constraint kind "GALAXY_COUNT"/);
  });

  it('throws on an unknown scope', () => {
    expect(() =>
      validateSquad(baseSquad(), [{ kind: 'CHEMISTRY_POINTS', value: 1, scope: 'SOMETIMES' }])
    ).toThrow(/Unknown scope "SOMETIMES"/);
  });

  it('throws when the required value is not a finite number', () => {
    expect(() =>
      validateSquad(baseSquad(), [{ kind: 'CHEMISTRY_POINTS', value: NaN, scope: 'GREATER' }])
    ).toThrow(/constraint 0 required value must be a finite number/);
  });

  it('throws when CHEMISTRY_POINTS is required but squad.chemistry is missing', () => {
    expect(() =>
      validateSquad({ players: baseSquad().players }, [
        { kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' },
      ])
    ).toThrow(/squad.chemistry must be a finite number to check CHEMISTRY_POINTS/);
  });

  it('throws when a computed chemistry object carries no finite chemistry number', () => {
    expect(() =>
      validateSquad(
        { ...baseSquad(), chemistry: { chemistry: NaN, verified: false, reason: CHEMISTRY_REASON } },
        [constraint('CHEMISTRY_POINTS', { value: 30 })]
      )
    ).toThrow(/squad\.chemistry\.chemistry must be a finite number/);
  });

  it('throws when a computed chemistry object carries no boolean verified flag', () => {
    expect(() =>
      validateSquad(
        { ...baseSquad(), chemistry: { chemistry: 31, verified: 'yes' } },
        [constraint('CHEMISTRY_POINTS', { value: 30 })]
      )
    ).toThrow(/squad\.chemistry\.verified must be a boolean/);
  });

  it('throws when an unverified chemistry object carries no reason', () => {
    expect(() =>
      validateSquad(
        { ...baseSquad(), chemistry: { chemistry: 31, verified: false } },
        [constraint('CHEMISTRY_POINTS', { value: 30 })]
      )
    ).toThrow(/squad\.chemistry\.reason must be a non-empty string/);
  });

  it('throws on a chemistry reason this module cannot translate to a diagnostic', () => {
    expect(() =>
      validateSquad(
        { ...baseSquad(), chemistry: { chemistry: 31, verified: false, reason: 'made-up' } },
        [constraint('CHEMISTRY_POINTS', { value: 30 })]
      )
    ).toThrow(/is not a known unverified reason/);
  });

  it('rejects a chemistry object whose fields are inherited instead of owned', () => {
    const inherited = Object.create({ chemistry: 31, verified: true, reason: null });

    expect(() =>
      validateSquad({ ...baseSquad(), chemistry: inherited }, [
        constraint('CHEMISTRY_POINTS', { value: 30 }),
      ])
    ).toThrow(/must carry its own finite chemistry field/);
  });

  it('rejects a verified chemistry object whose reason is not null', () => {
    expect(() =>
      validateSquad(
        { ...baseSquad(), chemistry: { chemistry: 31, verified: true, reason: 'made-up' } },
        [constraint('CHEMISTRY_POINTS', { value: 30 })]
      )
    ).toThrow(/squad\.chemistry\.reason must be null when verified is true/);
  });

  it('rejects a known reason code that does not belong to chemistry', () => {
    expect(() =>
      validateSquad(
        { ...baseSquad(), chemistry: { chemistry: 31, verified: false, reason: RATING_REASON } },
        [constraint('CHEMISTRY_POINTS', { value: 30 })]
      )
    ).toThrow(/cannot map for CHEMISTRY_POINTS/);
  });

  it('does not require squad.chemistry when no constraint needs it', () => {
    const result = validateSquad({ players: baseSquad().players }, [
      { kind: 'LEAGUE_COUNT', value: 7, scope: 'EXACT' },
    ]);

    expect(result.valid).toBe(true);
  });

  it('throws when PLAYER_COUNT_MATCH carries no match object', () => {
    expect(() => validateSquad(baseSquad(), [constraint('PLAYER_COUNT_MATCH')])).toThrow(
      /constraint 0 is PLAYER_COUNT_MATCH and must carry a match object/
    );
  });

  it.each(['LEAGUE_COUNT', 'TEAM_RATING', 'PLAYER_QUALITY'])(
    'throws when %s carries a match object',
    (kind) => {
      expect(() =>
        validateSquad(baseSquad(), [
          { kind, value: 1, scope: 'GREATER', match: { nationIds: [21] } },
        ])
      ).toThrow(new RegExp(`constraint 0 \\(${kind}\\) must not carry a match object`));
    }
  );

  it.each([Infinity, -Infinity, NaN])(
    'throws when a measure returns a non-finite number (%s)',
    (value) => {
      expect(() =>
        validateSquad(baseSquad(), [constraint('TEAM_RATING')], {
          measures: { TEAM_RATING: () => value },
        })
      ).toThrow(/measure for TEAM_RATING on constraint 0 must return a finite number/);
    }
  );

  it('throws when a stable item field is not a finite number', () => {
    const players = baseSquad().players.map((player, index) =>
      index === 0 ? { ...player, rating: NaN } : player
    );

    expect(() => validateSquad({ players, chemistry: 1 }, [constraint('TEAM_RATING')])).toThrow(
      /squad\.players\[0\]\.rating must be a finite number/
    );
  });

  it.each([
    ['a non-object match', null, /constraint 0 match must be an object/],
    ['two match fields', { nationIds: [21], leagueIds: [31] }, /must name exactly one field/],
    ['an unsupported field', { playerClubs: [1] }, /has an unsupported match field "playerClubs"/],
    ['an empty value array', { nationIds: [] }, /match.nationIds must be a non-empty array/],
    ['a non-array value', { nationIds: 21 }, /match.nationIds must be a non-empty array/],
    ['a non-numeric value', { nationIds: ['21'] }, /match.nationIds must contain only finite numbers/],
  ])('throws on %s', (_label, match, message) => {
    expect(() => validateSquad(baseSquad(), [constraint('PLAYER_COUNT_MATCH', { match })])).toThrow(
      message
    );
  });
});

describe('validateSquad enforces the 11-player contract', () => {
  it.each([
    ['one player', 1],
    ['ten players', 10],
    ['twelve players', 12],
    ['twenty-two players', 22],
  ])('throws for %s instead of validating a partial squad', (_label, size) => {
    const players = Array.from({ length: size }, (_, index) => baseSquad().players[index % 11]);
    const constraints = [{ kind: 'NATION_COUNT', value: 1, scope: 'GREATER' }];

    expect(() => validateSquad({ players, chemistry: 31 }, constraints)).toThrow(
      new RegExp(`squad\\.players must contain exactly 11 players, received ${size}`)
    );
  });
});

describe('validateSquad requires stable unique item ids', () => {
  it('throws when all eleven items are copies of the same item', () => {
    const [first] = baseSquad().players;
    const players = Array.from({ length: 11 }, () => ({ ...first }));

    expect(() => validateSquad({ players, chemistry: 31 }, [])).toThrow(
      /squad\.players item ids must be unique; duplicated: /
    );
  });

  it('throws when only two items share an id', () => {
    const players = baseSquad().players;
    players[1] = { ...players[1], id: players[0].id };

    expect(() => validateSquad({ players, chemistry: 31 }, [])).toThrow(
      new RegExp(`squad\\.players item ids must be unique; duplicated: ${players[0].id}`)
    );
  });

  it('throws when a player carries no id', () => {
    const players = baseSquad().players.map((player, index) =>
      index === 0 ? without(player, 'id') : player
    );

    expect(() => validateSquad({ players, chemistry: 31 }, [])).toThrow(
      /squad\.players\[0\]\.id must be a finite number/
    );
  });

  it('accepts eleven players with distinct ids', () => {
    const result = validateSquad(baseSquad(), [
      { kind: 'NATION_COUNT', value: 1, scope: 'GREATER' },
    ]);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
  });
});

describe('validateSquad enforces the adapter stable item schema at the entry', () => {
  it.each(['rating', 'nationId', 'leagueId', 'clubId'])(
    'throws when %s is missing from a player',
    (field) => {
      const players = baseSquad().players.map((player, index) =>
        index === 0 ? without(player, field) : player
      );

      expect(() => validateSquad({ players, chemistry: 31 }, [])).toThrow(
        new RegExp(`squad\\.players\\[0\\]\\.${field} must be a finite number`)
      );
    }
  );

  it.each([NaN, Infinity, -Infinity, '84', null])(
    'throws when a stable field is present but not a finite number (%s)',
    (value) => {
      const players = baseSquad().players.map((player, index) =>
        index === 0 ? { ...player, clubId: value } : player
      );

      expect(() => validateSquad({ players, chemistry: 31 }, [])).toThrow(
        /squad\.players\[0\]\.clubId must be a finite number/
      );
    }
  );

  it('rejects raw club payload items that were never normalised', () => {
    const players = club.items.slice(0, 11);

    expect(() => validateSquad({ players, chemistry: 31 }, [])).toThrow(
      /squad\.players\[0\]\.nationId must be a finite number/
    );
  });
});

describe('stable field mapping through normaliseClubItem', () => {
  it('maps a captured raw club item onto the stable schema', () => {
    const raw = club.items[0];

    expect(normaliseClubItem(raw)).toEqual({
      id: raw.id,
      assetId: raw.assetId,
      rating: raw.rating,
      nationId: raw.nation,
      leagueId: raw.leagueId,
      clubId: raw.teamid,
      rarity: raw.rareflag,
      cardSubtype: raw.cardsubtypeid,
      playStyles: raw.playStyle,
      preferredPosition: raw.preferredPosition,
      possiblePositions: raw.possiblePositions,
      rolePlus: raw.plusRoles,
      rolePlusPlus: raw.plusPlusRoles ?? [],
      untradeable: raw.untradeable,
      pile: raw.pile,
      owners: raw.owners,
      collected: raw.isCollected,
      marketAverage: raw.marketAverage,
      marketMin: raw.marketDataMinPrice,
      marketMax: raw.marketDataMaxPrice,
      discardValue: raw.discardValue,
    });
  });

  it('takes clubId from the raw teamid even when the payload carries a conflicting clubId', () => {
    const raw = {
      id: 1,
      assetId: 1,
      rating: 80,
      nation: 1,
      leagueId: 16,
      teamid: 5,
      rareflag: 0,
      cardsubtypeid: 0,
      playStyle: 0,
      preferredPosition: 'ST',
      possiblePositions: ['ST'],
      untradeable: false,
      pile: 7,
      owners: 1,
      isCollected: true,
      clubId: 999,
    };

    expect(normaliseClubItem(raw).clubId).toBe(5);
  });

  it.each(['rating', 'nation', 'teamid'])(
    'throws when the raw item is missing %s instead of normalising it to undefined',
    (field) => {
      expect(() => normaliseClubItem(without(club.items[0], field))).toThrow(
        new RegExp(`normaliseClubItem: raw item must carry a finite ${field}`)
      );
    }
  );

  it('counts a clubIds match on the mapped clubId values', () => {
    const result = validateSquad(rawClubSquad(), [
      { kind: 'PLAYER_COUNT_MATCH', value: 2, scope: 'EXACT', match: { clubIds: [700] } },
    ]);

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('counts nobody when a clubIds match is written against another raw id', () => {
    const result = validateSquad(rawClubSquad(), [
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'EXACT', match: { clubIds: [100] } },
    ]);

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      kind: 'PLAYER_COUNT_MATCH',
      actual: 0,
      shortfall: 1,
      diagnostic: { id: 'missing-players', params: { count: 1 } },
    });
  });

  it('counts a leagueIds match on the mapped leagueId values', () => {
    const exact = validateSquad(rawClubSquad(), [
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'EXACT', match: { leagueIds: [100] } },
    ]);
    expect(exact.valid).toBe(true);
    expect(exact.failures).toEqual([]);

    const mismatched = validateSquad(rawClubSquad(), [
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'EXACT', match: { leagueIds: [9000] } },
    ]);
    expect(mismatched.failures).toHaveLength(1);
    expect(mismatched.failures[0]).toMatchObject({ actual: 0 });
  });
});

describe('options.measures honours the complete own-key set', () => {
  const measuresWith = (kind, measure) => {
    const measures = {};
    Object.defineProperty(measures, kind, { value: measure, enumerable: false });
    return measures;
  };

  it('throws for a non-enumerable PLAYER_QUALITY override instead of ignoring it', () => {
    expect(() =>
      validateSquad(baseSquad(), [GREATER('PLAYER_QUALITY')], {
        measures: measuresWith('PLAYER_QUALITY', () => 0),
      })
    ).toThrow(/options\.measures\.PLAYER_QUALITY is not allowed/);
  });

  it('throws for a non-enumerable unknown measure kind instead of ignoring it', () => {
    expect(() =>
      validateSquad(baseSquad(), [], { measures: measuresWith('GALAXY_COUNT', () => 0) })
    ).toThrow(/options\.measures\.GALAXY_COUNT does not name a known measure kind/);
  });

  it('applies a non-enumerable TEAM_RATING override and counts it caller-verified', () => {
    const sumRatings = (squad) => squad.players.reduce((sum, player) => sum + player.rating, 0);

    const result = validateSquad(baseSquad(), [GREATER('TEAM_RATING', 900)], {
      measures: measuresWith('TEAM_RATING', sumRatings),
    });

    expect(result.valid).toBe(true);
    expect(result.unverified).toEqual([]);
  });

  it('reads the own keys exactly once, so a proxy cannot answer differently between merge and verification', () => {
    let ownKeysReads = 0;
    const measures = new Proxy(
      {},
      {
        ownKeys() {
          ownKeysReads += 1;
          return ownKeysReads === 1 ? [] : ['TEAM_RATING'];
        },
        getOwnPropertyDescriptor() {
          return { configurable: true, enumerable: true, value: () => 100, writable: true };
        },
      }
    );

    const result = validateSquad(baseSquad(), [GREATER('TEAM_RATING', 90)], { measures });

    expect(ownKeysReads).toBe(1);
    expect(result.valid).toBe(false);
    expect(result.failures).toEqual([
      {
        kind: 'TEAM_RATING',
        required: 90,
        actual: 83,
        shortfall: 7,
        scope: 'GREATER',
        unverified: true,
        diagnostic: { id: 'missing-rating', params: { points: 7 } },
      },
    ]);
    expect(result.unverified).toEqual([
      {
        kind: 'TEAM_RATING',
        required: 90,
        scope: 'GREATER',
        reason: RATING_REASON,
        diagnostic: { id: 'rating-formula-unverified', params: {} },
      },
    ]);
  });
});

describe('validateSquad rejects sparse arrays', () => {
  it('throws for a constraints array created with new Array(1)', () => {
    expect(() => validateSquad(baseSquad(), new Array(1))).toThrow(
      /constraints must not contain holes \(index 0 is missing\)/
    );
  });

  it('throws for a hole in the middle of the constraints array', () => {
    const constraints = [
      { kind: 'LEAGUE_COUNT', value: 7, scope: 'EXACT' },
      ,
      { kind: 'NATION_COUNT', value: 7, scope: 'EXACT' },
    ];

    expect(() => validateSquad(baseSquad(), constraints)).toThrow(
      /constraints must not contain holes \(index 1 is missing\)/
    );
  });

  it('throws for a sparse players array', () => {
    const players = baseSquad().players;
    delete players[3];

    expect(() => validateSquad({ players, chemistry: 31 }, [])).toThrow(
      /squad\.players must not contain holes \(index 3 is missing\)/
    );
  });

  it('throws for a sparse match value list', () => {
    const match = { nationIds: [21, , 42] };

    expect(() =>
      validateSquad(baseSquad(), [GREATER('PLAYER_COUNT_MATCH', 1, { match })])
    ).toThrow(/constraint 0 match\.nationIds must not contain holes \(index 1 is missing\)/);
  });
});

describe('structured diagnostics', () => {
  const DOCUMENTED_IDS = [
    'chemistry-formula-unverified',
    'missing-chemistry',
    'missing-clubs',
    'missing-leagues',
    'missing-nations',
    'missing-players',
    'missing-rating',
    'player-level-not-checked',
    'quality-not-checked',
    'rating-formula-unverified',
  ];

  // One constraint per documented id: a base squad, deliberately probed. The
  // quoted numbers are the fixture's own measurements (7 leagues, 7 nations,
  // chemistry 31, rounded mean rating 83, 11 clubs, 4 nation-21 players).
  const ALL_ID_SCENARIOS = [
    { kind: 'LEAGUE_COUNT', value: 8, scope: 'GREATER' },
    { kind: 'NATION_COUNT', value: 8, scope: 'GREATER' },
    { kind: 'CHEMISTRY_POINTS', value: 40, scope: 'GREATER' },
    { kind: 'TEAM_RATING', value: 84, scope: 'GREATER' },
    { kind: 'CLUB_COUNT', value: 12, scope: 'GREATER' },
    { kind: 'PLAYER_COUNT_MATCH', value: 5, scope: 'GREATER', match: { nationIds: [21] } },
    { kind: 'PLAYER_QUALITY', value: 1, scope: 'GREATER' },
    { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { playerLevels: [2] } },
  ];

  const diagnosticsOf = (result) =>
    [...result.failures, ...result.unverified].map((entry) => entry.diagnostic);

  // The unverified-chemistry diagnostic can never coexist with the
  // missing-chemistry failure in one result, so it is probed with its own
  // squad rather than by the shared scenario table above.
  const computedChemistryDiagnostics = () =>
    diagnosticsOf(
      validateSquad(computedSquad(31), [{ kind: 'CHEMISTRY_POINTS', value: 33, scope: 'GREATER' }])
    );

  it('reports a chemistry shortfall as an id and the shortfall number', () => {
    const result = validateSquad(baseSquad(18), [
      { kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' },
    ]);

    expect(result.failures[0].diagnostic).toEqual({
      id: 'missing-chemistry',
      params: { points: 12 },
    });
  });

  it('covers every documented diagnostic id with an id and a params object', () => {
    const diagnostics = [
      ...diagnosticsOf(validateSquad(baseSquad(31), ALL_ID_SCENARIOS)),
      ...computedChemistryDiagnostics(),
    ];

    expect(new Set(diagnostics.map(({ id }) => id)).size).toBe(DOCUMENTED_IDS.length);
    expect(diagnostics.map(({ id }) => id).sort()).toEqual(DOCUMENTED_IDS);
    for (const diagnostic of diagnostics) {
      expect(typeof diagnostic.id).toBe('string');
      expect(typeof diagnostic.params).toBe('object');
      expect(diagnostic.params).not.toBeNull();
      expect(Array.isArray(diagnostic.params)).toBe(false);
    }
  });

  it('pins the shortfall number each failure diagnostic carries', () => {
    const result = validateSquad(baseSquad(31), ALL_ID_SCENARIOS);

    expect(result.failures.map((failure) => failure.diagnostic)).toEqual([
      { id: 'missing-leagues', params: { count: 1 } },
      { id: 'missing-nations', params: { count: 1 } },
      { id: 'missing-chemistry', params: { points: 9 } },
      { id: 'missing-rating', params: { points: 1 } },
      { id: 'missing-clubs', params: { count: 1 } },
      { id: 'missing-players', params: { count: 1 } },
    ]);
  });

  it.each([
    ['SAME_LEAGUE_COUNT', 'missing-leagues'],
    ['SAME_NATION_COUNT', 'missing-nations'],
    ['SAME_CLUB_COUNT', 'missing-clubs'],
  ])('maps %s onto the %s diagnostic', (kind, id) => {
    const [failure] = validateSquad(baseSquad(), [{ kind, value: 20, scope: 'GREATER' }]).failures;

    expect(failure.diagnostic).toEqual({ id, params: { count: failure.shortfall } });
  });

  it('keeps every diagnostic id and param free of prose', () => {
    const diagnostics = [
      ...diagnosticsOf(validateSquad(baseSquad(31), ALL_ID_SCENARIOS)),
      ...computedChemistryDiagnostics(),
    ];

    for (const { id, params } of diagnostics) {
      expect(id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      for (const [key, value] of Object.entries(params)) {
        expect(['count', 'points']).toContain(key);
        expect(typeof value).toBe('number');
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('surfaces unverified requirements as ids that carry no numbers', () => {
    const result = validateSquad(baseSquad(), [
      { kind: 'PLAYER_QUALITY', value: 1, scope: 'GREATER' },
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { playerLevels: [2] } },
      { kind: 'TEAM_RATING', value: 75, scope: 'GREATER' },
    ]);

    expect(result.unverified.map((entry) => entry.diagnostic)).toEqual([
      { id: 'quality-not-checked', params: {} },
      { id: 'player-level-not-checked', params: {} },
      { id: 'rating-formula-unverified', params: {} },
    ]);
  });
});

describe('the solver source never names a raw EA field or enum', () => {
  const solverSource = readFileSync(
    fileURLToPath(new URL('../src/solver/validate.js', import.meta.url)),
    'utf8'
  );

  // Comments and JSDoc may name the presentation words the solver must never
  // return; only executable code is checked here.
  const codeOnly = solverSource
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  it.each([
    ['the raw club field teamid', /teamid/],
    ['the raw club field rareflag', /rareflag/],
    ['the raw enum name PLAYER_LEVEL', /\bPLAYER_LEVEL\b/],
    ['the raw enum name TEAM_RATING_1_TO_100', /TEAM_RATING_1_TO_100/],
    ['a raw .nation property read', /\.nation\b/],
  ])('contains no %s', (_label, pattern) => {
    expect(solverSource).not.toMatch(pattern);
  });

  it.each([
    ['the word needs', /\bneeds\b/],
    ['the phrase short by', /short by/],
    ['the phrase must equal', /must equal/],
    ['the phrase not checked', /not checked/],
    ['the word decrease', /\bdecrease\b/],
    ['the word increase', /\bincrease\b/],
  ])('contains no %s outside comments', (_label, pattern) => {
    expect(codeOnly).not.toMatch(pattern);
  });

  it('never returns a presentation-only direction field', () => {
    const [failure] = validateSquad(baseSquad(), [
      { kind: 'LEAGUE_COUNT', value: 8, scope: 'GREATER' },
    ]).failures;

    expect(failure).not.toHaveProperty('direction');
  });

  it('no longer exports the panel-text formatters', async () => {
    const solver = await import('../src/solver/validate.js');

    expect(solver.describeFailures).toBeUndefined();
    expect(solver.describeUnverified).toBeUndefined();
  });
});
