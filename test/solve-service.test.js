import { describe, expect, it, vi } from 'vitest';

import { createSolveService } from '../src/ea/solve-service.js';
import { SQUAD_WRITE_STRATEGIES } from '../src/ea/adapter.js';

const challenge = {
  challengeId: 25,
  name: '3 Leagues & 2 Nations',
  formation: 'f343',
  elgOperation: 'AND',
  elgReq: [{ type: 'COUNT', eligibilitySlot: 0, eligibilityKey: 8, eligibilityValue: 3 }],
};

const solution = {
  squad: { players: Array.from({ length: 11 }, (_, index) => ({ id: 1000 + index })) },
  cost: 4200,
  costComplete: true,
  costCoverage: { known: 11, unknown: 0, complete: true, unknownCards: [] },
  valid: true,
  failures: [],
  unverified: [{ slot: 3, reason: 'no chemistry link data' }],
};

const challengeSquad = {
  challengeId: 25,
  squad: { id: 1, players: Array.from({ length: 11 }, (_, index) => ({ index })) },
};

const writeReport = {
  ok: true,
  strategy: 'services.UTSquadBuildingChallengeDAO.saveChallenge',
  attempts: [
    { id: 'services.UTSquadBuildingChallengeDAO.saveChallenge', ok: true, reason: null },
  ],
};

const createSteps = (overrides = {}) => {
  const calls = [];
  const keys = Object.freeze({ 8: Object.freeze({ type: 'COUNT' }) });
  const steps = {
    calls,
    readEligibilityKeys: vi.fn(() => {
      calls.push('eligibility');
      return { keys, scopes: null, members: [], unmodelled: [] };
    }),
    resolveChallengeSubject: vi.fn((subject) => {
      calls.push('subject');
      return { ok: true, payload: subject, strategy: 'panel-argument', attempts: [] };
    }),
    // The load stage runs between the subject and the challenge read; the
    // default mirrors production by falling back to the subject payload when
    // it resolved and failing when it did not.
    loadChallenge: vi.fn(async (pageWindow, subjectResult) =>
      subjectResult.ok === true
        ? { ok: true, payload: subjectResult.payload, strategy: 'subject.payload', attempts: [] }
        : { ok: false, payload: null, strategy: null, attempts: [] }
    ),
    readChallenge: vi.fn(() => {
      calls.push('challenge');
      return challenge;
    }),
    resolveClubItems: vi.fn(async () => {
      calls.push('club');
      return {
        ok: true,
        items: [{ id: 1000 }, { id: 1001 }],
        strategy: 'services.UTSBCRepository.getClubItems',
        attempts: [],
      };
    }),
    readClubItems: vi.fn((items) => {
      calls.push('clubItems');
      return items.map((item) => ({ ...item, duplicate: false }));
    }),
    resolveChallengeSquad: vi.fn(() => {
      calls.push('squad');
      return { ok: true, payload: challengeSquad, strategy: 'panel-argument', attempts: [] };
    }),
    runSolve: vi.fn(async (input) => {
      calls.push('solve');
      return { ...solution, input };
    }),
    applySolution: vi.fn((squad, solved, clubIndex) => {
      calls.push('apply');
      return { challengeId: squad.challengeId, squad: { id: squad.squad.id }, solution: solved, clubIndex };
    }),
    writeSolution: vi.fn(async (pageWindow, payload) => {
      calls.push('write');
      return writeReport;
    }),
    ...overrides,
  };
  return steps;
};

const createService = (steps, extras = {}) => {
  const pageWindow = extras.pageWindow ?? { marker: 'page-window' };
  const requestSolve = extras.requestSolve ?? vi.fn(async () => solution);
  return {
    pageWindow,
    requestSolve,
    service: createSolveService({ pageWindow, requestSolve, steps }),
  };
};

describe('createSolveService', () => {
  it('runs the read, solve and write stages in order and surfaces the worker result', async () => {
    const steps = createSteps();
    const { service, requestSolve } = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.ok).toBe(true);
    expect(steps.calls).toEqual([
      'subject',
      'challenge',
      'club',
      'clubItems',
      'squad',
      'eligibility',
      'solve',
      'apply',
      'write',
    ]);
    expect(outcome.cost).toBe(4200);
    expect(outcome.costComplete).toBe(true);
    expect(outcome.costCoverage).toEqual(solution.costCoverage);
    expect(outcome.valid).toBe(true);
    expect(outcome.unverified).toEqual(solution.unverified);
    expect(outcome.write).toBe(writeReport);
    expect(outcome.read.summary).toContain('3 Leagues & 2 Nations');
    expect(outcome.read.summary).toContain('2 club items');
    expect(steps.runSolve.mock.calls[0][0].requestSolve).toBe(requestSolve);
    expect(steps.applySolution.mock.calls[0][2]).toBeInstanceOf(Map);
  });

  it('resolves the live eligibility tables once and passes the same tables to every solve', async () => {
    const steps = createSteps();
    const { service } = createService(steps);

    await service.solve({ subject: 'panel' });
    await service.solve({ subject: 'panel' });

    expect(steps.readEligibilityKeys).toHaveBeenCalledTimes(1);
    expect(steps.runSolve).toHaveBeenCalledTimes(2);
    const first = steps.runSolve.mock.calls[0][0];
    const second = steps.runSolve.mock.calls[1][0];
    expect(first.keys).toBe(second.keys);
    expect(first.scopes).toBe(second.scopes);
    expect(first.keys).not.toBeNull();
  });

  it('fails loudly naming the live enum when the key table is unreadable, with no static fallback', async () => {
    const thrown = new Error(
      'readEligibilityKeys: SBCEligibilityKey is malformed; refusing to build a partial table'
    );
    const steps = createSteps({
      readEligibilityKeys: vi.fn(() => {
        throw thrown;
      }),
    });
    const { service } = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe('eligibility');
    expect(outcome.error.message).toBe(thrown.message);
    expect(steps.runSolve).not.toHaveBeenCalled();
    expect(steps.calls).not.toContain('solve');
  });

  it('rejects a resolver that returns no usable key table instead of substituting one', async () => {
    const steps = createSteps({ readEligibilityKeys: vi.fn(() => ({ keys: {}, members: [] })) });
    const { service } = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe('eligibility');
    expect(outcome.error.message).toMatch(/SBCEligibilityKey/);
    expect(outcome.error.message).toMatch(/no usable key table/);
    expect(steps.runSolve).not.toHaveBeenCalled();
  });

  it('reaches writeSolution with the applied payload and surfaces its report', async () => {
    const steps = createSteps();
    const { service, pageWindow } = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });

    expect(steps.writeSolution).toHaveBeenCalledTimes(1);
    const [writeWindow, payload] = steps.writeSolution.mock.calls[0];
    expect(writeWindow).toBe(pageWindow);
    const [squad, solved] = steps.applySolution.mock.calls[0];
    expect(squad).toBe(challengeSquad);
    expect(solved.cost).toBe(4200);
    expect(payload.solution).toBe(solved);
    expect(outcome.write).toBe(writeReport);
    expect(outcome.write.strategy).toBe('services.UTSquadBuildingChallengeDAO.saveChallenge');
  });

  it('reports an invalid solution as a normal outcome and does not write it', async () => {
    const invalid = {
      ...solution,
      valid: false,
      failures: [{ slot: 0, reason: 'no nation match available' }],
      cost: null,
      costComplete: false,
    };
    const steps = createSteps({ runSolve: vi.fn(async () => invalid) });
    const { service } = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.ok).toBe(true);
    expect(outcome.valid).toBe(false);
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.write).toBeNull();
    expect(outcome.writeSkipped).toMatch(/not valid/i);
    expect(steps.writeSolution).not.toHaveBeenCalled();
  });

  it('reports a failed challenge read rather than throwing', async () => {
    const steps = createSteps({
      resolveChallengeSubject: vi.fn(() => ({ ok: false, payload: null, strategy: null, attempts: [] })),
    });
    const { service } = createService(steps);

    const outcome = await service.solve({ subject: 'nonsense' });

    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe('challenge');
    expect(outcome.read.summary).toMatch(/challenge not detected/);
    expect(steps.runSolve).not.toHaveBeenCalled();
  });

  it('never lets the solve path reach submitChallenge, even when every write candidate fails', async () => {
    const submitChallenge = vi.fn();
    const pageWindow = {
      services: {
        UTSquadBuildingChallengeDAO: {
          submitChallenge,
          saveChallenge: () => {
            throw new Error('rejected');
          },
        },
      },
    };
    const steps = createSteps();
    delete steps.writeSolution;
    const { service } = createService(steps, { pageWindow });

    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.ok).toBe(true);
    expect(outcome.write.ok).toBe(false);
    expect(outcome.write.attempts.map((attempt) => attempt.id)).toEqual(
      SQUAD_WRITE_STRATEGIES.map((strategy) => strategy.id)
    );
    for (const attempt of outcome.write.attempts) {
      expect(attempt.ok).toBe(false);
      expect(attempt.reason.length).toBeGreaterThan(0);
    }
    expect(submitChallenge).not.toHaveBeenCalled();
  });

  it('requires the injected transport and page window at construction', () => {
    expect(() => createSolveService({ requestSolve: async () => {} })).toThrow(/pageWindow/);
    expect(() => createSolveService({ pageWindow: {} })).toThrow(/requestSolve/);
  });

  it('keeps the diagnostics when the service shape report throws', async () => {
    const steps = createSteps({
      resolveClubItems: vi.fn(async () => ({
        ok: false,
        items: [],
        strategy: null,
        attempts: [
          {
            id: 'services.Club.clubDao.getClubItems',
            ok: false,
            reason: 'threw: Cannot read properties of undefined',
          },
        ],
      })),
      describeServiceShape: vi.fn(() => {
        throw new Error('shape exploded');
      }),
    });
    const { service } = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });
    const club = outcome.stages.find((stage) => stage.id === 'club');

    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe('club');
    expect(club.ok).toBe(false);
    expect(club.detail.shape).toBeNull();
    expect(club.detail.shapeError).toMatch(/shape report failed/);
    expect(club.detail.shapeError).toMatch(/shape exploded/);
    expect(steps.describeServiceShape).toHaveBeenCalledTimes(1);
  });
});
