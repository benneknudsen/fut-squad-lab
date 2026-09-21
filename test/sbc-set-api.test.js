import { describe, expect, it } from 'vitest';

import {
  CHALLENGE_LOAD_STRATEGIES,
  loadChallengePayload,
  selectOpenChallenge,
} from '../src/ea/adapter.js';
import { createTestPacer } from './helpers/pacing.js';

const testPacer = createTestPacer();

// Issue #72: the fsl-build/9 live run proved the panel hook carries no
// requirements, and the reference reads the challenge through EA's SBC set API
// instead: requestSets -> requestChallengesForSet -> set.getChallenges() -> an
// open challenge -> loadChallenge. These tests pin that call chain, the
// arguments each load branch receives and the deterministic selection rule. The
// panel argument stays as a reported fallback behind it.

const observableOf = (payload) => ({
  observe(subscriber, callback) {
    callback(
      { unobserve() {} },
      { data: null, error: null, response: payload, status: 200, success: true }
    );
    return { unobserve() {} };
  },
});

const loadedPayload = {
  challengeId: 25,
  name: '3 Leagues & 2 Nations',
  formation: 'f343',
  elgOperation: 'AND',
  elgReq: [{ type: 'LEAGUE_COUNT', eligibilitySlot: 1, eligibilityKey: 8, eligibilityValue: 3 }],
};

const emptySubject = { ok: false, payload: null, strategy: null, attempts: [] };

const challengeEntity = ({ id, completed = false, inProgress = false, onLoad }) => ({
  id,
  isCompleted() {
    if (completed === 'throw') throw new Error('isCompleted exploded');
    return completed;
  },
  isInProgress() {
    return inProgress;
  },
  onLoad,
});

describe('the challenge is read through the SBC set API (#72)', () => {
  it('walks requestSets -> requestChallengesForSet -> getChallenges, then loads the open challenge', async () => {
    const localPacer = createTestPacer();
    const calls = [];
    const entity = challengeEntity({ id: 25 });
    const set = {
      id: 10,
      getChallenges() {
        calls.push('getChallenges');
        return [entity];
      },
    };
    const pageWindow = {
      services: {
        SBC: {
          requestSets() {
            calls.push('requestSets');
            return observableOf({ sets: [set] });
          },
          requestChallengesForSet(received) {
            calls.push('requestChallengesForSet');
            expect(received).toBe(set);
            return observableOf({ challenges: [] });
          },
          loadChallenge(received) {
            calls.push('loadChallenge');
            expect(received).toBe(entity);
            return observableOf(loadedPayload);
          },
        },
      },
    };

    const result = await loadChallengePayload(pageWindow, emptySubject, { pacer: localPacer });

    expect(CHALLENGE_LOAD_STRATEGIES[0].id).toBe(
      'services.SBC.requestSets+requestChallengesForSet+getChallenges'
    );
    expect(result.ok).toBe(true);
    expect(result.payload).toBe(loadedPayload);
    expect(result.strategy).toBe(
      'services.SBC.requestSets+requestChallengesForSet+getChallenges'
    );
    expect(calls).toEqual(['requestSets', 'requestChallengesForSet', 'getChallenges', 'loadChallenge']);
    expect(localPacer.snapshot().calls).toBe(3);
    expect(result.attempts[0]).toMatchObject({
      id: 'services.SBC.requestSets+requestChallengesForSet+getChallenges',
      ok: true,
      reason: null,
    });
    expect(result.attempts[0].selection).toMatchObject({
      sets: 1,
      seen: 1,
      open: 1,
      chosenId: 25,
      inProgress: false,
    });
  });

  it('prefers sbcDAO.loadChallenge(id, inProgress) when it exists and the entity carries an id', async () => {
    const received = [];
    const entity = challengeEntity({ id: 25, inProgress: true });
    const set = { id: 10, getChallenges: () => [entity] };
    const pageWindow = {
      services: {
        SBC: {
          sbcDAO: {
            loadChallenge(...args) {
              received.push(args);
              return observableOf(loadedPayload);
            },
          },
          requestSets: () => observableOf({ sets: [set] }),
          requestChallengesForSet: () => observableOf({}),
          loadChallenge() {
            throw new Error('the entity branch must not run when the DAO answers');
          },
        },
      },
    };

    const result = await loadChallengePayload(pageWindow, emptySubject, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(received).toEqual([[25, true]]);
  });

  it('falls back to services.SBC.loadChallenge(entity) and passes the entity itself', async () => {
    const received = [];
    const entity = challengeEntity({ id: 25, inProgress: false });
    const set = { id: 10, getChallenges: () => [entity] };
    const pageWindow = {
      services: {
        SBC: {
          requestSets: () => observableOf({ sets: [set] }),
          requestChallengesForSet: () => observableOf({}),
          loadChallenge(...args) {
            received.push(args);
            return observableOf(loadedPayload);
          },
        },
      },
    };

    const result = await loadChallengePayload(pageWindow, emptySubject, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0][0]).toBe(entity);
    expect(received[0][0]).not.toBe(25);
  });

  it('writes the loaded squad back onto the challenge entity when it has none', async () => {
    const entity = challengeEntity({ id: 25 });
    const set = { id: 10, getChallenges: () => [entity] };
    const squad = { id: 1, players: [] };
    const pageWindow = {
      services: {
        SBC: {
          requestSets: () => observableOf({ sets: [set] }),
          requestChallengesForSet: () => observableOf({}),
          loadChallenge: () => observableOf({ ...loadedPayload, squad }),
        },
      },
    };

    const result = await loadChallengePayload(pageWindow, emptySubject, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(entity.squad).toBe(squad);
  });
});

describe('the open-challenge selection rule (#72)', () => {
  it('never picks a completed challenge', () => {
    const completed = challengeEntity({ id: 1, completed: true, inProgress: true });
    const open = challengeEntity({ id: 2 });

    const selection = selectOpenChallenge([completed, open]);

    expect(selection.ok).toBe(true);
    expect(selection.challenge).toBe(open);
    expect(selection.seen).toBe(2);
    expect(selection.open).toBe(1);
    expect(selection.reason).toContain('2');
  });

  it('prefers the in-progress challenge among several open ones', () => {
    const firstOpen = challengeEntity({ id: 1 });
    const inProgress = challengeEntity({ id: 3, inProgress: true });

    const selection = selectOpenChallenge([firstOpen, inProgress]);

    expect(selection.challenge).toBe(inProgress);
    expect(selection.inProgress).toBe(true);
    expect(selection.open).toBe(2);
    expect(selection.reason).toContain('3');
  });

  it('treats an isCompleted() that throws as open, as the reference does', () => {
    const throwing = challengeEntity({ id: 7, completed: 'throw' });

    const selection = selectOpenChallenge([throwing]);

    expect(selection.ok).toBe(true);
    expect(selection.challenge).toBe(throwing);
  });

  it('returns null and a diagnostic carrying the counts when no challenge is open', async () => {
    const selection = selectOpenChallenge([
      challengeEntity({ id: 1, completed: true }),
      challengeEntity({ id: 2, completed: true }),
    ]);

    expect(selection.ok).toBe(false);
    expect(selection.challenge).toBeNull();
    expect(selection.seen).toBe(2);
    expect(selection.open).toBe(0);
    expect(selection.reason).toMatch(/saw 2 challenges/);
    expect(selection.reason).toMatch(/none/);

    const set = { id: 10, getChallenges: () => [challengeEntity({ id: 1, completed: true })] };
    const pageWindow = {
      services: {
        SBC: {
          requestSets: () => observableOf({ sets: [set] }),
          requestChallengesForSet: () => observableOf({}),
        },
      },
    };

    const result = await loadChallengePayload(pageWindow, emptySubject, { pacer: testPacer });

    expect(result.ok).toBe(false);
    expect(result.attempts[0].reason).toMatch(/saw 1 challenges/);
    expect(result.attempts[0].selection).toMatchObject({ seen: 1, open: 0, chosenId: null });
  });

  it('reports the counts and the chosen challenge in the attempt the diagnostic prints', async () => {
    const entity = challengeEntity({ id: 25, inProgress: true });
    const set = { id: 10, getChallenges: () => [challengeEntity({ id: 9, completed: true }), entity] };
    const pageWindow = {
      services: {
        SBC: {
          requestSets: () => observableOf({ sets: [set] }),
          requestChallengesForSet: () => observableOf({}),
          loadChallenge: () => observableOf(loadedPayload),
        },
      },
    };

    const result = await loadChallengePayload(pageWindow, emptySubject, { pacer: testPacer });

    expect(result.attempts[0].selection).toMatchObject({
      sets: 1,
      seen: 2,
      open: 1,
      chosenId: 25,
      inProgress: true,
    });
  });
});
