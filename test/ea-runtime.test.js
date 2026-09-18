import { describe, expect, it } from 'vitest';

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

// The order is the contract: the repository instance in the service locator is
// the most likely home of a club read, the service instance next, then the
// locator and the globals themselves.
const EXPECTED_CLUB_STRATEGY_ORDER = [
  'services.UTSBCRepository.getClubItems',
  'services.UTSBCRepository.getClub',
  'services.UTSBCRepository.getClubPlayers',
  'services.UTSBCRepository.searchClub',
  'services.UTSBCService.getClubItems',
  'services.UTSBCService.getClub',
  'services.UTSBCService.getClubPlayers',
  'services.UTSBCService.searchClub',
  'services.getClubItems',
  'services.getClub',
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
        UTSBCRepository: { getClubItems: () => ({ itemData: items }) },
      },
    };
    const result = await resolveClubItems(pageWindow);
    expect(result.ok).toBe(true);
    expect(result.items).toBe(items);
    expect(result.strategy).toBe('services.UTSBCRepository.getClubItems');
    expect(result.attempts).toEqual([
      { id: 'services.UTSBCRepository.getClubItems', ok: true, reason: null },
    ]);
  });

  it('accepts a bare item array and a promise result', async () => {
    const items = [{ id: 7 }];
    const pageWindow = {
      services: {
        UTSBCRepository: { getClubItems: async () => items },
      },
    };
    const result = await resolveClubItems(pageWindow);
    expect(result.items).toBe(items);
  });

  it('skips a candidate whose method is missing and records why, then uses the next', async () => {
    const items = [{ id: 2 }];
    const pageWindow = {
      services: {
        UTSBCRepository: { getClub: () => ({ itemData: items }) },
      },
    };
    const result = await resolveClubItems(pageWindow);
    expect(result.strategy).toBe('services.UTSBCRepository.getClub');
    expect(result.attempts[0]).toEqual({
      id: 'services.UTSBCRepository.getClubItems',
      ok: false,
      reason: 'UTSBCRepository has no getClubItems method',
    });
    expect(result.attempts[1].ok).toBe(true);
  });

  it('records a thrown method and tries the next candidate', async () => {
    const items = [{ id: 3 }];
    const pageWindow = {
      services: {
        UTSBCRepository: {
          getClubItems: () => {
            throw new Error('needs a search payload');
          },
          getClub: () => ({ itemData: items }),
        },
      },
    };
    const result = await resolveClubItems(pageWindow);
    expect(result.strategy).toBe('services.UTSBCRepository.getClub');
    expect(result.attempts[0].reason).toBe('threw: needs a search payload');
  });

  it('rejects a wrong-shaped result and records the shape, then tries the next', async () => {
    const items = [{ id: 4 }];
    const pageWindow = {
      services: {
        UTSBCRepository: {
          getClubItems: () => ({ pagination: {} }),
          getClub: () => ({ itemData: items }),
        },
      },
    };
    const result = await resolveClubItems(pageWindow);
    expect(result.strategy).toBe('services.UTSBCRepository.getClub');
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
    expect(result.attempts[0].reason).toContain('services');
  });

  it('names the missing locator when the page exposes no services object', async () => {
    const result = await resolveClubItems({});
    expect(result.attempts[0].reason).toContain('services');
    expect(result.attempts[0].reason).not.toMatch(/undefined has no/);
  });

  it('names the missing constructor when the locator lacks the class instance', async () => {
    const result = await resolveClubItems({ services: {} });
    expect(result.attempts[0].reason).toContain('UTSBCRepository');
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
