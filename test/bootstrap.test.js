import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_MODULE_FILE,
  CONTENT_SOURCE,
  CONTENT_TO_PAGE_KINDS,
  NONCE_FIELD,
  PAGE_SOURCE,
  isBridgeModuleUrl,
} from '../src/ui/messages.js';
import {
  FOREIGN_EXTENSION_ID,
  OWN_EXTENSION_ID,
  loadMainWorldBootstrap,
} from './helpers/bootstrap.js';
import { TEST_NONCE } from './helpers/nonce.js';

// The two manifest-declared entry scripts are classic scripts: they cannot use
// static imports, so their protocol constants are literals that must stay in
// step with `src/ui/messages.js`. These tests read the real files, so changing a
// tag on one side without the other fails here.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const PAGE_BRIDGE = 'src/page-bridge.js';
const CONTENT = 'src/content.js';

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

describe('main-world bootstrap module gate', () => {
  const ownModuleUrl = `chrome-extension://${OWN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}`;
  const moduleMessage = (extra) => ({
    source: CONTENT_SOURCE,
    kind: 'bridge-module',
    nonce: TEST_NONCE,
    url: ownModuleUrl,
    ...extra,
  });

  it('imports the bridge module from this extension id and starts it with the nonce', async () => {
    const bridge = loadMainWorldBootstrap();
    bridge.dispatch(moduleMessage());

    expect(bridge.importCalls).toEqual([ownModuleUrl]);
    await vi.waitFor(() => {
      // The nonce the module is started with is the one the relay minted, so
      // the module can require it on everything it accepts from here on.
      expect(bridge.startPageBridge).toHaveBeenCalledWith(bridge.window, { nonce: TEST_NONCE });
    });
  });

  it('refuses an unsigned bridge-module message and never imports it', () => {
    for (const nonce of [undefined, null, '', 42, {}]) {
      const bridge = loadMainWorldBootstrap();
      bridge.dispatch(moduleMessage({ nonce }));

      expect(bridge.importCalls).toEqual([]);
      expect(bridge.startPageBridge).not.toHaveBeenCalled();
      // The refusal must still be visible: this script has no nonce of its own
      // to sign an error with, and the relay now drops unsigned messages.
      expect(bridge.warned.join('\n')).toMatch(/nonce/i);
    }
  });

  it('names the session nonce nowhere in its own output', () => {
    const bridge = loadMainWorldBootstrap();
    bridge.dispatch(
      moduleMessage({ url: `chrome-extension://${FOREIGN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}` })
    );

    expect(bridge.warned.join('\n')).not.toContain(TEST_NONCE);
    expect(JSON.stringify(bridge.posted)).not.toContain(TEST_NONCE);
  });

  it('refuses a bridge-module URL from another extension and never imports it', () => {
    const bridge = loadMainWorldBootstrap();
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

  it('refuses every bridge-module message when it cannot derive its own id', () => {
    for (const ownScriptUrl of [null, 'https://www.ea.com/src/page-bridge.js']) {
      const bridge = loadMainWorldBootstrap({ ownScriptUrl });
      bridge.dispatch(moduleMessage());

      expect(bridge.importCalls).toEqual([]);
      expect(bridge.startPageBridge).not.toHaveBeenCalled();
      const error = bridge.posted.find((message) => message.kind === 'error');
      expect(error.message).toContain('could not determine its own id');
    }
  });

  it('refuses this extension id when the path is not the bridge module', () => {
    const bridge = loadMainWorldBootstrap();
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
      const bridge = loadMainWorldBootstrap();
      bridge.dispatch(moduleMessage({ url: `chrome-extension://${OWN_EXTENSION_ID}/${path}` }));

      expect(bridge.importCalls).toEqual([]);
    }
  });

  it('pins the extension id character for character, not just the scheme', () => {
    // #85's whole point: a gate that accepted "some chrome-extension host"
    // would import this. Only the id comparison refuses it.
    const nearMissId = `x${OWN_EXTENSION_ID.slice(1)}`;
    const nearMissUrl = `chrome-extension://${nearMissId}/${BRIDGE_MODULE_FILE}`;

    const refused = loadMainWorldBootstrap();
    refused.dispatch(moduleMessage({ url: nearMissUrl }));
    expect(refused.importCalls).toEqual([]);

    // And the refusal is the id pin rather than anything else: the same URL is
    // imported once the script derives that very id for itself.
    const accepted = loadMainWorldBootstrap({
      ownScriptUrl: `chrome-extension://${nearMissId}/src/page-bridge.js`,
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
      const bridge = loadMainWorldBootstrap();
      bridge.dispatch(moduleMessage({ url }));

      expect(bridge.importCalls, `the bootstrap refused ${url}`).toEqual(
        isBridgeModuleUrl(url, OWN_EXTENSION_ID) ? [url] : [],
      );
    }
  });

  it('imports once, so a second signed module message cannot restart the bridge', async () => {
    const bridge = loadMainWorldBootstrap();
    bridge.dispatch(moduleMessage());
    await vi.waitFor(() => {
      expect(bridge.startPageBridge).toHaveBeenCalledTimes(1);
    });

    bridge.dispatch(moduleMessage());

    expect(bridge.importCalls).toEqual([ownModuleUrl]);
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
