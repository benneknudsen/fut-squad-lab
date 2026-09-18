import { describe, expect, it } from 'vitest';

import club from './fixtures/club-items.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import { CLUB_ITEM_STRATEGIES } from '../src/ea/adapter.js';
import { readChallenge } from '../src/ea/challenge-reader.js';
import { readClubItems } from '../src/ea/club-reader.js';
import { buildReadSummary, countConstraints } from '../src/ea/summary.js';

const challenge = readChallenge(
  set10.challenges.find((entry) => entry.challengeId === 25)
);
const clubItems = readClubItems(club);

const successClub = {
  ok: true,
  items: clubItems,
  strategy: 'services.UTSBCRepository.getClubItems',
  attempts: [{ id: 'services.UTSBCRepository.getClubItems', ok: true, reason: null }],
};

const failedClub = {
  ok: false,
  items: [],
  strategy: null,
  attempts: CLUB_ITEM_STRATEGIES.map((strategy) => ({
    id: strategy.id,
    ok: false,
    reason: 'method missing',
  })),
};

describe('countConstraints', () => {
  it('counts one constraint per distinct eligibility slot, not one per elgReq entry', () => {
    // The fixture challenge carries 12 elgReq entries across 6 slots, because a
    // scope modifier shares its requirement's slot.
    expect(challenge.elgReq).toHaveLength(12);
    expect(countConstraints(challenge)).toBe(6);
  });

  it('collapses repeated slots and ignores extra fields', () => {
    expect(
      countConstraints({
        elgReq: [
          { eligibilitySlot: 1, eligibilityKey: 8, eligibilityValue: 3 },
          { eligibilitySlot: 1, eligibilityKey: 13, eligibilityValue: 2 },
          { eligibilitySlot: 2, eligibilityKey: 7, eligibilityValue: 2 },
        ],
      })
    ).toBe(2);
  });

  it('rejects a challenge without an elgReq array', () => {
    expect(() => countConstraints(null)).toThrow(/elgReq/);
    expect(() => countConstraints({})).toThrow(/elgReq/);
  });
});

describe('buildReadSummary', () => {
  it('states the real challenge name, constraint count, club size and winning strategy', () => {
    const summary = buildReadSummary({ challenge, clubResult: successClub });
    expect(summary).toContain('3 Leagues & 2 Nations');
    expect(summary).toContain('6 constraints');
    expect(summary).toContain('42 club items');
    expect(summary).toContain('services.UTSBCRepository.getClubItems');
    expect(summary).not.toContain('undefined');
  });

  it('does not report the raw elgReq entry count as the constraint count', () => {
    const summary = buildReadSummary({ challenge, clubResult: successClub });
    expect(summary).not.toContain('12 constraints');
  });

  it('says the challenge was not detected when the panel argument carried none', () => {
    const summary = buildReadSummary({ challenge: null, clubResult: successClub });
    expect(summary).toMatch(/challenge not detected/i);
    expect(summary).toContain('42 club items');
  });

  it('names every candidate it tried when the club read failed, and never a guessed size', () => {
    const summary = buildReadSummary({ challenge, clubResult: failedClub });
    expect(summary).toMatch(/club read failed/);
    for (const strategy of CLUB_ITEM_STRATEGIES) {
      expect(summary).toContain(strategy.id);
    }
    expect(summary).not.toMatch(/42 club items/);
  });

  it('handles a missing club result without inventing one', () => {
    const summary = buildReadSummary({ challenge, clubResult: null });
    expect(summary).toMatch(/club read failed/);
    expect(summary).toContain('0 items');
    expect(summary).not.toMatch(/42/);
  });
});
