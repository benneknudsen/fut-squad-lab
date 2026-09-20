import { describe, expect, it } from 'vitest';

import set10 from './fixtures/sbs-set-10-challenges.json';
import { PINNED_ELIGIBILITY_KEYS, SCOPE_VALUES } from './helpers/eligibility.js';
import { readChallenge } from '../src/ea/challenge-reader.js';
import { normaliseRequirements } from '../src/solver/requirements.js';

// The expected `elgReq` is written out from the requirement model documented in
// `docs/PLAN.md` section 1.3, independently of the fixture, so a fixture drift
// shows up as a reader test failure rather than as an echoed expectation.
const EXPECTED_CHALLENGE_25 = {
  challengeId: 25,
  name: '3 Leagues & 2 Nations',
  formation: 'f343',
  elgOperation: 'AND',
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
      'name',
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
});
