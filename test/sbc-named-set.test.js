import { describe, expect, it } from 'vitest';

import { loadChallengePayload, resolveChallengeSubject } from '../src/ea/adapter.js';
import { readChallenge } from '../src/ea/challenge-reader.js';
import set16 from './fixtures/sbs-set-16-challenges.json';
import { createTestPacer } from './helpers/pacing.js';

// fsl-build/14 walked all 22 SBC sets from the hub to reach the challenge the
// panel had already named, and EA rate-limited Benjamin's own account: the
// network capture of that run holds sixteen 429/426/512/521 answers to
// `GET /sbs/setId/{id}/challenges`, all after the first few successes. The
// panel's first argument *is* the set, and the capture proves the panel named
// set 16's challenge 37 while its second argument named 37.
//
// These tests pin the fix: a panel argument carrying a set id must cost exactly
// one `requestChallengesForSet` call for that set, matched by `challengeId`, and
// the walk must not run at all. The call count is the assertion that matters —
// a test that only checked the resulting requirements would pass with the walk
// still in place.

const observableOf = (payload) => ({
  observe(subscriber, callback) {
    callback(
      { unobserve() {} },
      { data: null, error: null, response: payload, status: 200, success: true }
    );
    return { unobserve() {} };
  },
});

const namedEntry = (challengeId) => set16.challenges.find((entry) => entry.challengeId === challengeId);

/**
 * A page whose SBC service counts every set-challenges request and reports the
 * sets it was handed, so a test can prove both how many calls ran and which set
 * each one was for.
 */
const countedSbc = ({ payload = set16, listing = () => ({ challenges: payload.challenges }) } = {}) => {
  const calls = [];
  return {
    calls,
    service: {
      requestSets() {
        calls.push({ method: 'requestSets', set: null });
        return observableOf({
          sets: Array.from({ length: 22 }, (unused, index) => ({
            id: index + 1,
            getChallenges: () => [],
          })),
        });
      },
      requestChallengesForSet(set) {
        calls.push({ method: 'requestChallengesForSet', set });
        return observableOf(listing(set));
      },
      loadChallenge() {
        calls.push({ method: 'loadChallenge', set: null });
        throw new Error('a challenge with its own elgReq must not be loaded');
      },
    },
  };
};

const panelSet = (id) => ({ id, challenges: {}, challengesCount: 1, name: 'a set' });

const readViaBridge = async (pageWindow, subject, panelContext) => {
  const subjectResult = resolveChallengeSubject(subject, pageWindow, panelContext);
  return loadChallengePayload(pageWindow, subjectResult, { pacer: createTestPacer() });
};

describe('the named set is fetched with one request (#115)', () => {
  it('reads the set-challenges payload of the panel set, matched by challengeId', async () => {
    const subject = panelSet(16);
    const { calls, service } = countedSbc();

    const result = await readViaBridge({ services: { SBC: service } }, subject, { challengeId: 37 });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(namedEntry(37));
    expect(calls.filter((call) => call.method === 'requestChallengesForSet')).toHaveLength(1);
    expect(calls[0].set).toBe(subject);
    const challenge = readChallenge(result.payload);
    expect(challenge.challengeId).toBe(37);
    expect(challenge.requirementsFrom).toBe('payload.elgReq');
  });

  it('never calls requestSets, so the run costs one EA call in total', async () => {
    const subject = panelSet(16);
    const { calls, service } = countedSbc();
    const pacer = createTestPacer();

    const subjectResult = resolveChallengeSubject(subject, { services: { SBC: service } }, {
      challengeId: 37,
    });
    const result = await loadChallengePayload(
      { services: { SBC: service } },
      subjectResult,
      { pacer }
    );

    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.method)).toEqual(['requestChallengesForSet']);
    expect(calls.filter((call) => call.method === 'requestSets')).toHaveLength(0);
    expect(pacer.snapshot().calls).toBe(1);
  });

  it('reports the panel set id and the set it read, so a report shows one set, not 22', async () => {
    const subject = panelSet(16);
    const { service } = countedSbc();

    const result = await readViaBridge({ services: { SBC: service } }, subject, { challengeId: 37 });

    const attempt = result.attempts[0];
    expect(attempt.ok).toBe(true);
    expect(attempt.setId).toBe(16);
    expect(attempt.sets).toBe(1);
    expect(attempt.selection).toMatchObject({ ok: true, sets: 1, chosenId: 37, seen: 4 });
  });

  it('never opens the set-walk pacing stage, so a report cannot show a walked set', async () => {
    const subject = panelSet(16);
    const { calls, service } = countedSbc();
    const pacer = createTestPacer();

    const subjectResult = resolveChallengeSubject(subject, { services: { SBC: service } }, {
      challengeId: 37,
    });
    const result = await loadChallengePayload({ services: { SBC: service } }, subjectResult, {
      pacer,
    });

    expect(result.ok).toBe(true);
    expect(result.attempts.map((attempt) => attempt.id)).toEqual([
      'services.SBC.requestChallengesForSet+namedSet',
    ]);
    expect(calls.filter((call) => call.method === 'requestSets')).toHaveLength(0);
    expect(pacer.snapshot().stages.bridge).toEqual({ calls: 1, budget: 8 });
    expect(pacer.snapshot().stages.setWalk).toBeUndefined();
  });

  it('records the walk as refused when the named-set read fails, with the reason', async () => {
    const subject = panelSet(16);
    const { service } = countedSbc({ payload: { challenges: [] } });

    const result = await readViaBridge({ services: { SBC: service } }, subject, { challengeId: 37 });

    expect(result.ok).toBe(false);
    const walk = result.attempts.find((attempt) => attempt.id.startsWith('services.SBC.requestSets'));
    expect(walk.ok).toBe(false);
    expect(walk.sets).toBe(0);
    expect(walk.reason).toMatch(/named set 16/);
    expect(walk.reason).toMatch(/walk/i);
  });

  it('picks the entry the panel named, not the first entry in the payload', async () => {
    const subject = panelSet(16);
    const { service } = countedSbc();

    const first = await readViaBridge({ services: { SBC: service } }, subject, { challengeId: 35 });
    const last = await readViaBridge({ services: { SBC: service } }, subject, { challengeId: 39 });

    expect(first.payload).toBe(namedEntry(35));
    expect(last.payload).toBe(namedEntry(39));
    expect(last.payload).not.toBe(set16.challenges[0]);
  });
});

describe('a payload without the named challenge fails loudly (#115)', () => {
  it('refuses the whole read and selects nothing when no entry carries the id', async () => {
    const subject = panelSet(16);
    const { calls, service } = countedSbc();

    const result = await readViaBridge({ services: { SBC: service } }, subject, { challengeId: 4242 });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(calls.filter((call) => call.method === 'requestChallengesForSet')).toHaveLength(1);
    const attempt = result.attempts[0];
    expect(attempt.ok).toBe(false);
    expect(attempt.selection).toMatchObject({ ok: false, seen: 4, chosenId: 4242, sets: 1 });
    expect(attempt.reason).toMatch(/4242/);
    expect(attempt.reason).toMatch(/refusing to select another/i);
  });

  it('names the location the panel set id was read from, in the subject attempt', () => {
    const subject = panelSet(16);

    const subjectResult = resolveChallengeSubject(subject, { services: {} }, { challengeId: 37 });

    expect(subjectResult.selectedSetId).toBe(16);
    expect(subjectResult.selectedChallengeId).toBe(37);
    const panel = subjectResult.attempts[0];
    expect(panel.locations.map((location) => location.id)).toContain('panel-argument.id');
    expect(panel.locations.find((location) => location.id === 'panel-argument.id')).toEqual({
      id: 'panel-argument.id',
      ok: true,
      reason: null,
    });
  });

  it('reports a set id it could not read, and never falls back to a guessed one', () => {
    const subject = { challenges: {} };

    const subjectResult = resolveChallengeSubject(subject, { services: {} }, { challengeId: 37 });

    expect(subjectResult.selectedSetId).toBeNull();
    const setId = subjectResult.attempts[0].locations.find(
      (location) => location.id === 'panel-argument.id'
    );
    expect(setId.ok).toBe(false);
    expect(setId.reason).toMatch(/id/);
  });

  it('walks the sets only when the panel argument named no set, and says so', async () => {
    const subject = { challenges: {} };
    const { calls, service } = countedSbc();

    const result = await readViaBridge({ services: { SBC: service } }, subject, { challengeId: 37 });

    expect(result.ok).toBe(false);
    expect(calls.filter((call) => call.method === 'requestChallengesForSet')).toHaveLength(22);
    const walk = result.attempts[0];
    expect(walk.id).toBe('services.SBC.requestSets+requestChallengesForSet+getChallenges');
    expect(walk.reason).toMatch(/no set id/);
    expect(walk.reason).toMatch(/last-resort/i);
  });
});
