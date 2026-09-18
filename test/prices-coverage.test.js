import { describe, expect, it } from 'vitest';

import { normaliseChemistryProfile, normaliseTeamChemLinks } from '../src/ea/adapter.js';
import { buildPool, normaliseClub } from '../src/solver/candidates.js';
import {
  UNKNOWN_CONTRIBUTION,
  compareContributions,
  costCoverage,
  itemCost,
  mergePrices,
} from '../src/solver/prices.js';
import { reevaluate, solve } from '../src/solver/solve.js';
import clubFixture from './fixtures/club-items.json';
import linksFixture from './fixtures/chemistry-teamlinks.json';
import profilesFixture from './fixtures/chemistry-profiles.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import set16 from './fixtures/sbs-set-16-challenges.json';

// A cost is only meaningful when every card in the squad is priced. These tests
// pin the aggregation of that fact: `costCoverage` names the cards without a
// resolvable price, and `solve`/`reevaluate` carry a `costComplete` qualifier
// beside the cost, so a caller can tell a real total from a lower bound without
// walking the card list.
//
// The exact fixture costs below are the pre-change numbers observed on this
// fixture (set16.challenges[0] and [3] with the shared options). They are here
// so the qualifier cannot be added by changing what the cost number means.

const POOL = buildPool(normaliseClub(clubFixture.itemData));

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

const raw = (overrides = {}) => ({
  id: 1000,
  assetId: 500,
  rating: 80,
  nation: 1,
  leagueId: 10,
  teamid: 100,
  rareflag: 0,
  cardsubtypeid: 0,
  playStyle: 0,
  preferredPosition: 'ST',
  possiblePositions: ['ST'],
  untradeable: true,
  pile: 7,
  owners: 1,
  isCollected: true,
  marketAverage: 1000,
  marketDataMinPrice: 900,
  marketDataMaxPrice: 1200,
  discardValue: 400,
  ...overrides,
});

const stableRecord = (overrides = {}) => normaliseClub([raw(overrides)])[0];

// A concept card is not a club item: a caller marks it explicitly and it has no
// EA price data at all, because the user does not own it.
const conceptRecord = (overrides = {}) => ({
  ...stableRecord({
    marketAverage: null,
    marketDataMinPrice: null,
    marketDataMaxPrice: null,
    discardValue: null,
  }),
  concept: true,
  ...overrides,
});

const F442_SLOTS = ['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'];

const EMPTY_CHALLENGE = { formation: 'f442', elgReq: [], elgOperation: 'AND' };

const ALL_SLOTS = Object.freeze(Array.from({ length: 11 }, (_, index) => index));

// One record per slot, every one priced except the concept ST: the solver has
// no choice at ten slots and the concept card can only sort last at the other.
const conceptSquadPool = () => {
  const records = F442_SLOTS.map((position, index) =>
    stableRecord({
      id: 800 + index,
      assetId: 900 + index,
      preferredPosition: position,
      possiblePositions: [position],
      marketAverage: 1000,
      discardValue: null,
    })
  );
  records[10] = conceptRecord({
    id: 810,
    assetId: 910,
    preferredPosition: 'ST',
    possiblePositions: ['ST'],
  });
  return mergePrices(records);
};

describe('costCoverage', () => {
  it('counts a fully priced squad as complete', () => {
    const records = mergePrices([
      stableRecord({ id: 1, assetId: 501, marketAverage: 1000 }),
      stableRecord({ id: 2, assetId: 502, marketAverage: 2000 }),
      stableRecord({ id: 3, assetId: 503, marketAverage: null, discardValue: 400 }),
    ]);

    expect(costCoverage(records)).toEqual({
      known: 3,
      unknown: 0,
      complete: true,
      unknownCards: [],
    });
  });

  it('counts a wholly unpriced squad as unknown and names every card', () => {
    const records = mergePrices([
      stableRecord({ id: 11, assetId: 511, marketAverage: null, discardValue: null }),
      stableRecord({ id: 12, assetId: 512, marketAverage: null, discardValue: null }),
    ]);

    expect(costCoverage(records)).toEqual({
      known: 0,
      unknown: 2,
      complete: false,
      unknownCards: [
        { slot: 0, id: 11, assetId: 511 },
        { slot: 1, id: 12, assetId: 512 },
      ],
    });
  });

  it('names only the unpriced card of a mixed squad, by slot and identity', () => {
    const records = mergePrices([
      stableRecord({ id: 21, assetId: 521, marketAverage: 1000 }),
      stableRecord({ id: 22, assetId: 522, marketAverage: null, discardValue: null }),
      stableRecord({ id: 23, assetId: 523, marketAverage: 500 }),
    ]);

    expect(costCoverage(records)).toEqual({
      known: 2,
      unknown: 1,
      complete: false,
      unknownCards: [{ slot: 1, id: 22, assetId: 522 }],
    });
  });

  it('counts a known zero price as priced and an absent price as unknown', () => {
    const zero = mergePrices([
      stableRecord({ id: 31, assetId: 531, marketAverage: null, discardValue: 0 }),
    ])[0];
    const absent = mergePrices([
      stableRecord({ id: 32, assetId: 532, marketAverage: null, discardValue: null }),
    ])[0];

    expect(itemCost(zero).contribution).toBe(0);
    expect(itemCost(zero).contribution).not.toBe(UNKNOWN_CONTRIBUTION);
    expect(itemCost(absent).contribution).toBe(UNKNOWN_CONTRIBUTION);

    expect(costCoverage([zero])).toEqual({
      known: 1,
      unknown: 0,
      complete: true,
      unknownCards: [],
    });
    expect(costCoverage([zero, absent])).toEqual({
      known: 1,
      unknown: 1,
      complete: false,
      unknownCards: [{ slot: 1, id: 32, assetId: 532 }],
    });
  });

  it('counts a concept card as unknown even when every other card is priced', () => {
    const priced = mergePrices([
      stableRecord({ id: 41, assetId: 541, marketAverage: 1000 }),
    ])[0];
    const [concept] = mergePrices([conceptRecord({ id: 42, assetId: 542 })]);

    expect(concept.cardState).toBe('concept');
    expect(costCoverage([priced, concept])).toEqual({
      known: 1,
      unknown: 1,
      complete: false,
      unknownCards: [{ slot: 1, id: 42, assetId: 542 }],
    });
  });

  it('accepts an empty squad as vacuously complete', () => {
    expect(costCoverage([])).toEqual({
      known: 0,
      unknown: 0,
      complete: true,
      unknownCards: [],
    });
  });

  it('does not mutate the records it inspects', () => {
    const records = mergePrices([
      stableRecord({ id: 51, assetId: 551, marketAverage: 1000 }),
      stableRecord({ id: 52, assetId: 552, marketAverage: null, discardValue: null }),
    ]);
    const snapshot = JSON.stringify(records);

    costCoverage(records);

    expect(JSON.stringify(records)).toBe(snapshot);
  });

  it('rejects a sparse record list and a non-array, like totalCost', () => {
    expect(() => costCoverage(new Array(1))).toThrow(/costCoverage/);
    expect(() => costCoverage('squad')).toThrow(/costCoverage/);
  });
});

describe('unknown price honesty', () => {
  it('keeps UNKNOWN_CONTRIBUTION as null through JSON and sorts it last', () => {
    expect(UNKNOWN_CONTRIBUTION).toBeNull();
    expect(JSON.parse(JSON.stringify(UNKNOWN_CONTRIBUTION))).toBe(UNKNOWN_CONTRIBUTION);
    expect(compareContributions(UNKNOWN_CONTRIBUTION, 0)).toBe(1);
    expect(compareContributions(0, UNKNOWN_CONTRIBUTION)).toBe(-1);
    expect(compareContributions(UNKNOWN_CONTRIBUTION, UNKNOWN_CONTRIBUTION)).toBe(0);
  });

  it('keeps a coverage summary complete flag and unknown marker through JSON', () => {
    const coverage = costCoverage(
      mergePrices([
        stableRecord({ id: 61, assetId: 561, marketAverage: 1000 }),
        stableRecord({ id: 62, assetId: 562, marketAverage: null, discardValue: null }),
      ])
    );

    const transported = JSON.parse(JSON.stringify(coverage));

    expect(transported).toEqual(coverage);
    expect(transported.complete).toBe(false);
    expect(transported.unknownCards).toEqual([{ slot: 1, id: 62, assetId: 562 }]);
  });
});

describe('solve cost completeness', () => {
  it('keeps the cost number and validity unchanged for a fully priced squad', () => {
    const result = solve(set16.challenges[0], POOL, options());

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.cost).toBe(769);
    expect(result.costComplete).toBe(true);

    const coverage = costCoverage(result.squad.players);
    expect(coverage.complete).toBe(true);
    expect(coverage.known).toBe(11);
    expect(coverage.unknown).toBe(0);
  });

  it('keeps a second fully priced fixture solve exactly as before', () => {
    const result = solve(set16.challenges[3], POOL, options());

    expect(result.valid).toBe(true);
    expect(result.cost).toBe(2368.4);
    expect(result.costComplete).toBe(true);
  });

  it('reports price completeness independently of validity', () => {
    const result = solve(set10.challenges[0], POOL, options());

    expect(result.valid).toBe(false);
    expect(result.cost).toBe(829);
    expect(result.costComplete).toBe(true);
  });

  it('carries the qualifier through an effort-enabled improvement pass', () => {
    const result = solve(set16.challenges[0], POOL, options({ effort: 'fast' }));

    expect(result.valid).toBe(true);
    expect(Number.isFinite(result.cost)).toBe(true);
    expect(result.costComplete).toBe(true);
  });

  it('reports an all-unpriced squad as an incomplete total, never as free', () => {
    const rawItems = F442_SLOTS.map((position, index) => ({
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
    }));

    const result = solve(EMPTY_CHALLENGE, buildPool(normaliseClub(rawItems)), { seed: 1 });

    expect(result.valid).toBe(true);
    expect(result.cost).toBe(UNKNOWN_CONTRIBUTION);
    expect(result.costComplete).toBe(false);
    expect(costCoverage(result.squad.players)).toMatchObject({
      known: 0,
      unknown: 11,
      complete: false,
    });
  });

  it('reports a concept card as unknown even when the other ten starters are priced', () => {
    const result = solve(EMPTY_CHALLENGE, conceptSquadPool(), { seed: 1 });

    expect(result.valid).toBe(true);
    expect(result.cost).toBe(UNKNOWN_CONTRIBUTION);
    expect(result.costComplete).toBe(false);

    const coverage = costCoverage(result.squad.players);
    expect(coverage.known).toBe(10);
    expect(coverage.unknown).toBe(1);
    expect(coverage.unknownCards).toHaveLength(1);
    const [unknown] = coverage.unknownCards;
    expect(result.squad.players[unknown.slot].cardState).toBe('concept');
  });
});

describe('reevaluate cost completeness', () => {
  it('carries a complete total through the interactive re-solve', () => {
    const base = solve(set16.challenges[0], POOL, options());
    expect(base.costComplete).toBe(true);

    const result = reevaluate(base.squad, [], POOL, options({ challenge: set16.challenges[0] }));

    expect(result.valid).toBe(true);
    expect(Number.isFinite(result.cost)).toBe(true);
    expect(result.costComplete).toBe(true);
    expect(costCoverage(result.squad.players).complete).toBe(true);
  });

  it('reports a locked concept card as an incomplete total', () => {
    const pool = conceptSquadPool();
    const solved = solve(EMPTY_CHALLENGE, pool, { seed: 1 });

    const result = reevaluate(solved.squad, ALL_SLOTS, pool, {
      challenge: EMPTY_CHALLENGE,
      seed: 1,
    });

    expect(result.cost).toBe(UNKNOWN_CONTRIBUTION);
    expect(result.costComplete).toBe(false);
    expect(costCoverage(result.squad.players)).toMatchObject({
      known: 10,
      unknown: 1,
      complete: false,
    });
  });
});
