/**
 * The browser-half solve glue: it runs the existing pure pipeline in the
 * documented order and hands the solve itself to the worker.
 *
 *   normaliseClub -> mergePrices -> buildPool -> solve (worker)
 *
 * `readClubItems` performs the `normaliseClub` step (see
 * `src/ea/club-reader.js`); the price merge, the pool trim and the solve are the
 * modules already covered by their own tests. The only fresh responsibility here
 * is ordering them, passing the caller-resolved eligibility tables through, and
 * attaching `costCoverage` to the result so a partial cost can never be
 * reported as though it were the complete one (#10).
 *
 * The worker is injected as `requestSolve(operation, payload)`, which production
 * backs with the content-script relay around `src/solver/worker.js`. That keeps
 * this module pure and unit-testable with fakes, and guarantees `solve` is never
 * called synchronously on the page.
 *
 * Eligibility tables are required, with no fallback: `options.keys` comes from
 * `readEligibilityKeys` against the live page and `options.scopes` from the
 * adapter's pinned `SCOPE_VALUES`. A missing table fails here, before any work
 * is dispatched to the worker, naming the option (issue #16).
 */

import { buildPool } from '../solver/candidates.js';
import { costCoverage, mergePrices } from '../solver/prices.js';
import { OPERATIONS } from '../solver/worker-protocol.js';
import { readClubItems } from './club-reader.js';

const fail = (message) => {
  throw new Error(`runSolve: ${message}`);
};

const requireEligibilityTable = (name, value) => {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    fail(
      `options.${name} is required; pass the table resolved from the live FC27 page. There is no` +
        ' fallback eligibility table.'
    );
  }
};

/**
 * @param {object} input
 * @param {object} input.challenge the contract challenge shape the solver reads
 * @param {Array<object>} input.clubItems raw `/club` items as read from the page
 * @param {Map|object|null} [input.externalPrices] `assetId` -> price, or null
 * @param {object} input.keys the live eligibility key table
 * @param {object} input.scopes the caller-supplied scope table (the adapter's
 *   pinned model in production)
 * @param {(operation: string, payload: object) => Promise<object>} input.requestSolve
 *   the worker-backed transport; called once with the built pool
 * @param {object} [steps] injectable pipeline steps, for tests
 * @returns {Promise<object>} the solver result plus `costCoverage`
 * @throws {Error} when an eligibility table is missing, `requestSolve` is not a
 *   function, or the solver returns no squad
 */
export async function runSolve(input, steps = {}) {
  if (input === null || typeof input !== 'object') fail('input must be an object');
  const { challenge, clubItems, externalPrices = null, keys, scopes, requestSolve } = input;
  if (typeof requestSolve !== 'function') {
    fail('requestSolve must be the worker-backed transport function');
  }
  requireEligibilityTable('keys', keys);
  requireEligibilityTable('scopes', scopes);

  const readItems = steps.readClubItems ?? readClubItems;
  const merge = steps.mergePrices ?? mergePrices;
  const build = steps.buildPool ?? buildPool;

  const records = readItems(clubItems);
  const pricedRecords = merge(records, externalPrices);
  const pool = build(pricedRecords, {});

  const result = await requestSolve(OPERATIONS.SOLVE, {
    challenge,
    pool,
    options: { keys, scopes },
  });
  if (result === null || typeof result !== 'object' || result.squad === undefined) {
    fail('the worker returned no squad; a solver response must carry the solution');
  }

  return { ...result, costCoverage: costCoverage(result.squad.players) };
}