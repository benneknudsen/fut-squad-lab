/**
 * Runs the real `src/page-bridge.js` body the way a browser runs an injected
 * MAIN-world script: as a classic script, with `document.currentScript` naming
 * the `<script>` element it was loaded through, and only for the length of its
 * synchronous evaluation.
 *
 * #105 is the reason this file has no `ownScriptUrl` option. The loader reads
 * its own extension id off that element, and Chrome gives a manifest-declared
 * MAIN-world content script no element at all — `document.currentScript` is `null`
 * there, which is why the relay's own message was refused on a live run. A harness
 * that could hand this body a script element from outside would launder that
 * assumption back in through a green test, so the only way in is a real
 * injection: `injectLoaderScript` puts an element on the document head the way the
 * relay does, and `startInjectedLoader` runs what was injected.
 *
 * `parkInjectedScript` is the `document.head.appendChild` a fake document uses. It
 * parks the element where a browser would start fetching it rather than evaluating
 * it, because a browser fetches first and evaluates on a later turn — an ordering
 * the handshake depends on. `startInjectedLoader` is that later turn, and it
 * refuses to invent an element: a document that never injected one has no loader,
 * which is a state worth being able to test.
 *
 * The only edit to the source is swapping the dynamic `import()` for a recorder,
 * because a `Function` body cannot have its import target intercepted any other
 * way. The harness asserts that swap matched exactly once, so a future rewrite
 * that removes the import fails here instead of silently passing. `importModule`
 * decides what the recorder resolves to: the default is a stub that only records
 * that `startPageBridge` was called, and a test that wants the real MAIN-world
 * module hands in a real dynamic `import()`.
 *
 * `warned` is the refusal lines the loader wrote, recorded only when the harness
 * owns the console. Given a shared `window` the loader writes to that window's own
 * console, so a caller recording one console for both worlds sees every line once
 * and in order.
 */

import { readFileSync } from 'node:fs';
import { vi } from 'vitest';

import { BRIDGE_LOADER_FILE, BRIDGE_MODULE_FILE } from '../../src/ui/messages.js';

const PAGE_BRIDGE = 'src/page-bridge.js';
const IMPORT_MARKER = 'import(data.url)';
const CHROME_EXTENSION_PREFIX = 'chrome-extension://';

export const OWN_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const FOREIGN_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

/** The URL the relay resolves for the loader it injects. */
export const OWN_LOADER_URL = `${CHROME_EXTENSION_PREFIX}${OWN_EXTENSION_ID}/${BRIDGE_LOADER_FILE}`;

/** The URL of the MAIN-world module, which the loader pins against that id. */
export const OWN_MODULE_URL = `${CHROME_EXTENSION_PREFIX}${OWN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}`;

const readRepoFile = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/**
 * The element a MAIN-world injection creates. `src` is an attribute the way a real
 * element's is, so reading `element.src` back gives the absolute URL a browser
 * would have fetched.
 *
 * @returns {object} a fake `<script>` node with no `src` set yet
 */
export const createScriptElement = () => {
  const attributes = {};
  return {
    tagName: 'SCRIPT',
    attributes,
    onerror: null,
    get src() {
      return attributes.src ?? '';
    },
    set src(value) {
      attributes.src = String(value);
    },
    setAttribute(name, value) {
      attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(attributes, name) ? attributes[name] : null;
    },
  };
};

/**
 * The `document.head.appendChild` a fake document uses to receive the relay's
 * injections. Only `<script>` elements are parked — a stylesheet link reaching the
 * head is not something a browser would execute, and treating it as a script to
 * run would model the page worse than the browser does.
 *
 * @param {object[]} injectedScripts the list to park them in
 * @returns {Function} the append handler to give the fake document's head
 */
export const parkInjectedScript = (injectedScripts) => (node) => {
  if (String(node?.tagName).toUpperCase() === 'SCRIPT') injectedScripts.push(node);
  return node;
};

/**
 * Puts one `<script>` element on `document.head` the way the relay does, and
 * returns it so a test can assert what was injected.
 *
 * @param {object} document a fake document whose head parks scripts
 * @param {{ url?: string }} [options] the extension URL the relay resolved
 * @returns {object} the injected element
 */
export const injectLoaderScript = (document, { url = OWN_LOADER_URL } = {}) => {
  const element = createScriptElement();
  element.src = url;
  document.head.appendChild(element);
  return element;
};

/**
 * Runs the real loader body against a script element, with `document.currentScript`
 * live only while the body evaluates.
 *
 * @param {object} document the fake document the loader read from
 * @param {object} script the `<script>` element it was loaded through
 * @param {() => void} evaluate runs the body, synchronously
 * @returns {void}
 */
const evaluateInScript = (document, script, evaluate) => {
  // A real accessor, so `currentScript` is `null` at rest and after the body — the
  // only window in which a browser exposes one is the body's own evaluation.
  let current = null;
  Object.defineProperty(document, 'currentScript', {
    configurable: true,
    get: () => current,
  });
  try {
    current = script;
    evaluate();
  } finally {
    current = null;
  }
};

/**
 * Runs the loader body once and records everything it did. Shared by both
 * entry points below, so the identified and the unidentified loader are the same
 * code path with one difference between them: whether a `<script>` element exists.
 *
 * @param {{ document: object, script: object|null, window?: object,
 *   importModule?: Function }} input the page world and the element it loaded through
 * @returns {{ window: object, posted: object[], warned: string[],
 *   importCalls: string[], startPageBridge: Function, dispatch: Function }} the recorder
 */
const runLoaderBody = ({ document, script, window: targetWindow, importModule }) => {
  const source = readRepoFile(PAGE_BRIDGE);
  const matches = source.split(IMPORT_MARKER).length - 1;
  if (matches !== 1) {
    throw new Error(`expected one dynamic import marker in ${PAGE_BRIDGE}, found ${matches}`);
  }

  const posted = [];
  const importCalls = [];
  const listeners = [];
  const warned = [];
  const startPageBridge = vi.fn();

  // A test that wires both worlds onto one shared `window` passes it in; one that
  // only exercises the loader gets a fake of its own.
  const window =
    targetWindow ?? {
      postMessage(message) {
        posted.push(message);
      },
      addEventListener(type, handler) {
        if (type === 'message') listeners.push(handler);
      },
    };
  if (targetWindow === undefined) {
    // The harness owns this console, so it records what the loader refuses.
    window.console = { log: () => {}, warn: (line) => warned.push(line) };
  } else {
    // The caller owns that console, and the loader writes to it as it stands — so
    // its lines land in the caller's own list next to the relay's, which is the
    // whole point of sharing one window. The listener is what this harness has to
    // add itself: it needs the loader's handler to dispatch to on its own.
    window.addEventListener('message', (handler) => listeners.push(handler));
  }
  const importShim = (url) => {
    importCalls.push(url);
    return importModule === undefined
      ? Promise.resolve({ startPageBridge })
      : importModule(url);
  };
  const body = new Function(
    'window',
    'document',
    'importShim',
    source.replace(IMPORT_MARKER, 'importShim(data.url)'),
  );

  evaluateInScript(document, script, () => body(window, document, importShim));

  return {
    window,
    posted,
    warned,
    importCalls,
    startPageBridge,
    dispatch(data) {
      for (const listener of [...listeners]) listener({ data });
    },
  };
};

/**
 * Runs the MAIN-world loader out of whatever the relay injected.
 *
 * Refuses to run anything that was not injected, and refuses to run twice: a page
 * gets exactly one loader per session, so a test that wants a second one has to
 * inject a second one rather than have a synthetic element appear.
 *
 * @param {{ document: object, injectedScripts: object[], window?: object,
 *   importModule?: Function }} input the shared page world and the parked elements
 * @returns {ReturnType<typeof runLoaderBody>} the recorder for the one injected loader
 */
export const startInjectedLoader = ({ document, injectedScripts, ...rest }) => {
  if (injectedScripts.length !== 1) {
    throw new Error(
      `expected exactly one injected MAIN-world script, found ${injectedScripts.length}: ` +
        'the loader runs out of a real injection and is never fabricated',
    );
  }
  const script = injectedScripts.shift();
  // A `<script>` connected with no `src` fetches the page's own URL, so a browser
  // would run EA's document rather than this loader. There is no honest way to
  // continue, and pretending otherwise is the bug #105 is about.
  if (script.src === '') {
    throw new Error('the injected script has no src, so a browser would fetch the page URL');
  }
  return runLoaderBody({ document, script, ...rest });
};

/**
 * Runs the loader body in a document that never injected it — so there is no
 * `<script>` element and `document.currentScript` is `null` while it evaluates,
 * which is exactly what Chrome gives a manifest-declared MAIN-world content
 * script.
 *
 * That is the state #105 was written about: the id the loader pins its module URL
 * against cannot be resolved, and the gate refuses everything, the relay's own
 * message included. Nothing in the shipped extension can reach this state any
 * more — `test/manifest.test.js` says why — so it exists here to pin the
 * consequence down, so the gate cannot be quietly loosened to make it work.
 *
 * @param {{ document: object, window?: object, importModule?: Function }} input
 * @returns {ReturnType<typeof runLoaderBody>} the recorder
 */
export const startUnidentifiedLoader = (input) => runLoaderBody({ ...input, script: null });