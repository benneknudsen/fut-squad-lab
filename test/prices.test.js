import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import club from './fixtures/club-items.json';
import { normaliseClub } from '../src/solver/candidates.js';
import {
  CARD_STATES,
  DEFAULT_WEIGHTS,
  PRICE_SOURCES,
  UNKNOWN_CONTRIBUTION,
  classifyCardState,
  compareContributions,
  itemCost,
  mergePrices,
  totalCost,
} from '../src/solver/prices.js';

// These tests exercise the price-merge and fodder cost model. The captured club
// fixture is the only real price data available, and it is degenerate in the
// states this model exists for:
//
//   - assetId is unique across all 42 items, so the club holds no duplicate;
//   - a club capture holds owned cards only, so it holds no concept card;
//   - marketAverage is absent on a few items, but discardValue is never absent,
//     so a fully unpriced card never occurs either.
//
// Duplicate, concept and fully unpriced records are therefore constructed
// below, and the fixture-degeneracy test at the top fails if a future capture
// ever changes that, so this file cannot silently stop covering those states.
// Every other record below comes through the real adapter and `normaliseClub`.

const fixtureRawItems = club.itemData;

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

// One stable record through the real normalisation path, carrying `duplicate`.
const stableRecord = (overrides = {}) => normaliseClub([raw(overrides)])[0];

// A concept card is not a club item, so it cannot come through the adapter: a
// caller marks one explicitly and supplies the record's price externally.
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

describe('captured club fixture degeneracy', () => {
  it('is unique by assetId and holds no concept card', () => {
    expect(fixtureRawItems).toHaveLength(42);
    expect(new Set(fixtureRawItems.map((item) => item.assetId)).size).toBe(
      fixtureRawItems.length
    );
    expect(fixtureRawItems.filter((item) => item.concept === true)).toHaveLength(0);
  });

  it('really does carry the missing-price and ownership splits the model must handle', () => {
    const missingAverage = fixtureRawItems.filter(
      (item) => !Object.hasOwn(item, 'marketAverage')
    );
    const untradeable = fixtureRawItems.filter((item) => item.untradeable === true);
    const tradeable = fixtureRawItems.filter((item) => item.untradeable === false);

    expect(missingAverage.length).toBeGreaterThan(0);
    expect(untradeable.length).toBeGreaterThan(0);
    expect(tradeable.length).toBeGreaterThan(0);
  });
});

describe('documented vocabulary', () => {
  it('exposes exactly the four card states and the five price sources', () => {
    expect(CARD_STATES).toEqual([
      'untradeableDuplicate',
      'untradeable',
      'tradeable',
      'concept',
    ]);
    expect(PRICE_SOURCES).toEqual({
      external: 'external',
      marketAverage: 'ea-market-average',
      discardValue: 'ea-discard-value',
      ratingEstimate: 'rating-p60-estimate',
      none: 'none',
    });
  });
});

describe('classifyCardState', () => {
  it('classifies the four card states from the record flags', () => {
    const [tradeable] = normaliseClub([raw({ untradeable: false })]);
    const [untradeable] = normaliseClub([raw({ untradeable: true })]);

    expect(classifyCardState(tradeable)).toBe('tradeable');
    expect(classifyCardState(untradeable)).toBe('untradeable');
    expect(classifyCardState(conceptRecord())).toBe('concept');
  });

  it('flags only the extra copies of a repeated assetId as duplicates', () => {
    const [first, second] = normaliseClub([
      raw({ id: 1, assetId: 77, untradeable: true }),
      raw({ id: 2, assetId: 77, untradeable: true }),
    ]);

    expect(classifyCardState(first)).toBe('untradeable');
    expect(classifyCardState(second)).toBe('untradeableDuplicate');
  });

  it('classifies a duplicate tradeable card as tradeable, not as a duplicate', () => {
    const [, second] = normaliseClub([
      raw({ id: 1, assetId: 77, untradeable: false }),
      raw({ id: 2, assetId: 77, untradeable: false }),
    ]);

    expect(classifyCardState(second)).toBe('tradeable');
  });

  it('classifies a concept card without needing the ownership flags', () => {
    const concept = conceptRecord();
    delete concept.untradeable;
    delete concept.duplicate;

    expect(classifyCardState(concept)).toBe('concept');
  });

  it('throws when untradeable is missing instead of defaulting to tradeable', () => {
    const record = stableRecord();
    delete record.untradeable;

    expect(() => classifyCardState(record)).toThrow(/untradeable/);
  });

  it.each([
    ['a string', 'yes'],
    ['a number', 1],
    ['null', null],
  ])('rejects %s untradeable instead of coercing it', (_label, untradeable) => {
    const record = { ...stableRecord(), untradeable };

    expect(() => classifyCardState(record)).toThrow(/untradeable/);
  });

  it('throws when duplicate is missing on an untradeable card', () => {
    const record = stableRecord({ untradeable: true });
    delete record.duplicate;

    expect(() => classifyCardState(record)).toThrow(/duplicate/);
  });

  it('throws when duplicate is missing on a tradeable card too, instead of assuming false', () => {
    const record = stableRecord({ untradeable: false });
    delete record.duplicate;

    expect(() => classifyCardState(record)).toThrow(/duplicate/);
  });

  it.each([
    ['a string', 'yes'],
    ['a number', 1],
  ])('rejects %s concept flag instead of coercing it', (_label, concept) => {
    const record = { ...stableRecord(), concept };

    expect(() => classifyCardState(record)).toThrow(/concept/);
  });

  it('treats an absent concept flag as an owned card', () => {
    const record = stableRecord();

    expect(Object.hasOwn(record, 'concept')).toBe(false);
    expect(classifyCardState(record)).toBe('untradeable');
  });

  it('throws for a record that is not an object', () => {
    expect(() => classifyCardState('player')).toThrow(/must be an object/);
  });
});

describe('mergePrices', () => {
  it('prefers an external price over every EA value and records the source', () => {
    const records = mergePrices(
      [stableRecord({ assetId: 501, marketAverage: 1000, discardValue: 400 })],
      { 501: 7777 }
    );

    expect(records[0].price).toBe(7777);
    expect(records[0].priceSource).toBe(PRICE_SOURCES.external);
  });

  it('falls back to marketAverage when no external table is supplied at all', () => {
    const records = mergePrices([
      stableRecord({ marketAverage: 1000, discardValue: 400 }),
    ]);

    expect(records[0].price).toBe(1000);
    expect(records[0].priceSource).toBe(PRICE_SOURCES.marketAverage);
  });

  it('falls back to discardValue when marketAverage is absent, recording that source', () => {
    const records = mergePrices([
      stableRecord({ marketAverage: null, discardValue: 400 }),
    ]);

    expect(records[0].price).toBe(400);
    expect(records[0].priceSource).toBe(PRICE_SOURCES.discardValue);
  });

  it('keeps a known zero price as a price, never as unknown', () => {
    const records = mergePrices([
      stableRecord({ marketAverage: null, discardValue: 0 }),
    ]);

    expect(records[0].price).toBe(0);
    expect(records[0].priceSource).toBe(PRICE_SOURCES.discardValue);
  });

  it('records no price and the none source when no source produced one', () => {
    const records = mergePrices([
      stableRecord({ marketAverage: null, discardValue: null }),
    ]);

    expect(records[0].price).toBeNull();
    expect(records[0].priceSource).toBe(PRICE_SOURCES.none);
  });

  it('accepts an empty external table as the offline case', () => {
    const records = mergePrices([stableRecord({ marketAverage: 800 })], {});

    expect(records[0].price).toBe(800);
    expect(records[0].priceSource).toBe(PRICE_SOURCES.marketAverage);
  });

  it('accepts a Map keyed by number or by numeric string', () => {
    const records = mergePrices(
      [
        stableRecord({ id: 1, assetId: 601 }),
        stableRecord({ id: 2, assetId: 602 }),
      ],
      new Map([
        [601, 111],
        ['602', 222],
      ])
    );

    expect(records.map((record) => record.price)).toEqual([111, 222]);
    expect(records.map((record) => record.priceSource)).toEqual([
      PRICE_SOURCES.external,
      PRICE_SOURCES.external,
    ]);
  });

  it('ignores malformed external entries and falls back to EA values', () => {
    const records = mergePrices(
      [
        stableRecord({ id: 1, assetId: 611, marketAverage: 1000, discardValue: 400 }),
        stableRecord({ id: 2, assetId: 612, marketAverage: 1000, discardValue: 400 }),
        stableRecord({ id: 3, assetId: 613, marketAverage: 1000, discardValue: 400 }),
        stableRecord({ id: 4, assetId: 614, marketAverage: 1000, discardValue: 400 }),
      ],
      {
        611: 'cheap',
        612: -5,
        613: Number.NaN,
        614: Number.POSITIVE_INFINITY,
      }
    );

    expect(records.map((record) => record.price)).toEqual([1000, 1000, 1000, 1000]);
    expect(records.map((record) => record.priceSource)).toEqual([
      PRICE_SOURCES.marketAverage,
      PRICE_SOURCES.marketAverage,
      PRICE_SOURCES.marketAverage,
      PRICE_SOURCES.marketAverage,
    ]);
  });

  it('never uses EA values for a concept card, because the user does not own it', () => {
    const [record] = mergePrices([
      conceptRecord({ assetId: 621, marketAverage: 1000, discardValue: 400 }),
    ]);

    expect(record.cardState).toBe('concept');
    expect(record.price).toBeNull();
    expect(record.priceSource).toBe(PRICE_SOURCES.none);
  });

  it('prices a concept card from the external table when one exists', () => {
    const [record] = mergePrices([conceptRecord({ assetId: 622 })], { 622: 2500 });

    expect(record.cardState).toBe('concept');
    expect(record.price).toBe(2500);
    expect(record.priceSource).toBe(PRICE_SOURCES.external);
  });

  it('attaches the classified card state alongside the resolved price', () => {
    const [record] = mergePrices([stableRecord({ untradeable: true })]);

    expect(record.cardState).toBe('untradeable');
  });

  it('does not mutate the records it merges', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 631 }),
      raw({ id: 2, assetId: 632 }),
    ]);
    const snapshot = JSON.stringify(records);

    const merged = mergePrices(records, { 631: 500 });

    expect(JSON.stringify(records)).toBe(snapshot);
    expect(merged[0].price).toBe(500);
  });

  it('rejects a malformed EA price field instead of treating it as unknown', () => {
    const asString = { ...stableRecord(), marketAverage: '1000' };
    const negativeDiscard = { ...stableRecord({ marketAverage: null }), discardValue: -1 };

    expect(() => mergePrices([asString])).toThrow(/marketAverage/);
    expect(() => mergePrices([negativeDiscard])).toThrow(/discardValue/);
  });

  it('rejects a sparse record list instead of returning holes', () => {
    expect(() => mergePrices(new Array(1))).toThrow(
      /mergePrices: records must not contain holes \(index 0 is missing\)/
    );
  });

  it('rejects an external table that is neither a Map nor a plain object', () => {
    expect(() => mergePrices([stableRecord()], 'cheap')).toThrow(/externalPrices/);
    expect(() => mergePrices([stableRecord()], [1, 2])).toThrow(/externalPrices/);
  });
});

describe('itemCost', () => {
  const merge = (overrides, externalPrices) =>
    mergePrices([stableRecord(overrides)], externalPrices)[0];

  it('returns price, source, weight and contribution as separate fields', () => {
    const record = merge({ untradeable: true, marketAverage: 1000 });

    expect(itemCost(record)).toEqual({
      price: 1000,
      priceSource: PRICE_SOURCES.marketAverage,
      weight: 0.7,
      contribution: 700,
    });
  });

  it('applies the design default weight to each of the four card states', () => {
    const tradeable = merge({ id: 1, assetId: 701, untradeable: false, marketAverage: 1000 });
    const untradeable = merge({ id: 2, assetId: 702, untradeable: true, marketAverage: 1000 });
    const [, duplicate] = mergePrices(
      normaliseClub([
        raw({ id: 3, assetId: 703, untradeable: true, marketAverage: 1000 }),
        raw({ id: 4, assetId: 703, untradeable: true, marketAverage: 1000 }),
      ])
    );
    const concept = mergePrices([conceptRecord({ id: 5, assetId: 704 })], { 704: 1000 })[0];

    expect(itemCost(tradeable)).toEqual({
      price: 1000,
      priceSource: PRICE_SOURCES.marketAverage,
      weight: 1,
      contribution: 1000,
    });
    expect(itemCost(untradeable)).toEqual({
      price: 1000,
      priceSource: PRICE_SOURCES.marketAverage,
      weight: 0.7,
      contribution: 700,
    });
    expect(itemCost(duplicate)).toEqual({
      price: 1000,
      priceSource: PRICE_SOURCES.marketAverage,
      weight: 0.1,
      contribution: 100,
    });
    expect(itemCost(concept)).toEqual({
      price: 1000,
      priceSource: PRICE_SOURCES.external,
      weight: 2,
      contribution: 2000,
    });
  });

  it('uses the design defaults when no weights argument is supplied', () => {
    expect(DEFAULT_WEIGHTS).toEqual({
      untradeableDuplicate: 0.1,
      untradeable: 0.7,
      tradeable: 1,
      concept: 2,
    });
  });

  it('makes a duplicate cost less than a tradeable card at identical market value', () => {
    const tradeable = merge({ id: 1, assetId: 711, untradeable: false, marketAverage: 1000 });
    const [, duplicate] = mergePrices(
      normaliseClub([
        raw({ id: 2, assetId: 712, untradeable: true, marketAverage: 1000 }),
        raw({ id: 3, assetId: 712, untradeable: true, marketAverage: 1000 }),
      ])
    );

    expect(itemCost(duplicate).contribution).toBe(100);
    expect(itemCost(tradeable).contribution).toBe(1000);
    expect(itemCost(duplicate).contribution).toBeLessThan(itemCost(tradeable).contribution);
  });

  it('lets a caller override one weight at runtime and changes the cost', () => {
    const record = merge({ untradeable: true, marketAverage: 1000 });

    expect(itemCost(record)).toEqual({
      price: 1000,
      priceSource: PRICE_SOURCES.marketAverage,
      weight: 0.7,
      contribution: 700,
    });
    expect(itemCost(record, { untradeable: 0.75 })).toEqual({
      price: 1000,
      priceSource: PRICE_SOURCES.marketAverage,
      weight: 0.75,
      contribution: 750,
    });
  });

  it('merges a partial override over the untouched defaults', () => {
    const [, duplicate] = mergePrices(
      normaliseClub([
        raw({ id: 1, assetId: 721, untradeable: true, marketAverage: 1000 }),
        raw({ id: 2, assetId: 721, untradeable: true, marketAverage: 1000 }),
      ])
    );

    const cost = itemCost(duplicate, { tradeable: 5 });

    expect(cost.weight).toBe(0.1);
    expect(cost.contribution).toBe(100);
  });

  it('does not mutate the caller weights or the defaults', () => {
    const record = merge({ marketAverage: 1000 });
    const weights = { tradeable: 2 };
    const weightsSnapshot = JSON.stringify(weights);
    const defaultSnapshot = JSON.stringify(DEFAULT_WEIGHTS);

    itemCost(record, weights);

    expect(JSON.stringify(weights)).toBe(weightsSnapshot);
    expect(JSON.stringify(DEFAULT_WEIGHTS)).toBe(defaultSnapshot);
  });

  it('never scores an unpriced record cheaper than a known price', () => {
    const unpriced = merge({ id: 1, assetId: 731, marketAverage: null, discardValue: null });
    const priced = merge({ id: 2, assetId: 732, marketAverage: 1, discardValue: null });

    const unpricedCost = itemCost(unpriced);
    const pricedCost = itemCost(priced);

    expect(Number.isNaN(unpricedCost.contribution)).toBe(false);
    expect(unpricedCost.contribution).not.toBe(0);
    expect(unpricedCost.contribution).toBe(UNKNOWN_CONTRIBUTION);
    expect(compareContributions(unpricedCost.contribution, pricedCost.contribution)).toBe(1);
    expect(unpricedCost.price).toBeNull();
    expect(unpricedCost.priceSource).toBe(PRICE_SOURCES.none);
  });

  it('keeps an unknown contribution unknown through a JSON round trip', () => {
    const unpriced = merge({ id: 1, assetId: 751, marketAverage: null, discardValue: null });

    const cost = itemCost(unpriced);
    const transported = JSON.parse(JSON.stringify(cost));

    expect(cost.contribution).toBe(UNKNOWN_CONTRIBUTION);
    expect(transported).toEqual(cost);
    expect(transported.contribution).toBeNull();
    expect(transported.contribution).toBe(UNKNOWN_CONTRIBUTION);
    expect(transported.priceSource).toBe(PRICE_SOURCES.none);
    expect(compareContributions(transported.contribution, 0)).toBe(1);
  });

  it('keeps the unknown contribution even when its state weight is zero', () => {
    const unpriced = merge({ id: 1, assetId: 741, marketAverage: null, discardValue: null });

    const cost = itemCost(unpriced, { untradeable: 0 });

    expect(cost.weight).toBe(0);
    expect(cost.contribution).toBe(UNKNOWN_CONTRIBUTION);
  });

  it('throws when the record does not say which card state it is', () => {
    const record = merge({ marketAverage: 1000 });
    const { cardState, ...withoutState } = record;

    expect(() => itemCost(withoutState)).toThrow(/cardState/);
  });

  it('throws on an unknown card state instead of assuming tradeable', () => {
    const record = merge({ marketAverage: 1000 });

    expect(() => itemCost({ ...record, cardState: 'bronze' })).toThrow(/cardState/);
  });

  it('throws when the record has no resolved price, instead of guessing one', () => {
    const record = merge({ marketAverage: 1000 });
    const { price, ...withoutPrice } = record;

    expect(() => itemCost(withoutPrice)).toThrow(/price/);
  });

  it('throws when the record carries no price source', () => {
    const record = merge({ marketAverage: 1000 });
    const { priceSource, ...withoutSource } = record;

    expect(() => itemCost(withoutSource)).toThrow(/priceSource/);
  });

  it('rejects a price and a priceSource that disagree in either direction', () => {
    const record = merge({ marketAverage: 1000 });

    expect(() =>
      itemCost({ ...record, price: 0, priceSource: PRICE_SOURCES.none })
    ).toThrow(/record\.price.*record\.priceSource/);
    expect(() =>
      itemCost({ ...record, price: null, priceSource: PRICE_SOURCES.marketAverage })
    ).toThrow(/record\.price.*record\.priceSource/);
    expect(() =>
      itemCost({ ...record, price: null, priceSource: PRICE_SOURCES.external })
    ).toThrow(/record\.price.*record\.priceSource/);
  });

  it('rejects an EA price source on a concept card, which the club cannot price', () => {
    const concept = mergePrices([conceptRecord({ id: 1, assetId: 752 })], { 752: 2500 })[0];

    expect(() =>
      itemCost({ ...concept, price: 1000, priceSource: PRICE_SOURCES.marketAverage })
    ).toThrow(/record\.price.*record\.priceSource/);
  });

  it('accepts a concept card with an external price or with no price at all', () => {
    const priced = mergePrices([conceptRecord({ id: 1, assetId: 753 })], { 753: 2500 })[0];
    const unpriced = mergePrices([conceptRecord({ id: 2, assetId: 754 })])[0];

    expect(itemCost(priced).contribution).toBe(5000);
    expect(itemCost(unpriced).contribution).toBe(UNKNOWN_CONTRIBUTION);
  });

  it('rejects an overflowed price * weight instead of letting it look like an unknown price', () => {
    const record = merge({ untradeable: false, marketAverage: 1000 });

    expect(() =>
      itemCost({ ...record, price: Number.MAX_VALUE }, { tradeable: 2 })
    ).toThrow(/contribution/);
  });

  it('rejects a Map where a weight table is expected instead of silently ignoring it', () => {
    const record = merge({ marketAverage: 1000 });

    expect(() => itemCost(record, new Map([['tradeable', 5]]))).toThrow(/weights/);
  });

  it.each([
    ['a negative weight', -0.5],
    ['a NaN weight', Number.NaN],
    ['an infinite weight', Number.POSITIVE_INFINITY],
    ['a string weight', '0.5'],
  ])('rejects %s instead of producing a bad contribution', (_label, weight) => {
    const record = merge({ marketAverage: 1000 });

    expect(() => itemCost(record, { tradeable: weight })).toThrow(/tradeable/);
  });

  it('rejects a weight key that names no card state', () => {
    const record = merge({ marketAverage: 1000 });

    expect(() => itemCost(record, { striker: 2 })).toThrow(/striker/);
  });
});

describe('totalCost', () => {
  const merge = (overrides) => mergePrices([stableRecord(overrides)])[0];

  it('sums known contributions into one finite total', () => {
    const untradeable = itemCost(
      merge({ id: 1, assetId: 761, untradeable: true, marketAverage: 1000 })
    );
    const tradeable = itemCost(
      merge({ id: 2, assetId: 762, untradeable: false, marketAverage: 250 })
    );

    expect(totalCost([untradeable.contribution, tradeable.contribution])).toBe(950);
  });

  it('returns a known total as the same number after a JSON round trip', () => {
    const contribution = itemCost(
      merge({ id: 1, assetId: 763, untradeable: true, marketAverage: 1000 })
    ).contribution;

    expect(JSON.parse(JSON.stringify(totalCost([contribution])))).toBe(700);
  });

  it('propagates an unknown contribution instead of adding it as zero', () => {
    const unknown = itemCost(
      merge({ id: 1, assetId: 764, marketAverage: null, discardValue: null })
    );
    const known = itemCost(
      merge({ id: 2, assetId: 765, untradeable: false, marketAverage: 300 })
    );

    expect(unknown.contribution).toBe(UNKNOWN_CONTRIBUTION);
    const total = totalCost([unknown.contribution, known.contribution]);

    expect(total).toBe(UNKNOWN_CONTRIBUTION);
    expect(total).not.toBe(300);
    expect(total).not.toBe(known.contribution);
    expect(compareContributions(total, known.contribution)).toBe(1);
  });

  it('propagates an unknown contribution in any position, not only the first', () => {
    expect(totalCost([300, UNKNOWN_CONTRIBUTION, 300])).toBe(UNKNOWN_CONTRIBUTION);
  });

  it('keeps an unknown total unknown through a JSON round trip', () => {
    const transported = JSON.parse(JSON.stringify(totalCost([UNKNOWN_CONTRIBUTION, 300])));

    expect(transported).toBeNull();
    expect(transported).toBe(UNKNOWN_CONTRIBUTION);
    expect(compareContributions(transported, 0)).toBe(1);
  });

  it('rejects a sum of finite contributions that overflows to Infinity', () => {
    expect(() => totalCost([Number.MAX_VALUE, Number.MAX_VALUE])).toThrow(
      /totalCost.*not finite/
    );
  });

  it('rejects the overflow two valid itemCost contributions produce', () => {
    const record = mergePrices(
      [stableRecord({ untradeable: false, marketAverage: 1000 })],
      { 500: Number.MAX_VALUE }
    )[0];
    const contribution = itemCost(record).contribution;

    expect(contribution).toBe(Number.MAX_VALUE);
    expect(() => totalCost([contribution, contribution])).toThrow(/prices: totalCost/);
  });

  it('returns zero for no contributions', () => {
    expect(totalCost([])).toBe(0);
  });

  it.each([
    ['a negative number', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['a string', '300'],
  ])('rejects %s instead of summing it', (_label, contribution) => {
    expect(() => totalCost([contribution])).toThrow(/prices: totalCost/);
  });

  it('rejects a sparse contribution list instead of skipping the hole', () => {
    expect(() => totalCost(new Array(1))).toThrow(/prices: totalCost/);
  });

  it('rejects a contribution list that is not an array', () => {
    expect(() => totalCost(300)).toThrow(/prices: totalCost/);
  });
});

describe('EA payload names stay in the adapter', () => {
  const RAW_ONLY_NAMES = [
    'nation',
    'teamid',
    'rareflag',
    'cardsubtypeid',
    'isCollected',
    'marketDataMinPrice',
    'marketDataMaxPrice',
    'playStyle',
    'plusRoles',
    'plusPlusRoles',
    'itemData',
    'pile',
  ];

  it('names no raw payload field anywhere in src/solver/prices.js', () => {
    const source = readFileSync(new URL('../src/solver/prices.js', import.meta.url), 'utf8');

    for (const name of RAW_ONLY_NAMES) {
      expect(source).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
