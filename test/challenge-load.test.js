import { describe, expect, it } from 'vitest';

import {
  CHALLENGE_LOAD_STRATEGIES,
  loadChallengePayload,
} from '../src/ea/adapter.js';
import { createTestPacer } from './helpers/pacing.js';

const testPacer = createTestPacer();

// Issue #51: the challenge is loaded through an observable — the primary call
// is `services.SBC.loadChallenge(challenge)`, the recorded fallback is the DAO
// variant taking the challenge id, and the payload the panel argument already
// carried is the last resort. No argument list whose contents are unknown is
// invented.

const challenge = {
  challengeId: 25,
  name: '3 Leagues & 2 Nations',
  formation: 'f343',
  elgOperation: 'AND',
  elgReq: [{ type: 'LEAGUE_COUNT', eligibilitySlot: 1, eligibilityKey: 8, eligibilityValue: 3 }],
};

const subjectResult = { ok: true, payload: challenge, strategy: 'panel-argument', attempts: [] };

const observableOf = (event, state = { unsubscribed: 0 }) => ({
  observe(callback) {
    callback(event);
    return {
      unobserve() {
        state.unsubscribed += 1;
      },
    };
  },
  state,
});

const neverFires = () => ({
  observe() {
    return { unobserve() {} };
  },
});

const responseOf = (payload) => observableOf({ data: null, response: payload, status: 200, success: true });

describe('CHALLENGE_LOAD_STRATEGIES', () => {
  it('starts with loadChallenge on the subject and records the DAO id fallback', () => {
    expect(CHALLENGE_LOAD_STRATEGIES[0].id).toBe('services.SBC.loadChallenge+subject');
    expect(CHALLENGE_LOAD_STRATEGIES.some((entry) => entry.id === 'services.SBC.loadChallenge')).toBe(
      true
    );
    expect(CHALLENGE_LOAD_STRATEGIES.some((entry) => entry.id === 'services.SBC.sbcDAO.loadChallenge+id')).toBe(
      true
    );
    expect(Object.isFrozen(CHALLENGE_LOAD_STRATEGIES)).toBe(true);
    const ids = CHALLENGE_LOAD_STRATEGIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('loadChallengePayload', () => {
  it('loads through services.SBC.loadChallenge with the resolved subject', async () => {
    const received = [];
    const loaded = { ...challenge, name: 'Loaded' };
    const pageWindow = {
      services: {
        SBC: {
          loadChallenge(...args) {
            received.push(args);
            return responseOf(loaded);
          },
        },
      },
    };

    const result = await loadChallengePayload(pageWindow, subjectResult, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(loaded);
    expect(result.strategy).toBe('services.SBC.loadChallenge+subject');
    expect(received).toEqual([[challenge]]);
    expect(result.attempts[0]).toMatchObject({
      id: 'services.SBC.loadChallenge+subject',
      ok: true,
      reason: null,
    });
    expect(result.attempts[0].method.arity).toBeDefined();
  });

  it('accepts a loaded payload whose requirements live under eligibilityRequirements', async () => {
    const { elgReq, ...rest } = challenge;
    const loaded = { ...rest, eligibilityRequirements: elgReq };
    const pageWindow = {
      services: { SBC: { loadChallenge: () => responseOf(loaded) } },
    };

    const result = await loadChallengePayload(pageWindow, subjectResult, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(loaded);
  });

  it('falls back to services.SBC.sbcDAO.loadChallenge with the challenge id only', async () => {
    const received = [];
    const loaded = { ...challenge, name: 'DAO loaded' };
    const pageWindow = {
      services: {
        SBC: {
          sbcDAO: {
            loadChallenge(...args) {
              received.push(args);
              return responseOf(loaded);
            },
          },
        },
      },
    };

    const result = await loadChallengePayload(pageWindow, subjectResult, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.SBC.sbcDAO.loadChallenge+id');
    expect(received).toEqual([[25]]);
    const first = result.attempts.find((attempt) => attempt.id === 'services.SBC.loadChallenge+subject');
    expect(first.reason).toContain('loadChallenge');
  });

  it('calls loadChallenge with no arguments when the panel carried no subject', async () => {
    const received = [];
    const pageWindow = {
      services: {
        SBC: {
          loadChallenge(...args) {
            received.push(args);
            return responseOf(challenge);
          },
        },
      },
    };
    const emptySubject = { ok: false, payload: null, strategy: null, attempts: [] };

    const result = await loadChallengePayload(pageWindow, emptySubject, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.SBC.loadChallenge');
    expect(received).toEqual([[]]);
    expect(result.attempts[0].reason).toMatch(/no challenge payload/);
  });

  it('falls back to the panel payload the subject already carried', async () => {
    const result = await loadChallengePayload({ services: {} }, subjectResult, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(challenge);
    expect(result.strategy).toBe('subject.payload');
    const failing = result.attempts.filter((attempt) => !attempt.ok);
    expect(failing.length).toBeGreaterThan(0);
    for (const attempt of failing) expect(attempt.reason.length).toBeGreaterThan(0);
  });

  it('records a throwing loadChallenge and keeps going', async () => {
    const pageWindow = {
      services: {
        SBC: {
          loadChallenge() {
            throw new Error('challenge argument rejected');
          },
        },
      },
    };

    const result = await loadChallengePayload(pageWindow, subjectResult, { pacer: testPacer });

    expect(result.strategy).toBe('subject.payload');
    const attempt = result.attempts.find((entry) => entry.id === 'services.SBC.loadChallenge+subject');
    expect(attempt.reason).toBe('threw: challenge argument rejected');
  });

  it('records a wrong-shaped load result without inventing a payload', async () => {
    const pageWindow = {
      services: { SBC: { loadChallenge: () => ({ pagination: {} }) } },
    };

    const result = await loadChallengePayload(pageWindow, subjectResult, { pacer: testPacer });

    expect(result.strategy).toBe('subject.payload');
    const attempt = result.attempts.find((entry) => entry.id === 'services.SBC.loadChallenge+subject');
    expect(attempt.reason).toMatch(/requirements|returned/i);
  });

  it('times out a subscription that never fires and falls back', async () => {
    const pageWindow = {
      services: { SBC: { loadChallenge: () => neverFires() } },
    };

    const result = await loadChallengePayload(pageWindow, subjectResult, {
      observableTimeoutMs: 20,
      pacer: testPacer,
    });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('subject.payload');
    const attempt = result.attempts.find((entry) => entry.id === 'services.SBC.loadChallenge+subject');
    expect(attempt.reason).toMatch(/timed out/);
  });

  it('fails with a reason per attempt when nothing can load the challenge', async () => {
    const emptySubject = { ok: false, payload: null, strategy: null, attempts: [] };

    const result = await loadChallengePayload({ services: {} }, emptySubject, { pacer: testPacer });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.strategy).toBeNull();
    expect(result.attempts.map((attempt) => attempt.id)).toEqual(
      CHALLENGE_LOAD_STRATEGIES.map((entry) => entry.id)
    );
    for (const attempt of result.attempts) {
      expect(attempt.ok).toBe(false);
      expect(attempt.reason.length).toBeGreaterThan(0);
    }
  });
});
