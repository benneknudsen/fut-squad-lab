import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import club from './fixtures/club-items.json';
import { normaliseClubItem } from '../src/ea/adapter.js';
import { buildPool, normaliseClub } from '../src/solver/candidates.js';
import { mergePrices } from '../src/solver/prices.js';

// These tests exercise the club-to-pool path. The captured fixture is the
// ground truth for the raw record shape, but three of its properties are
// degenerate and cannot drive the behaviour under test:
//
//   - no item repeats another item's assetId (42 items, 42 distinct values), so
//     duplicate marking is proven with synthetic records;
//   - every item carries the same value for the rarity and ownership fields, so
//     any grouping or duplicate rule based on those values alone would pass
//     vacuously and is therefore proven with synthetic records too;
//   - no (preferred position, exact rating) group has more than three members,
//     so the trim cap is proven with synthetic records as well.
//
// Synthetic raw items below go through the real adapter, so every pool test
// covers the full path from a raw club item to a trimmed pool record.

const fixtureRawItems = club.itemData;

const DOCUMENTED_FIELDS = [
  'id',
  'assetId',
  'rating',
  'nationId',
  'leagueId',
  'clubId',
  'rarity',
  'cardSubtype',
  'playStyles',
  'preferredPosition',
  'possiblePositions',
  'rolePlus',
  'rolePlusPlus',
  'untradeable',
  'pile',
  'owners',
  'collected',
  'marketAverage',
  'marketMin',
  'marketMax',
  'discardValue',
  'duplicate',
];

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

const without = (object, key) => {
  const copy = { ...object };
  delete copy[key];
  return copy;
};

// Six items in one (position, exact rating) group, cheapest third in input
// order. Prices ascend from 100 so the ranking is not wired to the input order.
const pricedClub = () =>
  normaliseClub([
    raw({ id: 1, assetId: 11, marketAverage: 900, discardValue: 900 }),
    raw({ id: 2, assetId: 12, marketAverage: 700, discardValue: 700 }),
    raw({ id: 3, assetId: 13, marketAverage: 100, discardValue: 100 }),
    raw({ id: 4, assetId: 14, marketAverage: 600, discardValue: 600 }),
    raw({ id: 5, assetId: 15, marketAverage: 300, discardValue: 300 }),
    raw({ id: 6, assetId: 16, marketAverage: 800, discardValue: 800 }),
  ]);

// Six one-position rivals in a second group, priced 100..600: one more than the
// capped group can hold, so the most expensive rival is trimmed while a fallback
// record in another group survives as that group's only candidate.
const stRivals = () =>
  [1, 2, 3, 4, 5, 6].map((step) =>
    raw({
      id: 100 + step,
      assetId: 200 + step,
      preferredPosition: 'ST',
      possiblePositions: ['ST'],
      marketAverage: step * 100,
      discardValue: step * 100,
    })
  );

// Three unmerged records where raw market value and weighted contribution
// disagree: the tradeable card is the cheapest raw card (300), while the
// untradeable duplicate contributes only 0.20 * 1000 = 200. Unmerged records
// prove the trimmer's own state weighting; the merged path is proven below
// with an external price table.
const weightedRivals = () =>
  normaliseClub([
    raw({ id: 1, assetId: 11, untradeable: false, marketAverage: 300, discardValue: 300 }),
    raw({ id: 2, assetId: 12, untradeable: true, marketAverage: 1000, discardValue: 1000 }),
    raw({ id: 3, assetId: 12, untradeable: true, marketAverage: 1000, discardValue: 1000 }),
  ]);

describe('normaliseClub over the captured club fixture', () => {
  const records = normaliseClub(fixtureRawItems);

  it('returns one record per raw item, in input order', () => {
    expect(records).toHaveLength(fixtureRawItems.length);
    expect(records.map((record) => record.id)).toEqual(
      fixtureRawItems.map((rawItem) => rawItem.id)
    );
  });

  it('gives every record every documented field and nothing else', () => {
    const expectedKeys = [...DOCUMENTED_FIELDS].sort();
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(expectedKeys);
    }
  });

  it('maps the widened fields from the captured payload', () => {
    const source = fixtureRawItems[0];
    const record = records[0];

    expect(record.assetId).toBe(source.assetId);
    expect(record.cardSubtype).toBe(source.cardsubtypeid);
    expect(record.playStyles).toBe(source.playStyle);
    expect(record.preferredPosition).toBe(source.preferredPosition);
    expect(record.possiblePositions).toEqual(source.possiblePositions);
    expect(record.untradeable).toBe(source.untradeable);
    expect(record.pile).toBe(source.pile);
    expect(record.owners).toBe(source.owners);
    expect(record.collected).toBe(source.isCollected);
    expect(record.marketAverage).toBe(source.marketAverage);
    expect(record.marketMin).toBe(source.marketDataMinPrice);
    expect(record.marketMax).toBe(source.marketDataMaxPrice);
    expect(record.discardValue).toBe(source.discardValue);
  });

  it('normalises an absent price to null, never to zero', () => {
    const sourcesWithoutAverage = fixtureRawItems.filter(
      (rawItem) => !Object.hasOwn(rawItem, 'marketAverage')
    );
    expect(sourcesWithoutAverage.length).toBeGreaterThan(0);

    const pool = buildPool(records, { groupSize: 5 });
    for (const source of sourcesWithoutAverage) {
      const record = pool.find((entry) => entry.id === source.id);
      expect(record.marketAverage).toBeNull();
    }
  });
});

describe('normaliseClub input contract', () => {
  it('does not mutate the raw payload items', () => {
    const raws = [raw(), raw({ id: 2, assetId: 501 })];
    const snapshot = JSON.stringify(raws);

    const records = normaliseClub(raws);

    expect(JSON.stringify(raws)).toBe(snapshot);
    expect(records).toHaveLength(2);
  });

  it('throws when the club is not an array', () => {
    expect(() => normaliseClub({ item: raw() })).toThrow(/normaliseClub/);
  });

  it('rejects a sparse raw club array instead of returning holes', () => {
    expect(() => normaliseClub(new Array(3))).toThrow(
      /normaliseClub: raw club items must not contain holes \(index 0 is missing\)/
    );
    expect(() => normaliseClub([raw(), , raw({ id: 2, assetId: 501 })])).toThrow(
      /normaliseClub: raw club items must not contain holes \(index 1 is missing\)/
    );
  });
});

describe('widened adapter validation', () => {
  it.each([
    'id',
    'assetId',
    'rating',
    'nation',
    'leagueId',
    'teamid',
    'rareflag',
    'cardsubtypeid',
    'playStyle',
    'preferredPosition',
    'possiblePositions',
    'untradeable',
    'pile',
    'owners',
    'isCollected',
  ])('throws when the raw item is missing %s instead of emitting undefined', (field) => {
    expect(() => normaliseClub([without(raw(), field)])).toThrow(
      new RegExp(`normaliseClubItem.*${field}`)
    );
  });

  const PRICE_FIELDS = [
    ['marketAverage', 'marketAverage'],
    ['marketDataMinPrice', 'marketMin'],
    ['marketDataMaxPrice', 'marketMax'],
    ['discardValue', 'discardValue'],
  ];

  it.each(PRICE_FIELDS)(
    'normalises an absent %s to null, never to zero',
    (rawField, stableField) => {
      const [record] = normaliseClub([without(raw(), rawField)]);

      expect(record[stableField]).toBeNull();
    }
  );

  it.each(PRICE_FIELDS)(
    'normalises an explicit null %s to null, never to zero',
    (rawField, stableField) => {
      const [record] = normaliseClub([raw({ [rawField]: null })]);

      expect(record[stableField]).toBeNull();
    }
  );

  it.each(PRICE_FIELDS)(
    'rejects a present but non-numeric %s instead of coercing it',
    (rawField) => {
      expect(() => normaliseClub([raw({ [rawField]: '1100' })])).toThrow(
        new RegExp(`normaliseClubItem.*${rawField}`)
      );
    }
  );

  it('rejects a sparse possiblePositions list instead of skipping the hole', () => {
    expect(() => normaliseClub([raw({ possiblePositions: ['ST', , 'CAM'] })])).toThrow(
      /normaliseClubItem.*possiblePositions/
    );
    expect(() => normaliseClub([raw({ possiblePositions: new Array(3) })])).toThrow(
      /normaliseClubItem.*possiblePositions/
    );
  });

  it.each([
    ['a non-string entry', ['ST', 42]],
    ['an empty string entry', ['ST', '']],
  ])('rejects %s in possiblePositions', (_label, possiblePositions) => {
    expect(() => normaliseClub([raw({ possiblePositions })])).toThrow(
      /normaliseClubItem.*possiblePositions/
    );
  });

  it('passes repeated position names through; buildPool deduplicates them later', () => {
    const [record] = normaliseClub([raw({ possiblePositions: ['ST', 'ST'] })]);

    expect(record.possiblePositions).toEqual(['ST', 'ST']);
  });
});

describe('special-card role lists', () => {
  it('maps plusRoles onto the stable rolePlus list', () => {
    const [record] = normaliseClub([raw({ plusRoles: [31, 32, 43] })]);

    expect(record.rolePlus).toEqual([31, 32, 43]);
  });

  it('maps plusPlusRoles onto the stable rolePlusPlus list when present', () => {
    const [record] = normaliseClub([raw({ plusRoles: [31], plusPlusRoles: [116] })]);

    expect(record.rolePlusPlus).toEqual([116]);
  });

  it.each([undefined, null])(
    'normalises an absent plusRoles (%s) to an empty rolePlus list without throwing',
    (plusRoles) => {
      const [record] = normaliseClub([raw({ plusRoles })]);

      expect(record.rolePlus).toEqual([]);
    }
  );

  it.each([undefined, null])(
    'normalises an absent plusPlusRoles (%s) to an empty rolePlusPlus list without throwing',
    (plusPlusRoles) => {
      const [record] = normaliseClub([raw({ plusPlusRoles })]);

      expect(record.rolePlusPlus).toEqual([]);
    }
  );

  it.each([
    ['a non-list plusRoles', { plusRoles: 31 }, /normaliseClubItem.*plusRoles/],
    ['a non-list plusPlusRoles', { plusPlusRoles: 31 }, /normaliseClubItem.*plusPlusRoles/],
    ['a non-numeric plusRoles entry', { plusRoles: [31, '32'] }, /normaliseClubItem.*plusRoles/],
    [
      'a non-numeric plusPlusRoles entry',
      { plusPlusRoles: [31, '32'] },
      /normaliseClubItem.*plusPlusRoles/,
    ],
    ['a sparse plusRoles list', { plusRoles: [31, , 43] }, /normaliseClubItem.*plusRoles/],
    [
      'a sparse plusPlusRoles list',
      { plusPlusRoles: [31, , 43] },
      /normaliseClubItem.*plusPlusRoles/,
    ],
  ])('rejects %s with a message naming the field', (_label, overrides, message) => {
    expect(() => normaliseClub([raw(overrides)])).toThrow(message);
  });

  it('gives every captured fixture item a rolePlus list and honours its plusPlusRoles', () => {
    const records = normaliseClub(fixtureRawItems);
    expect(records).toHaveLength(fixtureRawItems.length);
    expect(fixtureRawItems).toHaveLength(42);

    for (const [index, record] of records.entries()) {
      expect(Array.isArray(record.rolePlus)).toBe(true);
      expect(record.rolePlus).toEqual(fixtureRawItems[index].plusRoles);
    }

    const sourcesWithPlusPlus = fixtureRawItems.filter((rawItem) =>
      Object.hasOwn(rawItem, 'plusPlusRoles')
    );
    expect(sourcesWithPlusPlus.length).toBeGreaterThan(0);

    for (const source of sourcesWithPlusPlus) {
      const record = records.find((entry) => entry.id === source.id);
      expect(record.rolePlusPlus).toEqual(source.plusPlusRoles);
      expect(record.rolePlusPlus.length).toBeGreaterThan(0);
    }
  });
});

describe('duplicate marking', () => {
  it('flags exactly the extra copies of a repeated assetId', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 77 }),
      raw({ id: 2, assetId: 88 }),
      raw({ id: 3, assetId: 77 }),
      raw({ id: 4, assetId: 77 }),
    ]);

    expect(records.map((record) => record.duplicate)).toEqual([false, false, true, true]);
  });

  it('decides duplicates from assetId, not from the ownership fields', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 77, owners: 1, isCollected: true }),
      raw({ id: 2, assetId: 88, owners: 9, isCollected: false }),
      raw({ id: 3, assetId: 77, owners: 1, isCollected: true }),
    ]);

    expect(records.map((record) => record.duplicate)).toEqual([false, false, true]);
  });

  it('keeps the duplicate flag on the records that survive trimming', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 77, marketAverage: 900, discardValue: 900 }),
      raw({ id: 2, assetId: 77, marketAverage: 100, discardValue: 100 }),
    ]);

    const pool = buildPool(records, { groupSize: 1 });

    expect(pool).toHaveLength(1);
    expect(pool[0].id).toBe(2);
    expect(pool[0].duplicate).toBe(true);
  });
});

describe('buildPool', () => {
  it('returns an empty pool for an empty club without throwing', () => {
    expect(normaliseClub([])).toEqual([]);
    expect(buildPool([])).toEqual([]);
    expect(buildPool(normaliseClub([]), { scope: 'untradeable', groupSize: 2 })).toEqual([]);
  });

  it('rejects sparse records instead of skipping the holes', () => {
    const records = normaliseClub([raw({ id: 1, assetId: 11 }), raw({ id: 2, assetId: 12 })]);

    expect(() => buildPool(new Array(1))).toThrow(
      /buildPool: records must not contain holes \(index 0 is missing\)/
    );
    expect(() => buildPool([records[0], , records[1]])).toThrow(
      /buildPool: records must not contain holes \(index 1 is missing\)/
    );
  });

  it('keeps the whole captured fixture because no group exceeds the default cap', () => {
    const pool = buildPool(normaliseClub(fixtureRawItems));

    expect(pool).toHaveLength(fixtureRawItems.length);
  });

  it('keeps every candidate from a group at or below the cap', () => {
    const records = pricedClub();
    const pool = buildPool(records, { groupSize: 6 });

    expect(pool.map((record) => record.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('drops the most expensive candidates once a group exceeds the cap', () => {
    const pool = buildPool(pricedClub(), { groupSize: 2 });

    expect(pool.map((record) => record.id)).toEqual([3, 5]);
  });

  it('keeps the cheapest per group even when it is neither first nor last in input order', () => {
    const records = pricedClub();
    const cheapest = records.reduce((lowest, record) =>
      record.marketAverage < lowest.marketAverage ? record : lowest
    );

    const pool = buildPool(records, { groupSize: 2 });

    expect(cheapest.id).toBe(3);
    expect(pool.map((record) => record.id)).toEqual([3, 5]);
  });

  it('keeps five candidates in a group by default', () => {
    const pool = buildPool(pricedClub());

    expect(pool).toHaveLength(5);
    expect(pool.map((record) => record.id)).toEqual([2, 3, 4, 5, 6]);
  });

  it('trims a 400-record club to the five cheapest in one group and a fraction of the club', () => {
    const records = normaliseClub(
      Array.from({ length: 400 }, (_, index) =>
        raw({
          id: index + 1,
          assetId: 1000 + index,
          marketAverage: (400 - index) * 100,
          discardValue: (400 - index) * 100,
        })
      )
    );

    const pool = buildPool(records);

    expect(records).toHaveLength(400);
    expect(pool).toHaveLength(5);
    expect(pool.map((record) => record.id)).toEqual([396, 397, 398, 399, 400]);
    expect(pool.length / records.length).toBeLessThan(0.05);
  });

  it('keeps exact ratings apart at the default band width', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, rating: 82, marketAverage: 500, discardValue: 500 }),
      raw({ id: 2, assetId: 12, rating: 84, marketAverage: 900, discardValue: 900 }),
    ]);

    const pool = buildPool(records, { groupSize: 1 });

    expect(pool.map((record) => record.id)).toEqual([1, 2]);
  });

  it('merges adjacent ratings only when the caller widens the band', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, rating: 82, marketAverage: 500, discardValue: 500 }),
      raw({ id: 2, assetId: 12, rating: 84, marketAverage: 900, discardValue: 900 }),
    ]);

    const pool = buildPool(records, { groupSize: 1, ratingBandWidth: 5 });

    expect(pool.map((record) => record.id)).toEqual([1]);
  });

  it('keeps preferred positions apart', () => {
    const records = normaliseClub([
      raw({
        id: 1,
        assetId: 11,
        preferredPosition: 'ST',
        possiblePositions: ['ST'],
        marketAverage: 500,
        discardValue: 500,
      }),
      raw({
        id: 2,
        assetId: 12,
        preferredPosition: 'CAM',
        possiblePositions: ['CAM'],
        marketAverage: 900,
        discardValue: 900,
      }),
    ]);

    const pool = buildPool(records, { groupSize: 1 });

    expect(pool.map((record) => record.id)).toEqual([1, 2]);
  });

  it('keeps a record that is the only candidate for an alternative slot', () => {
    const cheapCamOnly = [1, 2, 3, 4, 5].map((id) =>
      raw({
        id,
        assetId: 100 + id,
        preferredPosition: 'CAM',
        possiblePositions: ['CAM'],
        marketAverage: id * 100,
        discardValue: id * 100,
      })
    );
    const versatile = raw({
      id: 6,
      assetId: 106,
      preferredPosition: 'CAM',
      possiblePositions: ['CAM', 'ST'],
      marketAverage: 6000,
      discardValue: 6000,
    });
    const records = normaliseClub([...cheapCamOnly, versatile]);

    const pool = buildPool(records, { groupSize: 5 });

    expect(pool).toHaveLength(6);
    expect(pool).toContainEqual(records[5]);
    expect(pool.map((record) => record.id)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('counts a card once per group even when a position name repeats', () => {
    const records = normaliseClub([
      raw({
        id: 1,
        assetId: 11,
        possiblePositions: ['ST', 'ST'],
        marketAverage: 100,
        discardValue: 100,
      }),
      raw({
        id: 2,
        assetId: 12,
        possiblePositions: ['ST'],
        marketAverage: 900,
        discardValue: 900,
      }),
    ]);

    const pool = buildPool(records, { groupSize: 2 });

    expect(pool.map((record) => record.id)).toEqual([1, 2]);
  });

  it('falls back to preferredPosition when the possiblePositions key is absent', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, preferredPosition: 'CAM', marketAverage: 100, discardValue: 100 }),
      raw({
        id: 2,
        assetId: 12,
        preferredPosition: 'CAM',
        possiblePositions: ['CAM'],
        marketAverage: 900,
        discardValue: 900,
      }),
    ]).map((record, index) => (index === 0 ? without(record, 'possiblePositions') : record));

    const pool = buildPool(records, { groupSize: 1 });

    expect(pool.map((record) => record.id)).toEqual([1]);
  });

  it('falls back to preferredPosition when possiblePositions is an empty list', () => {
    const records = normaliseClub([
      raw({
        id: 1,
        assetId: 11,
        preferredPosition: 'CAM',
        possiblePositions: [],
        marketAverage: 100,
        discardValue: 100,
      }),
      raw({
        id: 2,
        assetId: 12,
        preferredPosition: 'CAM',
        possiblePositions: ['CAM'],
        marketAverage: 900,
        discardValue: 900,
      }),
    ]);

    const pool = buildPool(records, { groupSize: 1 });

    expect(pool.map((record) => record.id)).toEqual([1]);
  });

  it('keeps an absent-list fallback record when it is the only candidate in its group', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, preferredPosition: 'CAM', marketAverage: 900, discardValue: 900 }),
      ...stRivals(),
    ]).map((record, index) => (index === 0 ? without(record, 'possiblePositions') : record));

    const pool = buildPool(records, { groupSize: 5 });

    expect(pool.map((record) => record.id)).toEqual([1, 101, 102, 103, 104, 105]);
    expect(pool).toContainEqual(records[0]);
  });

  it('keeps an empty-list fallback record when it is the only candidate in its group', () => {
    const records = normaliseClub([
      raw({
        id: 1,
        assetId: 11,
        preferredPosition: 'CAM',
        possiblePositions: [],
        marketAverage: 900,
        discardValue: 900,
      }),
      ...stRivals(),
    ]);

    const pool = buildPool(records, { groupSize: 5 });

    expect(pool.map((record) => record.id)).toEqual([1, 101, 102, 103, 104, 105]);
    expect(pool).toContainEqual(records[0]);
  });

  it('rejects a possiblePositions value that is not an array', () => {
    const records = normaliseClub([raw({})]).map((record) => ({
      ...record,
      possiblePositions: 'ST',
    }));

    expect(() => buildPool(records)).toThrow(/possiblePositions/);
  });

  it.each([
    ['a non-string entry', ['ST', 42]],
    ['an empty string entry', ['ST', '']],
    ['a sparse list', ['ST', , 'CAM']],
    ['an all-holes list', new Array(2)],
  ])('rejects %s in a direct possiblePositions list', (_label, possiblePositions) => {
    const [record] = normaliseClub([raw({})]);

    expect(() => buildPool([{ ...record, possiblePositions }])).toThrow(/possiblePositions/);
  });

  it.each([
    ['a string', 'ST'],
    ['a sparse list', ['ST', , 'CAM']],
    ['a non-string entry', ['ST', 42]],
  ])(
    'rejects %s possiblePositions even when the record is out of scope',
    (_label, possiblePositions) => {
      const [record] = normaliseClub([raw({ untradeable: true })]);

      expect(() =>
        buildPool([{ ...record, possiblePositions }], { scope: 'tradeable' })
      ).toThrow(/buildPool: records\[0\]\.possiblePositions/);
    }
  );

  it('honours the scope option for untradeable, tradeable and both', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, untradeable: true }),
      raw({ id: 2, assetId: 12, untradeable: false }),
      raw({ id: 3, assetId: 13, untradeable: true }),
    ]);

    const ids = (pool) => pool.map((record) => record.id);

    expect(ids(buildPool(records, { scope: 'untradeable' }))).toEqual([1, 3]);
    expect(ids(buildPool(records, { scope: 'tradeable' }))).toEqual([2]);
    expect(ids(buildPool(records, { scope: 'both' }))).toEqual([1, 2, 3]);
    expect(ids(buildPool(records))).toEqual([1, 2, 3]);
  });

  it('prefers marketAverage over discardValue', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, marketAverage: 900, discardValue: 100 }),
      raw({ id: 2, assetId: 12, marketAverage: 500, discardValue: 900 }),
    ]);

    const pool = buildPool(records, { groupSize: 1 });

    expect(pool.map((record) => record.id)).toEqual([2]);
  });

  it('falls back to discardValue when marketAverage is absent', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, marketAverage: null, marketDataMinPrice: null, marketDataMaxPrice: null, discardValue: 500 }),
      raw({ id: 2, assetId: 12, marketAverage: 600, discardValue: 900 }),
    ]);

    const pool = buildPool(records, { groupSize: 1 });

    expect(pool.map((record) => record.id)).toEqual([1]);
  });

  it('sorts an unknown price after a known price instead of treating it as free', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, marketAverage: null, discardValue: null }),
      raw({ id: 2, assetId: 12, marketAverage: 1000, discardValue: 1000 }),
    ]);

    const pool = buildPool(records, { groupSize: 1 });

    expect(pool.map((record) => record.id)).toEqual([2]);
  });

  it('lets a caller inject the price lookup', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, marketAverage: 100, discardValue: 100 }),
      raw({ id: 2, assetId: 12, marketAverage: 900, discardValue: 900 }),
    ]);

    const pool = buildPool(records, {
      groupSize: 1,
      priceLookup: (record) => (record.assetId === 12 ? 1 : 5000),
    });

    expect(pool.map((record) => record.id)).toEqual([2]);
  });

  it('trims by state-aware weighted contribution, not by raw market value', () => {
    const pool = buildPool(weightedRivals(), { groupSize: 1 });

    expect(pool.map((record) => record.id)).toEqual([3]);
  });

  it('ranks merged records by their resolved external price, not their raw EA market value', () => {
    const records = mergePrices(
      normaliseClub([
        raw({ id: 1, assetId: 11, untradeable: true, marketAverage: 100, discardValue: 100 }),
        raw({ id: 2, assetId: 12, untradeable: true, marketAverage: 9000, discardValue: 9000 }),
      ]),
      { 11: 9000, 12: 100 }
    );

    const pool = buildPool(records, { groupSize: 1 });

    expect(pool.map((record) => record.id)).toEqual([2]);
  });

  it('lets options.weights decide which weighted card survives', () => {
    const pool = buildPool(weightedRivals(), {
      groupSize: 1,
      weights: { untradeableDuplicate: 1 },
    });

    expect(pool.map((record) => record.id)).toEqual([1]);
  });

  it('lets options.weights change the winner among merged records with external prices', () => {
    const records = mergePrices(
      normaliseClub([
        raw({ id: 1, assetId: 11, untradeable: true, marketAverage: 100, discardValue: 100 }),
        raw({ id: 2, assetId: 11, untradeable: true, marketAverage: 100, discardValue: 100 }),
        raw({ id: 3, assetId: 12, untradeable: false, marketAverage: 9000, discardValue: 9000 }),
      ]),
      { 11: 1000, 12: 300 }
    );

    // Record 2 is the untradeable duplicate: 0.20 * 1000 = 200 beats the
    // tradeable card's 1.00 * 300 = 300. Raising the duplicate weight flips it.
    // Both the external prices and the weights must be used: a raw-price
    // fallback would keep record 2 (0.20 * 100 against 9000) either way.
    const defaults = buildPool(records, { groupSize: 1 });
    const overridden = buildPool(records, {
      groupSize: 1,
      weights: { untradeableDuplicate: 1 },
    });

    expect(defaults.map((record) => record.id)).toEqual([2]);
    expect(overridden.map((record) => record.id)).toEqual([3]);
  });

  it.each(['cardState', 'price', 'priceSource'])(
    'treats an own, undefined %s as a merged record instead of falling back to raw prices',
    (field) => {
      const [record] = normaliseClub([
        raw({ marketAverage: 100, discardValue: 100 }),
      ]);
      const halfMerged = { ...record, [field]: undefined };

      expect(Object.hasOwn(halfMerged, field)).toBe(true);
      expect(() => buildPool([halfMerged], { groupSize: 1 })).toThrow(/prices:/);
    }
  );

  it('ranks a merged unknown price last without throwing, even after JSON transport', () => {
    const unpriced = {
      marketAverage: null,
      marketDataMinPrice: null,
      marketDataMaxPrice: null,
      discardValue: null,
    };
    const rawItems = [
      raw({ id: 1, assetId: 11, ...unpriced }),
      raw({ id: 2, assetId: 12, ...unpriced }),
    ];
    const records = JSON.parse(
      JSON.stringify(mergePrices(normaliseClub(rawItems), { 12: 9000 }))
    );

    // Without the merged metadata both raw prices are unknown, so the earlier
    // record would win; only the merged external price can rank record 2 first.
    expect(buildPool(normaliseClub(rawItems), { groupSize: 1 }).map((record) => record.id)).toEqual(
      [1]
    );
    expect(records[0].price).toBeNull();
    expect(records[1].price).toBe(9000);
    expect(buildPool(records, { groupSize: 1 }).map((record) => record.id)).toEqual([2]);
  });

  it('rejects an unmerged tradeable record with no duplicate flag instead of guessing', () => {
    const records = normaliseClub([raw({ untradeable: false })]).map((record) => {
      const copy = { ...record };
      delete copy.duplicate;
      return copy;
    });

    expect(() => buildPool(records)).toThrow(/duplicate/);
  });

  it('preserves input order and is deterministic for the same input', () => {
    const records = pricedClub();

    const first = buildPool(records, { groupSize: 3 });
    const second = buildPool(records, { groupSize: 3 });
    const third = buildPool(pricedClub(), { groupSize: 3 });

    expect(first.map((record) => record.id)).toEqual([3, 4, 5]);
    expect(second.map((record) => record.id)).toEqual(first.map((record) => record.id));
    expect(third.map((record) => record.id)).toEqual(first.map((record) => record.id));
  });

  it('breaks a price tie in favour of the earlier input record', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, marketAverage: 500, discardValue: 500 }),
      raw({ id: 2, assetId: 12, marketAverage: 500, discardValue: 500 }),
    ]);

    const pool = buildPool(records, { groupSize: 1 });

    expect(pool.map((record) => record.id)).toEqual([1]);
  });

  it('does not mutate the input records', () => {
    const records = normaliseClub([
      raw({ id: 1, assetId: 11, marketAverage: 100, discardValue: 100 }),
      raw({ id: 2, assetId: 12, marketAverage: 900, discardValue: 900 }),
    ]);
    const frozen = records.map((record) =>
      Object.freeze({ ...record, possiblePositions: Object.freeze([...record.possiblePositions]) })
    );
    Object.freeze(frozen);
    const snapshot = JSON.stringify(frozen);

    expect(() => buildPool(frozen, { groupSize: 1 })).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });

  it.each([
    ['scope', { scope: 'cheapest' }, /scope/],
    ['groupSize', { groupSize: 0 }, /groupSize/],
    ['groupSize', { groupSize: 2.5 }, /groupSize/],
    ['ratingBandWidth', { ratingBandWidth: 0 }, /ratingBandWidth/],
    ['priceLookup', { priceLookup: 'cheap' }, /priceLookup/],
    ['weights', { weights: new Map([['tradeable', 5]]) }, /weights/],
  ])('rejects an invalid %s option', (_label, options, message) => {
    expect(() => buildPool(pricedClub(), options)).toThrow(message);
  });

  it('rejects a price lookup that returns something other than null or a finite number', () => {
    expect(() => buildPool(pricedClub(), { priceLookup: () => Number.NaN })).toThrow(
      /priceLookup/
    );
    expect(() => buildPool(pricedClub(), { priceLookup: () => -1 })).toThrow(/priceLookup/);
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
  ];

  const sourceOf = (relativePath) =>
    readFileSync(new URL(relativePath, import.meta.url), 'utf8');

  it('names no raw payload field anywhere in src/solver/candidates.js', () => {
    const source = sourceOf('../src/solver/candidates.js');

    for (const name of RAW_ONLY_NAMES) {
      expect(source).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('never maps assetId from a raw source name in src/solver/candidates.js', () => {
    const source = sourceOf('../src/solver/candidates.js');

    expect(source).not.toMatch(/\bassetId\s*:/);
    expect(source).not.toMatch(/\b(?:raw|item|payload|source)[A-Za-z]*\.assetId\b/);
  });

  it('names no raw payload field anywhere in src/solver/validate.js', () => {
    const source = sourceOf('../src/solver/validate.js');

    for (const name of RAW_ONLY_NAMES) {
      expect(source).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
