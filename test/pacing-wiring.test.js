import { describe, expect, it, vi } from 'vitest';

import { loadChallengePayload, resolveChallengeSquad, resolveClubItems } from '../src/ea/adapter.js';
import { createPacer, defaultPacer } from '../src/ea/pacing.js';
import { createSolveService } from '../src/ea/solve-service.js';
import { writeSolution } from '../src/ea/squad-writer.js';
import { DIAGNOSTIC_STAGES, buildDiagnosticsReport } from '../src/ea/summary.js';

// Issue #52 wiring: the pacing tests prove the queue itself; these prove every
// EA call site actually goes through it. The injected pacers here are
// zero-wait, so this file runs against fake-free timers without sleeping.

const ZERO_WAIT = {
  minGapMs: 0,
  submitGapMs: 0,
  jitterRatio: 0,
  backoffBaseMs: 0,
  backoffMaxMs: 0,
};

const zeroWaitPacer = () => createPacer(ZERO_WAIT);

const observableOf = ({ data = null, response = null, error = null, status = 200 } = {}) => ({
  observe(subscriber, callback) {
    callback({ unobserve() {} }, { data, error, response, status, success: error === null });
    return { unobserve() {} };
  },
});

const challenge = {
  challengeId: 25,
  name: '3 Leagues & 2 Nations',
  formation: 'f343',
  elgOperation: 'AND',
  elgReq: [],
};

const subjectResult = { ok: true, payload: challenge, strategy: 'panel-argument', attempts: [] };

describe('the club read goes through the queue', () => {
  it('counts every search page as a paced call', async () => {
    const pacer = zeroWaitPacer();
    const pages = [[{ id: 1 }], []];
    let page = 0;
    const pageWindow = {
      UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } },
      services: {
        Club: {
          search: () => observableOf({ data: { items: pages[page++] ?? [] } }),
        },
      },
    };

    const result = await resolveClubItems(pageWindow, { pacer });

    expect(result.ok).toBe(true);
    expect(result.pages).toBe(2);
    expect(pacer.snapshot().calls).toBe(2);
  });

  it('retries a rate-limited page through the queue before yielding the club', async () => {
    const pacer = zeroWaitPacer();
    const bodies = [
      observableOf({ error: new Error('rate limited'), status: 429 }),
      observableOf({ data: { items: [{ id: 1 }] } }),
      observableOf({ data: { items: [] } }),
    ];
    let call = 0;
    const pageWindow = {
      UTBucketedItemSearchViewModel: { searchCriteria: { ownedOnly: true } },
      services: { Club: { search: () => bodies[call++] } },
    };

    const result = await resolveClubItems(pageWindow, { pacer });

    expect(result.ok).toBe(true);
    expect(result.items).toEqual([{ id: 1 }]);
    expect(pacer.snapshot()).toMatchObject({ calls: 3, retries: 1 });
  });

  it('retries a rate-limited challenge load and names the winning strategy', async () => {
    const pacer = zeroWaitPacer();
    const bodies = [
      observableOf({ error: new Error('busy'), status: 503 }),
      observableOf({ response: challenge, status: 200 }),
    ];
    let call = 0;
    const pageWindow = { services: { SBC: { loadChallenge: () => bodies[call++] } } };

    const result = await loadChallengePayload(pageWindow, subjectResult, { pacer });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.SBC.loadChallenge+subject');
    expect(pacer.snapshot()).toMatchObject({ calls: 2, retries: 1 });
  });

  it('counts the active-squad definition-id call as a paced call', async () => {
    const pacer = zeroWaitPacer();
    const squad = { challengeId: 25, squad: { id: 1, players: [] } };
    const viewModel = {
      requestActiveSquadDefinitionIds: () => observableOf({ data: squad }),
    };

    const result = await resolveChallengeSquad(
      {},
      { UTBucketedItemSearchViewModel: viewModel },
      null,
      { pacer }
    );

    expect(result.ok).toBe(true);
    expect(pacer.snapshot().calls).toBe(1);
  });
});

describe('the squad write goes through the queue', () => {
  it('retries a rate-limited save through the queue', async () => {
    const pacer = zeroWaitPacer();
    let saves = 0;
    const saveChallenge = vi.fn(async () => {
      saves += 1;
      if (saves === 1) {
        const error = new Error('rate limited');
        error.status = 429;
        throw error;
      }
      return 'saved';
    });
    const pageWindow = { services: { UTSquadBuildingChallengeDAO: { saveChallenge } } };

    const report = await writeSolution(pageWindow, { challengeId: 25 }, { pacer });

    expect(report.ok).toBe(true);
    expect(saveChallenge).toHaveBeenCalledTimes(2);
    expect(pacer.snapshot()).toMatchObject({ calls: 2, retries: 1 });
  });

  it('does not retry a 475 save because the context says EA rejected the squad', async () => {
    const pacer = zeroWaitPacer();
    const saveChallenge = vi.fn(async () => {
      const error = new Error('Ineligible Squad');
      error.status = 475;
      throw error;
    });
    const pageWindow = { services: { UTSquadBuildingChallengeDAO: { saveChallenge } } };

    const report = await writeSolution(pageWindow, { challengeId: 25 }, { pacer });

    expect(report.ok).toBe(false);
    expect(saveChallenge).toHaveBeenCalledTimes(1);
    expect(pacer.snapshot().retries).toBe(0);
    expect(report.attempts[0].reason).toMatch(/ineligible/i);
  });

  it('retries a rate-limited slot-level save through the queue', async () => {
    const pacer = zeroWaitPacer();
    let attempts = 0;
    // A zero-arity save is refused by the plain strategy, so this exercises the
    // getSlots+save candidate and its paced save call.
    async function save() {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('too many requests');
        error.status = 429;
        throw error;
      }
      return 'saved';
    }
    const slots = [{ index: 0, setItem: async () => {} }];
    const pageWindow = { services: { UTSquadEntity: { getSlots: () => slots, save } } };
    const payload = { challengeId: 25, squad: { players: [{ index: 0, itemData: { id: 1 } }] } };

    const report = await writeSolution(pageWindow, payload, { pacer });

    expect(report.ok).toBe(true);
    expect(report.strategy).toBe('services.UTSquadEntity.getSlots+save');
    expect(report.slotStrategy).toBe('setItem');
    expect(attempts).toBe(2);
    expect(pacer.snapshot()).toMatchObject({ calls: 2, retries: 1 });
  });
});

describe('the solve service owns one pacer for the whole run', () => {
  const stage = (id, ok = true) => ({ id, ok, reason: null, detail: null });
  const finishedStages = () => DIAGNOSTIC_STAGES.map((id) => stage(id));

  const createSteps = (seen) => ({
    resolveChallengeSubject: () => ({ ...subjectResult }),
    loadChallenge: async (pageWindow, subject, options) => {
      seen.load = options?.pacer ?? null;
      return { ok: true, payload: challenge, strategy: 'subject.payload', attempts: [] };
    },
    readChallenge: () => challenge,
    resolveClubItems: async (pageWindow, options) => {
      seen.club = options?.pacer ?? null;
      await options.pacer.run('stub club call', async () => 'club');
      return { ok: true, items: [], strategy: 'stub', attempts: [], pages: 1, capped: false };
    },
    readClubItems: (items) => items,
    resolveChallengeSquad: async (subject, pageWindow, loaded, options) => {
      seen.squad = options?.pacer ?? null;
      return { ok: true, payload: { challengeId: 25, squad: { players: [] } }, strategy: 'stub', attempts: [] };
    },
    readEligibilityKeys: () => ({ keys: { 8: { type: 'X' } }, members: [], unmodelled: [] }),
    describeServiceShape: () => ({ schema: 'stub' }),
    runSolve: async () => ({ squad: { players: [] }, cost: 0, valid: true, failures: [], unverified: [] }),
    planSquadWrite: () => ({ placed: [], preserved: [], unplaced: [] }),
    applySolution: () => ({ challengeId: 25, squad: { players: [] } }),
    writeSolution: async (pageWindow, payload, options) => {
      seen.write = options?.pacer ?? null;
      return { ok: true, strategy: 'stub', attempts: [] };
    },
  });

  it('passes the same pacer to every EA-touching stage and surfaces its counts', async () => {
    const seen = {};
    const pacer = zeroWaitPacer();
    const service = createSolveService({
      pageWindow: { marker: 'page-window' },
      requestSolve: async () => ({ squad: { players: [] } }),
      steps: createSteps(seen),
      pacer,
    });

    const outcome = await service.solve({ subject: 'panel' });

    expect(seen.load).toBe(pacer);
    expect(seen.club).toBe(pacer);
    expect(seen.squad).toBe(pacer);
    expect(seen.write).toBe(pacer);
    expect(outcome.pacing).toEqual(pacer.snapshot());
    expect(outcome.pacing.calls).toBe(1);

    const report = buildDiagnosticsReport(finishedStages(), undefined, outcome.pacing);
    expect(report.pacing).toEqual(pacer.snapshot());

    service.cancel();
    await expect(pacer.run('after cancel', async () => 'late')).rejects.toThrow(/cancel/i);
  });

  it('re-arms the pacer at the start of the next solve after a cancel', async () => {
    const seen = {};
    const pacer = zeroWaitPacer();
    const service = createSolveService({
      pageWindow: { marker: 'page-window' },
      requestSolve: async () => ({ squad: { players: [] } }),
      steps: createSteps(seen),
      pacer,
    });

    service.cancel();
    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.ok).toBe(true);
    expect(pacer.snapshot().calls).toBe(1);
  });

  it('sends a call through the shared default queue when no pacer is injected', async () => {
    const before = defaultPacer().snapshot().calls;
    const pageWindow = {
      services: { Club: { clubDao: { getClubItems: () => ({ items: [] }) } } },
    };

    const result = await resolveClubItems(pageWindow);

    expect(result.ok).toBe(true);
    expect(defaultPacer().snapshot().calls).toBe(before + 1);
  });
});