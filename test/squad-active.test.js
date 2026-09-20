import { describe, expect, it } from 'vitest';

import {
  ACTIVE_SQUAD_METHODS,
  CHALLENGE_SQUAD_STRATEGIES,
  resolveChallengeSquad,
} from '../src/ea/adapter.js';

// Issue #51 deliverable 4: when the challenge carries no squad of its own, the
// active squad is requested from the same search view model through the
// observable bridge.

const squadPayload = { challengeId: 25, squad: { id: 1, formation: 'f343', players: [] } };

const observableOf = (payload, state) => ({
  observe(callback) {
    callback({ data: payload, error: null, response: null, status: 200, success: true });
    return {
      unobserve() {
        state.unsubscribed += 1;
      },
    };
  },
});

const neverFires = () => ({
  observe() {
    return { unobserve() {} };
  },
});

const viewModelWith = (method, implementation) => ({ [method]: implementation });

describe('the active squad chain', () => {
  it('ends with the search view model definition-id candidates', () => {
    const ids = CHALLENGE_SQUAD_STRATEGIES.map((entry) => entry.id);
    for (const method of ACTIVE_SQUAD_METHODS) {
      expect(ids.some((id) => id.includes(method))).toBe(true);
    }
  });

  it('subscribes to the active-squad definition-id request through the bridge', async () => {
    const calls = [];
    const state = { unsubscribed: 0 };
    const viewModel = viewModelWith('requestActiveSquadDefinitionIds', (...args) => {
      calls.push(args);
      return observableOf(squadPayload, state);
    });

    const result = await resolveChallengeSquad(
      {},
      { UTBucketedItemSearchViewModel: viewModel }
    );

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(squadPayload);
    expect(result.strategy).toBe(
      'UTBucketedItemSearchViewModel.requestActiveSquadDefinitionIds+observable'
    );
    expect(calls).toEqual([[]]);
    expect(state.unsubscribed).toBe(1);
  });

  it('carries the squad on the loaded challenge payload without a call', async () => {
    const result = await resolveChallengeSquad({}, {}, squadPayload);

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(squadPayload);
    expect(result.strategy).toBe('challenge-load.squad');
  });

  it('errors with a reason per candidate when no active squad can be read', async () => {
    const result = await resolveChallengeSquad({}, { services: {} });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.attempts.map((attempt) => attempt.id)).toEqual(
      CHALLENGE_SQUAD_STRATEGIES.map((entry) => entry.id)
    );
    for (const attempt of result.attempts) {
      expect(attempt.ok).toBe(false);
      expect(attempt.reason.length).toBeGreaterThan(0);
    }
  });

  it('records a method it reached but could not use, with the method shape', async () => {
    function requestActiveSquadDefinitionIds() {
      throw new Error('refused');
    }
    const result = await resolveChallengeSquad(
      {},
      { UTBucketedItemSearchViewModel: { requestActiveSquadDefinitionIds } }
    );
    const attempt = result.attempts.find((entry) =>
      entry.id.includes('requestActiveSquadDefinitionIds')
    );

    expect(attempt.reason).toBe('threw: refused');
    expect(attempt.method.arity).toBe(0);
    expect(attempt.method.excerpt).toContain('requestActiveSquadDefinitionIds');
  });

  it('times out a subscription that never fires instead of hanging', async () => {
    const viewModel = viewModelWith('requestActiveSquadDefinitionIds', () => neverFires());
    const result = await resolveChallengeSquad(
      {},
      { UTBucketedItemSearchViewModel: viewModel },
      null,
      { observableTimeoutMs: 20 }
    );
    const attempt = result.attempts.find((entry) =>
      entry.id.includes('requestActiveSquadDefinitionIds')
    );

    expect(result.ok).toBe(false);
    expect(attempt.reason).toMatch(/timed out/);
  });

  it('rejects a payload that is not a squad and tries the next candidate', async () => {
    const state = { unsubscribed: 0 };
    const viewModel = viewModelWith('requestActiveSquadDefinitionIds', () =>
      observableOf({ definitionIds: [1, 2] }, state)
    );

    const result = await resolveChallengeSquad({}, { UTBucketedItemSearchViewModel: viewModel });

    expect(result.ok).toBe(false);
    const attempt = result.attempts.find((entry) =>
      entry.id.includes('requestActiveSquadDefinitionIds')
    );
    expect(attempt.reason).toMatch(/squad\.players/);
  });
});
