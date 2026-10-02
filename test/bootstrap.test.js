import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_MODULE_FILE,
  CONTENT_SOURCE,
  CONTENT_TO_PAGE_KINDS,
  PAGE_SOURCE,
} from '../src/ui/messages.js';

// The two manifest-declared entry scripts are classic scripts: they cannot use
// static imports, so their protocol constants are literals that must stay in
// step with `src/ui/messages.js`. These tests read the real files, so changing a
// tag on one side without the other fails here.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const PAGE_BRIDGE = 'src/page-bridge.js';
const CONTENT = 'src/content.js';

const OWN_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
const FOREIGN_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

// Runs the real `page-bridge.js` body as a classic script against a fake window
// and document. The only edit is swapping the dynamic `import()` for a
// recorder, because a `Function` body cannot have its import target intercepted
// any other way. The harness asserts that swap matched exactly once, so a
// future rewrite that removes the import fails here instead of silently
// passing.
const loadMainWorldBootstrap = ({
  ownScriptUrl = `chrome-extension://${OWN_EXTENSION_ID}/src/page-bridge.js`,
} = {}) => {
  const source = read(PAGE_BRIDGE);
  const marker = 'import(data.url)';
  const matches = source.split(marker).length - 1;
  if (matches !== 1) {
    throw new Error(`expected one dynamic import marker in ${PAGE_BRIDGE}, found ${matches}`);
  }

  const posted = [];
  const importCalls = [];
  const listeners = [];
  const startPageBridge = vi.fn();

  const window = {
    postMessage(message) {
      posted.push(message);
    },
    addEventListener(type, handler) {
      if (type === 'message') listeners.push(handler);
    },
  };
  const document = {
    currentScript: ownScriptUrl === null ? null : { src: ownScriptUrl },
  };
  const importShim = (url) => {
    importCalls.push(url);
    return Promise.resolve({ startPageBridge });
  };

  const run = new Function(
    'window',
    'document',
    'importShim',
    source.replace(marker, 'importShim(data.url)')
  );
  run(window, document, importShim);

  return {
    window,
    posted,
    importCalls,
    startPageBridge,
    dispatch(data) {
      for (const listener of listeners) listener({ data });
    },
  };
};

describe('main-world bootstrap', () => {
  it('uses the message contract tags from messages.js', () => {
    const source = read(PAGE_BRIDGE);
    expect(source).toContain(`'${PAGE_SOURCE}'`);
    expect(source).toContain(`'${CONTENT_SOURCE}'`);
    expect(source).toContain(`'${CONTENT_TO_PAGE_KINDS.BRIDGE_MODULE}'`);
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

  it('imports the bridge module from this extension id and starts it', async () => {
    const bridge = loadMainWorldBootstrap();
    bridge.dispatch({ source: CONTENT_SOURCE, kind: 'bridge-module', url: ownModuleUrl });

    expect(bridge.importCalls).toEqual([ownModuleUrl]);
    await vi.waitFor(() => {
      expect(bridge.startPageBridge).toHaveBeenCalledWith(bridge.window);
    });
  });

  it('refuses a bridge-module URL from another extension and never imports it', () => {
    const bridge = loadMainWorldBootstrap();
    const foreignUrl = `chrome-extension://${FOREIGN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}`;
    bridge.dispatch({ source: CONTENT_SOURCE, kind: 'bridge-module', url: foreignUrl });

    expect(bridge.importCalls).toEqual([]);
    expect(bridge.startPageBridge).not.toHaveBeenCalled();

    const error = bridge.posted.find((message) => message.kind === 'error');
    expect(error.message).toContain(`chrome-extension://${OWN_EXTENSION_ID}/`);
    expect(error.message).toContain(`chrome-extension://${FOREIGN_EXTENSION_ID}`);
    expect(error.message).not.toContain(`chrome-extension://${FOREIGN_EXTENSION_ID}/`);
  });

  it('refuses every bridge-module message when it cannot derive its own id', () => {
    for (const ownScriptUrl of [null, 'https://www.ea.com/src/page-bridge.js']) {
      const bridge = loadMainWorldBootstrap({ ownScriptUrl });
      bridge.dispatch({ source: CONTENT_SOURCE, kind: 'bridge-module', url: ownModuleUrl });

      expect(bridge.importCalls).toEqual([]);
      expect(bridge.startPageBridge).not.toHaveBeenCalled();
      const error = bridge.posted.find((message) => message.kind === 'error');
      expect(error.message).toContain('could not determine its own id');
    }
  });

  it('refuses this extension id when the path is not the bridge module', () => {
    const bridge = loadMainWorldBootstrap();
    bridge.dispatch({
      source: CONTENT_SOURCE,
      kind: 'bridge-module',
      url: `chrome-extension://${OWN_EXTENSION_ID}/src/other.js`,
    });

    expect(bridge.importCalls).toEqual([]);
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
