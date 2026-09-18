/**
 * The chemistry layer: the link counts (which clubs count as the same club,
 * and how many club, league and nationId links each player has) and the
 * scoring that turns those links into EA's 0–3 per-player chemistry and 0–33
 * squad total. `squadChemistry` returns that total together with its
 * verification status, so a computed number can never be mistaken for a
 * verified one.
 *
 * ## Stable record
 *
 * `countLinks` reads the stable club record produced by `normaliseClubItem`:
 * it uses `id`, `nationId`, `leagueId` and `clubId` and nothing else. The raw
 * payload names are translated in `src/ea/adapter.js`; this module never sees
 * them.
 *
 * `playerChemistry` validates those four identity fields on every record it
 * scores before it counts links. A record missing `nationId`, `leagueId` or
 * `clubId` would compare its `undefined` against another missing record's
 * `undefined` and count a false link, so such a record throws instead of
 * scoring a plausible-looking wrong number.
 *
 * ## Club equivalence
 *
 * `buildClubIndex(links)` takes the adapter's normalised link list —
 * `[{ clubId, linkedClubIds }]` — and returns:
 *
 *   groupOf(clubId)   the stable identity of the club's equivalence group: the
 *                     smallest clubId in the group, so the identity does not
 *                     depend on the order of the links.
 *   sameClub(a, b)    true when both clubs are in the same group.
 *
 * The relation is transitive (A-B and B-C put A, B and C in one group) and
 * symmetric (a one-directional link still merges both sides). A club absent
 * from the link list is its own singleton group, never `undefined`. Self-links
 * and repeated linked club ids do not change the result.
 *
 * ## Counting rule
 *
 * `countLinks(player, others, clubIndex)` counts partners, not distinct clubs:
 * a player matched to two other squad members from the same club counts two
 * club links, because two other players are linked to them. A partner that
 * matches on several dimensions counts once in each dimension.
 *
 * `others` holds the other squad members only, never the player itself: the
 * own id appearing there throws. `clubIndex` is required: without it, linked
 * clubs would be counted as different clubs and the chemistry total would be
 * silently wrong.
 *
 * This module is pure: plain data in, plain data out. No DOM, no chrome APIs,
 * no network. Inputs are never mutated.
 */

/**
 * Union-find over the club links. The representative of a group is the smallest
 * clubId in it, which makes `groupOf` stable regardless of the order the links
 * arrive in.
 */
export function buildClubIndex(links) {
  const parent = new Map();

  const find = (clubId) => {
    let root = clubId;
    while (parent.get(root) !== root) {
      root = parent.get(root);
    }
    let current = clubId;
    while (parent.get(current) !== root) {
      const next = parent.get(current);
      parent.set(current, root);
      current = next;
    }
    return root;
  };

  const union = (left, right) => {
    if (!parent.has(left)) parent.set(left, left);
    if (!parent.has(right)) parent.set(right, right);
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parent.set(rightRoot, leftRoot);
    else parent.set(leftRoot, rightRoot);
  };

  for (const { clubId, linkedClubIds } of links) {
    for (const linkedClubId of linkedClubIds) {
      union(clubId, linkedClubId);
    }
  }

  const groupOf = (clubId) => (parent.has(clubId) ? find(clubId) : clubId);
  const sameClub = (left, right) => groupOf(left) === groupOf(right);

  return { groupOf, sameClub };
}

/**
 * Per-player link counts over `others`, broken down by dimension.
 *
 * @param {{ id: number, nationId: number, leagueId: number, clubId: number }} player
 *   a stable club record
 * @param {Array<object>} others the other squad members, excluding `player`
 * @param {{ groupOf: Function, sameClub: Function }} clubIndex output of
 *   `buildClubIndex`
 * @returns {{ nation: number, league: number, club: number }} exact counts,
 *   zero when nothing matches
 * @throws {Error} when `clubIndex` is omitted or `others` contains `player`
 */
export function countLinks(player, others, clubIndex) {
  if (clubIndex === undefined || clubIndex === null) {
    throw new Error(
      'countLinks: clubIndex is required; build it with buildClubIndex and pass it in.' +
        ' Without it, linked clubs would be counted as different clubs and the chemistry' +
        ' score would be silently wrong.'
    );
  }

  let nation = 0;
  let league = 0;
  let club = 0;

  for (const other of others) {
    if (other.id === player.id) {
      throw new Error(
        `countLinks: others must not contain the player itself (id ${player.id}); pass the` +
          ' other squad members only'
      );
    }
    if (other.nationId === player.nationId) nation += 1;
    if (other.leagueId === player.leagueId) league += 1;
    if (clubIndex.sameClub(player.clubId, other.clubId)) club += 1;
  }

  return { nation, league, club };
}

/**
 * ## Scoring layer: profile resolution and chemistry values
 *
 * `resolveProfile`, `playerChemistry` and `squadChemistry` turn the link counts
 * above into the 0–3 numbers EA displays per starter and their 0–33 squad
 * total. Every statement below is tagged:
 *
 *   [observed] the captured `chemistry-observed-squad.json` fixture proves it
 *   [inferred] derived here; the captured data cannot prove it
 *   [hypothesis] a reading the one capture cannot separate from alternatives;
 *     it is carried because it is the least invented reading, not because EA
 *     is shown to behave that way
 *
 * ### Stable profile schema
 *
 * The scoring functions read the stable rule set produced by the adapter's
 * `normaliseChemistryProfile`: mappings are `{ profile, rarities }`, profiles
 * are `{ id, fullChemistryAtPreferredPosition, overrides, rules }` and rules
 * are `{ dimension, calculation, value }` with `dimension` one of `nation`,
 * `league` and `club`. Raw EA names never reach this module.
 *
 * ### Profile resolution
 *
 * [observed] The fixture maps rarity 69 to a profile whose rules carry nation
 * 1, league 3 and club 2.
 *
 * [inferred] `resolveProfile` follows the indirection and never hardcodes a
 * profile id: it finds the mapping whose `rarities` contain the rarity, then
 * returns the profile with the mapped `profile` id. A rarity with no mapping
 * resolves to `null`. The fixture maps only rarity 69, so a fallback profile
 * would be a guess, and a guessed rule set scores a card silently wrongly.
 * The caller decides what an unmapped card means; `playerChemistry` rejects a
 * `null` profile rather than inventing rules.
 *
 * ### The formula
 *
 * [observed] The squad total is the sum over the eleven starters. The twelve
 * bench slots carry no chemistry at all (EA stores `null` for each), so the
 * bench is out of scope and the array passed to these functions is the XI.
 *
 * [observed] A starter who shares no nation, league or club with any other
 * starter scores 0 (fixture starter 8).
 *
 * [observed] In the capture every nation match count is 0 or 1 under nation
 * value 1, every league match count is 0 or exactly 3 under league value 3,
 * and every club match count is 0: no two starters share a club, linked or
 * not. The observed per-player values are [1, 1, 1, 1, 1, 1, 1, 1, 0, 2, 2],
 * total 12.
 *
 * [hypothesis] How a rule's `value` becomes points. No dimension is ever
 * observed above its `value`, and the club rule is never observed with a
 * non-zero match count, so each of these readings reproduces all eleven values
 * and the total:
 *
 *   floor(matches / value)        one point per complete group of `value`
 *   ceil(matches / value)         one point as soon as any partner exists
 *   matches >= value ? 1 : 0      a single threshold, never more than one point
 *   matches / value               unrounded, fractional points
 *   min(matches, value) / value   division with saturation at one point
 *
 * `floor(matches / value)` is chosen because it uses each rule's own `value`
 * with no introduced constant, keeps every score an integer like EA's display,
 * and defines behaviour beyond `value` without inventing a cap. That is a
 * choice, not a proof: a squad with, say, five same-league partners under value
 * 3 would separate these readings, and no such squad has been captured. The
 * formula is therefore a hypothesis that ships behind the unverified marker
 * described below.
 *
 * Matches are other starters only, never the player itself. A teammate that
 * matches several dimensions counts once in each. The club dimension uses the
 * linked-club groups from `buildClubIndex`, not raw club ids.
 *
 * [hypothesis] `calculation` carries no arithmetic here. The one captured
 * profile mixes `normal` and `universal` in a single rule set, and no capture
 * shows what separates them, so this module accepts the two named values and
 * scores them identically. The adapter only ever emits those two (and throws
 * on any other raw value); a hand-built profile with another value throws here
 * rather than having an effect invented for it.
 *
 * [inferred] Per-player chemistry is the sum of the rule points capped at 3,
 * EA's per-player maximum; the squad maximum is therefore 33 (11 × 3).
 *
 * [inferred] `fullChemistryAtPreferredPosition` cannot be acted on. The stable
 * records carry no formation slot position, so an out-of-position starter
 * cannot be identified and a `true` flag would silently overstate chemistry.
 * `playerChemistry` therefore throws for a profile with the flag set, naming
 * the missing slot context; the captured profile carries `false`, so no
 * captured path changes.
 *
 * [inferred] A profile may carry `fullChemistryAtPreferredPosition: null`,
 * meaning the payload did not state the flag. The arithmetic is unchanged —
 * `false` and `null` score the same — but `squadChemistry` marks a `null`-flag
 * result with the distinct reason `chemistry-position-flag-missing`, so a
 * caller can tell "EA said position does not matter" from "we do not know".
 * A `true` flag still throws: it promises placement matters and this layer
 * cannot honour that promise.
 *
 * [inferred] `loyaltyBonus` is not part of the value. [observed] Starter 8
 * carries `loyaltyBonus: 1` and EA still displays chemistry 0, and all eleven
 * starters match without any loyalty term.
 *
 * ### Verification status travels with the number
 *
 * [observed] The formula reproduces every per-player value and the total for
 * the one captured squad. One squad is one observation, not verification.
 * `squadChemistry` therefore returns an object, not a bare number:
 *
 *   { chemistry: <number>, verified: false, reason: 'chemistry-formula-unverified' }
 *
 * When the resolved profile's position flag is `null`, the reason is
 * `chemistry-position-flag-missing` instead: the number is just as unverified,
 * and the reason says which fact is missing.
 *
 * `verified` mirrors `CHEMISTRY_FORMULA_VERIFIED`; while it is false the reason
 * names why. A caller that stores only a bare number throws that status away,
 * which is what would let a computed score be mistaken for a verified one.
 * `playerChemistry` still returns a bare number: the status belongs to the
 * formula as a whole, every per-player value comes from the same formula, and
 * one squad-level marker covers them all.
 */

/** The maximum chemistry EA displays for one starter. */
const PLAYER_CHEMISTRY_MAX = 3;

/**
 * `false` until the scoring formula has been verified against EA. The one
 * captured squad matches, but that is a single observation; the M3 acceptance
 * test — a computed squad matches the number EA renders in its squad stats
 * view — is what flips this. `squadChemistry` copies this flag and the
 * accompanying reason onto every result, so a caller never has to remember it.
 */
export const CHEMISTRY_FORMULA_VERIFIED = false;

/** The reason carried on every `squadChemistry` result while it is unverified. */
const CHEMISTRY_UNVERIFIED_REASON = 'chemistry-formula-unverified';

/**
 * The reason carried when the adapter could not say whether full chemistry
 * needs the preferred position (the payload omitted the flag, normalised to
 * `null`). Distinct from `CHEMISTRY_UNVERIFIED_REASON`, so a caller can tell
 * "EA said the position does not matter" from "we do not know". `validate.js`
 * duplicates this string in its known-reason set; a test binds the two.
 */
const CHEMISTRY_POSITION_FLAG_MISSING_REASON = 'chemistry-position-flag-missing';

/**
 * The dimensions a rule may measure, mapped to the `countLinks` result key.
 * The adapter normalises EA's raw dimension enum down to these keys, so the
 * mapping is the identity today; it stays an explicit table so the allowed
 * vocabulary lives in one place. Lookup uses `Object.hasOwn` so an inherited
 * key such as `toString` cannot pass the check and reach the arithmetic as
 * `undefined`. An unknown dimension throws rather than being skipped: skipping
 * would silently reduce every player's chemistry.
 */
const LINK_COUNT_FIELDS = Object.freeze({
  nation: 'nation',
  league: 'league',
  club: 'club',
});

/** The named calculation types; both are scored identically (see above). */
const CALCULATION_VALUES = new Set(['normal', 'universal']);

/**
 * The profile that applies to a card rarity, honouring the mapping
 * indirection: find the mapping whose `rarities` contain `rarityId`, then
 * return the profile whose `id` is the mapped `profile`.
 *
 * A rarity with no mapping returns `null` — no profile is guessed. A mapping
 * without a finite `profile`, or one that names a profile the rule set does
 * not contain, throws: malformed data is a loud failure, and an un-normalised
 * raw payload hits the `profile` guard instead of resolving against raw names.
 *
 * @param {number} rarityId the stable `rarity` of the card
 * @param {{ mappings: Array<object>, profiles: Array<object> }} ruleSet the
 *   stable rule set from the adapter's `normaliseChemistryProfile`
 * @returns {object|null} the applicable profile, or `null` when the rarity has
 *   no mapping
 * @throws {Error} when the rule set is not a mappings/profiles object, a
 *   mapping has no finite `profile`, or a mapping names a profile the rule set
 *   does not contain
 */
export function resolveProfile(rarityId, ruleSet) {
  if (
    ruleSet === null ||
    typeof ruleSet !== 'object' ||
    Array.isArray(ruleSet) ||
    !Array.isArray(ruleSet.mappings) ||
    !Array.isArray(ruleSet.profiles)
  ) {
    throw new Error(
      'resolveProfile: rule set must carry a mappings array and a profiles array; normalise the' +
        ' adapter chemistry rule set with normaliseChemistryProfile first'
    );
  }

  for (const [index, entry] of ruleSet.mappings.entries()) {
    if (entry === null || typeof entry !== 'object' || !Array.isArray(entry.rarities)) {
      throw new Error(
        `resolveProfile: mapping ${index} must carry a rarities array; normalise the adapter` +
          ' chemistry rule set with normaliseChemistryProfile first'
      );
    }
  }

  const mapping = ruleSet.mappings.find((entry) => entry.rarities.includes(rarityId));
  if (mapping === undefined) return null;
  if (!Number.isFinite(mapping.profile)) {
    throw new Error(
      `resolveProfile: mapping for rarity ${rarityId} must carry a finite profile id; normalise` +
        ' the adapter chemistry rule set with normaliseChemistryProfile first'
    );
  }

  const profile = ruleSet.profiles.find((entry) => entry.id === mapping.profile);
  if (profile === undefined) {
    throw new Error(
      `resolveProfile: mapping for rarity ${rarityId} names profile ${mapping.profile}, which is` +
        ' not in the rule set'
    );
  }
  return profile;
}

/**
 * One rule's chemistry points for a player. The division is the hypothesis
 * documented in the scoring block; `calculation` is read only to reject a
 * value this module cannot name, never to change the arithmetic.
 */
const rulePoints = (rule, links) => {
  if (!Object.hasOwn(LINK_COUNT_FIELDS, rule.dimension)) {
    throw new Error(
      `playerChemistry: unsupported rule dimension ${JSON.stringify(
        rule.dimension
      )}; this scoring layer knows nation, league and club and will not ignore a dimension it` +
        ' cannot score'
    );
  }
  if (!CALCULATION_VALUES.has(rule.calculation)) {
    throw new Error(
      `playerChemistry: unsupported rule calculation ${JSON.stringify(
        rule.calculation
      )}; only the named calculation types may reach the scoring layer`
    );
  }
  if (!Number.isFinite(rule.value) || rule.value <= 0) {
    throw new Error(
      `playerChemistry: rule for ${rule.dimension} must carry a positive finite value, got` +
        ` ${JSON.stringify(rule.value)}; a non-positive value would divide by zero`
    );
  }
  return Math.floor(links[LINK_COUNT_FIELDS[rule.dimension]] / rule.value);
};

/**
 * The identity fields `countLinks` reads. A record missing one of them would
 * compare its `undefined` against another missing record's `undefined` and
 * count a false link, so `playerChemistry` validates every record it scores
 * before any link is counted. `countLinks` itself stays unchanged: the guard
 * sits at the scoring layer's entry.
 */
const PLAYER_IDENTITY_FIELDS = Object.freeze(['id', 'nationId', 'leagueId', 'clubId']);

const requireIdentityFields = (record, label) => {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`playerChemistry: ${label} must be a stable record object`);
  }
  for (const field of PLAYER_IDENTITY_FIELDS) {
    if (!Number.isFinite(record[field])) {
      throw new Error(
        `playerChemistry: ${label} must carry a finite ${field}; a record without a finite` +
          ' identity field would compare undefined as a shared value and count a false link'
      );
    }
  }
};

/**
 * Validates a resolved profile at the scoring layer's entry and returns its
 * `fullChemistryAtPreferredPosition` flag. Both `playerChemistry` and
 * `squadChemistry` run this before any scoring, so an unscorable profile
 * throws even when `starters` is empty and no per-player call would have run.
 */
const requireScorableProfile = (profile) => {
  if (profile === null || typeof profile !== 'object' || !Array.isArray(profile.rules)) {
    throw new Error(
      'playerChemistry: profile must be a resolved profile with a rules array; resolveProfile' +
        ' returns null when a rarity has no mapping, and the caller must not guess one'
    );
  }
  const fullPosition = profile.fullChemistryAtPreferredPosition;
  if (fullPosition !== null && typeof fullPosition !== 'boolean') {
    throw new Error(
      'playerChemistry: profile must carry fullChemistryAtPreferredPosition as a boolean, or' +
        ' null when the payload did not state it; normalise the adapter chemistry rule set with' +
        ' normaliseChemistryProfile first'
    );
  }
  if (fullPosition === true) {
    throw new Error(
      'playerChemistry: cannot score a profile with fullChemistryAtPreferredPosition true: the' +
        ' stable records carry no formation slot, so an out-of-position starter cannot be' +
        ' identified and the score would silently overstate chemistry. Add slot context before' +
        ' scoring this profile.'
    );
  }
  return fullPosition;
};

/**
 * One starter's chemistry against the rest of the starting XI: each profile
 * rule contributes its points, the points are summed, and the total is capped
 * at 3. The per-rule division is the hypothesis documented in the scoring
 * block, and the verification marker is squad-level: this function returns a
 * bare number.
 *
 * `starters` is the eleven on-pitch records; the bench is not part of this
 * layer (see the scoring block). The player itself is excluded by id, so
 * `starters` may include `player` or not. Every record is validated on
 * `id`, `nationId`, `leagueId` and `clubId` before links are counted: a
 * missing identity field would compare as `undefined` and count a false link.
 * `clubIndex` is required and must be built with `buildClubIndex`; `countLinks`
 * throws without it.
 *
 * @param {{ id: number, nationId: number, leagueId: number, clubId: number }} player
 *   the stable record to score
 * @param {Array<object>} starters the starting XI, including `player` at most once
 * @param {object} profile a resolved profile from `resolveProfile`
 * @param {{ groupOf: Function, sameClub: Function }} clubIndex output of
 *   `buildClubIndex`
 * @returns {number} an integer in 0–3
 * @throws {Error} when a record lacks a finite identity field, when `profile`
 *   is not a resolved profile, the profile cannot be scored without a
 *   formation slot (`fullChemistryAtPreferredPosition` is true), a rule has an
 *   unsupported `dimension` or `calculation` or a non-positive `value`, or
 *   `clubIndex` is missing
 */
export function playerChemistry(player, starters, profile, clubIndex) {
  requireIdentityFields(player, 'player');
  requireScorableProfile(profile);

  const others = [];
  for (const [index, entry] of starters.entries()) {
    requireIdentityFields(entry, `starters[${index}]`);
    if (entry.id === player.id) continue;
    others.push(entry);
  }
  const links = countLinks(player, others, clubIndex);

  let points = 0;
  for (const rule of profile.rules) points += rulePoints(rule, links);

  return Math.min(PLAYER_CHEMISTRY_MAX, points);
}

/**
 * The squad chemistry total with its verification status: `playerChemistry`
 * summed over the starting XI and wrapped as `{ chemistry, verified, reason }`.
 * While `CHEMISTRY_FORMULA_VERIFIED` is false the reason is
 * `chemistry-formula-unverified`; when the profile's position flag is `null`
 * (the payload did not state it) the reason is `chemistry-position-flag-missing`
 * instead, so the result never pretends the flag was false. The scoring block
 * documents both. The bench contributes nothing because it is not passed in.
 *
 * Callers must pass this object through, not only its `chemistry` number:
 * `validateSquad` reads the marker to report a CHEMISTRY_POINTS requirement as
 * unverified instead of approving it from a computed number.
 *
 * The profile is validated before the loop runs, so an empty `starters` array
 * still throws for a profile that cannot be scored instead of returning a
 * result built from no players.
 *
 * @param {Array<object>} starters the eleven on-pitch stable records
 * @param {object} profile a resolved profile from `resolveProfile`
 * @param {{ groupOf: Function, sameClub: Function }} clubIndex output of
 *   `buildClubIndex`
 * @returns {{ chemistry: number, verified: boolean, reason: string|null }} the
 *   integer total in 0–33 plus its status
 * @throws {Error} under the same conditions as `playerChemistry`
 */
export function squadChemistry(starters, profile, clubIndex) {
  const fullPosition = requireScorableProfile(profile);

  let chemistry = 0;
  for (const player of starters) {
    chemistry += playerChemistry(player, starters, profile, clubIndex);
  }
  if (fullPosition === null) {
    return {
      chemistry,
      verified: false,
      reason: CHEMISTRY_POSITION_FLAG_MISSING_REASON,
    };
  }
  return {
    chemistry,
    verified: CHEMISTRY_FORMULA_VERIFIED,
    reason: CHEMISTRY_FORMULA_VERIFIED ? null : CHEMISTRY_UNVERIFIED_REASON,
  };
}
