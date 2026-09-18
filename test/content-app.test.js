import { describe, expect, it } from 'vitest';

import copyDa from '../design/copy.da.json';
import copyEn from '../design/copy.en.json';
import { bridgeModuleMessage, injectStylesheets, loadCopyMessage } from '../src/content-app.js';

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
