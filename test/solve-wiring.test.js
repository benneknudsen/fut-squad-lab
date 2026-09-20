import { describe, expect, it, vi } from 'vitest';

import copyDa from '../design/copy.da.json';
import copyEn from '../design/copy.en.json';
import { startPageBridge } from '../src/page-bridge-app.js';
import { startContentApp } from '../src/content-app.js';
import { buildSolveSummary } from '../src/ea/summary.js';
import { panelLabel } from '../src/ui/copy.js';
import club from './fixtures/club-items.json';
import set10 from './fixtures/sbs-set-10-challenges.json';
import challengeSquadFixture from './fixtures/sbs-challenge-25-squad.json';
import { createTestPacer } from './helpers/pacing.js';

const challengeFixture = set10.challenges.find((entry) => entry.challengeId === 25);
const COPY_MESSAGE = {
  source: 'fsl-content',
  kind: 'copy',
  locale: 'da',
  label: panelLabel({ da: copyDa, en: copyEn }, 'da-DK'),
};

// ---------------------------------------------------------------------------
// The MAIN-world half: clicking Solve must post one worker request, treat the
// relayed answer as the solution, and write it through EA's own save path.
// ---------------------------------------------------------------------------

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

const createFakeWindow = ({ withEligibilityKeys = true } = {}) => {
  const view = createFakeNode();
  const messages = [];
  const listeners = [];

  function UTSBCSquadDetailPanelViewController() {
    this.view = view;
  }
  UTSBCSquadDetailPanelViewController.prototype.initWithSBCSet = function (subject) {
    this.subject = subject;
    return 'original result';
  };

  const saveChallenge = vi.fn(async () => 'saved');
  const submitChallenge = vi.fn();
  const pageWindow = {
    document: {
      body: createFakeNode(),
      createElement: () => createFakeNode(),
    },
    services: {
      UTSBCRepository: {
        getClubItems: async () => ({ itemData: club.itemData }),
      },
      UTSquadBuildingChallengeDAO: { saveChallenge, submitChallenge },
    },
    SBCEligibilityKey: undefined,
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
  pageWindow.UTSBCSquadDetailPanelViewController = UTSBCSquadDetailPanelViewController;
  if (withEligibilityKeys) {
    pageWindow.SBCEligibilityKey = { PLAYER_COUNT: 2, 2: 'PLAYER_COUNT' };
  }

  return {
    pageWindow,
    view,
    messages,
    saveChallenge,
    submitChallenge,
    dispatchMessage(data, source = pageWindow) {
      for (const listener of listeners) listener({ data, source });
    },
  };
};

const mountedButton = (view) => view.children[0]?.children[0]?.children[0] ?? null;

const subjectWithSquad = () => ({ ...challengeFixture, squad: challengeSquadFixture.squad });

describe('the Solve action end to end', () => {
  it('posts one worker request, applies the relayed solution and writes through EA', async () => {
    const { pageWindow, view, messages, saveChallenge, submitChallenge, dispatchMessage } =
      createFakeWindow();
    startPageBridge(pageWindow, { hookPollMs: 1, pacer: createTestPacer() });
    dispatchMessage(COPY_MESSAGE);
    new pageWindow.UTSBCSquadDetailPanelViewController().initWithSBCSet(subjectWithSquad());

    mountedButton(view).click();

    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'solve-request')).toBe(true);
    });
    const requests = messages.filter((message) => message.kind === 'solve-request');
    expect(requests).toHaveLength(1);
    expect(requests[0].operation).toBe('solve');
    expect(requests[0].payload.options.keys).toBeTruthy();
    expect(requests[0].payload.options.scopes).toEqual({ 0: 'GREATER', 1: 'LOWER', 2: 'EXACT' });
    // The solve is dispatched to the worker; nothing is written until it answers.
    expect(saveChallenge).not.toHaveBeenCalled();

    const players = requests[0].payload.pool.slice(0, 11);
    expect(players).toHaveLength(11);
    dispatchMessage({
      source: 'fsl-content',
      kind: 'solve-response',
      token: requests[0].token,
      result: {
        squad: { players, chemistry: { total: 0 } },
        cost: 5000,
        costComplete: true,
        valid: true,
        failures: [],
        unverified: [{ slot: 0, reason: 'no link data' }],
      },
    });

    await vi.waitFor(() => {
      expect(messages.filter((message) => message.kind === 'summary')).toHaveLength(2);
    });
    const summaries = messages.filter((message) => message.kind === 'summary');
    expect(summaries[0].summary).toContain('3 Leagues & 2 Nations');
    const solveSummary = summaries[1].summary;
    expect(solveSummary).toContain('cost 5000 (complete)');
    expect(solveSummary).toContain('valid: yes');
    expect(solveSummary).toContain('unverified: 1');
    expect(solveSummary).toContain(
      'write: services.UTSquadBuildingChallengeDAO.saveChallenge'
    );

    expect(saveChallenge).toHaveBeenCalledTimes(1);
    const payload = saveChallenge.mock.calls[0][0];
    expect(payload.challengeId).toBe(25);
    const firstSlot = payload.squad.players.find((entry) => entry.index === 0);
    expect(firstSlot.itemData).toEqual(club.itemData.find((item) => item.id === players[0].id));
    expect(submitChallenge).not.toHaveBeenCalled();
  });

  it('never writes when the worker reports the solution invalid', async () => {
    const { pageWindow, view, messages, saveChallenge, dispatchMessage } = createFakeWindow();
    startPageBridge(pageWindow, { hookPollMs: 1, pacer: createTestPacer() });
    dispatchMessage(COPY_MESSAGE);
    new pageWindow.UTSBCSquadDetailPanelViewController().initWithSBCSet(subjectWithSquad());

    mountedButton(view).click();
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'solve-request')).toBe(true);
    });
    const request = messages.find((message) => message.kind === 'solve-request');
    dispatchMessage({
      source: 'fsl-content',
      kind: 'solve-response',
      token: request.token,
      result: {
        squad: { players: request.payload.pool.slice(0, 11) },
        cost: null,
        costComplete: false,
        valid: false,
        failures: [{ slot: 4, reason: 'no nation match' }],
        unverified: [],
      },
    });

    await vi.waitFor(() => {
      expect(messages.filter((message) => message.kind === 'summary')).toHaveLength(2);
    });
    const solveSummary = messages.filter((message) => message.kind === 'summary')[1].summary;
    expect(solveSummary).toContain('valid: no');
    expect(solveSummary).toContain('write: skipped');
    expect(saveChallenge).not.toHaveBeenCalled();
  });

  it('reports the relayed worker error loudly on the message channel', async () => {
    const { pageWindow, view, messages, dispatchMessage } = createFakeWindow();
    startPageBridge(pageWindow, { hookPollMs: 1, pacer: createTestPacer() });
    dispatchMessage(COPY_MESSAGE);
    new pageWindow.UTSBCSquadDetailPanelViewController().initWithSBCSet(subjectWithSquad());

    mountedButton(view).click();
    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'solve-request')).toBe(true);
    });
    const request = messages.find((message) => message.kind === 'solve-request');
    dispatchMessage({
      source: 'fsl-content',
      kind: 'solve-error',
      token: request.token,
      error: { name: 'Error', message: 'solve: the worker found no legal lineup' },
    });

    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'error')).toBe(true);
    });
    const error = messages.find((message) => message.kind === 'error');
    expect(error.message).toContain('solve: the worker found no legal lineup');
  });

  it('fails loudly naming SBCEligibilityKey when the live enum is unreadable, and never solves', async () => {
    const { pageWindow, view, messages, saveChallenge, dispatchMessage } = createFakeWindow({
      withEligibilityKeys: false,
    });
    pageWindow.console = { info: vi.fn() };
    startPageBridge(pageWindow, { hookPollMs: 1, pacer: createTestPacer() });
    dispatchMessage(COPY_MESSAGE);
    new pageWindow.UTSBCSquadDetailPanelViewController().initWithSBCSet(subjectWithSquad());

    mountedButton(view).click();

    await vi.waitFor(() => {
      expect(messages.some((message) => message.kind === 'error')).toBe(true);
    });
    const error = messages.find((message) => message.kind === 'error');
    expect(error.message).toContain('SBCEligibilityKey');
    expect(messages.some((message) => message.kind === 'solve-request')).toBe(false);
    expect(saveChallenge).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The ISOLATED-world half: the relay spawns one worker and brokers the page
// protocol to it.
// ---------------------------------------------------------------------------

const createFakeContentWindow = () => {
  const messages = [];
  const listeners = {};
  const window = {
    postMessage(message) {
      messages.push(message);
    },
    addEventListener(type, handler) {
      (listeners[type] ??= []).push(handler);
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
    dispatch(type, data, source = window) {
      for (const handler of listeners[type] ?? []) handler({ data, source });
    },
  };
};

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

const startFakeContentRelay = () => {
  const fake = createFakeContentWindow();
  const worker = createFakeWorker();
  const created = [];
  const fakeConsole = { log: vi.fn(), warn: vi.fn() };
  startContentApp({
    window: fake.window,
    document: fake.document,
    chrome: { runtime: { getURL: (path) => `chrome-extension://abc/${path}` } },
    navigator: { language: 'en-GB' },
    fetch: async (url) => ({ ok: true, status: 200, url, json: async () => copyEn }),
    console: fakeConsole,
    createWorker: (url) => {
      created.push(url);
      return worker;
    },
  });
  return { ...fake, worker, created, fakeConsole };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the isolated solve relay', () => {
  it('creates one worker lazily and answers the page token with the worker result', async () => {
    const { window, messages, worker, created, dispatch } = startFakeContentRelay();
    expect(created).toEqual([]);

    dispatch('message', { source: 'fsl-page', kind: 'solve-request', token: 3, operation: 'solve', payload: { a: 1 } });
    expect(created).toEqual(['chrome-extension://abc/src/solver/worker.js']);
    const [request] = worker.posted;
    expect(request).toMatchObject({ kind: 'request', operation: 'solve', payload: { a: 1 } });

    dispatch('message', { source: 'fsl-page', kind: 'solve-request', token: 4, operation: 'solve', payload: { b: 2 } });
    expect(created).toHaveLength(1);
    expect(worker.posted.filter((message) => message.kind === 'request')).toHaveLength(2);

    worker.onmessage({ data: { kind: 'response', id: request.id, result: { squad: 'solved' } } });
    await flush();

    expect(messages).toContainEqual({
      source: 'fsl-content',
      kind: 'solve-response',
      token: 3,
      result: { squad: 'solved' },
    });
  });

  it('tears the worker down on pagehide and stops later solves', async () => {
    const { worker, dispatch } = startFakeContentRelay();
    dispatch('message', { source: 'fsl-page', kind: 'solve-request', token: 5, operation: 'solve', payload: {} });
    const [request] = worker.posted;

    dispatch('pagehide', {});

    expect(worker.terminated).toBe(1);
    expect(worker.posted).toContainEqual({ kind: 'cancel', id: request.id });

    dispatch('message', { source: 'fsl-page', kind: 'solve-request', token: 6, operation: 'solve', payload: {} });
    expect(worker.posted.filter((message) => message.kind === 'request')).toHaveLength(1);
  });

  it('cancels the worker request when the page cancels its token', () => {
    const { worker, dispatch, messages } = startFakeContentRelay();
    dispatch('message', { source: 'fsl-page', kind: 'solve-request', token: 9, operation: 'solve', payload: {} });
    const [request] = worker.posted;

    dispatch('message', { source: 'fsl-page', kind: 'solve-cancel', token: 9 });

    expect(worker.posted).toContainEqual({ kind: 'cancel', id: request.id });
    expect(messages.at(-1)).toMatchObject({
      source: 'fsl-content',
      kind: 'solve-error',
      token: 9,
      error: { name: 'AbortError' },
    });
  });

  it('ignores a solve message posted by a foreign frame', () => {
    const { worker, dispatch } = startFakeContentRelay();
    dispatch('message', { source: 'fsl-page', kind: 'solve-request', token: 10, operation: 'solve', payload: {} }, {});
    expect(worker.posted).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The solve line itself: partial cost must never read as a complete total.
// ---------------------------------------------------------------------------

describe('buildSolveSummary', () => {
  it('prints a complete cost as complete and a partial cost as coverage, never as a bare total', () => {
    const complete = buildSolveSummary({
      readSummary: 'read',
      result: { cost: 5000, costComplete: true, costCoverage: { known: 11, unknown: 0 }, valid: true, unverified: [] },
      write: { ok: true, strategy: 'services.UTSquadEntity.save', attempts: [] },
    });
    expect(complete).toContain('cost 5000 (complete)');
    expect(complete).toContain('write: services.UTSquadEntity.save');

    const partial = buildSolveSummary({
      readSummary: 'read',
      result: {
        cost: 900,
        costComplete: false,
        costCoverage: { known: 9, unknown: 2, complete: false },
        valid: true,
        unverified: [],
      },
      write: null,
      writeSkipped: 'the solution is not valid; refusing to write it',
    });
    expect(partial).toContain('cost 9 known, 2 unpriced (incomplete)');
    expect(partial).not.toContain('cost 900 (complete)');
    expect(partial).toContain('write: skipped');
  });

  it('lists every failed write candidate with its reason and never a forged fallback', () => {
    const summary = buildSolveSummary({
      readSummary: 'read',
      result: { cost: 0, costComplete: true, costCoverage: { known: 11, unknown: 0 }, valid: true, unverified: [] },
      write: {
        ok: false,
        strategy: null,
        attempts: [
          { id: 'services.UTSquadBuildingChallengeDAO.saveChallenge', ok: false, reason: 'threw: rejected' },
          { id: 'services.UTSquadEntity.save', ok: false, reason: 'has no save method' },
        ],
      },
    });
    expect(summary).toContain('services.UTSquadBuildingChallengeDAO.saveChallenge: threw: rejected');
    expect(summary).toContain('services.UTSquadEntity.save: has no save method');
  });
});
