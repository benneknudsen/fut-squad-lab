import { describe, expect, it } from 'vitest';

import { STAGE_CALL_BUDGETS, STAGE_NAMES, createPacer } from '../src/ea/pacing.js';
import { createSolveService } from '../src/ea/solve-service.js';
import { buildDiagnosticsReport } from '../src/ea/summary.js';
import { panelSubjectChanged } from '../src/page-bridge-app.js';

// fsl-build/13 spent the whole queue on the 21-set bridge walk, and the club
// read every queued call with "pacing: the call was cancelled before it
// started". These tests pin a per-stage call budget: exhausting one stage can
// no longer starve the next, and the split is reported in the diagnostics.

const ZERO_WAIT = {
  minGapMs: 0,
  submitGapMs: 0,
  jitterRatio: 0,
  backoffBaseMs: 0,
  backoffMaxMs: 0,
};

const challenge = {
  challengeId: 25,
  name: 'test challenge',
  formation: 'f343',
  elgOperation: 'AND',
  elgReq: [],
};

const finishedStages = () => [
  { id: 'bridge', ok: true, reason: null, detail: null },
  { id: 'challenge', ok: true, reason: null, detail: null },
  { id: 'club', ok: true, reason: null, detail: null },
  { id: 'squad', ok: true, reason: null, detail: null },
  { id: 'eligibility', ok: true, reason: null, detail: null },
  { id: 'solve', ok: true, reason: null, detail: null },
  { id: 'payload', ok: true, reason: null, detail: null },
  { id: 'write', ok: true, reason: null, detail: null },
];

describe('the per-stage pacing allowance', () => {
  it('names the stage budgets and stage names as exports, not call-site numbers', () => {
    for (const stage of Object.values(STAGE_NAMES)) {
      expect(STAGE_CALL_BUDGETS[stage]).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(STAGE_CALL_BUDGETS)).toBe(true);
    expect(Object.isFrozen(STAGE_NAMES)).toBe(true);
  });

  it('caps one stage without spending another stage allowance', async () => {
    const pacer = createPacer({ ...ZERO_WAIT, stageBudgets: { bridge: 2, club: 3 } });
    pacer.beginStage(STAGE_NAMES.BRIDGE);
    await pacer.run('bridge 1', async () => 1);
    await pacer.run('bridge 2', async () => 2);
    await expect(pacer.run('bridge 3', async () => 3)).rejects.toThrow(/bridge/);
    await expect(pacer.run('bridge 4', async () => 4)).rejects.toThrow(/budget of 2/);

    pacer.beginStage(STAGE_NAMES.CLUB);
    await expect(pacer.run('club 1', async () => 'club')).resolves.toBe('club');

    const stages = pacer.snapshot().stages;
    expect(stages.bridge).toEqual({ calls: 2, budget: 2 });
    expect(stages.club).toEqual({ calls: 1, budget: 3 });
  });

  it('reports the split through the diagnostics report once each stage has run', async () => {
    const seen = {};
    const pacer = createPacer({
      ...ZERO_WAIT,
      stageBudgets: { bridge: 1, club: 2, squad: 1, write: 1 },
    });
    const service = createSolveService({
      pageWindow: { marker: 'page-window' },
      requestSolve: async () => ({ squad: { players: [] } }),
      pacer,
      steps: {
        resolveChallengeSubject: () => ({
          ok: true,
          payload: challenge,
          strategy: 'panel-argument',
          attempts: [],
        }),
        loadChallenge: async (pageWindow, subject, options) => {
          await options.pacer.run('bridge call 1', async () => 'one');
          try {
            await options.pacer.run('bridge call 2', async () => 'two');
          } catch (error) {
            seen.bridgeError = error.message;
          }
          return { ok: true, payload: challenge, strategy: 'subject.payload', attempts: [] };
        },
        readChallenge: () => challenge,
        resolveClubItems: async (pageWindow, options) => {
          seen.clubPacer = options.pacer;
          seen.clubValue = await options.pacer.run('club call', async () => 'club');
          return {
            ok: true,
            items: [],
            strategy: 'stub',
            attempts: [],
            pages: 1,
            capped: false,
            pageItems: [0],
          };
        },
        readClubItems: (items) => items,
        resolveChallengeSquad: async () => ({
          ok: true,
          payload: { challengeId: 25, squad: { players: [] } },
          strategy: 'stub',
          attempts: [],
        }),
        readEligibilityKeys: () => ({ keys: { 8: { type: 'X' } }, members: [], unmodelled: [] }),
        describeServiceShape: () => ({ schema: 'stub' }),
        runSolve: async () => ({
          squad: { players: [] },
          cost: 0,
          valid: true,
          failures: [],
          unverified: [],
        }),
        planSquadWrite: () => ({ placed: [], preserved: [], unplaced: [] }),
        applySolution: () => ({ challengeId: 25, squad: { players: [] } }),
        writeSolution: async () => ({ ok: true, strategy: 'stub', attempts: [] }),
      },
    });

    const outcome = await service.solve({ subject: 'panel' });

    expect(seen.bridgeError).toMatch(/bridge/);
    expect(seen.bridgeError).toMatch(/budget of 1/);
    expect(seen.clubValue).toBe('club');
    expect(outcome.ok).toBe(true);
    expect(outcome.pacing.stages.bridge).toEqual({ calls: 1, budget: 1 });
    expect(outcome.pacing.stages.club).toEqual({ calls: 1, budget: 2 });

    const report = buildDiagnosticsReport(finishedStages(), undefined, outcome.pacing);
    expect(report.pacing.stages.bridge).toEqual({ calls: 1, budget: 1 });
    expect(report.pacing.stages.club).toEqual({ calls: 1, budget: 2 });
  });
});

describe('the panel subject identity', () => {
  const a = { id: 'first-object' };
  const b = { id: 'second-object' };

  it('keeps the run alive when EA re-renders the same selected challenge', () => {
    expect(
      panelSubjectChanged({ subject: a, challengeId: 25 }, { subject: b, challengeId: 25 })
    ).toBe(false);
  });

  it('cancels when the selected challenge id changes', () => {
    expect(
      panelSubjectChanged({ subject: a, challengeId: 25 }, { subject: b, challengeId: 26 })
    ).toBe(true);
  });

  it('cancels when no id is known and the argument object changes', () => {
    expect(panelSubjectChanged({ subject: a, challengeId: null }, { subject: b, challengeId: null })).toBe(
      true
    );
    expect(panelSubjectChanged({ subject: a, challengeId: null }, { subject: a, challengeId: null })).toBe(
      false
    );
  });
});
