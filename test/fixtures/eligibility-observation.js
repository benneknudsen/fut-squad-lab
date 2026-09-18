/**
 * Observation-based development and test data: the eligibility key numbers and
 * scope values read off the captured FC27 fixtures in this directory.
 *
 * This data deliberately does not live under `src/`. Issue #16 requires the
 * production path to build its key table from EA's live `SBCEligibilityKey` enum
 * through `readEligibilityKeys()` in `src/ea/adapter.js`; a copy of this table
 * inside `src/` would be a fallback a caller could silently reach for. Keeping
 * it in the test fixtures makes that structurally impossible: there is no
 * export for `src/solver/` to import.
 *
 * `PINNED_ELIGIBILITY_KEYS` maps `eligibilityKey` to a descriptor:
 *
 *   type   the payload's `type` string for that key (input side). The decoder
 *          only cross-checks the payload against it; it is never emitted.
 *   kind   the stable internal kind emitted on a decoded constraint (output
 *          side). This is the vocabulary the rest of the solver codes against.
 *          EA's `type` strings are volatile between game versions; `kind` is
 *          owned by the adapter and must stay stable across such renames.
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
 * `SCOPE_VALUES` maps `eligibilityValue` to a comparison operator name. The
 * mapping itself is a pinned EA-semantics model and lives in
 * `src/ea/adapter.js` now, where the browser half reads it from; this file
 * re-exports it so the test helpers keep one import path.
 *
 * Provenance of `SCOPE_VALUES`: EA's client bundle documents the comparison
 * semantics (`GREATER ? n<=r : LOWER ? r<=n : r===n`) but does not expose the
 * enum numbers. The 0/1/2 mapping is an inference supported by the captured
 * fixtures and their challenge descriptions, not a direct reading of an EA enum.
 * Fixture cross-check: set 10 challenge 25 is titled "3 Leagues & 2 Nations" and
 * its payload carries key 8 value 3 with scope 2, key 7 value 2 with scope 2,
 * key 5 value 6 with scope 1 and key 4 value 6 with scope 1 — that title is
 * only reachable if 2 is EXACT and 1 is LOWER.
 *
 * `PLAYER_QUALITY` (key 3) is an opaque integer. The fixtures only ever observe
 * values 1, 2 and 3, but that is an observation, not a verified complete enum,
 * so the decoder does not treat the domain as closed. Which card tier each
 * number names, and how EA aggregates tiers across a squad, is NOT verified
 * here. See `src/solver/requirements.js` and issues #2 and #16.
 */

export { SCOPE_VALUES } from '../../src/ea/adapter.js';

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
