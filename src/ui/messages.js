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
 * URL handed to `import()` must point at this extension's bridge module (see
 * `isBridgeModuleUrl`), never at a page-controlled URL.
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
  ERROR: 'error',
  SOLVE_REQUEST: 'solve-request',
  SOLVE_CANCEL: 'solve-cancel',
});

/** The bridge module the classic MAIN-world loader dynamically imports. */
export const BRIDGE_MODULE_FILE = 'src/page-bridge-app.js';

/** The solver worker the isolated relay spawns, once per page session. */
export const WORKER_MODULE_FILE = 'src/solver/worker.js';

/**
 * True only for a `chrome-extension://` URL whose path is exactly the bridge
 * module. The URL arrives by postMessage, where any page script can see it and
 * post its own; this check keeps a hostile page from pointing `import()` at a
 * page-controlled script.
 *
 * @param {*} url the candidate URL
 * @returns {boolean}
 */
export function isBridgeModuleUrl(url) {
  if (typeof url !== 'string') return false;
  if (!url.startsWith('chrome-extension://')) return false;
  return url.endsWith(`/${BRIDGE_MODULE_FILE}`);
}
