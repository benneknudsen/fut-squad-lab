import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  DIAGNOSTIC_SCHEMA,
  DIAGNOSTIC_STAGES,
  buildDiagnosticsReport,
  completeStages,
  formatDiagnosticsBlock,
  formatDiagnosticsFileName,
  summarizeWritePlan,
} from '../src/ea/summary.js';
import {
  crossCheckEligibilityModel,
  readEligibilityKeys,
  resolveClubItems,
} from '../src/ea/adapter.js';
import { readClubItems } from '../src/ea/club-reader.js';
import { createSolveService } from '../src/ea/solve-service.js';
import { scrubExternalText } from '../src/shape.js';
import { startPageBridge, writeDiagnosticsFile } from '../src/page-bridge-app.js';
import club from './fixtures/club-items.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import challengeSquadFixture from './fixtures/sbs-challenge-25-squad.json';
import { PINNED_ELIGIBILITY_KEYS } from './fixtures/eligibility-observation.js';
import { createTestPacer } from './helpers/pacing.js';

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
    players: club.items
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
    items: club.items,
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
    pacer: createTestPacer(),
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

    // The live enum here is built from the pinned observation set, which
    // predates issue #53: the names the model gained after that observation are
    // reported as missing from this live read, exactly as the model requires.
    expect(report.pinned.present).toBe(15);
    expect(report.pinned.missing).toEqual([
      'PLAYER_RARITY_GROUP',
      'PLAYER_MIN_OVR',
      'PLAYER_EXACT_OVR',
      'PLAYER_MAX_OVR',
      'PLAYER_TRADABILITY',
      'ALL_PLAYERS_CHEMISTRY_POINTS',
    ]);
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

describe('formatDiagnosticsFileName', () => {
  it('names the evidence file with the build id and a date, and no time of day', () => {
    const name = formatDiagnosticsFileName('fsl-build/13', new Date('2026-09-27T14:02:11.000Z'));

    expect(name).toBe('fsl-diagnostics-fsl-build-13-2026-09-27.json');
    expect(name).not.toContain('T');
    expect(name).not.toContain('Z');
    expect(name).not.toMatch(/\d{2}-\d{2}-\d{2}Z/);
  });

  it('names two solves on the same day identically, so the file records no play time', () => {
    const midnight = formatDiagnosticsFileName('fsl-build/13', new Date('2026-09-27T00:00:00.000Z'));
    const lastSecond = formatDiagnosticsFileName(
      'fsl-build/13',
      new Date('2026-09-27T23:59:59.999Z')
    );

    expect(midnight).toBe('fsl-diagnostics-fsl-build-13-2026-09-27.json');
    expect(lastSecond).toBe(midnight);
  });

  it('rejects a report without a build id instead of writing an unnamed file', () => {
    expect(() => formatDiagnosticsFileName('', new Date())).toThrow(/buildId/);
  });
});

const createFilePage = ({ withBlob = true } = {}) => {
  const clicked = [];
  const revoked = [];
  const blobs = [];
  class Blob {
    constructor(parts, settings) {
      this.parts = parts;
      this.settings = settings;
      blobs.push(this);
    }
  }
  const document = {
    body: { appendChild: vi.fn() },
    createElement: (tagName) => {
      void tagName;
      const anchor = {
        href: null,
        download: null,
        click: () => clicked.push(anchor),
        remove: vi.fn(),
      };
      return anchor;
    },
  };
  const urlApi = {
    createObjectURL: (blob) => `blob:fsl/${blob === blobs[0] ? 1 : 2}`,
    revokeObjectURL: (url) => revoked.push(url),
  };
  const pageWindow = {
    document,
    Blob: withBlob ? Blob : undefined,
    URL: urlApi,
  };
  return { pageWindow, blobs, clicked, revoked, document };
};

describe('writeDiagnosticsFile', () => {
  it('writes the exact report JSON through a blob and clicks a named download anchor', () => {
    const { pageWindow, blobs, clicked, revoked } = createFilePage();
    const report = { schema: DIAGNOSTIC_SCHEMA, stages: [], download: { ok: true } };

    writeDiagnosticsFile(pageWindow, 'fsl-diagnostics-fsl-build-13-2026-09-27.json', report);

    expect(blobs).toHaveLength(1);
    expect(blobs[0].settings).toEqual({ type: 'application/json' });
    expect(JSON.parse(blobs[0].parts[0])).toEqual(report);
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe('fsl-diagnostics-fsl-build-13-2026-09-27.json');
    expect(clicked[0].href).toBe('blob:fsl/1');
    expect(revoked).toEqual(['blob:fsl/1']);
  });

  it('throws naming the missing Blob shape rather than silently dropping the evidence file', () => {
    const { pageWindow } = createFilePage({ withBlob: false });

    expect(() => writeDiagnosticsFile(pageWindow, 'name.json', {})).toThrow(/Blob/);
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
    // The fake live enum is the 15-member pinned observation set; the six model
    // names issue #53 added are absent from it by construction.
    expect(byId.eligibility.detail.crossCheck.pinned.missing).toEqual([
      'PLAYER_RARITY_GROUP',
      'PLAYER_MIN_OVR',
      'PLAYER_EXACT_OVR',
      'PLAYER_MAX_OVR',
      'PLAYER_TRADABILITY',
      'ALL_PLAYERS_CHEMISTRY_POINTS',
    ]);
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

  it('carries the club payload field the read used into the club stage detail', async () => {
    const steps = createSteps({
      resolveClubItems: vi.fn(async () => ({
        ok: true,
        items: club.items,
        strategy: 'fake-club-reader',
        field: 'items',
        endOfList: true,
        attempts: [{ id: 'fake-club-reader', ok: true, reason: null }],
      })),
    });
    const service = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });
    const clubStage = stageById(outcome.stages, 'club');

    expect(clubStage.detail).toMatchObject({ field: 'items', endOfList: true });
  });

  it('carries the set-API selection counts into the bridge detail and the read', async () => {
    const selection = {
      ok: true,
      sets: 2,
      seen: 7,
      open: 3,
      chosenId: 25,
      inProgress: true,
      reason: 'saw 7 challenges, 3 open; chose challenge 25 (in progress)',
    };
    const steps = createSteps({
      loadChallenge: vi.fn(async () => ({
        ok: true,
        payload: challengeFixture,
        strategy: 'services.SBC.requestSets+requestChallengesForSet+getChallenges',
        attempts: [
          {
            id: 'services.SBC.requestSets+requestChallengesForSet+getChallenges',
            ok: true,
            reason: null,
            selection,
          },
        ],
        selection,
      })),
    });
    const service = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });
    const bridge = stageById(outcome.stages, 'bridge');

    expect(bridge.detail.selection).toEqual(selection);
    expect(outcome.read.loadSelection).toEqual(selection);
    expect(outcome.read.summary).toContain('saw 7 challenges');
    expect(outcome.read.summary).toContain('chose 25');
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

  it('records a stage that throws with its error message and leaves the later stages unrecorded', async () => {
    const steps = createSteps({
      readClubItems: vi.fn(() => {
        throw new Error(
          'normaliseClubItem: raw item must carry a finite assetId; rejected field assetId;' +
            ' it carries keys [id]; the /club payload shape may have changed'
        );
      }),
    });
    const service = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe('club');
    expect(outcome.error.message).toMatch(/finite assetId/);
    expect(outcome.stages.map((stage) => stage.id)).toEqual(['bridge', 'challenge', 'club']);
    const club = stageById(outcome.stages, 'club');
    expect(club.ok).toBe(false);
    expect(club.reason).toMatch(/finite assetId/);
    const report = buildDiagnosticsReport(outcome.stages);
    expect(report.ok).toBe(false);
    expect(report.stoppedAt).toBe('club');
    expect(report.stages.slice(3).every((stage) => stage.ok === null)).toBe(true);
  });

  it('names the club array field, page and offending index when an item cannot be normalised', async () => {
    const { assetId, ...withoutAssetId } = club.items[0];
    const steps = createSteps({
      resolveClubItems: vi.fn(async () => ({
        ok: true,
        items: [club.items[1], withoutAssetId],
        strategy: 'fake-club-reader',
        field: 'items',
        pages: 2,
        pageItems: [1, 1],
        attempts: [{ id: 'fake-club-reader', ok: true, reason: null }],
      })),
      readClubItems,
    });
    const service = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });
    const clubStage = stageById(outcome.stages, 'club');

    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe('club');
    expect(clubStage.ok).toBe(false);
    expect(clubStage.detail.field).toBe('items');
    expect(clubStage.detail.clubRead).toMatchObject({
      field: 'items',
      index: 1,
      pageIndex: 2,
      pageItems: 1,
      itemIndexInPage: 0,
    });
    expect(clubStage.reason).toMatch(/assetId/);
    expect(clubStage.reason).toMatch(/page 2/);
  });

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

const collectStringValues = (value) => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (value === null || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectStringValues);
};

describe('scrubExternalText', () => {
  it('drops a URL query and fragment while keeping the path', () => {
    const scrubbed = scrubExternalText(
      'request failed for https://utas.example/ut/game/fc27/club?personaId=987654321#access_token'
    );

    expect(scrubbed).toContain('https://utas.example/ut/game/fc27/club');
    expect(scrubbed).not.toContain('personaId');
    expect(scrubbed).not.toContain('987654321');
    expect(scrubbed).not.toContain('access_token');
  });

  it('collapses a run of six or more digits and keeps a shorter number', () => {
    expect(scrubExternalText('persona 987654321')).not.toMatch(/\d{6,}/);
    expect(scrubExternalText('cost 12345 coins')).toContain('12345');
    expect(scrubExternalText('item 123456')).not.toContain('123456');
  });

  it('collapses newlines so a message cannot smuggle a block boundary', () => {
    const scrubbed = scrubExternalText('line one\nline two\r\nline three');

    expect(scrubbed).not.toContain('\n');
    expect(scrubbed).not.toContain('\r');
    expect(scrubbed).toContain('line one');
    expect(scrubbed).toContain('line three');
  });

  it('returns a value that is not a string unchanged', () => {
    expect(scrubExternalText(null)).toBeNull();
    expect(scrubExternalText(undefined)).toBeUndefined();
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

  it('scrubs an EA error URL and persona id out of the string values, and keeps the challenge name', async () => {
    const eaMessage = 'request failed for https://utas.example/ut/game/fc27/club?personaId=987654321';
    const eaPageWindow = {
      services: {
        UTSBCRepository: {
          getClubItems: () => ({
            observe(subscriber, callback) {
              void subscriber;
              callback({ unobserve() {} }, { error: { message: eaMessage } });
            },
          }),
        },
      },
    };
    const steps = createSteps({
      resolveClubItems: (ignoredPageWindow, options) => resolveClubItems(eaPageWindow, options),
    });
    const service = createService(steps);

    const outcome = await service.solve({ subject: 'panel' });
    const report = buildDiagnosticsReport(outcome.stages);
    const block = formatDiagnosticsBlock(report);
    const parsed = JSON.parse(block.slice(block.indexOf('{'), block.lastIndexOf('}') + 1));
    const values = collectStringValues(parsed);

    // The real adapter path produced the reason, so the assertions below are
    // exercised against EA text and not against a string the test wrote into
    // the stage list itself.
    const clubReason = report.stages.find((stage) => stage.id === 'club').reason;
    expect(clubReason).toContain('the observable reported an error');
    expect(clubReason).toContain('https://utas.example/ut/game/fc27/club');

    expect(values.some((value) => value.includes('987654321'))).toBe(false);
    expect(values.some((value) => value.includes('personaId=987654321'))).toBe(false);
    expect(values).toContain('3 Leagues & 2 Nations');
  });
});

describe('the diagnostic path never sends anything anywhere', () => {
  const diagnosticModules = [
    'src/ea/adapter.js',
    'src/ea/build.js',
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

const createDiagnosticsWindow = (options = {}) => {
  const view = createFakeNode();
  const messages = [];
  const listeners = [];
  const logs = [];
  const created = [];
  const blobs = [];
  const objectUrls = [];
  const revocations = [];
  const clubResponse = options.clubResponse ?? { items: club.items };
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
      players: club.items.slice(0, 11).map((item) => ({
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

  class Blob {
    constructor(parts, settings) {
      this.parts = parts;
      this.settings = settings;
      blobs.push(this);
    }
  }

  const pageWindow = {
    SBCEligibilityKey: liveEnumFromPinned(),
    document: {
      body: createFakeNode(),
      createElement: (tagName) => {
        const node = createFakeNode();
        node.tagName = String(tagName).toUpperCase();
        created.push(node);
        return node;
      },
    },
    Blob: options.downloadBlocked === true ? undefined : Blob,
    URL: {
      createObjectURL: vi.fn((blob) => {
        const url = `blob:fsl/${objectUrls.length + 1}`;
        objectUrls.push({ url, blob });
        return url;
      }),
      revokeObjectURL: vi.fn((url) => revocations.push(url)),
    },
    services: {
      UTSBCRepository: { getClubItems: async () => clubResponse },
      // The fake page exposes EA's own challenge save path, so the default
      // bridge Solve is a full success (every stage ok) and the write gate can
      // be tested against a genuinely successful Solve.
      UTSquadBuildingChallengeDAO: { saveChallenge: async () => undefined },
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
    created,
    blobs,
    objectUrls,
    revocations,
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
    startPageBridge(pageWindow, { hookPollMs: 1, pacer: createTestPacer() });
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
    // #52: the pasted report explains a slow run with its paced call counts.
    expect(report.pacing.calls).toBeGreaterThan(0);
    expect(typeof report.pacing.waits).toBe('number');
    expect(typeof report.pacing.retries).toBe('number');

    expect(pageWindow.fetch).not.toHaveBeenCalled();
    expect(pageWindow.navigator.sendBeacon).not.toHaveBeenCalled();
  });

  it('logs the one delimited block the global re-dumps', async () => {
    const { pageWindow, view, dispatchMessage, logs } = createDiagnosticsWindow();
    startPageBridge(pageWindow, { hookPollMs: 1, pacer: createTestPacer() });
    dispatchMessage(COPY_MESSAGE);
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet({ ...challengeFixture, squad: challengeSquadFixture.squad });
    mountedButton(view).click();

    await vi.waitFor(() => {
      expect(pageWindow.__FSL_DIAGNOSE__()).not.toBeNull();
    });

    const block = formatDiagnosticsBlock(pageWindow.__FSL_DIAGNOSE__());
    expect(logs.filter((line) => line === block)).toHaveLength(1);
    expect(block).toContain('__FSL_DIAGNOSE__');
  });

  it('still logs the block exactly once when a read throws', async () => {
    const { pageWindow, view, dispatchMessage, logs } = createDiagnosticsWindow({
      clubResponse: { items: [{ id: 116927068448054 }] },
    });
    startPageBridge(pageWindow, { hookPollMs: 1, pacer: createTestPacer() });
    dispatchMessage(COPY_MESSAGE);
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet({ ...challengeFixture, squad: challengeSquadFixture.squad });
    mountedButton(view).click();

    await vi.waitFor(() => {
      expect(pageWindow.__FSL_DIAGNOSE__()).not.toBeNull();
    });

    const report = pageWindow.__FSL_DIAGNOSE__();
    const club = report.stages.find((stage) => stage.id === 'club');
    expect(report.ok).toBe(false);
    expect(report.stoppedAt).toBe('club');
    expect(club.ok).toBe(false);
    expect(club.reason).toMatch(/assetId/);
    expect(club.detail.clubRead).toMatchObject({
      field: 'items',
      index: 0,
      pageIndex: 1,
      pageItems: 1,
      itemIndexInPage: 0,
    });
    const block = formatDiagnosticsBlock(report);
    expect(logs.filter((line) => line === block)).toHaveLength(1);
  });

  it('carries the observer captures in the pasted report, names and types only', async () => {
    const { pageWindow, view, dispatchMessage } = createDiagnosticsWindow();
    startPageBridge(pageWindow, { hookPollMs: 1, pacer: createTestPacer() });
    dispatchMessage(COPY_MESSAGE);
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet({ ...challengeFixture, squad: challengeSquadFixture.squad });
    mountedButton(view).click();

    await vi.waitFor(() => {
      expect(pageWindow.__FSL_DIAGNOSE__()).not.toBeNull();
    });

    const report = pageWindow.__FSL_DIAGNOSE__();
    const call = report.observer.calls.find((entry) => entry.method.includes('initWithSBCSet'));
    expect(call).toBeDefined();
    expect(call.argumentCount).toBe(1);
    expect(call.args[0].type).toBe('object');
    expect(call.args[0].keys.some((entry) => entry.name === 'elgReq')).toBe(true);
    expect(JSON.stringify(report.observer)).not.toContain('3 Leagues & 2 Nations');
    // #76: the diff is computed beside the captures, even when EA's own club
    // search was never observed in this session.
    expect(report.criteriaDiff).not.toBeUndefined();
    expect(report.criteriaDiff.observed).toBeNull();
    expect(report.criteriaDiff.note).toMatch(/Club/);
  });
});

const runBridgeSolve = async (options = {}) => {
  const fake = createDiagnosticsWindow(options);
  startPageBridge(fake.pageWindow, { hookPollMs: 1, pacer: createTestPacer() });
  fake.dispatchMessage(COPY_MESSAGE);
  const controller = new fake.pageWindow.UTSBCSquadDetailPanelViewController();
  controller.initWithSBCSet({ ...challengeFixture, squad: challengeSquadFixture.squad });
  mountedButton(fake.view).click();
  await vi.waitFor(() => {
    expect(fake.pageWindow.__FSL_DIAGNOSE__()).not.toBeNull();
  });
  return fake;
};

describe('the page bridge writes the evidence file only for a failed Solve', () => {
  it('writes nothing and relays no download outcome when the Solve succeeded', async () => {
    const { pageWindow, logs, messages, blobs, created } = await runBridgeSolve();

    const report = pageWindow.__FSL_DIAGNOSE__();
    expect(report.ok).toBe(true);
    expect(report.stoppedAt).toBeNull();
    expect(report.download).toBeNull();
    expect(report.mount).not.toBeUndefined();

    // The observable effect: no Blob was constructed and no anchor was clicked.
    expect(blobs).toHaveLength(0);
    expect(created.some((node) => node.tagName === 'A')).toBe(false);

    // The block still goes to the isolated console verbatim.
    const relayed = messages.filter((message) => message.kind === 'diagnostics');
    expect(relayed).toHaveLength(1);
    expect(relayed[0].block).toBe(formatDiagnosticsBlock(report));
    expect(relayed[0].file).toBeNull();
    expect(relayed[0].download).toBeNull();
    expect(logs.filter((line) => line === relayed[0].block)).toHaveLength(1);
  });

  it('writes the exact __FSL_DIAGNOSE__() object for a failed Solve under the date-granular name', async () => {
    const { pageWindow, logs, messages, blobs, created } = await runBridgeSolve({
      clubResponse: { items: [{ id: 116927068448054 }] },
    });

    const report = pageWindow.__FSL_DIAGNOSE__();
    expect(report.ok).toBe(false);
    expect(report.stoppedAt).toBe('club');
    expect(report.download).toEqual({
      ok: true,
      file: expect.stringMatching(/^fsl-diagnostics-fsl-build-13-\d{4}-\d{2}-\d{2}\.json$/),
    });
    expect(report.download.file).not.toContain('T');

    expect(blobs).toHaveLength(1);
    expect(blobs[0].settings).toEqual({ type: 'application/json' });
    expect(JSON.parse(blobs[0].parts[0])).toEqual(report);

    const anchor = created.find((node) => node.tagName === 'A');
    expect(anchor.download).toBe(report.download.file);
    expect(anchor.href).toBe('blob:fsl/1');

    const relayed = messages.filter((message) => message.kind === 'diagnostics');
    expect(relayed).toHaveLength(1);
    expect(relayed[0].block).toBe(formatDiagnosticsBlock(report));
    expect(relayed[0].file).toBe(report.download.file);
    expect(relayed[0].download).toEqual(report.download);
    expect(logs.filter((line) => line === relayed[0].block)).toHaveLength(1);
  });

  it('records a blocked write for a failed Solve instead of swallowing it', async () => {
    const { pageWindow, logs, messages, blobs } = await runBridgeSolve({
      clubResponse: { items: [{ id: 116927068448054 }] },
      downloadBlocked: true,
    });

    const report = pageWindow.__FSL_DIAGNOSE__();
    expect(report.ok).toBe(false);
    expect(report.download.ok).toBe(false);
    expect(report.download.reason).toMatch(/Blob/);
    expect(blobs).toHaveLength(0);

    const relayed = messages.filter((message) => message.kind === 'diagnostics');
    expect(relayed).toHaveLength(1);
    expect(relayed[0].file).toBeNull();
    expect(relayed[0].download).toEqual(report.download);
    expect(logs.filter((line) => line === relayed[0].block)).toHaveLength(1);
  });

  it('carries the stall point of a failed club walk into the written evidence', async () => {
    const { pageWindow, blobs } = await runBridgeSolve({
      clubResponse: { items: [{ id: 116927068448054 }] },
    });

    const report = pageWindow.__FSL_DIAGNOSE__();
    const club = report.stages.find((stage) => stage.id === 'club');
    const challenge = report.stages.find((stage) => stage.id === 'challenge');

    expect(report.build.id).toBe('fsl-build/13');
    expect(challenge.detail.challengeId).toBe(25);
    expect(club.detail).toMatchObject({
      field: 'items',
      strategy: 'services.UTSBCRepository.getClubItems',
    });
    expect(club.detail.clubRead).toMatchObject({
      index: 0,
      pageIndex: 1,
      pageItems: 1,
      itemIndexInPage: 0,
    });
    expect(club.detail.clubRead.keys).toContain('id');
    expect(club.reason).toMatch(/assetId/);
    expect(JSON.parse(blobs[0].parts[0])).toEqual(report);
  });
});
