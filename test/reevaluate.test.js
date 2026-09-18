import { describe, expect, it } from 'vitest';

import {
  normaliseChemistryProfile,
  normaliseFormation,
  normaliseTeamChemLinks,
} from '../src/ea/adapter.js';
import { buildPool, normaliseClub } from '../src/solver/candidates.js';
import { buildClubIndex } from '../src/solver/chemistry.js';
import {
  compareContributions,
  itemCost,
  mergePrices,
  resolveWeights,
} from '../src/solver/prices.js';
import { normaliseRequirements } from '../src/solver/requirements.js';
import { reevaluate, solve } from '../src/solver/solve.js';
import { validateSquad } from '../src/solver/validate.js';
import { PINNED_ELIGIBILITY_KEYS, SCOPE_VALUES, withEligibility } from './helpers/eligibility.js';
import clubFixture from './fixtures/club-items.json';
import linksFixture from './fixtures/chemistry-teamlinks.json';
import profilesFixture from './fixtures/chemistry-profiles.json';
import set16 from './fixtures/sbs-set-16-challenges.json';

const decode = (challenge) =>
  normaliseRequirements(challenge.elgReq, {
    operation: challenge.elgOperation,
    keys: PINNED_ELIGIBILITY_KEYS,
    scopes: SCOPE_VALUES,
  }).constraints;

const POOL = buildPool(normaliseClub(clubFixture.itemData));

// The pool records `buildPool` emits are unmerged; the solver prices its own
// copies. The tests price an independent copy through the canonical path so
// every expected contribution is computed with the same #6 model.
const PRICED_POOL = mergePrices(POOL);

const CLUB_INDEX = buildClubIndex(normaliseTeamChemLinks(linksFixture.teamChemLinks));

const VALIDATOR_OPTIONS = { clubLinks: (clubId) => CLUB_INDEX.groupOf(clubId) };

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

const validate = (result, challenge) =>
  validateSquad(result.squad, decode(challenge), VALIDATOR_OPTIONS);

const ALL_SLOTS = Object.freeze(Array.from({ length: 11 }, (_, index) => index));

// The closed vocabulary fixed by design/copy.en.json under `alts.reason`. The
// solver may not invent a key: the UI has no copy for anything outside this
// set. The list is repeated here on purpose, so a typo in the solver constant
// cannot make this test pass.
const REASON_KEYS = new Set([
  'sameLeague',
  'sameNation',
  'sameClub',
  'keepsChemistry',
  'oneRatingDown',
  'twoRatingDown',
  'breaksLink',
  'keepsLinks',
  'fromClubPool',
  'positionMatch',
  'outOfPosition',
]);

const contributionOf = (record) => itemCost(record, resolveWeights()).contribution;

const positionsFor = (player) =>
  Array.isArray(player.possiblePositions) && player.possiblePositions.length > 0
    ? player.possiblePositions
    : [player.preferredPosition];

const swappedSquad = (base, slot, record) => {
  const players = base.squad.players.slice();
  players[slot] = record;
  return { players, chemistry: base.squad.chemistry };
};

// The fixture must offer at least one valid swap that costs more than the
// solver's pick; the test that plants it fails loudly if not, instead of
// silently checking nothing.
const findPricierValidSwap = (base, challenge) => {
  const usedIds = new Set(base.squad.players.map(({ id }) => id));
  const { positions } = normaliseFormation(challenge.formation);

  for (const slot of ALL_SLOTS) {
    const current = contributionOf(base.squad.players[slot]);
    if (current === null) continue;

    for (const record of PRICED_POOL) {
      if (usedIds.has(record.id)) continue;
      if (!positionsFor(record).includes(positions[slot])) continue;
      const candidate = contributionOf(record);
      if (candidate === null || candidate <= current) continue;

      const validation = validateSquad(
        swappedSquad(base, slot, record),
        decode(challenge),
        VALIDATOR_OPTIONS
      );
      if (validation.valid) return { slot, record };
    }
  }
  return null;
};

const rawItem = ({
  index,
  position,
  club,
  nation = 1,
  leagueId = 1,
  rating = 70,
  marketAverage = 1000,
  discardValue = 500,
}) => ({
  id: 920000 + index,
  assetId: 720000 + index,
  rating,
  nation,
  leagueId,
  teamid: club,
  rareflag: 0,
  cardsubtypeid: 0,
  playStyle: 0,
  preferredPosition: position,
  possiblePositions: [position],
  untradeable: true,
  pile: 7,
  owners: 1,
  isCollected: true,
  marketAverage,
  marketDataMinPrice: null,
  marketDataMaxPrice: null,
  discardValue,
});

describe('reevaluate', () => {
  const challenge = set16.challenges[0];
  const base = solve(challenge, POOL, options());

  it('keeps every locked player in place and returns a validator-approved result', () => {
    expect(base.valid).toBe(true);

    const lockedSlots = [0, 5, 9];
    const lockedIds = lockedSlots.map((slot) => base.squad.players[slot].id);

    const result = reevaluate(base.squad, lockedSlots, POOL, options({ challenge }));

    expect(result.squad.players).toHaveLength(11);
    expect(lockedSlots.map((slot) => result.squad.players[slot].id)).toEqual(lockedIds);
    expect(new Set(result.squad.players.map(({ id }) => id)).size).toBe(11);
    expect(validate(result, challenge).valid).toBe(result.valid);
  });

  it('changes an unlocked slot when a cheaper valid arrangement exists', () => {
    const found = findPricierValidSwap(base, challenge);
    expect(found, 'fixture pool must offer a valid pricier swap').not.toBeNull();

    const planted = {
      players: base.squad.players.slice(),
      chemistry: base.squad.chemistry,
    };
    planted.players[found.slot] = found.record;

    // Every other slot is locked, so the only decision left is this slot. The
    // solver must replace the planted, deliberately pricier record with a
    // cheaper valid one instead of echoing the planted squad back.
    const result = reevaluate(
      planted,
      ALL_SLOTS.filter((slot) => slot !== found.slot),
      POOL,
      options({ challenge })
    );

    expect(result.squad.players[found.slot].id).not.toBe(found.record.id);
    expect(validate(result, challenge).valid).toBe(result.valid);
    expect(result.valid).toBe(true);
  });

  it('populates alternatives for unlocked slots and leaves locked slots empty', () => {
    const lockedSlots = [0, 5];

    const result = reevaluate(base.squad, lockedSlots, POOL, options({ challenge }));

    expect(result.alternatives).toHaveLength(11);
    for (const slot of lockedSlots) expect(result.alternatives[slot]).toEqual([]);
    expect(result.alternatives.every(Array.isArray)).toBe(true);
    expect(result.alternatives.some((list, slot) => !lockedSlots.includes(slot) && list.length > 0)).toBe(
      true
    );
  });

  it('returns the input squad unchanged, re-validated, when every slot is locked', () => {
    const result = reevaluate(base.squad, ALL_SLOTS, POOL, options({ challenge }));

    expect(result.valid).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.squad.players.map(({ id }) => id)).toEqual(
      base.squad.players.map(({ id }) => id)
    );
    expect(validate(result, challenge).valid).toBe(true);
    expect(result.alternatives).toEqual(ALL_SLOTS.map(() => []));
  });

  it('reports a lock-caused infeasibility instead of silently unlocking the slot', () => {
    // Club-count EXACT 2: the club holds ten records from club 1, one from
    // club 2 and one goalkeeper from club 3. Solving without locks is valid
    // (club 1 plus club 2). Locking the club-3 goalkeeper leaves ten records
    // from clubs 1 and 2 for ten slots, so any completion counts three clubs
    // and must fail the EXACT 2 requirement. A solver that quietly unlocked
    // slot 0 would return a valid squad; this one must not.
    const pool = buildPool(
      normaliseClub([
        ...['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST'].map((position, index) =>
          rawItem({ index, position, club: 100 })
        ),
        rawItem({ index: 10, position: 'ST', club: 200 }),
        rawItem({ index: 11, position: 'GK', club: 300 }),
      ])
    );
    const clubCountChallenge = {
      formation: 'f442',
      elgOperation: 'AND',
      elgReq: [
        { type: 'SCOPE', eligibilitySlot: 1, eligibilityKey: 13, eligibilityValue: 2 },
        { type: 'CLUB_COUNT', eligibilitySlot: 1, eligibilityKey: 9, eligibilityValue: 2 },
      ],
    };
    const clubThreeGoalkeeper = pool.find((record) => record.clubId === 300);

    const solved = solve(clubCountChallenge, pool, withEligibility({ seed: 1 }));
    expect(solved.valid, 'the unlocked solve must be valid for this test to mean anything').toBe(
      true
    );

    const players = solved.squad.players.slice();
    players[0] = clubThreeGoalkeeper;

    const result = reevaluate(
      { players, chemistry: solved.squad.chemistry },
      [0],
      pool,
      withEligibility({ challenge: clubCountChallenge, seed: 1 })
    );

    expect(result.valid).toBe(false);
    expect(result.squad.players[0].id).toBe(clubThreeGoalkeeper.id);
    const clubFailure = result.failures.find(({ kind }) => kind === 'CLUB_COUNT');
    expect(clubFailure).toMatchObject({ required: 2, actual: 3, scope: 'EXACT' });
  });

  it('only returns alternatives whose swap keeps the squad valid', () => {
    const result = reevaluate(base.squad, [], POOL, options({ challenge }));
    let checked = 0;

    result.alternatives.forEach((list, slot) => {
      for (const alternative of list) {
        const validation = validateSquad(
          swappedSquad(result, slot, alternative.record),
          decode(challenge),
          VALIDATOR_OPTIONS
        );
        expect(validation.valid, `slot ${slot}, record ${alternative.record.id}`).toBe(true);
        checked += 1;
      }
    });

    // Without this the loop above could pass vacuously on empty lists.
    expect(checked).toBeGreaterThan(0);
  });

  it('ranks alternatives by cost ascending and reports a signed, independently derived costDelta', () => {
    // Challenge 39's fixture solution has at least one cheaper valid swap, so
    // the negative sign of `costDelta` is exercised, not only derived arithmetic.
    const deltaChallenge = set16.challenges[3];
    const deltaBase = solve(deltaChallenge, POOL, options());
    expect(deltaBase.valid).toBe(true);

    const result = reevaluate(deltaBase.squad, [], POOL, options({ challenge: deltaChallenge }));
    const weights = resolveWeights();
    let checked = 0;
    let sawNegative = false;

    result.alternatives.forEach((list, slot) => {
      const currentContribution = itemCost(result.squad.players[slot], weights).contribution;

      for (let index = 0; index < list.length; index++) {
        const alternative = list[index];
        const candidateContribution = itemCost(alternative.record, weights).contribution;
        const expected =
          candidateContribution === null || currentContribution === null
            ? null
            : candidateContribution - currentContribution;

        expect(alternative.costDelta, `slot ${slot}, record ${alternative.record.id}`).toBe(expected);
        if (alternative.costDelta !== null && alternative.costDelta < 0) sawNegative = true;
        checked += 1;

        if (index > 0) {
          expect(
            compareContributions(
              itemCost(list[index - 1].record, weights).contribution,
              candidateContribution
            )
          ).toBeLessThanOrEqual(0);
        }
      }
    });

    expect(checked).toBeGreaterThan(0);
    // A signed delta is only really exercised by a negative value; this
    // fixture pool has at least one cheaper valid swap.
    expect(sawNegative).toBe(true);
  });

  it('emits only structured reason keys from the design contract vocabulary', () => {
    const result = reevaluate(base.squad, [], POOL, options({ challenge }));
    let reasonCount = 0;

    result.alternatives.forEach((list) => {
      for (const alternative of list) {
        expect(Array.isArray(alternative.reasons)).toBe(true);
        for (const reason of alternative.reasons) {
          expect(REASON_KEYS.has(reason.key), `unknown reason key ${reason.key}`).toBe(true);
          reasonCount += 1;

          if (reason.key === 'breaksLink') {
            expect(reason.params).toEqual({ count: expect.any(Number) });
          } else if (reason.key === 'positionMatch') {
            expect(reason.params).toEqual({ formation: challenge.formation });
          } else {
            expect(reason.params).toBeUndefined();
          }
        }
      }
    });

    expect(reasonCount).toBeGreaterThan(0);
  });

  it('propagates an unknown contribution as a null costDelta instead of 0', () => {
    // A pool whose every card is unpriced: the solver still fills a valid
    // squad (cost null), and no alternative may pretend an unpriced swap is
    // free. Two fitting records per position give the populated lists.
    const unpricedPool = buildPool(
      normaliseClub([
        ...['GK', 'LB', 'CB', 'CB', 'RB', 'LM', 'CM', 'CM', 'RM', 'ST', 'ST'].map(
          (position, index) =>
            rawItem({ index, position, club: 100 + index, marketAverage: null, discardValue: null })
        ),
        ...['LB', 'CB', 'CM', 'ST'].map((position, index) =>
          rawItem({
            index: 20 + index,
            position,
            club: 200 + index,
            marketAverage: null,
            discardValue: null,
          })
        ),
      ])
    );
    const bareChallenge = { formation: 'f442', elgOperation: 'AND', elgReq: [] };

    const solved = solve(bareChallenge, unpricedPool, withEligibility({ seed: 1 }));
    expect(solved.valid).toBe(true);
    expect(solved.cost).toBeNull();

    const result = reevaluate(
      solved.squad,
      [],
      unpricedPool,
      withEligibility({ challenge: bareChallenge, seed: 1 })
    );
    const populated = result.alternatives.filter((list) => list.length > 0);
    expect(populated.length).toBeGreaterThan(0);
    for (const list of populated) {
      for (const alternative of list) expect(alternative.costDelta).toBeNull();
    }
  });

  it('is deterministic for the same seed', () => {
    const first = reevaluate(base.squad, [0, 5], POOL, options({ challenge, seed: 7 }));
    const second = reevaluate(base.squad, [0, 5], POOL, options({ challenge, seed: 7 }));

    expect(second).toEqual(first);
  });

  it('stays well inside the interactive budget on the fixture pool', () => {
    const durations = [];
    for (let run = 0; run < 5; run++) {
      const started = Date.now();
      reevaluate(base.squad, [], POOL, options({ challenge }));
      durations.push(Date.now() - started);
    }
    durations.sort((left, right) => left - right);
    const median = durations[2];

    expect(median).toBeLessThan(1000);
  });
});
