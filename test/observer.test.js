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

// Issue #67: the default origin classifier reads the innermost frame that is
// not this module's own machinery, so the tests need real frame URLs. The
// calling code runs inside a function whose source URL is the EA page (or the
// extension), which gives a genuine stack for both directions.
const EA_SCRIPT_URL = 'https://www.ea.com/ut/fake-ea.js';
const EXTENSION_SCRIPT_URL = 'chrome-extension://fsl-fake/src/ea/club-reader.js';

const callFrom = (url, holder, body) =>
  new Function('holder', `return ${body}\n//# sourceURL=${url}`)(holder);

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

describe('origin classification', () => {
  it('labels a call our own code makes as ours', () => {
    const holder = { method: () => 'ok' };
    const observer = createMethodObserver();
    installOne(observer, holder);

    callFrom(EXTENSION_SCRIPT_URL, holder, 'holder.method()');

    expect(observer.report().calls[0].origin).toBe('extension');
  });

  it('labels a script with no extension frame as EA, never ours', () => {
    const holder = { method: () => 'ok' };
    const observer = createMethodObserver();
    installOne(observer, holder);

    callFrom(EA_SCRIPT_URL, holder, 'holder.method()');
    holder.method();

    const [fromEa, fromNoFrame] = observer.report().calls;
    expect(fromEa.origin).toBe('ea');
    expect(fromNoFrame.origin).not.toBe('extension');
  });

  it('labels a nested EA call as EA, not ours, because EA issued it', () => {
    const items = ['item'];
    const holder = {
      clubDao: {
        getClubItems() {
          return items;
        },
      },
    };
    holder.search = new Function(
      `return this.clubDao.getClubItems()\n//# sourceURL=${EA_SCRIPT_URL}`
    );
    const observer = createMethodObserver();
    observer.install([
      { id: 'services.Club.search', holder, method: 'search' },
      { id: 'services.Club.clubDao.getClubItems', holder: holder.clubDao, method: 'getClubItems' },
    ]);

    const result = callFrom(EXTENSION_SCRIPT_URL, holder, 'holder.search()');

    const calls = observer.report().calls;
    expect(result).toBe(items);
    expect(calls.map((call) => call.method)).toEqual([
      'services.Club.search',
      'services.Club.clubDao.getClubItems',
    ]);
    expect(calls[0].origin).toBe('extension');
    expect(calls[1].origin).toBe('ea');
    expect(calls[0].nested).toBe(false);
    expect(calls[1].nested).toBe(true);
  });
});

describe('nesting', () => {
  it('tracks two and three levels of nesting and resets after the top-level call', () => {
    const holder = {
      one() {
        holder.two();
      },
      two() {
        holder.three();
      },
      three() {
        return 'done';
      },
    };
    const observer = createMethodObserver();
    observer.install([
      { id: 'fake.one', holder, method: 'one' },
      { id: 'fake.two', holder, method: 'two' },
      { id: 'fake.three', holder, method: 'three' },
    ]);

    holder.one();
    holder.three();

    expect(observer.report().calls.map((call) => [call.method, call.nested])).toEqual([
      ['fake.one', false],
      ['fake.two', true],
      ['fake.three', true],
      ['fake.three', false],
    ]);
  });

  it('resets the nesting state after a throwing top-level call', () => {
    const boom = new Error('EA blew up');
    let throwNow = true;
    const holder = {
      outer() {
        holder.inner();
        if (throwNow) throw boom;
        return 'ok';
      },
      inner: () => 'inner',
    };
    const observer = createMethodObserver();
    observer.install([
      { id: 'fake.outer', holder, method: 'outer' },
      { id: 'fake.inner', holder, method: 'inner' },
    ]);

    expect(() => holder.outer()).toThrow(boom);
    throwNow = false;
    holder.inner();

    expect(observer.report().calls.map((call) => [call.method, call.nested, call.threw])).toEqual([
      ['fake.outer', false, true],
      ['fake.inner', true, false],
      ['fake.inner', false, false],
    ]);
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

  it('leaves a method someone else replaced after installation alone on remove', () => {
    const original = () => 'original';
    const holder = { method: original };
    const observer = createMethodObserver();
    installOne(observer, holder);
    const replacement = () => 'replacement';

    holder.method = replacement;
    observer.remove();

    expect(holder.method).toBe(replacement);
  });

  it('wraps once when two observers watch the same method', () => {
    const original = vi.fn(() => 'ok');
    const holder = { method: original };
    const first = createMethodObserver();
    const second = createMethodObserver();
    installOne(first, holder);

    const wrapped = holder.method;
    installOne(second, holder);

    expect(holder.method).toBe(wrapped);
    holder.method();
    expect(original).toHaveBeenCalledTimes(1);
    expect(first.report().calls).toHaveLength(1);
    expect(second.report().calls).toHaveLength(0);

    second.remove();
    expect(holder.method).toBe(wrapped);
    first.remove();
    expect(holder.method).toBe(original);
  });

  it('is safe to remove twice', () => {
    const original = () => 'ok';
    const holder = { method: original };
    const observer = createMethodObserver();
    installOne(observer, holder);

    observer.remove();
    expect(holder.method).toBe(original);
    expect(() => observer.remove()).not.toThrow();
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

  it('shows the nested flag on the line so the log states it outright', () => {
    const holder = {
      outer() {
        return holder.inner();
      },
      inner: () => 'ok',
    };
    const observer = createMethodObserver();
    observer.install([
      { id: 'fake.outer', holder, method: 'outer' },
      { id: 'fake.inner', holder, method: 'inner' },
    ]);
    holder.outer();

    const [outer, inner] = observer.report().calls;
    expect(formatObserverCall(outer)).toContain('nested=false');
    expect(formatObserverCall(inner)).toContain('nested=true');
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