import { describe, expect, it, vi } from 'vitest';

import { startPageBridge } from '../src/page-bridge-app.js';
import { TEST_NONCE } from './helpers/nonce.js';

// Issue #64: the bridge installs the read-only observer when EA's panel class
// appears, records EA's own club calls to the console, removes every wrapper on
// teardown, and carries the captures in the staged diagnostics.

const createFakeWindow = () => {
  const messages = [];
  const listeners = [];
  const logs = [];
  const reply = { items: [] };
  const originalSearch = (criteria) => reply;

  function UTSBCSquadDetailPanelViewController() {}
  const eaPanelHook = function (subject) {
    this.subject = subject;
    return 'original result';
  };
  UTSBCSquadDetailPanelViewController.prototype.initWithSBCSet = eaPanelHook;

  const pageWindow = {
    services: { Club: { search: originalSearch } },
    console: {
      group: vi.fn(),
      groupEnd: vi.fn(),
      log: vi.fn((...args) => logs.push(args.join(' '))),
      info: vi.fn(),
    },
    UTSBCSquadDetailPanelViewController,
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

  return {
    pageWindow,
    originalSearch,
    eaPanelHook,
    reply,
    logs,
    messages,
    dispatch(type, event = {}) {
      for (const listener of listeners) {
        listener.type === type && listener.handler({ type, ...event });
      }
    },
  };
};

const logLines = (pageWindow) =>
  pageWindow.console.log.mock.calls.map((call) => call[0]).filter((line) => typeof line === 'string');

describe('the bridge installs the observer', () => {
  it('wraps EA\u2019s club search, records how it was called and returns its result unchanged', () => {
    const { pageWindow, originalSearch, reply, logs } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1, hookTimeoutMs: 20 });

    const criteria = { count: 25, offset: 0, personaId: 'distinctive-persona-987' };
    expect(pageWindow.services.Club.search).not.toBe(originalSearch);

    const result = pageWindow.services.Club.search(criteria);

    expect(result).toBe(reply);
    expect(pageWindow.console.group).toHaveBeenCalledWith(
      expect.stringContaining('observed EA calls')
    );
    const line = logLines(pageWindow).find((entry) => entry.includes('services.Club.search'));
    expect(line).toContain('args=1');
    expect(line).toContain('count:25');
    expect(line).not.toContain('distinctive-persona-987');
    expect(logs.join('\n')).not.toContain('distinctive-persona-987');
  });

  it('records the panel payload by property name and type, never by value', () => {
    const { pageWindow } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1, hookTimeoutMs: 20 });

    const controller = new pageWindow.UTSBCSquadDetailPanelViewController();
    controller.initWithSBCSet({
      challengeId: 25,
      name: 'A Distinctive Challenge Name',
      elgReq: [],
    });

    const lines = logLines(pageWindow);
    const line = lines.find((entry) => entry.includes('initWithSBCSet'));
    expect(line).toContain('args=1');
    expect(line).toContain('elgReq');
    expect(line).toContain('challengeId');
    expect(lines.join('\n')).not.toContain('A Distinctive Challenge Name');
  });

  it('removes every wrapper on pagehide and ends the console group', () => {
    const { pageWindow, originalSearch, dispatch } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1, hookTimeoutMs: 20 });
    expect(pageWindow.services.Club.search).not.toBe(originalSearch);
    pageWindow.services.Club.search({ count: 1 });
    expect(pageWindow.console.groupEnd).not.toHaveBeenCalled();

    dispatch('pagehide');

    expect(pageWindow.services.Club.search).toBe(originalSearch);
    expect(pageWindow.console.groupEnd).toHaveBeenCalled();
  });

  // #90: the observer wraps the button patch, not the other way round, so
  // `pagehide` unwraps two layers. Restoring the prototype while the observer's
  // wrapper is still on top of it would find its own function gone and quietly
  // do nothing, leaving the patch in place after the page is gone.
  it('hands EA its panel method back even though the observer wrapped our patch', () => {
    const { pageWindow, eaPanelHook, dispatch } = createFakeWindow();
    startPageBridge(pageWindow, { nonce: TEST_NONCE, hookPollMs: 1, hookTimeoutMs: 20 });
    new pageWindow.UTSBCSquadDetailPanelViewController().initWithSBCSet({ elgReq: [] });
    const { prototype } = pageWindow.UTSBCSquadDetailPanelViewController;

    dispatch('pagehide');

    expect(prototype.initWithSBCSet).toBe(eaPanelHook);
  });
});

// Issue #100: `pagehide` removes the observer even when the document is going
// into the back/forward cache. A cached document comes back on the same JS heap,
// but nothing re-runs the content script or the hook poll, so `pageshow` is the
// only place the wrappers can be reinstalled.
describe('the observer after a back/forward-cache restore', () => {
  const start = () => {
    const fake = createFakeWindow();
    startPageBridge(fake.pageWindow, { nonce: TEST_NONCE, hookPollMs: 1, hookTimeoutMs: 20 });
    return fake;
  };

  it('reinstalls the observer when pageshow reports a cache restore', () => {
    const { pageWindow, originalSearch, reply, dispatch } = start();
    expect(pageWindow.services.Club.search).not.toBe(originalSearch);

    dispatch('pagehide', { persisted: true });
    expect(pageWindow.services.Club.search).toBe(originalSearch);

    dispatch('pageshow', { persisted: true });

    expect(pageWindow.services.Club.search).not.toBe(originalSearch);
    expect(pageWindow.services.Club.search({ count: 1 })).toBe(reply);
    expect(logLines(pageWindow).some((line) => line.includes('services.Club.search'))).toBe(true);
  });

  it('does nothing when pageshow reports a real navigation', () => {
    const { pageWindow, originalSearch, dispatch } = start();
    dispatch('pagehide', { persisted: true });
    expect(pageWindow.services.Club.search).toBe(originalSearch);
    const logsBefore = pageWindow.console.log.mock.calls.length;

    dispatch('pageshow', { persisted: false });

    expect(pageWindow.services.Club.search).toBe(originalSearch);
    expect(pageWindow.console.log.mock.calls.length).toBe(logsBefore);
  });

  it('does not stack wrappers when pageshow fires twice', () => {
    const { pageWindow, originalSearch, dispatch } = start();
    dispatch('pagehide', { persisted: true });

    dispatch('pageshow', { persisted: true });
    const wrapped = pageWindow.services.Club.search;
    expect(wrapped).not.toBe(originalSearch);

    dispatch('pageshow', { persisted: true });
    expect(pageWindow.services.Club.search).toBe(wrapped);

    pageWindow.services.Club.search({ count: 1 });
    expect(
      logLines(pageWindow).filter((line) => line.includes('services.Club.search'))
    ).toHaveLength(1);
  });

  it('writes one boot line naming the cache restore', () => {
    const { pageWindow, dispatch } = start();
    dispatch('pagehide', { persisted: true });

    dispatch('pageshow', { persisted: true });

    expect(logLines(pageWindow)).toContain(
      '[FUT Squad Lab] observer reinstalled after back/forward-cache'
    );
  });
});