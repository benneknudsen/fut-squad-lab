import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { EA_GLOBALS } from '../src/ea/adapter.js';
import { SERVICE_SHAPE_SCHEMA, describeServiceShape } from '../src/ea/service-shape.js';
import { createSolveService } from '../src/ea/solve-service.js';
import { buildDiagnosticsReport } from '../src/ea/summary.js';
import set10 from './fixtures/sbs-set-10-challenges.json';

const challengeFixture = set10.challenges.find((entry) => entry.challengeId === 25);

const findCandidate = (shape, location) =>
  shape.requestLayer.candidates.find((candidate) => candidate.location === location);

const fakeElement = () => ({
  tagName: 'div',
  className: 'card quiet',
  appendChild() {},
  querySelector() {
    return null;
  },
});

// The names the diagnostics output must never carry, whichever report emits
// them: a session, credential, account or club-item/price field.
const FORBIDDEN =
  /token|session|cookie|persona|credential|secret|authorization|platform|price|itemData|assetId|marketAverage|discardValue|coin/i;

const secretWindow = () => {
  function UTSBCRepository() {}
  UTSBCRepository.prototype.getClubItems = function () {};

  return {
    UTSBCRepository,
    services: {
      authToken: 'live-token-value',
      personaId: 987654321,
      coinBalance: 12345,
      httpClient: {
        platform: 'pc',
        sessionCookie: 'live-cookie-value',
        itemData: [{ id: 1, assetId: 2, marketAverage: 9000, discardValue: 500 }],
      },
    },
  };
};

describe('describeServiceShape request layer', () => {
  it('finds a services request helper and a window request helper with usable signatures', () => {
    function UTRequestHelper() {}
    UTRequestHelper.create = function create() {
      return new UTRequestHelper();
    };
    UTRequestHelper.prototype.request = function request(url, method, body) {};
    UTRequestHelper.prototype.sendRequest = function sendRequest(url, body) {};

    const pageWindow = {
      UTRequestHelper,
      services: { request: new UTRequestHelper() },
    };

    const shape = describeServiceShape(pageWindow);
    const serviceHit = findCandidate(shape, 'services.request');
    const windowHit = findCandidate(shape, 'window.UTRequestHelper');

    expect(shape.schema).toBe(SERVICE_SHAPE_SCHEMA);
    expect(serviceHit.signature).toBe('obj{}');
    expect(serviceHit.prototypeMethods).toEqual(['request', 'sendRequest']);
    expect(windowHit.signature).toBe('function');
    expect(windowHit.prototypeMethods).toEqual(['request', 'sendRequest']);
    expect(windowHit.ownProperties).toEqual(['create: function']);
  });

  it('lists every own enumerable property of the services object with a signature', () => {
    const shape = describeServiceShape({ services: { alpha: 1, beta: 'x', gamma: null } });

    expect(shape.services).toEqual({
      present: true,
      signature: 'obj{alpha,beta,gamma}',
      ownProperties: ['alpha: number', 'beta: string("...")', 'gamma: null'],
    });
  });

  it('reports the prototype methods of the two known classes, present or absent', () => {
    function UTSBCRepository() {}
    UTSBCRepository.prototype.getClubItems = function () {};
    Object.defineProperty(UTSBCRepository.prototype, 'club', {
      get() {
        return null;
      },
    });

    const pageWindow = { UTSBCRepository, services: {} };
    const shape = describeServiceShape(pageWindow);

    expect(shape.eaGlobals.map((entry) => entry.name)).toEqual(Object.values(EA_GLOBALS));

    const repository = shape.classes.find((entry) => entry.name === 'UTSBCRepository');
    expect(repository.present).toBe(true);
    expect(repository.signature).toBe('function');
    expect(repository.prototypeMethods).toEqual(['getClubItems', 'club (getter)']);

    const service = shape.classes.find((entry) => entry.name === 'UTSBCService');
    expect(service).toEqual({
      name: 'UTSBCService',
      present: false,
      signature: 'undefined',
      prototypeMethods: [],
    });
  });

  it('signs every value shape without printing a single value', () => {
    const client = {
      el: fakeElement(),
      plain: { alpha: 1, beta: 2 },
      list: [1, 2, 3],
      handler: () => {},
      nothing: null,
      missing: undefined,
      label: 'never print this value',
      count: 7,
    };

    const shape = describeServiceShape({ services: { httpClient: client } });
    const candidate = findCandidate(shape, 'services.httpClient');

    expect(candidate.signature).toBe('obj{el,plain,list,handler,nothing,missing,…}');
    expect(candidate.ownProperties).toEqual([
      'el: ELEMENT <div> .card .quiet',
      'plain: obj{alpha,beta}',
      'list: array[3]',
      'handler: function',
      'nothing: null',
      'missing: undefined',
      'label: string("...")',
      'count: number',
    ]);
    expect(JSON.stringify(shape)).not.toContain('never print this value');
  });

  it('never invokes a getter or a method while describing them', () => {
    const methodSpy = vi.fn();
    const getterSpy = vi.fn(() => ({ request() {} }));

    function RequestHelper() {}
    RequestHelper.prototype.send = methodSpy;

    const services = {
      httpClient: {
        submit: methodSpy,
      },
    };
    Object.defineProperty(services, 'requestClient', {
      enumerable: true,
      get: getterSpy,
    });

    const shape = describeServiceShape({ RequestHelper, services });

    expect(findCandidate(shape, 'services.requestClient').signature).toBe('accessor(get)');
    expect(findCandidate(shape, 'window.RequestHelper').prototypeMethods).toEqual(['send']);
    expect(findCandidate(shape, 'services.httpClient').ownProperties).toEqual(['submit: function']);
    expect(shape.services.ownProperties).toContain('requestClient: accessor(get)');
    expect(getterSpy).not.toHaveBeenCalled();
    expect(methodSpy).not.toHaveBeenCalled();
  });

  it('describes the page fetch without calling it', () => {
    const fetchSpy = vi.fn(() => {
      throw new Error('the shape report must not fetch');
    });

    const shape = describeServiceShape({ fetch: fetchSpy, services: {} });

    expect(findCandidate(shape, 'window.fetch').signature).toBe('function');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('describeServiceShape paste safety', () => {
  it('keeps a redacted name visible as <redacted> instead of dropping it', () => {
    const shape = describeServiceShape({
      services: {
        sessionToken: 'live-token-value',
        httpClient: { itemData: [{ id: 1 }] },
      },
    });

    expect(shape.services.ownProperties).toContain('<redacted>: string("...")');
    expect(findCandidate(shape, 'services.httpClient').ownProperties).toEqual([
      '<redacted>: array[1]',
    ]);

    const json = JSON.stringify(shape);
    expect(json).not.toContain('live-token-value');
    expect(json).not.toContain('sessionToken');
    expect(json).not.toContain('itemData');
  });

  it('tells an absent name apart from a redacted one', () => {
    const shape = describeServiceShape({ services: { sessionToken: 'x' } });

    expect(shape.services.ownProperties).toContain('<redacted>: string("...")');

    const absentGlobal = shape.eaGlobals.find((entry) => entry.name === 'SBCEligibilityKey');
    expect(absentGlobal).toEqual({
      name: 'SBCEligibilityKey',
      present: false,
      signature: 'undefined',
    });
    expect(shape.services.ownProperties.some((entry) => entry.includes('SBCEligibilityKey'))).toBe(
      false
    );
  });

  it('emits none of the forbidden fields when every value it describes is sensitive', () => {
    const shape = describeServiceShape(secretWindow());
    const json = JSON.stringify(shape);

    expect(json).not.toMatch(FORBIDDEN);
    expect(json).not.toContain('live-token-value');
    expect(json).not.toContain('live-cookie-value');
    expect(json).not.toContain('987654321');
    expect(json).not.toContain('12345');
  });
});

describe('the staged diagnostic carries the service shape on a failed club read', () => {
  const solveReport = async (pageWindow, clubResult) => {
    const service = createSolveService({
      pageWindow,
      requestSolve: vi.fn(),
      steps: {
        resolveChallengeSubject: vi.fn(() => ({
          ok: true,
          payload: challengeFixture,
          strategy: 'panel-argument',
          attempts: [{ id: 'panel-argument', ok: true, reason: null }],
        })),
        resolveClubItems: vi.fn(async () => clubResult),
      },
    });
    const outcome = await service.solve({});
    return buildDiagnosticsReport(outcome.stages);
  };

  it('attaches the shape report to the failed club stage without leaking anything', async () => {
    const report = await solveReport(secretWindow(), {
      ok: false,
      items: [],
      strategy: null,
      attempts: [
        { id: 'services.UTSBCRepository.getClubItems', ok: false, reason: 'no method' },
      ],
    });
    const club = report.stages.find((stage) => stage.id === 'club');
    const json = JSON.stringify(report);

    expect(report.stoppedAt).toBe('club');
    expect(club.ok).toBe(false);
    expect(club.detail.shape.schema).toBe(SERVICE_SHAPE_SCHEMA);
    expect(findCandidate(club.detail.shape, 'services.httpClient')).toBeDefined();
    expect(json).not.toMatch(FORBIDDEN);
    expect(json).not.toContain('live-token-value');
    expect(json).not.toContain('live-cookie-value');
    expect(json).not.toContain('987654321');
    expect(json).not.toContain('12345');
  });

  it('omits the shape report when the club read answered', async () => {
    const report = await solveReport(secretWindow(), {
      ok: true,
      items: [],
      strategy: 'fake-club-reader',
      attempts: [{ id: 'fake-club-reader', ok: true, reason: null }],
    });
    const club = report.stages.find((stage) => stage.id === 'club');

    expect(club.ok).toBe(true);
    expect(club.detail.shape).toBeNull();
  });
});

describe('the service shape report never reaches the network', () => {
  const diagnosticModules = ['src/ea/service-shape.js', 'src/shape.js'];
  const networkCalls =
    /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource|new\s+Image\s*\(|createElement\s*\(\s*['"]img['"]/;

  for (const file of diagnosticModules) {
    it(`${file} contains no network call`, () => {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

      expect(source).not.toMatch(networkCalls);
    });
  }
});