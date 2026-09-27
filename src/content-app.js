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
import { createWorkerClient } from './ea/worker-client.js';
import {
  BRIDGE_MODULE_FILE,
  CONTENT_SOURCE,
  CONTENT_TO_PAGE_KINDS,
  PAGE_SOURCE,
  PAGE_TO_CONTENT_KINDS,
  WORKER_MODULE_FILE,
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
 * Fetches the copy bundle for the browser language. The bundle is returned so
 * the diagnostics relay can build its panel string from the same load the
 * button label came from; nothing is fetched twice.
 *
 * @param {{ chrome: object, navigator: object, fetch: Function }} environment
 * @returns {Promise<{ locale: string, bundle: object }>}
 * @throws {Error} when the bundle request fails
 */
export async function loadCopyBundle({ chrome, navigator, fetch }) {
  const locale = resolveCopyLocale(navigator.language);
  const file = COPY_FILES[locale];
  const response = await fetch(chrome.runtime.getURL(file));
  if (!response.ok) {
    throw new Error(`copy bundle ${file} failed to load (HTTP ${response.status})`);
  }
  return { locale, bundle: await response.json() };
}

const copyMessage = ({ locale, bundle }) => ({
  source: CONTENT_SOURCE,
  kind: CONTENT_TO_PAGE_KINDS.COPY,
  locale,
  label: readCopyPath(bundle, 'panel.solve'),
});

/**
 * Loads the copy bundle for the browser language and builds the message that
 * carries the primary-action label to the page.
 *
 * @param {{ chrome: object, navigator: object, fetch: Function }} environment
 * @returns {Promise<{ source: string, kind: string, locale: string, label: string }>}
 * @throws {Error} when the bundle request fails or the file has no `panel.solve`
 */
export async function loadCopyMessage(environment) {
  return copyMessage(await loadCopyBundle(environment));
}

/** The injected root the diagnostics note is appended to. */
const PANEL_ROOT_SELECTOR = '.fsl-root';
const NOTE_ATTRIBUTE = 'data-fsl-diagnostics';
const NOTE_SELECTOR = `[${NOTE_ATTRIBUTE}]`;

/**
 * States in the injected panel whether the Solve's evidence file was written.
 * The string is the copy bundle's `panel.diagnosticsFile` (or
 * `panel.diagnosticsBlocked`) with `{file}` substituted; the note is created
 * on the first Solve and reused after, so a second solve replaces one line
 * instead of stacking another. The DOM is optional: a page with no injected
 * root, or a test document without `querySelector`, is left untouched.
 *
 * @param {{ document: object, bundle: object, file: string|null, ok: boolean }} input
 * @returns {object|null} the note element, or null when there is no panel root
 */
export function showDiagnosticsNote({ document, bundle, file, ok }) {
  const root = document?.querySelector?.(PANEL_ROOT_SELECTOR) ?? null;
  if (root === null) return null;
  let note = root.querySelector?.(NOTE_SELECTOR) ?? null;
  if (note === null) {
    note = document.createElement('p');
    note.className = 'fsl-diagnostics';
    note.setAttribute(NOTE_ATTRIBUTE, '');
    note.setAttribute('role', 'status');
    root.appendChild(note);
  }
  const key = ok === true ? 'panel.diagnosticsFile' : 'panel.diagnosticsBlocked';
  note.textContent = readCopyPath(bundle, key).replaceAll('{file}', String(file));
  return note;
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
 * bridge error to the page console. It also owns the one solver Worker for the
 * session: the page's token-tagged solve requests are brokered to it and its
 * answers are posted back with the same token. The MAIN world's diagnostics
 * block is logged verbatim here and the evidence file is stated in the panel,
 * so a saved console log always carries the block (#75).
 *
 * @param {{ window: object, document: object, chrome: object, navigator: object,
 *   fetch: Function, console: object, createWorker?: (url: string) => object }}
 *   environment `createWorker` is injectable for tests; production constructs a
 *   module Worker from the extension URL
 */
export function startContentApp({
  window,
  document,
  chrome,
  navigator,
  fetch,
  console,
  createWorker = (url) => new Worker(url, { type: 'module' }),
}) {
  const send = (message) => window.postMessage(message, '*');

  const workerClient = createWorkerClient({
    createWorker: () => createWorker(chrome.runtime.getURL(WORKER_MODULE_FILE)),
    deliver: (message) => send({ source: CONTENT_SOURCE, ...message }),
  });

  // The one copy load of the session, kept so the diagnostics relay can state
  // the evidence file in the panel without fetching the bundle a second time.
  let copy = null;

  const announceCopy = () =>
    loadCopyBundle({ chrome, navigator, fetch })
      .then((loaded) => {
        copy = loaded;
        send(copyMessage(loaded));
      })
      .catch((error) => console.warn(`[FUT Squad Lab] ${error.message}`));

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== PAGE_SOURCE) return;
    if (data.kind === PAGE_TO_CONTENT_KINDS.BRIDGE_HELLO) {
      send(bridgeModuleMessage(chrome));
      announceCopy();
      return;
    }
    if (data.kind === PAGE_TO_CONTENT_KINDS.SOLVE_REQUEST) {
      workerClient.request(data.token, data.operation, data.payload);
      return;
    }
    if (data.kind === PAGE_TO_CONTENT_KINDS.SOLVE_CANCEL) {
      workerClient.cancel(data.token);
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
    if (data.kind === PAGE_TO_CONTENT_KINDS.DIAGNOSTICS) {
      // The one isolated-world copy of the block, verbatim and unconditional:
      // the MAIN-world log is kept, but only this one is guaranteed to survive
      // a saved console log (#75). One post per Solve means one line here; a
      // malformed message never produces a second.
      if (typeof data.block !== 'string' || data.block.length === 0) return;
      console.log(data.block);
      if (copy === null) {
        console.warn('[FUT Squad Lab] diagnostics note skipped: the copy bundle has not loaded');
        return;
      }
      const ok =
        data.download?.ok === true && typeof data.file === 'string' && data.file.length > 0;
      try {
        showDiagnosticsNote({
          document,
          bundle: copy.bundle,
          file: ok ? data.file : null,
          ok,
        });
      } catch (error) {
        console.warn(`[FUT Squad Lab] diagnostics note failed: ${error.message}`);
      }
      return;
    }
    if (data.kind === PAGE_TO_CONTENT_KINDS.ERROR) {
      console.warn(`[FUT Squad Lab] ${data.message}`);
    }
  });

  window.addEventListener('pagehide', () => workerClient.teardown());

  injectStylesheets(document, chrome);
  // Proactive, so the handshake works no matter which world starts first: the
  // MAIN-world loader may have posted its hello before this listener existed.
  send(bridgeModuleMessage(chrome));
  announceCopy();
}
