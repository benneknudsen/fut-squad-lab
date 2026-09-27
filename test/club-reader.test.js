import { describe, expect, it } from 'vitest';

import club from './fixtures/club-items.json';
import { normaliseClubItem } from '../src/ea/adapter.js';
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
  it('reads the items envelope and maps every item to the stable record shape', () => {
    const records = readClubItems(club);
    expect(club.items).toHaveLength(42);
    expect(records).toHaveLength(42);
    expect(records[0]).toEqual(EXPECTED_FIRST_RECORD);
    for (const record of records) {
      expect(Object.keys(record).sort()).toEqual(DOCUMENTED_RECORD_FIELDS);
    }
  });

  it('accepts a bare item array as well as the envelope', () => {
    const records = readClubItems(club.items);
    expect(records).toHaveLength(42);
    expect(records[0]).toEqual(EXPECTED_FIRST_RECORD);
  });

  it('feeds buildPool without any further translation', () => {
    const pool = buildPool(readClubItems(club));
    expect(pool.length).toBeGreaterThan(0);
    expect(pool.length).toBeLessThanOrEqual(club.items.length);
  });

  it('flags the second copy of an assetId as a duplicate', () => {
    const [first] = club.items;
    const records = readClubItems({ items: [first, { ...first, id: 999 }] });
    expect(records.map((record) => record.duplicate)).toEqual([false, true]);
  });

  it('emits plain serialisable data and does not mutate the payload', () => {
    const snapshot = JSON.stringify(club);
    const records = readClubItems(club);
    expect(JSON.parse(JSON.stringify(records))).toEqual(records);
    expect(JSON.stringify(club)).toBe(snapshot);
  });

  it('names the items field when the response is neither envelope nor array', () => {
    expect(() => readClubItems({ rows: [] })).toThrow(/items/);
    expect(() => readClubItems({ items: {} })).toThrow(/items/);
    expect(() => readClubItems(null)).toThrow(/items/);
  });

  it('propagates the adapter validation naming the offending raw field', () => {
    const { rating, ...withoutRating } = club.items[0];
    expect(() => readClubItems({ items: [withoutRating] })).toThrow(/rating/);
  });
});

// Issue #74: the fsl-build/10 live run threw from normaliseClubItem with only
// "raw item must carry a finite assetId" — no key names, no page, no index — so
// the next report could not say what EA actually sent. These tests pin the
// item-shape report and the club-walk location report.
describe('the club item shape report (#74)', () => {
  const SENTINEL_ID = 900900900;

  it('names the rejected field and the key names the item carries, never a value', () => {
    const { assetId, ...item } = { ...club.items[0], id: SENTINEL_ID };

    let message = null;
    try {
      normaliseClubItem(item);
    } catch (error) {
      message = error.message;
    }

    expect(message).toMatch(/assetId/);
    expect(message).toMatch(/keys \[/);
    expect(message).toContain('id');
    expect(message).toContain('rating');
    expect(message).not.toContain(String(SENTINEL_ID));
    expect(message).not.toContain(String(club.items[0].marketAverage));
    expect(message).not.toContain(String(club.items[0].id));
  });

  it('reports sensitive key names through the shared redaction list and never their values', () => {
    const { assetId, ...item } = {
      ...club.items[0],
      marketAverage: 987654321,
      discardValue: 123456789,
      lastSalePrice: 111222333,
    };

    let message = null;
    try {
      normaliseClubItem(item);
    } catch (error) {
      message = error.message;
    }

    expect(message).toContain('<redacted>');
    expect(message).not.toContain('987654321');
    expect(message).not.toContain('123456789');
    expect(message).not.toContain('111222333');
  });

  it('locates the offending item in its page when the caller reports the page sizes', () => {
    const { assetId, ...withoutAssetId } = club.items[0];

    let caught = null;
    try {
      readClubItems({ items: [club.items[1], withoutAssetId] }, { pageItems: [1, 1] });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    expect(caught.clubRead).toMatchObject({
      field: 'items',
      index: 1,
      pageIndex: 2,
      pageItems: 1,
      itemIndexInPage: 0,
    });
    expect(caught.clubRead.keys).toContain('id');
    expect(caught.message).toMatch(/assetId/);
    expect(caught.message).toMatch(/page 2/);
    expect(caught.message).toContain('array field items');
  });
});
