import { describe, expect, it, vi } from 'vitest';

import club from './fixtures/club-items.json';
import {
  CLUB_ITEM_STRATEGIES,
  CLUB_SEARCH_PAGE_CAP,
  CLUB_SEARCH_PAGE_SIZE,
  resolveClubItems,
} from '../src/ea/adapter.js';
import { readClubItems } from '../src/ea/club-reader.js';

// Issue #51: the club read is a paged `services.Club.search(criteria)` call
// whose result is an observable. These tests build fake EA observables — they
// fire once, synchronously, and expose `unobserve` — and assert the criteria
// shape, the page walk and the fallbacks with their reasons.

const observableOf = (data, state = { unsubscribed: 0 }) => ({
  observe(callback) {
    callback({ data, error: null, response: null, status: 200, success: true });
    return {
      unobserve() {
        state.unsubscribed += 1;
      },
    };
  },
  state,
});

const neverFires = () => ({
  observe() {
    return { unobserve() {} };
  },
});

const pagedSearch = (pages) => {
  const calls = [];
  const search = (criteria) => {
    calls.push(criteria);
    const page = pages[calls.length - 1] ?? [];
    return observableOf({ itemData: page });
  };
  return { calls, search };
};

const windowWithCriteria = (extra = {}) => ({
  UTBucketedItemSearchViewModel: { searchCriteria: { filters: { owned: true } } },
  services: { Club: { search: () => observableOf({ itemData: [] }) }, ...extra },
});

describe('CLUB_ITEM_STRATEGIES search entry', () => {
  it('starts with the search path and keeps every previous path after it', () => {
    expect(CLUB_ITEM_STRATEGIES[0].id).toBe('services.Club.search+searchCriteria');
    expect(CLUB_ITEM_STRATEGIES.some((s) => s.id === 'services.Club.clubDao.getClubItems')).toBe(
      true
    );
    expect(CLUB_ITEM_STRATEGIES.some((s) => s.id === 'window.UTSBCService.getClub')).toBe(true);
  });
});

describe('resolveClubItems search path', () => {
  it('builds the search criteria from the EA view model and calls the subscription', async () => {
    const { calls, search } = pagedSearch([[{ id: 1 }], []]);
    const pageWindow = { UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } }, services: { Club: { search } } };

    const result = await resolveClubItems(pageWindow);

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.Club.search+searchCriteria');
    expect(result.pages).toBe(2);
    expect(result.capped).toBe(false);
    expect(calls[0].count).toBe(CLUB_SEARCH_PAGE_SIZE);
    expect(calls[0].offset).toBe(0);
    expect(calls[0].ownedOnly).toBe(true);
    expect(result.attempts[0].method.arity).toBe(1);
    expect(result.criteria).toMatchObject({ ok: true, strategy: expect.stringContaining('UTBucketedItemSearchViewModel') });
  });

  it('constructs the view model with no arguments when the global is a class', async () => {
    const constructed = [];
    function UTBucketedItemSearchViewModel() {
      constructed.push('constructed');
      this.searchCriteria = { fromPrototypeFree: true };
    }
    const { calls, search } = pagedSearch([[{ id: 1 }], []]);
    const result = await resolveClubItems({
      UTBucketedItemSearchViewModel,
      services: { Club: { search } },
    });

    expect(result.ok).toBe(true);
    expect(constructed).toEqual(['constructed']);
    expect(calls[0].fromPrototypeFree).toBe(true);
  });

  it('does not mutate the view model search criteria it copies', async () => {
    const criteria = { ownedOnly: true };
    const { calls, search } = pagedSearch([[{ id: 1 }], []]);
    await resolveClubItems({ UTBucketedItemSearchViewModel: { searchCriteria: criteria }, services: { Club: { search } } });

    expect(Object.hasOwn(criteria, 'count')).toBe(false);
    expect(Object.hasOwn(criteria, 'offset')).toBe(false);
    expect(calls[0]).not.toBe(criteria);
  });

  it('pages until the result stops yielding items and sums every page', async () => {
    const { calls, search } = pagedSearch([[{ id: 1 }, { id: 2 }], [{ id: 3 }], []]);

    const result = await resolveClubItems({ UTBucketedItemSearchViewModel: { searchCriteria: {} }, services: { Club: { search } } });

    expect(result.items.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(result.pages).toBe(3);
    expect(calls.map((criteria) => criteria.offset)).toEqual([0, 2, 3]);
    expect(calls.every((criteria) => criteria.count === CLUB_SEARCH_PAGE_SIZE)).toBe(true);
  });

  it('stops at the page cap and reports the cap instead of looping forever', async () => {
    const { calls, search } = pagedSearch(Array.from({ length: 1000 }, (_, index) => [{ id: index }]));

    const result = await resolveClubItems({ UTBucketedItemSearchViewModel: { searchCriteria: {} }, services: { Club: { search } } });

    expect(result.ok).toBe(true);
    expect(result.pages).toBe(CLUB_SEARCH_PAGE_CAP);
    expect(calls).toHaveLength(CLUB_SEARCH_PAGE_CAP);
    expect(result.capped).toBe(true);
    expect(result.capReason).toMatch(new RegExp(`cap of ${CLUB_SEARCH_PAGE_CAP}`));
    expect(result.items).toHaveLength(CLUB_SEARCH_PAGE_CAP);
  });

  it('times out a subscription that never fires instead of hanging', async () => {
    const result = await resolveClubItems(
      { UTBucketedItemSearchViewModel: { searchCriteria: {} }, services: { Club: { search: () => neverFires() } } },
      { observableTimeoutMs: 20 }
    );

    expect(result.ok).toBe(false);
    expect(result.items).toEqual([]);
    expect(result.attempts[0].reason).toMatch(/timed out/);
  });

  it('reports a criteria property that is an accessor without invoking it', async () => {
    const getter = vi.fn(() => ({ filters: {} }));
    const viewModel = {};
    Object.defineProperty(viewModel, 'searchCriteria', { get: getter });
    const search = vi.fn();

    const result = await resolveClubItems({ UTBucketedItemSearchViewModel: viewModel, services: { Club: { search } } });

    expect(getter).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(result.criteria.ok).toBe(false);
    expect(result.attempts[0].reason).toMatch(/accessor|criteria/i);
  });

  it('names the missing view model when no search criteria can be read', async () => {
    const search = vi.fn();

    const result = await resolveClubItems({ services: { Club: { search } } });

    expect(result.ok).toBe(false);
    expect(search).not.toHaveBeenCalled();
    expect(result.criteria.ok).toBe(false);
    const reasons = result.criteria.attempts.map((attempt) => attempt.reason).join('; ');
    expect(reasons).toContain('UTBucketedItemSearchViewModel');
    expect(result.attempts).toHaveLength(CLUB_ITEM_STRATEGIES.length);
    for (const attempt of result.attempts) {
      expect(attempt.ok).toBe(false);
      expect(attempt.reason.length).toBeGreaterThan(0);
    }
  });

  it('falls through to services.Item.searchStorageItems with the same criteria', async () => {
    const { calls, search } = pagedSearch([[{ id: 7 }], []]);

    const result = await resolveClubItems({
      UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } },
      services: { Club: { clubDao: {} }, Item: { searchStorageItems: search } },
    });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.Item.searchStorageItems+searchCriteria');
    expect(calls[0].count).toBe(CLUB_SEARCH_PAGE_SIZE);
    expect(calls[0].ownedOnly).toBe(true);
    expect(result.criteria.ok).toBe(true);
  });

  it('feeds the real fixture items through the existing normaliser', async () => {
    const { search } = pagedSearch([club.itemData, []]);

    const result = await resolveClubItems({ UTBucketedItemSearchViewModel: { searchCriteria: {} }, services: { Club: { search } } });
    const records = readClubItems(result.items);

    expect(result.ok).toBe(true);
    expect(records).toHaveLength(club.itemData.length);
    expect(records[0]).toMatchObject({ id: 116927068448054, preferredPosition: 'CAM', duplicate: false });
  });

  it('reports a page that is not an item payload and tries the next candidate', async () => {
    const good = pagedSearch([[{ id: 4 }], []]);
    const pageWindow = {
      UTBucketedItemSearchViewModel: { searchCriteria: {} },
      services: {
        Club: { search: () => observableOf({ pagination: { total: 1 } }) },
        Item: { searchStorageItems: good.search },
      },
    };

    const result = await resolveClubItems(pageWindow);

    expect(result.strategy).toBe('services.Item.searchStorageItems+searchCriteria');
    expect(result.attempts[0].reason).toMatch(/itemData/);
  });

  it('keeps the recorded attempts in chain order with {id, ok, reason}', async () => {
    const result = await resolveClubItems({ services: {} });

    expect(result.attempts.map((attempt) => attempt.id)).toEqual(
      CLUB_ITEM_STRATEGIES.map((strategy) => strategy.id)
    );
    for (const attempt of result.attempts) {
      expect(Object.keys(attempt).sort()).toEqual(['id', 'ok', 'reason']);
    }
  });
});
