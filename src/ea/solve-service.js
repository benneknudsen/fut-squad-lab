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
 * Every stage is injectable through `steps`, so the glue is unit-testable with
 * fakes for the readers, the solver and the writer; production defaults to the
 * real modules. The eligibility key table is resolved once and cached for the
 * session, including its failure: an unreadable live `SBCEligibilityKey` enum
 * fails naming that global and is never replaced by a static table (#16).
 *
 * `solve` never throws for an expected environment failure. It returns
 * `{ ok: false, stage, error, read }` so the bridge can always print the read
 * summary and a loud, specific reason. A solution the validator rejected is a
 * normal `{ ok: true, valid: false }` outcome and is not written: writing a
 * squad that violates the challenge would be worse than reporting it.
 */

import {
  CLUB_ITEM_ID_FIELD,
  EA_GLOBALS,
  SCOPE_VALUES,
  readEligibilityKeys,
  resolveChallengeSquad,
  resolveChallengeSubject,
  resolveClubItems,
} from './adapter.js';
import { readChallenge } from './challenge-reader.js';
import { readClubItems } from './club-reader.js';
import { runSolve } from './solve-runner.js';
import { applySolution, writeSolution } from './squad-writer.js';
import { buildReadSummary } from './summary.js';

const fail = (message) => {
  throw new Error(`solve-service: ${message}`);
};

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const toError = (value) => (value instanceof Error ? value : new Error(String(value)));

const describeAttempts = (attempts) =>
  attempts.length === 0
    ? 'no candidate was tried'
    : attempts.map((attempt) => `${attempt.id}: ${attempt.reason}`).join('; ');

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
  const runSolveFn = steps.runSolve ?? runSolve;
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
      eligibility = { keys };
    } catch (error) {
      eligibility = { error: toError(error) };
    }
    return eligibility;
  };

  return {
    async solve(subject) {
      const subjectResult = resolveSubject(subject);
      let challenge = null;
      let challengeError = null;
      if (subjectResult.ok) {
        try {
          challenge = readChallengeFn(subjectResult.payload);
        } catch (error) {
          challengeError = toError(error);
        }
      }

      const clubResult = await resolveClub(pageWindow);
      const clubRecords = clubResult.ok ? readClubItemsFn(clubResult.items) : [];
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
        return {
          ok: false,
          stage: 'challenge',
          read,
          error:
            challengeError ??
            new Error('the panel argument carried no challenge payload; the panel shape may have changed'),
        };
      }
      if (!clubResult.ok) {
        return {
          ok: false,
          stage: 'club',
          read,
          error: new Error(`the club read failed; tried ${describeAttempts(clubResult.attempts)}`),
        };
      }

      const squadResult = resolveSquad(subject);
      if (!squadResult.ok) {
        return {
          ok: false,
          stage: 'squad',
          read,
          error: new Error(
            `the challenge squad payload is unreadable; tried ${describeAttempts(squadResult.attempts)}`
          ),
        };
      }

      const table = resolveEligibilityOnce();
      if (table.error !== undefined) {
        return { ok: false, stage: 'eligibility', read, error: table.error };
      }

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
        return { ok: false, stage: 'solve', read, error: toError(error) };
      }

      const base = { ok: true, read, challenge, ...solved };
      if (solved.valid !== true) {
        return {
          ...base,
          write: null,
          writeSkipped: 'the solution is not valid; refusing to write it',
        };
      }

      try {
        const clubIndex = new Map(
          clubResult.items.map((item) => [item?.[CLUB_ITEM_ID_FIELD], item])
        );
        const payload = applySolutionFn(squadResult.payload, solved, clubIndex);
        const write = await writeSolutionFn(pageWindow, payload);
        return { ...base, write };
      } catch (error) {
        return { ok: false, stage: 'write', read, error: toError(error) };
      }
    },
  };
}
