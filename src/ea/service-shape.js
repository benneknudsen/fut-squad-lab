/**
 * Reports the live shape of the page's service locator and request surface when
 * the club read fails (#44), so the club reader can be pointed at the real path
 * instead of another round of guessed method names.
 *
 * `docs/PLAN.md` §1.2 documents the club as `POST /club`, reached through a
 * request layer EA does not document. The second live session showed that every
 * strategy in `CLUB_ITEM_STRATEGIES` is a method call on an object that does not
 * carry it: `services` exists but holds no `UTSBCRepository`, and
 * `window.UTSBCRepository` / `window.UTSBCService` exist as classes without
 * those methods. This report describes what the live page actually exposes:
 *
 *   requestLayer  every name on `window` and `services` suggesting it can issue
 *                 a request (`request`, `send`, `fetch`, `api`, `network`,
 *                 `client`, `http`, `repo`, `repository`, `service`, `dao`,
 *                 `transport`), each with a type signature plus its own
 *                 property and prototype method names — enough to spot a
 *                 method that takes a URL and a body.
 *   services      every own enumerable property of the `services` object with a
 *                 type signature.
 *   classes       the prototype method names of the two EA classes the club
 *                 reader calls wrong, present or absent.
 *   eaGlobals     every global in `EA_GLOBALS` from `src/ea/adapter.js`, present
 *                 or absent, so a renamed global is distinguishable from a
 *                 wrong method call on a right one.
 *
 * ## Paste safety
 *
 * This output is pasted into a chat and the repo is public, so the rules of the
 * #42 mount report apply unchanged, through the one implementation and the one
 * redaction list in `src/shape.js`:
 *
 * - names and type signatures only; a string is always `string("...")`;
 * - a redacted name stays visible as `<redacted>`, so absent and hidden can be
 *   told apart;
 * - a getter is named as `accessor(get)` and never invoked, because a live
 *   accessor may have side effects inside the player's authenticated session;
 * - nothing is invoked or fetched: the report describes what is reachable and
 *   makes no request of its own.
 *
 * The EA names and the endpoint vocabulary stay in `src/ea/adapter.js`; this
 * module imports `EA_GLOBALS` and never spells an EA symbol itself. It is pure
 * of effect: properties read, no method calls, no network, no DOM writes.
 */

import { EA_GLOBALS } from './adapter.js';
import {
  describeOwnProperties,
  describePrototypeMethods,
  describeValue,
  isRecord,
  redactName,
} from '../shape.js';

/** The schema id of the service surface shape report. */
export const SERVICE_SHAPE_SCHEMA = 'fsl-service-shape/1';

const MAX_REQUEST_CANDIDATES = 60;

/**
 * The name fragments that suggest a value can issue a request. A scan hit is a
 * candidate, not a verified request path; the report says which names matched
 * and what each one exposes.
 */
const REQUEST_NAME_PATTERN =
  /request|send|fetch|api|network|client|http|repo|repository|service|dao|transport/i;

const signatureOf = (value) => {
  try {
    return describeValue(value);
  } catch {
    return 'unreadable';
  }
};

const ownKeysOf = (target) => {
  try {
    return Object.keys(target);
  } catch {
    return [];
  }
};

/**
 * Reads one own property without ever invoking an accessor. The descriptor is
 * consulted first: an own getter is reported as `accessor(get)` and its value
 * is never read, because this runs in the player's authenticated session.
 *
 * @param {*} target the object to read from
 * @param {string} name the own property to read
 * @returns {{ ok: true, value: * }|{ ok: false, signature: string }}
 */
const readProperty = (target, name) => {
  if (target === null || target === undefined) return { ok: false, signature: 'undefined' };
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(target, name);
  } catch {
    return { ok: false, signature: 'unreadable' };
  }
  if (descriptor !== undefined && typeof descriptor.get === 'function') {
    return { ok: false, signature: 'accessor(get)' };
  }
  try {
    return { ok: true, value: target[name] };
  } catch {
    return { ok: false, signature: 'unreadable' };
  }
};

const isPresent = (read) => read.ok && read.value !== undefined && read.value !== null;

const describeCandidate = (scope, name, read) => ({
  location: `${scope}.${redactName(name)}`,
  signature: read.ok ? signatureOf(read.value) : read.signature,
  ownProperties: read.ok ? describeOwnProperties(read.value) : [],
  prototypeMethods: read.ok ? describePrototypeMethods(read.value) : [],
});

/**
 * Collects every own enumerable name on a container that matches the request
 * vocabulary, describing each hit. An accessor hit is named with its
 * `accessor(get)` signature and nothing further is read from it.
 */
const scanContainer = (scope, container, candidates) => {
  for (const name of ownKeysOf(container)) {
    if (!REQUEST_NAME_PATTERN.test(name)) continue;
    candidates.push(describeCandidate(scope, name, readProperty(container, name)));
  }
};

/**
 * Describes one read result as the `{ name, present, signature }` entry shared
 * by the `eaGlobals` and `classes` lists.
 */
const describeRead = (name, read) => ({
  name: redactName(name),
  present: isPresent(read),
  signature: read.ok ? signatureOf(read.value) : read.signature,
});

const describeGlobal = (pageWindow, name) => describeRead(name, readProperty(pageWindow, name));

const describeClass = (pageWindow, key) => {
  const name = EA_GLOBALS[key];
  const read = readProperty(pageWindow, name);
  return {
    ...describeRead(name, read),
    prototypeMethods: describePrototypeMethods(read.ok ? read.value : undefined),
  };
};

/**
 * Builds the service and request surface shape report for one page window.
 * Names and signatures only: no value, no item, no account or session field is
 * ever emitted, no accessor is invoked and no request is made.
 *
 * @param {object|undefined} pageWindow the page's `window`
 * @returns {{ schema: string, requestLayer: { candidates: Array<object>,
 *   omitted: number }, services: { present: boolean, signature: string,
 *   ownProperties: Array<string> }, classes: Array<object>,
 *   eaGlobals: Array<{name: string, present: boolean, signature: string}> }}
 */
export function describeServiceShape(pageWindow) {
  const servicesRead = readProperty(pageWindow, EA_GLOBALS.services);
  const servicesValue = servicesRead.ok ? servicesRead.value : undefined;
  const services = isRecord(servicesValue) ? servicesValue : null;

  const candidates = [];
  scanContainer('window', pageWindow, candidates);
  if (services !== null) scanContainer('services', services, candidates);
  candidates.sort((left, right) =>
    left.location < right.location ? -1 : left.location > right.location ? 1 : 0
  );
  const shown = candidates.slice(0, MAX_REQUEST_CANDIDATES);

  return {
    schema: SERVICE_SHAPE_SCHEMA,
    requestLayer: {
      candidates: shown,
      omitted: candidates.length - shown.length,
    },
    services: {
      present: isPresent(servicesRead),
      signature: servicesRead.ok ? signatureOf(servicesValue) : servicesRead.signature,
      ownProperties: services === null ? [] : describeOwnProperties(services),
    },
    classes: ['sbcRepository', 'sbcService'].map((key) => describeClass(pageWindow, key)),
    eaGlobals: Object.values(EA_GLOBALS).map((name) => describeGlobal(pageWindow, name)),
  };
}