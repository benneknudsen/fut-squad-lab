import { describe, expect, it, vi } from 'vitest';

import club from './fixtures/club-items.json';
import {
  CHALLENGE_SQUAD_STRATEGIES,
  CHALLENGE_SUBJECT_STRATEGIES,
  CLUB_ITEM_STRATEGIES,
  resolveChallengeSquad,
  resolveChallengeSubject,
  resolveClubItems,
} from '../src/ea/adapter.js';
import { readClubItems } from '../src/ea/club-reader.js';
import { createTestPacer } from './helpers/pacing.js';

const testPacer = createTestPacer();

// Issue #48: the live shape report proved every EA global exists but that the
// instances live under `services.<Domain>`, not at `services.<ClassName>`. The
// club read is `services.Club.clubDao.getClubItems`; the challenge and squad
// reads additionally have the `services.SBC` / `services.Squad` containers to
// try. These tests pin the instance-first chains; they cannot prove the live
// page answers, only that the chain reaches the instances the report named.

const challenge = {
  challengeId: 25,
  name: '3 Leagues & 2 Nations',
  formation: 'f343',
  elgOperation: 'AND',
  elgReq: [],
};

const challengeSquad = { challengeId: 25, squad: { id: 1, players: [] } };

describe('the club chain reaches the live service instances', () => {
  it('reaches services.Club.clubDao through the instance, never the window class', async () => {
    const daoGet = vi.fn(() => ({ items: [{ id: 1 }] }));
    const legacyGet = vi.fn(() => ({ items: [{ id: 2 }] }));
    function UTSBCRepository() {}
    UTSBCRepository.prototype.getClubItems = vi.fn(() => ({ items: [{ id: 3 }] }));

    const pageWindow = {
      services: {
        Club: { clubDao: { getClubItems: daoGet } },
        UTSBCRepository: { getClubItems: legacyGet },
      },
      UTSBCRepository,
    };

    const result = await resolveClubItems(pageWindow, { pacer: testPacer });

    expect(result.strategy).toBe('services.Club.clubDao.getClubItems');
    expect(daoGet).toHaveBeenCalledTimes(1);
    expect(legacyGet).not.toHaveBeenCalled();
    expect(UTSBCRepository.prototype.getClubItems).not.toHaveBeenCalled();
  });

  it('carries clubDao items through the normaliser into stable records', async () => {
    const pageWindow = {
      services: { Club: { clubDao: { getClubItems: async () => ({ items: club.items }) } } },
    };

    const result = await resolveClubItems(pageWindow, { pacer: testPacer });
    const records = readClubItems(result.items);

    expect(result.ok).toBe(true);
    expect(records).toHaveLength(club.items.length);
    expect(records[0]).toMatchObject({ id: 116927068448054, preferredPosition: 'CAM' });
  });

  it('reports one {id, ok, reason} record per strategy, in order', async () => {
    const result = await resolveClubItems({ services: {} }, { pacer: testPacer });

    expect(result.attempts.map((attempt) => attempt.id)).toEqual(
      CLUB_ITEM_STRATEGIES.map((strategy) => strategy.id)
    );
    for (const attempt of result.attempts) {
      expect(Object.keys(attempt).sort()).toEqual(['id', 'ok', 'reason']);
      expect(attempt.ok).toBe(false);
      expect(attempt.reason.length).toBeGreaterThan(0);
    }
  });

  it('refuses the window class as a constructor, not an instance', async () => {
    function UTSBCRepository() {}
    UTSBCRepository.prototype.getClubItems = vi.fn();

    const result = await resolveClubItems({ services: {}, UTSBCRepository }, { pacer: testPacer });
    const attempt = result.attempts.find(
      (entry) => entry.id === 'window.UTSBCRepository.getClubItems'
    );

    expect(attempt.reason).toMatch(/constructor, not an instance/);
    expect(UTSBCRepository.prototype.getClubItems).not.toHaveBeenCalled();
  });
});

describe('the challenge and squad chains reach the live service containers', () => {
  it('reads the challenge from services.SBC.repository.challenge when the panel argument carries none', () => {
    const pageWindow = { services: { SBC: { repository: { challenge } } } };

    const result = resolveChallengeSubject({ data: {} }, pageWindow);

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.SBC.repository.challenge');
    expect(result.payload).toBe(challenge);
  });

  it('keeps one attempt per challenge strategy and explains the missing services path', () => {
    const result = resolveChallengeSubject({}, { services: { SBC: {}, Squad: {} } });

    expect(result.ok).toBe(false);
    expect(result.attempts.map((attempt) => attempt.id)).toEqual(
      CHALLENGE_SUBJECT_STRATEGIES.map((strategy) => strategy.id)
    );
    const repositoryAttempt = result.attempts.find(
      (attempt) => attempt.id === 'services.SBC.repository.challenge'
    );
    expect(repositoryAttempt.reason).toContain('SBC.repository');
  });

  it('reads the challenge squad from services.Squad.activeSquad when the panel argument carries none', async () => {
    const pageWindow = { services: { Squad: { activeSquad: challengeSquad } } };

    // The squad chain now ends with bridged view-model methods, so it resolves
    // through a promise like the club chain.
    const result = await resolveChallengeSquad({}, pageWindow, null, { pacer: testPacer });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.Squad.activeSquad');
    expect(result.payload).toBe(challengeSquad);
  });

  it('keeps one attempt per squad strategy and a reason for every one', async () => {
    const result = await resolveChallengeSquad({}, { services: { Squad: {} } }, null, {
      pacer: testPacer,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts.map((attempt) => attempt.id)).toEqual(
      CHALLENGE_SQUAD_STRATEGIES.map((strategy) => strategy.id)
    );
    for (const attempt of result.attempts) {
      expect(attempt.ok).toBe(false);
      expect(attempt.reason.length).toBeGreaterThan(0);
    }
  });
});
