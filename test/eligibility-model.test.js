import { describe, expect, it } from 'vitest';

import {
  ELIGIBILITY_KEY_FALLBACK,
  ELIGIBILITY_KEY_MODEL,
  RARITY_GROUP_MEANINGS,
  decodeRarityGroup,
  decodeScopeName,
  formatEligibilityKeysLine,
  readEligibilityKeys,
} from '../src/ea/adapter.js';

// Issue #53: the eligibility key model was pinned from one live observation and
// missed several members. These tests exercise the model the live reader turns
// into descriptors, the fallback number table it is cross-checked against, and
// the loose name matching the scope comparison needs.

describe('ELIGIBILITY_KEY_MODEL covers the keys issue #53 names', () => {
  it.each([
    ['PLAYER_RARITY_GROUP', 'PLAYER_RARITY_GROUP', 'match', 'rarityGroups'],
    ['PLAYER_MIN_OVR', 'PLAYER_MIN_OVR', 'match', 'minRatings'],
    ['PLAYER_EXACT_OVR', 'PLAYER_EXACT_OVR', 'match', 'exactRatings'],
    ['PLAYER_MAX_OVR', 'PLAYER_MAX_OVR', 'match', 'maxRatings'],
    ['PLAYER_TRADABILITY', 'PLAYER_TRADABILITY', 'match', 'tradabilities'],
    ['ALL_PLAYERS_CHEMISTRY_POINTS', 'ALL_PLAYERS_CHEMISTRY_POINTS', 'scalar', undefined],
  ])('models %s as %s', (name, kind, role, field) => {
    expect(ELIGIBILITY_KEY_MODEL[name]).toMatchObject({ kind, role });
    if (field === undefined) {
      expect(ELIGIBILITY_KEY_MODEL[name]).not.toHaveProperty('field');
    } else {
      expect(ELIGIBILITY_KEY_MODEL[name].field).toBe(field);
    }
  });

  it('keeps the keys the earlier observation already modelled', () => {
    for (const name of [
      'PLAYER_COUNT',
      'SCOPE',
      'TEAM_RATING_1_TO_100',
      'CHEMISTRY_POINTS',
      'PLAYER_LEVEL',
    ]) {
      expect(ELIGIBILITY_KEY_MODEL[name], name).toBeDefined();
    }
  });
});

describe('decodeScopeName matches comparison names loosely', () => {
  it.each([
    ['minimum', 'GREATER'],
    ['MIN', 'GREATER'],
    ['greater than', 'GREATER'],
    ['maximum', 'LOWER'],
    ['MAX', 'LOWER'],
    ['lower than', 'LOWER'],
    ['less than or equal', 'LOWER'],
    ['EXACT', 'EXACT'],
    ['a range', 'RANGE'],
  ])('resolves %s to %s', (name, canonical) => {
    expect(decodeScopeName(name)).toBe(canonical);
  });

  it.each([null, undefined, 3, '', 'sideways', 'at least 3'])('returns null for %j', (name) => {
    expect(decodeScopeName(name)).toBeNull();
  });
});

describe('decodeRarityGroup disambiguates key 25 by label and by value', () => {
  it('reads a geographic region from the label', () => {
    expect(decodeRarityGroup('Players from Europe', 44)).toEqual({
      meaning: RARITY_GROUP_MEANINGS.REGION,
      region: 'europe',
    });
    expect(decodeRarityGroup('Players from South America', 1).region).toBe('south_america');
  });

  it('reads TOTS from the label', () => {
    expect(decodeRarityGroup('Team of the Season players', 44)).toEqual({
      meaning: RARITY_GROUP_MEANINGS.TOTS,
      region: null,
    });
    expect(decodeRarityGroup('TOTS players', 1).meaning).toBe(RARITY_GROUP_MEANINGS.TOTS);
  });

  it('reads TOTW-or-TOTS from the label that names both', () => {
    expect(decodeRarityGroup('TOTW or TOTS players', 44)).toEqual({
      meaning: RARITY_GROUP_MEANINGS.TOTW_OR_TOTS,
      region: null,
    });
    expect(decodeRarityGroup('Team of the Week or Team of the Season', 44).meaning).toBe(
      RARITY_GROUP_MEANINGS.TOTW_OR_TOTS
    );
  });

  it('reads the value 44 as TOTW-or-TOTS when the label does not name TOTS', () => {
    expect(decodeRarityGroup(null, 44)).toEqual({
      meaning: RARITY_GROUP_MEANINGS.TOTW_OR_TOTS,
      region: null,
    });
    expect(decodeRarityGroup('Special players', 44).meaning).toBe(
      RARITY_GROUP_MEANINGS.TOTW_OR_TOTS
    );
  });

  it('lets the region label win over the value 44', () => {
    expect(decodeRarityGroup('Players from Asia', 44)).toEqual({
      meaning: RARITY_GROUP_MEANINGS.REGION,
      region: 'asia',
    });
  });

  it('returns a null meaning when neither label nor value names a group', () => {
    expect(decodeRarityGroup(null, 7)).toEqual({ meaning: null, region: null });
    expect(decodeRarityGroup('Rare players', 7)).toEqual({ meaning: null, region: null });
  });
});

describe('ELIGIBILITY_KEY_FALLBACK is a labelled fallback over EA numbers', () => {
  it('is frozen and maps the documented key numbers to EA member names', () => {
    expect(Object.isFrozen(ELIGIBILITY_KEY_FALLBACK)).toBe(true);
    expect(ELIGIBILITY_KEY_FALLBACK).toMatchObject({
      0: 'TEAM_STAR_RATING',
      13: 'SCOPE',
      15: 'LEGEND_COUNT',
      18: 'PLAYER_RARITY',
      21: 'PLAYER_COUNT_COMBINED',
      25: 'PLAYER_RARITY_GROUP',
      26: 'PLAYER_MIN_OVR',
      27: 'PLAYER_EXACT_OVR',
      28: 'PLAYER_MAX_OVR',
      30: 'FIRST_OWNER_PLAYERS_COUNT',
      33: 'PLAYER_TRADABILITY',
      35: 'CHEMISTRY_POINTS',
      36: 'ALL_PLAYERS_CHEMISTRY_POINTS',
    });
  });

  it('uses the observed FC27 name for TEAM_RATING, not a shortened variant', () => {
    expect(ELIGIBILITY_KEY_FALLBACK[19]).toBe('TEAM_RATING_1_TO_100');
  });
});

describe('readEligibilityKeys falls back only when the live enum is missing', () => {
  it('resolves the fallback table, names the missing symbol and marks the source', () => {
    const resolved = readEligibilityKeys({});

    expect(resolved.source).toBe('fallback');
    expect(resolved.liveError).toContain('SBCEligibilityKey');
    expect(resolved.keys[13]).toEqual({ type: 'SCOPE', kind: 'SCOPE', role: 'scope' });
    expect(resolved.keys[25]).toMatchObject({ type: 'PLAYER_RARITY_GROUP', role: 'match' });
    expect(resolved.keys[36]).toMatchObject({ type: 'ALL_PLAYERS_CHEMISTRY_POINTS' });
    expect(resolved.drift).toEqual({ added: [], missing: [], renamed: [] });
  });

  it('still rejects a malformed or empty live enum instead of falling back', () => {
    expect(() => readEligibilityKeys({})).not.toThrow();
    expect(() => readEligibilityKeys({ SBCEligibilityKey: {} })).toThrow(/no members/);
    expect(() =>
      readEligibilityKeys({ SBCEligibilityKey: { PLAYER_COUNT: 'two' } })
    ).toThrow(/malformed/);
  });
});

describe('the live page wins over the fallback and the disagreement is reported', () => {
  it('builds the descriptor from the live member and reports the renamed number', () => {
    const resolved = readEligibilityKeys({
      SBCEligibilityKey: {
        PLAYER_MIN_OVR: 19,
        19: 'PLAYER_MIN_OVR',
        SCOPE: 13,
        13: 'SCOPE',
      },
    });

    expect(resolved.source).toBe('live');
    expect(resolved.liveError).toBeNull();
    expect(resolved.keys[19]).toMatchObject({
      type: 'PLAYER_MIN_OVR',
      kind: 'PLAYER_MIN_OVR',
      role: 'match',
      field: 'minRatings',
    });
    expect(resolved.drift.renamed).toContainEqual({
      eligibilityKey: 19,
      liveType: 'PLAYER_MIN_OVR',
      observedType: 'TEAM_RATING_1_TO_100',
    });
  });

  it('reports fallback keys the live enum does not carry, without adding them', () => {
    const resolved = readEligibilityKeys({
      SBCEligibilityKey: { PLAYER_COUNT: 2, 2: 'PLAYER_COUNT' },
    });

    expect(resolved.keys[2].type).toBe('PLAYER_COUNT');
    expect(resolved.keys[25]).toBeUndefined();
    expect(resolved.drift.missing).toContainEqual({
      eligibilityKey: 25,
      type: 'PLAYER_RARITY_GROUP',
    });
  });

  it('reports live keys the fallback does not carry', () => {
    const resolved = readEligibilityKeys({
      SBCEligibilityKey: { SCOPE: 13, 13: 'SCOPE', SOMETHING_NEW: 77, 77: 'SOMETHING_NEW' },
    });

    expect(resolved.drift.added).toContainEqual({ eligibilityKey: 77, type: 'SOMETHING_NEW' });
  });

  it('prints the source and the fallback reason in the diagnostic line', () => {
    const line = formatEligibilityKeysLine(readEligibilityKeys({}));

    expect(line).toContain('source=fallback');
    expect(line).toContain('SBCEligibilityKey');
  });
});