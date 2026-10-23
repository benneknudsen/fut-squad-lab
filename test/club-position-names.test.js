import { describe, expect, it } from 'vitest';

import {
  clubItemSources,
  createPositionNameResolver,
  normaliseClubItem,
} from '../src/ea/adapter.js';
import { readClubItems } from '../src/ea/club-reader.js';
import { createSolveService } from '../src/ea/solve-service.js';
import { normaliseClub } from '../src/solver/candidates.js';
import observable from './fixtures/club-items-observable.json';

// Issue #115: the observable club item carries `preferredPosition` as a NUMBER
// and `possiblePositions` as a getter, while the wire item carries position
// strings. EA's own page resolves that number to a name. These tests pin that
// the resolver is the only source of the translation: a code it cannot name is
// refused loudly, never decoded from a guessed table.

const numericItem = () => ({
  ...observable.items[0],
  preferredPosition: 3,
  basePossiblePositions: [3, 25],
});

const fakeResolver = (names = { 3: 'CAM', 25: 'ST' }, source = 'UTLocalizationUtil.positionIdToName') => ({
  source,
  size: Object.keys(names).length,
  resolve: (code) => names[code] ?? null,
  get unnamed() {
    return [];
  },
});

describe('a numeric position is named by EA’s own resolver (#115)', () => {
  it('normalises a numeric preferredPosition and numeric basePossiblePositions through an injected resolver', () => {
    const record = normaliseClubItem(numericItem(), { positionNames: fakeResolver() });

    expect(record.preferredPosition).toBe('CAM');
    expect(record.possiblePositions).toEqual(['CAM', 'ST']);
    expect(clubItemSources(numericItem(), { positionNames: fakeResolver() }).fields).toMatchObject({
      preferredPosition: 'preferredPosition(resolved:UTLocalizationUtil.positionIdToName)',
      possiblePositions:
        'basePossiblePositions(resolved:UTLocalizationUtil.positionIdToName)',
    });
  });

  it('refuses the same item without a resolver, naming the code', () => {
    let caught = null;
    try {
      normaliseClubItem(numericItem());
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/preferredPosition/);
    expect(caught.message).toMatch(/number 3/);
  });

  it('refuses when the resolver answers null for the code, naming the code', () => {
    let caught = null;
    try {
      normaliseClubItem(numericItem(), { positionNames: fakeResolver({}) });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/preferredPosition/);
    expect(caught.message).toMatch(/number 3/);
  });

  it('refuses when the resolver names a position outside the accepted set, naming code and name', () => {
    let caught = null;
    try {
      normaliseClubItem(numericItem(), {
        positionNames: fakeResolver({ 3: 'XCF', 25: 'ST' }),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/number 3/);
    expect(caught.message).toMatch(/XCF/);
  });

  it('never invokes a possiblePositions accessor when the resolver can name the preferred position', () => {
    const item = numericItem();
    Object.defineProperty(item, 'possiblePositions', {
      enumerable: true,
      get() {
        throw new Error('possiblePositions accessor was invoked');
      },
    });

    const record = normaliseClubItem(item, { positionNames: fakeResolver() });

    expect(record.preferredPosition).toBe('CAM');
    expect(record.possiblePositions).toEqual(['CAM', 'ST']);
  });

  it('carries the resolver provenance and unnamed codes on a located clubRead failure', () => {
    const unnamed = [];
    const resolver = {
      source: 'DataProvider.getPlayerPositionDP',
      size: 1,
      resolve(code) {
        unnamed.push(code);
        return null;
      },
      get unnamed() {
        return unnamed;
      },
    };

    let caught = null;
    try {
      readClubItems([numericItem()], { positionNames: resolver });
    } catch (error) {
      caught = error;
    }

    expect(caught).not.toBeNull();
    expect(caught.clubRead.positionNames).toEqual({
      source: 'DataProvider.getPlayerPositionDP',
      size: 1,
      unnamed: [3],
    });
  });

  it('forwards the resolver through normaliseClub and readClubItems', () => {
    const resolver = fakeResolver();

    expect(normaliseClub([numericItem()], { positionNames: resolver })[0].preferredPosition).toBe(
      'CAM'
    );
    expect(readClubItems([numericItem()], { positionNames: resolver })[0].possiblePositions).toEqual(
      ['CAM', 'ST']
    );
  });
});

describe('createPositionNameResolver reads EA’s own position names (#115)', () => {
  it('prefers UTLocalizationUtil.positionIdToName when it exists', () => {
    const resolver = createPositionNameResolver({
      UTLocalizationUtil: {
        positionIdToName(id) {
          return id === 3 ? 'CAM' : null;
        },
      },
    });

    expect(resolver.source).toBe('UTLocalizationUtil.positionIdToName');
    expect(resolver.resolve(3)).toBe('CAM');
    expect(resolver.resolve(77)).toBeNull();
  });

  it('falls back to DataProvider.getPlayerPositionDP as an id to label/name map', () => {
    const resolver = createPositionNameResolver({
      factories: {
        DataProvider: {
          getPlayerPositionDP() {
            return [
              { id: 3, label: 'CAM' },
              { id: 25, name: 'ST' },
            ];
          },
        },
      },
    });

    expect(resolver.source).toBe('DataProvider.getPlayerPositionDP');
    expect(resolver.size).toBe(2);
    expect(resolver.resolve(3)).toBe('CAM');
    expect(resolver.resolve(25)).toBe('ST');
  });

  it('reports no source and size 0 when neither EA source exists', () => {
    const resolver = createPositionNameResolver({});

    expect(resolver.source).toBeNull();
    expect(resolver.size).toBe(0);
    expect(resolver.resolve(3)).toBeNull();
  });
});

describe('the club stage reports the position resolver provenance (#115)', () => {
  const challenge = {
    challengeId: 25,
    name: 'a challenge',
    formation: 'f343',
    elgOperation: 'AND',
    elgReq: [],
  };

  it('carries source, size and unnamed codes on the club stage', async () => {
    const resolver = fakeResolver();
    const service = createSolveService({
      pageWindow: { marker: 'page-window' },
      requestSolve: async () => ({ squad: { players: [] } }),
      steps: {
        resolveChallengeSubject: () => ({
          ok: true,
          payload: challenge,
          strategy: 'panel-argument',
          attempts: [],
        }),
        loadChallenge: async () => ({
          ok: true,
          payload: challenge,
          strategy: 'stub',
          attempts: [],
        }),
        readChallenge: () => challenge,
        resolveClubItems: async () => ({
          ok: true,
          items: [numericItem()],
          positionNames: resolver,
          strategy: 'services.Club.search+searchCriteria',
          attempts: [],
          pages: 1,
          capped: false,
          pageItems: [1],
        }),
        readClubItems,
        resolveChallengeSquad: async () => ({
          ok: false,
          payload: null,
          strategy: null,
          attempts: [],
        }),
        writeSolution: async () => ({ ok: false, attempts: [] }),
      },
    });

    const outcome = await service.solve({ subject: 'panel' });
    const club = outcome.stages.find((stage) => stage.id === 'club');

    expect(club.detail.positionNames).toEqual({
      source: 'UTLocalizationUtil.positionIdToName',
      size: 2,
      unnamed: [],
    });
  });
});
