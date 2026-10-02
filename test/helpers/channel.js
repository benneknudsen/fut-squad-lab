/**
 * One fake `window` with both extension worlds on it, so a test can read the
 * boot log the real code actually writes instead of asserting on each module's
 * calls in isolation.
 *
 * `postMessage` queues instead of delivering and `settle` drains the queue to
 * every listener. A browser queues a dispatch task, so a listener attached in the
 * same task still receives the message — the queue holds it until drained, it does
 * not drop it. That is the realistic model and what this harness does; a listener
 * added after `settle` genuinely sees nothing.
 *
 * The console is one object both worlds are given — the relay through its
 * `console` option, the MAIN world through `window.console` — so a single
 * ordered list of lines is the page's real console, in the order they happened.
 */

import { vi } from 'vitest';

import copyEn from '../../design/copy.en.json';
import { startContentApp } from '../../src/content-app.js';
import { BRIDGE_MODULE_FILE } from '../../src/ui/messages.js';
import { OWN_EXTENSION_ID, loadMainWorldBootstrap } from './bootstrap.js';
import { stubCrypto } from './nonce.js';

/** A plain-object DOM node, the same shape the other bridge tests use. */
export const createFakeNode = (tagName = 'div') => {
  const node = {
    tagName: tagName.toUpperCase(),
    className: '',
    textContent: '',
    type: '',
    attributes: {},
    children: [],
    parentNode: null,
    listeners: [],
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      this.listeners.push({ type, handler });
    },
    click() {
      for (const listener of this.listeners) {
        if (listener.type === 'click') listener.handler({ type: 'click' });
      }
    },
    querySelector(selector) {
      if (selector !== '[data-fsl-solve-button]') throw new Error(`unexpected selector ${selector}`);
      const scan = (candidate) => {
        if (Object.hasOwn(candidate.attributes, 'data-fsl-solve-button')) return candidate;
        for (const child of candidate.children) {
          const match = scan(child);
          if (match !== null) return match;
        }
        return null;
      };
      return scan(this);
    },
  };
  return node;
};

/**
 * @param {{ withController?: boolean, withHook?: boolean }} options
 *   `withController: false` leaves EA's panel class off the page window (the
 *   hook times out); `withHook: false` exposes the class without the method the
 *   bridge patches (the hook is refused)
 * @returns {object} the shared page world plus what the test asserts on
 */
export const createChannel = ({ withController = true, withHook = true } = {}) => {
  const view = createFakeNode('section');
  const listeners = [];
  const queue = [];
  const seen = [];
  const logged = [];
  const warned = [];

  function UTSBCSquadDetailPanelViewController() {
    this.view = view;
  }
  const eaPanelHook = function (subject) {
    this.subject = subject;
    return 'original result';
  };
  if (withHook) {
    UTSBCSquadDetailPanelViewController.prototype.initWithSBCSet = eaPanelHook;
  }

  const document = {
    body: createFakeNode('body'),
    createElement: (tagName) => createFakeNode(tagName),
    head: { appendChild: () => {} },
  };

  const consoleStub = {
    log: vi.fn((...args) => logged.push(args.join(' '))),
    warn: vi.fn((...args) => warned.push(args.join(' '))),
    info: vi.fn(),
    group: vi.fn(),
    groupEnd: vi.fn(),
  };

  const window = {
    document,
    console: consoleStub,
    // EA's club read, so the observer has a method worth wrapping.
    services: { UTSBCRepository: { getClubItems: async () => ({ items: [] }) } },
    postMessage(message) {
      queue.push(structuredClone(message));
    },
    addEventListener(type, handler) {
      if (type === 'message') listeners.push(handler);
    },
    setInterval(handler, ms) {
      return setInterval(handler, ms);
    },
    clearInterval(id) {
      clearInterval(id);
    },
  };
  if (withController) window.UTSBCSquadDetailPanelViewController = UTSBCSquadDetailPanelViewController;

  const drain = () => {
    for (const message of queue.splice(0, queue.length)) {
      seen.push(message);
      for (const handler of [...listeners]) handler({ data: message, source: window });
    }
  };

  return {
    window,
    document,
    view,
    eaPanelHook,
    console: consoleStub,
    logged,
    warned,
    seen,
    /** Queues a message as if a page script posted it to the same channel. */
    post: (message) => queue.push(structuredClone(message)),
    drain,
    settle: async () => {
      for (let round = 0; round < 8; round += 1) {
        drain();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      drain();
    },
    /** Runs EA's own panel entry point, which is what mounts the button. */
    openPanel: () => {
      const controller = new window.UTSBCSquadDetailPanelViewController();
      controller.initWithSBCSet({ challengeId: 25, name: 'A Challenge', elgReq: [] });
      return controller;
    },
    /** The mounted Solve button, or `null` when nothing was mounted. */
    mountedButton: () => view.children[0]?.children[0]?.children[0] ?? null,
  };
};

/** Starts the isolated relay on the shared window, with a known session nonce. */
export const startRelay = (channel) =>
  startContentApp({
    window: channel.window,
    document: channel.document,
    // The extension id the classic loader derives for itself, so the module URL
    // the relay hands over is the one the loader's own gate accepts.
    chrome: { runtime: { getURL: (path) => `chrome-extension://${OWN_EXTENSION_ID}/${path}` } },
    navigator: { language: 'en-GB' },
    fetch: async (url) => ({ ok: true, status: 200, url, json: async () => copyEn }),
    console: channel.console,
    crypto: stubCrypto(),
    createWorker: () => ({ postMessage() {}, terminate() {} }),
  });

/**
 * Runs the real classic MAIN-world bootstrap on the shared window, importing the
 * real MAIN-world module — the only arrangement in which the loader's own lines
 * and the module's lines land in the same console in the order they happen.
 *
 * @param {object} channel the shared page world
 * @param {{ importModule?: Function }} options `importModule` replaces the real
 *   dynamic import, so a test can make the module fail to load
 */
export const startLoader = (channel, { importModule } = {}) =>
  loadMainWorldBootstrap({
    window: channel.window,
    document: channel.document,
    importModule:
      importModule ??
      (async () => {
        const module = await import('../../src/page-bridge-app.js');
        return { startPageBridge: module.startPageBridge };
      }),
  });

/** The bridge module URL the relay and the loader must agree on. */
export const OWN_MODULE_URL = `chrome-extension://${OWN_EXTENSION_ID}/${BRIDGE_MODULE_FILE}`;
