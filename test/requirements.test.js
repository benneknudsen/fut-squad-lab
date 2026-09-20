import { describe, expect, it } from 'vitest';

import set10 from './fixtures/sbs-set-10-challenges.json';
import set16 from './fixtures/sbs-set-16-challenges.json';
import { PINNED_ELIGIBILITY_KEYS, SCOPE_VALUES } from './helpers/eligibility.js';
import { ELIGIBILITY_KEY_MODEL } from '../src/ea/adapter.js';
import { DEFAULT_SCOPE, normaliseRequirements } from '../src/solver/requirements.js';

// Accepted/rejected squad cases cannot live here yet: they require a logged-in
// FC27 session and experimental submissions against the live challenge. They are
// tracked in issue #2 (validating our constraint semantics against EA's own
// challenge display) and issue #16 (the page bridge needed for live enum reads
// and page-side checks). Until those land, this suite combines tests against the
// captured payloads with explicitly labelled inference tests.

const normalise = (elgReq, operation = 'AND') =>
  normaliseRequirements(elgReq, {
    operation,
    keys: PINNED_ELIGIBILITY_KEYS,
    scopes: SCOPE_VALUES,
  });

// These expectations encode our inference that scope value 2 is EXACT and scope
// value 1 is LOWER (see the SCOPE_VALUES provenance comment in
// src/ea/adapter.js). They are not a reading of an EA enum; the challenge titles
// in the fixtures are the cross-check.
const SET_10_EXPECTED = {
  25: [
    { kind: 'LEAGUE_COUNT', value: 3, scope: 'EXACT' },
    { kind: 'NATION_COUNT', value: 2, scope: 'EXACT' },
    { kind: 'SAME_LEAGUE_COUNT', value: 6, scope: 'LOWER' },
    { kind: 'SAME_NATION_COUNT', value: 6, scope: 'LOWER' },
    { kind: 'PLAYER_QUALITY', value: 3, scope: 'EXACT' },
    { kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' },
  ],
  26: [
    { kind: 'LEAGUE_COUNT', value: 4, scope: 'EXACT' },
    { kind: 'NATION_COUNT', value: 5, scope: 'EXACT' },
    { kind: 'SAME_LEAGUE_COUNT', value: 4, scope: 'LOWER' },
    { kind: 'SAME_NATION_COUNT', value: 3, scope: 'LOWER' },
    { kind: 'TEAM_RATING', value: 78, scope: 'GREATER' },
    { kind: 'CHEMISTRY_POINTS', value: 25, scope: 'GREATER' },
  ],
  27: [
    { kind: 'LEAGUE_COUNT', value: 5, scope: 'EXACT' },
    { kind: 'NATION_COUNT', value: 6, scope: 'EXACT' },
    { kind: 'SAME_CLUB_COUNT', value: 2, scope: 'LOWER' },
    { kind: 'TEAM_RATING', value: 81, scope: 'GREATER' },
    { kind: 'CHEMISTRY_POINTS', value: 25, scope: 'GREATER' },
  ],
};

const SET_16_EXPECTED = {
  35: [
    { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { nationIds: [42] } },
    { kind: 'CLUB_COUNT', value: 2, scope: 'GREATER' },
    { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { playerLevels: [2] } },
    { kind: 'PLAYER_QUALITY', value: 1, scope: 'GREATER' },
    { kind: 'CHEMISTRY_POINTS', value: 14, scope: 'GREATER' },
  ],
  37: [
    { kind: 'PLAYER_COUNT_MATCH', value: 2, scope: 'GREATER', match: { leagueIds: [308] } },
    { kind: 'PLAYER_COUNT_MATCH', value: 2, scope: 'GREATER', match: { nationIds: [38] } },
    { kind: 'LEAGUE_COUNT', value: 6, scope: 'LOWER' },
    { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { playerLevels: [3] } },
    { kind: 'PLAYER_QUALITY', value: 2, scope: 'GREATER' },
    { kind: 'CHEMISTRY_POINTS', value: 18, scope: 'GREATER' },
  ],
  38: [
    { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { clubIds: [73, 219] } },
    { kind: 'PLAYER_COUNT_MATCH', value: 2, scope: 'GREATER', match: { nationIds: [18] } },
    { kind: 'SAME_LEAGUE_COUNT', value: 5, scope: 'LOWER' },
    { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { playerLevels: [3] } },
    { kind: 'PLAYER_QUALITY', value: 2, scope: 'GREATER' },
    { kind: 'CHEMISTRY_POINTS', value: 22, scope: 'GREATER' },
  ],
  39: [
    { kind: 'PLAYER_COUNT_MATCH', value: 2, scope: 'GREATER', match: { clubIds: [240, 243] } },
    { kind: 'PLAYER_COUNT_MATCH', value: 2, scope: 'GREATER', match: { leagueIds: [53] } },
    { kind: 'SAME_NATION_COUNT', value: 4, scope: 'GREATER' },
    { kind: 'SAME_CLUB_COUNT', value: 3, scope: 'LOWER' },
    { kind: 'TEAM_RATING', value: 75, scope: 'GREATER' },
    { kind: 'CHEMISTRY_POINTS', value: 26, scope: 'GREATER' },
  ],
};

// The payload `type` strings EA ships for those keys. They stay in the adapter as
// cross-check input even though the decoder emits the stable `kind`s above.
const OBSERVED_TYPES = {
  2: 'PLAYER_COUNT',
  3: 'PLAYER_QUALITY',
  4: 'SAME_NATION_COUNT',
  5: 'SAME_LEAGUE_COUNT',
  6: 'SAME_CLUB_COUNT',
  7: 'NATION_COUNT',
  8: 'LEAGUE_COUNT',
  9: 'CLUB_COUNT',
  10: 'NATION_ID',
  11: 'LEAGUE_ID',
  12: 'CLUB_ID',
  13: 'SCOPE',
  17: 'PLAYER_LEVEL',
  19: 'TEAM_RATING_1_TO_100',
  35: 'CHEMISTRY_POINTS',
};

const challengeCases = (fixture) =>
  fixture.challenges.map((challenge) => [challenge.challengeId, challenge]);

const allCases = [...challengeCases(set10), ...challengeCases(set16)];
const allExpected = { ...SET_10_EXPECTED, ...SET_16_EXPECTED };

const sortedNumbers = (values) => [...values].sort((a, b) => a - b);

const scopeEntry = (slot, value) => ({
  type: 'SCOPE',
  eligibilitySlot: slot,
  eligibilityKey: 13,
  eligibilityValue: value,
});

// The eligibility keys issue #53 added to the model, with the live numbers from
// the issue. The pinned observation table above only carries what the captured
// fixtures use; these numbers are facts about EA's enum, and the descriptors
// come from `ELIGIBILITY_KEY_MODEL` so the tests exercise the model the live
// reader builds descriptors from.
const MODEL_KEY_NUMBERS = Object.freeze({
  PLAYER_RARITY_GROUP: 25,
  PLAYER_MIN_OVR: 26,
  PLAYER_EXACT_OVR: 27,
  PLAYER_MAX_OVR: 28,
  PLAYER_TRADABILITY: 33,
  ALL_PLAYERS_CHEMISTRY_POINTS: 36,
});

const MODEL_KEYS = Object.freeze(
  Object.fromEntries(
    Object.entries(MODEL_KEY_NUMBERS).map(([name, number]) => [
      number,
      Object.freeze({ type: name, ...ELIGIBILITY_KEY_MODEL[name] }),
    ])
  )
);

const EXTENDED_KEYS = Object.freeze({ ...PINNED_ELIGIBILITY_KEYS, ...MODEL_KEYS });

const normaliseExtended = (elgReq) =>
  normaliseRequirements(elgReq, { keys: EXTENDED_KEYS, scopes: SCOPE_VALUES }).constraints;

describe('normaliseRequirements against the captured challenge payloads', () => {
  it('covers every challenge in both fixtures', () => {
    expect(sortedNumbers(allCases.map(([id]) => id))).toEqual(
      sortedNumbers(Object.keys(allExpected).map(Number))
    );
  });

  it.each(allCases)('normalises challenge %i with its own elgOperation', (id, challenge) => {
    expect(normalise(challenge.elgReq, challenge.elgOperation)).toEqual({
      constraints: allExpected[id],
      operation: 'AND',
    });
  });

  it('names 3 Leagues & 2 Nations as exactly 3 leagues, 2 nations, max 6 same league, max 6 same nation and 30 chemistry', () => {
    const challenge = set10.challenges.find((entry) => entry.challengeId === 25);
    expect(challenge.name).toBe('3 Leagues & 2 Nations');

    const { constraints } = normalise(challenge.elgReq, challenge.elgOperation);

    expect(constraints).toHaveLength(6);
    expect(constraints).toEqual(
      expect.arrayContaining([
        { kind: 'LEAGUE_COUNT', value: 3, scope: 'EXACT' },
        { kind: 'NATION_COUNT', value: 2, scope: 'EXACT' },
        { kind: 'SAME_LEAGUE_COUNT', value: 6, scope: 'LOWER' },
        { kind: 'SAME_NATION_COUNT', value: 6, scope: 'LOWER' },
        { kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' },
      ])
    );
  });
});

describe('the pinned observation table', () => {
  it('is frozen, descriptor by descriptor', () => {
    expect(Object.isFrozen(PINNED_ELIGIBILITY_KEYS)).toBe(true);
    for (const descriptor of Object.values(PINNED_ELIGIBILITY_KEYS)) {
      expect(Object.isFrozen(descriptor)).toBe(true);
    }
  });

  it('maps exactly the keys observed in the fixtures, with the payload type strings', () => {
    const observed = new Set();
    for (const [, challenge] of allCases) {
      for (const entry of challenge.elgReq) observed.add(entry.eligibilityKey);
    }

    expect(sortedNumbers(observed)).toEqual(
      sortedNumbers(Object.keys(OBSERVED_TYPES).map(Number))
    );
    for (const [key, name] of Object.entries(OBSERVED_TYPES)) {
      expect(PINNED_ELIGIBILITY_KEYS[key].type).toBe(name);
    }
  });

  it('gives every descriptor a stable kind and no value domain', () => {
    for (const [key, descriptor] of Object.entries(PINNED_ELIGIBILITY_KEYS)) {
      expect(typeof descriptor.kind, `kind for eligibilityKey ${key}`).toBe('string');
      expect(descriptor.kind.length, `kind for eligibilityKey ${key}`).toBeGreaterThan(0);
      expect(descriptor).not.toHaveProperty('allowedValues');
    }
  });

  it('keeps a stable kind separate from EA volatile type strings where they differ', () => {
    expect(PINNED_ELIGIBILITY_KEYS[19].type).toBe('TEAM_RATING_1_TO_100');
    expect(PINNED_ELIGIBILITY_KEYS[19].kind).toBe('TEAM_RATING');
    expect(PINNED_ELIGIBILITY_KEYS[2].kind).toBe('PLAYER_COUNT_MATCH');
  });
});

describe('the keys and scopes mappings are required input', () => {
  it('throws when the options object is missing', () => {
    expect(() => normaliseRequirements([])).toThrow(/options object/);
  });

  it('throws when the keys mapping is missing', () => {
    expect(() => normaliseRequirements([], { operation: 'AND' })).toThrow(/keys mapping is required/);
  });

  it('throws when the scopes mapping is missing', () => {
    expect(() =>
      normaliseRequirements([], { operation: 'AND', keys: PINNED_ELIGIBILITY_KEYS })
    ).toThrow(/scopes mapping is required/);
  });

  it('decodes with any caller-supplied mapping and carries no EA table of its own', () => {
    const keys = {
      1: { type: 'COUNT', kind: 'COUNT', role: 'count' },
      2: { type: 'TEAM', kind: 'TEAM_MATCH', role: 'match', field: 'teamIds' },
      3: { type: 'SCOPE', kind: 'SCOPE', role: 'scope' },
    };
    const scopes = { 9: 'AT_LEAST' };

    const { constraints } = normaliseRequirements(
      [
        { type: 'COUNT', eligibilitySlot: 1, eligibilityKey: 1, eligibilityValue: 2 },
        { type: 'TEAM', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 7 },
        { type: 'TEAM', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 9 },
        { type: 'SCOPE', eligibilitySlot: 1, eligibilityKey: 3, eligibilityValue: 9 },
      ],
      { operation: 'AND', keys, scopes }
    );

    expect(constraints).toEqual([
      { kind: 'COUNT', value: 2, scope: 'AT_LEAST', match: { teamIds: [7, 9] } },
    ]);
  });
});

describe('inference: scope comparison labels come from our mapping, not an EA enum', () => {
  it('names the comparison values used by the fixtures', () => {
    expect(SCOPE_VALUES).toEqual({ 0: 'GREATER', 1: 'LOWER', 2: 'EXACT', 3: 'RANGE' });
  });

  it('attaches SCOPE to the requirement that shares its eligibilitySlot', () => {
    const { constraints } = normalise([
      { type: 'NATION_COUNT', eligibilitySlot: 2, eligibilityKey: 7, eligibilityValue: 5 },
      scopeEntry(2, 2),
      { type: 'SAME_LEAGUE_COUNT', eligibilitySlot: 1, eligibilityKey: 5, eligibilityValue: 4 },
      scopeEntry(1, 1),
    ]);

    expect(constraints).toEqual([
      { kind: 'SAME_LEAGUE_COUNT', value: 4, scope: 'LOWER' },
      { kind: 'NATION_COUNT', value: 5, scope: 'EXACT' },
    ]);
  });

  it('returns constraints ordered by eligibilitySlot', () => {
    const { constraints } = normalise([
      { type: 'CHEMISTRY_POINTS', eligibilitySlot: 6, eligibilityKey: 35, eligibilityValue: 25 },
      scopeEntry(6, 0),
      { type: 'PLAYER_QUALITY', eligibilitySlot: 1, eligibilityKey: 3, eligibilityValue: 3 },
      scopeEntry(1, 2),
    ]);

    expect(constraints.map((constraint) => constraint.kind)).toEqual([
      'PLAYER_QUALITY',
      'CHEMISTRY_POINTS',
    ]);
  });
});

describe('inference: PLAYER_QUALITY is an opaque integer; the observed 1-3 range is not a closed domain', () => {
  const OBSERVED_TIERS = [1, 2, 3];
  const UNOBSERVED_TIERS = [0, 4, 99];
  const SCOPES = [
    ['GREATER', 0],
    ['LOWER', 1],
    ['EXACT', 2],
  ];

  const qualityEntry = (slot, value) => ({
    type: 'PLAYER_QUALITY',
    eligibilitySlot: slot,
    eligibilityKey: 3,
    eligibilityValue: value,
  });

  it.each(OBSERVED_TIERS.flatMap((tier) => SCOPES.map(([scope, value]) => [tier, scope, value])))(
    'passes observed tier %i through unchanged under scope %s',
    (tier, scope, scopeValue) => {
      const { constraints } = normalise([qualityEntry(1, tier), scopeEntry(1, scopeValue)]);

      expect(constraints).toEqual([{ kind: 'PLAYER_QUALITY', value: tier, scope }]);
    }
  );

  it.each(UNOBSERVED_TIERS)(
    'passes unobserved tier %i through instead of rejecting it as outside a domain',
    (tier) => {
      const { constraints } = normalise([qualityEntry(1, tier), scopeEntry(1, 0)]);

      expect(constraints).toEqual([{ kind: 'PLAYER_QUALITY', value: tier, scope: 'GREATER' }]);
    }
  );

  it('emits mixed quality tiers and scopes side by side without aggregating them', () => {
    // Whether tiers combine into a floor, a ceiling or a single-tier rule is
    // unverified (issues #2 and #16). This only pins that the decoder does not
    // invent an aggregation: mixed tiers stay separate pass-through constraints.
    const { constraints } = normalise([
      qualityEntry(1, 3),
      scopeEntry(1, 2),
      qualityEntry(2, 2),
      scopeEntry(2, 0),
      qualityEntry(3, 1),
      scopeEntry(3, 1),
    ]);

    expect(constraints).toEqual([
      { kind: 'PLAYER_QUALITY', value: 3, scope: 'EXACT' },
      { kind: 'PLAYER_QUALITY', value: 2, scope: 'GREATER' },
      { kind: 'PLAYER_QUALITY', value: 1, scope: 'LOWER' },
    ]);
  });
});

describe('PLAYER_COUNT discriminators', () => {
  it('groups repeated discriminator values in one slot into a single match', () => {
    const { constraints } = normalise([
      { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
      { type: 'CLUB_ID', eligibilitySlot: 1, eligibilityKey: 12, eligibilityValue: 73 },
      { type: 'CLUB_ID', eligibilitySlot: 1, eligibilityKey: 12, eligibilityValue: 219 },
      scopeEntry(1, 0),
    ]);

    expect(constraints).toEqual([
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { clubIds: [73, 219] } },
    ]);
  });
});

describe('a slot with no SCOPE entry defaults to a minimum, explicitly', () => {
  it('exports the default comparison as a named minimum operator', () => {
    expect(DEFAULT_SCOPE).toBe('GREATER');
  });

  it('treats a count with no SCOPE entry as "at least N", never "exactly N"', () => {
    const { constraints } = normalise([
      { type: 'CHEMISTRY_POINTS', eligibilitySlot: 5, eligibilityKey: 35, eligibilityValue: 30 },
    ]);

    expect(constraints).toEqual([{ kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' }]);
  });

  it('applies the default to a count match as well', () => {
    const { constraints } = normalise([
      { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
      { type: 'NATION_ID', eligibilitySlot: 1, eligibilityKey: 10, eligibilityValue: 42 },
    ]);

    expect(constraints).toEqual([
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { nationIds: [42] } },
    ]);
  });
});

describe('scope value 3 resolves to a range, never to exact or minimum', () => {
  it('pins RANGE in the scope table', () => {
    expect(SCOPE_VALUES[3]).toBe('RANGE');
  });

  it('carries RANGE through the decode without degrading it', () => {
    const { constraints } = normalise([
      { type: 'CHEMISTRY_POINTS', eligibilitySlot: 5, eligibilityKey: 35, eligibilityValue: 30 },
      scopeEntry(5, 3),
    ]);

    expect(constraints).toEqual([{ kind: 'CHEMISTRY_POINTS', value: 30, scope: 'RANGE' }]);
  });

  it('does not silently map an unknown scope number onto RANGE', () => {
    expect(() =>
      normalise([
        { type: 'CHEMISTRY_POINTS', eligibilitySlot: 5, eligibilityKey: 35, eligibilityValue: 30 },
        scopeEntry(5, 4),
      ])
    ).toThrow(/scope value 4/);
  });
});

describe('scope operator names are matched loosely', () => {
  const scoped = (operator) =>
    normaliseRequirements(
      [
        { type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 30 },
        scopeEntry(1, 9),
      ],
      { keys: PINNED_ELIGIBILITY_KEYS, scopes: { 9: operator } }
    ).constraints;

  it.each([
    ['minimum', 'GREATER'],
    ['MIN', 'GREATER'],
    ['greater than or equal', 'GREATER'],
    ['maximum', 'LOWER'],
    ['LESS than', 'LOWER'],
    ['lower than or equal', 'LOWER'],
    ['exact', 'EXACT'],
    ['a RANGE of values', 'RANGE'],
  ])('canonicalises the operator name %s to %s', (name, canonical) => {
    expect(scoped(name)).toEqual([{ kind: 'CHEMISTRY_POINTS', value: 30, scope: canonical }]);
  });
});

describe('count = -1 is a sentinel, never a requirement of minus one', () => {
  it('resolves the target from the value when count is the -1 sentinel', () => {
    const { constraints } = normalise([
      {
        type: 'CHEMISTRY_POINTS',
        eligibilitySlot: 1,
        eligibilityKey: 35,
        eligibilityValue: 30,
        count: -1,
      },
      scopeEntry(1, 0),
    ]);

    expect(constraints).toEqual([{ kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' }]);
  });

  it('fails naming the -1 sentinel when the value cannot supply a target', () => {
    expect(() =>
      normalise([
        {
          type: 'CHEMISTRY_POINTS',
          eligibilitySlot: 1,
          eligibilityKey: 35,
          eligibilityValue: -1,
          count: -1,
        },
        scopeEntry(1, 0),
      ])
    ).toThrow(/-1.*sentinel|sentinel.*-1/);
  });

  it('never reads a bare -1 value as a requirement of minus one', () => {
    expect(() =>
      normalise([
        { type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: -1 },
        scopeEntry(1, 0),
      ])
    ).toThrow(/-1/);
  });
});

describe('the eligibility keys issue #53 adds are decoded', () => {
  it('decodes key 13 SCOPE inside the key list into the slot comparison', () => {
    const { constraints } = normalise([
      { type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 30 },
      { type: 'SCOPE', eligibilitySlot: 1, eligibilityKey: 13, eligibilityValue: 2 },
    ]);

    expect(constraints).toEqual([{ kind: 'CHEMISTRY_POINTS', value: 30, scope: 'EXACT' }]);
  });

  it('decodes key 26 PLAYER_MIN_OVR as a minimum-rating discriminator', () => {
    expect(
      normaliseExtended([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        { type: 'PLAYER_MIN_OVR', eligibilitySlot: 1, eligibilityKey: 26, eligibilityValue: 85 },
        scopeEntry(1, 0),
      ])
    ).toEqual([
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { minRatings: [85] } },
    ]);
  });

  it('decodes key 27 PLAYER_EXACT_OVR as an exact-rating discriminator', () => {
    expect(
      normaliseExtended([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        { type: 'PLAYER_EXACT_OVR', eligibilitySlot: 1, eligibilityKey: 27, eligibilityValue: 84 },
        scopeEntry(1, 0),
      ])
    ).toEqual([
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { exactRatings: [84] } },
    ]);
  });

  it('decodes key 28 PLAYER_MAX_OVR as a maximum-rating discriminator', () => {
    expect(
      normaliseExtended([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        { type: 'PLAYER_MAX_OVR', eligibilitySlot: 1, eligibilityKey: 28, eligibilityValue: 79 },
        scopeEntry(1, 0),
      ])
    ).toEqual([
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { maxRatings: [79] } },
    ]);
  });

  it('decodes key 33 PLAYER_TRADABILITY as a tradeability discriminator', () => {
    expect(
      normaliseExtended([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        { type: 'PLAYER_TRADABILITY', eligibilitySlot: 1, eligibilityKey: 33, eligibilityValue: 1 },
        scopeEntry(1, 0),
      ])
    ).toEqual([
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { tradabilities: [1] } },
    ]);
  });

  it('decodes key 35 CHEMISTRY_POINTS as a scalar', () => {
    expect(
      normaliseExtended([
        { type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 30 },
        scopeEntry(1, 0),
      ])
    ).toEqual([{ kind: 'CHEMISTRY_POINTS', value: 30, scope: 'GREATER' }]);
  });

  it('decodes key 36 ALL_PLAYERS_CHEMISTRY_POINTS as a scalar', () => {
    expect(
      normaliseExtended([
        {
          type: 'ALL_PLAYERS_CHEMISTRY_POINTS',
          eligibilitySlot: 1,
          eligibilityKey: 36,
          eligibilityValue: 8,
        },
        scopeEntry(1, 0),
      ])
    ).toEqual([{ kind: 'ALL_PLAYERS_CHEMISTRY_POINTS', value: 8, scope: 'GREATER' }]);
  });
});

describe('key 25 PLAYER_RARITY_GROUP is disambiguated by label and value', () => {
  const rarityGroup = (slot, value, label) => ({
    type: 'PLAYER_RARITY_GROUP',
    eligibilitySlot: slot,
    eligibilityKey: 25,
    eligibilityValue: value,
    ...(label === undefined ? {} : { label }),
  });

  it('decodes a geographic region named by the label', () => {
    expect(
      normaliseExtended([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        rarityGroup(1, 44, 'Players from Europe'),
        scopeEntry(1, 0),
      ])
    ).toEqual([
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { rarityGroups: ['europe'] } },
    ]);
  });

  it('decodes TOTS from the label', () => {
    expect(
      normaliseExtended([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        rarityGroup(1, 44, 'Team of the Season players'),
        scopeEntry(1, 0),
      ])
    ).toEqual([
      { kind: 'PLAYER_COUNT_MATCH', value: 1, scope: 'GREATER', match: { rarityGroups: ['TOTS'] } },
    ]);
  });

  it('decodes TOTW-or-TOTS from the value 44 when the label does not name TOTS', () => {
    expect(
      normaliseExtended([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        rarityGroup(1, 44),
        scopeEntry(1, 0),
      ])
    ).toEqual([
      {
        kind: 'PLAYER_COUNT_MATCH',
        value: 1,
        scope: 'GREATER',
        match: { rarityGroups: ['TOTW_OR_TOTS'] },
      },
    ]);
  });

  it('refuses to guess when neither label nor value names a meaning', () => {
    expect(() =>
      normaliseExtended([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        rarityGroup(1, 7),
        scopeEntry(1, 0),
      ])
    ).toThrow(/eligibilityKey 25/);
  });
});

describe('fail-loud behaviour', () => {
  const withScope = (entry, scopeValue = 0) => [entry, scopeEntry(1, scopeValue)];

  it.each([null, undefined, 42, 'PLAYER_COUNT'])(
    'throws on a non-object elgReq entry (%j)',
    (entry) => {
      expect(() => normalise([entry])).toThrow(/elgReq entries must be objects/);
    }
  );

  it.each([0, -1, 1.5, '1'])('throws on an invalid eligibilitySlot (%j)', (slot) => {
    expect(() =>
      normalise(
        withScope({
          type: 'CHEMISTRY_POINTS',
          eligibilitySlot: slot,
          eligibilityKey: 35,
          eligibilityValue: 30,
        })
      )
    ).toThrow(/invalid eligibilitySlot/);
  });

  it('throws on a mapped role the decoder does not support', () => {
    const keys = { 99: { type: 'WEIRD', kind: 'WEIRD', role: 'banana' } };

    expect(() =>
      normaliseRequirements(
        [{ type: 'WEIRD', eligibilitySlot: 1, eligibilityKey: 99, eligibilityValue: 1 }],
        { keys, scopes: { 0: 'GREATER' } }
      )
    ).toThrow(/unsupported role "banana"/);
  });

  it('throws on a match key without a field in the keys mapping', () => {
    const keys = { 99: { type: 'NATION_ID', kind: 'NATION_MATCH', role: 'match' } };

    expect(() =>
      normaliseRequirements(
        [{ type: 'NATION_ID', eligibilitySlot: 1, eligibilityKey: 99, eligibilityValue: 42 }],
        { keys, scopes: { 0: 'GREATER' } }
      )
    ).toThrow(/match key without a field/);
  });

  it('throws on a key without a stable kind in the keys mapping', () => {
    const keys = { 99: { type: 'CHEMISTRY_POINTS', role: 'scalar' } };

    expect(() =>
      normaliseRequirements(
        [{ type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 99, eligibilityValue: 30 }],
        { keys, scopes: { 0: 'GREATER' } }
      )
    ).toThrow(/eligibilityKey 99 has no stable kind/);
  });

  it.each([2.5, '30', null, undefined, NaN])(
    'throws on a non-integer eligibilityValue (%j)',
    (value) => {
      expect(() =>
        normalise(
          withScope({
            type: 'CHEMISTRY_POINTS',
            eligibilitySlot: 1,
            eligibilityKey: 35,
            eligibilityValue: value,
          })
        )
      ).toThrow(/eligibilityValue for CHEMISTRY_POINTS in eligibilitySlot 1 must be an integer/);
    }
  );

  it('throws on an unknown eligibilityKey and names it', () => {
    expect(() =>
      normalise(
        withScope({ type: 'TEAM_STAR_RATING', eligibilitySlot: 1, eligibilityKey: 0, eligibilityValue: 4 })
      )
    ).toThrow(/eligibilityKey 0/);
  });

  it('rejects a numeric string eligibilityKey instead of coercing it', () => {
    expect(() =>
      normalise([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: '2', eligibilityValue: 1 },
        { type: 'CLUB_ID', eligibilitySlot: 1, eligibilityKey: 12, eligibilityValue: 73 },
        scopeEntry(1, 0),
      ])
    ).toThrow(/Unknown eligibilityKey "2"/);
  });

  it('rejects a non-integer eligibilityKey', () => {
    expect(() =>
      normalise(
        withScope({ type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35.5, eligibilityValue: 30 })
      )
    ).toThrow(/Unknown eligibilityKey 35.5/);
  });

  it('rejects a prototype key that is not in the mapping', () => {
    expect(() =>
      normalise(
        withScope({ type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: '__proto__', eligibilityValue: 1 })
      )
    ).toThrow(/Unknown eligibilityKey "__proto__"/);
  });

  it('throws when the numeric key and the type string disagree', () => {
    expect(() =>
      normalise(
        withScope({ type: 'NATION_COUNT', eligibilitySlot: 1, eligibilityKey: 8, eligibilityValue: 4 })
      )
    ).toThrow(/eligibilityKey 8 is LEAGUE_COUNT, but the payload claims "NATION_COUNT"/);
  });

  it('throws when an entry has no type string', () => {
    expect(() =>
      normalise([
        { eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 30 },
        scopeEntry(1, 0),
      ])
    ).toThrow(/has no type string/);
  });

  it('throws when an entry has an empty type string', () => {
    expect(() =>
      normalise([
        { type: '', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 30 },
        scopeEntry(1, 0),
      ])
    ).toThrow(/has no type string/);
  });

  it('throws on a SCOPE entry with no requirement in its slot', () => {
    expect(() => normalise([scopeEntry(3, 1)])).toThrow(/eligibilitySlot 3/);
  });

  it('defaults a slot with no SCOPE entry to a minimum instead of throwing', () => {
    expect(
      normalise([
        { type: 'CHEMISTRY_POINTS', eligibilitySlot: 5, eligibilityKey: 35, eligibilityValue: 30 },
      ])
    ).toEqual({
      constraints: [{ kind: 'CHEMISTRY_POINTS', value: 30, scope: DEFAULT_SCOPE }],
      operation: 'AND',
    });
  });

  it('throws on an unknown SCOPE value and names it', () => {
    expect(() =>
      normalise(
        withScope({ type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 30 }, 7)
      )
    ).toThrow(/scope value 7/);
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['a number', 3],
  ])('throws on a scopes mapping that maps to %s', (_label, operator) => {
    expect(() =>
      normaliseRequirements(
        [
          { type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 30 },
          { type: 'SCOPE', eligibilitySlot: 1, eligibilityKey: 13, eligibilityValue: 0 },
        ],
        { keys: PINNED_ELIGIBILITY_KEYS, scopes: { 0: operator } }
      )
    ).toThrow(/Malformed scopes mapping for value 0/);
  });

  it('throws when a slot carries more than one SCOPE entry', () => {
    expect(() =>
      normalise([
        { type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 30 },
        scopeEntry(1, 0),
        scopeEntry(1, 1),
      ])
    ).toThrow(/Multiple scope entries/);
  });

  it('throws when PLAYER_COUNT has no discriminator', () => {
    expect(() =>
      normalise(
        withScope({ type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 })
      )
    ).toThrow(
      /PLAYER_COUNT_MATCH in eligibilitySlot 1 has no nation\/league\/club\/level discriminator/
    );
  });

  it('throws when a discriminator has no count requirement', () => {
    expect(() =>
      normalise(
        withScope({ type: 'NATION_ID', eligibilitySlot: 1, eligibilityKey: 10, eligibilityValue: 42 })
      )
    ).toThrow(/NATION_MATCH in eligibilitySlot 1 has no count requirement/);
  });

  it('throws when one slot mixes two discriminator kinds', () => {
    expect(() =>
      normalise([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        { type: 'NATION_ID', eligibilitySlot: 1, eligibilityKey: 10, eligibilityValue: 42 },
        { type: 'CLUB_ID', eligibilitySlot: 1, eligibilityKey: 12, eligibilityValue: 73 },
        scopeEntry(1, 0),
      ])
    ).toThrow(/mixes NATION_MATCH and CLUB_MATCH/);
  });

  it('throws when a slot combines PLAYER_COUNT with a scalar requirement', () => {
    expect(() =>
      normalise([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        { type: 'PLAYER_QUALITY', eligibilitySlot: 1, eligibilityKey: 3, eligibilityValue: 2 },
        scopeEntry(1, 0),
      ])
    ).toThrow(/combines PLAYER_COUNT_MATCH with PLAYER_QUALITY/);
  });

  it('throws when one slot mixes two scalar requirement kinds', () => {
    expect(() =>
      normalise([
        { type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 30 },
        { type: 'PLAYER_QUALITY', eligibilitySlot: 1, eligibilityKey: 3, eligibilityValue: 3 },
        scopeEntry(1, 0),
      ])
    ).toThrow(/eligibilitySlot 1 combines CHEMISTRY_POINTS with PLAYER_QUALITY/);
  });

  it('throws on a duplicated scalar requirement in one slot', () => {
    expect(() =>
      normalise([
        { type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 30 },
        { type: 'CHEMISTRY_POINTS', eligibilitySlot: 1, eligibilityKey: 35, eligibilityValue: 25 },
        scopeEntry(1, 0),
      ])
    ).toThrow(/Duplicate CHEMISTRY_POINTS/);
  });

  it('throws on a duplicated count requirement in one slot', () => {
    expect(() =>
      normalise([
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 1 },
        { type: 'PLAYER_COUNT', eligibilitySlot: 1, eligibilityKey: 2, eligibilityValue: 2 },
        { type: 'CLUB_ID', eligibilitySlot: 1, eligibilityKey: 12, eligibilityValue: 73 },
        scopeEntry(1, 0),
      ])
    ).toThrow(/Duplicate PLAYER_COUNT_MATCH in eligibilitySlot 1/);
  });

  it('rejects input that is not an array', () => {
    expect(() => normalise(null)).toThrow(/must be an array/);
  });
});

describe('elgOperation: the captured fixtures only exercise AND', () => {
  it('pins that every captured challenge uses AND, so other operations are untested data', () => {
    // This is a limitation of the captured fixtures, not of the decoder. A
    // challenge combining requirements with OR (or another operation) has simply
    // never been observed. Issue #16 tracks capturing more of them.
    for (const [, challenge] of allCases) {
      expect(challenge.elgOperation).toBe('AND');
    }
  });

  it('rejects any elgOperation other than AND', () => {
    expect(() => normalise([], 'OR')).toThrow(/Unsupported elgOperation: "OR"/);
    expect(() => normalise([], 'SUM')).toThrow(/Unsupported elgOperation: "SUM"/);
  });
});

describe('empty input', () => {
  it('returns an empty constraint set with the default operation', () => {
    expect(normalise([])).toEqual({ constraints: [], operation: 'AND' });
  });
});
