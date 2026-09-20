import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ELIGIBILITY_KEY_MODEL,
  crossCheckEligibilityKeys,
  formatEligibilityKeysLine,
  normaliseChemistryProfile,
  normaliseTeamChemLinks,
  readEligibilityKeys,
} from '../src/ea/adapter.js';
import { buildPool, normaliseClub } from '../src/solver/candidates.js';
import { improve, reevaluate, solve } from '../src/solver/solve.js';
import clubFixture from './fixtures/club-items.json';
import linksFixture from './fixtures/chemistry-teamlinks.json';
import profilesFixture from './fixtures/chemistry-profiles.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import set16 from './fixtures/sbs-set-16-challenges.json';
import { PINNED_ELIGIBILITY_KEYS, withEligibility } from './helpers/eligibility.js';

// Issue #16: the solver must not own the eligibility table. Every entry point
// that decodes `elgReq` requires the caller (the browser half) to supply the
// table read from EA's live `SBCEligibilityKey` enum, and there is no fallback
// to the pinned observation set anywhere on that path. The pinned values live
// in test/fixtures/eligibility-observation.js and are supplied here through the
// shared `withEligibility` helper.

const POOL = buildPool(normaliseClub(clubFixture.itemData));

const CHEMISTRY_RULE_SET = normaliseChemistryProfile({
  ...profilesFixture,
  mappings: [{ profileId: 4, rarityIds: [0, 69] }],
});

const options = (overrides = {}) =>
  withEligibility({
    seed: 1,
    chemistryRuleSet: CHEMISTRY_RULE_SET,
    clubLinks: linksFixture.teamChemLinks,
    ...overrides,
  });

describe('the solver requires the live eligibility tables', () => {
  const challenge = set16.challenges[0];

  it('solve throws a structured error naming options.keys, never a bare TypeError', () => {
    let caught;
    try {
      solve(challenge, POOL, { seed: 1 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TypeError);
    expect(caught.code).toBe('MISSING_ELIGIBILITY_TABLE');
    expect(caught.option).toBe('keys');
    expect(caught.message).toMatch(/options\.keys is required/);
  });

  it('solve throws naming options.scopes when only the keys are supplied', () => {
    let caught;
    try {
      solve(challenge, POOL, withEligibility({ seed: 1, scopes: undefined }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('MISSING_ELIGIBILITY_TABLE');
    expect(caught.option).toBe('scopes');
    expect(caught.message).toMatch(/options\.scopes is required/);
  });

  it('reevaluate throws naming options.keys instead of falling back', () => {
    const solved = solve(challenge, POOL, options());

    expect(() => reevaluate(solved.squad, [], POOL, { challenge, seed: 1 })).toThrow(
      /options\.keys is required/
    );
  });

  it('improve throws naming options.keys instead of falling back', () => {
    const solved = solve(challenge, POOL, options());

    expect(() => improve(solved.squad, POOL, { challenge, seed: 1 })).toThrow(
      /options\.keys is required/
    );
  });
});

describe('the pinned decode is unchanged through the new plumbing', () => {
  it('solves set 16 challenge 35 to the pinned cost and validity', () => {
    const result = solve(set16.challenges[0], POOL, options());

    // 769 is the pre-change observation pinned in test/prices-coverage.test.js,
    // not recomputed from the code under test.
    expect(result.valid).toBe(true);
    expect(result.cost).toBe(769);
    expect(result.failures).toEqual([]);
  });

  it('decodes set 10 challenge 25 to the pinned failures', () => {
    const result = solve(set10.challenges[0], POOL, options());

    // 829 is the pre-change observation pinned in test/prices-coverage.test.js.
    expect(result.valid).toBe(false);
    expect(result.cost).toBe(829);
    const nationCount = result.failures.find(({ kind }) => kind === 'NATION_COUNT');
    expect(nationCount).toMatchObject({ required: 2, scope: 'EXACT' });
  });
});

describe('src/solver cannot reach the pinned observation table', () => {  it('names no pinned table constant and no fixture path in any solver module', () => {
    const dir = new URL('../src/solver/', import.meta.url);
    const files = readdirSync(dir).filter((name) => name.endsWith('.js'));

    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const source = readFileSync(new URL(name, dir), 'utf8');
      for (const forbidden of [
        'PINNED_ELIGIBILITY_KEYS',
        'SCOPE_VALUES',
        'eligibility-observation',
      ]) {
        expect(source, `${name} must not mention ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

// A fake page window carrying the shape EA's TypeScript-compiled numeric enum
// has: name -> number and number -> name in the same object. Only the members
// this test needs are present; the production enum carries the rest.
const LIVE_ENUM = Object.freeze({
  PLAYER_COUNT: 2,
  2: 'PLAYER_COUNT',
  SCOPE: 13,
  13: 'SCOPE',
  TEAM_RATING_1_TO_100: 19,
  19: 'TEAM_RATING_1_TO_100',
});

describe('readEligibilityKeys against a fake page window', () => {
  it('builds the descriptor table from the live enum members and our stable model', () => {
    const resolved = readEligibilityKeys({ SBCEligibilityKey: LIVE_ENUM });

    expect(Object.keys(resolved.keys).map(Number).sort((left, right) => left - right)).toEqual([
      2, 13, 19,
    ]);
    expect(resolved.keys[2]).toEqual({
      type: 'PLAYER_COUNT',
      kind: 'PLAYER_COUNT_MATCH',
      role: 'count',
    });
    expect(resolved.keys[13]).toEqual({ type: 'SCOPE', kind: 'SCOPE', role: 'scope' });
    expect(resolved.keys[19]).toEqual({
      type: 'TEAM_RATING_1_TO_100',
      kind: 'TEAM_RATING',
      role: 'scalar',
    });
    expect(resolved.unmodelled).toEqual([]);
  });

  it('does not claim a live source for the scope enum', () => {
    const resolved = readEligibilityKeys({ SBCEligibilityKey: LIVE_ENUM });

    expect(resolved.scopes).toBeNull();
  });

  it('accepts a one-directional name-to-number enum', () => {
    const resolved = readEligibilityKeys({
      SBCEligibilityKey: { PLAYER_COUNT: 2, SCOPE: 13 },
    });

    expect(resolved.keys[2].type).toBe('PLAYER_COUNT');
    expect(resolved.keys[13].type).toBe('SCOPE');
  });

  it('falls back to the pinned number table and names the missing EA symbol', () => {
    const resolved = readEligibilityKeys({});

    expect(resolved.source).toBe('fallback');
    expect(resolved.liveError).toContain('SBCEligibilityKey');
    expect(resolved.keys[2].type).toBe('PLAYER_COUNT');
  });

  it('rejects an empty enum instead of resolving an empty table', () => {
    expect(() => readEligibilityKeys({ SBCEligibilityKey: {} })).toThrow(/no members/);
  });

  it('rejects a member that is neither a name nor a number, without a half-table', () => {
    expect(() =>
      readEligibilityKeys({ SBCEligibilityKey: { PLAYER_COUNT: 'two' } })
    ).toThrow(/malformed/);
    expect(() =>
      readEligibilityKeys({ SBCEligibilityKey: { PLAYER_COUNT: 2, 2: 'SCOPE' } })
    ).toThrow(/malformed/);
    expect(() => readEligibilityKeys({ SBCEligibilityKey: [] })).toThrow(/malformed/);
  });

  it('keeps a live member our model cannot name unmodelled, and a challenge using it raises', () => {
    const resolved = readEligibilityKeys({
      SBCEligibilityKey: { ...LIVE_ENUM, PLAYER_RARITY: 40, 40: 'PLAYER_RARITY' },
    });

    expect(resolved.keys[40]).toBeUndefined();
    expect(resolved.unmodelled).toContainEqual({ eligibilityKey: 40, type: 'PLAYER_RARITY' });

    const challenge = {
      formation: 'f442',
      elgOperation: 'AND',
      elgReq: [
        { type: 'PLAYER_RARITY', eligibilitySlot: 1, eligibilityKey: 40, eligibilityValue: 1 },
        { type: 'SCOPE', eligibilitySlot: 1, eligibilityKey: 13, eligibilityValue: 0 },
      ],
    };

    expect(() =>
      solve(challenge, POOL, options({ keys: resolved.keys }))
    ).toThrow(/Unknown eligibilityKey 40/);
  });
});

describe('the live-built table matches the pinned observation set', () => {
  const liveEnumFromPinned = () => {
    const enumTable = {};
    for (const [key, descriptor] of Object.entries(PINNED_ELIGIBILITY_KEYS)) {
      enumTable[key] = descriptor.type;
      enumTable[descriptor.type] = Number(key);
    }
    return enumTable;
  };

  it('models every member name the fixtures observed', () => {
    for (const descriptor of Object.values(PINNED_ELIGIBILITY_KEYS)) {
      expect(ELIGIBILITY_KEY_MODEL[descriptor.type], descriptor.type).toBeDefined();
    }
  });

  it('builds every pinned descriptor exactly from enum member names and numbers', () => {
    const resolved = readEligibilityKeys({ SBCEligibilityKey: liveEnumFromPinned() });

    for (const [key, descriptor] of Object.entries(PINNED_ELIGIBILITY_KEYS)) {
      expect(resolved.keys[key], `eligibilityKey ${key}`).toEqual(descriptor);
    }
    expect(resolved.unmodelled).toEqual([]);
    expect(crossCheckEligibilityKeys(resolved.keys, PINNED_ELIGIBILITY_KEYS)).toEqual({
      added: [],
      missing: [],
      renamed: [],
    });
  });
});

describe('crossCheckEligibilityKeys', () => {
  const observed = {
    2: { type: 'PLAYER_COUNT', kind: 'PLAYER_COUNT_MATCH', role: 'count' },
    19: { type: 'TEAM_RATING_1_TO_100', kind: 'TEAM_RATING', role: 'scalar' },
  };

  it('adds a live key our table does not model, in an actionable shape', () => {
    const live = {
      2: { type: 'PLAYER_COUNT', kind: 'PLAYER_COUNT_MATCH', role: 'count' },
      40: { type: 'PLAYER_RARITY', kind: 'PLAYER_RARITY', role: 'scalar' },
    };

    expect(crossCheckEligibilityKeys(live, observed).added).toEqual([
      { eligibilityKey: 40, type: 'PLAYER_RARITY' },
    ]);
  });

  it('reports a key we model that the live enum does not have, as a mismatch to investigate', () => {
    const live = {
      2: { type: 'PLAYER_COUNT', kind: 'PLAYER_COUNT_MATCH', role: 'count' },
    };

    expect(crossCheckEligibilityKeys(live, observed).missing).toEqual([
      { eligibilityKey: 19, type: 'TEAM_RATING_1_TO_100' },
    ]);
  });

  it('reports the same number wearing a different name as a rename, never reconciling it', () => {
    const live = { 19: { type: 'TEAM_STAR_RATING', kind: 'TEAM_RATING', role: 'scalar' } };

    expect(crossCheckEligibilityKeys(live, observed).renamed).toEqual([
      { eligibilityKey: 19, liveType: 'TEAM_STAR_RATING', observedType: 'TEAM_RATING_1_TO_100' },
    ]);
  });

  it('reports no drift for identical tables', () => {
    expect(crossCheckEligibilityKeys(observed, observed)).toEqual({
      added: [],
      missing: [],
      renamed: [],
    });
  });
});

describe('formatEligibilityKeysLine', () => {
  it('renders one pasteable line with every resolved key, the unmodelled members and the report', () => {
    const line = formatEligibilityKeysLine({
      keys: {
        2: { type: 'PLAYER_COUNT' },
        19: { type: 'TEAM_RATING_1_TO_100' },
      },
      unmodelled: [{ eligibilityKey: 40, type: 'PLAYER_RARITY' }],
      report: {
        added: [],
        missing: [{ eligibilityKey: 10, type: 'NATION_ID' }],
        renamed: [],
      },
    });

    expect(line).not.toContain('\n');
    expect(line).toContain('2=PLAYER_COUNT');
    expect(line).toContain('19=TEAM_RATING_1_TO_100');
    expect(line).toContain('40=PLAYER_RARITY');
    expect(line).toContain('NATION_ID');
    expect(line).toContain('scopes');
  });
});
