import { describe, expect, it } from 'vitest';

import { CLUB_SEARCH_PAGE_SIZE, resolveClubItems } from '../src/ea/adapter.js';
import { readClubItems } from '../src/ea/club-reader.js';
import { buildReadSummary } from '../src/ea/summary.js';
import { createTestPacer } from './helpers/pacing.js';

const testPacer = createTestPacer();

// Issue #72: the fsl-build/9 live run returned `{ items, retrievedAll }` from
// `services.Club.search` and `{ items, endOfList }` from
// `services.Item.searchStorageItems`. The reader looked for `itemData` and read
// zero items from both. These tests pin the live field name, the end-of-list
// rule and the offset rule the reference confirmed: the offset advances by the
// requested page size, never by the number of items a page happened to return.

const observableOf = (payload) => ({
  observe(subscriber, callback) {
    callback({ unobserve() {} }, { data: null, error: null, response: payload, status: 200 });
    return { unobserve() {} };
  },
});

const pagedSearch = (pages) => {
  const calls = [];
  const snapshots = [];
  const search = (criteria) => {
    calls.push(criteria);
    snapshots.push({ ...criteria });
    return observableOf(pages[calls.length - 1] ?? { items: [] });
  };
  return { calls, snapshots, search };
};

const windowWithSearch = (search) => ({
  UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } },
  services: { Club: { search } },
});

describe('the live club payload field is items (#72)', () => {
  it('reads a page shaped { items, retrievedAll: true } as items and reports the field', async () => {
    const { search } = pagedSearch([{ items: [{ id: 1 }], retrievedAll: true }]);

    const result = await resolveClubItems(windowWithSearch(search), { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(result.items).toEqual([{ id: 1 }]);
    expect(result.field).toBe('items');
    expect(result.pages).toBe(1);
  });

  it('reads a page shaped { items, endOfList: true } as items and stops the walk', async () => {
    const { calls, search } = pagedSearch([
      { items: [{ id: 1 }], endOfList: true },
      { items: [{ id: 2 }], endOfList: true },
    ]);

    const result = await resolveClubItems(windowWithSearch(search), { pacer: testPacer });

    expect(result.items).toEqual([{ id: 1 }]);
    expect(result.pages).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('reads items through readClubItems from the live envelope and rejects itemData by name', () => {
    expect(readClubItems({ items: [] })).toEqual([]);
    expect(() => readClubItems({ itemData: [] })).toThrow(/items/);
    expect(() => readClubItems({ itemData: [] })).toThrow(/itemData/);
  });

  it('names the payload field and its own keys when it carries no items array', async () => {
    const { search } = pagedSearch([{ itemData: [{ id: 1 }], retrievedAll: true }]);

    const result = await resolveClubItems(windowWithSearch(search), { pacer: testPacer });

    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.attempts[0].reason).toMatch(/no items array/);
    expect(result.attempts[0].reason).not.toMatch(/no itemData array/);
    expect(result.attempts[0].reason).toContain('itemData');
  });
});

describe('the club end-of-list rule (#72)', () => {
  it('continues while retrievedAll is false and advances the offset by the page size', async () => {
    const { snapshots, search } = pagedSearch([
      { items: [{ id: 1 }, { id: 2 }], retrievedAll: false },
      { items: [{ id: 3 }], retrievedAll: false },
      { items: [], retrievedAll: true },
    ]);

    const result = await resolveClubItems(windowWithSearch(search), { pacer: testPacer });

    expect(result.items.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(result.pages).toBe(3);
    expect(snapshots.map((criteria) => criteria.offset)).toEqual([
      0,
      CLUB_SEARCH_PAGE_SIZE,
      2 * CLUB_SEARCH_PAGE_SIZE,
    ]);
  });

  it('lets endOfList win over retrievedAll and keeps walking when it is false', async () => {
    const { calls, search } = pagedSearch([
      { items: [{ id: 1 }], endOfList: false, retrievedAll: true },
      { items: [{ id: 2 }], endOfList: true, retrievedAll: false },
      { items: [{ id: 3 }], endOfList: true },
    ]);

    const result = await resolveClubItems(windowWithSearch(search), { pacer: testPacer });

    expect(result.items.map((item) => item.id)).toEqual([1, 2]);
    expect(calls).toHaveLength(2);
  });

  it('stops when a page returns no items even without an end-of-list flag', async () => {
    const { calls, search } = pagedSearch([{ items: [] }, { items: [{ id: 9 }] }]);

    const result = await resolveClubItems(windowWithSearch(search), { pacer: testPacer });

    expect(result.items).toEqual([]);
    expect(result.pages).toBe(1);
    expect(result.capped).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('the club payload field in the diagnostic (#72)', () => {
  it('names the field that was read and the item count in the read summary', () => {
    const summary = buildReadSummary({
      challenge: null,
      clubResult: {
        ok: true,
        items: [{ id: 1 }, { id: 2 }],
        strategy: 'services.Club.search+searchCriteria',
        field: 'items',
      },
    });

    expect(summary).toContain('2 club items');
    expect(summary).toContain('field items');
  });

  it('never prints an undefined field when the read result carries none', () => {
    const summary = buildReadSummary({
      challenge: null,
      clubResult: { ok: true, items: [], strategy: 'stub-strategy' },
    });

    expect(summary).not.toContain('undefined');
    expect(summary).not.toMatch(/field /);
  });

  it('lets the live envelope report the field the page actually carried', async () => {
    const { search } = pagedSearch([{ items: [{ id: 1 }], endOfList: true }]);

    const result = await resolveClubItems(windowWithSearch(search), { pacer: testPacer });

    expect(result.field).toBe('items');
    expect(result.endOfList).toBe(true);
  });
});
