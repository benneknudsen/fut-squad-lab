import { describe, expect, it } from 'vitest';

import { normaliseClub } from '../src/solver/candidates.js';
import * as costModel from '../src/solver/prices.js';
import { solve } from '../src/solver/solve.js';
import { withEligibility } from './helpers/eligibility.js';

// Issue #60: the four fodder weights are borrowed from SBC Monkey's published
// documentation (facts only; no affiliation) and a card with no market value is
// estimated at the P60 of the market values of cards with a similar rating.
// These tests pin the behaviour those numbers exist for, not just the numbers:
// a concept card must be more expensive than a tradeable one, a duplicate must
// win a slot ahead of an untradeable and that ahead of a tradeable, and an
// estimate must never be mistakable for a quoted market value.
//
// The constants are read through a namespace import on purpose: this file was
// written before the implementation existed, so the assertions had to fail on
// their values rather than on a missing named export at module load.

const {
  DEFAULT_WEIGHTS,
  MIN_ESTIMATE_SAMPLES,
  P60_PERCENTILE,
  PRICE_SOURCES,
  SIMILAR_RATING_RADIUS,
  UNKNOWN_CONTRIBUTION,
  itemCost,
  mergePrices,
} = costModel;

// A complete raw club item; every field the adapter requires is present.
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

// A concept card is not a club item: a caller marks one explicitly and it has
// no EA price data at all, because the user does not own it.
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

// One fixed, fully priced player for a formation slot. The GK slot is the one
// under test, so it is supplied separately by the caller.
const fixedPlayer = (id, position, overrides = {}) => ({
  id,
  assetId: id + 1000,
  rating: 80,
  nationId: 1,
  leagueId: 10,
  clubId: 100,
  rareflag: 0,
  cardsubtypeid: 0,
  playStyle: 0,
  preferredPosition: position,
  possiblePositions: [position],
  untradeable: true,
  duplicate: false,
  pile: 7,
  owners: 1,
  isCollected: true,
  marketAverage: 1000,
  marketDataMinPrice: null,
  marketDataMaxPrice: null,
  discardValue: null,
  ...overrides,
});

// A fillable eleven with one GK chosen from `variants`; every other slot is
// fixed, so the only choice the solver makes is the GK.
const poolWithGoalkeeperChoice = (variants) => {
  const records = [];
  let id = 1;
  for (const position of F442_SLOTS) {
    if (position === 'GK') continue;
    records.push(fixedPlayer(id++, position));
  }
  records.push(...variants.map((variant) => fixedPlayer(variant.id, 'GK', variant)));
  return records;
};

const chosenGoalkeeperId = (variants) => {
  const result = solve(EMPTY_CHALLENGE, poolWithGoalkeeperChoice(variants), withEligibility({ seed: 1 }));
  expect(result.valid).toBe(true);
  return result.squad.players.find((player) => player.preferredPosition === 'GK').id;
};

describe('borrowed fodder weights', () => {
  it('ships the published defaults, and duplicate < untradeable < tradeable < concept holds', () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      untradeableDuplicate: 0.1,
      untradeable: 0.7,
      tradeable: 1,
      concept: 2,
    });
    expect(DEFAULT_WEIGHTS.untradeableDuplicate).toBeLessThan(DEFAULT_WEIGHTS.untradeable);
    expect(DEFAULT_WEIGHTS.untradeable).toBeLessThan(DEFAULT_WEIGHTS.tradeable);
    expect(DEFAULT_WEIGHTS.tradeable).toBeLessThan(DEFAULT_WEIGHTS.concept);
  });

  it('makes a concept card cost more than an equivalent tradeable card', () => {
    const [concept] = mergePrices([conceptRecord({ id: 1, assetId: 6001 })], { 6001: 1000 });
    const [tradeable] = mergePrices([
      stableRecord({ id: 2, assetId: 6002, untradeable: false, marketAverage: 1000 }),
    ]);

    expect(itemCost(concept).weight).toBe(2);
    expect(itemCost(concept).contribution).toBe(2000);
    expect(itemCost(tradeable).contribution).toBe(1000);
    expect(itemCost(concept).contribution).toBeGreaterThan(itemCost(tradeable).contribution);
  });

  it('prefers a duplicate to a non-duplicate untradeable, and that to a tradeable', () => {
    const tradeable = { id: 9003, assetId: 10003, untradeable: false, duplicate: false };
    const untradeable = { id: 9002, assetId: 10002, untradeable: true, duplicate: false };
    const duplicate = { id: 9001, assetId: 10001, untradeable: true, duplicate: true };

    expect(chosenGoalkeeperId([tradeable, untradeable, duplicate])).toBe(duplicate.id);
    expect(chosenGoalkeeperId([tradeable, untradeable])).toBe(untradeable.id);
    expect(chosenGoalkeeperId([tradeable])).toBe(tradeable.id);
  });

  it('changes the chosen player when a weight is overridden through the options', () => {
    const [concept] = mergePrices(
      [
        conceptRecord({
          id: 9004,
          assetId: 10004,
          preferredPosition: 'GK',
          possiblePositions: ['GK'],
        }),
      ],
      { 10004: 1000 }
    );
    const untradeable = fixedPlayer(9005, 'GK', { untradeable: true, duplicate: false });
    const pool = poolWithGoalkeeperChoice([concept, untradeable]);

    const byDefault = solve(EMPTY_CHALLENGE, pool, withEligibility({ seed: 1 }));
    const defaultChoice = byDefault.squad.players.find(
      (player) => player.preferredPosition === 'GK'
    );
    expect(defaultChoice.id).toBe(untradeable.id);

    const costlierUntradeable = solve(
      EMPTY_CHALLENGE,
      pool,
      withEligibility({ seed: 1, weights: { untradeable: 3 } })
    );
    const overriddenChoice = costlierUntradeable.squad.players.find(
      (player) => player.preferredPosition === 'GK'
    );
    expect(overriddenChoice.id).toBe(concept.id);
  });
});

describe('rating-based estimate for cards with no market value', () => {
  const referencesAt = (rating, marketValues) =>
    marketValues.map((marketAverage, index) =>
      stableRecord({ id: 100 + index, assetId: 200 + index, rating, marketAverage })
    );

  it('estimates an unpriced card from same-rating market values, but never overwrites a quote', () => {
    const references = referencesAt(80, [1000, 2000, 3000, 4000, 5000]);
    const unpriced = stableRecord({
      id: 901,
      assetId: 1001,
      rating: 80,
      marketAverage: null,
      discardValue: null,
    });
    const quoted = stableRecord({ id: 902, assetId: 1002, rating: 80, marketAverage: 750 });

    const merged = mergePrices([...references, unpriced, quoted]);

    expect(merged[5].price).toBe(3000);
    expect(merged[5].priceSource).toBe(PRICE_SOURCES.ratingEstimate);
    expect(merged[6].price).toBe(750);
    expect(merged[6].priceSource).toBe(PRICE_SOURCES.marketAverage);
  });

  it('computes the estimate as the hand-computed 60th percentile of same-rating market values', () => {
    // Sorted [100, 200, 300, 400, 1000], n = 5. Nearest-rank P60 is the
    // element at ceil(0.6 * 5) - 1 = index 2, i.e. 300 — not the 400 mean.
    const references = referencesAt(80, [1000, 400, 100, 300, 200]);
    const unpriced = stableRecord({
      id: 911,
      assetId: 1011,
      rating: 80,
      marketAverage: null,
      discardValue: null,
    });

    const [estimated] = mergePrices([...references, unpriced]).slice(-1);

    expect(P60_PERCENTILE).toBe(0.6);
    expect(estimated.price).toBe(300);
    expect(estimated.price).not.toBe(400);
    expect(estimated.priceSource).toBe(PRICE_SOURCES.ratingEstimate);
  });

  it('refuses to estimate when fewer than the minimum same-rating market values exist', () => {
    const references = referencesAt(80, [1000, 2000]);
    const unpriced = stableRecord({
      id: 921,
      assetId: 1021,
      rating: 80,
      marketAverage: null,
      discardValue: null,
    });

    const [, , estimated] = mergePrices([...references, unpriced]);

    expect(estimated.price).toBeNull();
    expect(estimated.priceSource).toBe(PRICE_SOURCES.none);
    expect(itemCost(estimated).contribution).not.toBe(0);
    expect(itemCost(estimated).contribution).toBe(UNKNOWN_CONTRIBUTION);
    expect(MIN_ESTIMATE_SAMPLES).toBe(3);
  });

  it('uses market values, never quick-sell values, as the percentile population', () => {
    const quickSells = [10, 20, 30].map((discardValue, index) =>
      stableRecord({
        id: 110 + index,
        assetId: 210 + index,
        rating: 80,
        marketAverage: null,
        discardValue,
      })
    );
    const unpriced = stableRecord({
      id: 931,
      assetId: 1031,
      rating: 80,
      marketAverage: null,
      discardValue: null,
    });

    const merged = mergePrices([...quickSells, unpriced]);
    const target = merged[3];

    expect(target.price).toBeNull();
    expect(target.priceSource).toBe(PRICE_SOURCES.none);
  });

  it('estimates only from an exact rating match while the radius constant is 0', () => {
    const references = referencesAt(81, [1000, 2000, 3000]);
    const unpriced = stableRecord({
      id: 941,
      assetId: 1041,
      rating: 80,
      marketAverage: null,
      discardValue: null,
    });

    const [, , , estimated] = mergePrices([...references, unpriced]);

    expect(SIMILAR_RATING_RADIUS).toBe(0);
    expect(estimated.price).toBeNull();
    expect(estimated.priceSource).toBe(PRICE_SOURCES.none);
  });

  it('marks an estimate with a source a caller can tell from a quoted price', () => {
    const references = referencesAt(80, [1000, 2000, 3000]);
    const unpriced = stableRecord({
      id: 951,
      assetId: 1051,
      rating: 80,
      marketAverage: null,
      discardValue: null,
    });
    const quoted = stableRecord({ id: 952, assetId: 1052, rating: 80, marketAverage: 750 });

    const merged = mergePrices([...references, unpriced, quoted]);

    expect(PRICE_SOURCES.ratingEstimate).not.toBe(PRICE_SOURCES.marketAverage);
    expect(PRICE_SOURCES.ratingEstimate).not.toBe(PRICE_SOURCES.external);
    expect(itemCost(merged[3]).priceSource).toBe(PRICE_SOURCES.ratingEstimate);
    expect(itemCost(merged[4]).priceSource).toBe(PRICE_SOURCES.marketAverage);
  });
});