/**
 * The shared test access point for the pinned eligibility observation set.
 *
 * The solver's production path has no table of its own (issue #16): `solve`,
 * `improve` and `reevaluate` require `options.keys` and `options.scopes`, so
 * every existing call site that used to rely on the removed fallback now has to
 * supply them. `withEligibility` is that shared supply, kept in one place
 * instead of repeating the two fields across every test file.
 */

import {
  PINNED_ELIGIBILITY_KEYS,
  SCOPE_VALUES,
} from '../fixtures/eligibility-observation.js';

export { PINNED_ELIGIBILITY_KEYS, SCOPE_VALUES };

/**
 * Adds the pinned observation tables to a solver options object.
 *
 * @param {object} [overrides] fields that win over the tables, so a test can
 *   still omit one deliberately
 * @returns {{ keys: object, scopes: object }}
 */
export const withEligibility = (overrides = {}) => ({
  keys: PINNED_ELIGIBILITY_KEYS,
  scopes: SCOPE_VALUES,
  ...overrides,
});
