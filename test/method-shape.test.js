import { afterEach, describe, expect, it, vi } from 'vitest';

import { METHOD_SOURCE_CAP, describeMethodShape } from '../src/shape.js';

describe('describeMethodShape', () => {
  it('reads arity from fn.length for a zero-argument and a two-argument method', () => {
    expect(describeMethodShape(function getClubItems() {}).arity).toBe(0);
    expect(describeMethodShape(function search(count, offset) {}).arity).toBe(2);
  });

  it('names the method constructor so an async method is recognisable', () => {
    expect(describeMethodShape(async function getClubItems() {}).constructor).toBe('AsyncFunction');
    expect(describeMethodShape(function getClubItems() {}).constructor).toBe('Function');
  });

  it('caps a long source excerpt and marks the truncation explicitly', () => {
    const source = `function getClubItems() { return ${'0'.repeat(4000)}; }`;
    const method = new Function('return ' + source)();
    const shape = describeMethodShape(method);

    expect(shape.truncated).toBe(true);
    expect(shape.excerpt).toContain('getClubItems');
    expect(shape.excerpt).toMatch(/\[truncated \d+ chars\]/);
    expect(shape.excerpt.length).toBeLessThanOrEqual(METHOD_SOURCE_CAP + 40);
  });

  it('does not mark a short excerpt as truncated', () => {
    const shape = describeMethodShape(function getClubItems(count) {});
    expect(shape.truncated).toBe(false);
    expect(shape.excerpt).toContain('getClubItems');
  });

  it('keeps a literal value inside the method source out of the report', () => {
    const sentinel = 'fsl-sentinel-6b2d9e';
    const method = new Function('count', `return ${JSON.stringify(sentinel)};`);

    const shape = describeMethodShape(method);
    const json = JSON.stringify(shape);

    expect(shape.excerpt).toContain('count');
    expect(json).not.toContain(sentinel);
  });

  it('drops the excerpt with a reason when the source cannot be read', () => {
    const original = Function.prototype.toString;
    Function.prototype.toString = function toString() {
      throw new Error('no source available');
    };
    try {
      const shape = describeMethodShape(function getClubItems() {});
      expect(shape.excerpt).toBeNull();
      expect(shape.excerptReason).toMatch(/unreadable/);
      expect(shape.arity).toBe(0);
    } finally {
      Function.prototype.toString = original;
    }
  });

  it('never invokes an accessor while reading arity or the constructor', () => {
    const lengthSpy = vi.fn(() => 7);
    const constructorSpy = vi.fn(() => Function);
    function getClubItems() {}
    Object.defineProperty(getClubItems, 'length', { get: lengthSpy });
    Object.defineProperty(getClubItems, 'constructor', { get: constructorSpy });

    const shape = describeMethodShape(getClubItems);

    expect(lengthSpy).not.toHaveBeenCalled();
    expect(constructorSpy).not.toHaveBeenCalled();
    expect(shape.arity).toBeNull();
    expect(shape.constructor).toBeNull();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
