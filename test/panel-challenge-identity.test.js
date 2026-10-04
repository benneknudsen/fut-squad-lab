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

    const [keyed, identity] = located.locations;
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
