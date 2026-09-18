import { describe, expect, it } from 'vitest';

import { SCOPE_VALUES } from '../src/ea/adapter.js';
import { runSolve } from '../src/ea/solve-runner.js';
import { normaliseClub } from '../src/solver/candidates.js';
import { mergePrices } from '../src/solver/prices.js';
import { OPERATIONS } from '../src/solver/worker-protocol.js';
import club from './fixtures/club-items.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import { SCOPE_VALUES as FIXTURE_SCOPE_VALUES } from './helpers/eligibility.js';

const challenge = set10.challenges.find((entry) => entry.challengeId === 25);
const records = normaliseClub(club.itemData);
const priced = mergePrices(records, null);
const pool = priced.slice(0, 20);
const keys = Object.freeze({ 8: Object.freeze({ type: 'LEAGUE_COUNT', kind: 'LEAGUE_COUNT', role: 'scalar' }) });

const fakeResult = (players) => ({
  squad: { players, chemistry: { total: 0 } },
  cost: 42,
  costComplete: true,
  valid: true,
  failures: [],
  unverified: [],
});

const solveInput = (overrides = {}) => ({
  challenge,
  clubItems: club.itemData,
  externalPrices: null,
  keys,
  scopes: SCOPE_VALUES,
  requestSolve: async () => fakeResult(priced.slice(0, 11)),
  ...overrides,
});

describe('the pinned scope model', () => {
  it('lives in the adapter and the test fixture re-exports the same object', () => {
    expect(SCOPE_VALUES).toEqual({ 0: 'GREATER', 1: 'LOWER', 2: 'EXACT' });
    expect(Object.isFrozen(SCOPE_VALUES)).toBe(true);
    expect(FIXTURE_SCOPE_VALUES).toBe(SCOPE_VALUES);
  });
});

describe('runSolve', () => {
  it('runs normaliseClub, mergePrices, buildPool and solve in the documented order', async () => {
    const order = [];
    const steps = {
      readClubItems: (items) => {
        order.push('normaliseClub');
        expect(items).toBe(club.itemData);
        return records;
      },
      mergePrices: (input, external) => {
        order.push('mergePrices');
        expect(input).toBe(records);
        expect(external).toBeNull();
        return priced;
      },
      buildPool: (input) => {
        order.push('buildPool');
        expect(input).toBe(priced);
        return pool;
      },
    };
    let captured = null;
    const requestSolve = async (operation, payload) => {
      order.push('solve');
      captured = { operation, payload };
      return fakeResult(priced.slice(0, 11));
    };

    const result = await runSolve(solveInput({ requestSolve }), steps);

    expect(order).toEqual(['normaliseClub', 'mergePrices', 'buildPool', 'solve']);
    expect(captured.operation).toBe(OPERATIONS.SOLVE);
    expect(captured.payload.challenge).toBe(challenge);
    expect(captured.payload.pool).toBe(pool);
    expect(captured.payload.options.keys).toBe(keys);
    expect(captured.payload.options.scopes).toBe(SCOPE_VALUES);
    expect(result.cost).toBe(42);
    expect(result.costComplete).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.unverified).toEqual([]);
    expect(result.costCoverage).toEqual({
      known: 11,
      unknown: 0,
      complete: true,
      unknownCards: [],
    });
  });

  it('fails before touching the worker when the live key table is missing', async () => {
    let solveCalled = false;
    const requestSolve = async () => {
      solveCalled = true;
      return fakeResult(priced.slice(0, 11));
    };

    await expect(runSolve(solveInput({ keys: null, requestSolve }))).rejects.toThrow(
      /options\.keys/
    );
    await expect(runSolve(solveInput({ scopes: null, requestSolve }))).rejects.toThrow(
      /options\.scopes/
    );
    expect(solveCalled).toBe(false);
  });

  it('reports a partial cost as incomplete coverage instead of a complete total', async () => {
    const unpriced = mergePrices([{ ...records[0], marketAverage: null, discardValue: null }])[0];
    const players = [...priced.slice(0, 10), unpriced];

    const result = await runSolve(
      solveInput({ requestSolve: async () => fakeResult(players) })
    );

    expect(result.costCoverage).toMatchObject({ known: 10, unknown: 1, complete: false });
    expect(result.costCoverage.unknownCards).toEqual([
      { slot: 10, id: records[0].id, assetId: records[0].assetId },
    ]);
  });

  it('rejects a solver response with no squad instead of reporting a fake success', async () => {
    await expect(
      runSolve(solveInput({ requestSolve: async () => null }))
    ).rejects.toThrow(/no squad/);
  });
});