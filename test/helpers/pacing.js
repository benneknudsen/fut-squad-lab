/**
 * A zero-wait pacer for tests.
 *
 * It still serialises every call and counts calls, waits and retries, but every
 * delay is zero, so an existing behavioural test never waits on a real clock.
 * Only the pacing tests use the production timings; production code injects
 * either its own service-owned pacer or the module default.
 */

import { createPacer } from '../../src/ea/pacing.js';

export const createTestPacer = () =>
  createPacer({
    minGapMs: 0,
    submitGapMs: 0,
    jitterRatio: 0,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
  });