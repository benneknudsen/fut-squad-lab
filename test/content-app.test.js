import { describe, expect, it, vi } from 'vitest';

import copyDa from '../design/copy.da.json';
import copyEn from '../design/copy.en.json';
import {
  bridgeModuleMessage,
  injectStylesheets,
  loadCopyMessage,
  mintSessionNonce,
  startContentApp,
} from '../src/content-app.js';
import { NONCE_BYTES, formatNonce } from '../src/ui/messages.js';
import { TEST_NONCE, stubCrypto } from './helpers/nonce.js';

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

// The one solver Worker of the session, as the relay sees it: the forge tests
// assert on what it was asked to do, not on whether the relay returned.
const createFakeWorker = () => ({
  posted: [],
  onmessage: null,
  onerror: null,
  onmessageerror: null,
  terminated: 0,
  postMessage(message) {
    this.posted.push(message);
  },
  terminate() {
    this.terminated += 1;
  },
});

const startFakeContentApp = (options = {}) => {
  const fake = createFakeContentWindow(options.document);
  const fakeConsole = { log: vi.fn(), warn: vi.fn() };
  const created = [];
  const workers = [];
  startContentApp({
    window: fake.window,
    document: fake.document,
    chrome: fakeChrome(),
    navigator: options.navigator ?? { language: 'en-GB' },
    fetch: options.fetch ?? fetched(copyEn),
    console: fakeConsole,
    crypto: options.crypto ?? stubCrypto(),
    createWorker: (url) => {
      const worker = createFakeWorker();
      created.push(url);
      workers.push(worker);
      return worker;
    },
  });
  return { ...fake, fakeConsole, created, workers };
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
      nonce: TEST_NONCE,
      kind: 'summary',
      summary: '42 club items via services.UTSBCRepository.getClubItems',
    });
    expect(messages.filter((message) => message.kind === 'bridge-module')).toHaveLength(2);
    expect(fakeConsole.log).toHaveBeenCalledWith(
      '[FUT Squad Lab] 42 club items via services.UTSBCRepository.getClubItems'
    );
  });
});

describe('mintSessionNonce', () => {
  it('mints 16 random bytes and renders them as the hex nonce on the channel', () => {
    const requested = [];
    const crypto = {
      getRandomValues: (array) => {
        requested.push(array.length);
        for (let index = 0; index < array.length; index += 1) array[index] = index * 17;
        return array;
      },
    };

    expect(mintSessionNonce(crypto)).toBe(
      formatNonce(Uint8Array.from({ length: NONCE_BYTES }, (_value, index) => index * 17))
    );
    expect(requested).toEqual([NONCE_BYTES]);
  });

  it('mints per session from crypto, not from a constant in the source', () => {
    const asked = [];
    const recording = (seed) => ({
      getRandomValues: (array) => {
        asked.push({ length: array.length, fresh: [...array] });
        for (let index = 0; index < array.length; index += 1) array[index] = seed + index;
        return array;
      },
    });

    const first = startFakeContentApp({ crypto: recording(0x00) });
    const second = startFakeContentApp({ crypto: recording(0x40) });

    const nonceOf = (relay) =>
      relay.messages.find((message) => message.kind === 'bridge-module').nonce;
    expect(nonceOf(first)).toBe(
      formatNonce(Uint8Array.from({ length: NONCE_BYTES }, (_value, index) => index))
    );
    expect(nonceOf(second)).toBe(
      formatNonce(Uint8Array.from({ length: NONCE_BYTES }, (_value, index) => 0x40 + index))
    );
    // Each session asked crypto for its own 16 uninitialised bytes.
    expect(asked).toHaveLength(2);
    expect(asked[0].fresh).toEqual(new Array(NONCE_BYTES).fill(0));
    expect(asked[1].fresh).toEqual(new Array(NONCE_BYTES).fill(0));
  });

  it('reports a missing crypto instead of falling back to a guessable nonce', () => {
    expect(() => mintSessionNonce(undefined)).toThrow(/getRandomValues/);
    expect(() => mintSessionNonce({})).toThrow(/getRandomValues/);
  });
});

describe('the session nonce on the channel', () => {
  it('signs every message the relay sends, including the proactive ones', async () => {
    const { messages } = startFakeContentApp();

    // The two proactive messages go out before any page message has been seen.
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(message.nonce).toBe(TEST_NONCE);
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'copy')).toBe(true);
    });
    for (const message of messages) expect(message.nonce).toBe(TEST_NONCE);
  });

  it('adds the nonce to the copy message envelope and to nothing else on it', async () => {
    const { messages } = startFakeContentApp();
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'copy')).toBe(true);
    });
    const copy = messages.find((message) => message.kind === 'copy');
    expect(Object.keys(copy).sort()).toEqual(['kind', 'label', 'locale', 'nonce', 'source']);
  });

  it('drops a solve request that forges the source tag without the nonce', () => {
    const { dispatchMessage, messages, created, workers } = startFakeContentApp();

    dispatchMessage({
      source: 'fsl-page',
      kind: 'solve-request',
      token: 1,
      operation: 'solve',
      payload: { pool: [] },
    });

    // The observable effect, not merely that nothing was returned: no solver
    // worker was ever constructed, so the page's payload never reached one.
    expect(created).toEqual([]);
    expect(workers).toEqual([]);
    expect(messages.some((message) => message.kind === 'solve-response')).toBe(false);
    expect(messages.some((message) => message.kind === 'solve-error')).toBe(false);
  });

  it('drops a solve request whose nonce is one character wrong', () => {
    const { dispatchMessage, created } = startFakeContentApp();
    const wrong = `${TEST_NONCE.slice(0, -1)}${TEST_NONCE.endsWith('f') ? 'e' : 'f'}`;

    expect(wrong).not.toBe(TEST_NONCE);
    dispatchMessage({
      source: 'fsl-page',
      nonce: wrong,
      kind: 'solve-request',
      token: 1,
      operation: 'solve',
      payload: { pool: [] },
    });

    expect(created).toEqual([]);
  });

  it('drops a solve request whose nonce is the right type but not a string', () => {
    const { dispatchMessage, created } = startFakeContentApp();
    const asBytes = [...TEST_NONCE].map((character) => character.charCodeAt(0));

    dispatchMessage({
      source: 'fsl-page',
      nonce: asBytes,
      kind: 'solve-request',
      token: 1,
      operation: 'solve',
      payload: { pool: [] },
    });
    dispatchMessage({
      source: 'fsl-page',
      nonce: { value: TEST_NONCE },
      kind: 'solve-request',
      token: 2,
      operation: 'solve',
      payload: { pool: [] },
    });

    expect(created).toEqual([]);
  });

  it('brokers a solve request that carries the session nonce', () => {
    const { dispatchMessage, created, workers } = startFakeContentApp();

    dispatchMessage({
      source: 'fsl-page',
      nonce: TEST_NONCE,
      kind: 'solve-request',
      token: 7,
      operation: 'solve',
      payload: { pool: [1, 2, 3] },
    });

    expect(created).toEqual(['chrome-extension://abc/src/solver/worker.js']);
    // The worker is ours, in our own world: the nonce guards the page channel,
    // not the hop to our own module worker.
    expect(workers[0].posted[0]).toMatchObject({
      kind: 'request',
      operation: 'solve',
      payload: { pool: [1, 2, 3] },
    });
    expect(workers[0].posted[0].nonce).toBeUndefined();
  });

  it('answers a brokered solve with the nonce attached, so the page accepts it', async () => {
    const { dispatchMessage, messages, workers } = startFakeContentApp();
    dispatchMessage({
      source: 'fsl-page',
      nonce: TEST_NONCE,
      kind: 'solve-request',
      token: 3,
      operation: 'solve',
      payload: {},
    });
    const [request] = workers[0].posted;

    workers[0].onmessage({ data: { kind: 'response', id: request.id, result: { squad: [] } } });
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'solve-response')).toBe(true);
    });

    const response = messages.find((message) => message.kind === 'solve-response');
    expect(response).toMatchObject({ source: 'fsl-content', token: 3, nonce: TEST_NONCE });
  });

  it('ignores a forged cancel, so an in-flight Solve is not killed by the page', () => {
    const { dispatchMessage, messages, workers } = startFakeContentApp();
    dispatchMessage({
      source: 'fsl-page',
      nonce: TEST_NONCE,
      kind: 'solve-request',
      token: 9,
      operation: 'solve',
      payload: {},
    });
    const [request] = workers[0].posted;

    dispatchMessage({ source: 'fsl-page', kind: 'solve-cancel', token: 9 });
    dispatchMessage({ source: 'fsl-page', nonce: 'deadbeef', kind: 'solve-cancel', token: 9 });

    // The observable effect: the worker was never told to cancel, and no
    // AbortError was faked back to the page to make it look like it had.
    expect(workers[0].posted).toEqual([request]);
    expect(workers[0].terminated).toBe(0);
    expect(messages.some((message) => message.kind === 'solve-error')).toBe(false);
  });

  it('cancels the worker for a cancel that carries the session nonce', () => {
    const { dispatchMessage, workers } = startFakeContentApp();
    dispatchMessage({
      source: 'fsl-page',
      nonce: TEST_NONCE,
      kind: 'solve-request',
      token: 9,
      operation: 'solve',
      payload: {},
    });
    const [request] = workers[0].posted;

    dispatchMessage({ source: 'fsl-page', nonce: TEST_NONCE, kind: 'solve-cancel', token: 9 });

    expect(workers[0].posted).toContainEqual({ kind: 'cancel', id: request.id });
  });

  it('ignores a forged summary and a forged diagnostics block', () => {
    const { document, root } = createFakePanelDocument();
    const { dispatchMessage, fakeConsole } = startFakeContentApp({ document });

    dispatchMessage({ source: 'fsl-page', kind: 'summary', summary: 'forged read summary' });
    dispatchMessage({ source: 'fsl-page', nonce: 'nope', kind: 'summary', summary: 'forged' });
    dispatchMessage({
      source: 'fsl-page',
      kind: 'diagnostics',
      block: 'forged diagnostics block',
      file: 'forged.json',
      download: { ok: true, file: 'forged.json' },
    });

    expect(fakeConsole.log).not.toHaveBeenCalled();
    expect(root.children).toEqual([]);
  });

  it('answers the unsigned bridge hello, because that is how the nonce arrives', () => {
    const { dispatchMessage, messages } = startFakeContentApp();
    const before = messages.filter((message) => message.kind === 'bridge-module').length;

    // The classic MAIN-world bootstrap runs at document_start and has no nonce
    // of its own yet, so the hello is the one message it may send unsigned. The
    // reply carries the nonce, which is how the two worlds end up sharing one.
    dispatchMessage({ source: 'fsl-page', kind: 'bridge-hello' });

    const replies = messages.filter((message) => message.kind === 'bridge-module');
    expect(replies).toHaveLength(before + 1);
    expect(replies.at(-1).nonce).toBe(TEST_NONCE);
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
    nonce: TEST_NONCE,
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

    dispatchMessage({ source: 'fsl-page', nonce: TEST_NONCE, kind: 'diagnostics', file: FILE });

    expect(fakeConsole.log).not.toHaveBeenCalled();
  });
});
