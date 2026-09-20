/**
 * The compiled-in build marker for the browser diagnostics (#50).
 *
 * The diagnostic is pasted out of a live session, so a report that does not
 * state which build produced it cannot be trusted: the third #48 session ran a
 * `service-shape.js` older than the merged code beside an `adapter.js` chain
 * newer than it, and the mismatch was undiagnosable from the pasted log. The
 * extension version in `manifest.json` is never bumped, so it is useless as a
 * freshness signal; this marker is.
 *
 * `BUILD_ID` is bumped whenever the diagnostic or any reader chain changes.
 * `buildMarker()` also reports the reader-chain ids actually compiled into the
 * adapter, read from those frozen tables at call time, so a stale adapter shows
 * up immediately even when the build id matches.
 *
 * This module is pure: plain data in, plain data out. No DOM, no chrome APIs,
 * no network.
 */

import {
  CHALLENGE_LOAD_STRATEGIES,
  CHALLENGE_SQUAD_STRATEGIES,
  CHALLENGE_SUBJECT_STRATEGIES,
  CLUB_ITEM_STRATEGIES,
} from './adapter.js';

/**
 * The marker for this build. Incremented by #51: the read layer moved to EA's
 * observable calling convention, the club read became a paged search and the
 * challenge read gained the load and active-squad chains, so a report from an
 * older build compiled different chains. Incremented by #52: every EA call now
 * goes through the pacing queue, so a report must state the pacing build and
 * carry the run's wait and retry counts.
 */
export const BUILD_ID = 'fsl-build/4';

/**
 * Builds the marker carried by every diagnostic: the build id plus the exact
 * reader-chain ids compiled into `src/ea/adapter.js` for the challenge, club,
 * challenge-squad and challenge-load reads.
 *
 * @returns {{ id: string, readers: { challenge: Array<string>, club:
 *   Array<string>, squad: Array<string>, challengeLoad: Array<string> } }}
 */
export function buildMarker() {
  return {
    id: BUILD_ID,
    readers: {
      challenge: CHALLENGE_SUBJECT_STRATEGIES.map((strategy) => strategy.id),
      club: CLUB_ITEM_STRATEGIES.map((strategy) => strategy.id),
      squad: CHALLENGE_SQUAD_STRATEGIES.map((strategy) => strategy.id),
      challengeLoad: CHALLENGE_LOAD_STRATEGIES.map((strategy) => strategy.id),
    },
  };
}
