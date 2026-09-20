import { describe, expect, it, vi } from 'vitest';

import {
  CHALLENGE_FIELDS,
  CHALLENGE_SUBJECT_STRATEGIES,
  CLUB_ITEM_STRATEGIES,
  EA_ENDPOINTS,
  EA_GLOBALS,
  EA_PANEL_HOOK,
  isClubPayload,
  requireEaGlobal,
  resolveChallengeSubject,
  resolveClubItems,
  resolveEaGlobal,
  resolveEaGlobals,
} from '../src/ea/adapter.js';

// The adapter is imported by the pure solver, so these tests run in Node where
// `window` does not exist. Every runtime read takes an explicit `pageWindow`
// argument; nothing may touch a module-level `window`.

const fn = () => {};

describe('EA naming tables', () => {
  it('freezes every volatile EA string table', () => {
    for (const table of [EA_GLOBALS, EA_ENDPOINTS, CHALLENGE_FIELDS]) {
      expect(Object.isFrozen(table)).toBe(true);
    }
    expect(Object.isFrozen(EA_PANEL_HOOK)).toBe(true);
    expect(Object.isFrozen(CLUB_ITEM_STRATEGIES)).toBe(true);
    for (const strategy of CLUB_ITEM_STRATEGIES) {
      expect(Object.isFrozen(strategy)).toBe(true);
    }
    expect(Object.isFrozen(CHALLENGE_SUBJECT_STRATEGIES)).toBe(true);
  });

  it('names the documented panel hook entry point', () => {
    expect(EA_PANEL_HOOK.entry).toBe('initWithSBCSet');
  });

  it('names the verified panel and service globals from docs/PLAN.md section 1.1', () => {
    expect(EA_GLOBALS.squadDetailPanel).toBe('UTSBCSquadDetailPanelViewController');
    expect(EA_GLOBALS.sbcService).toBe('UTSBCService');
    expect(EA_GLOBALS.sbcRepository).toBe('UTSBCRepository');
    expect(EA_GLOBALS.eligibilityKeys).toBe('SBCEligibilityKey');
    expect(EA_GLOBALS.services).toBe('services');
  });

  it('carries the verified endpoint paths from docs/PLAN.md section 1.2', () => {
    expect(EA_ENDPOINTS.club).toBe('/club');
    expect(EA_ENDPOINTS.sets).toBe('/sbs/sets');
    expect(EA_ENDPOINTS.setChallenges).toBe('/sbs/setId/{setId}/challenges');
    expect(EA_ENDPOINTS.challengeSquad).toBe('/sbs/challenge/{challengeId}');
  });

  it('names the raw challenge payload fields', () => {
    expect(CHALLENGE_FIELDS.requirements).toBe('elgReq');
    expect(CHALLENGE_FIELDS.operation).toBe('elgOperation');
    expect(CHALLENGE_FIELDS.challengeId).toBe('challengeId');
  });
});

describe('resolveEaGlobal', () => {
  it('returns the value when the page window carries the named global', () => {
    const pageWindow = { UTSBCService: fn, services: {} };
    expect(resolveEaGlobal(pageWindow, 'sbcService')).toBe(fn);
  });

  it('returns null when the global is absent instead of throwing', () => {
    expect(resolveEaGlobal({}, 'sbcService')).toBeNull();
    expect(resolveEaGlobal(undefined, 'sbcService')).toBeNull();
  });

  it('rejects a key outside the frozen naming table', () => {
    expect(() => resolveEaGlobal({}, 'notAnEaGlobal')).toThrow(/notAnEaGlobal/);
  });
});

describe('requireEaGlobal', () => {
  it('returns the value when present', () => {
    const pageWindow = { UTSBCSquadDetailPanelViewController: fn };
    expect(requireEaGlobal(pageWindow, 'squadDetailPanel')).toBe(fn);
  });

  it('throws an Error naming the missing EA symbol, never a bare TypeError', () => {
    let caught;
    try {
      requireEaGlobal({ UTSBCService: fn }, 'squadDetailPanel');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).toContain('UTSBCSquadDetailPanelViewController');
  });

  it('names the missing symbol when there is no page window at all', () => {
    expect(() => requireEaGlobal(undefined, 'squadDetailPanel')).toThrow(
      /UTSBCSquadDetailPanelViewController/
    );
  });
});

describe('resolveEaGlobals', () => {
  it('reports which globals resolved and which are missing by EA name', () => {
    const pageWindow = { UTSBCService: fn, SBCEligibilityKey: {} };
    const report = resolveEaGlobals(pageWindow, ['sbcService', 'eligibilityKeys', 'squadDetailPanel']);
    expect(report.resolved.sbcService).toBe(fn);
    expect(report.resolved.eligibilityKeys).toEqual({});
    expect(report.missing).toEqual(['UTSBCSquadDetailPanelViewController']);
  });
});

describe('isClubPayload', () => {
  it('accepts an itemData envelope and a bare item array', () => {
    expect(isClubPayload({ itemData: [] })).toBe(true);
    expect(isClubPayload([])).toBe(true);
  });

  it('rejects an envelope whose itemData is not an array', () => {
    expect(isClubPayload({ itemData: {} })).toBe(false);
    expect(isClubPayload({ items: [] })).toBe(false);
    expect(isClubPayload(null)).toBe(false);
    expect(isClubPayload('club')).toBe(false);
  });
});

// The order is the contract, most-specific first: the instance paths the #44
// live shape report proved (`services.<Domain>` containers and their DAOs), the
// repository/service search names the report proved, the legacy
// `services.UTSBCRepository` entry kept for page builds that still expose it,
// then the window classes, which are constructors and are refused as instances.
const EXPECTED_CLUB_STRATEGY_ORDER = [
  'services.Club.clubDao.getClubItems',
  'services.Club.clubDao.getClubItems+{}',
  'services.Club.clubDao.search',
  'services.Club.clubRepository.search',
  'services.Club.clubService.search',
  'services.Item.itemDao.getClubItems',
  'services.Item.itemDao.search',
  'services.SBC.itemRepository.getClubItems',
  'services.SBC.itemRepository.search',
  'services.SBC.repository.getClubItems',
  'services.SBC.repository.search',
  'services.SBC.sbcDAO.getClubItems',
  'services.SBC.sbcDAO.search',
  'services.Item.marketRepository.getClubItems',
  'services.Item.marketRepository.search',
  'services.UTSBCRepository.getClubItems',
  'window.UTSBCRepository.getClubItems',
  'window.UTSBCRepository.getClub',
  'window.UTSBCService.getClubItems',
  'window.UTSBCService.getClub',
];

describe('CLUB_ITEM_STRATEGIES', () => {
  it('lists every candidate in the documented order, each with a unique id', () => {
    expect(CLUB_ITEM_STRATEGIES.map((strategy) => strategy.id)).toEqual(
      EXPECTED_CLUB_STRATEGY_ORDER
    );
    expect(new Set(EXPECTED_CLUB_STRATEGY_ORDER).size).toBe(EXPECTED_CLUB_STRATEGY_ORDER.length);
  });
});

describe('resolveClubItems', () => {
  it('uses the first candidate and reports its id when it returns an itemData envelope', async () => {
    const items = [{ id: 1 }];
    const pageWindow = {
      services: {
        Club: { clubDao: { getClubItems: () => ({ itemData: items }) } },
      },
    };
    const result = await resolveClubItems(pageWindow);
    expect(result.ok).toBe(true);
    expect(result.items).toBe(items);
    expect(result.strategy).toBe('services.Club.clubDao.getClubItems');
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({
      id: 'services.Club.clubDao.getClubItems',
      ok: true,
      reason: null,
    });
    expect(result.attempts[0].method.arity).toBe(0);
  });

  it('tries getClubItems with no arguments, then with an empty object and nothing else', async () => {
    const items = [{ id: 5 }];
    const received = [];
    const pageWindow = {
      services: {
        Club: {
          clubDao: {
            getClubItems(...args) {
              received.push(args);
              if (args.length === 0) throw new Error('requires a query object');
              return { itemData: items };
            },
          },
        },
      },
    };

    const result = await resolveClubItems(pageWindow);

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.Club.clubDao.getClubItems+{}');
    expect(received).toHaveLength(2);
    expect(received[0]).toEqual([]);
    expect(received[1]).toHaveLength(1);
    expect(received[1][0]).toEqual({});
    expect(Object.keys(received[1][0])).toEqual([]);
    expect(result.attempts.map((attempt) => attempt.id)).toEqual([
      'services.Club.clubDao.getClubItems',
      'services.Club.clubDao.getClubItems+{}',
    ]);
  });

  it('gives each getClubItems call shape its own attempt id and reason', async () => {
    const pageWindow = {
      services: {
        Club: {
          clubDao: {
            getClubItems(...args) {
              throw new Error(args.length === 0 ? 'no argument' : 'argument rejected');
            },
          },
        },
      },
    };

    const result = await resolveClubItems(pageWindow);
    const [zeroArgument, emptyObject] = result.attempts;

    expect(result.ok).toBe(false);
    expect(zeroArgument.id).toBe('services.Club.clubDao.getClubItems');
    expect(emptyObject.id).toBe('services.Club.clubDao.getClubItems+{}');
    expect(zeroArgument.id).not.toBe(emptyObject.id);
    expect(zeroArgument.reason).toBe('threw: no argument');
    expect(emptyObject.reason).toBe('threw: argument rejected');
  });

  it('reports the arity and source signature of a method it resolved but could not use', async () => {
    const pageWindow = {
      services: {
        Club: {
          clubDao: {
            getClubItems(count, offset) {
              throw new Error('not supported');
            },
          },
        },
      },
    };

    const result = await resolveClubItems(pageWindow);

    expect(result.attempts[0].ok).toBe(false);
    expect(result.attempts[0].reason).toBe('threw: not supported');
    expect(result.attempts[0].method.arity).toBe(2);
    expect(result.attempts[0].method.constructor).toBe('Function');
    expect(result.attempts[0].method.excerpt).toContain('getClubItems');
  });

  it('refuses an accessor method without invoking the getter', async () => {
    const getterSpy = vi.fn(() => () => ({ itemData: [] }));
    const clubDao = {};
    Object.defineProperty(clubDao, 'getClubItems', { get: getterSpy });

    const result = await resolveClubItems({ services: { Club: { clubDao } } });

    expect(getterSpy).not.toHaveBeenCalled();
    expect(result.attempts[0].reason).toMatch(/accessor/);
  });

  it('accepts a bare item array and a promise result from clubDao', async () => {
    const items = [{ id: 7 }];
    const pageWindow = {
      services: {
        Club: { clubDao: { getClubItems: async () => items } },
      },
    };
    const result = await resolveClubItems(pageWindow);
    expect(result.items).toBe(items);
  });

  it('skips a candidate whose method is missing and records why, then uses the next', async () => {
    const items = [{ id: 2 }];
    const pageWindow = {
      services: {
        Club: { clubDao: { search: () => ({ itemData: items }) } },
      },
    };
    const result = await resolveClubItems(pageWindow);
    expect(result.strategy).toBe('services.Club.clubDao.search');
    expect(result.attempts[0]).toEqual({
      id: 'services.Club.clubDao.getClubItems',
      ok: false,
      reason: 'Club.clubDao has no getClubItems method',
    });
    expect(result.attempts[1]).toEqual({
      id: 'services.Club.clubDao.getClubItems+{}',
      ok: false,
      reason: 'Club.clubDao has no getClubItems method',
    });
    expect(result.attempts[2].ok).toBe(true);
  });

  it('records a thrown method and tries the next candidate', async () => {
    const items = [{ id: 3 }];
    const pageWindow = {
      services: {
        Club: {
          clubDao: {
            getClubItems: () => {
              throw new Error('needs a search payload');
            },
            search: () => ({ itemData: items }),
          },
        },
      },
    };
    const result = await resolveClubItems(pageWindow);
    expect(result.strategy).toBe('services.Club.clubDao.search');
    expect(result.attempts[0].reason).toBe('threw: needs a search payload');
  });

  it('rejects a wrong-shaped result and records the shape, then tries the next', async () => {
    const items = [{ id: 4 }];
    const pageWindow = {
      services: {
        Club: {
          clubDao: {
            getClubItems: () => ({ pagination: {} }),
            search: () => ({ itemData: items }),
          },
        },
      },
    };
    const result = await resolveClubItems(pageWindow);
    expect(result.strategy).toBe('services.Club.clubDao.search');
    expect(result.attempts[0].reason).toMatch(/itemData/);
  });

  it('reports every candidate in order with a reason when none succeed, and never guesses a size', async () => {
    const pageWindow = { services: {} };
    const result = await resolveClubItems(pageWindow);
    expect(result.ok).toBe(false);
    expect(result.strategy).toBeNull();
    expect(result.items).toEqual([]);
    expect(result.attempts.map((attempt) => attempt.id)).toEqual(EXPECTED_CLUB_STRATEGY_ORDER);
    for (const attempt of result.attempts) {
      expect(attempt.ok).toBe(false);
      expect(typeof attempt.reason).toBe('string');
      expect(attempt.reason.length).toBeGreaterThan(0);
    }
    expect(result.attempts[0].reason).toContain('Club');
  });

  it('names the missing locator when the page exposes no services object', async () => {
    const result = await resolveClubItems({});
    expect(result.attempts[0].reason).toContain('services');
    expect(result.attempts[0].reason).not.toMatch(/undefined has no/);
  });

  it('names the missing nested path when the locator lacks the domain', async () => {
    const result = await resolveClubItems({ services: {} });
    expect(result.attempts[0].reason).toContain('Club');
    expect(result.attempts[0].reason).not.toMatch(/undefined/);
  });

  it('refuses a window class as a constructor and never calls its prototype method', async () => {
    const prototypeGet = vi.fn(() => ({ itemData: [{ id: 9 }] }));
    function UTSBCRepository() {}
    UTSBCRepository.prototype.getClubItems = prototypeGet;
    const result = await resolveClubItems({ services: {}, UTSBCRepository });
    const attempt = result.attempts.find(
      (entry) => entry.id === 'window.UTSBCRepository.getClubItems'
    );
    expect(attempt.reason).toMatch(/constructor, not an instance/);
    expect(prototypeGet).not.toHaveBeenCalled();
  });

  it('accepts a page window with no argument at all without throwing', async () => {
    const result = await resolveClubItems(undefined);
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(CLUB_ITEM_STRATEGIES.length);
  });
});

describe('resolveChallengeSubject', () => {
  const challenge = { challengeId: 25, name: '3 Leagues & 2 Nations', elgReq: [] };

  it('reads the challenge out of the panel argument data property first', () => {
    const result = resolveChallengeSubject({ data: challenge });
    expect(result.ok).toBe(true);
    expect(result.payload).toBe(challenge);
    expect(result.strategy).toBe('panel-argument.data');
    expect(result.attempts).toEqual([{ id: 'panel-argument.data', ok: true, reason: null }]);
  });

  it('accepts a challenge-shaped panel argument directly', () => {
    const result = resolveChallengeSubject(challenge);
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('panel-argument');
  });

  it('reads a nested challenge property', () => {
    const result = resolveChallengeSubject({ challenge });
    expect(result.ok).toBe(true);
    expect(result.payload).toBe(challenge);
    expect(result.strategy).toBe('panel-argument.challenge');
  });

  it('reports every candidate and a reason when the argument carries no elgReq array', () => {
    const result = resolveChallengeSubject({ data: { squad: {} }, something: 1 });
    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.attempts.map((attempt) => attempt.id)).toEqual(
      CHALLENGE_SUBJECT_STRATEGIES.map((strategy) => strategy.id)
    );
    for (const attempt of result.attempts) {
      expect(typeof attempt.reason).toBe('string');
      expect(attempt.reason.length).toBeGreaterThan(0);
    }
  });

  it('reports every candidate for a non-object argument', () => {
    const result = resolveChallengeSubject(null);
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(CHALLENGE_SUBJECT_STRATEGIES.length);
  });
});
