import { describe, expect, it } from 'vitest';

import entityChallenge18 from './fixtures/sbs-entity-challenge-18.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import { PINNED_ELIGIBILITY_KEYS, SCOPE_VALUES } from './helpers/eligibility.js';
import { readChallenge } from '../src/ea/challenge-reader.js';
import { readEligibilityKeys } from '../src/ea/adapter.js';
import { normaliseRequirements } from '../src/solver/requirements.js';

// The expected `elgReq` is written out from the requirement model documented in
// `docs/PLAN.md` section 1.3, independently of the fixture, so a fixture drift
// shows up as a reader test failure rather than as an echoed expectation.
const EXPECTED_CHALLENGE_25 = {
  challengeId: 25,
  name: '3 Leagues & 2 Nations',
  formation: 'f343',
  elgOperation: 'AND',
  identityFrom: 'payload.challengeId',
  operationFrom: 'payload.elgOperation',
  requirementsFrom: 'payload.elgReq',
  elgReq: [
    { type: 'LEAGUE_COUNT', eligibilitySlot: 1, eligibilityKey: 8, eligibilityValue: 3 },
    { type: 'SCOPE', eligibilitySlot: 1, eligibilityKey: 13, eligibilityValue: 2 },
    { type: 'NATION_COUNT', eligibilitySlot: 2, eligibilityKey: 7, eligibilityValue: 2 },
    { type: 'SCOPE', eligibilitySlot: 2, eligibilityKey: 13, eligibilityValue: 2 },
    { type: 'SAME_LEAGUE_COUNT', eligibilitySlot: 3, eligibilityKey: 5, eligibilityValue: 6 },
    { type: 'SCOPE', eligibilitySlot: 3, eligibilityKey: 13, eligibilityValue: 1 },
    { type: 'SAME_NATION_COUNT', eligibilitySlot: 4, eligibilityKey: 4, eligibilityValue: 6 },
    { type: 'SCOPE', eligibilitySlot: 4, eligibilityKey: 13, eligibilityValue: 1 },
    { type: 'PLAYER_QUALITY', eligibilitySlot: 5, eligibilityKey: 3, eligibilityValue: 3 },
    { type: 'SCOPE', eligibilitySlot: 5, eligibilityKey: 13, eligibilityValue: 2 },
    { type: 'CHEMISTRY_POINTS', eligibilitySlot: 6, eligibilityKey: 35, eligibilityValue: 30 },
    { type: 'SCOPE', eligibilitySlot: 6, eligibilityKey: 13, eligibilityValue: 0 },
  ],
};

const fixtureChallenge = set10.challenges.find(
  (challenge) => challenge.challengeId === 25
);

describe('readChallenge', () => {
  it('emits exactly the contract shape requirements.js consumes', () => {
    const challenge = readChallenge(fixtureChallenge);
    expect(challenge).toEqual(EXPECTED_CHALLENGE_25);
    expect(Object.keys(challenge).sort()).toEqual([
      'challengeId',
      'elgOperation',
      'elgReq',
      'formation',
      'identityFrom',
      'name',
      'operationFrom',
      'requirementsFrom',
    ]);
  });

  it('decodes the fixture through requirements.js without an adapter fallback', () => {
    const { constraints, operation } = normaliseRequirements(readChallenge(fixtureChallenge).elgReq, {
      operation: readChallenge(fixtureChallenge).elgOperation,
      keys: PINNED_ELIGIBILITY_KEYS,
      scopes: SCOPE_VALUES,
    });
    expect(operation).toBe('AND');
    expect(constraints.map((constraint) => constraint.kind)).toEqual([
      'LEAGUE_COUNT',
      'NATION_COUNT',
      'SAME_LEAGUE_COUNT',
      'SAME_NATION_COUNT',
      'PLAYER_QUALITY',
      'CHEMISTRY_POINTS',
    ]);
  });

  it('emits plain serialisable data, not entity references', () => {
    const challenge = readChallenge(fixtureChallenge);
    expect(JSON.parse(JSON.stringify(challenge))).toEqual(challenge);
  });

  it('does not mutate the payload it reads', () => {
    const snapshot = JSON.stringify(fixtureChallenge);
    readChallenge(fixtureChallenge);
    expect(JSON.stringify(fixtureChallenge)).toBe(snapshot);
  });

  it('names the missing field when the payload lacks one', () => {
    const { name, ...withoutName } = fixtureChallenge;
    expect(() => readChallenge(withoutName)).toThrow(/name/);
    const { elgReq, ...withoutRequirements } = fixtureChallenge;
    expect(() => readChallenge(withoutRequirements)).toThrow(/elgReq/);
    const { formation, ...withoutFormation } = fixtureChallenge;
    expect(() => readChallenge(withoutFormation)).toThrow(/formation/);
  });

  it('rejects a requirements value that is not an array', () => {
    expect(() => readChallenge({ ...fixtureChallenge, elgReq: {} })).toThrow(/elgReq/);
  });

  it('rejects a payload that is not an object', () => {
    expect(() => readChallenge(null)).toThrow(/object/);
    expect(() => readChallenge('challenge')).toThrow(/object/);
  });

  it('decodes requirements living under eligibilityRequirements and reports that location', () => {
    const { elgReq, ...rest } = fixtureChallenge;
    const challenge = readChallenge({ ...rest, eligibilityRequirements: elgReq });
    expect(challenge.requirementsFrom).toBe('payload.eligibilityRequirements');
    expect(challenge.elgReq).toEqual(EXPECTED_CHALLENGE_25.elgReq);
  });

  it('decodes requirements one level down behind getRequirements()', () => {
    const { elgReq, ...rest } = fixtureChallenge;
    const challenge = readChallenge({
      ...rest,
      challenge: { getRequirements: () => elgReq },
    });
    expect(challenge.requirementsFrom).toBe('payload.challenge.getRequirements()');
    expect(challenge.elgReq).toEqual(EXPECTED_CHALLENGE_25.elgReq);
  });

  it('reports which location answered for the documented nested shapes', () => {
    const { elgReq, ...rest } = fixtureChallenge;
    expect(readChallenge({ ...rest, requirements: elgReq }).requirementsFrom).toBe(
      'payload.requirements'
    );
    expect(readChallenge({ ...rest, requirementsList: elgReq }).requirementsFrom).toBe(
      'payload.requirementsList'
    );
    expect(readChallenge({ ...rest, data: { sbcChallenge: { eligibilityRequirements: elgReq } } }).requirementsFrom).toBe(
      'payload.data.sbcChallenge.eligibilityRequirements'
    );
    expect(readChallenge({ ...rest, sbcChallenge: { requirementsList: elgReq } }).requirementsFrom).toBe(
      'payload.sbcChallenge.requirementsList'
    );
  });

  it('names every documented lookup when no location carries requirements', () => {
    const { elgReq, ...withoutRequirements } = fixtureChallenge;
    const read = () => readChallenge(withoutRequirements);
    expect(read).toThrow(/eligibilityRequirements/);
    expect(read).toThrow(/getRequirements/);
    expect(read).toThrow(/data\.sbcChallenge/);
  });

  it('reads the live entity names and reports where identity and operation were found', () => {
    const challenge = readChallenge(entityChallenge18);

    expect(challenge.challengeId).toBe(18);
    expect(challenge.identityFrom).toBe('payload.id');
    expect(challenge.elgOperation).toBe('AND');
    expect(challenge.operationFrom).toBe('payload.eligibilityOperation');
    expect(challenge.requirementsFrom).toBe('payload.eligibilityRequirements');
    expect(challenge.elgReq).toEqual(entityChallenge18.eligibilityRequirements);
  });

  it('names an undecodable entry by its own key names and types, never its values', () => {
    const payload = {
      ...entityChallenge18,
      id: 101,
      eligibilityRequirements: [{ type: 'LEAGUE_COUNT', eligibilityKey: 8675309 }],
    };

    let message = '';
    try {
      readChallenge(payload);
    } catch (error) {
      message = error.message;
    }

    expect(message).toMatch(/eligibilitySlot/);
    expect(message).toContain('eligibilityKey: number');
    expect(message).not.toContain('8675309');
  });
});

/**
 * The live entity groups one slot's facts as `{ scope, count, kvPairs }` instead
 * of flattening them into wire rows. The key table is EA's live enum, as it is
 * in production; this fake carries only the members these tests use.
 */
const LIVE_ELIGIBILITY_ENUM = Object.freeze({
  PLAYER_COUNT: 2,
  2: 'PLAYER_COUNT',
  PLAYER_QUALITY: 3,
  3: 'PLAYER_QUALITY',
  NATION_ID: 10,
  10: 'NATION_ID',
  CLUB_ID: 12,
  12: 'CLUB_ID',
  SCOPE: 13,
  13: 'SCOPE',
});

const liveKeys = () => readEligibilityKeys({ SBCEligibilityKey: LIVE_ELIGIBILITY_ENUM });

const livePayload = (requirements) => ({
  ...entityChallenge18,
  eligibilityRequirements: requirements,
});

const readLive = (requirements) =>
  readChallenge(livePayload(requirements), { eligibilityKeys: liveKeys() });

describe('live requirement entries written as { scope, count, kvPairs } (#121)', () => {
  it('expands one live entry into the wire rows the existing decoder consumes', () => {
    const challenge = readLive([{ scope: 0, count: -1, kvPairs: { 3: 3 } }]);

    expect(challenge.requirementsFrom).toBe('payload.eligibilityRequirements');
    expect(challenge.elgReq).toEqual([
      {
        type: 'PLAYER_QUALITY',
        eligibilitySlot: 1,
        eligibilityKey: 3,
        eligibilityValue: 3,
        count: -1,
      },
      { type: 'SCOPE', eligibilitySlot: 1, eligibilityKey: 13, eligibilityValue: 0 },
    ]);
  });

  it('reads a match-shaped entry whose kvPairs is a collection object with `_collection`', () => {
    const challenge = readLive([
      {
        scope: 0,
        count: 2,
        kvPairs: {
          _collection: [
            [10, 42],
            { key: 12, value: 4 },
          ],
        },
      },
    ]);

    expect(challenge.elgReq).toEqual([
      {
        type: 'NATION_ID',
        eligibilitySlot: 1,
        eligibilityKey: 10,
        eligibilityValue: 42,
        count: 2,
      },
      {
        type: 'CLUB_ID',
        eligibilitySlot: 1,
        eligibilityKey: 12,
        eligibilityValue: 4,
        count: 2,
      },
      { type: 'SCOPE', eligibilitySlot: 1, eligibilityKey: 13, eligibilityValue: 0 },
    ]);
  });

  it('names a kvPairs key the live key table cannot name', () => {
    let message = '';
    try {
      readLive([{ scope: 0, count: -1, kvPairs: { 99: 1 } }]);
    } catch (error) {
      message = error.message;
    }

    expect(message).toMatch(/99/);
    expect(message).toMatch(/cannot name/);
    expect(message).toMatch(/kvPairs/);
    // The shape report names the entry's own keys, both integers, and the
    // count-role key the pairs do not carry, so the next run needs no guess.
    expect(message).toMatch(/scope: number/);
    expect(message).toMatch(/count: number/);
    expect(message).toMatch(/no count-role key \(PLAYER_COUNT\)/);
  });

  it('names the row type through EA’s own key table, not a local map', () => {
    const renamed = readEligibilityKeys({
      SBCEligibilityKey: {
        SAME_LEAGUE_COUNT: 3,
        3: 'SAME_LEAGUE_COUNT',
        SCOPE: 13,
        13: 'SCOPE',
      },
    });
    const challenge = readChallenge(
      livePayload([{ scope: 0, count: -1, kvPairs: { 3: 6 } }]),
      { eligibilityKeys: renamed }
    );

    expect(challenge.elgReq[0].type).toBe('SAME_LEAGUE_COUNT');
  });

  it('names the shape of a kvPairs value it cannot decode', () => {
    let message = '';
    try {
      readLive([{ scope: 0, count: -1, kvPairs: 'not a collection' }]);
    } catch (error) {
      message = error.message;
    }

    expect(message).toMatch(/kvPairs/);
    expect(message).toMatch(/string/);
    expect(message).toMatch(/kvPairs: string/);
  });
});
