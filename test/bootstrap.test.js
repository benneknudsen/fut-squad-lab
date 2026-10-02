import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_LOADER_FILE,
  BRIDGE_MODULE_FILE,
  CONTENT_SOURCE,
  CONTENT_TO_PAGE_KINDS,
  LOG_PREFIX,
  NONCE_FIELD,
  PAGE_SOURCE,
  isBridgeModuleUrl,
} from '../src/ui/messages.js';
import {
  FOREIGN_EXTENSION_ID,
  OWN_EXTENSION_ID,
  OWN_LOADER_URL,
  OWN_MODULE_URL,
  createScriptElement,
  injectLoaderScript,
  parkInjectedScript,
  startInjectedLoader,
  startUnidentifiedLoader,
} from './helpers/bootstrap.js';
import { TEST_NONCE } from './helpers/nonce.js';

// The two manifest-declared entry scripts are classic scripts: they cannot use
// static imports, so their protocol constants are literals that must stay in
// step with `src/ui/messages.js`. These tests read the real files, so changing a
// tag on one side without the other fails here.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const PAGE_BRIDGE = 'src/page-bridge.js';
const CONTENT = 'src/content.js';

/** A document that has not been injected into yet, and the list that records it. */
const createDocument = () => {
  const injectedScripts = [];
  return {
    injectedScripts,
    document: {
      // A real document has this, and it is `null` outside a script's own
      // evaluation — which is the whole of #105's problem in one property.
      currentScript: null,
      createElement: (tagName) => (String(tagName).toLowerCase() === 'script' ? createScriptElement() : {}),
      head: { appendChild: parkInjectedScript(injectedScripts) },
    },
  };
};

/**
 * The relay's injection followed by the browser's evaluation — the only way into
 * the loader body since #105. There is deliberately no option for handing it a
 * script element some other way.
 */
const startLoader = ({ url = OWN_LOADER_URL, importModule } = {}) => {
  const { document, injectedScripts } = createDocument();
  injectLoaderScript(document, { url });
  return startInjectedLoader({ document, injectedScripts, importModule });
};

describe('main-world bootstrap', () => {
  it('uses the message contract tags from messages.js', () => {
    const source = read(PAGE_BRIDGE);
    expect(source).toContain(`'${PAGE_SOURCE}'`);
    expect(source).toContain(`'${CONTENT_SOURCE}'`);
    expect(source).toContain(`'${CONTENT_TO_PAGE_KINDS.BRIDGE_MODULE}'`);
    expect(source).toContain(`'${NONCE_FIELD}'`);
  });

  it('imports exactly the bridge module named in the contract', () => {
    expect(read(PAGE_BRIDGE)).toContain(`'/${BRIDGE_MODULE_FILE}'`);
  });

  it('contains no static import or export statement', () => {
    const source = read(PAGE_BRIDGE);
    expect(source).not.toMatch(/^\s*import\s+(?!\()/m);
    expect(source).not.toMatch(/^\s*export\b/m);
  });
});

// #102: the console prefix is the one string both worlds write on every line, so
// a copy of it that drifted would silently split the boot log in two. Exactly
// one classic script may spell it out; the other must reach the shared constant
// through the log helper it loads at runtime.
describe('the console prefix in the classic scripts', () => {
  const occurrences = (source, value) => source.split(`'${value}'`).length - 1;

  it('is spelled once in the MAIN-world loader and nowhere in the isolated one', () => {
    expect(LOG_PREFIX).toBe('[FUT Squad Lab]');
    expect(occurrences(read(PAGE_BRIDGE), LOG_PREFIX)).toBe(1);
    expect(occurrences(read(CONTENT), LOG_PREFIX)).toBe(0);
  });
});

// #105: the loader reads its own extension id off the `<script>` element it was
// injected through, because that is the only thing in the MAIN world that names
// this extension. These tests pin where that element comes from and what the
// loader does without one — the state a manifest-declared MAIN-world content
// script is in, and the reason the first live run refused the relay's own message.
describe('the script element the MAIN world reads its extension id from', () => {
  it('is the element the relay injected, not a fabricated one', async () => {
    const { document, injectedScripts } = createDocument();
    const injected = injectLoaderScript(document);

    expect(injected.src).toBe(OWN_LOADER_URL);
    expect(injectedScripts).toEqual([injected]);

    const bridge = startInjectedLoader({ document, injectedScripts });
    bridge.dispatch({
      source: CONTENT_SOURCE,
      kind: CONTENT_TO_PAGE_KINDS.BRIDGE_MODULE,
      nonce: TEST_NONCE,
      url: OWN_MODULE_URL,
    });

    await vi.waitFor(() => {
      expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
    });
  });

  it('does not exist in a document that never injected it, so there is no id to pin', () => {
    const { document } = createDocument();

    // The state a manifest-declared MAIN-world content script is in, and the one
    // this harness used to paper over. Here `document.currentScript` is null
    // before the body runs and null after it, as it is in a real document at
    // rest.
    expect(document.currentScript).toBeNull();
    const bridge = startUnidentifiedLoader({ document });
    expect(document.currentScript).toBeNull();

    bridge.dispatch({
      source: CONTENT_SOURCE,
      kind: CONTENT_TO_PAGE_KINDS.BRIDGE_MODULE,
      nonce: TEST_NONCE,
      url: OWN_MODULE_URL,
    });

    // Failing closed is the point: this is the gate that #105 left intact, and a
    // loosening of it would let an unidentified origin choose the module URL.
    expect(bridge.importCalls).toEqual([]);
    const error = bridge.posted.find((message) => message.kind === 'error');
    // The line a player saw on fsl-build/13, verbatim. Two things are being kept
    // apart on purpose: an extension that cannot name itself, and an extension
    // that named something else.
    expect(error.message).toBe(
      `refused bridge module URL chrome-extension://${OWN_EXTENSION_ID}; ` +
        'this extension could not determine its own id',
    );
    expect(bridge.warned.join('\n')).toBe(`[FUT Squad Lab] ${error.message}`);
  });

  it('is never invented for a document that injected nothing', () => {
    // The harness must not be able to conjure the one element the whole design
    // now rests on: a test that wants a loader has to inject one.
    const { document, injectedScripts } = createDocument();

    expect(() => startInjectedLoader({ document, injectedScripts })).toThrow(
      /exactly one injected MAIN-world script/,
    );
  });

  it('cannot be run twice off one injection, the way a page gets one loader', () => {
    const { document, injectedScripts } = createDocument();
    injectLoaderScript(document);
    startInjectedLoader({ document, injectedScripts });

    expect(() => startInjectedLoader({ document, injectedScripts })).toThrow(
      /exactly one injected MAIN-world script/,
    );
  });

  it('cannot be run at all off an element with no src, which a browser would fetch as the page', () => {
    const { document, injectedScripts } = createDocument();
    const element = document.createElement('script');
    document.head.appendChild(element);

    expect(() => startInjectedLoader({ document, injectedScripts })).toThrow(/no src/);
  });

  it('pins the extension that served it, so an element from elsewhere moves the pin', () => {
    // The id is not a constant and not a message field: it is whichever extension
    // the browser fetched this body from. So an element served by another
    // extension pins *that* id, and this extension's own module URL is then the
    // one refused. That is the direction the id is supposed to fail in — it takes
    // the page's element at its word, and the element is the only thing naming it.
    const foreignLoaderUrl = `chrome-extension://${FOREIGN_EXTENSION_ID}/${BRIDGE_LOADER_FILE}`;
    const bridge = startLoader({ url: foreignLoaderUrl });
    bridge.dispatch({
      source: CONTENT_SOURCE,
      kind: CONTENT_TO_PAGE_KINDS.BRIDGE_MODULE,
      nonce: TEST_NONCE,
      url: OWN_MODULE_URL,
    });

    expect(bridge.importCalls).toEqual([]);
    const error = bridge.posted.find((message) => message.kind === 'error');
    expect(error.message).toBe(
      `refused bridge module URL chrome-extension://${OWN_EXTENSION_ID}; ` +
        `expected ${foreignLoaderUrl.replace(BRIDGE_LOADER_FILE, BRIDGE_MODULE_FILE)}`,
    );
  });
});

describe('main-world bootstrap module gate', () => {
  const moduleMessage = (extra) => ({
    source: CONTENT_SOURCE,
    kind: 'bridge-module',
    nonce: TEST_NONCE,
    url: OWN_MODULE_URL,
    ...extra,
  });

  it('imports the bridge module from this extension id and starts it with the nonce', async () => {
    const bridge = startLoader();
    bridge.dispatch(moduleMessage());

    expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
    await vi.waitFor(() => {
      // The nonce the module is started with is the one the relay minted, so
      // the module can require it on everything it accepts from here on.
      expect(bridge.startPageBridge).toHaveBeenCalledWith(bridge.window, { nonce: TEST_NONCE });
    });
  });

  it('refuses an unsigned bridge-module message and never imports it', () => {
    for (const nonce of [undefined, null, '', 42, {}]) {
      const bridge = startLoader();
      bridge.dispatch(moduleMessage({ nonce }));

      expect(bridge.importCalls).toEqual([]);
      expect(bridge.startPageBridge).not.toHaveBeenCalled();
      // The refusal must still be visible: this script has no nonce of its own
      // to sign an error with, and the relay now drops unsigned messages.
      expect(bridge.warned.join('\n')).toMatch(/nonce/i);
    }
  });

  it('names the session nonce nowhere in its own output', () => {
    const bridge = startLoader();
    bridge.dispatch(
      moduleMessage({ url: `chrome-extension://${FOREIGN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}` })
    );

    expect(bridge.warned.join('\n')).not.toContain(TEST_NONCE);
    expect(JSON.stringify(bridge.posted)).not.toContain(TEST_NONCE);
  });

  it('refuses a bridge-module URL from another extension and never imports it', () => {
    const bridge = startLoader();
    const foreignUrl = `chrome-extension://${FOREIGN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}`;
    bridge.dispatch(moduleMessage({ url: foreignUrl }));

    expect(bridge.importCalls).toEqual([]);
    expect(bridge.startPageBridge).not.toHaveBeenCalled();

    const error = bridge.posted.find((message) => message.kind === 'error');
    expect(error.message).toContain(`chrome-extension://${OWN_EXTENSION_ID}/`);
    expect(error.message).toContain(`chrome-extension://${FOREIGN_EXTENSION_ID}`);
    expect(error.message).not.toContain(`chrome-extension://${FOREIGN_EXTENSION_ID}/`);
    // The same refusal, still legible in the console.
    expect(bridge.warned.join('\n')).toContain(`chrome-extension://${FOREIGN_EXTENSION_ID}`);
  });

  it('refuses every bridge-module message when its script element is not an extension', () => {
    // The id source is the URL the loader itself was loaded from, so anything
    // that is not a `chrome-extension://` URL names no extension and the gate
    // refuses rather than pinning against an origin it cannot verify. An element
    // with no `src` at all never gets this far: a browser would fetch the page
    // URL, so the harness refuses to run it.
    for (const url of ['https://www.ea.com/src/page-bridge.js', 'about:blank', 'data:,']) {
      const bridge = startLoader({ url });
      bridge.dispatch(moduleMessage());

      expect(bridge.importCalls).toEqual([]);
      expect(bridge.startPageBridge).not.toHaveBeenCalled();
      const error = bridge.posted.find((message) => message.kind === 'error');
      expect(error.message).toContain('could not determine its own id');
    }
  });

  it('refuses this extension id when the path is not the bridge module', () => {
    const bridge = startLoader();
    bridge.dispatch({
      ...moduleMessage(),
      url: `chrome-extension://${OWN_EXTENSION_ID}/src/other.js`,
    });

    expect(bridge.importCalls).toEqual([]);
  });

  it('refuses a path that only ends like the module, so a traversal cannot name it', () => {
    // A suffix check admits every one of these, because each ends in the module
    // path. The gate has to be on the whole path, not on its tail.
    for (const path of [
      '../src/page-bridge-app.js',
      'src/../src/page-bridge-app.js',
      'src/ui/../page-bridge-app.js',
      'assets/src/page-bridge-app.js',
      // `use_dynamic_url` replaces the URL's host, it does not add a `_/`
      // segment to the path, so no accepted path carries one either (#89).
      '_/src/page-bridge-app.js',
    ]) {
      const bridge = startLoader();
      bridge.dispatch(moduleMessage({ url: `chrome-extension://${OWN_EXTENSION_ID}/${path}` }));

      expect(bridge.importCalls).toEqual([]);
    }
  });

  it('pins the extension id character for character, not just the scheme', () => {
    // #85's whole point: a gate that accepted "some chrome-extension host"
    // would import this. Only the id comparison refuses it.
    const nearMissId = `x${OWN_EXTENSION_ID.slice(1)}`;
    const nearMissUrl = `chrome-extension://${nearMissId}/${BRIDGE_MODULE_FILE}`;

    const refused = startLoader();
    refused.dispatch(moduleMessage({ url: nearMissUrl }));
    expect(refused.importCalls).toEqual([]);

    // And the refusal is the id pin rather than anything else: the same URL is
    // imported once the loader's own script element carries that very id.
    const accepted = startLoader({
      url: `chrome-extension://${nearMissId}/${BRIDGE_LOADER_FILE}`,
    });
    accepted.dispatch(moduleMessage({ url: nearMissUrl }));
    expect(accepted.importCalls).toEqual([nearMissUrl]);
  });

  it('decides every candidate URL the same way the shared contract does', () => {
    // The two gates cannot import each other, so they are the same rule written
    // twice. `use_dynamic_url` and #85 both moved what a valid URL looks like;
    // this is where one side being left behind shows up.
    const candidates = [
      `chrome-extension://${OWN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}`,
      `chrome-extension://${OWN_EXTENSION_ID}/_/${BRIDGE_MODULE_FILE}`,
      `chrome-extension://${OWN_EXTENSION_ID}/../${BRIDGE_MODULE_FILE}`,
      `chrome-extension://${OWN_EXTENSION_ID}/src/ui/../page-bridge-app.js`,
      `chrome-extension://${OWN_EXTENSION_ID}/assets/${BRIDGE_MODULE_FILE}`,
      `chrome-extension://${OWN_EXTENSION_ID}/src/other.js`,
      `chrome-extension://${FOREIGN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}`,
      `x${OWN_EXTENSION_ID.slice(1)}/${BRIDGE_MODULE_FILE}`,
      'https://evil.example/src/page-bridge-app.js',
      'data:text/javascript,export const x = 1',
    ];

    for (const url of candidates) {
      const bridge = startLoader();
      bridge.dispatch(moduleMessage({ url }));

      expect(bridge.importCalls, `the bootstrap refused ${url}`).toEqual(
        isBridgeModuleUrl(url, OWN_EXTENSION_ID) ? [url] : [],
      );
    }
  });

  it('imports once, so a second signed module message cannot restart the bridge', async () => {
    const bridge = startLoader();
    bridge.dispatch(moduleMessage());
    await vi.waitFor(() => {
      expect(bridge.startPageBridge).toHaveBeenCalledTimes(1);
    });

    bridge.dispatch(moduleMessage());

    expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
    expect(bridge.startPageBridge).toHaveBeenCalledTimes(1);
  });
});

describe('isolated-world bootstrap', () => {
  it('loads the relay module through chrome.runtime.getURL', () => {
    expect(read(CONTENT)).toContain("chrome.runtime.getURL('src/content-app.js')");
  });

  it('contains no static import or export statement', () => {
    const source = read(CONTENT);
    expect(source).not.toMatch(/^\s*import\s+(?!\()/m);
    expect(source).not.toMatch(/^\s*export\b/m);
  });
});
