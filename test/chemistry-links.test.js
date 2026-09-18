import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import club from './fixtures/club-items.json';
import teamLinks from './fixtures/chemistry-teamlinks.json';
import { normaliseClubItem, normaliseTeamChemLinks } from '../src/ea/adapter.js';
import { buildClubIndex, countLinks } from '../src/solver/chemistry.js';

// The captured link table is the ground truth for the payload shape, but two of
// the behaviours this module owes cannot be exercised by it:
//
//   - every one of its 128 entries has its reverse present (zero
//     one-directional pairs), so a symmetry test driven by the fixture would
//     pass whether or not the code honours the given direction;
//   - all 64 equivalence groups have exactly two members, so a transitivity
//     test driven by the fixture would pass against an index that only unions
//     direct pairs.
//
// Both are therefore proven with synthetic links, and the first describe block
// asserts the degenerate fixture properties explicitly, so the synthetic tests
// are demonstrably not satisfied by the fixture alone.
//
// The counting tests use a real six-player squad drawn from the captured club
// fixture, including the one link pair whose both sides are in the club
// (clubs 243 and 116326, whose nations and leagues differ). Counts are exact
// hand-computed numbers; see the per-test comments.

const fixtureRawLinks = teamLinks.teamChemLinks;
const fixtureLinks = normaliseTeamChemLinks(fixtureRawLinks);
const fixtureIndex = buildClubIndex(fixtureLinks);

const fixtureRawItems = club.itemData;
const rawItemById = new Map(fixtureRawItems.map((rawItem) => [rawItem.id, rawItem]));
const recordFor = (id) => normaliseClubItem(rawItemById.get(id));

const rawLink = (overrides = {}) => ({
  teamId: 1,
  linkedTeams: [2],
  ...overrides,
});

const without = (object, key) => {
  const copy = { ...object };
  delete copy[key];
  return copy;
};

describe('captured link table facts', () => {
  it('holds 128 entries, 128 clubs and 64 size-2 groups', () => {
    expect(fixtureRawLinks).toHaveLength(128);

    const clubs = new Set();
    for (const link of fixtureRawLinks) {
      clubs.add(link.teamId);
      for (const linked of link.linkedTeams) clubs.add(linked);
    }

    expect(clubs.size).toBe(128);
  });

  it('has zero one-directional pairs, so symmetry can only be proven synthetically', () => {
    const directedPairs = new Set();
    for (const link of fixtureRawLinks) {
      for (const linked of link.linkedTeams) {
        directedPairs.add(`${link.teamId}:${linked}`);
      }
    }

    const oneDirectional = [...directedPairs].filter(
      (pair) => !directedPairs.has(pair.split(':').reverse().join(':'))
    );

    expect(oneDirectional).toEqual([]);
  });

  it('has only size-2 groups, so transitivity can only be proven synthetically', () => {
    const partners = new Map();
    for (const link of fixtureRawLinks) {
      for (const linked of link.linkedTeams) {
        if (!partners.has(link.teamId)) partners.set(link.teamId, new Set());
        partners.get(link.teamId).add(linked);
      }
    }

    expect(partners.size).toBe(128);
    for (const [clubId, linked] of partners) {
      expect(linked.size).toBe(1);
      const [partner] = linked;
      expect(partners.get(partner)).toBeDefined();
      expect(partners.get(partner).has(clubId)).toBe(true);
    }
  });
});

describe('normaliseTeamChemLinks', () => {
  it('maps the raw payload names onto the stable shape', () => {
    expect(normaliseTeamChemLinks([{ teamId: 1, linkedTeams: [116009] }])).toEqual([
      { clubId: 1, linkedClubIds: [116009] },
    ]);
  });

  it('normalises the whole captured table to clubId/linkedClubIds entries only', () => {
    expect(fixtureLinks).toHaveLength(fixtureRawLinks.length);

    for (const entry of fixtureLinks) {
      expect(Object.keys(entry).sort()).toEqual(['clubId', 'linkedClubIds']);
      expect(Number.isFinite(entry.clubId)).toBe(true);
      expect(Array.isArray(entry.linkedClubIds)).toBe(true);
      for (const linked of entry.linkedClubIds) {
        expect(Number.isFinite(linked)).toBe(true);
      }
    }
  });

  it('accepts an empty linked list', () => {
    expect(normaliseTeamChemLinks([{ teamId: 1, linkedTeams: [] }])).toEqual([
      { clubId: 1, linkedClubIds: [] },
    ]);
  });

  it('copies the linked list instead of aliasing the payload', () => {
    const raw = rawLink();
    const [entry] = normaliseTeamChemLinks([raw]);

    expect(entry.linkedClubIds).not.toBe(raw.linkedTeams);
    expect(entry.linkedClubIds).toEqual(raw.linkedTeams);
  });

  it('rejects a raw links value that is not an array', () => {
    expect(() => normaliseTeamChemLinks({ teamId: 1, linkedTeams: [2] })).toThrow(
      /normaliseTeamChemLinks: raw links must be an array/
    );
  });

  it('rejects a sparse raw links array instead of returning holes', () => {
    expect(() => normaliseTeamChemLinks(new Array(2))).toThrow(
      /normaliseTeamChemLinks: raw links must not contain holes \(index 0 is missing\)/
    );
  });

  it.each([
    ['a null entry', null, /must be an object/],
    ['a missing teamId', without(rawLink(), 'teamId'), /teamId/],
    ['a non-numeric teamId', rawLink({ teamId: '1' }), /teamId/],
    ['a missing linkedTeams', without(rawLink(), 'linkedTeams'), /linkedTeams/],
    ['a non-array linkedTeams', rawLink({ linkedTeams: 2 }), /linkedTeams/],
    ['a sparse linkedTeams', rawLink({ linkedTeams: [2, , 3] }), /linkedTeams/],
    ['a non-numeric linked club', rawLink({ linkedTeams: [2, '3'] }), /linkedTeams/],
  ])('rejects %s instead of emitting undefined', (_label, entry, message) => {
    expect(() => normaliseTeamChemLinks([entry])).toThrow(message);
  });

  it('does not mutate the raw links', () => {
    const raws = [rawLink(), rawLink({ teamId: 2, linkedTeams: [1] })];
    const snapshot = JSON.stringify(raws);

    normaliseTeamChemLinks(raws);

    expect(JSON.stringify(raws)).toBe(snapshot);
  });
});

describe('buildClubIndex', () => {
  it('merges a transitive chain into one group', () => {
    const index = buildClubIndex([
      { clubId: 1, linkedClubIds: [2] },
      { clubId: 2, linkedClubIds: [3] },
    ]);

    expect(index.sameClub(1, 3)).toBe(true);
    expect(index.groupOf(1)).toBe(index.groupOf(2));
    expect(index.groupOf(2)).toBe(index.groupOf(3));
  });

  it('closes a chain of length five, not just one hop', () => {
    const index = buildClubIndex([
      { clubId: 10, linkedClubIds: [20] },
      { clubId: 20, linkedClubIds: [30] },
      { clubId: 30, linkedClubIds: [40] },
      { clubId: 40, linkedClubIds: [50] },
    ]);

    expect(index.groupOf(10)).toBe(10);
    expect(index.groupOf(50)).toBe(10);
    expect(index.sameClub(20, 50)).toBe(true);
    expect(index.sameClub(10, 50)).toBe(true);
  });

  it('merges both sides from a one-directional entry', () => {
    const index = buildClubIndex([{ clubId: 1, linkedClubIds: [2] }]);

    expect(index.sameClub(1, 2)).toBe(true);
    expect(index.sameClub(2, 1)).toBe(true);
    expect(index.groupOf(2)).toBe(1);
  });

  it('resolves every fixture club through its reciprocal links', () => {
    expect(fixtureIndex.groupOf(243)).toBe(243);
    expect(fixtureIndex.groupOf(116326)).toBe(243);
    expect(fixtureIndex.sameClub(243, 116326)).toBe(true);
    expect(fixtureIndex.sameClub(243, 116010)).toBe(false);
  });

  it('gives a club absent from the link table its own group', () => {
    expect(fixtureIndex.groupOf(999999)).toBe(999999);
    expect(fixtureIndex.sameClub(999999, 999998)).toBe(false);
    expect(fixtureIndex.sameClub(999999, 999999)).toBe(true);
  });

  it('gives a club that only appears as a linked target its own group identity', () => {
    const index = buildClubIndex([{ clubId: 1, linkedClubIds: [2] }]);

    expect(index.groupOf(2)).toBe(1);
    expect(index.sameClub(2, 2)).toBe(true);
    expect(index.groupOf(3)).toBe(3);
  });

  it('gives every club its own group for empty input without throwing', () => {
    const index = buildClubIndex([]);

    expect(index.groupOf(1)).toBe(1);
    expect(index.groupOf(876)).toBe(876);
    expect(index.sameClub(1, 2)).toBe(false);
    expect(index.sameClub(3, 3)).toBe(true);
  });

  it('is unaffected by a self-link', () => {
    const index = buildClubIndex([
      { clubId: 1, linkedClubIds: [1, 2] },
      { clubId: 2, linkedClubIds: [] },
    ]);

    expect(index.groupOf(1)).toBe(1);
    expect(index.groupOf(2)).toBe(1);
    expect(index.groupOf(3)).toBe(3);
  });

  it('is unaffected by duplicate linked club ids', () => {
    const withDuplicates = buildClubIndex([{ clubId: 1, linkedClubIds: [2, 2, 2] }]);
    const withoutDuplicates = buildClubIndex([{ clubId: 1, linkedClubIds: [2] }]);

    expect(withDuplicates.groupOf(2)).toBe(withoutDuplicates.groupOf(2));
    expect(withDuplicates.sameClub(1, 2)).toBe(true);
  });

  it('does not mutate the supplied links', () => {
    const links = [
      Object.freeze({ clubId: 1, linkedClubIds: Object.freeze([2, 3]) }),
      Object.freeze({ clubId: 3, linkedClubIds: Object.freeze([4]) }),
    ];
    Object.freeze(links);
    const snapshot = JSON.stringify(links);

    const index = buildClubIndex(links);

    expect(index.groupOf(4)).toBe(1);
    expect(JSON.stringify(links)).toBe(snapshot);
  });
});

describe('countLinks', () => {
  // Six real club fixture items. Only the 243/116326 pair links by club; the
  // other clubs are absent from the link table or link outside the squad.
  const squad = [
    recordFor(221963375192307), // club 243,   nation 21, league 53
    recordFor(212775446319377), // club 116326, nation 18, league 2222
    recordFor(188838070310451), // club 240,   nation 13, league 53
    recordFor(65549988793144), // club 240,   nation 95, league 53
    recordFor(125366608588041), // club 449,   nation 52, league 53
    recordFor(219021823390421), // club 36,    nation 21, league 19
  ];

  const othersOf = (player) => squad.filter((other) => other.id !== player.id);

  it('counts the linked 243/116326 pair as one club link and nothing else', () => {
    // Clubs 243 and 116326 are one equivalence group, but their items carry
    // different nations (21 vs 18) and leagues (53 vs 2222).
    const club243 = squad[0];
    const linkedClub = squad[1];

    expect(countLinks(club243, [linkedClub], fixtureIndex)).toEqual({
      nation: 0,
      league: 0,
      club: 1,
    });
    expect(countLinks(linkedClub, [club243], fixtureIndex)).toEqual({
      nation: 0,
      league: 0,
      club: 1,
    });
  });

  it('counts exact nation, league and club partners across the squad', () => {
    // Hand-computed over the six players above:
    //   club 243:    nation {club 36},       league {240, 240, 449}, club {116326}
    //   club 116326: nation {},              league {},                club {243}
    //   club 240:    nation {},              league {243, 240, 449},   club {240}
    //   club 240:    nation {},              league {243, 240, 449},   club {240}
    //   club 449:    nation {},              league {243, 240, 240},   club {}
    //   club 36:     nation {243},           league {},                club {}
    const expected = [
      { nation: 1, league: 3, club: 1 },
      { nation: 0, league: 0, club: 1 },
      { nation: 0, league: 3, club: 1 },
      { nation: 0, league: 3, club: 1 },
      { nation: 0, league: 3, club: 0 },
      { nation: 1, league: 0, club: 0 },
    ];

    squad.forEach((player, position) => {
      expect(countLinks(player, othersOf(player), fixtureIndex)).toEqual(expected[position]);
    });
  });

  it('counts each same-club partner once, so two partners read as two', () => {
    const player = { id: 1, nationId: 1, leagueId: 10, clubId: 240 };
    const firstPartner = { id: 2, nationId: 2, leagueId: 20, clubId: 240 };
    const secondPartner = { id: 3, nationId: 3, leagueId: 30, clubId: 240 };

    expect(countLinks(player, [firstPartner, secondPartner], fixtureIndex)).toEqual({
      nation: 0,
      league: 0,
      club: 2,
    });
  });

  it('counts a partner once per matching dimension when several match', () => {
    const player = { id: 1, nationId: 7, leagueId: 13, clubId: 240 };
    const twin = { id: 2, nationId: 7, leagueId: 13, clubId: 240 };

    expect(countLinks(player, [twin], fixtureIndex)).toEqual({ nation: 1, league: 1, club: 1 });
  });

  it('returns exact zeros when no partner matches', () => {
    const lonely = { id: 1, nationId: 1, leagueId: 2, clubId: 999999 };

    expect(countLinks(lonely, [], fixtureIndex)).toEqual({ nation: 0, league: 0, club: 0 });
  });

  it('throws when clubIndex is omitted', () => {
    const player = squad[0];

    expect(() => countLinks(player, othersOf(player))).toThrow(
      /countLinks: clubIndex is required/
    );
  });

  it('throws when the player itself appears in others', () => {
    const player = squad[0];

    expect(() => countLinks(player, [player], fixtureIndex)).toThrow(
      new RegExp(`countLinks: others must not contain the player itself \\(id ${player.id}\\)`)
    );
  });

  it('does not mutate the player, others or clubIndex', () => {
    const player = recordFor(221963375192307);
    const others = [recordFor(212775446319377), recordFor(188838070310451)];
    const frozen = [player, ...others].map((record) =>
      Object.freeze({
        ...record,
        possiblePositions: Object.freeze([...record.possiblePositions]),
        rolePlus: Object.freeze([...record.rolePlus]),
        rolePlusPlus: Object.freeze([...record.rolePlusPlus]),
      })
    );
    Object.freeze(frozen);
    const snapshot = JSON.stringify(frozen);

    expect(() => countLinks(frozen[0], frozen.slice(1), fixtureIndex)).not.toThrow();
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });
});

describe('EA payload names stay in the adapter', () => {
  // `nation` is the stable output key of `countLinks` and `leagueId` is a
  // stable adapter field name, exactly as in `candidates.test.js`. What must
  // not appear is a raw payload read: the raw nation field is read as a bare
  // `.nation` property, while the stable field is `nationId`.
  const RAW_LINK_NAMES = ['teamId', 'linkedTeams', 'teamChemLinks', 'teamid'];
  const source = readFileSync(new URL('../src/solver/chemistry.js', import.meta.url), 'utf8');

  it('names no raw link-table field in src/solver/chemistry.js', () => {
    for (const name of RAW_LINK_NAMES) {
      expect(source).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('reads nationality as the stable nationId field, never as a raw property', () => {
    expect(source).not.toMatch(/\.nation\b/);
    expect(source).toMatch(/\.nationId\b/);
  });
});
