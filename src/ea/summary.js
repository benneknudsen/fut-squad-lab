/**
 * Builds the one-line read report the M1 manual test looks for: the challenge
 * name, the constraint count, the club size and — the whole point of this
 * milestone — which club-read strategy answered.
 *
 * This is diagnostic console output, not panel UI, so it stays in plain English
 * rather than the design copy bundle. The injected button label is the only
 * user-visible string in M1 and it comes from `design/copy.*.json`.
 *
 * The summary never invents a number: a failed club read reports zero items and
 * names every candidate tried, each with its reason.
 *
 * This module is pure: plain data in, plain string out. No DOM, no chrome APIs,
 * no network.
 */

/**
 * The number of constraints in a read challenge: one per distinct
 * `eligibilitySlot`, because entries in a slot describe a single requirement
 * (the scope entry modifies its slot's requirement rather than adding one).
 *
 * @param {object} challenge the contract shape emitted by `readChallenge`
 * @returns {number}
 * @throws {Error} when the challenge carries no `elgReq` array
 */
export function countConstraints(challenge) {
  if (
    challenge === null ||
    typeof challenge !== 'object' ||
    !Array.isArray(challenge.elgReq)
  ) {
    throw new Error('countConstraints: challenge must carry an elgReq array');
  }
  const slots = new Set();
  for (const entry of challenge.elgReq) {
    if (entry !== null && typeof entry === 'object' && Number.isInteger(entry.eligibilitySlot)) {
      slots.add(entry.eligibilitySlot);
    }
  }
  return slots.size;
}

const describeClub = (clubResult) => {
  if (clubResult?.ok === true) {
    return `${clubResult.items.length} club items via ${clubResult.strategy}`;
  }
  const attempts = clubResult?.attempts ?? [];
  const tried =
    attempts.length === 0
      ? 'no strategy was attempted'
      : attempts.map((attempt) => `${attempt.id}: ${attempt.reason}`).join('; ');
  return `club read failed (0 items); tried ${tried}`;
};

/**
 * @param {{ challenge: object|null, clubResult: object|null }} read
 *   `challenge` is the contract shape from `readChallenge` (or `null`), and
 *   `clubResult` the record from `resolveClubItems`
 * @returns {string} a single diagnostic line
 */
export function buildReadSummary({ challenge, clubResult }) {
  const challengePart =
    challenge === null || challenge === undefined
      ? 'challenge not detected'
      : `challenge "${challenge.name}" (id ${challenge.challengeId}, ${challenge.formation}),` +
        ` ${countConstraints(challenge)} constraints`;
  return `FUT Squad Lab: ${challengePart} | ${describeClub(clubResult)}`;
}
