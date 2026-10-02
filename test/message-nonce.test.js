import { describe, expect, it, vi } from 'vitest';

import copyEn from '../design/copy.en.json';
import { startContentApp } from '../src/content-app.js';
import { BRIDGE_MODULE_FILE, CONTENT_SOURCE, PAGE_SOURCE } from '../src/ui/messages.js';
import {
  FOREIGN_EXTENSION_ID,
  OWN_EXTENSION_ID,
  loadMainWorldBootstrap,
} from './helpers/bootstrap.js';
import { TEST_NONCE, stubCrypto } from './helpers/nonce.js';

// #88: the handshake itself, end to end and in both orders, with the real
// classic bootstrap, the real isolated relay and the real MAIN-world module on
// one fake `window`. A nonce that either world fails to require, or to attach,
// deadlocks one of these two orders or admits a forgery, so this is where that
// shows up.

const OWN_MODULE_URL = `chrome-extension://${OWN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}`;

/**
 * One `window` for both worlds. `postMessage` queues instead of delivering, and
 * `settle` drains the queue to every listener until the channel is quiet, which
 * is what a real page does — a message posted before a listener exists is lost,
 * not buffered, and that loss is the whole reason the handshake has to survive
 * both orders.
 */
const createChannel = () => {
  const listeners = [];
  const queue = [];
  const seen = [];

  const window = {
    console: { log() {}, warn() {}, info() {}, group() {}, groupEnd() {} },
    postMessage(message) {
      queue.push(structuredClone(message));
    },
    addEventListener(type, handler) {
      if (type === 'message') listeners.push(handler);
    },
    // The MAIN-world module polls for EA's panel class. This harness is about the
    // channel, so the poll never fires: nothing here needs a panel.
    setInterval() {
      return 1;
    },
    clearInterval() {},
  };
  const document = { createElement: () => ({}), head: { appendChild() {} } };

  const drain = () => {
    const batch = queue.splice(0, queue.length);
    for (const message of batch) {
      seen.push(message);
      for (const handler of [...listeners]) handler({ data: message, source: window });
    }
  };

  return {
    window,
    document,
    seen,
    // A hostile page script, on the same window, with the same listener list.
    post: (message) => queue.push(structuredClone(message)),
    settle: async () => {
      for (let round = 0; round < 8; round += 1) {
        drain();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      drain();
    },
  };
};

const startRelay = (channel) =>
  startContentApp({
    window: channel.window,
    document: channel.document,
    // The same extension id the bootstrap derives from its own script URL: the
    // relay has to hand out this extension's module URL or #85's gate refuses it.
    chrome: { runtime: { getURL: (path) => `chrome-extension://${OWN_EXTENSION_ID}/${path}` } },
    navigator: { language: 'en-GB' },
    fetch: async (url) => ({ ok: true, status: 200, url, json: async () => copyEn }),
    console: { log() {}, warn() {} },
    crypto: stubCrypto(),
  });

/** Loads the real MAIN-world module, recording the options it was started with. */
const realBridgeModule = (started) => async () => {
  const module = await import('../src/page-bridge-app.js');
  return {
    startPageBridge: (pageWindow, options) => {
      started.push(options);
      return module.startPageBridge(pageWindow, options);
    },
  };
};

const handshake = async ({ order }) => {
  const channel = createChannel();
  const started = [];
  const startBootstrap = () =>
    loadMainWorldBootstrap({
      importModule: realBridgeModule(started),
      window: channel.window,
      document: channel.document,
    });

  // Whichever side starts first delivers its first message to a window that has
  // no listener for it yet, so that message is lost. Both orders still have to
  // converge: the relay announces the module URL on its own, and the MAIN world
  // asks again with its unsigned hello, which the relay answers.
  let bridge;
  if (order === 'main-world-first') {
    bridge = startBootstrap();
    await channel.settle();
    startRelay(channel);
  } else {
    startRelay(channel);
    await channel.settle();
    bridge = startBootstrap();
  }
  await channel.settle();
  return { channel, bridge, started };
};

describe('the cross-world handshake converges in both orders', () => {
  for (const order of ['main-world-first', 'relay-first']) {
    it(`starts the bridge module with the relay's nonce when the ${order} starts`, async () => {
      const { bridge, started } = await handshake({ order });

      expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
      // The import is dynamic, so the module is started a tick later.
      await vi.waitFor(() => {
        expect(started).toEqual([{ nonce: TEST_NONCE }]);
      });
    });

    it(`has both worlds signing every message when the ${order} starts`, async () => {
      const { channel } = await handshake({ order });

      const fromRelay = channel.seen.filter((message) => message.source === CONTENT_SOURCE);
      const fromPage = channel.seen.filter((message) => message.source === PAGE_SOURCE);
      expect(fromRelay.length).toBeGreaterThan(0);
      expect(fromPage.length).toBeGreaterThan(0);
      for (const message of [...fromRelay, ...fromPage]) {
        // The bootstrap's own hello is the one message that cannot be signed: it
        // is what asks for the nonce. Everything after it is signed.
        if (message.kind === 'bridge-hello' && message.nonce === undefined) continue;
        expect(message.nonce).toBe(TEST_NONCE);
      }
    });
  }

  it('answers the unsigned hello, so the relay-first order is not lost', async () => {
    const { bridge, channel } = await handshake({ order: 'relay-first' });

    // The relay's own signed module message went out before the bootstrap's
    // listener existed, so the unsigned hello is the only thing that can bring
    // the module across. If the relay stopped answering it, the import above
    // would never happen.
    expect(channel.seen.some((message) => message.kind === 'bridge-hello' && message.nonce === undefined)).toBe(true);
    expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
  });

  it('ignores a hostile script that forges the handshake from the same window', async () => {
    const channel = createChannel();
    const started = [];
    // A page script that posts a bridge-module URL of its own before the relay
    // has said anything: #85's id pin and #88's nonce requirement are two
    // independent reasons this cannot take over the channel.
    channel.post({
      source: CONTENT_SOURCE,
      kind: 'bridge-module',
      nonce: 'a-nonce-the-page-chose',
      url: `chrome-extension://${FOREIGN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}`,
    });
    startRelay(channel);
    const bridge = loadMainWorldBootstrap({
      importModule: realBridgeModule(started),
      window: channel.window,
      document: channel.document,
    });
    await channel.settle();

    // The real relay won the channel: the module was imported once, from this
    // extension, with the relay's nonce and not the page's.
    expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
    await vi.waitFor(() => {
      expect(started).toEqual([{ nonce: TEST_NONCE }]);
    });
  });
});
