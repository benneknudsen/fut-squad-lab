import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_OBSERVER_CALL_CAP,
  createMethodObserver,
  formatObserverCall,
} from '../src/ea/observer.js';
import {
  OBSERVED_CRITERIA_VALUE_FIELDS,
  OBSERVED_METHOD_TARGETS,
  resolveObservationTargets,
} from '../src/ea/adapter.js';
import { buildMarker } from '../src/ea/build.js';
import { DIAGNOSTIC_STAGES, buildDiagnosticsReport } from '../src/ea/summary.js';

// Issue #64: the observer wraps an EA method, records how it was called,
// calls through with the same `this` and arguments, and returns EA's result
// unchanged. It is testable against a fake EA object: no browser needed.

const installOne = (observer, holder, method = 'method', id = `fake.${method}`) =>
  observer.install([{ id, holder, method }]);

describe('call-through fidelity', () => {
  const cases = [
    ['a function', () => {}],
    ['an observable-like object', { observe() {}, unobserve() {} }],
    ['undefined', undefined],
  ];

  it.each(cases)('returns %s unchanged, with the same this and arguments', (_name, expected) => {
    const received = [];
    const holder = {
      method(...args) {
        received.push({ self: this, args });
        return expected;
      },
    };
    const observer = createMethodObserver();
    installOne(observer, holder);

    const self = { notTheHolder: true };
    const first = { any: 'object' };
    const second = ['any', 'array'];
    const returned = holder.method.call(self, first, second);

    expect(returned).toBe(expected);
    expect(received).toHaveLength(1);
    expect(received[0].self).toBe(self);
    expect(received[0].args).toHaveLength(2);
    expect(received[0].args[0]).toBe(first);
    expect(received[0].args[1]).toBe(second);
  });

  it('records the call before calling through, so a throwing method still records', () => {
    const boom = new Error('EA blew up');
    const holder = {
      method() {
        throw boom;
      },
    };
    const observer = createMethodObserver();
    installOne(observer, holder);

    let caught;
    try {
      holder.method();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(boom);
    expect(observer.report().calls).toHaveLength(1);
    expect(observer.report().calls[0].threw).toBe(true);
  });

  it('returns a rejected promise unchanged instead of awaiting or swallowing it', () => {
    const rejection = Promise.reject(new Error('rejected'));
    rejection.catch(() => {});
    const holder = { method: () => rejection };
    const observer = createMethodObserver();
    installOne(observer, holder);

    expect(holder.method()).toBe(rejection);
    expect(observer.report().calls).toHaveLength(1);
  });

  it('reports whether this was the wrapped target or something else', () => {
    const holder = {
      method() {
        return 'ok';
      },
    };
    const observer = createMethodObserver();
    installOne(observer, holder);

    holder.method();
    holder.method.call({ other: true });

    const [direct, indirect] = observer.report().calls;
    expect(direct.thisMatchesTarget).toBe(true);
    expect(direct.thisType).toBe('object');
    expect(indirect.thisMatchesTarget).toBe(false);
  });
});

describe('what is recorded', () => {
  it('records the argument count for one argument and for two', () => {
    const holder = { method: () => 'ok' };
    const observer = createMethodObserver();
    installOne(observer, holder);

    holder.method({});
    holder.method({}, {});

    expect(observer.report().calls.map((call) => call.argumentCount)).toEqual([1, 2]);
  });

  it('records allowlisted values only, and no sensitive value anywhere', () => {
    const holder = { method: () => 'ok' };
    const observer = createMethodObserver({ valueFields: ['count', 'offset'] });
    installOne(observer, holder);

    holder.method({
      count: 100,
      offset: 0,
      personaId: 'distinctive-persona-987',
      defId: [987654321],
      sessionToken: 'distinctive-token-abc',
    });

    const report = observer.report();
    const argument = report.calls[0].args[0];
    const serialized = JSON.stringify(report);

    expect(argument.values).toEqual({ count: 100, offset: 0 });
    expect(serialized).toContain('100');
    expect(serialized).toContain('<redacted>');
    expect(serialized).not.toContain('distinctive-persona-987');
    expect(serialized).not.toContain('987654321');
    expect(serialized).not.toContain('distinctive-token-abc');
    expect(argument.keys).toContainEqual({ name: 'count', type: 'number' });
    expect(argument.keys).toContainEqual({ name: '<redacted>', type: 'string', empty: false });
  });

  it('reports an argument property that is an accessor without invoking it', () => {
    let reads = 0;
    const argument = { offset: 3 };
    Object.defineProperty(argument, 'count', {
      enumerable: true,
      get() {
        reads += 1;
        return 100;
      },
    });
    const holder = { method: () => 'ok' };
    const observer = createMethodObserver({ valueFields: ['count', 'offset'] });
    installOne(observer, holder);

    holder.method(argument);

    const [call] = observer.report().calls;
    expect(reads).toBe(0);
    expect(call.args[0].keys).toContainEqual({ name: 'count', type: 'accessor(get)' });
    expect(call.args[0].values).toEqual({ offset: 3 });
  });

  it('records which part of the stack made the call', () => {
    const holder = { method: () => 'ok' };
    const observer = createMethodObserver({ classifyOrigin: () => 'ea' });
    installOne(observer, holder);

    holder.method();

    expect(observer.report().calls[0].origin).toBe('ea');
  });

  it('bounds the recording and counts what was dropped', () => {
    let calls = 0;
    const holder = {
      method() {
        calls += 1;
        return calls;
      },
    };
    const observer = createMethodObserver({ callCap: 3 });
    installOne(observer, holder);

    for (let index = 0; index < 10; index++) holder.method();

    const report = observer.report();
    expect(calls).toBe(10);
    expect(report.calls).toHaveLength(3);
    expect(report.dropped).toBe(7);
    expect(report.truncated).toBe(true);
    expect(DEFAULT_OBSERVER_CALL_CAP).toBeGreaterThan(3);
  });
});

describe('install and remove', () => {
  it('restores the original function on remove and records nothing after', () => {
    const original = vi.fn(() => 'value');
    const holder = { method: original };
    const observer = createMethodObserver();
    installOne(observer, holder);

    holder.method('one');
    observer.remove();

    expect(holder.method).toBe(original);
    holder.method('two');
    expect(observer.report().calls).toHaveLength(1);
    expect(original).toHaveBeenCalledTimes(2);
  });

  it('restores a method that lived on the prototype by deleting the own wrapper', () => {
    const original = () => 'value';
    const proto = { method: original };
    const holder = Object.create(proto);
    const observer = createMethodObserver();
    installOne(observer, holder);

    expect(Object.hasOwn(holder, 'method')).toBe(true);
    holder.method();
    observer.remove();

    expect(Object.hasOwn(holder, 'method')).toBe(false);
    expect(holder.method).toBe(original);
  });

  it('installs each target once even when install is called again', () => {
    const holder = { method: vi.fn(() => 'ok') };
    const observer = createMethodObserver();
    installOne(observer, holder);
    installOne(observer, holder);

    holder.method();

    expect(observer.report().calls).toHaveLength(1);
    const methods = observer.report().methods;
    expect(methods).toHaveLength(2);
    expect(methods.every((entry) => entry.installed === true)).toBe(true);
  });

  it('reports a missing method and an accessor instead of wrapping them', () => {
    const getter = vi.fn(() => () => 'never');
    const holder = {};
    Object.defineProperty(holder, 'hidden', { get: getter });

    const observer = createMethodObserver();
    const outcomes = observer.install([
      { id: 'fake.absent', holder, method: 'absent' },
      { id: 'fake.hidden', holder, method: 'hidden' },
    ]);

    expect(getter).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      { id: 'fake.absent', installed: false, reason: expect.stringContaining('no absent method') },
      { id: 'fake.hidden', installed: false, reason: 'accessor(get)' },
    ]);
    expect(observer.report().calls).toEqual([]);
  });

  it('reports a target whose holder is missing without throwing', () => {
    const observer = createMethodObserver();
    const outcomes = observer.install([
      { id: 'services.Club.search', holder: null, method: 'search', reason: 'services has no Club' },
    ]);

    expect(outcomes).toEqual([
      { id: 'services.Club.search', installed: false, reason: 'services has no Club' },
    ]);
  });
});

describe('formatObserverCall', () => {
  it('names the method, the argument count and each argument shape', () => {
    const holder = { method: () => 'ok' };
    const observer = createMethodObserver({ valueFields: ['count'] });
    installOne(observer, holder, 'method', 'services.Club.search');

    holder.method({ count: 25, ownedOnly: true }, 'plain');

    const line = formatObserverCall(observer.report().calls[0]);
    expect(line).toContain('services.Club.search');
    expect(line).toContain('args=2');
    expect(line).toContain('count:number');
    expect(line).toContain('values{count:25}');
    expect(line).toContain('string(non-empty)');
  });

  it('never prints a value the allowlist did not permit', () => {
    const holder = { method: () => 'ok' };
    const observer = createMethodObserver({ valueFields: [] });
    installOne(observer, holder, 'method', 'services.Club.search');

    holder.method({ personaId: 'distinctive-persona-987' });

    const line = formatObserverCall(observer.report().calls[0]);
    expect(line).not.toContain('distinctive-persona-987');
    expect(line).toContain('<redacted>');
  });
});

describe('resolveObservationTargets', () => {
  const withTargets = () => {
    function UTSBCSquadDetailPanelViewController() {}
    UTSBCSquadDetailPanelViewController.prototype.initWithSBCSet = function () {};
    return {
      UTSBCSquadDetailPanelViewController,
      services: {
        Club: { search() {}, clubDao: { getClubItems() {} } },
        Item: { searchStorageItems() {} },
      },
    };
  };

  it('resolves every observed method to the live holder', () => {
    const pageWindow = withTargets();
    const { targets } = resolveObservationTargets(pageWindow);
    const byId = Object.fromEntries(targets.map((target) => [target.id, target]));

    expect(targets.map((target) => target.id)).toEqual(
      OBSERVED_METHOD_TARGETS.map((target) => target.id)
    );
    expect(byId['services.Club.search'].holder).toBe(pageWindow.services.Club);
    expect(byId['services.Club.search'].method).toBe('search');
    expect(byId['services.Club.clubDao.getClubItems'].holder).toBe(
      pageWindow.services.Club.clubDao
    );
    expect(byId['services.Item.searchStorageItems'].holder).toBe(pageWindow.services.Item);
    expect(byId['UTSBCSquadDetailPanelViewController.prototype.initWithSBCSet'].holder).toBe(
      pageWindow.UTSBCSquadDetailPanelViewController.prototype
    );
  });

  it('names a missing holder with its reason instead of throwing', () => {
    const { targets } = resolveObservationTargets({ services: {} });
    const missing = targets.find((target) => target.id === 'services.Club.search');
    const panel = targets.find((target) => target.id.includes('initWithSBCSet'));

    expect(missing.holder).toBeNull();
    expect(missing.reason).toContain('Club');
    expect(panel.holder).toBeNull();
    expect(panel.reason).toContain('UTSBCSquadDetailPanelViewController');
  });

  it('pins the allowlisted criteria fields the observer may record values for', () => {
    expect(OBSERVED_CRITERIA_VALUE_FIELDS).toEqual([
      'count',
      'offset',
      'sortBy',
      '_type',
      '_category',
      '_position',
      '_sort',
      '_zone',
      'isExactSearch',
      'preferredPositionOnly',
    ]);
  });
});

describe('the observer report in the staged diagnostics', () => {
  const finishedStages = () =>
    DIAGNOSTIC_STAGES.map((id) => ({ id, ok: true, reason: null, detail: null }));

  it('is carried when supplied and null otherwise', () => {
    const report = { calls: [], dropped: 0, truncated: false, methods: [] };

    expect(buildDiagnosticsReport(finishedStages()).observer).toBeNull();
    expect(buildDiagnosticsReport(finishedStages(), buildMarker(), null, report).observer).toEqual(
      report
    );
  });
});