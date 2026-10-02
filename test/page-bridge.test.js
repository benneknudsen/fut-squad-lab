import { describe, expect, it, vi } from 'vitest';

import copyDa from '../design/copy.da.json';
import copyEn from '../design/copy.en.json';
import club from './fixtures/club-items.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import { panelLabel } from '../src/ui/copy.js';
import { startPageBridge } from '../src/page-bridge-app.js';
import { TEST_NONCE } from './helpers/nonce.js';

const challengeFixture = set10.challenges.find((entry) => entry.challengeId === 25);
const COPY_MESSAGE = {
  source: 'fsl-content',
  nonce: TEST_NONCE,
  kind: 'copy',
  locale: 'da',
  label: panelLabel({ da: copyDa, en: copyEn }, 'da-DK'),
};

// A plain-object DOM: these tests prove the bridge's behaviour against fake
// EA objects, so no jsdom is needed and every assertion is on elements the
// bridge really created.
const createFakeNode = () => {
  const node = {
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

const createFakeWindow = ({ withController = true, withHook = true } = {}) => {
  const view = createFakeNode();
  const messages = [];
  const listeners = [];

  function UTSBCSquadDetailPanelViewController() {
    this.view = view;
  }
  // The reference a teardown test needs: EA's own method, kept by identity so
  // "restored" can be asserted as `toBe(eaPanelHook)` rather than as a flag.
  const eaPanelHook = function (subject) {
    this.subject = subject;
    return 'original result';
  };
  if (withHook) {
    UTSBCSquadDetailPanelViewController.prototype.initWithSBCSet = eaPanelHook;
  }

  const document = {
    body: createFakeNode(),
    createElement: () => createFakeNode(),
  };

  const pageWindow = {
    document,
    services: {
      UTSBCRepository: {
        getClubItems: async () => ({ items: club.items }),
      },
    },
    postMessage(message) {
      messages.push(message);
    },
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    setInterval(handler, ms) {
      return setInterval(handler, ms);
    },
    clearInterval(id) {
      clearInterval(id);
    },
  };
  if (withController) pageWindow.UTSBCSquadDetailPanelViewController = UTSBCSquadDetailPanelViewController;

  return {
    pageWindow,
    view,
    eaPanelHook,
    messages,
    dispatchMessage(data, source = pageWindow) {
      for (const listener of listeners) {
        if (listener.type === 'message') listener.handler({ data, source });
      }
    },
    dispatchPageHide({ persisted = false } = {}) {
      for (const listener of listeners) {
        if (listener.type === 'pagehide') listener.handler({ type: 'pagehide', persisted });
      }
    },
  };
};

const mountedButton = (view) => view.children[0]?.children[0]?.children[0] ?? null;

describe('startPageBridge', () => {
  it('patches the panel, keeps the original method working, and injects one labelled button', () => {
    const { pageWindow, view, dispatchMessage, messages } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);

    const Controller = pageWindow.UTSBCSquadDetailPanelViewController;
    const controller = new Controller();
    expect(controller.initWithSBCSet(challengeFixture)).toBe('original result');

    const wrapper = view.children[0];
    expect(wrapper.className).toBe('fsl-root');
    const button = mountedButton(view);
    expect(button.className).toBe('fsl-btn-primary');
    expect(button.textContent).toBe('Løs denne udfordring');
    expect(messages.some((message) => message.kind === 'mounted')).toBe(true);

    const second = new Controller();
    second.initWithSBCSet(challengeFixture);
    expect(view.children).toHaveLength(1);
  });

  it('does not inject before the copy label arrives', () => {
    const { pageWindow, view } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet(challengeFixture);
    expect(view.children).toHaveLength(0);
  });

  it('posts the real challenge name, constraint count and club size on click', async () => {
    const { pageWindow, view, dispatchMessage, messages } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet(challengeFixture);

    mountedButton(view).click();
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'summary')).toBe(true);
    });

    const summary = messages.find((message) => message.kind === 'summary');
    expect(summary.summary).toContain('3 Leagues & 2 Nations');
    expect(summary.summary).toContain('6 constraints');
    expect(summary.summary).toContain('42 club items');
    expect(summary.summary).toContain('services.UTSBCRepository.getClubItems');
    expect(summary.challengeStrategy).toBe('panel-argument');
    expect(summary.clubStrategy).toBe('services.UTSBCRepository.getClubItems');
  });

  it('ignores a copy message posted by a foreign frame', () => {
    const { pageWindow, view, dispatchMessage } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE, {});
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet(challengeFixture);
    expect(view.children).toHaveLength(0);
  });

  it('accepts a copy message from its own window', () => {
    const { pageWindow, view, dispatchMessage } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE, pageWindow);
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet(challengeFixture);
    expect(mountedButton(view)?.textContent).toBe('Løs denne udfordring');
  });

  it('names the missing panel class after the poll window, without throwing', async () => {
    const { pageWindow, messages } = createFakeWindow({ withController: false });
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 2, hookTimeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const error = messages.find((message) => message.kind === 'error');
    expect(error.message).toContain('UTSBCSquadDetailPanelViewController');
  });

  it('names the missing hook method when the class exists without it', async () => {
    const { pageWindow, messages } = createFakeWindow({ withHook: false });
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 2 });
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'error')).toBe(true);
    });
    const error = messages.find((message) => message.kind === 'error');
    expect(error.message).toContain('initWithSBCSet');
  });

  it('reports a bridge error instead of throwing when the panel argument is unusable', async () => {
    const { pageWindow, view, dispatchMessage, messages } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet('not a challenge');
    mountedButton(view).click();
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'summary')).toBe(true);
    });
    const summary = messages.find((message) => message.kind === 'summary');
    expect(summary.summary).toMatch(/challenge not detected/i);
  });
});

// Issue #90: the button needs a prototype hook, because EA re-renders the panel
// and the extension has no event to listen to. The mutation is a decision, so
// teardown hands EA its own function back rather than leaving a first-party
// prototype patched after the page is gone.
describe('the patched EA prototype', () => {
  it('is EA\'s own function again on pagehide, by identity and not by a cleared flag', () => {
    const { pageWindow, eaPanelHook, dispatchPageHide } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    const { prototype } = pageWindow.UTSBCSquadDetailPanelViewController;
    // The bridge owns two layers here: its own wrapper, and the observer's on
    // top of it. Identity is the only assertion that sees through both.
    expect(prototype.initWithSBCSet).not.toBe(eaPanelHook);

    dispatchPageHide();

    expect(prototype.initWithSBCSet).toBe(eaPanelHook);
    // EA's own method still behaves: the wrapper passed arguments through and
    // returned its result, so the restored function is the same behaviour.
    expect(prototype.initWithSBCSet.call({}, challengeFixture)).toBe('original result');
  });

  it('restores exactly once, and a second pagehide over a live bridge does not throw', () => {
    const { pageWindow, eaPanelHook, dispatchPageHide, messages } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    const { prototype } = pageWindow.UTSBCSquadDetailPanelViewController;
    const before = messages.length;

    dispatchPageHide();
    dispatchPageHide();

    expect(prototype.initWithSBCSet).toBe(eaPanelHook);
    // A teardown path that reported on itself would put noise in the console of
    // a page the player is leaving.
    expect(messages.slice(before).some((message) => message.kind === 'error')).toBe(false);
  });

  it('survives a back/forward cache round trip, so the button still mounts after the page comes back', () => {
    // `pagehide` with `persisted: true` means the document is going into the
    // bfcache: its heap, its listeners and this patch all come back untouched,
    // and nothing re-patches it. Restoring here would remove the only hook the
    // button has, silently, on every Back button press inside the SPA.
    const { pageWindow, view, eaPanelHook, dispatchMessage, dispatchPageHide } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);
    const Controller = pageWindow.UTSBCSquadDetailPanelViewController;

    dispatchPageHide({ persisted: true });

    expect(Controller.prototype.initWithSBCSet).not.toBe(eaPanelHook);
    new Controller().initWithSBCSet(challengeFixture);
    expect(mountedButton(view)?.textContent).toBe('Løs denne udfordring');
  });

  it('restores a hook EA replaced itself, without clobbering what is there now', () => {
    const { pageWindow, eaPanelHook, dispatchPageHide } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    const { prototype } = pageWindow.UTSBCSquadDetailPanelViewController;
    // EA hot-swapped the method after we patched it. Restoring over that would
    // silently reinstate a function the page has already discarded.
    const easReplacement = function () {
      return 'ea replaced this';
    };
    prototype.initWithSBCSet = easReplacement;

    dispatchPageHide();

    expect(prototype.initWithSBCSet).toBe(easReplacement);
    expect(prototype.initWithSBCSet).not.toBe(eaPanelHook);
  });

  it('tears down on a page that was never patched, without throwing', async () => {
    const { pageWindow, dispatchPageHide } = createFakeWindow({ withController: false });
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 2, hookTimeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(() => {
      dispatchPageHide();
    }).not.toThrow();
  });
});

describe('live eligibility keys logging', () => {
  it('resolves the enum once per session and logs one pasteable line', () => {
    const { pageWindow, dispatchMessage } = createFakeWindow();
    let reads = 0;
    Object.defineProperty(pageWindow, 'SBCEligibilityKey', {
      configurable: true,
      get() {
        reads += 1;
        return { PLAYER_COUNT: 2, 2: 'PLAYER_COUNT', SCOPE: 13, 13: 'SCOPE' };
      },
    });
    pageWindow.console = { info: vi.fn() };

    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);
    const Controller = pageWindow.UTSBCSquadDetailPanelViewController;
    new Controller().initWithSBCSet(challengeFixture);
    new Controller().initWithSBCSet(challengeFixture);

    expect(reads).toBe(1);
    expect(pageWindow.console.info).toHaveBeenCalledTimes(1);
    const line = pageWindow.console.info.mock.calls[0][0];
    expect(line).toContain('2=PLAYER_COUNT');
    expect(line).not.toContain('\n');
  });

  it('logs the unreadable enum once instead of throwing when the symbol is missing', () => {
    const { pageWindow, dispatchMessage } = createFakeWindow();
    pageWindow.console = { info: vi.fn() };

    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);
    const Controller = pageWindow.UTSBCSquadDetailPanelViewController;
    new Controller().initWithSBCSet(challengeFixture);
    new Controller().initWithSBCSet(challengeFixture);

    expect(pageWindow.console.info).toHaveBeenCalledTimes(1);
    expect(pageWindow.console.info.mock.calls[0][0]).toContain('SBCEligibilityKey');
  });
});


describe('the MAIN-world side of the session nonce', () => {
  const openPanel = (pageWindow) => {
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet(challengeFixture);
    return controller;
  };

  it('signs every message it posts, so the relay will accept them', () => {
    const { pageWindow, view, dispatchMessage, messages } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);
    openPanel(pageWindow);

    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(message.nonce).toBe(TEST_NONCE);
    expect(messages.some((message) => message.kind === 'bridge-hello')).toBe(true);
    expect(mountedButton(view)).not.toBeNull();
  });

  it('mounts nothing for a copy message that forges the source tag without the nonce', () => {
    const { pageWindow, view, dispatchMessage } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });

    dispatchMessage({ ...COPY_MESSAGE, nonce: undefined });
    openPanel(pageWindow);
    expect(view.children).toHaveLength(0);

    dispatchMessage({ ...COPY_MESSAGE, nonce: `${TEST_NONCE.slice(0, -1)}0` });
    openPanel(pageWindow);
    expect(view.children).toHaveLength(0);

    dispatchMessage({ ...COPY_MESSAGE, nonce: 42 });
    openPanel(pageWindow);
    expect(view.children).toHaveLength(0);
  });

  it('mounts the button as soon as the signed copy message arrives', () => {
    const { pageWindow, view, dispatchMessage } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1 });
    openPanel(pageWindow);
    expect(view.children).toHaveLength(0);

    dispatchMessage(COPY_MESSAGE);
    expect(mountedButton(view)?.textContent).toBe('Løs denne udfordring');
  });

  it('drops everything, without error, when it was started without a nonce', () => {
    // A page script can import this module and call `startPageBridge` itself. With
    // no nonce there is nothing to authenticate against, so the instance is inert
    // rather than a second, unsigned bridge on the channel.
    const { pageWindow, view, dispatchMessage, messages } = createFakeWindow();
    startPageBridge(pageWindow, { hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);
    openPanel(pageWindow);

    expect(view.children).toHaveLength(0);
    expect(messages.some((message) => message.kind === 'error')).toBe(false);
    for (const message of messages) {
      if (message.kind === 'error') continue;
      expect(message.nonce).not.toBe(TEST_NONCE);
    }
  });
});
