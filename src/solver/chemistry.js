/**
 * The chemistry link layer: which clubs count as the same club, and how many
 * club, league and nationId links each player has.
 *
 * ## Stable record
 *
 * `countLinks` reads the stable club record produced by `normaliseClubItem`:
 * it uses `id`, `nationId`, `leagueId` and `clubId` and nothing else. The raw
 * payload names are translated in `src/ea/adapter.js`; this module never sees
 * them.
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
