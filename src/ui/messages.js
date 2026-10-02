/**
 * The message contract between the two injected worlds.
 *
 * `src/content.js` runs in the isolated world and can use `chrome.runtime`;
 * `src/page-bridge.js` runs in the MAIN world, shares `window` with EA's code
 * and has no extension APIs. The two talk only through `window.postMessage`,
 * so every message carries a source tag and a kind from these frozen tables.
 *
 * Page scripts can post to the same channel and can read every message, so the
 * bridge validates what it accepts: the copy label is a string, and the module
 * URL handed to `import()` must come from this extension (see
 * `isBridgeModuleUrl`, which the caller must pin to its own extension id),
 * never from a page-controlled URL.
 *
 * #88 adds the second gate: every message carries the session nonce minted by
 * the isolated relay, and both worlds drop anything that does not present it.
 * The `source` tag is a string literal any page script can write, so on its own
 * it is a label, not a credential. The nonce is not a secret either — the
 * channel is the same `window`, so a script that listens can read the nonce off
 * the wire — and it is not meant to be. It is a capability: `SOLVE_REQUEST` is
 * not something the page should hold just because it can spell the tag, and a
 * script must be on the channel and know this session's value to exercise one.
 * What it stops is forgery that does not bother to observe the channel, and
 * another script that happens to speak these tags by accident.
 *
 * #102 adds the console half of that contract: the prefix and the one boot-log
 * writer both worlds use, so a pasted console log says which stage the boot
 * reached without the reader having to know any of this.
 */

export const PAGE_SOURCE = 'fsl-page';
export const CONTENT_SOURCE = 'fsl-content';

/** Kinds the main-world bridge accepts from the isolated relay. */
export const CONTENT_TO_PAGE_KINDS = Object.freeze({
  COPY: 'copy',
  BRIDGE_MODULE: 'bridge-module',
  SOLVE_PROGRESS: 'solve-progress',
  SOLVE_RESPONSE: 'solve-response',
  SOLVE_ERROR: 'solve-error',
});

/** Kinds the isolated relay accepts from the main-world bridge. */
export const PAGE_TO_CONTENT_KINDS = Object.freeze({
  BRIDGE_HELLO: 'bridge-hello',
  BRIDGE_READY: 'bridge-ready',
  MOUNTED: 'mounted',
  SUMMARY: 'summary',
  DIAGNOSTICS: 'diagnostics',
  ERROR: 'error',
  SOLVE_REQUEST: 'solve-request',
  SOLVE_CANCEL: 'solve-cancel',
});

/** The bridge module the classic MAIN-world loader dynamically imports. */
export const BRIDGE_MODULE_FILE = 'src/page-bridge-app.js';

/** The solver worker the isolated relay spawns, once per page session. */
export const WORKER_MODULE_FILE = 'src/solver/worker.js';

/** The field every cross-world message carries the session nonce in. */
export const NONCE_FIELD = 'nonce';

/** Bytes of entropy behind one session nonce. */
export const NONCE_BYTES = 16;

/**
 * The prefix every stage line this extension writes to the page console carries
 * (#102). Two lines are deliberately outside it: the bootstrap failure in
 * `src/content.js`, which can only prefix once this module has imported, and the
 * diagnostics block, which is pasted verbatim.
 *
 * It is the one string both worlds put in front of every line, so it lives here
 * with the rest of the cross-world literals. `src/page-bridge.js` is a classic
 * MAIN-world script and cannot import this module, so it spells the prefix out
 * itself; `test/bootstrap.test.js` locks the two together. Nothing else may
 * hold a copy.
 */
export const LOG_PREFIX = '[FUT Squad Lab]';

/**
 * Builds one console line: the prefix, and nothing else.
 *
 * @param {string} line the stage description
 * @returns {string} the prefixed line
 */
export const bootLine = (line) => `${LOG_PREFIX} ${line}`;

/**
 * The one boot-log writer, bound to the console of the world that logs (#102).
 *
 * One stage per call, at the point the stage completes: a line in a pasted log
 * is evidence that the stage happened, so nothing here logs speculatively. It
 * takes no level — a caller that already had one keeps it and composes its own
 * line with `bootLine`.
 *
 * @param {{ log: Function }|undefined|null} console the console of this world
 * @returns {Function} writes one prefixed line
 */
export const createBootLog = (console) => (line) => console?.log?.(bootLine(line));

/**
 * Renders random bytes as the hex nonce that travels on the channel. Hex, not
 * base64url, so the value stays readable in a console while a session is being
 * traced. Every byte gets two characters, so a leading zero survives.
 *
 * @param {Uint8Array} bytes the random bytes
 * @returns {string} `2 * bytes.length` lowercase hex characters
 * @throws {TypeError} when the argument is not a byte array
 */
export function formatNonce(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('formatNonce: expected a Uint8Array of random bytes');
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * True only for the exact nonce this session minted, as a string.
 *
 * The comparison walks both strings to the end and folds the differences
 * together instead of returning at the first mismatch. A timing attack is not
 * the threat this closes — the channel is one shared `window`, so a page script
 * that wanted the nonce could read it out of a message instead of guessing it,
 * and the value is only good for the rest of one page session — but this is a
 * nonce, so it is compared like one: eight lines, and no prefix oracle left in
 * the channel on principle.
 *
 * @param {*} expected the nonce the listener minted
 * @param {*} candidate the nonce on the message
 * @returns {boolean}
 */
export function nonceMatches(expected, candidate) {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof candidate !== 'string') return false;
  if (candidate.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ candidate.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * True only for a `chrome-extension://` URL from the given extension id whose
 * path is the bridge module. The URL arrives by postMessage, where any page
 * script can see it and post its own; scheme and path alone are not enough, so
 * the caller must pass its own extension id and a caller that cannot name one
 * rejects everything.
 *
 * The check is on the whole path, not on its tail: a suffix test would admit
 * `chrome-extension://<own-id>/../src/page-bridge-app.js` and
 * `.../assets/src/page-bridge-app.js`, neither of which is this module. Both
 * `src/page-bridge.js` and this function must agree — see the note on the copy
 * in the MAIN-world bootstrap, which cannot import this module.
 *
 * @param {*} url the candidate URL
 * @param {*} extensionId the extension id that must serve the URL
 * @returns {boolean}
 */
export function isBridgeModuleUrl(url, extensionId) {
  if (typeof url !== 'string') return false;
  if (typeof extensionId !== 'string' || extensionId.length === 0) return false;
  return url === `chrome-extension://${extensionId}/${BRIDGE_MODULE_FILE}`;
}
