import { describe, expect, it, vi } from 'vitest';

import copyDa from '../design/copy.da.json';
import copyEn from '../design/copy.en.json';
import { bridgeModuleMessage, injectStylesheets, loadCopyMessage, startContentApp } from '../src/content-app.js';

const fakeChrome = () => ({
  runtime: { getURL: (path) => `chrome-extension://abc/${path}` },
});

const fetched = (bundle) => async (url) => ({
  ok: true,
  status: 200,
  url,
  json: async () => bundle,
});

describe('bridgeModuleMessage', () => {
  it('points the MAIN-world loader at this extension bridge module', () => {
    expect(bridgeModuleMessage(fakeChrome())).toEqual({
      source: 'fsl-content',
      kind: 'bridge-module',
      url: 'chrome-extension://abc/src/page-bridge-app.js',
    });
  });
});

describe('loadCopyMessage', () => {
  it('loads the Danish bundle for a da-DK browser and returns panel.solve', async () => {
    const message = await loadCopyMessage({
      chrome: fakeChrome(),
      navigator: { language: 'da-DK' },
      fetch: fetched(copyDa),
    });
    expect(message).toEqual({
      source: 'fsl-content',
      kind: 'copy',
      locale: 'da',
      label: 'Løs denne udfordring',
    });
  });

  it('loads the English bundle for en-GB and for an unknown locale', async () => {
    const enGb = await loadCopyMessage({
      chrome: fakeChrome(),
      navigator: { language: 'en-GB' },
      fetch: fetched(copyEn),
    });
    const unknown = await loadCopyMessage({
      chrome: fakeChrome(),
      navigator: { language: 'pt-BR' },
      fetch: fetched(copyEn),
    });
    expect(enGb.label).toBe('Solve this challenge');
    expect(unknown).toEqual({
      source: 'fsl-content',
      kind: 'copy',
      locale: 'en',
      label: 'Solve this challenge',
    });
  });

  it('fails loudly naming the bundle when the fetch does not succeed', async () => {
    await expect(
      loadCopyMessage({
        chrome: fakeChrome(),
        navigator: { language: 'en-GB' },
        fetch: async () => ({ ok: false, status: 404 }),
      })
    ).rejects.toThrow(/copy\.en\.json/);
  });
});

describe('injectStylesheets', () => {
  it('appends the contract tokens and the component styles as extension links', () => {
    const links = [];
    const document = {
      createElement: (tagName) => {
        expect(tagName).toBe('link');
        return { rel: '', href: '' };
      },
      head: { appendChild: (node) => links.push(node) },
    };
    injectStylesheets(document, fakeChrome());
    expect(links.map((link) => link.rel)).toEqual(['stylesheet', 'stylesheet']);
    expect(links.map((link) => link.href)).toEqual([
      'chrome-extension://abc/design/tokens.css',
      'chrome-extension://abc/src/ui/styles.css',
    ]);
  });
});

const createFakeContentWindow = (document = undefined) => {
  const messages = [];
  const listeners = [];
  const window = {
    postMessage(message) {
      messages.push(message);
    },
    addEventListener(type, handler) {
      if (type === 'message') listeners.push(handler);
    },
  };
  const doc = document ?? {
    createElement: () => ({ rel: '', href: '' }),
    head: { appendChild: () => {} },
  };
  return {
    window,
    document: doc,
    messages,
    dispatchMessage(data, source = window) {
      for (const listener of listeners) listener({ data, source });
    },
  };
};

const startFakeContentApp = (options = {}) => {
  const fake = createFakeContentWindow(options.document);
  const fakeConsole = { log: vi.fn(), warn: vi.fn() };
  startContentApp({
    window: fake.window,
    document: fake.document,
    chrome: fakeChrome(),
    navigator: options.navigator ?? { language: 'en-GB' },
    fetch: options.fetch ?? fetched(copyEn),
    console: fakeConsole,
  });
  return { ...fake, fakeConsole };
};

describe('startContentApp message listener', () => {
  it('ignores a summary and a bridge hello posted by a foreign frame', () => {
    const { dispatchMessage, messages, fakeConsole } = startFakeContentApp();
    dispatchMessage(
      {
        source: 'fsl-page',
        kind: 'summary',
        summary: '42 club items via services.UTSBCRepository.getClubItems',
      },
      {}
    );
    dispatchMessage({ source: 'fsl-page', kind: 'bridge-hello' }, {});
    expect(fakeConsole.log).not.toHaveBeenCalled();
    expect(messages.filter((message) => message.kind === 'bridge-module')).toHaveLength(1);
  });

  it('accepts a summary and a bridge hello from its own window', () => {
    const { dispatchMessage, messages, fakeConsole } = startFakeContentApp();
    dispatchMessage({ source: 'fsl-page', kind: 'bridge-hello' });
    dispatchMessage({
      source: 'fsl-page',
      kind: 'summary',
      summary: '42 club items via services.UTSBCRepository.getClubItems',
    });
    expect(messages.filter((message) => message.kind === 'bridge-module')).toHaveLength(2);
    expect(fakeConsole.log).toHaveBeenCalledWith(
      '[FUT Squad Lab] 42 club items via services.UTSBCRepository.getClubItems'
    );
  });
});

const createFakePanelDocument = () => {
  const root = {
    className: 'fsl-root',
    children: [],
    querySelector(selector) {
      if (selector !== '[data-fsl-diagnostics]') {
        throw new Error(`unexpected selector ${selector}`);
      }
      return (
        this.children.find((child) => Object.hasOwn(child.attributes, 'data-fsl-diagnostics')) ?? null
      );
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
  };
  const document = {
    createElement: (tagName) => ({
      tagName: tagName.toUpperCase(),
      className: '',
      textContent: '',
      attributes: {},
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
      },
    }),
    head: { appendChild: () => {} },
    querySelector: (selector) => (selector === '.fsl-root' ? root : null),
  };
  return { document, root };
};

describe('startContentApp diagnostics relay', () => {
  const FILE = 'fsl-diagnostics-fsl-build-11-2026-09-27.json';
  const BLOCK =
    '=== FUT Squad Lab diagnostics (fsl-diagnostics/1, fsl-build/11) — copy from here ===\n' +
    '{"schema":"fsl-diagnostics/1"}\n' +
    '=== end FUT Squad Lab diagnostics ===';
  const relayed = (file = FILE, download = { ok: true, file }) => ({
    source: 'fsl-page',
    kind: 'diagnostics',
    block: BLOCK,
    file,
    download,
  });

  it('logs the relayed block verbatim once and states the written file in the panel', async () => {
    const { document, root } = createFakePanelDocument();
    const { dispatchMessage, fakeConsole, messages } = startFakeContentApp({ document });
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'copy')).toBe(true);
    });

    dispatchMessage(relayed());

    expect(fakeConsole.log).toHaveBeenCalledTimes(1);
    expect(fakeConsole.log).toHaveBeenCalledWith(BLOCK);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].textContent).toBe(`Diagnostics saved to ${FILE}`);
    expect(root.children[0].getAttribute('role')).toBe('status');
    expect(root.children[0].getAttribute('data-fsl-diagnostics')).not.toBeNull();
  });

  it('uses the Danish panel line for a Danish browser', async () => {
    const { document, root } = createFakePanelDocument();
    const { dispatchMessage, messages } = startFakeContentApp({
      document,
      navigator: { language: 'da-DK' },
      fetch: fetched(copyDa),
    });
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'copy')).toBe(true);
    });

    dispatchMessage(relayed());

    expect(root.children[0].textContent).toBe(`Diagnostik gemt i ${FILE}`);
  });

  it('names a blocked write in the panel instead of claiming a file exists', async () => {
    const { document, root } = createFakePanelDocument();
    const { dispatchMessage, fakeConsole, messages } = startFakeContentApp({ document });
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'copy')).toBe(true);
    });

    dispatchMessage(
      relayed(null, { ok: false, reason: 'the page has no Blob constructor' })
    );

    expect(fakeConsole.log).toHaveBeenCalledWith(BLOCK);
    expect(root.children).toHaveLength(1);
    expect(root.children[0].textContent).toBe('Diagnostics file could not be saved');
  });

  it('reuses one panel note when a second Solve writes a second file', async () => {
    const { document, root } = createFakePanelDocument();
    const { dispatchMessage, messages } = startFakeContentApp({ document });
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'copy')).toBe(true);
    });

    dispatchMessage(relayed('fsl-diagnostics-fsl-build-11-2026-09-27.json'));
    dispatchMessage(relayed('fsl-diagnostics-fsl-build-11-2026-09-28.json'));

    expect(root.children).toHaveLength(1);
    expect(root.children[0].textContent).toBe(
      'Diagnostics saved to fsl-diagnostics-fsl-build-11-2026-09-28.json'
    );
  });

  it('logs the block but states nothing in the panel when the Solve did not attempt a download', async () => {
    const { document, root } = createFakePanelDocument();
    const { dispatchMessage, fakeConsole, messages } = startFakeContentApp({ document });
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'copy')).toBe(true);
    });

    dispatchMessage(relayed(null, null));

    expect(fakeConsole.log).toHaveBeenCalledWith(BLOCK);
    expect(root.children).toHaveLength(0);
    expect(fakeConsole.warn).not.toHaveBeenCalled();
  });

  it('ignores a diagnostics message from a foreign frame', () => {
    const { document, root } = createFakePanelDocument();
    const { dispatchMessage, fakeConsole } = startFakeContentApp({ document });

    dispatchMessage(relayed(), {});

    expect(fakeConsole.log).not.toHaveBeenCalled();
    expect(root.children).toHaveLength(0);
  });

  it('does not log a diagnostics message that carries no block text', () => {
    const { document } = createFakePanelDocument();
    const { dispatchMessage, fakeConsole } = startFakeContentApp({ document });

    dispatchMessage({ source: 'fsl-page', kind: 'diagnostics', file: FILE });

    expect(fakeConsole.log).not.toHaveBeenCalled();
  });
});
