/*
 * Scoring-layer tests: `normaliseChemistryProfile`, `resolveProfile`,
 * `playerChemistry` and `squadChemistry`.
 *
 * The ground truth is `chemistry-observed-squad.json`: EA's own chemistry for a
 * real squad. The formula under test is derived in the scoring block of
 * `src/solver/chemistry.js` and tagged [observed]/[inferred]/[hypothesis]
 * there; this file is where that derivation is held to the one observation we
 * have.
 *
 * The raw payloads carry EA field names, so this test normalises them through
 * `normaliseClubItem`, `normaliseTeamChemLinks` and
 * `normaliseChemistryProfile` before the solver sees them. A stable record
 * needs fields the chemistry does not read (prices, pile, role lists); the
 * observed-squad fixture was trimmed to the chemistry fields, so those are
 * filled with inert defaults here and can never affect a score.
 *
 * Coverage note: the captured rule set maps only rarity 69, while every
 * captured card carries `rareflag: 0`, which `normaliseClubItem` turns into
 * `rarity: 0`. `resolveProfile` would return null for the fixture cards
 * themselves, so the score tests pass the profile the captured mapping does
 * define (rarity 69) explicitly. The rule set is what is under test, and no
 * mapping for 0 is invented; `resolveProfile`'s own behaviour, including the
 * null it returns for 0, is pinned by the resolver tests.
 */

import { describe, expect, it } from 'vitest';

import observedSquad from './fixtures/chemistry-observed-squad.json';
import profilesFixture from './fixtures/chemistry-profiles.json';
import teamLinks from './fixtures/chemistry-teamlinks.json';
import {
  normaliseChemistryProfile,
  normaliseClubItem,
  normaliseTeamChemLinks,
} from '../src/ea/adapter.js';
import {
  buildClubIndex,
  CHEMISTRY_FORMULA_VERIFIED,
  playerChemistry,
  resolveProfile,
  squadChemistry,
} from '../src/solver/chemistry.js';

const RAW_ITEM_DEFAULTS = Object.freeze({
  playStyle: 0,
  pile: 0,
  owners: 0,
  untradeable: false,
  isCollected: false,
  marketAverage: null,
  marketDataMinPrice: null,
  marketDataMaxPrice: null,
  discardValue: null,
});

const stableRecordFor = (slot) =>
  normaliseClubItem({
    ...RAW_ITEM_DEFAULTS,
    id: slot.index + 1,
    assetId: slot.index + 1,
    ...slot.item,
  });

const STARTER_SLOTS = observedSquad.slots.slice(0, 11);
const BENCH_SLOTS = observedSquad.slots.slice(11);
const STARTERS = STARTER_SLOTS.map(stableRecordFor);
const BENCH = BENCH_SLOTS.map(stableRecordFor);

const RULE_SET = normaliseChemistryProfile(profilesFixture);
// The captured mapping covers rarity 69 only; the fixture cards carry
// `rareflag: 0`. The score tests pass this explicitly resolved profile instead
// of resolving each card's own rarity — see the coverage note in the header and
// the test that pins what `resolveProfile` does for 0.
const PROFILE = resolveProfile(69, RULE_SET);
const CLUB_INDEX = buildClubIndex(normaliseTeamChemLinks(teamLinks.teamChemLinks));

const EA_PER_PLAYER = observedSquad.eaPerPlayerChemistry.map((entry) => entry.chemistry);

const computedFor = (starters, profile = PROFILE, clubIndex = CLUB_INDEX) =>
  starters.map((player) => playerChemistry(player, starters, profile, clubIndex));

const computedTotal = (starters, profile = PROFILE, clubIndex = CLUB_INDEX) =>
  squadChemistry(starters, profile, clubIndex).chemistry;

const withRuleValue = (profile, dimension, value) => ({
  ...profile,
  rules: profile.rules.map((rule) => (rule.dimension === dimension ? { ...rule, value } : rule)),
});

const rawProfile = (overrides = {}) => ({
  baseOverride: false,
  iconOverride: false,
  heroOverride: false,
  fullChemistryOnPreferredPosition: false,
  rules: [{ parameterType: 'NATION', calculationType: 'NORMAL', value: 1 }],
  ...overrides,
});

describe('the observed squad fixture', () => {
  it('pins EA chemistry for eleven starters and no chemistry for the bench', () => {
    expect(EA_PER_PLAYER).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 2, 2]);
    expect(observedSquad.eaPerPlayerChemistry.map((entry) => entry.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(EA_PER_PLAYER.reduce((sum, chemistry) => sum + chemistry, 0)).toBe(
      observedSquad.eaChemistry
    );
    expect(observedSquad.eaChemistry).toBe(12);
    expect(BENCH_SLOTS).toHaveLength(12);
    expect(BENCH_SLOTS.map((slot) => slot.chemistry)).toEqual(new Array(12).fill(null));
  });
});

describe('the score path resolves its profile through the fixture mapping', () => {
  it('resolves rarity 69 to the mapped profile before scoring anything', () => {
    expect(PROFILE).not.toBeNull();
    expect(PROFILE.id).toBe(4);
    expect(PROFILE).toBe(RULE_SET.profiles[0]);
  });

  it('cannot resolve the fixture cards’ own rarity: the mapping covers 69, the cards carry 0', () => {
    // The honest bound of the capture: the observed squad's cards all carry
    // `rareflag: 0`, and the captured chemistry mapping names only rarity 69.
    // Production would therefore resolve these cards to null and refuse to
    // score them; the score tests above/below pass PROFILE explicitly because
    // the captured rule set is what is under test. No mapping for 0 is invented
    // here, and the null `resolveProfile` returns for 0 is pinned by the
    // resolver tests.
    expect(STARTERS.map((starter) => starter.rarity)).toEqual(new Array(11).fill(0));
    expect(resolveProfile(0, RULE_SET)).toBeNull();
  });

  it('scores with the profile the mapping resolves to, not the first profile listed', () => {
    const remapped = normaliseChemistryProfile({
      profiles: [
        rawProfile({ id: 1, rules: [{ parameterType: 'NATION', calculationType: 'NORMAL', value: 99 }] }),
        rawProfile({
          id: 2,
          rules: [
            { parameterType: 'NATION', calculationType: 'NORMAL', value: 1 },
            { parameterType: 'LEAGUE', calculationType: 'NORMAL', value: 7 },
            { parameterType: 'CLUB', calculationType: 'NORMAL', value: 2 },
          ],
        }),
      ],
      mappings: [{ profileId: 2, rarityIds: [69] }],
    });

    const resolved = resolveProfile(69, remapped);

    expect(resolved.id).toBe(2);
    // Nation points survive (eight starters still have one nation partner);
    // league 7 removes the four league points; total 12 -> 8.
    expect(computedTotal(STARTERS, resolved)).toBe(8);
  });
});

describe('the derived scoring formula against EA’s observed squad', () => {
  // This squad matches the formula derived in the module from the rule values
  // (`floor(matches / value)` per rule, sum capped at 3). It is asserted as an
  // equality, not `it.fails`, because the derivation reproduces every value;
  // the match is still one observation, which is why the module exports
  // CHEMISTRY_FORMULA_VERIFIED as false until the browser acceptance test.
  it('reproduces every per-player value EA displays', () => {
    expect(computedFor(STARTERS)).toEqual(EA_PER_PLAYER);
  });

  it('reproduces the squad total EA displays', () => {
    expect(computedTotal(STARTERS)).toBe(observedSquad.eaChemistry);
  });
});

describe('squadChemistry', () => {
  it('returns the total with the unverified status attached', () => {
    expect(squadChemistry(STARTERS, PROFILE, CLUB_INDEX)).toEqual({
      chemistry: 12,
      verified: false,
      reason: 'chemistry-formula-unverified',
    });
  });

  it('is the sum of the per-player values for the eleven starters', () => {
    const perPlayer = computedFor(STARTERS);
    const structuralSum = perPlayer.reduce((sum, chemistry) => sum + chemistry, 0);

    expect(computedTotal(STARTERS)).toBe(structuralSum);
    expect(structuralSum).toBe(12);
  });

  it('counts only the eleven starters it is given, never the bench records', () => {
    // EA stores chemistry null for all twelve bench slots (pinned above), so
    // the bench is out of scope by observation. Records that share nothing
    // with the XI or with each other add nothing wherever they sit in the
    // array; the real bench does share attributes, so passing it raises the
    // total from 12 to 36. That pins the XI boundary as load-bearing: the
    // caller, not this layer, must exclude the bench.
    const strangers = BENCH.map((player, index) => ({
      ...player,
      nationId: 9000 + index,
      leagueId: 9000 + index,
      clubId: 9000 + index,
    }));

    expect(computedTotal([...STARTERS, ...strangers])).toBe(12);
    expect(computedTotal([...STARTERS, ...BENCH])).toBe(36);
  });

  it('returns a whole number in 0–33 for the eleven starters and 0 for an empty squad', () => {
    const total = computedTotal(STARTERS);

    expect(Number.isNaN(total)).toBe(false);
    expect(Number.isInteger(total)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(33);
    expect(computedTotal([])).toBe(0);
  });

  it('reaches the documented maximum of 33 when all eleven share nation, league and club', () => {
    // Per-player chemistry is capped at 3 (EA's per-player scale), so eleven
    // capped players give a 33-point maximum.
    const eleven = Array.from({ length: 11 }, (unused, index) => ({
      id: 1000 + index,
      nationId: 14,
      leagueId: 13,
      clubId: 1943,
    }));

    expect(computedFor(eleven)).toEqual(new Array(11).fill(3));
    expect(computedTotal(eleven)).toBe(33);
  });

  it('lowers the total by exactly 3 when a stranger replaces one link partner', () => {
    const eleven = Array.from({ length: 11 }, (unused, index) => ({
      id: 1000 + index,
      nationId: 14,
      leagueId: 13,
      clubId: 1943,
    }));
    const stranger = { id: 9999, nationId: 1, leagueId: 2, clubId: 3 };

    expect(computedTotal(eleven)).toBe(33);
    expect(computedTotal([...eleven.slice(0, 10), stranger])).toBe(30);
  });
});

describe('playerChemistry', () => {
  it('scores a player with no shared nation, league or club at exactly 0', () => {
    // Starter 8 is the fixture's zero-link player: EA displays 0. [observed]
    expect(playerChemistry(STARTERS[8], STARTERS, PROFILE, CLUB_INDEX)).toBe(0);

    const stranger = { id: 9999, nationId: 1, leagueId: 2, clubId: 3 };

    expect(playerChemistry(stranger, STARTERS, PROFILE, CLUB_INDEX)).toBe(0);
  });

  it('keeps every observed player inside the documented 0–3 range', () => {
    for (const chemistry of computedFor(STARTERS)) {
      expect(Number.isInteger(chemistry)).toBe(true);
      expect(chemistry).toBeGreaterThanOrEqual(0);
      expect(chemistry).toBeLessThanOrEqual(3);
    }
  });

  it('counts linked clubs through the club index, not raw club ids', () => {
    // Clubs 1, 2 and 3 are one linked-club group, as men's and women's sides
    // of the same club are. Each player then has two club matches, which the
    // CLUB value 2 turns into one point; raising that value to 4 removes it.
    const index = buildClubIndex([{ clubId: 1, linkedClubIds: [2, 3] }]);
    const trio = [
      { id: 1, nationId: 1, leagueId: 1, clubId: 1 },
      { id: 2, nationId: 2, leagueId: 2, clubId: 2 },
      { id: 3, nationId: 3, leagueId: 3, clubId: 3 },
    ];
    const clubValueFour = withRuleValue(PROFILE, 'club', 4);

    for (const player of trio) {
      expect(playerChemistry(player, trio, PROFILE, index)).toBe(1);
      expect(playerChemistry(player, trio, clubValueFour, index)).toBe(0);
    }
  });
});

describe('playerChemistry rejects records that cannot link safely', () => {
  const complete = (id) => ({ id, nationId: id, leagueId: id, clubId: id });

  it.each(['id', 'nationId', 'leagueId', 'clubId'])(
    'throws when the scored player is missing a finite %s',
    (field) => {
      const player = complete(1);
      delete player[field];

      expect(() => playerChemistry(player, [player, complete(2)], PROFILE, CLUB_INDEX)).toThrow(
        new RegExp(`playerChemistry: player must carry a finite ${field}`)
      );
    }
  );

  it.each(['id', 'nationId', 'leagueId', 'clubId'])(
    'throws when another starter is missing a finite %s instead of counting a false link',
    (field) => {
      const other = complete(2);
      delete other[field];

      expect(() => playerChemistry(complete(1), [other], PROFILE, CLUB_INDEX)).toThrow(
        new RegExp(`playerChemistry: starters\\[0\\] must carry a finite ${field}`)
      );
    }
  );

  it('refuses to score the false-link case where two records without nationId share undefined', () => {
    // Without the identity guard, { id: 1 } and { id: 2 } compare
    // undefined === undefined in every dimension and score 3 under a
    // one-point-per-dimension profile. The guard must refuse the record
    // before any link is counted.
    const allOne = {
      ...PROFILE,
      rules: [
        { dimension: 'nation', calculation: 'normal', value: 1 },
        { dimension: 'league', calculation: 'normal', value: 1 },
        { dimension: 'club', calculation: 'normal', value: 1 },
      ],
    };

    expect(() => playerChemistry({ id: 1 }, [{ id: 1 }, { id: 2 }], allOne, CLUB_INDEX)).toThrow(
      /playerChemistry: player must carry a finite nationId/
    );
  });
});

describe('the profile drives every number', () => {
  it('reads the weights from the profile: doubling the nation value changes the score', () => {
    // Nation 1 -> 2 makes every single nation partner worth nothing, because
    // a point needs two matches. Eight starters lose exactly one nation point:
    // 2, 3, 4, 5, 6, 7 (one each) and 9, 10 (one each).
    const profile = withRuleValue(PROFILE, 'nation', 2);

    expect(computedTotal(STARTERS)).toBe(12);
    expect(computedTotal(STARTERS, profile)).toBe(4);
  });

  it('reads the weights from the profile: a longer league step changes the score', () => {
    // League 3 -> 4 makes the three league-31 partners worth nothing, so the
    // four starters with a league point (0, 1, 9, 10) each lose one: 12 -> 8.
    const profile = withRuleValue(PROFILE, 'league', 4);

    expect(computedTotal(STARTERS, profile)).toBe(8);
  });

  it('scores normal and universal calculation identically: the capture cannot separate them', () => {
    // [hypothesis] Both values appear in the one captured profile and no
    // capture shows a squad where they would differ, so this pins only what
    // the implementation does — the field does not enter the arithmetic — not
    // that EA treats the two identically.
    const allNormal = {
      ...PROFILE,
      rules: PROFILE.rules.map((rule) => ({ ...rule, calculation: 'normal' })),
    };
    const allUniversal = {
      ...PROFILE,
      rules: PROFILE.rules.map((rule) => ({ ...rule, calculation: 'universal' })),
    };

    expect(computedTotal(STARTERS, allNormal)).toBe(12);
    expect(computedTotal(STARTERS, allUniversal)).toBe(12);
  });

  it('throws on a profile that needs the formation slot instead of ignoring the flag', () => {
    // `fullChemistryAtPreferredPosition: true` promises placement matters,
    // but the scoring functions receive stable records and no formation slot
    // positions, so a player cannot be classified as in or out of position.
    // Scoring anyway would silently overstate chemistry, so the module
    // refuses until a layer that knows the formation supplies slot context.
    const fullPosition = { ...PROFILE, fullChemistryAtPreferredPosition: true };

    expect(() => playerChemistry(STARTERS[0], STARTERS, fullPosition, CLUB_INDEX)).toThrow(
      /fullChemistryAtPreferredPosition true/
    );
    expect(() => squadChemistry(STARTERS, fullPosition, CLUB_INDEX)).toThrow(/formation slot/);
  });

  it('throws when the preferred-position flag is not a boolean instead of assuming false', () => {
    const missing = { ...PROFILE, fullChemistryAtPreferredPosition: undefined };

    expect(() => playerChemistry(STARTERS[0], STARTERS, missing, CLUB_INDEX)).toThrow(
      /must carry fullChemistryAtPreferredPosition as a boolean/
    );
  });

  it('scores a profile whose position flag payload omitted, with a flag-specific reason', () => {
    // null means the payload did not state whether full chemistry requires
    // the preferred position. The arithmetic is unchanged, but the result
    // must say the flag was missing instead of pretending EA said false.
    const unknownFlag = { ...PROFILE, fullChemistryAtPreferredPosition: null };

    expect(computedFor(STARTERS, unknownFlag)).toEqual(EA_PER_PLAYER);
    expect(squadChemistry(STARTERS, unknownFlag, CLUB_INDEX)).toEqual({
      chemistry: 12,
      verified: false,
      reason: 'chemistry-position-flag-missing',
    });
    expect(squadChemistry(STARTERS, PROFILE, CLUB_INDEX).reason).toBe(
      'chemistry-formula-unverified'
    );
  });

  it('carries the missing flag from the adapter payload through to the squad result', () => {
    const raw = {
      mappings: [{ profileId: 4, rarityIds: [69] }],
      profiles: [
        {
          id: 4,
          rules: [
            { parameterType: 'NATION', calculationType: 'NORMAL', value: 1 },
            { parameterType: 'LEAGUE', calculationType: 'UNIVERSAL', value: 3 },
            { parameterType: 'CLUB', calculationType: 'UNIVERSAL', value: 2 },
          ],
        },
      ],
    };
    const profile = resolveProfile(69, normaliseChemistryProfile(raw));

    expect(profile.fullChemistryAtPreferredPosition).toBeNull();
    expect(computedFor(STARTERS, profile)).toEqual(EA_PER_PLAYER);
    expect(squadChemistry(STARTERS, profile, CLUB_INDEX)).toEqual({
      chemistry: 12,
      verified: false,
      reason: 'chemistry-position-flag-missing',
    });
  });
});

describe('normaliseChemistryProfile', () => {
  it('translates the raw payload into the stable schema with no raw names left', () => {
    expect(RULE_SET).toEqual({
      mappings: [{ profile: 4, rarities: [69] }],
      profiles: [
        {
          id: 4,
          fullChemistryAtPreferredPosition: false,
          overrides: { base: true, icon: false, hero: false },
          rules: [
            { dimension: 'nation', calculation: 'normal', value: 1 },
            { dimension: 'league', calculation: 'universal', value: 3 },
            { dimension: 'club', calculation: 'universal', value: 2 },
          ],
        },
      ],
    });
  });

  it('throws on a raw parameterType it cannot name instead of dropping the dimension', () => {
    const raw = {
      mappings: [{ profileId: 4, rarityIds: [69] }],
      profiles: [
        rawProfile({
          id: 4,
          rules: [{ parameterType: 'POSITION', calculationType: 'NORMAL', value: 1 }],
        }),
      ],
    };

    expect(() => normaliseChemistryProfile(raw)).toThrow(
      /unsupported parameterType "POSITION"/
    );
  });

  it('throws on a raw calculationType it cannot name instead of scoring it silently', () => {
    const raw = {
      mappings: [{ profileId: 4, rarityIds: [69] }],
      profiles: [
        rawProfile({
          id: 4,
          rules: [{ parameterType: 'NATION', calculationType: 'WEIGHTED', value: 1 }],
        }),
      ],
    };

    expect(() => normaliseChemistryProfile(raw)).toThrow(
      /unsupported calculationType "WEIGHTED"/
    );
  });

  it('rejects a non-positive rule value at the boundary', () => {
    const raw = {
      mappings: [{ profileId: 4, rarityIds: [69] }],
      profiles: [
        rawProfile({
          id: 4,
          rules: [{ parameterType: 'NATION', calculationType: 'NORMAL', value: 0 }],
        }),
      ],
    };

    expect(() => normaliseChemistryProfile(raw)).toThrow(/positive finite value/);
  });

  it('throws on a payload that is not shaped like a profile rule set', () => {
    expect(() => normaliseChemistryProfile({ mappings: [] })).toThrow(/dense array/);
    expect(() => normaliseChemistryProfile(null)).toThrow(/must be an object/);
  });

  it('defaults the override flags to false when the payload omits them', () => {
    // The three override flags are not read by the formula, and issue #5
    // guarantees only the fields EA actually displays. Absence means "no
    // override", so it normalises to false instead of rejecting a valid
    // payload. The profile object below is built without the fields at all
    // (not with `undefined` values), so the test proves real absence.
    const raw = {
      mappings: [],
      profiles: [
        {
          id: 4,
          rules: [{ parameterType: 'NATION', calculationType: 'NORMAL', value: 1 }],
        },
      ],
    };

    expect(normaliseChemistryProfile(raw).profiles[0].overrides).toEqual({
      base: false,
      icon: false,
      hero: false,
    });
  });

  it('normalises a missing fullChemistryOnPreferredPosition to null (unknown), never false', () => {
    // The captured payload field is `fullChemistryOnPreferredPosition`; the
    // `fullPositionBonus` name in the issue text is not the captured name.
    // When the field is absent we do not know whether slot position matters,
    // and null says exactly that, where false would claim EA said "no".
    const raw = {
      mappings: [],
      profiles: [
        {
          id: 4,
          rules: [{ parameterType: 'NATION', calculationType: 'NORMAL', value: 1 }],
        },
      ],
    };

    expect(normaliseChemistryProfile(raw).profiles[0].fullChemistryAtPreferredPosition).toBeNull();
  });

  it('keeps an explicit fullChemistryOnPreferredPosition false distinct from a missing field', () => {
    const raw = {
      mappings: [],
      profiles: [rawProfile({ id: 4, fullChemistryOnPreferredPosition: false })],
    };

    expect(normaliseChemistryProfile(raw).profiles[0].fullChemistryAtPreferredPosition).toBe(
      false
    );
  });

  it('throws when fullChemistryOnPreferredPosition is present but not a boolean', () => {
    const raw = {
      mappings: [],
      profiles: [rawProfile({ id: 4, fullChemistryOnPreferredPosition: 'yes' })],
    };

    expect(() => normaliseChemistryProfile(raw)).toThrow(
      /must carry fullChemistryOnPreferredPosition as a boolean or null/
    );
  });

  it.each(['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty'])(
    'throws on the prototype key %s as parameterType instead of translating it',
    (parameterType) => {
      const raw = {
        mappings: [],
        profiles: [
          rawProfile({
            id: 4,
            rules: [{ parameterType, calculationType: 'NORMAL', value: 1 }],
          }),
        ],
      };

      expect(() => normaliseChemistryProfile(raw)).toThrow(/unsupported parameterType/);
    }
  );

  it.each(['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty'])(
    'throws on the prototype key %s as calculationType instead of translating it',
    (calculationType) => {
      const raw = {
        mappings: [],
        profiles: [
          rawProfile({
            id: 4,
            rules: [{ parameterType: 'NATION', calculationType, value: 1 }],
          }),
        ],
      };

      expect(() => normaliseChemistryProfile(raw)).toThrow(/unsupported calculationType/);
    }
  );

  it('rejects a rarity mapped in more than one mapping instead of letting payload order decide', () => {
    const profiles = [rawProfile({ id: 1 }), rawProfile({ id: 2 })];
    const overlapping = {
      mappings: [
        { profileId: 1, rarityIds: [69] },
        { profileId: 2, rarityIds: [70, 69] },
      ],
      profiles,
    };

    expect(() => normaliseChemistryProfile(overlapping)).toThrow(
      /rarity 69 appears in more than one mapping/
    );
    expect(() =>
      normaliseChemistryProfile({ ...overlapping, mappings: [...overlapping.mappings].reverse() })
    ).toThrow(/rarity 69 appears in more than one mapping/);
  });

  it('throws when a profile id appears twice instead of letting payload order decide', () => {
    const raw = {
      mappings: [],
      profiles: [rawProfile({ id: 4 }), rawProfile({ id: 4 })],
    };

    expect(() => normaliseChemistryProfile(raw)).toThrow(/profile id 4 appears twice/);
  });
});

describe('resolveProfile', () => {
  it('resolves rarity 69 to the profile its mapping names', () => {
    expect(resolveProfile(69, RULE_SET)).toBe(RULE_SET.profiles[0]);
    expect(resolveProfile(69, RULE_SET).id).toBe(4);
  });

  it('honours the mappings indirection rather than a hardcoded profile id', () => {
    const remapped = normaliseChemistryProfile({
      profiles: [rawProfile({ id: 7 })],
      mappings: [{ profileId: 7, rarityIds: [69] }],
    });

    expect(resolveProfile(69, remapped).id).toBe(7);
  });

  it('returns null for a rarity with no mapping instead of guessing a profile', () => {
    expect(resolveProfile(0, RULE_SET)).toBeNull();
    expect(resolveProfile(12345, RULE_SET)).toBeNull();
  });

  it('throws when a mapping names a profile the rule set does not contain', () => {
    const broken = {
      mappings: [{ profile: 99, rarities: [69] }],
      profiles: RULE_SET.profiles,
    };

    expect(() => resolveProfile(69, broken)).toThrow(
      /resolveProfile: mapping for rarity 69 names profile 99/
    );
  });

  it('throws when a mapping carries no finite profile id', () => {
    const broken = { mappings: [{ rarities: [69] }], profiles: RULE_SET.profiles };

    expect(() => resolveProfile(69, broken)).toThrow(/must carry a finite profile id/);
  });

  it('rejects an un-normalised raw payload instead of resolving against raw names', () => {
    expect(() => resolveProfile(69, profilesFixture)).toThrow(/rarities array/);
  });

  it('throws when the rule set is not shaped like a stable profiles payload', () => {
    expect(() => resolveProfile(69, {})).toThrow(/mappings array and a profiles array/);
  });
});

describe('scoring guards', () => {
  it('throws on a rule dimension this layer does not know instead of ignoring it', () => {
    const broken = {
      ...PROFILE,
      rules: [...PROFILE.rules, { dimension: 'position', calculation: 'normal', value: 1 }],
    };

    expect(() => playerChemistry(STARTERS[0], STARTERS, broken, CLUB_INDEX)).toThrow(
      /unsupported rule dimension "position"/
    );
  });

  it.each(['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty'])(
    'throws on the prototype key %s as a rule dimension instead of computing NaN',
    (dimension) => {
      const broken = {
        ...PROFILE,
        rules: [{ dimension, calculation: 'normal', value: 1 }],
      };

      expect(() => playerChemistry(STARTERS[0], STARTERS, broken, CLUB_INDEX)).toThrow(
        /unsupported rule dimension/
      );
    }
  );

  it('throws on a calculation value this layer cannot name', () => {
    const broken = {
      ...PROFILE,
      rules: [{ dimension: 'nation', calculation: 'weighted', value: 1 }],
    };

    expect(() => playerChemistry(STARTERS[0], STARTERS, broken, CLUB_INDEX)).toThrow(
      /unsupported rule calculation "weighted"/
    );
  });

  it('throws on a rule value that is not positive and finite instead of dividing by zero', () => {
    const zero = {
      ...PROFILE,
      rules: [{ dimension: 'nation', calculation: 'normal', value: 0 }],
    };

    expect(() => playerChemistry(STARTERS[0], STARTERS, zero, CLUB_INDEX)).toThrow(
      /positive finite value/
    );
  });

  it('throws when given no resolved profile instead of guessing one', () => {
    expect(() => playerChemistry(STARTERS[0], STARTERS, null, CLUB_INDEX)).toThrow(
      /profile must be a resolved profile/
    );
  });

  it('validates the profile before iterating, so an empty starters array cannot skip the guards', () => {
    // The documented input is an XI of eleven records, but the guards must
    // hold for any array: with no players the per-player calls never run, so
    // the profile check sits at the squad entry instead.
    expect(() => squadChemistry([], null, CLUB_INDEX)).toThrow(
      /profile must be a resolved profile/
    );
    expect(() =>
      squadChemistry([], { ...PROFILE, fullChemistryAtPreferredPosition: 'yes' }, CLUB_INDEX)
    ).toThrow(/fullChemistryAtPreferredPosition as a boolean/);
    expect(() =>
      squadChemistry([], { ...PROFILE, fullChemistryAtPreferredPosition: true }, CLUB_INDEX)
    ).toThrow(/cannot score a profile with fullChemistryAtPreferredPosition true/);
  });
});

describe('the verification marker', () => {
  it('reports the formula as computed, not verified against EA', () => {
    expect(CHEMISTRY_FORMULA_VERIFIED).toBe(false);
    expect(squadChemistry(STARTERS, PROFILE, CLUB_INDEX).verified).toBe(false);
  });
});
