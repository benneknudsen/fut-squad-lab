import { describe, expect, it } from 'vitest';

import club from './fixtures/club-items.json';
import { readClubItems } from '../src/ea/club-reader.js';
import { buildPool } from '../src/solver/candidates.js';

// The expected record is constructed from the adapter's documented mapping of
// the raw `/club` fields (docs/PLAN.md section 1.4 and the normaliseClubItem
// contract), not by re-running the adapter, so a mapping change fails here.
const EXPECTED_FIRST_RECORD = {
  id: 116927068448054,
  assetId: 277846,
  rating: 84,
  nationId: 52,
  leagueId: 31,
  clubId: 1745,
  rarity: 0,
  cardSubtype: 2,
  playStyles: 250,
  preferredPosition: 'CAM',
  possiblePositions: ['CAM', 'ST'],
  rolePlus: [31, 32, 43],
  rolePlusPlus: [],
  untradeable: false,
  pile: 7,
  owners: 1,
  collected: true,
  marketAverage: 1100,
  marketMin: 600,
  marketMax: 10000,
  discardValue: 596,
  duplicate: false,
};

const DOCUMENTED_RECORD_FIELDS = Object.keys(EXPECTED_FIRST_RECORD).sort();

describe('readClubItems', () => {
  it('reads the itemData envelope and maps every item to the stable record shape', () => {
    const records = readClubItems(club);
    expect(club.itemData).toHaveLength(42);
    expect(records).toHaveLength(42);
    expect(records[0]).toEqual(EXPECTED_FIRST_RECORD);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(DOCUMENTED_RECORD_FIELDS);
    }
  });

  it('accepts a bare item array as well as the envelope', () => {
    const records = readClubItems(club.itemData);
    expect(records).toHaveLength(42);
    expect(records[0]).toEqual(EXPECTED_FIRST_RECORD);
  });

  it('feeds buildPool without any further translation', () => {
    const pool = buildPool(readClubItems(club));
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.length).toBeLessThanOrEqual(club.itemData.length);
  });

  it('flags the second copy of an assetId as a duplicate', () => {
    const [first] = club.itemData;
    const records = readClubItems({ itemData: [first, { ...first, id: 999 }] });
    expect(records.map((record) => record.duplicate)).toEqual([false, true]);
  });

  it('emits plain serialisable data and does not mutate the payload', () => {
    const snapshot = JSON.stringify(club);
    const records = readClubItems(club);
    expect(JSON.parse(JSON.stringify(records))).toEqual(records);
    expect(JSON.stringify(club)).toBe(snapshot);
  });

  it('names the itemData field when the response is neither envelope nor array', () => {
    expect(() => readClubItems({ rows: [] })).toThrow(/itemData/);
    expect(() => readClubItems({ itemData: {} })).toThrow(/itemData/);
    expect(() => readClubItems(null)).toThrow(/itemData/);
  });

  it('propagates the adapter validation naming the offending raw field', () => {
    const { rating, ...withoutRating } = club.itemData[0];
    expect(() => readClubItems({ itemData: [withoutRating] })).toThrow(/rating/);
  });
});
