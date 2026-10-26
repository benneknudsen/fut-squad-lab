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

/**
 * Reads a reported source path out of a raw item, so a provenance claim is
 * checked. A path may name one element of a list (`basePossiblePositions[0]`):
 * that is how a position read out of a position list is credited.
 */
const readPath = (item, path) => {
  const [location, element] = path.split('[');
  const value = location
    .split('.')
    .reduce(
      (current, key) => (current === null || current === undefined ? undefined : current[key]),
      item
    );
  if (element === undefined) return value;
  const index = Number(element.replace(']', ''));
  return Array.isArray(value) ? value[index] : undefined;
};

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
      preferredPosition: 'basePossiblePositions[0]',
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
    // The two position fields are multi-candidate since #111: the live layer
    // carries a number where the wire layer carries the string vocabulary.
    expect([...new Set(probes.map((probe) => probe.field))].sort()).toEqual([
      'collected',
      'discardValue',
      'marketAverage',
      'marketMax',
      'marketMin',
      'possiblePositions',
      'preferredPosition',
    ]);
  });

  it('reports the shape of the static and meta sub-objects by name and type only', () => {
    const { subLayers } = clubItemSources(firstItem);

    // `assetId` is on the redaction list, so its name stays visible as
    // `<redacted>` and can never be confused with a field the item lacks. The
    // rest are the key names the live page's own diagnostics reported, with the
    // types the capture reported: `fsl-build/15` read the names **and** the
    // types off `club.itemLayer.subLayers._staticData.keys`, so the fixture
    // carries the captured shape and only the values are synthetic.
    expect(subLayers._staticData.keys).toEqual([
      { name: '<redacted>', type: 'number' },
      { name: 'assetType', type: 'string', empty: true },
      { name: 'assetYear', type: 'number' },
      { name: 'amount', type: 'number' },
      { name: 'name', type: 'string', empty: false },
      { name: 'firstName', type: 'string', empty: false },
      { name: 'lastName', type: 'string', empty: false },
      { name: 'knownAs', type: 'string', empty: false },
      { name: 'description', type: 'string', empty: true },
      { name: 'manufacturer', type: 'string', empty: true },
      { name: 'trainedAttribute', type: 'number' },
      { name: 'trainPosFrom', type: 'string', empty: true },
      { name: 'trainPosTo', type: 'string', empty: true },
      { name: 'goldBoost', type: 'number' },
      { name: 'silverBoost', type: 'number' },
      { name: 'bronzeBoost', type: 'number' },
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

// Issue #111: the live observable club item carries `preferredPosition` as a
// NUMBER. The reader required a string, so the first item of the first page was
// rejected and the whole club read yielded zero items — the run failed at the
// club stage with "preferredPosition is number, not the required string".
//
// The string vocabulary is still on the item: its own position lists carry it.
// The number is never decoded into a position, because no capture proves which
// code names which position and a wrong mapping writes the wrong card into a
// player's squad. A position that no accepted set names is refused instead.
describe('a position is resolved from a string source, and the source is named (#111)', () => {
  const withoutPositionLists = () => {
    const item = { ...firstItem };
    delete item.basePossiblePositions;
    return item;
  };

  it('resolves a numeric preferredPosition from basePossiblePositions and names that source', () => {
    const record = normaliseClubItem(firstItem);

    expect(record.preferredPosition).toBe('CAM');
    expect(record.possiblePositions).toEqual(['CAM', 'ST']);
    expect(clubItemSources(firstItem).fields.preferredPosition).toBe('basePossiblePositions[0]');
    expect(clubItemSources(firstItem).fields.possiblePositions).toBe('basePossiblePositions');
  });

  it('still resolves the wire shape’s own preferredPosition string', () => {
    const item = { ...firstItem, preferredPosition: 'ST' };

    expect(normaliseClubItem(item).preferredPosition).toBe('ST');
    expect(clubItemSources(item).fields.preferredPosition).toBe('preferredPosition');
  });

  it('still resolves the wire shape’s possiblePositions list', () => {
    const item = { ...firstItem, preferredPosition: 'CM', possiblePositions: ['CM', 'CAM'] };
    delete item.basePossiblePositions;

    expect(normaliseClubItem(item).possiblePositions).toEqual(['CM', 'CAM']);
    expect(clubItemSources(item).fields.possiblePositions).toBe('possiblePositions');
  });

  it('refuses loudly, naming the number and every probed location, when no string source exists', () => {
    const item = withoutPositionLists();

    let message = null;
    try {
      normaliseClubItem(item);
    } catch (error) {
      message = error.message;
    }

    // The number is named, so the next live run can settle the mapping.
    expect(message).toMatch(/preferredPosition is the number 3/);
    // Every location that was probed is named.
    expect(message).toMatch(/preferredPosition:/);
    expect(message).toMatch(/possiblePositions\[0\]/);
    expect(message).toMatch(/basePossiblePositions\[0\]/);
    // The item's own key names with their types, so the report says what EA
    // sent without carrying a value.
    expect(message).toMatch(/preferredPosition: number/);
    expect(message).toMatch(/attributes: array\[6\]/);
    // Nothing answered, so no source is credited.
    expect(clubItemSources(item).fields.preferredPosition).toBeNull();
  });

  it('refuses a position outside the accepted set', () => {
    const item = { ...firstItem, basePossiblePositions: ['CAM', 'XCF'] };

    expect(() => normaliseClubItem(item)).toThrow(/not one of the accepted positions/);
    expect(() => normaliseClubItem({ ...firstItem, preferredPosition: 'XCF' })).toThrow(
      /not one of the accepted positions/
    );
  });

  it('never decodes a number into a position', () => {
    // The numeric code is refused even when it is the only position on the
    // item: a guessed mapping would place the wrong card in the wrong slot.
    const item = withoutPositionLists();

    let caught = null;
    try {
      normaliseClubItem(item);
    } catch (error) {
      caught = error;
    }

    // No record at all: a decoded number would be a guess about which card the
    // player is, and a wrong guess writes the wrong card into a squad.
    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/preferredPosition is the number 3/);
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

  it('reports an unreadable role list on the successful club stage without failing it (#121)', async () => {
    const item = { ...firstItem, _basePlusPlusRoles: [{ id: 7 }] };
    const service = serviceOver({ items: [item] });

    const outcome = await service.solve({ subject: 'panel' });

    expect(outcome.ok).toBe(true);
    const club = outcome.stages.find((stage) => stage.id === 'club');
    expect(club.ok).toBe(true);
    const expected = [
      {
        field: 'rolePlusPlus',
        path: '_basePlusPlusRoles',
        elementTypes: ['object'],
        keys: ['id'],
      },
    ];
    expect(club.detail.itemLayer.unreadable).toEqual(expected);
    expect(club.detail.unreadableRoles).toEqual(expected);
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
      'possiblePositions',
      'preferredPosition',
    ]);
    // The sub-object report is what settles the open question on the next live
    // run, so it has to survive the failure that carries it.
    expect(club.detail.clubRead.subLayers._staticData.keys).toEqual([
      { name: 'quality', type: 'string', empty: false },
    ]);
  });
});

describe('a role list that is present but unreadable (#121)', () => {
  const withUnreadablePlusPlus = () => ({
    ...firstItem,
    _basePlusPlusRoles: [{ id: 7 }],
  });

  it('normalises the list to [] and keeps the rest of the record', () => {
    const record = normaliseClubItem(withUnreadablePlusPlus());

    expect(record.rolePlusPlus).toEqual([]);
    expect(record.rolePlus).toEqual([21]);
    expect(record.assetId).toBe(3001);
  });

  it('reports the field, the location, the element types and the element keys', () => {
    const { unreadable } = clubItemSources(withUnreadablePlusPlus());

    expect(unreadable).toEqual([
      {
        field: 'rolePlusPlus',
        path: '_basePlusPlusRoles',
        elementTypes: ['object'],
        keys: ['id'],
      },
    ]);
  });

  it('leaves a readable numeric list unchanged and reports nothing unreadable', () => {
    expect(normaliseClubItem(firstItem).rolePlusPlus).toEqual([11, 12]);
    expect(clubItemSources(firstItem).unreadable).toEqual([]);
  });

  it('does not reject the whole item for this field', () => {
    expect(() => normaliseClubItem(withUnreadablePlusPlus())).not.toThrow();
  });

  it('carries the same evidence on clubRead when another field rejects the item', () => {
    const { _staticData, ...rest } = withUnreadablePlusPlus();
    const { assetId, ...staticDataWithoutAssetId } = _staticData;
    let error = null;
    try {
      readClubItems([{ ...rest, _staticData: staticDataWithoutAssetId }]);
    } catch (thrown) {
      error = thrown;
    }

    expect(error).not.toBeNull();
    expect(error.clubRead.unreadableRoles).toEqual([
      {
        field: 'rolePlusPlus',
        path: '_basePlusPlusRoles',
        elementTypes: ['object'],
        keys: ['id'],
      },
    ]);
  });

  it('normalises an unreadable wire role list to [] as well', () => {
    const raw = { ...wire.items[0], plusRoles: [{ role: 31 }] };

    expect(normaliseClubItem(raw).rolePlus).toEqual([]);
    expect(clubItemSources(raw).unreadable).toEqual([
      { field: 'rolePlus', path: 'plusRoles', elementTypes: ['object'], keys: ['role'] },
    ]);
  });
});
