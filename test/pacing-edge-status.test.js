import { describe, expect, it, vi } from 'vitest';

import {
  ATTEMPT_BUDGETS,
  BACKOFF_BASE_MS,
  CALL_KINDS,
  CHALLENGE_SET_CALL_GAP_MS,
  EDGE_STATUSES,
  MIN_CALL_GAP_MS,
  RATE_LIMIT_STATUSES,
  STAGE_CALL_BUDGETS,
  STAGE_NAMES,
  UPGRADE_REQUIRED_STATUS,
  backoffDelay,
  classifyFailure,
  createPacer,
  gapMsFor,
} from '../src/ea/pacing.js';
import { buildDiagnosticsReport } from '../src/ea/summary.js';

// fsl-build/14 rate-limited Benjamin's own EA account. From about 31 seconds
// into the run EA started rejecting our own calls: sixteen answers across
// 429, 426, 512 and 521, every one of them a `GET /sbs/setId/{id}/challenges`
// from the 22-set walk, and every one of them avoidable by asking for one set.
//
// These tests pin the citizenship half of the fix: 426 is a slow-down, not a
// mystery; an edge error backs off further than a plain 500; the set-challenges
// class gets a longer floor; and the stage budgets are sized for the call
// volume the single-set path actually makes.

const failure = (status, message) => Object.assign(new Error(message), { status });

describe('EA pushing back is classified, not retried by accident', () => {
  it('treats 429 and 426 as the same slow-down condition', () => {
    expect(RATE_LIMIT_STATUSES).toEqual([429, 426]);
    expect(UPGRADE_REQUIRED_STATUS).toBe(426);

    for (const status of RATE_LIMIT_STATUSES) {
      const decision = classifyFailure(failure(status, 'slow down'));
      expect(decision.retry).toBe(true);
      expect(decision.reason).toContain(String(status));
    }
  });

  it('retried a 426 before this build and failed it as undocumented — the defect', () => {
    // fsl-build/14 had no branch for 426, so this fell through to the message
    // pattern. The message EA sends is "Upgrade Required", which carries no
    // rate/limit/throttle wording, so the call was abandoned instead of retried.
    const decision = classifyFailure(failure(426, 'Upgrade Required'));

    expect(decision.retry).toBe(true);
    expect(decision.reason).toMatch(/slow down/i);
  });

  it('backs an edge error off further than a plain server error', () => {
    expect(EDGE_STATUSES).toEqual([512, 521]);

    for (const status of EDGE_STATUSES) {
      const decision = classifyFailure(failure(status, 'edge error'));
      expect(decision.retry).toBe(true);
      expect(decision.backoffScale).toBeGreaterThan(1);
    }
    expect(classifyFailure(failure(500, 'server error')).backoffScale).toBe(1);
    expect(classifyFailure(failure(429, 'rate limited')).backoffScale).toBe(1);
  });

  it('still refuses a rejection it has not reasoned about', () => {
    expect(classifyFailure(failure(400, 'bad request')).retry).toBe(false);
    expect(classifyFailure(failure(403, 'forbidden')).retry).toBe(false);
    expect(classifyFailure(new Error('market item no longer exists')).retry).toBe(false);
  });
});

describe('the set-challenges call class carries its own gap and budget', () => {
  it('gives the set-challenges class a longer floor than a general read', () => {
    expect(CHALLENGE_SET_CALL_GAP_MS).toBeGreaterThan(MIN_CALL_GAP_MS);
    expect(gapMsFor(CALL_KINDS.CHALLENGE_SET)).toBe(CHALLENGE_SET_CALL_GAP_MS);
    expect(gapMsFor(CALL_KINDS.CLUB_PAGE)).toBe(MIN_CALL_GAP_MS);
  });

  it('is at least twice the general gap, because one call per solve now replaces 22', () => {
    expect(CHALLENGE_SET_CALL_GAP_MS).toBeGreaterThanOrEqual(MIN_CALL_GAP_MS * 2);
  });

  it('gives the set class one retry, like every other read', () => {
    expect(ATTEMPT_BUDGETS[CALL_KINDS.CHALLENGE_SET]).toBeGreaterThanOrEqual(2);
  });

  it('waits the longer gap between two set-challenges calls on a real clock', async () => {
    vi.useFakeTimers();
    try {
      const starts = [];
      const pacer = createPacer({
        jitterRatio: 0,
        backoffBaseMs: 0,
        backoffMaxMs: 0,
      });
      const run = (value) =>
        pacer.run(`set ${value}`, async () => {
          starts.push(Date.now());
          return value;
        }, { kind: CALL_KINDS.CHALLENGE_SET });

      const first = run('one');
      await vi.advanceTimersByTimeAsync(CHALLENGE_SET_CALL_GAP_MS);
      await first;
      const second = run('two');
      await vi.advanceTimersByTimeAsync(CHALLENGE_SET_CALL_GAP_MS);
      await second;

      expect(starts[1] - starts[0]).toBe(CHALLENGE_SET_CALL_GAP_MS);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the stage budgets are sized for the single-set call volume', () => {
  it('leaves the bridge a budget for one set call plus the panel-argument fallbacks', () => {
    // The fsl-build/14 run spent a bridge budget of 32 on the walk and then
    // cancelled the club read. The normal path makes one set-challenges call.
    // The exact figure is the assertion: a range would let a regression that cut
    // the bridge to three calls — which is all the walk makes — pass, and the
    // three panel-argument fallbacks would then never fit.
    expect(STAGE_CALL_BUDGETS[STAGE_NAMES.BRIDGE]).toBe(8);
  });

  it('gives the last-resort walk its own stage, so its cost cannot eat the bridge', () => {
    expect(STAGE_NAMES.SET_WALK).toBe('setWalk');
    expect(STAGE_CALL_BUDGETS[STAGE_NAMES.SET_WALK]).toBeGreaterThanOrEqual(22);
    expect(STAGE_CALL_BUDGETS[STAGE_NAMES.SET_WALK]).toBeGreaterThan(
      STAGE_CALL_BUDGETS[STAGE_NAMES.BRIDGE]
    );
  });
});

describe('the observed HTTP statuses are reported', () => {
  it('counts every status a failed call reported', async () => {
    const pacer = createPacer({
      minGapMs: 0,
      submitGapMs: 0,
      challengeSetGapMs: 0,
      jitterRatio: 0,
      backoffBaseMs: 0,
      backoffMaxMs: 0,
      budgets: { challengeSet: 4 },
    });
    const statuses = [426, 521, 426];
    let index = 0;

    const answer = await pacer.run('set challenges', async () => {
      if (index >= statuses.length) return 'accepted';
      throw failure(statuses[index++], 'EA pushed back');
    }, { kind: CALL_KINDS.CHALLENGE_SET });

    expect(answer).toBe('accepted');
    expect(pacer.snapshot().statuses).toEqual({ 426: 2, 521: 1 });
    expect(pacer.snapshot().retries).toBe(3);
  });

  it('reports an empty map when nothing failed', async () => {
    const pacer = createPacer({ minGapMs: 0, submitGapMs: 0, challengeSetGapMs: 0, jitterRatio: 0 });

    await pacer.run('clean', async () => 'ok', { kind: CALL_KINDS.CLUB_PAGE });

    expect(pacer.snapshot().statuses).toEqual({});
  });

  it('backs off an edge error for longer than a plain 500, on a real clock', () => {
    const options = { random: () => 0, jitterRatio: 0 };
    const scale = classifyFailure(failure(521, 'edge')).backoffScale;

    expect(backoffDelay(0, options)).toBe(BACKOFF_BASE_MS);
    expect(scale).toBeGreaterThan(1);
    expect(BACKOFF_BASE_MS * scale).toBeGreaterThan(BACKOFF_BASE_MS);
  });
});
describe('the statuses reach the diagnostics report', () => {
  it('carries the observed statuses through the report, not only the snapshot', () => {
    // A bridge stage that did not finish, so the report stops there and keeps the
    // pacing counters the bridge actually spent.
    const report = buildDiagnosticsReport(
      [{ id: 'bridge', ok: false, reason: 'EA pushed back', detail: null }],
      undefined,
      { calls: 2, waits: 1, retries: 1, waitedMs: 2500, statuses: { 426: 1, 512: 1 }, stages: {} }
    );

    expect(report.pacing.statuses).toEqual({ 426: 1, 512: 1 });
  });
});
