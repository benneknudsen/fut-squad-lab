import { describe, expect, it, vi } from 'vitest';

import club from './fixtures/club-items.json';
import {
  CLUB_ITEM_STRATEGIES,
  CLUB_SEARCH_PAGE_CAP,
  CLUB_SEARCH_PAGE_SIZE,
  resolveClubItems,
} from '../src/ea/adapter.js';
import { readClubItems } from '../src/ea/club-reader.js';
import { createTestPacer } from './helpers/pacing.js';

const testPacer = createTestPacer();

// Issue #51: the club read is a paged `services.Club.search(criteria)` call
// whose result is an observable. These tests build fake EA observables — they
// fire once, synchronously, and expose `unobserve` — and assert the criteria
// shape, the page walk and the fallbacks with their reasons. Issue #70: the
// fake observable takes the subscriber first and the callback second, as EA's
// own observable does.

const observableOf = (data, state = { unsubscribed: 0 }) => ({
  observe(subscriber, callback) {
    const observer = {
      unobserve() {
        state.unsubscribed += 1;
      },
    };
    callback(observer, { data, error: null, response: null, status: 200, success: true });
    return observer;
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
  // What EA actually saw at call time: the criteria object is handed over live
  // and restored after the walk (#70), so a post-read inspection would show the
  // restored values, not the ones the page was called with.
  const snapshots = [];
  const search = (criteria) => {
    calls.push(criteria);
    snapshots.push({ ...criteria });
    const page = pages[calls.length - 1] ?? [];
    return observableOf({ itemData: page });
  };
  return { calls, snapshots, search };
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
    const { snapshots, search } = pagedSearch([[{ id: 1 }], []]);
    const pageWindow = { UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } }, services: { Club: { search } } };

    const result = await resolveClubItems(pageWindow, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.Club.search+searchCriteria');
    expect(result.pages).toBe(2);
    expect(result.capped).toBe(false);
    expect(snapshots[0].count).toBe(CLUB_SEARCH_PAGE_SIZE);
    expect(snapshots[0].offset).toBe(0);
    expect(snapshots[0].ownedOnly).toBe(true);
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
    const result = await resolveClubItems(
      {
        UTBucketedItemSearchViewModel,
        services: { Club: { search } },
      },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(constructed).toEqual(['constructed']);
    expect(calls[0].fromPrototypeFree).toBe(true);
  });

  it('hands the view model criteria object itself to EA and restores it after the walk', async () => {
    const criteria = { ownedOnly: true, count: 5, offset: 7, untradeables: 'true' };
    const { calls, search } = pagedSearch([[{ id: 1 }], []]);
    await resolveClubItems({ UTBucketedItemSearchViewModel: { searchCriteria: criteria }, services: { Club: { search } } }, { pacer: testPacer });

    expect(calls[0]).toBe(criteria);
    expect(calls[1]).toBe(criteria);
    expect(criteria).toEqual({ ownedOnly: true, count: 5, offset: 7, untradeables: 'true' });
  });

  it('pages until the result stops yielding items and sums every page', async () => {
    const { snapshots, search } = pagedSearch([[{ id: 1 }, { id: 2 }], [{ id: 3 }], []]);

    const result = await resolveClubItems({ UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } }, services: { Club: { search } } }, { pacer: testPacer });

    expect(result.items.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(result.pages).toBe(3);
    expect(snapshots.map((criteria) => criteria.offset)).toEqual([0, 2, 3]);
    expect(snapshots.every((criteria) => criteria.count === CLUB_SEARCH_PAGE_SIZE)).toBe(true);
  });

  it('stops at the page cap and reports the cap instead of looping forever', async () => {
    const { calls, search } = pagedSearch(Array.from({ length: 1000 }, (_, index) => [{ id: index }]));

    const result = await resolveClubItems({ UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } }, services: { Club: { search } } }, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(result.pages).toBe(CLUB_SEARCH_PAGE_CAP);
    expect(calls).toHaveLength(CLUB_SEARCH_PAGE_CAP);
    expect(result.capped).toBe(true);
    expect(result.capReason).toMatch(new RegExp(`cap of ${CLUB_SEARCH_PAGE_CAP}`));
    expect(result.items).toHaveLength(CLUB_SEARCH_PAGE_CAP);
  });

  it('times out a subscription that never fires instead of hanging', async () => {
    const result = await resolveClubItems(
      { UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } }, services: { Club: { search: () => neverFires() } } },
      { observableTimeoutMs: 20, pacer: testPacer }
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

    const result = await resolveClubItems({ UTBucketedItemSearchViewModel: viewModel, services: { Club: { search } } }, { pacer: testPacer });

    expect(getter).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
    expect(result.criteria.ok).toBe(false);
    expect(result.attempts[0].reason).toMatch(/accessor|criteria/i);
  });

  it('names the missing view model when no search criteria can be read', async () => {
    const search = vi.fn();

    const result = await resolveClubItems({ services: { Club: { search } } }, { pacer: testPacer });

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
    const { snapshots, search } = pagedSearch([[{ id: 7 }], []]);

    const result = await resolveClubItems(
      {
        UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } },
        services: { Club: { clubDao: {} }, Item: { searchStorageItems: search } },
      },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.Item.searchStorageItems+searchCriteria');
    expect(snapshots[0].count).toBe(CLUB_SEARCH_PAGE_SIZE);
    expect(snapshots[0].ownedOnly).toBe(true);
    expect(result.criteria.ok).toBe(true);
  });

  it('feeds the real fixture items through the existing normaliser', async () => {
    const { search } = pagedSearch([club.itemData, []]);

    const result = await resolveClubItems({ UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } }, services: { Club: { search } } }, { pacer: testPacer });
    const records = readClubItems(result.items);

    expect(result.ok).toBe(true);
    expect(records).toHaveLength(club.itemData.length);
    expect(records[0]).toMatchObject({ id: 116927068448054, preferredPosition: 'CAM', duplicate: false });
  });

  it('reports a page that is not an item payload and tries the next candidate', async () => {
    const good = pagedSearch([[{ id: 4 }], []]);
    const pageWindow = {
      UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } },
      services: {
        Club: { search: () => observableOf({ pagination: { total: 1 } }) },
        Item: { searchStorageItems: good.search },
      },
    };

    const result = await resolveClubItems(pageWindow, { pacer: testPacer });

    expect(result.strategy).toBe('services.Item.searchStorageItems+searchCriteria');
    expect(result.attempts[0].reason).toMatch(/itemData/);
  });

  it('keeps the recorded attempts in chain order with {id, ok, reason}', async () => {
    const result = await resolveClubItems({ services: {} }, { pacer: testPacer });

    expect(result.attempts.map((attempt) => attempt.id)).toEqual(
      CLUB_ITEM_STRATEGIES.map((strategy) => strategy.id)
    );
    for (const attempt of result.attempts) {
      expect(Object.keys(attempt).sort()).toEqual(['id', 'ok', 'reason']);
    }
  });
});

// Issue #61: the criteria handed to EA must be reported by shape before they
// are used, preferred from a live instance, and refused when they are
// half-built. An EA-side throw must be labelled as one, distinct from a missing
// method. Names and types only: a criteria object can carry account-scoped
// fields, so no value may appear anywhere in the report.
describe('the criteria report (#61)', () => {
  it('reports the criteria shape by key name and type, never a value, and names the producing strategy', async () => {
    const { search } = pagedSearch([[{ id: 1 }], []]);
    const result = await resolveClubItems(
      {
        UTBucketedItemSearchViewModel: {
          searchCriteria: {
            ownedOnly: true,
            label: 'do-not-log-me',
            missing: undefined,
            nothing: null,
            empty: '',
          },
        },
        services: { Club: { search } },
      },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.criteria.strategy).toBe('UTBucketedItemSearchViewModel.searchCriteria');
    expect(result.criteria.source).toBe('instance');
    expect(result.criteria.shape.keys).toEqual([
      { name: 'ownedOnly', type: 'boolean' },
      { name: 'label', type: 'string', empty: false },
      { name: 'missing', type: 'undefined' },
      { name: 'nothing', type: 'null' },
      { name: 'empty', type: 'string', empty: true },
    ]);
    expect(result.criteria.shape.undefinedKeys).toEqual(['missing']);
    expect(result.criteria.shape.nullKeys).toEqual(['nothing']);
    expect(result.criteria.shape.emptyStringKeys).toEqual(['empty']);
    expect(result.criteria.shape.prototype).toBe(false);
    expect(result.criteria.attempts[0].constructed).toBe(false);
    expect(JSON.stringify(result.criteria)).not.toContain('do-not-log-me');
  });

  it('prefers a populated instance criteria over a prototype default and reports which was used', async () => {
    function UTBucketedItemSearchViewModel() {
      this.searchCriteria = { fromInstance: true };
    }
    UTBucketedItemSearchViewModel.prototype.searchCriteria = { fromPrototype: true };
    const { calls, search } = pagedSearch([[{ id: 1 }], []]);

    const result = await resolveClubItems(
      { UTBucketedItemSearchViewModel, services: { Club: { search } } },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.criteria.ok).toBe(true);
    expect(result.criteria.strategy).toBe('UTBucketedItemSearchViewModel.searchCriteria');
    expect(result.criteria.source).toBe('instance');
    expect(result.criteria.shape.own).toBe(true);
    expect(result.criteria.attempts[0].constructed).toBe(true);
    expect(calls[0].fromInstance).toBe(true);
    expect(calls[0].fromPrototype).toBeUndefined();
  });

  it('refuses to call EA with half-built criteria and reports why', async () => {
    const search = vi.fn();

    const result = await resolveClubItems(
      { UTBucketedItemSearchViewModel: { searchCriteria: {} }, services: { Club: { search } } },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(false);
    expect(search).not.toHaveBeenCalled();
    expect(result.criteria.ok).toBe(false);
    expect(result.criteria.strategy).toBeNull();
    const [instanceAttempt, prototypeAttempt] = result.criteria.attempts;
    expect(instanceAttempt.reason).toMatch(/not usable/i);
    expect(instanceAttempt.shape.usable).toBe(false);
    expect(prototypeAttempt.reason.length).toBeGreaterThan(0);
  });

  it('refuses criteria whose values are all undefined, from an instance or a prototype', async () => {
    function UTBucketedItemSearchViewModel() {}
    UTBucketedItemSearchViewModel.prototype.searchCriteria = {
      type: undefined,
      filters: undefined,
    };
    const search = vi.fn();

    const result = await resolveClubItems(
      { UTBucketedItemSearchViewModel, services: { Club: { search } } },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(false);
    expect(search).not.toHaveBeenCalled();
    const [instanceAttempt, prototypeAttempt] = result.criteria.attempts;
    expect(instanceAttempt.reason).toMatch(/not usable/i);
    expect(instanceAttempt.shape.own).toBe(false);
    expect(instanceAttempt.shape.undefinedKeys).toEqual(['type', 'filters']);
    expect(prototypeAttempt.reason).toMatch(/not usable/i);
    expect(prototypeAttempt.shape.prototype).toBe(true);
  });

  it('labels an EA-side throw as EA refusing our criteria, never as a missing method', async () => {
    const search = vi.fn(() => {
      throw new Error("Cannot read properties of undefined (reading 'toLowerCase')");
    });

    const result = await resolveClubItems(
      {
        UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } },
        services: { Club: { search } },
      },
      { pacer: testPacer }
    );
    const attempt = result.attempts.find(
      (entry) => entry.id === 'services.Club.search+searchCriteria'
    );

    expect(attempt.reason).toMatch(/EA threw while calling this method with our criteria/);
    expect(attempt.reason).toContain('UTBucketedItemSearchViewModel.searchCriteria');
    expect(attempt.reason).toMatch(/toLowerCase/);
    expect(attempt.reason).not.toMatch(/has no .* method/);
  });

  it('reports whether a timed-out observable looked real and what it was called with', async () => {
    const result = await resolveClubItems(
      {
        UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } },
        services: { Club: { search: () => ({ observe: () => ({}) }) } },
      },
      { observableTimeoutMs: 20, pacer: testPacer }
    );
    const reason = result.attempts[0].reason;

    expect(reason).toMatch(/timed out/);
    expect(reason).toMatch(/observe=function/);
    expect(reason).toMatch(/unobserve=absent/);
    expect(reason).toMatch(/count=100/);
    expect(reason).toMatch(/offset=0/);
    expect(reason).toMatch(/ownedOnly/);
  });

  it('redacts a criteria key name that matches the paste-safety list but keeps its type', async () => {
    const result = await resolveClubItems(
      {
        UTBucketedItemSearchViewModel: { searchCriteria: { marketAverage: 987654 } },
        services: { Club: { search: () => observableOf({ itemData: [] }) } },
      },
      { pacer: testPacer }
    );

    const report = JSON.stringify(result.criteria);
    expect(report).toContain('<redacted>');
    expect(report).not.toContain('987654');
    expect(result.criteria.shape.keys).toEqual([{ name: '<redacted>', type: 'number' }]);
  });
});

// Issue #65: the criteria handed to EA must carry `untradeables` as a STRING
// and the named page size, and the club DAO's stats cache is reset when the
// page provides it. The string type is the deliberate part: EA lower-cases the
// value, so a boolean would silently look right to a careless test.
describe('the criteria initialisation (#65)', () => {
  const searchWindow = (search, club = {}) => ({
    UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } },
    services: { Club: { search, ...club } },
  });

  it('sets untradeables as a string, never a boolean', async () => {
    const { snapshots, search } = pagedSearch([[{ id: 1 }], []]);

    const result = await resolveClubItems(searchWindow(search), { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(typeof snapshots[0].untradeables).toBe('string');
    expect(snapshots[0].untradeables).toBe('false');
  });

  it('sets the untradeables-only path to "true" and the other path to "false"', async () => {
    const onlyUntradeables = pagedSearch([[{ id: 1 }], []]);
    await resolveClubItems(searchWindow(onlyUntradeables.search), {
      pacer: testPacer,
      onlyUntradeables: true,
    });
    expect(onlyUntradeables.snapshots[0].untradeables).toBe('true');
    expect(typeof onlyUntradeables.snapshots[0].untradeables).toBe('string');

    const notOnly = pagedSearch([[{ id: 1 }], []]);
    await resolveClubItems(searchWindow(notOnly.search), {
      pacer: testPacer,
      onlyUntradeables: false,
    });
    expect(notOnly.snapshots[0].untradeables).toBe('false');
    expect(notOnly.snapshots[0].untradeables).not.toBe(false);
  });

  it('sets count to the named page-size constant on every page', async () => {
    const { snapshots, search } = pagedSearch([[{ id: 1 }, { id: 2 }], [{ id: 3 }], []]);

    await resolveClubItems(searchWindow(search), { pacer: testPacer });

    expect(snapshots.every((criteria) => criteria.count === CLUB_SEARCH_PAGE_SIZE)).toBe(true);
  });

  it('resets the club stats cache when present and treats its absence as normal', async () => {
    const resetStatsCache = vi.fn();
    const withCache = pagedSearch([[{ id: 1 }], []]);

    const reset = await resolveClubItems(searchWindow(withCache.search, { clubDao: { resetStatsCache } }), {
      pacer: testPacer,
    });

    expect(reset.ok).toBe(true);
    expect(resetStatsCache).toHaveBeenCalledTimes(1);
    expect(reset.criteria.statsCache).toBe('reset');

    const withoutCache = pagedSearch([[{ id: 1 }], []]);
    const absent = await resolveClubItems(searchWindow(withoutCache.search), { pacer: testPacer });

    expect(absent.ok).toBe(true);
    expect(absent.criteria.statsCache).toBe('absent');
  });

  it('does not lose the read when resetStatsCache throws', async () => {
    const { search } = pagedSearch([[{ id: 1 }], []]);
    const resetStatsCache = vi.fn(() => {
      throw new Error('cache exploded');
    });

    const result = await resolveClubItems(searchWindow(search, { clubDao: { resetStatsCache } }), {
      pacer: testPacer,
    });

    expect(result.ok).toBe(true);
    expect(result.criteria.statsCache).toMatch(/threw/);
  });

  it('names the criteria fields it set in the summary and in a failed page reason', async () => {
    const { search } = pagedSearch([[{ id: 1 }], []]);
    const read = await resolveClubItems(searchWindow(search), { pacer: testPacer });

    expect(read.criteria.setFields).toEqual([
      { name: 'untradeables', type: 'string' },
      { name: 'count', type: 'number' },
      { name: 'offset', type: 'number' },
    ]);

    const timedOut = await resolveClubItems(searchWindow(() => neverFires()), {
      observableTimeoutMs: 20,
      pacer: testPacer,
    });
    expect(timedOut.attempts[0].reason).toContain('untradeables');
  });

  it('never hands the criteria to EA, or reports set fields, when they cannot be read', async () => {
    const search = vi.fn();

    const result = await resolveClubItems({ services: { Club: { search } } }, { pacer: testPacer });

    expect(search).not.toHaveBeenCalled();
    expect(result.criteria.ok).toBe(false);
    expect(Object.hasOwn(result.criteria, 'setFields')).toBe(false);
  });
});

// Issue #70: EA's search reads the public criteria fields off the object it is
// handed, and those fields live on the criteria' prototype. A spread copy keeps
// only the own backing fields, so EA threw reading `.toLowerCase()` off
// `undefined`. The fix hands EA the criteria object itself and restores the
// fields this project set when the object belongs to the live page.
describe('the criteria object handed to EA (#70)', () => {
  it('keeps a prototype field readable on the object EA receives', async () => {
    const criteria = Object.create({ type: 'player' });
    criteria.ownedOnly = true;
    const seen = [];
    const search = (received) => {
      seen.push(received.type.toLowerCase());
      return observableOf({ itemData: [] });
    };

    const result = await resolveClubItems(
      { UTBucketedItemSearchViewModel: { searchCriteria: criteria }, services: { Club: { search } } },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(seen).toEqual(['player']);
    expect(Object.hasOwn(criteria, 'type')).toBe(false);
  });

  it('creates its own view model criteria when the global is a class', async () => {
    let ownCriteria = null;
    function UTBucketedItemSearchViewModel() {
      ownCriteria = { ownedOnly: true };
      this.searchCriteria = ownCriteria;
    }
    const { calls, search } = pagedSearch([[{ id: 1 }], []]);

    const result = await resolveClubItems(
      { UTBucketedItemSearchViewModel, services: { Club: { search } } },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.criteria.owned).toBe(true);
    expect(calls[0]).toBe(ownCriteria);
  });

  it('reports whether the criteria came from an object we created or from the live page', async () => {
    const live = await resolveClubItems(windowWithCriteria(), { pacer: testPacer });
    expect(live.criteria.source).toBe('instance');
    expect(live.criteria.owned).toBe(false);

    function UTBucketedItemSearchViewModel() {
      this.searchCriteria = { ownedOnly: true };
    }
    const own = await resolveClubItems(
      {
        UTBucketedItemSearchViewModel,
        services: { Club: { search: () => observableOf({ itemData: [] }) } },
      },
      { pacer: testPacer }
    );
    expect(own.criteria.source).toBe('instance');
    expect(own.criteria.owned).toBe(true);
  });

  it('restores the fields it set on live criteria after a successful walk', async () => {
    const criteria = { ownedOnly: true, count: 5, offset: 7, untradeables: 'true' };
    const { search } = pagedSearch([[{ id: 1 }], []]);

    await resolveClubItems(
      { UTBucketedItemSearchViewModel: { searchCriteria: criteria }, services: { Club: { search } } },
      { pacer: testPacer }
    );

    expect(criteria).toEqual({ ownedOnly: true, count: 5, offset: 7, untradeables: 'true' });
  });

  it('restores live criteria after a failed page and after a timeout', async () => {
    const failing = { ownedOnly: true };
    await resolveClubItems(
      {
        UTBucketedItemSearchViewModel: { searchCriteria: failing },
        services: {
          Club: {
            search: () => {
              throw new Error('EA refused the search');
            },
          },
        },
      },
      { pacer: testPacer }
    );
    expect(failing).toEqual({ ownedOnly: true });

    const timingOut = { ownedOnly: true };
    await resolveClubItems(
      {
        UTBucketedItemSearchViewModel: { searchCriteria: timingOut },
        services: { Club: { search: () => neverFires() } },
      },
      { observableTimeoutMs: 20, pacer: testPacer }
    );
    expect(timingOut).toEqual({ ownedOnly: true });
  });

  it('restores an accessor-backed live criteria through its backing fields', async () => {
    const criteria = Object.create({
      get count() {
        return this._count;
      },
      set count(value) {
        this._count = value;
      },
      get offset() {
        return this._offset;
      },
      set offset(value) {
        this._offset = value;
      },
      get untradeables() {
        return this._untradeables;
      },
      set untradeables(value) {
        this._untradeables = value;
      },
    });
    criteria.ownedOnly = true;
    criteria._count = 5;
    criteria._offset = 7;
    criteria._untradeables = 'true';
    const seen = [];
    const search = (received) => {
      seen.push({
        count: received.count,
        offset: received.offset,
        untradeables: received.untradeables,
      });
      return observableOf({ itemData: seen.length === 1 ? [{ id: 1 }] : [] });
    };

    const result = await resolveClubItems(
      { UTBucketedItemSearchViewModel: { searchCriteria: criteria }, services: { Club: { search } } },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(seen[0]).toEqual({
      count: CLUB_SEARCH_PAGE_SIZE,
      offset: 0,
      untradeables: 'false',
    });
    expect(Object.hasOwn(criteria, 'count')).toBe(false);
    expect(criteria._count).toBe(5);
    expect(criteria._offset).toBe(7);
    expect(criteria._untradeables).toBe('true');
  });

  it('does not restore criteria it created itself', async () => {
    let ownCriteria = null;
    function UTBucketedItemSearchViewModel() {
      ownCriteria = { ownedOnly: true };
      this.searchCriteria = ownCriteria;
    }
    const { search } = pagedSearch([[{ id: 1 }], []]);

    await resolveClubItems(
      { UTBucketedItemSearchViewModel, services: { Club: { search } } },
      { pacer: testPacer }
    );

    expect(ownCriteria.count).toBe(CLUB_SEARCH_PAGE_SIZE);
    expect(ownCriteria.offset).toBe(1);
  });
});
