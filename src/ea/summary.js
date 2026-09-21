/**
 * Builds the console reports the owner reads: the one-line read summary the M1
 * manual test looks for, the one-line solve summary, and the staged
 * diagnostic report (#40) that names every pipeline stage with its outcome,
 * the live eligibility model cross-check, the write plan and the write attempt
 * chain.
 *
 * This is diagnostic console output, not panel UI, so it stays in plain English
 * rather than the design copy bundle. The injected button label is the only
 * user-visible string in M1 and it comes from `design/copy.*.json`.
 *
 * The summary never invents a number: a failed club read reports zero items and
 * names every candidate tried, each with its reason.
 *
 * This module is pure: plain data in, plain string or plain data out. No DOM,
 * no chrome APIs, no network.
 */

import { BUILD_ID, buildMarker } from './build.js';

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
 * The challenge half of the read summary. When no challenge was read, the
 * failure reason the bridge and subject attempts already recorded is named in
 * the same line (#70): "challenge not detected" alone left a live report unable
 * to say why, while the club half carried its whole attempt list. The reason is
 * ignored when a challenge was read, so a successful line is unchanged.
 */
const describeChallenge = (challenge, failure) => {
  if (challenge !== null && challenge !== undefined) {
    return `challenge "${challenge.name}" (id ${challenge.challengeId}, ${challenge.formation}),` +
      ` ${countConstraints(challenge)} constraints`;
  }
  return typeof failure === 'string' && failure.length > 0
    ? `challenge not detected (${failure})`
    : 'challenge not detected';
};

/**
 * @param {{ challenge: object|null, clubResult: object|null,
 *   challengeFailure?: string|null }} read
 *   `challenge` is the contract shape from `readChallenge` (or `null`),
 *   `clubResult` the record from `resolveClubItems`, and `challengeFailure` the
 *   already-recorded reason the challenge could not be read; it is appended to
 *   the summary only when no challenge was read
 * @returns {string} a single diagnostic line
 */
export function buildReadSummary({ challenge, clubResult, challengeFailure = null }) {
  return `FUT Squad Lab [${BUILD_ID}]: ${describeChallenge(
    challenge,
    challengeFailure
  )} | ${describeClub(clubResult)}`;
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

/** The schema id of the staged diagnostic report. */
export const DIAGNOSTIC_SCHEMA = 'fsl-diagnostics/1';

/**
 * The pipeline stages in execution order. Issue #40 lists seven; `squad` is
 * the challenge-squad read made an explicit stage of its own, because it is a
 * separate read the payload stage depends on and a failure there must name
 * itself rather than masquerade as a payload failure.
 */
export const DIAGNOSTIC_STAGES = Object.freeze([
  'bridge',
  'challenge',
  'club',
  'squad',
  'eligibility',
  'solve',
  'payload',
  'write',
]);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Fills every stage the pipeline never reached with an explicit not-reached
 * outcome, so the rendered report always shows the full chain and the first
 * stage that did not finish. Recorded stages keep their identity; unknown and
 * duplicated stage ids throw, because a typo would otherwise hide a stage.
 *
 * @param {Array<{id: string, ok: boolean|null, reason: string|null, detail: *}>} recorded
 * @returns {Array<object>} one entry per `DIAGNOSTIC_STAGES`, in that order
 * @throws {Error} when a recorded stage has no string id, an unknown id, or is
 *   recorded twice
 */
export function completeStages(recorded) {
  if (!Array.isArray(recorded)) {
    throw new Error('completeStages: recorded stages must be an array');
  }
  const byId = new Map();
  for (const entry of recorded) {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      throw new Error('completeStages: every recorded stage must carry a string id');
    }
    if (!DIAGNOSTIC_STAGES.includes(entry.id)) {
      throw new Error(`completeStages: unknown stage id ${JSON.stringify(entry.id)}`);
    }
    if (byId.has(entry.id)) {
      throw new Error(`completeStages: stage ${entry.id} was recorded twice`);
    }
    byId.set(entry.id, entry);
  }
  const stopped = recorded.find((entry) => entry.ok !== true) ?? null;
  const reason =
    stopped === null
      ? 'not reached: the pipeline stopped before this stage'
      : `not reached: the ${stopped.id} stage did not finish`;
  return DIAGNOSTIC_STAGES.map(
    (id) => byId.get(id) ?? { id, ok: null, reason, detail: null }
  );
}

/**
 * Builds the one structured diagnostic report for a Solve from the stages the
 * pipeline recorded. `ok` is true only when every stage finished; `stoppedAt`
 * names the first stage that did not, so a reader can say where the chain
 * stopped without a debugger. `build` states which build produced the report
 * and the reader-chain ids it compiled, so a stale module beside fresh code is
 * visible in the pasted block itself (#50). A stage outcome that was never
 * recorded is a defect and throws naming the stage.
 *
 * @param {Array<object>} stages the stages recorded by `createSolveService`
 * @param {{ id: string, readers: object }} [build] the build marker; defaults
 *   to this build's `buildMarker()`, injectable so a test can prove the report
 *   reports the marker it was handed
 * @param {{ calls: number, waits: number, retries: number, waitedMs: number }} [pacing]
 *   the run's pacing counters (#52), so a slow run is explainable; `null` when
 *   the reporter has none
 * @param {{ calls: Array<object>, dropped: number, truncated: boolean,
 *   methods: Array<object> }} [observer] the #64 observer report: how EA's own
 *   methods were called while this session ran, by name and type only; `null`
 *   when no observer was installed
 * @returns {{ schema: string, build: object, pacing: object|null,
 *   observer: object|null, ok: boolean, stoppedAt: string|null,
 *   stages: Array<object> }}
 * @throws {Error} when a stage outcome is missing, unknown or duplicated
 */
export function buildDiagnosticsReport(
  stages,
  build = buildMarker(),
  pacing = null,
  observer = null
) {
  if (!Array.isArray(stages)) {
    throw new Error('buildDiagnosticsReport: stages must be an array');
  }
  const recordedIds = new Set(stages.map((stage) => stage?.id));
  // A successful run must record every stage. A stopped run records a prefix
  // up to and including the failure; a stage missing from that prefix is a
  // defect and throws, while the unrecorded stages after the failure are
  // legitimately not reached and are filled by `completeStages`.
  const failed = stages.find((stage) => stage?.ok !== true) ?? null;
  const required = failed === null ? DIAGNOSTIC_STAGES : DIAGNOSTIC_STAGES.slice(0, DIAGNOSTIC_STAGES.indexOf(failed.id) + 1);
  for (const id of required) {
    if (!recordedIds.has(id)) {
      throw new Error(
        `buildDiagnosticsReport: stage ${id} has no recorded outcome; every stage up to the stop` +
          ' must record'
      );
    }
  }
  const completed = completeStages(stages);
  const stopped = completed.find((stage) => stage.ok !== true) ?? null;
  return {
    schema: DIAGNOSTIC_SCHEMA,
    build,
    pacing: pacing ?? null,
    observer: observer ?? null,
    ok: stopped === null,
    stoppedAt: stopped === null ? null : stopped.id,
    stages: completed,
  };
}

/**
 * Renders the report as one delimited, copy-pasteable block: a header, the
 * pretty-printed JSON and the documented one-liner that re-dumps the same
 * object later. Summary-level data only — the report is built from counts,
 * ids, stage outcomes and reason strings, never club item contents, player
 * names or session data.
 *
 * @param {{ schema: string, stages: Array<object> }} report the
 *   `buildDiagnosticsReport` output
 * @returns {string} one block, never sent anywhere by itself
 * @throws {Error} when `report` is not a diagnostics report
 */
export function formatDiagnosticsBlock(report) {
  if (!isRecord(report) || report.schema !== DIAGNOSTIC_SCHEMA || !Array.isArray(report.stages)) {
    throw new Error('formatDiagnosticsBlock: report must be the buildDiagnosticsReport output');
  }
  return [
    `=== FUT Squad Lab diagnostics (${report.schema}, ${report.build?.id ?? 'unknown build'}) — copy from here ===`,
    JSON.stringify(report, null, 2),
    '=== end FUT Squad Lab diagnostics ===',
    'Dump again with: copy(JSON.stringify(window.__FSL_DIAGNOSE__(), null, 2))',
  ].join('\n');
}

/**
 * Shapes `planSquadWrite`'s report for the payload stage without carrying any
 * club item id into the pasted summary: how many slots were filled, how many
 * existing entries were preserved, and every unplaced player as a formation
 * slot index, whether it was a concept card, and its reason. A missing reason
 * is surfaced as a reason, never dropped.
 *
 * @param {object} plan the `planSquadWrite` result
 * @returns {{ placed: {count: number, slots: Array<number>},
 *   preserved: {count: number, slots: Array<number>},
 *   unplaced: Array<{index: number|null, concept: boolean, reason: string}> }}
 * @throws {Error} when `plan` is not the plan result object
 */
export function summarizeWritePlan(plan) {
  if (!isRecord(plan)) {
    throw new Error('summarizeWritePlan: plan must be the planSquadWrite result');
  }
  const slotList = (value) => (Array.isArray(value) ? [...value] : []);
  const placed = slotList(plan.placed);
  const preserved = slotList(plan.preserved);
  return {
    placed: { count: placed.length, slots: placed },
    preserved: { count: preserved.length, slots: preserved },
    unplaced: (Array.isArray(plan.unplaced) ? plan.unplaced : []).map((entry) => ({
      index: Number.isInteger(entry?.index) ? entry.index : null,
      concept: entry?.concept === true,
      reason:
        typeof entry?.reason === 'string' && entry.reason.length > 0
          ? entry.reason
          : 'no reason recorded',
    })),
  };
}
