import { describe, expect, it, vi } from 'vitest';

import { startPageBridge } from '../src/page-bridge-app.js';

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
  UTSBCSquadDetailPanelViewController.prototype.initWithSBCSet = function (subject) {
    this.subject = subject;
    return 'original result';
  };

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
    reply,
    logs,
    messages,
    dispatch(type) {
      for (const listener of listeners) {
        listener.type === type && listener.handler({ type });
      }
    },
  };
};

const logLines = (pageWindow) =>
  pageWindow.console.log.mock.calls.map((call) => call[0]).filter((line) => typeof line === 'string');

describe('the bridge installs the observer', () => {
  it('wraps EA\u2019s club search, records how it was called and returns its result unchanged', () => {
    const { pageWindow, originalSearch, reply, logs } = createFakeWindow();
    startPageBridge(pageWindow, { hookPollMs: 1, hookTimeoutMs: 20 });

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
    startPageBridge(pageWindow, { hookPollMs: 1, hookTimeoutMs: 20 });

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
    startPageBridge(pageWindow, { hookPollMs: 1, hookTimeoutMs: 20 });
    expect(pageWindow.services.Club.search).not.toBe(originalSearch);
    pageWindow.services.Club.search({ count: 1 });
    expect(pageWindow.console.groupEnd).not.toHaveBeenCalled();

    dispatch('pagehide');

    expect(pageWindow.services.Club.search).toBe(originalSearch);
    expect(pageWindow.console.groupEnd).toHaveBeenCalled();
  });
});