import { describe, expect, it, vi } from 'vitest';

import {
  BRIDGE_MODULE_FILE,
  CONTENT_SOURCE,
  NONCE_FIELD,
  PAGE_SOURCE,
} from '../src/ui/messages.js';
import {
  FOREIGN_EXTENSION_ID,
  OWN_EXTENSION_ID,
  OWN_MODULE_URL,
  startUnidentifiedLoader,
} from './helpers/bootstrap.js';
import { TEST_NONCE } from './helpers/nonce.js';
import { createChannel, startLoader, startRelay } from './helpers/channel.js';

// #88: the handshake itself, end to end, with the real classic bootstrap, the real
// isolated relay and the real MAIN-world module on one fake `window` — which is
// `test/helpers/channel.js`, shared with the boot-log tests. A nonce that either
// world fails to require, or to attach, deadlocks the handshake or admits a
// forgery, so this is where that shows up.
//
// #105 gives the handshake exactly one possible order: the relay boots, injects the
// MAIN-world loader, and the browser evaluates that element on a later turn. The
// loader cannot exist before the relay, so "which world starts first" is no longer
// a question with two answers — what is left is the message the loader never
// receives, because it was posted before there was a listener for it.

const FOREIGN_MODULE_URL = `chrome-extension://${FOREIGN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}`;

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

/**
 * Production order, once: the relay boots and injects the loader, the browser
 * evaluates the injected element, and the loader's own hello is what brings the
 * module across. `options.identifiable` runs the body in a document that was
 * never injected into, which is what a manifest-declared MAIN-world content
 * script gets and what #105 was about.
 */
const handshake = async ({ identifiable = true } = {}) => {
  const channel = createChannel();
  const started = [];
  startRelay(channel);

  const bridge = identifiable
    ? startLoader(channel, { importModule: realBridgeModule(started) })
    : startUnidentifiedLoader({
        document: channel.document,
        window: channel.window,
        importModule: realBridgeModule(started),
      });

  await channel.settle();
  return { channel, bridge, started };
};

describe('the cross-world handshake', () => {
  it('starts the bridge module with the relay nonce after the relay injects the loader', async () => {
    const { bridge, started } = await handshake();

    expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
    // The import is dynamic, so the module is started a tick later.
    await vi.waitFor(() => {
      expect(started).toEqual([{ nonce: TEST_NONCE }]);
    });
  });

  it('has both worlds signing every message', async () => {
    const { channel } = await handshake();

    const fromRelay = channel.seen.filter((message) => message.source === CONTENT_SOURCE);
    const fromPage = channel.seen.filter((message) => message.source === PAGE_SOURCE);
    expect(fromRelay.length).toBeGreaterThan(0);
    expect(fromPage.length).toBeGreaterThan(0);
    for (const message of [...fromRelay, ...fromPage]) {
      // The loader's own hello is the one message that cannot be signed: it is
      // what asks for the nonce. Everything after it is signed.
      if (message.kind === 'bridge-hello' && message.nonce === undefined) continue;
      expect(message.nonce).toBe(TEST_NONCE);
    }
  });

  it('loses the relay first message and recovers through the loader hello', async () => {
    // The relay announces the module URL before the loader's element has been
    // evaluated, so that message is dispatched with nothing listening. The
    // unsigned hello is the only thing that can bring the module across: if the
    // relay stopped answering it, the import above would never happen.
    const channel = createChannel();
    const started = [];
    startRelay(channel);
    channel.drain();
    expect(channel.seen.some((message) => message.kind === 'bridge-module')).toBe(true);

    const bridge = startLoader(channel, { importModule: realBridgeModule(started) });
    await channel.settle();

    expect(channel.seen.some((message) => message.kind === 'bridge-hello' && message.nonce === undefined)).toBe(true);
    expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
    await vi.waitFor(() => {
      expect(started).toEqual([{ nonce: TEST_NONCE }]);
    });
  });

  it('refuses every module message when the document never injected the loader', async () => {
    // #105: the failure Benjamin hit on fsl-build/13. Without a `<script>` element
    // of its own the loader cannot resolve this extension's id, so it refuses the
    // relay's own URL — and says so in the console rather than failing silently.
    const { channel, bridge, started } = await handshake({ identifiable: false });

    expect(bridge.importCalls).toEqual([]);
    expect(started).toEqual([]);
    const errors = channel.seen.filter(
      (message) => message.source === PAGE_SOURCE && message.kind === 'error',
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(error.message).toContain('could not determine its own id');
    }
  });
});

describe('a page script that observes the channel', () => {
  /**
   * A page script with a listener on the same `window`, which is what every script
   * on the page can have. It reads the session nonce and this extension's id off
   * the relay's own message, because both travel in the clear on one shared
   * channel — #88 says so outright: the nonce is a capability, not a secret.
   */
  const plantSpy = (channel) => {
    const observed = [];
    channel.observe((event) => observed.push(event.data));
    return observed;
  };

  const harvested = (observed) => ({
    nonce: observed.find((message) => typeof message.nonce === 'string')?.nonce,
    url: observed.find((message) => message.kind === 'bridge-module')?.url,
  });

  it('cannot make the loader import a URL from another extension', async () => {
    const channel = createChannel();
    const started = [];
    const observed = plantSpy(channel);
    startRelay(channel);
    // The relay's first announcement is dispatched with nothing listening — the
    // loader does not exist yet. A page script that is on the channel is exactly
    // as entitled to what was posted as it is to what comes next.
    channel.drain();

    const { nonce, url } = harvested(observed);
    expect(nonce).toBe(TEST_NONCE);
    expect(url).toBe(OWN_MODULE_URL);

    // Two forgeries, both carrying a nonce this page read off the wire and a
    // claimed extension id to go with it: the id of the attacker, and this
    // extension's own. Either would be enough if the gate took the message's word
    // for which extension it came from.
    for (const claimedId of [FOREIGN_EXTENSION_ID, OWN_EXTENSION_ID]) {
      channel.post({
        source: CONTENT_SOURCE,
        kind: 'bridge-module',
        nonce,
        url: FOREIGN_MODULE_URL,
        extensionId: claimedId,
      });
    }

    const bridge = startLoader(channel, { importModule: realBridgeModule(started) });
    await channel.settle();

    // The gate compared the URL against the id its own script element carried, so
    // neither forgery was imported. `importCalls` is the whole claim: had either
    // been taken, this would be the foreign URL and not this extension's.
    expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
    expect(bridge.importCalls).not.toContain(FOREIGN_MODULE_URL);
    await vi.waitFor(() => {
      expect(started).toEqual([{ nonce: TEST_NONCE }]);
    });
    // Refused, and visibly: both refusals name the origin they refused, and they
    // say which URL they were waiting for instead. They reach the page console
    // through the shared window, so they are read off the channel.
    const refusals = channel.seen
      .filter((message) => message.source === PAGE_SOURCE && message.kind === 'error')
      .map((message) => message.message);
    expect(refusals).toEqual([
      `refused bridge module URL chrome-extension://${FOREIGN_EXTENSION_ID}; ` +
        `expected chrome-extension://${OWN_EXTENSION_ID}/src/page-bridge-app.js`,
      `refused bridge module URL chrome-extension://${FOREIGN_EXTENSION_ID}; ` +
        `expected chrome-extension://${OWN_EXTENSION_ID}/src/page-bridge-app.js`,
    ]);
  });

  // Named for what it actually proves: the loader refuses a foreign-extension URL.
  // It does not prove the loader cannot be taken over at all — see the own-URL
  // replay case below for the honest limit.
  it('still refuses a foreign-extension URL when it forges before the loader exists', async () => {
    const channel = createChannel();
    const started = [];
    channel.post({
      source: CONTENT_SOURCE,
      kind: 'bridge-module',
      // No nonce has ever been minted here, so this is a guess.
      nonce: 'a-nonce-the-page-chose',
      url: FOREIGN_MODULE_URL,
    });
    startRelay(channel);
    const bridge = startLoader(channel, { importModule: realBridgeModule(started) });
    await channel.settle();

    // The real relay won the channel: the module was imported once, from this
    // extension, with the relay's nonce and not the page's.
    expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
    await vi.waitFor(() => {
      expect(started).toEqual([{ nonce: TEST_NONCE }]);
    });
  });

  it('documents the honest limit: an own-URL replay with an attacker nonce takes the channel over', async () => {
    // #105: the loader accepts any non-empty nonce (#88 checks shape only), and the
    // module URL is derivable from the injected element's `src`. A page script that
    // wins the evaluation race can therefore start the bridge with a nonce it chose
    // and deadlock the real handshake. This is bounded — #88 already puts the real
    // nonce on the wire, so a channel observer has equivalent power without racing,
    // and the only delta is a handshake DoS — but it is a real limit, and the test
    // above must not be read as claiming otherwise.
    const channel = createChannel();
    const started = [];
    channel.post({
      source: CONTENT_SOURCE,
      kind: 'bridge-module',
      url: OWN_MODULE_URL,
      nonce: 'attacker-chosen-nonce',
    });
    // The relay injects the loader and posts its own handshake; the page's forged
    // message is already in the queue, so it is delivered first.
    startRelay(channel);
    const bridge = startLoader(channel, { importModule: realBridgeModule(started) });
    await channel.settle();
    // The attacker's message was queued first, so it is delivered before the relay's
    // own. The loader accepts it and never sees the real handshake.
    expect(bridge.importCalls).toEqual([OWN_MODULE_URL]);
    await vi.waitFor(() => {
      expect(started).toEqual([{ nonce: 'attacker-chosen-nonce' }]);
    });
  });

  it('leaves the nonce unreadable by anything that is not on the channel', () => {
    // The negative twin: a message the relay never signed is a message no listener
    // on this window acts on, which is what the nonce requirement buys for the
    // orders a page script cannot observe.
    const channel = createChannel();
    const observed = plantSpy(channel);
    startRelay(channel);
    channel.drain();
    channel.post({ source: PAGE_SOURCE, kind: 'summary', summary: 'forged' });
    channel.drain();

    const relayed = observed.filter((message) => message.source === CONTENT_SOURCE);
    expect(relayed.length).toBeGreaterThan(0);
    for (const message of relayed) expect(message[NONCE_FIELD]).toBe(TEST_NONCE);
  });
});
