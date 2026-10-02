/**
 * Runs the real `src/page-bridge.js` body as a classic script against a fake
 * window and document.
 *
 * The only edit is swapping the dynamic `import()` for a recorder, because a
 * `Function` body cannot have its import target intercepted any other way. The
 * harness asserts that swap matched exactly once, so a future rewrite that
 * removes the import fails here instead of silently passing. `importModule`
 * decides what the recorder resolves to: the default is a stub that only records
 * that `startPageBridge` was called, and a test that wants the real MAIN-world
 * module hands in a real dynamic `import()`. Passing `window` and `document`
 * runs the body against a shared fake the caller owns, which is how the two
 * worlds get onto one channel.
 */

import { readFileSync } from 'node:fs';
import { vi } from 'vitest';

const PAGE_BRIDGE = 'src/page-bridge.js';

export const OWN_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const FOREIGN_EXTENSION_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';

export const readRepoFile = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

export const loadMainWorldBootstrap = ({
  ownScriptUrl = `chrome-extension://${OWN_EXTENSION_ID}/${PAGE_BRIDGE}`,
  importModule,
  window: targetWindow,
  document: targetDocument,
} = {}) => {
  const source = readRepoFile(PAGE_BRIDGE);
  const marker = 'import(data.url)';
  const matches = source.split(marker).length - 1;
  if (matches !== 1) {
    throw new Error(`expected one dynamic import marker in ${PAGE_BRIDGE}, found ${matches}`);
  }

  const posted = [];
  const importCalls = [];
  const listeners = [];
  const warned = [];
  const startPageBridge = vi.fn();

  // A test that wires both worlds onto one shared `window` passes it in; one
  // that only exercises the bootstrap gets a fake of its own.
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
    window.console = { warn: (line) => warned.push(line) };
  } else {
    const inner = window.console ?? {};
    window.console = {
      ...inner,
      warn: (line) => {
        warned.push(line);
        inner.warn?.(line);
      },
    };
    window.addEventListener('message', (handler) => listeners.push(handler));
  }
  const document = targetDocument ?? {
    currentScript: ownScriptUrl === null ? null : { src: ownScriptUrl },
  };
  if (targetDocument !== undefined) {
    Object.defineProperty(document, 'currentScript', {
      configurable: true,
      value: ownScriptUrl === null ? null : { src: ownScriptUrl },
    });
  }
  const importShim = (url) => {
    importCalls.push(url);
    return importModule === undefined
      ? Promise.resolve({ startPageBridge })
      : importModule(url);
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
    warned,
    importCalls,
    startPageBridge,
    dispatch(data) {
      for (const listener of [...listeners]) listener({ data });
    },
  };
};
