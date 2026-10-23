/**
 * Turns the raw challenge payload carried by EA's SBC detail panel into the
 * plain contract shape `src/solver/requirements.js` consumes:
 *
 *   { challengeId, name, formation, elgOperation, elgReq, identityFrom,
 *     operationFrom, requirementsFrom }
 *
 * The field names are read from `CHALLENGE_FIELDS` in `src/ea/adapter.js`, the
 * one file allowed to know raw EA payload names. The output is plain,
 * serialisable data — no entity reference, no method, no DOM — so this reader is
 * unit-testable in Node and the solver core never sees an EA object.
 *
 * `elgReq` is kept as the output field name because that is what the solver
 * consumes; the payload location it came from is reported separately as
 * `requirementsFrom`, resolved by `resolveChallengeRequirements` across every
 * documented location (`eligibilityRequirements`, `requirements`,
 * `requirementsList`, `elgReq`, a `getRequirements()` method, and one level
 * down inside `challenge`, `sbcChallenge`, `data.challenge` and
 * `data.sbcChallenge`).
 *
 * Every required field is validated here, where the raw shape is known: a
 * missing or retyped field throws with the field's name instead of emitting an
 * `undefined` that only surfaces later as a confusing solver error. The reader
 * does not decode requirements; `requirements.js` owns that and rejects any
 * eligibility key the adapter's table cannot name.
 *
 * This module is pure: plain data in, plain data out. No DOM, no chrome APIs,
 * no network.
 */

import {
  CHALLENGE_FIELDS,
  CHALLENGE_IDENTITY_PROPERTIES,
  CHALLENGE_OPERATION_PROPERTIES,
  resolveChallengeRequirements,
} from './adapter.js';
import { describeOwnPropertyTypes } from '../shape.js';

const fail = (message) => {
  throw new Error(`readChallenge: ${message}`);
};

const requireNonEmptyString = (payload, field) => {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`payload must carry a non-empty string ${field}; the challenge shape may have changed`);
  }
  return value;
};

/**
 * Reads the first field in `properties` that satisfies `accept`, and names the
 * location that answered. The wire and the live entity spell the same fact
 * differently (#113), so the reader never hardcodes one spelling; the names
 * themselves stay in `adapter.js`.
 */
const readAlternative = (payload, properties, accept, description) => {
  for (const property of properties) {
    if (accept(payload[property])) {
      return { value: payload[property], from: `payload.${property}` };
    }
  }
  fail(
    `payload must carry ${description} as ${properties.join(' or ')}; the challenge shape may` +
      ' have changed'
  );
};

/**
 * The entry's own key names and types, never a value, so a paste-safe report
 * can tell `{type, kvPairs}` from `{eligibilitySlot, eligibilityKey,
 * eligibilityValue}` in one run.
 */
const describeEntryKeys = (entry) =>
  describeOwnPropertyTypes(entry)
    .map(({ name, type }) => `${name}: ${type}`)
    .join(', ');

const readRequirement = (entry, index) => {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`${CHALLENGE_FIELDS.requirements}[${index}] must be an object`);
  }
  const carried = `the entry carries [${describeEntryKeys(entry)}]`;
  if (typeof entry.type !== 'string' || entry.type.length === 0) {
    fail(`${CHALLENGE_FIELDS.requirements}[${index}] must carry a non-empty type; ${carried}`);
  }
  for (const field of ['eligibilitySlot', 'eligibilityKey', 'eligibilityValue']) {
    if (!Number.isInteger(entry[field])) {
      fail(`${CHALLENGE_FIELDS.requirements}[${index}] must carry an integer ${field}; ${carried}`);
    }
  }
  return {
    type: entry.type,
    eligibilitySlot: entry.eligibilitySlot,
    eligibilityKey: entry.eligibilityKey,
    eligibilityValue: entry.eligibilityValue,
  };
};

/**
 * @param {object} payload the raw challenge payload read from the live page
 * @returns {{ challengeId: number, name: string, formation: string,
 *   elgOperation: string, elgReq: Array<object>, identityFrom: string,
 *   operationFrom: string, requirementsFrom: string }}
 * @throws {Error} when the payload is not an object, lacks a required field,
 *   or carries no requirements array in any documented location
 */
export function readChallenge(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('challenge payload must be an object; the live panel argument may have changed shape');
  }
  const resolved = resolveChallengeRequirements(payload);
  if (!resolved.ok) {
    fail(
      'payload carries no requirements array; looked in ' +
        resolved.attempts.map((attempt) => attempt.id).join(', ')
    );
  }
  const identity = readAlternative(
    payload,
    CHALLENGE_IDENTITY_PROPERTIES,
    (value) => Number.isFinite(value),
    'a finite challenge id'
  );
  const operation = readAlternative(
    payload,
    CHALLENGE_OPERATION_PROPERTIES,
    (value) => typeof value === 'string' && value.length > 0,
    'a non-empty operation'
  );
  return {
    challengeId: identity.value,
    name: requireNonEmptyString(payload, CHALLENGE_FIELDS.name),
    formation: requireNonEmptyString(payload, CHALLENGE_FIELDS.formation),
    elgOperation: operation.value,
    elgReq: resolved.requirements.map(readRequirement),
    identityFrom: identity.from,
    operationFrom: operation.from,
    requirementsFrom: resolved.source,
  };
}
