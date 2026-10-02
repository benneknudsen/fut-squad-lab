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

/**
 * True only for a `chrome-extension://` URL from the given extension id whose
 * path ends in the bridge module. The URL arrives by postMessage, where any
 * page script can see it and post its own; scheme and path alone are not
 * enough, so the caller must pass its own extension id and a caller that cannot
 * name one rejects everything.
 *
 * @param {*} url the candidate URL
 * @param {*} extensionId the extension id that must serve the URL
 * @returns {boolean}
 */
export function isBridgeModuleUrl(url, extensionId) {
  if (typeof url !== 'string') return false;
  if (typeof extensionId !== 'string' || extensionId.length === 0) return false;
  if (!url.startsWith(`chrome-extension://${extensionId}/`)) return false;
  return url.endsWith(`/${BRIDGE_MODULE_FILE}`);
}
