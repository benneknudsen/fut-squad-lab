/**
 * The isolated-world half of the bridge: it loads the copy bundle and the design
 * stylesheet, hands the copy label and the bridge-module URL to the MAIN-world
 * loader, and prints the read summary the bridge posts back.
 *
 * This file is loaded as an ES module by `src/content.js`, which must be a
 * classic script because manifest-declared content scripts cannot use static
 * imports. All environment access happens inside `startContentApp` (or the pure
 * relay helpers), so the module itself imports cleanly in Node.
 */

import { readCopyPath, resolveCopyLocale } from './ui/copy.js';
import {
  BRIDGE_MODULE_FILE,
  CONTENT_SOURCE,
  CONTENT_TO_PAGE_KINDS,
  PAGE_SOURCE,
  PAGE_TO_CONTENT_KINDS,
} from './ui/messages.js';

const COPY_FILES = Object.freeze({
  da: 'design/copy.da.json',
  en: 'design/copy.en.json',
});

const STYLESHEETS = Object.freeze(['design/tokens.css', 'src/ui/styles.css']);

/**
 * The handshake message that tells the MAIN-world loader which module to import.
 * The loader validates the URL against `BRIDGE_MODULE_FILE` before importing.
 */
export function bridgeModuleMessage(chrome) {
  return {
    source: CONTENT_SOURCE,
    kind: CONTENT_TO_PAGE_KINDS.BRIDGE_MODULE,
    url: chrome.runtime.getURL(BRIDGE_MODULE_FILE),
  };
}

/**
 * Loads the copy bundle for the browser language and builds the message that
 * carries the primary-action label to the page.
 *
 * @param {{ chrome: object, navigator: object, fetch: Function }} environment
 * @returns {Promise<{ source: string, kind: string, locale: string, label: string }>}
 * @throws {Error} when the bundle request fails or the file has no `panel.solve`
 */
export async function loadCopyMessage({ chrome, navigator, fetch }) {
  const locale = resolveCopyLocale(navigator.language);
  const file = COPY_FILES[locale];
  const response = await fetch(chrome.runtime.getURL(file));
  if (!response.ok) {
    throw new Error(`copy bundle ${file} failed to load (HTTP ${response.status})`);
  }
  return {
    source: CONTENT_SOURCE,
    kind: CONTENT_TO_PAGE_KINDS.COPY,
    locale,
    label: readCopyPath(await response.json(), 'panel.solve'),
  };
}

/**
 * Appends the design contract's stylesheet and the component styles to the
 * page head as extension links. Serving them as files (not inline styles) is
 * deliberate: MV3's CSP blocks inline style in some contexts, and both files
 * are declared web-accessible for `www.ea.com`.
 */
export function injectStylesheets(document, chrome) {
  for (const file of STYLESHEETS) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL(file);
    document.head.appendChild(link);
  }
}

/**
 * Wires the isolated relay: injects styles, announces the copy and, on the
 * bridge's hello, hands over the bridge module URL. Prints the summary and any
 * bridge error to the page console.
 *
 * @param {{ window: object, document: object, chrome: object, navigator: object,
 *   fetch: Function, console: object }} environment
 */
export function startContentApp({ window, document, chrome, navigator, fetch, console }) {
  const send = (message) => window.postMessage(message, '*');

  const announceCopy = () =>
    loadCopyMessage({ chrome, navigator, fetch })
      .then(send)
      .catch((error) => console.warn(`[FUT Squad Lab] ${error.message}`));

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== PAGE_SOURCE) return;
    if (data.kind === PAGE_TO_CONTENT_KINDS.BRIDGE_HELLO) {
      send(bridgeModuleMessage(chrome));
      announceCopy();
      return;
    }
    if (data.kind === PAGE_TO_CONTENT_KINDS.BRIDGE_READY || data.kind === PAGE_TO_CONTENT_KINDS.MOUNTED) {
      console.log(`[FUT Squad Lab] ${data.message ?? data.kind}`);
      return;
    }
    if (data.kind === PAGE_TO_CONTENT_KINDS.SUMMARY) {
      console.log(`[FUT Squad Lab] ${data.summary}`);
      return;
    }
    if (data.kind === PAGE_TO_CONTENT_KINDS.ERROR) {
      console.warn(`[FUT Squad Lab] ${data.message}`);
    }
  });

  injectStylesheets(document, chrome);
  // Proactive, so the handshake works no matter which world starts first: the
  // MAIN-world loader may have posted its hello before this listener existed.
  send(bridgeModuleMessage(chrome));
  announceCopy();
}
