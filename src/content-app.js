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
import { BUILD_ID } from './ea/build.js';
import {
  BRIDGE_LOADER_FILE,
  BRIDGE_MODULE_FILE,
  CONTENT_SOURCE,
  CONTENT_TO_PAGE_KINDS,
  NONCE_BYTES,
  NONCE_FIELD,
  PAGE_SOURCE,
  PAGE_TO_CONTENT_KINDS,
  WORKER_MODULE_FILE,
  bootLine,
  createBootLog,
  formatNonce,
  nonceMatches,
} from './ui/messages.js';

const COPY_FILES = Object.freeze({
  da: 'design/copy.da.json',
  en: 'design/copy.en.json',
});

const STYLESHEETS = Object.freeze(['design/tokens.css', 'src/ui/styles.css']);

/**
 * Mints this page session's nonce from the isolated world's `crypto`, which is
 * the only world of the two that has it (`src/page-bridge.js` is a classic
 * MAIN-world script and cannot import this module, so it is handed the finished
 * value instead). Minting here rather than in `src/ui/messages.js` keeps the
 * `crypto` dependency in one file and leaves the shared module pure.
 *
 * @param {{ getRandomValues: (array: Uint8Array) => Uint8Array }} crypto
 * @returns {string} the hex nonce
 * @throws {Error} when the environment has no `crypto.getRandomValues` — a
 *   bridge without a nonce would be a bridge that trusts a forgeable tag
 */
export function mintSessionNonce(crypto) {
  if (typeof crypto?.getRandomValues !== 'function') {
    throw new Error('the isolated world has no crypto.getRandomValues to mint a nonce with');
  }
  return formatNonce(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

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
 * Injects the classic MAIN-world loader (#105). This is the only thing that puts
 * `src/page-bridge.js` into the MAIN world, and the loader's whole ability to
 * identify its own extension rests on the element created here.
 *
 * The `src` is set before the element is inserted, which is not a style choice:
 * a `<script>` element that reaches the document with an empty `src` fetches the
 * page's own URL, and a real browser starts fetching the moment it is connected.
 * `onError` is the one channel this injection has — the page never sees the
 * element as anything but a node — and it fires for the failure that would
 * otherwise be completely silent, a page whose CSP refuses the extension origin.
 *
 * @param {object} document the isolated world's `document`, which is the same
 *   document the page sees: a script element connected to it runs in the MAIN
 *   world, which is what an extension-script world cannot do for us
 * @param {object} chrome `chrome.runtime.getURL` resolves the loader's own URL
 * @param {(url: string) => void} [onError] called with the refused URL when the
 *   browser does not run the injected script
 * @returns {object} the injected element
 */
export function injectBridgeLoader(document, chrome, onError) {
  const element = document.createElement('script');
  const url = chrome.runtime.getURL(BRIDGE_LOADER_FILE);
  element.src = url;
  if (typeof onError === 'function') {
    element.onerror = () => onError(url);
  }
  document.head.appendChild(element);
  return element;
}

/**
 * Wires the isolated relay: mints the session nonce, injects styles, announces
 * the copy and, on the bridge's hello, hands over the bridge module URL. Prints
 * the summary and any bridge error to the page console. It also owns the one
 * solver Worker for the session: the page's token-tagged solve requests are
 * brokered to it and its answers are posted back with the same token. The MAIN
 * world's diagnostics block is logged verbatim here and the evidence file is
 * stated in the panel, so a saved console log always carries the block (#75).
 *
 * @param {{ window: object, document: object, chrome: object, navigator: object,
 *   fetch: Function, console: object, crypto: object,
 *   createWorker?: (url: string) => object }} environment `crypto` mints the
 *   session nonce and `createWorker` is injectable for tests; production
 *   constructs a module Worker from the extension URL
 */
export function startContentApp({
  window,
  document,
  chrome,
  navigator,
  fetch,
  console,
  crypto,
  createWorker = (url) => new Worker(url, { type: 'module' }),
}) {
  // #102: the boot log. One line per stage, at the point the stage completes, so
  // a copied log says where the boot got to and stopped. The build marker goes
  // first, before anything that can throw: an empty console means the extension
  // never ran, and a first line that names this build means the extension that
  // ran is the one the reader has in their checkout.
  const bootLog = createBootLog(console);
  bootLog(`build ${BUILD_ID} booting`);

  // #88: one nonce per page session, and the single `send` choke point that
  // every outbound message goes through. The nonce is spread last, so no caller
  // can override or drop it by accident.
  const nonce = mintSessionNonce(crypto);
  const send = (message) => window.postMessage({ ...message, [NONCE_FIELD]: nonce }, '*');

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
      .catch((error) => console.warn(bootLine(error.message)));

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (data === null || typeof data !== 'object' || data.source !== PAGE_SOURCE) return;
    // The `source` tag is a literal any page script can write, so it says which
    // world claims a message, not who sent it: the nonce is the part that has to
    // be right. One message is exempt — the hello. The classic MAIN-world
    // bootstrap runs at `document_start`, may have no nonce of its own yet, and
    // the hello is how it asks for one; the reply carries the nonce and both
    // worlds then have it. The hello holds no capability: its only effect is to
    // be answered with the copy label and the module URL, which the relay
    // already sent proactively. Everything else, `SOLVE_REQUEST` above all, is
    // dropped here, before any dispatch.
    const isHandshakeHello = data.kind === PAGE_TO_CONTENT_KINDS.BRIDGE_HELLO;
    if (!isHandshakeHello && !nonceMatches(nonce, data[NONCE_FIELD])) return;
    if (isHandshakeHello) {
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
      bootLog(data.message ?? data.kind);
      return;
    }
    if (data.kind === PAGE_TO_CONTENT_KINDS.SUMMARY) {
      bootLog(data.summary);
      return;
    }
    if (data.kind === PAGE_TO_CONTENT_KINDS.DIAGNOSTICS) {
      // The one isolated-world copy of the block, verbatim and unconditional:
      // the MAIN-world log is kept, but only this one is guaranteed to survive
      // a saved console log (#75). One post per Solve means one line here; a
      // malformed message never produces a second.
      if (typeof data.block !== 'string' || data.block.length === 0) return;
      console.log(data.block);
      // #87: a successful Solve attempts no write, so it carries no download
      // outcome and the panel says nothing — there is nothing to state. The
      // block above is still logged, exactly as before.
      if (data.download === null || data.download === undefined) return;
      if (copy === null) {
        console.warn(bootLine('diagnostics note skipped: the copy bundle has not loaded'));
        return;
      }
      const ok =
        data.download.ok === true && typeof data.file === 'string' && data.file.length > 0;
      try {
        showDiagnosticsNote({
          document,
          bundle: copy.bundle,
          file: ok ? data.file : null,
          ok,
        });
      } catch (error) {
        console.warn(bootLine(`diagnostics note failed: ${error.message}`));
      }
      return;
    }
    if (data.kind === PAGE_TO_CONTENT_KINDS.ERROR) {
      console.warn(bootLine(data.message));
    }
  });

  // #102: the relay is ready the moment it holds a nonce and is listening — from
  // here a message the MAIN world posts is answered. Before the proactive
  // handshake below, so the log reads as the stages completing in order.
  bootLog('content relay ready');

  // #105: the MAIN-world loader is injected here rather than declared in the
  // manifest, because a manifest-declared MAIN-world content script has no
  // `<script>` element of its own: `document.currentScript` is `null` in it, so
  // #85's id pin could never resolve and every `bridge-module` message was
  // refused. An injected element is a real element, so the loader reads its own
  // extension id off it, and the id stays out of the hands of anything on the
  // channel. The element goes in before the handshake below, and the loader's own
  // `bridge-hello` covers the ordering either way. Injection is the only new way
  // this boot can fail silently, so a refused script says so.
  injectBridgeLoader(document, chrome, (url) =>
    console.warn(bootLine(`main-world loader did not run: ${url} was refused or not found`)),
  );

  window.addEventListener('pagehide', () => workerClient.teardown());

  injectStylesheets(document, chrome);
  // Proactive, so the handshake works no matter which world starts first: the
  // MAIN-world loader may have posted its hello before this listener existed.
  // #102: the one stage line for it — answering the loader's hello sends the very
  // same message again, and a boot log that repeats is one nobody reads.
  send(bridgeModuleMessage(chrome));
  bootLog('bridge module handshake sent');
  announceCopy();
}
