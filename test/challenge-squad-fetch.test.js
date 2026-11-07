import { describe, expect, it } from 'vitest';

import {
  CHALLENGE_SQUAD_STRATEGIES,
  resolveChallengeSquad,
} from '../src/ea/adapter.js';
import { planSquadWrite } from '../src/ea/squad-writer.js';
import challengeSquadFixture from './fixtures/sbs-challenge-18-squad.json';
import club from './fixtures/club-items.json';
import { createTestPacer } from './helpers/pacing.js';

const testPacer = createTestPacer();

const observableOf = (payload) => ({
  observe(subscriber, callback) {
    callback(
      { unobserve() {} },
      { data: payload, error: null, response: null, status: 200, success: true }
    );
    return { unobserve() {} };
  },
});

const strategyIds = () => CHALLENGE_SQUAD_STRATEGIES.map((entry) => entry.id);

const clubIndex = new Map(club.items.map((item) => [item.id, item]));

const solutionFromClub = () => ({
  squad: {
    players: club.items
      .slice(0, 11)
      .map((item) => ({ id: item.id, assetId: item.assetId })),
  },
});

describe('the fetched challenge-squad chain (#131)', () => {
  it('resolves the squad from services.SBC.sbcDAO.loadChallenge through the bridge', async () => {
    const calls = [];
    const dao = {
      loadChallenge(challengeId, isInProgress) {
        calls.push([challengeId, isInProgress]);
        return observableOf({ data: { squad: challengeSquadFixture.squad } });
      },
    };
    const subject = { challengeId: 18, eligibilityRequirements: [], isInProgress: () => true };

    const result = await resolveChallengeSquad(
      subject,
      { services: { SBC: { sbcDAO: dao } } },
      null,
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.SBC.sbcDAO.loadChallenge+subject');
    expect(result.payload.squad.players).toHaveLength(23);
    expect(calls).toEqual([[18, true]]);
  });

  it('falls through to services.SBC.loadChallenge with the subject entity when the DAO is absent', async () => {
    const calls = [];
    const subject = { id: 18, eligibilityRequirements: [] };
    const service = {
      loadChallenge(entity) {
        calls.push(entity);
        return observableOf({ data: { squad: challengeSquadFixture.squad } });
      },
    };

    const result = await resolveChallengeSquad(
      subject,
      { services: { SBC: { loadChallenge: service.loadChallenge.bind(service) } } },
      null,
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.SBC.loadChallenge+subject');
    expect(result.payload.squad.players).toHaveLength(23);
    expect(calls).toEqual([subject]);
    expect(result.attempts.map((attempt) => attempt.id).indexOf(
      'services.SBC.sbcDAO.loadChallenge+subject'
    )).toBeLessThan(strategyIds().indexOf('services.SBC.loadChallenge+subject'));
  });

  it('tries the DAO before the service reader when both are present', async () => {
    const dao = { loadChallenge: () => observableOf({ squad: challengeSquadFixture.squad }) };
    const service = {
      loadChallenge() {
        throw new Error('the service reader must not be reached');
      },
    };

    const result = await resolveChallengeSquad(
      { challengeId: 18, eligibilityRequirements: [] },
      { services: { SBC: { sbcDAO: dao, loadChallenge: service.loadChallenge.bind(service) } } },
      null,
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.SBC.sbcDAO.loadChallenge+subject');
  });

  it('normalises an entity-shaped squad through getPlayers, getItem, isBrick and isLocked', async () => {
    const emptyItem = { id: 0, itemType: 'player', itemState: 'invalid' };
    const populatedItem = { id: 4101, itemType: 'player', itemState: 'valid' };
    const squadEntity = {
      getPlayers() {
        return [
          {
            index: 0,
            getItem: () => emptyItem,
            isBrick: () => false,
            isLocked: () => false,
          },
          {
            getItem: () => populatedItem,
            isBrick: () => true,
            isLocked: () => false,
          },
        ];
      },
    };

    const result = await resolveChallengeSquad(
      {},
      {},
      { challengeId: 18, squad: squadEntity },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('challenge-load.squad');
    expect(result.payload.squad.players).toEqual([
      { index: 0, itemData: emptyItem, brick: false, locked: false },
      { index: 1, itemData: populatedItem, brick: true, locked: false },
    ]);
    expect(result.payload.squad.players[0].itemData.id).toBe(0);
    expect(result.attempts[0].squad).toMatchObject({
      source: 'getPlayers',
      slotCount: 2,
      itemFrom: 'getItem',
      brickFrom: 'isBrick',
      lockedFrom: 'isLocked',
    });
  });

  it('reports one attempt per strategy when neither reader exists', async () => {
    const result = await resolveChallengeSquad(
      { challengeId: 18, eligibilityRequirements: [] },
      { services: {} },
      null,
      { pacer: testPacer }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts.map((attempt) => attempt.id)).toEqual(strategyIds());
    const daoAttempt = result.attempts.find(
      (attempt) => attempt.id === 'services.SBC.sbcDAO.loadChallenge+subject'
    );
    expect(daoAttempt.reason).toMatch(/SBC/);
    expect(daoAttempt.reason).not.toBe('the loaded challenge payload carries no squad.players array');
  });

  it('names the types a fetched payload carried when it holds no squad', async () => {
    const dao = { loadChallenge: () => observableOf({ data: { something: 1 } }) };

    const result = await resolveChallengeSquad(
      { challengeId: 18, eligibilityRequirements: [] },
      { services: { SBC: { sbcDAO: dao } } },
      null,
      { pacer: testPacer }
    );

    expect(result.ok).toBe(false);
    const attempt = result.attempts.find(
      (entry) => entry.id === 'services.SBC.sbcDAO.loadChallenge+subject'
    );
    expect(attempt.reason).toContain('something: number');
    expect(attempt.reason).toContain('squad.players');
  });

  it('calls the DAO with the challenge id, never the set id, when the panel subject is the set', async () => {
    const calls = [];
    const dao = {
      loadChallenge(challengeId, isInProgress) {
        calls.push([challengeId, isInProgress]);
        return observableOf({ data: { squad: challengeSquadFixture.squad } });
      },
    };
    const subject = { id: 6, challenges: {} };
    const loadedChallenge = { challengeId: 18, eligibilityRequirements: [] };

    const result = await resolveChallengeSquad(
      subject,
      { services: { SBC: { sbcDAO: dao } } },
      loadedChallenge,
      { pacer: testPacer }
    );

    expect(calls).toEqual([[18, false]]);
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.SBC.sbcDAO.loadChallenge+subject');
    expect(result.payload.challengeId).toBe(18);
    expect(result.payload.squad.players).toHaveLength(23);
  });

  it('stamps the load identity on a data.squad payload that carries no challengeId', async () => {
    const loadedPayload = { data: { squad: { players: challengeSquadFixture.squad.players } } };

    const result = await resolveChallengeSquad(
      { challengeId: 18, eligibilityRequirements: [] },
      {},
      loadedPayload,
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('challenge-load.squad');
    expect(result.payload.challengeId).toBe(18);
    expect(result.payload.squad.players).toHaveLength(23);
    expect(() =>
      planSquadWrite(result.payload, solutionFromClub(), clubIndex)
    ).not.toThrow();
  });

  it('wraps a direct squad payload into the writer shape with the load identity', async () => {
    const loadedPayload = {
      formation: 'f41212',
      players: challengeSquadFixture.squad.players,
    };

    const result = await resolveChallengeSquad(
      { challengeId: 18, eligibilityRequirements: [] },
      {},
      loadedPayload,
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('challenge-load.squad');
    expect(result.payload.challengeId).toBe(18);
    expect(result.payload.squad.players).toHaveLength(23);
    expect(result.payload.squad.formation).toBe('f41212');
    expect(() =>
      planSquadWrite(result.payload, solutionFromClub(), clubIndex)
    ).not.toThrow();
  });

  it('preserves an entity squad\'s own fields when adding getPlayers slots', async () => {
    const squadEntity = {
      id: 1,
      formation: 'f41212',
      rating: 14,
      chemistry: 0,
      manager: [],
      getPlayers() {
        return challengeSquadFixture.squad.players.map((entry) => ({
          index: entry.index,
          getItem: () => entry.itemData,
        }));
      },
    };

    const result = await resolveChallengeSquad(
      {},
      {},
      { challengeId: 18, squad: squadEntity },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(true);
    expect(result.payload.challengeId).toBe(18);
    expect(result.payload.squad.id).toBe(1);
    expect(result.payload.squad.formation).toBe('f41212');
    expect(result.payload.squad.rating).toBe(14);
    expect(result.payload.squad.chemistry).toBe(0);
    expect(result.payload.squad.manager).toEqual([]);
    expect(result.payload.squad.players).toHaveLength(23);
    expect(() =>
      planSquadWrite(result.payload, solutionFromClub(), clubIndex)
    ).not.toThrow();
  });

  it('says getPlayers returned something unusable instead of implying absence', async () => {
    const squadEntity = { getPlayers: () => ({ not: 'slots' }) };

    const result = await resolveChallengeSquad(
      {},
      {},
      { challengeId: 18, squad: squadEntity },
      { pacer: testPacer }
    );

    expect(result.ok).toBe(false);
    expect(result.attempts[0].reason).toContain('getPlayers() returned');
    expect(result.attempts[0].reason).not.toContain('no getPlayers method');
  });
});

describe('the fetched squad fixture feeds the existing writer', () => {
  it('carries 23 slots, preserves the populated one and fills an empty one', () => {
    expect(challengeSquadFixture.squad.players).toHaveLength(23);

    const plan = planSquadWrite(challengeSquadFixture, solutionFromClub(), clubIndex);

    expect(plan.payload.squad.players).toHaveLength(23);
    const preservedEntry = plan.payload.squad.players.find((entry) => entry.index === 7);
    expect(preservedEntry.itemData).toBe(challengeSquadFixture.squad.players[7].itemData);
    expect(preservedEntry.itemData.id).toBe(4101);
    expect(plan.preserved).toContain(7);
    expect(plan.placed).toContain(0);
    const filledEntry = plan.payload.squad.players.find((entry) => entry.index === 0);
    expect(filledEntry.itemData).toBe(club.items[0]);
  });
});
