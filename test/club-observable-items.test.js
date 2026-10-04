import { describe, expect, it } from 'vitest';

import { CLUB_ITEM_SOURCES, clubItemSources, normaliseClubItem } from '../src/ea/adapter.js';
import { readClubItems } from '../src/ea/club-reader.js';
import { createSolveService } from '../src/ea/solve-service.js';
import { buildPool } from '../src/solver/candidates.js';
import observable from './fixtures/club-items-observable.json';
import wire from './fixtures/club-items.json';

// fsl-build/14 rejected every live club item with "raw item must carry a finite
// assetId": `normaliseClubItem` speaks the `/club` **wire** vocabulary, and EA's
// observable hands back a different model with different names
// (`definitionId`, `_rating`, `_staticData`, `teamId`, `tradable`, `subtype`,
// `basePossiblePositions`, `utasPile`, …). The `fsl-build/14` diagnostics file
// lists every one of those key names; the capture of the same session proves
// the wire layer's names.
//
// These tests pin the observable mapping. Two properties matter more than the
// values themselves:
//
//   1. every output value is traceable to the field it was read from, so the
//      next live run can be checked field by field instead of guessed at;
//   2. `assetId` — the one field with no obvious top-level twin — is resolved
//      from a proven location or refused. A `definitionId` is a finite number,
//      so accepting one as an asset id never looks broken; whether the two
//      happen to coincide live is not established, so the reader requires
//      `_staticData.assetId`, fails loudly without it, and reports `_staticData`'s
//      own key names so the next live run can settle where the id lives.
//      Writing the wrong player into someone's squad costs their club; a loud
//      failure costs one round trip.

const [firstItem, secondItem] = observable.items;

const EXPECTED_FIRST_RECORD = {
  id: 40042,
  assetId: 3001,
  rating: 84,
  nationId: 14,
  leagueId: 21,
  clubId: 33,
  rarity: 0,
  cardSubtype: 2,
  playStyles: 250,
  preferredPosition: 'CAM',
  possiblePositions: ['CAM', 'ST'],
  rolePlus: [21],
  rolePlusPlus: [11, 12],
  untradeable: false,
  pile: 7,
  owners: 1,
  collected: true,
  marketAverage: null,
  marketMin: null,
  marketMax: null,
  discardValue: null,
  duplicate: false,
};

/** Reads a dotted path out of a raw item, so a provenance claim is checked. */
const readPath = (item, path) =>
  path.split('.').reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), item);

/**
 * Turns one reported source string into the value it claims the raw item holds
 * for that field. The vocabulary is `a.b+c.d` for two locations that agree,
 * `!path` for an inverted flag and `owners>0` for a derived boolean — so a test
 * can drive every claim back through the fixture instead of trusting the string.
 */
const claimedValue = (item, source) => {
  const [inverted, body] = source.startsWith('!') ? [true, source.slice(1)] : [false, source];
  const values = body.split('+').map((part) => {
    const [path, comparison] = part.split('>');
    const raw = readPath(item, path);
    if (comparison === undefined) return raw;
    return comparison === '0' ? raw > 0 : Number(raw) > Number(comparison);
  });
  const [value] = values;
  for (const other of values) expect(other).toEqual(value);
  return inverted ? !value : value;
};

describe('the observable club item layer (#115)', () => {
  it('maps every observable item to the same stable record shape as the wire layer', () => {
    const records = readClubItems(observable);

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(EXPECTED_FIRST_RECORD);
    expect(Object.keys(records[0]).sort()).toEqual(Object.keys(EXPECTED_FIRST_RECORD).sort());
  });

  it('reads untradeable as the inverse of the observable layer’s tradeable flag', () => {
    const records = readClubItems(observable);

    expect(records[0].untradeable).toBe(false);
    expect(records[1].untradeable).toBe(true);
    expect(clubItemSources(firstItem).fields.untradeable).toBe('!tradable');
  });

  it('feeds buildPool, so every record carries the fields the solver requires', () => {
    const pool = buildPool(readClubItems(observable));

    expect(pool).toHaveLength(2);
    for (const record of pool) {
      expect(Number.isFinite(record.id)).toBe(true);
      expect(Number.isFinite(record.rating)).toBe(true);
      expect(Number.isFinite(record.nationId)).toBe(true);
      expect(Number.isFinite(record.clubId)).toBe(true);
      expect(typeof record.untradeable).toBe('boolean');
    }
  });

  it('leaves the wire layer untouched: a wire item reads the wire fields', () => {
    const sources = clubItemSources(wire.items[0]);
    const record = normaliseClubItem(wire.items[0]);

    expect(sources.layer).toBe('wire');
    expect(record.assetId).toBe(277846);
    expect(record.nationId).toBe(wire.items[0].nation);
    expect(record.clubId).toBe(wire.items[0].teamid);
  });
});

describe('every observable output value is traceable to its source field (#115)', () => {
  it('reports the layer, one source per stable field, and the probed locations', () => {
    const sources = clubItemSources(firstItem);

    expect(sources.layer).toBe('observable');
    expect(Object.keys(sources.fields).sort()).toEqual(Object.keys(EXPECTED_FIRST_RECORD).filter((field) => field !== 'duplicate').sort());
  });

  it('agrees with the fixture: every reported source holds the value it is credited with', () => {
    const record = normaliseClubItem(firstItem);
    const { fields } = clubItemSources(firstItem);

    for (const [field, source] of Object.entries(fields)) {
      expect(source === null ? null : claimedValue(firstItem, source)).toEqual(record[field]);
    }
  });

  it('names the observable key it read for each field, not the wire name', () => {
    const { fields } = clubItemSources(firstItem);

    expect(fields).toMatchObject({
      id: 'id',
      rating: '_rating',
      nationId: 'nationId',
      leagueId: 'leagueId',
      clubId: 'teamId',
      rarity: '_rareflag',
      cardSubtype: 'subtype',
      playStyles: 'playStyle',
      preferredPosition: 'preferredPosition',
      possiblePositions: 'basePossiblePositions',
      rolePlus: '_basePlusRoles',
      rolePlusPlus: '_basePlusPlusRoles',
      pile: 'utasPile',
      owners: 'owners',
      collected: 'owners>0',
      marketAverage: null,
      discardValue: null,
    });
  });

  it('resolves assetId from the static asset id alone, and names no other source', () => {
    const { fields, probes } = clubItemSources(firstItem);

    // One proven location, so one named source. A definition id that happens to
    // hold the same number is not a second opinion, it is a different concept
    // that would only agree by coincidence.
    expect(fields.assetId).toBe('_staticData.assetId');
    expect(normaliseClubItem(firstItem).assetId).toBe(3001);
    // Every multi-candidate field is reported, and `assetId` is no longer one:
    // there is nothing to report about a field with a single proven location.
    expect([...new Set(probes.map((probe) => probe.field))].sort()).toEqual([
      'collected',
      'discardValue',
      'marketAverage',
      'marketMax',
      'marketMin',
    ]);
  });

  it('reports the shape of the static and meta sub-objects by name and type only', () => {
    const { subLayers } = clubItemSources(firstItem);

    // `assetId` is on the redaction list, so its name stays visible as
    // `<redacted>` and can never be confused with a field the item lacks.
    expect(subLayers._staticData.keys).toEqual([
      { name: '<redacted>', type: 'number' },
      { name: 'definitionId', type: 'number' },
      { name: 'quality', type: 'string', empty: false },
    ]);
    expect(subLayers._metaData.keys).toEqual([
      { name: 'acquired', type: 'null' },
      { name: 'owner', type: 'null' },
      { name: 'loaned', type: 'boolean' },
    ]);
  });

  it('reports no price source, so the price is unknown and never zero', () => {
    const { fields } = clubItemSources(firstItem);

    for (const field of ['marketAverage', 'marketMin', 'marketMax', 'discardValue']) {
      expect(fields[field]).toBeNull();
      expect(normaliseClubItem(firstItem)[field]).toBeNull();
    }
  });

  it('covers every stable record field exactly once, so the two layers cannot drift', () => {
    const stableFields = [
      'id',
      'assetId',
      'rating',
      'nationId',
      'leagueId',
      'clubId',
      'rarity',
      'cardSubtype',
      'playStyles',
      'preferredPosition',
      'possiblePositions',
      'rolePlus',
      'rolePlusPlus',
      'untradeable',
      'pile',
      'owners',
      'collected',
      'marketAverage',
      'marketMin',
      'marketMax',
      'discardValue',
    ];

    expect(CLUB_ITEM_SOURCES.map((source) => source.field)).toEqual(stableFields);
  });
});

describe('assetId is resolved from a proven location or refused, never derived (#115)', () => {
  const withoutStaticAssetId = () => {
    const item = { ...firstItem, _staticData: { ...firstItem._staticData } };
    delete item._staticData.assetId;
    return item;
  };

  it('fails loudly when only the definition id locations carry a number', () => {
    // The derived twins are the trap: a definition id is finite, so a reader
    // that accepts one never looks broken. Whether a definition id happens to
    // equal an asset id live is not established, and a wrong number here writes
    // the wrong card into someone's squad.
    const item = withoutStaticAssetId();

    let message = null;
    try {
      normaliseClubItem(item);
    } catch (error) {
      message = error.message;
    }

    expect(message).toMatch(/assetId/);
    expect(message).toMatch(/_staticData\.assetId: assetId is absent/);
    expect(message).not.toMatch(/must carry a resolvable untradeable/);
    expect(clubItemSources(item).fields.assetId).toBeNull();
  });

  it('resolves the static asset id even when every definition id disagrees', () => {
    // The inverse of the derivation: a disagreeing definition id can neither
    // poison the read nor be silently preferred over the proven location.
    const item = {
      ...firstItem,
      definitionId: 5555,
      _staticData: { ...firstItem._staticData, definitionId: 5555 },
    };

    expect(normaliseClubItem(item).assetId).toBe(3001);
    expect(clubItemSources(item).fields.assetId).toBe('_staticData.assetId');
  });

  it('fails loudly, naming every probe, when no location carries the id', () => {
    const item = { ...firstItem, _staticData: { quality: 'gold' } };
    delete item.definitionId;

    let message = null;
    try {
      normaliseClubItem(item);
    } catch (error) {
      message = error.message;
    }

    expect(message).toMatch(/assetId/);
    expect(message).toMatch(/_staticData\.assetId/);
    expect(message).toMatch(/_staticData carries/);
    expect(message).toContain('quality');
  });

  it('fails loudly when two probes of one field disagree, rather than picking one', () => {
    // The agreement rule is not assetId's alone: `collected` has two candidates
    // too, so the loud failure stays covered by a field that really has two.
    const item = { ...firstItem, isCollected: false };

    let message = null;
    try {
      normaliseClubItem(item);
    } catch (error) {
      message = error.message;
    }

    expect(message).toMatch(/disagree/i);
    expect(message).toMatch(/isCollected/);
    expect(message).toMatch(/owners>0/);
  });

  it('never puts an asset id, a definition id, an instance id or a price into the failure', () => {
    // The item is rejected, so the message names every probe, every key of the
    // item and both probed sub-objects — and must still hold none of their
    // values. Two definition ids are left on it on purpose: they are the numbers
    // a derived reader would have leaked into the record it silently produced.
    const item = {
      ...firstItem,
      _staticData: { ...firstItem._staticData, definitionId: 987654 },
    };
    delete item._staticData.assetId;

    let message = null;
    try {
      normaliseClubItem(item);
    } catch (error) {
      message = error.message;
    }

    expect(message).toMatch(/assetId/);
    expect(message).toMatch(/_staticData carries/);
    expect(message).not.toContain('987654');
    expect(message).not.toContain('3001');
    expect(message).not.toContain('40042');
  });

  it('locates the rejected observable item in its page, like a wire item', () => {
    const broken = { ...firstItem, _staticData: { quality: 'gold' } };
    delete broken.definitionId;

    let caught = null;
    try {
      readClubItems({ items: [secondItem, broken] }, { pageItems: [1, 1] });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    expect(caught.clubRead).toMatchObject({
      field: 'items',
      index: 1,
      pageIndex: 2,
      pageItems: 1,
      itemIndexInPage: 0,
      layer: 'observable',
    });
    expect(caught.message).toMatch(/page 2/);
  });
});
describe('the diagnostics block names every probed location on every path (#115)', () => {
  const challenge = {
    challengeId: 25,
    name: 'a challenge',
    formation: 'f343',
    elgOperation: 'AND',
    elgReq: [],
  };

  const serviceOver = ({ items, read }) =>
    createSolveService({
      pageWindow: { marker: 'page-window' },
      requestSolve: async () => ({ squad: { players: [] } }),
      steps: {
        resolveChallengeSubject: () => ({
          ok: true,
          payload: challenge,
          strategy: 'panel-argument',
          attempts: [],
        }),
        loadChallenge: async () => ({ ok: true, payload: challenge, strategy: 'stub', attempts: [] }),
        readChallenge: () => challenge,
        resolveClubItems: async () => ({
          ok: true,
          items,
          strategy: 'services.Club.search+searchCriteria',
          attempts: [],
          pages: 1,
          capped: false,
          pageItems: [items.length],
        }),
        readClubItems: read ?? readClubItems,
        resolveChallengeSquad: async () => ({
          ok: true,
          payload: { challengeId: 25, squad: { players: [] } },
          strategy: 'stub',
          attempts: [],
        }),
        readEligibilityKeys: () => ({ keys: { 3: { type: 'X' } }, members: [], unmodelled: [] }),
        describeServiceShape: () => ({ schema: 'stub' }),
        runSolve: async () => ({
          squad: { players: [] },
          cost: 0,
          valid: true,
          failures: [],
          unverified: [],
        }),
        planSquadWrite: () => ({ placed: [], preserved: [], unplaced: [] }),
        applySolution: () => ({ challengeId: 25, squad: { players: [] } }),
        writeSolution: async () => ({ ok: true, strategy: 'stub', attempts: [] }),
      },
    });

  it('reports the layer, the field sources and every probe on a successful club read', async () => {
    const service = serviceOver({ items: observable.items });

    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.ok).toBe(true);
    const club = outcome.stages.find((stage) => stage.id === 'club');
    expect(club.detail.itemLayer.layer).toBe('observable');
    expect(club.detail.itemLayer.fields).toMatchObject({
      assetId: '_staticData.assetId',
      rating: '_rating',
      collected: 'owners>0',
      marketAverage: null,
    });
    expect(club.detail.itemLayer.probes.length).toBeGreaterThan(0);
    expect(club.detail.itemLayer.subLayers._staticData.keys.length).toBeGreaterThan(0);
  });

  it('reports the same probe report on the failing path, from the error record', async () => {
    const broken = { ...firstItem, _staticData: { quality: 'gold' } };
    delete broken.definitionId;
    const service = serviceOver({ items: [broken] });

    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe('club');
    const club = outcome.stages.find((stage) => stage.id === 'club');
    expect(club.ok).toBe(false);
    expect(club.reason).toMatch(/assetId/);
    expect(club.detail.clubRead).toMatchObject({ field: 'items', index: 0, layer: 'observable' });
    expect(club.detail.clubRead.probes).toMatchObject([
      { id: '_staticData.assetId', ok: false, reason: expect.stringMatching(/absent/) },
    ]);
    // The item's own provenance report agrees the field resolved from nothing,
    // and still carries the probes of every field that really has two
    // candidates.
    expect(club.detail.itemLayer.fields.assetId).toBeNull();
    expect([...new Set(club.detail.itemLayer.probes.map((probe) => probe.field))].sort()).toEqual([
      'collected',
      'discardValue',
      'marketAverage',
      'marketMax',
      'marketMin',
    ]);
    // The sub-object report is what settles the open question on the next live
    // run, so it has to survive the failure that carries it.
    expect(club.detail.clubRead.subLayers._staticData.keys).toEqual([
      { name: 'quality', type: 'string', empty: false },
    ]);
  });
});
