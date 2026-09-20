import { describe, expect, it } from 'vitest';

import {
  CHALLENGE_SQUAD_STRATEGIES,
  CHALLENGE_SUBJECT_STRATEGIES,
  CLUB_ITEM_STRATEGIES,
} from '../src/ea/adapter.js';
import { BUILD_ID, buildMarker } from '../src/ea/build.js';
import {
  DIAGNOSTIC_STAGES,
  buildDiagnosticsReport,
  buildReadSummary,
  formatDiagnosticsBlock,
} from '../src/ea/summary.js';
import club from './fixtures/club-items.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import { readChallenge } from '../src/ea/challenge-reader.js';
import { readClubItems } from '../src/ea/club-reader.js';

const finishedStages = () =>
  DIAGNOSTIC_STAGES.map((id) => ({ id, ok: true, reason: null, detail: null }));

describe('the build marker', () => {
  it('states the compiled build id and the reader-chain ids actually in this build', () => {
    const marker = buildMarker();

    expect(marker.id).toBe(BUILD_ID);
    expect(marker.readers.challenge).toEqual(CHALLENGE_SUBJECT_STRATEGIES.map((entry) => entry.id));
    expect(marker.readers.club).toEqual(CLUB_ITEM_STRATEGIES.map((entry) => entry.id));
    expect(marker.readers.squad).toEqual(CHALLENGE_SQUAD_STRATEGIES.map((entry) => entry.id));
  });

  it('is carried in the diagnostic report and moves with the supplied marker', () => {
    expect(buildDiagnosticsReport(finishedStages()).build).toEqual(buildMarker());

    const moved = { id: 'fsl-build/probe-9', readers: { club: ['one'] } };
    expect(buildDiagnosticsReport(finishedStages(), moved).build).toEqual(moved);
  });

  it('surfaces the build id in the visible read summary line, not only in the JSON', () => {
    const challenge = readChallenge(set10.challenges.find((entry) => entry.challengeId === 25));
    const summary = buildReadSummary({
      challenge,
      clubResult: {
        ok: true,
        items: readClubItems(club),
        strategy: 'services.UTSBCRepository.getClubItems',
        attempts: [],
      },
    });

    expect(summary).toContain(BUILD_ID);
  });

  it('surfaces the build id in the pasted diagnostics block header', () => {
    const report = buildDiagnosticsReport(finishedStages());
    const [header] = formatDiagnosticsBlock(report).split('\n');

    expect(header).toContain(BUILD_ID);
  });
});
