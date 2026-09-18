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

const describeAttempts = (attempts, empty) =>
  attempts.length === 0
    ? empty
    : attempts.map((attempt) => `${attempt.id}: ${attempt.reason}`).join('; ');

const describeClub = (clubResult) => {
  if (clubResult?.ok === true) {
    return `${clubResult.items.length} club items via ${clubResult.strategy}`;
  }
  const attempts = clubResult?.attempts ?? [];
  return `club read failed (0 items); tried ${describeAttempts(attempts, 'no strategy was attempted')}`;
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

const describeCost = (result) => {
  const cost = result?.cost;
  const coverage = result?.costCoverage;
  if (result?.costComplete === true && Number.isFinite(cost)) {
    return `cost ${cost} (complete)`;
  }
  const known = Number.isFinite(coverage?.known) ? coverage.known : 0;
  const unknown = Number.isFinite(coverage?.unknown) ? coverage.unknown : 0;
  return `cost ${known} known, ${unknown} unpriced (incomplete)`;
};

const describeWrite = (result, write) => {
  if (write === null || write === undefined) {
    return `write: skipped (${result?.writeSkipped ?? 'nothing to write'})`;
  }
  if (write.ok === true) return `write: ${write.strategy}`;
  const attempts = Array.isArray(write.attempts) ? write.attempts : [];
  return `write failed; tried ${describeAttempts(attempts, 'no candidate was attempted')}`;
};

/**
 * Extends the read summary into the one solve report line the console shows:
 * the cost with its coverage, whether the squad validated, how many checks the
 * validator could not verify, and which write candidate answered (or every
 * candidate that did not, each with its reason). A partial cost is never
 * printed as though it were the complete total (#10).
 *
 * @param {{ readSummary: string, result: object, write: object|null }} report
 *   `result` is `runSolve`'s result (plus `writeSkipped` when nothing was
 *   written); `write` is `writeSolution`'s report, or `null`
 * @returns {string} a single diagnostic line
 * @throws {Error} when the result is not an object
 */
export function buildSolveSummary({ readSummary, result, write }) {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('buildSolveSummary: result must be the solver result object');
  }
  const unverified = Array.isArray(result.unverified) ? result.unverified.length : 0;
  const valid = result.valid === true ? 'valid: yes' : 'valid: no';
  return `${readSummary} | ${describeCost(result)} | ${valid} | unverified: ${unverified} | ${describeWrite(result, write)}`;
}
