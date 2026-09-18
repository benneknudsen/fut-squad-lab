import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  DIAGNOSTIC_SCHEMA,
  DIAGNOSTIC_STAGES,
  buildDiagnosticsReport,
  completeStages,
  formatDiagnosticsBlock,
  summarizeWritePlan,
} from '../src/ea/summary.js';
import { crossCheckEligibilityModel, readEligibilityKeys } from '../src/ea/adapter.js';
import { createSolveService } from '../src/ea/solve-service.js';
import { startPageBridge } from '../src/page-bridge-app.js';
import club from './fixtures/club-items.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import challengeSquadFixture from './fixtures/sbs-challenge-25-squad.json';
import { PINNED_ELIGIBILITY_KEYS } from './fixtures/eligibility-observation.js';

const challengeFixture = set10.challenges.find((entry) => entry.challengeId === 25);

const liveEnumFromPinned = () => {
  const enumTable = {};
  for (const [key, descriptor] of Object.entries(PINNED_ELIGIBILITY_KEYS)) {
    enumTable[key] = descriptor.type;
    enumTable[descriptor.type] = Number(key);
  }
  return enumTable;
};

const emptyEntry = (index) => ({
  index,
  itemData: { id: 0, assetId: 0, itemType: 'player', itemState: 'invalid', rating: 0 },
});

const challengeSquadWith = (players) => ({
  challengeId: 25,
  squad: {
    id: 1,
    formation: 'f343',
    rating: 0,
    chemistry: 0,
    manager: [{ id: 0, itemType: 'manager' }],
    players,
  },
});

const emptySquad = () =>
  challengeSquadWith(Array.from({ length: 23 }, (_, index) => emptyEntry(index)));

const solutionFromClub = (start = 0) => ({
  squad: {
    players: club.itemData
      .slice(start, start + 11)
      .map((item) => ({ id: item.id, assetId: item.assetId })),
  },
  cost: 4200,
  costComplete: true,
  costCoverage: { known: 11, unknown: 0, complete: true, unknownCards: [] },
  valid: true,
  failures: [],
  unverified: [],
});

const createSteps = (overrides = {}) => ({
  resolveChallengeSubject: vi.fn(() => ({
    ok: true,
    payload: challengeFixture,
    strategy: 'panel-argument',
    attempts: [{ id: 'panel-argument', ok: true, reason: null }],
  })),
  readChallenge: vi.fn(() => challengeFixture),
  resolveClubItems: vi.fn(async () => ({
    ok: true,
    items: club.itemData,
    strategy: 'fake-club-reader',
    attempts: [{ id: 'fake-club-reader', ok: true, reason: null }],
  })),
  readClubItems: vi.fn((items) => items),
  resolveChallengeSquad: vi.fn(() => ({
    ok: true,
    payload: emptySquad(),
    strategy: 'panel-argument',
    attempts: [{ id: 'panel-argument', ok: true, reason: null }],
  })),
  readEligibilityKeys: vi.fn(() => readEligibilityKeys({ SBCEligibilityKey: liveEnumFromPinned() })),
  runSolve: vi.fn(async () => solutionFromClub()),
  writeSolution: vi.fn(async () => ({
    ok: true,
    strategy: 'services.UTSquadBuildingChallengeDAO.saveChallenge',
    attempts: [
      { id: 'services.UTSquadBuildingChallengeDAO.saveChallenge', ok: true, reason: null },
    ],
  })),
  ...overrides,
});

const createService = (steps) =>
  createSolveService({
    pageWindow: { marker: 'page-window' },
    requestSolve: vi.fn(async () => solutionFromClub()),
    steps,
  });

const stageById = (stages, id) => stages.find((stage) => stage.id === id);

describe('crossCheckEligibilityModel', () => {
  const live = readEligibilityKeys({
    SBCEligibilityKey: {
      PLAYER_COUNT: 2,
      2: 'PLAYER_COUNT',
      SCOPE: 13,
      13: 'SCOPE',
      TEAM_RATING_1_TO_100: 19,
      19: 'TEAM_RATING_1_TO_100',
      PLAYER_RARITY: 40,
      40: 'PLAYER_RARITY',
    },
  });

  it('counts the pinned names present live and names the ones missing', () => {
    const report = crossCheckEligibilityModel(live, []);

    expect(report.pinned.present).toBe(3);
    expect(report.pinned.presentNames).toEqual(['PLAYER_COUNT', 'SCOPE', 'TEAM_RATING_1_TO_100']);
    expect(report.pinned.missing).toContain('NATION_ID');
    expect(report.pinned.missing).not.toContain('SCOPE');
  });

  it('names the live keys our model cannot name', () => {
    const report = crossCheckEligibilityModel(live, []);

    expect(report.unknown).toEqual([{ eligibilityKey: 40, type: 'PLAYER_RARITY' }]);
  });

  it('reports the same number wearing a different payload name as renamed, never reconciling it', () => {
    const report = crossCheckEligibilityModel(live, [
      { type: 'TEAM_STAR_RATING', eligibilitySlot: 1, eligibilityKey: 19, eligibilityValue: 80 },
    ]);

    expect(report.renamed).toEqual([
      {
        eligibilityKey: 19,
        liveType: 'TEAM_RATING_1_TO_100',
        observedType: 'TEAM_STAR_RATING',
      },
    ]);
  });

  it('reports a payload key the live-built table cannot decode, so stage 5 explains the failure', () => {
    const report = crossCheckEligibilityModel(live, [
      { type: 'CLUB_COUNT', eligibilitySlot: 1, eligibilityKey: 9, eligibilityValue: 1 },
    ]);

    expect(report.undecodable).toEqual([{ eligibilityKey: 9, type: 'CLUB_COUNT' }]);
  });

  it('reports no drift for the pinned observation set and the captured challenge', () => {
    const report = crossCheckEligibilityModel(
      readEligibilityKeys({ SBCEligibilityKey: liveEnumFromPinned() }),
      challengeFixture.elgReq
    );

    expect(report.pinned.present).toBe(15);
    expect(report.pinned.missing).toEqual([]);
    expect(report.unknown).toEqual([]);
    expect(report.renamed).toEqual([]);
    expect(report.undecodable).toEqual([]);
  });
});

describe('completeStages', () => {
  it('fills every stage the pipeline never reached with an explicit not-reached outcome', () => {
    const completed = completeStages([
      { id: 'bridge', ok: true, reason: null, detail: null },
      { id: 'challenge', ok: true, reason: null, detail: { challengeId: 25 } },
      { id: 'club', ok: false, reason: 'the club read failed', detail: null },
    ]);

    expect(completed.map((stage) => stage.id)).toEqual(DIAGNOSTIC_STAGES);
    expect(completed[0].ok).toBe(true);
    expect(completed[1].ok).toBe(true);
    expect(completed[2]).toMatchObject({ ok: false, reason: 'the club read failed' });
    for (const stage of completed.slice(3)) {
      expect(stage.ok).toBeNull();
      expect(stage.reason).toMatch(/not reached: the club stage/);
    }
  });

  it('returns an already complete list in the canonical order unchanged', () => {
    const stages = DIAGNOSTIC_STAGES.map((id) => ({ id, ok: true, reason: null, detail: null }));

    expect(completeStages(stages)).toEqual(stages);
  });

  it('rejects an unknown or duplicated stage id instead of rendering a wrong summary', () => {
    expect(() => completeStages([{ id: 'wat', ok: true, reason: null, detail: null }])).toThrow(
      /wat/
    );
    expect(() =>
      completeStages([
        { id: 'bridge', ok: true, reason: null, detail: null },
        { id: 'bridge', ok: true, reason: null, detail: null },
      ])
    ).toThrow(/recorded twice/);
  });
});

describe('buildDiagnosticsReport', () => {
  it('reports ok with no stoppedAt when every stage finished', () => {
    const stages = DIAGNOSTIC_STAGES.map((id) => ({ id, ok: true, reason: null, detail: null }));

    const report = buildDiagnosticsReport(stages);

    expect(report.schema).toBe(DIAGNOSTIC_SCHEMA);
    expect(report.ok).toBe(true);
    expect(report.stoppedAt).toBeNull();
    expect(report.stages.map((stage) => stage.id)).toEqual(DIAGNOSTIC_STAGES);
  });

  it('reports stoppedAt as the first stage that did not finish', () => {
    const report = buildDiagnosticsReport([
      { id: 'bridge', ok: true, reason: null, detail: null },
      { id: 'challenge', ok: true, reason: null, detail: null },
      { id: 'club', ok: false, reason: 'the club read failed', detail: null },
      { id: 'squad', ok: null, reason: 'not reached: the club stage did not finish', detail: null },
    ]);

    expect(report.ok).toBe(false);
    expect(report.stoppedAt).toBe('club');
  });

  it('throws when a stage outcome stops being recorded instead of hiding it', () => {
    const withoutClub = DIAGNOSTIC_STAGES.filter((id) => id !== 'club').map((id) => ({
      id,
      ok: true,
      reason: null,
      detail: null,
    }));

    expect(() => buildDiagnosticsReport(withoutClub)).toThrow(/club/);
  });
});

describe('formatDiagnosticsBlock', () => {
  it('renders one delimited JSON block and the documented dump one-liner', () => {
    const report = buildDiagnosticsReport(
      DIAGNOSTIC_STAGES.map((id) => ({ id, ok: true, reason: null, detail: null }))
    );

    const block = formatDiagnosticsBlock(report);

    expect(block).toContain('=== FUT Squad Lab diagnostics');
    expect(block).toContain('=== end FUT Squad Lab diagnostics ===');
    expect(block).toContain('copy(JSON.stringify(window.__FSL_DIAGNOSE__(), null, 2))');
    const json = block.slice(block.indexOf('{'), block.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual(report);
  });

  it('rejects a report that is not the builder output', () => {
    expect(() => formatDiagnosticsBlock(null)).toThrow(/report/);
    expect(() => formatDiagnosticsBlock({ schema: 'other' })).toThrow(/report/);
  });
});

describe('summarizeWritePlan', () => {
  it('surfaces placed, preserved and every unplaced player with its reason', () => {
    const summary = summarizeWritePlan({
      placed: [0, 1, 2],
      preserved: [3],
      unplaced: [
        { index: 4, id: 987654, concept: true, reason: 'no club item record for this player' },
        { index: 5, id: 123, concept: false, reason: 'challenge squad has no slot at this index' },
      ],
    });

    expect(summary.placed).toEqual({ count: 3, slots: [0, 1, 2] });
    expect(summary.preserved).toEqual({ count: 1, slots: [3] });
    expect(summary.unplaced).toEqual([
      { index: 4, concept: true, reason: 'no club item record for this player' },
      { index: 5, concept: false, reason: 'challenge squad has no slot at this index' },
    ]);
  });

  it('never carries a raw club item id into the summary', () => {
    const summary = summarizeWritePlan({
      placed: [],
      preserved: [],
      unplaced: [{ index: 0, id: 987654, concept: true, reason: 'no club record' }],
    });

    expect(JSON.stringify(summary)).not.toContain('987654');
  });

  it('rejects anything that is not a write plan', () => {
    expect(() => summarizeWritePlan(null)).toThrow(/plan/);
  });
});

describe('solve-service staged diagnostics', () => {
  it('records every stage with an explicit outcome and its detail on a full run', async () => {
    const steps = createSteps();
    const service = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });
    const report = buildDiagnosticsReport(outcome.stages);
    const byId = Object.fromEntries(report.stages.map((stage) => [stage.id, stage]));

    expect(report.ok).toBe(true);
    expect(report.stoppedAt).toBeNull();
    expect(byId.bridge).toMatchObject({ ok: true, reason: null });
    expect(byId.challenge.detail).toMatchObject({
      challengeId: 25,
      name: '3 Leagues & 2 Nations',
      formation: 'f343',
      constraints: 6,
    });
    expect(byId.club.detail).toMatchObject({ items: 42, strategy: 'fake-club-reader' });
    expect(byId.squad).toMatchObject({ ok: true, reason: null });
    expect(byId.eligibility).toMatchObject({ ok: true, reason: null });
    expect(byId.eligibility.detail.resolved).toBe(15);
    expect(byId.eligibility.detail.crossCheck.pinned.missing).toEqual([]);
    expect(byId.solve.detail).toMatchObject({
      cost: 4200,
      costComplete: true,
      valid: true,
      unverified: 0,
    });
    expect(byId.solve.detail.costCoverage).toEqual({ known: 11, unknown: 0, complete: true });
    expect(byId.payload.detail).toMatchObject({
      placed: { count: 11 },
      preserved: { count: 0 },
    });
    expect(byId.payload.detail.unplaced).toEqual([]);
    expect(byId.write).toMatchObject({ ok: true, reason: null });
    expect(byId.write.detail.attempts).toHaveLength(1);
  });

  it('surfaces an unplaced concept player with its reason instead of a clean write', async () => {
    const solution = solutionFromClub();
    solution.squad.players[10] = { id: 987654, assetId: 987654, concept: true };
    const steps = createSteps({ runSolve: vi.fn(async () => solution) });
    const service = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });
    const payload = stageById(outcome.stages, 'payload');

    expect(payload.ok).toBe(true);
    expect(payload.detail.placed.count).toBe(10);
    expect(payload.detail.unplaced).toEqual([
      {
        index: 10,
        concept: true,
        reason: expect.stringMatching(/club item record|synthesise/i),
      },
    ]);
  });

  // The expected outcome vector per stage, in DIAGNOSTIC_STAGES order. null
  // means the pipeline never reached it. The club read runs before the
  // challenge-failure return in solve-service (the read summary needs it), so
  // a bridge or challenge failure still records the club stage.
  const failureCases = [
    {
      name: 'bridge subject resolution',
      at: 'bridge',
      overrides: {
        resolveChallengeSubject: vi.fn(() => ({
          ok: false,
          payload: null,
          strategy: null,
          attempts: [{ id: 'panel-argument', ok: false, reason: 'carries no elgReq array' }],
        })),
      },
      reason: /no challenge payload/,
      expected: [false, null, true, null, null, null, null, null],
    },
    {
      name: 'challenge read',
      at: 'challenge',
      overrides: {
        readChallenge: vi.fn(() => {
          throw new Error('payload must carry a non-empty string formation');
        }),
      },
      reason: /non-empty string formation/,
      expected: [true, false, true, null, null, null, null, null],
    },
    {
      name: 'club read',
      at: 'club',
      overrides: {
        resolveClubItems: vi.fn(async () => ({
          ok: false,
          items: [],
          strategy: null,
          attempts: [{ id: 'services.UTSBCRepository.getClubItems', ok: false, reason: 'no method' }],
        })),
      },
      reason: /club read failed/,
      expected: [true, true, false, null, null, null, null, null],
    },
    {
      name: 'challenge squad read',
      at: 'squad',
      overrides: {
        resolveChallengeSquad: vi.fn(() => ({
          ok: false,
          payload: null,
          strategy: null,
          attempts: [{ id: 'panel-argument', ok: false, reason: 'no squad.players array' }],
        })),
      },
      reason: /challenge squad payload is unreadable/,
      expected: [true, true, true, false, null, null, null, null],
    },
    {
      name: 'live eligibility table',
      at: 'eligibility',
      overrides: {
        readEligibilityKeys: vi.fn(() => {
          throw new Error('EA global SBCEligibilityKey is missing from the page window');
        }),
      },
      reason: /SBCEligibilityKey is missing/,
      expected: [true, true, true, true, false, null, null, null],
    },
    {
      name: 'solve',
      at: 'solve',
      overrides: {
        runSolve: vi.fn(async () => {
          throw new Error('the solver worker failed');
        }),
      },
      reason: /solver worker failed/,
      expected: [true, true, true, true, true, false, null, null],
    },
    {
      name: 'write',
      at: 'write',
      overrides: {
        writeSolution: vi.fn(async () => ({
          ok: false,
          strategy: null,
          attempts: [
            { id: 'services.UTSquadBuildingChallengeDAO.saveChallenge', ok: false, reason: 'no method' },
          ],
        })),
      },
      reason: /no write candidate answered/,
      expected: [true, true, true, true, true, true, true, false],
    },
  ];

  for (const failure of failureCases) {
    it(`reports stages before a ${failure.name} failure as ok and that stage as failed with its reason`, async () => {
      const steps = createSteps(failure.overrides);
      const service = createService(steps);

      const outcome = await service.solve({ subject: 'panel' });
      const report = buildDiagnosticsReport(outcome.stages);
      const failedIndex = DIAGNOSTIC_STAGES.indexOf(failure.at);

      expect(report.ok).toBe(false);
      expect(report.stoppedAt).toBe(failure.at);
      expect(report.stages.map((stage) => stage.ok)).toEqual(failure.expected);
      for (let index = 0; index < failedIndex; index++) {
        expect(report.stages[index].ok, `stage ${report.stages[index].id} before the failure`).toBe(
          true
        );
      }
      expect(report.stages[failedIndex].ok).toBe(false);
      expect(report.stages[failedIndex].reason).toMatch(failure.reason);
      for (const stage of report.stages.slice(failedIndex + 1)) {
        if (stage.ok === null) expect(stage.reason).toMatch(/not reached/);
      }
    });
  }

  it('reports a valid:false solution as a solve that ran, with the payload stage stopping the write', async () => {
    const invalid = {
      ...solutionFromClub(),
      valid: false,
      failures: [{ slot: 0, reason: 'no nation match available' }],
      cost: null,
      costComplete: false,
      costCoverage: { known: 9, unknown: 2, complete: false, unknownCards: [{ slot: 1, id: 5 }] },
    };
    const steps = createSteps({ runSolve: vi.fn(async () => invalid) });
    const service = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });
    const report = buildDiagnosticsReport(outcome.stages);
    const solve = report.stages.find((stage) => stage.id === 'solve');
    const payload = report.stages.find((stage) => stage.id === 'payload');

    expect(solve.ok).toBe(true);
    expect(solve.detail.valid).toBe(false);
    expect(solve.detail.unverified).toBe(0);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toMatch(/not valid/);
    expect(report.stoppedAt).toBe('payload');
    expect(steps.writeSolution).not.toHaveBeenCalled();
  });

  it('keeps the solve result and the same write attempt as before (observability only)', async () => {
    const steps = createSteps();
    const service = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.cost).toBe(4200);
    expect(outcome.valid).toBe(true);
    expect(outcome.write.strategy).toBe('services.UTSquadBuildingChallengeDAO.saveChallenge');
    expect(steps.runSolve).toHaveBeenCalledTimes(1);
    expect(steps.writeSolution).toHaveBeenCalledTimes(1);
  });
});

describe('the diagnostics block is safe to paste', () => {
  it('carries no token, session, account or club item field', async () => {
    const steps = createSteps();
    const service = createService(steps);
    const outcome = await service.solve({ subject: 'panel' });
    const report = buildDiagnosticsReport(outcome.stages);

    const forbidden = /token|session|cookie|persona|credential|secret|authorization|itemData|assetId|marketAverage|discardValue|coin/i;
    const seen = [];
    const walk = (value) => {
      if (Array.isArray(value)) {
        for (const entry of value) walk(entry);
        return;
      }
      if (value === null || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        seen.push(key);
        walk(child);
      }
    };
    walk(report);

    expect(seen.length).toBeGreaterThan(0);
    for (const key of seen) {
      expect(key, `forbidden field ${key}`).not.toMatch(forbidden);
    }
    for (const unplaced of report.stages.find((stage) => stage.id === 'payload').detail.unplaced) {
      expect(Object.keys(unplaced).sort()).toEqual(['concept', 'index', 'reason']);
    }
  });
});

describe('the diagnostic path never sends anything anywhere', () => {
  const diagnosticModules = [
    'src/ea/adapter.js',
    'src/ea/summary.js',
    'src/ea/solve-service.js',
    'src/page-bridge-app.js',
  ];
  const networkCalls =
    /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource|new\s+Image\s*\(|createElement\s*\(\s*['"]img['"]/;

  for (const file of diagnosticModules) {
    it(`${file} contains no network call`, () => {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

      expect(source).not.toMatch(networkCalls);
    });
  }
});

// A plain-object DOM and a fake page window, same shape the existing page-bridge
// tests use. The solve-request message is answered synchronously so the full
// solve path (including the write attempt) runs without a browser.
const createFakeNode = () => {
  const node = {
    className: '',
    textContent: '',
    attributes: {},
    children: [],
    parentNode: null,
    listeners: [],
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      this.listeners.push({ type, handler });
    },
    click() {
      for (const listener of this.listeners) {
        if (listener.type === 'click') listener.handler({ type: 'click' });
      }
    },
    querySelector(selector) {
      if (selector !== '[data-fsl-solve-button]') throw new Error(`unexpected selector ${selector}`);
      const scan = (candidate) => {
        if (Object.hasOwn(candidate.attributes, 'data-fsl-solve-button')) return candidate;
        for (const child of candidate.children) {
          const match = scan(child);
          if (match !== null) return match;
        }
        return null;
      };
      return scan(this);
    },
  };
  return node;
};

const createDiagnosticsWindow = () => {
  const view = createFakeNode();
  const messages = [];
  const listeners = [];
  const logs = [];
  const network = {
    fetch: vi.fn(() => {
      throw new Error('the diagnostic path must not fetch');
    }),
    sendBeacon: vi.fn(() => {
      throw new Error('the diagnostic path must not beacon');
    }),
  };
  const solution = {
    squad: {
      players: club.itemData.slice(0, 11).map((item) => ({
        id: item.id,
        assetId: item.assetId,
        cardState: 'untradeable',
        price: 500,
        priceSource: 'ea-market-average',
      })),
    },
    cost: 5500,
    costComplete: true,
    valid: true,
    failures: [],
    unverified: [],
  };

  function UTSBCSquadDetailPanelViewController() {
    this.view = view;
  }
  UTSBCSquadDetailPanelViewController.prototype.initWithSBCSet = function (subject) {
    this.subject = subject;
    return 'original result';
  };

  const pageWindow = {
    SBCEligibilityKey: liveEnumFromPinned(),
    document: { body: createFakeNode(), createElement: () => createFakeNode() },
    services: {
      UTSBCRepository: { getClubItems: async () => ({ itemData: club.itemData }) },
    },
    console: {
      log: vi.fn((...args) => logs.push(args.join(' '))),
      info: vi.fn(),
      warn: vi.fn(),
    },
    fetch: network.fetch,
    navigator: { sendBeacon: network.sendBeacon },
    UTSBCSquadDetailPanelViewController,
    postMessage(message) {
      messages.push(message);
      if (message.kind === 'solve-request') {
        for (const listener of listeners) {
          listener({
            source: pageWindow,
            data: {
              source: 'fsl-content',
              kind: 'solve-response',
              token: message.token,
              result: solution,
            },
          });
        }
      }
    },
    addEventListener(type, handler) {
      if (type === 'message') listeners.push(handler);
    },
    setInterval(handler, ms) {
      return setInterval(handler, ms);
    },
    clearInterval(id) {
      clearInterval(id);
    },
  };

  return {
    pageWindow,
    view,
    logs,
    network,
    messages,
    dispatchMessage(data, source = pageWindow) {
      for (const listener of listeners) listener({ data, source });
    },
  };
};

const COPY_MESSAGE = {
  source: 'fsl-content',
  kind: 'copy',
  locale: 'en',
  label: 'Solve this challenge',
};

const mountedButton = (view) => view.children[0]?.children[0]?.children[0] ?? null;

describe('the page bridge exposes one documented diagnostic global', () => {
  it('returns null before the first solve and the staged report afterwards', async () => {
    const { pageWindow, view, dispatchMessage } = createDiagnosticsWindow();
    startPageBridge(pageWindow, { hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);

    expect(typeof pageWindow.__FSL_DIAGNOSE__).toBe('function');
    expect(pageWindow.__FSL_DIAGNOSE__()).toBeNull();

    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet({
      ...challengeFixture,
      squad: challengeSquadFixture.squad,
    });
    mountedButton(view).click();

    await vi.waitFor(() => {
      expect(pageWindow.__FSL_DIAGNOSE__()).not.toBeNull();
    });

    const report = pageWindow.__FSL_DIAGNOSE__();
    expect(report.schema).toBe(DIAGNOSTIC_SCHEMA);
    expect(report.stages.map((stage) => stage.id)).toEqual(DIAGNOSTIC_STAGES);
    expect(report.stages.every((stage) => stage.ok !== null)).toBe(true);

    expect(pageWindow.fetch).not.toHaveBeenCalled();
    expect(pageWindow.navigator.sendBeacon).not.toHaveBeenCalled();
  });

  it('logs the one delimited block the global re-dumps', async () => {
    const { pageWindow, view, dispatchMessage, logs } = createDiagnosticsWindow();
    startPageBridge(pageWindow, { hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet({ ...challengeFixture, squad: challengeSquadFixture.squad });
    mountedButton(view).click();

    await vi.waitFor(() => {
      expect(pageWindow.__FSL_DIAGNOSE__()).not.toBeNull();
    });

    const block = formatDiagnosticsBlock(pageWindow.__FSL_DIAGNOSE__());
    expect(logs).toContain(block);
    expect(block).toContain('__FSL_DIAGNOSE__');
  });
});
