import { describe, expect, it, vi } from 'vitest';

import {
  loadChallengePayload,
  resolveChallengeSubject,
  selectChallengeByIdentity,
} from '../src/ea/adapter.js';
import { readChallenge } from '../src/ea/challenge-reader.js';
import set10 from './fixtures/sbs-set-10-challenges.json';
import { createTestPacer } from './helpers/pacing.js';

// fsl-build/13's live diagnostic proved the panel hook's first argument is the
// SBC set and the second is the challenge the player opened. These tests pin
// that identity: the requirements come from the set's own selected challenge,
// the blind open-challenge walk never overrides that identity, and an entity
// wrapper's payload is read one level down inside its data wrapper.

const fixtureChallenge = (challengeId) =>
  JSON.parse(JSON.stringify(set10.challenges.find((entry) => entry.challengeId === challengeId)));

const setArgument = () => ({
  id: 10,
  challengesCount: set10.challenges.length,
  challenges: Object.fromEntries(
    set10.challenges.map((entry) => [entry.challengeId, fixtureChallenge(entry.challengeId)])
  ),
});

const observableOf = (payload) => ({
  observe(subscriber, callback) {
    callback(
      { unobserve() {} },
      { data: null, error: null, response: payload, status: 200, success: true }
    );
    return { unobserve() {} };
  },
});

const challengeEntity = ({ id, completed = false, inProgress = false }) => ({
  id,
  isCompleted: () => completed,
  isInProgress: () => inProgress,
});

/**
 * A synthetic set-challenges entry, invented for the reader to prove itself
 * against: key names, one id and one requirement. No captured club content, no
 * player, no price — the issue's own example shape and nothing else.
 */
const syntheticEntry = (overrides = {}) => ({
  challengeId: 18,
  name: 'a synthetic challenge',
  formation: 'f00000',
  elgOperation: 'OR',
  elgReq: [{ type: 'PLAYER_QUALITY', eligibilitySlot: 1, eligibilityKey: 3, eligibilityValue: 3 }],
  ...overrides,
});

/** A set argument whose `challenges` collection holds exactly the given entry. */
const setHolding = (entry) => ({
  id: 6,
  challengesCount: 1,
  challenges: { 18: entry },
});

describe('the selected challenge on a set-shaped panel argument', () => {
  it('resolves the requirements from the challenge named by the second argument', () => {
    const set = setArgument();

    const result = resolveChallengeSubject(set, undefined, { challengeId: 25 });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('panel-argument.challenges+id');
    expect(result.selectedChallengeId).toBe(25);
    expect(result.payload).toBe(set.challenges[25]);
    expect(result.payload.elgReq).toHaveLength(12);
    const attempt = result.attempts.find((entry) => entry.id === 'panel-argument.challenges+id');
    expect(attempt).toMatchObject({ ok: true });
    expect(result.attempts.slice(1).map((entry) => entry.id)).toEqual([
      'panel-argument.data',
      'panel-argument',
      'panel-argument.challenge',
      'panel-argument.sbcChallenge',
      'services.SBC.repository.challenge',
      'services.SBC.repository.activeChallenge',
      'services.SBC.sbcDAO.challenge',
      'services.SBC.sbcDAO.activeChallenge',
      'services.Squad.activeSquad.challenge',
      'services.Squad.squadDao.challenge',
    ]);
  });

  it('descends into an entity data wrapper when the selected challenge is a wrapper', () => {
    const payload = fixtureChallenge(25);
    const set = {
      id: 10,
      challengesCount: 1,
      challenges: { 25: { id: 25, data: payload } },
    };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 25 });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(payload);
    expect(result.requirementsFrom).toContain('data.elgReq');
    const read = readChallenge(result.payload);
    expect(read.elgReq).toHaveLength(12);
  });

  it('fails loudly and keeps the id when the set carries no matching challenge', () => {
    const set = {
      id: 10,
      challengesCount: 1,
      challenges: { 26: fixtureChallenge(26) },
    };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 25 });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.selectedChallengeId).toBe(25);
    const attempt = result.attempts[0];
    expect(attempt.id).toBe('panel-argument.challenges+id');
    expect(attempt.ok).toBe(false);
    expect(attempt.reason).toContain('25');
    expect(attempt.reason).toMatch(/none with id 25/i);
  });

  it('locates the selected challenge inside an array-shaped challenges collection', () => {
    const set = {
      id: 10,
      challengesCount: set10.challenges.length,
      challenges: set10.challenges.map((entry) => fixtureChallenge(entry.challengeId)),
    };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 27 });

    expect(result.ok).toBe(true);
    expect(result.selectedChallengeId).toBe(27);
    expect(result.payload.challengeId).toBe(27);
  });

  it('keeps the legacy panel strategies when no second argument was handed over', () => {
    const challenge = fixtureChallenge(25);

    const result = resolveChallengeSubject({ data: challenge });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('panel-argument.data');
    expect(result.attempts).toEqual([{ id: 'panel-argument.data', ok: true, reason: null }]);
  });
});

describe('the keyed lookup never selects an unverified challenge entry', () => {
  const locatedAttempt = (result) => result.attempts[0];

  it('refuses an index-keyed entry whose key collides with the challenge id', () => {
    // A `challenges` object keyed by array index: the key `1` is the second
    // entry's position, not a challenge id. Taking it would answer with a
    // challenge the player never opened.
    const set = {
      id: 10,
      challengesCount: 2,
      challenges: { 0: fixtureChallenge(25), 1: fixtureChallenge(26) },
    };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 1 });

    const attempt = locatedAttempt(result);
    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.selectedChallengeId).toBe(1);
    expect(attempt.ok).toBe(false);
    expect(attempt.reason).toContain('1');
    // Both probed locations are named in the pasted reason: the keyed path lost
    // because the entry there carries challenge 26, and the identity path found
    // nothing, so a live report says which answered and why the other did not.
    expect(attempt.reason).toContain('panel-argument.challenges[key]');
    expect(attempt.reason).toContain('panel-argument.challenges[identity]');
    expect(attempt.reason).toContain('26');
  });

  it('refuses a keyed entry whose own challenge id differs from its key', () => {
    const set = {
      id: 10,
      challengesCount: 1,
      challenges: { 25: fixtureChallenge(26) },
    };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 25 });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.selectedChallengeId).toBe(25);
    expect(locatedAttempt(result).ok).toBe(false);
  });

  it('falls through to the identity match when the keyed entry is unverified', () => {
    // Key `25` holds challenge 26, so the keyed read is refused; challenge 25
    // is still in the collection and must be found by its own identity.
    const wanted = fixtureChallenge(25);
    const set = {
      id: 10,
      challengesCount: 2,
      challenges: { 25: fixtureChallenge(26), 26: wanted },
    };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 25 });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(wanted);
    expect(result.payload.challengeId).toBe(25);
    expect(readChallenge(result.payload).elgReq).toHaveLength(12);
  });

  it('does not read a challenges key off the prototype chain', () => {
    const inherited = Object.create({ 25: fixtureChallenge(26) });
    const set = { id: 10, challengesCount: 1, challenges: inherited };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 25 });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.selectedChallengeId).toBe(25);
  });

  it('records the keyed and the identity probe so a live report says which path answered', () => {
    const set = setArgument();

    const located = locatedAttempt(resolveChallengeSubject(set, undefined, { challengeId: 25 }));

    expect(located.locations.map((entry) => entry.id)).toEqual([
      'panel-argument.id',
      'panel-argument.challenges[key]',
      'panel-argument.challenges[identity]',
    ]);
    for (const location of located.locations) {
      expect(location).toEqual({ id: location.id, ok: true, reason: null });
    }
  });

  it('records why the keyed probe was refused and the identity probe answered', () => {
    const set = {
      id: 10,
      challengesCount: 2,
      challenges: { 25: fixtureChallenge(26), 26: fixtureChallenge(25) },
    };

    const located = locatedAttempt(resolveChallengeSubject(set, undefined, { challengeId: 25 }));

    const [, keyed, identity] = located.locations;
    expect(keyed).toMatchObject({ id: 'panel-argument.challenges[key]', ok: false });
    expect(keyed.reason).toContain('26');
    expect(identity).toMatchObject({ id: 'panel-argument.challenges[identity]', ok: true });
    expect(located.ok).toBe(true);
  });
});

describe('the panel identity is preferred over the blind open-challenge walk', () => {
  it('answers from the panel argument without walking the set API', async () => {
    const set = setArgument();
    const subject = resolveChallengeSubject(set, undefined, { challengeId: 25 });
    const requestSets = vi.fn(() => {
      throw new Error('the set API must not be walked when the panel named the challenge');
    });
    const pageWindow = { services: { SBC: { requestSets } } };

    const result = await loadChallengePayload(pageWindow, subject, { pacer: createTestPacer() });

    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('panel-argument.challenges+id');
    expect(result.payload.elgReq).toHaveLength(12);
    expect(result.loadVia).toBe('panel-argument.challenges+id');
    expect(result.requirementsFrom).toBe('payload.elgReq');
    expect(requestSets).not.toHaveBeenCalled();
  });
});

describe('selectChallengeByIdentity', () => {
  it('selects the named challenge even when another is in progress', () => {
    const first = challengeEntity({ id: 9, inProgress: true });
    const wanted = challengeEntity({ id: 25 });

    const selection = selectChallengeByIdentity([first, wanted], 25);

    expect(selection.ok).toBe(true);
    expect(selection.challenge).toBe(wanted);
    expect(selection.chosenId).toBe(25);
    expect(selection.reason).toContain('25');
  });

  it('refuses to select another challenge when the named id is absent', () => {
    const selection = selectChallengeByIdentity([challengeEntity({ id: 9 })], 25);

    expect(selection.ok).toBe(false);
    expect(selection.challenge).toBeNull();
    expect(selection.chosenId).toBe(25);
    expect(selection.reason).toContain('25');
    expect(selection.reason).toMatch(/refusing/i);
  });
});

describe('the set walk follows the panel identity when the panel carried one', () => {
  it('loads the panel-named challenge by id instead of the in-progress one', async () => {
    const received = [];
    const loaded = fixtureChallenge(25);
    const entity9 = challengeEntity({ id: 9, inProgress: true });
    const entity25 = challengeEntity({ id: 25 });
    const set = { id: 10, getChallenges: () => [entity9, entity25] };
    const pageWindow = {
      services: {
        SBC: {
          sbcDAO: {
            loadChallenge(...args) {
              received.push(args);
              return observableOf(loaded);
            },
          },
          requestSets: () => observableOf({ sets: [set] }),
          requestChallengesForSet: () => observableOf({}),
        },
      },
    };
    const subject = {
      ok: false,
      payload: null,
      strategy: null,
      attempts: [],
      selectedChallengeId: 25,
    };

    const result = await loadChallengePayload(pageWindow, subject, { pacer: createTestPacer() });

    expect(result.ok).toBe(true);
    expect(received).toEqual([[25, false]]);
    expect(result.payload).toBe(loaded);
    expect(result.selection).toMatchObject({ ok: true, chosenId: 25 });
    expect(result.selection.reason).toContain('25');
  });

  it('fails the walk loudly when the panels named challenge is not in the sets', async () => {
    const loadChallenge = vi.fn();
    const set = {
      id: 10,
      getChallenges: () => [challengeEntity({ id: 9, inProgress: true })],
    };
    const pageWindow = {
      services: {
        SBC: {
          sbcDAO: { loadChallenge },
          requestSets: () => observableOf({ sets: [set] }),
          requestChallengesForSet: () => observableOf({}),
        },
      },
    };
    const subject = {
      ok: false,
      payload: null,
      strategy: null,
      attempts: [],
      selectedChallengeId: 25,
    };

    const result = await loadChallengePayload(pageWindow, subject, { pacer: createTestPacer() });

    expect(result.ok).toBe(false);
    expect(loadChallenge).not.toHaveBeenCalled();
    const reason = result.attempts[0].reason;
    expect(reason).toContain('25');
    expect(reason).toMatch(/no challenge/i);
    expect(result.attempts[0].selection).toMatchObject({ chosenId: 25, ok: false });
  });
});

describe('the load stage honours the refused identity instead of loading another challenge', () => {
  it('never loads a different challenge once the panel named one it could not verify', async () => {
    const other = fixtureChallenge(26);
    const loaded = [];
    const pageWindow = {
      services: {
        SBC: {
          loadChallenge(...args) {
            loaded.push(args);
            return observableOf(other);
          },
          sbcDAO: {
            loadChallenge(...args) {
              loaded.push(args);
              return observableOf(other);
            },
          },
          requestSets: () => observableOf({ sets: [] }),
          requestChallengesForSet: () => observableOf({}),
        },
      },
    };
    // The subject stage fell back to another challenge while the panel named 25.
    const subject = {
      ok: true,
      payload: other,
      strategy: 'panel-argument.data',
      attempts: [{ id: 'panel-argument.data', ok: true, reason: null }],
      selectedChallengeId: 25,
    };

    const result = await loadChallengePayload(pageWindow, subject, { pacer: createTestPacer() });

    expect(loaded).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    const refused = [
      'services.SBC.loadChallenge+subject',
      'services.SBC.sbcDAO.loadChallenge+id',
      'subject.payload',
    ];
    for (const id of refused) {
      const attempt = result.attempts.find((entry) => entry.id === id);
      expect(attempt.ok).toBe(false);
      expect(attempt.reason).toContain('25');
    }
  });

  it('still loads through the panel-argument strategies when no challenge was named', async () => {
    const other = fixtureChallenge(26);
    const loaded = [];
    const pageWindow = {
      services: {
        SBC: {
          loadChallenge(...args) {
            loaded.push(args);
            return observableOf(other);
          },
          requestSets: () => observableOf({ sets: [] }),
          requestChallengesForSet: () => observableOf({}),
        },
      },
    };

    const result = await loadChallengePayload(
      pageWindow,
      { ok: true, payload: other, strategy: 'panel-argument.data', attempts: [] },
      { pacer: createTestPacer() }
    );

    expect(loaded).toEqual([[other]]);
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('services.SBC.loadChallenge+subject');
  });
});

describe('a set-challenges entity wraps its payload one level down', () => {
  it('uses the elgReq inside the selected entity data wrapper without loading', async () => {
    const payload = fixtureChallenge(25);
    const entity = { ...challengeEntity({ id: 25 }), data: payload };
    let loads = 0;
    const pageWindow = {
      services: {
        SBC: {
          loadChallenge() {
            loads += 1;
            throw new Error('the challenge must not be loaded when its data wrapper carries elgReq');
          },
          requestSets: () => observableOf({ sets: [{ id: 10, getChallenges: () => [entity] }] }),
          requestChallengesForSet: () => observableOf({}),
        },
      },
    };

    const result = await loadChallengePayload(
      pageWindow,
      { ok: false, payload: null, strategy: null, attempts: [] },
      { pacer: createTestPacer() }
    );

    expect(result.ok).toBe(true);
    expect(loads).toBe(0);
    expect(result.payload).toBe(payload);
    expect(result.loadVia).toBe('set-payload.data.elgReq');
    const attempt = result.attempts[0];
    expect(attempt.reason).toMatch(/elgReq\[12\]/);
    expect(attempt.reason).toMatch(/data/);
    const read = readChallenge(result.payload);
    expect(read.elgReq).toHaveLength(12);
  });
});

// #109: the fsl-build/15 run stopped at the bridge stage because three reads of
// the same challenge disagreed about where a challenge's identity lives. The
// set-payload path read one level only, the identity path descended into one
// wrapper and the requirements path into two, and the identity path returned
// the *first* finite id it found — so an entry carrying a finite but different
// `id` shadowed a `challengeId` that matched.
//
// These tests pin the one shared read: the panel's named id is compared against
// every proven location (the top level, and one bounded level down in both
// `data` and `challengeData`), and a miss names the locations it probed and
// the candidate's own key names so the next live run is self-diagnosing.
describe('one shared identity read covers every proven location (#109)', () => {
  it('matches an entry that carries the id at the top level', () => {
    const entry = syntheticEntry();

    const result = resolveChallengeSubject(setHolding(entry), undefined, { challengeId: 18 });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(entry);
    expect(result.selectedChallengeId).toBe(18);
  });

  it('matches an entry that carries the id one level down in data', () => {
    const payload = syntheticEntry();
    const entry = { data: payload };

    const result = resolveChallengeSubject(setHolding(entry), undefined, { challengeId: 18 });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(payload);
    expect(result.requirementsFrom).toBe('data.elgReq');
  });

  it('matches an entry that carries the id one level down in challengeData', () => {
    const payload = syntheticEntry();
    const entry = { challengeData: payload };

    const result = resolveChallengeSubject(setHolding(entry), undefined, { challengeId: 18 });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(payload);
    expect(result.requirementsFrom).toBe('challengeData.elgReq');
  });

  it('matches an entry whose finite id shadows the matching challengeId', () => {
    // The shadowing case: `id` is finite and wrong, `challengeId` is right.
    // Taking the first id found and comparing that refuses the very challenge
    // the player opened.
    const entry = syntheticEntry({ id: 99 });

    const result = resolveChallengeSubject(setHolding(entry), undefined, { challengeId: 18 });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(entry);
    expect(result.selectedChallengeId).toBe(18);
  });

  it('matches an entry whose wrapper carries the id while its own id shadows it', () => {
    const payload = syntheticEntry();
    const entry = { id: 99, data: payload };

    const result = resolveChallengeSubject(setHolding(entry), undefined, { challengeId: 18 });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(payload);
  });

  it('refuses an entry that carries only a non-matching id, and names what it probed', () => {
    const set = setHolding({ id: 17, formation: 'f00000' });

    const result = resolveChallengeSubject(set, undefined, { challengeId: 18 });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.selectedChallengeId).toBe(18);
    const attempt = result.attempts[0];
    expect(attempt.ok).toBe(false);
    // The count of what was looked at is on the reason.
    expect(attempt.reason).toMatch(/none with id 18/i);
    // Every proven location is named, so the next live run can name the field
    // without another code change.
    expect(attempt.reason).toContain('challengeId');
    expect(attempt.reason).toContain('data.challengeId');
    expect(attempt.reason).toContain('challengeData.challengeId');
    // The candidate's own key names, with their types and never a value.
    expect(attempt.reason).toContain('id: number');
    expect(attempt.reason).toContain('formation: string');
    expect(attempt.reason).not.toContain('f00000');
  });

  it('refuses to read requirements off a set argument that carries none', () => {
    const set = setHolding({ challengeId: 18, formation: 'f00000' });

    const result = resolveChallengeSubject(set, undefined, { challengeId: 18 });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.requirementsFrom ?? null).toBeNull();
    // The identity survives the refusal, so the load stage still knows which
    // challenge the player opened.
    expect(result.selectedChallengeId).toBe(18);
    const attempt = result.attempts[0];
    expect(attempt.ok).toBe(false);
    expect(attempt.reason).toMatch(/requirements/i);
  });

  it('the load stage never answers with a set argument that carries requirements of its own', async () => {
    // The panel argument is a set: it carries a `challenges` collection and, in
    // this shape, a requirements array of its own. The set's requirements are
    // not the challenge's requirements, so the load stage must not answer with
    // the set — the challenge the player opened is the only answer, and it has
    // not been verified. The subject stage still answers with the set itself;
    // the load stage is the gate that refuses to answer with it.
    const set = {
      ...setHolding({ challengeId: 18, formation: 'f00000' }),
      elgReq: [
        { type: 'PLAYER_QUALITY', eligibilitySlot: 1, eligibilityKey: 3, eligibilityValue: 3 },
      ],
    };

    const subject = resolveChallengeSubject(set, undefined, { challengeId: 18 });
    const result = await loadChallengePayload({ services: { SBC: {} } }, subject, {
      pacer: createTestPacer(),
    });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.requirementsFrom ?? null).toBeNull();
  });
});

// #109 follow-up: the shared identity read compared the named id against every
// proven location at once, so a candidate whose wrapper `id` matched won
// before a candidate that named the challenge in the field the wire form
// proves — and a candidate that named *another* challenge was accepted on its
// wrapper id alone. Both are the wrong direction: the run must never write a
// squad into a challenge the player did not open.
//
// These tests pin the two rules that fix it: the named field outranks the
// wrapper field across every candidate, and a candidate that names another
// challenge is refused outright.
describe('the named field outranks the wrapper field (#109)', () => {
  const requirements = [
    { type: 'PLAYER_QUALITY', eligibilitySlot: 1, eligibilityKey: 3, eligibilityValue: 3 },
  ];

  /** A candidate that carries a wrapper id only, and names no challenge at all. */
  const wrapperOnly = (overrides = {}) => ({
    id: 18,
    name: 'the wrapper-id candidate',
    formation: 'f00000',
    elgOperation: 'OR',
    elgReq: requirements,
    ...overrides,
  });

  /** A candidate that names the challenge in the field the wire form proves. */
  const named = (overrides = {}) => ({
    challengeId: 18,
    name: 'the named candidate',
    formation: 'f00000',
    elgOperation: 'OR',
    elgReq: requirements,
    ...overrides,
  });

  it('prefers the candidate that names the challenge over an earlier wrapper-id candidate', () => {
    // The payload order must not decide which challenge the run picks: the
    // candidate that names challenge 18 in the proven field is the answer, even
    // though the first candidate carries a matching wrapper id.
    const wanted = named();
    const set = { id: 6, challengesCount: 2, challenges: [wrapperOnly(), wanted] };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 18 });

    expect(result.ok).toBe(true);
    expect(result.payload).toBe(wanted);
    expect(result.payload.name).toBe('the named candidate');
  });

  it('refuses a candidate that names another challenge, even when its own id matches', () => {
    const set = { id: 6, challengesCount: 1, challenges: [wrapperOnly({ challengeId: 50 })] };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 18 });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.selectedChallengeId).toBe(18);
    // The report says why: the candidate names another challenge.
    expect(result.attempts[0].reason).toMatch(/another challenge/i);
  });

  it('refuses a candidate that carries only a non-matching wrapper id', () => {
    const set = { id: 6, challengesCount: 1, challenges: [wrapperOnly({ id: 99 })] };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 18 });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.selectedChallengeId).toBe(18);
  });

  it('refuses a candidate that names only another challenge', () => {
    const set = { id: 6, challengesCount: 1, challenges: [named({ challengeId: 50 })] };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 18 });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.selectedChallengeId).toBe(18);
  });

  it('refuses a keyed entry that names another challenge, even when its own id matches', () => {
    // The keyed location is verified by the same identity read, so it cannot
    // hand back a challenge that names another one either.
    const set = { id: 6, challengesCount: 1, challenges: { 18: wrapperOnly({ challengeId: 50 }) } };

    const result = resolveChallengeSubject(set, undefined, { challengeId: 18 });

    expect(result.ok).toBe(false);
    expect(result.payload).toBeNull();
    expect(result.selectedChallengeId).toBe(18);
    const keyed = result.attempts[0].locations.find(
      (location) => location.id === 'panel-argument.challenges[key]'
    );
    expect(keyed.ok).toBe(false);
    expect(keyed.reason).toMatch(/another challenge/i);
  });
});
