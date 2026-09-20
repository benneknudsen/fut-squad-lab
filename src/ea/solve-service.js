/**
 * The end-to-end solve glue for one challenge: it reads the live page state,
 * resolves the session eligibility tables, runs the pure pipeline in
 * `src/ea/solve-runner.js`, applies the solution to the challenge squad and
 * writes it through EA's own objects.
 *
 * The stages run in the documented order:
 *
 *   challenge -> club -> challenge squad -> eligibility (once per session)
 *   -> runSolve -> applySolution -> writeSolution
 *
 * Every stage records an outcome as data on the returned `stages` list, as
 * `{ id, ok, reason, detail }`, so the page bridge can render one staged
 * diagnostic report (#40) without any stage work of its own. A failed club read
 * additionally carries the live service and request surface shape report (#44)
 * in its detail, because the failed strategy list cannot say what the page
 * exposes instead. A failure at one stage leaves the later stages unrecorded;
 * `completeStages` in `src/ea/summary.js` fills those with an explicit
 * not-reached outcome.
 *
 * Every stage is injectable through `steps`, so the glue is unit-testable with
 * fakes for the readers, the solver and the writer; production defaults to the
 * real modules. The eligibility key table is resolved once and cached for the
 * session, including its failure: an unreadable live `SBCEligibilityKey` enum
 * fails naming that global and is never replaced by a static table (#16).
 *
 * `solve` never throws for an expected environment failure. It returns
 * `{ ok: false, stage, error, read, stages }` so the bridge can always print the
 * read summary and a loud, specific reason. A solution the validator rejected is
 * a normal `{ ok: true, valid: false }` outcome and is not written: writing a
 * squad that violates the challenge would be worse than reporting it.
 *
 * Observability only: the write goes through the same `applySolution` payload
 * and the same `writeSolution` chain as before. `planSquadWrite` is called
 * additionally for its `placed`/`preserved`/`unplaced` report, which the
 * payload stage surfaces; it is pure and performs the same validation.
 */

import {
  CLUB_ITEM_ID_FIELD,
  EA_GLOBALS,
  SCOPE_VALUES,
  crossCheckEligibilityModel,
  readEligibilityKeys,
  resolveChallengeSquad,
  resolveChallengeSubject,
  resolveClubItems,
} from './adapter.js';
import { readChallenge } from './challenge-reader.js';
import { readClubItems } from './club-reader.js';
import { describeServiceShape } from './service-shape.js';
import { runSolve } from './solve-runner.js';
import { applySolution, planSquadWrite, writeSolution } from './squad-writer.js';
import { buildReadSummary, countConstraints, summarizeWritePlan } from './summary.js';

const fail = (message) => {
  throw new Error(`solve-service: ${message}`);
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const toError = (value) => (value instanceof Error ? value : new Error(String(value)));

const describeAttempts = (attempts) =>
  attempts.length === 0
    ? 'no candidate was tried'
    : attempts.map((attempt) => `${attempt.id}: ${attempt.reason}`).join('; ');

const summarizeCostCoverage = (coverage) => ({
  known: Number.isFinite(coverage?.known) ? coverage.known : 0,
  unknown: Number.isFinite(coverage?.unknown) ? coverage.unknown : 0,
  complete: coverage?.complete === true,
});

/**
 * @param {{ pageWindow: object, requestSolve: Function, steps?: object }} options
 *   `pageWindow` is the page's `window`; `requestSolve` backs the worker
 *   transport; `steps` overrides any pipeline stage for tests
 * @returns {{ solve: (subject: *) => Promise<object> }}
 * @throws {Error} when `pageWindow` or `requestSolve` is missing
 */
export function createSolveService({ pageWindow, requestSolve, steps = {} } = {}) {
  if (!isRecord(pageWindow)) {
    fail('pageWindow must be the page window object');
  }
  if (typeof requestSolve !== 'function') {
    fail('requestSolve must be the worker-backed transport function');
  }

  const resolveSubject = steps.resolveChallengeSubject ?? resolveChallengeSubject;
  const readChallengeFn = steps.readChallenge ?? readChallenge;
  const resolveClub = steps.resolveClubItems ?? resolveClubItems;
  const readClubItemsFn = steps.readClubItems ?? readClubItems;
  const resolveSquad = steps.resolveChallengeSquad ?? resolveChallengeSquad;
  const readKeys = steps.readEligibilityKeys ?? (() => readEligibilityKeys(pageWindow));
  const describeShape = steps.describeServiceShape ?? describeServiceShape;
  const runSolveFn = steps.runSolve ?? runSolve;
  const planSquadWriteFn = steps.planSquadWrite ?? planSquadWrite;
  const applySolutionFn = steps.applySolution ?? applySolution;
  const writeSolutionFn = steps.writeSolution ?? writeSolution;
  const externalPrices = steps.externalPrices ?? null;
  const scopes = steps.scopes ?? SCOPE_VALUES;

  let eligibility = null;

  /**
   * The key table is read at most once per session. A failed read is cached
   * too, so a later solve reports the same reason instead of silently retrying
   * into a fallback. The table is validated here, before any solve work is
   * dispatched: an empty table is a failed read, not a solvable challenge.
   * The full resolved object is kept beside the keys so the diagnostic stage
   * can report the live members and the model cross-check (#40).
   */
  const resolveEligibilityOnce = () => {
    if (eligibility !== null) return eligibility;
    try {
      const resolved = readKeys();
      const keys = isRecord(resolved) ? resolved.keys : null;
      if (!isRecord(keys) || Object.keys(keys).length === 0) {
        fail(
          `the live ${EA_GLOBALS.eligibilityKeys} enum produced no usable key table; refusing to` +
            ' fall back to a static table'
        );
      }
      eligibility = { keys, resolved };
    } catch (error) {
      eligibility = { error: toError(error) };
    }
    return eligibility;
  };

  /**
   * Runs the live shape report as instrumentation. Instrumentation must never
   * be able to lose the run it exists to explain (#44, re-flagged in #49, done
   * in #50), so a throwing shape function becomes a recorded reason on the club
   * stage instead of a rejected solve.
   */
  const describeShapeSafely = () => {
    try {
      return { report: describeShape(pageWindow), reason: null };
    } catch (error) {
      return {
        report: null,
        reason: `the service shape report failed: ${toError(error).message}`,
      };
    }
  };

  return {
    async solve(subject) {
      const stages = [];
      const record = (id, ok, reason = null, detail = null) => {
        stages.push({ id, ok, reason, detail });
      };
      const finish = (outcome) => ({ ...outcome, stages: [...stages] });

      const subjectResult = resolveSubject(subject, pageWindow);
      record(
        'bridge',
        subjectResult.ok === true,
        subjectResult.ok === true
          ? null
          : 'the panel argument carried no challenge payload; the panel shape may have changed',
        { strategy: subjectResult.strategy, attempts: subjectResult.attempts }
      );

      let challenge = null;
      let challengeError = null;
      if (subjectResult.ok) {
        try {
          challenge = readChallengeFn(subjectResult.payload);
        } catch (error) {
          challengeError = toError(error);
        }
        record(
          'challenge',
          challengeError === null,
          challengeError === null ? null : challengeError.message,
          challenge === null
            ? null
            : {
                challengeId: challenge.challengeId,
                name: challenge.name,
                formation: challenge.formation,
                constraints: countConstraints(challenge),
              }
        );
      }

      const clubResult = await resolveClub(pageWindow);
      const clubRecords = clubResult.ok ? readClubItemsFn(clubResult.items) : [];
      const shapeResult = clubResult.ok === true ? { report: null, reason: null } : describeShapeSafely();
      record(
        'club',
        clubResult.ok === true,
        clubResult.ok === true
          ? null
          : `the club read failed; tried ${describeAttempts(clubResult.attempts)}`,
        {
          items: clubRecords.length,
          strategy: clubResult.strategy ?? null,
          attempts: clubResult.attempts,
          // The shape report runs on failure only: a read that answered
          // carries none (#44). A shape failure is a recorded reason, never a
          // lost solve (#50).
          shape: shapeResult.report,
          shapeError: shapeResult.reason,
        }
      );

      const read = {
        summary: buildReadSummary({
          challenge,
          clubResult: clubResult.ok ? { ...clubResult, items: clubRecords } : clubResult,
        }),
        challengeStrategy: subjectResult.strategy,
        challengeAttempts: subjectResult.attempts,
        clubStrategy: clubResult.strategy,
        clubAttempts: clubResult.attempts,
      };

      if (subjectResult.ok !== true || challengeError !== null) {
        return finish({
          ok: false,
          stage: 'challenge',
          read,
          error:
            challengeError ??
            new Error('the panel argument carried no challenge payload; the panel shape may have changed'),
        });
      }
      if (!clubResult.ok) {
        return finish({
          ok: false,
          stage: 'club',
          read,
          error: new Error(`the club read failed; tried ${describeAttempts(clubResult.attempts)}`),
        });
      }

      const squadResult = resolveSquad(subject, pageWindow);
      record(
        'squad',
        squadResult.ok === true,
        squadResult.ok === true
          ? null
          : `the challenge squad payload is unreadable; tried ${describeAttempts(squadResult.attempts)}`,
        { strategy: squadResult.strategy ?? null, attempts: squadResult.attempts }
      );
      if (!squadResult.ok) {
        return finish({
          ok: false,
          stage: 'squad',
          read,
          error: new Error(
            `the challenge squad payload is unreadable; tried ${describeAttempts(squadResult.attempts)}`
          ),
        });
      }

      const table = resolveEligibilityOnce();
      if (table.error !== undefined) {
        record('eligibility', false, table.error.message, null);
        return finish({ ok: false, stage: 'eligibility', read, error: table.error });
      }
      record('eligibility', true, null, {
        resolved: Object.keys(table.keys).length,
        members: table.resolved?.members ?? [],
        unmodelled: table.resolved?.unmodelled ?? [],
        scopes: 'caller-supplied; no live scope enum',
        crossCheck: crossCheckEligibilityModel(table.resolved, challenge.elgReq),
      });

      let solved;
      try {
        solved = await runSolveFn({
          challenge,
          clubItems: clubResult.items,
          externalPrices,
          keys: table.keys,
          scopes,
          requestSolve,
        });
      } catch (error) {
        record('solve', false, toError(error).message, null);
        return finish({ ok: false, stage: 'solve', read, error: toError(error) });
      }
      record('solve', true, null, {
        cost: solved.cost ?? null,
        costComplete: solved.costComplete === true,
        costCoverage: summarizeCostCoverage(solved.costCoverage),
        valid: solved.valid === true,
        unverified: Array.isArray(solved.unverified) ? solved.unverified.length : 0,
        failures: Array.isArray(solved.failures) ? solved.failures.length : 0,
      });

      const base = { ok: true, read, challenge, ...solved };
      if (solved.valid !== true) {
        const reason = 'the solution is not valid; refusing to write it';
        record('payload', false, reason, null);
        return finish({ ...base, write: null, writeSkipped: reason });
      }

      const clubIndex = new Map(
        clubResult.items.map((item) => [item?.[CLUB_ITEM_ID_FIELD], item])
      );
      let plan;
      let payload;
      try {
        plan = planSquadWriteFn(squadResult.payload, solved, clubIndex);
        payload = applySolutionFn(squadResult.payload, solved, clubIndex);
      } catch (error) {
        const wrapped = toError(error);
        record('payload', false, wrapped.message, null);
        record('write', false, 'the payload could not be built', null);
        return finish({ ok: false, stage: 'write', read, error: wrapped });
      }
      record('payload', true, null, summarizeWritePlan(plan));

      try {
        const write = await writeSolutionFn(pageWindow, payload);
        record(
          'write',
          write.ok === true,
          write.ok === true ? null : 'no write candidate answered',
          {
            strategy: write.strategy ?? null,
            slotStrategy: write.slotStrategy ?? null,
            attempts: write.attempts,
          }
        );
        return finish({ ...base, write });
      } catch (error) {
        const wrapped = toError(error);
        record('write', false, wrapped.message, null);
        return finish({ ok: false, stage: 'write', read, error: wrapped });
      }
    },
  };
}
