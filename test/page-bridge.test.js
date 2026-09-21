import { describe, expect, it, vi } from 'vitest';

import copyDa from '../design/copy.da.json';
import copyEn from '../design/copy.en.json';
import club from './fixtures/club-items.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import { panelLabel } from '../src/ui/copy.js';
import { startPageBridge } from '../src/page-bridge-app.js';

const challengeFixture = set10.challenges.find((entry) => entry.challengeId === 25);
const COPY_MESSAGE = {
  source: 'fsl-content',
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
  if (withHook) {
    UTSBCSquadDetailPanelViewController.prototype.initWithSBCSet = function (subject) {
      this.subject = subject;
      return 'original result';
    };
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
      if (type === 'message') listeners.push(handler);
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
    messages,
    dispatchMessage(data, source = pageWindow) {
      for (const listener of listeners) listener({ data, source });
    },
  };
};

const mountedButton = (view) => view.children[0]?.children[0]?.children[0] ?? null;

describe('startPageBridge', () => {
  it('patches the panel, keeps the original method working, and injects one labelled button', () => {
    const { pageWindow, view, dispatchMessage, messages } = createFakeWindow();
    startPageBridge(pageWindow, { hookPollMs: 1 });
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
    startPageBridge(pageWindow, { hookPollMs: 1 });
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet(challengeFixture);
    expect(view.children).toHaveLength(0);
  });

  it('posts the real challenge name, constraint count and club size on click', async () => {
    const { pageWindow, view, dispatchMessage, messages } = createFakeWindow();
    startPageBridge(pageWindow, { hookPollMs: 1 });
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
    startPageBridge(pageWindow, { hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE, {});
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet(challengeFixture);
    expect(view.children).toHaveLength(0);
  });

  it('accepts a copy message from its own window', () => {
    const { pageWindow, view, dispatchMessage } = createFakeWindow();
    startPageBridge(pageWindow, { hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE, pageWindow);
    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet(challengeFixture);
    expect(mountedButton(view)?.textContent).toBe('Løs denne udfordring');
  });

  it('names the missing panel class after the poll window, without throwing', async () => {
    const { pageWindow, messages } = createFakeWindow({ withController: false });
    startPageBridge(pageWindow, { hookPollMs: 2, hookTimeoutMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const error = messages.find((message) => message.kind === 'error');
    expect(error.message).toContain('UTSBCSquadDetailPanelViewController');
  });

  it('names the missing hook method when the class exists without it', async () => {
    const { pageWindow, messages } = createFakeWindow({ withHook: false });
    startPageBridge(pageWindow, { hookPollMs: 2 });
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'error')).toBe(true);
    });
    const error = messages.find((message) => message.kind === 'error');
    expect(error.message).toContain('initWithSBCSet');
  });

  it('reports a bridge error instead of throwing when the panel argument is unusable', async () => {
    const { pageWindow, view, dispatchMessage, messages } = createFakeWindow();
    startPageBridge(pageWindow, { hookPollMs: 1 });
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

    startPageBridge(pageWindow, { hookPollMs: 1 });
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

    startPageBridge(pageWindow, { hookPollMs: 1 });
    dispatchMessage(COPY_MESSAGE);
    const Controller = pageWindow.UTSBCSquadDetailPanelViewController;
    new Controller().initWithSBCSet(challengeFixture);
    new Controller().initWithSBCSet(challengeFixture);

    expect(pageWindow.console.info).toHaveBeenCalledTimes(1);
    expect(pageWindow.console.info.mock.calls[0][0]).toContain('SBCEligibilityKey');
  });
});
