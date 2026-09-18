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

const createFakeContentWindow = () => {
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
  const document = {
    createElement: () => ({ rel: '', href: '' }),
    head: { appendChild: () => {} },
  };
  return {
    window,
    document,
    messages,
    dispatchMessage(data, source = window) {
      for (const listener of listeners) listener({ data, source });
    },
  };
};

const startFakeContentApp = () => {
  const fake = createFakeContentWindow();
  const fakeConsole = { log: vi.fn(), warn: vi.fn() };
  startContentApp({
    window: fake.window,
    document: fake.document,
    chrome: fakeChrome(),
    navigator: { language: 'en-GB' },
    fetch: fetched(copyEn),
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
