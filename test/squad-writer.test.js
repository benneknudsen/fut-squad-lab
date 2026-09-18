import { describe, expect, it, vi } from 'vitest';

import {
  CHALLENGE_SQUAD_STRATEGIES,
  SQUAD_WRITE_STRATEGIES,
} from '../src/ea/adapter.js';
import club from './fixtures/club-items.json';
import challengeSquadFixture from './fixtures/sbs-challenge-25-squad.json';
import { applySolution, planSquadWrite, writeSolution } from '../src/ea/squad-writer.js';

const rawItems = club.itemData;

const emptyEntry = (index) => ({
  index,
  itemData: {
    id: 0,
    assetId: 0,
    itemType: 'player',
    itemState: 'invalid',
    rating: 0,
  },
});

const clubIndex = new Map(rawItems.map((item) => [item.id, item]));

const solutionFromClub = (start = 0) => ({
  squad: {
    players: rawItems
      .slice(start, start + 11)
      .map((item) => ({ id: item.id, assetId: item.assetId })),
    chemistry: { total: 0 },
  },
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

describe('applySolution', () => {
  it('writes each solved player to its formation slot index and keeps the 23-entry shape', () => {
    const base = challengeSquadFixture;
    const reversed = [...base.squad.players].reverse();
    const challengeSquad = challengeSquadWith(reversed);

    const payload = applySolution(challengeSquad, solutionFromClub(), clubIndex);

    expect(payload.challengeId).toBe(25);
    expect(payload.squad.id).toBe(1);
    expect(payload.squad.formation).toBe('f343');
    expect(payload.squad.manager).toEqual(challengeSquad.squad.manager);
    expect(payload.squad.players).toHaveLength(23);

    // Array order is unchanged; the entry whose formation index is 1 receives
    // slot 1's player even though it sits at the end of the array.
    expect(payload.squad.players).not.toBe(reversed);
    expect(payload.squad.players.map((entry) => entry.index)).toEqual(
      reversed.map((entry) => entry.index)
    );
    for (let slot = 0; slot < 11; slot++) {
      const position = payload.squad.players.findIndex((entry) => entry.index === slot);
      expect(payload.squad.players[position].itemData).toBe(rawItems[slot]);
    }
    for (let position = 0; position < payload.squad.players.length; position++) {
      const entry = payload.squad.players[position];
      if (entry.index > 10) expect(entry).toBe(reversed[position]);
    }
  });

  it('refuses a squad that is not a formation XI instead of placing players at guessed indexes', () => {
    const challengeSquad = challengeSquadWith(
      Array.from({ length: 23 }, (_, index) => emptyEntry(index))
    );
    const partialSolution = { squad: { players: [solutionFromClub().squad.players[0]] } };
    expect(() => applySolution(challengeSquad, partialSolution, clubIndex)).toThrow(/11/);
  });
});

describe('planSquadWrite', () => {
  it('preserves a slot that already holds a player and reports it as preserved', () => {
    const occupiedItem = rawItems[41];
    const players = Array.from({ length: 23 }, (_, index) =>
      index === 3 ? { index, itemData: occupiedItem } : emptyEntry(index)
    );
    const challengeSquad = challengeSquadWith(players);

    const plan = planSquadWrite(challengeSquad, solutionFromClub(), clubIndex);

    const preservedEntry = plan.payload.squad.players.find((entry) => entry.index === 3);
    expect(preservedEntry.itemData).toBe(occupiedItem);
    expect(plan.preserved).toEqual([3]);
    expect(plan.placed).toContain(0);
    expect(plan.placed).not.toContain(3);
    expect(plan.unplaced).toEqual([]);
  });

  it('keeps the existing entry for a concept player with no club record and never synthesises an item', () => {
    const baseEntry = emptyEntry(10);
    const players = Array.from({ length: 23 }, (_, index) =>
      index === 10 ? baseEntry : emptyEntry(index)
    );
    const solution = solutionFromClub();
    solution.squad.players[10] = { id: 987654, assetId: 987654, concept: true };

    const plan = planSquadWrite(challengeSquadWith(players), solution, clubIndex);

    const slotEntry = plan.payload.squad.players.find((entry) => entry.index === 10);
    expect(slotEntry).toBe(baseEntry);
    expect(plan.unplaced).toHaveLength(1);
    expect(plan.unplaced[0]).toMatchObject({ index: 10, id: 987654, concept: true });
    expect(plan.unplaced[0].reason).toMatch(/club item record|synthesise/i);
    expect(plan.placed).not.toContain(10);
    expect(
      plan.payload.squad.players.some((entry) => entry.itemData?.id === 987654)
    ).toBe(false);
  });
});

const createWriteWindow = (services = {}, globals = {}) => ({
  services,
  ...globals,
});

describe('writeSolution', () => {
  it('tries the documented candidate order and reports which strategy answered', async () => {
    const payload = { challengeId: 25, squad: { id: 1 } };
    const saveChallenge = vi.fn(async () => 'saved');
    const pageWindow = createWriteWindow({
      UTSquadBuildingChallengeDAO: { saveChallenge },
    });

    const report = await writeSolution(pageWindow, payload);

    expect(report.ok).toBe(true);
    expect(report.strategy).toBe('services.UTSquadBuildingChallengeDAO.saveChallenge');
    expect(saveChallenge).toHaveBeenCalledWith(payload);
    expect(report.attempts[0]).toEqual({
      id: 'services.UTSquadBuildingChallengeDAO.saveChallenge',
      ok: true,
      reason: null,
    });
    expect(report.attempts).toHaveLength(1);
  });

  it('records a candidate that throws and tries the next one', async () => {
    const payload = { challengeId: 25, squad: { id: 1 } };
    const thrown = new Error('squad does not belong to this challenge');
    const save = vi.fn(async (payload) => `saved ${payload.challengeId}`);
    const pageWindow = createWriteWindow({
      UTSquadBuildingChallengeDAO: {
        saveChallenge: () => {
          throw thrown;
        },
      },
      UTSquadEntity: { save },
    });

    const report = await writeSolution(pageWindow, payload);

    expect(report.ok).toBe(true);
    expect(report.strategy).toBe('services.UTSquadEntity.save');
    expect(report.attempts[0].reason).toBe('threw: squad does not belong to this challenge');
    expect(report.attempts[1].reason).toContain('UTSquadBuildingChallengeDAO');
    expect(report.attempts[2].ok).toBe(true);
    expect(save).toHaveBeenCalledWith(payload);
  });

  it('reports every candidate with a reason when none answers, and never calls submitChallenge', async () => {
    const payload = { challengeId: 25, squad: { id: 1 } };
    const submitChallenge = vi.fn();
    const pageWindow = createWriteWindow({
      UTSquadBuildingChallengeDAO: {
        submitChallenge,
        saveChallenge: () => {
          throw new Error('rejected');
        },
      },
    });

    const report = await writeSolution(pageWindow, payload);

    expect(report.ok).toBe(false);
    expect(report.strategy).toBeNull();
    expect(report.attempts.map((attempt) => attempt.id)).toEqual(
      SQUAD_WRITE_STRATEGIES.map((strategy) => strategy.id)
    );
    for (const attempt of report.attempts) {
      expect(attempt.ok).toBe(false);
      expect(typeof attempt.reason).toBe('string');
      expect(attempt.reason.length).toBeGreaterThan(0);
    }
    expect(report.attempts[0].reason).toBe('threw: rejected');
    expect(submitChallenge).not.toHaveBeenCalled();
    for (const strategy of SQUAD_WRITE_STRATEGIES) {
      expect(strategy.method).not.toMatch(/submit/i);
    }
  });

  it('mutates slots through the first named slot method that exists, then saves', async () => {
    const payload = {
      challengeId: 25,
      squad: {
        id: 1,
        players: [
          { index: 0, itemData: { id: 111 } },
          { index: 1, itemData: { id: 222 } },
        ],
      },
    };
    const slots = payload.squad.players.map((entry) => ({
      index: entry.index,
      setItem: vi.fn(async (itemData) => {
        entry.itemData = itemData;
      }),
    }));
    const save = vi.fn(async () => 'saved');
    const pageWindow = createWriteWindow({
      UTSquadEntity: {
        getSlots: () => slots,
        save,
      },
    });

    const report = await writeSolution(pageWindow, payload);

    expect(report.ok).toBe(true);
    expect(report.strategy).toBe('services.UTSquadEntity.getSlots+save');
    expect(report.slotStrategy).toBe('setItem');
    const plainAttempt = report.attempts.find(
      (attempt) => attempt.id === 'services.UTSquadEntity.save'
    );
    expect(plainAttempt.reason).toMatch(/no.*arguments|takes no arguments/i);
    expect(slots[0].setItem).toHaveBeenCalledWith({ id: 111 });
    expect(slots[1].setItem).toHaveBeenCalledWith({ id: 222 });
    expect(save).toHaveBeenCalledWith(payload);
  });

  it('reports the slot-level candidate when the entity has no named slot mutator', async () => {
    const payload = { challengeId: 25, squad: { id: 1, players: [{ index: 0, itemData: {} }] } };
    const pageWindow = createWriteWindow({
      UTSquadEntity: {
        getSlots: () => [{ index: 0 }],
        save: vi.fn(),
      },
    });

    const report = await writeSolution(pageWindow, payload);

    expect(report.ok).toBe(false);
    const slotAttempt = report.attempts.find((attempt) =>
      attempt.id.endsWith('getSlots+save')
    );
    expect(slotAttempt.reason).toContain('setItemData');
    expect(slotAttempt.reason).toContain('setItem');
  });
});

describe('CHALLENGE_SQUAD_STRATEGIES', () => {
  it('lists unique, frozen candidate paths for finding the challenge squad', () => {
    expect(Object.isFrozen(CHALLENGE_SQUAD_STRATEGIES)).toBe(true);
    for (const strategy of CHALLENGE_SQUAD_STRATEGIES) expect(Object.isFrozen(strategy)).toBe(true);
    const ids = CHALLENGE_SQUAD_STRATEGIES.map((strategy) => strategy.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});