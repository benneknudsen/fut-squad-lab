/**
 * The one file that knows EA SPORTS FC 27 SBC class names, eligibility key
 * numbers, enum values and the raw `/club` item payload shape. Every other
 * module imports EA-specific naming from here, so that when EA renames
 * something exactly one file changes.
 *
 * `normaliseClubItem` at the bottom is the club-payload half of that boundary:
 * it translates raw items into the stable solver schema, and the solver core
 * may only ever see the translated form.
 *
 * ## Production entry point vs. pinned observation data
 *
 * M2 of `docs/PLAN.md` requires the eligibility key table to be built by reading
 * EA's live `SBCEligibilityKey` enum at runtime (`window.SBCEligibilityKey`)
 * rather than hardcoding numbers. That page-side read needs the M1 page bridge,
 * which does not exist yet (issue #16). Production code must therefore call
 * `readEligibilityKeys()`, which throws a clear error until the bridge lands: a
 * silent fallback to pinned numbers could decode requirements into the wrong
 * constraints without anyone noticing.
 *
 * `PINNED_ELIGIBILITY_KEYS` and `SCOPE_VALUES` below are observation-based
 * development and test data, read off the captured fixtures in `test/fixtures/`.
 * Tests import them directly; production code must not.
 *
 * ## Stable solver vocabulary
 *
 * `PINNED_ELIGIBILITY_KEYS` maps `eligibilityKey` to a descriptor:
 *
 *   type   the payload's `type` string for that key (input side). The decoder
 *          only cross-checks the payload against it; it is never emitted.
 *   kind   the stable internal kind emitted on a decoded constraint (output
 *          side). This is the vocabulary the rest of the solver codes against.
 *          EA's `type` strings are volatile between game versions; `kind` is
 *          owned by this adapter and must stay stable across such renames.
 *   role   what the entry means inside its `eligibilitySlot`:
 *            'count'  the squad-size quantity of a scoped player match
 *            'match'  a nation/league/club/level a 'count' applies to
 *            'scalar' a standalone quantity requirement
 *            'scope'  the comparison operator for the whole slot
 *   field  for role 'match': the internal field the values are grouped under
 *
 * A decoded constraint carries the comparison operator separately as `scope`,
 * so `kind` names the measured dimension only: a LOWER-scoped same-league count
 * is not a "min" requirement, it is a cap.
 *
 * `SCOPE_VALUES` maps `eligibilityValue` to a comparison operator name.
 *
 * Provenance of `SCOPE_VALUES`: EA's client bundle documents the comparison
 * semantics (`GREATER ? n<=r : LOWER ? r<=n : r===n`) but does not expose the
 * enum numbers. The 0/1/2 mapping below is an inference supported by the
 * captured fixtures and their challenge descriptions, not a direct reading of an
 * EA enum. Fixture cross-check: set 10 challenge 25 is titled
 * "3 Leagues & 2 Nations" and its payload carries key 8 value 3 with scope 2,
 * key 7 value 2 with scope 2, key 5 value 6 with scope 1 and key 4 value 6 with
 * scope 1 — that title is only reachable if 2 is EXACT and 1 is LOWER.
 *
 * `PLAYER_QUALITY` (key 3) is an opaque integer. The fixtures only ever observe
 * values 1, 2 and 3, but that is an observation, not a verified complete enum,
 * so the decoder does not treat the domain as closed. Which card tier each
 * number names, and how EA aggregates tiers across a squad, is NOT verified
 * here. See `src/solver/requirements.js` and issues #2 and #16.
 *
 * This file is pure data and pure functions. No DOM, no chrome APIs, no network.
 */

export const SCOPE_VALUES = Object.freeze({
  0: 'GREATER',
  1: 'LOWER',
  2: 'EXACT',
});

/**
 * Observation-based development and test data. Only tests may import this; the
 * production path is `readEligibilityKeys()`. The key numbers and kinds come
 * from the captured fixtures and may be incomplete or stale.
 */
export const PINNED_ELIGIBILITY_KEYS = Object.freeze({
  2: Object.freeze({ type: 'PLAYER_COUNT', kind: 'PLAYER_COUNT_MATCH', role: 'count' }),
  3: Object.freeze({ type: 'PLAYER_QUALITY', kind: 'PLAYER_QUALITY', role: 'scalar' }),
  4: Object.freeze({ type: 'SAME_NATION_COUNT', kind: 'SAME_NATION_COUNT', role: 'scalar' }),
  5: Object.freeze({ type: 'SAME_LEAGUE_COUNT', kind: 'SAME_LEAGUE_COUNT', role: 'scalar' }),
  6: Object.freeze({ type: 'SAME_CLUB_COUNT', kind: 'SAME_CLUB_COUNT', role: 'scalar' }),
  7: Object.freeze({ type: 'NATION_COUNT', kind: 'NATION_COUNT', role: 'scalar' }),
  8: Object.freeze({ type: 'LEAGUE_COUNT', kind: 'LEAGUE_COUNT', role: 'scalar' }),
  9: Object.freeze({ type: 'CLUB_COUNT', kind: 'CLUB_COUNT', role: 'scalar' }),
  10: Object.freeze({ type: 'NATION_ID', kind: 'NATION_MATCH', role: 'match', field: 'nationIds' }),
  11: Object.freeze({ type: 'LEAGUE_ID', kind: 'LEAGUE_MATCH', role: 'match', field: 'leagueIds' }),
  12: Object.freeze({ type: 'CLUB_ID', kind: 'CLUB_MATCH', role: 'match', field: 'clubIds' }),
  13: Object.freeze({ type: 'SCOPE', kind: 'SCOPE', role: 'scope' }),
  17: Object.freeze({
    type: 'PLAYER_LEVEL',
    kind: 'PLAYER_LEVEL_MATCH',
    role: 'match',
    field: 'playerLevels',
  }),
  19: Object.freeze({ type: 'TEAM_RATING_1_TO_100', kind: 'TEAM_RATING', role: 'scalar' }),
  35: Object.freeze({ type: 'CHEMISTRY_POINTS', kind: 'CHEMISTRY_POINTS', role: 'scalar' }),
});

/**
 * The production entry point for the eligibility key table.
 *
 * The table must be read from EA's live `SBCEligibilityKey` enum on the page
 * through the M1 page bridge. Neither the bridge nor a logged-in FC27 session is
 * available yet, so this throws instead of falling back to the pinned
 * observation table, whose numbers may be incomplete or stale.
 *
 * @returns {object} eligibilityKey -> descriptor, read from the live page enum
 * @throws {Error} always, until the M1 page bridge lands (issue #16)
 */
export function readEligibilityKeys() {
  throw new Error(
    'readEligibilityKeys: the live SBCEligibilityKey enum can only be read from the page ' +
      'through the M1 page bridge, which does not exist yet (issue #16). Production must ' +
      'not fall back to the pinned observation table; tests import PINNED_ELIGIBILITY_KEYS ' +
      'directly.'
  );
}

/** Raw `/club` item fields the stable schema cannot be built without. */
const RAW_ITEM_NUMERIC_FIELDS = Object.freeze(['rating', 'nation', 'teamid']);

/**
 * The one translation from a raw `/club` payload item to the stable item schema
 * the solver core codes against:
 *
 *   { id, rating, nationId, leagueId, clubId, rarity, untradeable }
 *
 * `nation` becomes `nationId`, `teamid` becomes `clubId` and `rareflag` becomes
 * `rarity`; `id`, `rating`, `leagueId` and `untradeable` keep their names. This
 * is the only place that may know the raw `/club` field names —
 * `src/solver/validate.js` reads the stable schema only, and rejects an
 * un-normalised item.
 *
 * The raw payload must carry `rating`, `nation` and `teamid` as finite numbers.
 * This boundary is the only point where the raw shape is known, so a missing
 * field throws here with that context instead of silently producing an
 * `undefined` that only surfaces later as a confusing solver error.
 *
 * @param {object} rawItem one item from the `/club` response
 * @returns {{ id: number, rating: number, nationId: number, leagueId: number,
 *   clubId: number, rarity: number, untradeable: boolean }}
 * @throws {Error} when the raw item lacks a finite `rating`, `nation` or `teamid`
 */
export function normaliseClubItem(rawItem) {
  for (const field of RAW_ITEM_NUMERIC_FIELDS) {
    if (!Number.isFinite(rawItem[field])) {
      throw new Error(
        `normaliseClubItem: raw item must carry a finite ${field}; the /club payload shape may` +
          ' have changed'
      );
    }
  }
  return {
    id: rawItem.id,
    rating: rawItem.rating,
    nationId: rawItem.nation,
    leagueId: rawItem.leagueId,
    clubId: rawItem.teamid,
    rarity: rawItem.rareflag,
    untradeable: rawItem.untradeable,
  };
}
